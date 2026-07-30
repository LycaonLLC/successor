import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  createMacroEngine,
  type MacroCommandReceipt,
  type MacroEngine,
  type MacroEngineState,
  type MacroRunSnapshot,
  type MacroStartResult,
  type MacroValue,
} from "@successor/client/src/slice-core/macroEngine/index";
import type { VerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import { macroLibraryRows, resolveMacroSource } from "./library";
import { ensureLocalMacrosLoaded, localMacrosSupported } from "./localMacros";
import { macroCaps, macros } from "./store";

/**
 * MACRO runtime — the 3D client's host for the slice-core macro engine (SP2).
 *
 * One instance per world boot, owned by successor3dApp:
 *  - LIBRARY: the merged three-provider view (library.ts — character record
 *    > local .macro files > starter pack). `/macro run <name>` and the
 *    window RUN column resolve through the same precedence.
 *  - PUMP: `update()` runs once per frame AFTER updatePlayState — new
 *    authority receipts flow into the engine (receipt waits, `$last.*`), then
 *    the engine advances on the same estimated server tick that stamps every
 *    outgoing command (`authorityIssuedAtServerTick`). Same-tick re-entry is
 *    safe: runs are always waiting or finished when tick() returns.
 *  - CHAT PARITY: `handleSlashLine` fronts EXACTLY `/macro …` and `/dump` for
 *    the 3D chat-line resolution order (mirrors client-tui/src/commands.ts —
 *    the registry has no client-verb extension point by design). Everything
 *    else returns null and falls through untouched.
 *  - NOTICES: finished runs surface once via `drainNotices()` — the window
 *    turns halts into deny flashes + ui_deny per the F1 pattern.
 */

export interface MacroNotice {
  kind: "completed" | "stopped" | "halted";
  name: string;
  runId: string;
  reasonCode: string | null;
}

export interface MacroRuntime {
  /** Per-frame pump: receipts in, then tick. Call after updatePlayState. */
  update(): void;
  start(name: string, args?: readonly MacroValue[]): MacroStartResult;
  /** Stop by run id, macro name, or "all"; returns runs stopped. */
  stop(target: string | "all"): number;
  runs(): readonly MacroRunSnapshot[];
  engineState(): MacroEngineState;
  /** New finished-run notices since the last drain (window deny wiring). */
  drainNotices(): MacroNotice[];
  /** Chat-line front for /macro + /dump; null = not a macro line. */
  handleSlashLine(line: string): string | null;
}

export interface MacroRuntimeOptions {
  state: PlayState;
  slice: SliceSnapshot;
  registry: VerbRegistry;
}

export function createMacroRuntime(options: MacroRuntimeOptions): MacroRuntime {
  const { state, slice, registry } = options;
  ensureLocalMacrosLoaded(); // local .macro provider (desktop shell only)

  const engine: MacroEngine = createMacroEngine({
    registry,
    caps: {
      tickRateHz: slice.tickRateHz,
      bodyBytes: macroCaps().maxBodyBytes,
      macrosPerCharacter: macroCaps().maxItems,
    },
    macros: {
      getMacro: (name) => {
        const hit = resolveMacroSource(name);
        return hit ? { name: hit.name, body: hit.body, iconId: hit.iconId } : null;
      },
      listMacros: () => macroLibraryRows()
        .filter((row) => !row.shadowed && row.error === null)
        .map((row) => ({ name: row.name, iconId: row.iconId })),
    },
    resolveVariable: (name) => resolveLiveVariable(state, name),
  });

  // Receipt cursor: the log is a 128-cap ring spliced from the front, so a
  // numeric index goes stale; entry objects are freshly allocated per receipt,
  // so identity of the last pumped entry is the durable cursor.
  let lastPumpedReceipt: object | null = null;
  const pumpReceipts = (): void => {
    const log = state.serverAuthority.receiptLog;
    if (log.length === 0) return;
    let start = 0;
    if (lastPumpedReceipt) {
      for (let index = log.length - 1; index >= 0; index -= 1) {
        if (log[index] === lastPumpedReceipt) {
          start = index + 1;
          break;
        }
      }
    }
    for (let index = start; index < log.length; index += 1) {
      const receipt = log[index]!;
      const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
      engine.ingestReceipt({
        commandId: receipt.commandId,
        accepted: receipt.accepted,
        tick: receipt.tick,
        reasonCode: receipt.reasonCode,
        kind: sent?.kind,
      } satisfies MacroCommandReceipt);
    }
    lastPumpedReceipt = log[log.length - 1] ?? lastPumpedReceipt;
  };

  // Finished-run cursor: completedRuns is a 64-cap ring of fresh snapshot
  // objects — same identity-walk as receipts.
  let lastSeenCompleted: object | null = null;
  const notices: MacroNotice[] = [];
  const collectNotices = (): void => {
    const completed = engine.getState().completedRuns;
    if (completed.length === 0) return;
    let start = 0;
    if (lastSeenCompleted) {
      for (let index = completed.length - 1; index >= 0; index -= 1) {
        if (completed[index] === lastSeenCompleted) {
          start = index + 1;
          break;
        }
      }
    }
    for (let index = start; index < completed.length; index += 1) {
      const run = completed[index]!;
      notices.push({
        kind: run.status === "halted" ? "halted" : run.status === "stopped" ? "stopped" : "completed",
        name: run.name,
        runId: run.runId,
        reasonCode: run.lastReasonCode ?? null,
      });
      while (notices.length > 16) notices.shift();
    }
    lastSeenCompleted = completed[completed.length - 1] ?? lastSeenCompleted;
  };

  const describeList = (): string => {
    const saved = macros();
    const running = engine.listRuns();
    const names = saved.map((macro) => macro.name).join(", ");
    const head = saved.length === 0
      ? "MACROS — NONE SAVED"
      : `MACROS ${saved.length}/${macroCaps().maxItems} — ${names}`;
    const rows = macroLibraryRows();
    const locals = rows.filter((row) => row.source === "local" && row.error === null).length;
    const starters = rows.filter((row) => row.source === "starter").length;
    const tiers = `${localMacrosSupported() ? `LOCAL ${locals} · ` : ""}STARTER ${starters}`;
    const line = `${head} · ${tiers}`;
    return running.length === 0 ? line : `${line} · RUNNING ${running.map((run) => run.name).join(", ")}`;
  };

  const describeStart = (name: string, args: readonly string[]): string => {
    const result = engine.startMacro({ name, args });
    collectNotices();
    if (!result.ok) return `MACRO DENIED — ${reasonCopy(result.reasonCode)}`;
    const slots = engine.listRuns().length;
    return `MACRO RUNNING — ${name.toUpperCase()} (SLOT ${slots}/${engine.getState().caps.runSlots})`;
  };

  return {
    update(): void {
      pumpReceipts();
      engine.tick(authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick));
      collectNotices();
    },

    start(name: string, args: readonly MacroValue[] = []): MacroStartResult {
      const result = engine.startMacro({ name, args });
      collectNotices();
      return result;
    },

    stop(target: string | "all"): number {
      const stopped = engine.stopMacro(target);
      collectNotices();
      return stopped;
    },

    runs: () => engine.listRuns(),
    engineState: () => engine.getState(),

    drainNotices(): MacroNotice[] {
      if (notices.length === 0) return [];
      return notices.splice(0, notices.length);
    },

    handleSlashLine(line: string): string | null {
      const trimmed = line.trim();
      if (!trimmed.startsWith("/")) return null;
      const tokens = trimmed.slice(1).split(/\s+/u).filter((token) => token.length > 0);
      const verb = tokens[0]?.toLowerCase() ?? "";
      if (verb === "dump") {
        const stopped = engine.stopMacro("all");
        return stopped > 0 ? `MACROS DUMPED — ${stopped} RUN${stopped === 1 ? "" : "S"} STOPPED` : "NO MACROS RUNNING";
      }
      if (verb !== "macro") return null;
      const sub = tokens[1]?.toLowerCase() ?? "";
      if (sub === "" || sub === "list") return describeList();
      if (sub === "stop") {
        const target = tokens[2] ?? "all";
        const stopped = engine.stopMacro(target);
        return stopped > 0
          ? `MACRO STOPPED — ${stopped} RUN${stopped === 1 ? "" : "S"}`
          : `MACRO DENIED — ${target.toUpperCase()} NOT RUNNING`;
      }
      const name = sub === "run" ? tokens[2] : tokens[1];
      if (!name) return "MACRO DENIED — USE /MACRO RUN <NAME>";
      const args = tokens.slice(sub === "run" ? 3 : 2);
      return describeStart(name, args);
    },
  };
}

/** Deny copy: `macro_run_slots_exhausted` → "RUN SLOTS EXHAUSTED". */
export function reasonCopy(reasonCode: string | null | undefined): string {
  if (!reasonCode) return "UNSPECIFIED";
  return reasonCode.replace(/^macro_/u, "").replaceAll("_", " ").toUpperCase();
}

/** Live `$var` resolution — the values a fast disciplined hand would use. */
function resolveLiveVariable(state: PlayState, name: string): MacroValue | undefined {
  switch (name) {
    case "target":
      return state.selectedActorId ?? state.softLockActorId ?? undefined;
    case "softlock":
      return state.softLockActorId ?? undefined;
    case "self":
      return state.serverAuthority.playerActorId ?? state.playerActorId;
    default:
      return undefined;
  }
}
