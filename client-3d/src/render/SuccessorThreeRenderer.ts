import {
  Fog,
  Scene,
  WebGLRenderer,
  type WebGLRendererParameters,
  Vector3,
} from "three";
import type { GameAuthorityViewInterest } from "@successor/client/src/slice-core/gameAuthoritySystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { currentArea } from "@successor/client/src/slice-core/worldQueries";
import { TerrainStreamer, biomeIdFromSliceArea, effectiveWorldSeedFromSliceArea } from "./terrain";
import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../config";
import { loadPawnPack } from "../assets/pawnPack";
import { IsometricCameraController, worldToScreenViewport, type GroundBounds, type ScreenPoint } from "./camera";
import type { ActiveClipsByLayer } from "./anim/PawnAnimator";
import { PawnRenderer, type PawnGroundingDebug } from "./pawns";
import { WorldPropsRenderer, type WorldPropAnimatedScreenDebug, type WorldPropEnterableCutawayDebug, type WorldPropPickResult } from "./props";
import { PlacedExtractorsRenderer, type ExtractorPickResult } from "./extractors";
import { PlacedCampsRenderer, type CampPickResult } from "./camps";
import { PlayerCorpsesRenderer, type PlayerCorpsePickResult } from "./playerCorpses";
import { FarmCropsRenderer } from "./crops";
import { Ps2PostRenderer } from "./post";
import { CombatFx } from "./fx";
import { BuildingRenderer, type BuildingCollision, type BuildingPickResult } from "./building";
import { RADIUS_CELLS as RADAR_RADIUS_CELLS } from "../ui/hud/radar";
import { WorldEnvironment } from "./environment";
import { FloraRenderer } from "./flora";
import { WeatherRenderer } from "./weather";
import { StormDirector, type StormDials } from "./weather/storm";
import { WaypointBeamRenderer } from "./waypointBeam";
import type { WorldFloraCollider } from "./flora/scatter";

declare global {
  interface Window {
    /** Dev-only: live three.js scene for debugging. */
    __successor3dScene?: Scene;
    /** Dev-only pawn presentation seams. */
    __successorPawns?: { plasmaBladePreview: (colorHex?: number) => boolean; poseTest: (clip: string) => boolean; plasmaIgniteTest: () => boolean };
    __combatQueueDemo?: () => boolean;
  }
}
export function superviseWorldPropsLoad(load: Promise<void>): void {
  void load.catch((error: unknown) => {
    console.error("world props: initial load failed", error);
  });
}

export interface RendererFrameStats {
  visiblePawns: number;
}

const rendererOptions: WebGLRendererParameters = {
  antialias: false,
  alpha: false,
  powerPreference: "high-performance",
};

export class SuccessorThreeRenderer {
  readonly renderer = new WebGLRenderer(rendererOptions);
  readonly scene = new Scene();
  readonly cameraController = new IsometricCameraController();
  readonly canvas = this.renderer.domElement;

  private readonly post = new Ps2PostRenderer();
  readonly env = new WorldEnvironment();
  private readonly props = new WorldPropsRenderer(this.scene);
  readonly buildings = new BuildingRenderer(this.scene, this.cameraController.camera);
  private readonly extractors = new PlacedExtractorsRenderer(this.scene);
  private readonly crops = new FarmCropsRenderer(this.scene);
  private readonly combatFx = new CombatFx(this.scene, this.cameraController.camera, this.canvas);
  private readonly camps = new PlacedCampsRenderer(this.scene, {
    set: (id, x, y, z) => this.combatFx.setWorldCampfire(id, x, y, z),
    remove: (id) => this.combatFx.removeWorldCampfire(id),
  });
  private readonly playerCorpses = new PlayerCorpsesRenderer(this.scene);
  private readonly pawns: PawnRenderer;
  /** App-level audio hook: fired whenever a saber-deflect visual plays. */
  onDeflectAudio: ((actorId: string) => void) | null = null;
  private readonly terrain: TerrainStreamer;
  private readonly flora: FloraRenderer;
  private readonly weather: WeatherRenderer;
  private readonly storm: StormDirector;
  private readonly waypointBeams = new WaypointBeamRenderer(this.scene);
  private readonly focus = new Vector3();
  private readonly pointerGround = new Vector3();
  private readonly bounds: GroundBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private readonly depthScreen: ScreenPoint = { px: 0, py: 0 };
  private width = 1;
  private height = 1;
  private contextLost = false;

