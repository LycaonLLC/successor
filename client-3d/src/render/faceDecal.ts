import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  MeshBasicMaterial,
  Object3D,
  SkinnedMesh,
  SRGBColorSpace,
} from "three";
import {
  loadFaceAssets,
  renderFaceTexture,
  type FaceAssets,
  type FaceStyle,
} from "../assets/faceKit/face-kit.js";

/**
 * FACE PAINT — the face-kit compositor output projected DIRECTLY onto the
 * pawn's own head geometry (owner ruling 2026-07-22: painted on, not a card
 * floating in front). Bodies ship with no UVs, so this module builds a face
 * overlay sub-mesh at runtime: the front-facing head-weighted triangles of
 * the body's skinned geometry, planar-projected into the measured face rect
 * for UVs, inflated ~1.5mm along bind normals, and bound to the same
 * skeleton. The transparent decal texture wraps the true face curvature and
 * tracks head animation exactly like skin; the matcap body beneath stays the
 * skin tone on every angle.
 *
 * One overlay geometry per body geometry (shared, never disposed — same rule
 * as pack geometry) and one texture/material per unique face config, shared
 * across world pawns, roster/creator dolls, paper dolls, and portraits.
 */

/** Wire/state face shape (ServerAuthorityActorFaceState). */
export interface PawnFaceConfig {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eye_color: string;
  brow_color: string;
  lip_color: string;
}

/** Face projection rect measured from pawn_male/female GLB bind pose (raw
 * GLB/bind units): head verts y 1.554–1.763 and x ±0.084 around the head
 * bone at y 1.55; the face-fit-lab card landed at center y 1.658, size
 * 0.165. The planar UV projection reuses that exact rect, so the kit's
 * feature layout lands where the card proof put it. */
const FACE_RECT_CENTER_Y = 1.658;
const FACE_RECT_SIZE = 0.165;
/** Bind-normal inflation keeping painted features just proud of the skin. */
const FACE_OVERLAY_INFLATE = 0.0015;
/** Head-dominance weight threshold for overlay vertex selection. */
const FACE_HEAD_WEIGHT_MIN = 0.35;
/** Triangles must face forward in bind pose (mean normal z) to be painted —
 * keeps the planar projection off the back of the skull. */
const FACE_FORWARD_NORMAL_MIN = 0.05;
const FACE_TEXTURE_SIZE = 256;

export function faceSignature(face: PawnFaceConfig | null | undefined): string {
  if (!face) return "";
  return `${face.eyes},${face.brows},${face.nose},${face.mouth},${face.eye_color},${face.brow_color},${face.lip_color}`;
}

interface FacePaintEntry {
  material: MeshBasicMaterial;
  texture: CanvasTexture;
}

let faceAssetsPromise: Promise<FaceAssets | null> | null = null;
const facePaintCache = new Map<string, FacePaintEntry>();
/** Source body geometry uuid -> face overlay geometry (null = no head found). */
const faceOverlayGeometryCache = new Map<string, BufferGeometry | null>();

function faceAssets(): Promise<FaceAssets | null> {
  faceAssetsPromise ??= loadFaceAssets(new URL(requireRuntimePublicPath("/assets/face-kit/assets/")!, window.location.origin))
    .catch((error: unknown) => {
      console.warn("face paint: atlas load failed — faces stay blank", error);
      return null;
    });
  return faceAssetsPromise;
}

function facePaintEntry(face: PawnFaceConfig, signature: string): FacePaintEntry {
  const cached = facePaintCache.get(signature);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = FACE_TEXTURE_SIZE;
  canvas.height = FACE_TEXTURE_SIZE;
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    // The overlay hugs the skin it was cut from — bias it in front even at
    // grazing angles and mid-animation.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  material.userData.successorFacePaintReady = false;
  material.userData.successorFaceSignature = signature;
  const entry: FacePaintEntry = { material, texture };
  facePaintCache.set(signature, entry);

  void faceAssets().then((assets) => {
    if (!assets || facePaintCache.get(signature) !== entry) return;
    // Wire style ids are open strings; the kit clamps unknown ids to "stoic"
    // in normalizeFaceConfig, so the cast cannot render garbage.
    const styles = {
      eyes: face.eyes,
      brows: face.brows,
      nose: face.nose,
      mouth: face.mouth,
    } as Partial<Record<"eyes" | "brows" | "nose" | "mouth", FaceStyle>>;
    renderFaceTexture(assets, {
      styles,
      eyeColor: face.eye_color,
      browColor: face.brow_color,
      lipColor: face.lip_color,
    }, { size: FACE_TEXTURE_SIZE, transparent: true, canvas });
    texture.needsUpdate = true;
    material.userData.successorFacePaintReady = true;
  });
  return entry;
}

/** Per-vertex weight toward the skeleton's `head` bone. */
function headWeightOf(
  skinIndex: BufferAttribute,
  skinWeight: BufferAttribute,
  vertex: number,
  headBoneIndex: number,
): number {
  let weight = 0;
  for (let component = 0; component < 4; component += 1) {
    if (skinIndex.getComponent(vertex, component) === headBoneIndex) {
      weight += skinWeight.getComponent(vertex, component);
    }
  }
  return weight;
}

/**
 * Cut the paintable face patch out of a body's skinned geometry: triangles
 * whose three vertices are head-dominant and whose mean bind normal faces
 * forward. Vertices carry planar UVs from the measured face rect, positions
 * inflated along bind normals, and the original skin attributes so the
 * overlay deforms identically to the head it was cut from.
 */
