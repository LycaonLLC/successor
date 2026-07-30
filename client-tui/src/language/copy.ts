/**
 * Shared terse vocabulary — reason stamps and ability labels, matching the
 * 3D combat queue's copy (ui/hud/combatQueue.ts) so both clients speak one
 * language for the same authority answers.
 */

export const REASON_COPY: Record<string, string> = {
  out_of_range: "RANGE",
  los_blocked: "NO LOS",
  no_weapon_equipped: "NO WEAPON",
  weapon_not_certified: "UNCERTIFIED",
  insufficient_action: "LOW ACTION",
  ammo_unavailable: "NO AMMO",
  melee_while_kneeling: "KNEELING",
  posture_locked: "POSTURE",
  actor_not_alive: "DEAD",
  actor_asleep: "STUNNED",
  target_unavailable: "NO TARGET",
  queue_full: "QUEUE FULL",
  queue_entry_unknown: "NOT QUEUED",
  wrong_combat_model: "WRONG MODE",
  ingress_budget_exhausted: "TOO FAST",
  blocked_cell: "BLOCKED",
  out_of_bounds: "BOUNDS",
  move_cooldown: "MOVE COOLDOWN",
  loot_out_of_range: "RANGE",
  loot_no_rights: "NO RIGHTS",
  loot_not_lootable: "NOT LOOTABLE",
  loot_missing_stack: "GONE",
  container_full: "BAGS FULL",
  survey_cooldown: "SCANNER COOLING",
  sample_cooldown: "SAMPLER COOLING",
  duplicate_command: "DUPLICATE",
  unknown_actor: "UNKNOWN ACTOR",
  extractor_already_placed: "RIG ALREADY DOWN",
  no_placed_extractor: "NO RIG",
  not_extractor_owner: "NOT YOUR RIG",
  not_at_extractor: "TOO FAR FROM RIG",
  extractor_hopper_empty: "HOPPER EMPTY",
  extractor_hopper_full: "HOPPER FULL",
  extractor_busy: "RIG BUSY",
  extractor_battery_present: "BATTERY PRESENT",
  missing_battery: "NO BATTERY",
  invalid_resource_family: "BAD FAMILY",
  unknown_item: "UNKNOWN ITEM",
  item_unavailable: "ITEM UNAVAILABLE",
  missing_survey_tool: "MISSING SURVEY TOOL",
  trade_partner_unavailable: "PARTNER GONE",
  trade_proposal_unknown: "NO SUCH OFFER",
  trade_items_unavailable: "GOODS GONE",
  not_at_travel_terminal: "NOT AT TERMINAL",
  unknown_travel_destination: "UNKNOWN DESTINATION",
  travel_ticket_unknown: "NO SUCH TICKET",
  insufficient_credits: "SHORT ON CREDITS",
  cannot_group_self: "THAT'S YOU",
  already_in_group: "ALREADY GROUPED",
  group_full: "GROUP FULL",
  not_in_group: "NO GROUP",
  not_group_leader: "NOT LEADER",
  not_group_member: "NOT IN YOUR GROUP",
  no_pending_invite: "NO INVITE",
};

export function reasonCopy(code: string): string {
  return REASON_COPY[code] ?? code.replace(/[-_]/g, " ").toUpperCase();
}

/** Rejection stamps that deserve a clause of prose after the stamp. */
export const REASON_CLAUSE: Record<string, string> = {
  out_of_range: "close the distance",
  los_blocked: "something stands between you",
  insufficient_action: "you need a breath first",
  ammo_unavailable: "the magazine has nothing to give",
  queue_full: "your hands are already full",
  ingress_budget_exhausted: "ease off, the wire only carries so much",
  actor_asleep: "the world swims — you are stunned",
  posture_locked: "not from this stance",
  melee_while_kneeling: "not from a knee",
  weapon_not_certified: "you lack the certification to wield that",
  loot_no_rights: "that kill belongs to someone else",
  container_full: "your bags are full",
};

export const ABILITY_LABEL: Record<string, string> = {
  basic_shot: "SHOT",
  aimed_shot: "AIMED SHOT",
  melee_strike: "STRIKE",
  peace: "PEACE",
  kneel: "KNEEL",
  stand: "STAND",
  stim: "STIM",
};

export function abilityLabel(abilityId: string): string {
  return ABILITY_LABEL[abilityId] ?? abilityId.replace(/[-_]/g, " ").toUpperCase();
}

/** Body zones → prose fragments ("takes him ${zonePhrase}"). */
export const ZONE_PHRASE: Record<string, string> = {
  head: "high in the head",
  torso: "square in the chest",
  left_arm: "in the left arm",
  right_arm: "in the right arm",
  legs: "low in the legs",
};

/** Resource family display names (canonical registry keys). */
export const FAMILY_LABEL: Record<string, string> = {
  metal: "iron",
  copper: "copper",
  chemical: "petrochemical",
  carbon: "carbon",
  flora: "flora",
  gas: "gas",
  liquid: "liquid",
};

export function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family.replace(/[-_]/g, " ");
}
