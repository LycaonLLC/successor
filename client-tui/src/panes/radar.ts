/**
 * RADAR — the braille scope + contacts list.
 *
 * Same data contract as the 3D scope: streamed actors classified hostile/
 * alerted/civilian, 96-cell radius, north-up world compass basis, rim-clamp
 * for out-of-range hostiles. Drawn as braille dots over faint range rings;
 * under it, the nearest contacts with projected bearing + distance. Waypoints
 * are the registry's local store when SP3/waypoint adoption lands — v1 plots
 * contacts and self only.
 */

import { RADAR_RADIUS_CELLS, worldCompassVector, windShort, windFor } from "../game/bearing";
import type { Contact } from "../game/contacts";
import { BrailleCanvas, type Surface, type Style } from "../term/surface";
import type { Palette, Rect } from "./styles";

/** tag ordering: higher wins the cell's ink. */
const TAG_RING = 0;
const TAG_CIV = 1;
const TAG_ALERT = 2;
const TAG_HOSTILE = 3;
const TAG_SELF = 4;

export function renderRadar(surface: Surface, rect: Rect, contacts: readonly Contact[], palette: Palette): void {
  const scopeRows = Math.max(0, Math.min(rect.h - 1, Math.floor(rect.w / 2 / 2)));
  if (scopeRows >= 4) {
    renderScope(surface, { ...rect, h: scopeRows }, contacts, palette);
  }
  renderContactList(surface, { ...rect, y: rect.y + scopeRows, h: rect.h - scopeRows }, contacts, palette);
}

function renderScope(surface: Surface, rect: Rect, contacts: readonly Contact[], palette: Palette): void {
  const cols = Math.min(rect.w, rect.h * 2); // braille cell ≈ 2:1 aspect → circle
  const canvas = new BrailleCanvas(cols, rect.h);
  const cx = canvas.dotWidth / 2;
  const cy = canvas.dotHeight / 2;
  const radius = Math.min(cx, cy) - 1;

  // range rings at 1/3, 2/3, full scope — dotted whisper
  for (const ringFrac of [1 / 3, 2 / 3, 1]) {
    const r = radius * ringFrac;
    const step = ringFrac === 1 ? 0.05 : 0.22;
    for (let a = 0; a < Math.PI * 2; a += step) {
      canvas.dot(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.95), TAG_RING);
    }
  }

  const scale = radius / RADAR_RADIUS_CELLS;
  for (const contact of contacts) {
    const bearing = worldCompassVector(contact.dx, contact.dy);
    let ex = bearing.east;
    let ny = bearing.north;
    if (contact.rimClamped) {
      const clamp = RADAR_RADIUS_CELLS / contact.dCells;
      ex *= clamp;
      ny *= clamp;
    }
    const dx = cx + ex * scale;
    const dy = cy - ny * scale; // screen up = +north
    const tag = contact.relation === "hostile" ? TAG_HOSTILE : contact.relation === "alerted" ? TAG_ALERT : TAG_CIV;
    canvas.dot(Math.round(dx), Math.round(dy), tag);
    if (!contact.rimClamped && contact.relation === "hostile") {
      // hostiles read as a 2-dot blip so they carry weight at a glance
      canvas.dot(Math.round(dx) + 1, Math.round(dy), tag);
    }
  }
  // self: solid 4-dot anchor at center
  canvas.dot(Math.round(cx), Math.round(cy), TAG_SELF);
  canvas.dot(Math.round(cx) + 1, Math.round(cy), TAG_SELF);
  canvas.dot(Math.round(cx), Math.round(cy) + 1, TAG_SELF);
  canvas.dot(Math.round(cx) + 1, Math.round(cy) + 1, TAG_SELF);

  const xOffset = rect.x + Math.max(0, Math.floor((rect.w - cols) / 2));
  canvas.blit(surface, xOffset, rect.y, (tag): Style => {
    switch (tag) {
      case TAG_SELF: return palette.accentBold;
      case TAG_HOSTILE: return palette.dangerBold;
      case TAG_ALERT: return palette.amber;
      case TAG_CIV: return palette.dim;
      default: return palette.faint;
    }
  });
  // N tick above the scope circle
  surface.text(xOffset + Math.floor(cols / 2), rect.y, "N", palette.accent);
}

function renderContactList(surface: Surface, rect: Rect, contacts: readonly Contact[], palette: Palette): void {
  let y = rect.y;
  if (contacts.length === 0) {
    if (rect.h > 0) surface.text(rect.x, y, "scope clear", palette.faint);
    return;
  }
  for (const contact of contacts) {
    if (y >= rect.y + rect.h) break;
    const glyph = contact.relation === "hostile" ? "▲" : contact.relation === "alerted" ? "◆" : "·";
    const glyphStyle = contact.relation === "hostile" ? palette.dangerBold : contact.relation === "alerted" ? palette.amber : palette.dim;
    surface.text(rect.x, y, glyph, glyphStyle);
    const range = contact.rimClamped ? ">96c" : `${Math.round(contact.dCells)}c`;
    const tail = ` ${windShort(windFor(contact.dx, contact.dy)).padStart(2)} ${range.padStart(4)}`;
    const nameWidth = rect.w - tail.length - 2;
    const name = contact.label.length > nameWidth ? `${contact.label.slice(0, Math.max(1, nameWidth - 1))}…` : contact.label;
    surface.text(rect.x + 2, y, name, contact.relation === "hostile" ? palette.ink : palette.dim, rect.x + rect.w - tail.length);
    surface.text(rect.x + rect.w - tail.length, y, tail, palette.faint);
    y += 1;
  }
}
