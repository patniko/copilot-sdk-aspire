// Agent job console. Talks only to this origin's /v1 API with the caller's API key.
// The key is held in memory, or in sessionStorage when "Keep for this tab" is checked.
// All server data is rendered with textContent; nothing is interpreted as HTML.

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "needs_review"]);
const KEY_STORAGE = "agent-console-api-key";

const $ = (id) => document.getElementById(id);
const state = {
  apiKey: "",
  harnesses: [],
  jobs: [],
  nextCursor: undefined,
  selectedId: undefined,
  stream: undefined,
};

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body, headers = {}, signal } = {}) {
  const response = await fetch(path, {
    method,
    signal,
    headers: {
      authorization: `Bearer ${state.apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!response.ok) {
    throw new ApiError(response.status, parsed);
  }
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

function badge(jobState) {
  return el("span", { class: `badge state-${jobState}`, text: jobState.replaceAll("_", " ") });
}

function show(node, visible) {
  node.hidden = !visible;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString();
}

function describeError(error) {
  if (error instanceof ApiError) {
    const details = error.body?.error?.details;
    const lines = [`${error.status} ${error.body?.error?.code ?? ""}`.trim(), error.message];
    if (details?.issues) lines.push(...details.issues.map((i) => `• ${i.path || "(root)"}: ${i.message}`));
    if (details?.errors) lines.push(...details.errors.map((e) => `• ${e.path || "(root)"}: ${e.message}`));
    if (details?.missingBindings) lines.push(`• missing tool bindings: ${details.missingBindings.join(", ")}`);
    return lines.join("\n");
  }
  return error?.message ?? String(error);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function connect(event) {
  event?.preventDefault();
  const key = $("api-key").value.trim();
  if (!key) {
    $("auth-status").textContent = "Enter an API key.";
    return;
  }
  state.apiKey = key;
  $("auth-status").textContent = "Connecting…";
  try {
    const { harnesses } = await api("/v1/harnesses");
    state.harnesses = harnesses;
    if ($("remember").checked) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
    $("auth-status").textContent = `Connected · ${harnesses.length} harness${harnesses.length === 1 ? "" : "es"}`;
    show($("main"), true);
    renderHarnesses();
    await loadJobs(true);
  } catch (error) {
    state.apiKey = "";
    show($("main"), false);
    $("auth-status").textContent = error instanceof ApiError && error.status === 401 ? "Invalid API key." : describeError(error);
  }
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

function selectedHarness() {
  return state.harnesses.find((h) => h.name === $("harness").value);
}

function selectedVersion() {
  return selectedHarness()?.versions.find((v) => v.version === $("version").value);
}

function renderHarnesses() {
  const select = $("harness");
  select.replaceChildren(...state.harnesses.map((h) => el("option", { value: h.name, text: h.name })));
  renderVersions();
}

function renderVersions() {
  const harness = selectedHarness();
  $("harness-description").textContent = harness?.description ?? "";
  $("version").replaceChildren(
    ...(harness?.versions ?? []).map((v, i) => el("option", { value: v.version, text: i === 0 ? `${v.version} (latest)` : v.version })),
  );
  renderProfiles();
}

function renderProfiles() {
  const version = selectedVersion();
  $("profile").replaceChildren(
    ...(version?.profiles ?? []).map((p) =>
      el("option", { value: p, text: p === version.defaultProfile ? `${p} (default)` : p }),
    ),
  );
  if (version) $("profile").value = version.defaultProfile;
  resetInput();
  show($("schema-view"), false);
}

function resetInput() {
  const schema = selectedVersion()?.inputSchema;
  $("input").value = schema ? JSON.stringify(sampleFor(schema), null, 2) : "{}";
}

/** Builds a starting value from a JSON Schema: examples, then defaults, then a typed skeleton. */
function sampleFor(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 8) return null;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ("default" in schema) return schema.default;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "object": {
      const result = {};
      const required = new Set(schema.required ?? Object.keys(schema.properties ?? {}));
      for (const [name, property] of Object.entries(schema.properties ?? {})) {
        if (required.has(name)) result[name] = sampleFor(property, depth + 1);
      }
      return result;
    }
    case "array":
      return schema.items ? [sampleFor(schema.items, depth + 1)] : [];
    case "string":
      return "";
    case "integer":
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    default:
      return null;
  }
}

async function submitJob(event) {
  event.preventDefault();
  const errorBox = $("submit-error");
  show(errorBox, false);
  let input;
  try {
    input = JSON.parse($("input").value);
  } catch (error) {
    errorBox.textContent = `Input is not valid JSON: ${error.message}`;
    show(errorBox, true);
    return;
  }
  const version = selectedVersion();
  const body = {
    harness: { name: $("harness").value, version: version?.version },
    profile: $("profile").value,
    input,
  };
  const deadline = Number.parseInt($("deadline").value, 10);
  if (Number.isFinite(deadline)) body.deadlineSeconds = deadline;
  const idempotencyKey = $("idempotency").value.trim();
  try {
    const job = await api("/v1/jobs", {
      method: "POST",
      body,
      headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : {},
    });
    await loadJobs(true);
    await selectJob(job.id);
  } catch (error) {
    errorBox.textContent = describeError(error);
    show(errorBox, true);
  }
}

function toggleSchema() {
  const view = $("schema-view");
  if (view.hidden) {
    view.textContent = JSON.stringify(selectedVersion()?.outputSchema ?? {}, null, 2);
  }
  show(view, view.hidden);
}

// ---------------------------------------------------------------------------
// Job list
// ---------------------------------------------------------------------------

async function loadJobs(reset) {
  const query = new URLSearchParams({ limit: "25" });
  if (!reset && state.nextCursor) query.set("before", state.nextCursor);
  try {
    const page = await api(`/v1/jobs?${query}`);
    state.jobs = reset ? page.jobs : [...state.jobs, ...page.jobs];
    state.nextCursor = page.next;
    renderJobs();
  } catch (error) {
    $("jobs").replaceChildren(el("li", { class: "error", text: describeError(error) }));
  }
}

function renderJobs() {
  const list = $("jobs");
  if (state.jobs.length === 0) {
    list.replaceChildren(el("li", { class: "muted", text: "No jobs yet." }));
  } else {
    list.replaceChildren(
      ...state.jobs.map((job) =>
        el(
          "li",
          { "aria-selected": String(job.id === state.selectedId), onclick: () => selectJob(job.id) },
          el("div", { class: "meta" }, el("strong", { text: job.harness.name }), badge(job.state)),
          el("div", { class: "meta small muted" }, el("span", { text: job.profile }), el("span", { text: formatDateTime(job.createdAt) })),
          el("div", { class: "id", text: job.id }),
        ),
      ),
    );
  }
  show($("more-jobs"), Boolean(state.nextCursor));
}

function upsertJob(job) {
  const index = state.jobs.findIndex((j) => j.id === job.id);
  const summary = { ...job };
  delete summary.result;
  if (index >= 0) state.jobs[index] = summary;
  else state.jobs.unshift(summary);
  renderJobs();
}

// ---------------------------------------------------------------------------
// Job detail and live events
// ---------------------------------------------------------------------------

async function selectJob(id) {
  state.stream?.abort();
  state.selectedId = id;
  renderJobs();
  show($("detail-empty"), false);
  show($("detail"), true);
  $("events").replaceChildren();
  await refreshJob();
  streamEvents(id);
}

async function refreshJob() {
  const id = state.selectedId;
  if (!id) return;
  try {
    const job = await api(`/v1/jobs/${id}`);
    if (id !== state.selectedId) return;
    renderJob(job);
    upsertJob(job);
  } catch (error) {
    $("summary").replaceChildren(el("dd", { class: "error", text: describeError(error) }));
  }
}

function renderJob(job) {
  const rows = [
    ["State", badge(job.state)],
    ["Job", job.id],
    ["Harness", `${job.harness.name} ${job.harness.version}`],
    ["Digest", job.harness.digest],
    ["Profile", job.profile],
    ["Attempts", `${job.attempts} of ${job.maxAttempts}`],
    ["Deadline", `${job.maxDurationSeconds}s per attempt`],
    ["Tokens", `${job.usage.inputTokens} in · ${job.usage.outputTokens} out · ${job.usage.requests} requests`],
    ["Created", formatDateTime(job.createdAt)],
    ["Updated", formatDateTime(job.updatedAt)],
  ];
  $("summary").replaceChildren(...rows.flatMap(([term, value]) => [el("dt", { text: term }), el("dd", {}, value)]));

  const gaps = $("gaps");
  gaps.textContent = job.acknowledgedGaps.length
    ? `Ran with acknowledged security gaps: ${job.acknowledgedGaps.join(", ")}`
    : "";
  show(gaps, job.acknowledgedGaps.length > 0);

  const errorBox = $("error-box");
  errorBox.textContent = job.error ? `${job.error.code}: ${job.error.message}` : "";
  show(errorBox, Boolean(job.error));

  $("cancel-job").disabled = TERMINAL.has(job.state) || job.state === "cancel_requested";
  $("retry-job").disabled = !(job.state === "failed" || job.state === "needs_review");

  const result = $("result");
  if (job.state === "succeeded") {
    const schema = state.harnesses
      .find((h) => h.name === job.harness.name)
      ?.versions.find((v) => v.version === job.harness.version)?.outputSchema;
    result.replaceChildren(
      renderValue(job.result, schema),
      el("details", {}, el("summary", { text: "Raw JSON" }), el("pre", { class: "code", text: JSON.stringify(job.result, null, 2) })),
    );
  } else {
    result.replaceChildren(el("p", { class: "muted", text: TERMINAL.has(job.state) ? "No result." : "Waiting for result…" }));
  }
}

/** Orders keys as declared in the schema's properties, followed by any undeclared keys. */
function orderedKeys(keys, schema) {
  const declared = Object.keys(schema?.properties ?? {});
  return [...declared.filter((k) => keys.includes(k)), ...keys.filter((k) => !declared.includes(k))];
}

/** Renders a JSON result readably: strings as text, arrays of flat objects as tables, in schema order. */
function renderValue(value, schema, depth = 0) {
  if (value === null || value === undefined) return el("span", { class: "muted", text: "—" });
  if (typeof value !== "object") return el("p", { class: "text", text: String(value) });
  if (Array.isArray(value)) {
    if (value.length === 0) return el("span", { class: "muted", text: "(empty)" });
    if (value.every((v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== "object"))) {
      const columns = orderedKeys([...new Set(value.flatMap((v) => Object.keys(v)))], schema?.items);
      return el(
        "table",
        {},
        el("thead", {}, el("tr", {}, columns.map((c) => el("th", { text: c })))),
        el("tbody", {}, value.map((row) => el("tr", {}, columns.map((c) => el("td", { text: formatCell(row[c]) }))))),
      );
    }
    return el("ul", {}, value.map((v) => el("li", {}, typeof v === "object" ? renderValue(v, schema?.items, depth + 1) : String(v))));
  }
  if (depth > 3) return el("pre", { class: "code", text: JSON.stringify(value, null, 2) });
  return el(
    "div",
    {},
    orderedKeys(Object.keys(value), schema).map((key) =>
      el("div", { class: "field" }, el("strong", { text: key }), renderValue(value[key], schema?.properties?.[key], depth + 1)),
    ),
  );
}

function formatCell(value) {
  if (typeof value === "number" && !Number.isInteger(value)) return value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return value === null || value === undefined ? "—" : String(value);
}

function describeEvent(body) {
  switch (body.type) {
    case "job.attempt_started":
      return `Attempt ${body.attempt} started on ${body.profile}${body.acknowledgedGaps.length ? ` (gaps: ${body.acknowledgedGaps.join(", ")})` : ""}`;
    case "job.runner_event": {
      const e = body.event;
      switch (e.kind) {
        case "tool.started":
          return `Tool ${e.tool} started`;
        case "tool.completed":
          return `Tool ${e.tool} ${e.ok ? "completed" : "failed"}`;
        case "agent.turn_started":
          return "Agent turn started";
        case "agent.turn_completed":
          return "Agent turn completed";
        default:
          return e.message ?? e.kind;
      }
    }
    case "job.retry_scheduled":
      return `Retry scheduled after attempt ${body.attempt} (${body.reason}) at ${formatTime(body.notBefore)}`;
    case "job.failed":
      return `Failed: ${body.code} — ${body.message}`;
    case "job.needs_review":
      return `Needs review: ${body.reason}`;
    default:
      return body.type.replace("job.", "").replaceAll("_", " ");
  }
}

function appendEvent(event) {
  const list = $("events");
  list.append(el("li", {}, el("time", { text: formatTime(event.at) }), el("span", { text: describeEvent(event.body) })));
  list.scrollTop = list.scrollHeight;
}

/** Follows the job's server-sent events, reconnecting from the last cursor until the job is terminal. */
async function streamEvents(id) {
  const controller = new AbortController();
  state.stream = controller;
  let cursor = 0;
  let terminal = false;
  const status = $("stream-status");

  while (!controller.signal.aborted && !terminal) {
    status.textContent = "· live";
    try {
      const response = await fetch(`/v1/jobs/${id}/events`, {
        headers: { authorization: `Bearer ${state.apiKey}`, accept: "text/event-stream", "last-event-id": String(cursor) },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new ApiError(response.status, safeJson(await response.text()));
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const event = safeJson(data);
          if (!event || event.seq <= cursor) continue;
          cursor = event.seq;
          appendEvent(event);
          if (["job.succeeded", "job.failed", "job.cancelled", "job.needs_review", "job.retry_scheduled", "job.attempt_started", "job.cancel_requested"].includes(event.body.type)) {
            await refreshJob();
          }
        }
      }
      const job = await api(`/v1/jobs/${id}`);
      terminal = TERMINAL.has(job.state);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status < 500) {
        status.textContent = `· ${describeError(error)}`;
        return;
      }
      status.textContent = "· reconnecting…";
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!controller.signal.aborted) {
    status.textContent = "· complete";
    await refreshJob();
  }
}

async function jobAction(action) {
  const id = state.selectedId;
  if (!id) return;
  try {
    const job = await api(`/v1/jobs/${id}:${action}`, { method: "POST" });
    renderJob(job);
    upsertJob(job);
    if (action === "retry") {
      $("events").replaceChildren();
      streamEvents(id);
    }
  } catch (error) {
    $("error-box").textContent = describeError(error);
    show($("error-box"), true);
  }
}

// ---------------------------------------------------------------------------

$("auth").addEventListener("submit", connect);
$("harness").addEventListener("change", renderVersions);
$("version").addEventListener("change", renderProfiles);
$("submit-form").addEventListener("submit", submitJob);
$("reset-input").addEventListener("click", resetInput);
$("show-schema").addEventListener("click", toggleSchema);
$("refresh-jobs").addEventListener("click", () => loadJobs(true));
$("more-jobs").addEventListener("click", () => loadJobs(false));
$("cancel-job").addEventListener("click", () => jobAction("cancel"));
$("retry-job").addEventListener("click", () => {
  state.stream?.abort();
  jobAction("retry");
});

const remembered = sessionStorage.getItem(KEY_STORAGE);
if (remembered) {
  $("api-key").value = remembered;
  $("remember").checked = true;
  connect();
}
