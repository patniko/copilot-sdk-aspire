import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ServerKey = z.object({
  keyId: z.string().min(1).max(200),
  algorithm: z.enum(["x25519-sealedbox", "hpke-x25519-hkdf-sha256-aes256gcm"]),
  publicKey: z.string().min(1).max(1000),
}).strict();
export type ServerKey = z.infer<typeof ServerKey>;

/** Provision public key material over the supervisor's authenticated local connection. */
export async function readServerKey(port: number, token: string): Promise<ServerKey> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?tkn=${encodeURIComponent(token)}`);
  let sequence = 0;
  const pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  let fail: (error: Error) => void = () => undefined;
  const timer = setTimeout(() => fail(new Error("AHP public-key provisioning timed out.")), 15_000);
  const failure = new Promise<never>((_resolve, reject) => { fail = reject; });
  socket.addEventListener("error", () => fail(new Error("AHP public-key provisioning connection failed.")));
  socket.addEventListener("message", (event) => {
    try {
      if (typeof event.data !== "string" || event.data.length > 1_048_576) throw new Error("Invalid AHP provisioning response.");
      const message: unknown = JSON.parse(event.data);
      const parsed = z.object({ id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() }).safeParse(message);
      if (!parsed.success) return;
      const request = pending.get(parsed.data.id);
      if (!request) return;
      pending.delete(parsed.data.id);
      if (parsed.data.error) request.reject(new Error("AHP rejected public-key provisioning."));
      else request.resolve(parsed.data.result);
    } catch {
      fail(new Error("Invalid AHP public-key provisioning response."));
    }
  });
  const request = (method: string, params: object): Promise<unknown> => {
    const id = ++sequence;
    return Promise.race([failure, new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    })]);
  };
  try {
    await Promise.race([failure, new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }))]);
    await request("initialize", { channel: "ahp-root://", clientId: `host-provisioning-${randomUUID()}`, protocolVersions: ["0.9.0"] });
    const root = await request("subscribe", { channel: "ahp-root://" });
    const parsed = z.object({ snapshot: z.object({ state: z.object({
      _meta: z.object({ "copilot.encryptionKeys": z.array(ServerKey.extend({ use: z.string() }).strip()) }),
    }) }) }).parse(root);
    const key = parsed.snapshot.state._meta["copilot.encryptionKeys"].find((item) => item.use === "auth-token" && item.algorithm === "x25519-sealedbox");
    if (!key) throw new Error("The host did not advertise a supported authentication key.");
    return ServerKey.parse({ keyId: key.keyId, algorithm: key.algorithm, publicKey: key.publicKey });
  } finally {
    clearTimeout(timer);
    pending.clear();
    socket.close();
  }
}
