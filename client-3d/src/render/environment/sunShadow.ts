import {
  Color,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  RGBADepthPacking,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type Scene,
  type Texture,
  type WebGLRenderer,
} from "three";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import type { WorldEnvironment } from "./index";

/**
 * Sun-projected shadow pass (Worldfeel Update).
 *
 * Contract (public surface is frozen):
 * - The scene stays unlit (MeshMatcap/MeshBasic identity, ART_DIRECTION §3).
 *   This system renders CASTERS (layer `SUN_SHADOW_CASTER_LAYER`) into a
 *   sun-POV ortho depth target that follows the camera focus, and receivers
 *   DARKEN by sampling it — a shadow-only pass, never a three.js light.
 * - `markSunShadowCaster(root)` — casters opt in (pawns, props, flora).
 * - `applyReceiver(material)` — convenience: installs the receiver patch on a
 *   material that has no other onBeforeCompile customization (props path).
 * - `injectReceiver(shader)` — composition hook for materials that own their
 *   onBeforeCompile (terrain detail overlay calls this inside its patch).
 * - `update(env, focusX, focusZ)` then `render(renderer, scene)` once per
 *   frame BEFORE the PS2 post pass; both must be cheap no-ops when
 *   `env.sun.shadowStrength01 === 0` (deep night / disabled).
 */
export const SUN_SHADOW_CASTER_LAYER = 1;

/** Enable shadow casting for a subtree (objects stay on their render layers). */
export function markSunShadowCaster(root: Object3D): void {
  root.traverse((object) => object.layers.enable(SUN_SHADOW_CASTER_LAYER));
}


interface SunShadowDebugProbe {
  /** Live dial: set to 0 to disable, or a positive integer depth-map size. */
  mapSize: number;
  strength: number;
  lastRenderMs: number;
  casterCount: number;
  /** Live dial: receiver depth-compare bias in packed-depth units. */
  bias: number;
}

declare global {
  interface Window {
    __successor3dSunShadow?: SunShadowDebugProbe;
  }
}

