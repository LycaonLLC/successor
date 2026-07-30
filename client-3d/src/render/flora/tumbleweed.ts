import {
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type Scene,
} from "three";
import type { WorldEnvironment } from "../environment";
import { markSunShadowCaster } from "../environment/sunShadow";
import type { FloraGeometryKit } from "./generators";
import { TUMBLEWEED_BASE_RADIUS } from "./generators";

interface TumbleweedActor {
  mesh: Mesh;
  active: boolean;
  x: number;
  z: number;
  velocityX: number;
  velocityZ: number;
  radius: number;
  hopY: number;
  hopVelocity: number;
}

const MAX_TUMBLEWEEDS = 3;
const MIN_SPAWN_CELLS = 40;
const MAX_SPAWN_CELLS = 60;
const DESPAWN_PAST_FOCUS_CELLS = 70;
const LATERAL_SPAWN_CELLS = 28;
const GRAVITY = 2.8;
const HOP_MIN_VELOCITY = 0.82;
const HOP_MAX_VELOCITY = 1.15;

export class TumbleweedSystem {
  private readonly root = new Group();
  private readonly actors: TumbleweedActor[] = [];
  private readonly rollAxis = new Vector3();
  private readonly rollQuat = new Quaternion();
  private readonly scale = new Vector3();
  private worldSeed = 0xffffffff;
  private rngState = 0x7A3B1E;
  private spawnCooldownSeconds = 0;
  private previousGust = 0;
  private live = 0;

  constructor(private readonly scene: Scene, kit: FloraGeometryKit) {
    this.root.name = "flora:tumbleweeds";
    this.scene.add(this.root);
    for (let i = 0; i < MAX_TUMBLEWEEDS; i += 1) {
      const mesh = new Mesh(kit.tumbleweedGeometry, kit.tumbleweedMaterial);
      mesh.name = `flora:tumbleweed:${i}`;
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.actors.push({
        mesh,
        active: false,
        x: 0,
        z: 0,
        velocityX: 0,
        velocityZ: 0,
        radius: 0.45,
        hopY: 0,
        hopVelocity: 0,
      });
    }
    markSunShadowCaster(this.root);
  }

  get liveCount(): number {
    return this.live;
  }

  setWorldSeed(seed: number): void {
    const normalized = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0x7A3B1E;
    if (normalized === this.worldSeed) return;
    this.worldSeed = normalized;
    this.rngState = normalized ^ 0x7A3B1E;
    this.reset();
  }

  update(focusX: number, focusZ: number, dtSeconds: number, env: WorldEnvironment): void {
    const dt = Math.max(0, Math.min(0.08, dtSeconds));
    this.spawnCooldownSeconds = Math.max(0, this.spawnCooldownSeconds - dt);
    this.live = 0;
    const wind = env.wind;
    const gustSpike = wind.gust01 > 0.72 && this.previousGust <= 0.72;
    for (let i = 0; i < this.actors.length; i += 1) {
      const actor = this.actors[i]!;
      if (!actor.active) continue;
      actor.velocityX = wind.dirX * actorSpeed(actor.radius, wind.strength01, i);
      actor.velocityZ = wind.dirZ * actorSpeed(actor.radius, wind.strength01, i);
      actor.x += actor.velocityX * dt;
      actor.z += actor.velocityZ * dt;
      if (gustSpike && actor.hopY <= 0.001) actor.hopVelocity = HOP_MIN_VELOCITY + this.next() * (HOP_MAX_VELOCITY - HOP_MIN_VELOCITY);
      actor.hopVelocity -= GRAVITY * dt;
      actor.hopY = Math.max(0, actor.hopY + actor.hopVelocity * dt);
      if (actor.hopY === 0 && actor.hopVelocity < 0) actor.hopVelocity = 0;
      this.updateActorMesh(actor, dt);
      const pastFocus = (actor.x - focusX) * wind.dirX + (actor.z - focusZ) * wind.dirZ;
      if (pastFocus > DESPAWN_PAST_FOCUS_CELLS) {
        this.deactivate(actor);
        continue;
      }
      this.live += 1;
    }

    const quietFrame = dtSeconds > 0 && dtSeconds < 0.09;
    const target = wind.strength01 > 0.58 && wind.gust01 > 0.42 ? 3 : 2;
    if (quietFrame && this.spawnCooldownSeconds <= 0 && this.live < target && wind.strength01 > 0.05) {
      const spawnCount = target - this.live;
      for (let i = 0; i < spawnCount; i += 1) {
        this.spawn(focusX, focusZ, wind.dirX, wind.dirZ, wind.strength01);
      }
      this.spawnCooldownSeconds = 3.8 + this.next() * 4.4;
    }
    this.previousGust = wind.gust01;
  }

