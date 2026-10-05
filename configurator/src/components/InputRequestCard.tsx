import clsx from "clsx";
import { useEffect, useState } from "react";
import type { InputRequestView, InputResponseSubmission } from "@copilot-agent/contracts";
import { AlertTriangle, Check, Copilot, X } from "./icons";
import { Badge, Spinner } from "./ui";
import { CommentDiscussionIcon, FileDiffIcon, GlobeIcon, TerminalIcon, FileIcon, ToolsIcon } from "@primer/octicons-react";

const TITLES: Record<string, string> = {
  shell: "Run a shell command",
  write: "Write a file",
  read: "Read a file",
  url: "Fetch a URL",
  mcp: "Use a tool",
  other: "Perform an action",
};

function countdown(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * One approval or question from a running agent. Agent-generated content is rendered as text only.
 */
export function InputRequestCard({ request, onRespond }: {
  request: InputRequestView;
  onRespond: (submission: InputResponseSubmission) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [answer, setAnswer] = useState("");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (request.state !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.state]);

  const respond = async (submission: InputResponseSubmission) => {
    setBusy(true);
    try {
      await onRespond(submission);
    } finally {
      setBusy(false);
    }
  };
  const pending = request.state === "pending";
  const body = request.request;
  const permission = body.kind === "permission" ? body.permission : undefined;
  const icon =
    body.kind === "question" ? (
      <CommentDiscussionIcon size={16} />
    ) : permission?.type === "shell" ? (
      <TerminalIcon size={16} />
    ) : permission?.type === "write" ? (
      <FileDiffIcon size={16} />
    ) : permission?.type === "url" ? (
      <GlobeIcon size={16} />
    ) : permission?.type === "read" ? (
      <FileIcon size={16} />
    ) : (
      <ToolsIcon size={16} />
    );
  const resolved =
    request.response?.kind === "permission"
      ? request.response.approved
        ? request.response.scope === "kind"
          ? `Approved for the rest of the run`
          : "Approved"
        : "Denied"
      : request.response?.kind === "question"
        ? `Answered: ${request.response.answer}`
        : request.state === "expired"
          ? "Expired without an answer"
          : request.state === "cancelled"
            ? "Cancelled"
            : undefined;

  return (
    <div
      className={clsx(
        "card",
        pending && "!border-[var(--borderColor-attention-emphasis)] shadow-[var(--shadow-resting-small)]",
      )}
    >
      <div className={clsx("box-header !py-2", pending && "!bg-[var(--bgColor-attention-muted)]")}>
        <div className="flex min-w-0 items-center gap-2">
          <span className={pending ? "fg-attention" : "fg-muted"}>{icon}</span>
          <span className="font-semibold">{body.kind === "question" ? "The agent has a question" : TITLES[permission?.type ?? "other"]}</span>
          {permission && <Badge>{permission.type}</Badge>}
        </div>
        {pending ? (
          <span className="text-xs fg-muted" title={`Expires at ${new Date(request.expiresAt).toLocaleTimeString()}`}>
            expires in {countdown(request.expiresAt, now)}
          </span>
        ) : (
          <Badge tone={request.state === "answered" ? (request.response?.kind === "permission" && !request.response.approved ? "red" : "green") : "neutral"}>
            {request.state}
          </Badge>
        )}
      </div>
      <div className="card-pad space-y-3">
        {body.kind === "question" ? (
          <p className="whitespace-pre-wrap">{body.question}</p>
        ) : (
          <>
            {permission?.intention && <p className="whitespace-pre-wrap">{permission.intention}</p>}
            {(permission?.command ?? permission?.path ?? permission?.url ?? permission?.tool) && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-muted bg-muted p-2 font-mono text-xs">
                {permission?.command ?? permission?.path ?? permission?.url ?? permission?.tool}
              </pre>
            )}
            {permission?.diff && (
              <details>
                <summary className="cursor-pointer text-xs fg-accent">Show diff</summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-muted bg-muted p-2 font-mono text-[11px]">
                  {permission.diff.split("\n").map((line, index) => (
                    <div
                      key={index}
                      className={clsx(
                        line.startsWith("+") && !line.startsWith("+++") && "bg-[var(--diffBlob-additionLine-bgColor)]",
                        line.startsWith("-") && !line.startsWith("---") && "bg-[var(--diffBlob-deletionLine-bgColor)]",
                      )}
                    >
                      {line || " "}
                    </div>
                  ))}
                </pre>
              </details>
            )}
            {permission?.warning && (
              <p className="flex items-start gap-1 text-xs fg-attention">
                <AlertTriangle className="mt-0.5 shrink-0" /> <span>{permission.warning}</span>
              </p>
            )}
          </>
        )}

        {pending && body.kind === "permission" && (
          <div className="space-y-2">
            <input
              className="input"
              placeholder="Optional note for the agent if you deny"
              aria-label="Feedback for the agent"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={() => void respond({ kind: "permission", approved: true, scope: "once" })}>
                {busy ? <Spinner /> : <Check />} Approve
              </button>
              <button
                type="button"
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => void respond({ kind: "permission", approved: true, scope: "kind" })}
              >
                Approve all {permission?.type} for this run
              </button>
              <button
                type="button"
                className="btn-danger btn-sm"
                disabled={busy}
                onClick={() => void respond({ kind: "permission", approved: false, ...(feedback.trim() ? { feedback: feedback.trim() } : {}) })}
              >
                <X /> Deny
              </button>
            </div>
          </div>
        )}

        {pending && body.kind === "question" && (
          <div className="space-y-2">
            {body.choices && body.choices.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {body.choices.map((choice) => (
                  <button key={choice} type="button" className="btn-secondary btn-sm" disabled={busy} onClick={() => void respond({ kind: "question", answer: choice })}>
                    {choice}
                  </button>
                ))}
              </div>
            )}
            {body.allowFreeform && (
              <div className="flex gap-2">
                <textarea
                  className="input"
                  rows={2}
                  aria-label="Your answer"
                  placeholder="Type your answer"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-primary btn-sm self-end"
                  disabled={busy || !answer.trim()}
                  onClick={() => void respond({ kind: "question", answer: answer.trim() })}
                >
                  {busy ? <Spinner /> : <Copilot />} Send
                </button>
              </div>
            )}
          </div>
        )}

        {!pending && resolved && <p className="text-xs fg-muted">{resolved}</p>}
      </div>
    </div>
  );
}
