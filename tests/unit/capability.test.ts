import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { entraPrincipalName, parsePostgresConnectionString, signCapability, verifyCapability } from "@copilot-agent/service-defaults";

const key = "k".repeat(64);
const grant = () => ({
  attemptId: randomUUID(),
  jti: randomUUID(),
  jobId: randomUUID(),
  attempt: 1,
  principal: "dev",
  models: ["grok-4.6"],
  tokenBudget: 1000,
  expiresAt: new Date(Date.now() + 60_000),
});

describe("capabilities", () => {
  it("round-trips claims bound to one attempt and model list", async () => {
    const g = grant();
    const claims = await verifyCapability(key, await signCapability(key, g));
    expect(claims).toMatchObject({ sub: g.attemptId, jti: g.jti, job: g.jobId, prn: "dev", mdl: ["grok-4.6"], tok: 1000 });
  });

  it("rejects tokens signed with another key", async () => {
    await expect(verifyCapability(key, await signCapability("x".repeat(64), grant()))).rejects.toThrow();
  });

  it("rejects expired tokens", async () => {
    const token = await signCapability(key, { ...grant(), expiresAt: new Date(Date.now() - 60_000) });
    await expect(verifyCapability(key, token)).rejects.toThrow();
  });

  it("rejects tokens for another audience", async () => {
    const token = await new SignJWT({ job: randomUUID(), att: 1, prn: "dev", mdl: ["m"], tok: 1 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("job-dispatcher")
      .setAudience("something-else")
      .setSubject(randomUUID())
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime("1m")
      .sign(new TextEncoder().encode(key));
    await expect(verifyCapability(key, token)).rejects.toThrow();
  });

  it("refuses short signing keys", async () => {
    await expect(signCapability("short", grant())).rejects.toThrow(/at least 32/);
  });
});

describe("postgres connection strings", () => {
  it("parses Aspire ADO.NET-style strings", () => {
    expect(
      parsePostgresConnectionString("Host=localhost;Port=5433;Username=postgres;Password=p;Database=jobsdb"),
    ).toEqual({ host: "localhost", port: 5433, database: "jobsdb", user: "postgres", password: "p", ssl: false });
  });

  it("uses Entra authentication and TLS for Azure servers without a password", () => {
    const info = parsePostgresConnectionString("Host=x.postgres.database.azure.com;Database=jobsdb");
    expect(info.password).toBeUndefined();
    expect(info.user).toBeUndefined();
    expect(info.ssl).toBe(true);
  });

  it("derives the Postgres role from a managed identity token", () => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const token = `${encode({ alg: "none" })}.${encode({
      xms_mirid: "/subscriptions/s/resourcegroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/agent-api-identity",
    })}.sig`;
    expect(entraPrincipalName(token)).toBe("agent-api-identity");
    expect(entraPrincipalName(`${encode({})}.${encode({ upn: "dev@example.com" })}.sig`)).toBe("dev@example.com");
  });

  it("parses URIs", () => {
    expect(parsePostgresConnectionString("postgresql://u:p%40ss@db:5432/jobs?sslmode=require")).toEqual({
      host: "db",
      port: 5432,
      database: "jobs",
      user: "u",
      password: "p@ss",
      ssl: true,
    });
  });
});
