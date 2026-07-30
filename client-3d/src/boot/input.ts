import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCollectExtractorCommand,
  enqueueAuthorityCrankExtractorCommand,
  enqueueAuthorityDeathblowCommand,
  enqueueAuthorityDestroyExtractorCommand,
  enqueueAuthorityInsertBatteryCommand,
  enqueueAuthorityPackUpCampCommand,
  enqueueAuthorityQueueCombatActionCommand,
  enqueueAuthorityStopCrankCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import { pointInsideCampInteractionFootprint } from "@successor/client/src/slice-core/campSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { isMovementKey } from "@successor/client/src/slice-core/geometry";
import { isTextInputTarget } from "@successor/client/src/slice-core/inputController";
import { reloadActiveWeaponAuthoritative, activeWeaponSpec } from "@successor/client/src/slice-core/loadoutSystem";
import { corpseHasLootSurface, cycleInteractionSelection } from "@successor/client/src/slice-core/interactionSystem";
import { isRotationLockKey, rotationLocked, setClickMoveTarget, toggleSprint } from "@successor/client/src/slice-core/movementSystem";
import { saveRuntimeSettings, gameplayCodeForInput, inputActionForCode } from "@successor/client/src/slice-core/settingsSystem";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { clampZoomPercent } from "../render/camera";
import type { SuccessorThreeRenderer } from "../render/SuccessorThreeRenderer";
import { pickActorAtScreenPoint3d, pickPropAtScreenPoint3d } from "../render/picking";
import type { WorldPropPickResult } from "../render/props";
import type { PlayerCorpsePickResult } from "../render/playerCorpses";
import type { ExtractorPickResult } from "../render/extractors";
import type { CampPickResult } from "../render/camps";
import type { BuildingController } from "../render/building";
import {
  bestBatteryRow,
  extractorRadialActions,
} from "../ui/extraction/actions";
import { campRadialActions, disarmPackUpConfirm } from "../ui/camp/actions";
import { isLocalInventoryContainer } from "../ui/inventory/data";
import { trainerRadialActions } from "../ui/dialogue/trainerRadial";
import { actorIsTradablePlayerPawn, tradeRadialAction } from "../ui/trade/tradeRadial";
import type { ToolbarController } from "../ui/hud/toolbar";
import type { ContextRadial, RadialAction } from "../ui/windows/contextRadial";
import { setSelectedTarget } from "@successor/client/src/slice-core/targetSelectionSystem";
import { cycleTargetOutward, isLockableHostile, setExplicitLockTarget } from "../combat/softLock";
import { canIssueGroundMove, clearEngagementFocusForGroundMove } from "./groundMove";
import { CYCLE_INTERACT_KEY_CODE } from "../overlay/interactChip";
import {
  actorPointerGrammarDecision,
  classifyPropClick,
  classifyActorClick,
  createActorClickMemory,
  createPropClickMemory,
  defaultActorAction,
  propPointerGrammarDecision,
  resetActorClickMemory,
  resetPropClickMemory,
} from "./clickRouting";
import { recordInputEvent } from "../debug/inputRecorder";
import { successorMoveTraceEnabled, recordSuccessorMoveTrace } from "@successor/client/src/slice-core/moveTraceSystem";
import { isProfessionTrainerActor } from "@successor/client/src/slice-core/professionTrainerSystem";
import { heldTicketsForTerminal, setActiveTravelTerminal, withinTerminalRange } from "../ui/travel/travelSystem";
import { useBestTicketAtTerminal } from "../ui/travel/travelActions";
import { isLoadScreenActive } from "../ui/loadScreen";

/**
 * Game input — gameplay keys/mouse only. Window hotkeys, Escape and
 * everything window-shaped live in the WindowManager's own keydown listener.
 *
 * Cursor policy (owner spec 2026-07-04): the 3D client is always in the
 * normal free-cursor presentation. Mouse capture, projected aim, and manual
 * mode toggles are retired here; the shared toggle binding is inert.
 *
 * Click grammar:
 *   - LMB actor: target bracket / explicit soft-lock only.
 *   - Double-LMB actor (≤350ms): attack if attackable, otherwise examine.
 *   - RMB actor: target + context radial at the cursor.
 *   - LMB interactable prop: examine.
 *   - Double-LMB interactable prop: default prop action (LOOT window on caches).
 *   - RMB interactable prop: prop radial (Loot + Examine).
 *   - Double-LMB / RMB corpse: LOOT window (per-stack take).
 *   - LMB ground: no combat action.
 *   - RMB-hold ground: rotation-lock strafe presentation.
 */
export interface Successor3dInputController {
  dispose: () => void;
}

/** Persistent run toggle key (edge-triggered; KeyX is free across gameplay,
 *  window hotkeys and toolbar defaults — same audit as KeyV). */
export const SPRINT_TOGGLE_KEY_CODE = "KeyX";

/** Build-mode toggle key (edge-triggered). KeyN is free across gameplay binds
 *  (WASD/Shift/Space/R/F/I/C/O/Semicolon), window hotkeys (C/K/O/P/B/G/I/M),
 *  toolbar defaults, Tab, X and V — KeyB belongs to the Action Browser window
 *  and KeyV to interact-chip cycling, so neither can own the builder. */
export const BUILD_TOGGLE_KEY_CODE = "KeyN";

