/**
 * The full TUI — alt-screen, panes, and the frame loop.
 *
 * Layout law (Main ruling 2026-07-08): the prose log is the HERO. Rails
 * collapse first as width shrinks (full rail ≥100 cols → slim rail ≥84 →
 * none); the log + command line survive to the last column. Chat keeps a
 * short strip above the command line; toasts float over the log's top-right.
 */

import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { writeFileSync } from "node:fs";
import { createGameSession } from "./game/session";
import { createArmedConfirm } from "./game/armedConfirm";
import { CombatNarratorReducer } from "./game/combatNarrator";
import { CONVERSE_RECEIPT_KINDS, createConverseSession } from "./game/converse";
import { createCraftNarrator } from "./game/craftFlow";
import { composeDuelOutcome } from "./game/duel";
import { genomeScanLines, spliceReadoutLines, spliceViewOf, genomeScanOf } from "./game/splice";
import { createPursuitController } from "./game/pursue";
import { createTradeNarrator } from "./game/exchangeTrade";
import { routeLine, completionVerbs, tradePartnerName } from "./commands";
import { createNarrator, type LogLine, type Narrator } from "./language/narrator";
import { reasonCopy } from "./language/copy";
import type { Contact } from "./game/contacts";
import { INTRO_DURATION_MS, renderOpeningCrawl } from "./intro";
import type { TuiOptions } from "./options";
import {
  disableBracketedPaste,
  enableBracketedPaste,
  enterAltScreen,
  hideCursor,
  leaveAltScreen,
  resetSgr,
  showCursor,
  windowTitle,
} from "./term/ansi";
import { Compositor, surfaceToText } from "./term/compositor";
import { KeyDecoder, type KeyEvent } from "./term/input";
import { Surface } from "./term/surface";
import { detectColorMode } from "./theme";
import { ChatPane } from "./panes/chat";
import {
  backspace,
  commit,
  completeVerb,
  createCommandLine,
  deleteForward,
  historyStep,
  insertText,
  killToEnd,
  killToStart,
  moveCursor,
  renderCommandLine,
  updateGhost,
  type CommandLine,
  type CommandLineRender,
} from "./panes/commandLine";
import { LogPane } from "./panes/log";
import { renderMasthead } from "./panes/masthead";
import { createQueuePaneState, ingestQueueEvents, renderQueue, type QueuePaneState } from "./panes/queue";
import { renderRadar } from "./panes/radar";
import { createPalette, type Palette, type Rect } from "./panes/styles";
import { ToastStack } from "./panes/toasts";
import { renderVitals } from "./panes/vitals";
import { createWeaponPaneState, renderWeapon, type WeaponPaneState } from "./panes/weapon";
import { parseWind } from "./game/bearing";

const FRAME_MS = 50;
const POLL_EVERY_FRAMES = 8;

interface Layout {
  masthead: Rect;
  log: Rect;
  rail: Rect | null;
  railVitals: Rect | null;
  railWeapon: Rect | null;
  railQueue: Rect | null;
  railRadar: Rect | null;
  chat: Rect | null;
  command: Rect;
}

