// Headed journey: Player Association terminal kiosk grammar plus normal
// management entry points. The authored dustgate-pa-terminal prop is present
// in the open-desert world; every open path below is ordinary visible input
// (F chip, single LMB, right-click radial screen, double-click) or a normal
// management route (dock / G / slash), with no injected pickers.
const PA = '.sc3d-window[data-window="player-association"]';
const PA_ID = 'dustgate-pa-terminal';
const PA_CELL = { x: 509, y: 501 };
// Runtime-proven trainer-only / PA-out stand (starter r21): >1.75 from PA center.
const PA_CLEAR_STAND = { x: 510.6, y: 503.0 };
const RADIAL = '.sc3d-radial:not([hidden])';
const RADIAL_SCREEN = `${RADIAL} .sc3d-radial-item[data-action="screen"]`;

async function waitAccepted(s, kind, timeoutMs = 15000) {
  return s.waitProbe(
    (p) => (p.authorityReceiptTail ?? []).some((r) => r.kind === kind && r.accepted),
    { label: `${kind} accepted receipt`, timeoutMs },
  );
}

async function waitText(s, selector, text, label) {
  return s.waitFn(
    `(() => document.querySelector(${JSON.stringify(selector)})?.textContent === ${JSON.stringify(text)})()`,
    { label, timeoutMs: 12000 },
  );
}

async function closePa(s) {
  await s.press('Escape');
  await s.waitDom(PA, { state: 'hidden', timeoutMs: 5000 }).catch(() => {});
}

async function canvasClientPoint(s, canvasX, canvasY) {
  const box = await s.page.locator('canvas.successor3d-canvas').boundingBox();
  s.assert(box, '3D canvas exists for terminal pointer route');
  return { x: box.x + canvasX, y: box.y + canvasY, box };
}

/**
 * Project the authored PA kiosk center through the live world→screen bridge.
 * Tries a tight height ladder around the kiosk face (asset ~1.75 tall).
 * Returns CSS-px canvas-local anchors (same space as probe.screen).
 */
async function projectPaTerminal(s) {
  return s.page.evaluate(({ cellX, cellY, heights }) => {
    const project = window.__successor3dWorldToScreen;
    if (typeof project !== 'function') {
      return { ok: false, reason: 'missing __successor3dWorldToScreen hook' };
    }
    const x = cellX + 0.5;
    const z = cellY + 0.5;
    const hits = [];
    for (const height of heights) {
      const point = project(x, z, height);
      if (!point || !Number.isFinite(point.px) || !Number.isFinite(point.py)) continue;
      hits.push({ height, canvasX: point.px, canvasY: point.py });
    }
    if (hits.length === 0) {
      return { ok: false, reason: 'worldToScreen returned no finite anchors', x, z, heights };
    }
    return { ok: true, x, z, hits };
  }, {
    cellX: PA_CELL.x,
    cellY: PA_CELL.y,
    heights: [0.9, 1.0, 1.1, 1.25, 1.35],
  });
}

/** Tiny neighborhood around a projected canvas point (no broad ground fan). */
function projectionNeighborhood(canvasX, canvasY) {
  const points = [[canvasX, canvasY]];
  for (const step of [10, 20]) {
    points.push(
      [canvasX + step, canvasY],
      [canvasX - step, canvasY],
      [canvasX, canvasY + step],
      [canvasX, canvasY - step],
      [canvasX + step, canvasY + step],
      [canvasX + step, canvasY - step],
      [canvasX - step, canvasY + step],
      [canvasX - step, canvasY - step],
    );
  }
  return points;
}

async function dismissStrayRadial(s) {
  const open = await s.page.locator(RADIAL).isVisible().catch(() => false);
  if (!open) return;
  await s.press('Escape');
  await s.waitDom(RADIAL, { state: 'hidden', timeoutMs: 1500 }).catch(() => {});
}

