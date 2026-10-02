// Deterministic fake runner implementing runner protocol v1 for end-to-end tests.
// It calls the inference gateway with its job capability and returns a schema-valid result.
// Behaviour is selected by the job input question: "hang" waits for cancellation, "invalid" returns a bad result.
import { createInterface } from "node:readline";

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({
  type: "hello",
  protocol: "1",
  runner: { name: "fake-runner", version: "0.0.1", language: "javascript", sdkVersion: "none" },
  capabilities: ["cancel", "structured-result"],
});

const lines = createInterface({ input: process.stdin });
let cancelled = false;
lines.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.type === "cancel") {
    cancelled = true;
    write({ type: "failure", code: "cancelled", message: "cancelled", retryable: false, uncertainEffects: false });
    process.exit(0);
  }
  if (message.type !== "start") {
    return;
  }
  const question = message.input?.question ?? "";
  const leaked = Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|AZURE|IDENTITY|services__/i.test(k));
  write({ type: "event", event: { kind: "agent.turn_started" } });
  const response = await fetch(`${message.inference.baseUrl}chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${message.inference.token}` },
    body: JSON.stringify({ model: message.inference.model, messages: [{ role: "user", content: question }] }),
  });
  const completion = await response.json();
  write({ type: "event", event: { kind: "tool.started", tool: "compute_statistics" } });
  write({ type: "event", event: { kind: "tool.completed", tool: "compute_statistics", ok: true } });
  if (question === "hang") {
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    return;
  }
  if (cancelled) {
    return;
  }
  write({
    type: "result",
    output:
      question === "invalid"
        ? { answer: 42 }
        : {
            answer: `${completion.choices?.[0]?.message?.content ?? "none"}|status=${response.status}|leaked=${leaked.join(",")}`,
            statistics: [{ column: "x", count: 2, mean: 1.5, median: 1.5, stdev: 0.7, min: 1, max: 2 }],
            observations: [],
          },
  });
  process.exit(0);
});
