import type { PlayState, ServerAuthorityActorState, ServerAuthorityAiAttitude, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { northUpScreenVectorFromWorld, worldVectorFromNorthUpScreen } from "@successor/client/src/slice-core/geometry";
import { setClickMoveTarget } from "@successor/client/src/slice-core/movementSystem";
import { setSelectedTarget } from "@successor/client/src/slice-core/targetSelectionSystem";
import { canIssueGroundMove, clearEngagementFocusForGroundMove } from "../../boot/groundMove";
import { isLockableHostile, setExplicitLockTarget } from "../../combat/softLock";
import { waypointStoreVersion, waypoints } from "../waypoints/store";

/**
 * RADAR — top-right tactical scope, v2 (owner brief 2026-07-07: "more hifi —
 * sleek and minimal but missing something the other elements have" + "see
 * what an NPC is when hovering on the dot").
 *
 * What the other HUD elements have that v1 lacked: the glass-plate chrome
 * (header microlabel, hairline frame, data-row footer), material depth, and
 * the steps()-flavored mechanical motion. v2 is built from that vocabulary:
 *
 *   base layer (static)   — brushed scope face: radial depth, polar grid,
 *                           cardinal ticks, scanlines, vignette.
 *   plot layer (diff-gated)— contact dots: hostile red w/ glow, alerted amber,
 *                           civilian dim; rim-clamped = hollow (bearing-true);
 *                           waypoint dots/chevrons; the accent self-dot.
 *   anim layer (rAF)      — rotating sweep wedge, contact afterglow as the
 *                           beam passes, new-contact entry pings, hover ring.
 *
 * Pointer input: the scope canvas alone takes pointer events. Hover ring +
 * glass tooltip name the nearest contact within the grab radius. LEFT CLICK
 * on a dot selects that actor (world target-selection rules); left click on
 * open scope inverts the north-up basis back to a raw world cell and sets
 * the click-move destination — the radar is a tap-to-travel surface.
 *
 * Coordinates readout underneath (north-up world grid reference). Contact plot
 * redraws only when the quantized scene signature changes, exactly like v1.
 */
export interface RadarController {
  dispose: () => void;
}

export const RADIUS_CELLS = 96;
const SIZE_PX = 156;
const SWEEP_PERIOD_MS = 6500;
const PING_MS = 620;
const HOVER_GRAB_PX = 9;
/** Click grab radius — a touch wider than hover so dots stay small but stay
 * clickable; ground clicks win only outside this ring (dot priority). */
export const CLICK_GRAB_PX = 11;
/** Visible instrument circle radius (px) — the rim stroke drawn by
 * drawScopeFace/drawAnim. The canvas is square but the scope is a circle:
 * pointer geometry outside this circle belongs to the world, not the radar
 * (hud.css clips hit-testing to the same circle so the transparent corner
 * pixels fall through the pane in real browsers). */
export const SCOPE_RIM_PX = SIZE_PX / 2 - 1.5;

/** True when a canvas-local point lies inside the visible scope circle. */
export function radarPointInScope(
  x: number,
  y: number,
  center: number = SIZE_PX / 2,
  rimPx: number = SCOPE_RIM_PX,
): boolean {
  const dx = x - center;
  const dy = y - center;
  return dx * dx + dy * dy <= rimPx * rimPx;
}

export type RadarContactClass = "hostile" | "passive" | "civilian";
export type RadarContactAttitude = ServerAuthorityAiAttitude | null | undefined;

export interface ClassifiedRadarContact {
  dCells: number;
  /** North-up east/west offset in cells; +x is screen-right. */
  xCells: number;
  /** North-up north/south offset in cells; negative y is screen-up/north. */
  yCells: number;
  clazz: RadarContactClass;
  rimClamped: boolean;
}

export interface ClassifiedRadarWaypoint {
  dCells: number;
  /** North-up east/west offset in cells; +x is screen-right. */
  xCells: number;
  /** North-up north/south offset in cells; negative y is screen-up/north. */
  yCells: number;
  rimClamped: boolean;
}

interface RadarDrawContact extends ClassifiedRadarContact {
  id: string;
  label: string;
}

interface RadarDrawWaypoint extends ClassifiedRadarWaypoint {
  id: string;
}

export interface RadarProbeContact {
  id: string;
  dCells: number;
  /** North-up screen offset, used by dev/E2E probes. */
  xCells: number;
  yCells: number;
  clazz: RadarContactClass;
  rimClamped: boolean;
}

export interface RadarProbeWaypoint {
  id: string;
  dCells: number;
  /** North-up screen offset, used by dev/E2E probes. */
  xCells: number;
  yCells: number;
  rimClamped: boolean;
}

export interface RadarDebugProbe {
  radiusCells: number;
  contacts: RadarProbeContact[];
  waypoints: RadarProbeWaypoint[];
  /** Hovered contact id (dev assertions for the tooltip path). */
  hoverId: string | null;
}

declare global {
  interface Window {
    __successor3dRadar?: RadarDebugProbe;
  }
}

const CLASS_LABEL: Record<RadarContactClass, string> = {
  hostile: "HOSTILE",
  passive: "ALERT",
  civilian: "CIV",
};

export type RadarClickAction =
  | { kind: "select"; actorId: string }
  | { kind: "move"; dxCells: number; dyCells: number };

/**
 * Resolve a scope click (canvas-local px). Dot hit takes priority: the
 * nearest contact within CLICK_GRAB_PX selects that actor. Otherwise the
 * point inverts through the shared north-up radar basis back to a raw world
 * cell offset from the player. Clicks beyond the scope rim resolve to null.
 */
export function radarClickAction(
  contacts: readonly Pick<RadarProbeContact, "id" | "xCells" | "yCells">[],
  clickX: number,
  clickY: number,
  center: number = SIZE_PX / 2,
  scale: number = (SIZE_PX / 2 - 7) / RADIUS_CELLS,
): RadarClickAction | null {
  let bestId: string | null = null;
  let bestDistSq = CLICK_GRAB_PX * CLICK_GRAB_PX;
  for (const contact of contacts) {
    const dx = clickX - (center + contact.xCells * scale);
    const dy = clickY - (center + contact.yCells * scale);
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      bestId = contact.id;
    }
  }
  if (bestId !== null) return { kind: "select", actorId: bestId };
  const world = worldVectorFromNorthUpScreen((clickX - center) / scale, (clickY - center) / scale);
  if (Math.hypot(world.x, world.y) > RADIUS_CELLS) return null;
  return { kind: "move", dxCells: world.x, dyCells: world.y };
}

