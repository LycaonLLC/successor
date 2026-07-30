/**
 * Command router — one grammar for the TUI and --plain.
 *
 * Resolution order (3D chat-line parity, extended):
 *   1. TUI overlay verbs (presentation/locomotion/macro/help — client-side)
 *   2. The shared verb registry (authority / local / query verbs)
 *   3. Chat command fallthrough (/local /zone /w … via the chat hub)
 *   4. Bare text → active chat channel
 */

import type { ChatSendChannel } from "@successor/client/src/chat/chatClient";
import { parseVerbLine } from "@successor/client/src/slice-core/verbRegistry/index";
import {
  authorityIssuedAtServerTick,
  enqueueAuthoritySetEquippedClothingCommand,
  enqueueAuthoritySetEquippedWeaponCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import { isWeaponId } from "@successor/client/src/slice-core/weaponSystem";

import type { ArmedConfirm } from "./game/armedConfirm";
import { routeCamp } from "./game/camp";
import { duelStatusLines } from "./game/duel";
import { routeFarm } from "./game/farm";
import { routeSplice } from "./game/splice";
import { parseWind } from "./game/bearing";
import type { ConverseSession } from "./game/converse";
import { routeCraftFlow, type CraftSessionSource } from "./game/craftFlow";
import { routeGroup, type GroupViewSource } from "./game/groups";
import {
  enqueueRetrieve,
  enqueueStore,
  enqueueProposal,
  enqueueTradeAnswer,
  enqueueTradeCoin,
  enqueueTradeConfirm,
  enqueueTradeItemChange,
  exchangeRows,
  parseTradeLineItem,
  parseTradeProposal,
  renderTradeTable,
  resolveItem,
  type TradeSessionSource,
} from "./game/exchangeTrade";
import {
  bestBatteryRow,
  batteryRuntimeSeconds,
  enqueueExtractorOrder,
  extractorLine,
  formatBatteryRuntime,
  listExtractors,
  resolveExtractor,
} from "./game/extractors";
import { lootAll } from "./game/loot";
import { redeemLargestChip } from "./game/credits";
import type { PursuitController } from "./game/pursue";
import type { GameSession } from "./game/session";
import {
  enqueuePurchase,
  enqueueUseTicket,
  listTickets,
  nearestTerminal,
  resolveDestination,
  travelDestinations,
} from "./game/travel";
import { canonicalFamily } from "./game/session";
import { reasonCopy } from "./language/copy";

export interface CommandLineOut {
  register: string;
  text: string;
}

export interface CommandOutcome {
  lines: CommandLineOut[];
  quit?: boolean;
  /** Set when the router wants a full scene block spoken (e.g. /look). */
  look?: boolean;
}

const CHAT_CHANNEL_VERBS: Record<string, ChatSendChannel> = {
  say: "local",
  local: "local",
  zone: "zone",
  global: "global",
  g: "global",
  trade: "trade",
  party: "party",
  guild: "guild",
};

/**
 * Registry verbs whose execution conflicts with a live pursuit (movement,
 * stance, posture — as typed, aliases included). The pursuit breaks first;
 * the command then runs. /walk //stop /attack and WASD interrupt at their
 * own seams.
 */
const PURSUIT_CONFLICTING_VERBS = new Set([
  "move", "move-intent", "set-move-intent", "peace", "posture", "set-posture", "kneel", "stand",
]);

export const OVERLAY_VERBS = [
  "help", "commands", "look", "walk", "stop", "loot", "lootall", "harvest-all", "redeem",
  "macro", "receipts", "say", "local", "zone", "global", "g", "trade", "party", "guild",
  "w", "whisper", "friend", "status", "snap", "quit", "exit",
  "converse", "extractors", "extractor", "travel", "exchange", "craft", "group", "farm",
] as const;

export interface RouterContext {
  session: GameSession;
  /** Presentation seams the app owns. */
  quitRequested: () => void;
  /** Live conversation (digit selection while active). */
  converse: ConverseSession;
  /** Destructive-action armed-confirm (packup / craft cancel). */
  confirm: ArmedConfirm;
  /** Live craft-session channel (serverAuthority.craftSession). */
  craftSession: CraftSessionSource;
  /** Live per-observer group channel (serverAuthority.group). */
  groupView: GroupViewSource;
  /** Live double-lock trade table (serverAuthority.tradeSession). */
  tradeSession: TradeSessionSource;
  /** Auto-approach: /attack pursues out-of-range targets (pursue.ts). */
  pursue: PursuitController;
}

export function routeLine(context: RouterContext, rawLine: string): CommandOutcome {
  const line = rawLine.trim();
  if (line.length === 0) return { lines: [] };

  // live conversation: bare digits select numbered options (MUD convention)
  if (context.converse.active() && /^\d{1,2}$/.test(line)) {
    return { lines: context.converse.select(Number(line)) };
  }

  if (!line.startsWith("/")) {
    context.session.sendChat("local", line);
    return { lines: [] };
  }

  const parsed = parseVerbLine(line);
  if (!parsed) return { lines: [{ register: "system", text: "Say again?" }] };

  // any slash input disarms a pending destructive confirm (except the
  // confirming repeat itself, which routeOverlay consumes first)
  const overlay = routeOverlay(context, parsed.verb, parsed.args);
  if (overlay) return overlay;
  context.confirm.disarm();

  // conflicting registry verbs break a live pursuit BEFORE they run — the
  // player's hand always wins instantly (movement, stance, posture)
  const interruptLines = PURSUIT_CONFLICTING_VERBS.has(parsed.verb) ? context.pursue.interrupt("command") : [];

  const result = context.session.executeVerb(line);
  if (result) {
    const register = result.class === "authority"
      ? (result.data.queued === false && result.data.error ? "reject" : "receipt")
      : result.class === "query" ? "system" : "system";
    return { lines: [...interruptLines, { register, text: result.text }] };
  }

  // chat fallthrough — unknown verbs travel to the hub like the 3D chat line
  return routeChatCommand(context, parsed.verb, parsed.args, line);
}


function lootAllOutcome(context: RouterContext, requestedId: string | undefined): CommandOutcome {
  const { session } = context;
  const result = lootAll(session.state, session.slice, requestedId);
  if (result.reason === "no_target") return { lines: [{ register: "reject", text: "No lootable body in scope." }] };
  if (result.reason === "out_of_reach") {
    return { lines: [{ register: "reject", text: `${result.target!.label} is ${result.target!.distanceCells.toFixed(1)}c away — step closer (reach 1.75c).` }] };
  }
  if (result.reason === "no_rights") return { lines: [{ register: "reject", text: "That kill is not yours to strip." }] };
  if (result.reason === "empty") return { lines: [{ register: "system", text: `${result.target!.label} has nothing left worth taking.` }] };
  return { lines: [{ register: "loot", text: `You strip ${result.target!.label} — ${result.queued} stack${result.queued === 1 ? "" : "s"} claimed.` }] };
}

function routeOverlay(context: RouterContext, verb: string, args: readonly string[]): CommandOutcome | null {
function parseItemVariant(token: string | undefined, explicit: string | undefined): { item: string; variantId?: number } {
  const raw = (token ?? "").trim();
  const match = /^(.+?)(?:[@:#](\d+))$/u.exec(raw);
  const candidate = explicit ?? match?.[2];
  const variantId = candidate !== undefined && /^\d+$/u.test(candidate) ? Number(candidate) : undefined;
  return { item: (match?.[1] ?? raw).trim(), variantId };
}

function routeEquipment(context: RouterContext, verb: string, args: readonly string[]): CommandOutcome {
  const { session } = context;
  if (verb === "equip-weapon" || verb === "set-equipped-weapon") {
    const weaponId = args[0];
    if (!weaponId) return { lines: [{ register: "system", text: "Equip with /equip-weapon <weapon> [item|item:variant]." }] };
    if (!isWeaponId(weaponId)) return { lines: [{ register: "reject", text: `Unknown weapon «${weaponId}».` }] };
    const parsed = parseItemVariant(args[1], args[2]?.replace(/^variant_id=/u, ""));
    if (!parsed.item) {
      const result = session.executeVerb(`/set-equipped-weapon weapon_id=${weaponId}`);
      return result ? { lines: [{ register: result.class === "authority" && result.data.queued === false ? "reject" : "receipt", text: result.text }] } : { lines: [{ register: "reject", text: "Nothing answers — weapon equip is unavailable." }] };
    }
    const variant = parsed.variantId;
    const resolved = resolveItem(session.state, parsed.item, (row) => session.isCarried(row.container)
      && (variant === undefined || row.variantId === variant));
    if (!resolved) return { lines: [{ register: "reject", text: `No carried weapon stack answers to «${parsed.item}».` }] };
    enqueueAuthoritySetEquippedWeaponCommand(
      session.state.authorityCommands,
      authorityIssuedAtServerTick(session.state, session.slice.tickRateHz, session.slice.tick),
      weaponId,
      resolved.row.itemId,
      resolved.row.variantId,
    );
    return { lines: [{ register: "receipt", text: "SET-EQUIPPED-WEAPON QUEUED" }] };
  }

  const parsed = parseItemVariant(args[0], args[2]?.replace(/^variant_id=/u, ""));
  const mode = (args[1] ?? "true").toLowerCase();
  const equipped = mode !== "off" && mode !== "false" && mode !== "unequip";
  if (!parsed.item) return { lines: [{ register: "system", text: "Equip with /equip-clothing <item|item:variant> [on|off]." }] };
  const variant = parsed.variantId;
  const resolved = resolveItem(session.state, parsed.item, (row) => session.isCarried(row.container)
    && (variant === undefined || row.variantId === variant));
  if (!resolved) return { lines: [{ register: "reject", text: `No carried clothing stack answers to «${parsed.item}».` }] };
  enqueueAuthoritySetEquippedClothingCommand(
    session.state.authorityCommands,
    authorityIssuedAtServerTick(session.state, session.slice.tickRateHz, session.slice.tick),
    resolved.row.itemId,
    equipped,
    resolved.row.stackId !== undefined ? String(resolved.row.stackId) : undefined,
    resolved.row.variantId,
    resolved.row.container,
  );
  return { lines: [{ register: "receipt", text: "SET-EQUIPPED-CLOTHING QUEUED" }] };
}

  const { session } = context;
  switch (verb) {
    case "equip-weapon":
    case "set-equipped-weapon":
    case "equip-clothing":
    case "set-equipped-clothing":
      return routeEquipment(context, verb, args);
    case "quit":
    case "exit": {
      context.quitRequested();
      return { lines: [{ register: "system", text: "Folding the terminal…" }], quit: true };
    }
    case "look": {
      return { lines: [], look: true };
    }
    case "snap": {
      // The full TUI intercepts /snap before routing (frame capture is
      // presentation-owned); reaching here means line mode has no frame.
      return { lines: [{ register: "system", text: "Nothing to snapshot in line mode." }] };
    }
      // Out-of-range targets pursue first (walk-up → engage from the band);
      // in-range and unresolvable forms fall through to the registry verb.
    case "attack": {
      const lines = context.pursue.beginAttack(args);
      return lines ? { lines } : null;
    }
    case "walk": {
      const wind = args[0] ? parseWind(args[0]) : null;
      if (!wind) return { lines: [{ register: "system", text: "Walk where? /walk <n|ne|e|se|s|sw|w|nw> [seconds] [sprint]" }] };
      const interrupted = context.pursue.interrupt("movement");
      const seconds = args[1] !== undefined && Number.isFinite(Number(args[1])) ? Math.max(0.1, Number(args[1])) : 1.5;
      const sprint = args.includes("sprint");
      session.walk(wind, seconds * 1000, sprint);
      return { lines: [...interrupted, { register: "system", text: `You set off ${wind}${sprint ? ", moving fast" : ""}.` }] };
    }
    case "stop": {
      const interrupted = context.pursue.interrupt("movement");
      session.stopMovement();
      return { lines: [...interrupted, { register: "system", text: "You stop." }] };
    }
    case "loot": {
      // `/loot all` (or bare `/loot`) is take-all parity with the 3D HOLD-F
      // gesture; a specific `/loot <container> <item> <variant> <qty>` falls
      // through to the registry's per-stack TakeLootItem verb (return null).
      if (args.length > 0 && args[0]!.toLowerCase() !== "all") return null;
      return lootAllOutcome(context, args[0]?.toLowerCase() === "all" ? args[1] : undefined);
    }
    case "lootall":
    case "harvest-all": {
      return lootAllOutcome(context, args[0]);
    }
    case "redeem":
    case "redeem-chip": {
      const result = redeemLargestChip(session.state, session.slice);
      if (result.reason === "no_chip") {
        return { lines: [{ register: "reject", text: "No credit chip in your pack to redeem." }] };
      }
      const remaining = result.remainingChips > 0
        ? ` (${result.remainingChips} chip${result.remainingChips === 1 ? "" : "s"} left, ${result.remainingValue.toLocaleString()} credits)`
        : "";
      return {
        lines: [{
          register: "loot",
          text: `You slot a ${result.value.toLocaleString()}-credit chip into your datapad — the balance ticks up${remaining}.`,
        }],
      };
    }
    case "converse": {
      return { lines: context.converse.open(args.join(" ").trim() || undefined) };
    }
    case "extractors": {
      const views = listExtractors(session.state);
      if (views.length === 0) return { lines: [{ register: "system", text: "No extractors in this stretch of ground." }] };
      return { lines: views.map((view) => ({ register: view.extractor.isOwner ? "survey" : "system", text: extractorLine(view) })) };
    }
    case "extractor": {
      return routeExtractor(context, args);
    }
    case "travel": {
      return routeTravel(context, args);
    }
    case "exchange": {
      return routeExchange(context, args);
    }
    case "craft": {
      // CONTRACTS-LIVE (CraftSimW67): session ops ride the generated craft
      // verbs; rendering consumes the craftSession VM the moment the client
      // ingest lands (injected source — no fabricated screens before that).
      return { lines: routeCraftFlow(session, context.confirm, context.craftSession, args) };
    }
    case "group": {
      return { lines: routeGroup(session, context.groupView, args) };
    }
    case "duel": {
      return routeDuel(context, args);
    }
    case "camp": {
      return { lines: routeCamp(session, context.confirm, args) };
    }
    case "splice": {
      return { lines: routeSplice(session, args) };
    }
    case "farm": {
      return { lines: routeFarm(session, args) };
    }
    case "trade": {
      const sub = (args[0] ?? "").toLowerCase();
      if (sub === "propose" || sub === "accept" || sub === "decline" || sub === "confirm" || sub === "add" || sub === "remove" || sub === "credits" || sub === "coin") {
        return routeTrade(context, sub, args.slice(1));
      }
      // anything else is the trade CHANNEL (talk), established sandbox-style
      const body = args.join(" ");
      if (body.length === 0) {
        const table = context.tradeSession();
        if (table) return { lines: renderTradeTable(table, tradePartnerName(session, table.partnerActorId)) };
        return { lines: [{ register: "system", text: "Trade: /trade propose <partner> give <item:qty…> for <item:qty…> · /trade accept|confirm|decline <id> · /trade add|remove <id> <item:qty> · /trade credits <id> <n> · /trade <message> talks the channel. Accept locks your side; any change clears both locks; both confirm to seal. Bare /trade shows the live table." }] };
      }
      session.sendChat("trade", body);
      return { lines: [] };
    }
    case "macro": {
      return routeMacro(session, args);
    }
    case "receipts": {
      const n = args[0] !== undefined && Number.isFinite(Number(args[0])) ? Math.max(1, Math.trunc(Number(args[0]))) : 8;
      const log = session.state.serverAuthority.receiptLog.slice(-n);
      if (log.length === 0) return { lines: [{ register: "system", text: "No receipts yet." }] };
      return {
        lines: log.map((receipt) => ({
          register: receipt.accepted ? "system" : "reject",
          text: `#${receipt.commandId} t${receipt.tick} ${receipt.accepted ? "accepted" : `rejected ${reasonCopy(receipt.reasonCode ?? "")}`}`,
        })),
      };
    }
    case "help": {
      return routeHelp(session, args);
    }
    case "commands": {
      return routeCommands(session, args);
    }
    default:
      return null;
  }
}

function routeMacro(session: GameSession, args: readonly string[]): CommandOutcome {
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "def" || sub === "define") {
    const name = args[1];
    const body = args.slice(2).join(" ");
    if (!name || body.length === 0) {
      return { lines: [{ register: "system", text: "Define with /macro def <name> <body> (chain with ;)." }] };
    }
    session.defineMacro(name, body);
    return { lines: [{ register: "system", text: `Macro «${name}» stored (${body.length}b).` }] };
  }
  if (sub === "run") {
    const name = args[1];
    if (!name) return { lines: [{ register: "system", text: "Run what? /macro run <name> [args…]" }] };
    const started = session.macros.startMacro({ name, args: args.slice(2) });
    return started.ok
      ? { lines: [{ register: "system", text: `Macro «${name}» running (${started.runId}).` }] }
      : { lines: [{ register: "reject", text: `Macro «${name}» refused — ${reasonCopy(started.reasonCode)}.` }] };
  }
  if (sub === "stop" || sub === "dump") {
    const target = args[1] ?? "all";
    const stopped = session.macros.stopMacro(target);
    return { lines: [{ register: "system", text: stopped > 0 ? `Stopped ${stopped} run${stopped === 1 ? "" : "s"}.` : "Nothing running." }] };
  }
  if (sub === "list" || sub === "") {
    const defs = session.listMacroDefs();
    const runs = session.macros.listRuns();
    const lines: CommandLineOut[] = [];
    lines.push({
      register: "system",
      text: defs.length === 0 ? "No macros defined. /macro def <name> <body>" : `Macros: ${defs.map((def) => def.name).join(", ")}`,
    });
    for (const run of runs) {
      lines.push({ register: "system", text: `  ▸ ${run.name} — ${run.status}${run.wait ? ` (${run.wait})` : ""}` });
    }
    return { lines };
  }
  // bare /macro <name> runs it, established sandbox-style
  const started = session.macros.startMacro({ name: sub, args: args.slice(1) });
  return started.ok
    ? { lines: [{ register: "system", text: `Macro «${sub}» running.` }] }
    : { lines: [{ register: "reject", text: `Macro «${sub}» refused — ${reasonCopy(started.reasonCode)}.` }] };
}

function routeHelp(session: GameSession, args: readonly string[]): CommandOutcome {
  const topic = args[0]?.replace(/^\//, "").toLowerCase();
  if (!topic) {
    return {
      lines: [
        { register: "help", text: "The world answers verbs. Movement: WASD holds a bearing, /walk <dir> [s], /stop. Fighting: /target nearest hostile · /attack (walks up out-of-range targets and engages from the weapon's band — any movement breaks it off) · /peace." },
        { register: "help", text: "Ground: /survey [family] · /sample [family] · /loot all · /redeem · /harvest <corpse> · /extractors + /extractor place|crank|battery|collect|packup. Knowledge: /where /vitals /inv /nearby /queue /budget /receipts." },
        { register: "help", text: "People & goods: /converse [trainer] (numbers answer) · /trade propose|accept|decline · /exchange store|retrieve|list · /travel list|buy|use. Macros: /macro def|run|stop. Social: plain text speaks locally; /zone /global /party /guild /w <who> <msg>." },
        { register: "help", text: "Panes: Tab cycles focus · PgUp/PgDn scroll the log · Ctrl+L repaints · /help <verb> for any verb's arguments · /commands [filter] lists everything." },
      ],
    };
  }
  const entry = session.registry.resolve(topic);
  if (!entry) return { lines: [{ register: "system", text: `No verb «${topic}». Try /commands.` }] };
  const argText = entry.argSchema.length === 0
    ? "no arguments"
    : entry.argSchema.map((arg) => {
      const name = arg.enumValues && arg.enumValues.length > 0 ? `${arg.name}=${arg.enumValues.join("|")}` : arg.name;
      return arg.required ? `<${name}>` : `[${name}]`;
    }).join(" ");
  const lines: CommandLineOut[] = [
    { register: "help", text: `/${entry.verb} — ${entry.class}${entry.commandKind ? ` (${entry.commandKind})` : ""} · ${argText}` },
  ];
  if (entry.aliases.length > 0) lines.push({ register: "help", text: `  aliases: ${entry.aliases.map((alias) => `/${alias}`).join(" ")}` });
  if (entry.durableIntent) lines.push({ register: "help", text: `  durable intent: ${entry.durableIntent.kind} — ${entry.durableIntent.notes}` });
  if (entry.reasonCodes && entry.reasonCodes.length > 0) {
    // the universal wire prelude hides the informative per-command answers
    const informative = entry.reasonCodes.filter((code) => !UNIVERSAL_REASONS[code]);
    const shown = informative.length > 0 ? informative : entry.reasonCodes;
    lines.push({ register: "help", text: `  answers: ${shown.slice(0, 10).join(", ")}${shown.length > 10 ? "…" : ""}` });
  }
  return { lines };
}

function routeCommands(session: GameSession, args: readonly string[]): CommandOutcome {
  const filter = (args[0] ?? "").toLowerCase();
  const groups: Array<{ label: string; verbs: string[] }> = [
    { label: "authority", verbs: session.registry.authorityEntries().filter((entry) => !entry.debugGated).map((entry) => entry.verb) },
    { label: "local", verbs: session.registry.localEntries().map((entry) => entry.verb) },
    { label: "query", verbs: session.registry.queryEntries().map((entry) => entry.verb) },
    { label: "terminal", verbs: [...OVERLAY_VERBS] },
  ];
  const lines: CommandLineOut[] = [];
  for (const group of groups) {
    const verbs = group.verbs.filter((verb) => verb.includes(filter)).sort();
    if (verbs.length === 0) continue;
    lines.push({ register: "help", text: `${group.label}: ${verbs.map((verb) => `/${verb}`).join(" ")}` });
  }
  if (lines.length === 0) lines.push({ register: "system", text: `Nothing matches «${filter}».` });
  return { lines };
}

function routeExtractor(context: RouterContext, args: readonly string[]): CommandOutcome {
  const { session, confirm } = context;
  const state = session.state;
  const sub = (args[0] ?? "").toLowerCase();
  const usage = "Extractor: /extractor place [family] · crank [n] · stop · battery [n] · collect [n] · packup [n] — /extractors lists.";

  if (sub === "" || sub === "help") return { lines: [{ register: "system", text: usage }] };

  if (sub === "place") {
    confirm.disarm();
    const family = canonicalFamily(args[1]);
    const queued = enqueueExtractorOrder(state, session.slice, { kind: "place", family });
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? `You look for honest ground to set the ${family} rig…` : "The rig never leaves your pack." }] };
  }
  if (sub === "stop" || sub === "stop-crank") {
    confirm.disarm();
    const queued = enqueueExtractorOrder(state, session.slice, { kind: "stop-crank" });
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? "You ease off the crank…" : "Nothing to let go of." }] };
  }

  const view = resolveExtractor(state, args[1]);
  if (!view) return { lines: [{ register: "reject", text: "No rig answers to that — /extractors lists what stands here." }] };
  if (!view.extractor.isOwner) return { lines: [{ register: "reject", text: "NOT YOUR RIG — that one belongs to another prospector." }] };
  if (!view.inReach && sub !== "packup") {
    return { lines: [{ register: "system", text: `Your rig is ${view.distanceCells.toFixed(1)}c off — step within 1.5c.` }] };
  }

  switch (sub) {
    case "crank": {
      confirm.disarm();
      const queued = enqueueExtractorOrder(state, session.slice, { kind: "crank", view });
      return { lines: [{ register: queued ? "system" : "reject", text: queued ? "You take hold of the crank…" : "Your hands find nothing to turn." }] };
    }
    case "battery": {
      confirm.disarm();
      const row = bestBatteryRow(state, (container) => session.isCarried(container));
      if (!row) return { lines: [{ register: "reject", text: "NO BATTERY — nothing charged in your pack." }] };
      const queued = enqueueExtractorOrder(state, session.slice, { kind: "battery", view, row });
      const charge = formatBatteryRuntime(batteryRuntimeSeconds(row.variantId));
      return { lines: [{ register: queued ? "system" : "reject", text: queued ? `You pull the ${charge} battery and seat it…` : "The battery won't seat." }] };
    }
    case "collect": {
      confirm.disarm();
      const queued = enqueueExtractorOrder(state, session.slice, { kind: "collect", view });
      return { lines: [{ register: queued ? "system" : "reject", text: queued ? "You open the hopper…" : "The hopper latch won't give." }] };
    }
    case "packup":
    case "destroy": {
      if (!view.inReach) {
        return { lines: [{ register: "system", text: `Your rig is ${view.distanceCells.toFixed(1)}c off — step within 1.5c.` }] };
      }
      if (view.extractor.mode === "manual") {
        return { lines: [{ register: "reject", text: "RIG BUSY — release the crank before packing up." }] };
      }
      const key = `packup:${view.extractor.extractorId}`;
      if (view.extractor.hopperPct > 0 && confirm.arm(key)) {
        return {
          lines: [{
            register: "reject",
            text: `Packing up forfeits the hopper (${view.extractor.hopperPct}% held). Repeat /extractor packup within 10s to break it down anyway.`,
          }],
        };
      }
      confirm.confirm(key);
      const queued = enqueueExtractorOrder(state, session.slice, { kind: "destroy", view });
      return { lines: [{ register: queued ? "system" : "reject", text: queued ? "You start breaking the rig down…" : "The rig resists you." }] };
    }
    default:
      return { lines: [{ register: "system", text: usage }] };
  }
}

