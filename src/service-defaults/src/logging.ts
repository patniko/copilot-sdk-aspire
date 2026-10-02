import { pino, type Logger } from "pino";

/**
 * Paths removed from every log record. Payload capture is disabled by default:
 * services log identifiers and outcomes, never prompts, tool output, or credentials.
 */
export const REDACT_PATHS = [
  "authorization",
  "*.authorization",
  "headers.authorization",
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers[\"x-api-key\"]",
  "req.headers[\"x-internal-key\"]",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "password",
  "*.password",
  "secret",
  "*.secret",
];

export function createLogger(service: string): Logger {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? "info",
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: { service },
  });
}

export type { Logger };
