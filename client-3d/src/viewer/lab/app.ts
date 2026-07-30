// app.ts — Successor Asset Lab shell: pawn-first workbench UI.
//
// UX model: the pawn is ALWAYS on stage (no staging ceremony). Left rail tabs
// WARDROBE / WEAPONS / ANIMS / PROPS drive instant composition changes through
// the runtime resolvers (see stage.ts). Bottom transport owns playback. State
// lives in the URL hash so reloads restore the exact composition.
import { Group, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { equipmentIdsCoverLegs } from "../../assets/pawnPack";
import { getEquipmentMaterialSets } from "../../assets/equipmentMaterials";
import type { PawnEquipmentItem } from "../../assets/pawnRigTypes";
import type { ActiveClipsByLayer } from "../../render/anim/PawnAnimator";
import type { HitStyleId } from "../../render/fx/hits";
import { applyThemeVariables } from "../../ui/theme";
import { initUiTheme } from "../../ui/uiTheme";
import { BEAM_FX_IDS, BOLT_STYLE_IDS, isBeamFxId, isLabFireFxId, type LabFireFxId } from "./fx";
import { loadLabData, type ClipGroup, type LabData, type LabWeaponEntry, type WavePropEntry } from "./packLoader";
import { PostPanel } from "./postPanel";
import {
  BASELINE_METHOD_ID,
  CREASE_METHODS,
  creaseMethodById,
  methodOverrideExists,
  type CreaseMethod,
  type CreaseMethodCtx,
} from "./methods/registry";
import {
  CAMERA_PRESET_ORDER,
  clipUsesGun,
  clipUsesMelee,
  DROID_BODY_KEY,
  LabPawn,
  LabStage,
  prepareWeaponMaterials,
  weaponSelectionFor,
  type CameraPresetName,
  defaultLabFogState,
  type LabBodyKey,
  type LabFogState,
} from "./stage";

export interface AssetLabApp {
  dispose: () => void;
}

declare global {
  interface Window {
    /** Capture-integrity marker: active method id once its pawn is live on stage; null while a rebuild is in flight. */
    __labMethodReady?: string | null;
  }
}

type TabName = "wardrobe" | "weapons" | "anims" | "props";
const TAB_ORDER: readonly TabName[] = ["wardrobe", "weapons", "anims", "props"];
const TAB_LABELS: Record<TabName, string> = {
  wardrobe: "WARDROBE",
  weapons: "WEAPONS",
  anims: "ANIMS",
  props: "PROPS",
};

const BODY_ORDER: readonly LabBodyKey[] = ["male", "female", DROID_BODY_KEY];
const BODY_LABELS: Record<string, string> = {
  male: "MALE",
  female: "FEMALE",
  [DROID_BODY_KEY]: "GR0K DROID",
};

const CAMERA_PRESET_LABELS: Record<CameraPresetName, string> = {
  quarter: "3/4",
  front: "FRONT",
  side: "SIDE",
  close: "CLOSE",
  grip: "GRIP",
};

/** Max rows rendered per list pass — 2,117 props stay snappy without a grid lib. */
const MAX_LIST_ROWS = 400;
const STEP_SECONDS = 1 / 30;

/** Cycle of one-hand swing montages the melee SWING button rotates through. */
const SWING_CYCLE = ["swing_h1", "swing_h2", "swing_h3"] as const;

/**
 * Main's default weapon -> fire-effect mapping (dropdown next to ATTACK
 * overrides per weapon; the pick persists in the URL hash).
 */
const DEFAULT_FIRE_FX: Record<string, LabFireFxId> = {
  slugthrower: "ballistic",
  wpn_pistol: "ballistic",
  wpn_smg: "ballistic",
  wpn_carbine: "plasma",
  lightning_carbine: "arc",
  wpn_assault: "searbeam",
  wpn_shotgun: "ballistic",
  wpn_sniper: "lance",
  wpn_heavy: "pulsebeam",
  wpn_launcher: "magnum",
};

interface FireProfile {
  /** LOOP repeat interval, seconds (beam picks are floored to 0.45s). */
  cadenceS: number;
  /** Bolts per trigger pull (shotgun fan). */
  count: number;
  /** Full fan width for count > 1, radians. */
  spreadRad: number;
  /** Tracer presentation speed, cells/s. */
  speed: number;
  /** Flash/bolt severity. */
  mag: number;
  /** Beam reach, cells. */
  beamDistance: number;
  /** Arrival-read override (launcher's big landing). */
  hitStyle?: HitStyleId;
}

const DEFAULT_FIRE_PROFILE: FireProfile = { cadenceS: 0.38, count: 1, spreadRad: 0, speed: 22, mag: 1, beamDistance: 10 };

const FIRE_PROFILE_BY_CLASS: Record<string, Partial<FireProfile>> = {
  pistol: { cadenceS: 0.42 },
  smg: { cadenceS: 0.11 },
  rifle: { cadenceS: 0.34 },
  shotgun: { cadenceS: 0.95, count: 6, spreadRad: 0.42 },
  launcher: { cadenceS: 1.5, speed: 9, mag: 2.4 },
};

const FIRE_PROFILE_BY_ID: Record<string, Partial<FireProfile>> = {
  /** Bastion LMG: loop reads as a fast burst. */
  wpn_heavy: { cadenceS: 0.09 },
  /** Flare Net: one slow fat bolt, big vertical landing. */
  wpn_launcher: { hitStyle: "geyser" },
};

const BEAM_MIN_CADENCE_S = 0.45;

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function required<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`asset lab: missing ${selector}`);
  return element;
}

/** WARDROBE grouping: the four shelves the owner thinks in. */
function wardrobeShelf(item: PawnEquipmentItem): string {
  if (item.group === "SYNTY TRIALS") return "SYNTY TRIALS";
  if (item.group === "Hair") return "HAIR";
  return item.layer === "Armor" ? "ARMOR" : "UNDER";
}

const WARDROBE_SHELF_ORDER = ["ARMOR", "UNDER", "HAIR", "SYNTY TRIALS"] as const;

