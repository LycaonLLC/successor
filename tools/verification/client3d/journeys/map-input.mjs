// Headed journey: radar target selection/click movement plus orbital map input.
// Every gameplay mutation below comes from visible canvas/DOM input. Probes are
// read-only evidence for contact coordinates, actor cells, receipts, and the
// final clean waypoint state.
import { waitAuthorityStationary } from "./camp.mjs";

const MAP = '.sc3d-window[data-window="datapad"]';
const RADIAL = '.sc3d-radial:not([hidden])';
const RADAR_RADIUS_CELLS = 96;
const MAP_WORLD_SIZE = 1024;

function distance(a, b) {
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}

function authorityPosition(probe) {
  return probe?.authorityPlayer ?? null;
}

function isMovementReceipt(entry) {
  return (entry?.kind === "Move" || entry?.kind === "SetMoveIntent") && entry.accepted === true;
}

async function waitAcceptedMovement(s, before, label) {
  const known = new Set((before?.authorityReceiptTail ?? []).map((entry) => entry.commandId));
  const probe = await s.waitProbe(
    (candidate) => (candidate.authorityReceiptTail ?? []).some(
      (entry) => !known.has(entry.commandId) && isMovementReceipt(entry),
    ),
    { label: `${label} accepted authority movement receipt`, timeoutMs: 15000, intervalMs: 100 },
  );
  return probe.authorityReceiptTail.find(
    (entry) => !known.has(entry.commandId) && isMovementReceipt(entry),
  );
}

async function waitDisplacement(s, before, label, minimum = 1.5) {
  return s.waitProbe(
    (probe) => distance(authorityPosition(probe), authorityPosition(before)) >= minimum,
    { label: `${label} authority displacement`, timeoutMs: 20000, intervalMs: 100 },
  );
}

async function mapReady(s, waitForImagery = true) {
  await s.press("KeyP");
  await s.waitDom(MAP, { state: "visible", timeoutMs: 8000 });
  await s.page.waitForFunction(
    (requireImagery) => {
      const map = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map');
      const canvas = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map-canvas');
      const sub = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map-sub');
      const isOrbital = map?.getAttribute("data-mode") === "orbital";
      const hasGeometry = canvas instanceof HTMLCanvasElement && canvas.getBoundingClientRect().width > 0;
      const imageryReady = !requireImagery || !sub?.textContent?.includes("ACQUIRING IMAGERY");
      return isOrbital && hasGeometry && imageryReady;
    },
    waitForImagery,
    { timeout: 30000 },
  );
}
/** Read-only map geometry: orbital is a north-up contain fit of the 1024 map. */
async function orbitalPointFromCell(s, offsetX, offsetY) {
  return s.page.evaluate(({ offsetX: dx, offsetY: dy }) => {
    const probe = window.__successor3d;
    const cell = probe?.playerCell;
    const canvas = document.querySelector('.sc3d-window[data-window="datapad"] .scp-map-canvas');
    if (!cell || !(canvas instanceof HTMLCanvasElement)) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const target = {
      x: Math.min(1023, Math.max(1, Math.round(cell.x) + dx)),
      y: Math.min(1023, Math.max(1, Math.round(cell.y) + dy)),
    };
    // Orbital projection is north-up, contain-fit, and the world is square.
    // Pointer events scale this CSS point back into the backing canvas.
    return {
      cell,
      target,
      x: rect.left + ((target.x + 0.5) / 1024) * rect.width,
      y: rect.top + ((target.y + 0.5) / 1024) * rect.height,
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }, { offsetX, offsetY });
}

/**
 * Trusted orbital double-click with explicit click count/delay pacing.
 * Playwright browser mouse input remains fully trusted. Under low-FPS software GL
 * rendering, explicit pacing between clickCount 1 and clickCount 2 ensures the canvas
 * receives a reliable browser double-click event.
 */
async function dblclickPoint(s, x, y) {
  await s.page.mouse.move(x, y);
  await s.page.mouse.down({ clickCount: 1 });
  await s.page.mouse.up({ clickCount: 1 });
  await s.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
  await s.page.mouse.down({ clickCount: 2 });
  await s.page.mouse.up({ clickCount: 2 });
}

async function radialText(s) {
  return s.page.locator(RADIAL).innerText().catch(() => "");
}

async function storedWaypoints(s) {
  return s.page.evaluate(() => {
    const rows = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith("successor3d.waypoints.")) continue;
      try {
        const payload = JSON.parse(localStorage.getItem(key) ?? "null");
        if (Array.isArray(payload?.waypoints)) rows.push(...payload.waypoints);
      } catch {
        // A malformed unrelated local row is not a waypoint.
      }
    }
    return rows;
  });
}

