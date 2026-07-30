import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { softLockTarget } from "../combat/softLock";
import type { OverlayWorldProjector } from "./index";

/**
 * Soft-lock target bracket (targeting v2, 2026-07-03) — four corners around
 * the acquired target, RELATION-TINTED: hostiles bracket in danger red,
 * anything else in phosphor accent. A slim health bar rides under the
 * bracket (the same target summary the HUD plate reads), so the fight's
 * arithmetic is visible AT the target, not just in the corner.
 */

const HOSTILE_COLOR = "rgba(255, 106, 96, 0.95)";
const HOSTILE_DIM = "rgba(255, 106, 96, 0.35)";
const FRIENDLY_COLOR = "rgba(140, 255, 158, 0.92)";
const PASSIVE_ATTACKABLE_COLOR = "rgba(241, 208, 107, 0.95)";
const PASSIVE_ATTACKABLE_DIM = "rgba(241, 208, 107, 0.34)";
const BRACKET_SHADOW = "rgba(10, 26, 14, 0.9)";
const BAR_BG = "rgba(12, 16, 12, 0.78)";

export function drawTargetBracket(
  ctx: CanvasRenderingContext2D,
  projector: OverlayWorldProjector,
  state: PlayState,
  timeMs: number,
  width: number,
  height: number,
): boolean {
  const target = softLockTarget();
  if (!target) return false;
  const actor = state.serverAuthority.actors[target.actorId];
  if (!actor || actor.lifeState !== "alive") return false;
  const x = actor.renderX ?? actor.x;
  const y = actor.renderY ?? actor.y;
  const screen = projector.worldToScreen(x + 0.5, y + 0.5, 0.95);
  if (screen.px < -60 || screen.px > width + 60 || screen.py < -60 || screen.py > height + 60) return false;

  // Relation tint: the lock module only admits hostiles today, but keep the
  // check honest in case the lock widens (heal-targeting etc).
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const passiveAttackable = actor.aiAttitude === "passive" || actor.aiAttitude === "alerted";
  const hostile = actor.aiAttitude === "hostile" || (!passiveAttackable && Boolean(actor.factionId && me?.factionId && actor.factionId !== me.factionId));
  const color = passiveAttackable ? PASSIVE_ATTACKABLE_COLOR : hostile ? HOSTILE_COLOR : FRIENDLY_COLOR;

  // Size from projected cell scale so the bracket hugs the pawn at any zoom.
  const origin = projector.worldToScreen(x, y, 0);
  const oneCell = projector.worldToScreen(x + 1, y, 0);
  const pxPerCell = Math.max(12, Math.hypot(oneCell.px - origin.px, oneCell.py - origin.py));
  const half = pxPerCell * 0.62;
  const arm = Math.max(4, half * 0.38);
  // Subtle breathing so the lock reads as LIVE, not a sticker.
  const breathe = 1 + 0.025 * Math.sin(timeMs * 0.006);
  const hw = half * breathe;
  const hh = half * 1.35 * breathe;

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = BRACKET_SHADOW;
  strokeCorners(ctx, screen.px, screen.py, hw + 1, hh + 1, arm);
  ctx.strokeStyle = color;
  strokeCorners(ctx, screen.px, screen.py, hw, hh, arm);

  // Health bar under the bracket — authority vitals are the same source the
  // HUD target plate reads (serverActor.vitals in actorTargetSummary).
  const maxHealth = actor.maxVitals?.health ?? 0;
  if (maxHealth > 0) {
    const fraction = Math.max(0, Math.min(1, Math.max(0, actor.vitals.health) / maxHealth));
    const barW = hw * 2;
    const barH = Math.max(2.5, pxPerCell * 0.09);
    const barX = screen.px - hw;
    const barY = screen.py + hh + Math.max(3, arm * 0.5);
    ctx.fillStyle = BAR_BG;
    ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
    ctx.fillStyle = passiveAttackable ? PASSIVE_ATTACKABLE_DIM : hostile ? HOSTILE_DIM : "rgba(140, 255, 158, 0.35)";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = color;
    ctx.fillRect(barX, barY, barW * fraction, barH);
  }
  ctx.restore();
  return true;
}

function strokeCorners(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  arm: number,
): void {
  ctx.beginPath();
  // TL
  ctx.moveTo(cx - hw, cy - hh + arm);
  ctx.lineTo(cx - hw, cy - hh);
  ctx.lineTo(cx - hw + arm, cy - hh);
  // TR
  ctx.moveTo(cx + hw - arm, cy - hh);
  ctx.lineTo(cx + hw, cy - hh);
  ctx.lineTo(cx + hw, cy - hh + arm);
  // BR
  ctx.moveTo(cx + hw, cy + hh - arm);
  ctx.lineTo(cx + hw, cy + hh);
  ctx.lineTo(cx + hw - arm, cy + hh);
  // BL
  ctx.moveTo(cx - hw + arm, cy + hh);
  ctx.lineTo(cx - hw, cy + hh);
  ctx.lineTo(cx - hw, cy + hh - arm);
  ctx.stroke();
}
