import type { SfxPlayer } from "../audio/sfx";
import { updateRuntimeAudio } from "./ambientAudioSystem";
import {
  authorityDirectionFromFacing,
  authorityIssuedAtServerTick,
  createAuthorityCommandQueue,
  enqueueAuthorityMoveCommand,
  enqueueAuthorityMoveIntentCommand,
  enqueueAuthorityTransitionCommand,
  authorityMoveIntentDurationTicks,
} from "./authorityCommandSystem";
import { successorMoveTraceEnabled, recordSuccessorMoveTrace } from "./moveTraceSystem";
import {
  authorityActorCanSprint,
  authorityMovementDistanceCells,
  authorityMovementSpeedCellsPerSecond,
  authoritySprintSpeedMultiplier,
} from "./authorityMovementSystem";
import type { ActorCombatState } from "./combatReducer";
import { combatAudioListenerPosition } from "./combatAudioSystem";
import { tickVisualEffects } from "./effectsSystem";
import { expireStaleInFlightMoves } from "./gameAuthoritySystem";
import { playerSpeedCellsPerSecond, sprintActionDrainPerSecond } from "./gameTuning";
import type {
  PlayState,
  ServerAuthorityPendingMoveState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "./gameState";
import { directionFromVector, isMovementKey, type Cell, type Direction } from "./geometry";
import {
  actorSprintRecoveryLocked,
  advanceClickRouteFromAuthority,
  cancelClickMove,
  clampToMovementBounds,
  clickMoveOctantVector,
  clickMoveStalled,
  clickMoveTarget,
  clickRouteNeedsBlockerReplan,
  clickRouteWaypoints,
  completeClickMove,
  facingFromMovementKeys,
  installClickRoute,
  isBlockedAt,
  isSprintKey,
  modifiedMovementVector,
  movementSprintIntent,
  movementVectorFromKeys,
  moveIfUnblocked,
  rotationLocked,
} from "./movementSystem";
import {
  applyAreaTransitionState,
  transitionAtPlayerPosition,
} from "./transitionSystem";
import { cancelRollAttackRepeat, queueRollAttack } from "./rollCombatInputSystem";
import { clearInvisibleTargetSelection } from "./targetSelectionSystem";
import { expireWeaponFireAnimations } from "./weaponPresentationSystem";
import {
  buildBlockedCells,
  buildMovementBlockers,
  currentArea,
  transitionsForArea,
} from "./worldQueries";

// Remote actors are rendered from a snapshot interpolation buffer, not chased
// with per-frame catch-up clamps. Keep presentation safely behind newest server
// truth, bridge short packet gaps by extrapolating along the last authority
// segment, and only treat large discontinuities as snaps.
const remoteActorInterpolationDelayMs = 120;
const remoteActorMaxExtrapolationMs = 120;
const remoteActorSnapDistanceCells = 12;
const remoteActorStationaryEpsilonCells = 0.0005;
const remoteActorStationaryHoldMs = 160;
// Bound one-frame local visual prediction. Server-authoritative movement is
// held intent: key edges/keepalives set an authority-side intent, and the Rust
// fixed tick integrates it. Browser frame rate therefore cannot become command
// cadence or movement cooldown cadence.
const localPlayerPredictionMaxFrameDtMs = 24;
const localPlayerPredictionMaxStepCells = 0.24;
const localPlayerWalkPredictionLeadCells = 0.82;
const localPlayerSprintPredictionLeadCells = 0.9;
const localPlayerWalkCorrectionLeadCells = 0.58;
const localPlayerSprintCorrectionLeadCells = 0.65;
// Local-player reconciliation is exponential, not a capped linear bleed:
// moving tau keeps sprint corrections velocity-continuous; idle tau settles slower.
const localPlayerMovingCorrectionTauSeconds = 0.09;
const localPlayerIdleCorrectionTauSeconds = 0.15;
const localPlayerDeadReckonMaxMs = 250;
const moveIntentKeepaliveMs = 500;
const transitionRequestCooldownMs = 180;


export function updatePlayState(
  state: PlayState,
  slice: SliceSnapshot,
  dtMs: number,
  time: number,
  sfx: SfxPlayer,
) {
  state.worldTimeMs = time;
  state.serverAuthority.enabled = true;
  applyObserverCameraFollow(state, slice);
  clearInvisibleTargetSelection({ state, slice });
  sfx.setListenerPosition(combatAudioListenerPosition(state));
  tickRuntimeTimers(state, dtMs);
  updateActorPresentationTimers(state, dtMs);
  updateChatBubbleTtls(state, dtMs);
  tickVisualEffects(state, dtMs);
  updateServerAuthorityInput(state, slice, dtMs, time);
  applyObserverCameraFollow(state, slice);
  updateRuntimeAudio(state, slice, sfx, time);
}

function applyObserverCameraFollow(state: PlayState, slice: SliceSnapshot): void {
  const followActorId = state.observerCamera.followActorId;
  if (!followActorId) return;
  const actor = state.serverAuthority.actors[followActorId];
  if (!actor || actor.lifeState === "respawning") {
    state.status = `observing ${followActorId}`;
    return;
  }
  if (state.activeAreaId !== actor.areaId) {
    state.activeAreaId = actor.areaId;
    state.blocked = buildBlockedCells(slice, actor.areaId);
    state.movementBlockers = buildMovementBlockers(slice, actor.areaId, state.serverAuthority.propStates ?? {}, state.serverAuthority.placedCamps);
  }
  state.player = {
    x: actor.renderX ?? actor.x,
    y: actor.renderY ?? actor.y,
  };
  state.facing = actor.direction ?? state.facing;
  state.moving = false;
  if (state.observerCamera.inputLocked) {
    state.serverAuthority.lastMoveVector = null;
    state.serverAuthority.wasMovingLastFrame = false;
  }
  state.status = `observing ${actor.label ?? followActorId}`;
}

export function updateServerAuthorityInput(
  state: PlayState,
  slice: SliceSnapshot,
  dtMs: number,
  time: number,
) {
  updateServerAuthorityActorVisuals(state, dtMs);
  if (state.serverAuthority.sourceMatchesClient === false) {
    state.moving = false;
    state.serverAuthority.lastMoveVector = null;
    state.serverAuthority.wasMovingLastFrame = false;
    if (!state.status.startsWith("server authority source mismatch")) {
      state.status = "server authority source mismatch";
    }
    return;
  }
  expireStaleInFlightMoves(state, time);
  const movementKeys = movementInputKeys(state);
  const keyVector = movementVectorFromKeys(movementKeys, state.movementInputMode);
  const wasMoving = state.serverAuthority.wasMovingLastFrame;
  const previousMoveVector = state.serverAuthority.lastMoveVector;
  const actor = state.actors[state.playerActorId];
  // Posture lock mirrors the server: kneeling (or mid-transition) rejects
  // movement server-side (posture_locked), so prediction + move enqueue
  // stop together — no rubber-band while sampling.
  const authorityPosture = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId]?.posture ?? "standing";
  const inputLocked = state.observerCamera.inputLocked
    || state.death.phase !== "alive"
    || actor?.lifeState !== "alive"
    || authorityPosture !== "standing";
  const clickVector = clickMoveIntentVector(state, slice, keyVector, inputLocked, time);
  const clickDriven = clickVector !== null;
  const vector = clickDriven ? clickVector : keyVector;
  const lockedFacing = !inputLocked && rotationLocked(state.keys)
    ? state.rotationLockFacing ?? state.facing
    : null;
  if (lockedFacing) state.facing = lockedFacing;
  state.moving = !inputLocked && (vector.x !== 0 || vector.y !== 0);
  if (state.moving) {
    if (!lockedFacing) {
      // Click navigation has no held keys — face along the travelled octant.
      state.facing = clickDriven
        ? directionFromVector(vector.x, vector.y, state.facing)
        : facingFromMovementKeys(movementKeys, state.facing, state.movementInputMode);
    }
    // Sprint intent: keyboard Shift and click-route share one calculation
    // (held key OR persistent toggle). While the authority recovery lockout is
    // projected, stop REQUESTING sprint (walk honestly / WINDED); the toggle
    // intent survives and resumes only when the sim clears the lock.
    const sprintRequested = movementSprintIntent(state, state.keys)
      && !actorSprintRecoveryLocked(playerAuthorityActor(state));
    const durationTicks = authorityMoveIntentDurationTicks(slice.tickRateHz);
    const plannedMove = plannedAuthorityMoveOctant(
      state,
      Math.sign(vector.x),
      Math.sign(vector.y),
      durationTicks,
      sprintRequested,
      slice.tickRateHz,
    );
    const sprinting = plannedMove?.sprinting === true;
    const prediction = predictServerAuthorityMovement(state, slice, vector, dtMs, sprinting);
    const currentMoveVector = { ...vector };
    if (clickDriven && prediction.blocked && !prediction.moved) {
      cancelClickMove(state, "blocked");
      state.moving = false;
      state.serverAuthority.lastMoveVector = null;
      state.serverAuthority.wasMovingLastFrame = false;
      state.serverAuthority.nextMoveCommandAtMs = time;
      enqueueStopMoveIntent(state, slice, time, wasMoving, previousMoveVector);
      state.status = state.serverAuthority.connected ? "server authority blocked" : "server authority connecting";
    } else {
      // Local collision only clamps presentation prediction. Rust remains the
      // sole movement authority, so visible keyboard intent is still sent even
      // when the local structural proxy predicts no movement.
      if (!wasMoving) {
        state.serverAuthority.nextMoveCommandAtMs = time;
      }
      if (state.serverAuthority.connected) {
        enqueueAuthorityMoveIntent(state, slice, vector, time, sprintRequested);
      }
      state.serverAuthority.lastMoveVector = currentMoveVector;
      state.serverAuthority.wasMovingLastFrame = true;
      state.status = state.serverAuthority.connected ? (sprinting ? "server authority sprinting" : "server authority moving") : "server authority connecting";
    }
  } else {
    enqueueStopMoveIntent(state, slice, time, wasMoving, previousMoveVector);
    state.serverAuthority.lastMoveVector = null;
    state.serverAuthority.wasMovingLastFrame = false;
    state.status = state.serverAuthority.connected ? "server authority" : "server authority connecting";
  }
  reconcileServerAuthorityPlayer(state, slice, dtMs);

  if (!inputLocked && state.moving && state.serverAuthority.connected && state.transitionCooldownMs <= 0) {
    const transition = transitionAtPlayerPosition(transitionsForArea(slice, state.activeAreaId), state.player);
    if (transition) {
      state.authorityCommands ??= createAuthorityCommandQueue();
      enqueueAuthorityTransitionCommand(
        state.authorityCommands,
        transition.id,
        authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      );
      state.transitionCooldownMs = transitionRequestCooldownMs;
      state.lastTransitionLabel = transition.label;
      state.status = `${transition.label.toLowerCase()} requested`;
    }
  }

  const rollTriggerHeld = !inputLocked && state.keys.has("Space");
  if (rollTriggerHeld) {
    // Combat direct control outranks navigation — a held trigger drops the
    // click destination before the queue fires.
    cancelClickMove(state, "combat");
    // Roll combat: the trigger enqueues; the server resolves and repeats at
    // fixed-tick weapon cadence until release or target loss cancels repeat.
    queueRollAttack(state, slice);
  } else {
    cancelRollAttackRepeat(state, slice);
  }
}

