import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ConfigError } from "./config.js";
import { HttpError } from "./http.js";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time comparison of two secrets of arbitrary length. */
export function secretsEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export interface Principal {
  id: string;
}

/**
 * Authenticates callers with API keys configured as `principal:key` pairs separated by
 * semicolons. Keys are kept only as SHA-256 digests in memory. Each principal is a tenant:
 * it can only see and act on its own jobs.
 */
export class ApiKeyAuthenticator {
  readonly #keys = new Map<string, string>();

  constructor(spec: string) {
    for (const entry of spec.split(";").map((s) => s.trim()).filter(Boolean)) {
      const separator = entry.indexOf(":");
      if (separator <= 0 || separator === entry.length - 1) {
        throw new ConfigError("API_KEYS entries must have the form principal:key.");
      }
      const principal = entry.slice(0, separator).trim();
      const key = entry.slice(separator + 1).trim();
      if (!/^[A-Za-z0-9._@-]{1,128}$/.test(principal)) {
        throw new ConfigError(`Invalid principal name in API_KEYS: '${principal}'.`);
      }
      if (key.length < 24) {
        throw new ConfigError(`API key for principal '${principal}' is too short (minimum 24 characters).`);
      }
      this.#keys.set(sha256(key).toString("hex"), principal);
    }
    if (this.#keys.size === 0) {
      throw new ConfigError("API_KEYS must configure at least one principal.");
    }
  }

  authenticate(request: FastifyRequest): Principal {
    const key = bearerToken(request) ?? headerValue(request, "x-api-key");
    if (!key) {
      throw new HttpError(401, "unauthenticated", "An API key is required.");
    }
    const principal = this.#keys.get(sha256(key).toString("hex"));
    if (!principal) {
      throw new HttpError(401, "unauthenticated", "The API key is not valid.");
    }
    return { id: principal };
  }
}

/** Validates a shared service key presented in `x-internal-key`. */
export function requireInternalKey(request: FastifyRequest, expected: string): void {
  const presented = headerValue(request, "x-internal-key");
  if (!presented || !secretsEqual(presented, expected)) {
    throw new HttpError(401, "unauthenticated", "Service authentication failed.");
  }
}

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = headerValue(request, "authorization");
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim();
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