export interface InstallSuccessor3dInputParams {
  target: Window;
  renderer: SuccessorThreeRenderer;
  state: PlayState;
  slice: SliceSnapshot;
  sfx: SfxPlayer;
  toolbar: ToolbarController;
  radial: ContextRadial;
  /** World interact (F-down) — dispatched by the HUD interact prompt controller. */
  onInteract: () => void;
  /** World interact (F-up) — completes the tap-vs-hold decision (tap opens the
   *  loot window; a fired hold is swallowed). */
  onInteractRelease: () => void;
  /** Open/refresh the combat-visible target examine pane for an explicit examine action. */
  onExamineActor: (actorId: string) => void;
  /** Open/refresh the transient prop examine pane for an explicit examine action. */
  onExamineProp: (propId: string) => void;
  /** Travel terminal interaction — binds the active terminal and opens the travel window. */
  onOpenTravelTerminal: (propId: string) => void;
  /** Bank terminal interaction — binds the active terminal and opens the BANK window. */
  onOpenBankTerminal: (propId: string) => void;
  /** Clone terminal interaction — binds the active terminal and opens the CLONING window. */
  onOpenCloneTerminal: (propId: string) => void;
  /** PA terminal interaction — binds the active terminal and opens the ASSOCIATION window. */
  onOpenPaTerminal: (propId: string) => void;
  /** Commerce trade terminal — opens the normal District Exchange / shared-storage UI. */
  onOpenExchange: (propId: string) => void;
  /** Corpse/cache/player-corpse loot — binds the loot target and opens the LOOT window. */
  onOpenLoot: (target: { kind: "corpse" | "cache" | "playerCorpse"; id: string; container?: string }) => void;
  /** Trainer conversation — binds the converse target and opens the CONVERSE window. */
  onConverseActor: (actorId: string) => void;
  /** Secure trade — opens the TRADE table with the picked player pawn. */
  /** Optional build-mode owner; when active it gets first refusal on world input. */
  buildingController?: BuildingController;
  /** N toggles build mode when the controller is currently inactive (B stays
   *  the Action Browser window hotkey; V stays interact-chip cycling). */
  onBuildToggle?: () => void;
  onTradeActor: (actorId: string) => void;
}

