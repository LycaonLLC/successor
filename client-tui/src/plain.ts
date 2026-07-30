/**
 * --plain — the classic MUD. One prose stream, one prompt, no chrome.
 *
 * Same session, same narrator, same command grammar as the full TUI; chat
 * rides inline. Colors degrade to nothing when stdout isn't a TTY, so it
 * pipes clean (bots, logs, screen readers).
 */

import { createInterface } from "node:readline";

import { routeLine, tradePartnerName } from "./commands";
import { createArmedConfirm } from "./game/armedConfirm";
import { CombatNarratorReducer } from "./game/combatNarrator";
import { CONVERSE_RECEIPT_KINDS, createConverseSession } from "./game/converse";
import { createCraftNarrator } from "./game/craftFlow";
import { composeDuelOutcome } from "./game/duel";
import { genomeScanLines, spliceReadoutLines, spliceViewOf, genomeScanOf } from "./game/splice";
import { createPursuitController } from "./game/pursue";
import { createTradeNarrator } from "./game/exchangeTrade";
import { createNarrator, type LogLine } from "./language/narrator";
import { createGameSession } from "./game/session";
import type { TuiOptions } from "./options";
import { SLATE, detectColorMode, type SlateRole } from "./theme";

const REGISTER_INK: Record<string, SlateRole> = {
  scene: "haze",
  reject: "oxide",
  receipt: "dim",
  survey: "brass",
  loot: "brass",
  system: "dim",
  help: "dim",
  echo: "faint",
  chat: "ink",
  dialogue: "amber",
  combat: "ink",
};

export async function runPlain(options: TuiOptions): Promise<number> {
  const colored = process.stdout.isTTY === true && detectColorMode() !== "mono";
  const ink = (register: string, text: string): string => {
    if (!colored) return text;
    const role = REGISTER_INK[register] ?? "ink";
    const [r, g, b] = SLATE[role].rgb;
    return `\u001b[38;2;${r};${g};${b}m${text}\u001b[0m`;
  };

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

  const reader = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout, prompt: "> " })
    : createInterface({ input: process.stdin, terminal: false });

  const speak = (line: LogLine): void => {
    // keep the prompt line clean: erase, print, re-prompt
    if (process.stdin.isTTY) process.stdout.write("\r\u001b[K");
    process.stdout.write(`${ink(line.register, line.text)}\n`);
    if (process.stdin.isTTY) reader.prompt(true);
  };

  const converse = createConverseSession(session.state, session.slice, session.isCarried);
  const confirm = createArmedConfirm();
  const combatReducer = new CombatNarratorReducer();
  const pursue = createPursuitController(session, {
    ...(options.pursueTimeoutMs !== undefined ? { timeoutMs: options.pursueTimeoutMs } : {}),
  });
  const narrator = createNarrator(session, speak, {
    verbose: options.verbose,
    chatLines: true,
    suppressReceipt: (kind) => converse.active() && kind !== undefined
      && (CONVERSE_RECEIPT_KINDS as readonly string[]).includes(kind),
  });
  const detach = narrator.attach();
  const craftSource = () => session.state.serverAuthority.craftSession;
  const craftNarrator = createCraftNarrator(session, craftSource);
  let craftRenderTimer: NodeJS.Timeout | null = null;
  const tradeSource = () => session.state.serverAuthority.tradeSession;
  const tradeNarrator = createTradeNarrator(tradeSource, (actorId) => tradePartnerName(session, actorId));
  let lastSplicePhase: string | null = null;
  const detachConverse = session.onEvent((event) => {
    if (event.kind === "status" && options.hosted && (event.status === "chat-failed" || event.status === "disconnected")) {
      // split launch: either leg down ends the run — the hosted loop
      // closes both, says so once, and mints fresh on the next attempt
      options.hosted.onLegFailure?.(event.status === "chat-failed"
        ? "the chat connection was refused or dropped"
        : "the game connection dropped");
      quitting = true;
      reader.close();
      return;
    }
    if (event.kind === "combat") {
      const lines = combatReducer.ingest(session.state, event.event, options.verbose);
      for (const line of lines) speak(line);
      return;
    }
    if (event.kind === "receipt" || event.kind === "queue") {
      for (const line of pursue.onEvent(event)) speak({ register: line.register, text: line.text, atMs: Date.now() });
    }
    if (event.kind === "trade") {
      for (const line of tradeNarrator.render()) speak({ register: line.register, text: line.text, atMs: Date.now() });
      return;
    }
    if (event.kind === "duelOutcome") {
      const line = composeDuelOutcome(event.outcome);
      if (line) speak({ register: line.register, text: line.text, atMs: Date.now() });
      return;
    }
    if (event.kind === "splice") {
      const view = spliceViewOf(session.state);
      const phase = view?.phase ?? null;
      // the ambient browse VM broadcasts at connect — only speak real sessions
      const ambient = !view || (view.phase === "browse" && !view.speciesName);
      if (view && !ambient && phase !== lastSplicePhase) {
        for (const line of spliceReadoutLines(view)) speak({ register: line.register, text: line.text, atMs: Date.now() });
      }
      lastSplicePhase = phase;
      return;
    }
    if (event.kind === "genomeScan") {
      const scan = genomeScanOf(session.state);
      if (scan) for (const line of genomeScanLines(scan)) speak({ register: line.register, text: line.text, atMs: Date.now() });
      return;
    }
    if (event.kind !== "receipt") return;
    if (event.accepted && craftNarrator.wantsRender(event.commandKind) && craftRenderTimer === null) {
      craftRenderTimer = setTimeout(() => {
        craftRenderTimer = null;
        for (const line of craftNarrator.render()) speak({ register: line.register, text: line.text, atMs: Date.now() });
      }, 300);
    }
    if (!converse.active() || event.commandKind === undefined) return;
    if (!(CONVERSE_RECEIPT_KINDS as readonly string[]).includes(event.commandKind)) return;
    for (const line of converse.phraseReceipt(event.commandKind, event.accepted, event.reasonCode)) {
      speak({ register: line.register, text: line.text, atMs: Date.now() });
    }
  });
  const pollTimer = setInterval(() => {
    narrator.poll();
    for (const line of converse.tick()) speak({ register: line.register, text: line.text, atMs: Date.now() });
    for (const line of pursue.tick()) speak({ register: line.register, text: line.text, atMs: Date.now() });
  }, 400);

  let quitting = false;
  const finish = Promise.withResolvers<void>();
  reader.on("close", () => finish.resolve());

  reader.on("line", (raw) => {
    const value = raw.trim();
    if (value.length === 0) {
      if (process.stdin.isTTY) reader.prompt(true);
      return;
    }
    if (value.startsWith("/")) speak({ register: "echo", text: value, atMs: Date.now() });
    const outcome = routeLine({
      session,
      converse,
      confirm,
      pursue,
      craftSession: craftSource,
      groupView: () => session.state.serverAuthority.group,
      tradeSession: tradeSource,
      quitRequested: () => {
        quitting = true;
        reader.close();
      },
    }, value);
    for (const line of outcome.lines) speak({ register: line.register, text: line.text, atMs: Date.now() });
    if (outcome.look) narrator.look();
    if (!quitting && process.stdin.isTTY) reader.prompt(true);
  });

  try {
    await session.start();
    narrator.look();
    if (process.stdin.isTTY) reader.prompt();
    await finish.promise;
    return 0;
  } finally {
    clearInterval(pollTimer);
    detach();
    detachConverse();
    await session.dispose();
  }
}