function routeTravel(context: RouterContext, args: readonly string[]): CommandOutcome {
  const { session } = context;
  const state = session.state;
  const sub = (args[0] ?? "list").toLowerCase();

  if (sub === "list") {
    const lines: CommandLineOut[] = [];
    const destinations = travelDestinations(session.slice);
    if (destinations.length === 0) {
      lines.push({ register: "system", text: "No travel catalog on this shard." });
    } else {
      lines.push({ register: "help", text: "Destinations:" });
      destinations.forEach((destination, index) => {
        lines.push({ register: "system", text: `  ${index + 1}. ${destination.planet.label} — ${destination.city.label} (${destination.planet.biome})` });
      });
    }
    const tickets = listTickets(state);
    if (tickets.length > 0) {
      lines.push({ register: "help", text: "Your tickets:" });
      for (const ticket of tickets) {
        lines.push({ register: "system", text: `  ${ticket.index}. ${ticket.ticket.toPlanetId} → ${ticket.ticket.toCityId} ×${ticket.row.available}` });
      }
    }
    const terminal = nearestTerminal(state, session.slice);
    lines.push({
      register: "system",
      text: terminal
        ? `${terminal.label}: ${terminal.inReach ? "at hand" : `${terminal.distanceCells.toFixed(0)}c away`}.`
        : "No travel terminal in this area.",
    });
    return { lines };
  }

  if (sub === "buy") {
    if (!args[1]) return { lines: [{ register: "system", text: "Buy passage where? /travel buy <planet> [city]" }] };
    const destination = resolveDestination(session.slice, args[1], args[2]);
    if (!destination) return { lines: [{ register: "reject", text: "No line runs there — /travel list shows the board." }] };
    const terminal = nearestTerminal(state, session.slice);
    if (!terminal) return { lines: [{ register: "reject", text: "No travel terminal in this area." }] };
    if (!terminal.inReach) return { lines: [{ register: "system", text: `${terminal.label} is ${terminal.distanceCells.toFixed(0)}c away — get to the counter.` }] };
    const queued = enqueuePurchase(state, session.slice, terminal, destination);
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? `You ask for passage to ${destination.city.label}, ${destination.planet.label}…` : "The clerk ignores you." }] };
  }

  if (sub === "use") {
    const tickets = listTickets(state);
    if (tickets.length === 0) return { lines: [{ register: "reject", text: "You hold no tickets." }] };
    const index = args[1] !== undefined ? Number(args[1]) : 1;
    const ticket = Number.isInteger(index) && index >= 1 && index <= tickets.length ? tickets[index - 1]! : null;
    if (!ticket) return { lines: [{ register: "reject", text: `No ticket ${args[1]} — /travel list numbers them.` }] };
    const queued = enqueueUseTicket(state, session.slice, ticket);
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? "You hand the ticket over…" : "The ticket won't scan." }] };
  }

  return { lines: [{ register: "system", text: "Travel: /travel list · /travel buy <planet> [city] · /travel use [n]" }] };
}

