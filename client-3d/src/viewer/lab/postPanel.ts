// postPanel.ts — Asset Lab post-processing tuning panel (right rail).
//
// Every field of the live Ps2PostDials object (window.__successor3dPost,
// installed by the stage's Ps2PostRenderer) gets a slider/toggle, plus a
// time-of-day override (stage stub clock), the sun-shadow probe and the
// SlugthrowerRig weapon dials WHEN their window handles exist. Dials are live
// objects re-read by the render pass every frame — writing them is the whole
// job; nothing here re-renders the scene.
import type { Ps2PostDials } from "../../render/post";
import type { Successor3dWeaponDials } from "../../render/weapons/slugthrowerRig";
import { defaultLabFogState, type LabFogState } from "./stage";

export interface PostPanelHost {
  /** null = clear the override (fixed lab noon). */
  setTimeOfDayMinute(minute: number | null): void;
  /** SCENE FOG bench state (app owns it; hash-persisted). */
  getFog(): LabFogState;
  setFog(patch: Partial<LabFogState>): void;
  /** DEPTH DRESSING prop spread on/off. */
  getDressing(): boolean;
  setDressing(on: boolean): void;
}

export interface PostPanelRefs {
  panel: HTMLElement;
  toggle: HTMLButtonElement;
  reset: HTMLButtonElement;
  copy: HTMLButtonElement;
  body: HTMLElement;
}

interface NumberSpec {
  key: keyof Ps2PostDials;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** Slider bounds per Ps2PostDials number field (sane ranges around config defaults). */
const POST_NUMBER_SPECS: readonly NumberSpec[] = [
  { key: "pixelScale", label: "pixel scale", min: 0.05, max: 1, step: 0.01 },
  { key: "posterizeLevels", label: "posterize levels", min: 0, max: 64, step: 1 },
  { key: "ditherStrength", label: "dither strength", min: 0, max: 0.2, step: 0.005 },
  { key: "desaturate", label: "desaturate", min: 0, max: 1, step: 0.01 },
  { key: "texelSoftness", label: "texel softness", min: 0, max: 1, step: 0.02 },
  { key: "bloomStrength", label: "bloom strength", min: 0, max: 4, step: 0.05 },
  { key: "bloomThreshold", label: "bloom threshold", min: 0, max: 0.99, step: 0.01 },
  { key: "shimmerAmplitude", label: "shimmer amplitude", min: 0, max: 1.2, step: 0.02 },
  { key: "blackLift", label: "black lift", min: 0, max: 0.35, step: 0.005 },
  { key: "fogNearT", label: "fog near t", min: 0, max: 2, step: 0.01 },
  { key: "fogFarT", label: "fog far t", min: 0, max: 2.5, step: 0.01 },
  { key: "dustHeightStart", label: "dust height start", min: 0, max: 1.5, step: 0.01 },
  { key: "dustHeightEnd", label: "dust height end", min: 0, max: 2, step: 0.01 },
  { key: "dustMaxStrength", label: "dust max strength", min: 0, max: 1, step: 0.01 },
  { key: "dustAmbient", label: "dust ambient", min: 0, max: 1, step: 0.01 },
  { key: "dustNoiseScale", label: "dust noise scale", min: 0.5, max: 20, step: 0.1 },
  { key: "dustDriftSpeed", label: "dust drift speed", min: 0, max: 0.2, step: 0.001 },
  { key: "dustPatchiness", label: "dust patchiness", min: 0, max: 1, step: 0.01 },
  { key: "atmoBorderStrength", label: "atmo border", min: 0, max: 2, step: 0.01 },
  { key: "atmoLayering", label: "atmo layering", min: 0, max: 1, step: 0.01 },
  { key: "atmoMoteScale", label: "atmo motes", min: 0, max: 3, step: 0.01 },
  { key: "chromaGuard", label: "chroma guard", min: 0, max: 1, step: 0.01 },
];

const POST_BOOL_SPECS: readonly { key: keyof Ps2PostDials; label: string }[] = [
  { key: "todEnabled", label: "time-of-day grade" },
  { key: "fogEnabled", label: "scene fog" },
];

const BONE_TINT_CHANNELS = ["R", "G", "B"] as const;

const WEAPON_AXIS_GROUPS: readonly { key: "posOffset" | "rotOffsetDeg" | "foregripContactOffset" | "stowPosOffset" | "stowRotOffsetDeg"; label: string; min: number; max: number; step: number }[] = [
  { key: "posOffset", label: "mount pos", min: -0.2, max: 0.2, step: 0.001 },
  { key: "rotOffsetDeg", label: "mount rot °", min: -45, max: 45, step: 0.5 },
  { key: "foregripContactOffset", label: "foregrip contact", min: -0.2, max: 0.2, step: 0.001 },
  { key: "stowPosOffset", label: "stow pos", min: -0.6, max: 0.6, step: 0.005 },
  { key: "stowRotOffsetDeg", label: "stow rot °", min: -180, max: 180, step: 1 },
];

const WEAPON_SCALAR_SPECS: readonly { key: "yawStrength" | "maxYawCorrectionRad" | "restingYawRad"; label: string; min: number; max: number; step: number }[] = [
  { key: "yawStrength", label: "yaw strength", min: 0, max: 1, step: 0.01 },
  { key: "maxYawCorrectionRad", label: "max yaw corr rad", min: 0, max: 1.2, step: 0.01 },
  { key: "restingYawRad", label: "resting yaw rad", min: -1, max: 1, step: 0.01 },
];

interface DialRow {
  /** Push the current live value into the readout (and the slider when idle). */
  sync: () => void;
  /** Restore the captured default. */
  reset: () => void;
}

function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = Math.floor(minute % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export class PostPanel {
  private readonly rows: DialRow[] = [];
  private readonly weaponRows: DialRow[] = [];
  private collapsed = false;
  private todOverrideOn = false;
  private todMinute = 720;
  private boundWeaponDials: Successor3dWeaponDials | null = null;
  private weaponDefaults: Record<string, number> = {};
  private readonly weaponSection: HTMLElement;
  private readonly postDefaults: Ps2PostDials | null;
  private disposed = false;

  constructor(private readonly refs: PostPanelRefs, private readonly host: PostPanelHost) {
    const dials = window.__successor3dPost ?? null;
    // Deep snapshot of the boot dials = the RESET target (config defaults +
    // the noon auto-grade readouts).
    this.postDefaults = dials ? (JSON.parse(JSON.stringify(dials)) as Ps2PostDials) : null;

    refs.toggle.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      refs.panel.toggleAttribute("data-collapsed", this.collapsed);
    });
    refs.reset.addEventListener("click", () => this.resetAll());
    refs.copy.addEventListener("click", () => void this.copyJson());

    this.buildPostSection();
    this.buildTodSection();
    this.buildSceneFogSection();
    this.buildSceneSection();
    this.buildSunShadowSection();
    this.weaponSection = this.section("WEAPON DIALS");
    this.rebuildWeaponSection();
    this.sync();
  }