const clickMoveVectorScratch: Cell = { x: 0, y: 0 };

function authorityPlayerPosition(state: PlayState): Cell {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authoritative = state.serverAuthority.actors[actorId];
  if (authoritative && authoritative.areaId === state.activeAreaId) {
    return { x: authoritative.x, y: authoritative.y };
  }
  // Pre-hydration / offline tests: presentation player is the only sample.
  return { x: state.player.x, y: state.player.y };
}

function clickRouteAreaBounds(state: PlayState, slice: SliceSnapshot) {
  // currentArea takes the play-state area id carrier, same as every other
  // runtime caller — never a bare string.
  const area = currentArea(slice, state);
  return { width: area.width, height: area.height };
}

/**
 * Click-to-move steering: plans a presentation-only route over blocked cells +
 * radius-inflated blockers, steers octants toward authority-advanced waypoints,
 * and clears on keyboard/combat/lock/area change or bounded failure. Returns
 * null when the keyboard owns the frame or no navigation is active.
 */
function clickMoveIntentVector(
  state: PlayState,
  slice: SliceSnapshot,
  keyVector: Cell,
  inputLocked: boolean,
  time: number,
): Cell | null {
  const target = clickMoveTarget(state);
  if (!target) return null;
  if (keyVector.x !== 0 || keyVector.y !== 0) {
    cancelClickMove(state, "manual-input");
    return null;
  }
  if (inputLocked) {
    cancelClickMove(state, "input-locked");
    return null;
  }
  if (target.areaId !== state.activeAreaId) {
    cancelClickMove(state, "area-transition");
    return null;
  }

  const authority = authorityPlayerPosition(state);
  const bounds = clickRouteAreaBounds(state, slice);
  const blocked = state.blocked;
  const blockers = state.movementBlockers;

  // Fresh click or obstacle-field revision -> (re)plan. First plan does not
  // burn the replan budget; later revisions/stalls do. Bounded failure cancels
  // visibly and lets the frame's stop path send an ordinary stop intent.
  if (clickRouteNeedsBlockerReplan(state, blocked, blockers)) {
    const countReplan = clickRouteWaypoints(state).length > 0;
    if (!installClickRoute(state, authority, bounds, blocked, blockers, countReplan)) {
      cancelClickMove(state, countReplan ? "replan-exhausted" : "unreachable");
      return null;
    }
  }

  if (clickMoveStalled(state, authority, time)) {
    if (!installClickRoute(state, authority, bounds, blocked, blockers, true)) {
      cancelClickMove(state, "replan-exhausted");
      return null;
    }
  }

  const steer = advanceClickRouteFromAuthority(state, authority);
  if (!steer) {
    completeClickMove(state);
    return null;
  }

  // Steer from authority-streamed position so waypoint arrival and octants
  // agree with the sole position writer (Rust), not local prediction drift.
  const octant = clickMoveOctantVector(steer, authority, clickMoveVectorScratch);
  if (!octant) {
    completeClickMove(state);
    return null;
  }

  const modified = modifiedMovementVector(octant);
  if (modified.x === 0 && modified.y === 0) return null;
  return modified;
}