function routeExchange(context: RouterContext, args: readonly string[]): CommandOutcome {
  const { session } = context;
  const state = session.state;
  const sub = (args[0] ?? "list").toLowerCase();

  if (sub === "list") {
    const rows = exchangeRows(state);
    if (rows.length === 0) return { lines: [{ register: "system", text: "Your exchange ledger is empty." }] };
    return {
      lines: [
        { register: "help", text: "Exchange ledger:" },
        ...rows.map((row, index) => ({ register: "system", text: `  ${index + 1}. ${row.item} ×${row.available}` })),
      ],
    };
  }

  const itemToken = args[1];
  if (!itemToken) return { lines: [{ register: "system", text: "Exchange: /exchange store <item> [qty] · /exchange retrieve <item|n> [qty] · /exchange list" }] };
  const quantity = args[2] !== undefined && Number.isFinite(Number(args[2])) ? Math.max(1, Math.trunc(Number(args[2]))) : 1;

  if (sub === "store") {
    const resolved = resolveItem(state, itemToken, (row) => session.isCarried(row.container));
    if (!resolved) return { lines: [{ register: "reject", text: `Nothing carried answers to «${itemToken}».` }] };
    const queued = enqueueStore(state, session.slice, resolved.row, Math.min(quantity, resolved.row.available));
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? `You hand ${resolved.label} ×${Math.min(quantity, resolved.row.available)} across the counter…` : "The clerk waves it back." }] };
  }

  if (sub === "retrieve") {
    const rows = exchangeRows(state);
    const numeric = Number(itemToken);
    const row = Number.isInteger(numeric) && numeric >= 1 && numeric <= rows.length
      ? rows[numeric - 1]!
      : resolveItem(state, itemToken, (candidate) => candidate.container === "district-exchange")?.row ?? null;
    if (!row) return { lines: [{ register: "reject", text: `Nothing in the ledger answers to «${itemToken}».` }] };
    const queued = enqueueRetrieve(state, session.slice, row, Math.min(quantity, row.available));
    return { lines: [{ register: queued ? "system" : "reject", text: queued ? `You call ${row.item} ×${Math.min(quantity, row.available)} back from the ledger…` : "The clerk shakes his head." }] };
  }

  return { lines: [{ register: "system", text: "Exchange: /exchange store <item> [qty] · /exchange retrieve <item|n> [qty] · /exchange list" }] };
}

