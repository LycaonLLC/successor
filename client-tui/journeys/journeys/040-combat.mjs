/**
 * Combat exchange — the sparring pit: the slice authors a dedicated
 * rogue-trooper spawn at (592,512) (activation 16c, 15s cadence) exactly
 * for live combat proofs.
 *
 * DEF-4 (reported): /target nearest hostile can't see idle/alerted
 * faction-hostiles (farmable-passive outranks faction hostility in the
 * shared relation classifier). The journey PREFERS the hostile selector
 * — self-healing to it the moment DEF-4 lands — and falls back to
 * by-name targeting, which bypasses the relation filter.
 */
export default async function combat({ session, actorId, check, note, grant, grantSkills }) {
  const tui = session({ actorId: actorId("a"), displayName: "GateGunner", spawnX: 592, spawnY: 511 });
  await tui.expect(/Signal locked/);
  const id = actorId("a");
  await grant(id, "slugthrower", 1);
  await grantSkills(id, ["marksman-novice", "marksman-rifle-ii", "marksman-rifle-iii"]);
  tui.send("/equip-weapon slugthrower 3101");
  await tui.idle(1200);
  const equipped = await tui.say("/receipts 2", /accepted/i, { timeoutMs: 8000 });
  check("combat: explicit slugthrower draw accepted before attack", /accepted/i.test(equipped.line));
  let target = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await tui.idle(1200);
    const bySelector = await tui.say("/target nearest hostile", /^TARGET (NOT FOUND|[A-Z])/);
    if (!bySelector.line.includes("NOT FOUND")) {
      target = bySelector;
      note("hostile selector found the trooper — DEF-4 is fixed; drop the by-name fallback");
      break;
    }
    const byName = await tui.say("/target mori", /^TARGET (NOT FOUND|[A-Z])/);
    if (!byName.line.includes("NOT FOUND")) {
      target = byName;
      note("targeted by name (DEF-4 workaround: alerted faction-hostiles invisible to the hostile selector)");
      break;
    }
  }
  check("the sparring pit offers a trooper to target", target !== null);
  if (!target) return;
  tui.send("/attack");
  const beat = await tui.expect(/FIRED|fires|round|shot|hits|deflects|misses|takes|staggers|drops/i, { timeoutMs: 20_000 });
  check("combat narration speaks the exchange", beat.line.length > 0);
  await tui.say("/peace", /ease off the trigger|stand down|PEACE/i);
}
