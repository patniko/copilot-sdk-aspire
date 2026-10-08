import { describe, expect, it, vi } from "vitest";
import { GitHubAuthError, GitHubDeviceAuth } from "../server/github-auth.js";

describe("GitHub device authorization", () => {
  it("exchanges an approved device code, verifies the account, and stores the identity", async () => {
    let now = 1_000;
    const saveIdentity = vi.fn();
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      if (url.endsWith("/login/oauth/access_token")) {
        return Response.json({ access_token: "gho_authenticated-user-token", token_type: "bearer", scope: "read:user" });
      }
      if (url.endsWith("/user")) return Response.json({ login: "octocat", id: 1 });
      throw new Error(`Unexpected request: ${url}`);
    }) as unknown as typeof fetch;
    const auth = new GitHubDeviceAuth("Iv1.client", saveIdentity, request, () => now);

    const flow = await auth.start();
    expect(flow).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      intervalSeconds: 5,
    });

    now += 5_000;
    await expect(auth.poll(flow.flowId)).resolves.toEqual({ status: "complete", login: "octocat" });
    expect(saveIdentity).toHaveBeenCalledWith("gho_authenticated-user-token", "octocat");
  });

  it("honors GitHub's polling interval and pending response", async () => {
    let now = 1_000;
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/login/device/code")) {
        return Response.json({
          device_code: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          expires_in: 900,
          interval: 5,
        });
      }
      return Response.json({ error: "authorization_pending" });
    }) as unknown as typeof fetch;
    const auth = new GitHubDeviceAuth("Iv1.client", vi.fn(), request, () => now);
    const flow = await auth.start();

    await expect(auth.poll(flow.flowId)).resolves.toEqual({ status: "pending", intervalSeconds: 5 });
    await expect(auth.poll(flow.flowId)).resolves.toEqual({ status: "pending", intervalSeconds: 5 });
    expect(request).toHaveBeenCalledTimes(2);

    now += 5_000;
    await expect(auth.poll(flow.flowId)).resolves.toEqual({ status: "pending", intervalSeconds: 5 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("reports a missing client ID without contacting GitHub", async () => {
    const request = vi.fn() as unknown as typeof fetch;
    const auth = new GitHubDeviceAuth(undefined, vi.fn(), request);

    await expect(auth.start()).rejects.toEqual(expect.objectContaining<Partial<GitHubAuthError>>({
      statusCode: 503,
      message: expect.stringContaining("CONFIGURATOR_GITHUB_CLIENT_ID"),
    }));
    expect(request).not.toHaveBeenCalled();
  });
});
