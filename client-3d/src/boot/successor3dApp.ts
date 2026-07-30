import { createSfxPlayer, type SfxPlayer } from "@successor/client/src/audio/sfx";
import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import {
  createGameAuthorityClient,
  drainAbilityQueueEvents,
  type GameAuthorityClient,
  type GameAuthorityLaunchFailureReason,
  type GameAuthorityViewInterest,
} from "@successor/client/src/slice-core/gameAuthoritySystem";
import { createPlayState, type PlayState, type ServerAuthorityActorAppearanceState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  authorityPlayerDebugProjection,
  type Successor3dAuthorityPlayerDebugProjection,
} from "./authorityPlayerProbe";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityBuildPlaceCommand,
  enqueueAuthorityBuildRemoveCommand,
  enqueueAuthorityBuildToggleDoorCommand,
  enqueueAuthorityCancelAbilityQueueCommand,
  nextRuntimeAuthorityCommandIdFloor,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { loadRuntimeSettings, runtimeSettingsStorageKey } from "@successor/client/src/slice-core/settingsSystem";
import { setEquippedWeaponAuthoritative } from "@successor/client/src/slice-core/loadoutSystem";
import { isWeaponId } from "@successor/client/src/slice-core/weaponSystem";
import { updatePlayState } from "@successor/client/src/slice-core/runtimeUpdateSystem";
import { interactionOptions } from "@successor/client/src/slice-core/interactionSystem";
import { BuildingController } from "../render/building";
import { mountBuildPanel } from "../ui/build/buildPanel";
import { DEFAULT_BUILD_CATALOG, type BuildPalette } from "../ui/build/catalog";
import { enqueueSpatialBubble } from "@successor/client/src/slice-core/spatialBubbleSystem";
import { loadRuntimeAssetBundle } from "../assets/runtimeAssets";
import { createMovementRecorder, type MovementRecorder } from "../debug/movementRecorder";
import { successorMoveTraceEnabled, recordSuccessorMoveTrace } from "@successor/client/src/slice-core/moveTraceSystem";
import { SUCCESSOR_3D_CONFIG } from "../config";
import type { ActiveClipsByLayer } from "../render/anim/PawnAnimator";
import { SuccessorThreeRenderer } from "../render/SuccessorThreeRenderer";
import type { WorldPropAnimatedScreenDebug, WorldPropEnterableCutawayDebug } from "../render/props";
import { getLodHiFiRadiusOverride, setLodHiFiRadiusOverride, type PawnGroundingDebug } from "../render/pawns";
import { createOverlayLayer, type Successor3dOverlayLayer, type OverlayFrameStats } from "../overlay";
import { installGameCursor } from "../overlay/cursor";
import { installInputRecorderProbe } from "../debug/inputRecorder";
import { installSuccessorMoveTraceProbe } from "../debug/moveTrace";
import { installSuccessorGameTraceProbe, type SuccessorGameTraceController } from "../debug/gameTrace";
import { syncAuthorityReceiptProbeTail, type AuthorityReceiptProbeEntry } from "../debug/authorityReceiptProbe";
import { projectFloatingTextsProbe, type FloatingTextProbeEntry } from "./floatingTextsProbe";
import {
  createEmptyDuelProbeState,
  syncDuelOutcomeProbeTail,
  syncDuelProbeState,
  type DuelOutcomeProbeEntry,
  type DuelProbeState,
} from "../debug/duelProbe";
import { authorityActorHasSkillBox, authorityActorLinkDead, authorityProfessionTrackXp, authorityProfessionXp, syncAuthorityActorKeys } from "../debug/authorityActorProbe";
import { installSuccessor3dInput, type Successor3dInputController } from "./input";
import { createAuthorityBeforeRenderer } from "./authorityRendererBoot";
import { waitForNextBootFrame } from "./bootFrame";
import { applyLaunchIdentity, characterStorageKeyFromLaunchIdentity, initialCameraFocus, launchActorIdFromSearch } from "./launch";
import { playerCorpseProbeProjections, type Successor3dPlayerCorpseDebugProjection } from "./playerCorpseProbe";
import { registerCampPlacementGate, registerCraftToolOpener, registerExamineOpener, registerExtractorPlacementGate, registerSpliceBenchOpener, registerSurveyToolOpener, registerTravelTicketGate } from "../ui/inventory/data";
import {
  CAMP_SHELTER_FOOTPRINT_CELLS,
  campCollisionProfileFromSidecar,
  registerCampCollisionProfile,
} from "@successor/client/src/slice-core/campSystem";
import { mountExtractionHud } from "../ui/extraction/extractionHud";
import { CRAFT_WINDOW_ID } from "../ui/crafting/craftWindowIds";
import { createLiveCraftCommandPort } from "../ui/crafting/commands";
import { enableCraftAuthoritySync } from "../ui/crafting/store";
import { SPLICE_WINDOW_ID } from "../ui/splice/spliceWindowIds";
import { createLiveSpliceCommandPort } from "../ui/splice/commands";
import { enableSpliceAuthoritySync } from "../ui/splice/store";
import { setEquippedGearPlayerId, setPendingWornSeed } from "../ui/inventory/equippedGearStore";
import { LOOT_WINDOW_ID, lootTargetRef, setLootTarget } from "../ui/windows/defs/lootWindowIds";
import { createLootWindowDefinition } from "../ui/windows/defs/lootWindow";
import { BANK_WINDOW_ID } from "../ui/windows/defs/bankWindowIds";
import { activeBankTerminal, setActiveBankTerminal } from "../ui/inventory/bankLink";
import { requestFactorySchematicsOpen, setActiveFactory } from "../ui/crafting/factoryLink";
import {
  activeCloneTerminal,
  CLONE_TERMINAL_WINDOW_ID,
  setActiveCloneTerminal,
} from "../ui/windows/defs/cloneTerminalWindowIds";
import {
  activePaTerminal,
  PA_WINDOW_ID,
  setActivePaTerminal,
  type PaWindowChatBridge,
} from "../ui/windows/defs/paWindowIds";
import { presentLoadScreen } from "../ui/loadScreen";
import { travelCatalogFrom } from "../ui/travel/travelSystem";
import { clampMovementOctant } from "./movementCollision";
import { installMovementVectorModifier } from "@successor/client/src/slice-core/movementSystem";
import type { WorldFloraCollider } from "../render/flora/scatter";
import { activeTravelTerminal, setActiveTravelTerminal, withinTerminalRange } from "../ui/travel/travelSystem";
import { setInteractChipSuppressor } from "../overlay/interactChip";
import { chatWsUrl } from "@successor/client/src/chat/chatClient";
import { createChatPaneClient, mountChatPane, type ChatPaneController } from "../ui/hud/chatPane";
import { createSlashCommandRouter } from "../ui/hud/slashCommands";
import { runtimeBackendHttpBase } from "@successor/client/src/runtime/runtimeDefaults";
import { mountTargetPlate, type TargetPlateController } from "../ui/hud/targetPlate";
import { mountGroupHud } from "../ui/hud/groupHud";
import { createCombatLogFeed } from "../ui/hud/combatLog";
import { mountDeathOverlay } from "../ui/hud/deathOverlay";
import { mountToolbar } from "../ui/hud/toolbar";
import { mountRadar } from "../ui/hud/radar";
import { makeDemoSource, mountCombatQueue, type QueueSource } from "../ui/hud/combatQueue";
import { mountInteractPrompt, type InteractPromptController } from "../ui/hud/interactPrompt";
import { mountFirstSteps } from "../ui/hud/firstSteps";
import {
  configureMacroStore,
  createParentMacroDataPort,
  deleteMacro,
  macroStoreStatus,
  macroStoreVersion,
  macros,
  refreshMacros,
  saveMacro,
  type MacroRecordPayloadLike,
} from "../ui/macros/store";
import { createMacroRuntime, reasonCopy, type MacroRuntime } from "../ui/macros/runtime";
import type { MacroNoticeSink } from "../ui/macros/macrosWindowIds";
import { setExamineItem } from "../ui/inventory/examineWindowIds";
import {
  targetExamineActorAvailable,
  TARGET_EXAMINE_WINDOW_ID,
} from "../ui/inventory/targetExamineWindowIds";
import { createInventoryWindowDefinition } from "../ui/inventory/shell";
import { createCharacterWindowDefinition } from "../ui/windows/defs/characterWindow";
import { createActionBrowserWindowDefinition } from "../ui/windows/defs/actionBrowserWindow";
import {
  CONVERSE_WINDOW_ID,
  converseTargetId,
  setConverseTarget,
} from "../ui/dialogue/converseWindowIds";
import { createLiveTradeCommandPort } from "../ui/trade/commands";
import { openTradeWith, pollTradeLifecycle, tradeSlashLine, wireTradeWindowLifecycle } from "../ui/trade/lifecycle";
import { enableTradeAuthoritySync } from "../ui/trade/store";
import { createOptionsWindowDefinition } from "../ui/windows/defs/optionsWindow";
import { createSkillsWindowDefinition } from "../ui/windows/defs/skillsWindow";
import {
  BUG_REPORT_WINDOW_ID,
  bugReportSlashLine,
  createBugReportWindowDefinition,
} from "../ui/windows/defs/bugReportWindow";
import {
  PROP_EXAMINE_WINDOW_ID,
  setExaminedProp,
} from "../ui/windows/defs/propExamineWindowIds";
import { createContextRadial, type ContextRadial } from "../ui/windows/contextRadial";
import { fxLabRequested, FX_LAB_WINDOW_ID } from "../ui/windows/defs/fxLabWindowIds";
import {
  createDeferredBankWindowDefinition,
  createDeferredCloneTerminalWindowDefinition,
  createDeferredConverseWindowDefinition,
  createDeferredCraftWindowDefinition,
  createDeferredDatapadWindowDefinition,
  createDeferredExamineWindowDefinition,
  createDeferredFxLabWindowDefinition,
  createDeferredMacrosWindowDefinition,
  createDeferredPaWindowDefinition,
  createDeferredPropExamineWindowDefinition,
  createDeferredSpliceWindowDefinition,
  createDeferredSurveyToolWindowDefinition,
  createDeferredTargetExamineWindowDefinition,
  createDeferredTradeWindowDefinition,
  createDeferredTravelWindowDefinition,
  scheduleDeferredFeaturePreload,
} from "../ui/windows/deferredWindows";
import { createWindowDock, type WindowDock } from "../ui/windows/dock";
import { createWindowManager, type WindowManager } from "../ui/windows/windowManager";
import { initUiTheme } from "../ui/uiTheme";
import {
  IRON_FAMILY,
  ingestSurveyResult,
  lastSurveyResultFor,
  surveyConcentrationAt,
  surveyDiscsFor,
  surveyStoreVersion,
} from "../ui/survey/store";
import {
  configureWaypointStore,
  createWaypoint,
  deleteWaypoint,
  waypoints,
  waypointStoreVersion,
  type Waypoint,
  type WaypointMutationResult,
} from "../ui/waypoints/store";
import { setMaxAcquireRangeFromWeaponMax, updateSoftLock } from "../combat/softLock";
import {
  collectBugReportDiagnostics,
  installBugReportErrorCapture,
} from "../support/bugReportDiagnostics";

