// Aspire TypeScript AppHost for the Copilot SDK agent service.
//
// Run mode:     Postgres runs in a container; agent-api, job-dispatcher and inference-gateway run as
//               Node processes; the agent-executor runs in a Linux container so runners execute as an
//               unprivileged user exactly as they do in Azure. The gateway uses the developer's Azure
//               CLI identity; executor containers never see it.
// Publish mode: every service is built from deploy/Dockerfile (linux/amd64) and deployed to Azure
//               Container Apps with Azure Database for PostgreSQL (Microsoft Entra auth). The gateway's
//               managed identity is granted Cognitive Services OpenAI User on the existing Foundry account.

import {
  AzureOpenAIRole,
  ContainerTargetPlatform,
  createBuilder,
  refExpr,
} from './.aspire/modules/aspire.mjs';
import { join } from 'node:path';
import { CUSTOMER_WORKSPACE_DIR, ensureCustomerWorkspace } from './configurator/server/workspace.js';

const builder = await createBuilder();
const isPublish = await builder.executionContext().isPublishMode();
const repoRoot = await builder.appHostDirectory();
const customerConfigRoot = join(repoRoot, CUSTOMER_WORKSPACE_DIR);
await ensureCustomerWorkspace(repoRoot, customerConfigRoot);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const generated = { minLength: 48, special: false };
const devApiKey = await builder.addParameterWithGeneratedValue('dev-api-key', generated, { secret: true, persist: true });
const executorKey = await builder.addParameterWithGeneratedValue('executor-key', generated, { secret: true, persist: true });
const gatewayKey = await builder.addParameterWithGeneratedValue('gateway-key', generated, { secret: true, persist: true });
const signingKey = await builder.addParameterWithGeneratedValue('capability-signing-key', { minLength: 64, special: false }, { secret: true, persist: true });

// Foundry (Azure AI) model route served by the inference gateway.
const foundryEndpoint = await builder.addParameter('foundry-endpoint');
const foundryDeployments = await builder.addParameter('foundry-deployments');