export default {
  id: "map-input",
  title: "Radar and Orbital Map Input (headed)",
  headed: true,
  timeoutMs: 150000,
  characters: [{
    role: "primary",
    id: "h3d-map-input",
    name: "MapInput",
    x: 520,
    y: 512,
    initialProfessionId: "marksman",
  }],

  async run(ctx) {
    const s = ctx.primary;
    const spawn = await s.waitProbe(
      (probe) => probe.serverStatus === "connected" && probe.authorityPlayer && probe.playerCell,
      { label: "fresh populated-world spawn", timeoutMs: 30000 },
    );
    s.assert(spawn.authorityPlayer.areaId === "open-desert-overworld", `unexpected spawn area: ${spawn.authorityPlayer.areaId}`);
    // Real-browser acceptance for the CSS hit region: the canvas still owns the
    // square layout box, but a transparent corner must resolve to the world
    // surface beneath it rather than swallowing viewport input.
    const radarCorner = await s.page.evaluate(() => {
      const canvas = document.querySelector(".sc3d-radar-scope");
      if (!(canvas instanceof HTMLCanvasElement)) return null;
      const rect = canvas.getBoundingClientRect();
      const x = rect.left + 3;
      const y = rect.top + 3;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        hitClass: hit instanceof HTMLElement ? hit.className : null,
        passesThrough: hit !== canvas,
      };
    });
    s.assert(radarCorner?.passesThrough, `radar transparent corner still captured input: ${JSON.stringify(radarCorner)}`);
    ctx.note(`radar circular hit region passed through square corner to ${radarCorner.hitClass || "world surface"}`);
    await ctx.moneyShot("00-spawn-populated");

    // A real contact dot is selected from the read-only radar coordinate. Prefer
    // the authored camp actor; fall back to the first streamed contact only if
    // the population packet arrives in a different order.
    const radarContact = await s.waitProbeCall(
      () => s.probe("__successor3dRadar"),
      (radar) => (radar?.contacts ?? []).some((contact) => contact.id === "grok") || (radar?.contacts ?? []).length > 0,
      { label: "populated radar contact", timeoutMs: 15000, intervalMs: 100 },
    );
    const contact = radarContact.contacts.find((entry) => entry.id === "grok") ?? radarContact.contacts[0];
    s.assert(contact?.id && Number.isFinite(contact.xCells) && Number.isFinite(contact.yCells), `radar contact had no usable plot: ${JSON.stringify(contact)}`);
    const contactPoint = await s.page.evaluate(({ xCells, yCells, radius }) => {
      const canvas = document.querySelector(".sc3d-radar-scope");
      const radar = window.__successor3dRadar;
      if (!(canvas instanceof HTMLCanvasElement) || !radar) return null;
      const rect = canvas.getBoundingClientRect();
      const center = rect.width / 2;
      const scale = (center - 7) / radius;
      return { x: rect.left + center + xCells * scale, y: rect.top + center + yCells * scale };
    }, { xCells: contact.xCells, yCells: contact.yCells, radius: RADAR_RADIUS_CELLS });
    s.assert(contactPoint, "radar canvas geometry unavailable");
    await s.page.mouse.click(contactPoint.x, contactPoint.y);
    const selected = await s.waitProbe(
      (probe) => String(probe.selectedActorId) === String(contact.id),
      { label: `radar selected ${contact.id}`, timeoutMs: 6000, intervalMs: 100 },
    );
    s.assert(selected.selectedActorId === contact.id, `radar selected ${selected.selectedActorId}, expected ${contact.id}`);
    ctx.note(`radar contact ${contact.id} plotted at (${contact.xCells},${contact.yCells}) and selectedActorId latched`);
    await ctx.moneyShot("01-radar-selected");

    // Click open radar ground, away from every plotted contact, then prove a
    // real accepted movement receipt and authority displacement.
    const radarBeforeMove = await s.probe();
    const groundPoint = await s.page.evaluate(() => {
      const canvas = document.querySelector(".sc3d-radar-scope");
      const radar = window.__successor3dRadar;
      if (!(canvas instanceof HTMLCanvasElement) || !radar) return null;
      const rect = canvas.getBoundingClientRect();
      const center = rect.width / 2;
      const scale = (center - 7) / 96;
      const contacts = (radar.contacts ?? []).map((entry) => ({
        x: center + entry.xCells * scale,
        y: center + entry.yCells * scale,
      }));
      let best = null;
      const radius = (center - 8) * 0.62;
      for (let index = 0; index < 16; index += 1) {
        const angle = (Math.PI * 2 * index) / 16;
        const localX = center + Math.cos(angle) * radius;
        const localY = center + Math.sin(angle) * radius;
        const clearance = contacts.reduce(
          (nearest, entry) => Math.min(nearest, Math.hypot(localX - entry.x, localY - entry.y)),
          Number.POSITIVE_INFINITY,
        );
        if (!best || clearance > best.clearance) best = { localX, localY, clearance };
      }
      return best && {
        x: rect.left + best.localX,
        y: rect.top + best.localY,
        clearance: best.clearance,
      };
    });
    s.assert(groundPoint && groundPoint.clearance > 12, `no open radar ground point cleared actor-dot priority: ${JSON.stringify(groundPoint)}`);
    s.assert(groundPoint, "radar ground geometry unavailable");
    await s.page.mouse.click(groundPoint.x, groundPoint.y);
    const radarReceipt = await waitAcceptedMovement(s, radarBeforeMove, "radar ground click");
    const radarAfterMove = await waitDisplacement(s, radarBeforeMove, "radar ground click", 0.75);
    const radarDelta = distance(authorityPosition(radarAfterMove), authorityPosition(radarBeforeMove));
    ctx.note(`radar ground movement receipt=${radarReceipt.kind}#${radarReceipt.commandId} delta=${radarDelta.toFixed(2)} cells`);
    await ctx.moneyShot("02-radar-ground-moved");

    // Causal phase boundary: cancel/settle the still-active radar click route
    // with real WASD before baselining orbital map input. Otherwise a low-FPS
    // retarget can fight the long radar intent and stall under the 1.5-cell gate.
    const radarHeading = {
      x: authorityPosition(radarAfterMove).x - authorityPosition(radarBeforeMove).x,
      y: authorityPosition(radarAfterMove).y - authorityPosition(radarBeforeMove).y,
    };
    const cancelKeys = [];
    // Nudge opposite the radar displacement when known; otherwise a short KeyD
    // pulse is enough to supersede the outstanding click route.
    if (Math.hypot(radarHeading.x, radarHeading.y) >= 0.2) {
      if (radarHeading.y > 0.15) cancelKeys.push("KeyW");
      else if (radarHeading.y < -0.15) cancelKeys.push("KeyS");
      if (radarHeading.x > 0.15) cancelKeys.push("KeyA");
      else if (radarHeading.x < -0.15) cancelKeys.push("KeyD");
    }
    if (cancelKeys.length === 0) cancelKeys.push("KeyD");
    await s.hold(cancelKeys, 260);
    await s.releaseAll();
    const settledAfterRadar = await waitAuthorityStationary(ctx, s, {
      timeoutMs: 12000,
      quietMs: 700,
    });
    s.assert(settledAfterRadar, "authority never settled after radar-route cancel pulse");
    ctx.note(
      `radar route cancelled and settled at (${Number(settledAfterRadar.x).toFixed(3)},${Number(settledAfterRadar.y).toFixed(3)}) before orbital baseline`,
    );

    // Open the real datapad, compute a deterministic clear first orbital target
    // east in open terrain (+24,0 from current cell), and double-click it through
    // the visible canvas. Wait for accepted movement and authority displacement
    // BEFORE Escape — closing the focused datapad immediately can race the
    // just-issued click route under software-GL load.
    await mapReady(s);
    const orbitalTarget = await orbitalPointFromCell(s, 24, 0);
    s.assert(orbitalTarget, "orbital map point unavailable");
    const mapBeforeMove = await s.probe();
    await dblclickPoint(s, orbitalTarget.x, orbitalTarget.y);
    await ctx.moneyShot("03-orbital-destination");
    const mapReceipt = await waitAcceptedMovement(s, mapBeforeMove, "orbital double-click");
    const mapAfterMove = await waitDisplacement(s, mapBeforeMove, "orbital double-click", 1.5);
    const mapDelta = distance(authorityPosition(mapAfterMove), authorityPosition(mapBeforeMove));
    ctx.note(`orbital double-click target=${JSON.stringify(orbitalTarget.target)} receipt=${mapReceipt.kind}#${mapReceipt.commandId} delta=${mapDelta.toFixed(2)} cells`);

    // Retarget movement via second ordinary orbital map double-click to a nearby already-cleared
    // cell opposite the first displacement so routing reaches a short destination naturally.
    const firstMotion = {
      x: authorityPosition(mapAfterMove).x - authorityPosition(mapBeforeMove).x,
      y: authorityPosition(mapAfterMove).y - authorityPosition(mapBeforeMove).y,
    };
    const retargetPoint = await orbitalPointFromCell(
      s,
      firstMotion.x >= 0 ? -1 : 1,
      firstMotion.y >= 0 ? -1 : 1,
    );
    s.assert(retargetPoint, "retarget orbital map point unavailable");

    const mapBeforeRetarget = await s.probe();
    await dblclickPoint(s, retargetPoint.x, retargetPoint.y);
    const retargetReceipt = await waitAcceptedMovement(s, mapBeforeRetarget, "orbital retarget double-click");
    ctx.note(`orbital retarget double-click target=${JSON.stringify(retargetPoint.target)} receipt=${retargetReceipt.kind}#${retargetReceipt.commandId}`);

    // Require moveGate queues drained, latest sent move acknowledged, and position quiet for >=700ms (<=0.01 cells).
    await s.waitProbe(
      (probe) => {
        const moveGate = probe?.moveGate ?? null;
        const pendingMoves = Number(moveGate?.pendingMoves);
        const inFlightMoves = Number(moveGate?.inFlightMoves);
        const latestSentMove = Array.isArray(moveGate?.sentMoveTail) ? moveGate.sentMoveTail.at(-1) ?? null : null;
        const latestSentReceipt = latestSentMove && Array.isArray(moveGate?.receiptTail)
          ? [...moveGate.receiptTail].reverse().find((r) => r.commandId === latestSentMove.commandId) ?? null
          : null;
        const latestVisibleMoveSettled = !latestSentMove || latestSentReceipt?.accepted === true;
        return moveGate?.moving === false
          && pendingMoves === 0
          && inFlightMoves === 0
          && moveGate?.sendGateStalled !== true
          && latestVisibleMoveSettled;
      },
      { label: "moveGate drained and settled", timeoutMs: 8000, intervalMs: 100 },
    );

    let quietAnchor = null;
    let quietStart = null;
    const quietProbe = await s.waitProbe(
      (probe) => {
        const pos = authorityPosition(probe);
        if (!pos) return false;
        if (!quietAnchor || distance(pos, quietAnchor) > 0.01) {
          quietAnchor = { x: pos.x, y: pos.y };
          quietStart = Date.now();
          return false;
        }
        return quietStart !== null && (Date.now() - quietStart >= 700);
      },
      { label: "authoritative position quiet >=700ms", timeoutMs: 8000, intervalMs: 50 },
    );

    const finalPos = authorityPosition(quietProbe);
    ctx.note(`orbital retarget receipt=${retargetReceipt.kind}#${retargetReceipt.commandId} stationary at (${finalPos.x.toFixed(2)},${finalPos.y.toFixed(2)})`);

    await s.press("Escape");
    await s.assertDom(MAP, { visible: false }, "datapad did not close after orbital route");

    // Reopen orbital map and exercise the map-ground radial through visible
    // right-click + button clicks. The point is retained exactly for marker
    // hit-testing, so the rendered waypoint is challenged at its own canvas px.
    await mapReady(s, false);
    const baselineWaypoints = await storedWaypoints(s);
    const baselineWaypointIds = new Set(baselineWaypoints.map((waypoint) => waypoint.id));

    // Choose a deterministic empty-ground target that is sufficiently clear of every baseline waypoint
    // so right-clicking opens the ground radial (CREATE WAYPOINT) rather than grabbing an existing marker.
    const candidates = [
      [8, 10], [-8, 10], [8, -10], [-8, -10],
      [16, 20], [-16, 20], [16, -20], [-16, -20],
      [32, 40], [-32, 40], [32, -40], [-32, -40],
      [64, 80], [-64, 80], [64, -80], [-64, -80],
      [96, 96], [-96, 96], [96, -96], [-96, -96],
    ];

    let waypointPoint = null;
    for (const [dx, dy] of candidates) {
      const point = await orbitalPointFromCell(s, dx, dy);
      if (!point || !point.rect?.width) continue;
      const grabCells = (12 * 1024 / point.rect.width) + 2.0; // MAP_WAYPOINT_GRAB_PX (12px) in world cells + safety margin
      const safe = baselineWaypoints.every((bw) => {
        const areaMatch = !bw.areaId || bw.areaId === "open-desert-overworld";
        if (!areaMatch) return true;
        if (!Number.isFinite(bw.x) || !Number.isFinite(bw.y)) return false; // Fail closed on malformed same-area coords
        return Math.hypot(point.target.x - bw.x, point.target.y - bw.y) > grabCells;
      });
      if (safe) {
        waypointPoint = point;
        break;
      }
    }
    s.assert(waypointPoint, "safe empty-ground waypoint map point unavailable");
    await s.page.mouse.click(waypointPoint.x, waypointPoint.y, { button: "right" });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="move"]`, { state: "visible", timeoutMs: 8000 });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="waypoint"]`, { state: "visible", timeoutMs: 8000 });
    const groundRadial = await radialText(s);
    s.assert(groundRadial.includes("MOVE HERE") && groundRadial.includes("CREATE WAYPOINT"), `map ground radial lacked actions: ${groundRadial}`);
    await ctx.moneyShot("04-map-ground-radial");
    await s.click(`${RADIAL} .sc3d-radial-item[data-action="waypoint"]`);
    await s.assertDom(RADIAL, { visible: false }, "map waypoint radial did not close");

    const created = await s.waitProbeCall(
      () => storedWaypoints(s),
      (rows) => rows.length === baselineWaypoints.length + 1
        && rows.some((waypoint) => !baselineWaypointIds.has(waypoint.id)),
      { label: "visible map waypoint persisted", timeoutMs: 8000, intervalMs: 100 },
    );
    const waypoint = created.find((row) => !baselineWaypointIds.has(row.id));
    s.assert(waypoint?.id, `map waypoint did not appear in read-only persisted state: ${JSON.stringify(created)}`);
    s.assert(waypoint.active === false, `new waypoint should start dormant: ${JSON.stringify(waypoint)}`);
    ctx.note(`created dormant waypoint ${waypoint.id} at map cell ${JSON.stringify(waypointPoint.target)} with ${baselineWaypoints.length} baseline waypoint(s) preserved`);
    await ctx.moneyShot("05-waypoint-created");

    // New waypoints are deliberately dormant. Exercise the full visible
    // lifecycle at the rendered marker: activate, deactivate, reactivate,
    // then delete. The radar probe intentionally exposes active waypoints only,
    // so persisted state proves dormancy while probe presence proves activity.
    await s.page.mouse.click(waypointPoint.x, waypointPoint.y, { button: "right" });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`, { state: "visible", timeoutMs: 8000 });
    const initialActivateText = await radialText(s);
    s.assert(initialActivateText.includes("ACTIVATE") && initialActivateText.includes("DELETE WAYPOINT"), `dormant marker radial lacked activate/delete: ${initialActivateText}`);
    await s.click(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`);
    await s.waitProbeCall(
      () => s.probe("__successor3dRadar"),
      (radar) => (radar?.waypoints ?? []).some((entry) => entry.id === waypoint.id),
      { label: "waypoint activated", timeoutMs: 5000, intervalMs: 100 },
    );
    await ctx.moneyShot("06-waypoint-activated");

    await s.page.mouse.click(waypointPoint.x, waypointPoint.y, { button: "right" });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`, { state: "visible", timeoutMs: 8000 });
    const deactivateText = await radialText(s);
    s.assert(deactivateText.includes("DEACTIVATE") && deactivateText.includes("DELETE WAYPOINT"), `active marker radial lacked deactivate/delete: ${deactivateText}`);
    await s.click(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`);
    await s.waitProbeCall(
      () => s.probe("__successor3dRadar"),
      (radar) => !(radar?.waypoints ?? []).some((entry) => entry.id === waypoint.id),
      { label: "waypoint deactivated", timeoutMs: 5000, intervalMs: 100 },
    );
    await ctx.moneyShot("07-waypoint-deactivated");

    await s.page.mouse.click(waypointPoint.x, waypointPoint.y, { button: "right" });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`, { state: "visible", timeoutMs: 8000 });
    const activateText = await radialText(s);
    s.assert(activateText.includes("ACTIVATE"), `inactive marker radial lacked activate: ${activateText}`);
    await s.click(`${RADIAL} .sc3d-radial-item[data-action="toggle"]`);
    await s.waitProbeCall(
      () => s.probe("__successor3dRadar"),
      (radar) => (radar?.waypoints ?? []).some((entry) => entry.id === waypoint.id),
      { label: "waypoint reactivated", timeoutMs: 5000, intervalMs: 100 },
    );
    await ctx.moneyShot("08-waypoint-reactivated");

    await s.page.mouse.click(waypointPoint.x, waypointPoint.y, { button: "right" });
    await s.waitDom(`${RADIAL} .sc3d-radial-item[data-action="delete"]`, { state: "visible", timeoutMs: 8000 });
    await s.click(`${RADIAL} .sc3d-radial-item[data-action="delete"]`);
    const clean = await s.waitProbeCall(
      async () => ({
        radar: await s.probe("__successor3dRadar"),
        persisted: await storedWaypoints(s),
      }),
      (candidate) => !(candidate.radar?.waypoints ?? []).some((entry) => entry.id === waypoint.id)
        && candidate.persisted.length === baselineWaypoints.length
        && candidate.persisted.every((entry) => baselineWaypointIds.has(entry.id)),
      { label: "waypoint deleted cleanly", timeoutMs: 8000, intervalMs: 100 },
    );
    s.assert(!(clean.radar?.waypoints ?? []).some((entry) => entry.id === waypoint.id), `created radar waypoint survived deletion: ${JSON.stringify(clean.radar?.waypoints)}`);
    s.assert(
      clean.persisted.length === baselineWaypoints.length
        && clean.persisted.every((entry) => baselineWaypointIds.has(entry.id)),
      `persisted baseline waypoints changed: ${JSON.stringify(clean.persisted)}`,
    );
    ctx.note(`waypoint actions: CREATE WAYPOINT (dormant) -> ACTIVATE -> DEACTIVATE -> ACTIVATE -> DELETE WAYPOINT; ${baselineWaypoints.length} baseline waypoint(s) restored`);
    await ctx.moneyShot("09-waypoint-deleted-clean");
  },
};