  dispose(): void {
    this.reset();
    this.scene.remove(this.root);
    this.root.clear();
  }

  private spawn(focusX: number, focusZ: number, windX: number, windZ: number, strength: number): void {
    const actor = this.firstInactive();
    if (!actor) return;
    const spawnDistance = MIN_SPAWN_CELLS + this.next() * (MAX_SPAWN_CELLS - MIN_SPAWN_CELLS);
    const lateral = (this.next() * 2 - 1) * LATERAL_SPAWN_CELLS;
    const sideX = -windZ;
    const sideZ = windX;
    actor.radius = 0.35 + this.next() * 0.2;
    actor.x = focusX - windX * spawnDistance + sideX * lateral;
    actor.z = focusZ - windZ * spawnDistance + sideZ * lateral;
    const speed = actorSpeed(actor.radius, strength, this.actors.indexOf(actor));
    actor.velocityX = windX * speed;
    actor.velocityZ = windZ * speed;
    actor.hopY = 0;
    actor.hopVelocity = 0;
    actor.active = true;
    actor.mesh.visible = true;
    actor.mesh.quaternion.set(0, 0, 0, 1);
    this.scale.setScalar(actor.radius / TUMBLEWEED_BASE_RADIUS);
    actor.mesh.scale.copy(this.scale);
    actor.mesh.position.set(actor.x, actor.radius, actor.z);
    this.live += 1;
  }

  private updateActorMesh(actor: TumbleweedActor, dt: number): void {
    const speed = Math.hypot(actor.velocityX, actor.velocityZ);
    if (speed > 0.001 && actor.radius > 0.001) {
      const invSpeed = 1 / speed;
      this.rollAxis.set(actor.velocityZ * invSpeed, 0, -actor.velocityX * invSpeed);
      this.rollQuat.setFromAxisAngle(this.rollAxis, (speed * dt) / actor.radius);
      actor.mesh.quaternion.premultiply(this.rollQuat);
    }
    actor.mesh.position.set(actor.x, actor.radius + actor.hopY, actor.z);
  }

  private deactivate(actor: TumbleweedActor): void {
    actor.active = false;
    actor.mesh.visible = false;
    actor.hopY = 0;
    actor.hopVelocity = 0;
  }

  private reset(): void {
    this.live = 0;
    this.spawnCooldownSeconds = 0;
    this.previousGust = 0;
    for (let i = 0; i < this.actors.length; i += 1) this.deactivate(this.actors[i]!);
  }

  private firstInactive(): TumbleweedActor | null {
    for (let i = 0; i < this.actors.length; i += 1) {
      const actor = this.actors[i]!;
      if (!actor.active) return actor;
    }
    return null;
  }

  private next(): number {
    this.rngState = Math.imul(this.rngState ^ (this.rngState >>> 15), 0x2c1b3c6d) >>> 0;
    this.rngState = Math.imul(this.rngState ^ (this.rngState >>> 12), 0x297a2d39) >>> 0;
    this.rngState = (this.rngState ^ (this.rngState >>> 15)) >>> 0;
    return this.rngState / 0xffffffff;
  }
}

function actorSpeed(radius: number, windStrength: number, index: number): number {
  const base = 2.5 + (index % 3) * 0.65 + (0.55 - radius) * 2.2;
  const strength = Math.max(0, Math.min(1, windStrength));
  return base * strength;
}
