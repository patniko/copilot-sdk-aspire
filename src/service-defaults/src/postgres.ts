import { DefaultAzureCredential } from "@azure/identity";
import pg from "pg";
import { ConfigError } from "./config.js";

const ENTRA_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default";

export interface PostgresConnectionInfo {
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  ssl: boolean;
}

/**
 * Reads the connection for an Aspire database reference. Supports the ADO.NET-style
 * `ConnectionStrings__<name>` value and a `postgres://` URI.
 */
export function readPostgresConnection(name: string): PostgresConnectionInfo {
  const raw =
    process.env[`ConnectionStrings__${name}`] ?? process.env[`${name.toUpperCase()}_URI`] ?? process.env.DATABASE_URL;
  if (!raw) {
    throw new ConfigError(`No connection string configured for database '${name}'.`);
  }
  return parsePostgresConnectionString(raw);
}

export function parsePostgresConnectionString(raw: string): PostgresConnectionInfo {
  if (/^postgres(ql)?:\/\//i.test(raw)) {
    const url = new URL(raw);
    const sslmode = url.searchParams.get("sslmode");
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 5432,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
      user: decodeURIComponent(url.username),
      password: url.password ? decodeURIComponent(url.password) : undefined,
      ssl: sslmode === "require" || sslmode === "verify-full" || isAzureHost(url.hostname),
    };
  }
  const parts = new Map<string, string>();
  for (const segment of raw.split(";")) {
    const index = segment.indexOf("=");
    if (index > 0) {
      parts.set(segment.slice(0, index).trim().toLowerCase().replaceAll(" ", ""), segment.slice(index + 1).trim());
    }
  }
  const host = parts.get("host") ?? parts.get("server");
  if (!host) {
    throw new ConfigError("Postgres connection string has no Host.");
  }
  const sslMode = parts.get("sslmode")?.toLowerCase();
  return {
    host,
    port: Number(parts.get("port") ?? "5432"),
    database: parts.get("database") ?? "postgres",
    user: parts.get("username") ?? parts.get("userid") ?? parts.get("user") ?? "postgres",
    password: parts.get("password"),
    ssl: sslMode === "require" || sslMode === "verifyfull" || isAzureHost(host),
  };
}

function isAzureHost(host: string): boolean {
  return host.endsWith(".postgres.database.azure.com");
}

/**
 * Creates a pool. When no password is configured the pool authenticates with a Microsoft Entra
 * token for the workload's managed identity, refreshed per connection.
 */
export function createPostgresPool(info: PostgresConnectionInfo, max = 10): pg.Pool {
  let password: pg.PoolConfig["password"] = info.password;
  if (!password) {
    const credential = new DefaultAzureCredential();
    password = async () => {
      const token = await credential.getToken(ENTRA_POSTGRES_SCOPE);
      if (!token) {
        throw new Error("Failed to acquire a Microsoft Entra token for PostgreSQL.");
      }
      return token.token;
    };
  }
  return new pg.Pool({
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.user,
    password,
    ssl: info.ssl ? { rejectUnauthorized: true } : undefined,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
}
