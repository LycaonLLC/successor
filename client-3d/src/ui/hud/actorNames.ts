export {
  cleanActorName,
  cleanActorNameById,
  stripTypeRead,
} from "@successor/client/src/slice-core/actorNameSystem";

/**
 * Clean actor names for compact HUD surfaces (fe-polish C1).
 *
 * The wire carries three name channels per actor: `label` (legacy composite,
 * may embed the actor descriptor — "Mori Maddox (a rogue trooper)"),
 * `display_name` (the clean name) and `descriptor` (the type read alone).
 * World nameplates already render display_name + descriptor as separate
 * lines; the target plate, ACTION QUEUE rows, combat log and loot header
 * consumed raw `label`, so every long NPC name truncated inside its own
 * parenthetical. These helpers give the compact surfaces ONE clean-name
 * chain: display_name first, then label with any trailing type read
 * stripped. The descriptor stays available on examine surfaces — it is
 * dropped here, never destroyed.
 */
