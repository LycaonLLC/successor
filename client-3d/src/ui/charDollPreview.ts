import {
  AnimationMixer,
  Color,
  Fog,
  Group,
  Mesh,
  type Material,
  MeshMatcapMaterial,
  Object3D,
  OrthographicCamera,
  Scene,
  SkinnedMesh,
  Vector3,
  WebGLRenderer,
} from "three";
import {
  applyPawnBodyZoneMask,
  clonePawnBody,
  collectPawnBodyZoneMeshes,
  loadPawnPack,
  resolvePawnBodyZoneMask,
  type PawnBody,
  type PawnEquipmentItem,
  type PawnPack,
} from "../assets/pawnPack";
import { attachPawnEquipmentSet, createPawnMatcapTexture } from "../render/pawns";
import { attachPawnFaceDecal, faceSignature, type PawnFaceConfig } from "../render/faceDecal";
import {
  equipmentSourceMaterialFromUserData,
  getEquipmentMaterialSets,
  resolveEquipmentSlotMaterial,
  type EquipmentSlotMaterialSource,
} from "../assets/equipmentMaterials";
import { attachTurntableInteraction, clampTurntableZoom } from "./turntableInteraction";
import { computeDollFrame, DEFAULT_DOLL_FRAME, dollOrthoFrustum, measureEquipmentAttachmentSpan, type DollFrame, type DollSpan } from "./dollFraming";

/**
 * CHARACTER DOLL — standalone 3D preview for the select/create screens.
 * No PlayState, no authority: pack body clone + optional worn equipment +
 * tints, idle clip via a bare AnimationMixer. One WebGL context, disposed
 * with the screen. Appearance updates rebuild only the doll group (pack is
 * loaded once and cached module-wide — the world boot reuses the same pack
 * loader cache path).
 */

export interface CharDollWornPiece {
  item: string;
  colors: readonly string[];
}

/** Record/creator face shape (camelCase, matches the character API). */
export interface CharDollFace {
  eyes: string;
  brows: string;
  nose: string;
  mouth: string;
  eyeColor: string;
  browColor: string;
  lipColor: string;
}

export interface CharDollAppearance {
  skinTone: string;
  hair: string | null;
  hairMat: string;
  body?: PawnBody;
  equipmentIds?: readonly string[];
  /** Creator worn set — items attach AND their zone colors apply. */
  worn?: readonly CharDollWornPiece[];
  /** Face-kit selection; null/absent = blank legacy face. */
  face?: CharDollFace | null;
}

export interface CharDollPreview {
  setAppearance: (appearance: CharDollAppearance) => void;
  dispose: () => void;
}

let packPromise: Promise<PawnPack> | null = null;

function pack(): Promise<PawnPack> {
  packPromise ??= loadPawnPack();
  return packPromise;
}

function dollFaceToWire(face: CharDollFace | null): PawnFaceConfig | null {
  if (!face) return null;
  return {
    eyes: face.eyes,
    brows: face.brows,
    nose: face.nose,
    mouth: face.mouth,
    eye_color: face.eyeColor,
    brow_color: face.browColor,
    lip_color: face.lipColor,
  };
}

