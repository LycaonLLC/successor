/**
 * /attack auto-approach — out-of-range attacks walk in and engage from the
 * weapon's authoritative band, with no manual movement required.
 */
const WHERE_RE = /^WHERE \S+ (\d+(?:\.\d+)?),(\d+(?:\.\d+)?) facing/;
const EXCHANGE_RE = /your shot|you put a round|clean hit|you rush it|goes wide/i;

async function whereNow(tui, anchor) {
  const where = await tui.say("/where", WHERE_RE);
  const x = Number(where.match[1]);
  const y = Number(where.match[2]);
  return { x, y, d: Math.hypot(x - anchor.x, y - anchor.y) };
}
async function formDuel(challenger, mark, markName) {
  let challenged = false;
  for (let attempt = 0; attempt < 5 && !challenged; attempt += 1) {
    const result = await challenger.say(`/duel ${markName}`, /throw down the glove|No one in scope answers/);
    challenged = result.line.includes("throw down the glove");
    if (!challenged) await challenger.idle(1200);
  }
  if (challenged) await mark.say("/duel accept", /Blades up — the duel is on\./);
  return challenged;
}
export default async function attackApproach({ session, actorId, check, note, grant, grantSkills }) {
  const MARK_A = { x: 546, y: 546 };
  const mark = session({ actorId: actorId("mark"), displayName: "GateMark", spawnX: MARK_A.x, spawnY: MARK_A.y });
  const gunner = session({ actorId: actorId("gunner"), displayName: "GateGunner", spawnX: MARK_A.x + 17, spawnY: MARK_A.y + 17 });
  await mark.expect(/Signal locked/);
  await gunner.expect(/Signal locked/);
  await grant(gunner.actorId, "slugthrower", 1);
  await grantSkills(gunner.actorId, ["marksman-novice", "marksman-rifle-ii", "marksman-rifle-iii"]);
  gunner.send("/equip-weapon slugthrower 3101");
  await gunner.idle(1200);
  const gunEquipped = await gunner.say("/receipts 2", /accepted/i, { timeoutMs: 8000 });
  check("ranged: explicit slugthrower draw accepted before attack", /accepted/i.test(gunEquipped.line));
  check("ranged: duel forms (PvP is duel-only law)", await formDuel(gunner, mark, "gatemark"));
  const rangedFrom = await whereNow(gunner, MARK_A);
  check(`ranged: mark stands out of range (${rangedFrom.d.toFixed(1)}c, need > 20c)`, rangedFrom.d > 20 && rangedFrom.d < 32);
  await gunner.say("/target gatemark", /^TARGET GATEMARK/i);
  gunner.send("/attack");
  const rangedStart = await gunner.expect(/move on|push toward|Boots forward/, { timeoutMs: 6000 });
  note(`pursue start spoken: ${rangedStart.line}`);
  const levelOff = await gunner.expect(/level off|plant your feet|where the gun likes it/, { timeoutMs: 30000 });
  note(`level-off spoken: ${levelOff.line}`);
  await gunner.expect(/ATTACK QUEUED/, { timeoutMs: 4000 });
  const rangedBeat = await gunner.expect(EXCHANGE_RE, { timeoutMs: 30000 });
  check("ranged: the gunner's own exchange speaks after the walk-up", rangedBeat.line.length > 0);
  const rangedAt = await whereNow(gunner, MARK_A);
  check(`ranged: distance closed ${rangedFrom.d.toFixed(1)}c → ${rangedAt.d.toFixed(1)}c (band 12c, engage ≤ 16c)`, rangedAt.d <= 16 && rangedAt.d < rangedFrom.d - 6);
  const markHit = await mark.expect(/shot catches you|You take a round|kicks sand at your feet|snaps past your ear|roll off the line|cuts empty air/i, { timeoutMs: 15000 });
  check("ranged: the mark's session hears the incoming fire (real 2-actor exchange)", markHit.line.length > 0);
  await gunner.say("/peace", /ease off the trigger|stand down|PEACE/i);
  await gunner.quit();
  await mark.quit();

  // The v8 sparring shelter is east of the approach lane. Move west before
  // attacking so the authoritative walk can route around solid camp props.
  const blade = session({ actorId: actorId("blade"), displayName: "GateBlade", spawnX: 592, spawnY: 526 });
  await blade.expect(/Signal locked/);
  await grantSkills(blade.actorId, ["brawler-novice"]);
  await grant(blade.actorId, "scraplineMachete", 1);
  await blade.idle(1200);
  const machete = await blade.say("/inv scrapline", /INV \d+ STACK/i);
  check("melee: the primitive Scrapline exists in the carried pack", /INV \d+ STACK/i.test(machete.line));
  blade.send("/equip-weapon scrapline-machete 3105");
  await blade.idle(1200);
  const equipped = await blade.say("/receipts 2", /accepted/i, { timeoutMs: 8000 });
  check("melee: primitive Scrapline draw accepted for a novice Brawler", /accepted/i.test(equipped.line));
  // The v8 sparring actor IDs are stable; target the east member to keep the
  // walk on the shelter's clear west approach lane.
  await blade.say("/target open-desert-sparring-02", /^TARGET /i);
  blade.send("/walk w 5");
  await blade.expect(/You set off west/);
  await blade.idle(5500);
  const meleeFrom = await whereNow(blade, { x: 592, y: 512 });
  blade.send("/attack");
  const meleeStart = await blade.expect(/go for|closing to arm's reach|start the walk with steel/, { timeoutMs: 6000 });
  note(`melee pursue start spoken (only speaks beyond the 3c max band): ${meleeStart.line}`);
  const meleeGap = /(\d+)c/.exec(meleeStart.line);
  check(`melee: spoken start gap ${meleeGap?.[1] ?? "?"}c is beyond reach`, meleeGap !== null && Number(meleeGap[1]) > 3);
  const meleeClose = await blade.expect(/close to reach|inside .* guard|shut the last stride/, { timeoutMs: 30000 });
  note(`melee close spoken: ${meleeClose.line}`);
  await blade.expect(/ATTACK QUEUED/, { timeoutMs: 4000 });
  const meleeBeat = await blade.expect(EXCHANGE_RE, { timeoutMs: 20000 });
  check("melee: the blade's own exchange speaks from reach", meleeBeat.line.length > 0);
  const meleeAt = await whereNow(blade, { x: 592, y: 512 });
  const walked = Math.hypot(meleeAt.x - meleeFrom.x, meleeAt.y - meleeFrom.y);
  check(`melee: the character actually walked the gap (${walked.toFixed(1)}c moved)`, walked >= 2);
  await blade.say("/peace", /ease off the trigger|stand down|PEACE/i);
}
