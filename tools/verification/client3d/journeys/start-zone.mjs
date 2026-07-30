// Journey: the authored new-player anchors are real runtime presentations.
// GR0K must be the promoted humanoid droid, idle and examinable without a
// fabricated job. Moving east/right reaches the promoted wedge terminal and
// its animated screen resources through the ordinary in-world travel prompt.

const GROK_ID = "grok";
const TERMINAL_ID = "travel-terminal-dustgate";
const TERMINAL_CELL = { x: 524, y: 512 };

function newAuthorityReceipt(probe, knownCommandIds, kind) {
  return (probe.authorityReceiptTail ?? []).find((entry) => (
    !knownCommandIds.has(entry.commandId) && entry.kind === kind
  ));
}

function exactTerminalInteraction(probe) {
  return (probe?.interactions ?? []).find((option) => (
    option.kind === "travelTerminal"
      && option.targetId === TERMINAL_ID
      && option.distanceCells <= 1.5
  )) ?? null;
}

/**
 * Advance one cardinal input pulse and wait for authority displacement. A
 * key's elapsed down-time is never treated as movement proof: under the full
 * concurrent software-GL gate, a short hold can span only one or two frames.
 */
async function authorityPulse(ctx, s, key, { pulseMs = 480, settleMs = 1800 } = {}) {
  const before = (await s.probe()).authorityPlayer;
  if (!before) {
    await ctx.delay(150);
    return { actor: null, moved: false };
  }
  await s.hold(key, pulseMs);
  const moved = await s.waitProbe(
    (probe) => {
      const actor = probe.authorityPlayer;
      return actor && Math.hypot(actor.x - before.x, actor.y - before.y) >= 0.03;
    },
    { label: `authority displacement after ${key}`, timeoutMs: settleMs, intervalMs: 100 },
  ).catch(() => null);
  if (moved?.authorityPlayer) return { actor: moved.authorityPlayer, moved: true };
  await ctx.delay(250);
  return { actor: (await s.probe()).authorityPlayer, moved: false };
}

/**
 * Approach the exact authored terminal from fresh authority coordinates until
 * its ordinary interaction is within 1.5 cells. The deadline is wall-clock;
 * progress is authority displacement, so low renderer FPS cannot exhaust an
 * arbitrary pulse count before the pawn has covered the required distance.
 */
async function approachTerminal(ctx, s, { timeoutMs = 40000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const keyPulses = { KeyW: 0, KeyA: 0, KeyS: 0, KeyD: 0 };
  let stalls = 0;
  let lastProbe = null;
  while (Date.now() < deadline) {
    const probe = await s.probe();
    lastProbe = probe;
    if (exactTerminalInteraction(probe)) {
      await s.releaseAll();
      return { probe, keyPulses, stalls };
    }
    const actor = probe.authorityPlayer;
    if (!actor) {
      await ctx.delay(150);
      continue;
    }

    const dx = TERMINAL_CELL.x - actor.x;
    const dy = TERMINAL_CELL.y - actor.y;
    let key;
    // Correct the larger world-space error first. These are the canonical
    // controls: +x east/right = D, -x west/left = A, +y south/down = S,
    // -y north/up = W.
    if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 0.16) key = dx > 0 ? "KeyD" : "KeyA";
    else if (Math.abs(dy) > 0.16) key = dy > 0 ? "KeyS" : "KeyW";
    else {
      // Position and interaction projection may land on adjacent snapshots.
      // Give the exact interaction one short projection window before failing.
      const projected = await s.waitProbe(
        (candidate) => Boolean(exactTerminalInteraction(candidate)),
        { label: "Dustgate terminal interaction projection", timeoutMs: 1800, intervalMs: 100 },
      ).catch(() => null);
      if (projected) return { probe: projected, keyPulses, stalls };
      break;
    }

    keyPulses[key] += 1;
    const result = await authorityPulse(ctx, s, key);
    if (!result.moved) stalls += 1;
  }
  await s.releaseAll();
  const finalProbe = await s.probe().catch(() => lastProbe);
  return { probe: finalProbe, keyPulses, stalls };
}

