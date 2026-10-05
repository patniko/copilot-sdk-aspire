import type {
  ExecutorCapabilities,
  HarnessSnapshot,
  InputRequestBody,
  InputRequestState,
  InputResponseBody,
  JobErrorCode,
  RunnerEventBody,
  RunnerHello,
} from "@copilot-agent/contracts";

export interface ClaimResponse {
  job: {
    id: string;
    principal: string;
    harness: HarnessSnapshot;
    profile: string;
    model: string;
    input: unknown;
  };
  attempt: { id: string; number: number; leaseToken: string; deadline: string; acknowledgedGaps: string[] };
  inference: { token: string; model: string };
  leaseSeconds: number;
  heartbeatSeconds: number;
}

export type Outcome =
  | { kind: "succeeded"; output: unknown }
  | { kind: "cancelled" }
  | { kind: "failed"; code: JobErrorCode; message: string; retryable: boolean; uncertainEffects: boolean };

export class LeaseLostError extends Error {}

export class InputRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class NotEligibleError extends Error {
  constructor(readonly gaps: string[]) {
    super(`Executor is not eligible to claim work: ${gaps.join(", ")}`);
  }
}

/** Authenticated client for the dispatcher's executor endpoints. */
export class DispatcherClient {
  constructor(
    private readonly baseUrl: string,
    private readonly executorKey: string,
  ) {}

  async claim(capabilities: ExecutorCapabilities): Promise<ClaimResponse | undefined> {
    const response = await this.#post("/internal/executor/claim", capabilities);
    if (response.status === 204) {
      return undefined;
    }
    if (response.status === 403) {
      const body = (await response.json()) as { error?: { details?: { gaps?: string[] } } };
      throw new NotEligibleError(body.error?.details?.gaps ?? []);
    }
    if (!response.ok) {
      throw new Error(`claim failed with ${response.status}`);
    }
    return (await response.json()) as ClaimResponse;
  }

  async heartbeat(attemptId: string, leaseToken: string): Promise<{ cancelRequested: boolean; deadline: string }> {
    const response = await this.#post(`/internal/attempts/${attemptId}/heartbeat`, { leaseToken });
    if (response.status === 409) {
      throw new LeaseLostError("lease lost");
    }
    if (!response.ok) {
      throw new Error(`heartbeat failed with ${response.status}`);
    }
    return (await response.json()) as { cancelRequested: boolean; deadline: string };
  }

  async provenance(
    attemptId: string,
    leaseToken: string,
    provenance: { runner: RunnerHello["runner"]; capabilities: string[]; profile: string; imageDigest?: string },
  ): Promise<void> {
    const response = await this.#post(`/internal/attempts/${attemptId}/provenance`, { leaseToken, provenance });
    if (response.status === 409) {
      throw new LeaseLostError("lease lost");
    }
  }

  async events(attemptId: string, leaseToken: string, events: RunnerEventBody[]): Promise<void> {
    const response = await this.#post(`/internal/attempts/${attemptId}/events`, { leaseToken, events });
    if (response.status === 409) {
      throw new LeaseLostError("lease lost");
    }
  }

  async complete(attemptId: string, leaseToken: string, outcome: Outcome): Promise<string | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await this.#post(`/internal/attempts/${attemptId}/complete`, { leaseToken, outcome });
        if (response.status === 409) {
          return undefined;
        }
        if (response.ok) {
          return ((await response.json()) as { state: string }).state;
        }
      } catch {
        // retried below; completion is fenced, so retries are safe
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw new Error("completion could not be delivered");
  }

  async createInputRequest(
    attemptId: string,
    leaseToken: string,
    runnerRequestId: string,
    request: InputRequestBody,
    signal?: AbortSignal,
  ): Promise<{ id: string; expiresAt: string }> {
    const response = await this.#post(
      `/internal/attempts/${attemptId}/input-requests`,
      { leaseToken, runnerRequestId, request },
      signal,
    );
    if (response.status === 409) {
      throw new LeaseLostError("lease lost");
    }
    if (!response.ok) {
      throw new InputRequestError(`input request failed with ${response.status}`, response.status);
    }
    return (await response.json()) as { id: string; expiresAt: string };
  }

  async pollInputRequest(
    attemptId: string,
    leaseToken: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<{ state: InputRequestState; response?: InputResponseBody } | undefined> {
    const response = await this.#post(
      `/internal/attempts/${attemptId}/input-requests/${requestId}/poll`,
      { leaseToken },
      signal,
    );
    if (response.status === 409) {
      throw new LeaseLostError("lease lost");
    }
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new InputRequestError(`input request poll failed with ${response.status}`, response.status);
    }
    return (await response.json()) as { state: InputRequestState; response?: InputResponseBody };
  }

  #post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(15_000);
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-key": this.executorKey },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
}
