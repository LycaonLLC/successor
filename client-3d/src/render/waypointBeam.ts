import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  Mesh,
  ShaderMaterial,
  type Scene,
} from "three";
import { waypoints } from "../ui/waypoints/store";

/**
 * Active waypoint world beams — client-only navigation affordance.
 *
 * The waypoint store is already per-character and current-page singleton, so
 * this renderer only reconciles the active current-area subset into a fixed
 * pool. No meshes/materials are created after construction; per-frame work is
 * a bounded scan of ≤100 waypoints and ≤8 beam slots.
 */

const MAX_BEAMS = 8;
const BEAM_RADIUS = 0.12;
const BEAM_HEIGHT = 40;
const BEAM_COLOR = new Color(0x63f0ff);
const HALF_HEIGHT = BEAM_HEIGHT / 2;

const VERTEX_SHADER = `
  varying float vHeight;
  void main() {
    vHeight = position.y / ${BEAM_HEIGHT.toFixed(1)} + 0.5;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vHeight;
  void main() {
    float fade = pow(clamp(1.0 - vHeight, 0.0, 1.0), 1.15);
    float base = smoothstep(0.0, 0.12, vHeight);
    float alpha = uOpacity * fade * base;
    if (alpha <= 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

interface BeamSlot {
  mesh: Mesh<CylinderGeometry, ShaderMaterial>;
  opacity: { value: number };
}

export class WaypointBeamRenderer {
  private readonly geometry = new CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, BEAM_HEIGHT, 18, 1, true);
  private readonly slots: BeamSlot[] = [];

  constructor(scene: Scene) {
    for (let i = 0; i < MAX_BEAMS; i += 1) {
      const opacity = { value: 0 };
      const material = new ShaderMaterial({
        uniforms: {
          uColor: { value: BEAM_COLOR },
          uOpacity: opacity,
        },
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: false,
      });
      const mesh = new Mesh(this.geometry, material);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 11;
      scene.add(mesh);
      this.slots.push({ mesh, opacity });
    }
  }

  update(activeAreaId: string, timeMs: number): void {
    const phase = 0.5 + 0.5 * Math.sin(timeMs * Math.PI * 0.001);
    const opacity = 0.55 + 0.35 * phase;
    let used = 0;
    for (const waypoint of waypoints()) {
      if (!waypoint.active || waypoint.areaId !== activeAreaId) continue;
      if (used >= MAX_BEAMS) break;
      const slot = this.slots[used]!;
      slot.mesh.visible = true;
      slot.mesh.position.set(waypoint.x + 0.5, HALF_HEIGHT, waypoint.y + 0.5);
      slot.opacity.value = opacity;
      used += 1;
    }
    for (let i = used; i < this.slots.length; i += 1) {
      const slot = this.slots[i]!;
      slot.mesh.visible = false;
      slot.opacity.value = 0;
    }
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.mesh.material.dispose();
      slot.mesh.parent?.remove(slot.mesh);
    }
    this.geometry.dispose();
    this.slots.length = 0;
  }
}
