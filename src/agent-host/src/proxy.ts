export async function resolveGitHubOwner(login: string): Promise<number> {
  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "copilot-aspire-demo-host" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("The configured GitHub owner could not be resolved.");
  const user: unknown = await response.json();
  if (!user || typeof user !== "object" || !("id" in user) || !("login" in user)
    || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0
    || typeof user.login !== "string" || user.login.toLowerCase() !== login.toLowerCase()) {
    throw new Error("The configured GitHub owner returned an invalid identity.");
  }
  return user.id;
}

export async function verifyGitHubOwner(token: string, expected: string): Promise<number | undefined> {
  const response = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "copilot-aspire-demo-host" },
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (response.status === 401 || response.status === 403) return undefined;
  if (!response.ok) throw new Error("GitHub identity verification is unavailable.");
  const user: unknown = await response.json();
  if (user && typeof user === "object" && "login" in user && typeof user.login === "string"
    && user.login.toLowerCase() === expected.toLowerCase() && "id" in user
    && typeof user.id === "number" && Number.isSafeInteger(user.id) && user.id > 0) return user.id;
  return undefined;
}