export interface Successor3dActorDebugProjection {
  id: string;
  x: number;
  y: number;
  distanceCells: number;
  lifeState: string;
  /** True only when the exact actor has a live pawn visual and animator. */
  rendered: boolean;
  baseClip: string | null;
  screen: { px: number; py: number } | null;
}

export interface Successor3dDebugProbe {
  tick: number;
  actorCount: number;
  /** Opaque authority actor keys for same-world verification; never account identity. */
  authorityActorKeys: string[];
  fps: number;
  playerCell: { x: number; y: number };
  serverStatus: string;
  selectedActorId: string | null;
  /** Exact selected-id projection; unlike nearestHostile this never substitutes another actor. */
  selectedActor: Successor3dActorDebugProjection | null;
  examineActorId: string | null;
  zoomPercent: number;
  status: string;
  playerActorId: string;
  /** Attached equipment item ids on the LOCAL pawn (hair/helmet mesh truth). */
  localEquipmentIds: string[];
  /** Configured face decal on the LOCAL pawn; ready means atlas paint completed. */
  localFacePaint: { attached: true; ready: boolean; signature: string } | null;
  sourceMatchesClient: boolean | null;
  acceptedCommands: number;
  rejectedCommands: number;
  /** Recent real authority receipts, joined to sent-command identity; oldest first. */
  authorityReceiptTail: AuthorityReceiptProbeEntry[];
  duel: DuelProbeState;
  duelOutcomes: DuelOutcomeProbeEntry[];
  playerLifeState: string | null;
  /** Server-authority life state + clone fields of the local pawn (death-flow QA). */
  playerAuthorityLifeState: string | null;
  playerRespawnTick: number;
  playerCloneSickness: number;
  playerIncapRemainingMs: number;
  playerIncapCount: number;
  playerIncapWindowMs: number;
  nameplateCount: number;
  bubbleCount: number;
  /** Opaque actor keys whose spatial bubbles were painted this frame. */
  bubbleActorKeys: string[];
  /** LOD tier counts this frame: HI-FI (full mixer+IK) vs SIMULATION (skip). */
  lodHiFiActors: number;
  lodSimActors: number;
  /** Compositor layers of the followed actor (pawn animation debug). */
  activeClipsByLayer: ActiveClipsByLayer | null;
  /** Slugthrower muzzle socket world position of the followed actor; null when unarmed/down. */
  muzzleWorld: { x: number; y: number; z: number } | null;
  /** Server actors currently in the "downed" lifeState (death-clip watch). */
  downedCount: number;
  /** Authority-synced inventory rows (all containers / local player's). */
  inventoryRows: number;
  inventoryPlayerRows: number;
  /** Authority-side view of the local player (initial-desync + character-contract diagnosis). */
  authorityPlayer: Successor3dAuthorityPlayerDebugProjection | null;
  activeAreaId: string;
  predictionErrorCells: number;
  /** Fidelity: worst render-vs-authority pawn position drift (cells). */
  renderDriftMaxCells: number;
  renderDriftActors: number;
  /** Fidelity: last roll-combat events (server truth for shot verification). */
  combatEventLog: {
    id: number;
    kind: string;
    shooter: string | null;
    target: string | null;
    hit: boolean | null;
    damage: number | null;
    effect: string | null;
    lifecycle: string | null;
    cause: string | null;
  }[];
  /** Movement-pipeline gate state (spin-freeze forensics, owner 2026-07-04). */
  moveGate: {
    moving: boolean;
    status: string;
    inFlightMoves: number;
    pendingMoves: number;
    lastMoveIssuedAtTick: number | null;
    snapshotTick: number;
    sendGateStalled: boolean;
    predictionErrorCells: number;
    lastMoveCommandAtMs: number | null;
    nextMoveCommandAtMs: number;
    moveCommandIntervalMs: number;
    sentMoveTail: { commandId: number; issuedAtTick: number; sentAtMs: number | null }[];
    receiptTail: { commandId: number; accepted: boolean; tick: number; reasonCode?: string }[];
  };
  /** Last rejected command receipts (kind + reason), newest last. */
  rejectLog: { kind: string; reason: string }[];
  /** Nearest living non-player hostile-class actor (harness aiming/QA). */
  nearestHostile: Successor3dActorDebugProjection | null;
  /** Renderer-owned proof that the authored terminal screen is live, not merely fetched. */
  travelTerminalScreen: WorldPropAnimatedScreenDebug | null;
  /** Storm event presentation state (weather slice QA; null before first frame). */
  weather: {
    phase: string;
    eventType: string | null;
    severity: number;
    sheltered: boolean;
  } | null;
  /** Nearby interaction options from the same selector used by the F prompt. */
  interactions: {
    id: string;
    kind: string;
    targetId: string;
    detail: string;
    distanceCells: number;
    doorOpen?: boolean;
  }[];
  /**
   * Currently V-cycled interaction (state.interactions.selectedIndex into the
   * live interactionOptions list). Null when nothing is in reach. Read-only
   * projection — KeyV changes selectedIndex; it does not reorder `interactions`.
   */
  selectedInteraction: {
    id: string;
    kind: string;
    targetId: string;
  } | null;
  /** Authority-streamed door states, kept small for live shelter-door proof. */
  doorStates: Record<string, { doorOpen: boolean | null }>;
  /** Authority-streamed placed extractors (extraction FE live proof + PlayState parity checks). */
  placedExtractors: {
    extractorId: string;
    areaId: string;
    cellX: number;
    cellY: number;
    mode: "idle" | "manual" | "battery";
    hopperPct: number;
    collectableUnits: number;
    batteryPct: number;
    isOwner: boolean;
  }[];
  /** Authority-streamed placed camps + client door drive (camp FE live proof). */
  placedCamps: {
    campId: string;
    areaId: string;
    cellX: number;
    cellY: number;
    isOwner: boolean;
    renderKind: string;
    abandonSecondsRemaining: number | null;
  }[];
  /** Camp auto-door states (open target + slide fraction), keyed by campId. */
  campDoors: Record<string, { open: boolean; t: number }>;
  /** AOI player corpse bags: authority cell + CSS-px canvas anchor (read-only harness seam). */
  playerCorpses: Successor3dPlayerCorpseDebugProjection[];
  /** Live floating combat texts and status labels (e.g. HARVESTED). */
  floatingTexts: FloatingTextProbeEntry[];
}

export interface Successor3dApp {
  state: PlayState;
  slice: SliceSnapshot;
  renderer: SuccessorThreeRenderer;
  stop: () => void;
  overlay: Successor3dOverlayLayer;
}

declare global {
  interface Window {
    __successor3d?: Successor3dDebugProbe;
    __successor3dEnqueueSpatialBubble?: (body: string, actorId?: string) => void;
    /** Exact authority link-dead projection for a caller-held opaque actor key. */
    __successor3dActorLinkDead?: (actorKey: string) => boolean | null;
    /** Verification bridge: point the examine window at an item key. */
    __successor3dExamine?: (key: string) => void;
    /** Verification bridge: survey store state (version bumps per scan). */
    __successor3dSurvey?: {
      version: number;
      discCount: number;
      lastSpawnName: string | null;
      lastAreaId: string | null;
      localConcentrationMilli: number | null;
    };
    /** Live LOD A/B dial: HI-FI radius override in cells (null = config default). */
    __successor3dLod?: {
      getHiFiRadius: () => number;
      setHiFiRadius: (cells: number | null) => number | null;
    };
    /** Game Lab verification bridge: waypoint mutations without pointer choreography. */
    __successor3dWaypoints?: {
      createAtPlayer: (name?: string) => WaypointMutationResult;
      delete: (id: string) => WaypointMutationResult;
      list: () => Waypoint[];
      clearLab: () => number;
      readonly count: number;
      readonly version: number;
    };
    /** Game Lab verification bridge: macro store + engine without pointer choreography. */
    __successor3dMacros?: {
      list: () => { id: string; name: string; body: string }[];
      save: (input: { id?: string | null; name: string; body: string }) => Promise<{ ok: boolean; status: string; reasonCode?: string }>;
      delete: (id: string) => Promise<{ ok: boolean; status: string; reasonCode?: string }>;
      run: (name: string) => { ok: boolean; runId?: string; reasonCode?: string };
      stop: (target: string) => number;
      runs: () => { runId: string; name: string; status: string; instructionPointer: number; jumpsUsed: number }[];
      slash: (line: string) => string | null;
      readonly version: number;
      readonly storePhase: string;
    };
    /**
     * Read-only on-demand cutaway diagnostics (no per-frame Box3 work).
     * With a prop id: that building's entry (or null); without: all enterables.
     */
    __successor3dCutaway?: (propId?: string) => WorldPropEnterableCutawayDebug[] | WorldPropEnterableCutawayDebug | null;
    /** Read-only on-demand pawn grounding diagnostics (defaults to the local player). */
    __successor3dPawnGrounding?: (actorId?: string) => PawnGroundingDebug | null;
    /**
     * Read-only world→canvas projection for headed proof routes.
     * Args match SuccessorThreeRenderer.worldToScreen(x, z, y): z is SIM y,
     * y is HEIGHT. Returns CSS-px offsets inside the 3D canvas (same space as
     * probe screen anchors); null when the frame has no live viewport.
     */
    __successor3dWorldToScreen?: (
      x: number,
      z: number,
      y?: number,
    ) => { px: number; py: number } | null;
  }
}

