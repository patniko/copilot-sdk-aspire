// Client for the local companion server. The session token arrives once in the URL (?t=) and is kept in
// sessionStorage for this tab only.

const TOKEN_KEY = "configurator-token";

function readToken(): string {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("t");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    params.delete("t");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? "";
}

const token = readToken();

export function hasToken(): boolean {
  return token.length > 0;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    headers: {
      "x-configurator-token": token,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const error = body as { error?: unknown; issues?: Array<{ path: string; message: string }> } | undefined;
    const message =
      typeof error?.error === "string"
        ? error.error
        : typeof (error?.error as { message?: unknown })?.message === "string"
          ? String((error!.error as { message: string }).message)
          : `Request failed (${response.status})`;
    throw new ApiError(response.status, message, error?.issues ?? [], body);
  }
  return body as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.issues.length
      ? `${error.message} ${error.issues.map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ")}`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