function routeTrade(
  context: RouterContext,
  sub: "propose" | "accept" | "decline" | "confirm" | "add" | "remove" | "credits" | "coin",
  args: readonly string[],
): CommandOutcome {
  const { session } = context;
  const state = session.state;

  if (sub === "propose") {
    const parsed = parseTradeProposal(state, args, (container) => session.isCarried(container));
    if ("error" in parsed) return { lines: [{ register: "system", text: parsed.error }] };
    const partner = resolveTradePartner(session, parsed.partnerToken);
    if (!partner) return { lines: [{ register: "reject", text: `No one in scope answers to «${parsed.partnerToken}».` }] };
    const queued = enqueueProposal(state, session.slice, partner.id, parsed);
    if (!queued) return { lines: [{ register: "reject", text: "The offer dies in your hands." }] };
    return {
      lines: [{
        register: "system",
        text: `You offer ${partner.label}: ${parsed.offer.echo} — asking ${parsed.request.echo}. (Escrow holds your side until they answer.)`,
      }],
    };
  }

  const proposalId = Number(args[0]);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    return { lines: [{ register: "system", text: `Which offer? /trade ${sub} <proposal-id> (the id arrives with the offer).` }] };
  }

  if (sub === "add" || sub === "remove") {
    const parsed = parseTradeLineItem(state, args.slice(1), (container) => session.isCarried(container));
    if ("error" in parsed) return { lines: [{ register: "system", text: parsed.error }] };
    const queued = enqueueTradeItemChange(state, session.slice, sub === "add", proposalId, parsed.item);
    if (!queued) return { lines: [{ register: "reject", text: "The table refuses the move." }] };
    return {
      lines: [{
        register: "system",
        text: sub === "add"
          ? `You set ${parsed.echo} on the table — both locks clear.`
          : `You take ${parsed.echo} back off the table — both locks clear.`,
      }],
    };
  }

  if (sub === "credits" || sub === "coin") {
    const amount = Number(args[1]);
    if (!Number.isInteger(amount) || amount < 0) {
      return { lines: [{ register: "system", text: "How much? /trade credits <id> <amount> (0 clears your credits)." }] };
    }
    const queued = enqueueTradeCoin(state, session.slice, proposalId, amount);
    if (!queued) return { lines: [{ register: "reject", text: "The credits stay in your wallet." }] };
    return {
      lines: [{
        register: "system",
        text: amount === 0
          ? "You clear your credits from the table — both locks clear."
          : `You put ${amount} credits on the table — both locks clear.`,
      }],
    };
  }

  if (sub === "confirm") {
    const queued = enqueueTradeConfirm(state, session.slice, proposalId);
    if (!queued) return { lines: [{ register: "reject", text: "Your hand stays up." }] };
    return { lines: [{ register: "system", text: "You bring your hand down — when both hands are down, the goods change hands." }] };
  }

  const queued = enqueueTradeAnswer(state, session.slice, sub === "accept", proposalId);
  return {
    lines: [{
      register: queued ? "system" : "reject",
      text: queued
        ? (sub === "accept"
          ? "You lock your side of the bargain — locked both sides, /trade confirm seals it. Any change to the table clears the locks."
          : "You turn the offer down…")
        : "No answer leaves you.",
    }],
  };
}