async function inputTailSnapshot(s) {
  return s.page.evaluate(() => {
    const rec = window.__successor3dInputRec;
    if (!rec || typeof rec.entries !== 'function') return [];
    return rec.entries().slice(-12).map((entry) => ({
      kind: entry.kind,
      button: entry.button ?? null,
      routed: entry.routed ?? null,
      actorId: entry.actorId ?? null,
      commandKind: entry.commandKind ?? null,
      source: entry.source ?? null,
    }));
  }).catch(() => []);
}

async function pointerFailureDetail(s, kind, attempts, evidence = null) {
  const probe = await s.probe().catch(() => null);
  const inputTail = await inputTailSnapshot(s);
  const paVisible = await s.page.locator(PA).isVisible().catch(() => false);
  const radialVisible = await s.page.locator(RADIAL).isVisible().catch(() => false);
  const radialText = radialVisible
    ? await s.page.locator(RADIAL).innerText().catch(() => "")
    : "";
  return [
    `real ${kind} pointer route did not open Association`,
    `attempts=${attempts}`,
    `paVisible=${paVisible}`,
    `radialVisible=${radialVisible}`,
    `radialText=${JSON.stringify(radialText.slice(0, 160))}`,
    `playerCell=${JSON.stringify(probe?.playerCell ?? null)}`,
    `authorityPlayer=${JSON.stringify(probe?.authorityPlayer ?? null)}`,
    `interactions=${JSON.stringify((probe?.interactions ?? []).slice(0, 6))}`,
    `projection=${JSON.stringify(evidence?.projection ?? null)}`,
    `lastPoint=${JSON.stringify(evidence?.lastPoint ?? null)}`,
    `inputTail=${JSON.stringify(inputTail)}`,
  ].join("; ");
}

/** Try visible canvas points around the centered terminal until the real
 * renderer raycast selects the PA kiosk. This is pointer input, not a debug
 * picker or injected module. */
