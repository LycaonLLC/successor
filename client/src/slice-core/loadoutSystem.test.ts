import { describe, expect, it } from "vitest";
import { createPlayState, type SliceSnapshot } from "./gameState";
import {
  activeWeaponLabel,
  activeAmmoTypeSpec,
  activeWeaponSpec,
  canReloadActiveWeapon,
  equipWeapon,
  reloadActiveWeapon,
  reloadActiveWeaponAuthoritative,
  setActiveAmmoType,
  setCooldown,
  unequipWeapon,
} from "./loadoutSystem";

function testSlice(): SliceSnapshot {
  return {
    schema: "fixture",
    tick: 1,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Test", width: 10, height: 10, level: 0 },
    areas: [{ id: "street", name: "Street", kind: "overworld", width: 10, height: 10, level: 0 }],
    stateHash: "hash",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "street",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 1, y: 1 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function state() {
  const slice = testSlice();
  const play = createPlayState(slice);
  play.serverAuthority.enabled = false;
  play.loadout.unlimitedAmmo = false;
  return play;
}

describe("loadoutSystem", () => {
  it("reloads the active weapon and sets reload cooldown", () => {
    const play = state();
    play.loadout.ammo["slug"].loaded = 24;

    expect(reloadActiveWeapon(play)).toBe(true);
    expect(play.loadout.ammo["slug"]).toEqual({ loaded: 30, reserve: 174 });
    expect(play.cooldownMs).toBe(2000);
    expect(play.status).toBe("slugthrower reloaded");
    expect(play.weaponFireAnimations[play.playerActorId]).toMatchObject({
      weaponId: "slugthrower",
      kind: "reload",
      durationMs: activeWeaponSpec(play)?.reloadMs,
    });
  });

  it("does not reload a full magazine", () => {
    const play = state();

    expect(canReloadActiveWeapon(play)).toBe(false);
    expect(reloadActiveWeapon(play)).toBe(false);
    expect(play.status).toBe("slugthrower full");
  });

  it("equips only when the account has the required certificate", () => {
    const play = state();
    play.progression.certificates = [];
    play.loadout.activeWeaponId = null;

    equipWeapon(play, "slugthrower");

    expect(play.loadout.activeWeaponId).toBeNull();
    expect(play.status).toBe("slugthrower cert missing");
  });

  it("unequips the active weapon and clears stale local weapon animation", () => {
    const play = state();
    play.weaponFireAnimations[play.playerActorId] = {
      weaponId: "slugthrower",
      kind: "reload",
      startedAtMs: 1_000,
      durationMs: 2_000,
    };
    unequipWeapon(play, "slugthrower");

    expect(play.loadout.activeWeaponId).toBeNull();
    expect(play.loadout.equipped.longGun).toBeNull();
    expect(play.weaponFireAnimations[play.playerActorId]).toBeUndefined();
    expect(activeWeaponLabel(play)).toBe("Unarmed");
  });

  it("selects compatible ammunition and exposes current weapon labels", () => {
    const play = state();

    expect(activeWeaponSpec(play)?.id).toBe("slugthrower");
    expect(activeWeaponLabel(play)).toBe("Slugthrower");
    expect(setActiveAmmoType(play, "slug_shard")).toBe(true);
    expect(activeAmmoTypeSpec(play, activeWeaponSpec(play)!).id).toBe("slug_shard");
  });

  it("blocks manual reload while server authority owns magazine state", () => {
    const play = state();
    play.serverAuthority.enabled = true;
    play.loadout.ammo["slug"].loaded = 12;

    expect(canReloadActiveWeapon(play)).toBe(true);
    expect(reloadActiveWeapon(play)).toBe(false);
    expect(play.loadout.ammo["slug"].loaded).toBe(12);
    expect(play.status).toBe("reloads on empty");
  });

  it("queues manual reload through server authority without local ammo mutation", () => {
    const slice = testSlice();
    const play = state();
    play.serverAuthority.enabled = true;
    play.loadout.ammo["slug"] = { loaded: 29, reserve: 300 };

    expect(canReloadActiveWeapon(play)).toBe(true);
    expect(reloadActiveWeaponAuthoritative(play, slice)).toBe(true);

    expect(play.loadout.ammo["slug"]).toEqual({ loaded: 29, reserve: 300 });
    expect(play.authorityCommands.pending.at(-1)?.command).toEqual({
      ReloadWeapon: { ammo_type: "slug_iron", weapon_id: "slugthrower" },
    });
    expect(play.cooldownMs).toBe(2000);
    expect(play.status).toBe("slugthrower reloading");
    expect(play.weaponFireAnimations[play.playerActorId]).toMatchObject({ kind: "reload" });
  });

  it("only extends cooldown forward", () => {
    const play = state();
    play.cooldownMs = 500;
    play.cooldownTotalMs = 500;

    setCooldown(play, 120);
    expect(play.cooldownMs).toBe(500);
    expect(play.cooldownTotalMs).toBe(500);

    setCooldown(play, 900);
    expect(play.cooldownMs).toBe(900);
    expect(play.cooldownTotalMs).toBe(900);
  });
});
