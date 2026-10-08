import { randomUUID } from "node:crypto";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval?: number;
}

interface AccessToken {
  access_token: string;
  token_type: string;
  scope: string;
}

interface DeviceError {
  error: string;
  error_description?: string;
}

interface Flow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
  nextPollAt: number;
  result?: { status: "complete"; login: string } | { status: "failed"; error: string };
}

export class GitHubAuthError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class GitHubDeviceAuth {
  readonly #flows = new Map<string, Flow>();

  constructor(
    private readonly clientId: string | undefined,
    private readonly saveIdentity: (token: string, login: string) => Promise<void>,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get configured(): boolean {
    return Boolean(this.clientId);
  }

  async start(): Promise<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    intervalSeconds: number;
  }> {
    if (!this.clientId) {
      throw new GitHubAuthError(503, "GitHub sign-in is not configured. Set CONFIGURATOR_GITHUB_CLIENT_ID and restart the configurator.");
    }
    const response = await this.request("https://github.com/login/device/code", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, scope: "read:user" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new GitHubAuthError(502, `GitHub device authorization failed (${response.status}).`);
    const authorization = await response.json() as Partial<DeviceAuthorization>;
    if (typeof authorization.device_code !== "string" || typeof authorization.user_code !== "string"
      || typeof authorization.verification_uri !== "string" || typeof authorization.expires_in !== "number"
      || !URL.canParse(authorization.verification_uri)
      || new URL(authorization.verification_uri).origin !== "https://github.com") {
      throw new GitHubAuthError(502, "GitHub returned an invalid device authorization response.");
    }
    const intervalSeconds = Math.max(5, authorization.interval ?? 5);
    const expiresAt = this.now() + authorization.expires_in * 1_000;
    const flowId = randomUUID();
    this.#flows.set(flowId, {
      deviceCode: authorization.device_code,
      userCode: authorization.user_code,
      verificationUri: authorization.verification_uri,
      expiresAt,
      intervalSeconds,
      nextPollAt: 0,
    });
    return {
      flowId,
      userCode: authorization.user_code,
      verificationUri: authorization.verification_uri,
      expiresAt: new Date(expiresAt).toISOString(),
      intervalSeconds,
    };
  }

  async poll(flowId: string): Promise<
    { status: "pending"; intervalSeconds: number }
    | { status: "complete"; login: string }
    | { status: "failed"; error: string }
  > {
    const flow = this.#flows.get(flowId);
    if (!flow) throw new GitHubAuthError(404, "GitHub sign-in flow not found or expired.");
    if (flow.result) return flow.result;
    const now = this.now();
    if (now >= flow.expiresAt) return this.#fail(flow, "GitHub sign-in expired. Start again.");
    if (now < flow.nextPollAt) {
      return { status: "pending", intervalSeconds: Math.max(1, Math.ceil((flow.nextPollAt - now) / 1_000)) };
    }
    flow.nextPollAt = now + flow.intervalSeconds * 1_000;
    if (!this.clientId) throw new GitHubAuthError(503, "GitHub sign-in is no longer configured.");
    const response = await this.request("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new GitHubAuthError(502, `GitHub token exchange failed (${response.status}).`);
    const token = await response.json() as Partial<AccessToken & DeviceError>;
    if (typeof token.access_token === "string") {
      const login = await this.#login(token.access_token);
      await this.saveIdentity(token.access_token, login);
      flow.result = { status: "complete", login };
      flow.deviceCode = "";
      return flow.result;
    }
    switch (token.error) {
      case "authorization_pending":
        return { status: "pending", intervalSeconds: flow.intervalSeconds };
      case "slow_down":
        flow.intervalSeconds += 5;
        flow.nextPollAt = now + flow.intervalSeconds * 1_000;
        return { status: "pending", intervalSeconds: flow.intervalSeconds };
      case "access_denied":
        return this.#fail(flow, "GitHub sign-in was denied.");
      case "expired_token":
        return this.#fail(flow, "GitHub sign-in expired. Start again.");
      default:
        throw new GitHubAuthError(502, token.error_description || "GitHub returned an invalid token response.");
    }
  }

  #fail(flow: Flow, error: string): { status: "failed"; error: string } {
    flow.deviceCode = "";
    flow.result = { status: "failed", error };
    return flow.result;
  }

  async #login(token: string): Promise<string> {
    const response = await this.request("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "copilot-aspire-configurator",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new GitHubAuthError(502, "GitHub sign-in succeeded, but the account identity could not be verified.");
    const user = await response.json() as { login?: unknown; id?: unknown };
    if (typeof user.login !== "string" || !user.login || typeof user.id !== "number" || !Number.isSafeInteger(user.id) || user.id <= 0) {
      throw new GitHubAuthError(502, "GitHub returned an invalid account identity.");
    }
    return user.login;
  }
}
