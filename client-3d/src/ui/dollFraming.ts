/**
 * DOLL FRAMING — pure math + attachment measure for the character doll ortho
 * frustum (select roster + creator share it via charDollPreview).
 *
 * Two measured spans feed one frame:
 * - `bones`: the ANIMATED skeleton span after mixer.update(0). Bones stop at
 *   the ankle joints and head root, so soles/scalp flesh needs padding.
 * - `attachments`: world-space bounds of worn equipment. Rigid meshes ride a
 *   live bone matrix, so geometry AABB × matrixWorld is exact. Skinned
 *   attachments (boots_canvas_ankle and kin) must be posed vertex-by-vertex —
 *   a plain Box3 reads the bind pose, not the idle pose the player sees.
 *
 * The frame then converts to an ortho frustum per host aspect: height is the
 * framing authority, but a narrow host widens the band (shrinking the doll)
 * rather than cropping shoulders/hands.
 */

import { Box3, Mesh, Object3D, SkinnedMesh, Vector3 } from "three";

/** World-space vertical span + symmetric horizontal reach of a measure. */
export interface DollSpan {
  minY: number;
  maxY: number;
  /** max |x| across the measure — the doll stage is centered on x=0. */
  maxAbsX: number;
}

/** Resolved doll frame: world-Y band center/height plus required half-width. */
export interface DollFrame {
  centerY: number;
  height: number;
  halfWidth: number;
}

export interface OrthoFrustumBand {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Tuned fallback for the pack rig (origin at the CHEST, body ~-1.0..0.75)
 * when a live measure never lands — matches the pre-helper constants. */
export const DEFAULT_DOLL_FRAME: DollFrame = { centerY: -0.12, height: 2.05, halfWidth: 0.85 };

/** Below this bone span the measure is garbage (missing skeleton). */
const MIN_BONE_SPAN = 0.3;
/** Ankle bone → boot sole flesh. */
const SOLE_PAD = 0.14;
/** Head bone → scalp crest (hair meshes past this feed `attachments`). */
const CROWN_PAD = 0.24;
/** Shoulder/hand bones → arm flesh + idle sway. */
const SIDE_PAD = 0.3;
/** Attachment mesh bounds are exact (rigid AABB or posed skinned verts) —
 * just a whisker so nothing kisses the edge. */
const ATTACHMENT_PAD = 0.05;
/** Deliberate breathing room around the measured band. */
const BREATHING = 1.12;
/** Never zoom tighter than this even on a tiny measure. */
const MIN_HEIGHT = 1.6;
/**
 * Hard cap on skinned vertex samples per mesh. Creator footwear is a few
 * hundred verts; this keeps a pathological mesh from stalling rebuild while
 * still covering the posed sole/cuff extremes via stride sampling.
 */
export const MAX_SKINNED_ATTACHMENT_SAMPLES = 2048;

// Module-level scratch — measure runs once per appearance rebuild, never per
// rAF tick. Reusing these avoids Box3/Vector3 churn on every wardrobe click.
const meshBox = new Box3();
const posedVertex = new Vector3();

function spanValid(span: DollSpan | null): span is DollSpan {
  return span !== null
    && Number.isFinite(span.minY)
    && Number.isFinite(span.maxY)
    && Number.isFinite(span.maxAbsX)
    && span.maxY > span.minY;
}

/** Resolve the doll frame from the animated bone span and (optional)
 * attachment bounds (rigid and/or posed skinned). Falls back to
 * `DEFAULT_DOLL_FRAME` on a bad measure. */
export function computeDollFrame(bones: DollSpan | null, attachments: DollSpan | null): DollFrame {
  if (!spanValid(bones) || bones.maxY - bones.minY < MIN_BONE_SPAN) return DEFAULT_DOLL_FRAME;
  let minY = bones.minY - SOLE_PAD;
  let maxY = bones.maxY + CROWN_PAD;
  let halfWidth = bones.maxAbsX + SIDE_PAD;
  if (spanValid(attachments)) {
    minY = Math.min(minY, attachments.minY - ATTACHMENT_PAD);
    maxY = Math.max(maxY, attachments.maxY + ATTACHMENT_PAD);
    halfWidth = Math.max(halfWidth, attachments.maxAbsX + ATTACHMENT_PAD);
  }
  return {
    centerY: (minY + maxY) / 2,
    height: Math.max(MIN_HEIGHT, (maxY - minY) * BREATHING),
    halfWidth,
  };
}

/** Ortho frustum for a frame at a host aspect (width/height). Height rules;
 * a host too narrow for `halfWidth` grows the band instead of cropping. */
export function dollOrthoFrustum(frame: DollFrame, aspect: number): OrthoFrustumBand {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const widthNeed = (frame.halfWidth * 2 * BREATHING) / safeAspect;
  const height = Math.max(frame.height, widthNeed);
  const halfWidth = (height * safeAspect) / 2;
  return {
    left: -halfWidth,
    right: halfWidth,
    top: frame.centerY + height / 2,
    bottom: frame.centerY - height / 2,
  };
}

interface SpanBuilder {
  minY: number;
  maxY: number;
  maxAbsX: number;
  hit: boolean;
}

function createSpanBuilder(): SpanBuilder {
  return {
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    maxAbsX: 0,
    hit: false,
  };
}

function includePoint(builder: SpanBuilder, x: number, y: number, _z: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (y < builder.minY) builder.minY = y;
  if (y > builder.maxY) builder.maxY = y;
  const absX = Math.abs(x);
  if (absX > builder.maxAbsX) builder.maxAbsX = absX;
  builder.hit = true;
}

function includeBox(builder: SpanBuilder, box: Box3): void {
  if (box.isEmpty()) return;
  // AABB corners — X extremes + Y extremes cover the doll span contract
  // (vertical band + symmetric |x|). Z is unused by framing.
  includePoint(builder, box.min.x, box.min.y, box.min.z);
  includePoint(builder, box.min.x, box.max.y, box.min.z);
  includePoint(builder, box.max.x, box.min.y, box.min.z);
  includePoint(builder, box.max.x, box.max.y, box.min.z);
  includePoint(builder, box.min.x, box.min.y, box.max.z);
  includePoint(builder, box.min.x, box.max.y, box.max.z);
  includePoint(builder, box.max.x, box.min.y, box.max.z);
  includePoint(builder, box.max.x, box.max.y, box.max.z);
}

function finalizeSpan(builder: SpanBuilder): DollSpan | null {
  if (!builder.hit) return null;
  if (!(builder.maxY > builder.minY) || !Number.isFinite(builder.maxAbsX)) return null;
  return {
    minY: builder.minY,
    maxY: builder.maxY,
    maxAbsX: builder.maxAbsX,
  };
}

/** Rigid mesh: geometry AABB transformed by the live world matrix. */
function expandBuilderByRigidMesh(builder: SpanBuilder, mesh: Mesh): void {
  const geometry = mesh.geometry;
  if (!geometry) return;
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds || bounds.isEmpty()) return;
  meshBox.copy(bounds).applyMatrix4(mesh.matrixWorld);
  includeBox(builder, meshBox);
}