export async function startSuccessor3dApp(
  canvasHost: HTMLElement,
  setStatus: (message: string) => void,
  options?: { sfx?: SfxPlayer; onLaunchFailure?: (reason: GameAuthorityLaunchFailureReason) => void },
): Promise<Successor3dApp> {
  const disposeBugReportErrorCapture = installBugReportErrorCapture();
  setStatus("Loading Successor runtime assets…");
  // Install the --sc3d-* theme variables on :root (Pip-Boy palettes) before
  // any in-world UI mounts; idempotent + restores the saved theme choice.
  initUiTheme();
  installInputRecorderProbe();
  const moveTrace = installSuccessorMoveTraceProbe();
  const gameTrace = installSuccessorGameTraceProbe();
  const assets = await loadRuntimeAssetBundle();
  const launchIdentity = getLaunchIdentity();
  const launchActorId = launchActorIdFromSearch(launchIdentity, window.location.search);
  // Per-character local stores use the selected character id when present;
  // LaunchIdentity.playerId is already characterId→ownerRef, and launchActorId
  // is the final boot-time authority fallback.
  const characterKey = characterStorageKeyFromLaunchIdentity(launchIdentity, launchActorId);
  configureWaypointStore(characterKey, window.localStorage);
  // MACRO record store (successor.macros.v1): server-authoritative, bound to
  // the selected character. The char-select flow hands a join-payload seed
  // through __successorSelectedCharacter (no fetch); lab boots that carry
  // ?characterId= sync with one GET instead. Without a character record the
  // store stays unbound and the window reads NO CHARACTER RECORD.
  const selected = (window as Window & {
    __successorSelectedCharacter?: {
      id?: string;
      macroRecords?: MacroRecordPayloadLike | null;
      worn?: Array<{ item: string; colors: string[] }>;
    };
  }).__successorSelectedCharacter;
  {
    const searchParams = new URLSearchParams(window.location.search);
    const macroCharacterId = launchIdentity.characterId ?? selected?.id ?? searchParams.get("characterId") ?? null;
    if (macroCharacterId) {
      const backendBase = runtimeBackendHttpBase({ gameWsUrl: launchIdentity.gameWsUrl, searchParams });
      const seed = selected?.macroRecords ?? null;
      const storefrontOrigin = import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN as string | undefined;
      const hostedParent =
        typeof window !== "undefined" &&
        window.parent !== window &&
        typeof storefrontOrigin === "string" &&
        storefrontOrigin.length > 0;
      if (hostedParent) {
        configureMacroStore({
          characterId: macroCharacterId,
          seed,
          dataPort: createParentMacroDataPort({
            characterId: macroCharacterId,
            parentOrigin: storefrontOrigin,
          }),
        });
      } else {
        configureMacroStore({ apiBase: backendBase, characterId: macroCharacterId, seed });
      }
      if (!seed) void refreshMacros();
    }
  }
  const slice = applyLaunchIdentity(assets.slice, launchIdentity, launchActorId);
  // Persisted authority checkpoints retain per-actor command IDs. A wall-clock
  // floor gives each real client launch a fresh monotonic namespace instead of
  // replaying command 1 and having every action rejected as a duplicate.
  const state = createPlayState(slice, launchActorId, nextRuntimeAuthorityCommandIdFloor());
  // Gear-store namespace MUST be pinned before the first PawnRenderer attach:
  // the store module initializes on the SELECT page (no ?player yet), latching
  // the fallback namespace — seeds would land there while the inventory VM
  // reads the identity namespace (naked-doll bug, owner report 2026-07-06).
  // Same precedence as the inventory VM: stable identity id, else actor id.
  setEquippedGearPlayerId(launchIdentity.playerId || launchActorId);
  // Creator worn set (join payload): parks until the pack registers the gear
  // catalog, then seeds the first-run equipped set with the character's
  // clothes instead of the classic look. seedIfEmpty semantics — a returning
  // character's own equip choices always win.
  if (Array.isArray(selected?.worn) && selected.worn.length > 0) {
    setPendingWornSeed(selected.worn.map((piece) => piece.item));
  }
  window.__successor3dActorLinkDead = (actorKey: string) => authorityActorLinkDead(state.serverAuthority.actors, actorKey);
  (window as Window & { __successor3dProfessionXp?: (professionId: string) => number | null }).__successor3dProfessionXp = (professionId: string) => authorityProfessionXp(state.serverAuthority.actors, state.serverAuthority.playerActorId ?? state.playerActorId, professionId);
  (window as Window & { __successor3dProfessionTrackXp?: (professionId: string, trackId: string) => number | null }).__successor3dProfessionTrackXp = (professionId: string, trackId: string) => authorityProfessionTrackXp(state.serverAuthority.actors, state.serverAuthority.playerActorId ?? state.playerActorId, professionId, trackId);
  (window as Window & { __successor3dHasSkillBox?: (skillBoxId: string) => boolean | null }).__successor3dHasSkillBox = (skillBoxId: string) => authorityActorHasSkillBox(state.serverAuthority.actors, state.serverAuthority.playerActorId ?? state.playerActorId, skillBoxId);
  window.__successor3dEnqueueSpatialBubble = (body: string, actorId?: string) => {
    enqueueSpatialBubble(state, {
      body,
      sender: "3D smoke",
      own: false,
      actorId: actorId ?? state.serverAuthority.playerActorId ?? state.playerActorId,
    });
  };
  state.settings = loadRuntimeSettings(window.localStorage);
  applySuccessor3dDefaultZoom(state, window.localStorage);
  // Movement flight recorder: always-on-cheap ring buffer + anomaly tagger.
  // F9 dumps a downloadable trace; ?moverec=1 shows a live marker chip. It
  // registers its own F9 window listener and never touches input.ts.
  const moveRecorder = createMovementRecorder(state);


  const sfx = options?.sfx ?? createSfxPlayer();
  void sfx.load().catch((error: unknown) => {
    console.warn("Successor 3D audio preload failed", error);
  });

  const { authority, chat, renderer } = await createAuthorityBeforeRenderer({
    createAuthority: (getViewInterest: () => GameAuthorityViewInterest | null) => createGameAuthorityClient({
      state,
      slice,
      launchIdentity,
      sfx,
      getViewInterest,
      onLaunchFailure: options?.onLaunchFailure,
    }),
    createChat: () => createChatPaneClient(
      state,
      sfx,
      options?.onLaunchFailure ? () => options.onLaunchFailure?.("game-failed") : undefined,
    ),
    connectChat: (bootChat) => bootChat.connect(chatWsUrl(launchIdentity, {
      location: window.location,
      searchParams: new URLSearchParams(window.location.search),
    })),
    waitForAuthority: async (bootAuthority) => {
      let initialAuthorityTimeout = 0;
      await Promise.race([
        bootAuthority.initialSnapshot,
        new Promise<void>((resolve) => {
          initialAuthorityTimeout = window.setTimeout(resolve, 5_000);
        }),
      ]);
      if (initialAuthorityTimeout !== 0) window.clearTimeout(initialAuthorityTimeout);
    },
    assertAuthorityReady: () => {
      if (!state.serverAuthority.connected) {
        throw new Error(state.status || "Server authority failed to connect");
      }
    },
    createRenderer: async () => {
      setStatus("Starting Three.js renderer…");
      return SuccessorThreeRenderer.create(canvasHost, slice, state);
    },
    getViewInterest: (bootRenderer) => bootRenderer.getViewInterest(slice, state),
    closeAuthority: (bootAuthority) => bootAuthority.close(),
    closeChat: (bootChat) => bootChat.dispose(),
  });
  // Planetfall arrival: fullscreen load screen on initial entry — always a
  // couple of seconds (owner spec), the first terrain bakes ride behind it.
  const bootCatalog = travelCatalogFrom(slice);
  // Resolve the ARRIVAL planet from the launch spawn request when present —
  // state.activeAreaId may still hold the default area this early.
  const bootAreaId = new URLSearchParams(window.location.search).get("spawnArea") ?? state.activeAreaId;
  presentLoadScreen({
    planet: bootCatalog?.planets.find((planet) => planet.areaId === bootAreaId) ?? null,
    fallbackLabel: "SUCCESSOR",
    phase: "boot",
  });
  // Terrain warmup rides INSIDE the load-screen hold: drain the spawn
  // neighborhood's bake queue in 40ms slices between animation frames — the
  // overlay paints and animates while first-sprint bake work happens up front
  // (fresh-load jag, owner report 2026-07-07).
  {
    const focus = initialCameraFocus(
      window.location.search,
      state.player,
      state.serverAuthority.authoritativePlayer,
    );
    const warmX = focus.x;
    const warmZ = focus.z;
    await waitForNextBootFrame();
    await waitForNextBootFrame(); // overlay committed + painted before any blocking slice
    const warmStart = performance.now();
    let passes = 0;
    let pending = 1;
    while (performance.now() - warmStart < 2200) {
      const slice = renderer.warmupTerrain(warmX, warmZ, 40);
      passes += slice.iterations;
      pending = slice.pending;
      if (pending === 0) break;
      await waitForNextBootFrame();
    }
    console.info(`successor3d terrain warmup: ${Math.round(performance.now() - warmStart)}ms, ${passes} passes, pending=${pending}`);
  }
  // World collision (client-side octant clamp; server sim runs collision-free
  // by fixture ruling — the SENT octant is the collision, cheaters welcome).
  const colliderScratch: WorldFloraCollider[] = [];
  installMovementVectorModifier((vector) => {
    const px = state.player.x + 0.5;
    const pz = state.player.y + 0.5;
    const count = renderer.floraCollidersNear(px, pz, 26, colliderScratch);
    if (count === 0) return vector;
    return clampMovementOctant(px, pz, vector, colliderScratch, count);
  });
  const gameCursor = installGameCursor(canvasHost);
  const overlay = createOverlayLayer(canvasHost, renderer);
  // Targeting v2: lock/Tab acquisition range follows the slice's weapon
  // tuning (only ever shortens vs the legacy 60-cell cap).
  setMaxAcquireRangeFromWeaponMax(slice.combatTuning?.weaponRangeBands?.["slugthrower"]?.maxCells);
  // Window system: manager + dock mount over the game canvas, before input so
  // hotkeys and UI chrome are live from boot.
  const windowManager = createWindowManager({
    mount: canvasHost,
    state,
    slice,
    storageScope: characterStorageKeyFromLaunchIdentity(launchIdentity, launchActorId),
  });
  const radial = createContextRadial(windowManager.root);
  const toolbar = mountToolbar(canvasHost, state, slice, sfx, {
    openWindow: (id) => windowManager.open(id),
  });
  // Slash router + macro runtime share ONE verb-registry instance; the router
  // fronts /macro + /dump (client-tui resolution-order convention) and the
  // engine resolves every macro verb through the same registry the chat line
  // uses — a macro is indistinguishable from a fast disciplined hand.
  let macroRuntime: MacroRuntime;
  const tradeCommands = createLiveTradeCommandPort(state, slice);
  // `/ui` reaches only the PERMANENT dock destinations (plus the FX Lab when
  // its dev flag registered it — otherwise it would be registered but
  // unreachable). One mutable array, filled after registration below — the
  // registry keeps the reference, so no second window registry exists.
  // Context surfaces (craft, splice, survey, travel, loot, examine…) and
  // context-only surfaces are denied here and keep their own routes.
  const slashWindowIds: string[] = [];
  const slashRouter = createSlashCommandRouter(state, slice, {
    openWindow: (id) => windowManager.open(id),
    knownWindowIds: slashWindowIds,
    macroLine: (line) => macroRuntime.handleSlashLine(line),
    tradeLine: (line) => tradeSlashLine(line, state, tradeCommands, windowManager),
    bugReportLine: (line) => bugReportSlashLine(
      line,
      () => windowManager.open(BUG_REPORT_WINDOW_ID),
    ),
  });
  macroRuntime = createMacroRuntime({ state, slice, registry: slashRouter.registry });
  // Finished-run notices: drained in the frame loop (deny tone plays even
  // while the window is closed); the window takes the copy for its flash.
  const macroNoticeQueue: { text: string; bad: boolean }[] = [];
  const macroNoticeSink: MacroNoticeSink = {
    take: () => macroNoticeQueue.shift() ?? null,
  };
  const pumpMacroRuntime = (): void => {
    macroRuntime.update();
    for (const notice of macroRuntime.drainNotices()) {
      const bad = notice.kind === "halted";
      if (bad) sfx.play(successorAudioIds.uiDeny);
      // Reason rides only on halts — "STOPPED · X · STOPPED" is noise.
      const reason = notice.kind === "halted" ? ` · ${reasonCopy(notice.reasonCode)}` : "";
      macroNoticeQueue.push({ text: `MACRO ${notice.kind.toUpperCase()} · ${notice.name.toUpperCase()}${reason}`, bad });
      while (macroNoticeQueue.length > 4) macroNoticeQueue.shift();
    }
  };
  // Dock order = registration order — permanent destinations only:
  // character, inventory, datapad (owns the map), skills, actions, macros,
  // options, association. Context-only benches (craft / gene bench), examine
  // panes, surveyTool and the fx lab are dock-invisible.
  windowManager.register(createCharacterWindowDefinition());
  windowManager.register(createInventoryWindowDefinition({ radial, sfx }));
  windowManager.register(createDeferredDatapadWindowDefinition({ radial, sfx }));
  windowManager.register(createSkillsWindowDefinition());
  windowManager.register(createActionBrowserWindowDefinition(toolbar));
  windowManager.register(createDeferredMacrosWindowDefinition({ runtime: macroRuntime, notices: macroNoticeSink, sfx }));
  windowManager.register(createOptionsWindowDefinition(toolbar, { openWindow: (id) => windowManager.open(id) }));
  // ASSOCIATION is a permanent destination (dock + G) AND a terminal screen:
  // the PA kiosk is the charter desk, never the only way to manage a roster.
  // The chat bridge lands after mountChatPane below (composition order).
  let paChatPane: ChatPaneController | null = null;
  const paChatBridge: PaWindowChatBridge = {
    sendGuildLine: (body) => paChatPane?.sendGuildLine(body) ?? false,
    selectGuildChannel: () => paChatPane?.selectGuildChannel() ?? false,
  };
  windowManager.register(createDeferredPaWindowDefinition({ sfx, chat: paChatBridge }));
  // CRAFT / GENE BENCH are context-only (no dock button, no global hotkey):
  // the item/device/station verbs below are the only player routes. The
  // stores trust the authority stream only once this composition root opts in.
  enableCraftAuthoritySync();
  enableSpliceAuthoritySync();
  windowManager.register(createDeferredCraftWindowDefinition({ commands: createLiveCraftCommandPort(state, slice), sfx }));
  windowManager.register(createDeferredSpliceWindowDefinition({ commands: createLiveSpliceCommandPort(state, slice), sfx }));
  // CONVERSE is world-opened (trainer radial / F-chip / double-click):
  // transient, dock-invisible, command leaves ride the authority queue.
  windowManager.register(createDeferredConverseWindowDefinition({
    sfx,
    openWindow: (id) => windowManager.open(id),
    closeWindow: (id) => windowManager.close(id),
  }));
  // TRADE is world-opened (player-pawn radial / bare `/trade`): transient,
  // dock-invisible; the store trusts the authority stream from here on, and
  // ✕/Esc on a live table declines it (earlier sandbox design) via the lifecycle hook.
  enableTradeAuthoritySync();
  windowManager.register(createDeferredTradeWindowDefinition({
    commands: tradeCommands,
    closeWindow: (id) => windowManager.close(id),
    sfx,
  }));
  const unwireTradeLifecycle = wireTradeWindowLifecycle(windowManager, tradeCommands);
  windowManager.register(createBugReportWindowDefinition({
    submit: (report) => authority.submitBugReport(report),
    diagnostics: () => collectBugReportDiagnostics(state, slice, launchIdentity, windowManager),
  }));
  // FX LAB is a dev instrument (owner ruling 2026-07-09: dev-flag-only) —
  // registered (never dock-visible; the dev flag also adds it to the `/ui`
  // allow list below) behind ?fxlab=1 or the localStorage twin, the
  // gameTrace flag pattern.
  if (fxLabRequested()) windowManager.register(createDeferredFxLabWindowDefinition());
  windowManager.register(createDeferredExamineWindowDefinition());
  windowManager.register(createDeferredTargetExamineWindowDefinition());
  windowManager.register(createDeferredPropExamineWindowDefinition());
  windowManager.register(createDeferredSurveyToolWindowDefinition({ sfx }));
  windowManager.register(createDeferredTravelWindowDefinition());
  windowManager.register(createLootWindowDefinition({ radial, sfx }));
  windowManager.register(createDeferredBankWindowDefinition({ sfx }));
  windowManager.register(createDeferredCloneTerminalWindowDefinition({ sfx }));
  // Registration complete — snapshot the rail into the shared `/ui` allow
  // list (the slash registry holds this array's reference). The FX Lab joins
  // only under its dev flag, mirroring its conditional registration.
  slashWindowIds.push(...windowManager.dockEntries().map((entry) => entry.id));
  if (fxLabRequested()) slashWindowIds.push(FX_LAB_WINDOW_ID);
  // EXAMINE routes through the data adapter's action registry: any dispatch
  // path (radial today, future verbs) sets the item and opens the window.
  registerExamineOpener((key) => {
    setExamineItem(key);
    windowManager.open("examine");
  });
  // SURVEY tool GUI opens from its inventory item (owner ruling: no hotkey,
  // no dock button — the tool row's OPEN action is the only entry). The
  // item routes are ONE coherent context transition: the inventory hands
  // off to the destination window instead of cluttering behind it.
  registerSurveyToolOpener(() => {
    windowManager.close("inventory");
    windowManager.open("surveyTool");
  });
  // CRAFT opens from the Field Multitool row (context-only bench — the item
  // verb is the player route).
  registerCraftToolOpener(() => {
    windowManager.close("inventory");
    windowManager.open(CRAFT_WINDOW_ID);
  });
  // GENE BENCH opens from the Splice Bench row (context-only bench).
  registerSpliceBenchOpener(() => {
    windowManager.close("inventory");
    windowManager.open(SPLICE_WINDOW_ID);
  });
  // TRAVEL NOW gate: honest affordance for ticket rows — enabled only within
  // use range of the ticket's ORIGIN terminal (server re-validates anyway).
  registerTravelTicketGate((ticket) => {
    const inRange = state.activeAreaId === ticket.originAreaId
      && withinTerminalRange(state, slice, ticket.originTerminalPropId);
    return {
      enabled: inRange,
      note: inRange ? null : "AT ORIGIN TERMINAL ONLY · ≤10 CELLS",
    };
  });
  // PLACE gate for the deployable extractor: standing + one unit per owner
  // (mirrors the sim's PlaceExtractor gates; server re-validates on submit).
  registerExtractorPlacementGate(() => {
    if (state.serverAuthority.placedExtractors.some((extractor) => extractor.isOwner)) {
      return { enabled: false, note: "ONE UNIT · ALREADY DEPLOYED" };
    }
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const posture = state.serverAuthority.actors[actorId]?.posture;
    if (posture && posture !== "standing") {
      return { enabled: false, note: "STAND TO DEPLOY" };
    }
    return { enabled: true, note: null };
  });
  // PITCH gate for the camp kit: standing + one camp per player + clear cell
  // (mirrors the sim's PlaceCamp gates; server re-validates on submit).
  registerCampPlacementGate(() => {
    if (state.serverAuthority.placedCamps.some((camp) => camp.isOwner)) {
      return { enabled: false, note: "ONE CAMP · ALREADY PITCHED" };
    }
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const posture = state.serverAuthority.actors[actorId]?.posture;
    if (posture && posture !== "standing") {
      return { enabled: false, note: "STAND TO PITCH" };
    }
    if (state.blocked.has(`${Math.floor(state.player.x)},${Math.floor(state.player.y)}`)) {
      return { enabled: false, note: "CLEAR GROUND REQUIRED" };
    }
    return { enabled: true, note: null };
  });
  // Camp collision profile: the pod-tent's measured wall boxes (pack sidecar,
  // house pipeline math). Until the fetch lands camps are walk-through —
  // which is the sim's own truth, so nothing lies in the meantime.
  void fetch(requireRuntimePublicPath("/assets/world-items/podtent_scout_collision.json"))
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      registerCampCollisionProfile(
        "scout-camp",
        campCollisionProfileFromSidecar(await response.json(), CAMP_SHELTER_FOOTPRINT_CELLS),
      );
    })
    .catch((error: unknown) => {
      console.warn("camp collision sidecar unavailable — camps stay walk-through", error);
    });
  window.__successor3dExamine = (key: string) => {
    setExamineItem(key);
    windowManager.open("examine");
  };
  window.__successor3dWaypoints = {
    createAtPlayer: (name?: string) => createWaypoint({
      name,
      x: state.player.x,
      y: state.player.y,
      areaId: state.activeAreaId,
      active: true,
    }),
    delete: (id: string) => deleteWaypoint(id),
    list: () => waypoints().map((waypoint) => ({ ...waypoint })),
    clearLab: () => {
      const existing = waypoints().slice();
      for (const waypoint of existing) deleteWaypoint(waypoint.id);
      return waypoints().length;
    },
    get count(): number {
      return waypoints().length;
    },
    get version(): number {
      return waypointStoreVersion();
    },
  };
  window.__successor3dMacros = {
    list: () => macros().map((macro) => ({ id: macro.id, name: macro.name, body: macro.body })),
    save: (input) => saveMacro(input),
    delete: (id) => deleteMacro(id),
    run: (name) => {
      const result = macroRuntime.start(name);
      return result.ok ? { ok: true, runId: result.runId } : { ok: false, reasonCode: result.reasonCode };
    },
    stop: (target) => macroRuntime.stop(target),
    runs: () => macroRuntime.runs().map((run) => ({
      runId: run.runId,
      name: run.name,
      status: run.status,
      instructionPointer: run.instructionPointer,
      jumpsUsed: run.jumpsUsed,
    })),
    slash: (line) => macroRuntime.handleSlashLine(line),
    get version(): number {
      return macroStoreVersion();
    },
    get storePhase(): string {
      return macroStoreStatus().phase;
    },
  };
  // Dock is built AFTER all window registrations (it snapshots the registry).
  const dock = createWindowDock(windowManager);
  // HUD corner panes — fixed position and always visible.
  // (Player status plate is mounted by main.ts; these join it.)
  const targetPlate = mountTargetPlate(canvasHost, state, slice);
  // Group HUD (fe-polish §1.29 minimal FE): invite toast + member rail over
  // the owning-session group channel — the wire landed with GroupsSim, the
  // invited client just never rendered it.
  const groupHud = mountGroupHud(canvasHost, state, slice);
  // The bottom-center action strip is RETIRED (owner directive 2026-07-08):
  // its combat log lives in the chat pane's COMBAT tab; its weapon-speed
  // sweep lives on the ACTION QUEUE's current-row rail.
  const deathOverlay = mountDeathOverlay(canvasHost, state, slice);
  const radar = mountRadar(canvasHost, state, slice);
  // Combat queue (spec §F): live owning-session view + drainable event beats.
  // CLEAR = CancelAbilityQueue{scope:"combat"} — C3 documented combat ⊇ repeat
  // intent (ability-queue-impl.md §C3.0 notes); pending posture survives (§A.5).
  const combatQueueLive: QueueSource = {
    view: () => state.abilityQueue.view,
    drainEvents: () => drainAbilityQueueEvents(state),
    clear: () => {
      const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      enqueueAuthorityCancelAbilityQueueCommand(state.authorityCommands, tick, { scope: "combat" });
    },
  };
  // Dev seam: window.__combatQueueDemo() previews the scripted motion vocabulary
  // over the live wire; auto-reverts when the script ends. Live events keep
  // draining (discarded) during the preview so no stale FIRED burst replays.
  const combatQueueDemo = makeDemoSource();
  const combatQueueSource: QueueSource = {
    view: () => (combatQueueDemo.running() ? combatQueueDemo.source.view() : combatQueueLive.view()),
    drainEvents: () => {
      if (!combatQueueDemo.running()) return combatQueueLive.drainEvents();
      combatQueueLive.drainEvents();
      return combatQueueDemo.source.drainEvents();
    },
    clear: () => {
      (combatQueueDemo.running() ? combatQueueDemo.source : combatQueueLive).clear();
    },
  };
  const combatQueue = mountCombatQueue(canvasHost, state, slice, combatQueueSource);
  window.__combatQueueDemo = () => {
    combatQueueDemo.start();
    return true;
  };
  // World-emitter audio (owner audio wave): SfxPlayer loops are GLOBAL per clip
  // id and non-positional, so each family aggregates to ONE keyed loop driven by
  // the nearest source at 150ms cadence. Deflect one-shots ride the renderer's
  // product deflect sink (visual + audio share the beat).
  let deflectAlternate = false;
  renderer.onDeflectAudio = (actorId) => {
    const actor = state.serverAuthority.actors[actorId];
    if (!actor) return;
    deflectAlternate = !deflectAlternate;
    sfx.playAt(
      deflectAlternate ? successorAudioIds.saberDeflect01 : successorAudioIds.saberDeflect02,
      { x: (actor.renderX ?? actor.x) + 0.5, y: (actor.renderY ?? actor.y) + 0.5 },
      { volume: 0.85, maxDistanceCells: 26 },
    );
  };
  // Camp auto-door: same positional door-slide voice as the house doors
  // (gameAuthoritySystem's playDoorSlideFeedback values).
  renderer.setCampDoorAudio((x, y) => {
    sfx.playAt(successorAudioIds.doorSlide, { x, y }, {
      volume: 0.64,
      minDistanceCells: 1.5,
      maxDistanceCells: 30,
      panDistanceCells: 10,
      rolloff: 1.35,
    });
  });
  const worldLoopGain = (dist: number | null, minD: number, maxD: number): number => {
    if (dist === null || dist >= maxD) return 0;
    const t = Math.max(0, (dist - minD) / (maxD - minD));
    return Math.pow(1 - t, 1.4);
  };
  // Threshold-gated: setLoop re-ramps an existing loop's gain, so calling it
  // every 150ms would restart the fade constantly (audible wobble). Only touch
  // the loop when the target gain moves >0.03 or crosses the start/stop edge.
  let lastFireGain = 0;
  let lastHumGain = 0;
  const driveWorldLoop = (id: string, gain: number, last: number, fadeMs: number, stopFadeMs: number): number => {
    if (gain <= 0.02) {
      if (last > 0) sfx.stopLoop?.(id, stopFadeMs);
      return 0;
    }
    if (last > 0 && Math.abs(gain - last) < 0.03) return last;
    sfx.setLoop?.(id, { volume: gain, fadeMs });
    return gain;
  };
  const worldLoopTimer = window.setInterval(() => {
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const px = state.player.x;
    const py = state.player.y;
    const fireGain = worldLoopGain(renderer.nearestCampfireDistance(px + 0.5, py + 0.5), 1.2, 20);
    lastFireGain = driveWorldLoop(successorAudioIds.campfireCrackleLoop, fireGain, lastFireGain, 400, 700);
    let humGain = 0;
    for (const { actorId, extension } of renderer.ignitedPlasmaActors()) {
      const actor = state.serverAuthority.actors[actorId];
      if (!actor) continue;
      const own = actorId === playerActorId;
      const dist = own ? 0 : Math.hypot((actor.renderX ?? actor.x) - px, (actor.renderY ?? actor.y) - py);
      humGain = Math.max(humGain, worldLoopGain(dist, 0, 14) * Math.min(1, extension) * (own ? 1 : 0.8));
    }
    lastHumGain = driveWorldLoop(successorAudioIds.saberIdleHum, humGain, lastHumGain, 250, 450);
  }, 150);
  const chatPane = mountChatPane(
    canvasHost,
    state,
    sfx,
    slashRouter,
    createCombatLogFeed(state),
    options?.onLaunchFailure ? () => options.onLaunchFailure?.("game-failed") : undefined,
    chat,
  );
  paChatPane = chatPane;
  // Travel terminal binding is session-scoped UI state: window closed = no
  // terminal armed (defense-in-depth beside the range gate — Main fold-in).
  windowManager.subscribeOpenChanged((id, open) => {
    if (id === "travel" && !open) setActiveTravelTerminal(null);
    if (id === BANK_WINDOW_ID && !open) setActiveBankTerminal(null);
    if (id === CLONE_TERMINAL_WINDOW_ID && !open) setActiveCloneTerminal(null);
    if (id === PA_WINDOW_ID && !open) setActivePaTerminal(null);
    if (id === "datapad" && !open) setActiveFactory(null);
  });
  const interactPrompt = mountInteractPrompt(canvasHost, state, slice, {
    openWindow: (id) => windowManager.open(id),
    openBankTerminal: (propId) => {
      setActiveBankTerminal(propId);
      windowManager.open(BANK_WINDOW_ID);
    },
    openCloneTerminal: (propId) => {
      setActiveCloneTerminal(propId);
      windowManager.open(CLONE_TERMINAL_WINDOW_ID);
    },
    openPaTerminal: (propId) => {
      setActivePaTerminal(propId);
      windowManager.open(PA_WINDOW_ID);
    },
    openFactoryTerminal: (propId) => {
      // Bind physical factory, open datapad, force SCHEMATICS on first mount or reopen.
      setActiveFactory(propId);
      requestFactorySchematicsOpen();
      windowManager.open("datapad");
    },
    sfx,
  });
  const activeBuildParcel = () => {
    const parcels = state.serverAuthority.placedParcels.filter(
      (parcel) => parcel.areaId === state.activeAreaId && parcel.isOwner,
    );
    const containing = parcels.find((parcel) => {
      const zone = parcel.buildZone;
      return state.player.x >= zone.x
        && state.player.x < zone.x + zone.w
        && state.player.y >= zone.y
        && state.player.y < zone.y + zone.h;
    });
    return containing ?? parcels[0] ?? null;
  };
  const buildingController = new BuildingController(renderer.buildings, {
    onPlace: (command) => {
      const parcel = activeBuildParcel();
      if (!parcel) return;
      const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      const palette: BuildPalette = {
        primary: command.palette.primary ?? null,
        secondary: command.palette.secondary ?? null,
        accent: command.palette.accent ?? null,
      };
      const compactPalette = Object.fromEntries(
        Object.entries(palette).filter(([, value]) => value !== null),
      ) as { primary?: string; secondary?: string; accent?: string };
      enqueueAuthorityBuildPlaceCommand(state.authorityCommands, issuedAtTick, {
        parcel_id: parcel.parcelId,
        catalog_id: command.catalog_id,
        cell_x: command.cell_x,
        cell_y: command.cell_y,
        rotation_quarters: command.rotation_quarters,
        ...(Object.keys(compactPalette).length > 0 ? { palette: compactPalette } : {}),
      });
    },
    onRemove: (componentId) => {
      const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      enqueueAuthorityBuildRemoveCommand(state.authorityCommands, issuedAtTick, componentId);
    },
    onToggleDoor: (componentId) => {
      const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      enqueueAuthorityBuildToggleDoorCommand(state.authorityCommands, issuedAtTick, componentId);
    },
    canPlace: (command) => {
      const parcel = activeBuildParcel();
      if (!parcel) return { valid: false, reason: "CLAIM A PARCEL TO BUILD" };
      const zone = parcel.buildZone;
      const inside = command.cell_x >= zone.x
        && command.cell_x < zone.x + zone.w
        && command.cell_y >= zone.y
        && command.cell_y < zone.y + zone.h;
      return inside ? { valid: true } : { valid: false, reason: "OUTSIDE BUILD ZONE" };
    },
  });
  const buildPanel = mountBuildPanel(canvasHost, {
    catalog: DEFAULT_BUILD_CATALOG,
    state: {
      parcelLabel: activeBuildParcel()?.name ? `PARCEL ${activeBuildParcel()!.name.toUpperCase()}` : "NO CLAIMED PARCEL",
      materials: {},
    },
    events: {
      onSelectItem: (item) => {
        if (!item) return;
        buildingController.activate();
        buildingController.selectCatalog(item.id);
      },
      onRotate: (rotation) => buildingController.rotate(rotation),
      onToolChange: (tool) => buildingController.setTool(tool),
      onPaletteChange: (palette) => buildingController.setPalette({
        primary: palette.primary ?? undefined,
        secondary: palette.secondary ?? undefined,
        accent: palette.accent ?? undefined,
      }),
      onCancel: () => buildingController.setTool("place"),
      onClose: () => buildingController.deactivate(),
    },
  });
  const unsubscribeBuilding = buildingController.subscribe((snapshot) => {
    buildPanel.root.hidden = !snapshot.active;
    buildPanel.setRotation(snapshot.rotation);
    buildPanel.setTool(snapshot.tool);
    buildPanel.setState({
      invalidReason: snapshot.ghost.reason,
      parcelLabel: activeBuildParcel()?.name
        ? `PARCEL ${activeBuildParcel()!.name.toUpperCase()}`
        : "NO CLAIMED PARCEL",
    });
  });
  // Extraction toast line + live sampler-cooldown countdown (HUD-level, so
  // rejects speak even with every window closed).
  const extractionHud = mountExtractionHud(canvasHost, state, slice);
  // First-session guidance: one objective + one-shot move/use/act teachings,
  // breadcrumbed by a real waypoint at the camp trainer (beam/radar/datapad).
  const firstSteps = mountFirstSteps(canvasHost, state, slice, {
    characterKey,
    converseWindowOpen: () => windowManager.isOpen(CONVERSE_WINDOW_ID),
    lootWindowOpen: () => windowManager.isOpen(LOOT_WINDOW_ID),
  });
  const input = installSuccessor3dInput({
    target: window,
    renderer,
    state,
    slice,
    sfx,
    toolbar,
    radial,
    onInteract: () => {
      interactPrompt.performSelected();
    },
    onInteractRelease: () => {
      interactPrompt.releaseSelected();
    },
    onExamineActor: (actorId) => {
      state.examineActorId = actorId;
      windowManager.open(TARGET_EXAMINE_WINDOW_ID);
    },
    onExamineProp: (propId) => {
      setExaminedProp(propId);
      windowManager.open(PROP_EXAMINE_WINDOW_ID);
    },
    onOpenTravelTerminal: (propId) => {
      setActiveTravelTerminal(propId);
      windowManager.open("travel");
    },
    onOpenBankTerminal: (propId) => {
      setActiveBankTerminal(propId);
      windowManager.open(BANK_WINDOW_ID);
    },
    onOpenCloneTerminal: (propId) => {
      setActiveCloneTerminal(propId);
      windowManager.open(CLONE_TERMINAL_WINDOW_ID);
    },
    onOpenPaTerminal: (propId) => {
      setActivePaTerminal(propId);
      windowManager.open(PA_WINDOW_ID);
    },
    onOpenExchange: () => {
      // Trade terminal kiosks are District Exchange screens — the datapad
      // window owns the shared-storage UI (no second trade surface).
      windowManager.open("datapad");
    },
    onOpenLoot: (target) => {
      setLootTarget(target);
      windowManager.open(LOOT_WINDOW_ID);
    },
    onConverseActor: (actorId) => {
      // Fresh session per converse open (fresh greeting); selection binds so the
      // skills ledger keeps its explicit-trainer gate.
      setConverseTarget(actorId);
      state.selectedActorId = actorId;
      windowManager.open(CONVERSE_WINDOW_ID);
    },
    buildingController,
    onBuildToggle: () => buildingController.activate(),
    onTradeActor: (actorId) => {
      // Secure trade — selection binds (target plate context), table opens
      // immediately and fills when the session VM streams.
      state.selectedActorId = actorId;
      openTradeWith(actorId, tradeCommands, windowManager);
    },
  });
  // Chip yields to its own window (fe-polish §1.8/§1.22): while the pane a
  // target opened is up, the world chip stops painting — options + F dispatch
  // stay live (probe/journey contract untouched).
  setInteractChipSuppressor((option) => {
    if (option.kind === "trainer") {
      return windowManager.isOpen(CONVERSE_WINDOW_ID) && converseTargetId() === option.targetId;
    }
    if (option.kind === "corpse" || option.kind === "lootCache") {
      const target = lootTargetRef();
      return windowManager.isOpen(LOOT_WINDOW_ID) && target !== null && target.id === option.targetId;
    }
    if (option.kind === "travelTerminal") {
      return windowManager.isOpen("travel") && activeTravelTerminal() === option.targetId;
    }
    if (option.kind === "bankTerminal") {
      return windowManager.isOpen(BANK_WINDOW_ID) && activeBankTerminal() === option.targetId;
    }
    if (option.kind === "paTerminal") {
      return windowManager.isOpen(PA_WINDOW_ID) && activePaTerminal() === option.targetId;
    }
    if (option.kind === "cloneTerminal") {
      return windowManager.isOpen(CLONE_TERMINAL_WINDOW_ID) && activeCloneTerminal() === option.targetId;
    }
    return false;
  });
  window.__successor3dLod = {
    getHiFiRadius: () => getLodHiFiRadiusOverride() ?? SUCCESSOR_3D_CONFIG.pawn.lod.hiFiRadiusCells,
    setHiFiRadius: (cells) => {
      setLodHiFiRadiusOverride(cells);
      return getLodHiFiRadiusOverride();
    },
  };
  const loop = createFrameLoop({
    state,
    slice,
    renderer,
    overlay,
    authority,
    input,
    windows: windowManager,
    dock,
    radial,
    targetPlate,
    chatPane,
    interactPrompt,
    sfx,
    setStatus,
    moveRecorder,
    gameTrace,
    pumpMacroRuntime,
  });
  loop.start();
  const cancelFeaturePreload = scheduleDeferredFeaturePreload();
  // Read-only evidence hooks for headed-browser proof / CLI capture contract:
  // {building: __successor3dCutaway(id), pawn: __successor3dPawnGrounding(actorId)}.
  // Each call does the bounded Box3 work on demand — nothing runs per frame.
  window.__successor3dCutaway = (propId?: string) => {
    const all = renderer.enterableCutawayDebug();
    return propId === undefined ? all : all.find((entry) => entry.propId === propId) ?? null;
  };
  window.__successor3dPawnGrounding = (actorId?: string) =>
    renderer.pawnGroundingDebug(actorId ?? state.serverAuthority.playerActorId ?? state.playerActorId);
  // Read-only world→screen bridge for journey pointer routes (no mutation).
  window.__successor3dWorldToScreen = (x: number, z: number, y = 0) => {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(y)) return null;
    const point = renderer.worldToScreen(x, z, y);
    if (!Number.isFinite(point.px) || !Number.isFinite(point.py)) return null;
    return { px: point.px, py: point.py };
  };

  return {
    state,
    slice,
    renderer,
    overlay,
    stop: () => {
      deathOverlay.dispose();
      groupHud.dispose();
      extractionHud.dispose();
      firstSteps.dispose();
      toolbar.dispose();
      radar.dispose();
      combatQueue.dispose();
      window.clearInterval(worldLoopTimer);
      renderer.onDeflectAudio = null;
      renderer.setCampDoorAudio(null);
      sfx.stopAllLoops?.(300);
      loop.stop();
      moveTrace.dispose();
      gameTrace.dispose();
      disposeBugReportErrorCapture();
      delete window.__successor3dActorLinkDead;
      delete window.__successor3dMacros;
      delete window.__successor3dWaypoints;
      delete window.__successor3dCutaway;
      delete window.__successor3dPawnGrounding;
      delete window.__successor3dWorldToScreen;
      unsubscribeBuilding();
      buildingController.deactivate();
      buildPanel.dispose();
      gameCursor.dispose();
      unwireTradeLifecycle();
      cancelFeaturePreload();
    },
  };
}

