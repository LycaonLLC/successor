import { baseActorEffectiveStats } from "./actorArchetypes";
import { bodyOutputMultiplierForStrain, reservoirStrainForVitals, type ActorCombatState } from "./combatReducer";
import type { ServerAuthorityActorState } from "./gameState";
import { playerSpeedCellsPerSecond, sprintActionDrainPerSecond, sprintSpeedMultiplier } from "./gameTuning";

const trackSkillBonusPerBox = 50;

export function authorityMovementSpeedCellsPerSecond(
  authorityActor: ServerAuthorityActorState | null | undefined,
  _combatActor: ActorCombatState | null | undefined,
): number {
  const baseMultiplier = authorityActor?.role
    ? baseActorEffectiveStats({ role: authorityActor.role }).movementSpeedMultiplier
    : 1;
  const scoutTraversalMultiplier = 1 + professionTrackSkillBonus(authorityActor, "scout", "traversal") * 4 / 5 / 1_000;
  const brawlerMovementMultiplier = 1 + professionTrackSkillBonus(authorityActor, "brawler", "movement-speed") * 4 / 5 / 1_000;
  const vitals = authorityActor?.vitals ?? null;
  const maxVitals = authorityActor?.maxVitals ?? null;
  const outputMultiplier = vitals && maxVitals
    ? bodyOutputMultiplierForStrain(reservoirStrainForVitals(vitals, maxVitals))
    : 1;
  return playerSpeedCellsPerSecond
    * baseMultiplier
    * scoutTraversalMultiplier
    * brawlerMovementMultiplier
    * outputMultiplier;
}

export function authoritySprintSpeedMultiplier(authorityActor: ServerAuthorityActorState | null | undefined): number {
  return sprintSpeedMultiplier * (1 + professionTrackSkillBonus(authorityActor, "scout", "sprinting") * 6 / 5 / 1_000);
}

export function authorityMovementDistanceCells(
  authorityActor: ServerAuthorityActorState | null | undefined,
  combatActor: ActorCombatState | null | undefined,
  durationTicks: number,
  tickRateHz: number,
  sprinting: boolean,
): number {
  return authorityMovementSpeedCellsPerSecond(authorityActor, combatActor)
    * (sprinting ? authoritySprintSpeedMultiplier(authorityActor) : 1)
    * (Math.max(1, durationTicks) / Math.max(1, tickRateHz));
}

export function authoritySprintActionCost(
  authorityActor: ServerAuthorityActorState | null | undefined,
  durationTicks: number,
  tickRateHz: number,
): number {
  const baseMilli = Math.ceil(
    (sprintActionDrainPerSecond * Math.max(1, durationTicks) * 1_000) / Math.max(1, tickRateHz),
  );
  const rawEfficiencyMilli = 1_000 - professionTrackSkillBonus(authorityActor, "scout", "sprinting") * 2;
  const efficiencyMilli = Number.isFinite(rawEfficiencyMilli)
    ? Math.max(700, Math.min(1_000, Math.trunc(rawEfficiencyMilli)))
    : 700;
  return Math.floor(Math.floor((baseMilli * efficiencyMilli) / 1_000) / 1_000);
}

export function authorityActorCanSprint(
  authorityActor: ServerAuthorityActorState | null | undefined,
  combatActor: ActorCombatState | null | undefined,
  durationTicks: number,
  tickRateHz: number,
): boolean {
  const action = authorityActor?.vitals.action ?? combatActor?.vitals.action ?? 0;
  return action > 0 && action >= authoritySprintActionCost(authorityActor, durationTicks, tickRateHz);
}

function professionTrackSkillBonus(
  actor: ServerAuthorityActorState | null | undefined,
  professionId: "brawler" | "scout",
  track: string,
): number {
  const profession = actor?.professions?.find((entry) => entry.id === professionId) ?? null;
  if (!profession) return 0;
  const skillBoxes = new Set(profession.skillBoxes ?? []);
  skillBoxes.add(`${professionId}-novice`);
  if (!skillBoxes.has(`${professionId}-novice`)) return 0;
  let bonus = trackSkillBonusPerBox;
  for (const tier of ["i", "ii", "iii", "iv"] as const) {
    if (skillBoxes.has(`${professionId}-${track}-${tier}`)) bonus += trackSkillBonusPerBox;
  }
  if (skillBoxes.has(`${professionId}-master`)) bonus += trackSkillBonusPerBox;
  return bonus;
}