  /** Cheap periodic tick (readouts + weapon-dial handle presence). */
  sync(): void {
    if (this.disposed) return;
    if (window.__successor3dWeapon !== this.boundWeaponDials) this.rebuildWeaponSection();
    for (const row of this.rows) row.sync();
    for (const row of this.weaponRows) row.sync();
  }

  dispose(): void {
    this.disposed = true;
    this.rows.length = 0;
    this.weaponRows.length = 0;
  }

  // ── sections ────────────────────────────────────────────────────────────

  private buildPostSection(): void {
    const dials = window.__successor3dPost;
    this.section("POST GRADE");
    if (!dials) {
      this.note("post pass not mounted");
      return;
    }
    for (const spec of POST_BOOL_SPECS) {
      this.toggleRow(spec.label, () => dials[spec.key] as boolean, (on) => {
        (dials[spec.key] as boolean) = on;
      }, () => {
        if (this.postDefaults) (dials[spec.key] as boolean) = this.postDefaults[spec.key] as boolean;
      });
    }
    for (const spec of POST_NUMBER_SPECS) {
      this.sliderRow(spec.label, spec.min, spec.max, spec.step,
        () => dials[spec.key] as number,
        (value) => { (dials[spec.key] as number) = value; },
        () => this.postDefaults ? this.postDefaults[spec.key] as number : dials[spec.key] as number);
    }
    for (let channel = 0; channel < 3; channel += 1) {
      this.sliderRow(`bone tint ${BONE_TINT_CHANNELS[channel]}`, 0.5, 1.5, 0.01,
        () => dials.boneTint[channel] ?? 1,
        (value) => { dials.boneTint[channel] = value; },
        () => this.postDefaults?.boneTint[channel] ?? 1);
    }
  }

  private buildTodSection(): void {
    this.section("TIME OF DAY");
    this.toggleRow("clock override", () => this.todOverrideOn, (on) => {
      this.todOverrideOn = on;
      this.host.setTimeOfDayMinute(on ? this.todMinute : null);
    }, () => {
      this.todOverrideOn = false;
      this.host.setTimeOfDayMinute(null);
    });
    this.sliderRow("minute of day", 0, 1439, 1,
      () => this.todMinute,
      (value) => {
        this.todMinute = value;
        if (this.todOverrideOn) this.host.setTimeOfDayMinute(value);
      },
      () => 720,
      (value) => formatMinute(value));
  }