interface FrameLoopParams {
  state: PlayState;
  slice: SliceSnapshot;
  renderer: SuccessorThreeRenderer;
  overlay: Successor3dOverlayLayer;
  authority: GameAuthorityClient;
  input: Successor3dInputController;
  windows: WindowManager;
  dock: WindowDock;
  radial: ContextRadial;
  targetPlate: TargetPlateController;
  chatPane: ChatPaneController;
  interactPrompt: InteractPromptController;
  sfx: SfxPlayer;
  setStatus: (message: string) => void;
  moveRecorder: MovementRecorder;
  gameTrace: SuccessorGameTraceController;
  /** Macro engine pump: receipts in → tick → finished-run notices out. */
  pumpMacroRuntime: () => void;
}

function createFrameLoop(params: FrameLoopParams): { start: () => void; stop: () => void } {
  let frameId = 0;
  let running = false;
  let lastTime = performance.now();
  let fps = 0;
  let joinLogged = false;
  let lastStatusAt = 0;
  let recorderFailed = false;
  let gameTraceFailed = false;
  // Planet load screen: fires on area CHANGES only — boot shows its own.
  let lastLoadScreenAreaId = params.state.activeAreaId;
  // Testing aids: ?unlimitedAmmo=1 re-asserts the flag around updatePlayState
  // (the authority loadout sync force-clears it); ?equip=slugthrower sends ONE
  // SetEquippedWeapon once the authority session is live (the 3D client ships
  // no loadout panels yet, so there is otherwise no equip path).
  const searchParams = new URLSearchParams(window.location.search);
  const unlimitedAmmo = searchParams.get("unlimitedAmmo") === "1";
  const equipParam = searchParams.get("equip");
  let equipSent = false;
  // Join snap (defensive one-shot): on (re)connect the authority may hold our
  // actor away from the locally predicted spawn (session takeover flapping,
  // shard-held positions). The shared reconciler normally teleports on >2.25
  // cells once snapshots flow; this belt-and-suspenders snap covers the first
  // connected frame explicitly so the camera can never open on empty desert
  // with the real pawn off-screen. No-op when local and authority agree.
  let joinSnapDone = false;

  const frame = (time: number) => {
    if (!running) return;
    const dtMs = Math.min(100, Math.max(0, time - lastTime));
    lastTime = time;
    const dtSeconds = dtMs / 1000;
    const traceRenderEnabled = successorMoveTraceEnabled();
    const traceRenderFromX = traceRenderEnabled ? params.state.player.x : 0;
    const traceRenderFromY = traceRenderEnabled ? params.state.player.y : 0;
    if (unlimitedAmmo) params.state.loadout.unlimitedAmmo = true;
    // Refresh the explicit soft lock before toolbar/radial input resolves.
    const lockPlayerId = params.state.serverAuthority.playerActorId ?? params.state.playerActorId;
    updateSoftLock(params.state, lockPlayerId);
    updatePlayState(params.state, params.slice, dtMs, time, params.sfx);
    if (unlimitedAmmo) params.state.loadout.unlimitedAmmo = true;
    // Macro engine rides the same estimated server tick that stamps outgoing
    // commands; receipts ingested first so waits resolve this frame.
    params.pumpMacroRuntime();
    if (!joinSnapDone && params.state.serverAuthority.connected) {
      const snapActorId = params.state.serverAuthority.playerActorId ?? params.state.playerActorId;
      const authoritative = params.state.serverAuthority.actors[snapActorId];
      if (authoritative && authoritative.areaId === params.state.activeAreaId) {
        joinSnapDone = true;
        const distance = Math.hypot(authoritative.x - params.state.player.x, authoritative.y - params.state.player.y);
        if (distance > 3) {
          params.state.player.x = authoritative.x;
          params.state.player.y = authoritative.y;
        }
      }
    }
    if (equipParam && !equipSent && isWeaponId(equipParam) && params.state.serverAuthority.connected
      && params.state.serverAuthority.actors[params.state.serverAuthority.playerActorId ?? params.state.playerActorId]) {
      setEquippedWeaponAuthoritative(params.state, params.slice, equipParam);
      equipSent = true;
    }
    if (traceRenderEnabled) {
      recordRenderPositionMoved(params.state, time, traceRenderFromX, traceRenderFromY);
    }

    if (params.state.examineActorId && !targetExamineActorAvailable(params.state, params.slice)) {
      params.state.examineActorId = null;
      if (params.windows.isOpen(TARGET_EXAMINE_WINDOW_ID)) params.windows.close(TARGET_EXAMINE_WINDOW_ID);
    }
    if (params.state.activeAreaId !== lastLoadScreenAreaId) {
      const catalog = travelCatalogFrom(params.slice);
      presentLoadScreen({
        planet: catalog?.planets.find((planet) => planet.areaId === params.state.activeAreaId) ?? null,
        fallbackLabel: params.state.activeAreaId.toUpperCase(),
        phase: "travel",
      });
      lastLoadScreenAreaId = params.state.activeAreaId;
      // A key held through the jump must not keep marching the arrival:
      // drop held movement state (keyups after this are no-op filters).
      params.state.keys.clear();
      params.state.movementKeyOrder.length = 0;
      // The terminal you used is a planet away — its screen closes with it.
      if (params.windows.isOpen("travel")) params.windows.close("travel");
    }
    const frameStats = params.renderer.render(params.slice, params.state, dtSeconds, time);
    const overlayStats = params.overlay.render(params.slice, params.state, time);
    // Survey scans: drain session-targeted results into the world-anchored
    // client store (runs even while the window is closed — slash-command
    // scans and late arrivals must never be dropped).
    const surveyResults = params.state.serverAuthority.surveyResults;
    if (surveyResults.length > 0) {
      for (const result of surveyResults) ingestSurveyResult(result.areaId, result);
      surveyResults.length = 0;
    }
    if (window.__successor3dSurvey?.version !== surveyStoreVersion()) {
      const areaId = params.state.activeAreaId;
      const last = lastSurveyResultFor(areaId, IRON_FAMILY);
      window.__successor3dSurvey = {
        version: surveyStoreVersion(),
        discCount: surveyDiscsFor(areaId, IRON_FAMILY).length,
        lastSpawnName: last?.spawnName ?? null,
        lastAreaId: last ? areaId : null,
        localConcentrationMilli: surveyConcentrationAt(
          areaId,
          IRON_FAMILY,
          params.state.player.x,
          params.state.player.y,
        ),
      };
    }
    // Trade lifecycle first (channel sync + partner auto-open), then the
    // window system: per-frame fanout to visible content handles only
    // (the manager suspends updates while alt-hidden or closed).
    pollTradeLifecycle(params.state, params.windows);
    params.interactPrompt.tick(time);
    params.windows.update(dtSeconds, time);
    const instantFps = dtMs > 0 ? 1000 / dtMs : fps;
    fps = fps === 0
      ? instantFps
      : fps * (1 - SUCCESSOR_3D_CONFIG.debug.fpsSmoothing) + instantFps * SUCCESSOR_3D_CONFIG.debug.fpsSmoothing;
    refreshDebugProbe(params.state, params.slice, params.renderer, frameStats.visiblePawns, fps, overlayStats);
    if (!gameTraceFailed) {
      try {
        params.gameTrace.sample(params.state, time);
      } catch (error) {
        gameTraceFailed = true;
        console.warn("game trace disabled after error", error);
      }
    }
    if (!recorderFailed) {
      try {
        params.moveRecorder.sample(params.state, time);
      } catch (error) {
        recorderFailed = true;
        console.warn("movement recorder disabled after error", error);
      }
    }
    const authorityActorCount = countServerActors(params.state);
    if (!joinLogged && params.state.serverAuthority.connected && authorityActorCount > 0) {
      joinLogged = true;
      console.log("Successor 3D joined game authority", {
        sessionId: params.state.serverAuthority.sessionId,
        actorId: params.state.serverAuthority.playerActorId ?? params.state.playerActorId,
        actorCount: authorityActorCount,
      });
    }
    if (time - lastStatusAt > 250) {
      const unresolvedCommands = params.state.authorityCommands.pending.length
        + (params.state.authorityCommands.inFlight ? 1 : 0);
      const transportStatus = params.state.serverAuthority.status === "connected"
        ? null
        : `${params.state.status}${unresolvedCommands > 0 ? ` · ${unresolvedCommands} COMMAND${unresolvedCommands === 1 ? "" : "S"} PENDING` : ""}`;
      params.setStatus(transportStatus ?? `Server connected · actors ${window.__successor3d?.actorCount ?? 0} · ${Math.round(fps)} fps`);
      lastStatusAt = time;
    }
    frameId = requestAnimationFrame(frame);
  };

  return {
    start() {
      if (running) return;
      running = true;
      lastTime = performance.now();
      frameId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      installMovementVectorModifier(null);
      params.input.dispose();
      params.moveRecorder.dispose();
      params.radial.dispose();
      params.dock.dispose();
      params.windows.dispose();
      registerExamineOpener(null);
      params.targetPlate.dispose();
      params.chatPane.dispose();
      params.interactPrompt.dispose();
      params.authority.close();
      params.renderer.dispose();
      params.overlay.dispose();
    },
  };
}

