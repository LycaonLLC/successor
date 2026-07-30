import { Color, IcosahedronGeometry, MeshMatcapMaterial, Vector2, type BufferGeometry, type Texture } from "three";
import {
  addTube,
  FacetBuilder,
  hashFloat,
  installWindSway,
  VariantRng,
  type FloraColliderShape,
  type FloraVariant,
  type FloraWindUniforms,
} from "./generators";

/**
 * Verdance — GIANT FANTASY FOREST (owner-ratified 2026-07-05, "trees 50×
 * bigger"). Authored by Main (Fable hands).
 *
 * The camera never sees a canopy in locked iso, so the titan forest is a
 * TRUNK-MONUMENT kit: colossal fluted columns (55–75u — the top exists only
 * for the sun-shadow silhouette), root buttresses that dwarf pawns, titan
 * stumps like fallen towers, fallen boughs the size of corridors — with
 * saplings and knee-high ferns supplying the scale contrast that SELLS the
 * 50×. Scale doctrine per ART_DIRECTION §4: traversal = size, countable
 * trunk rhythm, mass at the feet.
 *
 * Surface language: flutes are GEOMETRY (alternating inset faces, posterize-
 * safe), moss is a MATERIAL BAND riding the first ~7u, wear is silhouette
 * (root asymmetry, broken stump crowns) — never surface noise.
 *
 * Export surface FROZEN (biome plumbing consumes arrays blind):
 * pines = titan conifers, broadleafs = titan split-crowns, ferns, logs =
 * fallen boughs, mossyBoulders, stumps = titan stumps. `saplings` rides the
 * pines array's tail variants? NO — saplings are their own scatter species
 * (see scatter.ts), exported here as `saplings`.
 */
export interface ForestFloraVariants {
  readonly pines: FloraVariant[];
  readonly broadleafs: FloraVariant[];
  readonly saplings: FloraVariant[];
  readonly ferns: FloraVariant[];
  readonly logs: FloraVariant[];
  readonly mossyBoulders: FloraVariant[];
  readonly stumps: FloraVariant[];
  /** Per-frame dials for the titan depth shader (overhead fade + bark tone). */
  readonly depthUniforms: TitanDepthUniforms;
}

/**
 * Titan depth shader uniforms — shared by every titan-family material.
 * uDwPlayerPx = followed pawn in LOW-RES TARGET pixels (the scene pass's
 * gl_FragCoord space); uDwFadePx = screendoor cutout radius; uDwFadeMinY =
 * world height below which geometry never fades (trunks at eye level stay).
 */
export interface TitanDepthUniforms {
  readonly uDwPlayerPx: { value: Vector2 };
  readonly uDwFadePx: { value: number };
  readonly uDwFadeMinY: { value: number };
}

export function createTitanDepthUniforms(): TitanDepthUniforms {
  return {
    uDwPlayerPx: { value: new Vector2(-10_000, -10_000) },
    uDwFadePx: { value: 0 },
    uDwFadeMinY: { value: 7 },
  };
}

/**
 * Titan depth shader: (a) procedural BARK STRIATION — vertical value bands
 * from world position (no UVs, no textures, instancing-aware, ±8% so it
 * survives posterize as tone not noise); (b) OVERHEAD SCREENDOOR FADE —
 * fragments high above the ground near the followed pawn's screen position
 * hash-dither-discard, so a bough crossing over your head reads as "above
 * you" instead of a mystery wall. Discard keeps the opaque pass (no sorting,
 * PS2-honest dissolve).
 */
function installTitanDepthShader(material: MeshMatcapMaterial, uniforms: TitanDepthUniforms): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDwPlayerPx = uniforms.uDwPlayerPx;
    shader.uniforms.uDwFadePx = uniforms.uDwFadePx;
    shader.uniforms.uDwFadeMinY = uniforms.uDwFadeMinY;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 dwWorldPos;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
