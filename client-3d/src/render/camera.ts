import {
  MathUtils,
  OrthographicCamera,
  Vector2,
  Vector3,
  type WebGLRenderer,
} from "three";
import { SUCCESSOR_3D_CONFIG } from "../config";

export interface ScreenPoint {
  px: number;
  py: number;
}

export interface GroundBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const yawRadians = MathUtils.degToRad(SUCCESSOR_3D_CONFIG.camera.yawDegrees);
const pitchRadians = MathUtils.degToRad(SUCCESSOR_3D_CONFIG.camera.pitchDegrees);
const cameraDistance = SUCCESSOR_3D_CONFIG.camera.distanceCells;
const cameraHorizontalDistance = Math.cos(pitchRadians) * cameraDistance;
const cameraHeight = Math.sin(pitchRadians) * cameraDistance;
const cameraOffset = new Vector3(
  Math.sin(yawRadians) * cameraHorizontalDistance,
  cameraHeight,
  Math.cos(yawRadians) * cameraHorizontalDistance,
);

export class IsometricCameraController {
  readonly camera = new OrthographicCamera(
    -1,
    1,
    1,
    -1,
    SUCCESSOR_3D_CONFIG.camera.near,
    SUCCESSOR_3D_CONFIG.camera.far,
  );

  private readonly center = new Vector3(0, 0, 0);
  private readonly desiredCenter = new Vector3(0, 0, 0);
  private readonly nearPoint = new Vector3();
  private readonly farPoint = new Vector3();
  private readonly rayDirection = new Vector3();
  private readonly projected = new Vector3();
  private width = 1;
  private height = 1;
  private zoomPercent: number = SUCCESSOR_3D_CONFIG.camera.minZoomPercent;
  private initialized = false;

  constructor() {
    this.camera.up.set(0, 1, 0);
    this.updateCameraTransform();
  }

  resize(width: number, height: number, zoomPercent: number): void {
    const safeWidth = Math.max(1, Math.floor(width));
    const safeHeight = Math.max(1, Math.floor(height));
    const clampedZoom = clampZoomPercent(zoomPercent);
    if (safeWidth === this.width && safeHeight === this.height && clampedZoom === this.zoomPercent) return;
    this.width = safeWidth;
    this.height = safeHeight;
    this.zoomPercent = clampedZoom;
    const aspect = safeWidth / safeHeight;
    const zoomScale = clampedZoom / 100;
    const frustumHeight = SUCCESSOR_3D_CONFIG.camera.baseFrustumHeightCells / zoomScale;
    const frustumWidth = frustumHeight * aspect;
    this.camera.left = -frustumWidth / 2;
    this.camera.right = frustumWidth / 2;
    this.camera.top = frustumHeight / 2;
    this.camera.bottom = -frustumHeight / 2;
    this.camera.updateProjectionMatrix();
  }

  updateFocus(x: number, z: number, dtSeconds: number): void {
    this.desiredCenter.set(x, 0, z);
    if (!this.initialized) {
      this.center.copy(this.desiredCenter);
      this.initialized = true;
    } else {
      const alpha = 1 - Math.exp(-SUCCESSOR_3D_CONFIG.camera.followLerpPerSecond * Math.max(0, dtSeconds));
      this.center.lerp(this.desiredCenter, alpha);
    }
    this.updateCameraTransform();
  }

  screenToGround(renderer: WebGLRenderer, clientX: number, clientY: number, out: Vector3): boolean {
    const rect = renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((clientY - rect.top) / rect.height) * 2 - 1);
    return this.ndcToGround(ndcX, ndcY, out);
  }

  screenOffsetToGround(offsetX: number, offsetY: number, width: number, height: number, out: Vector3): boolean {
    if (width <= 0 || height <= 0) return false;
    const ndcX = (offsetX / width) * 2 - 1;
    const ndcY = -((offsetY / height) * 2 - 1);
    return this.ndcToGround(ndcX, ndcY, out);
  }

  ndcToGround(ndcX: number, ndcY: number, out: Vector3): boolean {
    this.nearPoint.set(ndcX, ndcY, -1).unproject(this.camera);
    this.farPoint.set(ndcX, ndcY, 1).unproject(this.camera);
    this.rayDirection.subVectors(this.farPoint, this.nearPoint);
    if (Math.abs(this.rayDirection.y) < 0.0001) return false;
    const t = -this.nearPoint.y / this.rayDirection.y;
    if (!Number.isFinite(t) || t < 0) return false;
    out.copy(this.nearPoint).addScaledVector(this.rayDirection, t);
    return Number.isFinite(out.x) && Number.isFinite(out.z);
  }

  groundBounds(out: GroundBounds): GroundBounds {
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    const corners = [-1, 1] as const;
    for (const ndcX of corners) {
      for (const ndcY of corners) {
        if (!this.ndcToGround(ndcX, ndcY, this.projected)) continue;
        minX = Math.min(minX, this.projected.x);
        maxX = Math.max(maxX, this.projected.x);
        minZ = Math.min(minZ, this.projected.z);
        maxZ = Math.max(maxZ, this.projected.z);
      }
    }
    out.minX = Number.isFinite(minX) ? minX : this.center.x;
    out.maxX = Number.isFinite(maxX) ? maxX : this.center.x;
    out.minZ = Number.isFinite(minZ) ? minZ : this.center.z;
    out.maxZ = Number.isFinite(maxZ) ? maxZ : this.center.z;
    return out;
  }

  private updateCameraTransform(): void {
    this.camera.position.copy(this.center).add(cameraOffset);
    this.camera.lookAt(this.center);
  }
}

export function worldToScreen(
  camera: OrthographicCamera,
  renderer: WebGLRenderer,
  x: number,
  z: number,
  y = 0,
  target: ScreenPoint = { px: 0, py: 0 },
): ScreenPoint {
  const rect = renderer.domElement.getBoundingClientRect();
  return worldToScreenViewport(camera, rect.width, rect.height, x, z, y, target);
}

export function worldToScreenViewport(
  camera: OrthographicCamera,
  width: number,
  height: number,
  x: number,
  z: number,
  y = 0,
  target: ScreenPoint = { px: 0, py: 0 },
): ScreenPoint {
  const projected = reusableWorldToScreenVector.set(x, y, z).project(camera);
  target.px = ((projected.x + 1) / 2) * Math.max(1, width);
  target.py = ((1 - projected.y) / 2) * Math.max(1, height);
  return target;
}

export function screenPointToNdc(point: ScreenPoint, renderer: WebGLRenderer, target = new Vector2()): Vector2 {
  const rect = renderer.domElement.getBoundingClientRect();
  target.set((point.px / Math.max(1, rect.width)) * 2 - 1, -((point.py / Math.max(1, rect.height)) * 2 - 1));
  return target;
}

export function clampZoomPercent(value: number): number {
  return MathUtils.clamp(
    value,
    SUCCESSOR_3D_CONFIG.camera.minZoomPercent,
    SUCCESSOR_3D_CONFIG.camera.maxZoomPercent,
  );
}

const reusableWorldToScreenVector = new Vector3();
