import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubInferenceFields, modelDetails, validGitHubInferenceToken } from "../src/components/GitHubInferenceFields";

const state: Record<string, unknown> = {};

vi.mock("../src/state", () => ({ useApp: () => state }));
vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: (error: unknown) => String(error) }));

describe("GitHub inference fields", () => {
  beforeEach(() => {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, { refreshSettings: vi.fn(), toast: vi.fn(), settings: { githubInferenceCredentialStored: true } });
  });

  it("shows the stored indicator and the github/ routed names of selected models", () => {
    const html = renderToStaticMarkup(<GitHubInferenceFields models={["gpt-5.4"]} onChange={() => undefined} />);
    expect(html).toContain("Token stored");
    expect(html).toContain("github/gpt-5.4");
    expect(html).toContain("Discover models");
    expect(html).toContain('type="password"');
  });

  it("explains that an empty selection exposes every usable model", () => {
    state.settings = { githubInferenceCredentialStored: false };
    const html = renderToStaticMarkup(<GitHubInferenceFields models={[]} onChange={() => undefined} />);
    expect(html).toContain("No token stored");
    expect(html).toContain("Empty exposes every usable model");
  });

  it("validates tokens and describes discovered models", () => {
    expect(validGitHubInferenceToken("")).toBe(true);
    expect(validGitHubInferenceToken("short")).toBe(false);
    expect(validGitHubInferenceToken("github_pat_with space_0000000")).toBe(false);
    expect(validGitHubInferenceToken("github_pat_000000000000000000")).toBe(true);
    expect(modelDetails([{ id: "gpt-5.4", name: "GPT-5.4", routedAs: "github/gpt-5.4", multiplier: 1 }])).toEqual({
      "gpt-5.4": "github/gpt-5.4 · GPT-5.4 · 1x premium requests",
    });
  });
});