function recordRenderPositionMoved(state: PlayState, time: number, fromX: number, fromY: number): void {
  const dx = state.player.x - fromX;
  const dy = state.player.y - fromY;
  if (Math.hypot(dx, dy) <= 0.0001) return;
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const authority = state.serverAuthority.actors[playerActorId];
  recordSuccessorMoveTrace({
    kind: "render-position-moved",
    worldTimeMs: Number(time.toFixed(3)),
    fromX: roundThousandths(fromX),
    fromY: roundThousandths(fromY),
    toX: roundThousandths(state.player.x),
    toY: roundThousandths(state.player.y),
    deltaX: roundThousandths(dx),
    deltaY: roundThousandths(dy),
    authorityX: authority ? roundThousandths(authority.x) : null,
    authorityY: authority ? roundThousandths(authority.y) : null,
    moving: state.moving,
    snapshotTick: state.serverAuthority.snapshotTick,
    predictionErrorCells: state.serverAuthority.predictionErrorCells,
    inFlightMoves: state.serverAuthority.inFlightMoves.length,
  });
}

const probeClipsScratch: ActiveClipsByLayer = { base: null, upper: null, hand: null, arm: null, montage: null };
const probeRenderScratch: { id: string; x: number; z: number }[] = [];
let probeLastRejectCommandId = -1;

