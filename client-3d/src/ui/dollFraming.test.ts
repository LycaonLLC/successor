import { describe, expect, it } from "vitest";
import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Skeleton,
  SkinnedMesh,
} from "three";
import {
  computeDollFrame,
  DEFAULT_DOLL_FRAME,
  dollOrthoFrustum,
  MAX_SKINNED_ATTACHMENT_SAMPLES,
  measureEquipmentAttachmentSpan,
  type DollSpan,
} from "./dollFraming";

/** Pack-rig-shaped bone measure: idle pose spans roughly -1.0..0.75. */
const rigBones: DollSpan = { minY: -1.0, maxY: 0.75, maxAbsX: 0.42 };

function bandBottom(frame: { centerY: number; height: number }): number {
  return frame.centerY - frame.height / 2;
}

function bandTop(frame: { centerY: number; height: number }): number {
  return frame.centerY + frame.height / 2;
}

/** Rigid unit box centered at origin in local space. */
function makeRigidBoxMesh(size = 0.2): Mesh {
  const geometry = new BufferGeometry();
  const h = size / 2;
  const positions = new Float32Array([
    -h, -h, -h,
    h, -h, -h,
    h, h, -h,
    -h, h, -h,
    -h, -h, h,
    h, -h, h,
    h, h, h,
    -h, h, h,
  ]);
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  return new Mesh(geometry, new MeshBasicMaterial());
}

/**
 * Minimal skinned footwear stand-in: one bone, binary weights, a vertical
 * column of verts. After a bone translation the posed sole moves with the
 * bone — bind-pose Box3 stays put, which is exactly the creator bug.
 */
function makeSkinnedBootColumn(opts?: {
  vertCount?: number;
  localMinY?: number;
  localMaxY?: number;
  localX?: number;
}): SkinnedMesh {
  const vertCount = opts?.vertCount ?? 8;
  const localMinY = opts?.localMinY ?? -0.12;
  const localMaxY = opts?.localMaxY ?? 0.24;
  const localX = opts?.localX ?? 0.09;
  const positions = new Float32Array(vertCount * 3);
  const skinIndex = new Uint16Array(vertCount * 4);
  const skinWeight = new Float32Array(vertCount * 4);
  for (let i = 0; i < vertCount; i += 1) {
    const t = vertCount === 1 ? 0 : i / (vertCount - 1);
    positions[i * 3] = localX;
    positions[i * 3 + 1] = localMinY + (localMaxY - localMinY) * t;
    positions[i * 3 + 2] = 0.05;
    skinIndex[i * 4] = 0;
    skinWeight[i * 4] = 1;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));

  const bone = new Bone();
  bone.name = "foot_l";
  const skeleton = new Skeleton([bone]);
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  // Match the pawn attach path: mesh is a sibling of the bone under a root,
  // then rebound to the live skeleton (Attached bind mode).
  const root = new Group();
  root.add(bone);
  root.add(mesh);
  mesh.bind(skeleton);
  root.updateMatrixWorld(true);
  // Stash bone handle for tests that pose after bind.
  mesh.userData.testBone = bone;
  mesh.userData.testRoot = root;
  return mesh;
}

function poseSkinnedBoot(mesh: SkinnedMesh, boneWorldY: number, boneWorldX = 0): void {
  const bone = mesh.userData.testBone as Bone;
  const root = mesh.userData.testRoot as Group;
  bone.position.set(boneWorldX, boneWorldY, 0);
  root.updateMatrixWorld(true);
  // Attached bind mode refreshes bindMatrixInverse from matrixWorld.
  mesh.updateMatrixWorld(true);
}

describe("computeDollFrame", () => {
  it("falls back to the tuned default on a missing or garbage measure", () => {
    expect(computeDollFrame(null, null)).toBe(DEFAULT_DOLL_FRAME);
    expect(computeDollFrame({ minY: 0, maxY: 0.1, maxAbsX: 0.2 }, null)).toBe(DEFAULT_DOLL_FRAME);
    expect(computeDollFrame({ minY: Number.NaN, maxY: 1, maxAbsX: 0 }, null)).toBe(DEFAULT_DOLL_FRAME);
  });

  it("pads the bone span so soles and scalp sit inside the band with breathing room", () => {
    const frame = computeDollFrame(rigBones, null);
    // Head bone + crown flesh fully inside, feet bone + sole flesh fully inside.
    expect(bandTop(frame)).toBeGreaterThan(rigBones.maxY + 0.2);
    expect(bandBottom(frame)).toBeLessThan(rigBones.minY - 0.1);
    // Deliberate breathing room: band exceeds the padded span itself.
    expect(frame.height).toBeGreaterThan((rigBones.maxY - rigBones.minY) * 1.05);
    // But not a wasteland — the doll still fills most of the band.
    expect(frame.height).toBeLessThan((rigBones.maxY - rigBones.minY) * 1.6);
  });

  it("extends the band for tall rigid attachments (high hair crest, deep boots)", () => {
    const base = computeDollFrame(rigBones, null);
    const crest = computeDollFrame(rigBones, { minY: 0.4, maxY: 1.35, maxAbsX: 0.3 });
    expect(bandTop(crest)).toBeGreaterThan(1.35); // crest fully framed
    expect(crest.height).toBeGreaterThan(base.height);
    const boots = computeDollFrame(rigBones, { minY: -1.3, maxY: -0.6, maxAbsX: 0.3 });
    expect(bandBottom(boots)).toBeLessThan(-1.3); // soles fully framed
  });

  it("ignores attachments already inside the padded bone band", () => {
    const base = computeDollFrame(rigBones, null);
    const inside = computeDollFrame(rigBones, { minY: -0.2, maxY: 0.3, maxAbsX: 0.1 });
    expect(inside).toEqual(base);
  });

  it("never zooms tighter than the minimum height", () => {
    const tiny = computeDollFrame({ minY: 0, maxY: 0.5, maxAbsX: 0.1 }, null);
    expect(tiny.height).toBeGreaterThanOrEqual(1.6);
  });

  it("keeps barefoot bone framing stable when attachment span is null", () => {
    const bare = computeDollFrame(rigBones, null);
    const empty = computeDollFrame(rigBones, measureEquipmentAttachmentSpan([]));
    expect(empty).toEqual(bare);
    expect(bandBottom(bare)).toBeLessThan(rigBones.minY);
    expect(bandTop(bare)).toBeGreaterThan(rigBones.maxY);
  });
});

