import type { Palette } from "./panes/styles";
import { stringWidth, type Style, Surface } from "./term/surface";

export const INTRO_DURATION_MS = 10_500;

export const OPENING_CRAWL_LINES = [
  "DUSTGATE HOLDS THE DESERT MARGIN.",
  "ROADS AND RUSTED SHELLS LEAD OUT",
  "INTO COUNTRY THAT DOES NOT CARE",
  "WHETHER YOU ARE READY.",
  "",
  "YOU STEP ONTO THE ROAD",
  "WITH A NOVICE TRADE",
  "AND THE CLOTHES ON YOUR BACK.",
  "",
  "THE REST IS ALREADY OUT THERE.",
] as const;

const CRAWL_START_MS = 650;
const LINE_STEP_MS = 590;

function centeredX(width: number, text: string): number {
  return Math.max(0, Math.floor((width - stringWidth(text)) / 2));
}

function spreadWords(text: string, targetWidth: number): string {
  const words = text.split(" ");
  if (words.length < 2) return text;
  const letters = words.reduce((sum, word) => sum + stringWidth(word), 0);
  const spaces = Math.max(words.length - 1, targetWidth - letters);
  const base = Math.floor(spaces / (words.length - 1));
  let remainder = spaces % (words.length - 1);
  return words
    .map((word, index) => {
      if (index === words.length - 1) return word;
      const gap = base + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      return `${word}${" ".repeat(gap)}`;
    })
    .join("");
}

function crawlStyle(depth: number, palette: Palette): Style {
  if (depth < 0.28) return palette.faint;
  if (depth < 0.52) return palette.dim;
  if (depth < 0.78) return palette.brass;
  return palette.brassBold;
}

/**
 * Draw one frame of Successor's opening crawl. The virtual text plane
 * approaches from the terminal floor and compresses toward a hard horizon;
 * it needs no DOM, canvas, image, or GPU.
 */
export function renderOpeningCrawl(
  surface: Surface,
  elapsedMs: number,
  palette: Palette,
): void {
  surface.clear(palette.canvas);
  const width = surface.width;
  const height = surface.height;
  if (width === 0 || height === 0) return;

  // Fixed dust gives the empty canvas some depth without turning it into art
  // the terminal cannot reproduce.
  for (let y = 1; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x * 17 + y * 31) % 113 === 0) surface.set(x, y, "·", palette.faint);
    }
  }

  const title = "SUCCESSOR";
  surface.text(centeredX(width, title), 1, title, palette.inkBold);
  if (height > 4) {
    const horizonWidth = Math.max(8, Math.min(width - 4, 42));
    const horizonX = Math.floor((width - horizonWidth) / 2);
    surface.hline(horizonX, 3, horizonWidth, palette.frame, "─");
  }

  const horizonY = Math.min(4, Math.max(2, height - 2));
  const floorY = Math.max(horizonY + 1, height - 2);
  const planeWidth = Math.max(18, Math.min(64, width - 4));
  const occupied = new Set<number>();

  OPENING_CRAWL_LINES.forEach((line, index) => {
    if (line.length === 0) return;
    const enteredAt = CRAWL_START_MS + index * LINE_STEP_MS;
    const ageSeconds = (elapsedMs - enteredAt) / 1_000;
    if (ageSeconds < 0) return;
    const depth = 1 / (1 + ageSeconds * 0.62);
    const y = Math.round(horizonY + depth * (floorY - horizonY));
    if (y <= horizonY || y >= height || occupied.has(y)) return;
    occupied.add(y);
    const targetWidth = Math.max(
      stringWidth(line),
      Math.floor(18 + depth * Math.max(0, planeWidth - 18)),
    );
    const projected = spreadWords(line, targetWidth);
    surface.text(centeredX(width, projected), y, projected, crawlStyle(depth, palette));
  });

  if (elapsedMs < 1_800 && height > 2) {
    const prompt = "ANY KEY TO ENTER";
    surface.text(centeredX(width, prompt), height - 1, prompt, palette.dim);
  }
}
