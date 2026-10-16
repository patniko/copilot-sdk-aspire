import { describe, expect, it } from "vitest";
import type { InputRequestBody, InputResponseBody } from "@copilot-agent/contracts";
import { workerPermissionHandler } from "../../src/session-container/src/worker-permissions.js";
import { sharedFileArguments } from "../../src/execution-controller/src/docker.js";
import { sharedFileReply, SHARED_FILES_SCRIPT } from "../../src/execution-controller/src/shared-files.js";
import { WorkerOwnerMessage, WorkerSupervisorMessage } from "../../src/session-container/src/protocol.js";
import { conversation, snapshot } from "../fixtures/workers.js";

const workspace = process.platform === "win32" ? "C:\\worker\\workspace" : "/data/execution/workspace";
const write = { kind: "write", fileName: "notes.md", diff: "+note", intention: "Write notes." } as const;
const shell = {
  kind: "shell", fullCommandText: "npm publish", intention: "Publish.", commands: [{ identifier: "npm", readOnly: false }],
  possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: false,
} as const;

function handler(approvalMode: "manual" | "assisted" | "allow-all", permissions: Record<string, unknown>, answer: InputResponseBody = { kind: "permission", approved: true }) {
  const asked: InputRequestBody[] = [];
  const definition = conversation("worker", { permissions });
  const run = workerPermissionHandler({ harness: snapshot(definition), approvalMode }, workspace, async (request) => {
    asked.push(request);
    return answer;
  });
  return { asked, run: (request: object, assisted?: "approve" | "require_approval") =>
    run(request as never, { sessionId: "worker", ...(assisted ? { assistedApproval: { recommendation: assisted } } : {}) } as never) };
}

describe("worker permission decisions", () => {
  it("apply the harness's deny and allow rules before the judge or a person", async () => {
    const denied = handler("assisted", { default: "ask", kinds: { shell: "deny", write: "allow" } });
    expect(await denied.run(shell, "approve")).toMatchObject({ kind: "reject" });
    expect(await denied.run(write)).toEqual({ kind: "approve-once" });
    expect(denied.asked).toEqual([]);
  });

  it("run what an assisted worker's judge approves and send what it declines to a person", async () => {
    const assisted = handler("assisted", { default: "ask" });
    expect(await assisted.run(shell, "approve")).toMatchObject({ kind: "attributed", result: { kind: "approve-once" } });
    expect(assisted.asked).toEqual([]);
    expect(await assisted.run(shell, "require_approval")).toMatchObject({ kind: "approve-once" });
    expect(assisted.asked).toEqual([{ kind: "permission", permission: expect.objectContaining({ type: "shell", command: "npm publish", commandNames: ["npm"] }) }]);
  });

  it("send a manual worker's requests to a person, never approving on the judge's say-so", async () => {
    const manual = handler("manual", { default: "ask" }, { kind: "permission", approved: false, feedback: "Not now." });
    expect(await manual.run(shell, "approve")).toEqual({ kind: "reject", feedback: "Not now." });
    expect(manual.asked).toHaveLength(1);
    const expired = handler("manual", { default: "ask" }, { kind: "expired" });
    expect(await expired.run(write)).toMatchObject({ kind: "reject" });
  });
});

describe("worker container protocol", () => {
  it("lets the owner request only the listed worker operations", () => {
    expect(WorkerOwnerMessage.safeParse({ kind: "call", id: crypto.randomUUID(), operation: "turns/started", body: { turnId: "t" } }).success).toBe(true);
    expect(WorkerOwnerMessage.safeParse({ kind: "call", id: crypto.randomUUID(), operation: "token", body: {} }).success).toBe(false);
    expect(WorkerOwnerMessage.safeParse({ kind: "call", id: crypto.randomUUID(), operation: "spec", body: {} }).success).toBe(false);
    expect(WorkerSupervisorMessage.safeParse({ kind: "result", id: crypto.randomUUID(), status: 200, body: { recorded: true } }).success).toBe(true);
  });
});

describe("shared file helpers", () => {
  const image = `sha256:${"c".repeat(64)}`;
  const volume = { purpose: "shared" as const, sessionId: crypto.randomUUID(), target: "/shared", readOnly: false, name: "hybrid-ns-shared-x" };

  it("run without network or credentials, mounting only the shared volume, read-only unless writing", () => {
    const read = sharedFileArguments("local-0123456789", image, volume, { kind: "read", path: "plan/notes.md" });
    expect(read).toEqual(expect.arrayContaining(["--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--label", "copilot.hybrid.managed=files", "--mount", "type=volume,src=hybrid-ns-shared-x,dst=/shared,readonly"]));
    expect(read.filter((arg, index) => read[index - 1] === "--cap-add").sort()).toEqual(["SETGID", "SETUID"]);
    for (const forbidden of ["--env", "--volume", "--privileged", "--publish"]) expect(read).not.toContain(forbidden);
    expect(read.slice(read.indexOf("--entrypoint"))).toEqual(["--entrypoint", "node", image, "-e", SHARED_FILES_SCRIPT, "read", "plan/notes.md"]);
    const written = sharedFileArguments("local-0123456789", image, volume, { kind: "write", path: "a.md", content: Buffer.from("x"), ifMatch: "etag" });
    expect(written).toContain("type=volume,src=hybrid-ns-shared-x,dst=/shared");
    expect(written.filter((arg, index) => written[index - 1] === "--cap-add").sort()).toEqual(["CHOWN", "SETGID", "SETUID"]);
    expect(written.slice(-3)).toEqual(["write", "a.md", "etag"]);
    expect(() => sharedFileArguments("ns", "copilot-session-container:local", volume, { kind: "list" })).toThrow();
    expect(() => sharedFileArguments("ns", image, { ...volume, purpose: "worker" }, { kind: "list" })).toThrow();
  });

  it("report refusals with a reason and parse each operation's reply", () => {
    expect(sharedFileReply({ kind: "list" }, JSON.stringify({ ok: true, entries: [{ name: "a", type: "file", size: 1 }], truncated: false })))
      .toEqual({ entries: [{ name: "a", type: "file", size: 1 }] });
    expect(sharedFileReply({ kind: "read", path: "a" }, JSON.stringify({ ok: true, content: Buffer.from("hi").toString("base64") })))
      .toEqual({ content: Buffer.from("hi") });
    expect(() => sharedFileReply({ kind: "read", path: "a" }, JSON.stringify({ ok: false, code: "not_found", message: "The file was not found." })))
      .toThrow("The file was not found.");
    expect(() => sharedFileReply({ kind: "write", path: "a", content: Buffer.from("") }, JSON.stringify({ ok: true, entries: [], truncated: false }))).toThrow();
  });
});
