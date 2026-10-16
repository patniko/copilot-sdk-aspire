import { execFileSync } from "node:child_process";

/** Explicit opt-in only. The credential is never persisted or included in diagnostics. */
export async function testGitHubAccount(): Promise<{ credential: string; id: number; login: string }> {
  const credential = process.env.HYBRID_USE_GH_ACCOUNT === "1"
    ? execFileSync("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    : process.env.DEMO_TEST_GITHUB_TOKEN;
  if (!credential) throw new Error("Provide DEMO_TEST_GITHUB_TOKEN or explicitly opt in to HYBRID_USE_GH_ACCOUNT=1.");
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${credential}`, accept: "application/vnd.github+json" },
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub identity validation failed (${response.status}).`);
  const identity: unknown = await response.json();
  if (!identity || typeof identity !== "object" || !("id" in identity) || typeof identity.id !== "number" || !Number.isSafeInteger(identity.id) || identity.id < 1
    || !("login" in identity) || typeof identity.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(identity.login)) {
    throw new Error("GitHub returned an invalid account identity.");
  }
  return { credential, id: identity.id, login: identity.login };
}
