import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../../config";

export const TERRAIN_RULES_VERSION = 6;

export const enum TerrainKind {
  Desert = 0,
  Scrub = 1,
  Hardpan = 2,
}

// Anchored to the measured average of desert-ground-image2.png: rgb(208, 165, 92).
const DESERT_PALETTE = SUCCESSOR_3D_CONFIG.biomes.desert.palette;
const FOREST_PALETTE = SUCCESSOR_3D_CONFIG.biomes.forest.palette;
const DESERT_R = DESERT_PALETTE.desert[0];
const DESERT_G = DESERT_PALETTE.desert[1];
const DESERT_B = DESERT_PALETTE.desert[2];
const SCRUB_R = DESERT_PALETTE.scrub[0];
const SCRUB_G = DESERT_PALETTE.scrub[1];
const SCRUB_B = DESERT_PALETTE.scrub[2];
const HARDPAN_R = DESERT_PALETTE.hardpan[0];
const HARDPAN_G = DESERT_PALETTE.hardpan[1];
const HARDPAN_B = DESERT_PALETTE.hardpan[2];
const LOAM_R = FOREST_PALETTE.loam[0];
const LOAM_G = FOREST_PALETTE.loam[1];
const LOAM_B = FOREST_PALETTE.loam[2];
const MOSS_R = FOREST_PALETTE.moss[0];
const MOSS_G = FOREST_PALETTE.moss[1];
const MOSS_B = FOREST_PALETTE.moss[2];
const DUFF_R = FOREST_PALETTE.duff[0];
const DUFF_G = FOREST_PALETTE.duff[1];
const DUFF_B = FOREST_PALETTE.duff[2];

const UINT_TO_UNIT = 1 / 0xffffffff;
const TAU = Math.PI * 2;
const WIND_AXIS_RAD = (SUCCESSOR_3D_CONFIG.environment.wind.baseDirDeg * Math.PI) / 180;
const WIND_AXIS_X = Math.cos(WIND_AXIS_RAD);
const WIND_AXIS_Z = Math.sin(WIND_AXIS_RAD);
const WIND_ACROSS_X = -WIND_AXIS_Z;
const WIND_ACROSS_Z = WIND_AXIS_X;
const TERRAIN_TEXELS_PER_CELL = (SUCCESSOR_3D_CONFIG.terrain.texturePixels - 1) / SUCCESSOR_3D_CONFIG.terrain.chunkCells;

/**
 * Paint one deterministic terrain texel. All fields are sampled in WORLD
 * coordinates so adjacent chunks resolve the same colour at their shared edge.
 */
