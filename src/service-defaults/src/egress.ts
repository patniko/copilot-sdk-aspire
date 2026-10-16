import { lookup as systemLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * Outbound HTTP filter for requests that leave a shared, in-process worker on behalf of an agent:
 * filtered web access and remote MCP servers. It refuses non-public destinations, resolves DNS once
 * per hop and pins the connection to the vetted addresses, rechecks every redirect hop, bounds time
 * and size, and never sends caller credentials after a redirect.
 *
 * It filters only requests made through it. It is not a network sandbox: other code in the process,
 * containers, and the runtime's own networking are unaffected (egress is not enforced there).
 */

export type AddressCategory =
  | "public"
  | "unspecified"
  | "loopback"
  | "private"
  | "shared"
  | "link-local"
  | "metadata"
  | "cloud-platform"
  | "protocol-assignment"
  | "documentation"
  | "benchmarking"
  | "multicast"
  | "broadcast"
  | "reserved"
  | "unique-local"
  | "site-local"
  | "ipv4-mapped"
  | "ipv4-compatible"
  | "ipv4-translated"
  | "6to4"
  | "teredo"
  | "discard";

export interface AddressClassification {
  address: string;
  family: 4 | 6;
  category: AddressCategory;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Categories an operator can deliberately allow for one catalog origin during development.
 * Link-local, metadata, cloud-platform, unspecified, multicast, reserved, and transition forms never are.
 */
export const DEVELOPMENT_NETWORK_CATEGORIES: ReadonlySet<AddressCategory> = new Set(["loopback", "private", "shared", "unique-local"]);

export type EgressErrorCode =
  | "invalid_url"
  | "scheme"
  | "credentials_in_url"
  | "hostname"
  | "address"
  | "internal"
  | "dns"
  | "redirect"
  | "insecure_credentials"
  | "too_large"
  | "encoding"
  | "timeout"
  | "aborted"
  | "network";

/** A refused or failed outbound request. Messages are safe to show to a model: no addresses or credentials. */
export class EgressError extends Error {
  constructor(
    readonly code: EgressErrorCode,
    message: string,
    readonly category?: AddressCategory,
  ) {
    super(message);
    this.name = "EgressError";
  }
}

const CATEGORY_TEXT: Record<AddressCategory, string> = {
  public: "a public address",
  unspecified: "an unspecified address",
  loopback: "a loopback address",
  private: "a private network address",
  shared: "a shared (carrier-grade NAT) address",
  "link-local": "a link-local address",
  metadata: "a cloud metadata address",
  "cloud-platform": "a cloud platform service address",
  "protocol-assignment": "an IETF protocol-assignment address",
  documentation: "a documentation address",
  benchmarking: "a benchmarking address",
  multicast: "a multicast address",
  broadcast: "a broadcast address",
  reserved: "a reserved address",
  "unique-local": "an IPv6 unique-local address",
  "site-local": "an IPv6 site-local address",
  "ipv4-mapped": "an IPv4-mapped IPv6 address",
  "ipv4-compatible": "an IPv4-compatible IPv6 address",
  "ipv4-translated": "an IPv4-translated IPv6 address",
  "6to4": "a 6to4 address",
  teredo: "a Teredo address",
  discard: "a discard-only address",
};

// Most specific first. Sources: IANA IPv4/IPv6 special-purpose registries and cloud metadata endpoints.
const IPV4_RANGES: ReadonlyArray<readonly [string, number, AddressCategory]> = [
  ["169.254.169.254", 32, "metadata"],
  ["169.254.170.2", 32, "metadata"],
  ["169.254.170.23", 32, "metadata"],
  ["100.100.100.200", 32, "metadata"],
  ["192.0.0.192", 32, "metadata"],
  ["168.63.129.16", 32, "cloud-platform"],
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "protocol-assignment"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "reserved"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["255.255.255.255", 32, "broadcast"],
  ["240.0.0.0", 4, "reserved"],
];

const IPV6_RANGES: ReadonlyArray<readonly [string, number, AddressCategory]> = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["::ffff:0:0", 96, "ipv4-mapped"],
  ["::ffff:0:0:0", 96, "ipv4-translated"],
  ["::", 96, "ipv4-compatible"],
  ["64:ff9b::", 96, "ipv4-translated"],
  ["64:ff9b:1::", 48, "ipv4-translated"],
  ["100::", 64, "discard"],
  ["2001::", 32, "teredo"],
  ["2001:db8::", 32, "documentation"],
  ["2001::", 23, "protocol-assignment"],
  ["2002::", 16, "6to4"],
  ["3fff::", 20, "documentation"],
  ["fd00:ec2::", 32, "metadata"],
  ["fc00::", 7, "unique-local"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
];

const GLOBAL_UNICAST_V6: Network = { family: 6, value: parseIPv6Value("2000::")!, prefix: 3 };

/** Parses a canonical dotted-quad IPv4 address. Numeric shorthands are normalized earlier by the WHATWG URL parser. */
export function parseIPv4Value(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** Parses an IPv6 address, including embedded dotted IPv4 and an ignored zone identifier. */
export function parseIPv6Value(text: string): bigint | undefined {
  let input = text.toLowerCase();
  const zone = input.indexOf("%");
  if (zone >= 0) input = input.slice(0, zone);
  if (input.length < 2 || input.length > 45) return undefined;
  let embedded: number[] = [];
  if (input.includes(".")) {
    const index = input.lastIndexOf(":");
    if (index < 0) return undefined;
    const v4 = parseIPv4Value(input.slice(index + 1));
    if (v4 === undefined) return undefined;
    embedded = [Math.floor(v4 / 65_536), v4 % 65_536];
    input = input.slice(0, index + 1);
    if (!input.endsWith("::")) input = input.slice(0, -1);
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const values: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      values.push(Number.parseInt(group, 16));
    }
    return values;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const explicit = head.length + tail.length + embedded.length;
  let all: number[];
  if (halves.length === 2) {
    if (explicit > 7) return undefined;
    all = [...head, ...new Array<number>(8 - explicit).fill(0), ...tail, ...embedded];
  } else {
    if (explicit !== 8) return undefined;
    all = [...head, ...embedded];
  }
  let value = 0n;
  for (const group of all) value = (value << 16n) | BigInt(group);
  return value;
}

interface Network {
  family: 4 | 6;
  value: number | bigint;
  prefix: number;
}

function inNetwork(family: 4 | 6, value: number | bigint, network: Network): boolean {
  if (family !== network.family) return false;
  if (family === 4) {
    const size = 2 ** (32 - network.prefix);
    return Math.floor((value as number) / size) === Math.floor((network.value as number) / size);
  }
  const shift = BigInt(128 - network.prefix);
  return ((value as bigint) >> shift) === ((network.value as bigint) >> shift);
}

const V4_TABLE = IPV4_RANGES.map(([address, prefix, category]) => ({ network: { family: 4 as const, value: parseIPv4Value(address)!, prefix }, category }));
const V6_TABLE = IPV6_RANGES.map(([address, prefix, category]) => ({ network: { family: 6 as const, value: parseIPv6Value(address)!, prefix }, category }));

function parseAddress(address: string): { family: 4 | 6; value: number | bigint } | undefined {
  const v4 = parseIPv4Value(address);
  if (v4 !== undefined) return { family: 4, value: v4 };
  const v6 = parseIPv6Value(address);
  return v6 === undefined ? undefined : { family: 6, value: v6 };
}

/** Classifies an IP address literal. Anything that is not global unicast is refused by default. */
export function classifyAddress(address: string): AddressClassification {
  const parsed = parseAddress(address);
  if (!parsed) throw new EgressError("address", "The destination is not a valid IP address.");
  const table = parsed.family === 4 ? V4_TABLE : V6_TABLE;
  const match = table.find((entry) => inNetwork(parsed.family, parsed.value, entry.network));
  let category: AddressCategory = match?.category ?? "public";
  if (!match && parsed.family === 6 && !inNetwork(6, parsed.value, GLOBAL_UNICAST_V6)) category = "reserved";
  return { address, family: parsed.family, category };
}

/** Parses an address or CIDR network used in operator configuration. */
export function parseNetwork(text: string): Network {
  const [address, prefixText, extra] = text.trim().split("/");
  const parsed = address ? parseAddress(address) : undefined;
  if (!parsed || extra !== undefined) throw new Error(`Invalid network '${text}'.`);
  const max = parsed.family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) {
    throw new Error(`Invalid network prefix in '${text}'.`);
  }
  return { family: parsed.family, value: parsed.value, prefix };
}

// Special-use and private-use names that never identify a public web destination.
const RESERVED_SUFFIXES = ["localhost", "local", "internal", "arpa", "localdomain", "invalid", "onion"];

/** Normalizes a hostname (lowercase, one trailing dot removed). Returns undefined for malformed names. */
export function normalizeHostname(hostname: string): string | undefined {
  let name = hostname.toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (!name || name.length > 253 || name.split(".").some((label) => !label || label.length > 63)) return undefined;
  return name;
}

function hostnameRefusal(name: string): string | undefined {
  const labels = name.split(".");
  if (labels.length < 2) return "Single-label host names are not reachable from shared sessions.";
  const last = labels.at(-1)!;
  if (RESERVED_SUFFIXES.includes(last)) return "The host name uses a reserved local or private-use domain.";
  // No delegated top-level domain starts with a digit; such names are numeric address forms.
  if (/^[0-9]/.test(last)) return "The host name is not a valid public domain name.";
  return undefined;
}

export interface InternalEndpoint {
  /** Host name, IP address, or CIDR network of a deployment service, such as service discovery or the database. */
  host: string;
  /** When set, only this port is refused (by name and by resolved address); otherwise every port is. */
  port?: number;
}

interface InternalRule extends Network {
  port?: number;
}

function defaultPort(protocol: string): number | undefined {
  return protocol === "https:" || protocol === "wss:" ? 443 : protocol === "http:" || protocol === "ws:" ? 80
    : protocol === "postgres:" || protocol === "postgresql:" ? 5432 : protocol === "redis:" || protocol === "rediss:" ? 6379 : undefined;
}

function endpointFromUrl(value: string): InternalEndpoint | undefined {
  try {
    const url = new URL(value);
    if (!url.hostname) return undefined;
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    const port = url.port ? Number(url.port) : defaultPort(url.protocol);
    return port === undefined ? { host } : { host, port };
  } catch {
    return undefined;
  }
}

function endpointsFromConnectionString(value: string): InternalEndpoint[] {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const endpoint = endpointFromUrl(value);
    return endpoint ? [endpoint] : [];
  }
  const parts = new Map<string, string>();
  for (const segment of value.split(";")) {
    const index = segment.indexOf("=");
    if (index > 0) parts.set(segment.slice(0, index).trim().toLowerCase().replaceAll(" ", ""), segment.slice(index + 1).trim());
  }
  const hosts = parts.get("host") ?? parts.get("server") ?? parts.get("datasource") ?? parts.get("endpoint");
  if (!hosts) return [];
  const port = Number(parts.get("port"));
  return hosts.split(",").map((entry) => entry.trim()).filter(Boolean).flatMap((entry): InternalEndpoint[] => {
    const embedded = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(entry);
    if (embedded) return [{ host: embedded[1] ?? embedded[2]!, port: Number(embedded[3]) }];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(entry)) {
      const endpoint = endpointFromUrl(entry);
      return endpoint ? [endpoint] : [];
    }
    return [Number.isInteger(port) && port > 0 ? { host: entry, port } : { host: entry }];
  });
}