function refreshDebugProbe(
  state: PlayState,
  slice: SliceSnapshot,
  renderer: SuccessorThreeRenderer,
  visiblePawns: number,
  fps: number,
  overlayStats: OverlayFrameStats,
): void {
  const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const probe = window.__successor3d ?? {
    tick: 0,
    actorCount: 0,
    authorityActorKeys: [],
    fps: 0,
    playerCell: { x: 0, y: 0 },
    serverStatus: "off",
    selectedActorId: null,
    selectedActor: null,
    examineActorId: null,
    zoomPercent: state.settings.mouse.cameraZoomPercent,
    status: state.status,
    playerActorId,
    localEquipmentIds: [],
    localFacePaint: null,
    sourceMatchesClient: null,
    acceptedCommands: 0,
    rejectedCommands: 0,
    authorityReceiptTail: [],
    duel: createEmptyDuelProbeState(),
    duelOutcomes: [],
    playerLifeState: null,
    playerAuthorityLifeState: null,
    playerRespawnTick: 0,
    playerCloneSickness: 0,
    playerIncapRemainingMs: 0,
    playerIncapCount: 0,
    playerIncapWindowMs: 0,
    nameplateCount: 0,
    bubbleCount: 0,
    bubbleActorKeys: [],
    lodHiFiActors: 0,
    lodSimActors: 0,
    activeClipsByLayer: null,
    muzzleWorld: null,
    downedCount: 0,
    inventoryRows: 0,
    inventoryPlayerRows: 0,
    authorityPlayer: null,
    activeAreaId: "",
    predictionErrorCells: 0,
    renderDriftMaxCells: 0,
    renderDriftActors: 0,
    combatEventLog: [],
    moveGate: {
      moving: false,
      status: "",
      inFlightMoves: 0,
      pendingMoves: 0,
      lastMoveIssuedAtTick: null,
      snapshotTick: 0,
      sendGateStalled: false,
      predictionErrorCells: 0,
      lastMoveCommandAtMs: null,
      nextMoveCommandAtMs: 0,
      moveCommandIntervalMs: 0,
      sentMoveTail: [],
      receiptTail: [],
    },
    rejectLog: [],
    nearestHostile: null,
    travelTerminalScreen: null,
    weather: null,
    interactions: [],
    selectedInteraction: null,
    doorStates: {},
    placedExtractors: [],
    placedCamps: [],
    campDoors: {},
    playerCorpses: [],
    floatingTexts: [],
  };
  window.__successor3d = probe;
  probe.tick = state.serverAuthority.snapshotTick;
  probe.actorCount = Math.max(visiblePawns, countServerActors(state));
  syncAuthorityActorKeys(probe.authorityActorKeys, state.serverAuthority.actors);
  probe.fps = Math.round(fps * 10) / 10;
  probe.playerCell.x = roundThousandths(state.player.x);
  probe.playerCell.y = roundThousandths(state.player.y);
  probe.serverStatus = state.serverAuthority.status;
  probe.selectedActorId = state.selectedActorId;
  probe.selectedActor = state.selectedActorId
    ? actorDebugProjection(state, renderer, playerActorId, state.selectedActorId)
    : null;
  probe.examineActorId = state.examineActorId;
  probe.zoomPercent = state.settings.mouse.cameraZoomPercent;
  probe.status = state.status;
  probe.playerActorId = playerActorId;
  probe.sourceMatchesClient = state.serverAuthority.sourceMatchesClient;
  probe.acceptedCommands = state.serverAuthority.acceptedCommands;
  if (!probe.duel) probe.duel = createEmptyDuelProbeState();
  syncDuelProbeState(probe.duel, state.serverAuthority.duel);
  if (!Array.isArray(probe.duelOutcomes)) probe.duelOutcomes = [];
  syncDuelOutcomeProbeTail(probe.duelOutcomes, state.serverAuthority.duelOutcomes);
  probe.rejectedCommands = state.serverAuthority.rejectedCommands;
  probe.floatingTexts = projectFloatingTextsProbe(state.floatingTexts);
  syncAuthorityReceiptProbeTail(
    probe.authorityReceiptTail,
    state.serverAuthority.receiptLog,
    state.serverAuthority.sentCommandLog,
  );
  probe.playerLifeState = state.actors[state.playerActorId]?.lifeState ?? null;
  const authorityMe = state.serverAuthority.actors[playerActorId];
  probe.playerAuthorityLifeState = authorityMe?.lifeState ?? null;
  probe.playerRespawnTick = authorityMe?.respawnAtTick ?? 0;
  probe.playerCloneSickness = authorityMe?.cloneSicknessRemainingMs ?? 0;
  probe.playerIncapRemainingMs = authorityMe?.incapRemainingMs ?? 0;
  probe.playerIncapCount = authorityMe?.incapCount ?? 0;
  probe.playerIncapWindowMs = authorityMe?.incapWindowMs ?? 0;
  probe.nameplateCount = overlayStats.nameplateCount;
  probe.bubbleCount = overlayStats.bubbleCount;
  probe.bubbleActorKeys.length = overlayStats.bubbleActorKeys.length;
  for (let index = 0; index < overlayStats.bubbleActorKeys.length; index += 1) probe.bubbleActorKeys[index] = overlayStats.bubbleActorKeys[index]!;
  const lodCounts = renderer.getLodCounts();
  const stormDials = renderer.getStormDials();
  if (probe.weather === null) {
    probe.weather = { phase: "idle", eventType: null, severity: 0, sheltered: false };
  }
  probe.weather.phase = stormDials.phase;
  probe.weather.eventType = stormDials.eventType;
  probe.weather.severity = Math.round(stormDials.severity * 1000) / 1000;
  probe.weather.sheltered = stormDials.sheltered;
  probe.lodHiFiActors = lodCounts.hiFi;
  probe.lodSimActors = lodCounts.sim;
  const followedActorId = state.observerCamera.followActorId ?? playerActorId;
  probe.localEquipmentIds = renderer.attachedEquipmentIdsFor(playerActorId);
  probe.localFacePaint = renderer.facePaintStatusFor(playerActorId);
  const layers = renderer.getActiveClipsByLayer(followedActorId, probeClipsScratch);
  probe.activeClipsByLayer = layers ? { ...layers } : null;
  const muzzle = renderer.getMuzzleWorldPosition(followedActorId);
  probe.muzzleWorld = muzzle
    ? { x: roundThousandths(muzzle.x), y: roundThousandths(muzzle.y), z: roundThousandths(muzzle.z) }
    : null;
  probe.downedCount = countDownedActors(state);
  probe.inventoryRows = state.inventory.length;
  probe.inventoryPlayerRows = countPlayerInventoryRows(state, playerActorId);
  const authorityActor = state.serverAuthority.actors[playerActorId];
  probe.authorityPlayer = authorityPlayerDebugProjection(authorityActor, playerActorId);
  probe.activeAreaId = state.activeAreaId;
  probe.predictionErrorCells = state.serverAuthority.predictionErrorCells;
  // Fidelity: worst render-vs-authority pawn drift (cell units; rendered
  // pawns sit at cell centers, authority positions are cell coords).
  let renderDriftMax = 0;
  let renderDriftActors = 0;
  const renderedCount = renderer.collectRenderedPositions(probeRenderScratch);
  for (let i = 0; i < renderedCount; i += 1) {
    const entry = probeRenderScratch[i]!;
    const authority = state.serverAuthority.actors[entry.id];
    if (!authority) continue;
    renderDriftActors += 1;
    const drift = Math.hypot(entry.x - (authority.x + 0.5), entry.z - (authority.y + 0.5));
    if (drift > renderDriftMax) renderDriftMax = drift;
  }
  probe.renderDriftMaxCells = roundThousandths(renderDriftMax);
  probe.renderDriftActors = renderDriftActors;
  // Fidelity: tail of the authoritative combat event log (shot truth).
  const eventLog = state.serverAuthority.eventLog;
  const eventTail = [];
  for (let i = Math.max(0, eventLog.length - 72); i < eventLog.length; i += 1) {
    const event = eventLog[i]!;
    const lifecycle = (event as { lifecycle?: { kind?: string; cause?: string } | null }).lifecycle;
    eventTail.push({
      id: event.id,
      kind: (event as { kind?: string }).kind ?? "combat",
      shooter: (event as { shooterActorId?: string }).shooterActorId ?? null,
      target: (event as { targetActorId?: string }).targetActorId ?? null,
      hit: (event as { hit?: boolean }).hit ?? null,
      damage: (event as { damage?: number }).damage ?? null,
      effect: (event as { effect?: { kind?: string } | null }).effect?.kind ?? null,
      lifecycle: lifecycle?.kind ?? null,
      cause: lifecycle?.cause ?? null,
    });
  }
  probe.combatEventLog = eventTail;
  // Movement-pipeline forensics: which gate is holding the pawn still?
  const pendingMoves = (state.authorityCommands?.pending ?? []).filter((envelope) => "Move" in envelope.command).length;
  const lastIssued = state.serverAuthority.lastMoveIssuedAtTick ?? null;
  probe.moveGate = {
    moving: state.moving,
    status: state.status,
    inFlightMoves: state.serverAuthority.inFlightMoves.length,
    pendingMoves,
    lastMoveIssuedAtTick: lastIssued,
    snapshotTick: state.serverAuthority.snapshotTick,
    sendGateStalled: lastIssued !== null && state.serverAuthority.snapshotTick < lastIssued,
    predictionErrorCells: state.serverAuthority.predictionErrorCells,
    lastMoveCommandAtMs: state.serverAuthority.lastMoveCommandAtMs,
    nextMoveCommandAtMs: Math.round(state.serverAuthority.nextMoveCommandAtMs * 10) / 10,
    moveCommandIntervalMs: Math.round(state.serverAuthority.moveCommandIntervalMs * 10) / 10,
    sentMoveTail: state.serverAuthority.sentCommandLog
      .filter((entry) => entry.kind === "Move")
      .slice(-8)
      .map((entry) => ({
        commandId: entry.commandId,
        issuedAtTick: entry.issuedAtTick ?? -1,
        sentAtMs: entry.sentAtMs,
      })),
    receiptTail: state.serverAuthority.receiptLog
      .filter((entry) => {
        const sent = state.serverAuthority.sentCommandLog.find((sentEntry) => sentEntry.commandId === entry.commandId);
        return sent?.kind === "Move";
      })
      .slice(-8)
      .map((entry) => ({
        commandId: entry.commandId,
        accepted: entry.accepted,
        tick: entry.tick,
        reasonCode: entry.reasonCode,
      })),
  };
  // Reject-reason ring: fold NEW rejected receipts (kind resolved via the
  // sent-command log, same trick commandReceipts.ts uses).
  const receipt = state.serverAuthority.lastReceipt;
  if (receipt && !receipt.accepted && receipt.commandId !== probeLastRejectCommandId) {
    probeLastRejectCommandId = receipt.commandId;
    const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
    probe.rejectLog.push({ kind: sent?.kind ?? "unknown", reason: receipt.reasonCode ?? "unspecified" });
    if (probe.rejectLog.length > 10) probe.rejectLog.shift();
  }
  probe.nearestHostile = nearestHostileProbe(state, renderer, playerActorId);
  probe.travelTerminalScreen = renderer.animatedPropScreen("Module_screen");
  // Same option list the F prompt / V-cycle chip use. selectedIndex picks the
  // active option; the array order stays nearest-first and is never mutated here.
  const interactionRoster = interactionOptions(slice, state);
  probe.interactions = interactionRoster.map((option) => ({
    id: option.id,
    kind: option.kind,
    targetId: option.targetId,
    detail: option.detail,
    distanceCells: roundThousandths(option.distanceCells),
    ...(option.doorOpen === undefined ? {} : { doorOpen: option.doorOpen }),
  }));
  if (interactionRoster.length === 0) {
    probe.selectedInteraction = null;
  } else {
    const rawIndex = Number(state.interactions.selectedIndex);
    const clampedIndex = Number.isFinite(rawIndex)
      ? Math.max(0, Math.min(Math.trunc(rawIndex), interactionRoster.length - 1))
      : 0;
    const selected = interactionRoster[clampedIndex] ?? null;
    probe.selectedInteraction = selected
      ? { id: selected.id, kind: selected.kind, targetId: selected.targetId }
      : null;
  }
  probe.doorStates = Object.fromEntries(
    Object.entries(state.serverAuthority.propStates ?? {})
      .filter(([, propState]) => typeof propState.doorOpen === "boolean")
      .map(([propId, propState]) => [propId, { doorOpen: propState.doorOpen ?? null }]),
  );
  probe.placedExtractors = state.serverAuthority.placedExtractors.map((extractor) => ({
    extractorId: extractor.extractorId,
    areaId: extractor.areaId,
    cellX: extractor.cellX,
    cellY: extractor.cellY,
    mode: extractor.mode,
    hopperPct: extractor.hopperPct,
    collectableUnits: extractor.collectableUnits,
    batteryPct: extractor.batteryPct,
    isOwner: extractor.isOwner,
  }));
  probe.placedCamps = state.serverAuthority.placedCamps.map((camp) => ({
    campId: camp.campId,
    areaId: camp.areaId,
    cellX: camp.cellX,
    cellY: camp.cellY,
    isOwner: camp.isOwner,
    renderKind: camp.renderKind,
    abandonSecondsRemaining: camp.abandonSecondsRemaining ?? null,
  }));
  probe.campDoors = renderer.campDoorStates();
  probe.playerCorpses = playerCorpseProbeProjections(state, (x, z, y) => renderer.worldToScreen(x, z, y));
}

