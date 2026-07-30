import { describe, expect, it } from "vitest";
import {
  actorDisplayName,
  actorKind,
  actorNameplateText,
  actorSecondaryLine,
  gaiaSpeciesForSprite,
  isCombatNpc,
  isFarmableCreatureIdentity,
  isSocialNpc,
  serverAuthorityDisplayName,
  usesRifleRunPose,
  usesSocialIdlePose,
} from "./npcSystem";

describe("npcSystem", () => {
  it("classifies Gaia creatures by their canonical role and preserves server names", () => {
    const actor = {
      id: "open-desert-bellback-03-1",
      label: "bellback grazer",
      role: "creature",
      sprite: "creature-bellback-adult",
    };

    expect(isFarmableCreatureIdentity(actor)).toBe(true);
    expect(actorKind(actor)).toBe("combat_npc");
    expect(actorDisplayName(actor)).toBe("bellback grazer");
    expect(actorNameplateText({ ...actor, guildTag: null })).toBe("bellback grazer");
  });

  it("does not infer farmable creature identity from an id, label, or model", () => {
    expect(isFarmableCreatureIdentity({ role: "remote_actor" })).toBe(false);
    expect(isFarmableCreatureIdentity({ role: "skirmisher" })).toBe(false);
    expect(isFarmableCreatureIdentity({ role: "player" })).toBe(false);
  });

  it("maps exactly the six Gaia adult sprites to species type lines", () => {
    const species = {
      "creature-bellback-adult": "bellback",
      "creature-pebblehorn-adult": "pebblehorn",
      "creature-snufflefin-adult": "snufflefin",
      "creature-pocketclod-adult": "pocketclod",
      "creature-mossmuff-adult": "mossmuff",
      "creature-dapplepod-adult": "dapplepod",
    };
    for (const [sprite, base] of Object.entries(species)) {
      expect(gaiaSpeciesForSprite(sprite)).toBe(base);
      const actor = { id: `zone-${base}-1`, label: `${base} roamer`, role: "creature", sprite };
      expect(actorSecondaryLine(undefined, undefined, actor)).toBe(`(a ${base})`);
    }
    expect(gaiaSpeciesForSprite("creature-bellback-juvenile")).toBe(null);
    expect(actorSecondaryLine(undefined, undefined, { id: "x", role: "creature", sprite: "creature-bellback-juvenile" })).toBe("(a creature)");
    expect(actorSecondaryLine("a bellback", undefined, { id: "x", role: "creature", sprite: "creature-bellback-adult" })).toBe("(a bellback)");
  });

  it("keeps humanoid NPC names clean and type reads in the secondary line", () => {
    const actor = {
      id: "skirmish-red-assault",
      label: "Rook Vale",
      role: "skirmisher_assault",
      sprite: "adventurer-premium-male",
      guildTag: "RED",
    };

    expect(actorKind(actor)).toBe("combat_npc");
    expect(actorDisplayName(actor)).toBe("Rook Vale");
    expect(actorNameplateText(actor)).toBe("Rook Vale <RED>");
    expect(actorSecondaryLine(undefined, undefined, actor)).toBe("(a skirmisher assault)");
    expect(actorSecondaryLine("a rogue drifter", undefined, actor)).toBe("(a rogue drifter)");
    expect(usesRifleRunPose(actor)).toBe(true);
  });

  it("keeps rogue brawlers off the rifle-run presentation", () => {
    const actor = {
      id: "rogue-range-brawler-01",
      label: "Hale Vex",
      role: "skirmisher_brawler",
      sprite: "adventurer-premium-male",
      guildTag: null,
    };

    expect(actorKind(actor)).toBe("combat_npc");
    expect(actorDisplayName(actor)).toBe("Hale Vex");
    expect(actorSecondaryLine(undefined, undefined, actor)).toBe("(a rogue brawler)");
    expect(isCombatNpc(actor)).toBe(true);
    expect(usesRifleRunPose(actor)).toBe(false);
  });

  it("keeps player and social role presentation distinct", () => {
    const player = {
      id: "desert-warden-agent-lead-01",
      label: "Warden Lead",
      role: "agent_player",
      sprite: "adventurer-premium-female",
      guildTag: "WARD",
    };
    expect(actorKind(player)).toBe("player");
    expect(actorNameplateText(player)).toBe("Warden Lead <WARD>");
    expect(usesRifleRunPose(player)).toBe(true);

    const shopkeeper = { id: "vendor", role: "public_shopkeeper", sprite: "adventurer-premium-male" };
    expect(isSocialNpc(shopkeeper)).toBe(true);
    expect(usesSocialIdlePose(shopkeeper)).toBe(true);
  });

  it("uses player organization tags when no guild tag is present", () => {
    const actor = {
      id: "player",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      guildTag: null,
      playerOrganizationTag: "WARD",
    };

    expect(actorNameplateText(actor)).toBe("Field Observer <WARD>");
  });

  it("accepts any non-empty authoritative display name verbatim", () => {
    expect(serverAuthorityDisplayName("  Duskback  ")).toBe("Duskback");
    expect(serverAuthorityDisplayName("  ")).toBeNull();
    expect(serverAuthorityDisplayName(null)).toBeNull();
  });
});
