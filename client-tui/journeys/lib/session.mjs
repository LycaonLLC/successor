/**
 * TuiSession — one live TUI client under journey control.
 *
 * Spawns the built dist/cli.js (plain mode for prose journeys; PTY via
 * `script` for /snap frame captures) and exposes an EVENT-DRIVEN
 * expect(): it resolves the moment a matching line arrives instead of
 * sleeping fixed delays — journeys read as send → expect → send, and a
 * miss fails fast with the transcript tail attached.
 */

import { spawn } from "node:child_process";
import path from "node:path";

const CLI_PATH = path.resolve(import.meta.dirname, "..", "..", "dist", "cli.js");

export class ExpectTimeout extends Error {
  constructor(pattern, tail) {
    super(`expect ${pattern} timed out\n--- transcript tail ---\n${tail}`);
    this.name = "ExpectTimeout";
  }
}

export function createSession({
  port,
  actorId,
  displayName,
  spawnArea = "open-desert-overworld",
  spawnX,
  spawnY,
  plain = true,
  chat = false,
  cols = 110,
  rows = 32,
}) {
  const argv = [
    "--legacy", // journeys drive a local server; hosted account play is the CLI default
    ...(plain ? ["--plain"] : []),
    "--no-intro",
    ...(chat ? [] : ["--no-chat"]),
    "--game-url", `http://127.0.0.1:${port}`,
    "--player-id", actorId,
    "--actor-id", actorId,
    "--display-name", displayName,
    ...(spawnX !== undefined ? ["--spawn-area", spawnArea, "--spawn-x", String(spawnX), "--spawn-y", String(spawnY)] : []),
  ];
  const child = plain
    ? spawn("node", [CLI_PATH, ...argv], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    })
    : spawn("script", ["-qfec", `stty cols ${cols} rows ${rows}; node ${CLI_PATH} ${argv.join(" ")}`, "/dev/null"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COLORTERM: "truecolor", TERM: "xterm-256color" },
    });

  const t0 = Date.now();
  const lines = []; // { atMs, text }
  const waiters = new Set(); // { pattern, from, resolve, reject, timer }
  const exited = Promise.withResolvers();
  let exitCode = null;

  const ingest = (chunk) => {
    for (const raw of chunk.toString().split("\n")) {
      const text = raw.trimEnd();
      if (text.trim().length === 0) continue;
      lines.push({ atMs: Date.now() - t0, text });
      for (const waiter of [...waiters]) {
        scan(waiter);
      }
    }
  };
  child.stdout.on("data", ingest);
  child.stderr.on("data", ingest);
  child.on("exit", (code) => {
    exitCode = code;
    exited.resolve(code);
    for (const waiter of [...waiters]) {
      waiter.reject(new ExpectTimeout(waiter.pattern, tail(12)));
      clear(waiter);
    }
  });

  const tail = (n) => lines.slice(-n).map((row) => `${(row.atMs / 1000).toFixed(1)}s ${row.text}`).join("\n");

  const scan = (waiter) => {
    for (let index = Math.max(waiter.from, consumed); index < lines.length; index += 1) {
      const match = waiter.pattern.exec(lines[index].text);
      if (match) {
        consumed = index + 1;
        clear(waiter);
        waiter.resolve({ line: lines[index].text, match, atMs: lines[index].atMs });
        return;
      }
    }
  };
  const clear = (waiter) => {
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
  };

  // Sequential-consumption cursor: each successful expect advances it, so
  // journeys assert prose in ORDER and a stale earlier line can't satisfy
  // a later expectation.
  let consumed = 0;

  return {
    actorId,
    /** Send a line to the client (newline in plain mode, CR under a PTY). */
    send(line) {
      child.stdin.write(`${line}${plain ? "\n" : "\r"}`);
    },
    /**
     * Resolve when a line matching `pattern` arrives at/after the cursor.
     * Consumes through the match. Rejects with the transcript tail on miss.
     */
    expect(pattern, { timeoutMs = 10_000 } = {}) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const waiter = { pattern, from: consumed, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        clear(waiter);
        reject(new ExpectTimeout(pattern, tail(12)));
      }, timeoutMs);
      waiters.add(waiter);
      scan(waiter);
      return promise;
    },
    /** send + expect in one breath. */
    async say(line, pattern, opts) {
      this.send(line);
      return this.expect(pattern, opts);
    },
    /** Sleep helper for the few genuinely time-based beats (cooldowns). */
    idle(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    transcript() {
      return lines.map((row) => `${(row.atMs / 1000).toFixed(1)}s ${row.text}`).join("\n");
    },
    async quit({ timeoutMs = 6_000 } = {}) {
      if (exitCode !== null) return exitCode;
      child.stdin.write(`/quit${plain ? "\n" : "\r"}`);
      const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      const code = await exited.promise;
      clearTimeout(killer);
      return code;
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}
