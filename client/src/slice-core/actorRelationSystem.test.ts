import { describe, expect, it } from "vitest";

import { actorMinimapColor, actorNameplateColor, actorRelationColors, actorRelationToPlayer } from "./actorRelationSystem";
import type { PlayState, SliceSnapshot } from "./gameState";

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 0,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [{ id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    factions: [
      { id: "desert_wardens", label: "Warden", playerAllowed: true, enemies: ["rogue_troopers"], allies: [], adjustFactorMilli: 1000 },
      { id: "rogue_troopers", label: "Rogues", playerAllowed: false, enemies: ["desert_wardens"], allies: [], adjustFactorMilli: 1000 },
      { id: "gaia", label: "Gaia", playerAllowed: false, enemies: [], allies: [], adjustFactorMilli: 1000 },
    ],
    playerOrganizations: [
      { id: "mswk", label: "Warden Security Workers", tag: "WARD", memberActorIds: ["player", "ally"], allyOrganizationIds: [], enemyOrganizationIds: [] },
      { id: "redhands", label: "Red Hands", tag: "RED", memberActorIds: ["enemy-player"], allyOrganizationIds: [], enemyOrganizationIds: ["mswk"] },
    ],
    actors: [
      {
        id: "player",
        entity: "actor:player",
        areaId: "a",
        label: "Field Observer",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "right",
        cell: { x: 1, y: 1 },
        route: [],
        factionId: "desert_wardens",
        playerOrganizationId: "mswk",
        playerOrganizationTag: "WARD",
      },
      {
        id: "ally",
        entity: "actor:ally",
        areaId: "a",
        label: "Nira Ash",
        role: "agent_player",
        sprite: "adventurer-premium-female",
        poseSet: "idle",
        direction: "right",
        cell: { x: 2, y: 1 },
        route: [],
        factionId: "desert_wardens",
        playerOrganizationId: "mswk",
        playerOrganizationTag: "WARD",
      },
      {
        id: "blue-neutral",
        entity: "actor:blue-neutral",
        areaId: "a",
        label: "Unaffiliated Pawn",
        role: "agent_player",
        sprite: "adventurer-premium-male",
        poseSet: "idle",
        direction: "right",
        cell: { x: 3, y: 1 },
        route: [],
      },
      {
        id: "rogue",
        entity: "actor:rogue",
        areaId: "a",
        label: "Rogue",
        role: "skirmisher",
        sprite: "adventurer-premium-male",
        poseSet: "idle",
        direction: "left",
        cell: { x: 4, y: 1 },
        route: [],
        factionId: "rogue_troopers",
      },
      {
        id: "bellback-01",
        entity: "actor:bellback",
        areaId: "a",
        label: "bellback grazer",
        role: "creature",
        sprite: "creature-bellback-adult",
        poseSet: "idle",
        direction: "front",
        cell: { x: 6, y: 1 },
        route: [],
        factionId: "gaia",
      },
    ],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function playStateFixture(): PlayState {
  return {
    playerActorId: "player",
    serverAuthority: {
      playerActorId: "player",
      actors: {},
    },
  } as PlayState;
}

describe("actorRelationSystem", () => {
  it("colors same organization, neutral player-like, hostile, and farmable actors distinctly", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const byId = new Map(slice.actors.map((actor) => [actor.id, actor]));

    expect(actorRelationToPlayer(byId.get("ally")!, slice, state)).toBe("same_player_organization");
    expect(actorNameplateColor(byId.get("ally")!, slice, state)).toBe(actorRelationColors.samePlayerOrganization);
    expect(actorMinimapColor(byId.get("ally")!, slice, state)).toBe(actorRelationColors.samePlayerOrganization);

    expect(actorRelationToPlayer(byId.get("blue-neutral")!, slice, state)).toBe("friendly_player_like");
    expect(actorMinimapColor(byId.get("blue-neutral")!, slice, state)).toBe(actorRelationColors.friendlyPlayerLike);

    expect(actorRelationToPlayer(byId.get("rogue")!, slice, state)).toBe("hostile");
    // Threat colour (owner 2026-07-08): the "hostile" relation paints RED only for auto-aggro classes.
    expect(actorMinimapColor({ ...byId.get("rogue")!, willAutoAggro: true }, slice, state)).toBe(actorRelationColors.hostile);

    expect(actorRelationToPlayer(byId.get("bellback-01")!, slice, state)).toBe("farmable_passive");
    expect(actorMinimapColor(byId.get("bellback-01")!, slice, state)).toBe(actorRelationColors.farmablePassive);
  });

  it("only treats organization wars as hostile when both organizations declare the war", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const enemyPlayer = {
      id: "enemy-player",
      role: "agent_player",
      playerOrganizationId: "redhands",
      factionId: "desert_wardens",
    };

    expect(actorRelationToPlayer(enemyPlayer, slice, state)).toBe("friendly_player_like");
    slice.playerOrganizations![0]!.enemyOrganizationIds = ["redhands"];
    expect(actorRelationToPlayer(enemyPlayer, slice, state)).toBe("hostile");
  });

  it("keeps faction hostiles hostile regardless of aggro state (DEF-4)", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const rogue = slice.actors.find((actor) => actor.id === "rogue")!;

    // Live repro: the sparring-zone skirmisher streams passive/alerted while
    // unprovoked — it must STILL classify hostile or `/target nearest
    // hostile` reports TARGET NOT FOUND with a rogue in scope.
    expect(actorRelationToPlayer({ ...rogue, aiAttitude: "passive" }, slice, state)).toBe("hostile");
    expect(actorRelationToPlayer({ ...rogue, aiAttitude: "alerted" }, slice, state)).toBe("hostile");
    expect(actorRelationToPlayer({ ...rogue, aiAttitude: "hostile" }, slice, state)).toBe("hostile");
    // DEF-4 keeps the RELATION hostile (the /target selector + both minimaps ride
    // it); the nameplate/minimap COLOUR is now a separate willAutoAggro read
    // (owner 2026-07-08) — an alerted rogue that won't auto-aggro paints yellow,
    // an auto-aggro one paints red. Relation-order is unchanged.
    expect(actorMinimapColor({ ...rogue, aiAttitude: "alerted", willAutoAggro: false }, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorMinimapColor({ ...rogue, aiAttitude: "alerted", willAutoAggro: true }, slice, state)).toBe(actorRelationColors.hostile);
  });

  it("keeps Gaia creatures farmable while passive/alerted and hostile once retaliating", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const creature = slice.actors.find((actor) => actor.id === "bellback-01")!;

    expect(actorRelationToPlayer({ ...creature, aiAttitude: "passive" }, slice, state)).toBe("farmable_passive");
    expect(actorRelationToPlayer({ ...creature, aiAttitude: "alerted" }, slice, state)).toBe("farmable_passive");
    expect(actorNameplateColor({ ...creature, aiAttitude: "alerted" }, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorRelationToPlayer({ ...creature, aiAttitude: "hostile" }, slice, state)).toBe("hostile");
  });

  it("reads Gaia creatures farmable/yellow off role+faction alone — the neutral faction table never hides them", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const creature = slice.actors.find((actor) => actor.id === "bellback-01")!;

    // No aiAttitude at all (fresh snapshot): identity + gaia faction still
    // resolve farmable_passive, so the creature is attackable-yellow.
    expect(actorRelationToPlayer(creature, slice, state)).toBe("farmable_passive");
    expect(actorMinimapColor(creature, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorNameplateColor(creature, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorRelationToPlayer({ ...creature, aiAttitude: "passive" }, slice, state)).toBe("farmable_passive");
    // Provoked retaliation: the server attitude flip drives the hostile relation.
    expect(actorRelationToPlayer({ ...creature, aiAttitude: "hostile" }, slice, state)).toBe("hostile");
    expect(actorNameplateColor({ ...creature, aiAttitude: "hostile", willAutoAggro: true }, slice, state)).toBe(actorRelationColors.hostile);
  });

  it("keeps faction-carrying social NPCs social — trainers are never targets (DEF-10)", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const trainer = {
      id: "camp-trainer",
      label: "Camp Trainer",
      role: "profession_trainer",
      sprite: "adventurer-premium-male",
      factionId: "rogue_troopers",
    };

    // DEF-10 repro: once a trainer carries a hostile-listed faction, the
    // pre-fix ordering classified it hostile and `/target nearest hostile`
    // selected a civilian.
    expect(actorRelationToPlayer(trainer, slice, state)).toBe("social");
    expect(actorNameplateColor(trainer, slice, state)).toBe(actorRelationColors.social);
    // A passive-attitude social stays social (never farmable-yellow).
    expect(actorRelationToPlayer({ ...trainer, aiAttitude: "passive" }, slice, state)).toBe("social");
    // The server saying it is FIGHTING still wins — attitude-hostile socials
    // read hostile (first clause, unchanged).
    expect(actorRelationToPlayer({ ...trainer, aiAttitude: "hostile" }, slice, state)).toBe("hostile");
  });

  it("threat-colours the hostile relation on willAutoAggro: auto-aggro red, provoked-only yellow (owner 2026-07-08)", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const rogue = slice.actors.find((actor) => actor.id === "rogue")!;
    const creature = slice.actors.find((actor) => actor.id === "bellback-01")!;

    // Auto-aggro rogue: hostile relation + red name and dot.
    expect(actorRelationToPlayer({ ...rogue, willAutoAggro: true }, slice, state)).toBe("hostile");
    expect(actorNameplateColor({ ...rogue, willAutoAggro: true }, slice, state)).toBe(actorRelationColors.hostile);
    expect(actorMinimapColor({ ...rogue, willAutoAggro: true }, slice, state)).toBe(actorRelationColors.hostile);

    // Provoked-only rogue (won't aggro unless attacked): STILL hostile RELATION
    // (selectors ride it) but YELLOW name & dot.
    expect(actorRelationToPlayer({ ...rogue, willAutoAggro: false }, slice, state)).toBe("hostile");
    expect(actorNameplateColor({ ...rogue, willAutoAggro: false }, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorMinimapColor({ ...rogue, willAutoAggro: false }, slice, state)).toBe(actorRelationColors.farmablePassive);

    // Farmable wildlife stays yellow regardless of willAutoAggro while passive.
    expect(actorNameplateColor({ ...creature, willAutoAggro: false }, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorMinimapColor({ ...creature, willAutoAggro: true }, slice, state)).toBe(actorRelationColors.farmablePassive);

    // Social/civilian unchanged — a trainer is never repainted by willAutoAggro.
    const trainer = { id: "camp-trainer", label: "Camp Trainer", role: "profession_trainer", sprite: "adventurer-premium-male", factionId: "rogue_troopers" };
    expect(actorNameplateColor({ ...trainer, willAutoAggro: true }, slice, state)).toBe(actorRelationColors.social);
  });

  it("flips a provoked passive rogue yellow->red on the willAutoAggro key across presentation surfaces", () => {
    const slice = sliceFixture();
    const state = playStateFixture();
    const rogue = slice.actors.find((actor) => actor.id === "rogue")!;

    // Passive/alerted, not yet provoked -> provoked-only YELLOW.
    const passive = { ...rogue, aiAttitude: "passive", willAutoAggro: false } as const;
    expect(actorNameplateColor(passive, slice, state)).toBe(actorRelationColors.farmablePassive);
    expect(actorMinimapColor(passive, slice, state)).toBe(actorRelationColors.farmablePassive);

    // Provoke -> sim flips willAutoAggro true (attitude hostile) -> RED on the
    // shared nameplate projection and the 3D minimap dot.
    const provoked = { ...rogue, aiAttitude: "hostile", willAutoAggro: true } as const;
    expect(actorNameplateColor(provoked, slice, state)).toBe(actorRelationColors.hostile);
    expect(actorMinimapColor(provoked, slice, state)).toBe(actorRelationColors.hostile);
  });
});
