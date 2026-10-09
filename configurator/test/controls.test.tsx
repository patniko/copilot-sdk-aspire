import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import summarizer from "../../examples/customer-config/harnesses/text-summarizer/harness.json";
import analyst from "../../examples/customer-config/harnesses/dataset-analyst/harness.json";
import demo from "../../examples/customer-config/harnesses/interactive-demo/harness.json";
import { fieldProblem, SchemaForm, supportsForm } from "../src/components/SchemaForm";
import { urlProblem } from "../src/components/UrlInput";
import { bumpSemver, formatUnit, NumberInput, OrderedList, RadioCards, SegmentedControl } from "../src/components/ui";
import { typingSlug } from "../src/views/harness/tabs";

vi.mock("../src/state", () => ({ useApp: () => ({ workspace: { harnesses: [] } }) }));
vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: String }));

describe("control helpers", () => {
  it("formats seconds and tokens for humans", () => {
    expect(formatUnit(45, "seconds")).toBe("45 s");
    expect(formatUnit(600, "seconds")).toBe("10 min");
    expect(formatUnit(5430, "seconds")).toBe("1 h 30 min 30 s");
    expect(formatUnit(200_000, "tokens")).toBe("200k tokens");
    expect(formatUnit(1_500_000, "tokens")).toBe("1.5M tokens");
    expect(formatUnit(Number.NaN, "tokens")).toBeUndefined();
  });

  it("bumps semantic versions and resets lower parts", () => {
    expect(bumpSemver("1.4.2")).toBe("1.4.3");
    expect(bumpSemver("1.4.2", "minor")).toBe("1.5.0");
    expect(bumpSemver("1.4.2-beta", "major")).toBe("2.0.0");
    expect(bumpSemver("nope")).toBe("1.0.0");
  });

  it("normalizes slugs while typing", () => {
    expect(typingSlug("My Reviewer")).toBe("my-reviewer");
    expect(typingSlug("a__b!!c")).toBe("a-b-c");
  });

  it("validates URLs before they can be tested", () => {
    expect(urlProblem("")).toBeUndefined();
    expect(urlProblem("registry.example")).toMatch(/full URL/);
    expect(urlProblem("http://proxy.local/npm")).toBeUndefined();
    expect(urlProblem("http://example.openai.azure.com", { https: true })).toMatch(/https/);
    expect(urlProblem("ftp://example.com")).toMatch(/http/);
  });
});

describe("schema-driven input form", () => {
  it("supports object schemas and rejects composed ones", () => {
    expect(supportsForm(summarizer.input.schema)).toBe(true);
    expect(supportsForm({ type: "string" })).toBe(false);
    expect(supportsForm({ type: "object", properties: {}, oneOf: [] })).toBe(false);
  });

  it("renders a long string as a text area and flags missing required values", () => {
    const html = renderToStaticMarkup(<SchemaForm schema={summarizer.input.schema} value={{}} onChange={() => undefined} />);
    expect(html).toContain("<textarea");
    expect(html).toContain("request");
    expect(html).toContain("Required.");
  });

  it("uses chips for string arrays and JSON for nested matrices", () => {
    const html = renderToStaticMarkup(<SchemaForm schema={analyst.input.schema} value={analyst.input.schema.examples[0]} onChange={() => undefined} />);
    expect(html).toContain("<legend");
    expect(html).toContain("dataset");
    expect(html).toContain("Remove region");
    expect(html).toContain("(edited as JSON)");
  });

  it("says when a harness takes no input", () => {
    expect(renderToStaticMarkup(<SchemaForm schema={demo.input.schema} value={{}} onChange={() => undefined} />)).toContain("takes no input fields");
  });

  it("checks basic constraints", () => {
    expect(fieldProblem({ type: "string", minLength: 3 }, "ab", true)).toMatch(/At least 3/);
    expect(fieldProblem({ type: "string", pattern: "^https://" }, "http://x", false)).toMatch(/Must match/);
    expect(fieldProblem({ type: "integer", maximum: 5 }, 6, false)).toMatch(/Maximum 5/);
    expect(fieldProblem({ type: "string" }, "", false)).toBeUndefined();
  });
});

describe("controls", () => {
  it("shows units and range for numbers", () => {
    const html = renderToStaticMarkup(<NumberInput unit="seconds" value={900} min={10} max={3600} onChange={() => undefined} />);
    expect(html).toContain("15 min");
    expect(html).toContain("max 1 h");
  });

  it("marks disabled segmented options", () => {
    const html = renderToStaticMarkup(
      <SegmentedControl label="Effort" value="low" onChange={() => undefined} options={[{ value: "low", label: "low" }, { value: "xhigh", label: "xhigh", disabled: true }]} />,
    );
    expect(html).toContain('aria-checked="true"');
    expect(html).toMatch(/disabled=""[^>]*>xhigh/);
  });

  it("renders ordered lists with move controls and remaining options", () => {
    const html = renderToStaticMarkup(<OrderedList label="Models" values={["a", "b"]} options={["a", "b", "c"]} onChange={() => undefined} />);
    expect(html).toContain("Move a down");
    expect(html).toContain("+ c");
  });

  it("renders radio cards", () => {
    const html = renderToStaticMarkup(
      <RadioCards label="Transport" value="b" onChange={() => undefined} options={[{ value: "a", label: "A" }, { value: "b", label: "B", description: "Second" }]} />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Second");
  });
});