describe("measureEquipmentAttachmentSpan", () => {
  it("returns null for empty, childless, and malformed geometry roots", () => {
    expect(measureEquipmentAttachmentSpan([])).toBeNull();
    expect(measureEquipmentAttachmentSpan([new Group()])).toBeNull();

    const emptyGeom = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    expect(measureEquipmentAttachmentSpan([emptyGeom])).toBeNull();

    const noPosition = new BufferGeometry();
    noPosition.setAttribute("skinIndex", new BufferAttribute(new Uint16Array(4), 4));
    noPosition.setAttribute("skinWeight", new BufferAttribute(new Float32Array([1, 0, 0, 0]), 4));
    const skinnedEmpty = new SkinnedMesh(noPosition, new MeshBasicMaterial());
    const bone = new Bone();
    skinnedEmpty.bind(new Skeleton([bone]));
    expect(measureEquipmentAttachmentSpan([skinnedEmpty])).toBeNull();
  });

  it("measures rigid attachment bounds through the live world matrix", () => {
    const mesh = makeRigidBoxMesh(0.4);
    const root = new Group();
    root.position.set(0.2, 1.2, 0);
    root.add(mesh);
    root.updateMatrixWorld(true);

    const span = measureEquipmentAttachmentSpan([root]);
    expect(span).not.toBeNull();
    expect(span!.minY).toBeCloseTo(1.0, 5);
    expect(span!.maxY).toBeCloseTo(1.4, 5);
    expect(span!.maxAbsX).toBeCloseTo(0.4, 5);

    // Deep boots under the ankle pad must pull the frame down.
    const deep = makeRigidBoxMesh(0.2);
    const deepRoot = new Group();
    deepRoot.position.set(0, -1.35, 0);
    deepRoot.add(deep);
    deepRoot.updateMatrixWorld(true);
    const bootSpan = measureEquipmentAttachmentSpan([deepRoot]);
    const frame = computeDollFrame(rigBones, bootSpan);
    expect(bandBottom(frame)).toBeLessThan(bootSpan!.minY);
  });

  it("measures posed skinned footwear, not the bind-pose Box3", () => {
    const mesh = makeSkinnedBootColumn({
      localMinY: -0.12,
      localMaxY: 0.24,
      localX: 0.09,
    });
    // Idle-like hip drop: foot bone sits near the pack ankle world Y.
    poseSkinnedBoot(mesh, -1.05, 0.08);

    const span = measureEquipmentAttachmentSpan([mesh]);
    expect(span).not.toBeNull();

    // Bind-pose geometry sole is near y=-0.12; posed sole must track the bone.
    expect(span!.minY).toBeLessThan(-1.1);
    expect(span!.minY).toBeCloseTo(-1.05 - 0.12, 4);
    expect(span!.maxY).toBeCloseTo(-1.05 + 0.24, 4);
    expect(span!.maxAbsX).toBeGreaterThan(0.08);

    // Bind-pose Box3 × matrixWorld would stay near the origin and fail framing.
    mesh.geometry.computeBoundingBox();
    const bindBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
    expect(bindBox.min.y).toBeGreaterThan(-0.5);
    expect(span!.minY).toBeLessThan(bindBox.min.y - 0.5);

    const bare = computeDollFrame(rigBones, null);
    const booted = computeDollFrame(rigBones, span);
    expect(bandBottom(booted)).toBeLessThan(bandBottom(bare));
    expect(bandBottom(booted)).toBeLessThan(span!.minY);
  });

  it("unions left/right skinned boots like boots_canvas_ankle pair attach", () => {
    const left = makeSkinnedBootColumn({ localX: 0.09, localMinY: -0.12, localMaxY: 0.2 });
    const right = makeSkinnedBootColumn({ localX: -0.09, localMinY: -0.14, localMaxY: 0.2 });
    poseSkinnedBoot(left, -1.0, 0.1);
    poseSkinnedBoot(right, -1.0, -0.1);

    const span = measureEquipmentAttachmentSpan([left, right]);
    expect(span).not.toBeNull();
    // Deeper sole wins.
    expect(span!.minY).toBeCloseTo(-1.0 - 0.14, 4);
    // Symmetric reach covers both feet.
    expect(span!.maxAbsX).toBeGreaterThanOrEqual(0.19 - 1e-6);
  });

  it("caps skinned vertex scans instead of walking unbounded meshes", () => {
    const huge = makeSkinnedBootColumn({
      vertCount: MAX_SKINNED_ATTACHMENT_SAMPLES * 3 + 17,
      localMinY: -0.2,
      localMaxY: 0.3,
      localX: 0.05,
    });
    poseSkinnedBoot(huge, -1.2, 0);

    const span = measureEquipmentAttachmentSpan([huge]);
    expect(span).not.toBeNull();
    // Stride sampling still captures the authored sole/cuff endpoints.
    expect(span!.minY).toBeCloseTo(-1.2 - 0.2, 3);
    expect(span!.maxY).toBeCloseTo(-1.2 + 0.3, 3);
    expect(span!.maxAbsX).toBeCloseTo(0.05, 3);
  });

  it("ignores non-mesh nodes while still measuring nested rigid shells", () => {
    const holder = new Group();
    const nested = new Group();
    const mesh = makeRigidBoxMesh(0.3);
    nested.position.set(0, 0.9, 0);
    nested.add(mesh);
    holder.add(nested);
    holder.add(new Bone());
    holder.updateMatrixWorld(true);

    const span = measureEquipmentAttachmentSpan([holder]);
    expect(span).not.toBeNull();
    expect(span!.minY).toBeCloseTo(0.75, 5);
    expect(span!.maxY).toBeCloseTo(1.05, 5);
  });
});

