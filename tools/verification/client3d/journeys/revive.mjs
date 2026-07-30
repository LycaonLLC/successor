// Journey: down → auto-revive → the slugthrower returns to the pawn.
//
// Incap once dropped the held slugthrower visual to the ground; revive never
// recovered it, so the orphaned ground mesh kept the muzzle socket and every
// post-revive bolt fired from the dirt. This journey certifies that after a
// revive the muzzle socket rides the pawn again at carried height and follows
// movement.
//
// Down vehicle (sanctioned): the sparring partner is debug-commanded to volley
// the probe at close range until the sim downs it (PvE rogues self-suppress;
// there is no debug-down). The incap timer then auto-revives in place — the
// exact recovery sequence under test.
//
// Money shots: downed (gun dropping), revived (no orphaned ground gun),
// post-revive fire (bolts from the pawn, not the dirt).
import { postJson } from "../lib/util.mjs";
import { waitHostile, acquireTarget, approachHostile } from "./_helpers.mjs";

const SLUGTHROWER_ITEM_ID = 3_101;
const IRON_SLUG_ITEM_ID = 1_101;
const STARTER_SLUG_QUANTITY = 240;

/** Muzzle-to-pawn horizontal distance (cells); Infinity when either is absent. */
function muzzleDistance(probe) {
  const m = probe?.muzzleWorld;
  const c = probe?.playerCell;
  if (!m || !c) return Infinity;
  return Math.hypot(m.x - c.x, m.z - c.y);
}

export default {
  id: "revive",
  title: "Down/auto-revive (slugthrower recovers to the pawn; no ground gun)",
  timeoutMs: 200000,
  // Low seeded health keeps the volley budget short; the partner post sits at
  // (592,512) — spawn beside it so injected volleys land at close range.
  characters: [{
    role: "primary",
    id: "h3d-revive-probe",
    name: "ProbeRevive",
    x: 588,
    y: 512,
    vitals: { health: 60, action: 160, spirit: 100 },
    initialProfessionId: "marksman",
    verificationLoadout: {
      mode: "client3d-pre-entry.v1",
      items: [
        { itemId: SLUGTHROWER_ITEM_ID, variantId: 0, quantity: 1, equipped: true },
        { itemId: IRON_SLUG_ITEM_ID, variantId: 0, quantity: STARTER_SLUG_QUANTITY, equipped: false },
      ],
    },
  }],
  async run(ctx) {
    const s = ctx.primary;
    await waitHostile(ctx, s);
    const acquired = await acquireTarget(ctx, s);
    const partnerId = acquired.selectedActorId;
    ctx.note(`sparring partner ${partnerId}`);
    await approachHostile(ctx, s, 3);
    // Baseline: armed + standing -> muzzle rides the pawn.
    const before = await s.probe();
    ctx.note(`pre-down muzzle distance ${muzzleDistance(before).toFixed(2)}c (y=${before?.muzzleWorld?.y ?? "null"})`);
    await ctx.moneyShot("00-pre-down");

    // Hold fire ourselves; the PARTNER volleys us down (debug-commanded — the
    // only sanctioned way to down a player probe on demand).
    await s.slash("/peace");
    let downed = false;
    const downDeadline = Date.now() + 120000;
    while (Date.now() < downDeadline) {
      await postJson(`${s.gameUrl}/game/debug/authority-command`, {
        actorId: partnerId,
        command: { QueueCombatAction: { action_id: "basic_shot", target_actor_id: s.actorId } },
      }).catch(() => null);
      await ctx.delay(900);
      const o = await s.oracle();
      const me = o?.actors?.[s.actorId];
      if (me && me.lifeState === "downed") { downed = true; break; }
    }
    s.assert(downed, "partner volleys never downed the probe (down vehicle broken?)");
    await ctx.moneyShot("01-downed");
    // Down contract: no muzzle while down (the dropped rig must not feed it).
    const downProbe = await s.probe();
    s.assert(downProbe.muzzleWorld === null, `muzzleWorld should be null while down, got ${JSON.stringify(downProbe.muzzleWorld)}`);

    // Auto-revive on the incap timer.
    const revived = await s.waitProbeCall(
      () => s.oracle(),
      (o) => o?.actors?.[s.actorId]?.lifeState === "alive",
      { label: "incap timer auto-revive", timeoutMs: 60000 },
    );
    s.assert(revived?.actors?.[s.actorId]?.lifeState === "alive", "probe never auto-revived from downed");

    // Core regression assert: the muzzle socket rides the pawn again — carried
    // height, within reach of the pawn — never the dirt at the drop spot.
    const recovered = await s.waitProbe(
      (p) => p.muzzleWorld !== null && p.muzzleWorld.y > 0.4 && muzzleDistance(p) < 1.5,
      { label: "muzzle recovered to the pawn", timeoutMs: 12000 },
    );
    ctx.note(`post-revive muzzle distance ${muzzleDistance(recovered).toFixed(2)}c (y=${recovered.muzzleWorld.y.toFixed(2)})`);
    await ctx.moneyShot("02-revived-recovered");

    // Move: the muzzle must TRACK the pawn (the bug pinned it at the drop spot).
    await s.hold(["KeyA"], 1800);
    const afterWalk = await s.probe();
    const walkDist = muzzleDistance(afterWalk);
    ctx.note(`post-walk muzzle distance ${walkDist.toFixed(2)}c`);
    s.assert(walkDist < 1.5, `muzzle did not follow the pawn after moving (distance ${walkDist.toFixed(2)}c — ground gun?)`);
    s.assert(afterWalk.muzzleWorld.y > 0.4, `muzzle sits at ground height after revive (y=${afterWalk.muzzleWorld.y.toFixed(2)})`);

    // Post-revive fire: bolts originate at the pawn's carried muzzle.
    await acquireTarget(ctx, s).catch(() => null);
    const arrivals0 = (await s.fx())?.lastArrival?.count ?? 0;
    await s.slash("/attack basic_shot $target");
    await ctx.delay(2500);
    const firing = await s.probe();
    const fireDist = muzzleDistance(firing);
    const arrivals1 = (await s.fx())?.lastArrival?.count ?? 0;
    ctx.note(`firing muzzle distance ${fireDist.toFixed(2)}c; arrivals ${arrivals0} -> ${arrivals1}`);
    await ctx.moneyShot("03-post-revive-fire");
    s.assert(fireDist < 1.6, `post-revive fire reads a far muzzle (${fireDist.toFixed(2)}c — bolts from the dirt)`);
    await s.slash("/peace");
  },
};
