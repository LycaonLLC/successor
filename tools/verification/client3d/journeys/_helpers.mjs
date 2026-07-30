// Shared journey helpers: combat acquisition/approach/fight, corpse discovery.
// These drive the REAL client surfaces (target/attack verbs, WASD approach)
// and read authoritative truth from the __successor3d probe.

const VIEW_CX = 720;
const VIEW_CY = 450;

/** Item ids used by loadout arming (from the open-desert slice inventory). */
export const ITEM = {
  slugthrower: 3101,
  vibrosword: 3103,
  fieldSaber: 3106,
  quarryChopper: 3107,
  kilnCarbine: 3112,
  lightningCarbine: 3121,
  fieldMultitool: 3001,
  metalExtractor: 3006,
  mineralSurveyTool: 3008,
  waterSurveyTool: 3011,
  waterVaporator: 3014,
  ironOre: 2001,
  slugIron: 1101,
  fieldBandage: 1002,
  creditChip: 9002,
  fuel: 2009,
};

/** Open one permanent player-facing window through its real right-hand dock button. */
export async function openDockWindow(s, windowId, { timeoutMs = 15000 } = {}) {
  const windowSelector = `.sc3d-window[data-window="${windowId}"]`;
  if (await s.page.locator(windowSelector).first().isVisible().catch(() => false)) return;
  const buttonSelector = `.sc3d-dock-btn[data-dock-window="${windowId}"]`;
  await s.waitDom(buttonSelector, { state: "visible", timeoutMs });
  await s.click(buttonSelector);
  await s.waitDom(windowSelector, { state: "visible", timeoutMs });
}

/**
 * Open a context-only tool surface through the carried item's radial action.
 * This is the player route: specialized benches are absent from the dock,
 * global hotkeys, and the normal `/ui` allow list.
 */
export async function openInventoryContextAction(
  s,
  itemId,
  actionId,
  { readyItemIds = [], actionTimeoutMs = 6000 } = {},
) {
  await openDockWindow(s, "inventory");
  // Debug arming can commit several inventory grants back-to-back. Under the
  // concurrent software renderer the server receipts may outrun the client's
  // DOM projection, so seeing the target tile alone is not proof that the grid
  // has finished reflowing. Journeys with a multi-item setup can name their
  // final projection barrier here; two browser frames then let that reflow
  // settle before Playwright applies its own real-pointer actionability check.
  const readyIds = [...new Set([itemId, ...readyItemIds])];
  await Promise.all(readyIds.map((readyId) => s.waitDom(
    `.inv-slot[data-item-id="${readyId}"]`,
    { state: "visible", timeoutMs: 15000 },
  )));
  if (readyItemIds.length > 0) {
    await s.page.evaluate(() => new Promise((resolve) => {
      let frames = 2;
      const fallback = window.setTimeout(resolve, 3000);
      const onFrame = () => {
        frames -= 1;
        if (frames > 0) {
          window.requestAnimationFrame(onFrame);
          return;
        }
        window.clearTimeout(fallback);
        resolve();
      };
      window.requestAnimationFrame(onFrame);
    }));
  }
  const itemSelector = `.inv-slot[data-item-id="${itemId}"]`;
  await s.page.locator(itemSelector).first().click({ button: "right", timeout: actionTimeoutMs });
  const actionSelector = `.sc3d-radial:not([hidden]) .sc3d-radial-item[data-action="${actionId}"]`;
  await s.waitDom(actionSelector, { state: "visible", timeoutMs: actionTimeoutMs });
  await s.click(actionSelector);
}

/** Wait until a living non-player actor is in view (the sparring partner). */
export async function waitHostile(ctx, s, { timeoutMs = 18000 } = {}) {
  const p = await s.waitProbe(
    (probe) => probe.nearestHostile && probe.nearestHostile.lifeState === "alive",
    { label: "hostile present", timeoutMs },
  );
  return p.nearestHostile;
}

/**
 * Target the nearest hostile by its ACTUAL id (deterministic under a crowd of
 * roaming actors) and confirm the selection latched; retry the slash a few
 * times to ride out first-frame/CPU-contention misses.
 */
