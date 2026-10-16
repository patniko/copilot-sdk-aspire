import { z } from "zod";
import { HarnessDefinition, SLUG } from "./harness.js";
import { ContainerSize, HOSTING_TRANSPORTS, type HostingTransport } from "./profile.js";
import { SharedServerKey } from "./shared.js";

export const HostTransport = z.enum(["disabled", "direct", "github", "both"]);
export type HostTransport = z.infer<typeof HostTransport>;

const HOST_HARNESS = /^[a-z][a-z0-9-]{1,62}$/;
const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
/** A client-visible AHP session identity (`ahp-session:/<id>`), as passed to `copilot --resume <id>`. */
export const AHP_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID_SPELLING = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const DemoHostSettings = z.object({
  transport: HostTransport.default("disabled"),
  owner: z.string().regex(GITHUB_LOGIN).or(z.literal("")).default(""),
  harness: z.string().regex(HOST_HARNESS).default("interactive-demo"),
  runtimeDirectory: z.string().max(300).refine((path) => path === "" ||
    (/^[A-Za-z0-9._/\\-]+$/.test(path) && path.split(/[/\\]/).every((part) => part !== "" && part !== "..")),
  "Use a relative build-context directory without parent traversal.").optional(),
}).strict().superRefine((settings, ctx) => {
  if (settings.transport !== "disabled" && !settings.owner) {
    ctx.addIssue({ code: "custom", path: ["owner"], message: "An expected GitHub owner is required." });
  }
});
export type DemoHostSettings = z.infer<typeof DemoHostSettings>;

/** Transports for an always-on owner host. Unlike the legacy demo host, `github` never implies native execution. */
export const OwnerHostTransport = z.enum(["direct", "github", "both"]);
export type OwnerHostTransport = z.infer<typeof OwnerHostTransport>;
export const HostExecution = z.enum(["managed", "github-native"]);
export type HostExecution = z.infer<typeof HostExecution>;

/** The client transports (`HOSTING_TRANSPORTS`) an owner host offers. */
export function ownerHostTransports(transport: OwnerHostTransport): HostingTransport[] {
  return transport === "both" ? ["direct", "github"] : [transport];
}

/** An owner host's always-on compute: a size from the harness's effective policy catalog, resolved by the AppHost. */
export const OwnerHostSize = ContainerSize.extend({ name: z.string().regex(SLUG) }).strict();
export type OwnerHostSize = z.infer<typeof OwnerHostSize>;

/** Container app names are limited to 32 characters, so owner-host resource names stay within that bound. */
export function ownerHostResource(harness: string): string {
  return `host-${harness}`;
}
/** Environment-variable suffix for per-host settings; harness names cannot contain `_`, so the mapping is one-to-one. */
export function ownerHostEnvSuffix(harness: string): string {
  return harness.toUpperCase().replaceAll("-", "_");
}

/** One entry of the AppHost's `Parameters:owner-hosts`: a managed, single-owner host for one isolated harness. */
export const OwnerHostSettings = z.object({
  harness: z.string().regex(HOST_HARNESS).refine((harness) => ownerHostResource(harness).length <= 32,
    "Owner-host harness names are limited to 27 characters so the host resource name fits 32."),
  transport: OwnerHostTransport,
  /** The API principal that owns the host; only it can obtain connection material or manage its sessions. */
  principal: z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/).default("dev"),
  /** A size name from the harness's effective `hosting.sizes`; omitted selects the policy's `defaultSize`. */
  size: z.string().regex(SLUG).optional(),
}).strict();
export type OwnerHostSettings = z.infer<typeof OwnerHostSettings>;

