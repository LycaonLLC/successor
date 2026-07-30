import { describe, expect, it } from "vitest";

import { createMacroEngine } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import type { ChatSendChannel } from "@successor/client/src/chat/chatClient";

import { TUI_FIXTURE_CHARACTER_ID, createTuiPlayStateFixture } from "../test/fixtures/playState";
import { completionVerbs, routeLine, type RouterContext } from "./commands";
import { createContactTracker } from "./game/contacts";
import { createSurveyStore } from "./game/surveyStore";
import { isCarriedContainer } from "./game/exchangeTrade";
import { createArmedConfirm } from "./game/armedConfirm";
import { createConverseSession } from "./game/converse";
import { createPursuitController } from "./game/pursue";
import type { GameSession } from "./game/session";
import type { Wind } from "./game/bearing";

interface FakeSessionLog {
  chats: Array<{ channel: ChatSendChannel; body: string; targetId?: string }>;
  walks: Array<{ wind: Wind; durationMs: number; sprint: boolean }>;
  stops: number;
}

function fakeSession(): { session: GameSession; calls: FakeSessionLog } {
  const { state, slice } = createTuiPlayStateFixture();
  const registry = createVerbRegistry({ state, slice });
  const macroLibrary = new Map<string, { name: string; body: string }>();
  const macros = createMacroEngine({
    registry,
    macros: {
      getMacro: (name) => macroLibrary.get(name.toLowerCase()) ?? null,
      listMacros: () => [...macroLibrary.values()].map((entry) => ({ name: entry.name })),
    },
  });
  const calls: FakeSessionLog = { chats: [], walks: [], stops: 0 };
  const session: GameSession = {
    state,
    slice,
    registry,
    macros,
    survey: createSurveyStore(),
    tracker: createContactTracker(),
    chat: null,
    defineMacro(name, body) {
      macroLibrary.set(name.trim().toLowerCase(), { name: name.trim(), body });
    },
    removeMacro(name) {
      return macroLibrary.delete(name.trim().toLowerCase());
    },
    listMacroDefs() {
      return [...macroLibrary.values()];
    },
    isCarried(container) {
      return isCarriedContainer(state, container, [TUI_FIXTURE_CHARACTER_ID]);
    },
    async start() {},
    async dispose() {},
    onEvent() {
      return () => {};
    },
    estimatedTick: () => 4512,
    executeVerb: (line) => registry.executeLine(line),
    sendChat(channel, body, targetId) {
      calls.chats.push({ channel, body, ...(targetId ? { targetId } : {}) });
    },
    holdDirection() {},
    walk(wind, durationMs, sprint) {
      calls.walks.push({ wind, durationMs, sprint });
    },
    stopMovement() {
      calls.stops += 1;
    },
    moving: () => false,
    queueEventsSince: (seq) => ({ seq, events: [] }),
  };
  return { session, calls };
}

function context(session: GameSession): RouterContext {
  return {
    session,
    quitRequested: () => {},
    converse: createConverseSession(session.state, session.slice, session.isCarried),
    confirm: createArmedConfirm(),
    pursue: createPursuitController(session),
    craftSession: () => null,
    groupView: () => ({ group: null, members: [], pendingInvite: null }),
    tradeSession: () => null,
  };
}

