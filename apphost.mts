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
import { OwnerHostList, ownerHostEnvSuffix, ownerHostResource, type OwnerHostDescriptor, type OwnerHostSize } from './contracts/src/host.js';
import { effectiveHostingPolicy, ExecutionPolicy, HarnessPolicyOverride, policyFor } from './contracts/src/profile.js';
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
// Names Docker resources that must not collide with another checkout on the same engine.
const checkoutId = createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);

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
const orchestratorWorkersEnabled = await configured('Parameters:orchestrator-workers', 'false');
if (!['true', 'false'].includes(orchestratorWorkersEnabled)) throw new Error('orchestrator-workers must be true or false.');
if (orchestratorWorkersEnabled === 'true' && sessionContainersEnabled !== 'true') {
  throw new Error('Orchestrator workers run in session containers; enable session-containers as well.');
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
// Per-harness owner hosts: one always-on, single-owner, managed host per listed isolated harness. They share the
// demo host's GitHub owner, owner credential, and local runtime bundle; each has its own key, volume, and relay environment.
const ownerHosts = OwnerHostList.parse(JSON.parse(await configured('Parameters:owner-hosts', '[]')));
const validOwner = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(demoHostOwner);
if (demoHostTransport !== 'disabled' && (!validOwner || !/^[a-z][a-z0-9-]{1,62}$/.test(demoHostHarness))) {
  throw new Error('Configure a valid demo-host-owner and demo-host-harness before enabling the host.');
}
if (ownerHosts.length) {
  if (isPublish) throw new Error('Per-harness owner hosts are local-only until the Azure stage. Publish with the single demo-host-* host instead.');
  if (!validOwner) throw new Error('Configure demo-host-owner, the GitHub owner of every owner host, before enabling owner hosts.');
  if (!demoHostRuntimeDirectory) throw new Error('Owner hosts run managed sessions on the local runtime: set demo-host-runtime-dir to a verified runtime bundle.');
  if (demoHostTransport !== 'disabled' && ownerHosts.some((host) => host.harness === demoHostHarness)) {
    throw new Error(`Harness '${demoHostHarness}' is configured both as the demo host and as an owner host.`);
  }
}
/**
 * The managed-runtime image stage installs a verified local bundle (deploy/build-hybrid-runtime.ps1 output) and builds
 * for the bundle's own Linux architecture, so a native ARM64 bundle is never built through amd64 emulation.
 * Publishing still requires an amd64 bundle.
 */
async function runtimeBundlePlatform(directory: string): Promise<ContainerTargetPlatform> {
  let platform: unknown;
  try {
    platform = (JSON.parse(await readFile(join(repoRoot, directory, 'provenance.json'), 'utf8')) as { platform?: unknown }).platform;
  } catch {
    throw new Error(`demo-host-runtime-dir '${directory}' must contain a verified runtime bundle with provenance.json (deploy/build-hybrid-runtime.ps1).`);
  }
  if (platform === 'linux/amd64') return ContainerTargetPlatform.LinuxAmd64;
  if (platform === 'linux/arm64' && !isPublish) return ContainerTargetPlatform.LinuxArm64;
  throw new Error(`The runtime bundle platform '${String(platform)}' cannot be ${isPublish ? 'published; Azure requires linux/amd64' : 'hosted'}.`);
}
/** An owner host's always-on size: a name from its harness's effective `hosting.sizes`, or the policy's `defaultSize`. */
async function ownerHostSize(harness: string, requested: string | undefined): Promise<OwnerHostSize> {
  const policyRoot = join(customerConfigRoot, 'policy');
  const base = ExecutionPolicy.parse(JSON.parse(await readFile(join(policyRoot, 'execution-policy.json'), 'utf8')));
  let override: HarnessPolicyOverride | undefined;
  try {
    override = HarnessPolicyOverride.parse(JSON.parse(await readFile(join(policyRoot, 'harnesses', `${harness}.json`), 'utf8')));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const hosting = effectiveHostingPolicy(policyFor({ base, overrides: new Map(override ? [[harness, override]] : []) }, harness));
  const name = requested ?? hosting.defaultSize;
  const size = hosting.sizes[name];
  if (!size) throw new Error(`Owner host '${harness}' requests size '${name}', which its effective hosting policy does not offer.`);
  return { name, ...size };
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
    if (orchestratorWorkersEnabled === 'true') {
      // Mode-4 workers: orchestrator coordinators run on the shared worker and start workers in session containers.
      // The shared worker reaches a coordinator's shared volume only through the controller's file service.
      const filesKey = await builder.addParameterWithGeneratedValue('shared-files-key', generated, { secret: true, persist: true });
      await controller.withEnvironment('SHARED_FILES_KEY', filesKey);
      await shared.withReference(await controller.getEndpoint('http'))
        .withEnvironment('ORCHESTRATOR_WORKERS', 'true')
        .withEnvironment('SESSION_CONTAINER_SETTINGS', sessionSettings)
        .withEnvironment('SHARED_FILES_KEY', filesKey);
      await api.withEnvironment('ORCHESTRATOR_WORKERS', 'true');
      await dispatcher.withEnvironment('ORCHESTRATOR_WORKERS', 'true');
    }
  }
}

let ownerCredential: Awaited<ReturnType<typeof builder.addParameter>> | undefined;
/** The owner's GitHub credential for Mission Control registration, shared by every relay-enabled host. */
async function githubOwnerCredential() {
  ownerCredential ??= await builder.addParameter('demo-host-github-token', { secret: true });
  return ownerCredential;
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
  // Local runs build natively like the executor: an emulated amd64 build on ARM64 hosts exceeds Aspire's build
  // timeout. Publishing requires amd64; the managed-runtime stage follows its bundle's architecture.
  const hostPlatform = hostStage === 'agent-host-runtime'
    ? await runtimeBundlePlatform(demoHostRuntimeDirectory)
    : isPublish ? ContainerTargetPlatform.LinuxAmd64 : undefined;
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
      if (hostPlatform) await ctx.targetPlatform.set(hostPlatform);
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
  // Local runs: the API returns this endpoint from /v1/hosts/{harness}/connection, as it does for owner hosts, and the
  // dispatcher gives it to the connection broker, when there is one, for connections through `/hosts/{harness}`.
  if (direct && !isPublish) {
    const endpoint = refExpr`${await host.getEndpoint('http')}`;
    await api.withEnvironment(`OWNER_HOST_URL_${ownerHostEnvSuffix(demoHostHarness)}`, endpoint);
    await dispatcher.withEnvironment(`OWNER_HOST_URL_${ownerHostEnvSuffix(demoHostHarness)}`, endpoint);
  }
  if (direct && connectionToken) {
    await host.withEnvironment('DEMO_HOST_CONNECTION_TOKEN', connectionToken)
      .withReference(await gateway.getEndpoint('http'))
      .waitFor(gateway);
  }
  if (demoHostTransport === 'github' || demoHostTransport === 'both') {
    await host.withEnvironment('DEMO_HOST_GITHUB_TOKEN', await githubOwnerCredential());
  }
}

if (ownerHosts.length) {
  const platform = await runtimeBundlePlatform(demoHostRuntimeDirectory);
  const gatewayEndpoint = await gateway.getEndpoint('http');
  const descriptors: OwnerHostDescriptor[] = [];
  for (const settings of ownerHosts) {
    const name = ownerHostResource(settings.harness);
    const suffix = ownerHostEnvSuffix(settings.harness);
    const direct = settings.transport !== 'github';
    const size = await ownerHostSize(settings.harness, settings.size);
    const key = await builder.addParameterWithGeneratedValue(`${name}-key`, generated, { secret: true, persist: true });
    const host = await builder
      .addDockerfile(name, '.', { dockerfilePath: 'deploy/Dockerfile', stage: 'agent-host-runtime' })
      .withBuildArg('CUSTOMER_CONFIG_DIR', CUSTOMER_WORKSPACE_DIR)
      .withBuildArg('DEMO_RUNTIME_DIR', demoHostRuntimeDirectory)
      .withBuildArg('NPM_REGISTRY', npmRegistry)
      .withBuildArg('PIP_INDEX_URL', pipIndexUrl)
      .withContainerBuildOptions(async (ctx) => { await ctx.targetPlatform.set(platform); })
      .withHttpEndpoint({ targetPort: 8080, env: 'PORT' })
      .withHttpHealthCheck({ path: '/health' })
      .withReference(dispatcherEndpoint)
      .waitFor(dispatcher)
      .withReference(gatewayEndpoint)
      .waitFor(gateway)
      .withEnvironment('DEMO_HOST_KEY', key)
      .withEnvironment('DEMO_HOST_OWNER', demoHostOwner)
      .withEnvironment('DEMO_HOST_HARNESS', settings.harness)
      .withEnvironment('DEMO_HOST_TRANSPORT', settings.transport)
      .withEnvironment('DEMO_HOST_EXECUTION', 'managed')
      // The retained runtime home, catalog, and workspace; named per checkout so worktrees never share a volume.
      .withVolume('/data', { name: `${name}-${checkoutId}` })
      .withContainerRuntimeArgs(['--cpus', String(size.cpus), '--memory', `${size.memoryMiB}m`]);
    if (direct) {
      const connectionToken = await builder.addParameterWithGeneratedValue(`${name}-connection-token`, generated, { secret: true, persist: true });
      await host.withEnvironment('DEMO_HOST_CONNECTION_TOKEN', connectionToken);
      // Clients dial the broker's /hosts/{harness} when hybrid mode runs one, otherwise this endpoint.
      const endpoint = refExpr`${await host.getEndpoint('http')}`;
      await api.withEnvironment(`OWNER_HOST_URL_${suffix}`, endpoint);
      await dispatcher.withEnvironment(`OWNER_HOST_URL_${suffix}`, endpoint);
    }
    if (settings.transport !== 'direct') await host.withEnvironment('DEMO_HOST_GITHUB_TOKEN', await githubOwnerCredential());
    await dispatcher.withEnvironment(`OWNER_HOST_KEY_${suffix}`, key);
    descriptors.push({
      harness: settings.harness, owner: demoHostOwner, principal: settings.principal, transport: settings.transport,
      execution: 'managed', resource: name, size,
    });
  }
  await dispatcher.withEnvironment('OWNER_HOSTS', JSON.stringify(descriptors));
  await api.withEnvironment('OWNER_HOSTS', JSON.stringify(descriptors));
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