export async function acquireTarget(ctx, s) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hostile = (await s.probe())?.nearestHostile;
    const targetId = hostile?.id ?? null;
    await s.slash(targetId ? `/target ${targetId}` : "/target nearest hostile");
    const got = await s.waitProbe(
      (p) => targetId ? String(p.selectedActorId) === String(targetId) : !!p.selectedActorId,
      { label: "target acquired", timeoutMs: 4000 },
    ).catch(() => null);
    if (got) return got;
    await ctx.delay(500);
  }
  // Final attempt surfaces the timeout with context while retaining the same
  // exact-id contract. A merely non-empty selection may be a downed target
  // left over from the preceding fight.
  const hostile = (await s.probe())?.nearestHostile;
  const targetId = hostile?.id ?? null;
  await s.slash(targetId ? `/target ${targetId}` : "/target nearest hostile");
  return s.waitProbe(
    (p) => targetId ? String(p.selectedActorId) === String(targetId) : !!p.selectedActorId,
    { label: "target acquired", timeoutMs: 4000 },
  );
}

/**
 * Walk toward the current nearest hostile until within `withinCells`.
 * Prefer authority/oracle world deltas (same contract as approachCorpse) so
 * solid camp props cannot pin a pure screen-space approach. Screen coords
 * remain a fallback when oracle positions are unavailable.
 */
export async function approachHostile(ctx, s, withinCells, { timeoutMs = 16000, targetId = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let stuckCount = 0;
  let lastPlayerPos = null;
  while (Date.now() < deadline) {
    let probe = await s.probe();
    const effectiveTargetId = targetId ?? probe?.selectedActorId ?? null;
    if (effectiveTargetId && probe?.selectedActorId !== effectiveTargetId) {
      await s.slash("/target " + effectiveTargetId);
      probe = await s.probe();
    }
    let h = null;
    if (targetId) {
      if (probe?.selectedActorId === targetId && probe?.selectedActor) {
        h = probe.selectedActor;
      } else {
        const oracle = await s.oracle().catch(() => null);
        const playerActor = probe?.authorityPlayer ?? oracle?.actors?.[s.actorId];
        const targetActor = oracle?.actors?.[targetId] ?? probe?.actors?.[targetId];
        if (playerActor && targetActor) {
          const dx = Number(targetActor.x) - Number(playerActor.x);
          const dy = Number(targetActor.y) - Number(playerActor.y);
          h = {
            id: targetActor.id ?? targetId,
            x: Number(targetActor.x),
            y: Number(targetActor.y),
            distanceCells: Math.hypot(dx, dy),
            lifeState: targetActor.lifeState ?? "alive",
            screen: null,
          };
        }
      }
      if (!h) {
        await s.hold([], 200);
        continue;
      }
    } else if (effectiveTargetId && probe?.selectedActorId === effectiveTargetId && probe?.selectedActor) {
      h = probe.selectedActor;
    } else {
      h = probe?.nearestHostile;
    }

    if (!h || h.lifeState !== "alive") return h;
    if (h.distanceCells <= withinCells) return h;

    const me = probe?.authorityPlayer;
    const hx = Number(h.x);
    const hy = Number(h.y);
    if (me && lastPlayerPos) {
      const moved = Math.hypot(me.x - lastPlayerPos.x, me.y - lastPlayerPos.y);
      if (moved < 0.08) {
        stuckCount += 1;
      } else {
        stuckCount = 0;
      }
    }
    if (me) {
      lastPlayerPos = { x: me.x, y: me.y };
    }

    const keys = [];
    if (me && Number.isFinite(hx) && Number.isFinite(hy)) {
      const dx = hx - Number(me.x);
      const dy = hy - Number(me.y);
      if (stuckCount > 0) {
        if (stuckCount % 3 === 1) {
          if (Math.abs(dx) > 0.1) keys.push(dx > 0 ? "KeyD" : "KeyA");
          else keys.push(dy > 0 ? "KeyS" : "KeyW");
        } else if (stuckCount % 3 === 2) {
          if (Math.abs(dy) > 0.1) keys.push(dy > 0 ? "KeyS" : "KeyW");
          else keys.push(dx > 0 ? "KeyD" : "KeyA");
        } else {
          if (Math.abs(dx) >= Math.abs(dy)) {
            keys.push(dy >= 0 ? "KeyS" : "KeyW");
          } else {
            keys.push(dx >= 0 ? "KeyD" : "KeyA");
          }
        }
      } else {
        if (dy > 0.15) keys.push("KeyS"); else if (dy < -0.15) keys.push("KeyW");
        if (dx > 0.15) keys.push("KeyD"); else if (dx < -0.15) keys.push("KeyA");
      }
      if (keys.length === 0) {
        if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? "KeyD" : "KeyA");
        else keys.push(dy >= 0 ? "KeyS" : "KeyW");
      }
    } else {
      const sc = h.screen;
      if (sc) {
        if (sc.py < VIEW_CY - 40) keys.push("KeyW"); else if (sc.py > VIEW_CY + 40) keys.push("KeyS");
        if (sc.px < VIEW_CX - 40) keys.push("KeyA"); else if (sc.px > VIEW_CX + 40) keys.push("KeyD");
      }
      if (keys.length === 0) keys.push("KeyD");
    }
    await s.hold(keys, 250);
  }

  const finalProbe = await s.probe();
  if (targetId) {
    if (finalProbe?.selectedActorId === targetId && finalProbe?.selectedActor) {
      return finalProbe.selectedActor;
    }
    const oracle = await s.oracle().catch(() => null);
    const playerActor = finalProbe?.authorityPlayer ?? oracle?.actors?.[s.actorId];
    const targetActor = oracle?.actors?.[targetId] ?? finalProbe?.actors?.[targetId];
    if (playerActor && targetActor) {
      const dx = Number(targetActor.x) - Number(playerActor.x);
      const dy = Number(targetActor.y) - Number(playerActor.y);
      return {
        id: targetActor.id ?? targetId,
        x: Number(targetActor.x),
        y: Number(targetActor.y),
        distanceCells: Math.hypot(dx, dy),
        lifeState: targetActor.lifeState ?? "alive",
        screen: null,
      };
    }
    return null;
  }

  const effId = finalProbe?.selectedActorId ?? null;
  if (effId && finalProbe?.selectedActorId === effId && finalProbe?.selectedActor) {
    return finalProbe.selectedActor;
  }
  return finalProbe?.nearestHostile;
}
/**
 * Arm auto-repeat basic attack on the selected target and wait until it dies.
 * Returns { killed, myHits, targetId, downedDelta }.
 */