function uniqueHarnesses(hosts: Array<{ harness: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  hosts.forEach((host, index) => {
    if (seen.has(host.harness)) ctx.addIssue({ code: "custom", path: [index, "harness"], message: "Configure at most one owner host per harness." });
    seen.add(host.harness);
  });
}
export const OwnerHostList = z.array(OwnerHostSettings).max(8).superRefine(uniqueHarnesses);
export type OwnerHostList = z.infer<typeof OwnerHostList>;

/**
 * Non-secret description of a deployed owner host, shared with the dispatcher and API (`OWNER_HOSTS`).
 * The legacy single demo host is described the same way with resource `agent-host` and no configured size.
 */
export const OwnerHostDescriptor = z.object({
  harness: z.string().regex(HOST_HARNESS),
  owner: z.string().regex(GITHUB_LOGIN),
  principal: z.string().regex(/^[A-Za-z0-9._@-]{1,128}$/),
  transport: OwnerHostTransport,
  execution: HostExecution,
  resource: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  size: OwnerHostSize.optional(),
}).strict().superRefine((host, ctx) => {
  if (host.execution === "github-native" && host.transport !== "github") {
    ctx.addIssue({ code: "custom", path: ["transport"], message: "GitHub-native execution is reachable only through the GitHub relay." });
  }
});
export type OwnerHostDescriptor = z.infer<typeof OwnerHostDescriptor>;
export const OwnerHostDescriptors = z.array(OwnerHostDescriptor).max(9).superRefine(uniqueHarnesses);

/** Body of `POST /v1/hosts/{harness}/connection`. */
export const HostConnectionRequest = z.object({
  transport: z.enum(HOSTING_TRANSPORTS).optional(),
  /** A retained managed session to resume: its ledger ID or its AHP session ID. Returned as `ahpSessionId` once verified. */
  sessionId: z.string().regex(AHP_SESSION_ID).optional(),
}).strict();
export type HostConnectionRequest = z.infer<typeof HostConnectionRequest>;

export const OwnerHostView = z.object({
  harness: z.string(),
  transport: OwnerHostTransport,
  execution: HostExecution,
  /** Whether the caller is the host's owner principal; only owners see connection metadata. */
  owned: z.boolean(),
  online: z.boolean(),
  resource: z.string(),
  size: OwnerHostSize.optional(),
  environmentId: z.string().max(200).optional(),
  serverKey: SharedServerKey.optional(),
}).strict();
export type OwnerHostView = z.infer<typeof OwnerHostView>;

export const OwnerHostConnection = z.object({
  harness: z.string(),
  transport: z.enum(HOSTING_TRANSPORTS),
  execution: HostExecution,
  /**
   * Direct WSS endpoint to dial with `?tkn=<token>`: the connection broker's `/hosts/{harness}` when the deployment has
   * a broker, otherwise the host itself. Absent for the legacy host, whose endpoint the launcher resolves.
   */
  url: z.url().refine((value) => ["ws:", "wss:"].includes(new URL(value).protocol)).optional(),
  token: z.string().min(32).max(200).optional(),
  expiresAt: z.iso.datetime().optional(),
  serverKey: SharedServerKey.optional(),
  environmentId: z.string().max(200).optional(),
  ahpSessionId: z.string().regex(AHP_SESSION_ID).optional(),
}).strict();
export type OwnerHostConnection = z.infer<typeof OwnerHostConnection>;

/** The connection broker's public path for direct WSS to a harness's owner host. */
export function ownerHostBrokerPath(harness: string): string {
  return `/hosts/${harness}`;
}

/** Internal: the broker asks the dispatcher to consume one owner-host ticket presented on `/hosts/{harness}`. */
export const BrokerHostTicketRequest = z.object({
  harness: z.string().regex(HOST_HARNESS),
  ticket: z.string().min(32).max(200),
}).strict();
export type BrokerHostTicketRequest = z.infer<typeof BrokerHostTicketRequest>;

/** An internal HTTP origin: no credentials, path, query, or fragment. */
export function isInternalHttpOrigin(value: string): boolean {
  const url = new URL(value);
  return url.protocol === "http:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
}

/**
 * Where the broker forwards one consumed owner-host ticket: the host's internal HTTP origin and a one-use upstream
 * ticket for the same host epoch, which the host's own ticket check accepts. The client's ticket never leaves the
 * broker, and neither ticket opens a host that was replaced after the client's ticket was issued.
 */
export const HostBrokerRoute = z.object({
  kind: z.literal("host"),
  harness: z.string().regex(HOST_HARNESS),
  epoch: z.string().uuid(),
  endpoint: z.url().refine(isInternalHttpOrigin, "An owner host's broker endpoint must be an internal HTTP origin."),
  upstreamTicket: z.string().min(32).max(200),
}).strict();
export type HostBrokerRoute = z.infer<typeof HostBrokerRoute>;

export const BrokerHostTicketResult = z.union([
  z.object({ authorized: z.literal(false) }).strict(),
  z.object({ authorized: z.literal(true), route: HostBrokerRoute }).strict(),
]);
export type BrokerHostTicketResult = z.infer<typeof BrokerHostTicketResult>;

export const HostLease = z.object({
  epoch: z.string().uuid(),
  computeId: z.string().uuid(),
  expiresAt: z.string().datetime(),
}).strict();
export type HostLease = z.infer<typeof HostLease>;


/**
 * The canonical hosted-session (ledger) identity for a runtime session ID. A host mints its own runtime session IDs
 * (currently UUIDs without hyphens), separately from the client's AHP session URI; grants, the ledger, and the API
 * use the hyphenated form. Non-UUID identities are refused.
 */
export function canonicalSessionId(id: string): string | undefined {
  if (!UUID_SPELLING.test(id)) return undefined;
  const hex = id.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const HostedSession = z.object({
  id: z.string().uuid(),
  /** The client-visible AHP session ID, once the host has attributed its catalog entry; clients resume with it. */
  ahpSessionId: z.string().regex(AHP_SESSION_ID).optional(),
  harness: z.object({ definition: HarnessDefinition, digest: z.string() }).strict(),
  model: z.string(),
  tokenBudget: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  closed: z.boolean(),
}).strict();
export type HostedSession = z.infer<typeof HostedSession>;

export const HostControlRequest = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("session"), sessionId: z.string().uuid(), resume: z.boolean() }).strict(),
  /** Records the client-visible AHP session ID of a session the host created. */
  z.object({ operation: z.literal("catalog"), sessionId: z.string().uuid(), ahpSessionId: z.string().regex(AHP_SESSION_ID) }).strict(),
  z.object({ operation: z.literal("token"), sessionId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal("close"), sessionId: z.string().uuid() }).strict(),
]);
export type HostControlRequest = z.infer<typeof HostControlRequest>;
