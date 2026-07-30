// Journey: universal unarmed fallback. An ordinary Scout starter receives no
// Brawler grants and has no authority weapon or rendered weapon attachment,
// yet the shared basic attack still produces a visible hand-to-hand swing and
// a deliberately weak authority hit.
//
// Sparring hostiles spawn on the west patrol of open-desert-sparring-zone
// (encounter spawn/patrol 586,*). Player starts at collision-clear (584,508)
// south-west of the solid sparring footlocker (590,512) and grill (589,514),
// then walks a west/north lane onto the patrol before exact-id approach so the
// footlocker cannot pin the close at ~2.8 cells.
import { waitHostile, acquireTarget, approachHostile } from "./_helpers.mjs";

const PLAYER_ID = "h3d-unarmed-probe";

async function weaponAttachmentNames(s) {
  return s.evalExpr(`(() => {
    const pawn = window.__successor3dScene?.getObjectByName(${JSON.stringify(`pawn:${PLAYER_ID}`)});
    if (!pawn) return null;
    const names = [];
    pawn.traverse((object) => {
      const name = String(object.name ?? "");
      if (name === "weapon" || name === "vibrosword" || name.startsWith("melee:")) names.push(name);
    });
    return names;
  })()`);
}

function skillBoxes(actor) {
  return (actor?.professions ?? []).flatMap((profession) => profession.skillBoxes ?? []);
}

function playerHitAfter(probe, baselineEventId) {
  return (probe?.combatEventLog ?? []).find((event) => (
    Number(event.id) > baselineEventId
      && String(event.shooter) === String(probe.playerActorId)
      && event.hit === true
      && Number(event.damage) > 0
  )) ?? null;
}

