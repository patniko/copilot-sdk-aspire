import { access, cp, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const CUSTOMER_WORKSPACE_DIR = ".copilot-agent-workspace";
export const EXAMPLE_CONFIG_DIR = join("examples", "customer-config");

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Creates the ignored customer workspace from immutable platform examples without overwriting existing files. */
export async function ensureCustomerWorkspace(platformRoot: string, workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  for (const directory of ["harnesses", "policy"]) {
    const target = join(workspaceRoot, directory);
    if (!(await exists(target))) {
      await cp(join(platformRoot, EXAMPLE_CONFIG_DIR, directory), target, { recursive: true });
    }
  }
}