/**
 * Nearest living non-player actor for the verification harness: aiming needs
 * a screen anchor and QA needs an activation read. Excludes the local player
 * and same-faction… deliberately NOT — the open-desert world's only other
 * actors are hostiles/camp placeholders; the harness filters by id when it
 * cares. Screen coords are CSS px from the renderer's projector (null when
 * behind/degenerate).
 */
function nearestHostileProbe(
  state: PlayState,
  renderer: SuccessorThreeRenderer,
  playerActorId: string,
): Successor3dDebugProbe["nearestHostile"] {
  const me = state.serverAuthority.actors[playerActorId];
  if (!me) return null;
  let best: (typeof state.serverAuthority.actors)[string] | null = null;
  let bestDistance = Infinity;
  for (const actorId in state.serverAuthority.actors) {
    if (actorId === playerActorId) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor || actor.lifeState !== "alive") continue;
    if (actor.areaId !== me.areaId) continue;
    const distance = Math.hypot(actor.x - me.x, actor.y - me.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = actor;
    }
  }
  if (!best) return null;
  return actorDebugProjection(state, renderer, playerActorId, best.id);
}

/** Exact-id renderer projection used by selected-actor browser proof. */
function actorDebugProjection(
  state: PlayState,
  renderer: SuccessorThreeRenderer,
  playerActorId: string,
  actorId: string,
): Successor3dActorDebugProjection | null {
  const me = state.serverAuthority.actors[playerActorId];
  const actor = state.serverAuthority.actors[actorId];
  if (!me || !actor || actor.areaId !== me.areaId) return null;
  const clips = renderer.getActiveClipsByLayer(actorId, probeClipsScratch);
  // worldToScreen(x, z, y): z is the SIM y-coordinate, y is HEIGHT (chest).
  const screen = clips ? renderer.worldToScreen(actor.x + 0.5, actor.y + 0.5, 1.0) : null;
  return {
    id: actorId,
    x: roundThousandths(actor.x),
    y: roundThousandths(actor.y),
    distanceCells: roundThousandths(Math.hypot(actor.x - me.x, actor.y - me.y)),
    lifeState: actor.lifeState,
    rendered: clips !== null,
    baseClip: clips?.base ?? null,
    screen: screen ? { px: Math.round(screen.px), py: Math.round(screen.py) } : null,
  };
}

