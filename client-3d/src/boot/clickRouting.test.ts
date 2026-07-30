import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthorityCommandQueue } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { ActorSnapshot, PlayState, ServerAuthorityPlacedCampState, ServerAuthorityPlacedExtractorState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { SuccessorThreeRenderer } from "../render/SuccessorThreeRenderer";
import { pickActorAtScreenPoint3d, type ScreenProjector } from "../render/picking";
import type { WorldPropPickResult } from "../render/props";
import type { ExtractorPickResult } from "../render/extractors";
import type { CampPickResult } from "../render/camps";
import type { PlayerCorpsePickResult } from "../render/playerCorpses";
import type { ContextRadial, RadialHandlers, RadialAction } from "../ui/windows/contextRadial";
import type { ToolbarController } from "../ui/hud/toolbar";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { BUILD_TOGGLE_KEY_CODE, installSuccessor3dInput } from "./input";
import type { BuildingController } from "../render/building";
import {
  actorPointerGrammarDecision,
  classifyActorClick,
  classifyPropClick,
  createActorClickMemory,
  createPropClickMemory,
  propPointerGrammarDecision,
  resetActorClickMemory,
  resetPropClickMemory,
} from "./clickRouting";

vi.mock("../debug/inputRecorder", () => ({
  recordInputEvent: vi.fn(),
  installInputRecorderProbe: vi.fn(),
}));

const POINTER_CAPTURE_KEY = `pointer${"Lock"}Element`;

function actor(id: string, x: number, y: number): ActorSnapshot {
  return {
    id,
    entity: `fixture:${id}`,
    areaId: "desert",
    label: id,
    role: "remote_actor",
    sprite: "adventurer-premium-male",
    poseSet: "idle",
    direction: "S",
    cell: { x, y },
    route: [],
  };
}

type Listener = (event: unknown) => void;

class TestEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    if (!("target" in event)) event.target = this;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class TestCanvas extends TestEventTarget {
  readonly ownerDocument: Document;
  clientWidth = 800;
  clientHeight = 600;

  constructor(ownerDocument: Document) {
    super();
    this.ownerDocument = ownerDocument;
  }

  focus(): void {
    // no-op
  }

  getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  }
}

interface HarnessOptions {
  propPick?: WorldPropPickResult | null;
  cacheEmptied?: boolean;
  extractorPick?: ExtractorPickResult | null;
  placedExtractors?: ServerAuthorityPlacedExtractorState[];
  campPick?: CampPickResult | null;
  placedCamps?: ServerAuthorityPlacedCampState[];
  corpsePick?: PlayerCorpsePickResult | null;
  buildingController?: BuildingController;
  onBuildToggle?: () => void;
}

interface MutableProbe<T> {
  current: T;
  calls: number;
}

type RadialOpenState = { actions: readonly RadialAction[]; handlers: RadialHandlers } | null;

interface Harness {
  target: TestEventTarget;
  canvas: TestCanvas;
  documentRef: Document;
  state: PlayState;
  radial: ContextRadial & { opened: RadialOpenState };
  propPick: MutableProbe<WorldPropPickResult | null>;
  extractorPick: MutableProbe<ExtractorPickResult | null>;
  campPick: MutableProbe<CampPickResult | null>;
  corpsePick: MutableProbe<PlayerCorpsePickResult | null>;
  examinedProp: { id: string | null };
  openedBankTerminal: { id: string | null };
  openedCloneTerminal: { id: string | null };
  openedPaTerminal: { id: string | null };
  openedExchange: { id: string | null };
  openedLoot: { target: { kind: "corpse" | "cache" | "playerCorpse"; id: string } | null };
  conversed: { id: string | null };
  traded: { id: string | null };
  slice: SliceSnapshot;
  dispose: () => void;
}

function createDocumentRef(): Document {
  return {
    [POINTER_CAPTURE_KEY]: null,
    activeElement: null,
    hasFocus: () => true,
  } as unknown as Document;
}

function serverActor(id: string, x: number, y: number, factionId: string): Record<string, unknown> {
  return {
    id,
    label: id,
    role: "remote_actor",
    x,
    y,
    renderX: x,
    renderY: y,
    areaId: "desert",
    factionId,
    lifeState: "alive",
    pvpStatus: "combatant",
  };
}