/** Hero-log layout: rails collapse first, prose survives to the end. */
export function computeLayout(width: number, height: number): Layout {
  const mastheadH = 1;
  const commandH = 1;
  const chatH = height >= 30 ? 3 : height >= 24 ? 2 : 0;
  const bodyY = mastheadH;
  const bodyH = Math.max(3, height - mastheadH - commandH - chatH - (chatH > 0 ? 1 : 0) - 1);
  const railW = width >= 100 ? 30 : width >= 84 ? 24 : 0;
  const logW = railW > 0 ? width - railW - 3 : width - 2;

  const layout: Layout = {
    masthead: { x: 0, y: 0, w: width, h: mastheadH },
    log: { x: 1, y: bodyY, w: logW, h: bodyH },
    rail: null,
    railVitals: null,
    railWeapon: null,
    railQueue: null,
    railRadar: null,
    chat: chatH > 0 ? { x: 1, y: bodyY + bodyH + 1, w: width - 2, h: chatH } : null,
    command: { x: 1, y: height - 1, w: width - 2, h: commandH },
  };
  if (railW > 0) {
    const railX = width - railW - 1;
    const slim = railW < 30;
    const vitalsH = 4;
    const weaponH = 3;
    const queueH = Math.min(5, Math.max(3, Math.floor(bodyH * 0.18)));
    const radarH = Math.max(4, bodyH - vitalsH - weaponH - queueH - 3);
    layout.rail = { x: railX, y: bodyY, w: railW, h: bodyH };
    layout.railVitals = { x: railX, y: bodyY, w: railW, h: vitalsH };
    layout.railWeapon = { x: railX, y: bodyY + vitalsH + 1, w: railW, h: weaponH };
    layout.railQueue = { x: railX, y: bodyY + vitalsH + weaponH + 2, w: railW, h: queueH };
    layout.railRadar = slim
      ? { x: railX, y: bodyY + vitalsH + weaponH + queueH + 3, w: railW, h: Math.max(2, radarH), }
      : { x: railX, y: bodyY + vitalsH + weaponH + queueH + 3, w: railW, h: radarH };
  }
  return layout;
}

/** Everything one frame needs — pure over these inputs, so tests snapshot it. */
export interface FrameInputs {
  state: PlayState;
  slice: SliceSnapshot;
  contacts: readonly Contact[];
  log: LogPane;
  chatPane: ChatPane;
  toasts: ToastStack;
  queuePane: QueuePaneState;
  weaponPane: WeaponPaneState;
  commandLine: CommandLine;
  palette: Palette;
}

/** Compose one full frame into the surface; returns the caret position. */
export function renderFrame(surface: Surface, inputs: FrameInputs): CommandLineRender {
  const { state, slice, contacts, log, chatPane, toasts, queuePane, weaponPane, commandLine, palette } = inputs;
  surface.clear(palette.canvas);
  const layout = computeLayout(surface.width, surface.height);
  renderMasthead(surface, layout.masthead, state, slice, palette);
  log.render(surface, layout.log, palette);
  toasts.render(surface, { ...layout.log, h: Math.min(4, layout.log.h) }, palette);

  if (layout.rail) {
    surface.vline(layout.rail.x - 1, layout.rail.y, layout.rail.h, palette.frame);
    if (layout.railVitals) renderVitals(surface, layout.railVitals, state, palette);
    if (layout.railWeapon) {
      surface.hline(layout.railWeapon.x, layout.railWeapon.y - 1, layout.railWeapon.w, palette.frame);
      renderWeapon(surface, layout.railWeapon, state, slice, weaponPane, palette);
    }
    if (layout.railQueue) {
      surface.hline(layout.railQueue.x, layout.railQueue.y - 1, layout.railQueue.w, palette.frame);
      renderQueue(surface, layout.railQueue, state, queuePane, palette);
    }
    if (layout.railRadar) {
      surface.hline(layout.railRadar.x, layout.railRadar.y - 1, layout.railRadar.w, palette.frame);
      renderRadar(surface, layout.railRadar, contacts, palette);
    }
  }
  if (layout.chat) {
    surface.hline(layout.chat.x - 1, layout.chat.y - 1, layout.chat.w + 2, palette.frame);
    chatPane.render(surface, layout.chat, palette);
  }
  surface.hline(layout.command.x - 1, layout.command.y - 1, layout.command.w + 2, palette.frame);
  return renderCommandLine(surface, layout.command, commandLine, state, palette);
}