export default {
  id: "start-zone",
  title: "Start zone (GR0K + animated travel terminal)",
  timeoutMs: 150000,
  characters: [{
    role: "primary",
    id: "h3d-start-zone-probe",
    name: "ProbeStart",
    x: 512,
    y: 512,
    initialProfessionId: "brawler",
    skillBoxIds: ["brawler-novice"],
  }],
  async run(ctx) {
    const s = ctx.primary;
    await s.waitProbe((probe) => probe.serverStatus === "connected", {
      label: "start-zone authority connected",
      timeoutMs: 20000,
    });
    const grok = (await s.oracle()).actors?.[GROK_ID];
    s.assert(grok?.label === "GR0K", `start-zone actor label drifted: ${JSON.stringify(grok ?? null)}`);
    s.assert(grok?.sprite === "droid-grok-humanoid", `GR0K sprite drifted: ${grok?.sprite}`);
    s.assert(grok?.descriptor === "a humanoid droid", `GR0K descriptor drifted: ${grok?.descriptor}`);
    s.assert(grok?.role === "scripted_player" && grok?.authored === true,
      `GR0K left the authored social-actor lane: role=${grok?.role} authored=${grok?.authored}`);
    s.assert(grok?.pvpStatus === "none", `GR0K must remain neutral, got ${grok?.pvpStatus}`);
    s.assert((grok?.professions ?? []).length === 0, `GR0K acquired an invented profession: ${JSON.stringify(grok?.professions)}`);

    // Resolve the exact fixture id through the player-facing target verb. The
    // selectedActor projection is renderer-owned and never substitutes a
    // merely-nearest non-player actor.
    await s.slash(`/target ${GROK_ID}`);
    const start = await s.waitProbe(
      (probe) => probe.selectedActorId === GROK_ID
        && probe.selectedActor?.id === GROK_ID
        && probe.selectedActor?.rendered === true
        && probe.selectedActor?.screen !== null
        && /idle/iu.test(probe.selectedActor?.baseClip ?? ""),
      { label: "exact GR0K pawn rendered idle beside the start", timeoutMs: 12000 },
    );
    s.assert(start.selectedActor?.lifeState === "alive", `GR0K is not alive: ${start.selectedActor?.lifeState}`);
    s.assert(/idle/iu.test(start.selectedActor?.baseClip ?? ""), `GR0K idle clip is not active: ${start.selectedActor?.baseClip}`);
    await ctx.moneyShot("00-grok-in-world");

    const screen = start.selectedActor.screen;
    await s.page.mouse.dblclick(screen.px, screen.py, { delay: 90 });
    await s.waitDom('.sc3d-window[data-window="targetExamine"]', { state: "visible", timeoutMs: 8000 });
    await s.waitDom('.sc3d-window[data-window="targetExamine"] [data-ref="model"] canvas', { state: "visible", timeoutMs: 8000 });
    const examinedName = await s.waitProbeCall(
      () => s.page.locator('.sc3d-window[data-window="targetExamine"] [data-ref="name"]').innerText().catch(() => ""),
      (value) => value === "GR0K",
      { label: "GR0K target examine", timeoutMs: 8000 },
    );
    s.assert(examinedName === "GR0K", `target examine resolved ${examinedName}`);
    await ctx.moneyShot("01-grok-examine");
    await s.click('.sc3d-window[data-window="targetExamine"] .sc3d-window-close');

    // Drive the real attack verb and bind the result to a new authority
    // receipt. Neutral client presentation alone is not protection proof.
    const knownAttackCommandIds = new Set((await s.probe()).authorityReceiptTail?.map((entry) => entry.commandId) ?? []);
    const grokHealthBefore = Number(grok.vitals?.health);
    s.assert(Number.isFinite(grokHealthBefore), `GR0K authority health missing: ${JSON.stringify(grok.vitals ?? null)}`);
    await s.slash(`/attack basic_shot ${GROK_ID}`);
    const protectedProbe = await s.waitProbe(
      (probe) => Boolean(newAuthorityReceipt(probe, knownAttackCommandIds, "QueueCombatAction")),
      { label: "GR0K authority protection receipt", timeoutMs: 8000 },
    );
    const protectedReceipt = newAuthorityReceipt(protectedProbe, knownAttackCommandIds, "QueueCombatAction");
    s.assert(
      protectedReceipt?.accepted === false && protectedReceipt.reasonCode === "target_protected",
      `GR0K attack did not reject as target_protected: ${JSON.stringify(protectedReceipt ?? null)}`,
    );
    const protectedGrok = (await s.oracle()).actors?.[GROK_ID];
    s.assert(
      protectedGrok?.lifeState === "alive" && Number(protectedGrok?.vitals?.health) >= grokHealthBefore,
      `GR0K changed after protected attack: ${JSON.stringify(protectedGrok ?? null)}`,
    );
    ctx.note(`GR0K is authority-protected (${protectedReceipt.reasonCode}) and examines through the humanoid-droid preview`);

    // Canonical east is KeyD/right. Re-read authority position after every
    // measured pulse so this cannot pass by blind timing or renderer motion.
    const startPosition = (await s.probe()).authorityPlayer;
    s.assert(startPosition, "authority player position missing before terminal approach");
    const approach = await approachTerminal(ctx, s);
    s.assert(
      exactTerminalInteraction(approach.probe),
      `failed to reach exact Dustgate terminal interaction: position=${JSON.stringify(approach.probe?.authorityPlayer ?? null)} pulses=${JSON.stringify(approach.keyPulses)} stalls=${approach.stalls} moveGate=${JSON.stringify(approach.probe?.moveGate ?? null)}`,
    );
    const terminalReady = await s.waitProbe(
      (probe) => Boolean(exactTerminalInteraction(probe))
        && probe.authorityPlayer !== null
        && probe.travelTerminalScreen !== null,
      { label: "Dustgate terminal interaction and animated screen ready", timeoutMs: 10000 },
    );
    const terminalInteraction = exactTerminalInteraction(terminalReady);
    s.assert(terminalInteraction?.targetId === TERMINAL_ID, `wrong travel anchor: ${JSON.stringify(terminalInteraction ?? null)}`);
    const eastDx = terminalReady.authorityPlayer.x - startPosition.x;
    const eastDy = terminalReady.authorityPlayer.y - startPosition.y;
    s.assert(
      approach.keyPulses.KeyD > 0 && eastDx > 1,
      `KeyD/east did not increase world x: delta=(${eastDx}, ${eastDy}) pulses=${JSON.stringify(approach.keyPulses)}`,
    );
    s.assert(
      Math.abs(eastDy) <= Math.abs(eastDx) * 0.2 + 0.5,
      `east/right approach drifted off the world x axis: delta=(${eastDx}, ${eastDy})`,
    );
    ctx.note(`authority approach delta=(${eastDx.toFixed(2)},${eastDy.toFixed(2)}) pulses=${JSON.stringify(approach.keyPulses)}`);

    const readyScreen = terminalReady.travelTerminalScreen;
    s.assert(readyScreen.node === "Module_screen", `wrong animated screen node: ${readyScreen.node}`);
    s.assert(readyScreen.exactNodeMatches === 1, `expected one exact Module_screen node, got ${readyScreen.exactNodeMatches}`);
    s.assert(readyScreen.descendantMeshMatches === 1, `expected one animated screen mesh, got ${readyScreen.descendantMeshMatches}`);
    s.assert(readyScreen.activeInstanceCount >= 1, `no active terminal screen placement: ${JSON.stringify(readyScreen)}`);

    // Zoom the ordinary play camera for a reviewable frame. The live travel
    // chip must remain above the fitted kiosk crown, not cover Module_screen.
    const canvasBox = await s.page.locator("canvas.successor3d-canvas").boundingBox();
    s.assert(canvasBox, "game canvas missing while framing terminal proof");
    await s.page.mouse.move(canvasBox.x + canvasBox.width * 0.62, canvasBox.y + canvasBox.height * 0.58);
    for (let notch = 0; notch < 8; notch += 1) await s.page.mouse.wheel(0, -100);
    const framedTerminal = await s.waitProbe(
      (probe) => probe.zoomPercent === 140
        && probe.travelTerminalScreen !== null,
      { label: "terminal screen at review zoom", timeoutMs: 10000 },
    );
    const travelChip = await s.waitProbeCall(
      () => s.evalExpr("window.__successor3dInteractChip"),
      (value) => value?.verb === "TRAVEL"
        && value?.anchor?.height === 2.05
        && value?.screen !== null,
      { label: "travel chip anchored above kiosk crown", timeoutMs: 8000 },
    );
    s.assert(travelChip.anchor.height > 1.9, `travel chip occludes kiosk: ${JSON.stringify(travelChip)}`);
    await s.page.waitForTimeout(700);
    const terminalScreenA = framedTerminal.travelTerminalScreen;
    await ctx.moneyShot("02-wedge-terminal-a");

    const terminalScreenBProbe = await s.waitProbe(
      (probe) => {
        const animated = probe.travelTerminalScreen;
        if (!animated || animated.elapsedSeconds <= terminalScreenA.elapsedSeconds + 0.2) return false;
        const rawUvDelta = Math.abs(animated.offsetY - terminalScreenA.offsetY);
        const wrappedUvDelta = Math.min(rawUvDelta, 1 - rawUvDelta);
        return wrappedUvDelta > 0.02 && Math.abs(animated.brightness - terminalScreenA.brightness) > 0.01;
      },
      { label: "terminal UV scroll and pulse advance", timeoutMs: 5000, intervalMs: 100 },
    );
    const terminalScreenB = terminalScreenBProbe.travelTerminalScreen;
    s.assert(terminalScreenB.exactNodeMatches === 1, "terminal screen node count changed after animation");
    await ctx.moneyShot("03-wedge-terminal-b");

    // Network loads are secondary evidence; the live renderer probe above is
    // what proves that the fetched screen was matched and animated in-scene.
    const loadedResources = await s.evalExpr(
      "performance.getEntriesByType('resource').map((entry) => new URL(entry.name).pathname)",
    );
    const terminalResourceEntries = loadedResources.filter((path) => path.includes("travel_terminal_grok_wedge"));
    ctx.note(`resource timing entries (secondary): ${terminalResourceEntries.length > 0 ? terminalResourceEntries.join(", ") : "not retained by browser"}`);

    await s.press("KeyF");
    await s.waitDom('.sc3d-window[data-window="travel"]', { state: "visible", timeoutMs: 6000 });
    ctx.note("GR0K rendered idle/examinable; east/right reached the wedge terminal and opened its authority travel surface");
  },
};
