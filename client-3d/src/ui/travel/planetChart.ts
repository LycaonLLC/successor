import type { TravelPlanet } from "./travelSystem";
import { cityMapPosition } from "./travelSystem";

/**
 * Stylized square planetary chart — shared by the TRAVEL window and the
 * planet load screen. Diegetic-cartographic: biome-toned field, survey grid,
 * terrain glyphs (dune arcs / canopy rounds), city markers with a selection
 * ring. Pure SVG string; server-authored strings are XML-escaped.
 */
export function planetMapSvg(planet: TravelPlanet, selectedCityId: string | null): string {
  const forest = planet.biome === "forest";
  const field = forest ? "#22301f" : "#4a3d28";
  const fieldEdge = forest ? "#2e4029" : "#5d4d32";
  const glyph = forest ? "#395430" : "#6b5738";
  const glyphDim = forest ? "#2c4426" : "#584730";
  const grid = forest ? "#3c5535" : "#6b5c3e";
  const parts: string[] = [];
  parts.push(`<svg class="scp-travel-chart" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">`);
  parts.push(`<rect x="1.5" y="1.5" width="97" height="97" rx="2.5" fill="${field}" stroke="${fieldEdge}" stroke-width="1"/>`);

  for (let i = 1; i < 5; i += 1) {
    const p = 1.5 + (97 / 5) * i;
    parts.push(`<line x1="${p}" y1="3" x2="${p}" y2="97" stroke="${grid}" stroke-width="0.35" opacity="0.6"/>`);
    parts.push(`<line x1="3" y1="${p}" x2="97" y2="${p}" stroke="${grid}" stroke-width="0.35" opacity="0.6"/>`);
  }

  let seed = 0;
  for (let i = 0; i < planet.id.length; i += 1) seed = (seed * 31 + planet.id.charCodeAt(i)) >>> 0;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  if (forest) {
    for (let i = 0; i < 26; i += 1) {
      const x = 8 + rand() * 84;
      const y = 8 + rand() * 84;
      const r = 2 + rand() * 4.5;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${rand() > 0.5 ? glyph : glyphDim}" opacity="0.75"/>`);
    }
  } else {
    for (let i = 0; i < 12; i += 1) {
      const x = 6 + rand() * 70;
      const y = 10 + rand() * 80;
      const w = 14 + rand() * 22;
      const bow = 2.5 + rand() * 4;
      parts.push(`<path d="M ${x.toFixed(1)} ${y.toFixed(1)} q ${(w / 2).toFixed(1)} ${-bow.toFixed(1)} ${w.toFixed(1)} 0" fill="none" stroke="${rand() > 0.5 ? glyph : glyphDim}" stroke-width="0.9" opacity="0.8"/>`);
    }
  }

  for (const city of planet.cities) {
    const pos = cityMapPosition(city.id);
    const x = 3 + pos.x * 94;
    const y = 3 + pos.y * 94;
    const selected = city.id === selectedCityId;
    parts.push(`<g class="scp-travel-city${selected ? " scp-travel-city--selected" : ""}" data-city="${escapeXml(city.id)}">`);
    if (selected) parts.push(`<circle cx="${x}" cy="${y}" r="5.2" fill="none" stroke="var(--sc3d-accent)" stroke-width="0.9"/>`);
    parts.push(`<circle cx="${x}" cy="${y}" r="2.1" fill="var(--sc3d-accent)"/>`);
    parts.push(`<text x="${x}" y="${(y - 6.5).toFixed(1)}" text-anchor="middle" class="scp-travel-city-label">${escapeXml(city.label.toUpperCase())}</text>`);
    parts.push(`</g>`);
  }

  parts.push(`<text x="5" y="9.5" class="scp-travel-chart-title">${escapeXml(planet.label.toUpperCase())}</text>`);
  parts.push(`<text x="95" y="95" text-anchor="end" class="scp-travel-chart-note">${planet.biome === "forest" ? "CANOPY WORLD" : "DUST WORLD"}</text>`);
  parts.push(`</svg>`);
  return parts.join("");
}

/** Biome tagline used by the chart corner note and the load screen. */
export function planetTagline(planet: TravelPlanet | null): string {
  if (!planet) return "UNCHARTED";
  return planet.biome === "forest" ? "CANOPY WORLD" : "DUST WORLD";
}

/** Server-authored strings ride innerHTML SVG — escape them (labels, ids). */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
