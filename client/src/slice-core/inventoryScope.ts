import type { InventoryRow, PlayState } from "./gameState";

export interface InventoryOwnerIdentity {
  playerId?: string | null;
  characterId?: string | null;
}

export interface InventoryScope {
  readonly ownerIds: readonly string[];
  readonly ownerPrefixes: readonly string[];
}

export interface MutableInventoryScope extends InventoryScope {
  ownerIds: string[];
  ownerPrefixes: string[];
  signature: string;
}

export function createInventoryScope(): MutableInventoryScope {
  return { ownerIds: [], ownerPrefixes: [], signature: "" };
}

export function inventoryScopeForState(
  state: PlayState,
  identity: InventoryOwnerIdentity | null | undefined = null,
): InventoryScope {
  return refreshInventoryScope(createInventoryScope(), state, identity);
}

export function refreshInventoryScope(
  scope: MutableInventoryScope,
  state: PlayState,
  identity: InventoryOwnerIdentity | null | undefined = null,
): InventoryScope {
  const authorityActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const playerActorId = state.playerActorId;
  const identityPlayerId = identity?.playerId ?? null;
  const identityCharacterId = identity?.characterId ?? null;
  const signature = `${authorityActorId}\u0000${playerActorId}\u0000${identityPlayerId ?? ""}\u0000${identityCharacterId ?? ""}`;
  if (signature === scope.signature) return scope;

  scope.signature = signature;
  scope.ownerIds.length = 0;
  scope.ownerPrefixes.length = 0;
  for (const id of [authorityActorId, playerActorId, identityPlayerId, identityCharacterId]) {
    if (id && !scope.ownerIds.includes(id)) {
      scope.ownerIds.push(id);
      scope.ownerPrefixes.push(`${id}:`);
    }
  }
  return scope;
}

export function isLocalInventoryContainerInScope(scope: InventoryScope, container: string): boolean {
  for (let index = 0; index < scope.ownerIds.length; index += 1) {
    if (container === scope.ownerIds[index] || container.startsWith(scope.ownerPrefixes[index]!)) return true;
  }
  return false;
}

export function isLocalOwnerInventoryRowInScope(row: InventoryRow, scope: InventoryScope): boolean {
  return isLocalInventoryContainerInScope(scope, row.container);
}

/** Datapad rows: exchange-stored stacks + mission/schematic chits held by the player. */
export function isDatapadInventoryRowInScope(row: InventoryRow, scope: InventoryScope): boolean {
  if (row.container === "district-exchange") return true;
  return (row.itemId === 4001 || row.itemId === 5003) && isLocalInventoryContainerInScope(scope, row.container);
}

/** Rows a player can legitimately see through the inventory/datapad surfaces. */
export function isInventorySurfaceRowInScope(row: InventoryRow, scope: InventoryScope): boolean {
  return row.available > 0 && (
    isLocalOwnerInventoryRowInScope(row, scope)
    || isDatapadInventoryRowInScope(row, scope)
  );
}

export function isLocalInventoryContainer(
  state: PlayState,
  container: string,
  identity: InventoryOwnerIdentity | null | undefined = null,
): boolean {
  return isLocalInventoryContainerInScope(inventoryScopeForState(state, identity), container);
}
