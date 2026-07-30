import type {
  ServerAuthorityActorAppearanceState,
  ServerAuthorityActorState,
  ServerAuthorityWeaponState,
} from "@successor/client/src/slice-core/gameState";

/** Read-only harness projection of the local authority actor for creation/relog truth. */
export interface Successor3dAuthorityPlayerDebugProjection {
  x: number;
  y: number;
  areaId: string | null;
  displayName: string;
  linkDead: boolean;
  appearance: ServerAuthorityActorAppearanceState | null;
  /** Creator worn set from the authority wire (item ids + zone colors). */
  worn: { item: string; colors: string[] }[];
  /** Durable creator palette cache from the authority wire (may include unequipped pieces). */
  wornColors: Record<string, string[]>;
  weapon: ServerAuthorityWeaponState | null;
  skillPointsUsed: number | null;
  skillPointsCap: number | null;
}

function roundThousandths(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Exact copy of authority actor fields the creation journey asserts after relog. */
export function authorityPlayerDebugProjection(
  authorityActor: ServerAuthorityActorState | null | undefined,
  playerActorId: string,
): Successor3dAuthorityPlayerDebugProjection | null {
  if (!authorityActor) return null;
  const worn = (authorityActor.worn ?? []).map((piece) => ({ item: piece.item, colors: [...piece.colors] }));
  const wornColorsSource = authorityActor.wornColors ?? {};
  const wornColors: Record<string, string[]> = {};
  for (const [item, colors] of Object.entries(wornColorsSource)) {
    if (!Array.isArray(colors)) continue;
    wornColors[item] = colors.map((color) => color);
  }
  // Equipped worn[].colors are authority for those pieces. Fill missing wornColors
  // keys from worn so the harness map check matches wire worn truth when the map
  // was dropped by compact deltas.
  for (const piece of worn) {
    if (!Object.prototype.hasOwnProperty.call(wornColors, piece.item)) {
      wornColors[piece.item] = [...piece.colors];
    }
  }
  return {
    x: roundThousandths(authorityActor.x),
    y: roundThousandths(authorityActor.y),
    areaId: authorityActor.areaId ?? null,
    displayName: authorityActor.displayName ?? authorityActor.label ?? playerActorId,
    linkDead: authorityActor.linkDead === true,
    appearance: authorityActor.appearance ? { ...authorityActor.appearance } : null,
    worn,
    wornColors,
    weapon: authorityActor.weapon
      ? {
          weaponId: authorityActor.weapon.weaponId,
          ...(authorityActor.weapon.weaponItemId === undefined ? {} : { weaponItemId: authorityActor.weapon.weaponItemId }),
          ...(authorityActor.weapon.weaponVariantId === undefined ? {} : { weaponVariantId: authorityActor.weapon.weaponVariantId }),
          ammoType: authorityActor.weapon.ammoType,
          loadedRounds: authorityActor.weapon.loadedRounds,
          magazineSize: authorityActor.weapon.magazineSize,
          reloadUntilTick: authorityActor.weapon.reloadUntilTick,
          reloadRemainingTicks: authorityActor.weapon.reloadRemainingTicks,
          reloadTotalTicks: authorityActor.weapon.reloadTotalTicks,
        }
      : null,
    skillPointsUsed: typeof authorityActor.skillPointsUsed === "number" ? authorityActor.skillPointsUsed : null,
    skillPointsCap: typeof authorityActor.skillPointsCap === "number" ? authorityActor.skillPointsCap : null,
  };
}