async function openByPointer(s, kind, action) {
  await dismissStrayRadial(s);
  const projection = await projectPaTerminal(s);
  s.assert(projection?.ok, `PA terminal projection failed: ${JSON.stringify(projection)}`);
  // Prefer the mid-height hit first, then the rest of the ladder.
  const orderedHits = [...projection.hits].sort((a, b) => Math.abs(a.height - 1.1) - Math.abs(b.height - 1.1));
  const candidates = [];
  const seen = new Set();
  for (const hit of orderedHits) {
    for (const [cx, cy] of projectionNeighborhood(hit.canvasX, hit.canvasY)) {
      const key = `${Math.round(cx)},${Math.round(cy)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ canvasX: cx, canvasY: cy, height: hit.height });
    }
  }
  s.assert(candidates.length > 0, 'PA projection produced no pointer candidates');

  const budgetMs = action === 'radial' ? 20000 : 15000;
  const startedAt = Date.now();
  let attempts = 0;
  let lastPoint = null;
  for (const candidate of candidates) {
    if (Date.now() - startedAt > budgetMs) break;
    attempts += 1;
    const point = await canvasClientPoint(s, candidate.canvasX, candidate.canvasY);
    lastPoint = { ...candidate, clientX: point.x, clientY: point.y };
    if (
      point.x < point.box.x + 2
      || point.y < point.box.y + 2
      || point.x > point.box.x + point.box.width - 2
      || point.y > point.box.y + point.box.height - 2
    ) {
      continue;
    }
    if (action === 'double') {
      await s.page.mouse.dblclick(point.x, point.y, { delay: 80 });
      const opened = await s.waitDom(PA, { state: 'visible', timeoutMs: 2500 }).then(() => true).catch(() => false);
      if (opened) return;
    } else if (action === 'radial') {
      await s.page.mouse.click(point.x, point.y, { button: 'right' });
      const shown = await s.waitDom(RADIAL_SCREEN, { state: 'visible', timeoutMs: 2500 })
        .then(() => true)
        .catch(() => false);
      if (!shown) {
        await dismissStrayRadial(s);
        continue;
      }
      const label = (await s.page.locator(RADIAL_SCREEN).innerText().catch(() => '')).toUpperCase();
      // PA kiosk radial carries Association Registry; other kiosks share data-action=screen.
      if (!label.includes('ASSOCIATION') && !label.includes('REGISTRY')) {
        await dismissStrayRadial(s);
        continue;
      }
      await s.click(RADIAL_SCREEN);
      const opened = await s.waitDom(PA, { state: 'visible', timeoutMs: 2500 }).then(() => true).catch(() => false);
      if (opened) return;
      await dismissStrayRadial(s);
    } else {
      await s.page.mouse.click(point.x, point.y, { button: 'left' });
      const opened = await s.waitDom(PA, { state: 'visible', timeoutMs: 2500 }).then(() => true).catch(() => false);
      if (opened) return;
    }
  }
  throw new Error(await pointerFailureDetail(s, kind, attempts, { projection, lastPoint }));
}

async function openByF(s) {
  await s.waitProbe(
    (p) => (p.interactions ?? []).some((o) => o.kind === 'paTerminal' && o.targetId === PA_ID),
    { label: 'PA terminal in F interaction chip', timeoutMs: 15000 },
  );
  await s.press('KeyF');
  await s.waitDom(PA, { state: 'visible', timeoutMs: 10000 });
}

async function walkAuthorityTo(ctx, s, target, {
  withinCells = 0.3,
  timeoutMs = 15000,
  minPulseMs = 100,
  maxPulseMs = 280,
  stopPredicate = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let stallPulses = 0;
  while (Date.now() < deadline) {
    const probe = await s.probe();
    if (stopPredicate && stopPredicate(probe)) {
      const actor = probe?.authorityPlayer;
      if (actor) {
        return { x: actor.x, y: actor.y, distance: Math.hypot(target.x - Number(actor.x), target.y - Number(actor.y)) };
      }
    }
    const actor = probe?.authorityPlayer;
    if (!actor) {
      await ctx.delay(100);
      continue;
    }
    const dx = target.x - Number(actor.x);
    const dy = target.y - Number(actor.y);
    const distance = Math.hypot(dx, dy);
    last = { x: actor.x, y: actor.y, distance };
    if (distance <= withinCells) return last;
    const keys = [];
    if (dy > 0.12) keys.push('KeyS'); else if (dy < -0.12) keys.push('KeyW');
    if (dx > 0.12) keys.push('KeyD'); else if (dx < -0.12) keys.push('KeyA');
    if (keys.length === 0) {
      if (Math.abs(dx) >= Math.abs(dy)) keys.push(dx >= 0 ? 'KeyD' : 'KeyA');
      else keys.push(dy >= 0 ? 'KeyS' : 'KeyW');
    }
    const pulseMs = Math.min(maxPulseMs, Math.max(minPulseMs, Math.round(distance * 140)));
    const before = { x: Number(actor.x), y: Number(actor.y) };
    await s.hold(keys, pulseMs);
    const after = (await s.probe())?.authorityPlayer;
    if (after && Math.hypot(Number(after.x) - before.x, Number(after.y) - before.y) < 0.02) {
      stallPulses += 1;
      if (stallPulses > 20) {
        throw new Error(`walkAuthorityTo stalled at (${after.x},${after.y}) going to (${target.x},${target.y})`);
      }
    } else {
      stallPulses = 0;
    }
  }
  throw new Error(`walkAuthorityTo timed out at ${JSON.stringify(last)} going to (${target.x},${target.y})`);
}

export default {
  id: 'association-terminal',
  title: 'Association terminal kiosk + normal management entries (headed)',
  headed: true,
  timeoutMs: 180000,
  characters: [{
    role: 'founder',
    id: 'h3d-association-terminal',
    name: 'AssocFounder',
    x: 510,
    y: 502,
    initialProfessionId: 'brawler',
    professions: { credits: 300000 },
  }],
  async run(ctx) {
    const s = ctx.session('founder');
    await s.waitProbe((p) => p.serverStatus === 'connected' && p.authorityPlayer, { label: 'authority connected', timeoutMs: 30000 });
    ctx.note(`PA terminal ${PA_ID} expected near ${JSON.stringify(PA_CELL)}; spawn=${JSON.stringify((await s.probe())?.playerCell ?? null)}`);

    // Kiosk grammar: F-chip, single LMB screen, radial screen action, and
    // double-click all open the same real Association window.
    await openByF(s);
    await s.waitDom(`${PA} [aria-label="Association name"]`, { state: 'visible', timeoutMs: 8000 });
    await s.waitDom(`${PA} [aria-label="Public directory"]`, { state: 'visible', timeoutMs: 8000 });
    await ctx.moneyShot('00-association-f-chip', s);
    await closePa(s);

    await openByPointer(s, 'single-LMB', 'single');
    await s.waitDom(`${PA} [aria-label="Found an association"]`, { state: 'visible', timeoutMs: 8000 });
    await ctx.moneyShot('01-association-single-lmb', s);
    await closePa(s);

    // Radial reuses the proven LMB hit first; no 100s blind full-canvas scan.
    await openByPointer(s, 'radial', 'radial');
    await s.waitDom(`${PA} [aria-label="Public directory"]`, { state: 'visible', timeoutMs: 8000 });
    await ctx.moneyShot('02-association-radial', s);
    await closePa(s);

    await openByPointer(s, 'double-click', 'double');
    await s.waitDom(PA, { state: 'visible', timeoutMs: 8000 });
    await ctx.moneyShot('03-association-double-click', s);

    // Charter form is a normal accessible form. The submit is proven by the
    // authority receipt, and the returned roster is the server projection.
    await s.page.getByLabel('Association name').fill('Dustgate Wardens');
    await s.page.getByLabel('Association tag').fill('DWRDN');
    await s.click(`${PA} [data-ref="found"]`);
    await waitAccepted(s, 'GuildCreate');
    await s.waitDom(`${PA} [aria-label="Member roster"]`, { state: 'visible', timeoutMs: 15000 });
    await s.waitDom(`${PA} [aria-label="Public directory"]`, { state: 'visible', timeoutMs: 8000 });
    await ctx.moneyShot('04-association-charter-roster-directory', s);
    await closePa(s);
    // Leave PA reach with an authority-grounded walk to the proven clear stand
    // (not blind A/S holds that wedge against commerce solids).
    const cleared = await walkAuthorityTo(ctx, s, PA_CLEAR_STAND, {
      withinCells: 0.35,
      timeoutMs: 15000,
      minPulseMs: 100,
      maxPulseMs: 280,
      stopPredicate: (p) => !(p.interactions ?? []).some((option) => option.kind === 'paTerminal' && option.targetId === PA_ID),
    });
    ctx.note(`cleared PA reach at (${Number(cleared.x).toFixed(3)},${Number(cleared.y).toFixed(3)})`);
    await s.waitProbe(
      (p) => !(p.interactions ?? []).some((option) => option.kind === 'paTerminal' && option.targetId === PA_ID),
      { label: 'away from PA terminal', timeoutMs: 10000 },
    );

    // Normal management routes work away from the terminal: dock button, G,
    // and the visible chat slash command all open the same surface.
    await s.click('.sc3d-dock-btn[data-dock-window="player-association"]');
    await s.waitDom(PA, { state: 'visible', timeoutMs: 8000 });
    await s.waitDom(`${PA} [aria-label="Member roster"]`, { state: 'visible', timeoutMs: 8000 });
    await closePa(s);

    await s.press('KeyG');
    await s.waitDom(PA, { state: 'visible', timeoutMs: 8000 });
    await s.waitDom(`${PA} [aria-label="Member roster"]`, { state: 'visible', timeoutMs: 8000 });
    await closePa(s);

    await s.slash('/ui association');
    await s.waitDom(PA, { state: 'visible', timeoutMs: 8000 });
    await s.waitDom(`${PA} [aria-label="Member roster"]`, { state: 'visible', timeoutMs: 8000 });
    await waitText(s, `${PA} [data-ref="link"]`, 'NO TERMINAL LINK', 'normal management remains terminal-independent');
    await ctx.moneyShot('05-association-normal-entry', s);
  },
};