/** Partner display name for table/narration — AOI label, falling back to the id. */
export function tradePartnerName(session: GameSession, actorId: string): string {
  const actor = session.state.serverAuthority.actors[actorId];
  return actor?.label ?? actor?.displayName ?? actorId;
}

function resolveTradePartner(session: GameSession, token: string): { id: string; label: string } | null {
  const needle = token.trim().toLowerCase();
  for (const contact of session.tracker.contacts()) {
    if (contact.id.toLowerCase() === needle || contact.label.toLowerCase().includes(needle)) {
      return { id: contact.id, label: contact.label };
    }
  }
  return null;
}

/**
 * /duel — consensual 1v1 (DuelSim tags 90-93): challenge by contact name,
 * accept/decline the pending challenge, yield for the honorable end.
 * Rides the generated duel verbs; consent + outcome are receipt truth.
 */
function routeDuel(context: RouterContext, args: readonly string[]): CommandOutcome {
  const { session } = context;
  const sub = (args[0] ?? "").toLowerCase();
  if (sub === "" || sub === "status") {
    return { lines: duelStatusLines(session.state, session.estimatedTick(), session.slice.tickRateHz) };
  }
  if (sub === "accept" || sub === "decline" || sub === "yield") {
    const result = session.executeVerb(`/duel-${sub}`);
    if (!result) return { lines: [{ register: "reject", text: "Nothing answers — this shard predates duels." }] };
    const rejected = result.class === "authority" && result.data.queued === false;
    return { lines: [{ register: rejected ? "reject" : "receipt", text: result.text }] };
  }
  const token = args.join(" ").trim();
  const target = resolveTradePartner(session, token);
  if (!target) return { lines: [{ register: "reject", text: `No one in scope answers to «${token}».` }] };
  const result = session.executeVerb(`/duel-challenge target_actor_id=${target.id}`);
  if (!result) return { lines: [{ register: "reject", text: "Nothing answers — this shard predates duels." }] };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { lines: [{ register: rejected ? "reject" : "receipt", text: result.text }] };
}

