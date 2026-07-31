// Terrain fixture generator — a VERBATIM copy of the desert/forest painters in
// client-3d/src/render/terrain/procgen.ts (TERRAIN_RULES_VERSION 6) with the
// config.ts constants inlined. Its output pins the Rust port byte-for-byte.
//
// Regenerate:
//   node tools/successor/dump-terrain-fixture.mjs > \
//     client-rust/source/app/src/world/terrain_fixture.json
//
// Keep this file in lockstep with procgen.ts; if the TS painter changes, copy
// the change here and regenerate, then the Rust `matches_reference_fixture`
// test enforces parity.

const DESERT = [208, 165, 92];
const SCRUB = [188, 151, 84];
const HARDPAN = [224, 190, 124];
const LOAM = [128, 110, 78];
const MOSS = [110, 130, 78];
const DUFF = [150, 128, 86];

const UINT_TO_UNIT = 1 / 0xffffffff;
const TAU = Math.PI * 2;
const WIND_AXIS_RAD = (115 * Math.PI) / 180;
const WIND_AXIS_X = Math.cos(WIND_AXIS_RAD);
const WIND_AXIS_Z = Math.sin(WIND_AXIS_RAD);
const WIND_ACROSS_X = -WIND_AXIS_Z;
const WIND_ACROSS_Z = WIND_AXIS_X;
const TERRAIN_TEXELS_PER_CELL = (1024 - 1) / 256;

