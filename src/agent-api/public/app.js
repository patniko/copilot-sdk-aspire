// Agent sessions portal. Talks only to this origin's /v1 API with the caller's API key.
// The key is held in memory, or in sessionStorage when "Keep for this tab" is checked.
// All server and agent data is rendered with textContent; nothing is interpreted as HTML.

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "needs_review"]);
const ACTIVE = new Set(["queued", "running", "retry_wait", "cancel_requested"]);
const KEY_STORAGE = "agent-console-api-key";
const INBOX_POLL_MS = 3000;

const $ = (id) => document.getElementById(id);
const state = {
  apiKey: "",
  harnesses: [],
  jobs: [],
  nextCursor: undefined,
  selectedId: undefined,
  selectedJob: undefined,
  detailRequests: [],
  inboxRequests: [],
  inboxLoaded: false,
  requestNotices: new Map(),
  filter: "all",
  currentView: "sessions",
  stream: undefined,
  inboxTimer: undefined,
  countdownTimer: undefined,
  lastPendingCount: undefined,
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
      "x-api-key": state.apiKey,
      authorization: `Bearer ${state.apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!response.ok) throw new ApiError(response.status, parsed);
  return parsed;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describeError(error) {
  if (error instanceof ApiError) {
    const details = error.body?.error?.details;
    const lines = [`${error.status} ${error.body?.error?.code ?? ""}`.trim(), error.message];
    if (details?.issues) lines.push(...details.issues.map((i) => `• ${i.path || "(root)"}: ${i.message}`));
    if (details?.errors) lines.push(...details.errors.map((e) => `• ${e.path || "(root)"}: ${e.message}`));
    if (details?.missingBindings) lines.push(`• missing tool bindings: ${details.missingBindings.join(", ")}`);
    return lines.filter(Boolean).join("\n");
  }
  return error?.message ?? String(error);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

function show(node, visible) {
  if (node) node.hidden = !visible;
}

function stateBadge(value, label = value) {
  return el("span", { class: `badge state-${value}`, text: String(label).replaceAll("_", " ") });
}

function needsBadge(count) {
  return el("span", { class: "badge needs-badge", text: `Needs you ${count}` });
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDateTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
function relativeTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return relativeFormatter.format(seconds, "second");
  if (abs < 2700) return relativeFormatter.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return relativeFormatter.format(Math.round(seconds / 3600), "hour");
  return relativeFormatter.format(Math.round(seconds / 86400), "day");
}

function formatTokens(usage = {}) {
  return `${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out · ${usage.requests ?? 0} requests`;
}

function announce(message) {
  $("live-region").textContent = message;
}

// ---------------------------------------------------------------------------
// Authentication and routing
// ---------------------------------------------------------------------------

async function connect(event) {
  event?.preventDefault();
  const key = $("api-key").value.trim();
  if (!key) {
    $("auth-status").textContent = "Enter an API key.";
    show($("auth-panel"), true);
    return;
  }
  state.apiKey = key;
  $("auth-status").textContent = "Connecting…";
  try {
    const { harnesses } = await api("/v1/harnesses");
    state.harnesses = harnesses ?? [];
    if ($("remember").checked) sessionStorage.setItem(KEY_STORAGE, key);
    else sessionStorage.removeItem(KEY_STORAGE);
    $("auth-status").textContent = `Connected · ${state.harnesses.length} harness${state.harnesses.length === 1 ? "" : "es"}`;
    show($("auth-panel"), false);
    show($("main"), true);
    renderHarnesses();
    startInboxPolling();
    await Promise.all([loadJobs(true), refreshInbox(false)]);
    routeFromHash();
    if (!location.hash && !state.selectedId && state.jobs.length > 0) await selectJob(state.jobs[0].id, { updateHash: true });
  } catch (error) {
    state.apiKey = "";
    show($("main"), false);
    show($("auth-panel"), true);
    $("auth-status").textContent = error instanceof ApiError && error.status === 401 ? "Invalid API key." : describeError(error);
  }
}

function setHash(hash) {
  if (location.hash !== hash) history.replaceState(null, "", hash || `${location.pathname}${location.search}`);
}

function routeFromHash() {
  if (!state.apiKey) return;
  const raw = location.hash.slice(1);
  if (raw === "inbox") {
    showView("inbox", { updateHash: false });
    return;
  }
  const params = new URLSearchParams(raw);
  const id = params.get("session") ?? params.get("job");
  showView("sessions", { updateHash: false });
  if (id && id !== state.selectedId) selectJob(id, { updateHash: false });
}

function showView(view, { updateHash = true } = {}) {
  const changed = state.currentView !== view;
  state.currentView = view;
  show($("sessions-view"), view === "sessions");
  show($("inbox-view"), view === "inbox");
  $("nav-sessions").classList.toggle("active", view === "sessions");
  $("nav-inbox").classList.toggle("active", view === "inbox");
  if (updateHash) setHash(view === "inbox" ? "#inbox" : state.selectedId ? `#session=${encodeURIComponent(state.selectedId)}` : "");
  if (changed) window.scrollTo(0, 0);
  if (view === "inbox") refreshInbox(false);
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
  if (version?.defaultProfile) $("profile").value = version.defaultProfile;
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
    show($("submit-panel"), false);
    await loadJobs(true);
    await selectJob(job.id);
  } catch (error) {
    errorBox.textContent = describeError(error);
    show(errorBox, true);
  }
}

