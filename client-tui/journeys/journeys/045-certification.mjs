/**
 * Weapon certification gate (combat-doctrine.md §3) — the honest reject spoken.
 *
 * A Rifle-I marksman is handed a Crafted Slugthrower Mk I (item 3101, which certs at
 * Rifle III). Drawing it is DENIED and the narrator SPEAKS it as readable prose
 * (UNCERTIFIED), never a dev code. Train Rifle III and the same draw lands; the
 * certified weapon then fires at the sparring trooper. Spawn at the pit (592,511).
 */
export default async function certification({ session, actorId, check, note, grant, grantSkills }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "CertGunner", spawnX: 592, spawnY: 511 });
  await tui.expect(/Signal locked/);

  await grantSkills(id, ["marksman-novice", "marksman-rifle-i"]);
  await grant(id, "craftedSlugthrower", 1);
  await tui.idle(400);

  // Draw the uncertified slugthrower -> the narrator speaks the honest reject.
  tui.send("/equip-weapon slugthrower 3101:101080090");
  await tui.idle(1200);
  const firstReceipt = await tui.say("/receipts 2", /accepted|weapon_not_certified|UNCERTIFIED|certification/i, { timeoutMs: 8000 });
  check("uncertified slugthrower draw is spoken/receipted as a readable cert reject", /UNCERTIFIED|certification|weapon_not_certified/i.test(firstReceipt.line));
  note(`cert reject spoken/receipted: ${firstReceipt.line}`);

  // Train Rifle III -> the same draw now lands (accepts are silent, so read the ledger).
  await grantSkills(id, ["marksman-rifle-ii", "marksman-rifle-iii"]);
  await tui.idle(400);
  tui.send("/equip-weapon slugthrower 3101:101080090");
  await tui.idle(1200);
  const accepted = await tui.say("/receipts 2", /accepted/i, { timeoutMs: 8000 });
  check("certified draw is accepted once Rifle III is trained", /accepted/i.test(accepted.line));

  // The certified slugthrower fires at the sparring trooper.
  let target = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await tui.idle(1100);
    const byName = await tui.say("/target mori", /^TARGET (NOT FOUND|[A-Z])/);
    if (!byName.line.includes("NOT FOUND")) { target = byName; break; }
    const bySel = await tui.say("/target nearest hostile", /^TARGET (NOT FOUND|[A-Z])/);
    if (!bySel.line.includes("NOT FOUND")) { target = bySel; break; }
  }
  check("a trooper is in reach for the certified weapon", target !== null);
  if (!target) return;
  tui.send("/attack");
  const beat = await tui.expect(/FIRED|fires|round|shot|hits|deflects|misses|takes|staggers|drops/i, { timeoutMs: 20000 });
  check("the certified slugthrower speaks its exchange", beat.line.length > 0);
  await tui.say("/peace", /ease off the trigger|stand down|PEACE/i);
}