function paintTerrainPixel(seed, worldX, worldZ, target, offset, biome) {
  if (biome === "forest") return paintForestTerrainPixel(seed, worldX, worldZ, target, offset);
  const macro = fbm(seed, worldX * 0.0045, worldZ * 0.0045, 0x2b01);
  const scrubField = fbm(seed, worldX * 0.018 + 37.17, worldZ * 0.018 - 19.31, 0x5107);
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
  const scrubTuft = scrubW > 0.18 && hashUnit(seed, Math.floor(worldX * 1.55), Math.floor(worldZ * 1.55), 0x7a11) > 0.82 ? -10 * scrubW : 0;
  const hardpanMottle = (valueNoise(seed, worldX * 0.045, worldZ * 1.18, 0x55aa) - 0.5) * 5.5 * hardpanW;
  const valueScale = 1 + (macro - 0.5) * 0.062 + fine * 0.026 + gravel + striation + cracks;
  let r = (DESERT[0] * desertW + SCRUB[0] * scrubW + HARDPAN[0] * hardpanW) * valueScale;
  let g = (DESERT[1] * desertW + SCRUB[1] * scrubW + HARDPAN[1] * hardpanW) * valueScale;
  let b = (DESERT[2] * desertW + SCRUB[2] * scrubW + HARDPAN[2] * hardpanW) * valueScale;
  r += scrubTuft + hardpanMottle;
  g += scrubTuft + hardpanMottle * 0.9;
  b += scrubTuft * 0.7 + hardpanMottle * 0.55;
  target[offset] = clampByte(r);
  target[offset + 1] = clampByte(g);
  target[offset + 2] = clampByte(b);
  target[offset + 3] = 255;
  if (hardpanW >= scrubW && hardpanW > 0.32) return 2;
  if (scrubW > 0.32) return 1;
  return 0;
}
function clearingMaskAt(seed, worldX, worldZ) {
  const alongWind = worldX * WIND_AXIS_X + worldZ * WIND_AXIS_Z;
  const acrossWind = worldX * WIND_ACROSS_X + worldZ * WIND_ACROSS_Z;
  const field = fbm(seed, alongWind * 0.0115, acrossWind * 0.0115, 0x77aa);
  const groveBreakup = fbm(seed, alongWind * 0.0127 + 5.1, acrossWind * 0.0127 - 7.4, 0x77ab);
  return smoothstep(0.42, 0.66, field) * smoothstep(0.44, 0.72, groveBreakup);
}
function paintForestTerrainPixel(seed, worldX, worldZ, target, offset) {
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
  loamW /= totalW; mossW /= totalW; duffW /= totalW;
  const canopyR = LOAM[0] * loamW + MOSS[0] * mossW + DUFF[0] * duffW;
  const canopyG = LOAM[1] * loamW + MOSS[1] * mossW + DUFF[1] * duffW;
  const canopyB = LOAM[2] * loamW + MOSS[2] * mossW + DUFF[2] * duffW;
  const clearingR = (MOSS[0] * 0.78 + DUFF[0] * 0.22) * 1.12;
  const clearingG = (MOSS[1] * 0.84 + DUFF[1] * 0.16) * 1.12;
  const clearingB = (MOSS[2] * 0.82 + LOAM[2] * 0.18) * 1.12;
  const clearMix = clearingBlend * 0.78;
  const leafDuffMottle = (valueNoise(seed, worldX * 0.075 + 3.7, worldZ * 0.075 - 2.9, 0xd4f1) - 0.5) * 0.1;
  const fineSpeckle = forestSpeckle(seed, worldX, worldZ);
  const rootVeins = rootVeinDark(seed, worldX, worldZ, canopy);
  const valueScale = 0.91 + (macroShade - 0.5) * 0.07 + clearingBlend * 0.13 + leafDuffMottle + fineSpeckle + rootVeins;
  target[offset] = clampByte(lerp(canopyR, clearingR, clearMix) * valueScale);
  target[offset + 1] = clampByte(lerp(canopyG, clearingG, clearMix) * valueScale);
  target[offset + 2] = clampByte(lerp(canopyB, clearingB, clearMix) * valueScale);
  target[offset + 3] = 255;
  if (clearingBlend > 0.58) return 1;
  if (duffW >= mossW && duffW > 0.34) return 2;
  return 0;
}
function forestSpeckle(seed, worldX, worldZ) {
  const texelX = Math.floor(worldX * TERRAIN_TEXELS_PER_CELL);
  const texelZ = Math.floor(worldZ * TERRAIN_TEXELS_PER_CELL);
  return (hashUnit(seed, texelX, texelZ, 0x3eaf) * 2 - 1) * 0.04;
}
function rootVeinDark(seed, worldX, worldZ, canopy) {
  const cellX = worldX * 0.112, cellZ = worldZ * 0.112;
  const xi = Math.floor(cellX), zi = Math.floor(cellZ);
  let nearest = Infinity, second = Infinity, nearestCellX = xi, nearestCellZ = zi;
  for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const cX = xi + dx, cZ = zi + dz;
    const siteX = cX + hashUnit(seed, cX, cZ, 0x6a31) * 0.82 + 0.09;
    const siteZ = cZ + hashUnit(seed, cX, cZ, 0x6a32) * 0.82 + 0.09;
    const dX = siteX - cellX, dZ = siteZ - cellZ, dist = dX * dX + dZ * dZ;
    if (dist < nearest) { second = nearest; nearest = dist; nearestCellX = cX; nearestCellZ = cZ; }
    else if (dist < second) { second = dist; }
  }
  if (hashUnit(seed, nearestCellX, nearestCellZ, 0x6a33) < 0.18) return 0;
  const edgeGap = Math.sqrt(second) - Math.sqrt(nearest);
  const vein = smoothstep(0.078, 0.024, edgeGap);
  return -0.08 * vein * smoothstep(0.18, 0.92, canopy);
}
function windStriation(seed, alongWind, acrossWind) {
  const field = fbm(seed, alongWind * 0.0031, acrossWind * 0.0031, 0x77aa);
  const fieldMask = 0.18 + 0.82 * smoothstep(0.42, 0.66, field);
  const wavelength = 6 + valueNoise(seed, alongWind * 0.006, acrossWind * 0.022, 0x6d51) * 8;
  const drift = (fbm(seed, alongWind * 0.018 + 9.7, acrossWind * 0.006 - 4.3, 0x72a9) - 0.5) * wavelength * 1.35;
  const phase = ((acrossWind + drift) / wavelength) * TAU;
  const ridged = Math.cos(phase) * 0.68 + Math.cos(phase * 2.0 + drift * 0.19) * 0.32;
  const amplitude = (0.06 + valueNoise(seed, alongWind * 0.011 - 2.1, acrossWind * 0.011 + 5.8, 0x3217) * 0.03) * fieldMask;
  return ridged * amplitude;
}
function gravelSpeckle(seed, worldX, worldZ) {
  const texelX = Math.floor(worldX * TERRAIN_TEXELS_PER_CELL);
  const texelZ = Math.floor(worldZ * TERRAIN_TEXELS_PER_CELL);
  const raw = hashUnit(seed, texelX, texelZ, 0xf00d) * 2 - 1;
  return raw * 0.04;
}
function hardpanCrack(seed, worldX, worldZ, hardpanW) {
  const cellX = worldX * 0.064, cellZ = worldZ * 0.064;
  const xi = Math.floor(cellX), zi = Math.floor(cellZ);
  let nearest = Infinity, second = Infinity, nearestCellX = xi, nearestCellZ = zi;
  for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) {
    const cX = xi + dx, cZ = zi + dz;
    const siteX = cX + hashUnit(seed, cX, cZ, 0x9c21) * 0.74 + 0.13;
    const siteZ = cZ + hashUnit(seed, cX, cZ, 0xa17d) * 0.74 + 0.13;
    const dX = siteX - cellX, dZ = siteZ - cellZ, dist = dX * dX + dZ * dZ;
    if (dist < nearest) { second = nearest; nearest = dist; nearestCellX = cX; nearestCellZ = cZ; }
    else if (dist < second) { second = dist; }
  }
  if (hashUnit(seed, nearestCellX, nearestCellZ, 0x4e11) < 0.42) return 0;
  const edgeGap = Math.sqrt(second) - Math.sqrt(nearest);
  const vein = smoothstep(0.072, 0.018, edgeGap);
  return -0.1 * vein * smoothstep(0.34, 0.78, hardpanW);
}
function fbm(seed, x, y, salt) {
  const a = valueNoise(seed, x, y, salt);
  const b = valueNoise(seed, x * 2.03 + 17.2, y * 2.03 - 11.7, salt + 0x1f3d);
  const c = valueNoise(seed, x * 4.07 - 5.9, y * 4.07 + 23.1, salt + 0x3d79);
  return a * 0.57 + b * 0.29 + c * 0.14;
}
function valueNoise(seed, x, y, salt) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smootherstep(x - xi), ty = smootherstep(y - yi);
  const a = hashUnit(seed, xi, yi, salt);
  const b = hashUnit(seed, xi + 1, yi, salt);
  const c = hashUnit(seed, xi, yi + 1, salt);
  const d = hashUnit(seed, xi + 1, yi + 1, salt);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}
function hashUnit(seed, x, y, salt) {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = (h ^ (h >>> 15)) >>> 0;
  return h * UINT_TO_UNIT;
}
function smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return smootherstep(t);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function clampByte(value) { return value <= 0 ? 0 : value >= 255 ? 255 : value + 0.5; }

const out = [];
const seeds = [0x0d3d071e, 42, 7];
const coords = [];
for (let i = 0; i < 8; i++) {
  for (let j = 0; j < 8; j++) {
    coords.push([i * 13.37 - 30, j * 9.11 + 256]); // spread + chunk-boundary z
  }
}
for (const seed of seeds) {
  for (const biome of ["desert", "forest"]) {
    for (const [x, z] of coords) {
      const buf = new Uint8ClampedArray(4);
      const kind = paintTerrainPixel(seed | 0, x, z, buf, 0, biome);
      out.push({ seed: seed | 0, x, z, biome, r: buf[0], g: buf[1], b: buf[2], kind });
    }
  }
}
process.stdout.write(JSON.stringify(out));
