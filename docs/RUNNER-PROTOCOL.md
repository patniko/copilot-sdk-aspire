# Runner protocol v1

[Documentation hub](README.md) | [Developer guide](DEVELOPER-GUIDE.md) | [Execution flow](ARCHITECTURE.md#job-execution)

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
   |  spawn (slot uid 10001-10008, minimal env, private workspace)
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
   | `builtin-tools` | `builtinTools[]` (Copilot's own file, shell, web or agent tools) |
   | `interactive` | `permissions` with any `ask` rule, or `permissions.questions` |

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
     "eventDetail": "sanitized",
     "workspace": "/work/<attempt-id>"
   }
   ```

   - `inference.token` is a job-scoped capability for the inference gateway. It is not a provider credential and
     is only valid for this attempt, its approved models, and its remaining token budget.
   - `workspace` is private to the attempt and deleted afterwards.
   - `eventDetail` is `sanitized` by default. An executor configured with `JOB_EVENT_DETAIL=full` requests
     bounded SDK event detail from the runner.

3. **event** messages report allowlisted progress. These kinds are accepted:
   `agent.turn_started`, `agent.turn_completed`, `tool.started {tool}`, `tool.completed {tool, ok}`,
   `subagent.started {agent}`, `subagent.completed {agent, ok}`, `skill.used {skill}`, `progress {message}`, and
   `sdk.event {detail}`.

   When `eventDetail` is `full`, normal progress events may include `detail`, and SDK events without a matching
   progress kind use `sdk.event`. Detail contains the SDK event type, correlation metadata, and a bounded `data`
   payload. The reference runners redact credential-shaped fields, omit content beyond their size limits, and cap
   each detail payload before writing the protocol line. This is diagnostic capture, not a lossless SDK event log.
   It can still contain job inputs, prompts, assistant/reasoning text, tool arguments and tool output.

4. **cancel** (`{"type":"cancel","reason":"…"}`) asks the runner to stop. The runner should abort its session and
   report `failure` with code `cancelled`. Runners that do not stop within 15 seconds are killed.

5. **input_request** / **input_response** let the agent ask a person for a permission decision or an answer.
   Only harnesses with `permissions` that `ask` or allow `questions` may send requests; the executor answers
   `expired` for anything else.

   ```json
   {"type":"input_request","id":"r1","request":{"kind":"permission","permission":{"type":"shell","command":"pytest -q","intention":"Run the tests"}}}
   {"type":"input_request","id":"r2","request":{"kind":"question","question":"Which Python version?","choices":["3.11","3.12"],"allowFreeform":true}}
   ```

   The executor stores the request with the dispatcher, the caller answers it through the API, and the executor
   replies:

   ```json
   {"type":"input_response","id":"r1","response":{"kind":"permission","approved":true,"scope":"once"}}
   {"type":"input_response","id":"r2","response":{"kind":"question","answer":"3.12","wasFreeform":false}}
   {"type":"input_response","id":"r1","response":{"kind":"expired"}}
   ```

   - `id` is chosen by the runner (`[A-Za-z0-9_-]{1,64}`, unique per attempt). At most 5 requests may wait at once.
   - Permission prompts carry only display fields (`type`, `intention`, `command`, `path`, `url`, `diff`, `tool`,
     `warning`) with fixed size limits; truncate before sending, because oversized messages fail the attempt.
   - `scope: "kind"` approves later requests of the same type for the rest of the attempt.
   - `expired` means nobody answered within `permissions.timeoutSeconds` (default 600, capped by the attempt
     deadline) or the attempt was cancelled. Deny the action, or answer the question with a note to continue.

6. Exactly one terminal message:
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
| `builtinTools[]` | `builtin:<name>` in `availableTools` for each tool in the group (files: view, glob, grep, create, edit; shell: the bash or PowerShell tool family; web: web_fetch; agents: task, read_agent, list_agents, write_agent, and built-in agents are no longer excluded) |
| `permissions` | `onPermissionRequest` applies the rule for the request kind (read, write, shell, url, otherwise the default): `allow` approves once, `deny` rejects, `ask` sends `input_request` |
| `permissions.questions` | `onUserInputRequest` sends `input_request` with a question, and `builtin:ask_user` in `availableTools` |
| (always) | `excludedBuiltinAgents` listing every built-in SDK agent, unless the harness enables the `agents` group |

Map SDK events `subagent.started`, `subagent.completed`/`subagent.failed` and `skill.invoked` to the protocol events
above, sending only the agent or skill name.