#ifdef USE_INSTANCING
dwWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
dwWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 dwWorldPos;
uniform vec2 uDwPlayerPx;
uniform float uDwFadePx;
uniform float uDwFadeMinY;`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
float dwBark = 0.92 + 0.08 * sin(dwWorldPos.y * 2.3 + sin(dwWorldPos.x * 1.7 + dwWorldPos.z * 1.3) * 2.2);
dwBark *= 0.955 + 0.045 * sin(dwWorldPos.y * 8.7 + dwWorldPos.x * 2.9 + dwWorldPos.z * 2.1);
diffuseColor.rgb *= dwBark;
if (uDwFadePx > 0.0 && dwWorldPos.y > uDwFadeMinY) {
  float dwDist = distance(gl_FragCoord.xy, uDwPlayerPx);
  float dwKeep = smoothstep(uDwFadePx * 0.3, uDwFadePx, dwDist);
  float dwGate = smoothstep(uDwFadeMinY, uDwFadeMinY + 5.0, dwWorldPos.y);
  float dwOpacity = mix(1.0, max(dwKeep, 0.12), dwGate);
  float dwHash = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
  if (dwOpacity < dwHash) discard;
}`,
      );
  };
  material.customProgramCacheKey = () => "successor-titan-depth-v1";
}

// Calibrated hot (~1.45×) — matcap+desat+grade bleach hard (judging room 2026-07-05).
const BARK_DARK = "#6b5642";
const BARK_MID = "#846c50";
const BARK_HIGH = "#9a805e";
const MOSS = "#719b57";
const HEARTWOOD = "#c7b287";
const SAPLING_SHADOW = "#446038";
const SAPLING_MID = "#587e47";
const SAPLING_LIT = "#6b9855";
const FERN_DEEP = "#6f934e";
const FERN_BRIGHT = "#87b05f";
const STONE_MID = "#b0a996";
const STONE_BASE = "#7b745c";

export function createForestFloraVariants(matcap: Texture, windUniforms: FloraWindUniforms): ForestFloraVariants {
  const sway = (hex: string): MeshMatcapMaterial => {
    const material = new MeshMatcapMaterial({ matcap, color: new Color(hex), flatShading: true, fog: true });
    material.name = `flora-forest:${hex}`;
    installWindSway(material, windUniforms);
    return material;
  };
  const still = (hex: string): MeshMatcapMaterial => {
    const material = new MeshMatcapMaterial({ matcap, color: new Color(hex), flatShading: true, fog: true });
    material.name = `flora-forest:${hex}`;
    return material;
  };
  const depthUniforms = createTitanDepthUniforms();
  const titan = (hex: string): MeshMatcapMaterial => {
    const material = still(hex);
    installTitanDepthShader(material, depthUniforms);
    return material;
  };

  // Titans NEVER sway — mass reads through stillness. Understory shivers.
  // Titan-family materials carry the depth shader (bark tone + overhead fade).
  const titanMaterials = [titan(BARK_DARK), titan(BARK_MID), titan(MOSS), titan(BARK_HIGH)];
  const stumpMaterials = [titan(BARK_DARK), titan(BARK_MID), titan(MOSS), titan(HEARTWOOD)];
  const saplingMaterials = [still(BARK_DARK), sway(SAPLING_SHADOW), sway(SAPLING_MID), sway(SAPLING_LIT)];
  const fernMaterials = [sway(FERN_DEEP), sway(FERN_BRIGHT)];
  const boughMaterials = [titan(BARK_DARK), titan(HEARTWOOD), titan(MOSS)];
  const boulderMaterials = [still(MOSS), still(STONE_MID), still(STONE_BASE)];

  const pines: FloraVariant[] = [];
  for (let i = 0; i < 3; i += 1) {
    const built = createTitanConifer(0x717A9 + i * 0x1f3d, i);
    pines.push({
      key: `pine:${i}`,
      species: "pine",
      geometry: built.geometry,
      materials: titanMaterials,
      collider: built.collider,
    });
  }
  const broadleafs: FloraVariant[] = [];
  for (let i = 0; i < 2; i += 1) {
    const built = createTitanSplitCrown(0xB60AD + i * 0x2d51, i);
    broadleafs.push({
      key: `broadleaf:${i}`,
      species: "broadleaf",
      geometry: built.geometry,
      materials: titanMaterials,
      collider: built.collider,
    });
  }
  const saplings: FloraVariant[] = [];
  for (let i = 0; i < 3; i += 1) {
    saplings.push({
      key: `sapling:${i}`,
      species: "sapling",
      geometry: dampSway(createSaplingGeometry(0x5A9 + i * 0x9e1, i), 0.5),
      materials: saplingMaterials,
    });
  }
  const ferns: FloraVariant[] = [];
  for (let i = 0; i < 2; i += 1) {
    ferns.push({
      key: `fern:${i}`,
      species: "fern",
      geometry: createFernGeometry(0xFE21 + i * 0x571, i),
      materials: fernMaterials,
    });
  }
  const logs: FloraVariant[] = [];
  for (let i = 0; i < 2; i += 1) {
    const built = createFallenBough(0x10665 + i * 0x943, i);
    logs.push({
      key: `log:${i}`,
      species: "log",
      geometry: built.geometry,
      materials: boughMaterials,
      collider: built.collider,
    });
  }
  const mossyBoulders: FloraVariant[] = [];
  for (let i = 0; i < 2; i += 1) {
    mossyBoulders.push({
      key: `mossy_boulder:${i}`,
      species: "mossy_boulder",
      geometry: createMossyBoulderGeometry(0xB0C0DE + i * 0x77f, i),
      materials: boulderMaterials,
      collider: { kind: "circle", radius: 1.15 },
    });
  }
  const built = createTitanStump(0x57097, 0);
  const stumps: FloraVariant[] = [{
    key: "stump:0",
    species: "stump",
    geometry: built.geometry,
    materials: stumpMaterials,
    collider: built.collider,
  }];

  return { pines, broadleafs, saplings, ferns, logs, mossyBoulders, stumps, depthUniforms };
}