/**
 * Posed skinned mesh: each sampled vertex is skinned with the live skeleton
 * (Three `getVertexPosition` → bone matrices after mixer.update) then lifted
 * into world space through the mesh matrix. Bind-pose Box3 is never used.
 */
function expandBuilderBySkinnedMesh(builder: SpanBuilder, mesh: SkinnedMesh): void {
  const geometry = mesh.geometry;
  if (!geometry) return;
  const position = geometry.getAttribute("position");
  if (!position || position.count <= 0) return;
  // bindMatrixInverse tracks matrixWorld in the default Attached bind mode.
  mesh.updateMatrixWorld(true);
  const count = position.count;
  const stride = count <= MAX_SKINNED_ATTACHMENT_SAMPLES
    ? 1
    : Math.ceil(count / MAX_SKINNED_ATTACHMENT_SAMPLES);
  for (let i = 0; i < count; i += stride) {
    mesh.getVertexPosition(i, posedVertex);
    posedVertex.applyMatrix4(mesh.matrixWorld);
    includePoint(builder, posedVertex.x, posedVertex.y, posedVertex.z);
  }
  // Always include the final vertex so a strided scan cannot miss the sole
  // tip when count-1 is not on the stride grid.
  if (stride > 1 && (count - 1) % stride !== 0) {
    mesh.getVertexPosition(count - 1, posedVertex);
    posedVertex.applyMatrix4(mesh.matrixWorld);
    includePoint(builder, posedVertex.x, posedVertex.y, posedVertex.z);
  }
}

function expandBuilderByAttachmentRoot(builder: SpanBuilder, root: Object3D): void {
  root.traverse((node) => {
    if (node instanceof SkinnedMesh) {
      expandBuilderBySkinnedMesh(builder, node);
      return;
    }
    if (node instanceof Mesh) {
      expandBuilderByRigidMesh(builder, node);
    }
  });
}

/**
 * World-space attachment span for equipment roots collected by the pawn
 * attach path. Handles rigid Mesh shells and posed SkinnedMesh footwear in
 * one pass. Returns null when nothing measurable is present (barefoot, empty
 * list, or malformed geometry).
 *
 * Caller must have already posed the skeleton (`mixer.update(0)`) and
 * refreshed world matrices on the doll root.
 */
export function measureEquipmentAttachmentSpan(
  attachments: readonly Object3D[],
): DollSpan | null {
  if (attachments.length === 0) return null;
  const builder = createSpanBuilder();
  for (let i = 0; i < attachments.length; i += 1) {
    const root = attachments[i];
    if (!root) continue;
    expandBuilderByAttachmentRoot(builder, root);
  }
  return finalizeSpan(builder);
}