  private buildSceneFogSection(): void {
    const fogDefaults = defaultLabFogState();
    this.section("SCENE FOG");
    this.toggleRow("fog override", () => this.host.getFog().enabled, (on) => {
      this.host.setFog({ enabled: on });
    }, () => this.host.setFog(fogDefaults));
    this.toggleRow("exp2 mode", () => this.host.getFog().mode === "exp2", (on) => {
      this.host.setFog({ mode: on ? "exp2" : "linear" });
    }, () => this.host.setFog({ mode: fogDefaults.mode }));
    this.colorRow("fog color", () => this.host.getFog().color, (color) => {
      this.host.setFog({ color });
    }, () => this.host.setFog({ color: fogDefaults.color }));
    this.sliderRow("fog near", 1, 300, 1,
      () => this.host.getFog().near,
      (value) => this.host.setFog({ near: value }),
      () => fogDefaults.near);
    this.sliderRow("fog far", 2, 400, 1,
      () => this.host.getFog().far,
      (value) => this.host.setFog({ far: value }),
      () => fogDefaults.far);
    this.sliderRow("exp2 density", 0, 0.15, 0.001,
      () => this.host.getFog().density,
      (value) => this.host.setFog({ density: value }),
      () => fogDefaults.density);
  }

  private buildSceneSection(): void {
    this.section("SCENE");
    this.toggleRow("depth dressing", () => this.host.getDressing(), (on) => {
      this.host.setDressing(on);
    }, () => this.host.setDressing(false));
    this.note("prop rows at 4 / 8 / 16 / 32 cells + far silhouettes");
  }

  private buildSunShadowSection(): void {
    this.section("SUN SHADOW");
    const probe = window.__successor3dSunShadow;
    if (!probe) {
      this.note("no sun-shadow system on the lab stage");
      return;
    }
    const defaults = { mapSize: probe.mapSize, bias: probe.bias };
    this.sliderRow("map size", 256, 4096, 256, () => probe.mapSize, (value) => { probe.mapSize = value; }, () => defaults.mapSize);
    this.sliderRow("bias", 0, 0.002, 0.00005, () => probe.bias, (value) => { probe.bias = value; }, () => defaults.bias, (value) => value.toFixed(5));
  }

  private rebuildWeaponSection(): void {
    const dials = window.__successor3dWeapon ?? null;
    this.boundWeaponDials = dials;
    this.weaponRows.length = 0;
    this.weaponSection.querySelectorAll(".lab-dial, .lab-dial-note").forEach((el) => el.remove());
    if (!dials) {
      this.note("equip a gun to expose the rig dials", this.weaponSection);
      return;
    }
    // Capture defaults once per handle identity (module-scoped in the rig,
    // so this survives re-equips of the same session).
    for (const group of WEAPON_AXIS_GROUPS) {
      for (const axis of ["x", "y", "z"] as const) {
        const defaultKey = `${group.key}.${axis}`;
        if (!(defaultKey in this.weaponDefaults)) this.weaponDefaults[defaultKey] = dials[group.key][axis];
        this.sliderRow(`${group.label} ${axis}`, group.min, group.max, group.step,
          () => dials[group.key][axis],
          (value) => { dials[group.key][axis] = value; },
          () => this.weaponDefaults[defaultKey] ?? 0,
          undefined, this.weaponSection, this.weaponRows);
      }
    }
    for (const spec of WEAPON_SCALAR_SPECS) {
      if (!(spec.key in this.weaponDefaults)) this.weaponDefaults[spec.key] = dials[spec.key];
      this.sliderRow(spec.label, spec.min, spec.max, spec.step,
        () => dials[spec.key],
        (value) => { dials[spec.key] = value; },
        () => this.weaponDefaults[spec.key] ?? 0,
        undefined, this.weaponSection, this.weaponRows);
    }
  }

  // ── actions ─────────────────────────────────────────────────────────────

  private resetAll(): void {
    for (const row of this.rows) row.reset();
    for (const row of this.weaponRows) row.reset();
    this.sync();
  }