export function paintTerrainPixel(
  seed: number,
  worldX: number,
  worldZ: number,
  target: Uint8ClampedArray,
  offset: number,
  biome: SuccessorBiomeId = "desert",
): TerrainKind {
  if (biome === "forest") return paintForestTerrainPixel(seed, worldX, worldZ, target, offset);

  const macro = fbm(seed, worldX * 0.0045, worldZ * 0.0045, 0x2b01);
  const scrubField = fbm(seed, worldX * 0.018 + 37.17, worldZ * 0.018 - 19.31, 0x5107);
  // Existing 3-biome layout stays palette-led; surface v2 adds value language on top.
  const saltLong = fbm(seed, worldX * 0.0075 + worldZ * 0.0015, worldZ * 0.052, 0x91af);
  const saltFine = valueNoise(seed, worldX * 0.022, worldZ * 0.19, 0xbad5);
  const hardpanW = smoothstep(0.54, 0.73, saltLong * 0.82 + saltFine * 0.18 + (macro - 0.5) * 0.1);
  const scrubW = (1 - hardpanW) * smoothstep(0.56, 0.75, scrubField + (0.53 - macro) * 0.14);
  const desertW = Math.max(0, 1 - hardpanW - scrubW);

  const alongWind = worldX * WIND_AXIS_X + worldZ * WIND_AXIS_Z;
  const acrossWind = worldX * WIND_ACROSS_X + worldZ * WIND_ACROSS_Z;
  const fine = valueNoise(seed, worldX * 0.92, worldZ * 0.92, 0x7001) * 2 - 1;
  const gravel = gravelSpeckle(seed, worldX, worldZ) * (desertW + scrubW * 0.85);
  const striation = windStriation(seed, alongWind, acrossWind) * (desertW + scrubW * 0.62 + hardpanW * 0.25);
  const cracks = hardpanW > 0.34 ? hardpanCrack(seed, worldX, worldZ, hardpanW) : 0;
  const scrubTuft = scrubW > 0.18 && hashUnit(seed, Math.floor(worldX * 1.55), Math.floor(worldZ * 1.55), 0x7a11) > 0.82
    ? -10 * scrubW
    : 0;
  const hardpanMottle = (valueNoise(seed, worldX * 0.045, worldZ * 1.18, 0x55aa) - 0.5) * 5.5 * hardpanW;
  const valueScale = 1 + (macro - 0.5) * 0.062 + fine * 0.026 + gravel + striation + cracks;

  let r = (DESERT_R * desertW + SCRUB_R * scrubW + HARDPAN_R * hardpanW) * valueScale;
  let g = (DESERT_G * desertW + SCRUB_G * scrubW + HARDPAN_G * hardpanW) * valueScale;
  let b = (DESERT_B * desertW + SCRUB_B * scrubW + HARDPAN_B * hardpanW) * valueScale;

  // Add value-only surface cues: dry scrub flecks and hardpan salt mottling.
  r += scrubTuft + hardpanMottle;
  g += scrubTuft + hardpanMottle * 0.9;
  b += scrubTuft * 0.7 + hardpanMottle * 0.55;

  target[offset] = clampByte(r);
  target[offset + 1] = clampByte(g);
  target[offset + 2] = clampByte(b);
  target[offset + 3] = 255;

  if (hardpanW >= scrubW && hardpanW > 0.32) return TerrainKind.Hardpan;
  if (scrubW > 0.32) return TerrainKind.Scrub;
  return TerrainKind.Desert;
}
export function clearingMaskAt(seed: number, worldX: number, worldZ: number): number {
  const alongWind = worldX * WIND_AXIS_X + worldZ * WIND_AXIS_Z;
  const acrossWind = worldX * WIND_ACROSS_X + worldZ * WIND_ACROSS_Z;
  // Glade scale: ~90-cell wavelength (taste pass 2026-07-05 — the inherited
  // dune-field 0.0031 frequency made prairie-sized clearings; forest glades
  // are intimate: crossed in seconds, treeline always in sight).
  const field = fbm(seed, alongWind * 0.0115, acrossWind * 0.0115, 0x77aa);
  const groveBreakup = fbm(seed, alongWind * 0.0127 + 5.1, acrossWind * 0.0127 - 7.4, 0x77ab);
  return smoothstep(0.42, 0.66, field) * smoothstep(0.44, 0.72, groveBreakup);
}

