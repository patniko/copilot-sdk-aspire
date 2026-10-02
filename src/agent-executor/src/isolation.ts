import { spawn } from "node:child_process";
import type { EgressEnforcement, ProcessIsolation } from "@copilot-agent/contracts";

export interface IsolationSettings {
  processIsolation: ProcessIsolation;
  egress: EgressEnforcement;
  uid?: number;
  gid?: number;
}

/**
 * Determines what this executor can actually enforce. Runners execute as a dedicated unprivileged
 * user only when the executor runs as root on Linux and a probe process confirms the switch.
 * Egress is reported as not enforced: this executor has no network-namespace or firewall control.
 */
export async function probeIsolation(runnerUid: number, runnerGid: number): Promise<IsolationSettings> {
  const egress: EgressEnforcement = "none";
  if (process.platform !== "linux" || typeof process.getuid !== "function" || process.getuid() !== 0) {
    return { processIsolation: "none", egress };
  }
  const observed = await new Promise<string>((resolve) => {
    const child = spawn("id", ["-u"], { uid: runnerUid, gid: runnerGid, env: { PATH: "/usr/bin:/bin" } });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output.trim()));
  });
  if (observed !== String(runnerUid)) {
    return { processIsolation: "none", egress };
  }
  return { processIsolation: "uid", egress, uid: runnerUid, gid: runnerGid };
}
