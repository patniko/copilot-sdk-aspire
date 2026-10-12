import { access } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export async function localRuntimeArtifacts(): Promise<{ launcher: string; library: string }> {
  const launcher = process.env.COPILOT_CLI_PATH;
  if (!launcher || !isAbsolute(launcher)) {
    throw new Error("Set COPILOT_CLI_PATH to the absolute path of the locally built runtime launcher, with its matching runtime.node beside it. Published-runtime fallback is not a local qualification.");
  }
  const library = join(dirname(launcher), "runtime.node");
  await access(launcher);
  await access(library);
  return { launcher, library };
}
