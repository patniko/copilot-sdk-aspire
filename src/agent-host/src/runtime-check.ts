import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

export const OWNER_GUARD_DIAGNOSTIC =
  "Request host.start failed with message: in-process AHP host startup failed: COPILOT_AHP_EXPECTED_OWNER requires githubApiUrl and numeric userId";

export interface ProbeRuntime {
  start(): Promise<void>;
  startAhpHost(options: { localServer: { hostname: string } }): Promise<{ dispose(): Promise<void> }>;
  stop(): Promise<unknown>;
}

/** An unknown environment variable must not silently turn an owner-bound host into an unrestricted host. */
export async function verifyOwnerGuard(directory: string, create: (home: string) => ProbeRuntime): Promise<void> {
  const home = await mkdtemp(join(directory, ".owner-guard-probe-"));
  let client: ProbeRuntime | undefined;
  try {
    client = create(home);
    await client.start();
    let listener: { dispose(): Promise<void> } | undefined;
    try {
      listener = await client.startAhpHost({ localServer: { hostname: "127.0.0.1" } });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === -32603 && error.message === OWNER_GUARD_DIAGNOSTIC) return;
      throw new Error("The runtime's expected-owner enforcement could not be verified. Use a qualified runtime build.", { cause: error });
    } finally {
      await listener?.dispose();
    }
    throw new Error("This runtime ignores expected-owner configuration. Hosting was not activated; provide a qualified runtime build.");
  } finally {
    const errors = await client?.stop();
    if (Array.isArray(errors) && errors.length > 0) throw new Error("The runtime qualification process did not stop cleanly.");
    await rm(home, { recursive: true, force: true });
  }
}
