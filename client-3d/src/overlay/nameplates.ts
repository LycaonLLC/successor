import {
  actorDrawEntries,
  actorNameplateFillStyle,
  actorNameplateMaxWidth,
  selectActorNameplateIds,
} from "@successor/client/src/slice-core/actorPresentationSystem";
import { actorCorpseNameplate, actorNameplate } from "@successor/client/src/slice-core/selectionSystem";
import { actorSecondaryLine, serverAuthorityDisplayName } from "@successor/client/src/slice-core/npcSystem";
import type { ActorSnapshot, PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { softLockTarget } from "../combat/softLock";
import { OVERLAY_FONT_STACK } from "./font";
import { interactChipScreenRect } from "./interactChip";
import type { OverlayWorldProjector } from "./index";
import {
  claimScreenRect,
  compareActorId,
  overlayViewportBounds,
  placeScreenRect,
  type ScreenRect,
  screenRectFromBaseline,
} from "./screenPlacement";

const nameplateHeadOffsetWorld = 1.75;
const nameplateScreenLiftPx = 24;
const actorNameplateLiftPx = 10;

/** Name line ascent above baseline (13px face + stroke pad). */
const NAME_ASCENT_PX = 12;
/** Title line sits 13px below baseline; include its descent. */
const TITLE_EXTRA_DESCENT_PX = 16;
/** Name-only descent below baseline. */
const NAME_DESCENT_PX = 4;
/** Horizontal pad so stroke edges do not kiss neighbors. */
const PLATE_PAD_X = 6;

/** Placed nameplate seats for a single frame — place first, paint after bubbles. */
export interface NameplateFrame {
  count: number;
  draws: readonly NameplateDrawCommand[];
}

export interface NameplateDrawCommand {
  label: string;
  title: string | null;
  fillStyle: string | undefined;
  plateMaxW: number;
  centerX: number;
  baselineY: number;
  underChip: boolean;
}

export function drawActorLabel(
  ctx: CanvasRenderingContext2D,
  label: string,
  centerX: number,
  baselineY: number,
  fillStyle = "#39f6ff",
  maxWidth = 240,
  title: string | null = null,
): void {
  ctx.save();
  const drawX = Math.round(centerX);
  const drawY = Math.round(baselineY);
  ctx.font = `400 13px ${OVERLAY_FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.66)";
  ctx.strokeText(label, drawX, drawY, maxWidth);
  ctx.fillStyle = fillStyle;
  ctx.fillText(label, drawX, drawY, maxWidth);
  if (title) {
    const titleY = drawY + 13;
    ctx.font = `400 10px ${OVERLAY_FONT_STACK}`;
    ctx.strokeText(title, drawX, titleY, maxWidth);
    ctx.fillStyle = fillStyle;
    ctx.fillText(title, drawX, titleY, maxWidth);
  }
  ctx.restore();
}

function estimatePlateWidth(
  ctx: CanvasRenderingContext2D,
  label: string,
  title: string | null,
  maxWidth: number,
): number {
  ctx.save();
  ctx.font = `400 13px ${OVERLAY_FONT_STACK}`;
  const labelW = Math.min(maxWidth, ctx.measureText(label).width);
  let titleW = 0;
  if (title) {
    ctx.font = `400 10px ${OVERLAY_FONT_STACK}`;
    titleW = Math.min(maxWidth, ctx.measureText(title).width);
  }
  ctx.restore();
  const raw = Math.max(labelW, titleW) + PLATE_PAD_X * 2;
  return Math.min(maxWidth, Math.max(36, Math.ceil(raw)));
}

function nameplatePriority(
  actorId: string,
  followActorId: string,
  selectedActorId: string | null | undefined,
  targetActorId: string | null,
  examineActorId: string | null | undefined,
): number {
  // Lower sorts first. Local + current target never lose their preferred seat.
  if (actorId === followActorId) return 0;
  if (targetActorId && actorId === targetActorId) return 1;
  if (selectedActorId && actorId === selectedActorId) return 2;
  if (examineActorId && actorId === examineActorId) return 3;
  return 4;
}

interface PendingPlate {
  actorId: string;
  label: string;
  title: string | null;
  fillStyle: string | undefined;
  plateMaxW: number;
  preferredCenterX: number;
  preferredBaselineY: number;
  boxW: number;
  ascent: number;
  descent: number;
  priority: number;
  /** Stable tie-break: screen Y then actor id. */
  sortY: number;
}

/**
 * Place/claim nameplate seats in priority order. Does not paint - call
 * paintNameplates after floating texts and bubbles so label glyphs sit above
 * bubble tails and other underlay chrome while occupancy still steers them.
 */
export function placeNameplates(
  ctx: CanvasRenderingContext2D,
  projector: OverlayWorldProjector,
  slice: SliceSnapshot,
  state: PlayState,
  timeMs: number,
  width: number,
  height: number,
  occupied: ScreenRect[],
): NameplateFrame {
  const entries = actorDrawEntries(slice, state, timeMs);
  const visibleNameplateActorIds = selectActorNameplateIds(entries, state, slice.camera.followActor);
  const chipRect = interactChipScreenRect();
  const followActorId = slice.camera.followActor;
  const targetActorId = softLockTarget()?.actorId
    ?? state.selectedActorId
    ?? null;
  const bounds = overlayViewportBounds(width, height);
  const pending: PendingPlate[] = [];

  for (const entry of entries) {
    if (!visibleNameplateActorIds.has(entry.actor.id)) continue;
    const serverActor = state.serverAuthority.actors[entry.actor.id] ?? null;
    const dead = serverActor?.lifeState !== undefined
      ? serverActor.lifeState !== "alive"
      : state.actors[entry.actor.id]?.statuses.some((status) => status.id === "dead") ?? false;
    const anchor = projector.worldToScreen(entry.pos.x + 0.5, entry.pos.y + 0.5, nameplateHeadOffsetWorld);
    const baselineY = anchor.py - nameplateScreenLiftPx - actorNameplateLiftPx;
    if (anchor.px < -260 || anchor.px > width + 260 || baselineY < -60 || baselineY > height + 80) continue;
    const baseLabel = serverAuthorityDisplayName(serverActor?.displayName)
      ?? (dead ? actorCorpseNameplate(entry.actor, slice) : actorNameplate(entry.actor, slice));
    const label = serverActor?.linkDead ? `${baseLabel} (LD)` : baseLabel;
    // Secondary read: the actor descriptor (descriptor) wins over a player's
    // profession title; falls back to the local designation off-authority.
    const title = dead
      ? null
      : actorSecondaryLine(serverActor?.descriptor, serverActor?.activeTitle?.label, entry.actor);
    const plateMaxW = actorNameplateMaxWidth(dead);
    const boxW = estimatePlateWidth(ctx, label, title, plateMaxW);
    const ascent = NAME_ASCENT_PX;
    const descent = title ? TITLE_EXTRA_DESCENT_PX : NAME_DESCENT_PX;
    pending.push({
      actorId: entry.actor.id,
      label,
      title,
      fillStyle: actorNameplateFillStyle(entry.actor, dead, slice, state),
      plateMaxW,
      preferredCenterX: anchor.px,
      preferredBaselineY: baselineY,
      boxW,
      ascent,
      descent,
      priority: nameplatePriority(
        entry.actor.id,
        followActorId,
        state.selectedActorId,
        targetActorId,
        state.examineActorId,
      ),
      sortY: baselineY,
    });
  }

  // Place/claim in priority order so local + target keep preferred seats.
  pending.sort((a, b) => (
    a.priority - b.priority
    || a.sortY - b.sortY
    || compareActorId(a.actorId, b.actorId)
  ));

  const draws: NameplateDrawCommand[] = [];
  for (const plate of pending) {
    const preferred = screenRectFromBaseline(
      plate.preferredCenterX,
      plate.preferredBaselineY,
      plate.boxW,
      plate.ascent,
      plate.descent,
    );
    const placed = placeScreenRect(preferred, occupied, bounds, {
      preferAxis: "y",
      maxShiftX: 64,
      maxShiftY: 88,
      step: 10,
      pad: 3,
    });
    const centerX = placed.rect.left + plate.boxW * 0.5;
    const baselineY = placed.rect.top + plate.ascent;
    // Chip precedence (§1.8): a plate under the interact chip whispers
    // instead of printing through it. Uses last frame's painted chip rect —
    // one frame of lag is invisible at fade alpha. Placement never hides the
    // local/target plate; whisper is the only chip concession.
    const underChip = chipRect !== null
      && placed.rect.right > chipRect.left
      && placed.rect.left < chipRect.right
      && placed.rect.bottom > chipRect.top
      && placed.rect.top < chipRect.bottom;
    draws.push({
      label: plate.label,
      title: plate.title,
      fillStyle: plate.fillStyle,
      plateMaxW: plate.plateMaxW,
      centerX,
      baselineY,
      underChip,
    });
    claimScreenRect(occupied, placed.rect);
  }

  return { count: draws.length, draws };
}

/**
 * Paint previously placed nameplates. Reverse order: low-priority first,
 * local/target last (top). Single pass — no repaint.
 */
export function paintNameplates(
  ctx: CanvasRenderingContext2D,
  frame: NameplateFrame,
): void {
  const draws = frame.draws;
  for (let i = draws.length - 1; i >= 0; i -= 1) {
    const draw = draws[i]!;
    const priorAlpha = ctx.globalAlpha;
    if (draw.underChip) ctx.globalAlpha = priorAlpha * 0.22;
    drawActorLabel(
      ctx,
      draw.label,
      draw.centerX,
      draw.baselineY,
      draw.fillStyle,
      draw.plateMaxW,
      draw.title,
    );
    ctx.globalAlpha = priorAlpha;
  }
}

export type NameplateActorSnapshot = ActorSnapshot;