/**
 * Derives the deployment's own service endpoints from Aspire service discovery (`services__*`) and
 * connection strings (`ConnectionStrings__*`), so the filter refuses them even when they are public.
 */
export function internalEndpointsFromEnvironment(env: NodeJS.ProcessEnv = process.env): InternalEndpoint[] {
  const endpoints: InternalEndpoint[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^services__.+__\d+$/i.test(key)) {
      const endpoint = endpointFromUrl(value);
      if (endpoint) endpoints.push(endpoint);
    } else if (/^ConnectionStrings__/i.test(key)) {
      endpoints.push(...endpointsFromConnectionString(value));
    }
  }
  const seen = new Set<string>();
  return endpoints.filter((endpoint) => {
    const key = `${endpoint.host.toLowerCase()}|${endpoint.port ?? "*"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface EgressFilterOptions {
  /** The deployment's own service addresses. Refused on every request, including for development exceptions. */
  internal?: InternalEndpoint[];
  /** Additional networks refused on every port, for example a managed database's address range. */
  deniedNetworks?: string[];
  /** How long resolved internal host names are reused before resolving again. */
  internalRefreshMs?: number;
  /** Test seams only: never configure these in a service. */
  testing?: {
    resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
    dial?: (address: ResolvedAddress, port: number) => ResolvedAddress;
  };
}

export interface VetOptions {
  /** Operator-only development exception for loopback, private, shared, and unique-local addresses. */
  allowPrivateNetwork?: boolean;
  signal?: AbortSignal;
}

export interface VettedTarget {
  url: URL;
  /** Host for the connection and TLS name checks: no brackets, no trailing dot. */
  hostname: string;
  port: number;
  secure: boolean;
  addresses: AddressClassification[];
}

export interface EgressRequestOptions {
  url: string | URL;
  method?: "GET" | "POST" | "DELETE";
  /** Sent on every hop. Must not carry credentials. */
  headers?: Record<string, string>;
  /** Sent only on the first hop to the requested origin; never after a redirect. Requires HTTPS to public hosts. */
  credentials?: Record<string, string>;
  body?: string | Uint8Array;
  /** Zero (the default) refuses redirects. Only GET requests follow them. */
  maxRedirects?: number;
  maxResponseBytes: number;
  /** `error` (default) fails oversized responses; `truncate` keeps the first `maxResponseBytes`. */
  overflow?: "error" | "truncate";
  /** One deadline for DNS, connection, every redirect hop, and the body. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Applies only to the requested origin, never to a redirect target on another origin. */
  allowPrivateNetwork?: boolean;
  /** Called before following a redirect; throw to refuse it. The target has not been vetted yet. */
  onRedirect?: (from: URL, to: URL) => Promise<void> | void;
}

export interface EgressResponse {
  readonly url: URL;
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** True once a `truncate` body stopped at the byte limit. */
  readonly truncated: boolean;
  /** Decompressed, bounded body; can be consumed once. */
  chunks(): AsyncIterable<Buffer>;
  bytes(): Promise<Buffer>;
  close(): void;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_LOCATION_LENGTH = 4096;
const MAX_TIMEOUT_MS = 10 * 60_000;

function nodeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

function abortReason(signal: AbortSignal): EgressError {
  return signal.reason instanceof EgressError ? signal.reason : new EgressError("aborted", "The request was cancelled.");
}

/**
 * Replaces Node network, TLS, parser, and decompression errors with model-safe messages: their native
 * messages can contain internal addresses. Errors without a code (for example from `onRedirect`) pass through.
 */
function convertError(error: unknown, signal: AbortSignal): unknown {
  if (error instanceof EgressError) return error;
  if (signal.aborted) return abortReason(signal);
  const code = nodeErrorCode(error);
  if (!code) return error;
  if (code.startsWith("Z_") || code.startsWith("ERR__") || code.includes("BROTLI") || code === "ERR_ZLIB_INITIALIZATION_FAILED") {
    return new EgressError("encoding", "The response body could not be decoded.");
  }
  if (code.includes("CERT") || code.startsWith("UNABLE_") || code.startsWith("DEPTH_") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL")) {
    return new EgressError("network", "The server's TLS certificate could not be verified.");
  }
  if (code.startsWith("HPE_")) return new EgressError("network", "The server sent an invalid or oversized HTTP response.");
  return new EgressError("network", "The connection to the server failed.");
}

function lookupFamily(options: unknown): number | undefined {
  const family = typeof options === "number" ? options : (options as { family?: unknown } | undefined)?.family;
  if (family === "IPv4" || family === 4) return 4;
  if (family === "IPv6" || family === 6) return 6;
  return undefined;
}

/** Resolves and validates a redirect location: HTTP(S) only, no HTTPS-to-HTTP downgrade, no embedded credentials. */
export function resolveRedirect(current: URL, location: string): URL {
  if (location.length > MAX_LOCATION_LENGTH) throw new EgressError("redirect", "The redirect location is too long.");
  let next: URL;
  try { next = new URL(location, current); }
  catch { throw new EgressError("redirect", "The redirect location is not a valid URL."); }
  if (next.protocol !== "http:" && next.protocol !== "https:") throw new EgressError("redirect", "The redirect target does not use HTTP or HTTPS.");
  if (current.protocol === "https:" && next.protocol === "http:") throw new EgressError("redirect", "Redirects from HTTPS to plain HTTP are refused.");
  if (next.username || next.password) throw new EgressError("credentials_in_url", "The redirect target contains credentials.");
  next.hash = "";
  return next;
}

/** One outbound filter per process or deployment configuration; safe for concurrent use. */
export class EgressFilter {
  readonly #staticRules: InternalRule[] = [];
  readonly #deniedNetworks: Network[];
  readonly #internalNames = new Map<string, Set<number | undefined>>();
  readonly #resolvedByName = new Map<string, InternalRule[]>();
  #resolvedInternal: InternalRule[] = [];
  #resolvedAt = 0;
  #refreshing?: Promise<void>;
  readonly #refreshMs: number;
  readonly #resolve: (hostname: string) => Promise<ResolvedAddress[]>;
  readonly #dial: (address: ResolvedAddress, port: number) => ResolvedAddress;

  constructor(options: EgressFilterOptions = {}) {
    this.#refreshMs = options.internalRefreshMs ?? 60_000;
    this.#resolve = options.testing?.resolve ?? (async (hostname) => (await systemLookup(hostname, { all: true, verbatim: true }))
      .map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 as const : 4 as const })));
    this.#dial = options.testing?.dial ?? ((address) => address);
    this.#deniedNetworks = (options.deniedNetworks ?? []).map(parseNetwork);
    for (const endpoint of options.internal ?? []) {
      if (endpoint.port !== undefined && (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65_535)) {
        throw new Error(`Invalid internal endpoint port for '${endpoint.host}'.`);
      }
      const host = endpoint.host.trim().replace(/^\[(.*)\]$/, "$1");
      if (isIP(host.split("/")[0] ?? "") || host.includes("/")) {
        this.#staticRules.push({ ...parseNetwork(host), port: endpoint.port });
        continue;
      }
      const name = normalizeHostname(host);
      if (!name) throw new Error(`Invalid internal endpoint host '${endpoint.host}'.`);
      const ports = this.#internalNames.get(name) ?? new Set<number | undefined>();
      ports.add(endpoint.port);
      this.#internalNames.set(name, ports);
    }
  }

  /** Validates a URL and resolves it to addresses that may be dialed. Every refusal is an {@link EgressError}. */
  async vet(input: string | URL, options: VetOptions = {}): Promise<VettedTarget> {
    let url: URL;
    try { url = new URL(input); }
    catch { throw new EgressError("invalid_url", "The URL is not valid."); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new EgressError("scheme", "Only HTTP and HTTPS URLs are allowed.");
    if (url.username || url.password) throw new EgressError("credentials_in_url", "URLs with embedded credentials are refused.");
    const secure = url.protocol === "https:";
    const port = url.port ? Number(url.port) : secure ? 443 : 80;
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    await this.#refreshInternal(signal);
    let hostname = url.hostname;
    let candidates: ResolvedAddress[];
    if (hostname.startsWith("[")) {
      hostname = hostname.slice(1, -1);
      candidates = [{ address: hostname, family: 6 }];
    } else if (isIP(hostname) === 4) {
      candidates = [{ address: hostname, family: 4 }];
    } else {
      const name = normalizeHostname(hostname);
      if (!name) throw new EgressError("hostname", "The host name is not valid.");
      // The development exception covers an operator-configured origin such as `localhost` or a
      // single-label container name; its resolved addresses are still checked below.
      const refusal = options.allowPrivateNetwork === true ? undefined : hostnameRefusal(name);
      if (refusal) throw new EgressError("hostname", refusal);
      const internalPorts = this.#internalNames.get(name);
      if (internalPorts && (internalPorts.has(undefined) || internalPorts.has(port))) {
        throw new EgressError("internal", "The host is one of this deployment's internal services.");
      }
      hostname = name;
      candidates = await this.#lookup(name, signal);
    }
    const addresses = candidates.map((candidate) => classifyAddress(candidate.address));
    for (const address of addresses) {
      const allowed = address.category === "public"
        || (options.allowPrivateNetwork === true && DEVELOPMENT_NETWORK_CATEGORIES.has(address.category));
      if (!allowed) {
        throw new EgressError("address", `The destination resolves to ${CATEGORY_TEXT[address.category]}, which shared sessions may not reach.`, address.category);
      }
      if (this.#isInternal(address, port)) throw new EgressError("internal", "The destination is one of this deployment's internal services.");
    }
    return { url, hostname, port, secure, addresses };
  }

  async #lookup(name: string, signal?: AbortSignal): Promise<ResolvedAddress[]> {
    let answers: ResolvedAddress[];
    try {
      answers = await raceSignal(this.#resolve(`${name}.`), signal);
    } catch (error) {
      if (error instanceof EgressError) throw error;
      if (signal?.aborted) throw abortReason(signal);
      throw new EgressError("dns", "The host name could not be resolved.");
    }
    const unique = new Map<string, ResolvedAddress>();
    for (const answer of answers) {
      if (!isIP(answer.address.split("%")[0] ?? "")) throw new EgressError("dns", "The host name resolved to an invalid address.");
      unique.set(answer.address, answer);
    }
    if (!unique.size) throw new EgressError("dns", "The host name has no addresses.");
    return [...unique.values()];
  }

  #isInternal(address: AddressClassification, port: number): boolean {
    const parsed = parseAddress(address.address)!;
    const matches = (rule: InternalRule) => (rule.port === undefined || rule.port === port) && inNetwork(parsed.family, parsed.value, rule);
    return this.#deniedNetworks.some((network) => inNetwork(parsed.family, parsed.value, network))
      || this.#staticRules.some(matches) || this.#resolvedInternal.some(matches);
  }

  async #refreshInternal(signal?: AbortSignal): Promise<void> {
    if (!this.#internalNames.size || Date.now() - this.#resolvedAt < this.#refreshMs) return;
    this.#refreshing ??= (async () => {
      await Promise.all([...this.#internalNames].map(async ([name, ports]) => {
        try {
          const answers = await raceSignal(this.#resolve(`${name}.`), AbortSignal.timeout(5_000));
          const rules: InternalRule[] = [];
          for (const answer of answers) {
            const parsed = parseAddress(answer.address.split("%")[0] ?? "");
            if (!parsed) continue;
            for (const port of ports) rules.push({ family: parsed.family, value: parsed.value, prefix: parsed.family === 4 ? 32 : 128, port });
          }
          this.#resolvedByName.set(name, rules);
        } catch {
          // Keep the last resolved addresses: a resolver outage must not drop protections.
        }
      }));
      this.#resolvedInternal = [...this.#resolvedByName.values()].flat();
      this.#resolvedAt = Date.now();
    })().finally(() => { this.#refreshing = undefined; });
    await raceSignal(this.#refreshing, signal);
  }

  /**
   * Sends one request through the filter. Every hop is vetted and pinned; redirects are followed only
   * when allowed, for GET, never downgrade HTTPS, and never carry `credentials`.
   */
  async request(options: EgressRequestOptions): Promise<EgressResponse> {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) throw new Error("Invalid egress timeout.");
    if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1) throw new Error("Invalid egress response limit.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new EgressError("timeout", "The request timed out.")), options.timeoutMs);
    const onAbort = () => controller.abort(new EgressError("aborted", "The request was cancelled."));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const initial = (() => {
      try { return new URL(options.url); }
      catch { return undefined; }
    })();
    try {
      if (!initial) throw new EgressError("invalid_url", "The URL is not valid.");
      initial.hash = "";
      let current = initial;
      const method = options.method ?? "GET";
      const maxRedirects = options.maxRedirects ?? 0;
      for (let hop = 0; ; hop++) {
        const target = await this.vet(current, {
          allowPrivateNetwork: options.allowPrivateNetwork === true && current.origin === initial.origin,
          signal: controller.signal,
        });
        const credentials = hop === 0 ? options.credentials : undefined;
        if (credentials && Object.keys(credentials).length && !target.secure && target.addresses.some((address) => address.category === "public")) {
          throw new EgressError("insecure_credentials", "Credentials are sent only over HTTPS, except to an approved development server.");
        }
        const response = await this.#send(target, method, options.headers, credentials, hop === 0 ? options.body : undefined, controller.signal);
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (REDIRECT_STATUSES.has(status) && location !== undefined) {
          response.destroy();
          if (maxRedirects === 0) throw new EgressError("redirect", "The server answered with a redirect, which this request does not follow.");
          if (hop >= maxRedirects) throw new EgressError("redirect", `The server redirected more than ${maxRedirects} times.`);
          if (method !== "GET") throw new EgressError("redirect", "Only GET requests follow redirects.");
          const next = resolveRedirect(current, location);
          await options.onRedirect?.(current, next);
          controller.signal.throwIfAborted();
          current = next;
          continue;
        }
        return this.#wrap(current, response, options, controller.signal, cleanup);
      }
    } catch (error) {
      cleanup();
      throw convertError(error, controller.signal);
    }
  }

  #send(
    target: VettedTarget,
    method: string,
    headers: Record<string, string> | undefined,
    credentials: Record<string, string> | undefined,
    body: string | Uint8Array | undefined,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    const pinned = target.addresses.map((address) => this.#dial({ address: address.address, family: address.family }, target.port));
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      const family = lookupFamily(lookupOptions);
      const matching = pinned.filter((entry) => !family || entry.family === family);
      if (!matching.length) {
        callback(Object.assign(new Error("No vetted address for the requested family."), { code: "ENOTFOUND" }), "", 0);
        return;
      }
      if (typeof lookupOptions === "object" && lookupOptions?.all) callback(null, matching);
      else callback(null, matching[0]!.address, matching[0]!.family);
    };
    const outgoing: OutgoingHttpHeaders = { ...headers, ...credentials };
    if (body !== undefined) outgoing["content-length"] = Buffer.byteLength(body);
    const requestOptions: RequestOptions = {
      host: target.hostname,
      port: target.port,
      method,
      path: `${target.url.pathname}${target.url.search}`,
      headers: outgoing,
      agent: false,
      lookup,
      signal,
      maxHeaderSize: 16 * 1024,
    };
    return new Promise((resolve, reject) => {
      const request = (target.secure ? httpsRequest : httpRequest)(requestOptions, (response) => {
        // A socket failure after the headers must not become an unhandled 'error' event.
        response.on("error", () => undefined);
        resolve(response);
      });
      request.on("error", reject);
      request.end(body);
    });
  }

  #wrap(url: URL, response: IncomingMessage, options: EgressRequestOptions, signal: AbortSignal, cleanup: () => void): EgressResponse {
    const limit = options.maxResponseBytes;
    const overflow = options.overflow ?? "error";
    const declared = Number(response.headers["content-length"]);
    const encoding = String(response.headers["content-encoding"] ?? "identity").trim().toLowerCase();
    const fail = (error: EgressError): never => {
      response.destroy();
      cleanup();
      throw error;
    };
    if (overflow === "error" && Number.isFinite(declared) && declared > limit) fail(new EgressError("too_large", "The response is larger than the allowed size."));
    let stream: Readable = response;
    const decoder = encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
      : encoding === "br" ? createBrotliDecompress() : undefined;
    if (decoder) stream = pipeline(response, decoder, () => undefined);
    else if (encoding !== "identity" && encoding !== "") fail(new EgressError("encoding", "The response uses an unsupported content encoding."));
    const destroy = () => { response.destroy(abortReason(signal)); };
    signal.addEventListener("abort", destroy, { once: true });
    let consumed = false;
    let closed = false;
    const state = { truncated: false };
    const close = () => {
      if (closed) return;
      closed = true;
      signal.removeEventListener("abort", destroy);
      response.destroy();
      stream.destroy();
      cleanup();
    };
    async function* chunks(): AsyncGenerator<Buffer> {
      if (consumed) throw new Error("The response body was already consumed.");
      consumed = true;
      let total = 0;
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          if (total + chunk.length > limit) {
            if (overflow === "error") throw new EgressError("too_large", "The response is larger than the allowed size.");
            const rest = chunk.subarray(0, limit - total);
            state.truncated = true;
            if (rest.length) yield rest;
            return;
          }
          total += chunk.length;
          yield chunk;
        }
      } catch (error) {
        throw convertError(error, signal);
      } finally {
        close();
      }
    }
    return {
      url,
      status: response.statusCode ?? 0,
      headers: response.headers,
      get truncated() { return state.truncated; },
      chunks,
      async bytes() {
        const parts: Buffer[] = [];
        for await (const chunk of chunks()) parts.push(chunk);
        return Buffer.concat(parts);
      },
      close,
    };
  }
}

async function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortReason(signal);
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