const SHADOW_CONFIG = SUCCESSOR_3D_CONFIG.environment.shadow;
const SHADOW_CAMERA_DISTANCE_MULTIPLIER = 4;
// Depth envelope covers TITAN casters (Verdance trunks reach ~75u tall).
const SHADOW_CAMERA_DEPTH_MARGIN_CELLS = 110;
const MAX_DEV_MAP_SIZE = 4096;
const MAX_DEV_BIAS = 0.05;
const SHADOW_BIAS_MATRIX = new Matrix4().set(
  0.5, 0, 0, 0.5,
  0, 0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

const RECEIVER_VERTEX_PARS = `
uniform mat4 successorSunShadowMatrix;
varying vec4 vSuccessorSunShadowCoord;
`;

const RECEIVER_VERTEX_PROJECT = `
vec4 successorSunShadowWorldPosition = modelMatrix * vec4(transformed, 1.0);
vSuccessorSunShadowCoord = successorSunShadowMatrix * successorSunShadowWorldPosition;
#include <project_vertex>
`;

const RECEIVER_FRAGMENT_PARS = `
#include <packing>
uniform sampler2D successorSunShadowMap;
uniform float successorSunShadowStrength;
uniform vec2 successorSunShadowTexelSize;
uniform float successorSunShadowBias;
varying vec4 vSuccessorSunShadowCoord;

float successorSunShadowTap(vec2 uv, float compareDepth) {
  float shadowDepth = unpackRGBAToDepth(texture2D(successorSunShadowMap, uv));
  return step(shadowDepth + successorSunShadowBias, compareDepth);
}

float successorSunShadowFactor() {
  if (successorSunShadowStrength <= 0.0 || vSuccessorSunShadowCoord.w <= 0.0) return 0.0;
  vec3 shadowCoord = vSuccessorSunShadowCoord.xyz / vSuccessorSunShadowCoord.w;
  if (
    shadowCoord.x <= 0.0 || shadowCoord.x >= 1.0 ||
    shadowCoord.y <= 0.0 || shadowCoord.y >= 1.0 ||
    shadowCoord.z <= 0.0 || shadowCoord.z >= 1.0
  ) {
    return 0.0;
  }
  vec2 halfTexel = successorSunShadowTexelSize * 0.5;
  float shadow = 0.0;
  shadow += successorSunShadowTap(shadowCoord.xy + vec2(-halfTexel.x, -halfTexel.y), shadowCoord.z);
  shadow += successorSunShadowTap(shadowCoord.xy + vec2( halfTexel.x, -halfTexel.y), shadowCoord.z);
  shadow += successorSunShadowTap(shadowCoord.xy + vec2(-halfTexel.x,  halfTexel.y), shadowCoord.z);
  shadow += successorSunShadowTap(shadowCoord.xy + vec2( halfTexel.x,  halfTexel.y), shadowCoord.z);
  return shadow * 0.25;
}
`;

const RECEIVER_FRAGMENT_APPLY = `
gl_FragColor.rgb *= 1.0 - successorSunShadowStrength * successorSunShadowFactor();
#include <fog_fragment>
`;

export class SunShadowSystem {
  private readonly shadowCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 256);
  private readonly depthMaterial = new MeshDepthMaterial({
    depthPacking: RGBADepthPacking,
    blending: NoBlending,
  });
  private readonly shadowMatrix = new Matrix4();
  private readonly texelSize = new Vector2(0, 0);
  private readonly shadowCenter = new Vector3();
  private readonly shadowLocalCenter = new Vector3();
  private readonly shadowRight = new Vector3();
  private readonly shadowUp = new Vector3();
  private readonly shadowForward = new Vector3();
  private readonly snapDelta = new Vector3();
  private readonly previousClearColor = new Color();
  private readonly depthClearColor = new Color(0xffffff);
  private readonly probe: SunShadowDebugProbe = {
    mapSize: SHADOW_CONFIG.mapSize,
    strength: 0,
    lastRenderMs: 0,
    casterCount: 0,
    bias: SHADOW_CONFIG.bias,
  };
  private readonly uniforms = {
    successorSunShadowMap: { value: null as Texture | null },
    successorSunShadowMatrix: { value: this.shadowMatrix },
    successorSunShadowStrength: { value: 0 },
    successorSunShadowTexelSize: { value: this.texelSize },
    successorSunShadowBias: { value: SHADOW_CONFIG.bias as number },
  };
  private readonly countCaster = (object: Object3D): void => {
    if (!(object instanceof Mesh)) return;
    if (!object.layers.test(this.shadowCamera.layers)) return;
    this.casterCount += 1;
  };
  private target: WebGLRenderTarget | null = null;
  private targetSize = 0;
  private active = false;
  private mapSize: number = SHADOW_CONFIG.mapSize;
  private bias: number = SHADOW_CONFIG.bias;
  private casterCount = 0;

  constructor() {
    this.shadowCamera.layers.set(SUN_SHADOW_CASTER_LAYER);
    this.depthMaterial.name = "successor-sun-shadow-depth";
    if (import.meta.env.DEV && typeof window !== "undefined") window.__successor3dSunShadow = this.probe;
  }

  /** Install the darkening sampler on a material with a free onBeforeCompile. */
  applyReceiver(material: Material): void {
    material.onBeforeCompile = (shader) => {
      this.injectReceiver(shader);
    };
    material.needsUpdate = true;
  }

  /**
   * Inject receiver uniforms + fragment darkening into an existing
   * onBeforeCompile shader object (terrain composes this with its own patch).
   */
  injectReceiver(shader: { uniforms: Record<string, { value: unknown }>; fragmentShader: string; vertexShader: string }): void {
    Object.assign(shader.uniforms, this.uniforms);
    if (!shader.vertexShader.includes("vSuccessorSunShadowCoord")) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${RECEIVER_VERTEX_PARS}`)
        .replace("#include <project_vertex>", RECEIVER_VERTEX_PROJECT);
    }
    if (!shader.fragmentShader.includes("successorSunShadowFactor")) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${RECEIVER_FRAGMENT_PARS}`)
        .replace("#include <fog_fragment>", RECEIVER_FRAGMENT_APPLY);
    }
  }

  update(env: WorldEnvironment, focusX: number, focusZ: number): void {
    const dials = import.meta.env.DEV && typeof window !== "undefined" && window.__successor3dSunShadow
      ? window.__successor3dSunShadow
      : this.probe;
    const requestedMapSize = dials.mapSize;
    const requestedBias = dials.bias;
    this.mapSize = typeof requestedMapSize === "number" && Number.isFinite(requestedMapSize)
      ? Math.max(0, Math.min(MAX_DEV_MAP_SIZE, Math.floor(requestedMapSize)))
      : SHADOW_CONFIG.mapSize;
    this.bias = typeof requestedBias === "number" && Number.isFinite(requestedBias)
      ? Math.max(0, Math.min(MAX_DEV_BIAS, requestedBias))
      : SHADOW_CONFIG.bias;

    const strength = Math.max(0, Math.min(1, env.sun.shadowStrength01));
    this.probe.mapSize = this.mapSize;
    this.probe.bias = this.bias;
    this.probe.strength = strength;
    this.uniforms.successorSunShadowBias.value = this.bias;
    if (this.mapSize === 0 || strength === 0) {
      this.active = false;
      this.probe.lastRenderMs = 0;
      this.probe.casterCount = 0;
      this.uniforms.successorSunShadowStrength.value = 0;
      this.texelSize.set(0, 0);
      if (this.mapSize === 0) this.disposeTarget();
      return;
    }

    this.ensureRenderTarget(this.mapSize);
    const radiusCells = Math.max(1, SHADOW_CONFIG.radiusCells);
    const cameraDistance = radiusCells * SHADOW_CAMERA_DISTANCE_MULTIPLIER + SHADOW_CAMERA_DEPTH_MARGIN_CELLS;
    const cameraDepthRadius = radiusCells * 2 + SHADOW_CAMERA_DEPTH_MARGIN_CELLS;
    const texelWorld = (radiusCells * 2) / this.mapSize;

    this.shadowCamera.left = -radiusCells;
    this.shadowCamera.right = radiusCells;
    this.shadowCamera.top = radiusCells;
    this.shadowCamera.bottom = -radiusCells;
    this.shadowCamera.near = Math.max(0.1, cameraDistance - cameraDepthRadius);
    this.shadowCamera.far = cameraDistance + cameraDepthRadius;
    this.shadowCamera.updateProjectionMatrix();

    this.shadowCenter.set(focusX, 0, focusZ);
    this.shadowCamera.position.copy(this.shadowCenter).addScaledVector(env.sun.dir, -cameraDistance);
    if (Math.abs(env.sun.dir.y) > 0.82) this.shadowCamera.up.set(0, 0, 1);
    else this.shadowCamera.up.set(0, 1, 0);
    this.shadowCamera.lookAt(this.shadowCenter);
    this.shadowCamera.updateMatrixWorld(true);

    this.shadowLocalCenter.copy(this.shadowCenter).applyMatrix4(this.shadowCamera.matrixWorldInverse);
    const snappedX = Math.round(this.shadowLocalCenter.x / texelWorld) * texelWorld;
    const snappedY = Math.round(this.shadowLocalCenter.y / texelWorld) * texelWorld;
    this.shadowCamera.matrixWorld.extractBasis(this.shadowRight, this.shadowUp, this.shadowForward);
    this.snapDelta.copy(this.shadowRight)
      .multiplyScalar(snappedX - this.shadowLocalCenter.x)
      .addScaledVector(this.shadowUp, snappedY - this.shadowLocalCenter.y);
    this.shadowCenter.add(this.snapDelta);
    this.shadowCamera.position.add(this.snapDelta);
    this.shadowCamera.lookAt(this.shadowCenter);
    this.shadowCamera.updateMatrixWorld(true);

    this.shadowMatrix.multiplyMatrices(this.shadowCamera.projectionMatrix, this.shadowCamera.matrixWorldInverse);
    this.shadowMatrix.premultiply(SHADOW_BIAS_MATRIX);
    this.texelSize.set(1 / this.mapSize, 1 / this.mapSize);
    this.uniforms.successorSunShadowStrength.value = strength;
    this.active = true;
  }

  render(renderer: WebGLRenderer, scene: Scene): void {
    const target = this.target;
    if (!this.active || !target) return;

    let startMs = 0;
    if (import.meta.env.DEV) {
      startMs = performance.now();
      this.casterCount = 0;
      scene.traverseVisible(this.countCaster);
      this.probe.casterCount = this.casterCount;
    }

    const previousOverride = scene.overrideMaterial;
    const previousTarget = renderer.getRenderTarget();
    const previousClearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(this.previousClearColor);
    scene.overrideMaterial = this.depthMaterial;
    try {
      renderer.setRenderTarget(target);
      renderer.setClearColor(this.depthClearColor, 1);
      renderer.clear(true, true, false);
      renderer.render(scene, this.shadowCamera);
    } finally {
      scene.overrideMaterial = previousOverride;
      renderer.setRenderTarget(previousTarget);
      renderer.setClearColor(this.previousClearColor, previousClearAlpha);
    }

    if (import.meta.env.DEV) {
      this.probe.lastRenderMs = Math.round((performance.now() - startMs) * 10) / 10;
    }
  }

  dispose(): void {
    this.disposeTarget();
    this.depthMaterial.dispose();
    if (import.meta.env.DEV && typeof window !== "undefined" && window.__successor3dSunShadow === this.probe) {
      delete window.__successor3dSunShadow;
    }
  }

  private ensureRenderTarget(mapSize: number): void {
    if (this.target && this.targetSize === mapSize) return;
    if (!this.target) {
      this.target = new WebGLRenderTarget(mapSize, mapSize, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.target.texture.name = "successor-sun-shadow-depth";
      this.target.texture.generateMipmaps = false;
      this.target.texture.minFilter = NearestFilter;
      this.target.texture.magFilter = NearestFilter;
      this.uniforms.successorSunShadowMap.value = this.target.texture;
    } else {
      this.target.setSize(mapSize, mapSize);
    }
    this.targetSize = mapSize;
  }

  private disposeTarget(): void {
    if (!this.target) return;
    this.target.dispose();
    this.target = null;
    this.targetSize = 0;
    this.uniforms.successorSunShadowMap.value = null;
  }
}
