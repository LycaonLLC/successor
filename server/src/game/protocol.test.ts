import { describe, expect, it } from "vitest";

import { clientCommandSchema, weaponIdSchema, ammoTypeSchema, gameWeatherSnapshotSchema } from "./protocol.js";
import {
  authorityWeaponIds,
  authorityWeaponMagazineSize,
  authorityWeaponProfiles,
  isAuthorityWeaponId,
} from "./weapons.js";
import { defaultAmmoTypeId, normalizeAuthorityAmmoType } from "./ammo.js";


const validWeatherSnapshot = {
  areaId: "open-desert-overworld",
  eventType: "sandstorm",
  phase: "active",
  centerX: 512,
  centerY: 512,
  radiusCells: 48,
  intensity: 1,
  magnitude: 0.85,
  phaseEndsAtTick: 3_450,
  resolvesAtTick: 3_750,
  sweepDirRad: 1.2112585008840648,
};
describe("game protocol", () => {
  it("accepts flat authoritative weather snapshots with sweep direction", () => {
    expect(gameWeatherSnapshotSchema.safeParse(validWeatherSnapshot).success).toBe(true);
    expect(gameWeatherSnapshotSchema.safeParse({ ...validWeatherSnapshot, centerCell: { x: 512, y: 512 } }).success).toBe(true);
    expect(gameWeatherSnapshotSchema.safeParse({ ...validWeatherSnapshot, centerX: undefined }).success).toBe(false);
    expect(gameWeatherSnapshotSchema.safeParse({ ...validWeatherSnapshot, sweepDirRad: undefined }).success).toBe(false);
    expect(gameWeatherSnapshotSchema.safeParse({ ...validWeatherSnapshot, magnitude: undefined }).success).toBe(false);
    expect(gameWeatherSnapshotSchema.safeParse({ ...validWeatherSnapshot, resolvesAtTick: undefined }).success).toBe(false);
  });

  it("rejects multi-kind and nested authority commands before command handling", () => {
    const resourceAndCombat = clientCommandSchema.safeParse({
      QueueCombatAction: { action_id: "basic_shot", target_actor_id: "target" },
      SurveyResource: { family: "mineral" },
    });
    const nestedResourceAndCombat = clientCommandSchema.safeParse({
      QueueCombatAction: {
        action_id: "basic_shot",
        target_actor_id: "target",
        SurveyResource: { family: "mineral" },
      },
    });

    expect(resourceAndCombat.success).toBe(false);
    expect(nestedResourceAndCombat.success).toBe(false);
  });

  it("accepts every bank, backup, and corpse-credit command with exact ids", () => {
    const id = `${"x".repeat(64)}.crafted`;
    const commands = [
      { BankStoreItem: { source_stack_id: id, quantity: 2 } },
      { BankRetrieveItem: { bank_stack_id: id, quantity: 1 } },
      { BankDepositCredits: { amount: 1000 } },
      { BankWithdrawCredits: { amount: 1000 } },
      { CloneSaveSkillBackup: {} },
      { CorpseTakeCredits: { corpse_id: id } },
    ];
    for (const command of commands) expect(clientCommandSchema.safeParse(command).success).toBe(true);
  });

  it("accepts SampleResource auto-repeat stop flag", () => {
    expect(clientCommandSchema.safeParse({ SampleResource: { family: "mineral" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ SampleResource: { family: "mineral", stop: true } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ SampleResource: { family: "mineral", stop: false } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ SampleResource: { family: "mineral", stop: "true" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ SampleResource: { family: "mineral", cancel: true } }).success).toBe(false);
  });
  it("accepts valid SetEquippedClothing commands and rejects malformed payloads", () => {
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7301, equipped: true },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7335, equipped: false },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: {
        item_id: 7201,
        equipped: true,
        container: "player:field-pack",
        stack_id: "3",
        variant_id: 0,
      },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: -1, equipped: true },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7301.5, equipped: false },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7301, equipped: "true" },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { itemId: 7301, equipped: true },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7301, equipped: true, colors: [] },
    }).success).toBe(false);
    expect(clientCommandSchema.safeParse({
      SetEquippedClothing: { item_id: 7201, equipped: true, container: "", stack_id: "3", variant_id: 0 },
    }).success).toBe(false);
    for (const stackId of ["", "0", " 3", "3 ", "not-a-stack"]) {
      expect(clientCommandSchema.safeParse({
        SetEquippedClothing: { item_id: 7201, equipped: true, stack_id: stackId, variant_id: 0 },
      }).success).toBe(false);
    }
  });

  it("accepts placed extractor command shapes with exact snake-case ids", () => {
    expect(clientCommandSchema.safeParse({ PlaceExtractor: { family: "mineral" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ CrankExtractor: { extractor_id: "extractor:player:1" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ StopCrank: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ InsertBattery: { extractor_id: "extractor:player:1", container: "player:field-pack", stack_id: "7", variant_id: 32_000_060 } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ CollectExtractor: { extractor_id: "extractor:player:1" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ DestroyExtractor: { extractor_id: "extractor:player:1" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ CrankExtractor: { extractorId: "extractor:player:1" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ StopCrank: { extractor_id: "extractor:player:1" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ InsertBattery: { extractorId: "extractor:player:1", container: "player:field-pack", stack_id: "7", variant_id: 32_000_060 } }).success).toBe(false);
  });

  it("accepts group command shapes and rejects malformed ones", () => {
    expect(clientCommandSchema.safeParse({ GroupInvite: { target_actor_id: "p2" } }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ GroupAccept: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ GroupDecline: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ GroupLeave: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ GroupDisband: {} }).success).toBe(true);
    expect(clientCommandSchema.safeParse({ GroupKick: { target_actor_id: "p2" } }).success).toBe(true);
    // Missing required target, camelCase drift, and extra fields on unit commands are rejected.
    expect(clientCommandSchema.safeParse({ GroupInvite: {} }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ GroupInvite: { targetActorId: "p2" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ GroupKick: {} }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ GroupAccept: { target_actor_id: "p2" } }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ GroupLeave: { foo: 1 } }).success).toBe(false);
  });

  it("requires exact variants on exchange commands", () => {
    expect(
      clientCommandSchema.safeParse({
        StoreToExchange: { item_id: 2001, quantity: 1 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        RetrieveFromExchange: { item_id: 2001, quantity: 1 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        StoreToExchange: { item_id: 2001, variant_id: 7, quantity: 1 },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        RetrieveFromExchange: { item_id: 2001, variant_id: 7, quantity: 1 },
      }).success,
    ).toBe(true);
  });

  it("accepts exact per-stack loot takes and rejects retired loot container commands", () => {
    expect(
      clientCommandSchema.safeParse({
        TakeLootItem: { container: "corpse:rogue-1", itemId: 1001, variantId: 7, quantity: 3 },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        TakeLootItem: { container: "", itemId: 1001, variantId: 7, quantity: 3 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        TakeLootItem: { container: "cache:open-desert-cache-01", itemId: 1001, variantId: 7, quantity: 0 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        TakeLootItem: { container: "cache:open-desert-cache-01", item_id: 1001, variant_id: 7, quantity: 1 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        LootContainer: { prop_id: "open-desert-cache-01" },
      }).success,
    ).toBe(false);
  });

  it("accepts credit-chip redeem shapes and rejects malformed ones", () => {
    expect(
      clientCommandSchema.safeParse({
        RedeemCreditChip: { container: "player:field-pack", stack_id: "7" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        RedeemCreditChip: { container: "", stack_id: "7" },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        RedeemCreditChip: { container: "player:field-pack", stack_id: "" },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        RedeemCreditChip: { container: "player:field-pack" },
      }).success,
    ).toBe(false);
  });

  it("accepts exact discard-stack fingerprint and rejects malformed payloads", () => {
    expect(
      clientCommandSchema.safeParse({
        DiscardStack: { container: "player:field-pack", stack_id: "7", item_id: 2_001, variant_id: 7 },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        DiscardStack: { container: "", stack_id: "7", item_id: 2_001, variant_id: 7 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        DiscardStack: { container: "player:field-pack", stack_id: "7", item_id: 2_001 },
      }).success,
    ).toBe(false);
  });

  it("accepts additive travel ticket commands", () => {
    expect(
      clientCommandSchema.safeParse({
        PurchaseTravelTicket: {
          terminal_prop_id: "travel-terminal-dustgate",
          to_planet_id: "verdance",
          to_city_id: "lowbough",
        },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        PurchaseTravelTicket: {
          terminalPropId: "travel-terminal-dustgate",
          to_planet_id: "verdance",
          to_city_id: "lowbough",
        },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        UseTravelTicket: {
          container: "player:field-pack",
          stack_id: "7",
          item_id: "travel_ticket",
          item_numeric_id: 5001,
        },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        UseTravelTicket: {
          stack_id: "",
          item_id: "boarding_pass",
        },
      }).success,
    ).toBe(false);
  });

  it("accepts toggle door commands with exact snake-case prop ids", () => {
    expect(
      clientCommandSchema.safeParse({
        ToggleDoor: { prop_id: "open-desert-shelter-house" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        ToggleDoor: { propId: "open-desert-shelter-house" },
      }).success,
    ).toBe(false);
  });

  it("accepts roll queue combat actions with bounded target ids and known action ids", () => {
    expect(
      clientCommandSchema.safeParse({
        QueueCombatAction: { action_id: "basic_shot", target_actor_id: "skirmish-1" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        QueueCombatAction: { action_id: "aimed_shot", target_actor_id: "skirmish-1" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        QueueCombatAction: { action_id: "burst_shot", target_actor_id: "skirmish-1" },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        QueueCombatAction: { action_id: "basic_shot", target_actor_id: "" },
      }).success,
    ).toBe(false);
  });

  it("accepts roll peace commands with an empty payload", () => {
    expect(
      clientCommandSchema.safeParse({
        Peace: {},
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        Peace: { target_actor_id: "skirmish-1" },
      }).success,
    ).toBe(false);
  });

  it("accepts single ability queue cancel command shape and bounded scopes", () => {
    expect(
      clientCommandSchema.safeParse({
        CancelAbilityQueue: {},
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CancelAbilityQueue: { scope: "owner_repeat" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CancelAbilityQueue: { queue_entry_id: "q_1", scope: "combat" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CancelAbilityQueue: { scope: "everything" },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        ClearCombatQueue: {},
      }).success,
    ).toBe(false);
  });

  it("accepts revive actor commands with an exact target actor", () => {
    expect(
      clientCommandSchema.safeParse({
        ReviveActor: { target_actor_id: "desert-warden-agent-wing-02" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        ReviveActor: {},
      }).success,
    ).toBe(false);
  });

  it("accepts optional clone respawn facility ids and rejects invalid shapes", () => {
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: {},
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: { facility_id: "camp-clone-vat" },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: { facility_id: null },
      }).success,
    ).toBe(true);
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: { facility_id: "" },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: { facility_id: 7 },
      }).success,
    ).toBe(false);
    expect(
      clientCommandSchema.safeParse({
        CloneRespawn: { facilityId: "camp-clone-vat" },
      }).success,
    ).toBe(false);
  });

  it("requires exact variants on direct ProposeTrade lines", () => {
    expect(
      clientCommandSchema.safeParse({
        ProposeTrade: {
          partner_actor_id: "desert-warden-agent-wing-02",
          offer: [{ item_id: 1001, quantity: 1 }],
          request: [],
        },
      }).success,
    ).toBe(false);

    expect(
      clientCommandSchema.safeParse({
        ProposeTrade: {
          partner_actor_id: "desert-warden-agent-wing-02",
          offer: [{ item_id: 1001, variant_id: 0, quantity: 1 }],
          request: [],
        },
      }).success,
    ).toBe(true);
  });
  it("accepts all thirteen Guild command schemas", () => {
    const commands = [
      { GuildCreate: { name: "Dust", tag: "DST", terminal_prop_id: "pa" } },
      { GuildInvite: { target_actor_id: "actor" } },
      { GuildAcceptInvite: { invite_id: "invite" } },
      { GuildDeclineInvite: { invite_id: "invite" } },
      { GuildLeave: {} },
      { GuildKick: { target_actor_id: "actor" } },
      { GuildSetRole: { target_actor_id: "actor", role: "officer" } },
      { GuildSetPermissions: { target_actor_id: "actor", permissions: 31 } },
      { GuildTransferLeadership: { target_actor_id: "actor" } },
      { GuildDeclareWar: { opposing_guild_id: "guild-2" } },
      { GuildAcceptWar: { opposing_guild_id: "guild-2" } },
      { GuildRescindWar: { opposing_guild_id: "guild-2" } },
      { GuildDisband: {} },
    ];
    expect(commands.every((command) => clientCommandSchema.safeParse(command).success)).toBe(true);
  });
});

describe("canonical weapon and ammunition protocol", () => {
  it("accepts every authority weapon id and rejects unknown ids", () => {
    for (const weaponId of authorityWeaponIds) {
      expect(weaponIdSchema.safeParse(weaponId).success).toBe(true);
      expect(isAuthorityWeaponId(weaponId)).toBe(true);
    }
    expect(weaponIdSchema.safeParse("unknown-weapon").success).toBe(false);
    expect(isAuthorityWeaponId("unknown-weapon")).toBe(false);
  });

  it("accepts the canonical slug and melee ammunition ids", () => {
    expect(ammoTypeSchema.safeParse("slug_iron").success).toBe(true);
    expect(ammoTypeSchema.safeParse("slug_shard").success).toBe(true);
    expect(ammoTypeSchema.safeParse("slug_spike").success).toBe(true);
    expect(ammoTypeSchema.safeParse("melee").success).toBe(true);
    expect(ammoTypeSchema.safeParse("unknown-ammo").success).toBe(false);
  });

  it("slugthrower profile exists at weapon id 'slugthrower' with slug-caliber ammo", () => {
    const profile = authorityWeaponProfiles["slugthrower"];
    expect(profile.id).toBe("slugthrower");
    expect(profile.defaultAmmoType).toBe("slug_iron");
    expect(profile.compatibleAmmoTypes).toEqual(expect.arrayContaining(["slug_iron", "slug_shard", "slug_spike"]));
  });

  it("publishes a profile for every authority weapon id", () => {
    expect(Object.keys(authorityWeaponProfiles)).toEqual([...authorityWeaponIds]);
  });

  it("keeps melee single-round and every ranged catalog weapon on the shared 30-round magazine", () => {
    for (const weaponId of [
      "vibrosword",
      "scrapline-machete",
      "field-saber",
      "quarry-chopper",
      "unarmed",
    ] as const) {
      expect(authorityWeaponProfiles[weaponId].defaultAmmoType).toBe("melee");
      expect(authorityWeaponMagazineSize(weaponId)).toBe(1);
    }
    for (const weaponId of [
      "slugthrower",
      "wpn-pistol",
      "wpn-smg",
      "wpn-carbine",
      "lightning-carbine",
      "wpn-assault",
      "wpn-shotgun",
      "wpn-sniper",
      "wpn-heavy",
      "wpn-launcher",
    ] as const) {
      expect(authorityWeaponProfiles[weaponId].defaultAmmoType).toBe("slug_iron");
      expect(authorityWeaponMagazineSize(weaponId)).toBe(30);
    }
  });

  it("normalizes canonical ammunition ids and defaults unknown wire values", () => {
    expect(normalizeAuthorityAmmoType("slug_iron")).toBe("slug_iron");
    expect(normalizeAuthorityAmmoType("slug_shard")).toBe("slug_shard");
    expect(normalizeAuthorityAmmoType("slug_spike")).toBe("slug_spike");
    expect(normalizeAuthorityAmmoType("melee")).toBe("melee");
    expect(normalizeAuthorityAmmoType("unknown-ammo")).toBe(defaultAmmoTypeId);
    expect(normalizeAuthorityAmmoType(null)).toBe(defaultAmmoTypeId);
  });

  it("ReloadWeapon accepts canonical ids and rejects unknown values", () => {
    const valid = clientCommandSchema.safeParse({
      ReloadWeapon: { weapon_id: "slugthrower", ammo_type: "slug_iron" },
    });
    expect(valid.success).toBe(true);

    const unknownWeapon = clientCommandSchema.safeParse({
      ReloadWeapon: { weapon_id: "unknown-weapon", ammo_type: "slug_iron" },
    });
    expect(unknownWeapon.success).toBe(false);

    const unknownAmmo = clientCommandSchema.safeParse({
      ReloadWeapon: { weapon_id: "slugthrower", ammo_type: "unknown-ammo" },
    });
    expect(unknownAmmo.success).toBe(false);
  });

  it("SetEquippedWeapon accepts canonical values and rejects unknown ids", () => {
    expect(clientCommandSchema.safeParse({
      SetEquippedWeapon: { weapon_id: "slugthrower" },
    }).success).toBe(true);
    expect(clientCommandSchema.safeParse({
      SetEquippedWeapon: { weapon_id: "slugthrower", weapon_item_id: 3101, weapon_variant_id: 17 },
    }).success).toBe(true);

    expect(clientCommandSchema.safeParse({
      SetEquippedWeapon: { weapon_id: "unknown-weapon" },
    }).success).toBe(false);
  });
});
