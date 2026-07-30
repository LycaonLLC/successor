import { FX_CONFIG } from "../../../render/fx/config";
import { BLOOD_PALETTE_IDS } from "../../../render/fx/config";
import { HIT_STYLE_IDS } from "../../../render/fx/hits";
import { BEAM_FX_IDS } from "../../../render/fx/beams";
import { POWER_FX_IDS } from "../../../render/fx/powers";
import { STATUS_FX_IDS } from "../../../render/fx/status";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * FX LAB — live effects showcase (owner request 2026-07-08: "how can me
 * preview all the things you just made").
 *
 * One button per bolt style, impact archetype and shield mode, all
 * driving the CombatFx demo hooks (`window.__successorFx`) — the exact rig
 * the visual verification harness uses. Presentation-only: every effect is
 * pooled client FX; no authority commands, no sim mutation, safe to spam.
 *
 * FULL SHOW runs a short choreographed sequence (shield pop → new-style
 * volleys → impact ring → formfit finale). Pending timeouts are tracked and
 * cleared on re-trigger/dispose per the demo-hook hygiene convention
 * (fx/index.ts psgTest precedent).
 */

import { FX_LAB_WINDOW_ID, fxLabRequested } from "./fxLabWindowIds";
export { FX_LAB_WINDOW_ID, fxLabRequested };
type FxHooks = NonNullable<Window["__successorFx"]>;

export function createFxLabWindowDefinition(): WindowDefinition {
  return {
    id: FX_LAB_WINDOW_ID,
    title: "FX LAB",
    icon: "fx",
    hotkey: null,
    // Even behind the dev flag the lab never takes a rail button; the flag
    // conditionally adds it to the `/ui` allow list in the composition root.
    dockVisible: false,
    minWidth: 300,
    minHeight: 340,
    // r2: own identity glyph (was borrowing the Attack crosshair), default
    // clear of the radar box at 1920, taller so fewer sections hide below
    // the fold (the manager's scroll cue covers the rest) — fe-polish P0.
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 340;
      const h = Math.min(640, Math.round(viewport.h * 0.78));
      return { x: Math.max(12, viewport.w - w - 200), y: 88, w, h };
    },
    mount: mountFxLabContent,
  };
}

