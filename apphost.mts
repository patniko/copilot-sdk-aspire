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
import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { SharedPrincipalBindings, SharedSessionLimits, SharedWorkerLimits } from './contracts/src/shared.js';
import { SessionContainerSettings } from './contracts/src/session-container.js';
import { CUSTOMER_WORKSPACE_DIR, ensureCustomerWorkspace } from './configurator/server/workspace.js';

/** Secret references (`mcpServers.*.auth.secret`) in the customer's base policy and per-harness overrides. */
async function mcpSecretReferences(configRoot: string): Promise<string[]> {
  const policy = join(configRoot, 'policy');
  const read = async (file: string) => JSON.parse(await readFile(join(policy, file), 'utf8')) as { mcpServers?: unknown; overrides?: { mcpServers?: unknown } };
  const catalogs: unknown[] = [(await read('execution-policy.json')).mcpServers];
  for (const name of (await readdir(join(policy, 'harnesses')).catch(() => [] as string[])).filter((entry) => entry.endsWith('.json'))) {
    catalogs.push((await read(join('harnesses', name))).overrides?.mcpServers);
  }
  const secrets = new Set<string>();
  for (const catalog of catalogs) {
    for (const server of Object.values(catalog && typeof catalog === 'object' ? catalog : {})) {
      const secret = (server as { auth?: { secret?: unknown } } | undefined)?.auth?.secret;
      if (typeof secret === 'string' && /^[a-z][a-z0-9-]{1,62}$/.test(secret)) secrets.add(secret);
    }
  }
  return [...secrets].sort();
}

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
const hybridEnabled = await configured('Parameters:hybrid-hosting', 'false');
if (!['true', 'false'].includes(hybridEnabled)) throw new Error('hybrid-hosting must be true or false.');
if (hybridEnabled === 'true' && isPublish) {
  throw new Error('Hybrid hosting currently has a local Docker controller. Disable it for Azure publishing; the Azure adapter is not qualified.');
}
const sessionContainersEnabled = await configured('Parameters:session-containers', 'false');
if (!['true', 'false'].includes(sessionContainersEnabled)) throw new Error('session-containers must be true or false.');
if (sessionContainersEnabled === 'true' && hybridEnabled !== 'true') {
  throw new Error('Session containers run under the local execution controller; enable hybrid-hosting as well.');
}
const demoHostTransport = await configured('Parameters:demo-host-transport', 'disabled');
if (!['disabled', 'direct', 'github', 'both'].includes(demoHostTransport)) {
  throw new Error('Parameters:demo-host-transport must be disabled, direct, github, or both.');
}
const demoHostOwner = await configured('Parameters:demo-host-owner', '');
const demoHostHarness = await configured('Parameters:demo-host-harness', 'interactive-demo');
const demoHostRuntimeDirectory = (await configured('Parameters:demo-host-runtime-dir', '')).replaceAll('\\', '/');
if (demoHostRuntimeDirectory && (!/^[A-Za-z0-9._/-]+$/.test(demoHostRuntimeDirectory) ||
  demoHostRuntimeDirectory.split('/').some((part) => part === '' || part === '..'))) {
  throw new Error('demo-host-runtime-dir must be a relative directory inside the build context.');
}
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
const environment = await builder.addAzureContainerAppEnvironment('aca');

const postgres = await builder.addAzurePostgresFlexibleServer('postgres').runAsContainer();
const jobsDb = await postgres.addDatabase('jobsdb');

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

const dispatcher = await service('job-dispatcher')
  .withReference(jobsDb)
  .waitFor(jobsDb)
  .withEnvironment('EXECUTOR_KEY', executorKey)
  .withEnvironment('GATEWAY_KEY', gatewayKey)
  .withEnvironment('CAPABILITY_SIGNING_KEY', signingKey);

// Reference endpoints (not resources) so the same wiring works for Node apps and containers.
const dispatcherEndpoint = await dispatcher.getEndpoint('http');

const gateway = await service('inference-gateway')
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
  await gateway.withCognitiveServicesRoleAssignments(foundry, [AzureOpenAIRole.CognitiveServicesOpenAIUser]);
}

const api = await service('agent-api')
  .withReference(jobsDb)
  .waitFor(jobsDb)
  .waitFor(dispatcher)
  .withEnvironment('API_KEYS', refExpr`dev:${devApiKey}`)
  .withExternalHttpEndpoints();

