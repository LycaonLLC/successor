export interface PawnYawTargetInput {
  currentYaw: number;
  isPlayer: boolean;
  /** True only while the local movement input is still held. */
  inputMoving: boolean;
  /** Render displacement/velocity says the pawn is moving this frame. */
  renderMoving: boolean;
  velocityX: number;
  velocityZ: number;
  aimYaw: number | null;
  aimControlsYaw: boolean;
  engagementYaw: number | null;
  actorDirection?: string | null;
}

// NOTE: no model-forward offset here. The pack rig's yaw-0 orientation IS the
// world "front" convention the clips and movement were authored against —
// group rotation applies resolved yaw RAW (a +π "correction" shipped 2026-07-06
// made every pawn run backwards; owner report 2026-07-07).

export function yawForDirection(direction: string): number {
  switch (direction) {
    case "right":
    case "front_right":
    case "back_right":
      return Math.PI / 2;
    case "back":
      return Math.PI;
    case "left":
    case "front_left":
    case "back_left":
      return -Math.PI / 2;
    case "front":
    default:
      return 0;
  }
}

export function resolvePawnYawTarget(input: PawnYawTargetInput): number {
  if (input.engagementYaw !== null) return input.engagementYaw;
  if (input.aimControlsYaw && input.aimYaw !== null) return input.aimYaw;
  // Local player position can still drift for a few frames after key release
  // while server-authority correction/late receipts settle. That displacement
  // is not travel intent; using it as yaw input turns the pawn toward the
  // correction vector, then idle holds the wrong heading.
  if (input.renderMoving && (!input.isPlayer || input.inputMoving)) {
    return Math.atan2(input.velocityX, input.velocityZ);
  }
  if (input.aimYaw !== null) return input.aimYaw;
  if (!input.isPlayer && input.actorDirection) return yawForDirection(input.actorDirection);
  return input.currentYaw;
}
