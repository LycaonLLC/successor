/**
 * Debug authority-command helpers — the fixture-enabled grant route
 * (GAME_DEBUG_AUTHORITY_COMMANDS=1 on scratch shards only).
 */

export async function grantItem(port, actorId, itemId, variantId, quantity) {
  const response = await fetch(`http://127.0.0.1:${port}/game/debug/authority-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId, command: { DebugGiveItem: { item_id: itemId, variant_id: variantId, quantity } } }),
  });
  if (!response.ok) throw new Error(`grant ${itemId}×${quantity} to ${actorId} failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result?.receipt?.accepted !== true) {
    throw new Error(`grant ${itemId}×${quantity} to ${actorId} rejected: ${result?.receipt?.reasonCode ?? "unknown_reason"}`);
  }
  return result;
}

/** The gate's standing item shorthand (fixture catalog ids). */
export const ITEMS = {
  stimpak: { itemId: 1001, variantId: 0 },
  iron: { itemId: 2001, variantId: 219954 },
  copper: { itemId: 2007, variantId: 225357 },
  chemical: { itemId: 2002, variantId: 230202 },
  water: { itemId: 2005, variantId: 240303 },
  clodpowder: { itemId: 2006, variantId: 250404 },
  multitool: { itemId: 3001, variantId: 0 },
  bec: { itemId: 1201, variantId: 820 },
  liquidSuspension: { itemId: 1202, variantId: 820 },
  crdm: { itemId: 1203, variantId: 820 },
  shell: { itemId: 1204, variantId: 820 },
  surveyTool: { itemId: 3008, variantId: 0 },
  slugthrower: { itemId: 3101, variantId: 0 },
  craftedSlugthrower: { itemId: 3101, variantId: 101_080_090 },
  vibrosword: { itemId: 3103, variantId: 0 },
  scraplineMachete: { itemId: 3105, variantId: 0 },
  extractorTool: { itemId: 3006, variantId: 0 },
  battery1h: { itemId: 3201, variantId: 32_000_000 + 3_600 },
  campKit: { itemId: 3007, variantId: 0 },
  geneSampler: { itemId: 6201, variantId: 0 },
  spliceBench: { itemId: 6202, variantId: 0 },
  creditChip: { itemId: 9002, variantId: 0 },
  fuel: { itemId: 2009, variantId: 47214220 },
};

export async function grant(port, actorId, name, quantity) {
  const item = ITEMS[name];
  if (!item) throw new Error(`unknown gate item «${name}»`);
  return grantItem(port, actorId, item.itemId, item.variantId, quantity);
}

/** Debug skill-box grant (fixture route) — elite gates like bioengineer-novice. */
export async function grantSkillBoxes(port, actorId, skillBoxIds) {
  const response = await fetch(`http://127.0.0.1:${port}/game/debug/authority-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId, command: { DebugGrantSkillBoxes: { skill_box_ids: skillBoxIds } } }),
  });
  if (!response.ok) throw new Error(`skill grant ${skillBoxIds.join(",")} to ${actorId} failed: HTTP ${response.status}`);
  const result = await response.json();
  if (result?.receipt?.accepted !== true) {
    throw new Error(`skill grant ${skillBoxIds.join(",")} to ${actorId} rejected: ${result?.receipt?.reasonCode ?? "unknown_reason"}`);
  }
  return result;
}
