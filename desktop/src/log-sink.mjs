import fs from "node:fs";
import path from "node:path";
import { successorDesktopEnv } from "./env.mjs";

// Lazy singleton write stream for the optional runtime log file. Opened once on
// the first desktopLog() call (only when SUCCESSOR_DESKTOP_RUNTIME_LOG is set),
// reused for every subsequent line, and flushed/closed on app shutdown. We
// never block the Electron main process (which routes input events) on drain:
// write() is fire-and-forget and stdout via console.error always preserves
// visibility. On a stream error we fall back to console.error-only and stop
// retrying the stream so a bad log path can't spam forever.
let logStream = null;
let logStreamFailed = false;

export function desktopLog(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    event,
    ...details,
  };
  const line = `[successor-desktop] ${JSON.stringify(payload)}`;
  console.error(line);

  const logPath = successorDesktopEnv("RUNTIME_LOG");
  if (!logPath) return;
  ensureLogStream(logPath);
  // write() is fire-and-forget: if it returns false (backpressure) we simply
  // continue. console.error above already preserved the line's visibility.
  logStream?.write(`${line}\n`);
}

function ensureLogStream(logPath) {
  if (logStream || logStreamFailed) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.on("error", (error) => {
      reportLogWriteFailure(error);
      logStream = null;
      logStreamFailed = true;
      try {
        stream.destroy();
      } catch {
        // Ignore teardown errors on a stream we have already abandoned.
      }
    });
    logStream = stream;
  } catch (error) {
    reportLogWriteFailure(error);
    logStreamFailed = true;
  }
}

function reportLogWriteFailure(error) {
  console.error(`[successor-desktop] ${JSON.stringify({
    ts: new Date().toISOString(),
    event: "runtime-log-write-failed",
    message: error instanceof Error ? error.message : String(error),
  })}`);
}

// Flush + close the sink. Call after game-server teardown completes so the
// teardown log lines are written before the process exits.
export function closeDesktopLogSink() {
  if (!logStream) return;
  const stream = logStream;
  logStream = null;
  try {
    stream.end();
  } catch {
    // Best-effort flush during shutdown; nothing actionable here.
  }
}