interface AuthorityMoveIntent {
  dx: number;
  dy: number;
  sprint: boolean;
  facing: Direction;
}

function enqueueAuthorityMoveIntent(
  state: PlayState,
  slice: SliceSnapshot,
  vector: Cell,
  time: number,
  sprintRequested: boolean,
) {
  const commandTime = Number.isFinite(time) ? time : state.worldTimeMs;
  if (!Number.isFinite(commandTime)) return;
  const durationTicks = 1;
  const dx = Math.sign(vector.x);
  const dy = Math.sign(vector.y);
  const plannedMove = plannedAuthorityMoveOctant(state, dx, dy, durationTicks, sprintRequested, slice.tickRateHz);
  if (!plannedMove) return;
  const { commandVector, sprinting } = plannedMove;
  if (!Number.isFinite(commandVector.dx) || !Number.isFinite(commandVector.dy)) return;
  enqueueAuthorityMoveIntentState(state, slice, {
    dx: commandVector.dx,
    dy: commandVector.dy,
    sprint: sprinting,
    facing: state.facing,
  }, commandTime);
}

function enqueueAuthorityMoveIntentState(
  state: PlayState,
  slice: Pick<SliceSnapshot, "tick" | "tickRateHz">,
  intent: AuthorityMoveIntent,
  time: number,
  force = false,
) {
  const commandTime = Number.isFinite(time) ? time : state.worldTimeMs;
  if (!Number.isFinite(commandTime)) return;
  state.authorityCommands ??= createAuthorityCommandQueue();
  const queuedIntent = latestQueuedMoveIntent(state);
  if (queuedIntent && sameAuthorityMoveIntent(queuedIntent, intent)) {
    state.serverAuthority.lastMoveIntent = { ...intent };
    return;
  }
  const previousIntent = state.serverAuthority.lastMoveIntent;
  const intentChanged = !previousIntent || !sameAuthorityMoveIntent(previousIntent, intent);
  const lastSentAt = state.serverAuthority.lastMoveIntentSentAtMs;
  const keepaliveDue = lastSentAt === null || commandTime - lastSentAt >= moveIntentKeepaliveMs;
  if (!force && !intentChanged && !keepaliveDue) return;
  dropQueuedMoveIntentCommands(state);
  const issuedAtTick = currentMoveIssuedAtCandidateTick(state, slice, commandTime);
  const envelope = enqueueAuthorityMoveIntentCommand(
    state.authorityCommands,
    intent.dx,
    intent.dy,
    issuedAtTick,
    authorityDirectionFromFacing(intent.facing),
    intent.sprint,
  );
  if (!envelope) return;
  state.serverAuthority.lastMoveIntent = { ...intent };
  state.serverAuthority.lastMoveIntentSentAtMs = commandTime;
  state.serverAuthority.lastMoveCommandAtMs = commandTime;
  state.serverAuthority.nextMoveCommandAtMs = commandTime + moveIntentKeepaliveMs;
  if (successorMoveTraceEnabled()) {
    recordSuccessorMoveTrace({
      kind: "command-enqueued",
      worldTimeMs: Number(commandTime.toFixed(3)),
      commandId: envelope.command_id,
      issuedAtTick,
      snapshotTick: state.serverAuthority.snapshotTick,
      dx: intent.dx,
      dy: intent.dy,
      durationTicks: null,
      sprint: intent.sprint,
      facing: intent.facing,
      pendingMoves: queuedMovementCommandCount(state),
      inFlightMoves: state.serverAuthority.inFlightMoves.length,
      nextMoveCommandAtMs: Number(state.serverAuthority.nextMoveCommandAtMs.toFixed(3)),
    });
  }
}

interface AuthorityMoveOctant {
  dx: number;
  dy: number;
  durationTicks: number;
}

function plannedAuthorityMoveOctant(
  state: PlayState,
  dx: number,
  dy: number,
  durationTicks: number,
  sprintRequested: boolean,
  tickRateHz: number,
): { commandVector: AuthorityMoveOctant; sprinting: boolean } | null {
  const commandVector = authorityIntentMoveOctant(dx, dy, durationTicks);
  if (!commandVector) return null;
  const sprinting = sprintRequested && playerHasSprintAction(state, commandVector.durationTicks, tickRateHz);
  return { commandVector, sprinting };
}

function authorityIntentMoveOctant(dx: number, dy: number, durationTicks: number): AuthorityMoveOctant | null {
  const commandDx = Math.sign(dx);
  const commandDy = Math.sign(dy);
  if (commandDx === 0 && commandDy === 0) return null;
  return {
    dx: commandDx,
    dy: commandDy,
    durationTicks: Math.max(1, Math.trunc(durationTicks)),
  };
}




function queuedAuthorityMoves(state: PlayState): ServerAuthorityPendingMoveState[] {
  return (state.authorityCommands?.pending ?? [])
    .flatMap((envelope): ServerAuthorityPendingMoveState[] => {
      if (!("Move" in envelope.command)) return [];
      return [{
        commandId: envelope.command_id,
        dx: envelope.command.Move.dx,
        dy: envelope.command.Move.dy,
        durationTicks: envelope.command.Move.duration_ticks,
        sprint: envelope.command.Move.sprint === true,
        facing: directionFromAuthorityFacing(envelope.command.Move.facing),
        issuedAtTick: envelope.issued_at_tick,
        sentAtMs: null,
      }];
    });
}

function latestQueuedMoveIntent(state: PlayState): AuthorityMoveIntent | null {
  const pending = state.authorityCommands?.pending ?? [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const envelope = pending[index]!;
    if (!("SetMoveIntent" in envelope.command)) continue;
    const intent = envelope.command.SetMoveIntent;
    return {
      dx: intent.dx,
      dy: intent.dy,
      sprint: intent.sprint === true,
      facing: directionFromAuthorityFacing(intent.facing) ?? state.facing,
    };
  }
  return null;
}

