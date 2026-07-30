import type { Scene } from "three";
import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../../config";
import type { WorldEnvironment } from "../environment";
import { createFloraGeometryKit, updateFloraWindUniforms, type FloraGeometryKit } from "./generators";
import { FloraScatterStream, type WorldFloraCollider } from "./scatter";
import { TumbleweedSystem } from "./tumbleweed";

interface FloraProbe {
  readonly visibleInstances: number;
  readonly chunks: number;
  readonly tumbleweeds: number;
  densityScale: number;
  readonly biome: SuccessorBiomeId;
}

declare global {
  interface Window {
    __successor3dFlora?: FloraProbe;
  }
}

/**
 * Desert flora + ambient life.
 *
 * Render-only scatter on the terrain chunk grid plus presentation-only
 * tumbleweeds driven by WorldEnvironment.wind. Nothing here touches sim,
 * picking, netcode, or TerrainStreamer internals.
 */
export class FloraRenderer {
  private readonly kit: FloraGeometryKit | null = null;
  private readonly scatter: FloraScatterStream | null = null;
  private readonly tumbleweeds: TumbleweedSystem | null = null;
  private readonly enabled = SUCCESSOR_3D_CONFIG.environment.flora.enabled;
  private densityScale: number = SUCCESSOR_3D_CONFIG.environment.flora.densityScale;
  private biome: SuccessorBiomeId = "desert";

  constructor(scene: Scene, private readonly env: WorldEnvironment) {
    if (!this.enabled) return;
    const kit = createFloraGeometryKit();
    this.kit = kit;
    this.scatter = new FloraScatterStream(scene, kit);
    this.tumbleweeds = new TumbleweedSystem(scene, kit);
    if (import.meta.env.DEV) this.installProbe();
  }

  setWorldSeed(seed: number): void {
    if (!this.enabled) return;
    this.scatter?.setWorldSeed(seed);
    this.tumbleweeds?.setWorldSeed(seed);
  }

  setBiome(biome: SuccessorBiomeId): void {
    if (!this.enabled || biome === this.biome) return;
    this.biome = biome;
    this.scatter?.setBiome(biome);
  }

  /** Resident world colliders near a point (movement clamp; reuses `out`). */
  collidersNear(x: number, z: number, radius: number, out: WorldFloraCollider[]): number {
    if (!this.enabled || !this.scatter) return 0;
    return this.scatter.collidersNear(x, z, radius, out);
  }

  /**
   * Per-frame titan depth-shader focus: the followed pawn's position in
   * LOW-RES TARGET pixels + cutout radius (renderer computes both).
   */
  setDepthFocus(playerPxX: number, playerPxY: number, fadeRadiusPx: number): void {
    const uniforms = this.kit?.forest.depthUniforms;
    if (!uniforms) return;
    uniforms.uDwPlayerPx.value.set(playerPxX, playerPxY);
    uniforms.uDwFadePx.value = fadeRadiusPx;
  }

  update(focusX: number, focusZ: number, dtSeconds: number, nowMs: number): void {
    if (!this.enabled || !this.kit || !this.scatter || !this.tumbleweeds) return;
    updateFloraWindUniforms(this.kit.windUniforms, this.env.wind, nowMs);
    this.scatter.setDensityScale(this.densityScale);
    this.scatter.update(focusX, focusZ);
    if (this.biome === "desert") this.tumbleweeds.update(focusX, focusZ, dtSeconds, this.env);
  }

  dispose(): void {
    if (!this.enabled) return;
    this.scatter?.dispose();
    this.tumbleweeds?.dispose();
    this.kit?.dispose();
    if (import.meta.env.DEV && window.__successor3dFlora) delete window.__successor3dFlora;
  }

  private installProbe(): void {
    const self = this;
    window.__successor3dFlora = {
      get visibleInstances() {
        return self.scatter?.visibleInstances ?? 0;
      },
      get chunks() {
        return self.scatter?.chunkCount ?? 0;
      },
      get tumbleweeds() {
        return self.tumbleweeds?.liveCount ?? 0;
      },
      get biome() {
        return self.biome;
      },
      get densityScale() {
        return self.densityScale;
      },
      set densityScale(value: number) {
        if (!Number.isFinite(value)) return;
        self.densityScale = Math.max(0, Math.min(3, value));
      },
    };
  }
}