/** Understory sways gently; scale the height²-weighted attribute down. */
function dampSway(geometry: BufferGeometry, factor: number): BufferGeometry {
  const sway = geometry.getAttribute("floraSway");
  if (sway) {
    for (let i = 0; i < sway.count; i += 1) sway.setX(i, sway.getX(i) * factor);
    sway.needsUpdate = true;
  }
  return geometry;
}

// ── Titan builders ────────────────────────────────────────────────────────

/**
 * Fluted colossal column: stacked polygon rings with alternating inset
 * vertices (the flutes — geometry, not texture), gentle taper and bow, moss
 * band material to ~7u, bark lightening with height. Root buttresses are
 * curved tapered tubes that carry the ground-contact mass.
 */
function addFlutedColumn(
  builder: FacetBuilder,
  rng: VariantRng,
  baseX: number,
  baseZ: number,
  baseRadius: number,
  height: number,
  bowX: number,
  bowZ: number,
  mossTopY: number,
  midTopY: number,
): void {
  const sides = 12;
  const fluteDepth = 0.82; // inset vertices at 82% radius — deep enough to band
  const rings = 7;
  const ringYs: number[] = [];
  const ringRadii: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    ringYs.push(t * height);
    // Root swell at the base, slow taper, slight waist then crown taper.
    const swell = t < 0.08 ? 1.35 - t * 3.2 : 1.06 - t * 0.5;
    ringRadii.push(baseRadius * Math.max(0.4, swell) * rng.range(0.985, 1.015));
  }
  const materialForY = (y: number): number => (y < mossTopY ? 2 : y < midTopY ? 1 : 3);
  for (let ring = 0; ring < rings; ring += 1) {
    const y0 = ringYs[ring]!;
    const y1 = ringYs[ring + 1]!;
    const r0 = ringRadii[ring]!;
    const r1 = ringRadii[ring + 1]!;
    const t0 = y0 / height;
    const t1 = y1 / height;
    const cx0 = baseX + bowX * t0 * t0;
    const cz0 = baseZ + bowZ * t0 * t0;
    const cx1 = baseX + bowX * t1 * t1;
    const cz1 = baseZ + bowZ * t1 * t1;
    const materialIndex = materialForY(y0);
    for (let i = 0; i < sides; i += 1) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const inset0 = i % 2 === 0 ? 1 : fluteDepth;
      const inset1 = (i + 1) % 2 === 0 ? 1 : fluteDepth;
      builder.addQuad(
        materialIndex,
        cx0 + Math.cos(a0) * r0 * inset0, y0, cz0 + Math.sin(a0) * r0 * inset0,
        cx1 + Math.cos(a0) * r1 * inset0, y1, cz1 + Math.sin(a0) * r1 * inset0,
        cx1 + Math.cos(a1) * r1 * inset1, y1, cz1 + Math.sin(a1) * r1 * inset1,
        cx0 + Math.cos(a1) * r0 * inset1, y0, cz0 + Math.sin(a1) * r0 * inset1,
      );
    }
  }
  // Crown cap (only the sun-shadow pass ever sees it).
  const topY = ringYs[rings]!;
  const topR = ringRadii[rings]!;
  const tcx = baseX + bowX;
  const tcz = baseZ + bowZ;
  for (let i = 0; i < sides; i += 1) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    builder.addTri(
      3,
      tcx, topY + topR * 0.4, tcz,
      tcx + Math.cos(a0) * topR, topY, tcz + Math.sin(a0) * topR,
      tcx + Math.cos(a1) * topR, topY, tcz + Math.sin(a1) * topR,
    );
  }
}