describe("dollOrthoFrustum with footwear spans", () => {
  const bareFrame = computeDollFrame(rigBones, null);
  const bootSpan: DollSpan = { minY: -1.28, maxY: -0.7, maxAbsX: 0.28 };
  const bootFrame = computeDollFrame(rigBones, bootSpan);

  it("keeps the vertical band authoritative on desktop-wide hosts", () => {
    for (const aspect of [1.6, 1.777, 2.4]) {
      const band = dollOrthoFrustum(bootFrame, aspect);
      expect(band.top - band.bottom).toBeCloseTo(bootFrame.height, 10);
      expect((band.top + band.bottom) / 2).toBeCloseTo(bootFrame.centerY, 10);
      expect(band.bottom).toBeLessThan(bootSpan.minY);
      expect(band.right - band.left).toBeCloseTo(bootFrame.height * aspect, 10);
    }
  });

  it("widens on mobile-narrow hosts so footwear width still fits", () => {
    for (const aspect of [0.45, 0.56, 0.3]) {
      const band = dollOrthoFrustum(bootFrame, aspect);
      expect(band.top - band.bottom).toBeGreaterThanOrEqual(bootFrame.height - 1e-9);
      expect(band.right).toBeGreaterThanOrEqual(bootFrame.halfWidth);
      expect(band.bottom).toBeLessThan(bootSpan.minY);
      expect((band.top + band.bottom) / 2).toBeCloseTo(bootFrame.centerY, 10);
    }
  });

  it("survives zoom extremes without collapsing the footwear band", () => {
    // Extreme host aspects stand in for turntable zoom extremes: framing
    // math stays finite and still encloses the measured sole.
    for (const aspect of [0.05, 0.2, 8, 20]) {
      const band = dollOrthoFrustum(bootFrame, aspect);
      expect(Number.isFinite(band.top)).toBe(true);
      expect(Number.isFinite(band.bottom)).toBe(true);
      expect(band.top).toBeGreaterThan(band.bottom);
      expect(band.right).toBeGreaterThan(band.left);
      expect(band.bottom).toBeLessThan(bootSpan.minY);
    }
  });

  it("does not regress barefoot body span on common desktop/mobile aspects", () => {
    for (const aspect of [0.56, 0.75, 1, 1.333, 1.777]) {
      const bare = dollOrthoFrustum(bareFrame, aspect);
      const booted = dollOrthoFrustum(bootFrame, aspect);
      expect(bare.bottom).toBeLessThan(rigBones.minY);
      expect(bare.top).toBeGreaterThan(rigBones.maxY);
      // Boots may deepen the band but must not lift the crown out.
      expect(booted.top).toBeGreaterThan(rigBones.maxY);
      expect(booted.bottom).toBeLessThanOrEqual(bare.bottom + 1e-9);
    }
  });

  it("survives degenerate aspect input", () => {
    for (const aspect of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const band = dollOrthoFrustum(bootFrame, aspect);
      expect(Number.isFinite(band.top)).toBe(true);
      expect(Number.isFinite(band.bottom)).toBe(true);
      expect(band.top).toBeGreaterThan(band.bottom);
      expect(band.right).toBeGreaterThan(band.left);
    }
  });
});
