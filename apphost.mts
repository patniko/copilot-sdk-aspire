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

const builder = await createBuilder();
const isPublish = await builder.executionContext().isPublishMode();
const repoRoot = await builder.appHostDirectory();

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
    .withEnvironment('CONFIG_ROOT', repoRoot);
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

service('agent-api')
  .withReference(jobsDb)
  .waitFor(jobsDb)
  .waitFor(dispatcher)
  .withEnvironment('API_KEYS', refExpr`dev:${devApiKey}`)
  .withExternalHttpEndpoints();

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
  .publishAsAzureContainerApp(async (_infra, app) => {
    await app.configureScale({ minReplicas: 1 });
  });

await builder.build().run();