/** Root buttresses: tapered arcs from trunk flank to ground, moss-banded. */
function addRootButtresses(
  builder: FacetBuilder,
  rng: VariantRng,
  baseRadius: number,
  count: number,
  reachMin: number,
  reachMax: number,
): void {
  for (let i = 0; i < count; i += 1) {
    const angle = (Math.PI * 2 * i) / count + rng.range(-0.35, 0.35);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const reach = rng.range(reachMin, reachMax);
    const rootHeight = rng.range(2.2, 4.2);
    const startR = baseRadius * 0.72;
    const midR = baseRadius * rng.range(0.34, 0.46);
    // Flank → knee → ground tip, two segments, thick to thin.
    addTube(
      builder,
      dirX * startR, rootHeight, dirZ * startR,
      dirX * (startR + reach * 0.45), rootHeight * 0.34, dirZ * (startR + reach * 0.45),
      midR, midR * 0.62, 6, 2, false, false,
    );
    addTube(
      builder,
      dirX * (startR + reach * 0.45), rootHeight * 0.34, dirZ * (startR + reach * 0.45),
      dirX * (startR + reach), 0.06, dirZ * (startR + reach),
      midR * 0.62, midR * 0.2, 5, 2, false, true,
    );
  }
}

interface BuiltTitanPiece {
  geometry: BufferGeometry;
  collider: FloraColliderShape;
}

function createTitanConifer(seed: number, variantIndex: number): BuiltTitanPiece {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const height = rng.range(55, 75);
  const baseRadius = rng.range(2.2, 3.2);
  const bowAngle = rng.range(0, Math.PI * 2);
  const bow = rng.range(0, 2.6);
  addFlutedColumn(
    builder, rng, 0, 0, baseRadius, height,
    Math.cos(bowAngle) * bow, Math.sin(bowAngle) * bow,
    rng.range(5.5, 8.5), height * rng.range(0.5, 0.62),
  );
  addRootButtresses(builder, rng, baseRadius, rng.int(5, 7), 5.5, 10.5);
  // One colossal bough high up — its moving shadow is the only canopy we see.
  // Dark bark + near-zero tip: from above it reads as branch, never a disc.
  const boughAngle = rng.range(0, Math.PI * 2);
  const boughY = height * rng.range(0.55, 0.7);
  addTube(
    builder,
    Math.cos(boughAngle) * baseRadius * 0.5, boughY, Math.sin(boughAngle) * baseRadius * 0.5,
    Math.cos(boughAngle) * rng.range(9, 15), boughY + rng.range(1.5, 4), Math.sin(boughAngle) * rng.range(9, 15),
    baseRadius * 0.34, baseRadius * 0.03, 6, 0, false, true,
  );
  return {
    geometry: builder.toGeometry(`flora:titan_conifer:${variantIndex}`, false),
    collider: { kind: "circle", radius: baseRadius * 0.94 },
  };
}

function createTitanSplitCrown(seed: number, variantIndex: number): BuiltTitanPiece {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const trunkHeight = rng.range(20, 27);
  const baseRadius = rng.range(2.8, 3.8);
  addFlutedColumn(builder, rng, 0, 0, baseRadius, trunkHeight, 0, 0, rng.range(5.5, 8), trunkHeight * 0.7);
  addRootButtresses(builder, rng, baseRadius, rng.int(6, 8), 7, 13);
  // The split: 2–3 leaning daughter columns rising out of frame. Tips taper
  // near-closed — a fat top cap read as a floating octagon from the iso
  // camera (owner screenshot, 2026-07-05).
  const splits = rng.int(2, 3);
  for (let i = 0; i < splits; i += 1) {
    const angle = (Math.PI * 2 * i) / splits + rng.range(-0.4, 0.4);
    const lean = rng.range(3, 7);
    const subHeight = rng.range(28, 42);
    const subRadius = baseRadius * rng.range(0.42, 0.55);
    const originX = Math.cos(angle) * baseRadius * 0.4;
    const originZ = Math.sin(angle) * baseRadius * 0.4;
    addTube(
      builder,
      originX, trunkHeight - 1.5, originZ,
      originX + Math.cos(angle) * lean, trunkHeight + subHeight, originZ + Math.sin(angle) * lean,
      subRadius, subRadius * 0.16, 8, 1, false, true,
    );
  }
  return {
    geometry: builder.toGeometry(`flora:titan_splitcrown:${variantIndex}`, false),
    collider: { kind: "circle", radius: baseRadius * 0.95 },
  };
}

