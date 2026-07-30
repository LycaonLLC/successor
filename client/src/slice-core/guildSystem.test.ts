import { describe, expect, it } from "vitest";
import {
  authorityCommandKind,
  createAuthorityCommandQueue,
  enqueueAuthorityGuildAcceptInviteCommand,
  enqueueAuthorityGuildAcceptWarCommand,
  enqueueAuthorityGuildCreateCommand,
  enqueueAuthorityGuildDeclareWarCommand,
  enqueueAuthorityGuildDeclineInviteCommand,
  enqueueAuthorityGuildDisbandCommand,
  enqueueAuthorityGuildInviteCommand,
  enqueueAuthorityGuildKickCommand,
  enqueueAuthorityGuildLeaveCommand,
  enqueueAuthorityGuildRescindWarCommand,
  enqueueAuthorityGuildSetPermissionsCommand,
  enqueueAuthorityGuildSetRoleCommand,
  enqueueAuthorityGuildTransferLeadershipCommand,
} from "./authorityCommandSystem";
import { applyServerPacket } from "./gameAuthoritySystem";
import {
  createPlayState,
  type ServerAuthorityGuildViewState,
  type SliceSnapshot,
} from "./gameState";
import {
  GUILD_CHARTER_FEE_CREDITS,
  guildPermissionMaskToList,
  guildPermissionsToMask,
  hasGuildPermission,
  isGuildLeader,
  isGuildMember,
  localGuildRosterEntry,
} from "./guildSystem";


import type { SfxPlayer } from "../audio/sfx";

function stubSfx(): SfxPlayer {
  return { play: () => undefined, playAt: () => undefined } as unknown as SfxPlayer;
}
function slice(): SliceSnapshot {
  return {
    schema: "fixture",
    tick: 20,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Guild Test", width: 24, height: 24, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Guild Test", kind: "overworld", width: 24, height: 24, level: 0 }],
    stateHash: "guild-authority-test",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "open-desert-overworld",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  } as unknown as SliceSnapshot;
}

const counters = { acceptedCommands: 0, rejectedCommands: 0, shotsFired: 0, hits: 0, deaths: 0 };

function memberView(): ServerAuthorityGuildViewState {
  return {
    guild: {
      id: "guild_dune",
      name: "Dune Cooperative",
      tag: "DUNE",
      leaderActorId: "player",
      createdTick: 10,
      memberCount: 2,
      wars: [
        { opposingGuildId: "guild_rust", opposingName: "Rust Pact", opposingTag: "RUST", state: "incoming", declaredTick: 12 },
      ],
    },
    roster: [
      { actorId: "player", name: "Field Observer", role: "leader", permissions: [], online: true, areaId: "open-desert-overworld", lastSeenTick: 20 },
      { actorId: "vendor", name: "Warden", role: "member", permissions: ["invite"], online: false, areaId: "should-be-scrubbed", lastSeenTick: 5 },
    ],
    pendingInvites: [],
    directory: [
      { id: "guild_dune", name: "Dune Cooperative", tag: "DUNE", memberCount: 2 },
      { id: "guild_rust", name: "Rust Pact", tag: "RUST", memberCount: 9 },
    ],
  };
}

function helloPacket(guilds?: ServerAuthorityGuildViewState) {
  return {
    type: "game.hello" as const,
    sessionId: "g_1",
    playerActorId: "player",
    serverTime: "1970-01-01T00:00:00.000Z",
    snapshot: {
      schema: "successor.authoritative-shard-snapshot.v1" as const,
      shardId: "test",
      tick: 20,
      playerActorId: "player",
      sourceStateHash: "guild-authority-test",
      sourceActorCount: 1,
      actors: {},
      ...(guilds !== undefined ? { guilds } : {}),
      counters,
    },
  };
}

function deltaPacket(tick: number, guilds?: ServerAuthorityGuildViewState) {
  return {
    type: "game.delta" as const,
    receipts: [],
    delta: {
      schema: "successor.authoritative-shard-delta.v1" as const,
      shardId: "test",
      tick,
      playerActorId: "player",
      actors: {},
      ...(guilds !== undefined ? { guilds } : {}),
      counters,
    },
    events: [],
  };
}

