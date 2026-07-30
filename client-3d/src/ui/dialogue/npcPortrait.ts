import { WebGLRenderer } from "three";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { getEquipmentMaterialSets } from "../../assets/equipmentMaterials";
import { loadPawnPack, type PawnPack } from "../../assets/pawnPack";
import type { RenderActor } from "../../render/pawns";
import { ActorPreviewRenderer, resolveActorPreviewLook } from "../inventory/actorPreview";
import { attachTurntableInteraction } from "../turntableInteraction";

/**
 * NPC portrait — cached pawn bust that PROMOTES to a live mini-turntable.
 *
 * Owner note (Main, design ack): the portrait must never hitch a transient
 * window open. So opening stays ONE-SHOT: the pawn is rendered once per
 * appearance into a 2D canvas (head/shoulder crop of the shared actor-preview
 * framing) and cached for the session. The cache keys on the actor-preview
 * LOOK SIGNATURE, so a weapon/hair/gear change re-renders instead of serving
 * a stale bust (earlier sandbox design semantics: always the last-known appearance).
 *
 * Interaction (Main ruling 2026-07-08): the first pointerdown promotes the
 * bust to a LIVE mini-turntable — same renderer, same framing, drag-to-spin
 * via the shared turntable vocabulary — so the GL cost lands only on intent.
 * Zoom is deliberately absent here: ortho zoom recenters the full figure and
 * pushes the face out of the bust crop; a 104px bust has nothing to gain.
 *
 * While the pack/materials load — or if they fail — the host keeps the styled
 * nameplate fallback (`data-portrait="pending|missing"`).
 *
 * Blits happen synchronously after render() in the same task, which is the
 * sanctioned way around the no-preserveDrawingBuffer blank-read trap.
 */

/** Bust framing: crop of the authored full-figure preview (head near top). */
const PORTRAIT_CSS_WIDTH = 104;
const PORTRAIT_CSS_HEIGHT = 122;
/** Fraction of the full-figure render height kept, measured from the top. */
const BUST_HEIGHT_FRACTION = 0.42;
/** Fraction of the full-figure render width kept, centered. */
const BUST_WIDTH_FRACTION = 0.64;
/** Portrait yaw: a 3/4 turn off the rig's authored front (yaw 0). The
 *  straight-on bust was ambiguous on faceless pawns (a symmetric hair dome
 *  over a flat skin block reads as a nape); the quarter turn puts a chin/jaw
 *  silhouette on screen — the classic portrait read (fe-polish §1.22). */
const PORTRAIT_YAW = -0.45;

let packPromise: Promise<PawnPack> | null = null;
let loadedPack: PawnPack | null = null;
let oneShotRenderer: WebGLRenderer | null = null;
let previewRenderer: ActorPreviewRenderer | null = null;

interface PortraitCacheEntry {
  signature: string;
  canvas: HTMLCanvasElement;
}

const portraitCache = new Map<string, PortraitCacheEntry>();

function bustSourceSize(): { width: number; height: number; dpr: number } {
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  // Render the FULL figure large enough that the bust crop still lands at
  // native portrait resolution.
  const height = Math.round((PORTRAIT_CSS_HEIGHT * dpr) / BUST_HEIGHT_FRACTION);
  const width = Math.round((PORTRAIT_CSS_WIDTH * dpr) / BUST_WIDTH_FRACTION);
  return { width, height, dpr };
}

function ensureOneShotRenderer(): WebGLRenderer {
  if (!oneShotRenderer) {
    oneShotRenderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
    oneShotRenderer.setClearColor(0x000000, 0);
  }
  return oneShotRenderer;
}

function createBustCanvas(dpr: number): { canvas: HTMLCanvasElement; ctx2d: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(PORTRAIT_CSS_WIDTH * dpr);
  canvas.height = Math.round(PORTRAIT_CSS_HEIGHT * dpr);
  canvas.style.width = `${PORTRAIT_CSS_WIDTH}px`;
  canvas.style.height = `${PORTRAIT_CSS_HEIGHT}px`;
  canvas.className = "scv-portrait-canvas";
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) throw new Error("npc portrait: 2d context unavailable");
  return { canvas, ctx2d };
}

/** Same-task GL→2D blit of the bust crop (valid until the browser composites). */
function blitBustCrop(ctx2d: CanvasRenderingContext2D, gl: WebGLRenderer, sourceWidth: number, sourceHeight: number): void {
  const cropWidth = Math.round(sourceWidth * BUST_WIDTH_FRACTION);
  const cropX = Math.round((sourceWidth - cropWidth) / 2);
  const cropHeight = Math.round(sourceHeight * BUST_HEIGHT_FRACTION);
  const out = ctx2d.canvas;
  ctx2d.clearRect(0, 0, out.width, out.height);
  ctx2d.drawImage(gl.domElement, cropX, 0, cropWidth, cropHeight, 0, 0, out.width, out.height);
}