export async function startAssetLab(root: HTMLElement): Promise<AssetLabApp> {
  applyThemeVariables();
  initUiTheme();
  root.innerHTML = `
    <main class="lab-shell">
      <div class="lab-canvas" data-ref="host"></div>

      <header class="lab-top">
        <span class="lab-brand">SUCCESSOR · ASSET LAB</span>
        <nav class="lab-bodies" data-ref="bodies" aria-label="Pawn body">
          ${BODY_ORDER.map((body) => `<button type="button" data-body="${body}">${BODY_LABELS[body]}</button>`).join("")}
        </nav>
        <em class="lab-status" data-ref="status">LOADING PACK…</em>
      </header>

      <section class="lab-rail" aria-label="Catalog">
        <nav class="lab-tabs" data-ref="tabs">
          ${TAB_ORDER.map((tab) => `<button type="button" data-tab="${tab}">${TAB_LABELS[tab]}</button>`).join("")}
        </nav>
        <div class="lab-search">
          <input data-ref="search" type="search" autocomplete="off" spellcheck="false" placeholder="search… ( / )" />
        </div>
        <div class="lab-facets" data-ref="facets" hidden></div>
        <div class="lab-list" data-ref="list" role="listbox"></div>
        <footer class="lab-loadout" data-ref="loadout" aria-label="Loadout"></footer>
      </section>

      <aside class="lab-side" aria-label="Stage controls">
        <div class="lab-side-group" data-ref="cams" aria-label="Camera presets">
          ${CAMERA_PRESET_ORDER.map((preset, index) =>
            `<button type="button" data-cam="${preset}" title="${index + 1}">${CAMERA_PRESET_LABELS[preset]}</button>`).join("")}
        </div>
        <div class="lab-side-group">
          <button type="button" data-ref="turntable" title="T">TURN</button>
          <button type="button" data-ref="bones" title="B">BONES</button>
          <button type="button" data-ref="post" title="game post pipeline">POST</button>
          <button type="button" data-ref="refresh" title="reload page + assets">REFRESH</button>
        </div>
      </aside>

      <aside class="lab-post-panel" data-ref="postPanel" aria-label="Post-processing dials">
        <header class="lab-post-head">
          <button type="button" class="lab-post-title" data-ref="postToggle">POST · DIALS</button>
          <button type="button" data-ref="postReset" title="restore every dial's boot default">RESET ALL</button>
          <button type="button" data-ref="postCopy" title="copy current dial values (clipboard + console)">COPY JSON</button>
        </header>
        <div class="lab-post-body" data-ref="postBody"></div>
      </aside>

      <div class="lab-actions" data-ref="actions" hidden></div>

      <footer class="lab-transport">
        <button type="button" class="lab-play" data-ref="play">PAUSE</button>
        <button type="button" data-ref="stepBack" title="−1/30 s">◀</button>
        <div class="lab-scrub">
          <input data-ref="scrub" type="range" min="0" max="1000" value="0" />
          <div class="lab-scrub-events" data-ref="scrubEvents"></div>
        </div>
        <button type="button" data-ref="stepFwd" title="+1/30 s">▶</button>
        <em class="lab-time" data-ref="time">0.00 / 0.00</em>
        <span class="lab-loop" data-ref="loop">LOOP</span>
        <input data-ref="speed" type="range" min="0.05" max="2" step="0.05" value="1" title="playback speed" />
        <em class="lab-speed" data-ref="speedValue">1.00×</em>
        <span class="lab-clipname" data-ref="clipName">idle</span>
        <em class="lab-layers" data-ref="layers">—</em>
      </footer>
    </main>
  `;

  const refs: LabRefs = {
    host: required<HTMLElement>(root, '[data-ref="host"]'),
    bodies: required<HTMLElement>(root, '[data-ref="bodies"]'),
    status: required<HTMLElement>(root, '[data-ref="status"]'),
    tabs: required<HTMLElement>(root, '[data-ref="tabs"]'),
    search: required<HTMLInputElement>(root, '[data-ref="search"]'),
    facets: required<HTMLElement>(root, '[data-ref="facets"]'),
    list: required<HTMLElement>(root, '[data-ref="list"]'),
    loadout: required<HTMLElement>(root, '[data-ref="loadout"]'),
    cams: required<HTMLElement>(root, '[data-ref="cams"]'),
    turntable: required<HTMLButtonElement>(root, '[data-ref="turntable"]'),
    bones: required<HTMLButtonElement>(root, '[data-ref="bones"]'),
    post: required<HTMLButtonElement>(root, '[data-ref="post"]'),
    refresh: required<HTMLButtonElement>(root, '[data-ref="refresh"]'),
    play: required<HTMLButtonElement>(root, '[data-ref="play"]'),
    stepBack: required<HTMLButtonElement>(root, '[data-ref="stepBack"]'),
    stepFwd: required<HTMLButtonElement>(root, '[data-ref="stepFwd"]'),
    scrub: required<HTMLInputElement>(root, '[data-ref="scrub"]'),
    scrubEvents: required<HTMLElement>(root, '[data-ref="scrubEvents"]'),
    time: required<HTMLElement>(root, '[data-ref="time"]'),
    loop: required<HTMLElement>(root, '[data-ref="loop"]'),
    speed: required<HTMLInputElement>(root, '[data-ref="speed"]'),
    speedValue: required<HTMLElement>(root, '[data-ref="speedValue"]'),
    clipName: required<HTMLElement>(root, '[data-ref="clipName"]'),
    layers: required<HTMLElement>(root, '[data-ref="layers"]'),
    actions: required<HTMLElement>(root, '[data-ref="actions"]'),
    postPanel: required<HTMLElement>(root, '[data-ref="postPanel"]'),
    postToggle: required<HTMLButtonElement>(root, '[data-ref="postToggle"]'),
    postReset: required<HTMLButtonElement>(root, '[data-ref="postReset"]'),
    postCopy: required<HTMLButtonElement>(root, '[data-ref="postCopy"]'),
    postBody: required<HTMLElement>(root, '[data-ref="postBody"]'),
  };

  const app = new SuccessorAssetLab(refs);
  await app.init();
  return app;
}

/** DOM handles the lab controller drives (collected once at boot). */
interface LabRefs {
  host: HTMLElement;
  bodies: HTMLElement;
  status: HTMLElement;
  tabs: HTMLElement;
  search: HTMLInputElement;
  facets: HTMLElement;
  list: HTMLElement;
  loadout: HTMLElement;
  cams: HTMLElement;
  turntable: HTMLButtonElement;
  bones: HTMLButtonElement;
  post: HTMLButtonElement;
  refresh: HTMLButtonElement;
  play: HTMLButtonElement;
  stepBack: HTMLButtonElement;
  stepFwd: HTMLButtonElement;
  scrub: HTMLInputElement;
  scrubEvents: HTMLElement;
  time: HTMLElement;
  loop: HTMLElement;
  speed: HTMLInputElement;
  speedValue: HTMLElement;
  clipName: HTMLElement;
  layers: HTMLElement;
  actions: HTMLElement;
  postPanel: HTMLElement;
  postToggle: HTMLButtonElement;
  postReset: HTMLButtonElement;
  postCopy: HTMLButtonElement;
  postBody: HTMLElement;
}

class SuccessorAssetLab implements AssetLabApp {
  private data: LabData | null = null;
  private stage: LabStage | null = null;

  private body: LabBodyKey = "male";
  private tab: TabName = "wardrobe";
  private readonly worn = new Set<string>();
  private resolvedWorn: string[] = [];
  private weaponId: string | null = null;
  private clip = "idle";
  private propId: string | null = null;
  private propPending = false;
  private propCategory = "";
  private speed = 1;
  private scrubbing = false;
  private disposed = false;
  private readonly activeLayers: ActiveClipsByLayer = { base: null, upper: null, hand: null, arm: null, montage: null };