function countServerActors(state: PlayState): number {
  let count = 0;
  for (const actorId in state.serverAuthority.actors) {
    if (state.serverAuthority.actors[actorId]) count += 1;
  }
  return count;
}

function countPlayerInventoryRows(state: PlayState, playerActorId: string): number {
  let count = 0;
  for (const row of state.inventory) {
    if (row.container === playerActorId || row.container.startsWith(`${playerActorId}:`)) count += 1;
  }
  return count;
}

function countDownedActors(state: PlayState): number {
  let count = 0;
  for (const actorId in state.serverAuthority.actors) {
    if (state.serverAuthority.actors[actorId]?.lifeState === "downed") count += 1;
  }
  return count;
}

// (Foreign-actor spawn defaults are the SERVER's job — shard.ts derives the
// identity-join spawn area from its own primary source area; the client's
// activeAreaId follows the authority snapshot.)

/**
 * The shared settings default is 45% zoom; the 3D app's owner-directed default
 * is the character-centered 100% frame (~40 cells
 * wide). Only applied when the user has no explicitly persisted zoom value.
 */
function applySuccessor3dDefaultZoom(state: PlayState, storage: Pick<Storage, "getItem">): void {
  const raw = storage.getItem(runtimeSettingsStorageKey);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed && typeof parsed === "object" && "mouse" in parsed
        && parsed.mouse && typeof parsed.mouse === "object" && "cameraZoomPercent" in parsed.mouse
        && typeof parsed.mouse.cameraZoomPercent === "number"
      ) {
        return; // user has a persisted zoom choice
      }
    } catch {
      // fall through to the 3D default
    }
  }
  state.settings.mouse.cameraZoomPercent = 100;
}

function roundThousandths(value: number): number {
  return Math.round(value * 1000) / 1000;
}
