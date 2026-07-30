/**
 * Duel, two sessions — the consent pair (DuelSim tags 90-93): challenge
 * by name, accept, scoped exchange, yield for the honorable end. Consent
 * and outcome are receipt truth; damage legality is DuelSim's server law.
 *
 * Runtime-skips on clients whose generated verbs predate duels (the
 * shared-tree build lags main until the landing queue reaches us).
 */
export default async function duelDuo({ session, actorId, check, skip, grant, grantSkills }) {
  const a = session({ actorId: actorId("a"), displayName: "GateVarga", spawnX: 514, spawnY: 514 });
  const b = session({ actorId: actorId("b"), displayName: "GateSzabo", spawnX: 514, spawnY: 514 });
  await a.expect(/Signal locked/);
  await b.expect(/Signal locked/);
  await grant(a.actorId, "slugthrower", 1);
  await grantSkills(a.actorId, ["marksman-novice", "marksman-rifle-ii", "marksman-rifle-iii"]);
  a.send("/equip-weapon slugthrower 3101");
  await a.idle(1200);
  const equipped = await a.say("/receipts 2", /accepted/i, { timeoutMs: 8000 });
  check("duel: explicit slugthrower draw accepted before attack", /accepted/i.test(equipped.line));
  await a.idle(1200); // mutual AOI before contact resolution
  let challenged = false;
  for (let attempt = 0; attempt < 4 && !challenged; attempt += 1) {
    const result = await a.say("/duel gateszabo", /throw down the glove|No one in scope answers/);
    challenged = result.line.includes("throw down the glove");
    if (!challenged) await a.idle(1200);
  }
  check("challenge resolves the opponent from AOI", challenged);
  await b.say("/duel accept", /Blades up — the duel is on\./);
  await a.idle(600);
  // one scoped exchange: A targets B by name and fires
  await a.say("/target gateszabo", /^TARGET GATESZABO/i);
  a.send("/attack");
  await a.expect(/FIRED|fires|round|shot|hits|deflect|miss|takes/i, { timeoutMs: 20_000 });
  await b.say("/duel yield", /lower your weapon — the duel ends with honor\./);
  const receipts = await b.say("/receipts 4", /#\d+ t\d+ accepted/);
  check("duel receipts flow (accept + yield)", receipts.line.length > 0);
  // DEF-5 (GPT-5.5 review): the OUTCOME must reach the OTHER session —
  // Rust emits it, the shard dropped it. RED against pre-fix mains by
  // design; greens with DuelSim's duelOutcome forwarding + the TUI's
  // narration bind (perspective-relative: B yielded, A hears the win).
  const outcome = await a.expect(/«GateSzabo» lowers their weapon — the duel is yours\./, { timeoutMs: 8_000 })
    .catch(() => null);
  check("DEF-5: the yield outcome reaches the opponent's session, spoken", outcome !== null);
}
