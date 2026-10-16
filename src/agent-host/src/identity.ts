import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const HostIdentity = z.object({
  schemaVersion: z.literal(1),
  harness: z.string().min(1),
  ownerUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  computeId: z.string().uuid(),
}).strict();
export type HostIdentity = z.infer<typeof HostIdentity>;

/**
 * Reads the identity recorded on a host's own volume. The compute identity names the runtime catalog and the
 * Mission Control environment, so it must survive a reset control-plane database; the harness and numeric owner
 * stop a volume from being reused by another host.
 */
export async function readHostIdentity(directory: string, expected: { harness: string; ownerUserId: number }): Promise<HostIdentity | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, "host.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const parsed = HostIdentity.safeParse(value);
  if (!parsed.success) throw new Error("The host volume identity (host.json) is invalid; review the volume before reuse.");
  if (parsed.data.harness !== expected.harness || parsed.data.ownerUserId !== expected.ownerUserId) {
    throw new Error("This host volume belongs to a different harness or GitHub owner; it is not reused.");
  }
  return parsed.data;
}

/** Records the durable host identity on the volume, readable only by the supervisor. */
export async function writeHostIdentity(directory: string, identity: Omit<HostIdentity, "schemaVersion">): Promise<void> {
  const path = join(directory, "host.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(HostIdentity.parse({ schemaVersion: 1, ...identity })), { mode: 0o600 });
  await rename(temporary, path);
}
