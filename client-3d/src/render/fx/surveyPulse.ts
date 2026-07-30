import { DoubleSide, Mesh, MeshBasicMaterial, RingGeometry, type Scene } from "three";
import { drainSurveyPulses, type SurveyPulse } from "../../ui/survey/store";

/**
 * SURVEY scan pulse — one expanding phosphor ground ring per scan (the
 * radius-disc "blip": press SURVEY, the world answers once). Pooled and
 * allocation-free per frame, mirroring DecalFx. Drains the survey store's
 * pulse queue directly so scans fired from the tool window OR slash
 * commands pulse even while the GUI is closed.
 */

const POOL_SIZE = 3;
const PULSE_SECONDS = 1.4;
/** Just above blood decals — never z-fights terrain or gore. */
const RING_Y = 0.06;
const PULSE_COLOR = 0x8cff9e;

interface PulseSlot {
  mesh: Mesh<RingGeometry, MeshBasicMaterial>;
  /** 0..1 progress; >= 1 means idle. */
  t: number;
  rangeCells: number;
}

export class SurveyPulseFx {
  private readonly slots: PulseSlot[] = [];
  private readonly scratch: SurveyPulse[] = [];

  constructor(scene: Scene) {
    const geometry = new RingGeometry(0.94, 1, 48);
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const material = new MeshBasicMaterial({
        color: PULSE_COLOR,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: DoubleSide,
        fog: true,
      });
      const mesh = new Mesh(geometry, material);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.rotation.set(-Math.PI / 2, 0, 0);
      scene.add(mesh);
      this.slots.push({ mesh, t: 1, rangeCells: 0 });
    }
  }

  update(dtSeconds: number): void {
    this.scratch.length = 0;
    drainSurveyPulses(this.scratch);
    for (let i = 0; i < this.scratch.length; i += 1) this.spawn(this.scratch[i]!);
    for (let i = 0; i < this.slots.length; i += 1) {
      const slot = this.slots[i]!;
      if (slot.t >= 1) continue;
      slot.t = Math.min(1, slot.t + dtSeconds / PULSE_SECONDS);
      const eased = 1 - (1 - slot.t) ** 3;
      const radius = Math.max(0.01, slot.rangeCells * eased);
      slot.mesh.scale.set(radius, radius, radius);
      slot.mesh.material.opacity = 0.75 * (1 - slot.t);
      if (slot.t >= 1) {
        slot.mesh.visible = false;
        slot.mesh.material.opacity = 0;
      }
    }
  }

  private spawn(pulse: SurveyPulse): void {
    // Prefer an idle slot; otherwise steal the most-finished pulse.
    let slot = this.slots[0]!;
    for (let i = 0; i < this.slots.length; i += 1) {
      const candidate = this.slots[i]!;
      if (candidate.t >= 1) {
        slot = candidate;
        break;
      }
      if (candidate.t > slot.t) slot = candidate;
    }
    slot.t = 0;
    slot.rangeCells = Math.max(4, pulse.rangeCells);
    slot.mesh.visible = true;
    // Cell-center convention (pawns/terrain render at cell + 0.5).
    slot.mesh.position.set(pulse.x + 0.5, RING_Y, pulse.y + 0.5);
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.mesh.material.dispose();
      slot.mesh.parent?.remove(slot.mesh);
    }
    this.slots[0]?.mesh.geometry.dispose();
    this.slots.length = 0;
  }
}