function cachePick(propId = "open-desert-cache-01"): WorldPropPickResult {
  return { propId, kind: "storage_chest", label: "Supply Cache", interactable: true };
}

function createHarness(options: HarnessOptions = {}): Harness {
  const documentRef = createDocumentRef();
  const target = new TestEventTarget();
  const canvas = new TestCanvas(documentRef);
  const propPick: MutableProbe<WorldPropPickResult | null> = { current: options.propPick ?? null, calls: 0 };
  const extractorPick: MutableProbe<ExtractorPickResult | null> = { current: options.extractorPick ?? null, calls: 0 };
  const campPick: MutableProbe<CampPickResult | null> = { current: options.campPick ?? null, calls: 0 };
  const corpsePick: MutableProbe<PlayerCorpsePickResult | null> = { current: options.corpsePick ?? null, calls: 0 };
  const examinedProp = { id: null as string | null };
  const openedBankTerminal: Harness["openedBankTerminal"] = { id: null };
  const openedCloneTerminal: Harness["openedCloneTerminal"] = { id: null };
  const openedPaTerminal: Harness["openedPaTerminal"] = { id: null };
  const openedExchange: Harness["openedExchange"] = { id: null };
  const openedLoot: Harness["openedLoot"] = { target: null };
  const conversed: Harness["conversed"] = { id: null };
  const traded: Harness["traded"] = { id: null };
  const state = {
    activeAreaId: "desert",
    actors: { player: { lifeState: "alive" } },
    player: { x: 0, y: 0 },
    playerActorId: "player",
    selectedActorId: null,
    examineActorId: null,
    interactions: { options: [], selectedIndex: 0 },
    aim: {
      vectorX: 0,
      vectorY: 0,
      active: false,
      softLockActorId: null,
    },
    inventory: [],
    serverAuthority: {
      enabled: true,
      playerActorId: "player",
      actors: {
        player: serverActor("player", 0, 0, "player"),
        rogue: serverActor("rogue", 2, 2, "rogue"),
      },
      inFlightMoves: [],
      wasMovingLastFrame: false,
      lastMoveVector: null,
      nextMoveCommandAtMs: 0,
      propStates: {},
      placedExtractors: options.placedExtractors ?? [],
      placedCamps: options.placedCamps ?? [],
    },
    authorityCommands: createAuthorityCommandQueue(),
    settings: {
      bindings: {
        keyboardFire: ["Space"],
        reload: ["KeyR"],
        interact: ["KeyF"],
      },
      mouse: { cameraZoomPercent: 55 },
    },
    keys: new Set<string>(),
    movementKeyOrder: [],
    movementInputMode: "world",
    rotationLockFacing: null,
    facing: "S",
    moving: false,
    transitionCooldownMs: 0,
    observerCamera: { inputLocked: false },
    death: { phase: "alive" },
  } as unknown as PlayState;
  if (propPick.current && options.cacheEmptied !== undefined) {
    (state.serverAuthority.propStates ??= {})[propPick.current.propId] = { cacheEmptied: options.cacheEmptied };
  }
  const slice = {
    actors: [],
    grid: { cellSizePx: 10 },
    camera: { followActor: "player" },
    combatModel: "roll",
    tickRateHz: 30,
    tick: 90,
  } as unknown as SliceSnapshot;
  const renderer = {
    canvas,
    screenOffsetToWorldGround(screenX: number, screenY: number) {
      return { x: screenX / 10, y: 0, z: screenY / 10 };
    },
    worldToScreen(x: number, z: number, y = 0) {
      return { px: x * 10, py: z * 10 - y * 10 };
    },
    pickPropAtScreenPoint() {
      propPick.calls += 1;
      return propPick.current;
    },
    pickExtractorAtScreenPoint() {
      extractorPick.calls += 1;
      return extractorPick.current;
    },
    pickCampAtScreenPoint() {
      campPick.calls += 1;
      return campPick.current;
    },
    pickPlayerCorpseAtScreenPoint() {
      corpsePick.calls += 1;
      return corpsePick.current;
    },
  } as unknown as SuccessorThreeRenderer;
  const toolbar = { pressCode: () => false } as unknown as ToolbarController;
  const radial: ContextRadial & { opened: RadialOpenState } = {
    opened: null,
    get isOpen() {
      return this.opened !== null;
    },
    openFor(_clientX: number, _clientY: number, actions: readonly RadialAction[], handlers: RadialHandlers): void {
      this.opened = { actions, handlers };
    },
    close(): void {
      this.opened = null;
    },
    dispose(): void {
      this.opened = null;
    },
  };
  const controller = installSuccessor3dInput({
    buildingController: options.buildingController,
    onBuildToggle: options.onBuildToggle,
    target: target as unknown as Window,
    renderer,
    state,
    slice,
    sfx: { play: () => undefined } as unknown as SfxPlayer,
    toolbar,
    radial: radial as ContextRadial,
    onInteract: () => undefined,
    onInteractRelease: () => undefined,
    onExamineActor: (actorId) => {
      state.examineActorId = actorId;
    },
    onExamineProp: (propId) => {
      examinedProp.id = propId;
    },
    onOpenBankTerminal: (propId) => {
      openedBankTerminal.id = propId;
    },
    onOpenCloneTerminal: (propId) => {
      openedCloneTerminal.id = propId;
    },
    onOpenPaTerminal: (propId) => {
      openedPaTerminal.id = propId;
    },
    onOpenExchange: (propId) => {
      openedExchange.id = propId;
    },
    onOpenTravelTerminal: () => {},
    onOpenLoot: (lootTarget) => {
      openedLoot.target = lootTarget;
    },
    onConverseActor: (actorId) => {
      conversed.id = actorId;
    },
    onTradeActor: (actorId) => {
      traded.id = actorId;
    },
  });
  return { target, canvas, documentRef, state, slice, radial: radial as Harness["radial"], propPick, extractorPick, campPick, corpsePick, examinedProp, openedBankTerminal, openedCloneTerminal, openedPaTerminal, openedExchange, openedLoot, conversed, traded, dispose: controller.dispose };
}