async function renderPortraitCanvas(
  actorId: string,
  actor: RenderActor,
  state: PlayState,
  slice: SliceSnapshot,
): Promise<PortraitCacheEntry> {
  packPromise ??= loadPawnPack();
  const [pack] = await Promise.all([packPromise, getEquipmentMaterialSets()]);
  loadedPack = pack;
  const { width, height, dpr } = bustSourceSize();
  const gl = ensureOneShotRenderer();
  gl.setSize(width, height, false);
  previewRenderer ??= new ActorPreviewRenderer(pack);
  // Canonical pose for the CACHED bust: the shared preview renderer may have
  // been spun/zoomed elsewhere — reset before the one-shot render.
  previewRenderer.setYaw(PORTRAIT_YAW);
  previewRenderer.setZoom(1);
  // Two settle frames: the first applies the idle clip pose, the second is
  // the one we crop (mixer state is deterministic — still a one-shot cost).
  const vm = { open: true, actorId, actor, state, slice };
  previewRenderer.render(gl, vm, 1 / 30, 0, width, height);
  previewRenderer.render(gl, vm, 1 / 30, 33, width, height);

  const { canvas, ctx2d } = createBustCanvas(dpr);
  blitBustCrop(ctx2d, gl, width, height);
  return { signature: resolveActorPreviewLook(pack, actorId, actor, state, slice).signature, canvas };
}

export interface NpcPortraitHandle {
  dispose(): void;
}

interface LiveTurntable {
  renderer: ActorPreviewRenderer;
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D;
  rafId: number;
  lastMs: number;
}

function resolvePortraitActor(state: PlayState, slice: SliceSnapshot, actorId: string): RenderActor | null {
  return state.serverAuthority.actors[actorId]
    ?? slice.actors.find((candidate) => candidate.id === actorId)
    ?? null;
}

/**
 * Mount the cached bust for `actorId` into `host`. Missing render inputs keep
 * the fallback state; a late successful render swaps in without reflowing
 * (host box is fixed by CSS).
 */
export function mountNpcPortrait(
  host: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
  actorId: string,
): NpcPortraitHandle {
  let disposed = false;
  let staticCanvas: HTMLCanvasElement | null = null;
  let live: LiveTurntable | null = null;
  let detachInteraction: (() => void) | null = null;

  const actor = resolvePortraitActor(state, slice, actorId);
  if (!actor) {
    host.dataset.portrait = "missing";
    return { dispose(): void { disposed = true; } };
  }

  /** First pointerdown promotes the cached bust to a live mini-turntable. */
  const promoteLive = (): LiveTurntable | null => {
    if (live || disposed) return live;
    if (!loadedPack) return null;
    const { width, height, dpr } = bustSourceSize();
    const { canvas, ctx2d } = createBustCanvas(dpr);
    const renderer = new ActorPreviewRenderer(loadedPack);
    // Continuity: the live turntable takes over at the cached bust's angle.
    renderer.setYaw(PORTRAIT_YAW);
    const gl = ensureOneShotRenderer();
    const promoted: LiveTurntable = { renderer, canvas, ctx2d, rafId: 0, lastMs: performance.now() };
    const frame = (now: number): void => {
      if (disposed || live !== promoted) return;
      promoted.rafId = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - promoted.lastMs) / 1000);
      promoted.lastMs = now;
      const liveActor = resolvePortraitActor(state, slice, actorId) ?? actor;
      gl.setSize(width, height, false);
      renderer.render(gl, { open: true, actorId, actor: liveActor, state, slice }, dt, now, width, height);
      blitBustCrop(ctx2d, gl, width, height);
    };
    staticCanvas?.remove();
    host.appendChild(canvas);
    live = promoted;
    promoted.rafId = requestAnimationFrame(frame);
    return promoted;
  };

  const installInteraction = (): void => {
    if (detachInteraction || disposed) return;
    detachInteraction = attachTurntableInteraction(host, {
      // Zoom lane intentionally absent (bust crop — see module doc).
      targetAt: () => {
        const promoted = promoteLive();
        if (!promoted) return null;
        return {
          getYaw: () => promoted.renderer.getYaw(),
          setYaw: (yaw: number) => promoted.renderer.setYaw(yaw),
        };
      },
    });
  };

  const adoptCanvas = (canvas: HTMLCanvasElement): void => {
    staticCanvas = canvas;
    host.dataset.portrait = "ready";
    host.appendChild(canvas);
    installInteraction();
  };

  const cached = portraitCache.get(actorId);
  const currentSignature = loadedPack
    ? resolveActorPreviewLook(loadedPack, actorId, actor, state, slice).signature
    : null;
  if (cached && currentSignature !== null && cached.signature === currentSignature) {
    adoptCanvas(cached.canvas);
  } else {
    host.dataset.portrait = "pending";
    void renderPortraitCanvas(actorId, actor, state, slice).then(
      (entry) => {
        portraitCache.set(actorId, entry);
        if (disposed) return;
        adoptCanvas(entry.canvas);
      },
      () => {
        // Pack/materials unavailable (headless boot, cold cache) — the styled
        // nameplate fallback IS the portrait; nothing else to do.
        if (!disposed) host.dataset.portrait = "missing";
      },
    );
  }

  return {
    dispose(): void {
      disposed = true;
      detachInteraction?.();
      detachInteraction = null;
      if (live) {
        cancelAnimationFrame(live.rafId);
        live.renderer.dispose();
        live.canvas.remove();
        live = null;
      }
      if (staticCanvas?.parentElement === host) staticCanvas.remove();
      staticCanvas = null;
    },
  };
}
