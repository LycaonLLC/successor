/**
 * Inventory-backed /equip-weapon smoke — the TUI verb must accept the same
 * item-backed ranged and melee equips the 3D inventory journey drives.
 */
export default async function weaponEquip({ session, actorId, check, grant, grantSkills, note }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "EquipVerb", spawnX: 592, spawnY: 511 });
  await tui.expect(/Signal locked/);

  await grantSkills(id, [
    "marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii",
    "brawler-novice",
  ]);
  await grant(id, "slugthrower", 1);
  await grant(id, "vibrosword", 1);
  await tui.idle(400);

  tui.send("/equip-weapon slugthrower 3101");
  await tui.idle(1000);
  const ranged = await tui.say("/receipts 3", /accepted/i, { timeoutMs: 8000 });
  check("tui: item-backed slugthrower equip is accepted", /accepted/i.test(ranged.line));
  note(`slugthrower equip receipt: ${ranged.line}`);

  tui.send("/equip-weapon vibrosword 3103");
  await tui.idle(1000);
  const melee = await tui.say("/receipts 3", /accepted/i, { timeoutMs: 8000 });
  check("tui: item-backed vibrosword equip is accepted", /accepted/i.test(melee.line));
  note(`vibrosword equip receipt: ${melee.line}`);
}