export async function fightToKill(ctx, s, targetId, { timeoutMs = 30000, reAttackMs = 2500, meleeRange = null } = {}) {
  const startDowned = (await s.probe())?.downedCount ?? 0;
  await s.slash("/attack basic_shot $target");
  const deadline = Date.now() + timeoutMs;
  let lastAttack = Date.now();
  let killed = false;
  let sawMyHit = false;
  let lastTargetHp = null;
  while (Date.now() < deadline) {
    await ctx.delay(500);
    const p = await s.probe();
    // combatEventLog is a rolling tail; accumulate the "I dealt damage" flag.
    if ((p.combatEventLog ?? []).some((e) => String(e.shooter) === String(p.playerActorId) && e.hit)) sawMyHit = true;
    const targetActor = (await s.oracle().catch(() => null))?.actors?.[targetId];
    if (targetActor?.vitals) lastTargetHp = targetActor.vitals.health;
    // Only the selected actor's explicit authority lifecycle proves this kill.
    // The global downed count also includes the player and every nearby NPC,
    // while a missing population actor may simply have been released when its
    // zone deactivated. Neither is evidence that this target died.
    const targetDowned = targetActor && ["downed", "dead", "respawning"].includes(targetActor.lifeState);
    if (targetDowned) { killed = true; break; }
    // Melee: the rogue kites, so stay glued to it — re-close before re-arming.
    if (meleeRange && p.nearestHostile && p.nearestHostile.distanceCells > meleeRange) {
      await approachHostile(ctx, s, meleeRange, { timeoutMs: 4000 });
      await s.slash("/attack basic_shot $target");
      lastAttack = Date.now();
      continue;
    }
    // re-arm periodically (repeat intent can drop on target loss / range).
    if (Date.now() - lastAttack > reAttackMs) {
      await s.slash("/attack basic_shot $target");
      lastAttack = Date.now();
    }
  }
  const end = await s.probe();
  const myHits = (end.combatEventLog ?? []).filter((e) => e.shooter && String(end.playerActorId) === String(e.shooter)).length;
  return { killed, myHits, sawMyHit, lastTargetHp, downedDelta: (end.downedCount ?? 0) - startDowned };
}