function toggleSchema() {
  const view = $("schema-view");
  if (view.hidden) view.textContent = JSON.stringify(selectedVersion()?.outputSchema ?? {}, null, 2);
  show(view, view.hidden);
}

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

async function loadJobs(reset) {
  const query = new URLSearchParams({ limit: "25" });
  if (!reset && state.nextCursor) query.set("before", state.nextCursor);
  try {
    const page = await api(`/v1/jobs?${query}`);
    state.jobs = reset ? page.jobs ?? [] : [...state.jobs, ...(page.jobs ?? [])];
    state.nextCursor = page.next;
    mergePendingCountsFromInbox();
    renderJobs();
  } catch (error) {
    $("jobs").replaceChildren(el("li", { class: "flash error", text: describeError(error) }));
  }
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".filter-tab").forEach((button) => button.classList.toggle("active", button.dataset.filter === filter));
  renderJobs();
}

function filteredJobs() {
  switch (state.filter) {
    case "active":
      return state.jobs.filter((job) => ACTIVE.has(job.state));
    case "needs":
      return state.jobs.filter((job) => (job.pendingInputs ?? 0) > 0);
    case "finished":
      return state.jobs.filter((job) => TERMINAL.has(job.state));
    default:
      return state.jobs;
  }
}

function renderJobs() {
  const list = $("jobs");
  const jobs = filteredJobs();
  if (jobs.length === 0) {
    list.replaceChildren(el("li", { class: "muted", text: state.jobs.length === 0 ? "No sessions yet." : "No sessions match this filter." }));
  } else {
    list.replaceChildren(
      ...jobs.map((job) =>
        el(
          "li",
          {},
          el(
            "button",
            {
              type: "button",
              class: "session-item",
              "aria-selected": String(job.id === state.selectedId),
              onclick: () => selectJob(job.id),
            },
            el("div", { class: "session-title" }, el("strong", { text: `${job.harness.name}@${job.harness.version}` }), stateBadge(job.state)),
            el(
              "div",
              { class: "session-meta small muted" },
              el("span", { class: "truncate", text: job.profile ?? "default" }),
              el("span", { text: relativeTime(job.createdAt) }),
            ),
            el(
              "div",
              { class: "session-footer" },
              el("span", { class: "session-id", text: job.id }),
              (job.pendingInputs ?? 0) > 0 ? needsBadge(job.pendingInputs) : undefined,
            ),
          ),
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
  if (job.id === state.selectedId) state.selectedJob = job;
  renderJobs();
}

function mergePendingCountsFromInbox() {
  if (!state.inboxLoaded) return;
  const counts = new Map();
  for (const request of state.inboxRequests) counts.set(request.jobId, (counts.get(request.jobId) ?? 0) + 1);
  state.jobs = state.jobs.map((job) => ({ ...job, pendingInputs: counts.get(job.id) ?? 0 }));
}

// ---------------------------------------------------------------------------
// Session detail, requests, and live events
// ---------------------------------------------------------------------------

async function selectJob(id, { updateHash = true } = {}) {
  state.stream?.abort();
  state.selectedId = id;
  showView("sessions", { updateHash: false });
  if (updateHash) setHash(`#session=${encodeURIComponent(id)}`);
  renderJobs();
  show($("detail-empty"), false);
  show($("detail"), true);
  $("events").replaceChildren();
  $("stream-status").textContent = "";
  await Promise.all([refreshJob(), refreshDetailRequests()]);
  streamEvents(id);
}

async function refreshJob() {
  const id = state.selectedId;
  if (!id) return;
  try {
    const job = await api(`/v1/jobs/${encodeURIComponent(id)}`);
    if (id !== state.selectedId) return;
    renderJob(job);
    upsertJob(job);
  } catch (error) {
    $("summary").replaceChildren(el("div", {}, el("dt", { text: "Error" }), el("dd", { class: "flash error", text: describeError(error) })));
  }
}

function renderJob(job) {
  $("detail-title").textContent = `${job.harness.name}@${job.harness.version}`;
  $("detail-subtitle").textContent = `${job.profile ?? "default"} · ${job.id}`;
  const rows = [
    ["State", stateBadge(job.state)],
    ["Profile / runner", job.profile ?? "default"],
    ["Attempt", `${job.attempts ?? 0} of ${job.maxAttempts ?? 0}`],
    ["Tokens", formatTokens(job.usage)],
    ["Created", `${formatDateTime(job.createdAt)} (${relativeTime(job.createdAt)})`],
    ["Updated", formatDateTime(job.updatedAt)],
    ["Deadline", `${job.maxDurationSeconds ?? "—"}s per attempt`],
    ["Pending inputs", String(job.pendingInputs ?? 0)],
    ["Digest", job.harness.digest ?? "—"],
    ["Session id", job.id],
  ];
  $("summary").replaceChildren(
    ...rows.map(([term, value]) => el("div", {}, el("dt", { text: term }), el("dd", {}, value))),
  );

  const gaps = $("gaps");
  const acknowledgedGaps = job.acknowledgedGaps ?? [];
  gaps.textContent = acknowledgedGaps.length ? `Ran with acknowledged security gaps: ${acknowledgedGaps.join(", ")}` : "";
  show(gaps, acknowledgedGaps.length > 0);

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

async function refreshDetailRequests() {
  const id = state.selectedId;
  if (!id) return;
  try {
    const { requests } = await api(`/v1/jobs/${encodeURIComponent(id)}/input-requests`);
    if (id !== state.selectedId) return;
    state.detailRequests = requests ?? [];
    renderDetailRequests();
  } catch (error) {
    state.detailRequests = [];
    $("detail-requests").replaceChildren(el("div", { class: "flash error", text: describeError(error) }));
    show($("detail-requests-section"), true);
  }
}

function renderDetailRequests() {
  const sorted = [...state.detailRequests].sort(compareRequestsForDisplay);
  const pending = sorted.filter((request) => request.state === "pending").length;
  $("detail-requests-count").textContent = String(pending);
  $("detail-requests-count").classList.toggle("zero", pending === 0);
  $("detail-requests-title").textContent = pending > 0 ? "Needs you" : "Requests";
  show($("detail-requests-section"), sorted.length > 0);
  $("detail-requests").replaceChildren(
    ...sorted.map((request) => (request.state === "pending" ? renderRequestCard(request, { inbox: false }) : renderResolvedRequest(request))),
  );
}

/** One line for an answered, expired or cancelled request; expands to the full card. */
function renderResolvedRequest(view) {
  const response = view.response;
  const outcome =
    response?.kind === "permission"
      ? response.approved
        ? response.scope === "kind"
          ? "Approved similar requests for the rest of the run"
          : "Approved"
        : "Denied"
      : response?.kind === "question"
        ? `Answered: ${response.answer}`
        : view.state === "expired"
          ? "Expired"
          : "Cancelled";
  const prompt = view.request?.permission ?? {};
  const target = view.request?.kind === "question" ? view.request.question : (prompt.command ?? prompt.path ?? prompt.url ?? prompt.tool ?? "");
  const details = el("details", { class: "resolved-request" });
  details.append(
    el(
      "summary",
      {},
      el("span", { class: `resolved-outcome ${response?.kind === "permission" && !response.approved ? "denied" : view.state === "answered" ? "ok" : ""}`, text: outcome }),
      el("span", { class: "resolved-title", text: requestTitle(view.request) }),
      el("code", { class: "resolved-target", text: target }),
      el("span", { class: "muted small", text: relativeTime(view.resolvedAt ?? view.createdAt) }),
    ),
    renderRequestCard(view, { inbox: false }),
  );
  return details;
}

function compareRequestsForDisplay(a, b) {
  if (a.state === "pending" && b.state !== "pending") return -1;
  if (a.state !== "pending" && b.state === "pending") return 1;
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

async function refreshInbox(showErrors = true) {
  if (!state.apiKey) return;
  try {
    const { requests } = await api("/v1/input-requests?state=pending&limit=100");
    state.inboxRequests = requests ?? [];
    state.inboxLoaded = true;
    mergePendingCountsFromInbox();
    renderJobs();
    renderInbox();
    updatePendingTotal(state.inboxRequests.length);
  } catch (error) {
    if (showErrors) $("inbox-list").replaceChildren(el("div", { class: "flash error", text: describeError(error) }));
  }
}

function renderInbox() {
  const list = $("inbox-list");
  $("inbox-count").textContent = String(state.inboxRequests.length);
  if (state.inboxRequests.length === 0) {
    list.replaceChildren(el("div", { class: "empty muted", text: "No pending approvals or questions." }));
    return;
  }
  list.replaceChildren(...state.inboxRequests.map((request) => renderRequestCard(request, { inbox: true })));
}

function updatePendingTotal(count) {
  $("nav-pending-count").textContent = String(count);
  show($("nav-pending-count"), count > 0);
  document.title = count > 0 ? `(${count}) Agent sessions` : "Agent sessions · GitHub Copilot SDK";
  if (state.lastPendingCount !== undefined && count > state.lastPendingCount) {
    announce(`${count} pending request${count === 1 ? "" : "s"} need your attention.`);
  }
  state.lastPendingCount = count;
}

function startInboxPolling() {
  if (state.inboxTimer) clearInterval(state.inboxTimer);
  state.inboxTimer = setInterval(() => {
    if (!document.hidden) refreshInbox(false);
  }, INBOX_POLL_MS);
  if (!state.countdownTimer) state.countdownTimer = setInterval(updateCountdowns, 1000);
}

const permissionTitles = {
  shell: "Run a shell command",
  write: "Write a file",
  read: "Read a file",
  url: "Fetch a URL",
  mcp: "Use a tool",
  other: "Approve an action",
};

function renderRequestCard(view, { inbox }) {
  const isPending = view.state === "pending";
  const card = el("article", { class: `request-card ${isPending ? "pending" : ""}` });
  const title = requestTitle(view.request);
  const headerMeta = [
    `${view.harness?.name ?? "harness"}@${view.harness?.version ?? "version"}`,
    `attempt ${view.attempt}`,
    `created ${relativeTime(view.createdAt)}`,
  ];
  const sessionLink = inbox
    ? el("button", { type: "button", class: "session-link", onclick: () => openRequestSession(view.jobId), text: `Session ${shortId(view.jobId)}` })
    : el("span", { text: `Session ${shortId(view.jobId)}` });
  card.append(
    el(
      "div",
      { class: "request-card-header" },
      el("div", {}, el("h4", { text: title }), el("p", { class: "muted small" }, sessionLink, document.createTextNode(` · ${headerMeta.join(" · ")}`))),
      el(
        "div",
        { class: "actions compact" },
        isPending ? el("span", { class: "expiry", "data-expires": view.expiresAt, text: expiryText(view.expiresAt) }) : undefined,
        stateBadge(view.state),
      ),
    ),
  );
  const body = el("div", { class: "request-card-body" });
  if (view.request?.kind === "permission") renderPermissionBody(body, view);
  else if (view.request?.kind === "question") renderQuestionBody(body, view);
  else body.append(el("p", { class: "muted", text: "Unsupported request." }));
  const notice = state.requestNotices.get(view.id);
  if (notice) body.append(el("div", { class: "flash warning", text: notice }));
  card.append(body);
  return card;
}

function requestTitle(request) {
  if (request?.kind === "question") return "Question for you";
  const type = request?.permission?.type ?? "other";
  return permissionTitles[type] ?? permissionTitles.other;
}

function renderPermissionBody(body, view) {
  const prompt = view.request.permission ?? {};
  if (prompt.intention) body.append(fieldBlock("Intention", prompt.intention));
  const target = prompt.command ?? prompt.path ?? prompt.url ?? prompt.tool;
  if (target) body.append(fieldBlock(targetLabel(prompt), target, true));
  if (prompt.diff) body.append(renderDiff(prompt.diff));
  if (prompt.warning) body.append(el("div", { class: "flash warning", text: prompt.warning }));
  if (view.state === "pending") {
    const status = el("div", { class: "request-status muted", role: "status" });
    const feedback = el("textarea", { rows: "3", placeholder: "Optional feedback when denying", "aria-label": "Feedback for the agent when denying" });
    body.append(
      el(
        "div",
        { class: "request-actions" },
        el("button", { type: "button", class: "primary", onclick: () => respondToRequest(view, { kind: "permission", approved: true }, status), text: "Approve" }),
        ...(similarApprovalLabel(prompt)
          ? [
              el("button", {
                type: "button",
                onclick: () => respondToRequest(view, { kind: "permission", approved: true, scope: "kind" }, status),
                text: similarApprovalLabel(prompt),
              }),
            ]
          : []),
        el("button", {
          type: "button",
          class: "danger",
          onclick: () => {
            const text = feedback.value.trim();
            respondToRequest(view, { kind: "permission", approved: false, ...(text ? { feedback: text } : {}) }, status);
          },
          text: "Deny",
        }),
      ),
      el("div", { class: "feedback-box" }, feedback),
      status,
    );
  } else {
    body.append(renderResponseSummary(view));
  }
}

function renderQuestionBody(body, view) {
  const request = view.request;
  body.append(el("p", { text: request.question }));
  if (view.state === "pending") {
    const status = el("div", { class: "request-status muted", role: "status" });
    const controls = [];
    if (Array.isArray(request.choices) && request.choices.length > 0) {
      controls.push(
        el(
          "div",
          { class: "choice-list", role: "group", "aria-label": "Answer choices" },
          request.choices.map((choice) =>
            el("button", { type: "button", onclick: () => respondToRequest(view, { kind: "question", answer: choice }, status), text: choice }),
          ),
        ),
      );
    }
    if (request.allowFreeform) {
      const answer = el("textarea", { rows: "3", placeholder: "Type an answer", "aria-label": "Answer" });
      controls.push(
        el(
          "div",
          { class: "feedback-box" },
          answer,
          el("div", { class: "actions compact" },
            el("button", {
              type: "button",
              class: "primary",
              onclick: () => {
                const text = answer.value.trim();
                if (!text) {
                  status.textContent = "Enter an answer first.";
                  return;
                }
                respondToRequest(view, { kind: "question", answer: text }, status);
              },
              text: "Send",
            }),
          ),
        ),
      );
    }
    if (controls.length === 0) controls.push(el("p", { class: "muted", text: "No answer options are available." }));
    body.append(...controls, status);
  } else {
    body.append(renderResponseSummary(view));
  }
}

function fieldBlock(label, value, mono = false) {
  return el("div", {}, el("strong", { class: "small muted", text: label }), mono ? el("pre", { class: "mono-block", text: value }) : el("p", { text: value }));
}

function targetLabel(prompt) {
  if (prompt.command) return "Command";
  if (prompt.path) return prompt.type === "read" ? "Path to read" : "Path to write";
  if (prompt.url) return "URL";
  if (prompt.tool) return "Tool";
  return "Target";
}

/** What approving "for this run" covers, matching the runner's similar-request scope; undefined when it covers nothing. */
function similarApprovalLabel(prompt) {
  switch (prompt.type) {
    case "shell":
      return prompt.commandNames?.length ? `Approve ${prompt.commandNames.join(", ")} for this run` : undefined;
    case "write":
      return "Approve all file changes for this run";
    case "read":
      return prompt.path ? "Approve reads in this folder for this run" : undefined;
    case "url": {
      let host;
      try {
        host = new URL(prompt.url).hostname;
      } catch {
        host = undefined;
      }
      return host ? `Approve ${host} for this run` : undefined;
    }
    default:
      return prompt.tool ? "Approve this tool for this run" : undefined;
  }
}

function renderDiff(diff) {
  const pre = el("pre", { class: "code diff-view" });
  for (const line of diff.split(/\r?\n/)) {
    let cls = "diff-line";
    if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) cls += " diff-meta";
    else if (line.startsWith("+")) cls += " diff-add";
    else if (line.startsWith("-")) cls += " diff-del";
    pre.append(el("span", { class: cls, text: line }));
  }
  return el("details", {}, el("summary", { text: "View diff" }), pre);
}

function renderResponseSummary(view) {
  const response = view.response;
  if (response?.kind === "permission") {
    const lines = [response.approved ? "Approved" : "Denied"];
    if (response.scope === "kind") lines.push("Also allowed similar requests for the rest of the run.");
    if (response.feedback) lines.push(`Feedback: ${response.feedback}`);
    return el("div", { class: response.approved ? "flash info" : "flash warning", text: lines.join("\n") });
  }
  if (response?.kind === "question") {
    return el("div", { class: "flash info", text: `Answered: ${response.answer}${response.wasFreeform ? " (freeform)" : ""}` });
  }
  if (response?.kind === "expired" || view.state === "expired") return el("div", { class: "flash warning", text: "Expired without an answer." });
  return el("div", { class: "flash info", text: `Request ${view.state}.` });
}

async function respondToRequest(view, body, statusNode) {
  statusNode.textContent = "Sending…";
  try {
    await api(`/v1/jobs/${encodeURIComponent(view.jobId)}/input-requests/${encodeURIComponent(view.id)}/respond`, {
      method: "POST",
      body,
    });
    state.requestNotices.delete(view.id);
    statusNode.textContent = "Response sent.";
    await Promise.all([refreshDetailRequests(), refreshInbox(false), refreshJob()]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const message = "Already answered or expired.";
      state.requestNotices.set(view.id, message);
      statusNode.textContent = message;
      announce(message);
      await Promise.all([refreshDetailRequests(), refreshInbox(false), refreshJob()]);
      return;
    }
    statusNode.textContent = describeError(error);
  }
}

function openRequestSession(jobId) {
  showView("sessions", { updateHash: false });
  selectJob(jobId);
}

function shortId(id) {
  return id ? id.slice(0, 8) : "unknown";
}

function expiryText(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "expires soon";
  if (ms <= 0) return "expired";
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `expires in ${hours}h ${rest}m`;
  }
  return `expires in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updateCountdowns() {
  document.querySelectorAll("[data-expires]").forEach((node) => {
    node.textContent = expiryText(node.getAttribute("data-expires"));
  });
}

function eventClass(body) {
  if (body.type === "job.input_requested" || body.type === "job.input_resolved") return "input";
  if (body.type === "job.succeeded") return "success";
  if (body.type === "job.failed" || body.type === "job.needs_review" || body.type === "job.cancelled") return "failure";
  return "";
}

function describeEvent(body) {
  switch (body.type) {
    case "job.queued":
      return "Queued";
    case "job.attempt_started":
      return `Attempt ${body.attempt} started on ${body.profile}${body.acknowledgedGaps?.length ? ` (gaps: ${body.acknowledgedGaps.join(", ")})` : ""}`;
    case "job.waiting_for_eligible_executor":
      return `Waiting for an executor that enforces what this harness's policy requires (${body.missing.join(", ")})`;
    case "job.runner_event": {
      const e = body.event;
      switch (e.kind) {
        case "tool.started":
          if (e.tool === "task") return "Delegating…";
          if (e.tool === "skill") return "Loading skill…";
          return `Tool ${e.tool} started`;
        case "tool.completed":
          if (e.tool === "task") return `Delegation ${e.ok ? "finished" : "failed"}`;
          if (e.tool === "skill") return `Skill ${e.ok ? "loaded" : "failed"}`;
          return `Tool ${e.tool} ${e.ok ? "completed" : "failed"}`;
        case "subagent.started":
          return `Delegated to sub-agent ${e.agent}`;
        case "subagent.completed":
          return `Sub-agent ${e.agent} ${e.ok ? "finished" : "failed"}`;
        case "skill.used":
          return `Loaded skill ${e.skill}`;
        case "agent.turn_started":
          return "Agent turn started";
        case "agent.turn_completed":
          return "Agent turn completed";
        case "progress":
          return e.message;
        case "sdk.event":
          return describeSdkEvent(e.detail);
        default:
          return e.message ?? e.kind;
      }
    }
    case "job.cancel_requested":
      return "Cancellation requested";
    case "job.retry_scheduled":
      return `Retry scheduled after attempt ${body.attempt} (${body.reason}) at ${formatTime(body.notBefore)}`;
    case "job.succeeded":
      return `Succeeded after attempt ${body.attempt}`;
    case "job.failed":
      return `Failed: ${body.code} — ${body.message}`;
    case "job.cancelled":
      return "Cancelled";
    case "job.needs_review":
      return `Needs review: ${body.reason}`;
    case "job.input_requested":
      return body.kind === "question" ? `Question: ${stripQuestionPrefix(body.summary)}` : `Waiting for your approval: ${body.summary}`;
    case "job.input_resolved":
      if (body.state === "answered") {
        if (body.approved === true) return "Approved";
        if (body.approved === false) return "Denied";
        return "Answered";
      }
      return body.state.charAt(0).toUpperCase() + body.state.slice(1);
    default:
      return body.type.replace("job.", "").replaceAll("_", " ");
  }
}

function describeSdkEvent(detail = {}) {
  const data = detail.data ?? {};
  switch (detail.eventType) {
    case "assistant.message":
      return data.content ? `Assistant: ${singleLine(data.content, 220)}` : "Assistant message";
    case "assistant.reasoning":
      return data.content ? `Reasoning: ${singleLine(data.content, 220)}` : "Assistant reasoning";
    case "user.message":
      return data.content ? `User: ${singleLine(data.content, 220)}` : "User message";
    case "assistant.usage":
      return `Model usage: ${data.model ?? "unknown model"} · ${data.inputTokens ?? 0} in · ${data.outputTokens ?? 0} out`;
    case "model.call_failure":
      return `Model call failed: ${data.errorCode ?? data.failureKind ?? data.errorMessage ?? "unknown error"}`;
    case "tool.execution_progress":
      return data.progressMessage ?? "Tool progress";
    case "tool.execution_partial_result":
      return `Tool output: ${singleLine(data.partialOutput ?? "", 220)}`;
    default:
      return String(detail.eventType ?? "SDK event").replaceAll(".", " ");
  }
}

function singleLine(value, limit) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stripQuestionPrefix(summary) {
  return String(summary ?? "").replace(/^Question:\s*/i, "");
}

function appendEvent(event) {
  const list = $("events");
  const content = el("div", { class: "event-content" }, el("span", { class: "event-label", text: describeEvent(event.body) }));
  content.append(
    el(
      "details",
      { class: "event-details" },
      el("summary", { text: event.body?.type === "job.runner_event" && event.body.event?.detail ? "SDK details" : "Event details" }),
      el("pre", { class: "code", text: JSON.stringify(event.body, null, 2) }),
    ),
  );
  list.append(el("li", { class: eventClass(event.body) }, el("time", { text: formatTime(event.at) }), content));
  list.scrollTop = list.scrollHeight;
}

/** Follows the job's server-sent events, reconnecting from the last cursor until the job is terminal. */
async function streamEvents(id) {
  const controller = new AbortController();
  state.stream = controller;
  let cursor = 0;
  let terminal = false;
  const status = $("stream-status");

  while (!controller.signal.aborted && !terminal && id === state.selectedId) {
    status.textContent = "live";
    try {
      const query = cursor > 0 ? `?after=${encodeURIComponent(String(cursor))}` : "";
      const response = await fetch(`/v1/jobs/${encodeURIComponent(id)}/events${query}`, {
        headers: {
          "x-api-key": state.apiKey,
          authorization: `Bearer ${state.apiKey}`,
          accept: "text/event-stream",
          "last-event-id": String(cursor),
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) throw new ApiError(response.status, safeJson(await response.text()));
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value.replaceAll("\r\n", "\n");
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
          if (event.body.type === "job.input_requested" || event.body.type === "job.input_resolved") {
            announce(describeEvent(event.body));
            await Promise.all([refreshDetailRequests(), refreshInbox(false), refreshJob()]);
          } else if (["job.succeeded", "job.failed", "job.cancelled", "job.needs_review", "job.retry_scheduled", "job.attempt_started", "job.cancel_requested"].includes(event.body.type)) {
            await refreshJob();
          }
        }
      }
      const job = await api(`/v1/jobs/${encodeURIComponent(id)}`);
      terminal = TERMINAL.has(job.state);
    } catch (error) {
      if (controller.signal.aborted || id !== state.selectedId) return;
      if (error instanceof ApiError && error.status < 500) {
        status.textContent = describeError(error);
        return;
      }
      status.textContent = "reconnecting…";
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  if (!controller.signal.aborted && id === state.selectedId) {
    status.textContent = "complete";
    await refreshJob();
  }
}

async function jobAction(action) {
  const id = state.selectedId;
  if (!id) return;
  try {
    const job = await api(`/v1/jobs/${encodeURIComponent(id)}:${action}`, { method: "POST" });
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
// Result rendering
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Wire up controls
// ---------------------------------------------------------------------------

$("auth").addEventListener("submit", connect);
$("api-key-toggle").addEventListener("click", () => show($("auth-panel"), $("auth-panel").hidden));
$("nav-sessions").addEventListener("click", () => showView("sessions"));
$("nav-inbox").addEventListener("click", () => showView("inbox"));
$("harness").addEventListener("change", renderVersions);
$("version").addEventListener("change", renderProfiles);
$("submit-form").addEventListener("submit", submitJob);
$("reset-input").addEventListener("click", resetInput);
$("show-schema").addEventListener("click", toggleSchema);
$("refresh-jobs").addEventListener("click", () => loadJobs(true));
$("more-jobs").addEventListener("click", () => loadJobs(false));
$("new-session").addEventListener("click", () => show($("submit-panel"), true));
$("close-new-session").addEventListener("click", () => show($("submit-panel"), false));
$("refresh-inbox").addEventListener("click", () => refreshInbox(true));
$("cancel-job").addEventListener("click", () => jobAction("cancel"));
$("retry-job").addEventListener("click", () => {
  state.stream?.abort();
  jobAction("retry");
});
document.querySelectorAll(".filter-tab").forEach((button) => button.addEventListener("click", () => setFilter(button.dataset.filter)));
window.addEventListener("hashchange", routeFromHash);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshInbox(false);
});

const remembered = sessionStorage.getItem(KEY_STORAGE);
if (remembered) {
  $("api-key").value = remembered;
  $("remember").checked = true;
  connect();
}