// Package registries used inside image builds. Override with `Parameters:npm-registry` and
// `Parameters:pip-index-url` (user secrets, environment, or deployment configuration) to use a proxy.
const configuration = await builder.getConfiguration();
async function configured(key: string, fallback: string): Promise<string> {
  return (await configuration.exists(key)) ? await configuration.getConfigValue(key) : fallback;
}
const npmRegistry = await configured('Parameters:npm-registry', 'https://registry.npmjs.org/');
const pipIndexUrl = await configured('Parameters:pip-index-url', 'https://pypi.org/simple');
const jobEventDetail = await configured('Parameters:job-event-detail', 'sanitized');
const demoHostTransport = await configured('Parameters:demo-host-transport', 'disabled');
if (!['disabled', 'direct', 'github', 'both'].includes(demoHostTransport)) {
  throw new Error('Parameters:demo-host-transport must be disabled, direct, github, or both.');
}
const demoHostOwner = await configured('Parameters:demo-host-owner', '');
const demoHostHarness = await configured('Parameters:demo-host-harness', 'interactive-demo');
if (demoHostTransport !== 'disabled' && (
  !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(demoHostOwner) ||
  !/^[a-z][a-z0-9-]{1,62}$/.test(demoHostHarness)
)) {
  throw new Error('Configure a valid demo-host-owner and demo-host-harness before enabling the host.');
}
if (jobEventDetail !== 'sanitized' && jobEventDetail !== 'full') {
  throw new Error("Parameters:job-event-detail must be 'sanitized' or 'full'.");
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------
builder.addAzureContainerAppEnvironment('aca');

const postgres = builder.addAzurePostgresFlexibleServer('postgres').runAsContainer();
const jobsDb = postgres.addDatabase('jobsdb');

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------
type Stage = 'agent-api' | 'job-dispatcher' | 'inference-gateway';

/** A control-plane service: a Node process locally, a container image when publishing. */
function service(name: Stage) {
  if (isPublish) {
    return builder
      .addDockerfile(name, '.', { dockerfilePath: 'deploy/Dockerfile', stage: name })
      .withBuildArg('NPM_REGISTRY', npmRegistry)
      .withBuildArg('CUSTOMER_CONFIG_DIR', CUSTOMER_WORKSPACE_DIR)
      .withContainerBuildOptions(async (ctx) => {
        await ctx.targetPlatform.set(ContainerTargetPlatform.LinuxAmd64);
      })
      .withHttpEndpoint({ targetPort: 8080, env: 'PORT' })
      .withHttpHealthCheck({ path: '/health' })
      .publishAsAzureContainerApp(async (_infra, app) => {
        await app.configureScale({ minReplicas: 1 });
      });
  }
  // The pnpm workspace is installed and built once at the repository root (`pnpm install && pnpm build`).
  return builder
    .addNodeApp(name, `./src/${name}`, 'dist/main.js')
    .withPnpm({ install: false })
    .withHttpEndpoint({ env: 'PORT' })
    .withHttpHealthCheck({ path: '/health' })
    .withEnvironment('CONFIG_ROOT', customerConfigRoot)
    .withEnvironment('PLATFORM_ROOT', repoRoot);
}

const dispatcher = service('job-dispatcher')
  .withReference(jobsDb)
  .waitFor(jobsDb)
  .withEnvironment('EXECUTOR_KEY', executorKey)
  .withEnvironment('GATEWAY_KEY', gatewayKey)
  .withEnvironment('CAPABILITY_SIGNING_KEY', signingKey);

// Reference endpoints (not resources) so the same wiring works for Node apps and containers.
const dispatcherEndpoint = await dispatcher.getEndpoint('http');

const gateway = service('inference-gateway')
  .withReference(dispatcherEndpoint)
  .withEnvironment('GATEWAY_KEY', gatewayKey)
  .withEnvironment('CAPABILITY_SIGNING_KEY', signingKey)
  .withEnvironment('FOUNDRY_ENDPOINT', foundryEndpoint)
  .withEnvironment('FOUNDRY_DEPLOYMENTS', foundryDeployments);

if (isPublish) {
  // Existing customer-owned Foundry account; the template never creates or deletes it.
  const foundryAccount = builder.addParameter('foundry-account');
  const foundryResourceGroup = builder.addParameter('foundry-resource-group');
  const foundry = builder.addAzureOpenAI('foundry').asExisting(foundryAccount, { resourceGroup: foundryResourceGroup });
  gateway.withCognitiveServicesRoleAssignments(foundry, [AzureOpenAIRole.CognitiveServicesOpenAIUser]);
}

const api = service('agent-api')
  .withReference(jobsDb)
  .waitFor(jobsDb)
  .waitFor(dispatcher)
  .withEnvironment('API_KEYS', refExpr`dev:${devApiKey}`)
  .withExternalHttpEndpoints();

if (demoHostTransport !== 'disabled') {
  const hostKey = await builder.addParameterWithGeneratedValue('demo-host-key', generated, { secret: true, persist: true });
  const connectionToken = await builder.addParameterWithGeneratedValue('demo-host-connection-token', generated, { secret: true, persist: true });
  const direct = demoHostTransport === 'direct' || demoHostTransport === 'both';
  dispatcher
    .withEnvironment('DEMO_HOST_KEY', hostKey)
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_HARNESS', demoHostHarness);
  api
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_TRANSPORT', demoHostTransport);
  const host = builder
    .addDockerfile('agent-host', '.', { dockerfilePath: 'deploy/Dockerfile', stage: 'agent-host' })
    .withBuildArg('CUSTOMER_CONFIG_DIR', CUSTOMER_WORKSPACE_DIR)
    .withBuildArg('NPM_REGISTRY', npmRegistry)
    .withBuildArg('PIP_INDEX_URL', pipIndexUrl)
    .withContainerBuildOptions(async (ctx) => {
      if (isPublish) await ctx.targetPlatform.set(ContainerTargetPlatform.LinuxAmd64);
    })
    .withVolume('/data', { name: 'demo-host-data' })
    .withHttpEndpoint({ targetPort: 8080, env: 'PORT' })
    .withHttpHealthCheck({ path: '/health' })
    .withReference(dispatcherEndpoint)
    .withReference(await gateway.getEndpoint('http'))
    .waitFor(dispatcher)
    .waitFor(gateway)
    .withEnvironment('DEMO_HOST_KEY', hostKey)
    .withEnvironment('DEMO_HOST_CONNECTION_TOKEN', connectionToken)
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_HARNESS', demoHostHarness)
    .withEnvironment('DEMO_HOST_TRANSPORT', demoHostTransport)
    .publishAsAzureContainerApp(async (_infra, app) => {
      await app.configureScale({ minReplicas: 1 });
    });
  if (direct) host.withExternalHttpEndpoints();
  if (demoHostTransport === 'github' || demoHostTransport === 'both') {
    const githubToken = await builder.addParameter('demo-host-github-token', { secret: true });
    host.withEnvironment('DEMO_HOST_GITHUB_TOKEN', githubToken);
  }
}

// The executor holds no database, Azure, or provider credentials: only its dispatcher key.
builder
  .addDockerfile('agent-executor', '.', { dockerfilePath: 'deploy/Dockerfile', stage: 'agent-executor' })
  .withBuildArg('NPM_REGISTRY', npmRegistry)
  .withBuildArg('PIP_INDEX_URL', pipIndexUrl)
  .withContainerBuildOptions(async (ctx) => {
    if (isPublish) {
      await ctx.targetPlatform.set(ContainerTargetPlatform.LinuxAmd64);
    }
  })
  .withReference(dispatcherEndpoint)
  .withReference(await gateway.getEndpoint('http'))
  .waitFor(dispatcher)
  .waitFor(gateway)
  .withEnvironment('EXECUTOR_KEY', executorKey)
  .withEnvironment('EXECUTOR_PARALLELISM', '2')
  .withEnvironment('JOB_EVENT_DETAIL', jobEventDetail)
  .publishAsAzureContainerApp(async (_infra, app) => {
    await app.configureScale({ minReplicas: 1 });
  });

await builder.build().run();