if (hybridEnabled === 'true') {
  const principals = SharedPrincipalBindings.parse(JSON.parse(await configured('Parameters:hybrid-principals', '{}')));
  if (!principals.dev) throw new Error('Map the local dev API principal to an approved numeric GitHub account in hybrid-principals.');
  const runtimePath = await configured('Parameters:hybrid-runtime-path', '');
  if (!runtimePath) throw new Error('Configure hybrid-runtime-path to the qualified native launcher for this host OS.');
  await access(runtimePath);
  const workerLimits = SharedWorkerLimits.parse(JSON.parse(await configured('Parameters:hybrid-worker-limits', '{}')));
  const sessionLimits = SharedSessionLimits.parse(JSON.parse(await configured('Parameters:hybrid-session-limits', '{}')));
  const workerKey = await builder.addParameterWithGeneratedValue('shared-worker-key', generated, { secret: true, persist: true });
  const brokerKey = await builder.addParameterWithGeneratedValue('connection-broker-key', generated, { secret: true, persist: true });
  const allocationKey = await builder.addParameterWithGeneratedValue('allocation-signing-key', generated, { secret: true, persist: true });
  const namespace = `local-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 20)}`;
  const shared = await builder.addNodeApp('session-host', './src/session-host', 'dist/main.js')
    .withPnpm({ install: false })
    .withReference(jobsDb).waitFor(jobsDb)
    .withReference(dispatcherEndpoint).waitFor(dispatcher)
    .withReference(await gateway.getEndpoint('http')).waitFor(gateway)
    .withHttpEndpoint({ env: 'PORT' }).withHttpHealthCheck({ path: '/health' })
    .withEnvironment('CONFIG_ROOT', customerConfigRoot)
    .withEnvironment('PLATFORM_ROOT', repoRoot)
    .withEnvironment('SHARED_SESSION_DATA', join(repoRoot, '.shared-session-data'))
    .withEnvironment('COPILOT_CLI_PATH', runtimePath)
    .withEnvironment('COPILOT_AHP_FACTORY_PROFILE', 'managed')
    .withEnvironment('SHARED_WORKER_KEY', workerKey)
    .withEnvironment('CONNECTION_BROKER_KEY', brokerKey)
    .withEnvironment('SHARED_PRINCIPALS', JSON.stringify(principals))
    .withEnvironment('SHARED_JOB_HARNESSES', await configured('Parameters:hybrid-harnesses', 'text-summarizer,copilot-coding-agent'))
    .withEnvironment('SHARED_WORKER_LIMITS', JSON.stringify(workerLimits))
    .withEnvironment('SHARED_SESSION_LIMITS', JSON.stringify(sessionLimits));
  // Each remote MCP credential the customer policy references is an Aspire secret parameter, resolved only by the worker.
  for (const secret of await mcpSecretReferences(customerConfigRoot)) {
    await shared.withEnvironment(`MCP_SECRET_${secret.toUpperCase().replaceAll('-', '_')}`, await builder.addParameter(`mcp-secret-${secret}`, { secret: true }));
  }
  const sharedEndpoint = await shared.getEndpoint('http');
  // CLI clients attach only through the broker, which consumes their tickets through the dispatcher and forwards to the
  // session's placement. It is separate from agent-api so that API restarts leave live connections up.
  const broker = await builder.addNodeApp('connection-broker', './src/connection-broker', 'dist/main.js')
    .withPnpm({ install: false })
    .withReference(dispatcherEndpoint).waitFor(dispatcher)
    .withReference(sharedEndpoint).waitFor(shared)
    .withHttpEndpoint({ env: 'PORT' }).withHttpHealthCheck({ path: '/health' })
    .withExternalHttpEndpoints()
    .withEnvironment('CONNECTION_BROKER_KEY', brokerKey);
  const brokerEndpoint = await broker.getEndpoint('http');
  // The worker's shared egress refuses its own listener and the broker's.
  await shared.withEnvironment('SHARED_WORKER_URL', refExpr`${sharedEndpoint}`)
    .withEnvironment('CONNECTION_BROKER_URL', refExpr`${brokerEndpoint}`);
  await api.withReference(sharedEndpoint).waitFor(shared)
    .withEnvironment('SHARED_WORKER_KEY', workerKey)
    .withEnvironment('CONNECTION_BROKER_URL', refExpr`${brokerEndpoint}`)
    .withEnvironment('EXECUTOR_MODE', 'on-demand');
  await dispatcher.withEnvironment('SHARED_WORKER_KEY', workerKey)
    .withEnvironment('CONNECTION_BROKER_KEY', brokerKey);
  const controller = await builder.addNodeApp('execution-controller', './src/execution-controller', 'dist/main.js')
    .withPnpm({ install: false })
    .withReference(jobsDb).waitFor(jobsDb)
    .withReference(dispatcherEndpoint).waitFor(dispatcher)
    .withReference(await gateway.getEndpoint('http')).waitFor(gateway)
    .withHttpEndpoint({ env: 'PORT' }).withHttpHealthCheck({ path: '/health' })
    .withEnvironment('ALLOCATION_SIGNING_KEY', allocationKey)
    .withEnvironment('SHARED_WORKER_LIMITS', JSON.stringify(workerLimits))
    .withEnvironment('EXECUTION_CONTAINER_SETTINGS', JSON.stringify({
      namespace,
      image: await configured('Parameters:hybrid-executor-image', 'copilot-hybrid-executor:local'),
    }));
  if (sessionContainersEnabled === 'true') {
    // Mode-1 sessions: one resumable container per isolated conversation session, started by the controller on
    // connection. The API admits sessions; the dispatcher serves the containers' allocation-scoped routes.
    const sessionSettings = JSON.stringify(SessionContainerSettings.parse({
      ...JSON.parse(await configured('Parameters:session-container-settings', '{}')),
      image: await configured('Parameters:session-container-image', 'copilot-session-container:local'),
    }));
    await controller.withEnvironment('SESSION_CONTAINER_SETTINGS', sessionSettings);
    await dispatcher.withEnvironment('SESSION_CONTAINER_SETTINGS', sessionSettings);
    // The shared worker promotes `promotable` conversations into the same session containers.
    await shared.withEnvironment('SESSION_CONTAINER_SETTINGS', sessionSettings);
    await api.withEnvironment('SESSION_CONTAINER_SETTINGS', sessionSettings)
      .withEnvironment('SHARED_PRINCIPALS', JSON.stringify(principals))
      .withEnvironment('SHARED_WORKER_LIMITS', JSON.stringify(workerLimits))
      .withEnvironment('SHARED_SESSION_LIMITS', JSON.stringify(sessionLimits));
  }
}