/** Switch the chat pane to its COMBAT tab; true if combat lines are present. */
export async function combatTabHasLines(s) {
  await s.click('.sc3d-chat-tab[data-tab="combat"]').catch(() => {});
  const count = await s.page.locator(".sc3d-chat-combatrow").count().catch(() => 0);
  return count;
}


/** Find a player-owned inventory stack for an itemId via the server oracle. */
export async function findInventoryStack(s, itemId, { timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const oracle = await s.oracle().catch(() => null);
    const rows = Array.isArray(oracle?.inventory) ? oracle.inventory : [];
    const row = rows.find((r) => r.itemId === itemId && String(r.container).startsWith(s.actorId) && (r.available ?? r.quantity ?? 0) > 0);
    if (row) return { container: row.container, stackId: row.stackId ?? row.stack_id, variantId: row.variantId ?? row.variant_id ?? 0, available: row.available ?? row.quantity };
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Walk the player toward a downed actor's authority position until within
 * `withinCells` (default 1.4 — well inside the 1.75-cell interaction radius).
 * Uses oracle actor positions for deterministic targeting instead of screen-
 * space heuristics. Returns the final distance.
 */
export async function approachCorpse(ctx, s, corpseId, { withinCells = 1.4, timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const o = await s.oracle().catch(() => null);
    const player = o?.actors?.[s.actorId];
    const corpse = o?.actors?.[corpseId];
    if (!player || !corpse) { await new Promise((r) => setTimeout(r, 200)); continue; }
    const dx = Number(corpse.x) - Number(player.x);
    const dy = Number(corpse.y) - Number(player.y);
    const dist = Math.hypot(dx, dy);
    if (dist <= withinCells) return dist;
    // Steer toward the corpse using cardinal keys based on world-space delta.
    const keys = [];
    if (dy > 0.3) keys.push("KeyS"); else if (dy < -0.3) keys.push("KeyW");
    if (dx > 0.3) keys.push("KeyD"); else if (dx < -0.3) keys.push("KeyA");
    if (keys.length === 0) keys.push("KeyS");
    await s.hold(keys, 250);
  }
  return Infinity;
}

/**
 * HOLD-F take-all on a corpse: ensures the corpse is within interaction range,
 * confirms the probe shows a corpse interaction, holds F for the threshold
 * duration, and returns true. Retries the approach + hold cycle up to 3 times
 * to absorb drift under concurrent load (the root cause of gate-only HOLD-F
 * failures was a swallowed `.catch(() => {})` that masked the corpse leaving
 * the 1.75-cell interaction radius).
 */
export async function holdFTakeAll(ctx, s, corpseId, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt += 1) {
    // 1. Walk within interaction radius.
    await approachCorpse(ctx, s, corpseId, { withinCells: 1.2, timeoutMs: 8000 });
    // 2. Wait for the corpse to appear in the interaction options (state-driven).
    const interactable = await s.waitProbe(
      (p) => (p.interactions ?? []).some((o) => o.kind === "corpse" && o.targetId === corpseId),
      { label: `corpse ${corpseId} interactable (attempt ${attempt + 1})`, timeoutMs: 4000 },
    ).catch(() => null);
    if (!interactable) {
      ctx.note(`hold-F attempt ${attempt + 1}: corpse not interactable, retrying approach`);
      continue;
    }
    // 3. Hold F for 1.3s (> 1s HOLD_TO_TAKE_ALL_MS threshold, generous margin).
    await s.hold("KeyF", 1300);
    return true;
  }
  // Surface the failure with context instead of swallowing it.
  const lastOracle = await s.oracle().catch(() => null);
  const player = lastOracle?.actors?.[s.actorId];
  const corpse = lastOracle?.actors?.[corpseId];
  const dist = player && corpse ? Math.hypot(Number(corpse.x) - Number(player.x), Number(corpse.y) - Number(player.y)).toFixed(2) : "?";
  const interactions = (await s.probe().catch(() => null))?.interactions ?? [];
  throw new Error(`holdFTakeAll failed after 3 attempts — dist=${dist}, interactions=${JSON.stringify(interactions.map((o) => o.kind + ":" + o.targetId))}, corpse lifeState=${corpse?.lifeState ?? "?"}`);
}