function mouse(button: number, offsetX: number, offsetY: number): MouseEvent {
  const event = {
    button,
    offsetX,
    offsetY,
    clientX: offsetX,
    clientY: offsetY,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event as unknown as MouseEvent;
}

function key(code: string, repeat = false): KeyboardEvent {
  const event = {
    code,
    repeat,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    target: null,
    defaultPrevented: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
  };
  return event as unknown as KeyboardEvent;
}

function basicShotCommands(state: PlayState): unknown[] {
  return state.authorityCommands.pending.filter((entry) => {
    const payload = commandPayload(entry.command, "QueueCombatAction");
    return payload !== null && Reflect.get(payload, "action_id") === "basic_shot";
  });
}

function commandPayload(command: unknown, key: string): object | null {
  if (!command || typeof command !== "object" || !(key in command)) return null;
  const payload = Reflect.get(command, key);
  return payload && typeof payload === "object" ? payload : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("actor click routing", () => {
  it("promotes only a fast second click on the same actor into default action intent", () => {
    const memory = createActorClickMemory();
    expect(classifyActorClick(memory, "rogue-1", 1_000)).toBe("target");
    expect(classifyActorClick(memory, "rogue-2", 1_100)).toBe("target");
    expect(classifyActorClick(memory, "rogue-2", 1_449)).toBe("defaultAction");
    expect(classifyActorClick(memory, "rogue-2", 1_900)).toBe("target");
  });

  it("resets ground clicks so empty ground clicks cannot arm a later actor attack", () => {
    const memory = createActorClickMemory();
    expect(classifyActorClick(memory, "rogue-1", 2_000)).toBe("target");
    resetActorClickMemory(memory);
    expect(classifyActorClick(memory, "rogue-1", 2_120)).toBe("target");
  });

  it("keeps the final always-cursor actor/ground click grammar explicit", () => {
    expect(actorPointerGrammarDecision({ button: "left", actorHit: true, doubleClick: false, attackable: true })).toBe("targetOnly");
    expect(actorPointerGrammarDecision({ button: "left", actorHit: true, doubleClick: true, attackable: true })).toBe("defaultAttack");
    expect(actorPointerGrammarDecision({ button: "left", actorHit: true, doubleClick: true, attackable: false })).toBe("defaultExamine");
    expect(actorPointerGrammarDecision({ button: "right", actorHit: true, doubleClick: false, attackable: true })).toBe("openRadial");
    expect(actorPointerGrammarDecision({ button: "left", actorHit: false, doubleClick: false, attackable: false })).toBe("groundOnly");
    expect(actorPointerGrammarDecision({ button: "right", actorHit: false, doubleClick: false, attackable: false })).toBe("strafeGround");
  });

  it("keeps the prop click grammar explicit", () => {
    const memory = createPropClickMemory();
    expect(classifyPropClick(memory, "cache-1", 3_000)).toBe("examine");
    expect(classifyPropClick(memory, "cache-1", 3_250)).toBe("defaultAction");
    resetPropClickMemory(memory);
    expect(classifyPropClick(memory, "cache-1", 3_300)).toBe("examine");
    expect(propPointerGrammarDecision({ button: "left", doubleClick: false })).toBe("propExamine");
    expect(propPointerGrammarDecision({ button: "left", doubleClick: true })).toBe("propDefaultLoot");
    expect(propPointerGrammarDecision({ button: "right", doubleClick: false })).toBe("propRadial");
  });

  it("uses actor silhouette picks before ground-footprint fallback", () => {
    const slice = {
      actors: [actor("ground-under-pointer", 1, 1), actor("screen-silhouette", 5, 5)],
      grid: { cellSizePx: 10 },
      camera: { followActor: "player" },
    } as unknown as SliceSnapshot;
    const state = {
      activeAreaId: "desert",
      actors: {},
      player: { x: 0, y: 0 },
      playerActorId: "player",
      observerCamera: { followActorId: null },
      serverAuthority: { enabled: false },
    } as unknown as PlayState;
    const projector: ScreenProjector = {
      worldToScreen(x: number, z: number, y = 0, target = { px: 0, py: 0 }) {
        target.px = x * 20;
        target.py = 200 - z * 20 - y * 45;
        return target;
      },
    };

    const picked = pickActorAtScreenPoint3d(
      slice,
      state,
      0,
      110,
      55,
      1.5,
      2,
      projector,
    );

    expect(picked).toBe("screen-silhouette");
  });

  it("keeps document pointer capture null through boot, actor radial Examine, and pane interaction", () => {
    const harness = createHarness();
    expect((harness.documentRef as unknown as Record<string, unknown>)[POINTER_CAPTURE_KEY]).toBeNull();

    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toContain("examine");
    expect((harness.documentRef as unknown as Record<string, unknown>)[POINTER_CAPTURE_KEY]).toBeNull();

    harness.radial.opened?.handlers.onAction("examine");
    expect(harness.state.examineActorId).toBe("rogue");
    harness.target.dispatch("mouseup", mouse(0, 40, 40) as unknown as Record<string, unknown>);
    expect((harness.documentRef as unknown as Record<string, unknown>)[POINTER_CAPTURE_KEY]).toBeNull();

    harness.dispose();
  });

  it("queues no attack command from a single LMB on actor or ground", () => {
    const harness = createHarness();
    vi.spyOn(performance, "now").mockReturnValue(1_000);

    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);
    expect(basicShotCommands(harness.state)).toHaveLength(0);
    harness.target.dispatch("mouseup", mouse(0, 25, 30) as unknown as Record<string, unknown>);
    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("queues exactly one basic_shot from double-LMB on an attackable actor", () => {
    const harness = createHarness();
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1_000);
    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);
    now.mockReturnValue(1_300);
    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);

    expect(basicShotCommands(harness.state)).toHaveLength(1);

    harness.dispose();
  });

  it("radial Examine never queues attack", () => {
    const harness = createHarness();
    vi.spyOn(performance, "now").mockReturnValue(2_000);

    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    harness.radial.opened?.handlers.onAction("examine");

    expect(harness.state.examineActorId).toBe("rogue");
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("routes single, double, and right-click prop actions without attacking", () => {
    const prop = cachePick();
    const harness = createHarness({ propPick: prop });
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(4_000);

    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.examinedProp.id).toBe(prop.propId);
    expect(harness.openedLoot.target).toBeNull();
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    now.mockReturnValue(4_250);
    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.openedLoot.target).toEqual({ kind: "cache", id: prop.propId });
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual(["open", "examine"]);
    harness.radial.opened?.handlers.onAction("examine");
    expect(harness.examinedProp.id).toBe(prop.propId);

    harness.dispose();
  });

  it("disables radial Open for emptied prop caches", () => {
    const prop = cachePick();
    const harness = createHarness({ propPick: prop, cacheEmptied: true });
    vi.spyOn(performance, "now").mockReturnValue(4_500);

    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    const open = harness.radial.opened?.actions.find((entry) => entry.id === "open");
    expect(open).toMatchObject({ enabled: false, note: "Empty" });
    harness.radial.opened?.handlers.onAction("open");
    expect(harness.openedLoot.target).toBeNull();

    harness.dispose();
  });

  it("opens the extractor radial on RMB and walks the pack-up confirm guard", () => {
    const vm: ServerAuthorityPlacedExtractorState = {
      extractorId: "extractor:player:1",
      areaId: "desert",
      cellX: 1,
      cellY: 1,
      mode: "idle",
      biome: "desert",
      hopperPct: 0,
      collectableUnits: 0,
      batteryPct: 0,
      isOwner: true,
      familyLabel: "metal",
    };
    const harness = createHarness({
      extractorPick: { extractorId: vm.extractorId, label: "Personal Mineral Sampler", isOwner: true },
      placedExtractors: [vm],
    });
    vi.spyOn(performance, "now").mockReturnValue(6_000);

    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual([
      "crank",
      "insert-battery",
      "collect",
      "destroy",
    ]);
    expect(harness.propPick.calls).toBe(0);

    // PACK UP arms the confirm step — nothing queued yet.
    harness.radial.opened?.handlers.onAction("destroy");
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual([
      "confirm-destroy",
      "cancel-destroy",
    ]);
    expect(harness.state.authorityCommands.pending.filter((entry) => commandPayload(entry.command, "DestroyExtractor") !== null)).toHaveLength(0);

    harness.radial.opened?.handlers.onAction("confirm-destroy");
    const destroys = harness.state.authorityCommands.pending.filter((entry) => commandPayload(entry.command, "DestroyExtractor") !== null);
    expect(destroys).toHaveLength(1);

    harness.dispose();
  });

  it("treats foreign extractors as scenery — no radial, no verbs", () => {
    const harness = createHarness({
      extractorPick: { extractorId: "extractor:rival:9", label: "Personal Mineral Sampler", isOwner: false },
    });
    vi.spyOn(performance, "now").mockReturnValue(6_500);

    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);

    expect(harness.radial.opened).toBeNull();
    expect(harness.state.authorityCommands.pending).toHaveLength(0);

    harness.dispose();
  });

  it("treats foreign camps as scenery and two-steps the own-camp strike radial", () => {
    const foreign = createHarness({
      campPick: { campId: "camp:rival:9", label: "Scout Camp", isOwner: false },
    });
    vi.spyOn(performance, "now").mockReturnValue(6_500);
    foreign.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(foreign.radial.opened).toBeNull();
    expect(foreign.state.authorityCommands.pending).toHaveLength(0);
    foreign.dispose();

    const own = createHarness({
      campPick: { campId: "camp:player:1", label: "Scout Camp", isOwner: true },
      placedCamps: [{
        campId: "camp:player:1",
        areaId: "desert",
        cellX: 0,
        cellY: 1,
        isOwner: true,
        renderKind: "scout-camp",
      }],
    });
    own.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(own.radial.opened).not.toBeNull();
    expect(own.radial.opened!.actions.map((action) => action.id)).toEqual(["pack-up"]);

    // First step re-opens ARMED — nothing on the wire yet.
    own.radial.opened!.handlers.onAction("pack-up");
    expect(own.radial.opened!.actions.map((action) => action.id)).toEqual(["confirm-pack-up", "cancel-pack-up"]);
    expect(own.radial.opened!.actions[0]!.label).toBe("CONFIRM STRIKE · NOTHING RETURNS");
    expect(own.state.authorityCommands.pending).toHaveLength(0);

    // Confirm queues the single PackUpCamp command.
    own.radial.opened!.handlers.onAction("confirm-pack-up");
    expect(own.state.authorityCommands.pending.map((pending) => pending.command)).toEqual([{ PackUpCamp: {} }]);
    own.dispose();
  });

  it("keeps actor picks ahead of overlapping prop picks", () => {
    const prop = cachePick();
    const harness = createHarness({ propPick: prop });
    vi.spyOn(performance, "now").mockReturnValue(5_000);

    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);

    expect(harness.state.selectedActorId).toBe("rogue");
    expect(harness.examinedProp.id).toBeNull();
    expect(harness.propPick.calls).toBe(0);
    expect(harness.openedLoot.target).toBeNull();

    harness.dispose();
  });

  it("routes corpse double-click and radial Loot to the loot window", () => {
    const harness = createHarness();
    const rogue = harness.state.serverAuthority.actors.rogue as unknown as Record<string, unknown>;
    rogue.lifeState = "downed";
    rogue.lootable = true;
    rogue.hasLoot = true;
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(6_000);

    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.openedLoot.target).toBeNull();
    now.mockReturnValue(6_250);
    harness.canvas.dispatch("mousedown", mouse(0, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.openedLoot.target).toEqual({ kind: "corpse", id: "rogue" });
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.openedLoot.target = null;
    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual(["deathblow", "loot", "examine"]);
    harness.radial.opened?.handlers.onAction("loot");
    expect(harness.openedLoot.target).toEqual({ kind: "corpse", id: "rogue" });
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("offers radial Deathblow only for visibly downed actors and queues exactly one command", () => {
    const harness = createHarness();
    vi.spyOn(performance, "now").mockReturnValue(7_000);

    // Alive actor: no deathblow row.
    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.some((entry) => entry.id === "deathblow")).toBe(false);
    harness.radial.close();

    // Visibly downed (no loot surface): DEATHBLOW leads the radial. The row is
    // presentation only — Rust still rejects illegal deathblows.
    const rogue = harness.state.serverAuthority.actors.rogue as unknown as Record<string, unknown>;
    rogue.lifeState = "downed";
    rogue.lootable = false;
    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions[0]).toMatchObject({ id: "deathblow", enabled: true });

    harness.radial.opened?.handlers.onAction("deathblow");
    const deathblows = harness.state.authorityCommands.pending
      .map((entry) => commandPayload(entry.command, "Deathblow"))
      .filter((payload) => payload !== null);
    expect(deathblows).toEqual([{ target_actor_id: "rogue" }]);
    expect(harness.state.authorityCommands.pending).toHaveLength(1);
    // The radial action routes through the same local selection state.
    expect(harness.state.selectedActorId).toBe("rogue");
    expect(harness.state.softLockActorId).toBe("rogue");
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("leads trainer right-click with Converse and grays Attack behind the camp-law note", () => {
    const harness = createHarness();
    const trainer = serverActor("camp-trainer", 5, 5, "warden");
    trainer.role = "profession_trainer";
    (harness.state.serverAuthority.actors as unknown as Record<string, unknown>)["camp-trainer"] = trainer;
    vi.spyOn(performance, "now").mockReturnValue(7_000);

    harness.canvas.dispatch("mousedown", mouse(2, 55, 60) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual(["converse", "examine", "attack"]);
    expect(harness.radial.opened?.actions[0]).toMatchObject({ id: "converse", enabled: true });
    expect(harness.radial.opened?.actions[2]).toMatchObject({ id: "attack", enabled: false });
    expect(harness.radial.opened?.actions[2]?.note).toBeTruthy();

    harness.radial.opened?.handlers.onAction("converse");
    expect(harness.conversed.id).toBe("camp-trainer");
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("routes trainer double-click to converse, never attack or examine", () => {
    const harness = createHarness();
    const trainer = serverActor("camp-trainer", 5, 5, "warden");
    trainer.role = "profession_trainer";
    (harness.state.serverAuthority.actors as unknown as Record<string, unknown>)["camp-trainer"] = trainer;
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(8_000);

    harness.canvas.dispatch("mousedown", mouse(0, 55, 60) as unknown as Record<string, unknown>);
    expect(harness.conversed.id).toBeNull();
    now.mockReturnValue(8_250);
    harness.canvas.dispatch("mousedown", mouse(0, 55, 60) as unknown as Record<string, unknown>);

    expect(harness.conversed.id).toBe("camp-trainer");
    expect(harness.state.examineActorId).toBeNull();
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("grows a TRADE row on live player pawns and routes it to onTradeActor", () => {
    const harness = createHarness();
    // Park the stock hostile far away — the picker is first-hit-wins and the
    // rogue's silhouette otherwise shadows any point-blank pawn.
    const rogue = harness.state.serverAuthority.actors.rogue as unknown as Record<string, unknown>;
    rogue.x = 50; rogue.y = 50; rogue.renderX = 50; rogue.renderY = 50;
    const pawn = serverActor("vex", 1, 0, "settlers");
    pawn.role = "player";
    (harness.state.serverAuthority.actors as unknown as Record<string, unknown>)["vex"] = pawn;
    vi.spyOn(performance, "now").mockReturnValue(9_000);

    harness.canvas.dispatch("mousedown", mouse(2, 12, 2) as unknown as Record<string, unknown>);
    const trade = harness.radial.opened?.actions.find((entry) => entry.id === "trade");
    expect(trade).toMatchObject({ id: "trade", enabled: true, note: null });

    harness.radial.opened?.handlers.onAction("trade");
    expect(harness.traded.id).toBe("vex");
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });

  it("keeps the TRADE row honest out of range and off non-player actors", () => {
    const harness = createHarness();
    const pawn = serverActor("far-vex", 5, 5, "settlers");
    pawn.role = "player";
    (harness.state.serverAuthority.actors as unknown as Record<string, unknown>)["far-vex"] = pawn;
    vi.spyOn(performance, "now").mockReturnValue(9_500);

    harness.canvas.dispatch("mousedown", mouse(2, 55, 60) as unknown as Record<string, unknown>);
    const trade = harness.radial.opened?.actions.find((entry) => entry.id === "trade");
    expect(trade).toMatchObject({ id: "trade", enabled: false });
    expect(trade?.note).toBeTruthy();

    // The stock hostile (role remote_actor) never grows a TRADE row.
    harness.radial.close();
    harness.canvas.dispatch("mousedown", mouse(2, 25, 30) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.some((entry) => entry.id === "trade")).toBe(false);

    harness.dispose();
  });

  it("tracks roll Space as a held trigger without issuing an immediate command", () => {
    const harness = createHarness();
    const press = key("Space");
    const repeat = key("Space", true);
    const release = key("Space");
    const duplicateRelease = key("Space");

    harness.target.dispatch("keydown", press as unknown as Record<string, unknown>);
    harness.target.dispatch("keydown", repeat as unknown as Record<string, unknown>);
    harness.target.dispatch("keyup", release as unknown as Record<string, unknown>);
    harness.target.dispatch("keyup", duplicateRelease as unknown as Record<string, unknown>);

    expect([press, repeat, release, duplicateRelease].every((event) => event.defaultPrevented)).toBe(true);
    expect(harness.state.keys.has("Space")).toBe(false);
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.dispose();
  });
});

describe("build-mode hotkey routing", () => {
  function fakeBuildingController(): BuildingController & { active: boolean; handled: string[] } {
    const fake = {
      active: false,
      handled: [] as string[],
      isActive: () => fake.active,
      deactivate: () => {
        fake.active = false;
      },
      handleKey: (event: KeyboardEvent) => {
        if (!fake.active) return false;
        fake.handled.push(event.code);
        return event.code === "KeyR";
      },
    };
    return fake as unknown as BuildingController & { active: boolean; handled: string[] };
  }

  it("toggles the builder on N (open then close) and never edge-fires on repeat", () => {
    expect(BUILD_TOGGLE_KEY_CODE).toBe("KeyN");
    const controller = fakeBuildingController();
    let toggles = 0;
    const harness = createHarness({
      buildingController: controller,
      onBuildToggle: () => {
        toggles += 1;
        controller.active = true;
      },
    });

    const open = key(BUILD_TOGGLE_KEY_CODE);
    harness.target.dispatch("keydown", open as unknown as Record<string, unknown>);
    expect(toggles).toBe(1);
    expect(controller.active).toBe(true);
    expect(open.defaultPrevented).toBe(true);

    harness.target.dispatch("keydown", key(BUILD_TOGGLE_KEY_CODE, true) as unknown as Record<string, unknown>);
    expect(toggles).toBe(1);
    expect(controller.active).toBe(true);

    harness.target.dispatch("keydown", key(BUILD_TOGGLE_KEY_CODE) as unknown as Record<string, unknown>);
    expect(controller.active).toBe(false);
    expect(toggles).toBe(1);

    harness.dispose();
  });

  it("leaves plain B and V untouched by the builder — Action Browser and interact cycling keep them", () => {
    const controller = fakeBuildingController();
    let toggles = 0;
    const harness = createHarness({
      buildingController: controller,
      onBuildToggle: () => {
        toggles += 1;
      },
    });

    const b = key("KeyB");
    harness.target.dispatch("keydown", b as unknown as Record<string, unknown>);
    expect(toggles).toBe(0);
    expect(controller.active).toBe(false);
    // Inactive builder never consumes B; the Action Browser window hotkey
    // (a separate window-manager listener) stays the sole owner.
    expect(controller.handled).toEqual([]);

    const v = key("KeyV");
    harness.target.dispatch("keydown", v as unknown as Record<string, unknown>);
    expect(toggles).toBe(0);
    // V reaches the interact-chip cycle branch, which owns it (preventDefault).
    expect(v.defaultPrevented).toBe(true);

    harness.dispose();
  });
  it("routes canvas mousemove into the active building preview and detaches on dispose", () => {
    const updatePointer = vi.fn();
    const hover = vi.fn();
    const controller = Object.assign(fakeBuildingController(), { updatePointer, hover });
    controller.active = true;
    const harness = createHarness({ buildingController: controller });

    harness.canvas.dispatch("mousemove", mouse(0, 120, 230) as unknown as Record<string, unknown>);
    expect(updatePointer).toHaveBeenCalledWith(120, 230, { x: 12, y: 0, z: 23 });
    expect(hover).toHaveBeenCalledWith(120, 230, 800, 600);

    harness.dispose();
    harness.canvas.dispatch("mousemove", mouse(0, 240, 310) as unknown as Record<string, unknown>);
    expect(updatePointer).toHaveBeenCalledTimes(1);
    expect(hover).toHaveBeenCalledTimes(1);
  });

});

describe("bank / clone terminal kiosks and player corpse bags", () => {
  const terminalPick = (kind: "bank_terminal" | "clone_terminal", propId: string): WorldPropPickResult => ({
    propId,
    kind,
    label: kind === "bank_terminal" ? "Bank Terminal" : "Clone Terminal",
    interactable: true,
  });

  const corpsePickResult = (): PlayerCorpsePickResult => ({
    corpseId: "player-corpse:7",
    ownerLabel: "Ashen Vek",
    isOwner: false,
    hasItems: true,
    creditsPresent: true,
    expiryTick: 144_000,
  });

  it("opens the bank window from single LMB and the terminal radial screen verb", () => {
    const harness = createHarness({ propPick: terminalPick("bank_terminal", "dustgate-bank-terminal") });
    vi.spyOn(performance, "now").mockReturnValue(10_000);

    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.openedBankTerminal.id).toBe("dustgate-bank-terminal");
    expect(harness.examinedProp.id).toBeNull();
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.openedBankTerminal.id = null;
    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual(["screen", "examine"]);
    harness.radial.opened?.handlers.onAction("screen");
    expect(harness.openedBankTerminal.id).toBe("dustgate-bank-terminal");

    harness.dispose();
  });

  it("opens the cloning window from the clone terminal kiosk grammar", () => {
    const harness = createHarness({ propPick: terminalPick("clone_terminal", "dustgate-clone-terminal") });
    vi.spyOn(performance, "now").mockReturnValue(10_500);

    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.openedCloneTerminal.id).toBe("dustgate-clone-terminal");
    expect(harness.openedBankTerminal.id).toBeNull();
    expect(harness.examinedProp.id).toBeNull();

    harness.dispose();
  });

  it("routes player corpse bags to the LOOT window via double-click and radial", () => {
    const harness = createHarness({ corpsePick: corpsePickResult() });
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(11_000);

    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.openedLoot.target).toBeNull();
    now.mockReturnValue(11_250);
    harness.canvas.dispatch("mousedown", mouse(0, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.openedLoot.target).toEqual({ kind: "playerCorpse", id: "player-corpse:7" });
    expect(basicShotCommands(harness.state)).toHaveLength(0);

    harness.openedLoot.target = null;
    harness.canvas.dispatch("mousedown", mouse(2, 180, 180) as unknown as Record<string, unknown>);
    expect(harness.radial.opened?.actions.map((entry) => entry.id)).toEqual(["loot"]);
    harness.radial.opened?.handlers.onAction("loot");
    expect(harness.openedLoot.target).toEqual({ kind: "playerCorpse", id: "player-corpse:7" });

    harness.dispose();
  });
});
