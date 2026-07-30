import { CircleGeometry, DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from "three";
import {
  clickMoveTarget,
  drainClickMoveEvents,
  type ClickMoveEvent,
} from "@successor/client/src/slice-core/movementSystem";

/**
 * Click-to-move ground marker — the brass "walk here" stamp.
 *
 * One pooled ring + hub pair built once (RingGeometry/CircleGeometry shared
 * with a single material each); update never allocates. Drains the movement
 * system's click-move event queue directly, so the marker follows the SAME
 * lifecycle the movement intent does (set/retarget stamp-in, arrived
 * collapse, cancelled fade) — no second source of truth.
 *
 * Motion is deterministic (internal clock advanced by dtSeconds only):
 *   set/retarget  ring stamps DOWN (1.6x -> 1x ease-out, 280ms), then idles
 *                 with a slow phosphor breathe.
 *   arrived       ring collapses into the hub and fades (260ms) — the
 *                 landing beat.
 *   cancelled     quick honest fade (150ms), no celebration.
 * Reduced motion (prefers-reduced-motion): no stamp scale, no breathe —
 * static ring while the target lives, plain opacity fades on exit.
 */

/** Brass/cartridge — SUCCESSOR_THEME.palette.ochre (#b98c3a). */
const MARKER_COLOR = 0xb98c3a;
/** Just above blood decals / beside survey rings — never z-fights terrain. */
const MARKER_Y = 0.06;
const RING_RADIUS_CELLS = 0.45;
const STAMP_SECONDS = 0.22;
const ARRIVE_SECONDS = 0.2;
const CANCEL_SECONDS = 0.12;
const IDLE_ALPHA = 0.62;
const BREATHE_HZ = 0.9;
const BREATHE_DEPTH = 0.18;

type MarkerPhase = "idle" | "active" | "arriving" | "cancelling";

export class ClickMoveMarkerFx {
  private readonly ring: Mesh<RingGeometry, MeshBasicMaterial>;
  private readonly hub: Mesh<CircleGeometry, MeshBasicMaterial>;
  private readonly events: ClickMoveEvent[] = [];
  private phase: MarkerPhase = "idle";
  /** Seconds since the current phase began (deterministic local clock). */
  private phaseT = 0;
  /** Seconds since the marker became active (breathe clock). */
  private idleT = 0;
  private reducedMotion: boolean;

  constructor(scene: Scene, reducedMotion?: boolean) {
    this.reducedMotion = reducedMotion
      ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    const ringMaterial = new MeshBasicMaterial({
      color: MARKER_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    this.ring = new Mesh(new RingGeometry(0.82, 1, 40), ringMaterial);
    const hubMaterial = new MeshBasicMaterial({
      color: MARKER_COLOR,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    this.hub = new Mesh(new CircleGeometry(0.16, 20), hubMaterial);
    for (const mesh of [this.ring, this.hub]) {
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.rotation.set(-Math.PI / 2, 0, 0);
      scene.add(mesh);
    }
  }

  /** Verification hook: current lifecycle phase. */
  get debugPhase(): MarkerPhase {
    return this.phase;
  }

  /** Verification hook: marker world position (authority cells + 0.5). */
  get debugX(): number {
    return this.ring.position.x;
  }

  get debugZ(): number {
    return this.ring.position.z;
  }

  /** Verification hook: ring opacity (reduced-motion stamps in at full alpha). */
  get debugOpacity(): number {
    return this.ring.material.opacity;
  }

  update(state: object, dtSeconds: number): void {
    this.events.length = 0;
    drainClickMoveEvents(state, this.events);
    for (let i = 0; i < this.events.length; i += 1) {
      const event = this.events[i]!;
      if (event.kind === "set" || event.kind === "retarget") this.stampAt(event.x, event.y);
      else if (event.kind === "arrived") this.beginExit("arriving");
      else this.beginExit("cancelling");
    }
    // Safety net: an active marker with no live target (event queue drained
    // by another consumer, test-reset state) fades out instead of squatting.
    if (this.phase === "active" && clickMoveTarget(state) === null) {
      this.beginExit("cancelling");
    }
    if (this.phase === "idle") return;

    this.phaseT += dtSeconds;
    this.idleT += dtSeconds;
    if (this.phase === "active") {
      if (this.reducedMotion) {
        this.applyRing(1, IDLE_ALPHA);
        this.hub.material.opacity = IDLE_ALPHA;
        return;
      }
      const stamp = Math.min(1, this.phaseT / STAMP_SECONDS);
      const eased = 1 - (1 - stamp) ** 3;
      const scale = 1.6 - 0.6 * eased;
      const breathe = stamp >= 1 ? 1 - BREATHE_DEPTH * (0.5 + 0.5 * Math.sin(this.idleT * BREATHE_HZ * Math.PI * 2)) : 1;
      this.applyRing(scale, IDLE_ALPHA * eased * breathe);
      this.hub.material.opacity = IDLE_ALPHA * eased;
      return;
    }
    const exitSeconds = this.phase === "arriving" ? ARRIVE_SECONDS : CANCEL_SECONDS;
    const t = Math.min(1, this.phaseT / exitSeconds);
    const fade = 1 - t;
    if (this.phase === "arriving" && !this.reducedMotion) {
      // Landing beat: the ring collapses into the hub.
      this.applyRing(1 - 0.8 * t, IDLE_ALPHA * fade);
      this.hub.material.opacity = Math.min(1, IDLE_ALPHA + 0.3 * t) * fade;
    } else {
      this.applyRing(this.ring.scale.x, IDLE_ALPHA * fade);
      this.hub.material.opacity = IDLE_ALPHA * fade;
    }
    if (t >= 1) this.hide();
  }

  private stampAt(cellX: number, cellY: number): void {
    // Cell-center convention (pawns/terrain render at cell + 0.5).
    this.ring.position.set(cellX + 0.5, MARKER_Y, cellY + 0.5);
    this.hub.position.set(cellX + 0.5, MARKER_Y + 0.001, cellY + 0.5);
    this.ring.visible = true;
    this.hub.visible = true;
    this.phase = "active";
    this.phaseT = 0;
    this.idleT = 0;
    if (this.reducedMotion) {
      this.applyRing(1, IDLE_ALPHA);
      this.hub.material.opacity = IDLE_ALPHA;
    }
  }

  private beginExit(phase: "arriving" | "cancelling"): void {
    if (!this.ring.visible) {
      this.phase = "idle";
      return;
    }
    this.phase = phase;
    this.phaseT = 0;
  }

  private applyRing(scale: number, opacity: number): void {
    const s = Math.max(0.01, scale * RING_RADIUS_CELLS * 2);
    this.ring.scale.set(s, s, s);
    this.ring.material.opacity = opacity;
  }

  private hide(): void {
    this.phase = "idle";
    this.ring.visible = false;
    this.hub.visible = false;
    this.ring.material.opacity = 0;
    this.hub.material.opacity = 0;
  }

  dispose(): void {
    for (const mesh of [this.ring, this.hub]) {
      mesh.material.dispose();
      mesh.geometry.dispose();
      mesh.parent?.remove(mesh);
    }
  }
}
