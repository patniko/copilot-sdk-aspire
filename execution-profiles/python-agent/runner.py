"""Customer-authored Python agent runner (runner protocol v1).

This sample shows how a team that writes agents with the Python Copilot SDK plugs into the
TypeScript platform without a Python control plane. It speaks the same JSON Lines protocol over
stdio as the TypeScript reference runner, routes inference through the platform gateway with the
job-scoped capability, and never receives upstream provider credentials.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from datetime import datetime
from importlib.metadata import version
from typing import Any

from copilot import CopilotClient
from copilot.generated.rpc import PermissionDecisionApproveOnce, PermissionDecisionReject
from copilot.tools import Tool, ToolInvocation, ToolResult
from jsonschema import Draft202012Validator

PROTOCOL = "1"
TOOLS_ROOT = os.environ.get("TOOLS_ROOT", "tools")
RESULT_CONTRACT = (
    "\n\n## Result contract\nWhen you have finished, call the `submit_result` tool exactly once with the "
    "complete final result. The arguments must satisfy the tool's JSON schema."
)
DEFAULT_INPUT_TIMEOUT_SECONDS = 600
# Built-in SDK agents stay unreachable; only the harness's own sub-agents can be delegated to.
BUILTIN_AGENTS = ["explore", "task", "general-purpose", "code-review", "research", "rubber-duck", "security-review", "rem-agent"]
BUILTIN_TOOL_GROUPS = {
    "files": ["view", "glob", "grep", "create", "edit", "apply_patch"],
    "shell": [
        "bash",
        "read_bash",
        "write_bash",
        "stop_bash",
        "list_bash",
        "powershell",
        "read_powershell",
        "write_powershell",
        "stop_powershell",
        "list_powershell",
    ],
    "web": ["web_fetch"],
    "agents": ["task", "read_agent", "list_agents", "write_agent"],
}
PERMISSION_LIMITS = {"intention": 1000, "command": 8000, "path": 1000, "url": 2000, "diff": 20_000, "tool": 200, "warning": 1000}
QUESTION_FALLBACK = "No answer was given in time. Continue with your best judgement and state your assumptions."

_terminal = False


def write(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def parse_line(line: bytes) -> dict[str, Any] | None:
    """Parses one protocol line; blank or malformed lines are ignored."""
    try:
        message = json.loads(line)
    except (json.JSONDecodeError, UnicodeDecodeError):
        if line.strip():
            print("runner: ignoring invalid protocol message", file=sys.stderr)
        return None
    return message if isinstance(message, dict) else None


def event(body: dict[str, Any]) -> None:
    if not _terminal:
        write({"type": "event", "event": body})


def result(output: Any) -> None:
    global _terminal
    if not _terminal:
        _terminal = True
        write({"type": "result", "output": output})


def failure(code: str, message: str, retryable: bool, uncertain_effects: bool = False) -> None:
    global _terminal
    if not _terminal:
        _terminal = True
        write(
            {
                "type": "failure",
                "code": code,
                "message": message[:2000],
                "retryable": retryable,
                "uncertainEffects": uncertain_effects,
            }
        )


class InputBridge:
    def __init__(self) -> None:
        self._pending: dict[str, tuple[asyncio.Future[dict[str, Any]], asyncio.TimerHandle | None]] = {}
        self._counter = 0

    async def ask(self, request: dict[str, Any], timeout: float | None = None) -> dict[str, Any]:
        if _terminal or (timeout is not None and timeout <= 0):
            return {"kind": "expired"}
        request_id = f"r{int(time.time() * 1000):x}_{self._counter:x}"
        self._counter += 1
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()

        def expire() -> None:
            if not future.done():
                future.set_result({"kind": "expired"})

        timer = loop.call_later(timeout, expire) if timeout is not None else None
        self._pending[request_id] = (future, timer)
        write({"type": "input_request", "id": request_id, "request": request})
        try:
            return await future
        finally:
            pending = self._pending.pop(request_id, None)
            if pending and pending[1]:
                pending[1].cancel()

    def resolve(self, request_id: str, response: dict[str, Any]) -> None:
        pending = self._pending.get(request_id)
        if not pending:
            return
        future, _timer = pending
        if not future.done():
            future.set_result(response)

    def expire_all(self) -> None:
        for future, timer in list(self._pending.values()):
            if timer:
                timer.cancel()
            if not future.done():
                future.set_result({"kind": "expired"})
        self._pending.clear()


def truncate(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    return value[:limit]


def add_if_present(target: dict[str, Any], key: str, value: Any) -> None:
    if value is not None:
        target[key] = value


def permission_mode_for(permissions: dict[str, Any] | None, kind: str) -> str:
    if not permissions:
        return "deny"
    return (permissions.get("kinds") or {}).get(kind) or permissions["default"]


def sandbox_warning(request: Any) -> str | None:
    if not getattr(request, "request_sandbox_bypass", False):
        return None
    reason = getattr(request, "request_sandbox_bypass_reason", None)
    return f"Sandbox bypass requested: {reason}" if reason else "Sandbox bypass requested."


def combined_warning(request: Any) -> str | None:
    parts = [part for part in (getattr(request, "warning", None), sandbox_warning(request)) if isinstance(part, str) and part.strip()]
    return truncate("\n".join(parts), PERMISSION_LIMITS["warning"]) if parts else None


def permission_prompt_for(request: Any) -> dict[str, Any]:
    kind = request.kind
    warning = combined_warning(request)
    if kind == "shell":
        prompt: dict[str, Any] = {"type": "shell"}
        add_if_present(prompt, "intention", truncate(getattr(request, "intention", None), PERMISSION_LIMITS["intention"]))
        add_if_present(prompt, "command", truncate(getattr(request, "full_command_text", None), PERMISSION_LIMITS["command"]))
        add_if_present(prompt, "warning", warning)
        return prompt
    if kind == "write":
        prompt = {"type": "write"}
        add_if_present(prompt, "intention", truncate(getattr(request, "intention", None), PERMISSION_LIMITS["intention"]))
        add_if_present(prompt, "path", truncate(getattr(request, "file_name", None), PERMISSION_LIMITS["path"]))
        add_if_present(prompt, "diff", truncate(getattr(request, "diff", None) or getattr(request, "new_file_contents", None), PERMISSION_LIMITS["diff"]))
        add_if_present(prompt, "warning", warning)
        return prompt
    if kind == "read":
        prompt = {"type": "read"}
        add_if_present(prompt, "intention", truncate(getattr(request, "intention", None), PERMISSION_LIMITS["intention"]))
        add_if_present(prompt, "path", truncate(getattr(request, "path", None), PERMISSION_LIMITS["path"]))
        add_if_present(prompt, "warning", warning)
        return prompt
    if kind == "url":
        prompt = {"type": "url"}
        add_if_present(prompt, "intention", truncate(getattr(request, "intention", None), PERMISSION_LIMITS["intention"]))
        add_if_present(prompt, "url", truncate(getattr(request, "url", None), PERMISSION_LIMITS["url"]))
        add_if_present(prompt, "warning", warning)
        return prompt
    if kind == "mcp":
        prompt = {"type": "mcp"}
        add_if_present(prompt, "tool", truncate(f"{request.server_name}:{request.tool_name}", PERMISSION_LIMITS["tool"]))
        add_if_present(prompt, "intention", truncate(getattr(request, "tool_title", None), PERMISSION_LIMITS["intention"]))
        return prompt
    prompt = {"type": "other"}
    tool = getattr(request, "tool_name", None) or getattr(request, "tool_title", None) or kind
    add_if_present(prompt, "tool", truncate(tool, PERMISSION_LIMITS["tool"]))
    add_if_present(
        prompt,
        "intention",
        truncate(getattr(request, "intention", None) or getattr(request, "tool_description", None), PERMISSION_LIMITS["intention"]),
    )
    add_if_present(prompt, "warning", warning)
    return prompt


def policy_kind(prompt: dict[str, Any]) -> str:
    return prompt["type"] if prompt["type"] in ("read", "write", "shell", "url") else "__default__"


def build_permission_handler(permissions: dict[str, Any] | None, ask: Any) -> Any:
    approved_kinds: set[str] = set()

    async def on_permission_request(request: Any, _invocation: dict[str, str]) -> Any:
        prompt = permission_prompt_for(request)
        if prompt["type"] in approved_kinds:
            return PermissionDecisionApproveOnce()
        mode = permission_mode_for(permissions, policy_kind(prompt))
        if mode == "allow":
            return PermissionDecisionApproveOnce()
        if mode == "deny":
            return PermissionDecisionReject(feedback="Not permitted by the job policy.")
        response = await ask({"kind": "permission", "permission": prompt})
        if response.get("kind") == "expired":
            return PermissionDecisionReject(feedback="No approval was given in time.")
        if response.get("kind") != "permission" or not response.get("approved"):
            return PermissionDecisionReject(feedback=response.get("feedback") or "Denied by the reviewer.")
        if response.get("scope") == "kind":
            approved_kinds.add(prompt["type"])
        return PermissionDecisionApproveOnce(approved_interactively=True)

    return on_permission_request


async def run_python_tool(script: str, args: Any, workspace: str, timeout: float = 30.0) -> Any:
    """Runs a pinned Python tool with JSON on stdin and bounded output."""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-I",
        script,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=workspace,
        env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(json.dumps(args).encode()), timeout)
    except asyncio.TimeoutError:
        process.kill()
        raise RuntimeError("Python tool timed out.")
    if process.returncode != 0:
        last = stderr.decode(errors="replace").strip().splitlines()[-1:] or [f"exit {process.returncode}"]
        raise RuntimeError(f"Python tool failed: {last[0]}")
    if len(stdout) > 1024 * 1024:
        raise RuntimeError("Python tool output too large.")
    return json.loads(stdout)


def bind_tools(requests: list[dict[str, Any]], workspace: str) -> list[Tool]:
    tools: list[Tool] = []
    for request in requests:
        if request["binding"] != "python:stats":
            raise LookupError(f"Tool binding '{request['binding']}' is not available in this runner.")
        script = os.path.join(TOOLS_ROOT, "python", "stats.py")

        async def handler(invocation: ToolInvocation, _script: str = script) -> ToolResult:
            try:
                output = await run_python_tool(_script, invocation.arguments, workspace)
                return ToolResult(text_result_for_llm=json.dumps(output))
            except Exception as error:  # noqa: BLE001 - reported to the model as a tool failure
                return ToolResult(result_type="failure", error=str(error), text_result_for_llm=str(error))

        tools.append(
            Tool(
                name=request["name"],
                description=request["description"],
                parameters={
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "values": {"type": "array", "items": {"type": "number"}, "minItems": 1},
                    },
                    "required": ["values"],
                    "additionalProperties": False,
                },
                handler=handler,
                skip_permission=True,
            )
        )
    return tools


def write_skills(skills: list[dict[str, Any]], directory: str) -> None:
    """Materializes harness skills as <directory>/<name>/SKILL.md for the SDK skill loader."""
    for skill in skills:
        folder = os.path.join(directory, skill["name"])
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, "SKILL.md"), "w", encoding="utf-8") as handle:
            handle.write(
                f"---\nname: {skill['name']}\ndescription: {json.dumps(skill['description'])}\n---\n\n"
                f"{skill['content'].strip()}\n"
            )


def session_options(definition: dict[str, Any], tool_names: list[str], skills_directory: str) -> dict[str, Any]:
    """Maps a harness definition to Python SDK session options (mirrors session-config.ts)."""
    content = definition["instructions"] + RESULT_CONTRACT
    prompt = definition.get("prompt") or {"mode": "replace"}
    if prompt["mode"] == "customize":
        sections = {
            s["name"]: {"action": "remove"} if s["action"] == "remove" else {"action": s["action"], "content": s["content"]}
            for s in prompt.get("sections", [])
        }
        system_message: dict[str, Any] = {"mode": "customize", "content": content, "sections": sections}
    else:
        system_message = {"mode": prompt["mode"], "content": content}

    agents = definition.get("agents") or []
    skills = definition.get("skills") or []
    builtin_tools = definition.get("builtinTools") or []
    available = [f"custom:{name}" for name in tool_names]
    for group in builtin_tools:
        available.extend(f"builtin:{name}" for name in BUILTIN_TOOL_GROUPS[group])
    if agents:
        available.append("builtin:task")
    if skills:
        available.append("builtin:skill")
    if (definition.get("permissions") or {}).get("questions") is True:
        available.append("builtin:ask_user")
    options: dict[str, Any] = {
        "system_message": system_message,
        "available_tools": list(dict.fromkeys(available)),
        "excluded_builtin_agents": [] if "agents" in builtin_tools else list(BUILTIN_AGENTS),
    }
    model = definition["model"]
    if model.get("reasoningEffort"):
        options["reasoning_effort"] = model["reasoningEffort"]
    if model.get("contextTier"):
        options["context_tier"] = model["contextTier"]
    if agents:
        custom_agents = []
        for agent in agents:
            config: dict[str, Any] = {
                "name": agent["name"],
                "display_name": agent.get("displayName") or agent["name"],
                "description": agent["description"],
                "prompt": agent["instructions"],
                "tools": list(agent["tools"]),
                "infer": True,
            }
            if agent.get("skills"):
                config["skills"] = list(agent["skills"])
            if agent.get("model"):
                config["model"] = agent["model"]
            if agent.get("reasoningEffort"):
                config["reasoning_effort"] = agent["reasoningEffort"]
            custom_agents.append(config)
        options["custom_agents"] = custom_agents
        delegated = [t["name"] for t in definition["tools"] if t.get("delegatedOnly")]
        if delegated:
            options["default_agent"] = {"excluded_tools": delegated}
    if skills:
        options["enable_skills"] = True
        options["skill_directories"] = [skills_directory]
    return options


async def run(start: dict[str, Any], cancelled: asyncio.Event, input_bridge: InputBridge) -> None:
    definition = start["harness"]["definition"]
    if errors := list(Draft202012Validator(definition["input"]["schema"]).iter_errors(start["input"])):
        failure("invalid_input", f"Input does not match the harness schema: {errors[0].message}", False)
        return

    workspace = start["workspace"]
    files = os.path.join(workspace, "files")
    os.makedirs(files, exist_ok=True)
    skills_directory = os.path.join(workspace, "skills")
    write_skills(definition.get("skills") or [], skills_directory)
    try:
        tools = bind_tools(definition["tools"], files)
    except LookupError as error:
        failure("unsupported", str(error), False)
        return

    output_validator = Draft202012Validator(definition["output"]["schema"])
    submitted: dict[str, Any] = {}

    async def submit_result(invocation: ToolInvocation) -> ToolResult:
        problems = [f"{'/'.join(map(str, e.path)) or '/'} {e.message}" for e in output_validator.iter_errors(invocation.arguments)]
        if problems:
            message = "The result does not match the required schema: " + "; ".join(problems[:10])
            return ToolResult(result_type="failure", error=message, text_result_for_llm=message)
        submitted["output"] = invocation.arguments
        return ToolResult(text_result_for_llm='{"accepted": true}')

    tools.append(
        Tool(
            name="submit_result",
            description="Submit the final structured result of this job. Call exactly once when finished.",
            parameters=definition["output"]["schema"],
            handler=submit_result,
            skip_permission=True,
            is_terminal=True,
        )
    )

    tool_names: dict[str, str] = {}
    last_error: dict[str, Any] = {}

    def on_event(evt: Any) -> None:
        kind = evt.type.value
        if kind == "assistant.turn_start":
            event({"kind": "agent.turn_started"})
        elif kind == "assistant.turn_end":
            event({"kind": "agent.turn_completed"})
        elif kind == "tool.execution_start":
            tool_names[evt.data.tool_call_id] = evt.data.tool_name
            event({"kind": "tool.started", "tool": evt.data.tool_name[:100]})
        elif kind == "tool.execution_complete":
            name = tool_names.get(evt.data.tool_call_id, "unknown")
            event({"kind": "tool.completed", "tool": name[:100], "ok": bool(evt.data.success)})
        elif kind == "subagent.started":
            event({"kind": "subagent.started", "agent": str(evt.data.agent_name)[:100]})
        elif kind in ("subagent.completed", "subagent.failed"):
            event({"kind": "subagent.completed", "agent": str(evt.data.agent_name)[:100], "ok": kind == "subagent.completed"})
        elif kind == "skill.invoked":
            event({"kind": "skill.used", "skill": str(evt.data.name)[:100]})
        elif kind == "session.error":
            last_error["status"] = getattr(evt.data, "status_code", None)

    runtime_env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "COPILOT_CLI_EXTRACT_DIR", "COPILOT_SKIP_CLI_DOWNLOAD")}
    client = CopilotClient(
        mode="empty",
        base_directory=os.path.join(workspace, "copilot-home"),
        working_directory=files,
        use_logged_in_user=False,
        log_level="error",
        env=runtime_env,
    )
    deadline = datetime.fromisoformat(start["deadline"].replace("Z", "+00:00")).timestamp()

    async def ask_input(request: dict[str, Any]) -> dict[str, Any]:
        timeout = min((definition.get("permissions") or {}).get("timeoutSeconds") or DEFAULT_INPUT_TIMEOUT_SECONDS, deadline - time.time() - 1)
        if cancelled.is_set() or timeout <= 0:
            return {"kind": "expired"}
        return await input_bridge.ask(request, timeout)

    async def on_user_input_request(request: dict[str, Any], _invocation: dict[str, str]) -> dict[str, Any]:
        choices = request.get("choices")
        if choices:
            choices = [choice[:500] for choice in choices if choice][:20] or None
        question = {
            "kind": "question",
            "question": (request.get("question") or "The agent asks for input.")[:4000],
            "allowFreeform": request.get("allowFreeform", True),
        }
        if choices:
            question["choices"] = choices
        response = await ask_input(question)
        if response.get("kind") == "question":
            return {"answer": response.get("answer", ""), "wasFreeform": bool(response.get("wasFreeform"))}
        return {"answer": QUESTION_FALLBACK, "wasFreeform": True}

    await client.start()
    try:
        session = await client.create_session(
            model=start["inference"]["model"],
            provider={
                "type": "openai",
                "base_url": start["inference"]["baseUrl"],
                "api_key": start["inference"]["token"],
                "wire_api": "completions",
            },
            tools=tools,
            on_permission_request=build_permission_handler(definition.get("permissions"), ask_input),
            on_user_input_request=on_user_input_request if (definition.get("permissions") or {}).get("questions") is True else None,
            enable_config_discovery=False,
            skip_custom_instructions=True,
            **session_options(definition, [tool.name for tool in tools], skills_directory),
        )
        session.on(on_event)

        async def abort_on_cancel() -> None:
            await cancelled.wait()
            input_bridge.expire_all()
            await session.abort()

        watcher = asyncio.create_task(abort_on_cancel())
        prompt = (
            f"Job input (JSON):\n```json\n{json.dumps(start['input'], indent=2)}\n```\n\n"
            "Complete the task using the available tools, then call submit_result."
        )
        try:
            for message in (prompt, "You have not submitted a valid result yet. Call submit_result now."):
                if submitted or cancelled.is_set():
                    break
                remaining = deadline - time.time() - 3
                if remaining <= 0:
                    failure("deadline_exceeded", "The attempt deadline was reached.", False)
                    return
                await session.send_and_wait(message, timeout=remaining)
        except Exception as error:  # noqa: BLE001 - mapped to protocol failures
            if cancelled.is_set():
                failure("cancelled", "The attempt was cancelled.", False)
            elif deadline - time.time() <= 3 or isinstance(error, asyncio.TimeoutError):
                failure("deadline_exceeded", "The attempt deadline was reached.", False)
            else:
                status = last_error.get("status")
                failure("inference_error", f"Inference failed ({status or 'error'}).", status not in (401, 403))
            return
        finally:
            watcher.cancel()

        if cancelled.is_set():
            failure("cancelled", "The attempt was cancelled.", False)
        elif "output" in submitted:
            result(submitted["output"])
        else:
            failure("invalid_output", "The agent finished without submitting a valid result.", False)
        await session.disconnect()
    finally:
        await client.stop()


async def main() -> None:
    write(
        {
            "type": "hello",
            "protocol": PROTOCOL,
            "runner": {
                "name": "python-sample-agent",
                "version": "0.1.0",
                "language": "python",
                "sdkVersion": version("github-copilot-sdk"),
            },
            "capabilities": [
                "cancel",
                "structured-result",
                "prompt-sections",
                "model-options",
                "custom-agents",
                "skills",
                "builtin-tools",
                "interactive",
            ],
        }
    )
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    cancelled = asyncio.Event()
    input_bridge = InputBridge()
    start: dict[str, Any] | None = None
    while start is None:
        line = await reader.readline()
        if not line:
            return
        message = parse_line(line)
        if message is None:
            continue
        if message.get("type") == "cancel":
            failure("cancelled", "Cancelled before start.", False)
            return
        if message.get("type") == "start" and message.get("protocol") == PROTOCOL:
            start = message

    async def watch_stdin() -> None:
        while True:
            line = await reader.readline()
            if not line:
                cancelled.set()
                input_bridge.expire_all()
                return
            message = parse_line(line)
            if message is None:
                continue
            if message.get("type") == "input_response":
                input_bridge.resolve(str(message.get("id")), message.get("response") or {"kind": "expired"})
            elif message.get("type") == "cancel":
                cancelled.set()
                input_bridge.expire_all()
                return

    watcher = asyncio.create_task(watch_stdin())
    try:
        await run(start, cancelled, input_bridge)
    except Exception as error:  # noqa: BLE001
        print(f"runner: unexpected error: {error}", file=sys.stderr)
        failure("internal", "The runner failed unexpectedly.", True)
    finally:
        watcher.cancel()
        input_bridge.expire_all()
        if not _terminal:
            failure("internal", "The runner ended without an outcome.", True)


if __name__ == "__main__":
    asyncio.run(main())