function paintForestTerrainPixel(
  seed: number,
  worldX: number,
  worldZ: number,
  target: Uint8ClampedArray,
  offset: number,
): TerrainKind {
  const clearing = clearingMaskAt(seed, worldX, worldZ);
  const clearingBlend = smoothstep(0.34, 0.78, clearing);
  const canopy = 1 - clearingBlend;
  const macroShade = fbm(seed, worldX * 0.0065 + 13.7, worldZ * 0.0065 - 21.9, 0x4f31);
  const mossField = fbm(seed, worldX * 0.016 - 8.1, worldZ * 0.016 + 5.4, 0x8d22);
  const duffField = fbm(seed, worldX * 0.024 + 41.3, worldZ * 0.024 - 15.8, 0xa907);
  let mossW = 0.16 + mossField * 0.24 + clearingBlend * 0.14;
  let duffW = 0.28 + duffField * 0.28 + canopy * 0.16;
  let loamW = Math.max(0.18, 1 - mossW - duffW);
  const totalW = loamW + mossW + duffW;
  loamW /= totalW;
  mossW /= totalW;
  duffW /= totalW;

  const canopyR = LOAM_R * loamW + MOSS_R * mossW + DUFF_R * duffW;
  const canopyG = LOAM_G * loamW + MOSS_G * mossW + DUFF_G * duffW;
  const canopyB = LOAM_B * loamW + MOSS_B * mossW + DUFF_B * duffW;
  const clearingR = (MOSS_R * 0.78 + DUFF_R * 0.22) * 1.12;
  const clearingG = (MOSS_G * 0.84 + DUFF_G * 0.16) * 1.12;
  const clearingB = (MOSS_B * 0.82 + LOAM_B * 0.18) * 1.12;
  const clearMix = clearingBlend * 0.78;

  const leafDuffMottle = (valueNoise(seed, worldX * 0.075 + 3.7, worldZ * 0.075 - 2.9, 0xd4f1) - 0.5) * 0.1;
  const fineSpeckle = forestSpeckle(seed, worldX, worldZ);
  const rootVeins = rootVeinDark(seed, worldX, worldZ, canopy);
  const valueScale = 0.91 + (macroShade - 0.5) * 0.07 + clearingBlend * 0.13 + leafDuffMottle + fineSpeckle + rootVeins;

  target[offset] = clampByte(lerp(canopyR, clearingR, clearMix) * valueScale);
  target[offset + 1] = clampByte(lerp(canopyG, clearingG, clearMix) * valueScale);
  target[offset + 2] = clampByte(lerp(canopyB, clearingB, clearMix) * valueScale);
  target[offset + 3] = 255;

  if (clearingBlend > 0.58) return TerrainKind.Scrub;
  if (duffW >= mossW && duffW > 0.34) return TerrainKind.Hardpan;
  return TerrainKind.Desert;
}

function forestSpeckle(seed: number, worldX: number, worldZ: number): number {
  const texelX = Math.floor(worldX * TERRAIN_TEXELS_PER_CELL);
  const texelZ = Math.floor(worldZ * TERRAIN_TEXELS_PER_CELL);
  return (hashUnit(seed, texelX, texelZ, 0x3eaf) * 2 - 1) * 0.04;
}

function rootVeinDark(seed: number, worldX: number, worldZ: number, canopy: number): number {
  const cellX = worldX * 0.112;
  const cellZ = worldZ * 0.112;
  const xi = Math.floor(cellX);
  const zi = Math.floor(cellZ);
  let nearest = Infinity;
  let second = Infinity;
  let nearestCellX = xi;
  let nearestCellZ = zi;

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const candidateX = xi + dx;
      const candidateZ = zi + dz;
      const siteX = candidateX + hashUnit(seed, candidateX, candidateZ, 0x6a31) * 0.82 + 0.09;
      const siteZ = candidateZ + hashUnit(seed, candidateX, candidateZ, 0x6a32) * 0.82 + 0.09;
      const distX = siteX - cellX;
      const distZ = siteZ - cellZ;
      const dist = distX * distX + distZ * distZ;
      if (dist < nearest) {
        second = nearest;
        nearest = dist;
        nearestCellX = candidateX;
        nearestCellZ = candidateZ;
      } else if (dist < second) {
        second = dist;
      }
    }
  }

  if (hashUnit(seed, nearestCellX, nearestCellZ, 0x6a33) < 0.18) return 0;
  const edgeGap = Math.sqrt(second) - Math.sqrt(nearest);
  const vein = smoothstep(0.078, 0.024, edgeGap);
  return -0.08 * vein * smoothstep(0.18, 0.92, canopy);
}