export function mountRadar(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
): RadarController {
  const pane = document.createElement("aside");
  pane.className = "sc3d-radar";
  pane.setAttribute("aria-label", "Radar");
  pane.innerHTML = `
    <div class="sc3d-radar-head">
      <span class="sc3d-radar-title">RADAR</span>
      <span class="sc3d-radar-range">${RADIUS_CELLS}c</span>
    </div>
    <div class="sc3d-radar-scope-wrap" data-ref="wrap">
      <canvas class="sc3d-radar-layer" data-ref="base" aria-hidden="true"></canvas>
      <canvas class="sc3d-radar-layer" data-ref="plot" aria-hidden="true"></canvas>
      <canvas class="sc3d-radar-layer sc3d-radar-scope" data-ref="anim" role="img" aria-label="Radar scope"></canvas>
      <div class="sc3d-radar-tip" data-ref="tip" hidden></div>
    </div>
    <div class="sc3d-radar-coords" data-ref="coords">—</div>
  `;
  shell.appendChild(pane);
  const wrap = pane.querySelector<HTMLElement>('[data-ref="wrap"]')!;
  const baseCanvas = pane.querySelector<HTMLCanvasElement>('[data-ref="base"]')!;
  const plotCanvas = pane.querySelector<HTMLCanvasElement>('[data-ref="plot"]')!;
  const animCanvas = pane.querySelector<HTMLCanvasElement>('[data-ref="anim"]')!;
  const tipEl = pane.querySelector<HTMLElement>('[data-ref="tip"]')!;
  const coordsEl = pane.querySelector<HTMLElement>('[data-ref="coords"]')!;

  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  for (const canvas of [baseCanvas, plotCanvas, animCanvas]) {
    canvas.width = Math.round(SIZE_PX * dpr);
    canvas.height = Math.round(SIZE_PX * dpr);
    canvas.style.width = `${SIZE_PX}px`;
    canvas.style.height = `${SIZE_PX}px`;
  }
  const baseCtx = baseCanvas.getContext("2d");
  const plotCtx = plotCanvas.getContext("2d");
  const animCtx = animCanvas.getContext("2d");

  const styles = getComputedStyle(pane);
  const tone = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : fallback;
  };
  const palette = {
    accent: tone("--sc3d-accent", "#48d6e6"),
    accentGlow: tone("--sc3d-accent-glow", "rgba(72,214,230,0.45)"),
    danger: tone("--sc3d-danger", "#e34a4a"),
    amber: "rgba(241, 208, 107, 0.95)",
    dim: tone("--sc3d-ink-dim", "#5f818c"),
    ink: tone("--sc3d-ink", "#cfe9ef"),
  };

  const c = SIZE_PX / 2;
  const scale = (c - 7) / RADIUS_CELLS;

  if (baseCtx) drawScopeFace(baseCtx, dpr, palette);

  // ── per-frame state ───────────────────────────────────────────────────────
  const applied = { signature: "", coords: "" };
  const drawContacts: RadarDrawContact[] = [];
  const drawWaypoints: RadarDrawWaypoint[] = [];
  /** Entry pings: contact id -> spawn epoch ms. Swept when expired. */
  const pings = new Map<string, number>();
  const knownIds = new Set<string>();
  let hover: { id: string; label: string; clazz: RadarContactClass; dCells: number; sx: number; sy: number } | null = null;
  let pointer: { x: number; y: number } | null = null;

  const probe: RadarDebugProbe = { radiusCells: RADIUS_CELLS, contacts: [], waypoints: [], hoverId: null };
  window.__successor3dRadar = probe;

  // Hover stays window-level (passive mousemove hit-tests the scope rect);
  // the scope canvas itself now takes pointer events for tap-to-travel and
  // dot selection (hud.css re-enables pointer-events on .sc3d-radar-scope).
  const onMove = (event: MouseEvent): void => {
    const rect = animCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    pointer = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height ? { x, y } : null;
  };
  const onLeave = (): void => {
    pointer = null;
  };
  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("blur", onLeave, { passive: true });

  const onClick = (event: MouseEvent): void => {
    const rect = animCanvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    // The square canvas is only an instrument inside the circle — corner
    // clicks belong to the world beneath (hud.css clip-path already drops
    // them in real browsers; this guard keeps the semantics test-honest).
    if (!radarPointInScope(x, y, c)) return;
    const action = radarClickAction(drawContacts, x, y, c, scale);
    if (!action) return;
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[meId];
    if (action.kind === "select") {
      // Same target-selection grammar as a world click (input.ts): soft-lock
      // only lockable hostiles; trainers/civilians select without a lock.
      const picked = state.serverAuthority.actors[action.actorId];
      const lockable =
        me !== undefined &&
        picked !== undefined &&
        picked.role !== "profession_trainer" &&
        picked.pvpStatus !== "none" &&
        isLockableHostile(picked, me);
      setSelectedTarget(state, action.actorId, lockable);
      setExplicitLockTarget(lockable ? action.actorId : null);
      return;
    }
    // Ground tap = travel there. Same grammar as a world ground click:
    // ignored unless alive, and the tap drops the engagement focus first.
    if (!canIssueGroundMove(state)) return;
    clearEngagementFocusForGroundMove(state);
    const px = me?.x ?? state.player.x;
    const py = me?.y ?? state.player.y;
    setClickMoveTarget(state, px + action.dxCells, py + action.dyCells, me?.areaId ?? state.activeAreaId, performance.now());
  };
  // The scope owns pointer events inside the circle — keep the browser menu
  // off the instrument, but let corner right-clicks pass through untouched.
  const onContextMenu = (event: MouseEvent): void => {
    const rect = animCanvas.getBoundingClientRect();
    if (!radarPointInScope(event.clientX - rect.left, event.clientY - rect.top, c)) return;
    event.preventDefault();
  };
  animCanvas.addEventListener("click", onClick);
  animCanvas.addEventListener("contextmenu", onContextMenu);

  let frameId = 0;
  const epoch = performance.now();
  const frame = (now: number): void => {
    frameId = requestAnimationFrame(frame);
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[meId];
    const px = me?.x ?? state.player.x;
    const py = me?.y ?? state.player.y;

    const coords = worldGridRef(px, py, slice.zone.width, slice.zone.height);
    if (applied.coords !== coords) {
      applied.coords = coords;
      coordsEl.textContent = coords;
    }

    // ── collect + signature (quantized) ─────────────────────────────────────
    const areaId = me?.areaId ?? state.activeAreaId;
    const parts: string[] = [`${Math.round(px * 2)}:${Math.round(py * 2)}:wpv${waypointStoreVersion()}`];
    drawContacts.length = 0;
    drawWaypoints.length = 0;
    const probeContacts: RadarProbeContact[] = [];
    const probeWaypoints: RadarProbeWaypoint[] = [];
    for (const actorId in state.serverAuthority.actors) {
      if (actorId === meId) continue;
      const actor = state.serverAuthority.actors[actorId];
      if (!actor || actor.lifeState !== "alive" || actor.areaId !== areaId) continue;
      const classified = classifyRadarContact(actor.x - px, actor.y - py, radarAttitudeForActor(actor, me));
      if (!classified) continue;
      const qx = Math.round(classified.xCells * 2) / 2;
      const qy = Math.round(classified.yCells * 2) / 2;
      drawContacts.push({
        dCells: classified.dCells,
        xCells: qx,
        yCells: qy,
        clazz: classified.clazz,
        rimClamped: classified.rimClamped,
        id: actorId,
        label: radarContactLabel(actor, actorId),
      });
      probeContacts.push({
        id: actorId,
        dCells: Math.round(classified.dCells * 10) / 10,
        xCells: qx,
        yCells: qy,
        clazz: classified.clazz,
        rimClamped: classified.rimClamped,
      });
      parts.push(`${actorId}:${Math.round(qx * 2)}:${Math.round(qy * 2)}:${classified.clazz}:${classified.rimClamped ? 1 : 0}`);
    }
    for (const waypoint of waypoints()) {
      if (!waypoint.active || waypoint.areaId !== areaId) continue;
      const classified = classifyRadarWaypoint(waypoint.x + 0.5 - px, waypoint.y + 0.5 - py);
      const qx = Math.round(classified.xCells * 2) / 2;
      const qy = Math.round(classified.yCells * 2) / 2;
      drawWaypoints.push({ id: waypoint.id, dCells: classified.dCells, xCells: qx, yCells: qy, rimClamped: classified.rimClamped });
      probeWaypoints.push({ id: waypoint.id, dCells: Math.round(classified.dCells * 10) / 10, xCells: qx, yCells: qy, rimClamped: classified.rimClamped });
      parts.push(`wp:${waypoint.id}:${Math.round(qx * 2)}:${Math.round(qy * 2)}:${classified.rimClamped ? 1 : 0}`);
    }

    // ── entry pings: ids appearing this frame ───────────────────────────────
    for (const contact of drawContacts) {
      if (!knownIds.has(contact.id)) pings.set(contact.id, now);
    }
    knownIds.clear();
    for (const contact of drawContacts) knownIds.add(contact.id);
    for (const [id, at] of pings) {
      if (now - at > PING_MS || !knownIds.has(id)) pings.delete(id);
    }

    probe.radiusCells = RADIUS_CELLS;
    probe.contacts = probeContacts;
    probe.waypoints = probeWaypoints;
    // Re-assert every frame (v1 did too): boot-sequence teardowns can clear
    // the global after a racing mount; the live loop self-heals it.
    window.__successor3dRadar = probe;

    // ── hover hit-test (screen px, nearest within grab radius) ──────────────
    hover = null;
    if (pointer) {
      let bestDistSq = HOVER_GRAB_PX * HOVER_GRAB_PX;
      for (const contact of drawContacts) {
        const sx = c + contact.xCells * scale;
        const sy = c + contact.yCells * scale;
        const dx = pointer.x - sx;
        const dy = pointer.y - sy;
        const distSq = dx * dx + dy * dy;
        if (distSq <= bestDistSq) {
          bestDistSq = distSq;
          hover = { id: contact.id, label: contact.label, clazz: contact.clazz, dCells: contact.dCells, sx, sy };
        }
      }
    }
    probe.hoverId = hover?.id ?? null;
    syncTooltip(tipEl, hover, palette);

    // ── plot layer: diff-gated ──────────────────────────────────────────────
    const signature = parts.join("|");
    if (applied.signature !== signature && plotCtx) {
      applied.signature = signature;
      drawPlot(plotCtx, dpr, drawContacts, drawWaypoints, palette, c, scale);
    }

    // ── anim layer: sweep + afterglow + pings + hover ring ──────────────────
    if (animCtx) {
      drawAnim(animCtx, dpr, drawContacts, palette, c, scale, ((now - epoch) % SWEEP_PERIOD_MS) / SWEEP_PERIOD_MS, pings, now, hover);
    }
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("blur", onLeave);
      animCanvas.removeEventListener("click", onClick);
      animCanvas.removeEventListener("contextmenu", onContextMenu);
      if (window.__successor3dRadar === probe) delete window.__successor3dRadar;
      pane.remove();
    },
  };
}

