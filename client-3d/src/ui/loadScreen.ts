import type { TravelPlanet } from "./travel/travelSystem";
import { escapeXml, planetMapSvg, planetTagline } from "./travel/planetChart";

/**
 * Fullscreen planetfall load screen (owner spec 2026-07-05): shown on initial
 * world entry AND on every inter-planet jump — always for a couple of
 * seconds, even when the swap is instant, because arrival should feel like
 * ARRIVAL (and the first terrain bakes ride in behind it).
 *
 * Diegetic transit-authority framing: starfield void, the destination's
 * square survey chart, stencil name, tagline, an eased transit bar. The bar
 * is presentation (min-duration), not a real progress meter — honest enough
 * for a fiction where the shuttle does the waiting.
 *
 * One screen at a time; a new request replaces the current one instantly
 * (double-jumps never stack overlays). While active, the game input layer
 * gates on {@link isLoadScreenActive} (keydown only — keyups always pass so
 * a key held across a jump can never stick).
 */
export interface LoadScreenRequest {
  planet: TravelPlanet | null;
  /** Big label fallback when the catalog has no planet (boot before parse). */
  fallbackLabel?: string;
  /** "boot" = ENTERING THE FIELD; "travel" = MAKING PLANETFALL. */
  phase: "boot" | "travel";
  /** Visible hold before fade; default 2800ms. */
  minMs?: number;
}

const FADE_MS = 450;
const DEFAULT_MIN_MS = 2_800;

let activeOverlay: HTMLElement | null = null;
let activeToken = 0;

/** True while a load screen holds the frame — input layers gate on this. */
export function isLoadScreenActive(): boolean {
  return activeOverlay !== null && !activeOverlay.classList.contains("sc3d-loadscreen--fading");
}

export function presentLoadScreen(request: LoadScreenRequest): void {
  const token = ++activeToken;
  if (activeOverlay) {
    activeOverlay.remove();
    activeOverlay = null;
  }

  const overlay = document.createElement("div");
  overlay.className = "sc3d-loadscreen";
  const label = request.planet?.label ?? request.fallbackLabel ?? "SUCCESSOR";
  const phaseLine = request.phase === "boot" ? "ENTERING THE FIELD" : "MAKING PLANETFALL";
  const chart = request.planet
    ? planetMapSvg(request.planet, request.planet.cities[0]?.id ?? null)
    : `<div class="sc3d-loadscreen-nochart"></div>`;
  overlay.innerHTML = `
    <div class="sc3d-loadscreen-body">
      <div class="sc3d-loadscreen-chart">${chart}</div>
      <h1 class="sc3d-loadscreen-name">${escapeXml(label.toUpperCase())}</h1>
      <div class="sc3d-loadscreen-tag">${escapeXml(planetTagline(request.planet))}</div>
      <div class="sc3d-loadscreen-phase">${phaseLine}<span class="sc3d-loadscreen-dots"></span></div>
      <div class="sc3d-loadscreen-bar"><div class="sc3d-loadscreen-bar-fill"></div></div>
    </div>
  `;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  const minMs = Math.max(600, request.minMs ?? DEFAULT_MIN_MS);
  const fill = overlay.querySelector<HTMLElement>(".sc3d-loadscreen-bar-fill");
  if (fill) fill.style.animationDuration = `${minMs}ms`;

  window.setTimeout(() => {
    if (token !== activeToken || activeOverlay !== overlay) return;
    overlay.classList.add("sc3d-loadscreen--fading");
    window.setTimeout(() => {
      if (overlay.parentElement) overlay.remove();
      if (activeOverlay === overlay) activeOverlay = null;
    }, FADE_MS + 60);
  }, minMs);
}
