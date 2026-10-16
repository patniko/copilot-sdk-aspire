import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHarnesses } from "@copilot-agent/service-defaults";

const examples = join(import.meta.dirname, "..", "..", "examples", "customer-config");

// Digests of the shipped examples on 0ad742e, before the hosting fields existed. Optional harness fields must stay
// omitted when unused so that existing published harnesses keep these digests (docs/HOSTING-MODES-PLAN.md, section 3).
const PINNED: Record<string, string> = {
  "copilot-coding-agent@1.0.0": "sha256:0161e4fdf891bcf439957977d859edffad527c390d2500f12e0c21ed5bdbc8c2",
  "dataset-analyst@1.1.0": "sha256:02b86aa734704c4f300934b7dc383467ba1087e66455b2918a587393ba862b54",
  "insights-team@1.0.0": "sha256:d351346958920cd19ed8f7acb1fbdee2a1be469b9aa3e045d28c05ee58fe81d3",
  "interactive-demo@1.0.0": "sha256:cb437f4980ac183cf73d987f5e082bb7693352581a5f4851b23b58f134d7264a",
  "text-summarizer@1.0.0": "sha256:af1301c4dcd766c08f31801b8c0b24e88d569319f71345f97825d332db220ddb",
  // Shared-hosting examples added with harness-driven shared mode (stage 2).
  "hybrid-coordinator@1.0.0": "sha256:0e92c067827d0ab0cb44fe316bd594ce591b622328eb481ae25f97e561a33869",
  "shared-researcher@1.0.0": "sha256:179deb7d1204d773a6e0631cf17029ebdffe5acfa1effd2fab458b32c0d2ec45",
  // Orchestrator and worker examples added with orchestrator workers (stage 4).
  "hybrid-builder@1.0.0": "sha256:f084d33f055f7a1256d63446f77137d3588ce58d924b303184776e45abd7c626",
  "hybrid-orchestrator@1.0.0": "sha256:feca8c0bc72ee1ccd0b2e4b4f04a5a0e8c8beb2c24becc38c6d519957acc11a4",
  "hybrid-reviewer@1.0.0": "sha256:c7b9d9439f6ec7fc704e256f674d73f27c27f6120358b42e32ab5baa218fbb29",
};

describe("published harness digests", () => {
  it("keeps the shipped example digests stable", async () => {
    const registry = await loadHarnesses(examples);
    const digests = Object.fromEntries(
      [...registry.values()].flat().map((snapshot) => [`${snapshot.definition.name}@${snapshot.definition.version}`, snapshot.digest]),
    );
    expect(digests).toEqual(PINNED);
  });
});
