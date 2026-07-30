import {
  AmbientLight,
  DirectionalLight,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
  type WebGLRendererParameters,
} from "three";
import { loadPawnPack, type PawnPack } from "../../assets/pawnPack";
import { getUiThemeColors, subscribeUiTheme } from "../uiTheme";
import { ActorPreviewRenderer, type ActorPreviewRenderVM } from "./actorPreview";
import { PaperDollRenderer } from "./paperDoll";
import { containerSpecFor } from "./containers";
import {
  keyPhase,
  SLOT_TURN_RADIANS_PER_SECOND,
  slotVisualRotation,
  SlotVisualKit,
  type SlotRotationEuler,
} from "./slotVisuals";
import {
  SLOT_CAMERA_HALF_HEIGHT,
  type SlotCameraBounds,
  writeSlotCameraBoundsForAspect,
} from "./previewCamera";
import type { InventoryItemVM, InventoryLayoutRects, InventoryViewModel } from "./types";
import { attachTurntableInteraction, clampTurntableZoom, type TurntableTarget } from "../turntableInteraction";

const rendererOptions: WebGLRendererParameters = {
  alpha: true,
  antialias: true,
  powerPreference: "high-performance",
};

export interface InventoryModelRendererOptions {
  readonly pack?: PawnPack;
  readonly state?: unknown;
  /** Load + render the OPERATIVE paper doll (default true). Grids that never
   * show a doll (examine, datapad) skip the pawn-pack load entirely. */
  readonly paperDoll?: boolean;
  /** Load + render a dedicated actor mannequin preview into the whole host. */
  readonly actorPreview?: boolean;
  /** Specific DOM host that starts paper-doll yaw drags; the canvas remains pointer-events:none. */
  readonly paperDollDragHost?: HTMLElement | null;
  /** Specific single-slot viewport host that starts item-examine yaw drags. */
  readonly slotDragHost?: HTMLElement | null;
  /** Specific actor-preview viewport host; defaults to the renderer host. */
  readonly actorPreviewDragHost?: HTMLElement | null;
}

interface SlotVisual {
  key: string;
  assetKey: string;
  root: Object3D;
  phase: number;
}

const DEFAULT_SLOT_ZOOM = 1;

/**
 * Inventory turntable renderer — one transparent canvas, many viewports.
 * Paints rotating normalized GLB item visuals into each slot's published
 * device-pixel rect with scissored viewports, plus the OPERATIVE paper doll
 * into the doll rect. The canvas is created eagerly (cheap); the GL context
 * is LAZY — created on the first visible render so a closed window costs zero
 * GPU contexts (a second eager WebGL context at boot stalls software-GL
 * environments).
 */