function queuedMovementCommandCount(state: PlayState): number {
  return (state.authorityCommands?.pending ?? [])
    .filter((envelope) => "Move" in envelope.command || "SetMoveIntent" in envelope.command)
    .length;
}

function sameAuthorityMoveIntent(
  left: { dx: number; dy: number; sprint: boolean; facing?: Direction } | null | undefined,
  right: { dx: number; dy: number; sprint: boolean; facing?: Direction } | null | undefined,
): boolean {
  return Boolean(left && right
    && left.dx === right.dx
    && left.dy === right.dy
    && left.sprint === right.sprint
    && left.facing === right.facing);
}

function dropQueuedMoveIntentCommands(state: PlayState): number {
  const queue = state.authorityCommands;
  if (!queue || queue.pending.length === 0) return 0;
  const before = queue.pending.length;
  queue.pending = queue.pending.filter((envelope) => !("SetMoveIntent" in envelope.command));
  return before - queue.pending.length;
}



function currentMoveIssuedAtCandidateTick(
  state: PlayState,
  slice: Pick<SliceSnapshot, "tick" | "tickRateHz">,
  commandWorldTimeMs = state.worldTimeMs,
): number {
  const fallbackTick = Math.max(
    Number.isFinite(slice.tick) ? Math.max(0, Math.trunc(slice.tick)) : 0,
    Number.isFinite(state.serverAuthority.snapshotTick) ? Math.max(0, Math.trunc(state.serverAuthority.snapshotTick)) : 0,
  );
  const candidateRaw = authorityIssuedAtServerTick(
    state,
    slice.tickRateHz,
    fallbackTick,
    commandWorldTimeMs,
  );
  return Number.isFinite(candidateRaw) ? Math.max(0, Math.trunc(candidateRaw)) : fallbackTick;
}

function enqueueStopMoveIntent(
  state: PlayState,
  slice: Pick<SliceSnapshot, "tick" | "tickRateHz">,
  time: number,
  wasMoving: boolean,
  previousMoveVector: Cell | null,
) {
  state.serverAuthority.nextMoveCommandAtMs = time;
  const queuedIntent = latestQueuedMoveIntent(state);
  const lastIntent = state.serverAuthority.lastMoveIntent;
  const hasMovingIntent = Boolean(
    wasMoving
    || previousMoveVector
    || (queuedIntent && (queuedIntent.dx !== 0 || queuedIntent.dy !== 0))
    || (lastIntent && (lastIntent.dx !== 0 || lastIntent.dy !== 0)),
  );
  if (!hasMovingIntent) return;
  if (!state.serverAuthority.connected) {
    dropQueuedMoveIntentCommands(state);
    state.serverAuthority.lastMoveIntent = null;
    state.serverAuthority.lastMoveIntentSentAtMs = null;
    return;
  }
  enqueueAuthorityMoveIntentState(state, slice, {
    dx: 0,
    dy: 0,
    sprint: false,
    facing: state.facing,
  }, time, true);
}

export interface MovementPredictionResult {
  moved: boolean;
  blocked: boolean;
}

export function predictServerAuthorityMovement(
  state: PlayState,
  slice: SliceSnapshot,
  vector: { x: number; y: number },
  dtMs: number,
  sprinting = false,
): MovementPredictionResult {
  const area = currentArea(slice, state);
  const predictionDtMs = Math.min(Math.max(0, dtMs), localPlayerPredictionMaxFrameDtMs);
  const predictionSpeedCellsPerSecond = authorityMovementSpeedCellsPerSecond(
    playerAuthorityActor(state),
    playerCombatActor(state),
  ) * (sprinting ? authoritySprintSpeedMultiplier(playerAuthorityActor(state)) : 1);
  const distance = Math.min(
    localPlayerPredictionMaxStepCells,
    predictionSpeedCellsPerSecond * (predictionDtMs / 1000),
  );
  const start = { ...state.player };
  const desired = {
    x: start.x + vector.x * distance,
    y: start.y + vector.y * distance,
  };
  const clamped = clampToMovementBounds(area, desired);
  const targetBlocked = isBlockedAt(state.blocked, clamped, state.movementBlockers);
  const clampedAtCurrent = clamped.x === start.x && clamped.y === start.y
    && (desired.x !== start.x || desired.y !== start.y);
  state.player = moveIfUnblocked(start, area, state.blocked, desired, state.movementBlockers);
  const blocked = targetBlocked || clampedAtCurrent;
  capLocalPlayerPredictionLeadFromAuthority(state, sprinting);
  return {
    moved: Math.hypot(state.player.x - start.x, state.player.y - start.y) > 0.0001,
    blocked,
  };
}

function capLocalPlayerPredictionLeadFromAuthority(state: PlayState, sprinting: boolean): void {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authoritative = state.serverAuthority.actors[playerActorId];
  if (!authoritative || authoritative.areaId !== state.activeAreaId) return;
  const dx = state.player.x - authoritative.x;
  const dy = state.player.y - authoritative.y;
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  if (vector.x !== 0 || vector.y !== 0) {
    const maxLeadCells = sprinting ? localPlayerSprintPredictionLeadCells : localPlayerWalkPredictionLeadCells;
    const parallelLead = dx * vector.x + dy * vector.y;
    if (parallelLead <= maxLeadCells) return;
    const excess = parallelLead - maxLeadCells;
    state.player = {
      x: state.player.x - vector.x * excess,
      y: state.player.y - vector.y * excess,
    };
    return;
  }
  const distance = Math.hypot(dx, dy);
  const maxLeadCells = sprinting ? localPlayerSprintPredictionLeadCells : localPlayerWalkPredictionLeadCells;
  if (distance <= maxLeadCells || distance <= 0.001) return;
  const scale = maxLeadCells / distance;
  state.player = {
    x: authoritative.x + dx * scale,
    y: authoritative.y + dy * scale,
  };
}

export function movementInputKeys(state: Pick<PlayState, "keys" | "movementKeyOrder">): Iterable<string> {
  const heldMovementKeys = [...state.keys].filter(isMovementKey);
  const orderedHeldMovementKeys = state.movementKeyOrder.filter((key) => state.keys.has(key) && isMovementKey(key));
  if (orderedHeldMovementKeys.length === 0) return heldMovementKeys;
  const unorderedHeldMovementKeys = heldMovementKeys.filter((key) => !orderedHeldMovementKeys.includes(key));
  if (unorderedHeldMovementKeys.length === 0) return orderedHeldMovementKeys;
  // Stale-held keys (lost from the order array by a swallowed event or focus
  // hiccup) rejoin BEFORE the ordered keys so an explicit fresh press still
  // wins same-axis conflicts under last-key-wins vector resolution.
  return [...unorderedHeldMovementKeys, ...orderedHeldMovementKeys];
}

export function sprintActionCost(durationTicks: number, tickRateHz: number): number {
  return Math.ceil(
    (sprintActionDrainPerSecond * Math.max(1, durationTicks)) / Math.max(1, tickRateHz),
  );
}

