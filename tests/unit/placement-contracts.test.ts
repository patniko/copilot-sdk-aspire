import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BROKER_MOVED_CLOSE, BrokerTicketRequest, BrokerTicketResult, PlacementKind, PlacementLookup, PlacementRoute, SessionPlacement,
} from "@copilot-agent/contracts";

describe("session placement contracts", () => {
  it("routes only implemented placement kinds with a positive generation", () => {
    const sessionId = randomUUID();
    expect(PlacementKind.options).toEqual(["shared", "container"]);
    expect(PlacementRoute.parse({ kind: "shared", sessionId, generation: 2, epoch: randomUUID() }).kind).toBe("shared");
    const container = { kind: "container", sessionId, generation: 1, allocationId: randomUUID(), endpoint: "http://127.0.0.1:49152/", credential: "c".repeat(43) };
    expect(PlacementRoute.parse(container).kind).toBe("container");
    for (const route of [
      { kind: "container", sessionId, generation: 1, epoch: randomUUID() },
      { ...container, endpoint: "ws://127.0.0.1:49152/" },
      { ...container, endpoint: "http://127.0.0.1:49152/sessions" },
      { ...container, endpoint: "http://user:secret@127.0.0.1:49152/" },
      { ...container, credential: "short" },
      { ...container, epoch: randomUUID() },
      { kind: "host", sessionId, generation: 1, epoch: randomUUID() },
      { kind: "shared", sessionId, generation: 0, epoch: randomUUID() },
      { kind: "shared", sessionId, generation: 1 },
      { kind: "shared", sessionId, generation: 1, epoch: randomUUID(), endpoint: "http://127.0.0.1:1" },
    ]) expect(PlacementRoute.safeParse(route).success, JSON.stringify(route)).toBe(false);
    expect(SessionPlacement.safeParse({ sessionId, kind: "shared", generation: 1.5 }).success).toBe(false);
  });

  it("bounds the broker's internal ticket and lookup requests", () => {
    const sessionId = randomUUID();
    expect(BrokerTicketRequest.safeParse({ sessionId, ticket: "x".repeat(31) }).success).toBe(false);
    expect(BrokerTicketRequest.safeParse({ sessionId, ticket: "x".repeat(201) }).success).toBe(false);
    expect(BrokerTicketRequest.safeParse({ sessionId: "not-a-session", ticket: "x".repeat(43) }).success).toBe(false);
    expect(BrokerTicketRequest.safeParse({ sessionId, ticket: "x".repeat(43), principal: "caller" }).success).toBe(false);
    expect(BrokerTicketResult.safeParse({ authorized: true }).success).toBe(false);
    expect(BrokerTicketResult.parse({ authorized: false })).toEqual({ authorized: false });
    expect(PlacementLookup.safeParse({ sessionIds: [] }).success).toBe(false);
    expect(PlacementLookup.safeParse({ sessionIds: Array.from({ length: 501 }, () => randomUUID()) }).success).toBe(false);
  });

  it("uses a private-range WebSocket close code with a short reason", () => {
    expect(BROKER_MOVED_CLOSE.code).toBeGreaterThanOrEqual(4000);
    expect(BROKER_MOVED_CLOSE.code).toBeLessThanOrEqual(4999);
    expect(Buffer.byteLength(BROKER_MOVED_CLOSE.reason)).toBeLessThanOrEqual(123);
  });
});