export class InventoryModelRenderer {
  readonly canvas = document.createElement("canvas");

  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.05, 16);
  private unsubscribeTheme: () => void = () => {};
  private readonly kit = new SlotVisualKit();
  private paperDoll: PaperDollRenderer | null = null;
  private actorPreview: ActorPreviewRenderer | null = null;
  private readonly slotVisuals = new Map<string, SlotVisual>();
  private readonly staleSlotKeys: string[] = [];
  private readonly liveKeysScratch = new Set<string>();
  private readonly detachInteractions: Array<() => void> = [];
  /** Per-slot drag freeze: present = a drag holds this slot's yaw. */
  private readonly slotDragYaw = new Map<string, number>();
  /** Per-slot wheel zoom (only wells with a slot drag host ever write it). */
  private readonly slotZoom = new Map<string, number>();
  private layoutRects: InventoryLayoutRects | null = null;
  private width = 1;
  private height = 1;
  private devicePixelRatio = 1;
  private visible = false;
  private contextLost = false;
  private lastSlotAspect = 0;
  private lastSlotZoom = DEFAULT_SLOT_ZOOM;
  private readonly slotCameraBoundsScratch: SlotCameraBounds = {
    left: -SLOT_CAMERA_HALF_HEIGHT,
    right: SLOT_CAMERA_HALF_HEIGHT,
    top: SLOT_CAMERA_HALF_HEIGHT,
    bottom: -SLOT_CAMERA_HALF_HEIGHT,
  };
  private disposed = false;
  private lastRenderTimeMs = 0;

  private constructor(
    private readonly host: HTMLElement,
    pack: PawnPack | null,
    wantPaperDoll: boolean,
    wantActorPreview: boolean,
    paperDollDragHost: HTMLElement | null,
    slotDragHost: HTMLElement | null,
    actorPreviewDragHost: HTMLElement | null,
  ) {
    if (pack && wantPaperDoll) {
      this.paperDoll = new PaperDollRenderer(pack);
      this.applyPaperDollTheme(this.paperDoll);
    }
    if (pack && wantActorPreview) {
      this.actorPreview = new ActorPreviewRenderer(pack);
    }
    // canvas is a plain element until ensureRenderer() attaches the GL context.
    this.canvas.className = "successor3d-inventory-model-canvas";
    this.canvas.style.position = "absolute";
    this.canvas.style.inset = "0";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "none";
    this.canvas.style.pointerEvents = "none";
    this.canvas.style.zIndex = "3";

    const hostPosition = window.getComputedStyle(host).position;
    if (hostPosition === "static") host.style.position = "relative";
    host.appendChild(this.canvas);
    // Shared turntable vocabulary (drag-spin + wheel-zoom) per viewport lane.
    // Hit tests run in CANVAS device-pixel space: hosts can be distinct
    // elements from the canvas host (dollWell vs canvasLayer), so each
    // targetAt converts its host-local point before rect lookups.
    if (wantPaperDoll) {
      this.installTurntableHost(paperDollDragHost ?? host, (canvasX, canvasY) => {
        const rect = this.layoutRects?.doll;
        if (rect && !rectContains(rect, canvasX, canvasY)) return null;
        return this.paperDoll;
      });
    }
    if (slotDragHost) {
      this.installTurntableHost(slotDragHost, (canvasX, canvasY) => {
        const slotKey = this.slotKeyAt(canvasX, canvasY) ?? this.soleSlotKey();
        return slotKey ? this.slotTurntableTarget(slotKey) : null;
      });
    }
    if (wantActorPreview) {
      this.installTurntableHost(actorPreviewDragHost ?? host, () => this.actorPreview);
    }
    this.unsubscribeTheme = subscribeUiTheme(() => {
      if (this.paperDoll) this.applyPaperDollTheme(this.paperDoll);
    });

    this.scene.add(new AmbientLight("#d8c392", 0.72));
    const key = new DirectionalLight("#ffddb0", 2.1);
    key.position.set(-2.4, 3.6, 3.2);
    this.scene.add(key);
    this.camera.position.set(0, 0.42, 3.4);
    this.camera.lookAt(0, 0, 0);
    this.canvas.addEventListener("webglcontextlost", this.onContextLost);
    this.canvas.addEventListener("webglcontextrestored", this.onContextRestored);

    if (!pack && (wantPaperDoll || wantActorPreview)) {
      void loadPawnPack().then(
        (loadedPack) => {
          if (!this.disposed) {
            if (wantPaperDoll) {
              const paperDoll = new PaperDollRenderer(loadedPack);
              this.applyPaperDollTheme(paperDoll);
              this.paperDoll = paperDoll;
            }
            if (wantActorPreview) this.actorPreview = new ActorPreviewRenderer(loadedPack);
          }
        },
        (error: unknown) => {
          console.warn("inventory actor/paper doll pawn pack failed", error);
        },
      );
    }
  }

  static create(host: HTMLElement, options: InventoryModelRendererOptions = {}): InventoryModelRenderer {
    return new InventoryModelRenderer(
      host,
      options.pack ?? null,
      options.paperDoll !== false,
      options.actorPreview === true,
      options.paperDollDragHost ?? null,
      options.slotDragHost ?? null,
      options.actorPreviewDragHost ?? null,
    );
  }

  setLayoutRects(rects: InventoryLayoutRects | null): void {
    this.layoutRects = rects;
  }

  /** Actual mesh attachments on the live inventory paper doll. */
  paperDollAttachedEquipmentIds(): string[] {
    return this.paperDoll?.attachedEquipmentIds() ?? [];
  }

  /** Headed-proof seam: null until this slot owns a 3D asset visual. */
  slotModelAssetKey(slotKey: string): string | null {
    return this.slotVisuals.get(slotKey)?.assetKey ?? null;
  }

  /** Lazily attach the GL context to the eager canvas on first open render. */
  private ensureRenderer(): WebGLRenderer {
    if (this.renderer) return this.renderer;
    this.renderer = new WebGLRenderer({ ...rendererOptions, canvas: this.canvas });
    this.renderer.setPixelRatio(1);
    this.renderer.setClearAlpha(0);
    this.renderer.autoClear = false;
    return this.renderer;
  }

  render(viewModel: InventoryViewModel, dtSeconds: number, timeMs: number): void {
    this.lastRenderTimeMs = timeMs;
    if (!viewModel.open || !this.layoutRects || this.contextLost) {
      this.hideAndIdle();
      return;
    }
    this.showAndResize();
    this.reconcileSlotVisuals(viewModel.items);

    const renderer = this.ensureRenderer();
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.width, this.height);
    renderer.clear(true, true, true);
    renderer.setScissorTest(true);

    this.paperDoll?.render(renderer, this.layoutRects.doll, viewModel.doll, dtSeconds, this.height);

    const gridClip = this.layoutRects.gridClip;
    for (let i = 0; i < viewModel.items.length; i += 1) {
      const item = viewModel.items[i]!;
      const rect = this.layoutRects.slots.get(item.key);
      if (!rect || rect.width < 2 || rect.height < 2) continue;
      // Rows scrolled fully out of the grid viewport draw nothing — without
      // this they'd paint over the window chrome (DEF-13b).
      if (gridClip && (rect.bottom <= gridClip.top || rect.top >= gridClip.bottom)) continue;
      const visual = this.ensureSlotVisual(item);
      if (visual) this.renderSlot(visual, rect, timeMs, gridClip);
    }
    renderer.setScissorTest(false);
  }

  renderActorPreview(viewModel: ActorPreviewRenderVM, dtSeconds: number, timeMs: number): void {
    this.lastRenderTimeMs = timeMs;
    if (!viewModel.open || !viewModel.actorId || !viewModel.actor || this.contextLost) {
      this.hideAndIdle();
      return;
    }
    this.showAndResize();
    const renderer = this.ensureRenderer();
    renderer.setRenderTarget(null);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.width, this.height);
    renderer.clear(true, true, true);
    this.actorPreview?.render(renderer, viewModel, dtSeconds, timeMs, this.width, this.height);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeTheme();
    for (const detach of this.detachInteractions) detach();
    this.detachInteractions.length = 0;
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);

    for (const visual of this.slotVisuals.values()) this.scene.remove(visual.root);
    this.slotVisuals.clear();
    this.kit.dispose();
    this.paperDoll?.dispose();
    this.actorPreview?.dispose();
    this.renderer?.dispose();
    this.canvas.remove();
  }
  private ensureSlotVisual(item: InventoryItemVM): SlotVisual | null {
    // Standardized resource/ammo containers outrank any direct GLB mapping.
    const spec = containerSpecFor(item);
    if (spec) {
      const assetKey = `container:${spec.shape}|${spec.plateColor}|${spec.bodyColor}|${spec.lineGlyph}`;
      return this.ensureVisual(item.key, assetKey, () => {
        const root = this.kit.createContainerRoot(spec);
        root.name = `inventory-slot-container:${item.key}`;
        return root;
      });
    }
    if (!item.glb) {
      this.removeSlotVisual(item.key);
      return null;
    }
    const asset = this.kit.modelAsset(item.glb);
    if (!asset.source || asset.error) {
      this.removeSlotVisual(item.key);
      return null;
    }
    const source = asset.source;
    // Inventory/equip identity and turntable material provenance are separate:
    // item 1004 equips the armor harness, but its authored GLB is a shield
    // generator prop and must retain prop materials rather than harness paint.
    const materialEquipmentId = item.glb.startsWith("/assets/pawn-pack/equipment/")
      ? item.equipmentId
      : null;
    const assetKey = `model:${item.glb}:${materialEquipmentId ?? "-"}`;
    return this.ensureVisual(item.key, assetKey, () => {
      const root = this.kit.createModelRoot(
        source,
        materialEquipmentId,
        (candidate) => this.slotVisuals.get(item.key)?.root === candidate,
      );
      root.name = `inventory-slot-model:${item.key}`;
      return root;
    });
  }

  private ensureVisual(key: string, assetKey: string, create: () => Object3D): SlotVisual {
    const existing = this.slotVisuals.get(key);
    if (existing && existing.assetKey === assetKey) return existing;
    this.removeSlotVisual(key);
    const root = create();
    root.visible = false;
    this.scene.add(root);
    const visual: SlotVisual = { key, assetKey, root, phase: keyPhase(key) };
    this.slotVisuals.set(key, visual);
    return visual;
  }

  private removeSlotVisual(key: string): void {
    const existing = this.slotVisuals.get(key);
    if (!existing) return;
    this.scene.remove(existing.root);
    this.slotVisuals.delete(key);
    this.slotDragYaw.delete(key);
    this.slotZoom.delete(key);
  }


  private readonly slotRotationScratch: SlotRotationEuler = { x: 0, y: 0, z: 0 };

  private renderSlot(visual: SlotVisual, rect: DOMRectReadOnly, timeMs: number, clip: DOMRectReadOnly | null): void {
    this.updateSlotCamera(rect.width / rect.height, this.slotZoom.get(visual.key) ?? DEFAULT_SLOT_ZOOM);
    // All slot roots are true 3D models or procedural containers: auto-turn,
    // tilt, and freeze their yaw at the hand during a live drag.
    const rotation = slotVisualRotation(
      visual.assetKey,
      visual.phase,
      timeMs,
      this.slotDragYaw.get(visual.key),
      this.slotRotationScratch,
    );
    visual.root.rotation.set(rotation.x, rotation.y, rotation.z);
    visual.root.visible = true;

    // Viewport = the full slot rect (model framing/aspect never squishes);
    // scissor = the rect clipped to the grid viewport, so edge rows CROP as
    // they scroll past instead of overpainting the chrome (DEF-13b).
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(this.height - rect.y - rect.height));
    const width = Math.max(1, Math.min(this.width - x, Math.floor(rect.width)));
    const height = Math.max(1, Math.min(this.height - y, Math.floor(rect.height)));
    const clipTop = clip ? Math.max(rect.top, clip.top) : rect.top;
    const clipBottom = clip ? Math.min(rect.bottom, clip.bottom) : rect.bottom;
    const scissorHeight = Math.max(0, Math.floor(clipBottom - clipTop));
    if (scissorHeight < 1) {
      visual.root.visible = false;
      return;
    }
    const scissorY = Math.max(0, Math.floor(this.height - clipTop - (clipBottom - clipTop)));
    const renderer = this.ensureRenderer();
    renderer.setViewport(x, y, width, height);
    renderer.setScissor(x, Math.max(0, scissorY), width, Math.min(this.height, scissorHeight));
    renderer.render(this.scene, this.camera);
    visual.root.visible = false;
  }

  private updateSlotCamera(aspect: number, zoom: number): void {
    const viewportAspect = Math.max(1e-4, aspect);
    if (Math.abs(viewportAspect - this.lastSlotAspect) < 1e-4 && zoom === this.lastSlotZoom) return;
    this.lastSlotAspect = viewportAspect;
    this.lastSlotZoom = zoom;
    const bounds = writeSlotCameraBoundsForAspect(viewportAspect, this.slotCameraBoundsScratch);
    this.camera.left = bounds.left;
    this.camera.right = bounds.right;
    this.camera.top = bounds.top;
    this.camera.bottom = bounds.bottom;
    this.camera.zoom = zoom;
    this.camera.updateProjectionMatrix();
  }

  private applyPaperDollTheme(paperDoll: PaperDollRenderer): void {
    const colors = getUiThemeColors();
    paperDoll.setTheme({
      accent: colors.accent.css,
      accentSoft: colors.accentSoft.css,
    });
  }

  /** Attach the shared turntable vocabulary to a drag host, converting
   * host-local CSS points into canvas device-pixel space for hit tests. */
  private installTurntableHost(
    dragHost: HTMLElement,
    targetAtCanvasPoint: (canvasX: number, canvasY: number) => TurntableTarget | null,
  ): void {
    this.detachInteractions.push(attachTurntableInteraction(dragHost, {
      targetAt: (localX, localY) => {
        if (!this.visible) return null;
        const dragRect = dragHost.getBoundingClientRect();
        const hostRect = this.host.getBoundingClientRect();
        const canvasX = (dragRect.left + localX - hostRect.left) * this.devicePixelRatio;
        const canvasY = (dragRect.top + localY - hostRect.top) * this.devicePixelRatio;
        return targetAtCanvasPoint(canvasX, canvasY);
      },
    }));
  }

  /** One drag/zoom target per slot key — yaw freeze + zoom live in maps the
   * visual reconciler prunes alongside the visuals themselves. */
  private slotTurntableTarget(slotKey: string): TurntableTarget | null {
    if (!this.slotVisuals.has(slotKey)) return null;
    return {
      getYaw: () => {
        const visual = this.slotVisuals.get(slotKey);
        return this.slotDragYaw.get(slotKey)
          ?? (visual ? visual.phase + this.lastRenderTimeMs * 0.001 * SLOT_TURN_RADIANS_PER_SECOND : 0);
      },
      setYaw: (yaw) => {
        if (this.slotVisuals.has(slotKey)) this.slotDragYaw.set(slotKey, yaw);
      },
      getZoom: () => this.slotZoom.get(slotKey) ?? DEFAULT_SLOT_ZOOM,
      setZoom: (zoom) => {
        if (this.slotVisuals.has(slotKey)) this.slotZoom.set(slotKey, clampTurntableZoom(zoom));
      },
      onDragStart: () => {
        const visual = this.slotVisuals.get(slotKey);
        if (visual && !this.slotDragYaw.has(slotKey)) {
          this.slotDragYaw.set(slotKey, visual.phase + this.lastRenderTimeMs * 0.001 * SLOT_TURN_RADIANS_PER_SECOND);
        }
      },
      onDragEnd: () => {
        const visual = this.slotVisuals.get(slotKey);
        const heldYaw = this.slotDragYaw.get(slotKey);
        if (visual && heldYaw !== undefined) {
          visual.phase = heldYaw - this.lastRenderTimeMs * 0.001 * SLOT_TURN_RADIANS_PER_SECOND;
        }
        this.slotDragYaw.delete(slotKey);
      },
    };
  }

  private slotKeyAt(canvasX: number, canvasY: number): string | null {
    const slots = this.layoutRects?.slots;
    if (!slots) return null;
    for (const [key, rect] of slots) {
      if (rectContains(rect, canvasX, canvasY)) return key;
    }
    return null;
  }

  private soleSlotKey(): string | null {
    const slots = this.layoutRects?.slots;
    if (!slots || slots.size !== 1) return null;
    for (const key of slots.keys()) return key;
    return null;
  }


  private reconcileSlotVisuals(items: readonly InventoryItemVM[]): void {
    // No identity fast-path: buildInventoryViewModel mutates ONE reused array
    // in place, so `items` is the same object every frame even when the item
    // set changed. Set-based prune is O(n+m) over ≤ tens of keys — cheaper
    // than letting stale roots pile up in the scene (every scissored slot
    // render traverses the whole scene graph).
    this.liveKeysScratch.clear();
    for (let i = 0; i < items.length; i += 1) this.liveKeysScratch.add(items[i]!.key);
    this.staleSlotKeys.length = 0;
    for (const key of this.slotVisuals.keys()) {
      if (!this.liveKeysScratch.has(key)) this.staleSlotKeys.push(key);
    }
    for (let i = 0; i < this.staleSlotKeys.length; i += 1) {
      this.removeSlotVisual(this.staleSlotKeys[i]!);
    }
  }

  private showAndResize(): void {
    if (!this.visible) {
      this.visible = true;
      this.canvas.style.display = "block";
    }
    const rect = this.host.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const nextWidth = Math.max(1, Math.floor(rect.width * dpr));
    const nextHeight = Math.max(1, Math.floor(rect.height * dpr));
    this.devicePixelRatio = dpr;
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.ensureRenderer().setSize(nextWidth, nextHeight, false);
  }

  private hideAndIdle(): void {
    if (!this.visible) return;
    this.visible = false;
    this.canvas.style.display = "none";
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
  };
}

function rectContains(rect: DOMRectReadOnly, canvasX: number, canvasY: number): boolean {
  return canvasX >= rect.x && canvasX <= rect.x + rect.width && canvasY >= rect.y && canvasY <= rect.y + rect.height;
}