function movementDistanceForDuration(
  state: Pick<PlayState, "actors" | "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
  durationTicks: number,
  tickRateHz: number,
  sprinting: boolean,
): number {
  return authorityMovementDistanceCells(
    playerAuthorityActor(state),
    playerCombatActor(state),
    durationTicks,
    tickRateHz,
    sprinting,
  );
}

function movementDeltaForDistance(dx: number, dy: number, distance: number): Cell {
  const length = Math.hypot(dx, dy);
  if (length <= 0.001 || distance <= 0) return { x: 0, y: 0 };
  const scale = distance / length;
  return { x: dx * scale, y: dy * scale };
}

function sprintRequestedFromKeys(keys: Iterable<string>): boolean {
  for (const key of keys) {
    if (isSprintKey(key)) return true;
  }
  return false;
}

function playerHasSprintAction(
  state: Pick<PlayState, "actors" | "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
  durationTicks: number,
  tickRateHz: number,
): boolean {
  return authorityActorCanSprint(
    playerAuthorityActor(state),
    playerCombatActor(state),
    durationTicks,
    tickRateHz,
  );
}

function playerAuthorityActor(
  state: Pick<PlayState, "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
): ServerAuthorityActorState | null {
  const actorId = state.serverAuthority?.playerActorId ?? state.playerActorId;
  return state.serverAuthority?.actors[actorId] ?? null;
}

function playerCombatActor(
  state: Pick<PlayState, "actors" | "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">>,
): ActorCombatState | null {
  const actorId = state.serverAuthority?.playerActorId ?? state.playerActorId;
  return state.actors[actorId] ?? state.actors[state.playerActorId] ?? null;
}

export function updateServerAuthorityActorVisuals(state: PlayState, dtMs: number) {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const dtSeconds = Math.max(0, dtMs) / 1000;
  for (const [actorId, actor] of Object.entries(state.serverAuthority.actors)) {
    if (actorId === playerActorId) continue;
    const target = remoteActorSnapshotPosition(actor, state);
    if (target) {
      setRemoteActorRenderPosition(actor, target.x, target.y, dtSeconds);
    } else {
      holdRemoteActorRenderPosition(actor, dtSeconds);
    }
  }
}

type RemoteActorSample = NonNullable<ServerAuthorityActorState["interpolationSamples"]>[number];
type TickRemoteActorSample = RemoteActorSample & { tick: number };

function setRemoteActorRenderPosition(
  actor: PlayState["serverAuthority"]["actors"][string],
  targetX: number,
  targetY: number,
  dtSeconds: number,
): void {
  const hasRender = typeof actor.renderX === "number"
    && Number.isFinite(actor.renderX)
    && typeof actor.renderY === "number"
    && Number.isFinite(actor.renderY);
  const renderX = hasRender ? actor.renderX! : targetX;
  const renderY = hasRender ? actor.renderY! : targetY;
  const dx = targetX - renderX;
  const dy = targetY - renderY;
  const distance = Math.hypot(dx, dy);
  actor.renderX = targetX;
  actor.renderY = targetY;
  // renderVelocityX/Y are CELLS PER SECOND for animation/gait consumers, never
  // per-frame deltas. Snaps intentionally report zero so one discontinuity does
  // not kick locomotion clips into a bogus sprint cycle.
  if (!hasRender || dtSeconds <= 0 || distance <= remoteActorStationaryEpsilonCells || distance > remoteActorSnapDistanceCells) {
    actor.renderVelocityX = 0;
    actor.renderVelocityY = 0;
    return;
  }
  actor.renderVelocityX = dx / dtSeconds;
  actor.renderVelocityY = dy / dtSeconds;
}

function holdRemoteActorRenderPosition(
  actor: PlayState["serverAuthority"]["actors"][string],
  dtSeconds: number,
): void {
  const renderX = typeof actor.renderX === "number" && Number.isFinite(actor.renderX) ? actor.renderX : actor.x;
  const renderY = typeof actor.renderY === "number" && Number.isFinite(actor.renderY) ? actor.renderY : actor.y;
  const latestDistance = Math.hypot(actor.x - renderX, actor.y - renderY);
  if (latestDistance > remoteActorSnapDistanceCells) {
    setRemoteActorRenderPosition(actor, actor.x, actor.y, dtSeconds);
    actor.renderVelocityX = 0;
    actor.renderVelocityY = 0;
    return;
  }
  actor.renderX = renderX;
  actor.renderY = renderY;
  actor.renderVelocityX = 0;
  actor.renderVelocityY = 0;
}

function remoteActorSnapshotPosition(
  actor: PlayState["serverAuthority"]["actors"][string],
  state: PlayState,
): { x: number; y: number } | null {
  const samples = actor.interpolationSamples;
  if (!samples || samples.length < 2) return null;
  return remoteActorSnapshotPositionByTick(samples, state)
    ?? remoteActorSnapshotPositionByReceiveTime(samples, state.worldTimeMs);
}

function remoteActorSamplesSharePosition(left: RemoteActorSample, right: RemoteActorSample): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y) <= remoteActorStationaryEpsilonCells;
}

function remoteActorStationaryHoldByReceiveTime(
  samples: readonly RemoteActorSample[],
  targetTime: number,
): { x: number; y: number } | null {
  let runStart: RemoteActorSample | null = null;
  let runLast: RemoteActorSample | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (runLast && remoteActorSamplesSharePosition(runLast, sample)) {
      runLast = sample;
      continue;
    }
    if (
      runStart
      && runLast
      && runLast.receivedAtMs - runStart.receivedAtMs >= remoteActorStationaryHoldMs
      && targetTime >= runStart.receivedAtMs
      && targetTime <= runLast.receivedAtMs
    ) {
      return { x: runLast.x, y: runLast.y };
    }
    runStart = sample;
    runLast = sample;
  }
  if (
    runStart
    && runLast
    && runLast.receivedAtMs - runStart.receivedAtMs >= remoteActorStationaryHoldMs
    && targetTime >= runStart.receivedAtMs
  ) {
    return { x: runLast.x, y: runLast.y };
  }
  return null;
}

function remoteActorStationaryHoldByTick(
  samples: readonly RemoteActorSample[],
  targetTick: number,
  tickRateHz: number,
): { x: number; y: number } | null {
  const minHoldTicks = (remoteActorStationaryHoldMs / 1000) * tickRateHz;
  let runStart: TickRemoteActorSample | null = null;
  let runLast: TickRemoteActorSample | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    const raw = samples[index]!;
    if (typeof raw.tick !== "number" || !Number.isFinite(raw.tick)) continue;
    const sample = raw as TickRemoteActorSample;
    if (runLast && remoteActorSamplesSharePosition(runLast, sample)) {
      runLast = sample;
      continue;
    }
    if (
      runStart
      && runLast
      && runLast.tick - runStart.tick >= minHoldTicks
      && targetTick >= runStart.tick
      && targetTick <= runLast.tick
    ) {
      return { x: runLast.x, y: runLast.y };
    }
    runStart = sample;
    runLast = sample;
  }
  if (
    runStart
    && runLast
    && runLast.tick - runStart.tick >= minHoldTicks
    && targetTick >= runStart.tick
  ) {
    return { x: runLast.x, y: runLast.y };
  }
  return null;
}


