import type { TokenCredential } from "@azure/identity";

const COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * Supplies the gateway's own Microsoft Entra token for the model provider. The token never leaves
 * the gateway; it is refreshed ahead of expiry and failures are surfaced rather than retried with
 * a weaker credential.
 */
export class UpstreamTokenProvider {
  #cached: { token: string; expiresAt: number } | undefined;
  #pending: Promise<string> | undefined;

  constructor(private readonly credential: TokenCredential) {}

  async token(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt - now > 5 * 60_000) {
      return this.#cached.token;
    }
    this.#pending ??= this.#refresh().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  async #refresh(): Promise<string> {
    const token = await this.credential.getToken(COGNITIVE_SERVICES_SCOPE);
    if (!token) {
      throw new Error("No upstream token available.");
    }
    this.#cached = { token: token.token, expiresAt: token.expiresOnTimestamp };
    return token.token;
  }
}
