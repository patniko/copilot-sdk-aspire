/**
 * Operator-side helpers for the managed-agent demo: watch where sessions run, promote one through the API, list an
 * orchestrator's workers, and answer worker approvals (which reach a person through the API, not the coordinator's
 * CLI). Run from the repository root with `pnpm agent:ops -- <command>`.
 */
import { createInterface } from "node:readline/promises";
import { AgentPlatform, AgentPlatformError, type WorkerInputRequestView, type WorkerResponse } from "../../src/agent-client/src/index.js";

const HELP = `pnpm agent:ops -- <command>

  sessions               your conversations: harness, mode, placement, container, online
  session <id>           one conversation: placement, generation, promotion, container, budget
  promote <id> [reason]  move a promotable conversation into its own container through the API
  workers <id>           an orchestrator's workers: harness, size, approval mode, state, usage
  approvals              answer worker approvals and questions as they arrive (Ctrl+C to stop)
  close <id>             close a conversation`;

const [command, id, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");

async function main(): Promise<void> {
  if (!command || command === "--help" || command === "-h") return void console.log(HELP);
  const platform = await AgentPlatform.local();
  const need = () => {
    if (!id) throw new Error(`${command} needs a session ID.`);
    return id;
  };
  switch (command) {
    case "sessions": {
      const sessions = (await platform.sessions()).filter((session) => !session.closed);
      if (!sessions.length) return void console.log("No open conversations.");
      console.table(sessions.map((session) => ({
        id: session.id, harness: session.harness?.name, mode: session.mode, placement: session.placement,
        generation: session.segment.generation, container: session.container?.state ?? "-", online: session.online,
      })));
      return;
    }
    case "session": {
      const view = await platform.view(need());
      console.log({
        harness: `${view.harness?.name}@${view.harness?.version}`, mode: view.mode, placement: view.placement,
        generation: view.segment.generation, promotion: view.promotion?.state ?? "none",
        container: view.container ? `${view.container.state} (${view.container.size})` : "none",
        model: view.model, online: view.online,
        budget: `${view.budget.usedTokens.toLocaleString()} used, ${view.budget.remainingTokens.toLocaleString()} remaining`,
      });
      return;
    }
    case "promote": {
      const session = await platform.session(need());
      const result = await session.promote(rest.join(" ") || "Requested by the operator from the demo.");
      console.log(result.created ? "Promotion started." : "The session already has a promotion.", { state: result.promotion?.state });
      console.log("An attached CLI is moved to the new container. Watch it with: pnpm agent:ops -- session", session.id);
      return;
    }
    case "workers": {
      const workers = await (await platform.session(need())).workers();
      if (!workers.length) return void console.log("No workers yet.");
      console.table(workers.map((worker) => ({
        name: worker.name, harness: worker.harness.name, source: worker.source, size: worker.size,
        approval: worker.approvalMode, shared: worker.sharedVolume, state: worker.state, stop: worker.stopReason ?? "-",
        tokens: worker.usage.tokensUsed, released: worker.capacityReleased,
      })));
      return;
    }
    case "approvals":
      return approvals(platform);
    case "close":
      await (await platform.session(need())).close();
      return void console.log("Closed.");
    default:
      console.log(HELP);
      process.exitCode = 2;
  }
}

/** Polls the caller's pending worker requests and asks the person at this terminal to answer each one. */
async function approvals(platform: AgentPlatform): Promise<void> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answered = new Set<string>();
  console.log("Waiting for worker approvals and questions. Ctrl+C to stop.\n");
  for (;;) {
    const pending = (await platform.workerInputRequests()).filter((request) => !answered.has(request.id));
    for (const request of pending) {
      console.log(describe(request));
      const response = await ask(prompt, request);
      if (!response) continue;
      try {
        await platform.respondToWorker(request.sessionId, request.id, response);
        console.log(response.kind === "permission" ? (response.approved ? "  approved\n" : "  denied\n") : "  answered\n");
      } catch (error) {
        console.log(`  not answered: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      answered.add(request.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

function describe(request: WorkerInputRequestView): string {
  const head = `[${request.worker} · ${request.harness.name}] expires ${new Date(request.expiresAt).toLocaleTimeString()}`;
  if (request.request.kind === "question") {
    return `${head}\n  question: ${request.request.question}${request.request.choices?.length ? `\n  choices: ${request.request.choices.join(" | ")}` : ""}`;
  }
  const permission = request.request.permission;
  const target = permission.command ?? permission.path ?? permission.url ?? "";
  return `${head}\n  ${permission.type}: ${target}${permission.intention ? `\n  why: ${permission.intention}` : ""}`;
}

async function ask(prompt: ReturnType<typeof createInterface>, request: WorkerInputRequestView): Promise<WorkerResponse | undefined> {
  if (request.request.kind === "question") {
    const answer = (await prompt.question("  answer (empty to skip): ")).trim();
    return answer ? { kind: "question", answer, wasFreeform: !request.request.choices?.includes(answer) } : undefined;
  }
  const choice = (await prompt.question("  [y] approve once  [k] approve this kind  [n] deny  [s] skip: ")).trim().toLowerCase();
  if (choice === "y") return { kind: "permission", approved: true, scope: "once" };
  if (choice === "k") return { kind: "permission", approved: true, scope: "kind" };
  if (choice === "n") return { kind: "permission", approved: false, feedback: (await prompt.question("  reason (optional): ")).trim() || "Denied by the operator." };
  return undefined;
}

await main().catch((error: unknown) => {
  console.error(error instanceof AgentPlatformError ? `${error.status} ${error.code ?? "error"}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
