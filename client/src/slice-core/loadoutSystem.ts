import type { CertificateId } from "./combatTypes";
import { ammoTypeSpecs, normalizeAmmoTypeForCaliber, type AmmoTypeId } from "./ammoSystem";
import {
  authorityIssuedAtServerTick,
  createAuthorityCommandQueue,
  enqueueAuthorityReloadWeaponCommand,
  enqueueAuthoritySetEquippedWeaponCommand,
} from "./authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "./gameState";
import { weaponSpecs, type WeaponId, type WeaponSpec } from "./weaponSystem";
import { triggerWeaponReloadAnimation } from "./weaponPresentationSystem";

export function activeAmmoTypeId(state: PlayState, spec: WeaponSpec): AmmoTypeId {
  const selected = state.loadout.activeAmmo[spec.caliber];
  return normalizeAmmoTypeForCaliber(spec.caliber, selected);
}

export function activeAmmoTypeSpec(state: PlayState, spec: WeaponSpec) {
  return ammoTypeSpecs[activeAmmoTypeId(state, spec)];
}

export function setActiveAmmoType(state: PlayState, ammoTypeId: AmmoTypeId): boolean {
  const ammo = ammoTypeSpecs[ammoTypeId];
  const weapon = activeWeaponSpec(state);
  if (weapon && !weapon.compatibleAmmoTypes.includes(ammoTypeId)) {
    state.status = `${ammo.shortName.toLowerCase()} incompatible`;
    return false;
  }
  state.loadout.activeAmmo[ammo.caliber] = ammoTypeId;
  state.status = `${ammo.name} selected`;
  return true;
}

export function equipWeapon(state: PlayState, weaponId: WeaponId) {
  const spec = weaponSpecs[weaponId];
  if (spec.requiredCert && !hasCertificate(state, spec.requiredCert)) {
    state.status = `${spec.shortName.toLowerCase()} cert missing`;
    return;
  }
  state.loadout.equipped[spec.slot] = weaponId;
  state.loadout.activeWeaponId = weaponId;
  state.equipPulseMs = 260;
  state.status = `${spec.shortName.toLowerCase()} equipped`;
}

export function unequipWeapon(state: PlayState, weaponId: WeaponId) {
  const spec = weaponSpecs[weaponId];
  const wasActive = state.loadout.activeWeaponId === weaponId;
  if (state.loadout.equipped[spec.slot] === weaponId) {
    state.loadout.equipped[spec.slot] = null;
  }
  if (wasActive) {
    state.loadout.activeWeaponId = state.loadout.equipped.longGun;
    delete state.weaponFireAnimations[state.playerActorId];
  }
  state.equipPulseMs = 220;
  state.status = `${spec.shortName.toLowerCase()} unequipped`;
}

export function setEquippedWeaponAuthoritative(
  state: PlayState,
  slice: SliceSnapshot,
  weaponId: WeaponId | null,
  weaponItemId?: number,
  weaponVariantId?: number,
): boolean {
  if (!state.serverAuthority?.enabled) {
    if (!weaponId) {
      const activeWeaponId = state.loadout.activeWeaponId;
      if (!activeWeaponId) return false;
      unequipWeapon(state, activeWeaponId);
      return true;
    }
    equipWeapon(state, weaponId);
    return state.loadout.activeWeaponId === weaponId;
  }
  if (weaponId) {
    const spec = weaponSpecs[weaponId];
    if (spec.requiredCert && !hasCertificate(state, spec.requiredCert)) {
      state.status = `${spec.shortName.toLowerCase()} cert missing`;
      return false;
    }
  }
  state.authorityCommands ??= createAuthorityCommandQueue();
  enqueueAuthoritySetEquippedWeaponCommand(
    state.authorityCommands,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    weaponId,
    weaponItemId,
    weaponVariantId,
  );
  if (weaponId) {
    equipWeapon(state, weaponId);
  } else {
    state.loadout.equipped.longGun = null;
    state.loadout.activeWeaponId = null;
    delete state.weaponFireAnimations[state.playerActorId];
    state.equipPulseMs = 220;
    state.status = "weapon unequipped";
  }
  return true;
}

