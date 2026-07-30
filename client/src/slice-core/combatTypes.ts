export type CertificateId = "cert_rifle" | "cert_combat_medic" | "cert_brawler" | "cert_basic_vehicle";
export type BodyZone = "head" | "torso" | "left_arm" | "right_arm" | "legs";
export type ActorLifeState = "alive" | "downed" | "respawning";
export type DeathPhase = "alive" | "downed" | "clone_pending";
export type DownedMode = "bleedout" | "recovery";

export interface ActorVitals {
  health: number;
  action: number;
  spirit: number;
}

export type VitalsKey = keyof ActorVitals;

export type CombatStatusId =
  | "bleeding"
  | "suppressed"
  | "sleeping"
  | "staggered"
  | "arm_hit"
  | "limping"
  | "downed"
  | "dead"
  | "evacuating"
  | "stabilized"
  | "medic-prep"
  | "entertainer-session"
  | "stimpak_a_heal"
  | "reloading"
  | "clone_sickness";