export function installSuccessor3dInput(params: InstallSuccessor3dInputParams): Successor3dInputController {
  const { target, renderer, state, slice, sfx, toolbar, radial, buildingController, onBuildToggle, onInteract, onInteractRelease, onExamineActor, onExamineProp, onOpenTravelTerminal, onOpenBankTerminal, onOpenCloneTerminal, onOpenPaTerminal, onOpenExchange, onOpenLoot, onConverseActor, onTradeActor } = params;
  const canvas = renderer.canvas;
  const actorClickMemory = createActorClickMemory();
  const propClickMemory = createPropClickMemory();
  const pointerDownActors = new Map<number, string | null>();
  const pointerDownRoutes = new Map<number, string>();
  state.movementInputMode = "world";
  // 3D targeting is explicit: world picks and target cycling publish the
  // current Roll-combat soft lock directly.

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (isTextInputTarget(event.target)) return;
    // In transit: the planetfall load screen owns the frame. Keydowns are
    // swallowed (keyups still flow below so held keys never stick).
    if (isLoadScreenActive()) {
      event.preventDefault();
      return;
    }
    if (event.code === BUILD_TOGGLE_KEY_CODE && buildingController) {
      if (!event.repeat) {
        if (buildingController.isActive()) buildingController.deactivate();
        else onBuildToggle?.();
      }
      event.preventDefault();
      return;
    }
    if (buildingController?.handleKey(event)) {
      event.preventDefault();
      return;
    }

    const action = inputActionForCode(state.settings, event.code);
    if (action === "keyboardFire") {
      event.preventDefault();
      // Hold the shared trigger key; the runtime turns its edge into the
      // server-owned repeat attack and cancels that repeat on key release.
      const gameplayCode = gameplayCodeForInput(state.settings, event.code);
      if (gameplayCode) state.keys.add(gameplayCode);
      return;
    }
    if (action === "reload") {
      event.preventDefault();
      if (!event.repeat) {
        const spec = activeWeaponSpec(state);
        const reloaded = reloadActiveWeaponAuthoritative(state, slice);
        sfx.play(spec && reloaded ? spec.reloadSfx : "ui_button_tick");
      }
      return;
    }
    if (action === "interact") {
      event.preventDefault();
      if (!event.repeat) onInteract();
      return;
    }
    // Tab cycles explicit target outward in the always-cursor grammar.
    if (event.code === "Tab") {
      event.preventDefault();
      if (!event.repeat) {
        const cycled = cycleTargetOutward(state, state.serverAuthority.playerActorId ?? state.playerActorId);
        if (cycled) {
          state.selectedActorId = cycled;
          sfx.play("ui_button_tick");
        }
      }
      return;
    }
    // V cycles the nearest-interactables list when more than one is in reach
    // (the chip advertises `+n ·V·`). F still fires the act verb on the
    // selected option. KeyV is verified free across gameplay + window binds
    // (WASD/Shift/Space/R/F/I, window hotkeys C/K/O/P/B/G, toolbar, Tab).
    if (event.code === CYCLE_INTERACT_KEY_CODE) {
      event.preventDefault();
      if (!event.repeat && state.interactions.options.length > 1) {
        cycleInteractionSelection(state, 1);
        sfx.play("ui_button_tick");
      }
      return;
    }
    // X toggles the persistent run (checked before toolbar binds, Tab/V
    // precedent). The intent survives the winded lockout — the movement
    // system stops requesting sprint while locked and resumes on unlock.
    if (event.code === SPRINT_TOGGLE_KEY_CODE) {
      event.preventDefault();
      if (!event.repeat) {
        toggleSprint(state);
        sfx.play("ui_button_tick");
      }
      return;
    }
    // Toolbar binds — before gameplay movement mapping.
    if (!event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && toolbar.pressCode(event.code)) {
      event.preventDefault();
      return;
    }
    const gameplayCode = gameplayCodeForInput(state.settings, event.code);
    if (!gameplayCode) return;
    event.preventDefault();
    if (isRotationLockKey(gameplayCode) && !event.repeat && state.rotationLockFacing === null) {
      state.rotationLockFacing = state.facing;
    }
    const movementKey = isMovementKey(gameplayCode);
    const insertedMovementKey = movementKey && !state.movementKeyOrder.includes(gameplayCode);
    if (insertedMovementKey) {
      state.movementKeyOrder.push(gameplayCode);
    }
    state.keys.add(gameplayCode);
    if (movementKey && successorMoveTraceEnabled()) {
      recordSuccessorMoveTrace({
        kind: "input-keydown",
        code: event.code,
        gameplayCode,
        repeat: event.repeat,
        inserted: insertedMovementKey,
        heldKeys: movementTraceKeyList(state.keys),
        movementKeyOrder: movementTraceKeyList(state.movementKeyOrder),
        playerX: Number(state.player.x.toFixed(3)),
        playerY: Number(state.player.y.toFixed(3)),
        snapshotTick: state.serverAuthority.snapshotTick,
      });
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    const action = inputActionForCode(state.settings, event.code);
    const gameplayCode = gameplayCodeForInput(state.settings, event.code);
    if (isTextInputTarget(event.target)) {
      if (!gameplayCode || !isMovementKey(gameplayCode)) return;
      event.preventDefault();
      state.keys.delete(gameplayCode);
      state.movementKeyOrder = state.movementKeyOrder.filter((code) => code !== gameplayCode);
      return;
    }
    if (action === "keyboardFire") {
      event.preventDefault();
      if (gameplayCode) state.keys.delete(gameplayCode);
      return;
    }
    if (action === "interact") {
      event.preventDefault();
      onInteractRelease();
      return;
    }
    if (!gameplayCode) return;
    event.preventDefault();
    state.keys.delete(gameplayCode);
    if (isMovementKey(gameplayCode)) {
      state.movementKeyOrder = state.movementKeyOrder.filter((code) => code !== gameplayCode);
    }
    if (isRotationLockKey(gameplayCode) && !rotationLocked(state.keys)) {
      state.rotationLockFacing = null;
    }
  };

  // ── Mouse ────────────────────────────────────────────────────────────────
  const localPlayerActorId = (): string => state.serverAuthority.playerActorId ?? state.playerActorId;

  const actorAttackable = (actorHitId: string): boolean => {
    const me = state.serverAuthority.actors[localPlayerActorId()];
    const picked = state.serverAuthority.actors[actorHitId];
    if (!me || !picked) return false;
    // Trainers, civilians/neutrals and corpses may be selected/examined, but
    // they are not valid default-attack targets even if they carry faction data.
    if (picked.role === "profession_trainer" || picked.pvpStatus === "none" || picked.lifeState !== "alive") return false;
    return isLockableHostile(picked, me);
  };

  const openExamineActor = (actorHitId: string): void => {
    state.examineActorId = actorHitId;
    onExamineActor(actorHitId);
  };

  const openExamineProp = (propId: string): void => {
    onExamineProp(propId);
  };

  const focusPickedActor = (actorHitId: string | null): void => {
    if (!actorHitId) {
      clearEngagementFocusForGroundMove(state);
      resetActorClickMemory(actorClickMemory);
      return;
    }
    const lockable = actorAttackable(actorHitId);
    setSelectedTarget(state, actorHitId, lockable);
    setExplicitLockTarget(lockable ? actorHitId : null);
  };

  const notePointerDown = (button: number, actorId: string | null, routed: string): void => {
    pointerDownActors.set(button, actorId);
    pointerDownRoutes.set(button, routed);
    recordInputEvent({ kind: "down", button, actorId, routed });
  };

  const notePointerUp = (button: number): void => {
    const actorId = pointerDownActors.get(button) ?? null;
    const routed = pointerDownRoutes.get(button) ?? "release";
    pointerDownActors.delete(button);
    pointerDownRoutes.delete(button);
    recordInputEvent({ kind: "up", button, actorId, routed });
  };

  const queueBasicShot = (actorHitId: string, source: "dblclick" | "ability" | "radial"): void => {
    const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthorityQueueCombatActionCommand(state.authorityCommands, "basic_shot", actorHitId, issuedAtTick);
    if (!queued) return;
    recordInputEvent({
      kind: "command",
      actorId: actorHitId,
      routed: "queueCombatAction",
      commandKind: "basic_shot",
      source,
    });
  };

  const propCacheEmptied = (propId: string): boolean => {
    return state.serverAuthority.propStates?.[propId]?.cacheEmptied === true;
  };

  const openLootForProp = (prop: WorldPropPickResult): boolean => {
    if (propCacheEmptied(prop.propId)) {
      state.status = `${prop.label} is empty`;
      return false;
    }
    sfx.play("ui_button_tick");
    const authoredContainer = slice.props?.find((candidate) => candidate.id === prop.propId)?.container;
    onOpenLoot({
      kind: "cache",
      id: prop.propId,
      ...(authoredContainer !== undefined ? { container: authoredContainer } : {}),
    });
    return true;
  };

  const performDefaultPropAction = (prop: WorldPropPickResult): void => {
    if (prop.kind === "travel_terminal") {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultTravel" });
      setActiveTravelTerminal(prop.propId);
      onOpenTravelTerminal(prop.propId);
      return;
    }
    if (prop.kind === "bank_terminal") {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultBank" });
      onOpenBankTerminal(prop.propId);
      return;
    }
    if (prop.kind === "clone_terminal") {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultClone" });
      onOpenCloneTerminal(prop.propId);
      return;
    }
    if (prop.kind === "pa_terminal") {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultPa" });
      onOpenPaTerminal(prop.propId);
      return;
    }
    if (prop.kind === "trade_terminal") {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultExchange" });
      onOpenExchange(prop.propId);
      return;
    }
    recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "propDefaultLoot" });
    openLootForProp(prop);
  };

  /**
   * Trainer check mirrors actorAttackable's source (authority actor role,
   * slice actor as the fixture-local fallback) — alive trainers converse.
   */
  const actorIsConversableTrainer = (actorHitId: string): boolean => {
    const picked = state.serverAuthority.actors[actorHitId];
    if (picked) {
      return picked.lifeState === "alive" && isProfessionTrainerActor({ role: picked.role ?? "" });
    }
    const local = slice.actors.find((candidate) => candidate.id === actorHitId);
    return local !== undefined && isProfessionTrainerActor(local);
  };

  /** Client-side range estimate for the TRADE row's honest gate (server
   *  re-validates): authority-cell distance, null when unmeasurable. */
  const tradeDistanceCells = (actorHitId: string): number | null => {
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[meId];
    const them = state.serverAuthority.actors[actorHitId];
    if (!me || !them || me.areaId !== them.areaId) return null;
    return Math.hypot(them.x - me.x, them.y - me.y);
  };

  const performDefaultActorAction = (actorHitId: string): void => {
    const picked = state.serverAuthority.actors[actorHitId];
    if (picked && corpseHasLootSurface(picked, state)) {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: actorHitId, routed: "defaultLoot", source: "dblclick" });
      sfx.play("ui_button_tick");
      onOpenLoot({ kind: "corpse", id: actorHitId });
      return;
    }
    // Trainers: the default action is the conversation (owner ask — talk,
    // don't get plopped onto the skills menu). Same verb as the radial default.
    if (actorIsConversableTrainer(actorHitId)) {
      recordInputEvent({ kind: "dblclick", button: 0, actorId: actorHitId, routed: "defaultConverse", source: "dblclick" });
      sfx.play("ui_button_tick");
      onConverseActor(actorHitId);
      return;
    }
    const action = defaultActorAction(actorAttackable(actorHitId));
    const routed = action === "attack" ? "defaultAttack" : "defaultExamine";
    recordInputEvent({ kind: "dblclick", button: 0, actorId: actorHitId, routed, source: "dblclick" });
    if (action === "attack") {
      queueBasicShot(actorHitId, "dblclick");
    } else {
      openExamineActor(actorHitId);
    }
  };

  const openActorRadial = (actorHitId: string, event: MouseEvent): void => {
    focusPickedActor(actorHitId);
    const attackable = actorAttackable(actorHitId);
    const picked = state.serverAuthority.actors[actorHitId];
    const localCombat = state.actors[actorHitId];
    const downed = picked?.lifeState === "downed" || localCombat?.lifeState === "downed";
    const lootSurface = Boolean(picked && corpseHasLootSurface(picked, state));
    // Live trainers lead with CONVERSE (dead lootable ones stay corpses first).
    const trainer = !lootSurface && actorIsConversableTrainer(actorHitId);
    const actions: RadialAction[] = lootSurface
      ? [
        { id: "loot", label: "Loot", enabled: true, note: null },
        { id: "examine", label: "Examine", enabled: true, note: null },
      ]
      : trainer
        ? trainerRadialActions()
        : attackable
          ? [
            { id: "attack", label: "Attack", enabled: true, note: null },
            { id: "examine", label: "Examine", enabled: true, note: null },
          ]
          : [
            { id: "examine", label: "Examine", enabled: true, note: null },
            { id: "attack", label: "Attack", enabled: false, note: "No attack route" },
          ];
    // Deathblow is a presentation affordance only when the selected actor is
    // visibly downed. Rust still decides whether the queued command is legal.
    if (downed && state.selectedActorId === actorHitId) {
      actions.unshift({ id: "deathblow", label: "Deathblow", enabled: true, note: null });
    }
    // Player pawns grow the TRADE row (CONVERSE-sibling tier — owner spec);
    // out-of-range shows the honest reason instead of a server deny.
    if (!lootSurface && !trainer && actorIsTradablePlayerPawn(picked)) {
      actions.push(tradeRadialAction(tradeDistanceCells(actorHitId)));
    }
    recordInputEvent({ kind: "radial", button: 2, actorId: actorHitId, routed: "openRadial", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        const routed = id === "attack" ? "radialAttack" : id === "examine" ? "radialExamine" : `radial:${id}`;
        recordInputEvent({ kind: "radial", actorId: actorHitId, routed, source: "radial" });
        focusPickedActor(actorHitId);
        if (id === "deathblow") {
          setSelectedTarget(state, actorHitId, true);
          const queued = enqueueAuthorityDeathblowCommand(
            state.authorityCommands,
            actorHitId,
            authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
          );
          if (queued) sfx.play("ui_button_tick");
          return;
        }
        if (id === "converse") {
          sfx.play("ui_button_tick");
          onConverseActor(actorHitId);
          return;
        }
        if (id === "trade") {
          sfx.play("ui_button_tick");
          onTradeActor(actorHitId);
          return;
        }
        if (id === "loot") {
          sfx.play("ui_button_tick");
          onOpenLoot({ kind: "corpse", id: actorHitId });
          return;
        }
        if (id === "attack") {
          if (actorAttackable(actorHitId)) queueBasicShot(actorHitId, "radial");
          return;
        }
        if (id === "examine") openExamineActor(actorHitId);
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  const openTravelTerminalRadial = (prop: WorldPropPickResult, event: MouseEvent): void => {
    const held = heldTicketsForTerminal(state, prop.propId);
    const inRange = withinTerminalRange(state, slice, prop.propId);
    const actions: RadialAction[] = [
      { id: "travel", label: "Travel Menu", enabled: true, note: null },
      {
        id: "ticket",
        label: "Use Ticket",
        enabled: held.length > 0 && inRange,
        note: held.length === 0 ? "No ticket for this terminal" : inRange ? null : "Too far from terminal",
      },
      { id: "examine", label: "Examine", enabled: true, note: null },
    ];
    recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: "propRadialTravel", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        recordInputEvent({ kind: "radial", actorId: null, routed: `travelRadial:${id}`, source: "radial" });
        if (id === "travel") {
          setActiveTravelTerminal(prop.propId);
          onOpenTravelTerminal(prop.propId);
          return;
        }
        if (id === "ticket") {
          const result = useBestTicketAtTerminal(state, slice, prop.propId);
          if (result === "queued") sfx.play("ui_button_tick");
          else state.status = result === "no_ticket" ? "No ticket for this terminal" : "Too far from terminal";
          return;
        }
        if (id === "examine") openExamineProp(prop.propId);
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  const openPropRadial = (prop: WorldPropPickResult, event: MouseEvent): void => {
    const emptied = propCacheEmptied(prop.propId);
    if (prop.kind === "travel_terminal") {
      openTravelTerminalRadial(prop, event);
      return;
    }
    if (prop.kind === "bank_terminal" || prop.kind === "clone_terminal" || prop.kind === "pa_terminal" || prop.kind === "trade_terminal") {
      // Terminal kiosks share one radial shape: screen verb + examine.
      const screenLabel = prop.kind === "bank_terminal" ? "Open Bank"
        : prop.kind === "clone_terminal" ? "Cloning Menu"
          : prop.kind === "pa_terminal" ? "Association Registry"
            : "District Exchange";
      const routedKind = prop.kind === "bank_terminal" ? "propRadialBank"
        : prop.kind === "clone_terminal" ? "propRadialClone"
          : prop.kind === "pa_terminal" ? "propRadialPa"
            : "propRadialExchange";
      const kioskActions: RadialAction[] = [
        { id: "screen", label: screenLabel, enabled: true, note: null },
        { id: "examine", label: "Examine", enabled: true, note: null },
      ];
      recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: routedKind, source: "radial" });
      radial.openFor(event.clientX, event.clientY, kioskActions, {
        onAction: (id) => {
          recordInputEvent({ kind: "radial", actorId: null, routed: `terminalRadial:${id}`, source: "radial" });
          if (id === "screen") {
            sfx.play("ui_button_tick");
            if (prop.kind === "bank_terminal") onOpenBankTerminal(prop.propId);
            else if (prop.kind === "clone_terminal") onOpenCloneTerminal(prop.propId);
            else if (prop.kind === "pa_terminal") onOpenPaTerminal(prop.propId);
            else onOpenExchange(prop.propId);
            return;
          }
          if (id === "examine") openExamineProp(prop.propId);
        },
        onDisabled: (note) => {
          if (note) state.status = note;
        },
      });
      return;
    }
    const actions: RadialAction[] = [
      { id: "open", label: "Loot", enabled: !emptied, note: emptied ? "Empty" : null },
      { id: "examine", label: "Examine", enabled: true, note: null },
    ];
    recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: "propRadial", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        const routed = id === "open" ? "propRadialLoot" : id === "examine" ? "propRadialExamine" : `propRadial:${id}`;
        recordInputEvent({ kind: "radial", actorId: null, routed, source: "radial" });
        if (id === "open") {
          openLootForProp(prop);
          return;
        }
        if (id === "examine") openExamineProp(prop.propId);
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  const pickActorAtPointer = (event: MouseEvent, nowMs: number): string | null => {
    const screenX = event.offsetX;
    const screenY = event.offsetY;
    const point = renderer.screenOffsetToWorldGround(screenX, screenY);
    if (!point) return null;
    return pickActorAtScreenPoint3d(
      slice,
      state,
      nowMs,
      screenX,
      screenY,
      point.x,
      point.z,
      renderer,
    );
  };

  const pickPropAtPointer = (event: MouseEvent): WorldPropPickResult | null => {
    return pickPropAtScreenPoint3d(renderer, event.offsetX, event.offsetY);
  };

  const pickOwnExtractorAtPointer = (event: MouseEvent): ExtractorPickResult | null => {
    const pick = renderer.pickExtractorAtScreenPoint(event.offsetX, event.offsetY);
    // Foreign extractors are scenery — no verbs, no pointer capture.
    return pick && pick.isOwner ? pick : null;
  };

  const pickOwnCampAtPointer = (event: MouseEvent): CampPickResult | null => {
    const pick = renderer.pickCampAtScreenPoint(event.offsetX, event.offsetY);
    // Foreign camps are scenery — the auto-door serves anyone, verbs do not.
    return pick && pick.isOwner ? pick : null;
  };

  const liveExtractor = (extractorId: string) =>
    state.serverAuthority.placedExtractors.find((entry) => entry.extractorId === extractorId) ?? null;

  const extractorDistanceCells = (extractor: { cellX: number; cellY: number }): number =>
    Math.hypot(extractor.cellX - state.player.x, extractor.cellY - state.player.y);

  /** Same precedence as the F verb: release crank, else bank hopper, else crank. */
  const performDefaultExtractorAction = (extractorId: string): void => {
    const extractor = liveExtractor(extractorId);
    if (!extractor) return;
    const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = extractor.mode === "manual"
      ? enqueueAuthorityStopCrankCommand(state.authorityCommands, issuedAtTick)
      : extractor.hopperPct > 0
        ? enqueueAuthorityCollectExtractorCommand(state.authorityCommands, extractorId, issuedAtTick)
        : enqueueAuthorityCrankExtractorCommand(state.authorityCommands, extractorId, issuedAtTick);
    if (queued) sfx.play("ui_button_tick");
  };

  const openExtractorRadial = (pick: ExtractorPickResult, event: MouseEvent, confirmDestroy = false): void => {
    const extractor = liveExtractor(pick.extractorId);
    if (!extractor) return;
    const battery = bestBatteryRow(state.inventory, (container) => isLocalInventoryContainer(state, container));
    const actions = extractorRadialActions({
      extractor,
      distanceCells: extractorDistanceCells(extractor),
      battery,
      confirmDestroy,
    });
    recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: confirmDestroy ? "extractorRadialConfirm" : "extractorRadial", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        recordInputEvent({ kind: "radial", actorId: null, routed: `extractorRadial:${id}`, source: "radial" });
        const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
        if (id === "crank") {
          if (enqueueAuthorityCrankExtractorCommand(state.authorityCommands, pick.extractorId, issuedAtTick)) sfx.play("ui_button_tick");
          return;
        }
        if (id === "stop-crank") {
          enqueueAuthorityStopCrankCommand(state.authorityCommands, issuedAtTick);
          sfx.play("ui_button_tick");
          return;
        }
        if (id === "insert-battery") {
          if (!battery || battery.stackId === undefined) return;
          const queued = enqueueAuthorityInsertBatteryCommand(state.authorityCommands, {
            extractorId: pick.extractorId,
            container: battery.container,
            stackId: battery.stackId,
            variantId: battery.variantId,
          }, issuedAtTick);
          if (queued) sfx.play("ui_button_tick");
          return;
        }
        if (id === "collect") {
          if (enqueueAuthorityCollectExtractorCommand(state.authorityCommands, pick.extractorId, issuedAtTick)) sfx.play("ui_button_tick");
          return;
        }
        if (id === "destroy") {
          // Confirm guard: pack-up forfeits the hopper — re-open armed.
          openExtractorRadial(pick, event, true);
          return;
        }
        if (id === "confirm-destroy") {
          if (enqueueAuthorityDestroyExtractorCommand(state.authorityCommands, pick.extractorId, issuedAtTick)) sfx.play("ui_button_tick");
          return;
        }
        // cancel-destroy: dismiss only.
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  const openCampRadial = (pick: CampPickResult, event: MouseEvent, confirmPackUp = false): void => {
    const camp = state.serverAuthority.placedCamps.find((entry) => entry.campId === pick.campId) ?? null;
    if (!camp) return;
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const player = state.serverAuthority.actors[playerActorId];
    const actions = campRadialActions({
      camp,
      insideFootprint: pointInsideCampInteractionFootprint(
        camp,
        player?.areaId ?? state.activeAreaId,
        player?.x ?? state.player.x,
        player?.y ?? state.player.y,
      ),
      confirmPackUp,
    });
    recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: confirmPackUp ? "campRadialConfirm" : "campRadial", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        recordInputEvent({ kind: "radial", actorId: null, routed: `campRadial:${id}`, source: "radial" });
        if (id === "pack-up") {
          // Confirm guard: the kit was consumed on placement — re-open armed
          // so the strike names its real cost before it happens.
          openCampRadial(pick, event, true);
          return;
        }
        if (id === "confirm-pack-up") {
          disarmPackUpConfirm();
          const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
          if (enqueueAuthorityPackUpCampCommand(state.authorityCommands, issuedAtTick)) sfx.play("ui_button_tick");
          return;
        }
        // cancel-pack-up / abandon-countdown: dismiss only.
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  // ── Player corpse bags (dedicated world props, public salvage) ──────────
  const openPlayerCorpseRadial = (pick: PlayerCorpsePickResult, event: MouseEvent): void => {
    const actions: RadialAction[] = [
      { id: "loot", label: "Loot", enabled: true, note: null },
    ];
    recordInputEvent({ kind: "radial", button: 2, actorId: null, routed: "playerCorpseRadial", source: "radial" });
    radial.openFor(event.clientX, event.clientY, actions, {
      onAction: (id) => {
        recordInputEvent({ kind: "radial", actorId: null, routed: `playerCorpseRadial:${id}`, source: "radial" });
        if (id === "loot") {
          sfx.play("ui_button_tick");
          onOpenLoot({ kind: "playerCorpse", id: pick.corpseId });
        }
      },
      onDisabled: (note) => {
        if (note) state.status = note;
      },
    });
  };

  const handleLeftPointerDown = (event: MouseEvent, nowMs: number): void => {
    const actorHitId = pickActorAtPointer(event, nowMs);
    if (actorHitId) {
      resetPropClickMemory(propClickMemory);
      const attackable = actorAttackable(actorHitId);
      const doubleClick = classifyActorClick(actorClickMemory, actorHitId, nowMs) === "defaultAction";
      const routed = actorPointerGrammarDecision({ button: "left", actorHit: true, doubleClick, attackable });
      notePointerDown(0, actorHitId, routed);
      focusPickedActor(actorHitId);
      if (doubleClick) {
        performDefaultActorAction(actorHitId);
        resetActorClickMemory(actorClickMemory);
      }
      return;
    }

    const corpseHit = renderer.pickPlayerCorpseAtScreenPoint(event.offsetX, event.offsetY);
    if (corpseHit) {
      resetActorClickMemory(actorClickMemory);
      const doubleClick = classifyPropClick(propClickMemory, corpseHit.corpseId, nowMs) === "defaultAction";
      const routed = propPointerGrammarDecision({ button: "left", doubleClick });
      notePointerDown(0, null, routed);
      if (doubleClick) {
        recordInputEvent({ kind: "dblclick", button: 0, actorId: null, routed: "playerCorpseDefaultLoot" });
        sfx.play("ui_button_tick");
        onOpenLoot({ kind: "playerCorpse", id: corpseHit.corpseId });
        resetPropClickMemory(propClickMemory);
      }
      return;
    }

    const extractorHit = pickOwnExtractorAtPointer(event);
    if (extractorHit) {
      resetActorClickMemory(actorClickMemory);
      const doubleClick = classifyPropClick(propClickMemory, extractorHit.extractorId, nowMs) === "defaultAction";
      const routed = propPointerGrammarDecision({ button: "left", doubleClick });
      notePointerDown(0, null, routed);
      if (doubleClick) {
        performDefaultExtractorAction(extractorHit.extractorId);
        resetPropClickMemory(propClickMemory);
      }
      return;
    }

    const campHit = pickOwnCampAtPointer(event);
    if (campHit) {
      // No double-click default: the camp's only verb is destructive and
      // confirm-gated. The click still claims the pointer (no ground fall-through).
      resetActorClickMemory(actorClickMemory);
      resetPropClickMemory(propClickMemory);
      const routed = propPointerGrammarDecision({ button: "left", doubleClick: false });
      notePointerDown(0, null, routed);
      return;
    }

    const propHit = pickPropAtPointer(event);
    if (propHit) {
      resetActorClickMemory(actorClickMemory);
      const doubleClick = classifyPropClick(propClickMemory, propHit.propId, nowMs) === "defaultAction";
      const routed = propPointerGrammarDecision({ button: "left", doubleClick });
      notePointerDown(0, null, routed);
      if (doubleClick) {
        performDefaultPropAction(propHit);
        resetPropClickMemory(propClickMemory);
      } else if (propHit.kind === "travel_terminal") {
        // Kiosk grammar: a terminal's screen IS its examine — single LMB
        // opens the travel menu directly (no cache-copy examine pane).
        setActiveTravelTerminal(propHit.propId);
        onOpenTravelTerminal(propHit.propId);
      } else if (propHit.kind === "bank_terminal") {
        // Same kiosk grammar for the vault terminal's screen.
        onOpenBankTerminal(propHit.propId);
      } else if (propHit.kind === "clone_terminal") {
        onOpenCloneTerminal(propHit.propId);
      } else if (propHit.kind === "pa_terminal") {
        onOpenPaTerminal(propHit.propId);
      } else if (propHit.kind === "trade_terminal") {
        onOpenExchange(propHit.propId);
      } else {
        openExamineProp(propHit.propId);
      }
      return;
    }

    resetActorClickMemory(actorClickMemory);
    resetPropClickMemory(propClickMemory);
    focusPickedActor(null);
    const routed = actorPointerGrammarDecision({ button: "left", actorHit: false, doubleClick: false, attackable: false });
    notePointerDown(0, null, routed);
    // Ground click = walk there (grammar unchanged: the click still clears the
    // target above). Ignored while dead — everything else (locks, transitions,
    // manual keys, blockers) cancels safely inside the movement system.
    if (!canIssueGroundMove(state)) return;
    const ground = renderer.screenOffsetToWorldGround(event.offsetX, event.offsetY);
    if (!ground) return;
    // World renders cells at cell + 0.5 — convert back to authority cells.
    setClickMoveTarget(state, ground.x - 0.5, ground.z - 0.5, state.activeAreaId, nowMs);
  };

  const handleRightPointerDown = (event: MouseEvent, nowMs: number): void => {
    const actorHitId = pickActorAtPointer(event, nowMs);
    if (actorHitId) {
      resetPropClickMemory(propClickMemory);
      const routed = actorPointerGrammarDecision({ button: "right", actorHit: true, doubleClick: false, attackable: actorAttackable(actorHitId) });
      notePointerDown(2, actorHitId, routed);
      focusPickedActor(actorHitId);
      resetActorClickMemory(actorClickMemory);
      openActorRadial(actorHitId, event);
      return;
    }

    const corpseHit = renderer.pickPlayerCorpseAtScreenPoint(event.offsetX, event.offsetY);
    if (corpseHit) {
      resetActorClickMemory(actorClickMemory);
      resetPropClickMemory(propClickMemory);
      const routed = propPointerGrammarDecision({ button: "right", doubleClick: false });
      notePointerDown(2, null, routed);
      openPlayerCorpseRadial(corpseHit, event);
      return;
    }

    const extractorHit = pickOwnExtractorAtPointer(event);
    if (extractorHit) {
      resetActorClickMemory(actorClickMemory);
      resetPropClickMemory(propClickMemory);
      const routed = propPointerGrammarDecision({ button: "right", doubleClick: false });
      notePointerDown(2, null, routed);
      openExtractorRadial(extractorHit, event);
      return;
    }

    const campHit = pickOwnCampAtPointer(event);
    if (campHit) {
      resetActorClickMemory(actorClickMemory);
      resetPropClickMemory(propClickMemory);
      const routed = propPointerGrammarDecision({ button: "right", doubleClick: false });
      notePointerDown(2, null, routed);
      openCampRadial(campHit, event);
      return;
    }

    const propHit = pickPropAtPointer(event);
    if (propHit) {
      resetActorClickMemory(actorClickMemory);
      resetPropClickMemory(propClickMemory);
      const routed = propPointerGrammarDecision({ button: "right", doubleClick: false });
      notePointerDown(2, null, routed);
      openPropRadial(propHit, event);
      return;
    }

    const routed = actorPointerGrammarDecision({ button: "right", actorHit: false, doubleClick: false, attackable: false });
    notePointerDown(2, null, routed);
    resetActorClickMemory(actorClickMemory);
    resetPropClickMemory(propClickMemory);
    if (state.rotationLockFacing === null) state.rotationLockFacing = state.facing;
    state.keys.add("MouseRight");
  };

  const onBuildingPointerMove = (event: MouseEvent) => {
    if (!buildingController?.isActive()) return;
    const ground = renderer.screenOffsetToWorldGround(event.offsetX, event.offsetY);
    buildingController.updatePointer(event.offsetX, event.offsetY, ground);
  };

  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    if (buildingController?.isActive()) {
      event.preventDefault();
      buildingController.pointerDown(event.offsetX, event.offsetY, event.button, renderer.canvas.clientWidth, renderer.canvas.clientHeight);
      return;
    }
    event.preventDefault();
    const nowMs = performance.now();
    if (event.button === 0) handleLeftPointerDown(event, nowMs);
    else handleRightPointerDown(event, nowMs);
  };

  const onMouseUp = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 2) return;
    notePointerUp(event.button);
    if (event.button === 2) {
      state.keys.delete("MouseRight");
      if (!rotationLocked(state.keys)) state.rotationLockFacing = null;
    }
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!buildingController?.isActive()) return;
    onBuildingPointerMove(event);
    buildingController.hover(event.offsetX, event.offsetY, renderer.canvas.clientWidth, renderer.canvas.clientHeight);
  };

  const onWheel = (event: WheelEvent) => {
    if (buildingController?.isActive()) {
      buildingController.rotate();
      event.preventDefault();
      return;
    }
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextZoom = clampZoomPercent(state.settings.mouse.cameraZoomPercent + direction * SUCCESSOR_3D_CONFIG.input.wheelStepPercent);
    if (nextZoom !== state.settings.mouse.cameraZoomPercent) {
      state.settings.mouse.cameraZoomPercent = nextZoom;
      saveRuntimeSettings(state.settings, window.localStorage);
    }
    event.preventDefault();
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  const onBlur = () => {
    state.keys.delete("MouseRight");
    for (const key of state.keys) {
      if (isMovementKey(key)) state.keys.delete(key);
    }
    state.movementKeyOrder = [];
    if (!rotationLocked(state.keys)) state.rotationLockFacing = null;
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("mouseup", onMouseUp);
  target.addEventListener("blur", onBlur);
  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);

  return {
    dispose() {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("mouseup", onMouseUp);
      target.removeEventListener("blur", onBlur);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    },
  };
}

function movementTraceKeyList(keys: Iterable<string>): string {
  const held: string[] = [];
  for (const key of keys) {
    if (isMovementKey(key)) held.push(key);
  }
  return held.join("+");
}
