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
from copilot.generated.rpc import PermissionDecisionReject
from copilot.tools import Tool, ToolInvocation, ToolResult
from jsonschema import Draft202012Validator

PROTOCOL = "1"
TOOLS_ROOT = os.environ.get("TOOLS_ROOT", "tools")
RESULT_CONTRACT = (
    "\n\n## Result contract\nWhen you have finished, call the `submit_result` tool exactly once with the "
    "complete final result. The arguments must satisfy the tool's JSON schema."
)

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


async def run(start: dict[str, Any], cancelled: asyncio.Event) -> None:
    definition = start["harness"]["definition"]
    if errors := list(Draft202012Validator(definition["input"]["schema"]).iter_errors(start["input"])):
        failure("invalid_input", f"Input does not match the harness schema: {errors[0].message}", False)
        return

    workspace = start["workspace"]
    files = os.path.join(workspace, "files")
    os.makedirs(files, exist_ok=True)
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
            system_message={"mode": "replace", "content": definition["instructions"] + RESULT_CONTRACT},
            tools=tools,
            available_tools=[f"custom:{tool.name}" for tool in tools],
            on_permission_request=lambda _req, _inv: PermissionDecisionReject(feedback="Not permitted by the job policy."),
            enable_config_discovery=False,
            skip_custom_instructions=True,
        )
        session.on(on_event)
        deadline = datetime.fromisoformat(start["deadline"].replace("Z", "+00:00")).timestamp()

        async def abort_on_cancel() -> None:
            await cancelled.wait()
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
            "capabilities": ["cancel", "structured-result"],
        }
    )
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    cancelled = asyncio.Event()
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
                return
            message = parse_line(line)
            if message is not None and message.get("type") == "cancel":
                cancelled.set()
                return

    watcher = asyncio.create_task(watch_stdin())
    try:
        await run(start, cancelled)
    except Exception as error:  # noqa: BLE001
        print(f"runner: unexpected error: {error}", file=sys.stderr)
        failure("internal", "The runner failed unexpectedly.", True)
    finally:
        watcher.cancel()
        if not _terminal:
            failure("internal", "The runner ended without an outcome.", True)


if __name__ == "__main__":
    asyncio.run(main())
