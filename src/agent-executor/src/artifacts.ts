import { constants } from "node:fs";
import { chown, mkdir, open, opendir, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import {
  ArtifactPath, ARTIFACT_MAX_BYTES, ARTIFACT_MAX_FILES, ARTIFACT_MAX_TOTAL_BYTES,
  type ArtifactData, type WorkspaceArtifacts,
} from "@copilot-agent/contracts";
import { validateArtifactSet } from "@copilot-agent/job-store";
import type { IsolationSettings } from "./isolation.js";

export interface ArtifactWorkspace { root: FileHandle; context: WorkspaceArtifacts }

export async function prepareArtifacts(workspace: string, inputs: ArtifactData[], isolation: IsolationSettings): Promise<ArtifactWorkspace> {
  if (process.platform !== "linux") throw new Error("Delegated filesystem artifact execution requires Linux.");
  const files = validateArtifactSet(inputs);
  const base = join(workspace, "files");
  const inputRoot = join(base, "inputs");
  const outputRoot = join(base, "outputs");
  const directories = new Set([base, inputRoot, outputRoot]);
  for (const file of files) {
    let directory = dirname(join(inputRoot, ...file.path.split("/")));
    while (directory !== inputRoot) { directories.add(directory); directory = dirname(directory); }
  }
  for (const directory of directories) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const file of files) await writeFile(join(inputRoot, ...file.path.split("/")), file.content, { flag: "wx", mode: 0o444 });
  if (isolation.processIsolation === "uid" && isolation.uid !== undefined && isolation.gid !== undefined) {
    for (const directory of directories) await chown(directory, isolation.uid, isolation.gid);
  }
  const root = await open(outputRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  return { root, context: { inputDirectory: "inputs", outputDirectory: "outputs",
    inputs: files.map((file) => ({ path: file.path, sha256: file.sha256, size: file.content.length })) } };
}

/** Directory descriptors pin every ancestor before reading untrusted output paths. */
export async function collectArtifacts(root: FileHandle): Promise<ArtifactData[]> {
  const artifacts: ArtifactData[] = [];
  const names = new Set<string>();
  let total = 0;
  let visited = 0;
  const visit = async (directory: FileHandle, prefix: string) => {
    const entries: string[] = [];
    for await (const entry of await opendir(`/proc/self/fd/${directory.fd}`)) {
      if (++visited > ARTIFACT_MAX_FILES * 8) throw new Error("Artifact tree exceeds its entry bound.");
      entries.push(entry.name);
    }
    for (const name of entries.sort()) {
      const path = ArtifactPath.parse(prefix ? `${prefix}/${name}` : name);
      const file = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (info.isDirectory()) { await visit(file, path); continue; }
        if (!info.isFile() || info.nlink !== 1 || info.size > ARTIFACT_MAX_BYTES || names.has(path.toLowerCase())) {
          throw new Error("Artifact must be a bounded regular file without links or aliases.");
        }
        if (artifacts.length >= ARTIFACT_MAX_FILES) throw new Error("Too many output artifacts.");
        const bytes = Buffer.alloc(ARTIFACT_MAX_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
          const result = await file.read(bytes, size, bytes.length - size, null);
          if (!result.bytesRead) break;
          size += result.bytesRead;
        }
        total += size;
        if (size > ARTIFACT_MAX_BYTES || total > ARTIFACT_MAX_TOTAL_BYTES) throw new Error("Output artifacts exceed their byte quota.");
        const content = bytes.subarray(0, size);
        names.add(path.toLowerCase());
        artifacts.push({ path, sha256: createHash("sha256").update(content).digest("hex"), base64: content.toString("base64") });
      } finally { await file.close(); }
    }
  };
  await visit(root, "");
  return artifacts;
}
