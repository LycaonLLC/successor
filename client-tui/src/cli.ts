#!/usr/bin/env node
/**
 * successor-tui — entry. Hosted account play by default; login/logout/account
 * manage this computer's credential; --legacy targets a local server with the
 * old flag surface. Full TUI on a real terminal, --plain otherwise.
 */
import { createInterface } from "node:readline";

import { runTui } from "./app";
import { runAccount, runLogin, runLogout } from "./account/accountCommands";
import { runHostedPlay, type SessionOutcome } from "./account/hosted";
import { runRcWorldProbeFromFd } from "./rcProbe";
import { helpText, parseTuiArgs, type TuiOptions } from "./options";
import { runPlain } from "./plain";

function dumbTerminal(): boolean {
  return !process.stdout.isTTY || !process.stdin.isTTY || process.env.TERM === "dumb";
}

async function runRcWorldProbe(argv: readonly string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== "--rc-probe-fd" || !/^[3-9][0-9]*$/u.test(argv[1] ?? "")) {
    process.stdout.write(JSON.stringify({ type: "successor.tui.world-ready.v1", status: "fail", reasonClass: "input", authorityConnected: false, tickPositive: false, identityMatch: false, sourceMatchesClient: false }) + "\n");
    return 2;
  }
  try {
    const result = await runRcWorldProbeFromFd(Number(argv[1]));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "pass" ? 0 : 1;
  } catch (error) {
    const reasonClass = error && typeof error === "object" && "reasonClass" in error && (error.reasonClass === "input" || error.reasonClass === "session-start" || error.reasonClass === "authority-timeout" || error.reasonClass === "probe-crash") ? error.reasonClass : "probe-crash";
    process.stdout.write(JSON.stringify({ type: "successor.tui.world-ready.v1", status: "fail", reasonClass, authorityConnected: false, tickPositive: false, identityMatch: false, sourceMatchesClient: false }) + "\n");
    return 1;
  }
}

async function runSession(options: TuiOptions): Promise<SessionOutcome> {
  let legNotice: string | null = null;
  if (options.hosted) {
    const upstream = options.hosted.onLegFailure;
    options.hosted.onLegFailure = (notice) => {
      legNotice = legNotice ?? notice;
      upstream?.(notice);
    };
  }
  try {
    const code = await (options.plain || dumbTerminal() ? runPlain(options) : runTui(options));
    return legNotice === null ? { kind: "quit", code } : { kind: "leg-failed", notice: legNotice };
  } catch (error) {
    return { kind: "leg-failed", notice: error instanceof Error ? error.message : String(error) };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv[0] === "--rc-world-probe") return runRcWorldProbe(argv.slice(1));
  let invocation;
  try {
    invocation = parseTuiArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (invocation === "help") {
    process.stdout.write(helpText());
    return 0;
  }

  const print = (line: string): void => void process.stdout.write(`${line}\n`);
  const error = (line: string): void => void process.stderr.write(`${line}\n`);

  switch (invocation.kind) {
    case "login":
      return runLogin(invocation.account, { io: { print, error } });
    case "logout":
      return runLogout(invocation.account, { io: { print, error } });
    case "account":
      return runAccount(invocation.account, { io: { print, error } });
    case "hosted": {
      const interactive = process.stdin.isTTY === true;
      const question = async (prompt: string): Promise<string | null> => {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await new Promise<string | null>((resolve) => {
            reader.on("close", () => resolve(null));
            reader.question(prompt, resolve);
          });
        } finally {
          reader.close();
        }
      };
      return runHostedPlay(invocation.hosted, {
        io: { print, error, question, interactive },
        runSession,
      });
    }
    case "legacy": {
      const options = invocation.legacy;
      try {
        if (options.plain || dumbTerminal()) return await runPlain(options);
        return await runTui(options);
      } catch (caught) {
        process.stderr.write(`${caught instanceof Error ? caught.stack ?? caught.message : String(caught)}\n`);
        return 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().then((code) => {
    process.exitCode = code;
    // the host keeps sockets/timers alive; exit deliberately once the run returns
    setTimeout(() => process.exit(code), 50).unref();
  });
}