describe("command router", () => {
  it("bare text speaks on the local channel", () => {
    const { session, calls } = fakeSession();
    const outcome = routeLine(context(session), "anyone near the extractor?");
    expect(outcome.lines).toEqual([]);
    expect(calls.chats).toEqual([{ channel: "local", body: "anyone near the extractor?" }]);
  });

  it("routes /global and /g to shard-wide chat", () => {
    const { session, calls } = fakeSession();
    expect(routeLine(context(session), "/global anyone awake?").lines).toEqual([]);
    expect(routeLine(context(session), "/g found the north gate").lines).toEqual([]);
    expect(calls.chats).toEqual([
      { channel: "global", body: "anyone awake?" },
      { channel: "global", body: "found the north gate" },
    ]);
  });

  it("registry verbs execute and echo their text (query class)", () => {
    const { session } = fakeSession();
    const outcome = routeLine(context(session), "/where");
    expect(outcome.lines).toHaveLength(1);
    expect(outcome.lines[0]!.text).toMatch(/^WHERE open-desert/);
  });

  it("authority verbs queue into the shared command queue", () => {
    const { session } = fakeSession();
    const before = session.state.authorityCommands.pending.length;
    const outcome = routeLine(context(session), "/survey iron");
    expect(outcome.lines[0]!.text).toMatch(/SURVEYING/);
    expect(session.state.authorityCommands.pending.length).toBe(before + 1);
  });
  it("equip-weapon resolves the requested variant when item ids collide", () => {
    const { session } = fakeSession();
    session.state.inventory.push(
      { container: `${TUI_FIXTURE_CHARACTER_ID}:field-pack`, item: "Slugthrower", itemId: 3101, variantId: 11, quantity: 1, reserved: 0, available: 1, stackId: 71 },
      { container: `${TUI_FIXTURE_CHARACTER_ID}:field-pack`, item: "Slugthrower", itemId: 3101, variantId: 22, quantity: 1, reserved: 0, available: 1, stackId: 72 },
    );
    const outcome = routeLine(context(session), "/equip-weapon slugthrower 3101:22");
    expect(outcome.lines[0]!.register).not.toBe("reject");
    expect(session.state.authorityCommands.pending.at(-1)?.command).toMatchObject({
      SetEquippedWeapon: { weapon_item_id: 3101, weapon_variant_id: 22 },
    });
  });

  it("equip-clothing resolves by row and supports unequip", () => {
    const { session } = fakeSession();
    session.state.inventory.push({
      container: `${TUI_FIXTURE_CHARACTER_ID}:field-pack`, item: "Frayed Tunic", itemId: 7201,
      variantId: 60_000_105, quantity: 1, reserved: 0, available: 1, stackId: 73,
    });
    const equip = routeLine(context(session), "/equip-clothing frayed tunic");
    expect(equip.lines[0]!.register).not.toBe("reject");
    expect(session.state.authorityCommands.pending.at(-1)?.command).toMatchObject({
      SetEquippedClothing: {
        container: `${TUI_FIXTURE_CHARACTER_ID}:field-pack`,
        stack_id: "73",
        item_id: 7201,
        variant_id: 60_000_105,
        equipped: true,
      },
    });
    const unequip = routeLine(context(session), "/equip-clothing 7201 off");
    expect(unequip.lines[0]!.register).not.toBe("reject");
    expect(session.state.authorityCommands.pending.at(-1)?.command).toMatchObject({
      SetEquippedClothing: {
        container: `${TUI_FIXTURE_CHARACTER_ID}:field-pack`,
        stack_id: "73",
        item_id: 7201,
        variant_id: 60_000_105,
        equipped: false,
      },
    });
  });

  it("/walk parses winds, seconds and sprint; rejects nonsense", () => {
    const { session, calls } = fakeSession();
    routeLine(context(session), "/walk ne 2 sprint");
    expect(calls.walks).toEqual([{ wind: "north-east", durationMs: 2000, sprint: true }]);
    const bad = routeLine(context(session), "/walk nowhere");
    expect(bad.lines[0]!.text).toMatch(/Walk where/);
  });

  it("/stop halts movement", () => {
    const { session, calls } = fakeSession();
    routeLine(context(session), "/stop");
    expect(calls.stops).toBe(1);
  });

  it("/lootall reach-gates like the 3D loot surface", () => {
    const { session } = fakeSession();
    // fixture corpse-1 at (41,45) vs player (40,44): d≈1.41 ≤ 1.75 → in reach;
    // give the corpse container a streamed stack to strip
    session.state.inventory.push({
      container: "corpse:corpse-1",
      item: "Rogue Carbine",
      itemId: 1101,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
      stackId: 7,
    });
    const outcome = routeLine(context(session), "/lootall");
    expect(outcome.lines[0]!.register).toBe("loot");
    expect(outcome.lines[0]!.text).toMatch(/1 stack/);
    // move the corpse away → out of reach speaks the gate
    session.state.serverAuthority.actors["corpse-1"]!.x = 50;
    const far = routeLine(context(session), "/lootall");
    expect(far.lines[0]!.register).toBe("reject");
    expect(far.lines[0]!.text).toMatch(/step closer/);
  });

  it("/loot all mirrors /lootall take-all", () => {
    const { session } = fakeSession();
    session.state.inventory.push({
      container: "corpse:corpse-1", item: "Rogue Carbine", itemId: 1101,
      variantId: 0, quantity: 1, reserved: 0, available: 1, stackId: 7,
    });
    const outcome = routeLine(context(session), "/loot all");
    expect(outcome.lines[0]!.register).toBe("loot");
    expect(outcome.lines[0]!.text).toMatch(/1 stack/);
  });

  it("/redeem banks the largest carried credit chip and narrates it", () => {
    const { session } = fakeSession();
    session.state.inventory.push({
      container: "loot-probe:field-pack", item: "Credit Chip", itemId: 9002,
      variantId: 0, quantity: 5000, reserved: 0, available: 5000, stackId: 3,
    });
    session.state.inventory.push({
      container: "loot-probe:field-pack", item: "Credit Chip", itemId: 9002,
      variantId: 0, quantity: 250, reserved: 0, available: 250, stackId: 4,
    });
    const outcome = routeLine(context(session), "/redeem");
    expect(outcome.lines[0]!.register).toBe("loot");
    expect(outcome.lines[0]!.text).toMatch(/credit chip into your datapad/);
    expect(outcome.lines[0]!.text).toMatch(/1 chip left/);
    const queued = session.state.authorityCommands.pending.some((envelope) => "RedeemCreditChip" in envelope.command);
    expect(queued).toBe(true);
  });

  it("/redeem with no chip rejects", () => {
    const { session } = fakeSession();
    const outcome = routeLine(context(session), "/redeem");
    expect(outcome.lines[0]!.register).toBe("reject");
  });

  it("/macro def + run + list + stop drive the slice-core engine", () => {
    const { session } = fakeSession();
    const def = routeLine(context(session), "/macro def probe /where ; /pause 1");
    expect(def.lines[0]!.text).toMatch(/stored/);
    const run = routeLine(context(session), "/macro run probe");
    expect(run.lines[0]!.text).toMatch(/running/);
    const list = routeLine(context(session), "/macro list");
    expect(list.lines[0]!.text).toMatch(/probe/);
    const stop = routeLine(context(session), "/macro stop all");
    expect(stop.lines[0]!.text).toMatch(/Stopped 1 run/);
  });

  it("/help <verb> renders the manifest contract (args, aliases, answers)", () => {
    const { session } = fakeSession();
    const outcome = routeLine(context(session), "/help attack");
    const text = outcome.lines.map((line) => line.text).join("\n");
    expect(text).toContain("/attack — authority (QueueCombatAction)");
    expect(text).toContain("action_id=basic_shot|aimed_shot");
    // answers list is manifest-derived — assert the stable shape + one
    // long-lived code, not the full reason vocabulary (it evolves)
    expect(text).toMatch(/answers: .*target_unavailable/);
  });

  it("/commands groups the merged inventory and filters", () => {
    const { session } = fakeSession();
    const outcome = routeLine(context(session), "/commands survey");
    const text = outcome.lines.map((line) => line.text).join("\n");
    expect(text).toContain("/survey");
    expect(text).not.toContain("/attack");
  });

  it("debug-gated verbs never surface in completion or /commands", () => {
    const { session } = fakeSession();
    expect(completionVerbs(session)).not.toContain("debug-give-item");
    const outcome = routeLine(context(session), "/commands debug");
    expect(outcome.lines.map((line) => line.text).join("\n")).not.toContain("debug-give-item");
  });

  it("whispers route with a target; unknown verbs fall through politely", () => {
    const { session, calls } = fakeSession();
    routeLine(context(session), "/w warden quiet deal?");
    expect(calls.chats).toEqual([{ channel: "whisper", body: "quiet deal?", targetId: "warden" }]);
    const unknown = routeLine(context(session), "/frobnicate now");
    expect(unknown.lines[0]!.text).toMatch(/Nothing answers/);
  });

  it("/attack on an out-of-range target starts the pursuit on the SAME verb — walk order out, nothing queued yet", () => {
    const { session, calls } = fakeSession();
    session.slice.combatModel = "roll";
    session.state.serverAuthority.actors["rogue-1"]!.x = 90; // (90,44) vs player (40,44) → 50c, beyond the projected 20c max
    session.state.serverAuthority.actors["rogue-1"]!.y = 44;
    session.tracker.update(session.state);
    const outcome = routeLine(context(session), "/attack rogue-1");
    expect(outcome.lines[0]!.register).toBe("combat");
    expect(outcome.lines[0]!.text).toMatch(/move on|push toward|Boots forward/);
    expect(calls.walks.length).toBeGreaterThan(0);
    expect(calls.walks[0]!.sprint).toBe(false);
    const queuedAttack = session.state.authorityCommands.pending.some((envelope) => "QueueCombatAction" in envelope.command);
    expect(queuedAttack).toBe(false); // the attack fires on arrival, not from 50c out
  });

  it("/attack in range falls through to the registry untouched — exact current behavior", () => {
    const { session, calls } = fakeSession();
    session.slice.combatModel = "roll";
    session.state.serverAuthority.actors["rogue-1"]!.x = 55;
    session.state.serverAuthority.actors["rogue-1"]!.y = 44;
    session.tracker.update(session.state); // 15c ≤ the projected 20c max
    const outcome = routeLine(context(session), "/attack rogue-1");
    expect(outcome.lines[0]!.text).toBe("ATTACK QUEUED");
    expect(calls.walks).toEqual([]);
    const queuedAttack = session.state.authorityCommands.pending.some((envelope) => "QueueCombatAction" in envelope.command);
    expect(queuedAttack).toBe(true);
  });

  it("player movement breaks a live pursuit before it moves — /walk and /stop win instantly", () => {
    const { session, calls } = fakeSession();
    session.slice.combatModel = "roll";
    session.state.serverAuthority.actors["rogue-1"]!.x = 90;
    session.state.serverAuthority.actors["rogue-1"]!.y = 44;
    session.tracker.update(session.state);
    const ctx = context(session);
    routeLine(ctx, "/attack rogue-1");
    expect(ctx.pursue.active()).toBe(true);
    const outcome = routeLine(ctx, "/walk n");
    expect(outcome.lines[0]!.text).toMatch(/break off|let the pursuit go/);
    expect(outcome.lines[1]!.text).toMatch(/You set off north/);
    expect(ctx.pursue.active()).toBe(false);
    expect(calls.stops).toBeGreaterThan(0);
  });

  it("conflicting registry verbs (/peace) break the pursuit, then run", () => {
    const { session } = fakeSession();
    session.slice.combatModel = "roll";
    session.state.serverAuthority.actors["rogue-1"]!.x = 90;
    session.state.serverAuthority.actors["rogue-1"]!.y = 44;
    session.tracker.update(session.state);
    const ctx = context(session);
    routeLine(ctx, "/attack rogue-1");
    expect(ctx.pursue.active()).toBe(true);
    const outcome = routeLine(ctx, "/peace");
    expect(outcome.lines[0]!.text).toMatch(/break off|let the pursuit go/);
    expect(outcome.lines[1]!.text).toBe("STANDING DOWN");
    expect(ctx.pursue.active()).toBe(false);
  });

  it("bare /attack pursues the selected target when it stands beyond the band", () => {
    const { session, calls } = fakeSession();
    session.slice.combatModel = "roll";
    session.state.serverAuthority.actors["rogue-1"]!.x = 90;
    session.state.serverAuthority.actors["rogue-1"]!.y = 44;
    session.state.selectedActorId = "rogue-1";
    session.tracker.update(session.state);
    const outcome = routeLine(context(session), "/attack");
    expect(outcome.lines[0]!.register).toBe("combat");
    expect(calls.walks.length).toBeGreaterThan(0);
  });
});