export default {
  id: "unarmed",
  title: "Universal unarmed strike (no weapon model → authority hit)",
  timeoutMs: 180000,
  // Collision-clear SW of the sparring footlocker (590,512) / grill (589,514).
  // West/north pre-route below joins the 586 patrol lane without crossing the
  // solid chest. Scout is intentionally a non-Brawler starter and receives no
  // fixture/debug combat grants.
  characters: [{
    role: "primary",
    id: PLAYER_ID,
    name: "ProbeHands",
    x: 584,
    y: 508,
    initialProfessionId: "scout",
  }],
  async run(ctx) {
    const s = ctx.primary;

    const starter = await s.waitProbeCall(
      () => s.oracle(),
      (oracle) => {
        const actor = oracle?.actors?.[PLAYER_ID];
        return actor?.skillPointsUsed === 16
          && actor?.skillPointsCap === 250
          && actor?.weapon === null
          && JSON.stringify(skillBoxes(actor)) === JSON.stringify(["scout-novice"]);
      },
      { timeoutMs: 10000, label: "unequipped Scout starter authority state" },
    );
    const starterActor = starter.actors[PLAYER_ID];
    s.assert(starterActor.weapon === null, `Scout unexpectedly has an authority weapon: ${JSON.stringify(starterActor.weapon)}`);
    s.assert(starterActor.skillPointsUsed === 16, `Scout starter SP ${starterActor.skillPointsUsed} != 16`);
    s.assert(
      JSON.stringify(skillBoxes(starterActor)) === JSON.stringify(["scout-novice"]),
      `non-Brawler starter boxes drifted: ${JSON.stringify(skillBoxes(starterActor))}`,
    );

    const bareReady = await s.waitProbeCall(
      () => weaponAttachmentNames(s),
      (names) => Array.isArray(names) && names.length === 0,
      { timeoutMs: 10000, label: "local Scout pawn rendered without a weapon attachment" },
    );
    s.assert(bareReady.length === 0, `unequipped Scout rendered weapon roots: ${JSON.stringify(bareReady)}`);
    ctx.note("Scout starter: 16 SP in scout-novice, authority weapon=null, rendered weapon roots=[]");
    await waitHostile(ctx, s);
    await ctx.moneyShot("00-bare-hands-ready");

    // Pre-route west/north around the sparring footlocker before pinning the
    // exact hostile id. Authority-verified waypoints stay clear of 590,512.
    async function walkAuthorityWaypoint(x, y, { timeoutMs = 10000, label = "waypoint" } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const oracle = await s.oracle().catch(() => null);
        const me = oracle?.actors?.[PLAYER_ID];
        if (!me) {
          await ctx.delay(150);
          continue;
        }
        const dx = x - Number(me.x);
        const dy = y - Number(me.y);
        const dist = Math.hypot(dx, dy);
        if (dist <= 0.55) return me;
        const keys = [];
        // Prefer pure cardinal bursts so we hug the west/north lane instead of
        // diagonal-cutting into the footlocker body.
        if (Math.abs(dx) >= Math.abs(dy)) {
          if (dx > 0.2) keys.push("KeyD");
          else if (dx < -0.2) keys.push("KeyA");
          else if (dy > 0.2) keys.push("KeyS");
          else if (dy < -0.2) keys.push("KeyW");
        } else {
          if (dy > 0.2) keys.push("KeyS");
          else if (dy < -0.2) keys.push("KeyW");
          else if (dx > 0.2) keys.push("KeyD");
          else if (dx < -0.2) keys.push("KeyA");
        }
        if (keys.length === 0) keys.push("KeyW");
        await s.hold(keys, 220);
      }
      const finalOracle = await s.oracle().catch(() => null);
      const finalMe = finalOracle?.actors?.[PLAYER_ID];
      s.assert(
        finalMe && Math.hypot(x - Number(finalMe.x), y - Number(finalMe.y)) <= 0.9,
        `${label} not reached (want ${x},${y}; at ${finalMe ? `${finalMe.x},${finalMe.y}` : "missing"})`,
      );
      return finalMe;
    }
    // 584,508 -> 584,512 (north along clear west lane) -> 586,512 (onto patrol).
    await walkAuthorityWaypoint(584, 512, { label: "west-lane north of spawn", timeoutMs: 12000 });
    await walkAuthorityWaypoint(586, 512, { label: "sparring patrol lane", timeoutMs: 10000 });
    ctx.note("pre-routed west/north around sparring footlocker onto 586,512 patrol lane");

    const acquired = await acquireTarget(ctx, s);
    const targetId = acquired.selectedActorId;
    s.assert(targetId, "acquireTarget returned no selectedActorId");
    ctx.note(`acquired ${targetId}`);
    await ctx.moneyShot("01-target-acquired");

    let oracle = await s.oracle();
    let targetActor = oracle?.actors?.[targetId];
    s.assert(targetActor, `acquired target ${targetId} missing from authority oracle`);
    s.assert(targetActor.lifeState === "alive", `acquired target ${targetId} lifeState ${targetActor?.lifeState} !== alive`);
    ctx.note(`target ${targetId} initial authority pos: (${Number(targetActor.x).toFixed(2)}, ${Number(targetActor.y).toFixed(2)}) lifeState=${targetActor.lifeState}`);

    // If target is east of the solid footlocker (590,512), immediately route south around footlocker (590,512)
    // and grill (589-590,514) so approachHostile starts from an unobstructed position on the east lane.
    const WEST_PATROL_X_MAX = 587.5;
    if (Number(targetActor.x) > WEST_PATROL_X_MAX) {
      ctx.note(`target ${targetId} at east position (${Number(targetActor.x).toFixed(2)}, ${Number(targetActor.y).toFixed(2)}); routing south around footlocker`);
      await walkAuthorityWaypoint(586, 508, { label: "south-lane clear of footlocker", timeoutMs: 10000 });
      await walkAuthorityWaypoint(Number(targetActor.x), 508, { label: "east along south-lane clear of footlocker", timeoutMs: 10000 });
      await walkAuthorityWaypoint(Number(targetActor.x), Math.min(Number(targetActor.y), 511), { label: "north to target clear of footlocker", timeoutMs: 10000 });
      oracle = await s.oracle();
      targetActor = oracle?.actors?.[targetId] ?? targetActor;
      s.assert(targetActor?.lifeState === "alive", `target ${targetId} lifeState ${targetActor?.lifeState} !== alive after south-lane route`);
      ctx.note(`post-route authority pos: player=${oracle?.actors?.[PLAYER_ID]?.x},${oracle?.actors?.[PLAYER_ID]?.y} target=${targetActor.x},${targetActor.y}`);
    } else {
      ctx.note(`target ${targetId} at west patrol authority pos: (${Number(targetActor.x).toFixed(2)}, ${Number(targetActor.y).toFixed(2)})`);
    }

    const closed = await approachHostile(ctx, s, 0.8, { targetId });
    s.assert(closed?.id === targetId, `approach actor id ${closed?.id ?? null} !== targetId ${targetId}`);
    s.assert(closed?.lifeState === "alive", `sparring target unavailable after approach: ${JSON.stringify(closed ?? null)}`);
    s.assert(closed.distanceCells <= 0.95, `failed to enter unarmed range: ${closed.distanceCells.toFixed(2)} cells`);
    ctx.note(`closed to ${closed.distanceCells.toFixed(2)} cells`);
    await ctx.moneyShot("02-unarmed-range");

    const beforeAttack = await s.probe();
    const baselineEventId = Math.max(0, ...(beforeAttack.combatEventLog ?? []).map((event) => Number(event.id) || 0));
    await s.slash("/attack basic_shot $target");

    // First-swing observation is render-frame-bound: Node waitProbe samples at
    // ~150ms and can miss a short swing_* montage under low FPS. Poll the live
    // probe on requestAnimationFrame and capture the exact montage string.
    let firstSwingMontage = null;
    try {
      const handle = await s.page.waitForFunction(() => {
        const montage = window.__successor3d?.activeClipsByLayer?.montage;
        return (typeof montage === "string" && montage.startsWith("swing_")) ? montage : false;
      }, undefined, { timeout: 8000, polling: "raf" });
      try {
        firstSwingMontage = await handle.jsonValue();
      } finally {
        await handle.dispose();
      }
    } catch (error) {
      const last = await s.probe().catch(() => null);
      s.assert(
        false,
        `timed out waiting for first unarmed swing montage (raf): ${error.message}; lastMontage=${JSON.stringify(last?.activeClipsByLayer?.montage ?? null)}`,
      );
    }
    s.assert(
      typeof firstSwingMontage === "string" && firstSwingMontage.startsWith("swing_"),
      `first unarmed swing montage missing: ${JSON.stringify(firstSwingMontage)}`,
    );
    const swingWeaponRoots = await weaponAttachmentNames(s);
    const swingAuthority = (await s.oracle()).actors?.[PLAYER_ID];
    s.assert(Array.isArray(swingWeaponRoots) && swingWeaponRoots.length === 0, `unarmed swing conjured weapon roots: ${JSON.stringify(swingWeaponRoots)}`);
    s.assert(swingAuthority?.weapon === null, `unarmed swing serialized an equipped weapon: ${JSON.stringify(swingAuthority?.weapon)}`);
    ctx.note(`first unarmed montage -> ${firstSwingMontage}; weapon roots=[]`);
    await ctx.moneyShot("03-unarmed-first-swing");

    // Basic attack is a repeat intent, but re-close/re-arm periodically so a
    // kiting target cannot turn this browser proof into a timing lottery.
    const deadline = Date.now() + 45000;
    let hit = playerHitAfter(await s.probe(), baselineEventId);
    let attempts = 1;
    while (!hit && Date.now() < deadline) {
      await ctx.delay(700);
      const probe = await s.probe();
      hit = playerHitAfter(probe, baselineEventId);
      if (hit) break;
      const currentTarget = (probe.selectedActorId === targetId && probe.selectedActor) ? probe.selectedActor : null;
      if (currentTarget?.lifeState === "alive" && currentTarget.distanceCells > 0.95) {
        const reclosed = await approachHostile(ctx, s, 0.8, { targetId, timeoutMs: 4000 });
        s.assert(reclosed?.id === targetId, `re-close actor id ${reclosed?.id ?? null} !== targetId ${targetId}`);
      }
      if (attempts % 2 === 0) await s.slash("/attack basic_shot $target");
      attempts += 1;
    }

    s.assert(hit, `no new unarmed authority hit from ${PLAYER_ID} after ${attempts} checks`);
    s.assert(Number(hit.damage) >= 1 && Number(hit.damage) <= 3, `unarmed hit damage ${hit.damage} escaped the deliberate 1-3 fallback band`);
    const finalWeaponRoots = await weaponAttachmentNames(s);
    const finalActor = (await s.oracle()).actors?.[PLAYER_ID];
    s.assert(Array.isArray(finalWeaponRoots) && finalWeaponRoots.length === 0, `authority hit left weapon roots on the pawn: ${JSON.stringify(finalWeaponRoots)}`);
    s.assert(finalActor?.weapon === null, `authority hit left a synthetic weapon equipped: ${JSON.stringify(finalActor?.weapon)}`);
    ctx.note(`authority hit id=${hit.id} shooter=${hit.shooter} target=${hit.target} damage=${hit.damage}; checks=${attempts}; weapon roots=[]`);
    await ctx.moneyShot("04-unarmed-authority-hit");
  },
};
