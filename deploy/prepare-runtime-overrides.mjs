import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const source = await readFile("/runtime/bazel/3rdparty/crates/crates.bzl", "utf8");
const overrides = [];
const blocks = source.matchAll(/maybe\(\s*git_repository,([\s\S]*?)\n    \)/g);
for (const [, block] of blocks) {
  const remote = /remote = "([^"]+)"/.exec(block)?.[1];
  const root = remote === "https://github.com/github/copilot-host.git" ? "/hosting"
    : remote === "https://github.com/microsoft/mxc" ? "/mxc" : undefined;
  if (!root) continue;
  const name = /name = "([^"]+)"/.exec(block)?.[1];
  const prefix = /strip_prefix = "([^"]+)"/.exec(block)?.[1];
  const build = /build_file = Label\("\/\/bazel\/3rdparty\/crates:([^"]+)"\)/.exec(block)?.[1];
  if (!name || !prefix || !build || !/^[A-Za-z0-9._-]+$/.test(name)
    || !/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.split("/").includes("..") || build.includes("/")) {
    throw new Error("The pinned private dependency declaration has an unsupported shape.");
  }
  const destination = join(root, prefix);
  await copyFile(join("/runtime/bazel/3rdparty/crates", build), join(destination, "BUILD.bazel"));
  await writeFile(join(destination, "REPO.bazel"), "");
  overrides.push(`build --override_repository=+c+${name}=${destination}`);
}
if (overrides.length !== 8) throw new Error("Review the private dependency snapshot: expected seven hosting crates and MXC.");
await writeFile("/runtime/local.bazelrc", `${overrides.join("\n")}\n`);