  // ── held-item actions / FX / POST panel state ─────────────────────────────
  private readonly fireFxByWeapon = new Map<string, LabFireFxId>();
  private actionLoop = false;
  private loopClock = 0;
  private swingIndex = 0;
  private postPanel: PostPanel | null = null;
  private panelClock = 0;
  private readonly muzzleScratch = new Vector3();
  private readonly boreScratch = new Vector3();
  private readonly shotDirScratch = new Vector3();
  private readonly tipScratch = new Vector3();
  private readonly rootScratch = new Vector3();
  private fogState: LabFogState = defaultLabFogState();
  private dressingOn = false;
  // ── crease-method bench state ──────────────────────────────────────────────
  private methodId: string = BASELINE_METHOD_ID;
  private methodToken = 0;
  private activeMethod: { method: CreaseMethod; ctx: CreaseMethodCtx } | null = null;
  private readonly methodGlbCache = new Map<string, Promise<Group | null>>();
  private readonly methodLoader = new GLTFLoader();
  private methodSelect: HTMLSelectElement | null = null;

  constructor(private readonly refs: LabRefs) {}

  async init(): Promise<void> {
    this.readHash();
    this.refs.search.addEventListener("input", this.onSearch);
    this.refs.tabs.addEventListener("click", this.onTabClick);
    this.refs.bodies.addEventListener("click", this.onBodyClick);
    this.refs.list.addEventListener("click", this.onListClick);
    this.refs.facets.addEventListener("change", this.onFacetChange);
    this.refs.loadout.addEventListener("click", this.onLoadoutClick);
    this.refs.cams.addEventListener("click", this.onCamClick);
    this.refs.turntable.addEventListener("click", this.onTurntable);
    this.refs.bones.addEventListener("click", this.onBones);
    this.refs.post.addEventListener("click", this.onPost);
    this.refs.refresh.addEventListener("click", this.onRefresh);
    this.refs.play.addEventListener("click", this.onPlay);
    this.refs.stepBack.addEventListener("click", () => this.step(-STEP_SECONDS));
    this.refs.stepFwd.addEventListener("click", () => this.step(STEP_SECONDS));
    this.refs.scrub.addEventListener("input", this.onScrub);
    this.refs.scrub.addEventListener("pointerdown", () => { this.scrubbing = true; });
    window.addEventListener("pointerup", this.onWindowPointerUp);
    this.refs.speed.addEventListener("input", this.onSpeed);
    window.addEventListener("keydown", this.onKeyDown);
    this.refs.actions.addEventListener("click", this.onActionClick);
    this.refs.actions.addEventListener("change", this.onActionChange);

    this.renderTabs();
    this.renderBodies();
    this.setStatus("LOADING PACK…");

    // Material presets must be cached before the first wear so every attach
    // resolves final materials (no placeholder → refresh pass).
    const [data] = await Promise.all([
      loadLabData(),
      getEquipmentMaterialSets().catch(() => null),
    ]);
    if (this.disposed) return;
    this.data = data;
    this.stage = new LabStage({ host: this.refs.host, onFrame: this.onFrame });
    prepareWeaponMaterials(data.pack, this.stage.pawnMatcap);
    this.postPanel = new PostPanel(
      {
        panel: this.refs.postPanel,
        toggle: this.refs.postToggle,
        reset: this.refs.postReset,
        copy: this.refs.postCopy,
        body: this.refs.postBody,
      },
      {
        setTimeOfDayMinute: (minute) => this.stage?.setTimeOfDayMinute(minute),
        getFog: () => this.fogState,
        setFog: (patch) => this.patchFog(patch),
        getDressing: () => this.dressingOn,
        setDressing: (on) => this.setDressing(on),
      },
    );
    if (this.fogState.enabled) this.stage.applyFog(this.fogState);
    if (this.dressingOn) void this.stage.setDepthDressing(true);
    if (!data.pack.clipMeta.has(this.clip)) this.clip = "idle";
    if (this.weaponId && !this.weaponEntry(this.weaponId)) this.weaponId = null;
    this.rebuildPawn();
    this.refs.post.toggleAttribute("data-active", this.stage.isPost());
    this.renderList();
    this.renderLoadout();
    if (this.propId) {
      const prop = data.waveProps.find((entry) => entry.id === this.propId) ?? null;
      if (prop) void this.placeProp(prop);
      else this.propId = null;
    }
    this.setStatus("READY");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("pointerup", this.onWindowPointerUp);
    this.postPanel?.dispose();
    this.postPanel = null;
    this.teardownActiveMethod();
    this.stage?.dispose();
    this.stage = null;
  }

  // ── composition ───────────────────────────────────────────────────────────

  private weaponEntry(weaponId: string): LabWeaponEntry | null {
    return this.data?.weapons.find((entry) => entry.id === weaponId) ?? null;
  }

  private rebuildPawn(): void {
    void this.rebuildPawnWithMethod();
  }

  /**
   * Method-aware rebuild: resolve the active crease-method's overrides
   * (garment/body forks, packPatch), build the pawn from the derived pack,
   * then run the method's runtime hooks. Stale rebuilds (rapid switches) are
   * dropped via methodToken.
   */
  private async rebuildPawnWithMethod(): Promise<void> {
    const token = ++this.methodToken;
    // Capture-integrity marker: null while ANY rebuild is in flight; set to the
    // method id only after the method pawn is live on stage (see end of this
    // function). External capture drivers MUST poll this instead of the select's
    // disabled state — the select re-enables before slow async fork loads land,
    // leaving the stale baseline pawn on stage (caused false A/B evidence).
    window.__labMethodReady = null;
    const data = this.data;
    const stage = this.stage;
    if (!data || !stage) return;
    this.teardownActiveMethod();
    const method = creaseMethodById(this.methodId);
    const wornIds = [...this.worn];
    let pack = data.pack;
    try {
      pack = await this.packWithMethodOverrides(data.pack, method, wornIds);
    } catch (error) {
      console.warn(`asset lab: method "${method.id}" overrides failed, using baseline pack`, error);
      pack = data.pack;
    }
    if (token !== this.methodToken || this.disposed || !this.stage) return;
    // A method that replaces the body owns that body entirely — never swap it
    // for the bare variant underneath the method's feet.
    const bareBody = this.body === "male"
      && !method.bodyUrl
      && !equipmentIdsCoverLegs(pack.equipment.items, wornIds);
    let pawn: LabPawn;
    try {
      pawn = new LabPawn(pack, this.body, stage.pawnMatcap, bareBody);
    } catch (error) {
      // Special body GLB missing → fall back to male instead of a dead stage.
      console.warn("asset lab: body unavailable, falling back to male", error);
      this.body = "male";
      pawn = new LabPawn(pack, this.body, stage.pawnMatcap);
    }
    stage.setPawn(pawn);
    this.resolvedWorn = pawn.setWorn(wornIds);
    this.applyWeaponToPawn();
    pawn.applyClip(this.clip);
    stage.framePawn();
    if (method.install || method.perFrame || method.uninstall) {
      const ctx: CreaseMethodCtx = {
        pawn,
        stage,
        scene: stage.methodScene(),
        pack,
        wornIds: this.resolvedWorn,
      };
      try {
        await method.install?.(ctx);
        if (token !== this.methodToken) {
          method.uninstall?.(ctx);
          return;
        }
        this.activeMethod = { method, ctx };
      } catch (error) {
        console.warn(`asset lab: method "${method.id}" install failed`, error);
      }
    }
    this.renderBodies();
    this.renderList();
    this.renderLoadout();
    this.configureTransport();
    this.renderActions();
    this.renderMethodControl();
    window.__labMethodReady = method.id;
    this.writeHash();
  }

