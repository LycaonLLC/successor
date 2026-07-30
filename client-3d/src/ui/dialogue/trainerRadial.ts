import type { RadialAction } from "../windows/contextRadial";

/**
 * Trainer context-radial actions (pure — input.ts consumes, tests pin).
 *
 * CONVERSE is the DEFAULT action on profession-trainer NPCs (owner ask:
 * dialogue, not the skills-menu plop). Conversation opens at any distance —
 * command leaves inside the tree gate on the shared 1.75-cell radius.
 * Attack stays visible but disabled with an in-character reason (Main ruling:
 * gray out per deny law, never hide).
 */

export const TRAINER_ATTACK_DENY_NOTE = "Camp law. Not a target.";

export function trainerRadialActions(): RadialAction[] {
  return [
    { id: "converse", label: "Converse", enabled: true, note: null },
    { id: "examine", label: "Examine", enabled: true, note: null },
    { id: "attack", label: "Attack", enabled: false, note: TRAINER_ATTACK_DENY_NOTE },
  ];
}