/** Sapling — the old forest pine, kept near human scale: it IS the ruler that measures the titans. */
function createSaplingGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const height = rng.range(2.4, 4.4);
  const leanAngle = rng.range(0, Math.PI * 2);
  const lean = rng.range(0, 0.09) * height;
  const leanX = Math.cos(leanAngle) * lean;
  const leanZ = Math.sin(leanAngle) * lean;
  const trunkTopY = height * rng.range(0.28, 0.36);
  const trunkRadius = 0.05 + height * 0.016;
  addTube(builder, 0, 0, 0, leanX * 0.35, trunkTopY, leanZ * 0.35, trunkRadius * 1.15, trunkRadius * 0.8, 6, 0, true, false);
  addTube(builder, leanX * 0.35, trunkTopY, leanZ * 0.35, leanX, height, leanZ, trunkRadius * 0.8, 0.012, 5, 0, false, true);
  const tiers = rng.int(3, 4);
  for (let tier = 0; tier < tiers; tier += 1) {
    const t = tier / tiers;
    const baseY = trunkTopY + (height - trunkTopY) * t * 0.92;
    const topY = baseY + (height - trunkTopY) / tiers * rng.range(0.9, 1.15);
    const radius = (0.5 + height * 0.1) * (1 - t * 0.58) * rng.range(0.88, 1.1);
    const materialIndex = tier === tiers - 1 ? 3 : tier === 0 ? 1 : 2;
    addTube(
      builder,
      leanX * t + rng.range(-0.05, 0.05), baseY - radius * 0.22, leanZ * t + rng.range(-0.05, 0.05),
      leanX * t, topY, leanZ * t,
      radius, radius * 0.18, 7, materialIndex, false, true,
    );
  }
  return builder.toGeometry(`flora:sapling:${variantIndex}`, true);
}

/** Fantasy fern — knee-to-waist-high radial frond crown (2× the old scale). */
function createFernGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const fronds = rng.int(7, 10);
  const crownHeight = rng.range(0.8, 1.3);
  for (let i = 0; i < fronds; i += 1) {
    const angle = (Math.PI * 2 * i) / fronds + rng.range(-0.22, 0.22);
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const reach = rng.range(0.65, 1.15);
    const rise = crownHeight * rng.range(0.75, 1);
    const midX = dirX * reach * 0.45;
    const midZ = dirZ * reach * 0.45;
    const materialIndex = rng.next() > 0.45 ? 1 : 0;
    addTube(builder, 0, 0.03, 0, midX, rise, midZ, 0.05, 0.036, 4, materialIndex, false, false);
    addTube(builder, midX, rise, midZ, dirX * reach, rise * rng.range(0.3, 0.48), dirZ * reach, 0.036, 0.006, 4, materialIndex, false, true);
  }
  return builder.toGeometry(`flora:fern:${variantIndex}`, true);
}

