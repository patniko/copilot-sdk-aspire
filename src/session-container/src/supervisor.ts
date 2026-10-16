/**
 * Container entry point. A session container runs one application session; a worker container
 * (`SESSION_CONTAINER_PURPOSE=worker`) runs one orchestrator worker. Both start as root only to run the agent loop as
 * the unprivileged execution user.
 */
if (process.env.SESSION_CONTAINER_PURPOSE === "worker") await import("./worker-supervisor.js");
else await import("./session-supervisor.js");

export {};