function mountFxLabContent(contentRoot: HTMLElement, _ctx: WindowContext): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "scp-root scp-fxlab";
  const pendingTimeouts: number[] = [];
  const clearPending = (): void => {
    for (const id of pendingTimeouts) window.clearTimeout(id);
    pendingTimeouts.length = 0;
  };
  const later = (fn: () => void, delayMs: number): void => {
    pendingTimeouts.push(window.setTimeout(fn, delayMs));
  };
  const hooks = (): FxHooks | null => window.__successorFx ?? null;
  const allButtons: HTMLButtonElement[] = [];

  const section = (title: string, hint: string): { el: HTMLElement; grid: HTMLElement } => {
    const el = document.createElement("section");
    el.className = "scp-section";
    const h = document.createElement("h3");
    h.className = "scp-section-title";
    h.textContent = title;
    h.title = hint;
    const grid = document.createElement("div");
    grid.className = "scp-fx-grid";
    el.append(h, grid);
    return { el, grid };
  };

  const button = (grid: HTMLElement, label: string, hint: string, fire: (fx: FxHooks) => void): void => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scp-rebind-btn scp-fx-btn";
    btn.textContent = label;
    btn.title = hint;
    btn.addEventListener("click", () => {
      const fx = hooks();
      if (fx) fire(fx);
    });
    allButtons.push(btn);
    grid.appendChild(btn);
  };

  // ── BOLTS — one fan per style, straight from the live style table ────────
  const bolts = section("BOLTS", "Fans six cosmetic test rounds of the style from your muzzle");
  const styleIds = Object.keys(FX_CONFIG.boltStyles);
  for (const styleId of styleIds) {
    button(bolts.grid, styleId.toUpperCase(), `boltTest("${styleId}")`, (fx) => fx.boltTest(styleId));
  }
  button(bolts.grid, "VOLLEY ALL", "Every style, staggered volleys", (fx) => {
    clearPending();
    styleIds.forEach((styleId, i) => later(() => fx.boltTest(styleId), i * 160));
  });

  // ── IMPACTS — the styled hit archetypes, rung around the pawn ────────────
  const impacts = section("IMPACTS", "Rings the player with the impact archetype");
  for (const hit of HIT_STYLE_IDS) {
    button(impacts.grid, hit.toUpperCase(), `hitTest("${hit}")`, (fx) => fx.hitTest(hit));
  }
  button(impacts.grid, "RING ALL", "One of each archetype at once", (fx) => fx.hitTest());

  // ── STATUS — the state-effect language (blind/bleed/poison/.../bigheal) ──
  const status = section("STATUS", "State-effect transients popped on your pawn (bleed also fires in real combat)");
  for (const st of STATUS_FX_IDS) {
    button(status.grid, st.toUpperCase(), `statusTest("${st}")`, (fx) => fx.statusTest(st));
  }
  button(status.grid, "ALL STATES", "The whole language ringed around you", (fx) => fx.statusTest());

  // ── BLOOD — red organic, green alien/toxic, blue synthetic/coolant ──────
  const blood = section("BLOOD", "On-hit blood + persistent ground residue, per species palette");
  for (const paletteId of BLOOD_PALETTE_IDS) {
    button(blood.grid, paletteId.toUpperCase(), `bloodTest("${paletteId}")`, (fx) => fx.bloodTest(paletteId));
  }
  button(blood.grid, "ALL THREE", "Red, green, blue ringed for comparison", (fx) => fx.bloodTest());

  // ── POWERS — force-power showcase (lightning/push/channel/healcast) ──────
  const powers = section("POWERS", "Caster-driven power effects fired from your pawn");
  for (const pw of POWER_FX_IDS) {
    button(powers.grid, pw.toUpperCase(), `powerTest("${pw}")`, (fx) => fx.powerTest(pw));
  }
  button(powers.grid, "ALL POWERS", "All four fanned from your pawn", (fx) => fx.powerTest());

  // ── BEAMS — full-line weapon effects (arcbeam/pulsebeam/searbeam) ────────
  const beams = section("BEAMS", "Line weapon effects fired from your pawn");
  for (const bm of BEAM_FX_IDS) {
    button(beams.grid, bm.toUpperCase(), `beamTest("${bm}")`, (fx) => fx.beamTest(bm));
  }
  button(beams.grid, "ALL BEAMS", "All three fanned", (fx) => fx.beamTest());

  // ── WORLD — persistent environment effects ───────────────────────────────
  const world = section("WORLD", "Always-on environment effects");
  button(world.grid, "CAMPFIRE", "Toggle an always-on campfire beside you", (fx) => fx.campfireTest());

  // ── SABER — deflect read: bolt dies on the blade + reflects ─────────────
  const saber = section("SABER", "Saber-block deflect: incoming bolt intercepted at your blade");
  button(saber.grid, "DEFLECT", "One incoming bolt deflected off your blade", (fx) => fx.deflectTest());

  // ── POSES — AnimSmith pack: base loops toggle, gestures one-shot ─────────
  const poses = section("POSES", "Pose/gesture clips on your pawn (base loops toggle on/off)");
  for (const clip of ["meditate_loop", "kneel_loop", "cast_aoe", "cast_directed_windup", "cast_directed_loop", "stim_inject"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scp-rebind-btn scp-fx-btn";
    btn.textContent = clip.replace(/_/g, " ").toUpperCase();
    btn.title = `__successorPawns.poseTest("${clip}")`;
    btn.addEventListener("click", () => { window.__successorPawns?.poseTest(clip); });
    allButtons.push(btn);
    poses.grid.appendChild(btn);
  }

  // ── PLASMA — the bladeless sword; cycles colors per press ────────────────
  const plasma = section("PLASMA BLADE", "Pure-effect blade on your sword hilt — press to cycle colors, full cycle turns it off");
  {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scp-rebind-btn scp-fx-btn";
    btn.textContent = "CYCLE BLADE";
    btn.title = "__successorPawns.plasmaBladePreview()";
    btn.addEventListener("click", () => { window.__successorPawns?.plasmaBladePreview(); });
    allButtons.push(btn);
    plasma.grid.appendChild(btn);
  }

  // ── SHIELD — both PSG bodies; CLEAN = charge pinned at full (no decay) ───
  const shield = section("SHIELD", "Pops the Personal Shield Generator on your pawn");
  button(shield.grid, "BUBBLE", "Triple-ripple combat demo, charge decays to ember", (fx) => fx.psgTest("bubble"));
  button(shield.grid, "FORMFIT", "Body-conforming shell, triple ripple", (fx) => fx.psgTest("formfit"));
  button(shield.grid, "BUBBLE CLEAN", "Full-charge cyan, single pop", (fx) => fx.psgTest("bubble", true));
  button(shield.grid, "FORMFIT CLEAN", "Full-charge cyan, single pop", (fx) => fx.psgTest("formfit", true));

  // ── SHOWCASE — the choreographed reel ────────────────────────────────────
  const showcase = section("SHOWCASE", "Runs the whole set as one sequence");
  button(showcase.grid, "FULL SHOW", "Shield pop, every bolt style, every impact, formfit finale", (fx) => {
    clearPending();
    // Bubble pop, then EVERY bolt style volleys in table order, then every
    // impact archetype rings, then the formfit finale. ~6s total.
    fx.psgTest("bubble", true);
    styleIds.forEach((styleId, i) => later(() => fx.boltTest(styleId), 700 + i * 180));
    const hitsAt = 700 + styleIds.length * 180 + 500;
    HIT_STYLE_IDS.forEach((hit, i) => {
      later(() => fx.hitTest(hit), hitsAt + i * 320);
    });
    const statesAt = hitsAt + HIT_STYLE_IDS.length * 320 + 400;
    later(() => fx.statusTest(), statesAt);
    later(() => fx.powerTest(), statesAt + 1500);
    later(() => fx.beamTest(), statesAt + 2600);
    later(() => fx.psgTest("formfit", true), statesAt + 4000);
  });

  // ── POST — the shader-side dials the FX were tuned against ──────────────
  const post = section("POST / SHADER", "Live post-pass dials — see how effects read under the grade");
  const dial = (label: string, hint: string, key: "chromaGuard" | "bloomStrength", max: number, step: number): (() => void) => {
    const row = document.createElement("div");
    row.className = "scp-row";
    row.innerHTML = `
      <span class="scp-label" title="${hint}">${label}</span>
      <input class="scp-range" type="range" min="0" max="${max}" step="${step}" aria-label="${label}" />
      <span class="scp-value">—</span>
    `;
    const input = row.querySelector<HTMLInputElement>("input")!;
    const value = row.querySelector<HTMLElement>(".scp-value")!;
    input.addEventListener("input", () => {
      const dials = window.__successor3dPost;
      if (dials) dials[key] = Number(input.value);
    });
    post.el.appendChild(row);
    return () => {
      const dials = window.__successor3dPost;
      if (!dials) return;
      const current = dials[key];
      value.textContent = current.toFixed(2);
      if (document.activeElement !== input) input.value = String(current);
    };
  };
  const refreshDials = [
    dial("CHROMA GUARD", "Signature-FX chroma guard: saturated effect colours (PSG cyan, tracer heat) shed less of the grade's desaturation. 0 = ratified legacy grade.", "chromaGuard", 1, 0.05),
    dial("BLOOM", "Bloom strength multiplier over the ToD anchor — rim/ripple crests are tuned to trip the extract.", "bloomStrength", 2, 0.1),
  ];

  const note = document.createElement("p");
  note.className = "scp-fx-note";
  note.textContent = "Presentation-only test rig — no ammo, no damage, no server commands.";
  root.append(bolts.el, impacts.el, blood.el, status.el, powers.el, beams.el, world.el, saber.el, poses.el, plasma.el, shield.el, showcase.el, post.el, note);
  contentRoot.appendChild(root);

  return {
    update(): void {
      // Hooks appear once CombatFx boots with the renderer; gate until then.
      const ready = hooks() !== null;
      for (const btn of allButtons) btn.disabled = !ready;
      for (const refresh of refreshDials) refresh();
    },
    onResized(): void {},
    dispose(): void {
      clearPending();
      root.remove();
    },
  };
}
