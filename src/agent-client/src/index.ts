export { AGENT_DEFAULTS, AgentDefinitionError, defineAgent, type AgentModel, type AgentSpec } from "./define-agent.js";
export {
  AgentPlatform, AgentPlatformError, localApiUrl, ManagedSession,
  type AgentPlatformOptions, type CreateSessionOptions, type LocalPlatformOptions, type OpenCliOptions, type WorkerResponse,
} from "./platform.js";
export { superviseSessionCli, type CliSupervisorOptions, type SessionConnection } from "./cli-supervisor.js";
export type { PromotionResponse, SharedSessionView, WorkerInputRequestView, WorkerView } from "@copilot-agent/contracts";
export { demoAgent, MODES as DEMO_MODES, type DemoAgent, type DemoMode } from "./demos.js";