  private teardownActiveMethod(): void {
    const active = this.activeMethod;
    this.activeMethod = null;
    if (!active) return;
    try {
      active.method.uninstall?.(active.ctx);
    } catch (error) {
      console.warn(`asset lab: method "${active.method.id}" uninstall failed`, error);
    }
  }

  /** Load a method's fork GLBs (cached per url); 404/HTML → null (fallback). */
  private loadMethodGlb(url: string): Promise<Group | null> {
    let pending = this.methodGlbCache.get(url);
    if (!pending) {
      pending = (async () => {
        if (!(await methodOverrideExists(url))) return null;
        const gltf = await this.methodLoader.loadAsync(url);
        return gltf.scene;
      })().catch((error) => {
        console.warn(`asset lab: method glb failed: ${url}`, error);
        return null;
      });
      this.methodGlbCache.set(url, pending);
    }
    return pending;
  }

  /** Derive the build pack for a method: garment fork scenes, body fork, packPatch. */
  private async packWithMethodOverrides(
    pack: LabData["pack"],
    method: CreaseMethod,
    wornIds: readonly string[],
  ): Promise<LabData["pack"]> {
    let derived = pack;
    if (method.assetRoot) {
      const scenes = new Map(pack.equipment.scenes);
      let overridden = 0;
      await Promise.all(wornIds.map(async (itemId) => {
        const item = pack.equipment.items.find((candidate) => candidate.id === itemId);
        if (!item) return;
        const fork = await this.loadMethodGlb(`${method.assetRoot}/${item.glb}`);
        if (fork) {
          scenes.set(itemId, fork);
          overridden += 1;
        }
      }));
      if (overridden > 0) {
        derived = { ...derived, equipment: { ...derived.equipment, scenes } };
      }
    }
    if (method.bodyUrl) {
      const body = await this.loadMethodGlb(method.bodyUrl);
      if (body) derived = { ...derived, bodies: { ...derived.bodies, male: body } };
    }
    if (method.packPatch) {
      derived = await method.packPatch(derived, {
        loadGlb: async (url: string) => {
          const scene = await this.loadMethodGlb(url);
          if (!scene) throw new Error(`method packPatch glb missing: ${url}`);
          return scene;
        },
      });
    }
    return derived;
  }

  /** METHOD dropdown (top strip): switch forks live; hash-persisted. */
  private renderMethodControl(): void {
    if (!this.methodSelect) {
      const select = document.createElement("select");
      select.className = "lab-method-select";
      select.title = "crease-fix method bench — pick a foundation, judge, repeat";
      select.addEventListener("change", () => {
        this.methodId = select.value;
        const method = creaseMethodById(this.methodId);
        this.setStatus(`METHOD ${method.label} — ${method.blurb}`);
        this.rebuildPawn();
      });
      this.refs.bodies.parentElement?.insertBefore(select, this.refs.bodies.nextSibling);
      this.methodSelect = select;
    }
    const options = CREASE_METHODS
      .map((method) => `<option value="${method.id}"${method.id === this.methodId ? " selected" : ""}>${method.label}</option>`)
      .join("");
    if (this.methodSelect.innerHTML !== options) this.methodSelect.innerHTML = options;
    else this.methodSelect.value = this.methodId;
  }

  private applyWeaponToPawn(): void {
    const data = this.data;
    const pawn = this.stage?.currentPawn() ?? null;
    if (!data || !pawn) return;
    if (!this.weaponId) {
      pawn.setWeapon(null);
      return;
    }
    const entry = this.weaponEntry(this.weaponId);
    const selection = entry ? weaponSelectionFor(data.pack, entry.id, entry.weaponClass) : null;
    if (!selection) {
      this.weaponId = null;
      pawn.setWeapon(null);
      return;
    }
    pawn.setWeapon(selection);
  }

  /** Owner acceptance gate: equipping enters the matching idle; unequip → idle. */
  private toggleWeapon(weaponId: string): void {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    if (this.weaponId === weaponId) {
      this.weaponId = null;
      this.applyWeaponToPawn();
      this.selectClip("idle");
      this.setStatus("UNARMED");
    } else {
      this.weaponId = weaponId;
      const entry = this.weaponEntry(weaponId);
      this.applyWeaponToPawn();
      const idle = entry?.weaponClass === "melee" ? "melee_idle" : "rifle_idle";
      this.selectClip(this.data?.pack.clipMeta.has(idle) ? idle : "idle");
      this.setStatus(`${entry?.label.toUpperCase() ?? weaponId} EQUIPPED`);
    }
    this.actionLoop = false;
    this.loopClock = 0;
    this.renderList();
    this.renderLoadout();
    this.renderActions();
    this.writeHash();
  }

