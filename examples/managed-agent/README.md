# Managed agents: define in code, run on the platform, open the CLI

This demo defines a conversation agent in TypeScript, asks the platform to create it, and drops you into the Copilot
CLI attached to it over AHP. The agent runs in the platform under the operator's policy; your machine only holds the
CLI. One agent per hosting offering lives in [`agents.ts`](agents.ts):

| `--mode` | Agent | Where it runs | What to show |
| --- | --- | --- | --- |
| `shared` | `team-researcher` | The shared worker, beside every other shared conversation (multi-tenant) | Web and workspace files with no container; no shell |
| `isolated` (default) | `release-notes-writer` | Its own resumable session container | Shell commands in `Linux`, each approved in the CLI |
| `promotable` | `promotable-coder` | Starts on the shared worker, moves itself into a container | The agent asks to promote, you approve, the CLI reconnects to the container and the work continues; no way back |
| `orchestrator` | `build-orchestrator` | A coordinator on the shared worker; workers in their own containers | A small builder and a medium, assisted reviewer on a shared volume; their approvals reach you through the API |

```ts
import { AgentPlatform, defineAgent } from "@copilot-agent/client";

const agent = defineAgent({
  name: "promotable-coder",
  model: "github/claude-sonnet-5.5",
  hosting: { mode: "promotable", promotion: { size: "small", approval: "ask" } },
  builtinTools: ["files", "shell", "web"],
  permissions: { default: "deny", kinds: { read: "allow", write: "ask", url: "ask", shell: "ask" }, questions: true },
  instructions: "When a request needs a shell, call promote_session, then continue in your container. ...",
});

const platform = await AgentPlatform.local();  // AGENT_API_URL/AGENT_API_KEY, or the running AppHost
const session = await platform.createSession(agent, { label: "demo" });
await session.openCli({ cli: "C:\\projects\\copilot-agent-runtime-hybrid\\dist-cli\\index.js" });
```

`defineAgent` fills in conversation defaults (version `0.1.0`, the `node-ts-agent` runner, input/output schemas, no
automatic retry, 300 s / 200,000-token limits) and validates the definition locally, so mistakes such as shell tools on
shared hosting fail before anything is sent. The service then applies every check a published harness gets: approved
models, tools, permission and approval modes, and the hosting mode and its host. The client also has
`platform.sessions()`, `session.promote()`, `session.workers()`, `platform.workerInputRequests()`, and
`platform.respondToWorker()`.

## Prerequisites

1. The local stack runs with [hybrid hosting, session containers, and orchestrator workers](../../docs/DEPLOYMENT.md#session-containers)
   (`pnpm aspire:run`), and the workspace packages are built (`pnpm install`, `pnpm build`). The orchestrator's workers
   are the published `hybrid-builder` and `hybrid-reviewer` harnesses from the example workspace.
2. The base policy in `.copilot-agent-workspace\policy\execution-policy.json` allows code-defined agents, the model,
   and the hosting modes. Code-defined agents get the base policy, never a per-harness override. Merge:

   ```json
   {
     "allowInlineHarnesses": true,
     "allowedModels": ["github/claude-sonnet-5.5"],
     "hosting": {
       "modes": ["isolated", "shared", "promotable", "orchestrator"],
       "workers": { "maxConcurrentPerSession": 2, "maxPerSession": 8, "maxPerPrincipal": 4, "idleSeconds": 900,
                    "maxLifetimeSeconds": 3600, "allowInheritedAuthority": true }
     }
   }
   ```

   A harness still runs only in the mode it declares, and harnesses with their own policy override keep it. GitHub
   models need [GitHub inference](../../docs/USER-GUIDE.md#github-copilot-models); otherwise pass `--model grok-4.6`.
3. Restart `agent-api` after editing the policy (the configurator's **Reload harnesses**, or the Aspire dashboard); the
   shared worker picks up changes by itself. Without `allowInlineHarnesses` the API answers `403 inline_harnesses_disabled`.
4. An AHP-enabled Copilot CLI. The demo uses `C:\projects\copilot-agent-runtime-hybrid\dist-cli\index.js` when it
   exists, otherwise `copilot`; pass `--cli` to choose another.

## Run of show

Use two terminals from the repository root: one for the CLI, one for `pnpm agent:ops`.

```powershell
pnpm agent:demo -- --show-policy-refusal --dry-run   # guardrails: a local and a service refusal, then a created agent
pnpm agent:demo -- --mode shared                     # multi-tenant
pnpm agent:demo -- --mode isolated                   # its own container
pnpm agent:demo -- --mode promotable                 # shared, then promoted into a container
pnpm agent:demo -- --mode orchestrator               # coordinator plus container workers
```

Each run prints the agent, its digest, admitted model, hosting and placement, budget, and prompts to try, then opens
the CLI. Exiting the CLI leaves the session running; reattach with the printed `pnpm host:connect --resume <id>`.
`--dry-run` creates the session without opening the CLI, `--model` picks another approved model, and `--label` names it.

- **Shared.** Ask it to fetch `https://example.com` and save a summary to `notes/findings.md`; approve the fetch and
  the write. `pnpm agent:ops -- session <id>` shows `placement: shared`, `container: none`. Run several shared demos
  at once to show one runtime serving all of them.
- **Isolated.** Ask it to run `uname -sm` and `id -u`; approve in the CLI. It reports `Linux`, uid `10001`, and
  `/data/execution/workspace`. The first connection waits for the container (about 10 seconds).
- **Promotable.** Ask what it can do (no shell yet), then ask it to run `uname -sm` and save the output to
  `hello.txt`. It calls `promote_session`; approve it. The launcher prints "moved to a new placement. Reconnecting",
  the CLI comes back on the container with a notice that the workspace moved, and the agent asks to run the command.
  `pnpm agent:ops -- session <id>` shows `placement: container`, `generation: 2`, `promotion: committed`. You can also
  promote from outside with `pnpm agent:ops -- promote <id>`.
- **Orchestrator.** Start `pnpm agent:ops -- approvals` in the second terminal first. Ask the coordinator to have a
  builder write and run `/shared/hello.py` and a reviewer check it. Approve the builder's write (`k` approves that kind
  for the worker) and shell command in the approvals terminal; the coordinator says it cannot approve them itself. The
  reviewer's assisted judge escalates its command to you as well. `pnpm agent:ops -- workers <id>` shows sizes,
  approval modes, shared-volume access, and, after the coordinator archives them, `released: true`.

Other helpers: `pnpm agent:ops -- sessions` lists open conversations, and `pnpm agent:ops -- close <id>` closes one.

## Troubleshooting

- **Session containers never start (`container_unavailable`), or a promotion stays `starting`.** If the machine slept
  or the database paused, the execution controller can lose its lease; by design it then stops provisioning. Restart
  `execution-controller` from the Aspire dashboard (`aspire resource execution-controller restart --apphost apphost.mts`).
- **`create_worker` says the budget cannot fund another worker.** Workers are paid from the coordinator's budget, which
  always holds back one coordinator turn; give the orchestrator a larger `limits.maxInferenceTokens` (the demo uses 500,000).
- **A service fails to parse sessions after pulling changes.** Rebuild (`pnpm build`) and restart the host services
  so every one runs the same contracts.
