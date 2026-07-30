import { describe, expect, it } from "vitest";

import { createAuthorityCommandQueue, enqueueAuthoritySurveyResourceCommand } from "../authorityCommandSystem";
import { createPlayState, type PlayState, type ServerAuthorityActorState, type SliceSnapshot } from "../gameState";
import { resourceTaxonomyEntries } from "../resourceTaxonomy";
import {
  createVerbRegistry,
  generatedAuthorityVerbRows,
  generatedCommandManifest,
  generatedVerbTable,
  type VerbRegistryContext,
  type VerbRegistry,
  type VerbExecutionResult,
} from "./index";

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 10,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [{ id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    factions: [
      { id: "desert_wardens", label: "Warden", enemies: ["rogue_troopers"] },
      { id: "rogue_troopers", label: "Rogues", enemies: ["desert_wardens"] },
    ],
    actors: [
      actorSnapshot("player", "Field Observer", 1, 2, "desert_wardens", "player"),
      actorSnapshot("rogue", "Rogue", 4, 2, "rogue_troopers", "skirmisher"),
    ],
    props: [{ id: "crate-1", entity: "prop:crate", areaId: "a", label: "Crate", kind: "crate", cell: { x: 3, y: 3 }, size: { w: 1, h: 1 }, interactive: true }],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [{ id: "camp-clone", areaId: "a", label: "Camp Clone", respawnCell: { x: 1, y: 1 }, respawnFacing: "right", sicknessDurationMs: 0 }],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function actorSnapshot(id: string, label: string, x: number, y: number, factionId: string, role: string) {
  return {
    id,
    entity: `actor:${id}`,
    areaId: "a",
    label,
    role,
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "right",
    cell: { x, y },
    route: [],
    factionId,
  };
}

function serverActor(id: string, label: string, x: number, y: number, factionId: string): ServerAuthorityActorState {
  return {
    id,
    label,
    role: id === "player" ? "player" : "skirmisher",
    sprite: "adventurer-premium-male",
    areaId: "a",
    x,
    y,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: id === "player" ? 81 : 40, action: 72, spirit: 63 },
    maxVitals: { health: 100, action: 100, spirit: 90 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    factionId,
    posture: "standing",
  } as ServerAuthorityActorState;
}

function playFixture(slice = sliceFixture()): PlayState {
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.snapshotTick = 42;
  state.serverAuthority.actors = {
    player: serverActor("player", "Field Observer", 1.25, 2.5, "desert_wardens"),
    rogue: serverActor("rogue", "Rogue", 4, 2, "rogue_troopers"),
  };
  state.activeAreaId = "a";
  state.player = { x: 1, y: 2 };
  state.inventory = [{
    container: "player:field-pack",
    item: "Iron Resource Container",
    itemId: 2001,
    variantId: 210123,
    quantity: 5,
    reserved: 2,
    available: 3,
    stackId: 77,
  }];
  state.abilityQueue.view = {
    actorId: "player",
    nextReadyTick: 45,
    entries: [{
      id: "q1",
      abilityId: "aimed_shot",
      iconId: "aimed_shot",
      class: "combat",
      targetActorId: "rogue",
      lifecycle: "pending",
      enqueuedAtTick: 40,
      readyTick: 45,
    }],
  };
  state.serverAuthority.sentCommands = 3;
  state.serverAuthority.acceptedCommands = 2;
  state.serverAuthority.rejectedCommands = 1;
  state.serverAuthority.lastReceipt = { commandId: 99, accepted: false, tick: 41, reasonCode: "ingress_budget_exhausted", receivedAtMs: 1200 };
  state.serverAuthority.receiptLog = [state.serverAuthority.lastReceipt];
  state.serverAuthority.sentCommandLog = [{ commandId: 99, kind: "SurveyResource", sentAtMs: 1100 }];
  return state;
}

function registryContext(state = playFixture(), slice = sliceFixture()): VerbRegistryContext {
  return {
    state,
    slice,
    canonicalResourceFamily: (value) => {
      const key = value?.trim().toLowerCase() ?? "";
      if (!key || key === "iron" || key === "mineral") return "metal";
      if (key === "cu") return "copper";
      return key;
    },
  };
}

describe("verbRegistry", () => {
  it("derives an authority verb entry for every generated manifest kind", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(generatedAuthorityVerbRows.length).toBe(generatedVerbTable.verbs.length);
    expect(generatedAuthorityVerbRows.length).toBe(generatedCommandManifest.commands.length);
    for (const row of generatedAuthorityVerbRows) {
      expect(registry.resolveCommandKind(row.kind)?.commandKind).toBe(row.kind);
      expect(registry.resolve(row.verb)?.commandKind).toBe(row.kind);
      expect(registry.resolve(row.defaultVerb)?.commandKind).toBe(row.kind);
      for (const alias of row.aliases) {
        expect(registry.resolve(alias)?.commandKind).toBe(row.kind);
      }
    }
  });

  it("queries only the owning session bank projection", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.serverAuthority.bank = {
      credits: 731,
      items: [{
        container: "bank:player",
        stackId: "9",
        item: "Iron Resource Container",
        itemId: 2001,
        variantId: 210123,
        quantity: 4,
        reserved: 0,
        available: 4,
      }, {
        container: "bank:player",
        stackId: "10",
        item: "Spent Slug",
        itemId: 1101,
        variantId: 0,
        quantity: 0,
        reserved: 0,
        available: 0,
      }],
      backupPresent: true,
      backupSavedTick: 40,
      backupSkillCount: 2,
      backupCost: 1000,
    };
    state.serverAuthority.actors.player!.credits = 1440;
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/bank")?.data).toEqual({
      query: "bank",
      schema: "successor.query.bank.v1",
      available: true,
      credits: 731,
      items: [{
        container: "bank:player",
        stackId: "9",
        item: "Iron Resource Container",
        itemId: 2001,
        variantId: 210123,
        quantity: 4,
        reserved: 0,
        available: 4,
      }],
      backupPresent: true,
      backupSavedTick: 40,
      backupSkillCount: 2,
      backupCost: 1000,
    });

    expect(registry.executeLine("/wallet")?.data).toEqual({
      query: "wallet",
      schema: "successor.query.wallet.v1",
      actorId: "player",
      credits: 1440,
    });

    state.serverAuthority.bank = null;
    expect(registry.executeLine("/bank")?.data).toMatchObject({ available: false, credits: null, items: [] });
  });

  it("rejects any verb/alias collision — no silent last-wins shadowing", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    // Construction throws on a collision (registerVerb fail-fast); reaching here
    // means the whole namespace is clean.
    const registry = createVerbRegistry(registryContext(state, slice));
    const seen = new Map<string, string>();
    for (const entry of registry.entries()) {
      const label = entry.commandKind ?? entry.verb;
      for (const token of [entry.verb, ...entry.aliases]) {
        const prev = seen.get(token);
        expect(prev === undefined || prev === label, `slash token "${token}" claimed by both ${prev} and ${label}`).toBe(true);
        seen.set(token, label);
      }
    }
    // The specific fix: /harvest is the creature harvest, /reap is the crop harvest.
    expect(registry.resolve("harvest")?.commandKind).toBe("HarvestCorpse");
    expect(registry.resolve("reap")?.commandKind).toBe("HarvestCrop");
    expect(registry.resolve("harvest-crop")?.commandKind).toBe("HarvestCrop");
  });

  it("keeps curated authority aliases byte-compatible with the old slash behavior", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/survey iron")?.text).toBe("SURVEYING METAL…");
    expect(registry.executeLine("/sample cu")?.text).toBe("SAMPLING COPPER — HOLD POSITION");
    expect(registry.executeLine("/kneel")?.text).toBe("KNEELING");
    expect(registry.executeLine("/stand")?.text).toBe("STANDING");
    expect(registry.executeLine("/peace")?.text).toBe("STANDING DOWN");
    expect(registry.executeLine("/clone camp-clone")?.text).toBe("CLONE ACTIVATION QUEUED");

    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { SurveyResource: { family: "metal" } },
      { SampleResource: { family: "copper" } },
      { SetPosture: { posture: "kneel" } },
      { SetPosture: { posture: "stand" } },
      { Peace: {} },
      { CloneRespawn: { facility_id: "camp-clone" } },
    ]);
    expect(registry.executeLine("/clone nowhere")?.text).toBe("UNKNOWN FACILITY — camp-clone");
  });

  it("parses text craft names and the empty practice payload", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));
    registry.executeLine('/craft-finalize-prototype "Bunker Nine Special"');
    registry.executeLine("/craft-finalize-prototype");
    registry.executeLine("/craft-finalize-practice");
    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { CraftFinalizePrototype: { custom_name: "Bunker Nine Special" } },
      { CraftFinalizePrototype: { custom_name: "" } },
      { CraftFinalizePractice: {} },
    ]);
  });

  it("normalizes generated weapon and ammo display enums for the current reload command", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/reload-weapon Slugthrower SlugIron")?.data).toMatchObject({
      commandKind: "ReloadWeapon",
      command: { ReloadWeapon: { weapon_id: "slugthrower", ammo_type: "slug_iron" } },
    });
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { ReloadWeapon: { weapon_id: "slugthrower", ammo_type: "slug_iron" } },
    ]);
  });

  it("maps sample stop spellings to the durable-loop wire flag and rejects invalid enum values", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/sample iron")?.data).toMatchObject({
      commandKind: "SampleResource",
      command: { SampleResource: { family: "metal" } },
    });
    expect(registry.executeLine("/sample iron true")?.data).toMatchObject({
      commandKind: "SampleResource",
      command: { SampleResource: { family: "metal", stop: true } },
    });
    expect(registry.executeLine("/stop-sample iron")?.data).toMatchObject({
      commandKind: "SampleResource",
      command: { SampleResource: { family: "metal", stop: true } },
    });
    expect(registry.executeLine("/sample iron halt")?.data).toMatchObject({ error: "bad_stop" });
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { SampleResource: { family: "metal" } },
      { SampleResource: { family: "metal", stop: true } },
      { SampleResource: { family: "metal", stop: true } },
    ]);
  });

  it("defaults curated /attack to basic_shot and the current target", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    state.selectedActorId = "rogue";
    state.softLockActorId = "soft-rogue";
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/attack")?.text).toBe("ATTACK QUEUED");
    state.selectedActorId = null;
    expect(registry.executeLine("/attack aimed-shot $target")?.data).toMatchObject({
      commandKind: "QueueCombatAction",
      queued: true,
      actionId: "aimed_shot",
      targetActorId: "soft-rogue",
    });
    expect(registry.executeLine("/attack bad_action rogue")?.text).toBe("ATTACK DENIED — BAD ACTION");
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { QueueCombatAction: { action_id: "basic_shot", target_actor_id: "rogue" } },
      { QueueCombatAction: { action_id: "aimed_shot", target_actor_id: "soft-rogue" } },
    ]);

    state.softLockActorId = null;
    expect(registry.executeLine("/attack")?.text).toBe("NO TARGET");
    expect(state.authorityCommands.pending).toHaveLength(2);
  });

  it("parses /trade with explicit named offer/request specs and scoped name lookup", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    state.inventory.push({
      container: "player:field-pack",
      item: "Creature Hide",
      itemId: 2101,
      variantId: 210777,
      quantity: 8,
      reserved: 0,
      available: 8,
      stackId: 78,
    });
    const registry = createVerbRegistry(registryContext(state, slice));

    const named = registry.executeLine("/trade propose Rogue offer=hide@210777:4,iron@210123:2 request=creditchip:20");
    expect(named?.text).toBe("TRADE QUEUED");
    expect(named?.data).toMatchObject({
      commandKind: "ProposeTrade",
      queued: true,
      partnerActorId: "rogue",
      offer: [
        { item_id: 2101, variant_id: 210777, quantity: 4 },
        { item_id: 2001, variant_id: 210123, quantity: 2 },
      ],
      request: [{ item_id: 9002, variant_id: 0, quantity: 20 }],
    });

    const quoted = registry.executeLine("/trade propose rogue offer=\"Creature Hide@210777:1\" request=creditchip:5");
    expect(quoted?.data).toMatchObject({
      offer: [{ item_id: 2101, variant_id: 210777, quantity: 1 }],
      request: [{ item_id: 9002, variant_id: 0, quantity: 5 }],
    });

    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      {
        ProposeTrade: {
          partner_actor_id: "rogue",
          offer: [
            { item_id: 2101, variant_id: 210777, quantity: 4 },
            { item_id: 2001, variant_id: 210123, quantity: 2 },
          ],
          request: [{ item_id: 9002, variant_id: 0, quantity: 20 }],
        },
      },
      {
        ProposeTrade: {
          partner_actor_id: "rogue",
          offer: [{ item_id: 2101, variant_id: 210777, quantity: 1 }],
          request: [{ item_id: 9002, variant_id: 0, quantity: 5 }],
        },
      },
    ]);
  });

  it("normalizes generated trade mutation item specs before enqueue", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/add-trade-item 7 9002@0:3")?.data).toMatchObject({
      commandKind: "AddTradeItem",
      queued: true,
    });
    expect(registry.executeLine("/remove-trade-item 7 2001@210123:2")?.data).toMatchObject({
      commandKind: "RemoveTradeItem",
      queued: true,
    });
    expect(registry.executeLine("/add-trade-item proposal_id=8 item=1101@0:4")?.data).toMatchObject({
      commandKind: "AddTradeItem",
      queued: true,
    });
    expect(registry.executeLine("/add-trade-item 7 bad-item")?.data).toMatchObject({
      queued: false,
      error: "bad_trade_item",
    });
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { AddTradeItem: { proposal_id: 7, item: { item_id: 9002, variant_id: 0, quantity: 3 } } },
      { RemoveTradeItem: { proposal_id: 7, item: { item_id: 2001, variant_id: 210123, quantity: 2 } } },
      { AddTradeItem: { proposal_id: 8, item: { item_id: 1101, variant_id: 0, quantity: 4 } } },
    ]);
  });

  it("keeps JSON trade item specs comma-safe and rejects ambiguous or malformed trade args", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    const json = registry.executeLine("/trade propose rogue offer='[{\"item_id\":2101,\"variant_id\":210777,\"quantity\":4},{\"item_id\":2001,\"variant_id\":210123,\"quantity\":1}]' request='{\"item_id\":9002,\"variant_id\":0,\"quantity\":20}'");
    expect(json?.text).toBe("TRADE QUEUED");
    expect(json?.data).toMatchObject({
      offer: [
        { item_id: 2101, variant_id: 210777, quantity: 4 },
        { item_id: 2001, variant_id: 210123, quantity: 1 },
      ],
      request: [{ item_id: 9002, variant_id: 0, quantity: 20 }],
    });

    const ambiguous = registry.executeLine("/trade propose rogue hide:4 creditchip:20");
    expect(ambiguous?.text).toBe("TRADE DENIED — SPLIT SIDES WITH OFFER=... REQUEST=... OR ... FOR ...");
    expect(ambiguous?.data).toMatchObject({ queued: false, error: "use_offer_request" });

    const malformed = registry.executeLine("/trade propose rogue offer='{\"item_id\":2101,\"quantity\":4' request=creditchip:20");
    expect(malformed?.text).toBe("TRADE DENIED — BAD OFFER ITEM");
    expect(malformed?.data).toMatchObject({ queued: false, error: "bad_offer" });
  });

  it("exposes local target and ui verbs through selection and window-manager seams", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    const opened: string[] = [];
    const registry = createVerbRegistry({ ...registryContext(state, slice), openWindow: (id) => opened.push(id) });

    const target = registry.executeLine("/target nearest hostile");
    expect(target?.data).toMatchObject({ ok: true, target: { id: "rogue", relation: "hostile" } });
    expect(state.softLockActorId).toBe("rogue");
    expect(state.selectedActorId).toBe("rogue");

    expect(registry.executeLine("/ui inventory")?.data).toMatchObject({ ok: true, windowId: "inventory" });
    expect(opened).toEqual(["inventory"]);
  });


  it("walks the /target selector grammar — self, exact, prefix, deterministic cycle, clear", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.serverAuthority.actors.rogue2 = serverActor("rogue2", "Rogue Two", 6, 2, "rogue_troopers");
    state.serverAuthority.actors.vendor = serverActor("vendor", "Vendor", 2, 2, "desert_wardens");
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/target self")?.data).toMatchObject({ ok: true, target: { id: "player" } });
    expect(registry.executeLine("/target Rogue")?.data).toMatchObject({ ok: true, target: { id: "rogue" } });
    expect(registry.executeLine("/target vend")?.data).toMatchObject({ ok: true, target: { id: "vendor" } });

    const ambiguous = registry.executeLine("/target rog");
    expect(ambiguous?.text).toBe("TARGET DENIED — AMBIGUOUS TARGET");
    expect(ambiguous?.data).toMatchObject({ ok: false, error: "ambiguous_target", candidates: ["rogue", "rogue2"] });

    // Cycle ring is the id-sorted visible set (rogue, rogue2, vendor); the
    // ambiguous line above left the vendor selection in place.
    expect(registry.executeLine("/target next")?.data).toMatchObject({ ok: true, target: { id: "rogue" } });
    expect(registry.executeLine("/target next")?.data).toMatchObject({ ok: true, target: { id: "rogue2" } });
    expect(registry.executeLine("/target next")?.data).toMatchObject({ ok: true, target: { id: "vendor" } });
    expect(registry.executeLine("/target next")?.data).toMatchObject({ ok: true, target: { id: "rogue" } });
    expect(registry.executeLine("/target previous")?.data).toMatchObject({ ok: true, target: { id: "vendor" } });

    // The selected actor vanishing clears the stale selection, so the next
    // cycle restarts from the front instead of walking from a ghost.
    registry.executeLine("/target rogue2");
    delete state.serverAuthority.actors.rogue2;
    expect(registry.executeLine("/target next")?.data).toMatchObject({ ok: true, target: { id: "rogue" } });

    expect(registry.executeLine("/target ghost")?.text).toBe("TARGET NOT FOUND");
    expect(registry.executeLine("/target clear")?.text).toBe("TARGET CLEARED");
    expect(state.selectedActorId).toBeNull();
    expect(state.softLockActorId).toBeNull();
    expect(registry.executeLine("/target")?.data).toMatchObject({ ok: false, error: "no_target" });
  });

  it("queues exactly one Deathblow — explicit target, then selected, then soft-lock fallback", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();
    const registry = createVerbRegistry(registryContext(state, slice));

    // Explicit visible target.
    const explicit = registry.executeLine("/deathblow rogue");
    expect(explicit?.text).toBe("DEATHBLOW QUEUED");
    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { Deathblow: { target_actor_id: "rogue" } },
    ]);
    expect(state.selectedActorId).toBe("rogue");
    expect(state.softLockActorId).toBe("rogue");

    // No-arg: selected target first.
    state.authorityCommands = createAuthorityCommandQueue();
    state.selectedActorId = "rogue";
    state.softLockActorId = null;
    expect(registry.executeLine("/deathblow")?.text).toBe("DEATHBLOW QUEUED");
    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { Deathblow: { target_actor_id: "rogue" } },
    ]);

    // No-arg: soft-lock fallback when nothing is selected.
    state.authorityCommands = createAuthorityCommandQueue();
    state.selectedActorId = null;
    state.softLockActorId = "rogue";
    expect(registry.executeLine("/deathblow")?.text).toBe("DEATHBLOW QUEUED");
    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { Deathblow: { target_actor_id: "rogue" } },
    ]);

    // No target anywhere: nothing reaches the wire.
    state.authorityCommands = createAuthorityCommandQueue();
    state.selectedActorId = null;
    state.softLockActorId = null;
    expect(registry.executeLine("/deathblow")?.text).toBe("DEATHBLOW DENIED — NO TARGET");
    expect(state.authorityCommands.pending).toHaveLength(0);

    // Ambiguous explicit selector: denied without a command.
    state.serverAuthority.actors.rogue2 = serverActor("rogue2", "Rogue Two", 6, 2, "rogue_troopers");
    expect(registry.executeLine("/deathblow rog")?.text).toBe("DEATHBLOW DENIED — AMBIGUOUS TARGET");
    expect(state.authorityCommands.pending).toHaveLength(0);
  });
  it("targets alerted faction hostiles — the DEF-4 selector repro", () => {
    const slice = sliceFixture();
    // Live shape: an unprovoked skirmisher streams passive/alerted attitude.
    // Pre-fix the relation classifier called it farmable_passive and
    // `/target nearest hostile` reported TARGET NOT FOUND with it in scope.
    slice.actors.find((actor) => actor.id === "rogue")!.aiAttitude = "alerted";
    const state = playFixture(slice);
    const registry = createVerbRegistry(registryContext(state, slice));

    const target = registry.executeLine("/target nearest hostile");
    expect(target?.data).toMatchObject({ ok: true, target: { id: "rogue", relation: "hostile" } });

    const nearby = registry.executeLine("/nearby hostile");
    expect(nearby?.text).toContain("NEARBY HOSTILE 1");
  });

  it("/nearby speaks hostile vs wary on the willAutoAggro key (relation stays hostile)", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    const registry = createVerbRegistry(registryContext(state, slice));

    // Auto-aggro rogue: relation stays hostile (selector unchanged) but the
    // prose speaks "hostile".
    state.serverAuthority.actors.rogue!.willAutoAggro = true;
    const hostile = registry.executeLine("/nearby hostile");
    expect(hostile?.data).toMatchObject({ actors: [{ id: "rogue", relation: "hostile", threat: "hostile" }] });
    expect(hostile?.text).toContain("NEARBY HOSTILE 1");
    expect(hostile?.text).toContain("(hostile)");

    // Provoked-only rogue (won't aggro unless attacked): still hostile RELATION
    // (still found by `/target`/`/nearby hostile`) but the prose speaks "wary".
    state.serverAuthority.actors.rogue!.willAutoAggro = false;
    const wary = registry.executeLine("/nearby hostile");
    expect(wary?.data).toMatchObject({ actors: [{ id: "rogue", relation: "hostile", threat: "wary" }] });
    expect(wary?.text).toContain("NEARBY HOSTILE 1");
    expect(wary?.text).toContain("(wary)");
  });

  it("returns structured query payloads with text renderings from PlayState only", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    enqueueAuthoritySurveyResourceCommand(state.authorityCommands, "metal", 41);
    state.serverAuthority.group = {
      group: { groupId: 4, leaderActorId: "player", createdTick: 40, memberActorIds: ["player", "rogue"] },
      members: [
        {
          actorId: "player",
          name: "Field Observer",
          areaId: "a",
          vitals: { health: 81, action: 72, spirit: 63 },
          maxVitals: { health: 100, action: 100, spirit: 90 },
          lifeState: "alive",
          isLeader: true,
          linkDead: false,
        },
        {
          actorId: "rogue",
          name: "Rogue",
          areaId: "a",
          vitals: { health: 100, action: 100, spirit: 100 },
          maxVitals: { health: 100, action: 100, spirit: 100 },
          lifeState: "alive",
          isLeader: false,
          linkDead: false,
        },
      ],
    };
    const registry = createVerbRegistry(registryContext(state, slice));

    const where = registry.executeLine("/where");
    expect(where?.kind).toBe("query");
    expect(where?.text).toContain("WHERE a");
    expect(where?.data).toMatchObject({ schema: "successor.query.where.v1", areaId: "a", x: 1.25, y: 2.5, source: "server" });

    const vitals = registry.executeLine("/vitals");
    expect(vitals?.text).toBe("VITALS H 81/100 · A 72/100 · S 63/90");
    expect(vitals?.data).toMatchObject({ schema: "successor.query.vitals.v1", vitals: { health: 81, action: 72, spirit: 63 } });

    const inv = registry.executeLine("/inv iron");
    expect(inv?.data).toMatchObject({
      schema: "successor.query.inventory.v1",
      totalStacks: 1,
      totalContainers: 1,
      totalAvailable: 3,
      containers: [{ container: "player:field-pack", totalStacks: 1, totalAvailable: 3 }],
    });
    expect(inv?.text).toBe("INV 1 STACK · 3 AVAILABLE · [player:field-pack] 1 STACK/3 AVAILABLE");

    const nearby = registry.executeLine("/nearby hostile");
    expect(nearby?.data).toMatchObject({ schema: "successor.query.nearby.v1", actors: [{ id: "rogue", relation: "hostile" }] });
    expect(nearby?.text).toContain("NEARBY HOSTILE 1");

    const queue = registry.executeLine("/queue");
    expect(queue?.data).toMatchObject({ schema: "successor.query.queue.v1", pendingCommandCount: 1, abilityQueue: { actorId: "player" } });
    expect(queue?.text).toBe("QUEUE 1 ABILITY · 1 WIRE PENDING");

    const group = registry.executeLine("/group");
    expect(group?.data).toMatchObject({ schema: "successor.query.group.v1", members: [{ actorId: "player" }, { actorId: "rogue" }] });
    expect(group?.text).toBe("GROUP 2 · *Field Observer · Rogue");

    const budget = registry.executeLine("/budget");
    expect(budget?.data).toMatchObject({
      schema: "successor.query.budget.v1",
      counters: { sent: 3, accepted: 2, rejected: 1, pending: 1 },
      recentIngressRejects: [{ commandId: 99, kind: "SurveyResource" }],
    });
    expect(budget?.text).toBe("BUDGET sent 3 · accepted 2 · rejected 1 · ingress rejects 1");
  });

  it("projects the owning guild roster while leaving outsider directory data explicit", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.serverAuthority.guilds = {
      guild: {
        id: "guild-1",
        name: "Dustgate Wardens",
        tag: "DUST",
        leaderActorId: "player",
        createdTick: 10,
        memberCount: 2,
        wars: [],
      },
      roster: [
        {
          actorId: "player",
          name: "Field Observer",
          role: "leader",
          permissions: ["invite", "kick", "roles", "war", "disband"],
          online: true,
          areaId: "a",
          lastSeenTick: 10,
        },
        {
          actorId: "rogue",
          name: "Rogue",
          role: "member",
          permissions: [],
          online: false,
          areaId: null,
          lastSeenTick: 9,
        },
      ],
      pendingInvites: [],
      directory: [{ id: "guild-1", name: "Dustgate Wardens", tag: "DUST", memberCount: 2 }],
    };
    const registry = createVerbRegistry(registryContext(state, slice));
    const guild = registry.executeLine("/guild");
    expect(guild?.data).toMatchObject({
      schema: "successor.query.guild.v1",
      guild: { id: "guild-1", tag: "DUST" },
      roster: [{ actorId: "player" }, { actorId: "rogue", online: false, areaId: null }],
      directory: [{ id: "guild-1", memberCount: 2 }],
    });
  });

  it("answers /where from authoritative actor coordinates when render interpolation is stale", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.facing = "front";
    state.serverAuthority.actors.player = {
      ...serverActor("player", "Field Observer", 513.36, 511.62, "desert_wardens"),
      direction: "right",
      renderX: 512,
      renderY: 512,
    };
    state.serverAuthority.actors.rogue = {
      ...serverActor("rogue", "Rogue", 520, 511.62, "rogue_troopers"),
      renderX: 504,
      renderY: 512,
    };
    const registry = createVerbRegistry(registryContext(state, slice));

    const where = registry.executeLine("/where");
    expect(where?.data).toMatchObject({
      schema: "successor.query.where.v1",
      areaId: "a",
      x: 513.36,
      y: 511.62,
      facing: "right",
      source: "server",
    });
    expect(where?.text).toBe("WHERE a 513.4,511.6 facing right");

    const nearby = registry.executeLine("/nearby hostile");
    expect(nearby?.data).toMatchObject({
      origin: { x: 513.36, y: 511.62 },
      actors: [{ id: "rogue", x: 520, y: 511.62 }],
    });
  });

  it("scopes /inv to local-owner and datapad rows before filtering raw state", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.inventory = [
      {
        container: "player:field-pack",
        item: "Iron Resource Container",
        itemId: 2001,
        variantId: 210123,
        quantity: 5,
        reserved: 2,
        available: 3,
        stackId: 77,
      },
      {
        container: "actionjohnson:field-pack",
        item: "Copper Resource Container",
        itemId: 2007,
        variantId: 220444,
        quantity: 2,
        reserved: 0,
        available: 2,
        stackId: 78,
      },
      {
        container: "district-exchange",
        item: "Stored Schematic",
        itemId: 5001,
        variantId: 1,
        quantity: 4,
        reserved: 0,
        available: 4,
        stackId: 79,
      },
      {
        container: "rogue:field-pack",
        item: "Foreign Iron Resource Container",
        itemId: 2001,
        variantId: 210999,
        quantity: 99,
        reserved: 0,
        available: 99,
        stackId: 80,
      },
      {
        container: "corpse:rogue",
        item: "Corpse Iron Resource Container",
        itemId: 2001,
        variantId: 210888,
        quantity: 11,
        reserved: 0,
        available: 11,
        stackId: 81,
      },
      {
        container: "player:field-pack",
        item: "Reserved Iron Resource Container",
        itemId: 2001,
        variantId: 210777,
        quantity: 7,
        reserved: 7,
        available: 0,
        stackId: 82,
      },
    ];
    const registry = createVerbRegistry({
      ...registryContext(state, slice),
      inventoryIdentity: { playerId: "observer", characterId: "actionjohnson" },
    });

    const inv = registry.executeLine("/inv");
    const invData = inv?.data as {
      totalStacks: number;
      totalContainers: number;
      totalAvailable: number;
      rows: Array<{ container: string; item: string }>;
      containers: Array<{ container: string; totalStacks: number; totalAvailable: number }>;
    };
    expect(invData.totalStacks).toBe(3);
    expect(invData.totalContainers).toBe(3);
    expect(invData.totalAvailable).toBe(9);
    expect(invData.rows.map((row) => row.container)).toEqual([
      "player:field-pack",
      "actionjohnson:field-pack",
      "district-exchange",
    ]);
    expect(invData.containers).toMatchObject([
      { container: "player:field-pack", totalStacks: 1, totalAvailable: 3 },
      { container: "actionjohnson:field-pack", totalStacks: 1, totalAvailable: 2 },
      { container: "district-exchange", totalStacks: 1, totalAvailable: 4 },
    ]);
    expect(inv?.text).toBe(
      "INV 3 STACKS · 9 AVAILABLE · [player:field-pack] 1 STACK/3 AVAILABLE · [actionjohnson:field-pack] 1 STACK/2 AVAILABLE · [district-exchange] 1 STACK/4 AVAILABLE",
    );

    const iron = registry.executeLine("/inv iron");
    const ironData = iron?.data as { totalStacks: number; totalAvailable: number; rows: Array<{ item: string }> };
    expect(ironData.totalStacks).toBe(1);
    expect(ironData.totalAvailable).toBe(3);
    expect(ironData.rows.map((row) => row.item)).toEqual(["Iron Resource Container"]);
  });

  it("leaves unknown slash verbs unresolved for chat fallthrough", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    const registry = createVerbRegistry(registryContext(state, slice));

    expect(registry.executeLine("/who")).toBeNull();
    expect(registry.executeLine("hello zone")).toBeNull();
    expect(state.authorityCommands.pending).toHaveLength(0);
  });
  it("handles exact variant trade parsing and variant requirements", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();

    // Clear inventory for unowned checks
    state.inventory = [];

    const registry = createVerbRegistry(registryContext(state, slice));

    // 1. Unowned resources return trade_variant_required error
    const unownedFuel = registry.executeLine("/trade propose rogue offer=fuel:12 request=creditchip:10");
    expect(unownedFuel?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(unownedFuel?.data).toMatchObject({ queued: false, error: "trade_variant_required" });

    const unownedPolymer = registry.executeLine("/trade propose rogue offer=polymer:900 request=creditchip:10");
    expect(unownedPolymer?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    const unownedCarbon = registry.executeLine("/trade propose rogue offer=carbon:450 request=creditchip:10");
    expect(unownedCarbon?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    const unownedBareNumeric = registry.executeLine("/trade propose rogue offer=2009:12 request=creditchip:10");
    expect(unownedBareNumeric?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    const unownedRequestFuel = registry.executeLine("/trade propose rogue offer=creditchip:10 request=fuel:12");
    expect(unownedRequestFuel?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // 2. Exact variant resolution works (e.g. 2009@47233337:12 resolves)
    const exactResolves = registry.executeLine("/trade propose rogue offer=2009@47233337:12 request=creditchip:10");
    expect(exactResolves?.text).toBe("TRADE QUEUED");
    expect(exactResolves?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 47233337, quantity: 12 }],
      request: [{ item_id: 9002, variant_id: 0, quantity: 10 }]
    });

    // 3. JSON item record remains accepted
    const jsonResolves = registry.executeLine("/trade propose rogue offer='[{\"item_id\":2009,\"variant_id\":47233337,\"quantity\":12}]' request=creditchip:10");
    expect(jsonResolves?.text).toBe("TRADE QUEUED");
    expect(jsonResolves?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 47233337, quantity: 12 }],
    });

    // 4. Ammo and physical Credit Chips remain fixed variant 0.
    const fixedAmmo = registry.executeLine("/trade propose rogue offer=creditchip:10 request=ammo:5");
    expect(fixedAmmo?.text).toBe("TRADE QUEUED");
    expect(fixedAmmo?.data).toMatchObject({
      request: [{ item_id: 1101, variant_id: 0, quantity: 5 }]
    });

    const fixedBareAmmo = registry.executeLine("/trade propose rogue offer=creditchip:10 request=1101:5");
    expect(fixedBareAmmo?.text).toBe("TRADE QUEUED");
    expect(fixedBareAmmo?.data).toMatchObject({
      request: [{ item_id: 1101, variant_id: 0, quantity: 5 }]
    });

    const fixedBareCreditChip = registry.executeLine("/trade propose rogue offer=creditchip:10 request=9002:5");
    expect(fixedBareCreditChip?.text).toBe("TRADE QUEUED");
    expect(fixedBareCreditChip?.data).toMatchObject({
      request: [{ item_id: 9002, variant_id: 0, quantity: 5 }]
    });

    // 5. With one owned Fuel/Polymer/Carbon row, friendly aliases and bare numeric IDs return trade_variant_required
    const stateWithFuel = playFixture(slice);
    stateWithFuel.inventory = [
      {
        container: "player:field-pack",
        item: "Fuel Resource",
        itemId: 2009,
        variantId: 47233337,
        quantity: 20,
        reserved: 0,
        available: 20,
        stackId: 101,
      },
      {
        container: "player:field-pack",
        item: "Polymer Resource",
        itemId: 2010,
        variantId: 888888,
        quantity: 20,
        reserved: 0,
        available: 20,
        stackId: 102,
      },
      {
        container: "player:field-pack",
        item: "Carbon Resource",
        itemId: 2008,
        variantId: 999999,
        quantity: 20,
        reserved: 0,
        available: 20,
        stackId: 103,
      }
    ];
    const registryWithFuel = createVerbRegistry(registryContext(stateWithFuel, slice));

    // Offer
    const fuelOffer = registryWithFuel.executeLine("/trade propose rogue offer=fuel:5 request=creditchip:10");
    expect(fuelOffer?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(fuelOffer?.data).toMatchObject({ queued: false, error: "trade_variant_required" });

    const bareFuelOffer = registryWithFuel.executeLine("/trade propose rogue offer=2009:5 request=creditchip:10");
    expect(bareFuelOffer?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Request
    const fuelRequest = registryWithFuel.executeLine("/trade propose rogue offer=creditchip:10 request=fuel:5");
    expect(fuelRequest?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(fuelRequest?.data).toMatchObject({ queued: false, error: "trade_variant_required" });

    const bareFuelRequest = registryWithFuel.executeLine("/trade propose rogue offer=creditchip:10 request=2009:5");
    expect(bareFuelRequest?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Repeat for Polymer and Carbon
    expect(registryWithFuel.executeLine("/trade propose rogue offer=polymer:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithFuel.executeLine("/trade propose rogue offer=2010:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithFuel.executeLine("/trade propose rogue offer=carbon:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithFuel.executeLine("/trade propose rogue offer=2008:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Explicit @/# variant resolves with one owned row
    const fuelOfferExplicitAt = registryWithFuel.executeLine("/trade propose rogue offer=fuel@47233337:5 request=creditchip:10");
    expect(fuelOfferExplicitAt?.text).toBe("TRADE QUEUED");
    expect(fuelOfferExplicitAt?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 47233337, quantity: 5 }]
    });

    const fuelOfferExplicitHash = registryWithFuel.executeLine("/trade propose rogue offer=2009#47233337:5 request=creditchip:10");
    expect(fuelOfferExplicitHash?.text).toBe("TRADE QUEUED");
    expect(fuelOfferExplicitHash?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 47233337, quantity: 5 }]
    });

    // 6. With multiple owned Fuel/Polymer/Carbon rows, friendly aliases and bare numeric IDs return trade_variant_required
    const stateWithMultiFuel = playFixture(slice);
    stateWithMultiFuel.inventory = [
      {
        container: "player:field-pack",
        item: "Fuel Resource A",
        itemId: 2009,
        variantId: 10101,
        quantity: 10,
        reserved: 0,
        available: 10,
        stackId: 101,
      },
      {
        container: "player:field-pack",
        item: "Fuel Resource B",
        itemId: 2009,
        variantId: 20202,
        quantity: 30,
        reserved: 0,
        available: 30,
        stackId: 102,
      },
      {
        container: "player:field-pack",
        item: "Polymer Resource A",
        itemId: 2010,
        variantId: 30303,
        quantity: 10,
        reserved: 0,
        available: 10,
        stackId: 103,
      },
      {
        container: "player:field-pack",
        item: "Polymer Resource B",
        itemId: 2010,
        variantId: 40404,
        quantity: 30,
        reserved: 0,
        available: 30,
        stackId: 104,
      },
      {
        container: "player:field-pack",
        item: "Carbon Resource A",
        itemId: 2008,
        variantId: 50505,
        quantity: 10,
        reserved: 0,
        available: 10,
        stackId: 105,
      },
      {
        container: "player:field-pack",
        item: "Carbon Resource B",
        itemId: 2008,
        variantId: 60606,
        quantity: 30,
        reserved: 0,
        available: 30,
        stackId: 106,
      }
    ];
    const registryWithMultiFuel = createVerbRegistry(registryContext(stateWithMultiFuel, slice));

    // Offer
    const multiFuelOffer = registryWithMultiFuel.executeLine("/trade propose rogue offer=fuel:5 request=creditchip:10");
    expect(multiFuelOffer?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(multiFuelOffer?.data).toMatchObject({ queued: false, error: "trade_variant_required" });

    const bareMultiFuelOffer = registryWithMultiFuel.executeLine("/trade propose rogue offer=2009:5 request=creditchip:10");
    expect(bareMultiFuelOffer?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Request
    const multiFuelRequest = registryWithMultiFuel.executeLine("/trade propose rogue offer=creditchip:10 request=fuel:5");
    expect(multiFuelRequest?.text).toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Repeat for Polymer and Carbon
    expect(registryWithMultiFuel.executeLine("/trade propose rogue offer=polymer:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithMultiFuel.executeLine("/trade propose rogue offer=2010:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithMultiFuel.executeLine("/trade propose rogue offer=carbon:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");
    expect(registryWithMultiFuel.executeLine("/trade propose rogue offer=2008:5 request=creditchip:10")?.text)
      .toBe("TRADE DENIED — RESOURCE VARIANT REQUIRED; USE ITEM_ID@VARIANT_ID:QUANTITY");

    // Explicit @/# variant resolves with multiple owned rows
    const multiFuelOfferExplicitHash = registryWithMultiFuel.executeLine("/trade propose rogue offer=fuel#20202:5 request=creditchip:10");
    expect(multiFuelOfferExplicitHash?.text).toBe("TRADE QUEUED");
    expect(multiFuelOfferExplicitHash?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 20202, quantity: 5 }]
    });

    const multiFuelOfferExplicitAt = registryWithMultiFuel.executeLine("/trade propose rogue offer=2009@10101:5 request=creditchip:10");
    expect(multiFuelOfferExplicitAt?.text).toBe("TRADE QUEUED");
    expect(multiFuelOfferExplicitAt?.data).toMatchObject({
      offer: [{ item_id: 2009, variant_id: 10101, quantity: 5 }]
    });
  });


  it("comprehensively validates all 14 variant-bearing resource IDs and has teeth", () => {
    const slice = sliceFixture();
    const state = playFixture(slice);
    state.authorityCommands = createAuthorityCommandQueue();

    // 1. Verify the list of expected 14 resource item IDs
    const allResourceItemIds = resourceTaxonomyEntries.map((e) => e.itemId);
    expect(allResourceItemIds).toHaveLength(14);
    expect(allResourceItemIds).toEqual([
      2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2101, 2102, 2103, 2104
    ]);

    // 2. Populate mock inventory with all 14 variant-bearing resources to test friendly name lookups
    state.inventory = resourceTaxonomyEntries.map((entry, idx) => ({
      container: "player:field-pack",
      item: entry.name,
      itemId: entry.itemId,
      variantId: 777000 + entry.itemId,
      quantity: 100,
      reserved: 0,
      available: 100,
      stackId: 1000 + idx,
    }));

    const registry = createVerbRegistry(registryContext(state, slice));

    // 3. Define completeness checking helper for numeric IDs
    function verifyTradeCompleteness(reg: VerbRegistry, resourceIds: readonly number[]) {
      for (const itemId of resourceIds) {
        // Bare numeric selector must reject with trade_variant_required
        const bareLine = `/trade propose rogue offer=${itemId}:5 request=creditchip:10`;
        const bareResult = reg.executeLine(bareLine);
        if (!bareResult) {
          throw new Error(`Execution of bare line failed to return result for itemId ${itemId}`);
        }
        if (bareResult.data.error !== "trade_variant_required") {
          throw new Error(`Expected itemId ${itemId} to reject with trade_variant_required but got: ${JSON.stringify(bareResult.data)}`);
        }

        // Explicit numeric selector with @ must accept and emit exact variant
        const explicitAtLine = `/trade propose rogue offer=${itemId}@777:5 request=creditchip:10`;
        const explicitAtResult = reg.executeLine(explicitAtLine);
        if (!explicitAtResult || explicitAtResult.data.error) {
          throw new Error(`Expected itemId ${itemId} with explicit @ variant to succeed but got: ${JSON.stringify(explicitAtResult?.data)}`);
        }
        const offerAt = explicitAtResult.data.offer;
        if (!Array.isArray(offerAt) || offerAt.length === 0) {
          throw new Error(`Expected offer array but got ${String(offerAt)}`);
        }
        const offerAtItem = offerAt[0] as unknown;
        if (
          !offerAtItem ||
          typeof offerAtItem !== "object" ||
          !("item_id" in offerAtItem) ||
          !("variant_id" in offerAtItem) ||
          offerAtItem.item_id !== itemId ||
          offerAtItem.variant_id !== 777
        ) {
          throw new Error(`Expected itemId ${itemId} to resolve to variant 777 with @ but got: ${JSON.stringify(offerAtItem)}`);
        }

        // Explicit numeric selector with # must accept and emit exact variant
        const explicitHashLine = `/trade propose rogue offer=${itemId}#777:5 request=creditchip:10`;
        const explicitHashResult = reg.executeLine(explicitHashLine);
        if (!explicitHashResult || explicitHashResult.data.error) {
          throw new Error(`Expected itemId ${itemId} with explicit # variant to succeed but got: ${JSON.stringify(explicitHashResult?.data)}`);
        }
        const offerHash = explicitHashResult.data.offer;
        if (!Array.isArray(offerHash) || offerHash.length === 0) {
          throw new Error(`Expected offer array but got ${String(offerHash)}`);
        }
        const offerHashItem = offerHash[0] as unknown;
        if (
          !offerHashItem ||
          typeof offerHashItem !== "object" ||
          !("item_id" in offerHashItem) ||
          !("variant_id" in offerHashItem) ||
          offerHashItem.item_id !== itemId ||
          offerHashItem.variant_id !== 777
        ) {
          throw new Error(`Expected itemId ${itemId} to resolve to variant 777 with # but got: ${JSON.stringify(offerHashItem)}`);
        }
      }
    }

    // 4. Define completeness checking helper for friendly names
    function verifyFriendlyTradeCompleteness(reg: VerbRegistry, entries: readonly { itemId: number; name: string }[]) {
      for (const entry of entries) {
        const friendlyName = entry.name.toLowerCase();

        // Bare friendly selector must reject with trade_variant_required
        const bareLine = `/trade propose rogue offer=${friendlyName}:5 request=creditchip:10`;
        const bareResult = reg.executeLine(bareLine);
        if (!bareResult) {
          throw new Error(`Execution of bare line failed for friendly name ${friendlyName}`);
        }
        if (bareResult.data.error !== "trade_variant_required") {
          throw new Error(`Expected friendly name ${friendlyName} (itemId ${entry.itemId}) to reject with trade_variant_required but got: ${JSON.stringify(bareResult.data)}`);
        }

        // Explicit friendly selector with @ must accept and emit exact variant
        const explicitAtLine = `/trade propose rogue offer=${friendlyName}@777:5 request=creditchip:10`;
        const explicitAtResult = reg.executeLine(explicitAtLine);
        if (!explicitAtResult || explicitAtResult.data.error) {
          throw new Error(`Expected friendly name ${friendlyName} with explicit @ variant to succeed but got: ${JSON.stringify(explicitAtResult?.data)}`);
        }
        const offerAt = explicitAtResult.data.offer;
        if (!Array.isArray(offerAt) || offerAt.length === 0) {
          throw new Error(`Expected offer array but got ${String(offerAt)}`);
        }
        const offerAtItem = offerAt[0] as unknown;
        if (
          !offerAtItem ||
          typeof offerAtItem !== "object" ||
          !("item_id" in offerAtItem) ||
          !("variant_id" in offerAtItem) ||
          offerAtItem.item_id !== entry.itemId ||
          offerAtItem.variant_id !== 777
        ) {
          throw new Error(`Expected friendly name ${friendlyName} to resolve to itemId ${entry.itemId} and variant 777 with @ but got: ${JSON.stringify(offerAtItem)}`);
        }

        // Explicit friendly selector with # must accept and emit exact variant
        const explicitHashLine = `/trade propose rogue offer=${friendlyName}#777:5 request=creditchip:10`;
        const explicitHashResult = reg.executeLine(explicitHashLine);
        if (!explicitHashResult || explicitHashResult.data.error) {
          throw new Error(`Expected friendly name ${friendlyName} with explicit # variant to succeed but got: ${JSON.stringify(explicitHashResult?.data)}`);
        }
        const offerHash = explicitHashResult.data.offer;
        if (!Array.isArray(offerHash) || offerHash.length === 0) {
          throw new Error(`Expected offer array but got ${String(offerHash)}`);
        }
        const offerHashItem = offerHash[0] as unknown;
        if (
          !offerHashItem ||
          typeof offerHashItem !== "object" ||
          !("item_id" in offerHashItem) ||
          !("variant_id" in offerHashItem) ||
          offerHashItem.item_id !== entry.itemId ||
          offerHashItem.variant_id !== 777
        ) {
          throw new Error(`Expected friendly name ${friendlyName} to resolve to itemId ${entry.itemId} and variant 777 with # but got: ${JSON.stringify(offerHashItem)}`);
        }
      }
    }

    // 5. Run the completeness checks. These must succeed for the active registry.
    verifyTradeCompleteness(registry, allResourceItemIds);
    verifyFriendlyTradeCompleteness(registry, resourceTaxonomyEntries);

    // 6. Verify that fixed ammo/vouchers remain accepted with variant 0 where contract permits.
    // Fixed ammo - 'ammo', 'slug' or item ID 1101
    const ammoAliases = ["ammo", "slug", "1101"];
    for (const alias of ammoAliases) {
      const line = `/trade propose rogue offer=creditchip:10 request=${alias}:5`;
      const res = registry.executeLine(line);
      expect(res?.text).toBe("TRADE QUEUED");
      expect(res?.data).toMatchObject({
        request: [{ item_id: 1101, variant_id: 0, quantity: 5 }]
      });
    }

    // Fixed physical voucher — 'creditchip', 'creditchips' or item ID 9002.
    const chipAliases = ["creditchip", "creditchips", "9002"];
    for (const alias of chipAliases) {
      const line = `/trade propose rogue offer=${alias}:10 request=ammo:5`;
      const res = registry.executeLine(line);
      expect(res?.text).toBe("TRADE QUEUED");
      expect(res?.data).toMatchObject({
        offer: [{ item_id: 9002, variant_id: 0, quantity: 10 }]
      });
    }

    // 7. Tooth check: Verify that the completeness assertion will throw if an unguarded ID is checked.
    // Ammo (1101) is unguarded and always allowed with variant 0, so passing it to verifyTradeCompleteness must fail the check.
    expect(() => {
      verifyTradeCompleteness(registry, [1101]);
    }).toThrow(/Expected itemId 1101 to reject with trade_variant_required/);

    // 8. Tooth check: Verify that if a representative resource ID (e.g. 2001 - Iron) were simulated to not require a variant, the checker fails.
    // Unchecked cast: stub registry implementation for simulating a missing guard on itemId 2001 (Iron)
    const buggyRegistry = {
      entries: () => [],
      authorityEntries: () => [],
      localEntries: () => [],
      queryEntries: () => [],
      resolve: () => null,
      resolveCommandKind: () => null,
      executeLine(line: string) {
        if (line.includes("2001:5")) {
          // Simulate the buggy behavior: accept bare selector with variant 0 instead of rejecting with trade_variant_required
          return {
            schema: "successor.verb-result.v1",
            verb: "trade",
            class: "authority",
            text: "TRADE QUEUED",
            data: {
              queued: true,
              offer: [{ item_id: 2001, variant_id: 0, quantity: 5 }]
            }
          } satisfies VerbExecutionResult;
        }
        return registry.executeLine(line);
      }
    } as unknown as VerbRegistry;

    expect(() => {
      verifyTradeCompleteness(buggyRegistry, allResourceItemIds);
    }).toThrow(/Expected itemId 2001 to reject with trade_variant_required/);

    // 9. Tooth check for friendly names: simulate buggy behavior for 'iron' friendly selector
    // Unchecked cast: stub registry implementation for simulating a missing guard on friendly name iron
    const buggyFriendlyRegistry = {
      entries: () => [],
      authorityEntries: () => [],
      localEntries: () => [],
      queryEntries: () => [],
      resolve: () => null,
      resolveCommandKind: () => null,
      executeLine(line: string) {
        if (line.includes("iron:5")) {
          return {
            schema: "successor.verb-result.v1",
            verb: "trade",
            class: "authority",
            text: "TRADE QUEUED",
            data: {
              queued: true,
              offer: [{ item_id: 2001, variant_id: 0, quantity: 5 }]
            }
          } satisfies VerbExecutionResult;
        }
        return registry.executeLine(line);
      }
    } as unknown as VerbRegistry;

    expect(() => {
      verifyFriendlyTradeCompleteness(buggyFriendlyRegistry, resourceTaxonomyEntries);
    }).toThrow(/Expected friendly name iron \(itemId 2001\) to reject with trade_variant_required/);
  });
});
