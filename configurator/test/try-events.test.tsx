import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EventItem, type JobEvent } from "../src/views/Try";

vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: vi.fn() }));

function render(event: JobEvent): string {
  return renderToStaticMarkup(<EventItem event={event} />);
}

describe("Try it activity events", () => {
  it("summarizes SDK messages and exposes their persisted detail", () => {
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
    expect(html).toContain("SDK details");
    expect(html).toContain("&quot;eventType&quot;: &quot;assistant.message&quot;");
    expect(html).not.toContain(">sdk.event<");
  });

  it("uses the SDK event type when no richer summary exists", () => {
    const html = render({
      seq: 4,
      at: "2026-10-07T02:45:01.000Z",
      body: {
        type: "job.runner_event",
        attempt: 1,
        event: {
          kind: "sdk.event",
          detail: {
            eventType: "session.idle",
            data: {},
          },
        },
      },
    });

    expect(html).toContain("session idle");
    expect(html).toContain("SDK details");
  });
});
