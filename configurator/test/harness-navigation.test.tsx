import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessSummary } from "../server/types";
import { HarnessNavigation, HarnessSections } from "../src/views/harness/navigation";
import { TABS } from "../src/views/harness/tabs";

vi.mock("../src/state", () => ({ useApp: () => ({}) }));

const harness: HarnessSummary = {
  name: "test-harness", folder: "test-harness", version: "1.0.0", description: "A useful harness.",
  latest: true, modified: false, untracked: false, errors: 0, warnings: 0,
};

describe("harness navigation", () => {
  it("makes the name the primary clickable target and shows the single version without a redundant selector", () => {
    const html = renderToStaticMarkup(<HarnessNavigation harnesses={[harness]} selected={harness.folder} disabled={false} onSelect={() => undefined} />);
    expect(html).toMatch(/<button[^>]*aria-current="page"[^>]*><span[^>]*>test-harness<\/span>/);
    expect(html).toContain("A useful harness.");
    expect(html).toContain("v1.0.0");
    expect(html).not.toContain("<select");
  });

  it("keeps the selected older version in its harness entry", () => {
    const versions = [{ ...harness, folder: "test-harness@2.0.0", version: "2.0.0" }, { ...harness, latest: false }];
    const html = renderToStaticMarkup(<HarnessNavigation harnesses={versions} selected={harness.folder} disabled={false} onSelect={() => undefined} />);
    expect(html).toContain('aria-label="Version of test-harness"');
    expect(html).toContain('<option value="test-harness" selected="">1.0.0</option>');
    expect(html).toContain("2.0.0 (latest)");
  });

  it("shows the latest version for an inactive harness and preserves validation status", () => {
    const versions = [{ ...harness, latest: false }, { ...harness, folder: "test-harness@2.0.0", version: "2.0.0", errors: 2 }];
    const html = renderToStaticMarkup(<HarnessNavigation harnesses={versions} selected="another-harness" disabled onSelect={() => undefined} />);
    expect(html).toContain('<option value="test-harness@2.0.0" selected="">2.0.0 (latest) - 2 errors</option>');
    expect(html).toContain("2 errors");
    expect(html).toContain('disabled=""');
  });

  it("renders every section without the scrolling tabs or count-badge clutter", () => {
    const html = renderToStaticMarkup(<HarnessSections selected="tools" issues={[{ path: "tools.0", level: "error", message: "Invalid tool" }]} onSelect={() => undefined} />);
    for (const tab of TABS) expect(html).toContain(tab.label.replace("&", "&amp;"));
    expect(html).toContain('class="harness-sections"');
    expect(html).not.toContain('class="tabs');
    expect(html).not.toContain("built-ins");
    expect(html).toContain('aria-label="1 errors or warnings"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
});