  private async copyJson(): Promise<void> {
    const payload = {
      post: window.__successor3dPost ?? null,
      todOverrideMinute: this.todOverrideOn ? this.todMinute : null,
      sceneFog: this.host.getFog(),
      depthDressing: this.host.getDressing(),
      sunShadow: window.__successor3dSunShadow
        ? { mapSize: window.__successor3dSunShadow.mapSize, bias: window.__successor3dSunShadow.bias }
        : null,
      weapon: window.__successor3dWeapon ?? null,
    };
    const json = JSON.stringify(payload, null, 2);
    console.log("[asset-lab] post dials", json);
    try {
      await navigator.clipboard.writeText(json);
      this.flashCopyState("COPIED");
    } catch {
      // Headless / permission-less contexts: console.log above is the handoff.
      this.flashCopyState("LOGGED");
    }
  }

  private flashCopyState(text: string): void {
    const previous = this.refs.copy.textContent;
    this.refs.copy.textContent = text;
    window.setTimeout(() => {
      if (!this.disposed) this.refs.copy.textContent = previous;
    }, 900);
  }

  // ── row builders ────────────────────────────────────────────────────────

  private section(label: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "lab-dial-section";
    el.innerHTML = `<div class="lab-dial-heading">${label}</div>`;
    this.refs.body.appendChild(el);
    return el;
  }

  private note(text: string, parent?: HTMLElement): void {
    const el = document.createElement("div");
    el.className = "lab-dial-note";
    el.textContent = text;
    (parent ?? this.refs.body.lastElementChild ?? this.refs.body).appendChild(el);
  }

  private sliderRow(
    label: string,
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (value: number) => void,
    defaultValue: () => number,
    format?: (value: number) => string,
    parent?: HTMLElement,
    sink?: DialRow[],
  ): void {
    const row = document.createElement("div");
    row.className = "lab-dial";
    row.title = "double-click to reset";
    row.innerHTML = `<span class="lab-dial-label">${label}</span>
      <input type="range" min="${min}" max="${max}" step="${step}" />
      <em class="lab-dial-value"></em>`;
    const input = row.querySelector("input") as HTMLInputElement;
    const value = row.querySelector("em") as HTMLElement;
    const decimals = Math.max(0, Math.min(5, -Math.floor(Math.log10(step))));
    const show = (v: number): string => format ? format(v) : v.toFixed(decimals);
    let dragging = false;
    input.addEventListener("pointerdown", () => { dragging = true; });
    window.addEventListener("pointerup", () => { dragging = false; });
    input.addEventListener("input", () => {
      const v = Number(input.value);
      write(v);
      value.textContent = show(v);
    });
    row.addEventListener("dblclick", () => {
      write(defaultValue());
      input.value = String(read());
      value.textContent = show(read());
    });
    const dialRow: DialRow = {
      sync: () => {
        const v = read();
        value.textContent = show(v);
        if (!dragging && document.activeElement !== input) input.value = String(v);
      },
      reset: () => write(defaultValue()),
    };
    input.value = String(read());
    value.textContent = show(read());
    (parent ?? this.refs.body.lastElementChild as HTMLElement).appendChild(row);
    (sink ?? this.rows).push(dialRow);
  }

  private toggleRow(
    label: string,
    read: () => boolean,
    write: (on: boolean) => void,
    reset: () => void,
  ): void {
    const row = document.createElement("div");
    row.className = "lab-dial";
    row.innerHTML = `<span class="lab-dial-label">${label}</span>
      <button type="button" class="lab-dial-toggle"></button>`;
    const button = row.querySelector("button") as HTMLButtonElement;
    button.addEventListener("click", () => {
      write(!read());
      dialRow.sync();
    });
    const dialRow: DialRow = {
      sync: () => {
        const on = read();
        button.textContent = on ? "ON" : "OFF";
        button.toggleAttribute("data-active", on);
      },
      reset,
    };
    dialRow.sync();
    (this.refs.body.lastElementChild as HTMLElement).appendChild(row);
    this.rows.push(dialRow);
  }

  private colorRow(
    label: string,
    read: () => string,
    write: (color: string) => void,
    reset: () => void,
  ): void {
    const row = document.createElement("div");
    row.className = "lab-dial";
    row.title = "double-click to reset";
    row.innerHTML = `<span class="lab-dial-label">${label}</span>
      <input type="color" class="lab-dial-color" />
      <em class="lab-dial-value"></em>`;
    const input = row.querySelector("input") as HTMLInputElement;
    const value = row.querySelector("em") as HTMLElement;
    input.addEventListener("input", () => {
      write(input.value);
      value.textContent = input.value;
    });
    row.addEventListener("dblclick", () => {
      reset();
      dialRow.sync();
    });
    const dialRow: DialRow = {
      sync: () => {
        const color = read();
        value.textContent = color;
        if (document.activeElement !== input) input.value = color;
      },
      reset,
    };
    dialRow.sync();
    (this.refs.body.lastElementChild as HTMLElement).appendChild(row);
    this.rows.push(dialRow);
  }
}
