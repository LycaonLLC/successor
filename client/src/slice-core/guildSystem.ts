import type {
  PlayState,
  ServerAuthorityGuildPermission,
  ServerAuthorityGuildRosterEntryState,
} from "./gameState";

/**
 * Player Association (guild) client selectors — the ONE place UI surfaces
 * read membership, permission, and wire-mask facts from the server-verified
 * `authority.guilds` projection. Chat gating, roster controls, and command
 * composition all resolve here so no surface invents its own membership rule.
 *
 * Contract freeze (2026-07-18, Main): permissions are the stable-order string
 * subset below; the `GuildSetPermissions` wire payload is a u8 bit mask
 * (invite=1, kick=2, roles=4, war=8, disband=16). The leader implicitly holds
 * every permission regardless of the stored subset.
 */

/** Authoritative charter price (sim re-validates; UI shows the exact figure). */
export const GUILD_CHARTER_FEE_CREDITS = 250_000;

/** Charter creation requires standing at a PA terminal (shared kiosk reach). */
export const GUILD_TERMINAL_REACH_CELLS = 1.75;

/** Stable wire/UI order — never re-sort. */
export const GUILD_PERMISSIONS: readonly ServerAuthorityGuildPermission[] =
  ["invite", "kick", "roles", "war", "disband"];

export const GUILD_PERMISSION_BITS: Record<ServerAuthorityGuildPermission, number> = {
  invite: 1,
  kick: 2,
  roles: 4,
  war: 8,
  disband: 16,
};

/** Projection strings -> `GuildSetPermissions.permissions` u8 mask. */
export function guildPermissionsToMask(permissions: readonly ServerAuthorityGuildPermission[]): number {
  let mask = 0;
  for (const permission of permissions) mask |= GUILD_PERMISSION_BITS[permission] ?? 0;
  return mask;
}

/** u8 mask -> stable-order string subset (unknown bits drop). */
export function guildPermissionMaskToList(mask: number): ServerAuthorityGuildPermission[] {
  return GUILD_PERMISSIONS.filter((permission) => (mask & GUILD_PERMISSION_BITS[permission]) !== 0);
}

type GuildStateSlice = Pick<PlayState, "playerActorId"> & {
  serverAuthority: Pick<PlayState["serverAuthority"], "guilds" | "playerActorId">;
};

/** The local player's roster row, or null when not a member. */
export function localGuildRosterEntry(state: GuildStateSlice): ServerAuthorityGuildRosterEntryState | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  return state.serverAuthority.guilds.roster.find((entry) => entry.actorId === actorId) ?? null;
}

/** Server-verified membership (guild chat gate): the projection carries OUR guild summary. */
export function isGuildMember(state: GuildStateSlice): boolean {
  return Boolean(state.serverAuthority.guilds.guild);
}

/**
 * Permission check against the authoritative roster row. Leader implicitly
 * holds all permissions; everyone else needs the explicit grant.
 */
export function hasGuildPermission(state: GuildStateSlice, permission: ServerAuthorityGuildPermission): boolean {
  const me = localGuildRosterEntry(state);
  if (!me) return false;
  if (me.role === "leader") return true;
  return me.permissions.includes(permission);
}

/** True when the local player leads the association. */
export function isGuildLeader(state: GuildStateSlice): boolean {
  const guild = state.serverAuthority.guilds.guild;
  if (!guild) return false;
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  return guild.leaderActorId === actorId;
}