// ── layers ──────────────────────────────────────────────────────────────────

/** Static scope face: radial depth, polar grid, cardinals, scanlines, vignette. */
function drawScopeFace(ctx: CanvasRenderingContext2D, dpr: number, palette: { accent: string; dim: string }): void {
  const c = SIZE_PX / 2;
  const rim = SCOPE_RIM_PX;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rim, 0, Math.PI * 2);
  ctx.clip();

  // depth: lit center falling to near-black rim
  const depth = ctx.createRadialGradient(c, c - 8, 4, c, c, rim);
  depth.addColorStop(0, "rgba(16, 30, 30, 0.92)");
  depth.addColorStop(0.55, "rgba(9, 17, 17, 0.9)");
  depth.addColorStop(1, "rgba(4, 8, 9, 0.95)");
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, SIZE_PX, SIZE_PX);

  // polar grid: three range rings + eight spokes, whisper-quiet
  const ringScale = (c - 7) / RADIUS_CELLS;
  ctx.strokeStyle = palette.dim;
  ctx.lineWidth = 1;
  for (const ring of [RADIUS_CELLS / 3, (RADIUS_CELLS * 2) / 3, RADIUS_CELLS]) {
    ctx.globalAlpha = ring === RADIUS_CELLS ? 0.3 : 0.16;
    ctx.beginPath();
    ctx.arc(c, c, ring * ringScale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.08;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(angle) * 6, c + Math.sin(angle) * 6);
    ctx.lineTo(c + Math.cos(angle) * rim, c + Math.sin(angle) * rim);
    ctx.stroke();
  }

  // scanlines: alternate 2px rows at whisper alpha (the HUD glass texture)
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = "#000";
  for (let y = 0; y < SIZE_PX; y += 4) ctx.fillRect(0, y, SIZE_PX, 2);
  ctx.globalAlpha = 1;

  // cardinals: north-up world/map compass, matching the contact plot
  const cardinals: Array<{ glyph: string; x: number; y: number; accent: boolean }> = [
    { glyph: "N", x: 0, y: -1, accent: true },
    { glyph: "E", x: 1, y: 0, accent: false },
    { glyph: "S", x: 0, y: 1, accent: false },
    { glyph: "W", x: -1, y: 0, accent: false },
  ];
  ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const cardinal of cardinals) {
    const tickOuter = rim - 0.5;
    const tickInner = rim - 4;
    ctx.strokeStyle = cardinal.accent ? palette.accent : palette.dim;
    ctx.globalAlpha = cardinal.accent ? 0.9 : 0.4;
    ctx.lineWidth = cardinal.accent ? 1.4 : 1;
    ctx.beginPath();
    ctx.moveTo(c + cardinal.x * tickInner, c + cardinal.y * tickInner);
    ctx.lineTo(c + cardinal.x * tickOuter, c + cardinal.y * tickOuter);
    ctx.stroke();
    ctx.fillStyle = cardinal.accent ? palette.accent : palette.dim;
    ctx.globalAlpha = cardinal.accent ? 0.85 : 0.42;
    ctx.fillText(cardinal.glyph, c + cardinal.x * (rim - 9.5), c + cardinal.y * (rim - 9.5));
  }
  ctx.globalAlpha = 1;

  // vignette breathes a little accent into the rim edge
  const edge = ctx.createRadialGradient(c, c, rim - 10, c, c, rim);
  edge.addColorStop(0, "rgba(72, 214, 230, 0)");
  edge.addColorStop(1, "rgba(72, 214, 230, 0.07)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, SIZE_PX, SIZE_PX);
  ctx.restore();

  // rim stroke
  ctx.strokeStyle = palette.dim;
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c, c, rim, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** Contact/waypoint plot — redrawn only when the scene signature changes. */
function drawPlot(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  contacts: readonly RadarDrawContact[],
  waypointContacts: readonly RadarDrawWaypoint[],
  palette: { accent: string; danger: string; amber: string; dim: string },
  c: number,
  scale: number,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, c - 1.5, 0, Math.PI * 2);
  ctx.clip();

  for (const contact of contacts) {
    const hostile = contact.clazz === "hostile";
    const passive = contact.clazz === "passive";
    const color = passive ? palette.amber : hostile ? palette.danger : palette.dim;
    const radius = hostile ? 2.5 : passive ? 2.1 : 1.7;
    const sx = c + contact.xCells * scale;
    const sy = c + contact.yCells * scale;
    ctx.beginPath();
    ctx.arc(sx, sy, radius, 0, Math.PI * 2);
    if (contact.rimClamped) {
      // beyond scope range, bearing-true: hollow ring reads "out there"
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.shadowColor = hostile ? palette.danger : passive ? palette.amber : "transparent";
      ctx.shadowBlur = hostile ? 5 : passive ? 3 : 0;
      ctx.fillStyle = color;
      ctx.globalAlpha = 1;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // waypoints: accent dot in range, rim chevron beyond
  for (const waypoint of waypointContacts) {
    const sx = c + waypoint.xCells * scale;
    const sy = c + waypoint.yCells * scale;
    if (waypoint.rimClamped) {
      drawWaypointChevron(ctx, sx, sy, Math.atan2(waypoint.yCells, waypoint.xCells), palette.accent);
    } else {
      ctx.fillStyle = palette.accent;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // me: accent dot with a soft halo — the scope's anchor
  ctx.shadowColor = palette.accent;
  ctx.shadowBlur = 6;
  ctx.fillStyle = palette.accent;
  ctx.beginPath();
  ctx.arc(c, c, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.restore();
}

/** Per-frame layer: sweep wedge, beam afterglow, entry pings, hover ring. */
function drawAnim(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  contacts: readonly RadarDrawContact[],
  palette: { accent: string; danger: string; amber: string; dim: string },
  c: number,
  scale: number,
  sweepT: number,
  pings: ReadonlyMap<string, number>,
  now: number,
  hover: { id: string; sx: number; sy: number; clazz: RadarContactClass } | null,
): void {
  const rim = SCOPE_RIM_PX;
  const beamAngle = sweepT * Math.PI * 2 - Math.PI / 2;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, SIZE_PX, SIZE_PX);
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rim, 0, Math.PI * 2);
  ctx.clip();

  // trailing wedge: a fan of arcs decaying behind the beam
  const wedge = 0.6; // radians of visible trail
  const steps = 18;
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const angle = beamAngle - t * wedge;
    ctx.strokeStyle = palette.accent;
    ctx.globalAlpha = 0.05 * (1 - t);
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(angle) * rim, c + Math.sin(angle) * rim);
    ctx.stroke();
  }
  // the beam edge itself
  ctx.globalAlpha = 0.24;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(c, c);
  ctx.lineTo(c + Math.cos(beamAngle) * rim, c + Math.sin(beamAngle) * rim);
  ctx.stroke();

  // afterglow: contacts bloom as the beam passes their bearing
  for (const contact of contacts) {
    if (contact.rimClamped) continue;
    const sx = c + contact.xCells * scale;
    const sy = c + contact.yCells * scale;
    const bearing = Math.atan2(sy - c, sx - c);
    let delta = beamAngle - bearing;
    while (delta < 0) delta += Math.PI * 2;
    while (delta >= Math.PI * 2) delta -= Math.PI * 2;
    // glow decays over ~1.1 rad of trailing beam travel
    if (delta > 1.1) continue;
    const boost = Math.exp(-delta * 3.2);
    const color = contact.clazz === "hostile" ? palette.danger : contact.clazz === "passive" ? palette.amber : palette.dim;
    ctx.globalAlpha = 0.5 * boost;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(sx, sy, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // entry pings: expanding ring where a contact just appeared
  for (const contact of contacts) {
    const at = pings.get(contact.id);
    if (at === undefined) continue;
    const t = Math.min(1, (now - at) / PING_MS);
    const sx = c + contact.xCells * scale;
    const sy = c + contact.yCells * scale;
    const color = contact.clazz === "hostile" ? palette.danger : contact.clazz === "passive" ? palette.amber : palette.dim;
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.55 * (1 - t);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(sx, sy, 3 + t * 9, 0, Math.PI * 2);
    ctx.stroke();
  }

  // hover ring: steady accent-inked focus ring over the hovered dot
  if (hover) {
    const color = hover.clazz === "hostile" ? palette.danger : hover.clazz === "passive" ? palette.amber : palette.dim;
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.arc(hover.sx, hover.sy, 5.2, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function syncTooltip(
  tipEl: HTMLElement,
  hover: { id: string; label: string; clazz: RadarContactClass; dCells: number; sx: number; sy: number } | null,
  palette: { danger: string; amber: string; dim: string },
): void {
  if (!hover) {
    if (!tipEl.hidden) tipEl.hidden = true;
    return;
  }
  const color = hover.clazz === "hostile" ? palette.danger : hover.clazz === "passive" ? palette.amber : palette.dim;
  const label = `${hover.label} · ${CLASS_LABEL[hover.clazz]} · ${Math.round(hover.dCells)}c`;
  if (tipEl.dataset.tip !== label) {
    tipEl.dataset.tip = label;
    tipEl.textContent = label;
    tipEl.style.borderColor = color;
  }
  // above the dot, clamped inside the wrap
  const half = SIZE_PX / 2;
  const x = Math.max(4, Math.min(SIZE_PX - 4, hover.sx));
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${Math.max(10, hover.sy - 10)}px`;
  tipEl.style.transform = `translate(${x > half ? "-100%" : "0"}, -100%)`;
  if (tipEl.hidden) tipEl.hidden = false;
}

// ── pure classification (shared north-up projection contract, test-covered) ─

/** The radar preserves raw authority deltas in the shared north-up basis:
 * +x is screen-right/east and negative y is screen-up/north.
 * dCells remains true raw world-cell distance, so rim clamping preserves the
 * exact bearing while plotting in projected coordinates.
 */
export function classifyRadarContact(
  dx: number,
  dy: number,
  attitude: RadarContactAttitude,
): ClassifiedRadarContact | null {
  const clazz: RadarContactClass = attitude === "hostile"
    ? "hostile"
    : attitude === "passive" || attitude === "alerted"
      ? "passive"
      : "civilian";
  const distanceSq = dx * dx + dy * dy;
  const radiusSq = RADIUS_CELLS * RADIUS_CELLS;
  const dCells = Math.sqrt(distanceSq);
  const projected = northUpScreenVectorFromWorld(dx, dy);
  const xCells = projected.x;
  const yCells = projected.y;
  if (distanceSq <= radiusSq) {
    return { dCells, xCells, yCells, clazz, rimClamped: false };
  }
  if (clazz === "civilian") return null;
  const clampScale = RADIUS_CELLS / dCells;
  return {
    dCells,
    xCells: xCells * clampScale,
    yCells: yCells * clampScale,
    clazz,
    rimClamped: true,
  };
}

export function classifyRadarWaypoint(dx: number, dy: number): ClassifiedRadarWaypoint {
  const distanceSq = dx * dx + dy * dy;
  const dCells = Math.sqrt(distanceSq);
  const projected = northUpScreenVectorFromWorld(dx, dy);
  const xCells = projected.x;
  const yCells = projected.y;
  if (distanceSq <= RADIUS_CELLS * RADIUS_CELLS || dCells <= 0) {
    return { dCells, xCells, yCells, rimClamped: false };
  }
  const clampScale = RADIUS_CELLS / dCells;
  return {
    dCells,
    xCells: xCells * clampScale,
    yCells: yCells * clampScale,
    rimClamped: true,
  };
}

function drawWaypointChevron(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string): void {
  const len = 6;
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle - 0.55) * len, y - Math.sin(angle - 0.55) * len);
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle + 0.55) * len, y - Math.sin(angle + 0.55) * len);
  ctx.stroke();
}

/**
 * Player-facing tactical grid reference in the same north-up basis as the
 * radar and map. The current map center is the local origin.
 */
export function worldGridRef(px: number, py: number, widthCells: number, heightCells: number): string {
  const projected = northUpScreenVectorFromWorld(px - widthCells / 2, py - heightCells / 2);
  const east = Math.round(projected.x);
  const north = Math.round(-projected.y);
  return `E ${east} · N ${north}`;
}

function radarAttitudeForActor(actor: ServerAuthorityActorState, me: ServerAuthorityActorState | undefined): RadarContactAttitude {
  if (actor.aiAttitude) return actor.aiAttitude;
  return actor.factionId && me?.factionId && actor.factionId !== me.factionId ? "hostile" : null;
}

function radarContactLabel(actor: ServerAuthorityActorState, actorId: string): string {
  const label = (actor as { label?: string | null }).label;
  if (typeof label === "string" && label.length > 0) return label;
  const role = (actor as { role?: string | null }).role;
  if (typeof role === "string" && role.length > 0) return role.replace(/[-_]/g, " ").toUpperCase();
  return actorId;
}