export async function mountCharDollPreview(host: HTMLElement): Promise<CharDollPreview> {
  const loaded = await pack();
  const renderer = new WebGLRenderer({ antialias: false, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.className = "sc3d-chardoll-canvas";
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  scene.fog = null as unknown as Fog; // no fog on the doll stage
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const matcap = createPawnMatcapTexture();

  const stage = new Group();
  scene.add(stage);

  let mixer: AnimationMixer | null = null;
  let dollRoot: Group | null = null;
  let disposed = false;
  let current: CharDollAppearance | null = null;
  // Frustum framing: tuned default for the pack rig, overridden by a live
  // measure of the ANIMATED skeleton + posed attachments (dollFraming.ts).
  let dollFrame: DollFrame = DEFAULT_DOLL_FRAME;

  const equipmentAttachments: Object3D[] = [];
  let equipmentMaterialGeneration = 0;
  let currentHairMaterialId: string | null = null;
  let currentWornColors: ReadonlyMap<string, readonly string[]> | null = null;

  const equipmentMaterial = (item: PawnEquipmentItem, source: EquipmentSlotMaterialSource): Material | Material[] => {
    const manifestMat = item.id.startsWith("hair_") && currentHairMaterialId ? currentHairMaterialId : item.mat;
    return resolveEquipmentSlotMaterial(source, item, manifestMat, { kind: "world", matcap }, currentWornColors?.get(item.id) ?? null);
  };

  const refreshEquipmentMaterials = (): void => {
    for (let i = 0; i < equipmentAttachments.length; i += 1) {
      const attachment = equipmentAttachments[i]!;
      if (!(attachment instanceof Mesh)) continue;
      const pieceId = typeof attachment.userData.successorEquipmentItemId === "string"
        ? attachment.userData.successorEquipmentItemId
        : null;
      if (!pieceId) continue;
      const item = loaded.equipment.items.find((candidate) => candidate.id === pieceId);
      if (!item) continue;
      attachment.material = equipmentMaterial(item, equipmentSourceMaterialFromUserData(attachment));
    }
  };

  // Read-only render readiness for headed proof capture — not gameplay truth.
  // Absent/false until one frame paints a non-null dollRoot after rebuild.
  const clearRenderReady = (): void => {
    pendingRenderReady = false;
    host.removeAttribute("data-chardoll-ready");
  };
  const markRenderReady = (): void => {
    host.setAttribute("data-chardoll-ready", "true");
  };
  let pendingRenderReady = false;
  clearRenderReady();

  const rebuild = (appearance: CharDollAppearance): void => {
    if (disposed) return;
    // New appearance work invalidates any prior painted frame immediately.
    clearRenderReady();
    equipmentMaterialGeneration += 1;
    equipmentAttachments.length = 0;
    currentHairMaterialId = appearance.hairMat;
    currentWornColors = appearance.worn && appearance.worn.length > 0
      ? new Map(appearance.worn.map((piece) => [piece.item, piece.colors] as const))
      : null;
    if (dollRoot) {
      stage.remove(dollRoot);
      // NOTE: cloned bodies share pack geometry (SkeletonUtils clone) — never
      // dispose geometries here or the next doll/world boot gets husks.
      dollRoot = null;
      mixer = null;
    }
    // Worn gear: same equipment attach/material resolver as in-world pawns.
    // Appearance hair is independent from inventory headwear.
    const equipmentIds: string[] = [];
    for (const id of appearance.equipmentIds ?? []) {
      if (!equipmentIds.includes(id)) equipmentIds.push(id);
    }
    for (const piece of appearance.worn ?? []) {
      if (!equipmentIds.includes(piece.item)) equipmentIds.push(piece.item);
    }
    const attachIds = appearance.hair && !equipmentIds.includes(appearance.hair)
      ? [...equipmentIds, appearance.hair]
      : equipmentIds;
    const body = clonePawnBody(loaded, appearance.body ?? "male");
    const bodyZoneMeshes = collectPawnBodyZoneMeshes(body);
    // Skin tint: matcap body material in the character's tone (the same
    // material class the world renderer uses — flat, PS2-friendly).
    const skin = new MeshMatcapMaterial({ matcap, color: new Color(appearance.skinTone) });
    body.traverse((object) => {
      if (object instanceof SkinnedMesh) object.material = skin;
    });
    const attachedItemIds = attachPawnEquipmentSet(
      loaded,
      body,
      attachIds,
      equipmentMaterial,
      equipmentAttachments,
    );
    applyPawnBodyZoneMask(
      bodyZoneMeshes,
      resolvePawnBodyZoneMask(loaded.equipment, attachedItemIds),
    );
    attachPawnFaceDecal(body, dollFaceToWire(appearance.face ?? null), equipmentAttachments);
    const materialGeneration = equipmentMaterialGeneration;
    void getEquipmentMaterialSets().then(() => {
      if (disposed || materialGeneration !== equipmentMaterialGeneration || dollRoot !== body) return;
      refreshEquipmentMaterials();
    });
    // Idle breathing straight off the pack clip — no animator stack needed.
    const idle = loaded.clips.get("idle");
    if (idle) {
      mixer = new AnimationMixer(body);
      mixer.clipAction(idle).play();
    }
    dollRoot = body;
    stage.add(body);
    // Arm readiness only once dollRoot exists; frame marks after the next render.
    pendingRenderReady = true;
    // Frame from the ANIMATED skeleton, not geometry bounds: Box3 sees the
    // bind pose (origin at feet, 0..1.8), but the idle clip's hip track
    // translates the rendered pawn well below it. Bone world positions after
    // an update(0) follow the pose the player actually sees (owner report
    // 2026-07-06: legs cropped, doll sitting low).
    mixer?.update(0);
    body.updateMatrixWorld(true);
    let boneMinY = Number.POSITIVE_INFINITY;
    let boneMaxY = Number.NEGATIVE_INFINITY;
    let boneMaxAbsX = 0;
    const boneWorld = new Vector3();
    body.traverse((object) => {
      if (object instanceof SkinnedMesh) {
        for (const bone of object.skeleton.bones) {
          bone.getWorldPosition(boneWorld);
          if (boneWorld.y < boneMinY) boneMinY = boneWorld.y;
          if (boneWorld.y > boneMaxY) boneMaxY = boneWorld.y;
          const absX = Math.abs(boneWorld.x);
          if (absX > boneMaxAbsX) boneMaxAbsX = absX;
        }
      }
    });
    const bones: DollSpan | null = Number.isFinite(boneMinY) && Number.isFinite(boneMaxY)
      ? { minY: boneMinY, maxY: boneMaxY, maxAbsX: boneMaxAbsX }
      : null;
    // Attachments (hair crests, caps, skinned footwear) extend the frame past
    // the bone pads. Rigid shells use live matrixWorld AABBs; skinned boots
    // are posed vertex-by-vertex so the sole the player sees is framed.
    const attachments: DollSpan | null = measureEquipmentAttachmentSpan(equipmentAttachments);
    dollFrame = computeDollFrame(bones, attachments);
    resize();
  };

  const resize = (): void => {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    const band = dollOrthoFrustum(dollFrame, width / height);
    camera.left = band.left;
    camera.right = band.right;
    camera.top = band.top;
    camera.bottom = band.bottom;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  // Camera MUST sit at y=0: ortho top/bottom are camera-LOCAL, and resize()
  // computes them as world-space Y (band = dollFrame.centerY ± height/2).
  // Any camera height silently shifts the whole band up by that amount.
  camera.position.set(0, 0, 4.2);
  camera.lookAt(0, 0, 0);
  // Face the camera square-on — no autorotate (owner call 2026-07-06). The
  // pack rig's native forward already looks down +Z at the camera. The
  // shared turntable vocabulary still applies: click-hold-spin + wheel zoom
  // (owner spec 2026-07-08), so the doll only turns when the hand turns it.
  stage.rotation.y = 0;
  const detachTurntable = attachTurntableInteraction(host, {
    targetAt: () => ({
      getYaw: () => stage.rotation.y,
      setYaw: (yaw: number) => {
        stage.rotation.y = yaw;
      },
      getZoom: () => camera.zoom,
      setZoom: (zoom: number) => {
        camera.zoom = clampTurntableZoom(zoom);
        camera.updateProjectionMatrix();
      },
    }),
  });

  let rafId = 0;
  let lastMs = performance.now();
  const frame = (): void => {
    if (disposed) return;
    rafId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastMs) / 1000);
    lastMs = now;
    mixer?.update(dt);
    renderer.render(scene, camera);
    // First painted frame after rebuild with a live dollRoot is the ready edge.
    if (pendingRenderReady && dollRoot) {
      pendingRenderReady = false;
      markRenderReady();
    }
  };
  rafId = requestAnimationFrame(frame);

  const appearanceSignature = (appearance: CharDollAppearance): string => {
    const equipmentKey = (appearance.equipmentIds ?? []).join(",");
    const wornKey = (appearance.worn ?? []).map((piece) => `${piece.item}:${piece.colors.join("+")}`).join(",");
    const faceKey = faceSignature(dollFaceToWire(appearance.face ?? null));
    return `${appearance.body ?? "male"}|${appearance.skinTone}|${appearance.hair ?? ""}|${appearance.hairMat}|${equipmentKey}|${wornKey}|${faceKey}`;
  };

  return {
    setAppearance(appearance: CharDollAppearance) {
      const key = appearanceSignature(appearance);
      if (current && key === appearanceSignature(current)) return;
      current = {
        ...appearance,
        equipmentIds: appearance.equipmentIds ? [...appearance.equipmentIds] : undefined,
        worn: appearance.worn ? appearance.worn.map((piece) => ({ item: piece.item, colors: [...piece.colors] })) : undefined,
        face: appearance.face ? { ...appearance.face } : appearance.face,
      };
      rebuild(current);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      detachTurntable();
      observer.disconnect();
      clearRenderReady();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
