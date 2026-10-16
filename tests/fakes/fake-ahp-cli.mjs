// A stand-in for the Copilot CLI's direct AHP attachment, for launcher supervision tests. It dials the `--ahp` URL with
// Node's WebSocket client, logs what it was started with and what it receives to FAKE_CLI_LOG, reconnects after a
// transient drop as the CLI's background recovery does, and stays running after a refused connection, as the CLI does.
// FAKE_CLI_HANDSHAKE_MS abandons a connection attempt that does not open in time, as the CLI's handshake timeout does;
// FAKE_CLI_RECONNECTS bounds reconnections (three by default).
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const url = args[args.indexOf("--ahp") + 1];
const resume = args[args.indexOf("--resume") + 1];
const handshake = Number(process.env.FAKE_CLI_HANDSHAKE_MS ?? 0);
const limit = Number(process.env.FAKE_CLI_RECONNECTS ?? 3);
const log = (entry) => appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
const dialed = new URL(url);
dialed.searchParams.delete("tkn");
log({ event: "start", url: dialed.href, resume, pin: JSON.parse(process.env.COPILOT_AHP_SERVER_KEY ?? "null"), args });
let reconnects = 0;
function dial() {
  const socket = new WebSocket(url);
  const timer = handshake > 0 ? setTimeout(() => { if (socket.readyState === WebSocket.CONNECTING) socket.close(); }, handshake) : undefined;
  socket.addEventListener("open", () => { clearTimeout(timer); log({ event: "open" }); socket.send(`hello ${process.pid}`); });
  socket.addEventListener("message", (event) => {
    log({ event: "message", data: String(event.data) });
    if (event.data === "quit") process.exit(0);
    if (event.data === "crash") process.exit(3);
  });
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    log({ event: "close", code: event.code });
    if ([1000, 1001, 1006, 1011, 1012, 1013].includes(event.code) && reconnects++ < limit) setTimeout(dial, 100);
  });
  socket.addEventListener("error", () => {});
}
dial();
setInterval(() => {}, 60_000);