describe("authority.guilds projection", () => {
  it("applies the member view from a hello snapshot and scrubs offline areas", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, helloPacket(memberView()), stubSfx());

    const view = state.serverAuthority.guilds;
    expect(view.guild?.tag).toBe("DUNE");
    expect(view.guild?.leaderActorId).toBe("player");
    expect(view.guild?.wars).toEqual([
      { opposingGuildId: "guild_rust", opposingName: "Rust Pact", opposingTag: "RUST", state: "incoming", declaredTick: 12 },
    ]);
    // Online member keeps its area; the OFFLINE member's area is scrubbed to
    // null client-side even when a wire payload slips one through.
    expect(view.roster[0]?.areaId).toBe("open-desert-overworld");
    expect(view.roster[1]?.online).toBe(false);
    expect(view.roster[1]?.areaId).toBeNull();
    expect(view.roster[1]?.lastSeenTick).toBe(5);
    expect(view.directory).toHaveLength(2);
  });

  it("omission retains, presence replaces, and the outsider view clears membership", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, helloPacket(memberView()), stubSfx());

    // Delta WITHOUT a guilds key: no change.
    applyServerPacket(state, sliceSnapshot, deltaPacket(21), stubSfx());
    expect(state.serverAuthority.guilds.guild?.id).toBe("guild_dune");
    expect(state.serverAuthority.guilds.roster).toHaveLength(2);

    // Delta WITH an outsider view (post-leave): guild + roster clear, the
    // public directory is all that remains, invites flow for outsiders.
    applyServerPacket(state, sliceSnapshot, deltaPacket(22, {
      roster: [],
      pendingInvites: [{
        inviteId: "inv_1",
        guildId: "guild_rust",
        guildName: "Rust Pact",
        guildTag: "RUST",
        inviterActorId: "vendor",
        inviterName: "Warden",
        issuedTick: 21,
        expiresTick: 921,
      }],
      directory: [{ id: "guild_rust", name: "Rust Pact", tag: "RUST", memberCount: 9 }],
    }), stubSfx());

    const view = state.serverAuthority.guilds;
    expect(view.guild).toBeUndefined();
    expect(view.roster).toEqual([]);
    expect(view.pendingInvites[0]?.inviteId).toBe("inv_1");
    expect(view.directory).toEqual([{ id: "guild_rust", name: "Rust Pact", tag: "RUST", memberCount: 9 }]);
    // Outsider privacy: no roster presence/location data survives anywhere.
    expect(JSON.stringify(view)).not.toContain("open-desert-overworld");
  });

  it("starts empty so outsiders render directory-only before any packet", () => {
    const state = createPlayState(slice());
    expect(state.serverAuthority.guilds).toEqual({ roster: [], pendingInvites: [], directory: [] });
    expect(isGuildMember(state)).toBe(false);
  });
});

describe("guild selectors and the frozen permission mask", () => {
  it("maps permission strings to the frozen u8 mask and back in stable order", () => {
    expect(guildPermissionsToMask(["invite"])).toBe(1);
    expect(guildPermissionsToMask(["kick"])).toBe(2);
    expect(guildPermissionsToMask(["roles"])).toBe(4);
    expect(guildPermissionsToMask(["war"])).toBe(8);
    expect(guildPermissionsToMask(["disband"])).toBe(16);
    expect(guildPermissionsToMask(["disband", "invite", "war"])).toBe(25);
    expect(guildPermissionMaskToList(25)).toEqual(["invite", "war", "disband"]);
    expect(guildPermissionMaskToList(0)).toEqual([]);
    // Unknown high bits drop instead of inventing permissions.
    expect(guildPermissionMaskToList(0b1110_0000)).toEqual([]);
  });

  it("grants the leader every permission implicitly; members need the explicit string", () => {
    const sliceSnapshot = slice();
    const state = createPlayState(sliceSnapshot);
    applyServerPacket(state, sliceSnapshot, helloPacket(memberView()), stubSfx());
    state.serverAuthority.playerActorId = "player";

    expect(isGuildMember(state)).toBe(true);
    expect(isGuildLeader(state)).toBe(true);
    expect(localGuildRosterEntry(state)?.role).toBe("leader");
    for (const permission of ["invite", "kick", "roles", "war", "disband"] as const) {
      expect(hasGuildPermission(state, permission)).toBe(true);
    }

    // Same view seen from the invite-only member.
    state.serverAuthority.playerActorId = "vendor";
    state.playerActorId = "vendor";
    expect(isGuildLeader(state)).toBe(false);
    expect(hasGuildPermission(state, "invite")).toBe(true);
    expect(hasGuildPermission(state, "kick")).toBe(false);
    expect(hasGuildPermission(state, "war")).toBe(false);
  });

  it("exposes the exact frozen charter fee", () => {
    expect(GUILD_CHARTER_FEE_CREDITS).toBe(250_000);
  });
});