function buildFaceOverlayGeometry(source: SkinnedMesh): BufferGeometry | null {
  const geometry = source.geometry;
  const index = geometry.index;
  const position = geometry.attributes.position as BufferAttribute | undefined;
  const normal = geometry.attributes.normal as BufferAttribute | undefined;
  const skinIndex = geometry.attributes.skinIndex as BufferAttribute | undefined;
  const skinWeight = geometry.attributes.skinWeight as BufferAttribute | undefined;
  if (!index || !position || !normal || !skinIndex || !skinWeight) return null;
  const headBoneIndex = source.skeleton.bones.findIndex((bone) => bone.name.toLowerCase() === "head");
  if (headBoneIndex < 0) return null;

  const vertexCount = position.count;
  const isHeadVertex = new Uint8Array(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (headWeightOf(skinIndex, skinWeight, vertex, headBoneIndex) >= FACE_HEAD_WEIGHT_MIN) {
      isHeadVertex[vertex] = 1;
    }
  }

  // Select forward-facing all-head triangles; collect the used vertex set.
  const keptTriangles: number[] = [];
  const remap = new Map<number, number>();
  for (let triangle = 0; triangle < index.count; triangle += 3) {
    const a = index.getX(triangle);
    const b = index.getX(triangle + 1);
    const c = index.getX(triangle + 2);
    if (!isHeadVertex[a] || !isHeadVertex[b] || !isHeadVertex[c]) continue;
    const meanNormalZ = (normal.getZ(a) + normal.getZ(b) + normal.getZ(c)) / 3;
    if (meanNormalZ < FACE_FORWARD_NORMAL_MIN) continue;
    for (const vertex of [a, b, c]) {
      if (!remap.has(vertex)) remap.set(vertex, remap.size);
    }
    keptTriangles.push(a, b, c);
  }
  if (keptTriangles.length === 0) return null;

  const overlayCount = remap.size;
  const positions = new Float32Array(overlayCount * 3);
  const uvs = new Float32Array(overlayCount * 2);
  const joints = new Uint16Array(overlayCount * 4);
  const weights = new Float32Array(overlayCount * 4);
  const rectHalf = FACE_RECT_SIZE / 2;
  for (const [vertex, overlayVertex] of remap) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    positions[overlayVertex * 3] = x + normal.getX(vertex) * FACE_OVERLAY_INFLATE;
    positions[overlayVertex * 3 + 1] = y + normal.getY(vertex) * FACE_OVERLAY_INFLATE;
    positions[overlayVertex * 3 + 2] = z + normal.getZ(vertex) * FACE_OVERLAY_INFLATE;
    uvs[overlayVertex * 2] = (x + rectHalf) / FACE_RECT_SIZE;
    uvs[overlayVertex * 2 + 1] = (y - (FACE_RECT_CENTER_Y - rectHalf)) / FACE_RECT_SIZE;
    for (let component = 0; component < 4; component += 1) {
      joints[overlayVertex * 4 + component] = skinIndex.getComponent(vertex, component);
      weights[overlayVertex * 4 + component] = skinWeight.getComponent(vertex, component);
    }
  }

  const overlay = new BufferGeometry();
  overlay.setAttribute("position", new BufferAttribute(positions, 3));
  overlay.setAttribute("uv", new BufferAttribute(uvs, 2));
  overlay.setAttribute("skinIndex", new BufferAttribute(joints, 4));
  overlay.setAttribute("skinWeight", new BufferAttribute(weights, 4));
  overlay.setIndex(keptTriangles.map((vertex) => remap.get(vertex)!));
  return overlay;
}

/**
 * Paint the face onto the body's head geometry. Null face = no overlay
 * (legacy blank look). The overlay mesh is pushed to `attachedOut` so the
 * caller's equipment-attachment cleanup detaches it on rebuild; the shared
 * geometry/material/texture stay cached for the session.
 */
export function attachPawnFaceDecal(
  bodyRoot: Object3D,
  face: PawnFaceConfig | null | undefined,
  attachedOut?: Object3D[],
): void {
  if (!face) return;
  let sourceMesh: SkinnedMesh | null = null;
  bodyRoot.traverse((object) => {
    if (!sourceMesh && object instanceof SkinnedMesh) sourceMesh = object;
  });
  if (!sourceMesh) return;
  const body = sourceMesh as SkinnedMesh;

  let overlayGeometry = faceOverlayGeometryCache.get(body.geometry.uuid);
  if (overlayGeometry === undefined) {
    overlayGeometry = buildFaceOverlayGeometry(body);
    faceOverlayGeometryCache.set(body.geometry.uuid, overlayGeometry);
  }
  if (!overlayGeometry) return;

  const entry = facePaintEntry(face, faceSignature(face));
  const overlay = new SkinnedMesh(overlayGeometry, entry.material);
  overlay.name = "appearance:face";
  overlay.userData.successorOwnedEquipmentAttachment = true;
  overlay.userData.successorFaceSignature = faceSignature(face);
  overlay.renderOrder = 10;
  overlay.frustumCulled = false;
  overlay.castShadow = false;
  overlay.matrixAutoUpdate = body.matrixAutoUpdate;
  overlay.matrix.copy(body.matrix);
  overlay.position.copy(body.position);
  overlay.quaternion.copy(body.quaternion);
  overlay.scale.copy(body.scale);
  (body.parent ?? bodyRoot).add(overlay);
  overlay.bind(body.skeleton, body.bindMatrix.clone());
  overlay.bindMode = body.bindMode;
  attachedOut?.push(overlay);
}