function remoteActorSnapshotPositionByReceiveTime(
  samples: readonly RemoteActorSample[],
  worldTimeMs: number,
): { x: number; y: number } | null {
  const targetTime = worldTimeMs - remoteActorInterpolationDelayMs;
  const stationaryHold = remoteActorStationaryHoldByReceiveTime(samples, targetTime);
  if (stationaryHold) return stationaryHold;
  let previous: RemoteActorSample | null = null;
  let beforePrevious: RemoteActorSample | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (previous && remoteActorSamplesSharePosition(previous, sample)) continue;
    if (targetTime <= sample.receivedAtMs) {
      if (!previous) return { x: sample.x, y: sample.y };
      return interpolateRemoteActorSamples(previous, sample, targetTime - previous.receivedAtMs, sample.receivedAtMs - previous.receivedAtMs);
    }
    beforePrevious = previous;
    previous = sample;
  }
  if (!previous) return null;
  if (!beforePrevious) return { x: previous.x, y: previous.y };
  return extrapolateRemoteActorSamples(
    beforePrevious,
    previous,
    targetTime - previous.receivedAtMs,
    previous.receivedAtMs - beforePrevious.receivedAtMs,
    remoteActorMaxExtrapolationMs,
  );
}

function remoteActorSnapshotPositionByTick(
  samples: readonly RemoteActorSample[],
  state: PlayState,
): { x: number; y: number } | null {
  const tickRateHz = Math.max(1, state.worldClock.config.tickRateHz);
  const targetTick = projectedAuthorityTick(state) - (remoteActorInterpolationDelayMs / 1000) * tickRateHz;
  const stationaryHold = remoteActorStationaryHoldByTick(samples, targetTick, tickRateHz);
  if (stationaryHold) return stationaryHold;
  const maxExtrapolationTicks = (remoteActorMaxExtrapolationMs / 1000) * tickRateHz;
  let previous: TickRemoteActorSample | null = null;
  let beforePrevious: TickRemoteActorSample | null = null;
  for (let index = 0; index < samples.length; index += 1) {
    const raw = samples[index]!;
    if (typeof raw.tick !== "number" || !Number.isFinite(raw.tick)) continue;
    const sample = raw as TickRemoteActorSample;
    if (previous && remoteActorSamplesSharePosition(previous, sample)) continue;
    if (targetTick <= sample.tick) {
      if (!previous) return { x: sample.x, y: sample.y };
      return interpolateRemoteActorSamples(previous, sample, targetTick - previous.tick, sample.tick - previous.tick);
    }
    beforePrevious = previous;
    previous = sample;
  }
  if (!previous) return null;
  if (!beforePrevious) return { x: previous.x, y: previous.y };
  return extrapolateRemoteActorSamples(
    beforePrevious,
    previous,
    targetTick - previous.tick,
    previous.tick - beforePrevious.tick,
    maxExtrapolationTicks,
  );
}

function interpolateRemoteActorSamples(
  from: RemoteActorSample,
  to: RemoteActorSample,
  elapsed: number,
  duration: number,
): { x: number; y: number } {
  const t = duration > 0 ? Math.max(0, Math.min(1, elapsed / duration)) : 1;
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  };
}

function extrapolateRemoteActorSamples(
  from: RemoteActorSample,
  to: RemoteActorSample,
  over: number,
  duration: number,
  maxOver: number,
): { x: number; y: number } {
  if (duration <= 0 || over <= 0 || maxOver <= 0) return { x: to.x, y: to.y };
  const t = Math.min(over, maxOver) / duration;
  return {
    x: to.x + (to.x - from.x) * t,
    y: to.y + (to.y - from.y) * t,
  };
}

function projectedAuthorityTick(state: PlayState): number {
  const clock = state.worldClock;
  const elapsedMs = clock.receivedAtMs === null
    ? Math.max(0, state.worldTimeMs)
    : Math.max(0, state.worldTimeMs - clock.receivedAtMs);
  return clock.authoritativeTick + (elapsedMs / 1000) * Math.max(1, clock.config.tickRateHz);
}

export function reconcileServerAuthorityPlayer(state: PlayState, slice: SliceSnapshot, dtMs: number) {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authoritative = state.serverAuthority.actors[playerActorId];
  if (!authoritative || authoritative.areaId !== state.activeAreaId) return;

  state.serverAuthority.authoritativePlayer = { x: authoritative.x, y: authoritative.y };
  const predictionTarget = state.moving
    ? deadReckonedAuthorityPlayerTarget(state, slice, authoritative)
    : predictedAuthorityPlayerTarget(state, slice, {
        x: authoritative.x,
        y: authoritative.y,
      });
  state.serverAuthority.predictionTarget = predictionTarget;
  const authorityDistance = Math.hypot(authoritative.x - state.player.x, authoritative.y - state.player.y);
  state.serverAuthority.maxPlayerCorrectionDistance = Math.max(
    state.serverAuthority.maxPlayerCorrectionDistance,
    Math.round(authorityDistance * 1000) / 1000,
  );
  const dx = predictionTarget.x - state.player.x;
  const dy = predictionTarget.y - state.player.y;
  const distance = Math.hypot(dx, dy);
  state.serverAuthority.predictionErrorCells = Math.round(distance * 1000) / 1000;
  state.serverAuthority.maxPredictionErrorCells = Math.max(
    state.serverAuthority.maxPredictionErrorCells,
    state.serverAuthority.predictionErrorCells,
  );
  if (distance <= 0.015) return;

  if (distance > 2.25) {
    state.player = { ...predictionTarget };
    state.serverAuthority.playerCorrectionCount += 1;
    state.serverAuthority.lastCorrectionCells = Math.round(distance * 1000) / 1000;
    state.serverAuthority.totalCorrectionCells += distance;
    return;
  }

  const correction = state.moving
    ? movingAuthorityCorrection(state, { x: dx, y: dy })
    : { x: dx, y: dy };
  const correctionDistance = Math.hypot(correction.x, correction.y);
  if (correctionDistance <= 0.015) return;

  const tauSeconds = state.moving
    ? localPlayerMovingCorrectionTauSeconds
    : localPlayerIdleCorrectionTauSeconds;
  const alpha = dampedCorrectionAlpha(dtMs, tauSeconds);
  const applied = {
    x: correction.x * alpha,
    y: correction.y * alpha,
  };
  const appliedDistance = Math.hypot(applied.x, applied.y);
  if (appliedDistance <= 0.0001) return;
  state.player = {
    x: state.player.x + applied.x,
    y: state.player.y + applied.y,
  };
  state.serverAuthority.lastCorrectionCells = Math.round(appliedDistance * 1000) / 1000;
  state.serverAuthority.totalCorrectionCells += appliedDistance;
  state.serverAuthority.playerCorrectionCount += 1;
}