if (demoHostTransport !== 'disabled') {
  const hostKey = await builder.addParameterWithGeneratedValue('demo-host-key', generated, { secret: true, persist: true });
  const direct = demoHostTransport === 'direct' || demoHostTransport === 'both';
  const connectionToken = direct
    ? await builder.addParameterWithGeneratedValue('demo-host-connection-token', generated, { secret: true, persist: true })
    : undefined;
  await dispatcher
    .withEnvironment('DEMO_HOST_KEY', hostKey)
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_TRANSPORT', demoHostTransport)
    .withEnvironment('DEMO_HOST_HARNESS', demoHostHarness);
  await api
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_TRANSPORT', demoHostTransport)
    .withEnvironment('DEMO_HOST_HARNESS', demoHostHarness);
  const hostStage = direct && demoHostRuntimeDirectory ? 'agent-host-runtime' : 'agent-host';
  const host = await builder
    .addDockerfile('agent-host', '.', {
      dockerfilePath: 'deploy/Dockerfile',
      stage: hostStage,
    })
    .withBuildArg('CUSTOMER_CONFIG_DIR', CUSTOMER_WORKSPACE_DIR)
    .withBuildArg('DEMO_RUNTIME_DIR', demoHostRuntimeDirectory || '.runtime-artifacts')
    .withBuildArg('NPM_REGISTRY', npmRegistry)
    .withBuildArg('PIP_INDEX_URL', pipIndexUrl)
    .withContainerBuildOptions(async (ctx) => {
      // Local runs build natively like the executor: an emulated amd64 build on ARM64 hosts exceeds Aspire's build
      // timeout. Publishing, and the managed-runtime stage's Linux x64 artifacts, require amd64.
      if (isPublish || hostStage === 'agent-host-runtime') {
        await ctx.targetPlatform.set(ContainerTargetPlatform.LinuxAmd64);
      }
    })
    .withHttpEndpoint({ targetPort: 8080, env: 'PORT' })
    .withHttpHealthCheck({ path: '/health' })
    .withReference(dispatcherEndpoint)
    .waitFor(dispatcher)
    .withEnvironment('DEMO_HOST_KEY', hostKey)
    .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
    .withEnvironment('DEMO_HOST_HARNESS', demoHostHarness)
    .withEnvironment('DEMO_HOST_TRANSPORT', demoHostTransport)
    .publishAsSingletonHost(environment);
  if (direct) await host.withExternalHttpEndpoints();
  if (direct && connectionToken) {
    await host.withEnvironment('DEMO_HOST_CONNECTION_TOKEN', connectionToken)
      .withReference(await gateway.getEndpoint('http'))
      .waitFor(gateway);
  }
  if (demoHostTransport === 'github' || demoHostTransport === 'both') {
    const githubToken = await builder.addParameter('demo-host-github-token', { secret: true });
    await host.withEnvironment('DEMO_HOST_GITHUB_TOKEN', githubToken);
  }
}

// On-demand mode creates no idle pool; the separate controller starts one-shot containers.
if (hybridEnabled !== 'true') {
  await builder
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
}

await builder.build().run();