  private constructor(private readonly host: HTMLElement, pawns: (scene: Scene) => PawnRenderer, worldSeed: number, biome: SuccessorBiomeId) {
    this.canvas.className = "successor3d-canvas";
    this.pawns = pawns(this.scene);
    this.terrain = new TerrainStreamer(this.scene, worldSeed, this.env, biome);
    this.flora = new FloraRenderer(this.scene, this.env);
    this.flora.setBiome(biome);
    this.weather = new WeatherRenderer(this.scene, this.env);
    this.weather.setBiome(biome);
    this.storm = new StormDirector(this.scene, { strata: this.weather, post: this.post, wind: this.env });
    this.post.env = this.env;
    this.combatFx.setMuzzleProvider((actorId) => this.pawns.getMuzzleWorldPosition(actorId));
    this.combatFx.setShellMeshProvider((actorId) => this.pawns.getShellMeshes(actorId));
    // Deflect is PRODUCT behavior (visual + audio hook) — never dev-gated.
    this.combatFx.setDeflectSink((actorId, ix, iz) => {
      this.pawns.playDeflect(actorId, ix, iz);
      this.onDeflectAudio?.(actorId);
    });
    // Dev-only scene handles for live debugging (never in production builds).
    if (import.meta.env.DEV) {
      window.__successor3dScene = this.scene;
      window.__successorPawns = { plasmaBladePreview: (c?: number) => this.pawns.plasmaBladePreview(c), poseTest: (clip: string) => this.pawns.poseTest(clip), plasmaIgniteTest: () => this.pawns.plasmaIgniteTest() };
    }
    this.canvas.tabIndex = 0;
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(SUCCESSOR_3D_CONFIG.renderer.clearColor, 1);
    this.renderer.autoClear = false;
    this.scene.fog = new Fog(
      SUCCESSOR_3D_CONFIG.ground.fogColor,
      SUCCESSOR_3D_CONFIG.ground.fogNear,
      SUCCESSOR_3D_CONFIG.ground.fogFar,
    );
    host.appendChild(this.canvas);
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.host.dataset.webglError = "WebGL context lost";
    });
    this.canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.host.dataset.webglError = "WebGL context restored; reload if rendering stalls";
    });
  }

  static async create(host: HTMLElement, slice: SliceSnapshot, state: PlayState): Promise<SuccessorThreeRenderer> {
    const pack = await loadPawnPack();
    const instance = new SuccessorThreeRenderer(host, (scene) => new PawnRenderer(scene, pack), effectiveWorldSeedFromSliceArea(slice, state.activeAreaId), biomeIdFromSliceArea(slice, state.activeAreaId));
    superviseWorldPropsLoad(instance.props.load(slice, state.activeAreaId));
    instance.resize(state.settings.mouse.cameraZoomPercent);
    return instance;
  }

  /** Nearest always-on campfire distance to a world point (crackle-loop driver). */
  nearestCampfireDistance(x: number, z: number): number | null {
    return this.combatFx.nearestCampfireDistance(x, z);
  }

  /** Actors whose plasma blade is currently ignited (hum-loop driver). */
  ignitedPlasmaActors(): Array<{ actorId: string; extension: number }> {
    return this.pawns.ignitedPlasmaActors();
  }

  render(slice: SliceSnapshot, state: PlayState, dtSeconds: number, timeMs: number): RendererFrameStats {
    if (this.contextLost) return { visiblePawns: 0 };
    const activeBiome = biomeIdFromSliceArea(slice, state.activeAreaId);
    const worldSeed = effectiveWorldSeedFromSliceArea(slice, state.activeAreaId);
    this.terrain.setWorldSeed(worldSeed);
    this.terrain.setBiome(activeBiome);
    this.flora.setWorldSeed(worldSeed);
    this.flora.setBiome(activeBiome);
    this.weather.setBiome(activeBiome);
    this.post.biome = activeBiome;
    this.resize(state.settings.mouse.cameraZoomPercent);
    this.focus.copy(this.focusPoint(state));
    this.cameraController.updateFocus(this.focus.x, this.focus.z, dtSeconds);
    this.terrain.update(this.cameraController.groundBounds(this.bounds), this.focus.x, this.focus.z);
    const visiblePawns = this.pawns.update(slice, state, dtSeconds, timeMs, this.focus.x, this.focus.z);
    this.props.update(slice, state, dtSeconds);
    this.buildings.update(slice, state, dtSeconds);
    this.extractors.update(state, dtSeconds, timeMs);
    this.camps.update(slice, state, dtSeconds);
    this.playerCorpses.update(state);
    this.crops.update(state);
    this.combatFx.update(state, dtSeconds);
    // Storm director FIRST: it writes the storm drives (wind/post/strata)
    // that env/weather/post consume this same frame.
    this.storm.update(slice, state, this.focus.x, this.focus.z, dtSeconds);
    // Roof-peel: hide shelter-roof parts while the player stands inside.
    this.props.setInteriorRevealed(this.storm.shelteredPropId);
    this.env.update(state, dtSeconds, timeMs);
    this.flora.update(this.focus.x, this.focus.z, dtSeconds, timeMs);
    this.weather.update(this.focus.x, this.focus.z, dtSeconds, timeMs);
    this.waypointBeams.update(state.activeAreaId, timeMs);
    // Titan depth shader: followed pawn in LOW-RES target pixels (the scene
    // pass's gl_FragCoord space; y flipped — FragCoord is bottom-origin).
    this.worldToScreen(this.focus.x, this.focus.z, 0.9, this.depthScreen);
    const targetScale = this.post.dials.pixelScale;
    this.flora.setDepthFocus(
      this.depthScreen.px * targetScale,
      (this.height - this.depthScreen.py) * targetScale,
      this.height * targetScale * 0.24,
    );
    this.env.sunShadow.update(this.env, this.focus.x, this.focus.z);
    this.env.sunShadow.render(this.renderer, this.scene);
    this.post.render(this.renderer, this.scene, this.cameraController.camera);
    this.terrain.publishRendererTextureCount(this.renderer.info.memory.textures);
    return { visiblePawns };
  }

  /** Boot-time terrain warmup: drain the chunk bake queue for the spawn
   * neighborhood synchronously while the load screen still holds the frame,
   * so the first sprint doesn't compete with texture baking (owner report
   * 2026-07-07: fresh-load sprint jag). Budget-capped; returns stats. */
  warmupTerrain(focusX: number, focusZ: number, maxMs = 2200): { ms: number; iterations: number; pending: number } {
    const start = performance.now();
    // Snap the camera to spawn so groundBounds covers the real first view.
    this.cameraController.updateFocus(focusX, focusZ, 1000);
    let iterations = 0;
    while (performance.now() - start < maxMs) {
      this.terrain.update(this.cameraController.groundBounds(this.bounds), focusX, focusZ);
      iterations += 1;
      if (this.terrain.pendingBakeWork() === 0) break;
    }
    return { ms: Math.round(performance.now() - start), iterations, pending: this.terrain.pendingBakeWork() };
  }

  screenToWorldGround(clientX: number, clientY: number): Vector3 | null {
    if (!this.cameraController.screenToGround(this.renderer, clientX, clientY, this.pointerGround)) return null;
    return this.pointerGround;
  }

  screenOffsetToWorldGround(offsetX: number, offsetY: number): Vector3 | null {
    if (!this.cameraController.screenOffsetToGround(offsetX, offsetY, this.width, this.height, this.pointerGround)) {
      return null;
    }
    return this.pointerGround;
  }

  pickPropAtScreenPoint(screenX: number, screenY: number): WorldPropPickResult | null {
    return this.props.pickAtScreenPoint(this.cameraController.camera, screenX, screenY, this.width, this.height);
  }

  pickExtractorAtScreenPoint(screenX: number, screenY: number): ExtractorPickResult | null {
    return this.extractors.pickAtScreenPoint(this.cameraController.camera, screenX, screenY, this.width, this.height);
  }

  pickCampAtScreenPoint(screenX: number, screenY: number): CampPickResult | null {
    return this.camps.pickAtScreenPoint(this.cameraController.camera, screenX, screenY, this.width, this.height);
  }

  pickPlayerCorpseAtScreenPoint(screenX: number, screenY: number): PlayerCorpsePickResult | null {
    return this.playerCorpses.pickAtScreenPoint(this.cameraController.camera, screenX, screenY, this.width, this.height);
  }

  pickBuildingAtScreenPoint(screenX: number, screenY: number): BuildingPickResult | null {
    return this.buildings.pickAtScreenPoint(screenX, screenY, this.width, this.height);
  }

  buildingCollisionsNear(areaId: string, x: number, z: number, radius: number, out?: BuildingCollision[]): number {
    return this.buildings.collisionsNear(areaId, x, z, radius, out);
  }

  /** App-level positional audio hook for the camp auto-door (mirrors deflect). */
  setCampDoorAudio(hook: ((x: number, y: number) => void) | null): void {
    this.camps.onDoorSlide = hook;
  }

  /** Live camp door states (debug probe / Harness3D). */
  campDoorStates(): Record<string, { open: boolean; t: number }> {
    return this.camps.debugDoorStates();
  }

  /** Live authored prop-screen state (debug probe / browser journey). */
  animatedPropScreen(node: string): WorldPropAnimatedScreenDebug | null {
    return this.props.debugAnimatedScreen(node);
  }

  /** On-demand enterable cutaway diagnostics (debug probe / headed proof). */
  enterableCutawayDebug(): WorldPropEnterableCutawayDebug[] {
    return this.props.debugEnterableCutaway();
  }

  /** On-demand pawn grounding diagnostics (debug probe / headed proof). */
  pawnGroundingDebug(actorId: string): PawnGroundingDebug | null {
    return this.pawns.debugPawnGrounding(actorId);
  }

  /**
   * Muzzle socket world position for an armed, standing pawn (effects layer).
   * Returns a REUSED scratch Vector3 — copy it before the next call — or null.
   */
  getMuzzleWorldPosition(actorId: string): Vector3 | null {
    return this.pawns.getMuzzleWorldPosition(actorId);
  }

  /** Live compositor layers for one actor (debug probe). */
  getActiveClipsByLayer(actorId: string, out: ActiveClipsByLayer): ActiveClipsByLayer | null {
    return this.pawns.getActiveClipsByLayer(actorId, out);
  }

  /** Attached equipment item ids on one actor's pawn (debug probe). */
  attachedEquipmentIdsFor(actorId: string): string[] {
    return this.pawns.attachedEquipmentIdsFor(actorId);
  }

  /** Face compositor attachment + atlas-paint readiness on one live pawn. */
  facePaintStatusFor(actorId: string) {
    return this.pawns.facePaintStatusFor(actorId);
  }

  /** Rendered pawn positions in cell units (fidelity probe drift check). */
  collectRenderedPositions(out: { id: string; x: number; z: number }[]): number {
    return this.pawns.collectRenderedPositions(out);
  }
  /** Live LOD tier counts this frame (debug probe: lodHiFiActors / lodSimActors). */
  getLodCounts(): { hiFi: number; sim: number } {
    return this.pawns.lodCounts();
  }
  /** Live storm presentation dials (debug probe: phase/severity/sheltered). */
  getStormDials(): StormDials {
    return this.storm.devDials;
  }

  /** Resident flora colliders near a world point (movement clamp; reuses `out`). */
  floraCollidersNear(x: number, z: number, radius: number, out: WorldFloraCollider[]): number {
    return this.flora.collidersNear(x, z, radius, out);
  }

  worldToScreen(x: number, z: number, y = 0, target?: ScreenPoint): ScreenPoint {
    return worldToScreenViewport(this.cameraController.camera, this.width, this.height, x, z, y, target);
  }

  getViewInterest(slice: SliceSnapshot, state: PlayState): GameAuthorityViewInterest | null {
    if (this.width <= 0 || this.height <= 0) return null;
    const bounds = this.cameraController.groundBounds(this.bounds);
    const widthCells = Math.max(1, bounds.maxX - bounds.minX);
    const heightCells = Math.max(1, bounds.maxZ - bounds.minZ);
    // AOI must cover the radar detection radius, not just the camera: the
    // server streams actors within viewport/2 + margin per axis (shard.ts
    // actorInterestFor), and radar.ts reads streamed actors. +8 headroom
    // keeps warm-tier contacts feeding the rim-clamp band beyond 96.
    // Server clamps margin at 128 — this stays well inside at every zoom.
    const radarMarginCells = RADAR_RADIUS_CELLS + 8 - Math.min(widthCells, heightCells) / 2;
    return {
      area_id: currentArea(slice, state).id,
      viewport_width_cells: roundTenths(widthCells),
      viewport_height_cells: roundTenths(heightCells),
      margin_cells: roundTenths(Math.max(16, Math.max(widthCells, heightCells) * 0.25, radarMarginCells)),
      center_actor_id: this.focusActorId(state),
    };
  }

  dispose(): void {
    this.pawns.dispose();
    this.props.dispose();
    this.buildings.dispose();
    this.camps.dispose();
    this.playerCorpses.dispose();
    this.extractors.dispose();
    this.crops.dispose();
    this.combatFx.dispose();
    this.terrain.dispose();
    this.flora.dispose();
    this.weather.dispose();
    this.storm.dispose();
    this.waypointBeams.dispose();
    this.env.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }

  private resize(zoomPercent: number): void {
    const rect = this.host.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const nextHeight = Math.max(1, Math.floor(rect.height || window.innerHeight));
    if (nextWidth !== this.width || nextHeight !== this.height) {
      this.width = nextWidth;
      this.height = nextHeight;
      this.renderer.setSize(nextWidth, nextHeight, false);
      this.post.resize(nextWidth, nextHeight);
    }
    this.cameraController.resize(this.width, this.height, zoomPercent);
  }

  private focusPoint(state: PlayState): Vector3 {
    const actorId = this.focusActorId(state);
    const localPlayerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    if (actorId === localPlayerActorId) {
      this.focus.set(state.player.x + 0.5, 0, state.player.y + 0.5);
      return this.focus;
    }
    const actor = actorId ? state.serverAuthority.actors[actorId] : null;
    if (actor) {
      this.focus.set(
        (actor.renderX ?? actor.x) + 0.5,
        0,
        (actor.renderY ?? actor.y) + 0.5,
      );
      return this.focus;
    }
    this.focus.set(state.player.x + 0.5, 0, state.player.y + 0.5);
    return this.focus;
  }

  private focusActorId(state: PlayState): string {
    return state.observerCamera.followActorId ?? state.serverAuthority.playerActorId ?? state.playerActorId;
  }
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}
