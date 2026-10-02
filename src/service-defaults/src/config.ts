export class ConfigError extends Error {}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Required configuration '${name}' is not set.`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new ConfigError(`Configuration '${name}' must be an integer.`);
  }
  return value;
}

/** Resolves a service endpoint injected by Aspire service discovery. */
export function serviceUrl(service: string, endpoint = "http"): string {
  const upper = service.toUpperCase().replaceAll("-", "_");
  const candidates = [
    `services__${service}__${endpoint}__0`,
    `services__${service}__https__0`,
    `${upper}_${endpoint.toUpperCase()}`,
    `${upper}_HTTPS`,
    `${upper}_URL`,
  ];
  for (const key of candidates) {
    const value = process.env[key];
    if (value) {
      return value.replace(/\/+$/, "");
    }
  }
  throw new ConfigError(`No endpoint configured for service '${service}' (looked for ${candidates.join(", ")}).`);
}

/** Port to listen on: Aspire sets PORT for Node apps and containers. */
export function listenPort(fallback: number): number {
  return intEnv("PORT", fallback);
}
