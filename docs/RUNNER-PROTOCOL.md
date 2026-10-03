# Runner protocol v1

A runner is the process that hosts one agent attempt. The platform ships a TypeScript reference runner
(`src/harness-hosting`) and a sample customer-authored Python runner (`execution-profiles/python-agent`).
Any runner that implements this protocol and is approved as an execution profile can run harnesses.

The contracts are defined in [`contracts/src/runner-protocol.ts`](../contracts/src/runner-protocol.ts).

## Transport

- The executor starts the runner as a child process with the profile's `entrypoint`.
- Messages are UTF-8 JSON objects, one per line (JSON Lines), at most 1 MiB per line.
- Executor → runner: **stdin**. Runner → executor: **stdout**. Diagnostics: **stderr** (not persisted).
- Unknown or malformed messages from the runner fail the attempt with `protocol_error`.

## Lifecycle

```text
executor                         runner
   |  spawn (uid 10001, minimal env, private workspace)
   |<--------------------------------- hello
   |  validate protocol + capabilities
   |-- start ------------------------->
   |<--------------------------------- event* (optional, ordered)
   |-- cancel (on cancel or deadline) ->       (optional)
   |<--------------------------------- result | failure (exactly one)
   |  validate result against harness output schema, report to dispatcher
```

1. **hello** must be the first message, within 60 seconds:

   ```json
   {"type":"hello","protocol":"1","runner":{"name":"…","version":"…","language":"python","sdkVersion":"1.0.14"},"capabilities":["cancel","structured-result"]}
   ```

   `cancel` and `structured-result` are required. Incompatible runners are terminated before any job data is sent.

   Harnesses that use optional features also need the matching capability, checked at admission (against the
   profile's `capabilities`) and again against `hello` before `start` is sent:

   | Capability | Needed when the harness has |
   | --- | --- |
   | `prompt-sections` | `prompt.mode` of `append` or `customize` |
   | `model-options` | `model.reasoningEffort` or `model.contextTier` |
   | `custom-agents` | `agents[]` (sub-agents) |
   | `skills` | `skills[]` |

2. **start** carries one attempt:

   ```json
   {
     "type": "start",
     "protocol": "1",
     "job": {"id": "<uuid>", "attempt": 1, "principal": "dev"},
     "harness": {"definition": { … }, "digest": "sha256:…"},
     "profile": "python-agent",
     "input": { … },
     "deadline": "2026-10-02T05:33:50.000Z",
     "inference": {"baseUrl": "https://inference-gateway…/openai/v1/", "token": "<job capability>", "model": "grok-4.6"},
     "workspace": "/work/<attempt-id>"
   }
   ```

   - `inference.token` is a job-scoped capability for the inference gateway. It is not a provider credential and
     is only valid for this attempt, its approved models, and its remaining token budget.
   - `workspace` is private to the attempt and deleted afterwards.

3. **event** messages report sanitized progress. Only these kinds are accepted; raw SDK events are never forwarded:
   `agent.turn_started`, `agent.turn_completed`, `tool.started {tool}`, `tool.completed {tool, ok}`,
   `subagent.started {agent}`, `subagent.completed {agent, ok}`, `skill.used {skill}`, `progress {message}`.

4. **cancel** (`{"type":"cancel","reason":"…"}`) asks the runner to stop. The runner should abort its session and
   report `failure` with code `cancelled`. Runners that do not stop within 15 seconds are killed.

5. Exactly one terminal message:
   - `{"type":"result","output":{…}}` — the executor validates `output` against the harness output schema;
     a mismatch fails the attempt with `invalid_output`.
   - `{"type":"failure","code":"…","message":"…","retryable":true,"uncertainEffects":false}` — codes:
     `invalid_input`, `invalid_output`, `cancelled`, `deadline_exceeded`, `inference_error`, `tool_error`,
     `unsupported`, `internal`. Set `uncertainEffects` when an external side effect may have happened.

A runner that exits without a terminal message fails the attempt with `runner_exited`, treated as an uncertain
outcome: read-only harnesses are retried; others go to `needs_review`.

## What a runner can and cannot do

- It receives only: PATH, HOME/TMPDIR inside its workspace, locale, and the non-secret `entrypoint.env` of its
  profile. It never receives database, dispatcher, Azure, or model-provider credentials.
- It cannot choose its identity, extend its lease, widen its capabilities, or declare a security control
  satisfied. The dispatcher and executor remain authoritative.
- Tool code and dependencies are baked into the execution image; nothing is installed from job input.

## Implementing a runner with a Copilot SDK

Configure the SDK session with a BYOK provider pointing at `inference.baseUrl` using `inference.token` as the API
key, use `mode: "empty"` (or the language equivalent), an explicit tool allowlist, no configuration discovery, and a
deny-by-default permission handler. Register a terminal `submit_result` tool whose parameters are the harness output
schema. See the TypeScript reference runner and the Python sample for complete implementations.

Map the optional harness features to session options as follows (TypeScript names; the Python SDK uses snake_case).
`src/harness-hosting/src/session-config.ts` is the reference mapping and has unit tests.

| Harness | Session option |
| --- | --- |
| `instructions` + `prompt.mode` | `systemMessage: {mode, content: instructions + result contract}`; the default mode is `replace` |
| `prompt.sections[]` | `systemMessage.sections: {[name]: {action, content}}` (`remove` has no content) |
| `model.reasoningEffort`, `model.contextTier` | `reasoningEffort`, `contextTier` |
| `agents[]` | `customAgents: [{name, displayName, description, prompt: instructions, tools, skills, model, reasoningEffort, infer: true}]` and `builtin:task` in `availableTools` |
| `tools[].delegatedOnly` | `defaultAgent: {excludedTools: [...]}` |
| `skills[]` | Write each to `<workspace>/skills/<name>/SKILL.md`; `enableSkills: true`, `skillDirectories`, and `builtin:skill` in `availableTools` |
| (always) | `excludedBuiltinAgents` listing every built-in SDK agent, so the task tool can only reach harness sub-agents |

Map SDK events `subagent.started`, `subagent.completed`/`subagent.failed` and `skill.invoked` to the protocol events
above, sending only the agent or skill name.
