import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, link, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { prepareArtifacts, collectArtifacts } from "/app/src/agent-executor/dist/artifacts.js";

const root = await mkdtemp(join(tmpdir(), "artifact-safety-"));
const paths = [];
const create = async () => {
  const path = join(root, String(paths.length));
  const workspace = await prepareArtifacts(path, [], { processIsolation: "none", egress: "none" });
  paths.push(workspace.root);
  return { workspace, output: join(path, "files", "outputs") };
};
try {
  const normal = await create();
  await mkdir(join(normal.output, "nested"));
  await writeFile(join(normal.output, "nested", "binary.bin"), Buffer.from([0, 255, 1]));
  assert.deepEqual(await collectArtifacts(normal.workspace.root), [{
    path: "nested/binary.bin", base64: "AP8B", sha256: createHash("sha256").update(Buffer.from([0, 255, 1])).digest("hex"),
  }]);
  const sentinel = join(root, "sentinel");
  await writeFile(sentinel, "not a job output");
  const linked = await create();
  await symlink(sentinel, join(linked.output, "escape"));
  await assert.rejects(collectArtifacts(linked.workspace.root));
  const hard = await create();
  await link(sentinel, join(hard.output, "hard"));
  await assert.rejects(collectArtifacts(hard.workspace.root), /without links/);
  const directory = await create();
  await symlink(root, join(directory.output, "directory"));
  await assert.rejects(collectArtifacts(directory.workspace.root));
  const oversized = await create();
  await writeFile(join(oversized.output, "large"), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(collectArtifacts(oversized.workspace.root));
  const many = await create();
  for (let i = 0; i < 17; i++) await writeFile(join(many.output, `file-${i}`), "x");
  await assert.rejects(collectArtifacts(many.workspace.root), /Too many/);
  console.log("Artifact safety passed: exact bytes, bounded files/count, symlink and hardlink rejection.");
} finally {
  for (const path of paths) await path.close();
  await rm(root, { recursive: true, force: true });
}