function windStriation(seed: number, alongWind: number, acrossWind: number): number {
  // Macro dune-field mask: ripples live in FIELDS with calm flats between —
  // uniform corduroy across the whole desert read as a fingerprint (owner
  // taste pass, worldfeel v1). Low band keeps a whisper so flats stay sand.
  const field = fbm(seed, alongWind * 0.0031, acrossWind * 0.0031, 0x77aa);
  const fieldMask = 0.18 + 0.82 * smoothstep(0.42, 0.66, field);
  const wavelength = 6 + valueNoise(seed, alongWind * 0.006, acrossWind * 0.022, 0x6d51) * 8;
  const drift = (fbm(seed, alongWind * 0.018 + 9.7, acrossWind * 0.006 - 4.3, 0x72a9) - 0.5) * wavelength * 1.35;
  const phase = ((acrossWind + drift) / wavelength) * TAU;
  const ridged = Math.cos(phase) * 0.68 + Math.cos(phase * 2.0 + drift * 0.19) * 0.32;
  const amplitude = (0.06 + valueNoise(seed, alongWind * 0.011 - 2.1, acrossWind * 0.011 + 5.8, 0x3217) * 0.03) * fieldMask;
  return ridged * amplitude;
}

function gravelSpeckle(seed: number, worldX: number, worldZ: number): number {
  const texelX = Math.floor(worldX * TERRAIN_TEXELS_PER_CELL);
  const texelZ = Math.floor(worldZ * TERRAIN_TEXELS_PER_CELL);
  const raw = hashUnit(seed, texelX, texelZ, 0xf00d) * 2 - 1;
  return raw * 0.04;
}

function hardpanCrack(seed: number, worldX: number, worldZ: number, hardpanW: number): number {
  const cellX = worldX * 0.064;
  const cellZ = worldZ * 0.064;
  const xi = Math.floor(cellX);
  const zi = Math.floor(cellZ);
  let nearest = Infinity;
  let second = Infinity;
  let nearestCellX = xi;
  let nearestCellZ = zi;

  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const candidateX = xi + dx;
      const candidateZ = zi + dz;
      const siteX = candidateX + hashUnit(seed, candidateX, candidateZ, 0x9c21) * 0.74 + 0.13;
      const siteZ = candidateZ + hashUnit(seed, candidateX, candidateZ, 0xa17d) * 0.74 + 0.13;
      const distX = siteX - cellX;
      const distZ = siteZ - cellZ;
      const dist = distX * distX + distZ * distZ;
      if (dist < nearest) {
        second = nearest;
        nearest = dist;
        nearestCellX = candidateX;
        nearestCellZ = candidateZ;
      } else if (dist < second) {
        second = dist;
      }
    }
  }

  if (hashUnit(seed, nearestCellX, nearestCellZ, 0x4e11) < 0.42) return 0;
  const edgeGap = Math.sqrt(second) - Math.sqrt(nearest);
  const vein = smoothstep(0.072, 0.018, edgeGap);
  return -0.1 * vein * smoothstep(0.34, 0.78, hardpanW);
}

function fbm(seed: number, x: number, y: number, salt: number): number {
  const a = valueNoise(seed, x, y, salt);
  const b = valueNoise(seed, x * 2.03 + 17.2, y * 2.03 - 11.7, salt + 0x1f3d);
  const c = valueNoise(seed, x * 4.07 - 5.9, y * 4.07 + 23.1, salt + 0x3d79);
  return (a * 0.57 + b * 0.29 + c * 0.14);
}

function valueNoise(seed: number, x: number, y: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smootherstep(x - xi);
  const ty = smootherstep(y - yi);
  const a = hashUnit(seed, xi, yi, salt);
  const b = hashUnit(seed, xi + 1, yi, salt);
  const c = hashUnit(seed, xi, yi + 1, salt);
  const d = hashUnit(seed, xi + 1, yi + 1, salt);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function hashUnit(seed: number, x: number, y: number, salt: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = (h ^ (h >>> 15)) >>> 0;
  return h * UINT_TO_UNIT;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return smootherstep(t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampByte(value: number): number {
  return value <= 0 ? 0 : value >= 255 ? 255 : value + 0.5;
}