  private toggleWornItem(itemId: string): void {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn || pawn.isDroid) return;
    if (this.worn.has(itemId)) this.worn.delete(itemId);
    else this.worn.add(itemId);
    this.rebuildPawn();
  }

  private selectClip(clipName: string): void {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn || !this.data?.pack.clipMeta.has(clipName)) return;
    this.clip = clipName;
    pawn.applyClip(clipName);
    pawn.setPlaying(true);
    this.refs.play.textContent = "PAUSE";
    this.configureTransport();
    if (this.tab === "anims") this.renderList();
    this.renderActions();
    this.writeHash();
  }

  private async placeProp(prop: WavePropEntry): Promise<void> {
    const stage = this.stage;
    if (!stage) return;
    this.propId = prop.id;
    this.propPending = true;
    this.renderList();
    try {
      await stage.placeProp(prop.url);
      this.setStatus(`${prop.label.toUpperCase()} ON PEDESTAL`);
    } catch (error) {
      console.error("asset lab: prop load failed", error);
      this.propId = null;
      this.setStatus("PROP LOAD FAILED");
    } finally {
      this.propPending = false;
      this.renderList();
      this.writeHash();
    }
  }

  private toggleProp(prop: WavePropEntry): void {
    if (this.propPending) return;
    if (this.propId === prop.id) {
      this.propId = null;
      this.stage?.removeProp();
      this.renderList();
      this.writeHash();
      return;
    }
    void this.placeProp(prop);
  }

  // ── URL hash state ──────────────────────────────────────────────────────────

  private writeHash(): void {
    const params = new URLSearchParams();
    params.set("body", this.body);
    if (this.worn.size > 0) params.set("worn", [...this.worn].join(","));
    if (this.weaponId) params.set("weapon", this.weaponId);
    if (this.clip !== "idle") params.set("clip", this.clip);
    if (this.tab !== "wardrobe") params.set("tab", this.tab);
    if (this.propId) params.set("prop", this.propId);
    if (this.fireFxByWeapon.size > 0) {
      params.set("fx", [...this.fireFxByWeapon].map(([weapon, fx]) => `${weapon}:${fx}`).join(","));
    }
    if (this.fogState.enabled) {
      const fog = this.fogState;
      params.set("sfog", `${fog.color}|${fog.near}|${fog.far}|${fog.mode}|${fog.density}`);
    }
    if (this.dressingOn) params.set("dress", "1");
    if (this.methodId !== BASELINE_METHOD_ID) params.set("method", this.methodId);
    history.replaceState(null, "", `#${params.toString()}`);
  }

  private readHash(): void {
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    const params = new URLSearchParams(raw);
    const body = params.get("body");
    if (body === "male" || body === "female" || body === DROID_BODY_KEY) this.body = body;
    for (const id of (params.get("worn") ?? "").split(",")) {
      if (id) this.worn.add(id);
    }
    this.weaponId = params.get("weapon");
    this.clip = params.get("clip") ?? "idle";
    const tab = params.get("tab");
    if (tab === "wardrobe" || tab === "weapons" || tab === "anims" || tab === "props") this.tab = tab;
    this.propId = params.get("prop");
    for (const pair of (params.get("fx") ?? "").split(",")) {
      const colon = pair.indexOf(":");
      if (colon <= 0) continue;
      const weapon = pair.slice(0, colon);
      const fx = pair.slice(colon + 1);
      if (isLabFireFxId(fx)) this.fireFxByWeapon.set(weapon, fx);
    }
    const sfog = params.get("sfog");
    if (sfog) {
      const [color, near, far, mode, density] = sfog.split("|");
      this.fogState = {
        enabled: true,
        color: /^#[0-9a-f]{6}$/i.test(color ?? "") ? (color as string) : this.fogState.color,
        near: Number.isFinite(Number(near)) ? Number(near) : this.fogState.near,
        far: Number.isFinite(Number(far)) ? Number(far) : this.fogState.far,
        mode: mode === "exp2" ? "exp2" : "linear",
        density: Number.isFinite(Number(density)) ? Number(density) : this.fogState.density,
      };
    }
    this.dressingOn = params.get("dress") === "1";
    const method = params.get("method");
    if (method && CREASE_METHODS.some((candidate) => candidate.id === method)) this.methodId = method;
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  private setStatus(message: string): void {
    this.refs.status.textContent = message;
  }

  private renderBodies(): void {
    for (const button of this.refs.bodies.querySelectorAll<HTMLButtonElement>("[data-body]")) {
      button.toggleAttribute("data-active", button.dataset.body === this.body);
    }
  }

  private renderTabs(): void {
    for (const button of this.refs.tabs.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
      button.toggleAttribute("data-active", button.dataset.tab === this.tab);
    }
    this.refs.facets.hidden = this.tab !== "props";
  }

  private renderList(): void {
    const data = this.data;
    if (!data) return;
    const query = this.refs.search.value.trim().toLowerCase();
    if (this.tab === "wardrobe") this.refs.list.innerHTML = this.wardrobeListHtml(data, query);
    else if (this.tab === "weapons") this.refs.list.innerHTML = this.weaponsListHtml(data, query);
    else if (this.tab === "anims") this.refs.list.innerHTML = this.animsListHtml(data, query);
    else this.refs.list.innerHTML = this.propsListHtml(data, query);
  }

  private wardrobeListHtml(data: LabData, query: string): string {
    const pawn = this.stage?.currentPawn() ?? null;
    if (pawn?.isDroid) {
      return `<div class="lab-empty">GR0K DROID — hard-shell chassis.<br />Wardrobe does not apply to this body.</div>`;
    }
    const worn = new Set(this.resolvedWorn);
    const byShelf = new Map<string, PawnEquipmentItem[]>();
    for (const item of data.pack.equipment.items) {
      if (query && !`${item.name} ${item.id} ${item.slot}`.toLowerCase().includes(query)) continue;
      const shelf = wardrobeShelf(item);
      const rows = byShelf.get(shelf);
      if (rows) rows.push(item);
      else byShelf.set(shelf, [item]);
    }
    let html = "";
    let total = 0;
    for (const shelf of WARDROBE_SHELF_ORDER) {
      const rows = byShelf.get(shelf);
      if (!rows || rows.length === 0) continue;
      total += rows.length;
      html += `<div class="lab-group">${shelf} <em>${rows.length}</em></div>`;
      for (const item of rows) {
        const active = worn.has(item.id);
        const requires = item.requires.length > 0 ? ` title="requires ${escapeHtml(item.requires.join(", "))}"` : "";
        html += `<button type="button" class="lab-row" data-kind="equipment" data-id="${escapeHtml(item.id)}"${active ? " data-active" : ""}${requires}>
          <span class="lab-row-name">${escapeHtml(item.name)}</span>
          <span class="lab-row-tag">${escapeHtml(item.slot)}</span>
          <span class="lab-row-state">${active ? "WORN" : ""}</span>
        </button>`;
      }
    }
    return total === 0 ? `<div class="lab-empty">No wardrobe matches “${escapeHtml(query)}”.</div>` : html;
  }

  private weaponsListHtml(data: LabData, query: string): string {
    const rows = data.weapons.filter((entry) =>
      !query || `${entry.label} ${entry.id} ${entry.weaponClass}`.toLowerCase().includes(query));
    if (rows.length === 0) return `<div class="lab-empty">No weapon matches “${escapeHtml(query)}”.</div>`;
    const melee = rows.filter((entry) => entry.weaponClass === "melee");
    const guns = rows.filter((entry) => entry.weaponClass !== "melee");
    const section = (label: string, entries: readonly LabWeaponEntry[]): string => {
      if (entries.length === 0) return "";
      let html = `<div class="lab-group">${label} <em>${entries.length}</em></div>`;
      for (const entry of entries) {
        const active = this.weaponId === entry.id;
        html += `<button type="button" class="lab-row" data-kind="weapon" data-id="${escapeHtml(entry.id)}"${active ? " data-active" : ""}>
          <span class="lab-row-name">${escapeHtml(entry.label)}</span>
          <span class="lab-row-tag">${escapeHtml(entry.weaponClass)}</span>
          <span class="lab-row-state">${active ? "HELD" : ""}</span>
        </button>`;
      }
      return html;
    };
    return section("GUNS", guns) + section("MELEE", melee);
  }

  private animsListHtml(data: LabData, query: string): string {
    const weapon = this.weaponId ? this.weaponEntry(this.weaponId) : null;
    const fits = weapon
      ? (weapon.weaponClass === "melee" ? clipUsesMelee : clipUsesGun)
      : null;
    const matches = (clip: string): boolean => !query || clip.toLowerCase().includes(query);
    const row = (clip: string): string => {
      const meta = data.pack.clipMeta.get(clip);
      const active = this.clip === clip;
      return `<button type="button" class="lab-row" data-kind="clip" data-id="${escapeHtml(clip)}"${active ? " data-active" : ""}>
        <span class="lab-row-name">${escapeHtml(clip)}</span>
        <span class="lab-row-tag">${meta ? escapeHtml(meta.layer) : ""}</span>
        <span class="lab-row-state">${meta ? `${meta.durationS.toFixed(1)}s` : ""}</span>
      </button>`;
    };
    let html = "";
    let total = 0;
    if (fits && weapon) {
      const fitting: string[] = [];
      for (const group of data.clipGroups) {
        for (const clip of group.clips) {
          if (fits(clip) && matches(clip)) fitting.push(clip);
        }
      }
      if (fitting.length > 0) {
        total += fitting.length;
        html += `<div class="lab-group lab-group--fits">FITS · ${escapeHtml(weapon.label.toUpperCase())} <em>${fitting.length}</em></div>`;
        html += fitting.map(row).join("");
      }
    }
    for (const group of data.clipGroups) {
      const clips = group.clips.filter((clip) => matches(clip) && !(fits && fits(clip)));
      if (clips.length === 0) continue;
      total += clips.length;
      html += `<div class="lab-group">${escapeHtml(group.label)} <em>${clips.length}</em></div>`;
      html += clips.map(row).join("");
    }
    return total === 0 ? `<div class="lab-empty">No clip matches “${escapeHtml(query)}”.</div>` : html;
  }

  private propsListHtml(data: LabData, query: string): string {
    if (data.waveProps.length === 0) return `<div class="lab-empty">Wave props library not present.</div>`;
    this.renderPropFacets(data);
    const rows: WavePropEntry[] = [];
    let matched = 0;
    for (const entry of data.waveProps) {
      if (this.propCategory && entry.category !== this.propCategory) continue;
      if (query && !entry.searchText.includes(query)) continue;
      matched += 1;
      if (rows.length < MAX_LIST_ROWS) rows.push(entry);
    }
    if (matched === 0) return `<div class="lab-empty">No prop matches “${escapeHtml(query)}”.</div>`;
    let html = `<div class="lab-group">WAVE LIBRARY <em>${matched}</em></div>`;
    for (const entry of rows) {
      const active = this.propId === entry.id;
      const pending = active && this.propPending;
      html += `<button type="button" class="lab-row" data-kind="prop" data-id="${escapeHtml(entry.id)}"${active ? " data-active" : ""}>
        <span class="lab-row-name">${escapeHtml(entry.label)}</span>
        <span class="lab-row-tag">${escapeHtml(entry.category)}</span>
        <span class="lab-row-state">${pending ? "…" : active ? "STAGED" : ""}</span>
      </button>`;
    }
    if (matched > rows.length) {
      html += `<div class="lab-more">+${matched - rows.length} more — refine search</div>`;
    }
    return html;
  }

  private propFacetsRendered = false;

  private renderPropFacets(data: LabData): void {
    if (this.propFacetsRendered) return;
    this.propFacetsRendered = true;
    const categories = [...new Set(data.waveProps.map((entry) => entry.category))].sort();
    this.refs.facets.innerHTML = `<select data-ref="propCategory" aria-label="Prop category">
      <option value="">ALL CATEGORIES (${data.waveProps.length})</option>
      ${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join("")}
    </select>`;
  }

  private renderLoadout(): void {
    const data = this.data;
    if (!data) return;
    const pawn = this.stage?.currentPawn() ?? null;
    const bodyVariant = pawn?.bodyVariant ?? "accommodation";
    if (typeof window !== "undefined") {
      (window as Window & { __labBodyVariant?: "bare" | "accommodation" }).__labBodyVariant = bodyVariant;
    }
    let html = `<span class="lab-loadout-label">LOADOUT</span><span class="lab-body-variant">BODY ${bodyVariant.toUpperCase()}</span>`;
    const chips: string[] = [];
    if (!pawn?.isDroid) {
      for (const itemId of this.resolvedWorn) {
        const item = data.pack.equipment.items.find((candidate) => candidate.id === itemId);
        chips.push(`<button type="button" class="lab-chip" data-kind="equipment" data-id="${escapeHtml(itemId)}" title="click to remove">${escapeHtml(item?.name ?? itemId)}<i>✕</i></button>`);
      }
    }
    if (this.weaponId) {
      const entry = this.weaponEntry(this.weaponId);
      chips.push(`<button type="button" class="lab-chip lab-chip--weapon" data-kind="weapon" data-id="${escapeHtml(this.weaponId)}" title="click to unequip">${escapeHtml(entry?.label ?? this.weaponId)}<i>✕</i></button>`);
    }
    html += chips.length > 0 ? chips.join("") : `<span class="lab-loadout-empty">bare</span>`;
    this.refs.loadout.innerHTML = html;
  }

  // ── SCENE FOG / DEPTH DRESSING (POST panel host) ──────────────────────────

  private patchFog(patch: Partial<LabFogState>): void {
    Object.assign(this.fogState, patch);
    if (this.fogState.far <= this.fogState.near) this.fogState.far = this.fogState.near + 0.1;
    this.stage?.applyFog(this.fogState);
    this.writeHash();
  }

  private setDressing(on: boolean): void {
    this.dressingOn = on;
    void this.stage?.setDepthDressing(on);
    this.writeHash();
  }

  // ── held-item actions (ACTIONS strip + F/R keys) ──────────────────────────

  private heldWeaponEntry(): LabWeaponEntry | null {
    return this.weaponId ? this.weaponEntry(this.weaponId) : null;
  }

  private fireFxFor(weaponId: string): LabFireFxId {
    return this.fireFxByWeapon.get(weaponId) ?? DEFAULT_FIRE_FX[weaponId] ?? "ballistic";
  }

  private fireProfileFor(entry: LabWeaponEntry): FireProfile {
    return {
      ...DEFAULT_FIRE_PROFILE,
      ...FIRE_PROFILE_BY_CLASS[entry.weaponClass],
      ...FIRE_PROFILE_BY_ID[entry.id],
    };
  }

  /** Rebuild the actions strip for the held item (hidden when unarmed). */
  private renderActions(): void {
    const entry = this.heldWeaponEntry();
    if (!entry) {
      this.actionLoop = false;
      this.refs.actions.hidden = true;
      this.refs.actions.innerHTML = "";
      return;
    }
    this.refs.actions.hidden = false;
    const loopAttr = this.actionLoop ? " data-active" : "";
    if (entry.weaponClass === "melee") {
      this.refs.actions.innerHTML = `
        <button type="button" data-act="swing" title="F">SWING</button>
        <button type="button" data-act="loop" title="repeat swings"${loopAttr}>LOOP</button>`;
      return;
    }
    const selected = this.fireFxFor(entry.id);
    const option = (id: string): string =>
      `<option value="${id}"${id === selected ? " selected" : ""}>${id}</option>`;
    const embedded = this.stage?.currentPawn()?.weaponFireClipName();
    this.refs.actions.innerHTML = `
      <button type="button" data-act="attack" title="F">ATTACK</button>
      <select data-act="fx" title="fire effect (persists per weapon)">
        <optgroup label="BOLTS">${BOLT_STYLE_IDS.map(option).join("")}</optgroup>
        <optgroup label="BEAMS">${BEAM_FX_IDS.map(option).join("")}</optgroup>
      </select>
      <button type="button" data-act="loop" title="repeat fire"${loopAttr}>LOOP</button>
      <button type="button" data-act="reload" title="R"${this.clip === "reload" ? " data-active" : ""}>RELOAD</button>
      ${embedded ? `<em class="lab-actions-clip" title="weapon GLB's own action clip, played on ATTACK">${escapeHtml(embedded)}</em>` : ""}`;
  }

  /** One trigger pull: body montage + weapon's own fire clip + muzzle/bore FX. */
  private doAttack(): void {
    const stage = this.stage;
    const pawn = stage?.currentPawn() ?? null;
    const entry = this.heldWeaponEntry();
    if (!stage || !pawn || !entry || entry.weaponClass === "melee") return;
    if (!clipUsesGun(this.clip)) {
      this.selectClip(this.data?.pack.clipMeta.has("rifle_idle") ? "rifle_idle" : "idle");
    }
    if (this.clip === "reload") return; // hands are busy in the mag well
    pawn.setPlaying(true);
    this.refs.play.textContent = "PAUSE";
    pawn.playActionMontage("rifle_fire");
    pawn.playWeaponFireClip();
    if (!pawn.muzzleBore(this.muzzleScratch, this.boreScratch)) return;
    const fx = this.fireFxFor(entry.id);
    const profile = this.fireProfileFor(entry);
    if (isBeamFxId(fx)) {
      stage.fx.flash(this.muzzleScratch, this.boreScratch, profile.mag);
      stage.fx.fireBeam(fx, this.muzzleScratch, this.boreScratch, profile.beamDistance);
      return;
    }
    for (let shot = 0; shot < profile.count; shot += 1) {
      // Fan around the bore in the ground plane (shotgun spread).
      const fan = profile.count > 1
        ? (shot / (profile.count - 1) - 0.5) * profile.spreadRad + (Math.random() - 0.5) * 0.04
        : 0;
      const cos = Math.cos(fan);
      const sin = Math.sin(fan);
      this.shotDirScratch.set(
        this.boreScratch.x * cos - this.boreScratch.z * sin,
        this.boreScratch.y,
        this.boreScratch.x * sin + this.boreScratch.z * cos,
      );
      stage.fx.fireBolt(this.muzzleScratch, this.shotDirScratch, {
        style: fx,
        hitStyle: profile.hitStyle,
        speed: profile.speed,
        mag: profile.mag,
        noFlash: shot > 0,
      });
    }
  }

  /** One melee swing: cycles swing_h1..h3, sparks the blade on an authored hit event. */
  private doSwing(): void {
    const stage = this.stage;
    const pawn = stage?.currentPawn() ?? null;
    const entry = this.heldWeaponEntry();
    if (!stage || !pawn || !entry || entry.weaponClass !== "melee") return;
    if (!clipUsesMelee(this.clip)) {
      this.selectClip(this.data?.pack.clipMeta.has("melee_idle") ? "melee_idle" : "idle");
    }
    pawn.setPlaying(true);
    this.refs.play.textContent = "PAUSE";
    const clip = SWING_CYCLE[this.swingIndex % SWING_CYCLE.length] ?? "swing_h1";
    this.swingIndex += 1;
    if (!pawn.playActionMontage(clip)) return;
    // Spark only when the clip authors a hit-ish event (none do today; the
    // hook is ready for the day the montages gain contact marks).
    const events = this.data?.pack.clipMeta.get(clip)?.events ?? {};
    const hit = Object.entries(events).find(([name]) => /hit|impact|contact/i.test(name)) ?? null;
    if (!hit) return;
    window.setTimeout(() => this.meleeSpark(), (hit[1] / Math.max(0.05, this.speed)) * 1000);
  }

  private meleeSpark(): void {
    const stage = this.stage;
    const pawn = stage?.currentPawn() ?? null;
    if (!stage || !pawn || !pawn.bladeTipWorld(this.tipScratch)) return;
    pawn.root.getWorldPosition(this.rootScratch);
    this.shotDirScratch.subVectors(this.tipScratch, this.rootScratch);
    this.shotDirScratch.y = 0;
    if (this.shotDirScratch.lengthSq() < 1e-6) this.shotDirScratch.set(0, 0, 1);
    else this.shotDirScratch.normalize();
    stage.fx.spark(this.tipScratch, this.shotDirScratch, 1);
  }

  /** Toggle the procedural reload theater (rifle idle hold + rig mag swap). */
  private doReload(): void {
    const entry = this.heldWeaponEntry();
    if (!entry || entry.weaponClass === "melee" || !this.data?.pack.clipMeta.has("reload")) return;
    if (this.clip === "reload") {
      this.selectClip(this.data.pack.clipMeta.has("rifle_idle") ? "rifle_idle" : "idle");
    } else {
      this.selectClip("reload");
    }
  }

  private toggleActionLoop(): void {
    this.actionLoop = !this.actionLoop;
    this.loopClock = Number.POSITIVE_INFINITY; // first repeat fires immediately
    this.renderActions();
  }

  /** LOOP driver (wall-clock dt): guns repeat on cadence, melee re-swings when the montage ends. */
  private tickActionLoop(dtSeconds: number): void {
    const entry = this.heldWeaponEntry();
    if (!entry) {
      this.actionLoop = false;
      return;
    }
    if (entry.weaponClass === "melee") {
      if (this.activeLayers.montage === null) this.doSwing();
      return;
    }
    if (this.clip === "reload") return; // resume firing after the reload toggle
    const profile = this.fireProfileFor(entry);
    const cadence = isBeamFxId(this.fireFxFor(entry.id))
      ? Math.max(profile.cadenceS, BEAM_MIN_CADENCE_S)
      : profile.cadenceS;
    this.loopClock += dtSeconds;
    if (this.loopClock < cadence) return;
    this.loopClock = 0;
    this.doAttack();
  }

  private readonly onActionClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-act]");
    if (!button) return;
    const act = button.dataset.act;
    if (act === "attack") this.doAttack();
    else if (act === "swing") this.doSwing();
    else if (act === "loop") this.toggleActionLoop();
    else if (act === "reload") this.doReload();
  };

  private readonly onActionChange = (event: Event): void => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.act !== "fx" || !this.weaponId) return;
    if (!isLabFireFxId(select.value)) return;
    this.fireFxByWeapon.set(this.weaponId, select.value);
    this.writeHash();
  };

  // ── transport ─────────────────────────────────────────────────────────────

  private configureTransport(): void {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    this.refs.clipName.textContent = this.clip;
    this.refs.loop.textContent = pawn.clipLoops() ? "LOOP" : "ONCE";
    this.refs.loop.toggleAttribute("data-once", !pawn.clipLoops());
    this.renderScrubEvents(pawn);
  }

  private renderScrubEvents(pawn: LabPawn): void {
    this.refs.scrubEvents.textContent = "";
    const duration = pawn.clipDuration();
    if (duration <= 0) return;
    for (const [name, timeS] of pawn.clipEvents()) {
      const tick = document.createElement("i");
      tick.title = `${name} @ ${timeS.toFixed(2)}s`;
      tick.style.left = `${((timeS / duration) * 100).toFixed(2)}%`;
      this.refs.scrubEvents.appendChild(tick);
    }
  }

  private step(deltaS: number): void {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    pawn.setPlaying(false);
    this.refs.play.textContent = "PLAY";
    const duration = pawn.clipDuration();
    if (duration <= 0) return;
    let target = pawn.clipTime() + deltaS;
    if (target < 0) target = pawn.clipLoops() ? duration + target : 0;
    pawn.seek(Math.min(duration, Math.max(0, target)));
  }

  private readonly onFrame = (dtSeconds: number): void => {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    pawn.update(dtSeconds * this.speed);
    if (this.activeMethod?.method.perFrame) {
      this.activeMethod.method.perFrame(this.activeMethod.ctx, dtSeconds * this.speed);
    }
    const duration = pawn.clipDuration();
    const time = pawn.clipTime();
    if (!this.scrubbing && duration > 0) {
      this.refs.scrub.value = String(Math.round((time / duration) * 1000));
    }
    const eventName = pawn.nearestEventName(time, 0.06);
    this.refs.time.textContent = `${time.toFixed(2)} / ${duration.toFixed(2)}${eventName ? ` · ${eventName}` : ""}`;
    pawn.activeClipsByLayer(this.activeLayers);
    const layers = [
      this.activeLayers.base ? `L0 ${this.activeLayers.base}` : null,
      this.activeLayers.upper ? `L1 ${this.activeLayers.upper}` : null,
      this.activeLayers.hand ? `L3 ${this.activeLayers.hand}` : null,
      this.activeLayers.montage ? `L4 ${this.activeLayers.montage}` : null,
      this.activeLayers.arm ? `L5 ${this.activeLayers.arm}` : null,
    ].filter((entry): entry is string => entry !== null);
    this.refs.layers.textContent = layers.join(" · ") || "—";
    if (this.actionLoop) this.tickActionLoop(dtSeconds);
    this.panelClock += dtSeconds;
    if (this.panelClock >= 0.25) {
      this.panelClock = 0;
      this.postPanel?.sync();
    }
  };

  // ── events ────────────────────────────────────────────────────────────────

  private readonly onSearch = (): void => {
    this.renderList();
  };

  private readonly onTabClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tab]");
    if (!button) return;
    this.tab = button.dataset.tab as TabName;
    this.refs.search.value = "";
    this.renderTabs();
    this.renderList();
    this.writeHash();
  };

  private readonly onBodyClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-body]");
    if (!button || button.dataset.body === this.body) return;
    this.body = button.dataset.body as LabBodyKey;
    this.rebuildPawn();
    this.setStatus(`${BODY_LABELS[this.body]} ON STAGE`);
  };

  private readonly onListClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-kind]");
    if (!button) return;
    const { kind, id } = button.dataset;
    if (!id) return;
    if (kind === "equipment") this.toggleWornItem(id);
    else if (kind === "weapon") this.toggleWeapon(id);
    else if (kind === "clip") this.selectClip(id);
    else if (kind === "prop") {
      const prop = this.data?.waveProps.find((entry) => entry.id === id);
      if (prop) this.toggleProp(prop);
    }
  };

  private readonly onFacetChange = (event: Event): void => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.ref !== "propCategory") return;
    this.propCategory = select.value;
    this.renderList();
  };

  private readonly onLoadoutClick = (event: Event): void => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>(".lab-chip");
    if (!chip) return;
    const { kind, id } = chip.dataset;
    if (!id) return;
    if (kind === "equipment") this.toggleWornItem(id);
    else if (kind === "weapon") this.toggleWeapon(id);
  };

  private readonly onCamClick = (event: Event): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-cam]");
    if (!button) return;
    this.stage?.applyPreset(button.dataset.cam as CameraPresetName);
  };

  private readonly onTurntable = (): void => {
    const stage = this.stage;
    if (!stage) return;
    stage.setTurntable(!stage.isTurntable());
    this.refs.turntable.toggleAttribute("data-active", stage.isTurntable());
  };

  private readonly onBones = (): void => {
    const stage = this.stage;
    if (!stage) return;
    stage.setBones(!stage.isBones());
    this.refs.bones.toggleAttribute("data-active", stage.isBones());
  };

  private readonly onPost = (): void => {
    const stage = this.stage;
    if (!stage) return;
    stage.setPost(!stage.isPost());
    this.refs.post.toggleAttribute("data-active", stage.isPost());
  };

  private readonly onRefresh = (): void => {
    // State lives in the hash — a hard reload re-fetches manifests + GLBs and
    // restores the exact composition.
    window.location.reload();
  };

  private readonly onPlay = (): void => {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    pawn.setPlaying(!pawn.playing);
    this.refs.play.textContent = pawn.playing ? "PAUSE" : "PLAY";
  };

  private readonly onScrub = (): void => {
    const pawn = this.stage?.currentPawn() ?? null;
    if (!pawn) return;
    const duration = pawn.clipDuration();
    if (duration <= 0) return;
    pawn.setPlaying(false);
    this.refs.play.textContent = "PLAY";
    pawn.seek((Number(this.refs.scrub.value) / 1000) * duration);
  };

  private readonly onWindowPointerUp = (): void => {
    this.scrubbing = false;
  };

  private readonly onSpeed = (): void => {
    this.speed = Number(this.refs.speed.value) || 1;
    this.refs.speedValue.textContent = `${this.speed.toFixed(2)}×`;
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
    if (event.key === "/" && !typing) {
      event.preventDefault();
      this.refs.search.focus();
      this.refs.search.select();
      return;
    }
    if (typing) return;
    if (event.code === "Space") {
      event.preventDefault();
      this.onPlay();
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      this.step(-STEP_SECONDS);
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      this.step(STEP_SECONDS);
    } else if (event.code === "KeyT") {
      this.onTurntable();
    } else if (event.code === "KeyB") {
      this.onBones();
    } else if (event.code === "KeyF") {
      const entry = this.heldWeaponEntry();
      if (entry) {
        event.preventDefault();
        if (entry.weaponClass === "melee") this.doSwing();
        else this.doAttack();
      }
    } else if (event.code === "KeyR") {
      this.doReload();
    } else {
      const digit = /^Digit([1-5])$/.exec(event.code);
      if (digit) {
        const preset = CAMERA_PRESET_ORDER[Number(digit[1]) - 1];
        if (preset) this.stage?.applyPreset(preset);
      }
    }
  };
}