describe("guild command wire payloads (frozen contract)", () => {
  it("enqueues every guild command with PascalCase variants and snake_case fields", () => {
    const queue = createAuthorityCommandQueue(3, 9);
    expect(enqueueAuthorityGuildCreateCommand(queue, "  Dune Cooperative ", "dune", "pa-terminal-dustgate", 40)?.command)
      .toEqual({ GuildCreate: { name: "Dune Cooperative", tag: "DUNE", terminal_prop_id: "pa-terminal-dustgate" } });
    expect(enqueueAuthorityGuildInviteCommand(queue, "p2", 41)?.command)
      .toEqual({ GuildInvite: { target_actor_id: "p2" } });
    expect(enqueueAuthorityGuildAcceptInviteCommand(queue, "inv_1", 42)?.command)
      .toEqual({ GuildAcceptInvite: { invite_id: "inv_1" } });
    expect(enqueueAuthorityGuildDeclineInviteCommand(queue, "inv_1", 43)?.command)
      .toEqual({ GuildDeclineInvite: { invite_id: "inv_1" } });
    expect(enqueueAuthorityGuildLeaveCommand(queue, 44).command).toEqual({ GuildLeave: {} });
    expect(enqueueAuthorityGuildKickCommand(queue, "p3", 45)?.command)
      .toEqual({ GuildKick: { target_actor_id: "p3" } });
    expect(enqueueAuthorityGuildSetRoleCommand(queue, "p2", "officer", 46)?.command)
      .toEqual({ GuildSetRole: { target_actor_id: "p2", role: "officer" } });
    expect(enqueueAuthorityGuildSetPermissionsCommand(queue, "p2", 25, 47)?.command)
      .toEqual({ GuildSetPermissions: { target_actor_id: "p2", permissions: 25 } });
    expect(enqueueAuthorityGuildTransferLeadershipCommand(queue, "p2", 48)?.command)
      .toEqual({ GuildTransferLeadership: { target_actor_id: "p2" } });
    expect(enqueueAuthorityGuildDeclareWarCommand(queue, "guild_rust", 49)?.command)
      .toEqual({ GuildDeclareWar: { opposing_guild_id: "guild_rust" } });
    expect(enqueueAuthorityGuildAcceptWarCommand(queue, "guild_rust", 50)?.command)
      .toEqual({ GuildAcceptWar: { opposing_guild_id: "guild_rust" } });
    expect(enqueueAuthorityGuildRescindWarCommand(queue, "guild_rust", 51)?.command)
      .toEqual({ GuildRescindWar: { opposing_guild_id: "guild_rust" } });
    expect(enqueueAuthorityGuildDisbandCommand(queue, 52).command).toEqual({ GuildDisband: {} });

    for (const kind of [
      "GuildCreate", "GuildInvite", "GuildAcceptInvite", "GuildDeclineInvite", "GuildLeave", "GuildKick",
      "GuildSetRole", "GuildSetPermissions", "GuildTransferLeadership", "GuildDeclareWar", "GuildAcceptWar",
      "GuildRescindWar", "GuildDisband",
    ]) {
      expect(queue.totalByKind[kind as keyof typeof queue.totalByKind]).toBe(1);
    }
  });

  it("resolves kinds and refuses malformed payloads before they reach the wire", () => {
    const queue = createAuthorityCommandQueue(3, 9);
    expect(authorityCommandKind({ GuildCreate: { name: "x", tag: "X", terminal_prop_id: "t" } })).toBe("GuildCreate");
    expect(authorityCommandKind({ GuildDisband: {} })).toBe("GuildDisband");
    expect(enqueueAuthorityGuildCreateCommand(queue, "  ", "DUNE", "t", 1)).toBeNull();
    expect(enqueueAuthorityGuildCreateCommand(queue, "Dune", "DUNE", "", 1)).toBeNull();
    expect(enqueueAuthorityGuildInviteCommand(queue, "  ", 1)).toBeNull();
    expect(enqueueAuthorityGuildSetPermissionsCommand(queue, "p2", -1, 1)).toBeNull();
    expect(enqueueAuthorityGuildSetPermissionsCommand(queue, "p2", 256, 1)).toBeNull();
    expect(enqueueAuthorityGuildSetPermissionsCommand(queue, "p2", 2.5, 1)).toBeNull();
    expect(queue.pending).toHaveLength(0);
  });
});
