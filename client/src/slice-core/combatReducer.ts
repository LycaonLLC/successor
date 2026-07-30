import type {
  ActorLifeState,
  ActorVitals,
  BodyZone,
  CombatStatusId,
} from "./combatTypes";
import { clamp, type Cell } from "./geometry";

export interface ActorBodyZoneState {
  zone: BodyZone;
  hp: number;
  maxHp: number;
  armor: number;
  woundTolerance?: number;
}

export interface BleedState {
  active: boolean;
  severity: number;
  stackCount: number;
  remainingMs: number;
  ratesPerSecond: ActorVitals;
}

export interface CombatStatus {
  id: CombatStatusId;
  label: string;
  severity: number;
  ttlMs: number;
  stacks?: number;
  threshold?: number;
}

export interface ActorCombatState {
  actorId: string;
  downedCell: Cell | null;
  lifeState: ActorLifeState;
  lifecycleSeq: number;
  vitals: ActorVitals;
  maxVitals: ActorVitals;
  bleed: BleedState;
  statuses: CombatStatus[];
  hitFlashMs: number;
  downed: boolean;
}

export function createInactiveBleedState(): BleedState {
  return {
    active: false,
    severity: 0,
    stackCount: 0,
    remainingMs: 0,
    ratesPerSecond: { health: 0, action: 0, spirit: 0 },
  };
}

export interface ReservoirStrain {
  body: number;
  action: number;
  spirit: number;
}

export function reservoirStrainForVitals(vitals: ActorVitals, maxVitals: ActorVitals): ReservoirStrain {
  return {
    body: 1 - clamp(vitals.health / Math.max(1, maxVitals.health), 0, 1),
    action: 1 - clamp(vitals.action / Math.max(1, maxVitals.action), 0, 1),
    spirit: 1 - clamp(vitals.spirit / Math.max(1, maxVitals.spirit), 0, 1),
  };
}

export function bodyOutputMultiplierForStrain(strain: ReservoirStrain | undefined): number {
  return 1 - Math.min(0.35, Math.max(0, (strain?.spirit ?? 0) * 0.35));
}