function routeChatCommand(context: RouterContext, verb: string, args: readonly string[], line: string): CommandOutcome {
  const { session } = context;
  const channel = CHAT_CHANNEL_VERBS[verb];
  if (channel) {
    const body = args.join(" ");
    if (body.length === 0) return { lines: [{ register: "system", text: `Say what? /${verb} <message>` }] };
    session.sendChat(channel, body);
    return { lines: [] };
  }
  if (verb === "w" || verb === "whisper") {
    const target = args[0];
    const body = args.slice(1).join(" ");
    if (!target || body.length === 0) return { lines: [{ register: "system", text: "Whisper who? /w <player> <message>" }] };
    session.sendChat("whisper", body, target);
    return { lines: [] };
  }
  if (session.chat) {
    // remaining chat-hub commands (/friend, /status …) ride the hub's own parser
    session.chat.submitLine(line);
    return { lines: [] };
  }
  return { lines: [{ register: "system", text: `Nothing answers to /${verb}. Try /commands.` }] };
}

/** Merged verb names for tab-completion (registry + overlay). */
export function completionVerbs(session: GameSession): string[] {
  const names = new Set<string>();
  for (const entry of session.registry.entries()) {
    if (entry.debugGated) continue;
    names.add(entry.verb);
    for (const alias of entry.aliases) names.add(alias);
  }
  for (const verb of OVERLAY_VERBS) names.add(verb);
  return [...names];
}

/** Reason codes every command shares — noise in a per-verb help card. */
const UNIVERSAL_REASONS: Record<string, true> = {
  wrong_session: true,
  wrong_player: true,
  duplicate_command: true,
  unknown_actor: true,
  ingress_budget_exhausted: true,
};
