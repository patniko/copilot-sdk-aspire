import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EventItem, type JobEvent } from "../src/views/Try";

vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: vi.fn() }));

function render(event: JobEvent): string {
  return renderToStaticMarkup(<EventItem event={event} />);
}

describe("Try it activity events", () => {
  it("uses the SDK summary as the expandable title", () => {
    const html = render({
      seq: 3,
      at: "2026-10-07T02:45:00.000Z",
      body: {
        type: "job.runner_event",
        attempt: 1,
        event: {
          kind: "sdk.event",
          detail: {
            eventType: "assistant.message",
            id: "event-1",
            data: { content: "The detailed assistant response." },
          },
        },
      },
    });

    expect(html).toContain("Assistant: The detailed assistant response.");
    expect(html).toContain("<summary");
    expect(html).toContain("&quot;eventType&quot;: &quot;assistant.message&quot;");
    expect(html).not.toContain(">sdk.event<");
    expect(html).not.toContain("SDK details");
  });

  it("promotes useful SDK properties into the title", () => {
    const html = render({
      seq: 4,
      at: "2026-10-07T02:45:01.000Z",
      body: {
        type: "job.runner_event",
        attempt: 1,
        event: {
          kind: "sdk.event",
          detail: {
            eventType: "model.call_finished",
            data: { outcome: "success", dispatchDurationMs: 1642 },
          },
        },
      },
    });

    expect(html).toContain("Model call succeeded");
    expect(html).toContain("1.6 s");
  });

  it("adds the SDK turn number to otherwise generic runner activity", () => {
    const html = render({
      seq: 5,
      at: "2026-10-07T02:45:02.000Z",
      body: {
        type: "job.runner_event",
        attempt: 1,
        event: {
          kind: "agent.turn_started",
          detail: {
            eventType: "assistant.turn_start",
            data: { turnId: 2, interactionId: "interaction-1" },
          },
        },
      },
    });

    expect(html).toContain("Agent turn started · turn 2");
    expect(html).not.toContain("SDK details");
  });
});