function dampedCorrectionAlpha(dtMs: number, tauSeconds: number): number {
  const dtSeconds = Math.max(0, Number.isFinite(dtMs) ? dtMs / 1000 : 0);
  const tau = Math.max(0.001, tauSeconds);
  return Math.max(0, Math.min(1, 1 - Math.exp(-dtSeconds / tau)));
}

export function deadReckonedAuthorityPlayerTarget(
  state: PlayState,
  slice: SliceSnapshot,
  authoritative: ServerAuthorityActorState,
): Cell {
  const anchor = { x: authoritative.x, y: authoritative.y };
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  if (!state.moving || (vector.x === 0 && vector.y === 0)) return anchor;
  const receivedAtMs = Number.isFinite(authoritative.receivedAtMs) ? authoritative.receivedAtMs as number : state.worldTimeMs;
  const elapsedMs = Math.min(
    localPlayerDeadReckonMaxMs,
    Math.max(0, state.worldTimeMs - receivedAtMs),
  );
  if (elapsedMs <= 0) return anchor;
  const durationTicks = authorityMoveIntentDurationTicks(slice.tickRateHz);
  const sprinting = sprintRequestedFromKeys(state.keys)
    && playerHasSprintAction(state, durationTicks, slice.tickRateHz);
  const speedCellsPerSecond = authorityMovementSpeedCellsPerSecond(
    authoritative,
    playerCombatActor(state),
  ) * (sprinting ? authoritySprintSpeedMultiplier(authoritative) : 1);
  const distance = speedCellsPerSecond * (elapsedMs / 1000);
  const area = currentArea(slice, state);
  const target = moveIfUnblocked(anchor, area, state.blocked, {
    x: anchor.x + vector.x * distance,
    y: anchor.y + vector.y * distance,
  }, state.movementBlockers);
  return capPredictionLeadFromAuthority(anchor, target, sprinting);
}

export function predictedAuthorityPlayerTarget(
  state: PlayState,
  slice: SliceSnapshot,
  authoritative: Cell,
): Cell {
  const { moves, speculativeCurrentInput } = pendingAuthorityMoves(state, slice);
  if (moves.length === 0) return { ...authoritative };
  const area = currentArea(slice, state);
  let target = { ...authoritative };
  for (const move of moves) {
    const distance = movementDistanceForDuration(state, move.durationTicks, slice.tickRateHz, move.sprint);
    const delta = movementDeltaForDistance(move.dx, move.dy, distance);
    target = moveIfUnblocked(target, area, state.blocked, {
      x: target.x + delta.x,
      y: target.y + delta.y,
    }, state.movementBlockers);
  }
  const cappedTarget = speculativeCurrentInput
    ? capSpeculativePredictionTargetToLocalPlayer(state, target, authoritative)
    : target;
  return capPredictionLeadFromAuthority(authoritative, cappedTarget, moves.some((move) => move.sprint));
}

function capPredictionLeadFromAuthority(
  authoritative: Cell,
  target: Cell,
  sprintLeadEligible: boolean,
): Cell {
  const dx = target.x - authoritative.x;
  const dy = target.y - authoritative.y;
  const distance = Math.hypot(dx, dy);
  const maxLeadCells = sprintLeadEligible ? localPlayerSprintPredictionLeadCells : localPlayerWalkPredictionLeadCells;
  if (distance <= maxLeadCells || distance <= 0.001) return target;
  const scale = maxLeadCells / distance;
  return {
    x: authoritative.x + dx * scale,
    y: authoritative.y + dy * scale,
  };
}

function currentMovementInputOctant(state: PlayState): Cell | null {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  const dx = Math.sign(vector.x);
  const dy = Math.sign(vector.y);
  if (dx === 0 && dy === 0) return null;
  return { x: dx, y: dy };
}

function moveOpposesInputOctant(move: ServerAuthorityPendingMoveState, inputOctant: Cell): boolean {
  return move.dx * inputOctant.x + move.dy * inputOctant.y < 0;
}

function pendingAuthorityMoves(
  state: PlayState,
  slice: SliceSnapshot,
): { moves: ServerAuthorityPendingMoveState[]; speculativeCurrentInput: boolean } {
  const inputOctant = currentMovementInputOctant(state);
  const inFlightMoves = inputOctant === null
    ? state.serverAuthority.inFlightMoves
    : state.serverAuthority.inFlightMoves.filter((move) => !moveOpposesInputOctant(move, inputOctant));
  const queuedMoves = inputOctant === null
    ? queuedAuthorityMoves(state)
    : queuedAuthorityMoves(state).filter((move) => !moveOpposesInputOctant(move, inputOctant));
  const moves = [...inFlightMoves, ...queuedMoves];
  let speculativeCurrentInput = false;
  // One move of local lead keeps input responsive without hiding bad authority drift.
  const targetPredictionLeadMoves = 1;
  if (state.moving && inputOctant !== null) {
    const durationTicks = authorityMoveIntentDurationTicks(slice.tickRateHz);
    const plannedMove = plannedAuthorityMoveOctant(
      state,
      inputOctant.x,
      inputOctant.y,
      durationTicks,
      movementSprintIntent(state, state.keys)
        && !actorSprintRecoveryLocked(playerAuthorityActor(state)),
      slice.tickRateHz,
    );
    if (!plannedMove) return { moves, speculativeCurrentInput };
    const move = {
      commandId: 0,
      dx: plannedMove.commandVector.dx,
      dy: plannedMove.commandVector.dy,
      durationTicks: plannedMove.commandVector.durationTicks,
      sprint: plannedMove.sprinting,
      facing: state.facing,
      sentAtMs: null,
    };
    while (moves.length < targetPredictionLeadMoves) {
      moves.push(move);
    }
    speculativeCurrentInput = true;
  }
  return { moves, speculativeCurrentInput };
}

function directionFromAuthorityFacing(facing: "Front" | "Right" | "Back" | "Left" | undefined): Direction | undefined {
  switch (facing) {
    case "Front":
      return "front";
    case "Right":
      return "right";
    case "Back":
      return "back";
    case "Left":
      return "left";
    default:
      return undefined;
  }
}