export async function runTui(options: TuiOptions): Promise<number> {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const mode = detectColorMode();
  const palette = createPalette();

  const session = await createGameSession({
    endpoint: options.endpoint,
    slicePath: options.slicePath,
    playerId: options.playerId,
    actorId: options.actorId,
    displayName: options.displayName,
    zoneId: options.zoneId,
    characterId: options.characterId,
    ticket: options.ticket,
    gameTicket: options.hosted?.gameTicket,
    clientReleaseId: options.hosted?.clientReleaseId,
    chatTicket: options.hosted?.chatTicket,
    origin: options.hosted?.origin,
    spawnArea: options.spawnArea,
    spawnX: options.spawnX,
    spawnY: options.spawnY,
    facing: options.facing,
    tickIntervalMs: options.tickIntervalMs,
    readyTimeoutMs: options.readyTimeoutMs,
    chatUrl: options.chatUrl ?? undefined,
  });
  if (options.hosted) {
    // handed to the session; the launch options keep no copy
    options.hosted.gameTicket = undefined;
    options.hosted.chatTicket = undefined;
  }

  const log = new LogPane();
  const chatPane = new ChatPane();
  const toasts = new ToastStack();
  const queuePane = createQueuePaneState();
  const weaponPane = createWeaponPaneState();
  const commandLine = createCommandLine();
  const verbs = completionVerbs(session);
  const converse = createConverseSession(session.state, session.slice, session.isCarried);
  const confirm = createArmedConfirm();
  const pursue = createPursuitController(session, {
    ...(options.pursueTimeoutMs !== undefined ? { timeoutMs: options.pursueTimeoutMs } : {}),
  });

  const narrator: Narrator = createNarrator(session, (line: LogLine) => log.push(line), {
    verbose: options.verbose,
    chatLines: false,
    suppressReceipt: (kind) => converse.active() && kind !== undefined
      && (CONVERSE_RECEIPT_KINDS as readonly string[]).includes(kind),
  });
  const detachNarrator = narrator.attach();

  // TUI-only signal taps: chat pane, toasts, queue beats, craft + trade + combat narration.
  const combatReducer = new CombatNarratorReducer();
  const craftSource = () => session.state.serverAuthority.craftSession;
  const craftNarrator = createCraftNarrator(session, craftSource);
  let craftRenderTimer: NodeJS.Timeout | null = null;
  const tradeSource = () => session.state.serverAuthority.tradeSession;
  const tradeNarrator = createTradeNarrator(tradeSource, (actorId) => tradePartnerName(session, actorId));
  let lastSplicePhase: string | null = null;
  const detachApp = session.onEvent((event) => {
    if (event.kind === "chat") chatPane.push(event.message);
    if (event.kind === "combat") {
      const lines = combatReducer.ingest(session.state, event.event, options.verbose);
      for (const line of lines) log.push(line);
    }
    if (event.kind === "queue") ingestQueueEvents(queuePane, [event.event]);
    if (event.kind === "receipt" || event.kind === "queue") {
      for (const line of pursue.onEvent(event)) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    }
    if (event.kind === "receipt" && converse.active()
      && event.commandKind !== undefined
      && (CONVERSE_RECEIPT_KINDS as readonly string[]).includes(event.commandKind)) {
      for (const line of converse.phraseReceipt(event.commandKind, event.accepted, event.reasonCode)) {
        log.push({ register: line.register, text: line.text, atMs: Date.now() });
      }
    }
    if (event.kind === "receipt" && event.accepted && craftNarrator.wantsRender(event.commandKind)) {
      // one render per receipt burst: give the side-channel a beat, coalesce
      if (craftRenderTimer === null) {
        craftRenderTimer = setTimeout(() => {
          craftRenderTimer = null;
          for (const line of craftNarrator.render()) log.push({ register: line.register, text: line.text, atMs: Date.now() });
        }, 300);
      }
    }
    if (event.kind === "receipt" && !event.accepted && event.reasonCode?.endsWith("_cooldown")) {
      toasts.push(reasonCopy(event.reasonCode), "warn");
    }
    if (event.kind === "trade") {
      for (const line of tradeNarrator.render()) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    }
    if (event.kind === "duelOutcome") {
      const line = composeDuelOutcome(event.outcome);
      if (line) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    }
    if (event.kind === "splice") {
      const view = spliceViewOf(session.state);
      const phase = view?.phase ?? null;
      // the ambient browse VM broadcasts at connect — only speak real sessions
      const ambient = !view || (view.phase === "browse" && !view.speciesName);
      if (view && !ambient && phase !== lastSplicePhase) {
        for (const line of spliceReadoutLines(view)) log.push({ register: line.register, text: line.text, atMs: Date.now() });
      }
      lastSplicePhase = phase;
    }
    if (event.kind === "genomeScan") {
      const scan = genomeScanOf(session.state);
      if (scan) for (const line of genomeScanLines(scan)) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    }
    if (event.kind === "survey") {
      const remainTicks = event.result.cooldownUntilTick - session.estimatedTick();
      if (remainTicks > 0) {
        toasts.push(`SCANNER COOLING ${Math.ceil(remainTicks / session.slice.tickRateHz)}s`, "info", 3_000);
      }
    }
    if (event.kind === "status") {
      if (event.status === "ready") toasts.push("SIGNAL LOCKED", "info");
      if (event.status === "disconnected") toasts.push("CONNECTION LOST", "danger", 8_000);
      if (options.hosted && (event.status === "chat-failed" || event.status === "disconnected")) {
        // split launch: either leg down ends the run — the hosted loop
        // closes both, says so once, and mints fresh on the next attempt
        options.hosted.onLegFailure?.(event.status === "chat-failed"
          ? "the chat connection was refused or dropped"
          : "the game connection dropped");
        requestQuit();
      }
    }
  });

  let width = stdout.columns || 100; // `||` — a degenerate pty reports 0, not undefined
  let height = stdout.rows || 30;
  let surface = new Surface(width, height);
  const compositor = new Compositor((chunk) => stdout.write(chunk), mode);
  let quitting = false;
  let frameCounter = 0;

  const decoder = new KeyDecoder();
  const onResize = (): void => {
    width = stdout.columns || width;
    height = stdout.rows || height;
    surface = new Surface(width, height);
    compositor.invalidate();
  };

  const requestQuit = (): void => {
    quitting = true;
  };

  const handleCommitted = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/")) log.push({ register: "echo", text: trimmed, atMs: Date.now() });
    // /snap is presentation-owned: writes the CURRENT frame as plain text
    // (bug reports, sharing a MUD moment — the terminal client's screenshot).
    const snap = /^\/snap(?:\s+(\S+))?$/.exec(trimmed);
    if (snap) {
      const file = snap[1] ?? `successor-tui-snap-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
      try {
        writeFileSync(file, `${surfaceToText(surface)}\n`);
        log.push({ register: "system", text: `Frame written — ${file}`, atMs: Date.now() });
      } catch (error) {
        log.push({ register: "reject", text: `Snap failed — ${error instanceof Error ? error.message : String(error)}`, atMs: Date.now() });
      }
      return;
    }
    const outcome = routeLine({ session, quitRequested: requestQuit, converse, confirm, pursue, craftSession: craftSource, groupView: () => session.state.serverAuthority.group, tradeSession: tradeSource }, trimmed);
    for (const line of outcome.lines) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    if (outcome.look) narrator.look();
  };

  const handleKey = (key: KeyEvent): void => {
    if (key.kind === "paste") {
      insertText(commandLine, key.value.replace(/\r?\n/g, " ; "));
      return;
    }
    if (key.kind === "special") {
      switch (key.name) {
        case "enter": {
          const value = commit(commandLine);
          handleCommitted(value);
          return;
        }
        case "backspace": backspace(commandLine); return;
        case "delete": deleteForward(commandLine); return;
        case "left": moveCursor(commandLine, -1); return;
        case "right": moveCursor(commandLine, 1); return;
        case "up": historyStep(commandLine, -1); return;
        case "down": historyStep(commandLine, 1); return;
        case "pageup": log.scroll(1, Math.max(4, height - 12)); return;
        case "pagedown": log.scroll(-1, Math.max(4, height - 12)); return;
        case "home": commandLine.cursor = 0; return;
        case "end": commandLine.cursor = commandLine.buffer.length; return;
        case "tab": completeVerb(commandLine, verbs); return;
        case "escape": {
          if (commandLine.buffer.length > 0) {
            commandLine.buffer = "";
            commandLine.cursor = 0;
          } else {
            for (const line of pursue.interrupt("movement")) log.push({ register: line.register, text: line.text, atMs: Date.now() });
            session.stopMovement();
          }
          return;
        }
        default: return;
      }
    }
    // chars
    if (key.ctrl) {
      switch (key.value) {
        case "c": requestQuit(); return;
        case "l": compositor.invalidate(); return;
        case "u": killToStart(commandLine); return;
        case "k": killToEnd(commandLine); return;
        case "a": commandLine.cursor = 0; return;
        case "e": commandLine.cursor = commandLine.buffer.length; return;
        default: return;
      }
    }
    // empty-line movement: w/a/s/d walk by compass, x stops; shift sprints.
    // The hand on the keys breaks any live pursuit before it moves.
    if (commandLine.buffer.length === 0) {
      const lower = key.value.toLowerCase();
      const impulseWind = lower === "w" ? "north" : lower === "s" ? "south" : lower === "a" ? "west" : lower === "d" ? "east" : null;
      if (impulseWind) {
        for (const line of pursue.interrupt("movement")) log.push({ register: line.register, text: line.text, atMs: Date.now() });
        session.holdDirection(parseWind(impulseWind)!, key.value !== lower, 300);
        return;
      }
      if (lower === "x") {
        for (const line of pursue.interrupt("movement")) log.push({ register: line.register, text: line.text, atMs: Date.now() });
        session.stopMovement();
        return;
      }
    }
    insertText(commandLine, key.value);
  };

  const frame = (): void => {
    frameCounter += 1;
    if (frameCounter % POLL_EVERY_FRAMES === 0) {
      narrator.poll();
      for (const line of converse.tick()) log.push({ register: line.register, text: line.text, atMs: Date.now() });
      for (const line of pursue.tick()) log.push({ register: line.register, text: line.text, atMs: Date.now() });
    }
    session.tracker.update(session.state); // pane truth even between event beats
    updateGhost(commandLine, verbs);
    const caret = renderFrame(surface, {
      state: session.state,
      slice: session.slice,
      contacts: session.tracker.contacts(),
      log,
      chatPane,
      toasts,
      queuePane,
      weaponPane,
      commandLine,
      palette,
    });
    compositor.render(surface, { row: caret.cursorRow, col: caret.cursorCol });
  };

  // ── terminal bring-up ──────────────────────────────────────────────────────
  stdout.write(enterAltScreen + hideCursor + enableBracketedPaste + windowTitle("SUCCESSOR — terminal client"));
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  const onData = (chunk: string): void => {
    for (const key of decoder.push(chunk)) handleKey(key);
  };
  stdout.on("resize", onResize);

  log.push({ register: "system", text: "SUCCESSOR terminal client — /help for the field manual.", atMs: Date.now() });

  let timer: NodeJS.Timeout | undefined;
  let introSkipped = false;
  const onIntroData = (chunk: string): void => {
    introSkipped = true;
    if (chunk.includes("\u0003")) requestQuit();
  };
  try {
    const startResult = session.start().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    if (options.intro) {
      stdin.on("data", onIntroData);
      const introStartedAt = Date.now();
      while (!introSkipped && !quitting) {
        const elapsedMs = Date.now() - introStartedAt;
        if (elapsedMs >= INTRO_DURATION_MS) break;
        renderOpeningCrawl(surface, elapsedMs, palette);
        compositor.render(surface);
        await new Promise<void>((resolve) => setTimeout(resolve, FRAME_MS));
      }
      stdin.off("data", onIntroData);
      compositor.invalidate();
    }
    stdin.on("data", onData);
    const started = await startResult;
    if (!started.ok) throw started.error;
    if (quitting) return 0;
    narrator.look();
    stdout.write(showCursor);
    const frames = Promise.withResolvers<void>();
    timer = setInterval(() => {
      if (quitting) {
        frames.resolve();
        return;
      }
      try {
        frame();
      } catch {
        compositor.invalidate();
      }
    }, FRAME_MS);
    await frames.promise;
    return 0;
  } finally {
    clearInterval(timer);
    stdin.off("data", onIntroData);
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    detachApp();
    detachNarrator();
    await session.dispose();
    stdout.write(disableBracketedPaste + resetSgr + showCursor + leaveAltScreen);
  }
}