/** Fallen titan bough — a corridor-scale trunk section rotting into the floor. */
function createFallenBough(seed: number, variantIndex: number): BuiltTitanPiece {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const length = rng.range(14, 22);
  const radius = rng.range(0.9, 1.4);
  const half = length / 2;
  const elbow = rng.range(-2.5, 2.5);
  const sag = radius * 0.68; // deeply settled into the duff
  addTube(builder, -half, sag, 0, rng.range(-1, 1), sag * 1.1, elbow, radius, radius * 0.92, 8, 0, false, false);
  addTube(builder, rng.range(-1, 1), sag * 1.1, elbow, half, sag * 0.9, elbow * 0.4, radius * 0.92, radius * 0.7, 8, 0, false, false);
  // Broken ends: heartwood discs.
  addTube(builder, -half - 0.06, sag, 0, -half, sag, 0, radius * 0.8, radius * 0.95, 8, 1, true, false);
  addTube(builder, half, sag * 0.9, elbow * 0.4, half + 0.06, sag * 0.9, elbow * 0.4, radius * 0.66, radius * 0.5, 8, 1, false, true);
  // Moss saddle along the top.
  addTube(builder, -half * 0.65, sag + radius * 0.62, elbow * 0.3, half * 0.5, sag + radius * 0.55, elbow * 0.5, radius * 0.42, radius * 0.3, 5, 2, false, false);
  // Shattered branch stubs.
  for (let i = 0; i < rng.int(2, 4); i += 1) {
    const at = rng.range(-half * 0.7, half * 0.7);
    const upAngle = rng.range(0.4, 1.2);
    addTube(
      builder,
      at, sag + radius * 0.5, elbow * 0.4,
      at + rng.range(-1.5, 1.5), sag + radius * 0.5 + Math.sin(upAngle) * rng.range(1.2, 2.6), elbow * 0.4 + rng.range(-1.5, 1.5),
      radius * 0.22, radius * 0.06, 5, 0, false, true,
    );
  }
  return {
    geometry: builder.toGeometry(`flora:fallen_bough:${variantIndex}`, false),
    collider: { kind: "segment", ax: -half, az: 0, bx: half, bz: elbow * 0.4, radius: radius * 1.05 },
  };
}

/** Mossy boulder — scaled for a giant's forest. */
function createMossyBoulderGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const source = new IcosahedronGeometry(0.8, 0);
  const shell = source.index ? source.toNonIndexed() : source;
  const position = shell.getAttribute("position");
  const builder = new FacetBuilder();
  const scaleX = rng.range(1.3, 2.1);
  const scaleY = rng.range(0.8, 1.15);
  const scaleZ = rng.range(1.25, 1.9);
  const xs = new Float32Array(position.count);
  const ys = new Float32Array(position.count);
  const zs = new Float32Array(position.count);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < position.count; i += 1) {
    const rough = 0.76 + hashFloat(seed, i, variantIndex, 0xB07) * 0.4;
    xs[i] = position.getX(i) * rough * scaleX;
    ys[i] = position.getY(i) * rough * scaleY;
    zs[i] = position.getZ(i) * rough * scaleZ;
    if (ys[i]! < minY) minY = ys[i]!;
    if (ys[i]! > maxY) maxY = ys[i]!;
  }
  const invHeight = maxY > minY ? 1 / (maxY - minY) : 0;
  for (let i = 0; i < position.count; i += 3) {
    const band = ((ys[i]! + ys[i + 1]! + ys[i + 2]!) / 3 - minY) * invHeight;
    const materialIndex = band > 0.62 ? 0 : band > 0.28 ? 1 : 2;
    builder.addTri(
      materialIndex,
      xs[i]!, ys[i]! - minY * 0.35, zs[i]!,
      xs[i + 1]!, ys[i + 1]! - minY * 0.35, zs[i + 1]!,
      xs[i + 2]!, ys[i + 2]! - minY * 0.35, zs[i + 2]!,
    );
  }
  source.dispose();
  if (shell !== source) shell.dispose();
  return builder.toGeometry(`flora:mossy_boulder:${variantIndex}`, false);
}

/** Titan stump — a fallen tower's foot: fluted drum, heartwood cut, root spread. */
function createTitanStump(seed: number, variantIndex: number): BuiltTitanPiece {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const radius = rng.range(2.6, 4.2);
  const height = rng.range(2.4, 4.6);
  addFlutedColumn(builder, rng, 0, 0, radius, height, rng.range(-0.4, 0.4), rng.range(-0.4, 0.4), Math.min(2.2, height * 0.6), height * 0.92);
  // Jagged crown: an inner heartwood disc slightly below the broken rim.
  const sides = 10;
  for (let i = 0; i < sides; i += 1) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const rim0 = radius * rng.range(0.5, 0.8);
    const rim1 = radius * rng.range(0.5, 0.8);
    builder.addTri(
      3,
      0, height - 0.35, 0,
      Math.cos(a0) * rim0, height + rng.range(-0.3, 0.5), Math.sin(a0) * rim0,
      Math.cos(a1) * rim1, height + rng.range(-0.3, 0.5), Math.sin(a1) * rim1,
    );
  }
  addRootButtresses(builder, rng, radius, rng.int(5, 7), 4.5, 9);
  return {
    geometry: builder.toGeometry(`flora:titan_stump:${variantIndex}`, false),
    collider: { kind: "circle", radius: radius * 0.92 },
  };
}