function capSpeculativePredictionTargetToLocalPlayer(state: PlayState, target: Cell, authoritative: Cell): Cell {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  const capped = { ...target };
  if (vector.x !== 0 && (capped.x - state.player.x) * vector.x > 0) {
    capped.x = vector.x > 0
      ? Math.max(authoritative.x, state.player.x)
      : Math.min(authoritative.x, state.player.x);
  }
  if (vector.y !== 0 && (capped.y - state.player.y) * vector.y > 0) {
    capped.y = vector.y > 0
      ? Math.max(authoritative.y, state.player.y)
      : Math.min(authoritative.y, state.player.y);
  }
  return capped;
}

export function movingAuthorityCorrection(
  state: Pick<PlayState, "keys" | "movementKeyOrder"> & Partial<Pick<PlayState, "actors" | "movementInputMode" | "playerActorId" | "worldClock" | "serverAuthority">>,
  error: Cell,
): Cell {
  const vector = movementVectorFromKeys(movementInputKeys(state), state.movementInputMode);
  if (vector.x === 0 && vector.y === 0) return error;

  const parallelError = error.x * vector.x + error.y * vector.y;
  const perpendicular = {
    x: error.x - parallelError * vector.x,
    y: error.y - parallelError * vector.y,
  };
  const perpendicularDistance = Math.hypot(perpendicular.x, perpendicular.y);
  const permittedPredictionLeadCells = sprintCorrectionEligible(state)
    ? localPlayerSprintCorrectionLeadCells
    : localPlayerWalkCorrectionLeadCells;
  const serverAheadCells = parallelError > 0 ? parallelError : 0;
  const excessiveLeadCells = parallelError < -permittedPredictionLeadCells
    ? parallelError + permittedPredictionLeadCells
    : 0;
  const parallelCorrection = serverAheadCells > 0.08 || excessiveLeadCells < -0.08
    ? serverAheadCells + excessiveLeadCells
    : 0;

  if (perpendicularDistance <= 0.045 && parallelCorrection === 0) {
    return { x: 0, y: 0 };
  }

  return {
    x: (perpendicularDistance > 0.045 ? perpendicular.x : 0) + parallelCorrection * vector.x,
    y: (perpendicularDistance > 0.045 ? perpendicular.y : 0) + parallelCorrection * vector.y,
  };
}

function sprintCorrectionEligible(
  state: Pick<PlayState, "keys" | "movementKeyOrder"> & Partial<Pick<PlayState, "actors" | "playerActorId" | "worldClock" | "serverAuthority">>,
): boolean {
  // Shared keyboard/click sprint intent, stripped while authority projects WINDED.
  if (!movementSprintIntent(state, state.keys)) return false;
  const actors = state.actors;
  const playerActorId = state.playerActorId;
  const worldClock = state.worldClock;
  if (!actors || !playerActorId || !worldClock) return false;
  // Narrow required playerActorId before helpers that demand it — no cast.
  const authorityCarrier: Pick<PlayState, "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">> = {
    playerActorId,
    serverAuthority: state.serverAuthority,
  };
  if (actorSprintRecoveryLocked(playerAuthorityActor(authorityCarrier))) return false;
  const sprintCarrier: Pick<PlayState, "actors" | "playerActorId"> & Partial<Pick<PlayState, "serverAuthority">> = {
    actors,
    playerActorId,
    serverAuthority: state.serverAuthority,
  };
  return playerHasSprintAction(sprintCarrier, 1, worldClock.config.tickRateHz);
}

export function tickRuntimeTimers(state: PlayState, dtMs: number) {
  state.cooldownMs = Math.max(0, state.cooldownMs - dtMs);
  if (state.cooldownMs <= 0) state.cooldownTotalMs = 0;
  state.equipPulseMs = Math.max(0, state.equipPulseMs - dtMs);
  state.transitionCooldownMs = Math.max(0, state.transitionCooldownMs - dtMs);
  state.transitionFlashMs = Math.max(0, state.transitionFlashMs - dtMs);
  expireWeaponFireAnimations(state);
}

export function updateActorPresentationTimers(state: PlayState, dtMs: number) {
  for (const actor of Object.values(state.actors)) {
    actor.hitFlashMs = Math.max(0, actor.hitFlashMs - dtMs);
  }
}

export function updateChatBubbleTtls(state: PlayState, dtMs: number) {
  state.chatBubbles = state.chatBubbles
    .map((bubble) => ({ ...bubble, ttlMs: Math.max(0, bubble.ttlMs - dtMs) }))
    .filter((bubble) => bubble.ttlMs > 0);
}


export function applyAreaTransition(state: PlayState, slice: SliceSnapshot, sfx: SfxPlayer) {
  const transition = state.transitionCooldownMs > 0
    ? null
    : transitionAtPlayerPosition(transitionsForArea(slice, state.activeAreaId), state.player);
  if (applyAreaTransitionState(state, slice)) {
    if (transition) {
      state.authorityCommands ??= createAuthorityCommandQueue();
      enqueueAuthorityTransitionCommand(
        state.authorityCommands,
        transition.id,
        authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
      );
    }
    sfx.play("area_transition");
  }
}

export function attemptMove(state: PlayState, slice: SliceSnapshot, next: Cell, axis?: "x" | "y") {
  const area = currentArea(slice, state);
  const before = state.player;
  state.player = moveIfUnblocked(state.player, area, state.blocked, next, state.movementBlockers);
  enqueueAuthorityMovementForCellCrossing(state, slice, before, state.player, axis);
}

export function enqueueAuthorityMovementForCellCrossing(
  state: PlayState,
  slice: Pick<SliceSnapshot, "tick" | "tickRateHz">,
  before: Cell,
  after: Cell,
  axis?: "x" | "y",
) {
  const beforeCell = { x: Math.floor(before.x), y: Math.floor(before.y) };
  const afterCell = { x: Math.floor(after.x), y: Math.floor(after.y) };
  const deltaX = afterCell.x - beforeCell.x;
  const deltaY = afterCell.y - beforeCell.y;
  if (deltaX === 0 && deltaY === 0) return;

  const durationTicks = authorityMoveDurationTicks(slice.tickRateHz);
  const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  state.authorityCommands ??= createAuthorityCommandQueue();

  if (axis !== "y") {
    const stepX = Math.sign(deltaX);
    for (let i = 0; i < Math.abs(deltaX); i += 1) {
      enqueueAuthorityMoveCommand(state.authorityCommands, stepX, 0, durationTicks, issuedAtTick);
    }
  }
  if (axis !== "x") {
    const stepY = Math.sign(deltaY);
    for (let i = 0; i < Math.abs(deltaY); i += 1) {
      enqueueAuthorityMoveCommand(state.authorityCommands, 0, stepY, durationTicks, issuedAtTick);
    }
  }
}

export function authorityMoveDurationTicks(tickRateHz: number): number {
  const hz = Number.isFinite(tickRateHz) && tickRateHz > 0 ? tickRateHz : 20;
  const ticksPerCell = (1 / playerSpeedCellsPerSecond) * hz;
  return Math.max(1, Math.min(30, Math.round(ticksPerCell)));
}