export function reloadActiveWeapon(state: PlayState): boolean {
  const weaponId = state.loadout.activeWeaponId;
  if (!weaponId) {
    state.status = "no weapon equipped";
    return false;
  }
  if (state.serverAuthority?.enabled) {
    state.status = "reloads on empty";
    return false;
  }
  return reloadWeapon(state, weaponSpecs[weaponId], "reloaded");
}

export function reloadActiveWeaponAuthoritative(state: PlayState, slice: SliceSnapshot): boolean {
  const weaponId = state.loadout.activeWeaponId;
  if (!weaponId) {
    state.status = "no weapon equipped";
    return false;
  }
  const spec = weaponSpecs[weaponId];
  if (!state.serverAuthority?.enabled) return reloadWeapon(state, spec, "reloaded");
  if (!canReloadActiveWeapon(state)) {
    const ammo = state.loadout.ammo[spec.caliber];
    state.status = ammo.loaded >= spec.magazineSize ? `${spec.shortName.toLowerCase()} full` : "no reserve ammo";
    return false;
  }
  state.authorityCommands ??= createAuthorityCommandQueue();
  enqueueAuthorityReloadWeaponCommand(
    state.authorityCommands,
    authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    activeAmmoTypeId(state, spec),
    spec.id,
  );
  setCooldown(state, spec.reloadMs);
  state.status = `${spec.shortName.toLowerCase()} reloading`;
  triggerWeaponReloadAnimation(state, state.playerActorId, spec.id, spec.reloadMs);
  return true;
}

export function activeWeaponSpec(state: PlayState): WeaponSpec | null {
  return state.loadout.activeWeaponId ? weaponSpecs[state.loadout.activeWeaponId] : null;
}

export function setCooldown(state: PlayState, durationMs: number) {
  state.cooldownMs = Math.max(state.cooldownMs, durationMs);
  state.cooldownTotalMs = Math.max(state.cooldownTotalMs, state.cooldownMs, durationMs);
}

export function reloadWeapon(state: PlayState, spec: WeaponSpec, statusSuffix: string): boolean {
  if (state.loadout.unlimitedAmmo) {
    const ammo = state.loadout.ammo[spec.caliber];
    ammo.loaded = spec.magazineSize;
    ammo.reserve = Math.max(ammo.reserve, spec.magazineSize);
    setCooldown(state, spec.reloadMs);
    state.status = `${spec.shortName.toLowerCase()} ${statusSuffix}`;
    triggerWeaponReloadAnimation(state, state.playerActorId, spec.id, spec.reloadMs);
    return true;
  }
  const ammo = state.loadout.ammo[spec.caliber];
  const needed = spec.magazineSize - ammo.loaded;
  if (needed <= 0) {
    state.status = `${spec.shortName.toLowerCase()} full`;
    return false;
  }
  if (ammo.reserve <= 0) {
    state.status = "no reserve ammo";
    return false;
  }
  const moved = Math.min(needed, ammo.reserve);
  ammo.loaded += moved;
  ammo.reserve -= moved;
  setCooldown(state, spec.reloadMs);
  state.status = `${spec.shortName.toLowerCase()} ${statusSuffix}`;
  triggerWeaponReloadAnimation(state, state.playerActorId, spec.id, spec.reloadMs);
  return true;
}

export function canReloadActiveWeapon(state: PlayState): boolean {
  const weaponId = state.loadout.activeWeaponId;
  if (!weaponId) return false;
  if (state.loadout.unlimitedAmmo) return false;
  const spec = weaponSpecs[weaponId];
  const ammo = state.loadout.ammo[spec.caliber];
  if (state.serverAuthority?.enabled) {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const reloading = (actorId ? state.serverAuthority.actors?.[actorId]?.weapon?.reloadRemainingTicks : 0) ?? 0;
    return reloading <= 0 && ammo.loaded < spec.magazineSize && ammo.reserve > 0;
  }
  return ammo.loaded < spec.magazineSize && ammo.reserve > 0;
}

export function activeWeaponLabel(state: PlayState): string {
  const weaponId = state.loadout.activeWeaponId;
  return weaponId ? weaponSpecs[weaponId].name : "Unarmed";
}

export function hasCertificate(state: PlayState, certificateId: CertificateId): boolean {
  return state.progression.certificates.includes(certificateId);
}
