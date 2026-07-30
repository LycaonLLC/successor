import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";

const DESERT_BIOME = {
  palette: {
    desert: [208, 165, 92],
    scrub: [188, 151, 84],
    hardpan: [224, 190, 124],
  },
  fogTint: [1, 1, 1],
  fogFarTScale: 1,
  gradeCool: 0,
  // ── Border atmosphere (post.ts "airfield" pass) — desert register ──────
  // Sand is an EVENT: it kicks up with the wind, rides it fast, lifts off
  // the ground, and piles hardest into the top corners of the frame where
  // the world is already dissolving into haze.
  atmosphere: {
    // Screen-border falloff width (fraction of the short edge).
    borderWidth: 0.26,
    // Extra density where two edges meet (corner build-up).
    cornerBoost: 0.45,
    // Vertical weighting of the border field: 1 = full weight.
    topBias: 0.48,
    bottomBias: 0.5,
    // Screen-space rise (+) or sink (−) added to wind drift, UV/s.
    windRise: 0.045,
    // Drift speed multiplier over the shared Worldfeel wind.
    driftScale: 1.0,
    // Noise cells across the frame for the mid plume layer.
    noiseScale: 5.4,
    // Peak border blend at full gust + max zoom-out.
    borderStrength: 0.28,
    // Accent tint multiplied over the fog colour on the NEAR wisp layer
    // (sun-warmed sand; catches light the far veil never gets).
    accentTint: [1.1, 1.02, 0.86],
    // Ridge-peak highlight strength on the near layer (sand glitter).
    moteStrength: 0.08,
    // How hard gusts modulate density (0 = constant air).
    gustiness: 1.0,
    // Density multiplier at deep night vs full day (calm, settled air).
    nightDensityScale: 0.72,
  },
} as const;

const FOREST_BIOME = {
  palette: {
    // Calibrated against the desert floor (avg ~208): forest floor sits
    // ~35% below it — shaded understory, never void-black under the grade
    // (first bake at [86,74,52] read as night at noon; taste pass 2026-07-05).
    loam: [128, 110, 78],
    moss: [110, 130, 78],
    duff: [150, 128, 86],
  },
  // Mystery-planet register (owner 2026-07-05): the air itself is Verdance's
  // menace — greener, cooler, and CLOSE. Titans dissolve into haze a screen
  // away; the desert's far-sight confidence does not exist here.
  fogTint: [0.78, 0.97, 0.8],
  fogFarTScale: 0.62,
  gradeCool: 0.24,
  // ── Border atmosphere — Verdance register ───────────────────────────────
  // The forest's menace is the AIR: moisture pools at the ground, creeps
  // slowly against the boots, thickens at night, and the canopy breathes a
  // dim gloom from above. Rare pale glints ride the mist banks (spores).
  atmosphere: {
    borderWidth: 0.32,
    cornerBoost: 0.35,
    topBias: 0.38,
    bottomBias: 1.0,
    windRise: -0.028,
    driftScale: 0.22,
    noiseScale: 4.0,
    borderStrength: 0.36,
    accentTint: [0.94, 1.08, 0.92],
    moteStrength: 0.11,
    gustiness: 0.55,
    nightDensityScale: 1.35,
  },
} as const;

export const SUCCESSOR_3D_CONFIG = {
  camera: {
    // Canonical world compass: +x/east is screen-right and -z/north is
    // screen-up. The camera may pitch but never rotates the world cardinals.
    yawDegrees: 0,
    pitchDegrees: 60,
    // Pawn-readability framing (owner contract, amended 2026-07-02 big-world
    // pass): at 100% zoom the frustum is 12.5 units tall -> followed pawn
    // (1.7u) ≈ 13.6% of viewport height; ~22 cells visible width at 16:9.
    // Zoom-out ceiling trimmed (55% ≈ 22.7 tall / ~40 wide — the screen is
    // the client FIDELITY budget; server interest/simulation stay camera-
    // independent) and zoom-in floor deepened (140% ≈ 8.9 tall) per the
    // owner's "little less zoom-out, little more zoom-in". Never whole-map.
    baseFrustumHeightCells: 12.5,
    minZoomPercent: 55,
    maxZoomPercent: 140,
    followLerpPerSecond: 12,
    distanceCells: 96,
    near: 0.1,
    far: 320,
  },
  biomes: {
    desert: DESERT_BIOME,
    forest: FOREST_BIOME,
  },
  renderer: {
    // Clear colour is deliberately identical to the fog colour: distant streamed
    // terrain dissolves into the same dust haze, so chunk edges never read as a
    // hard skyline seam.
    clearColor: "#c9ad82",
    // ── PS2 pass dials (consumed by render/post.ts) ──────────────────────
    post: {
      // Render-target scale. Owner amendments 2026-07-02 ("too PS1") and
      // 2026-07-03 ("slightly reduce the ps1isizer"): 0.45 ≈ 864×486 at
      // 1080p — period-soft but a touch finer than the 0.4 baseline.
      pixelScale: 0.45,
      // Colour levels per channel AFTER the grade. 48 keeps the banding
      // character with finer gradients (2026-07-03 reduction pass).
      // Set below 2 to disable (A/B).
      posterizeLevels: 48,
      // Ordered-dither amplitude in colour units, applied on the LOW-RES
      // pixel grid before posterize. Slightly under a quant step breaks
      // banding while staying subliminal. 0 disables (A/B).
      ditherStrength: 0.02,
      // Desert grade: fraction of chroma pulled toward luma ("bone")…
      desaturate: 0.2,
      // …then a gentle warm cast multiplied back in (sun-bleached, not sepia).
      boneTint: [1.04, 1.0, 0.9],
      // 0 = raw NEAREST upscale. >0 widens each low-res texel edge over about
      // this many display pixels (sharp-bilinear) so the 3× grid does not
      // shimmer while the iso camera pans. Keep well under 1.
      texelSoftness: 0.4,
      // Time-of-day bloom multiplier. The grade anchors provide the per-hour
      // strength; this dial scales it for live A/B. 0 disables bloom.
      bloomStrength: 1,
      // Raw low-res luma threshold for the pre-grade bloom extract.
      bloomThreshold: 0.8,
      // Heat shimmer amplitude in LOW-RES texels; post.ts hard-clamps to 1.2.
      shimmerAmplitude: 1,
      // Legacy/static black lift override. ToD grade owns the live value while
      // enabled; todEnabled=false forces 0 for a byte-identical fixed baseline.
      blackLift: 0,
      // ── Ambient desert dust (zoom-aware; post.ts blends toward the fog
      // colour AFTER posterize, broken up by drifting value noise) ──────
      // Replaces the old radial edge-fog vignette (owner 2026-07-03: "sort
      // of like a really rough vignette… hoping for high-fidelity ambient
      // dust"). In the locked iso frame, depth rises with screen height, so
      // the density ramp is VERTICAL (honest distance haze), plus a small
      // ambient term so far zoom reads dusty without walling the frame.
      dust: {
        // UNIFORM-AIR RULING (owner 2026-07-05): the vertical band is
        // RETIRED (maxStrength 0) — no screen-height density ramp may make
        // the top unique. The ramp bounds remain only as the heat-shimmer
        // mask (noon wobble stays a far-field flourish).
        heightStart: 0.62,
        heightEnd: 1.3,
        maxStrength: 0,
        // The air itself: one even, noise-mottled haze across the WHOLE
        // frame at zoom-out (patchiness keeps it alive, not flat).
        ambient: 0.09,
        // Value-noise cells across the frame width; lower = broader plumes.
        noiseScale: 5.0,
        // Horizontal drift in noise-cells/second (slow wind).
        driftSpeed: 0.018,
        // How much the noise modulates density (0 = flat band, 1 = fully patchy).
        patchiness: 0.5,
      },
    },
    // ── Fog vs zoom (post.ts re-derives scene fog every frame) ───────────
    fog: {
      enabled: true,
      // nearT/farT are relative to the VISIBLE frame, not world units:
      //   depth = cameraDistance + t · (halfFrustumHeight / tan(pitch))
      // t = 0 is the focused actor's depth, t = 1 the top edge of the screen.
      // UNIFORM-AIR RULING (owner 2026-07-05, third pass on the top border):
      // no vertical treatment may be unique to the top of the frame — the
      // fog window starts PAST the visible top edge (nearT > 1), so in-frame
      // fog is ZERO everywhere and the frame reads as one uniform air. The
      // melt into the clear colour happens entirely off-screen (still hiding
      // streamed-chunk edges; clearColor == fogColor doctrine unchanged).
      // Verdance note: its fogFarTScale (0.62) pulls far below near, which
      // updateFog clamps to near+1 — the forest melts almost immediately
      // past the frame, keeping its close-air menace without an in-frame
      // gradient.
      nearT: 1.05,
      farT: 1.45,
    },
  },
  terrain: {
    // Big-world E1: flat visual infinity, streamed in 256-cell chunks. This is
    // render-only; sim movement, picking, props, decals, and authority bounds
    // remain on the y=0 cell plane.
    chunkCells: 256,
    texturePixels: 1024,
    y: 0,
    visibleApronCells: 64,
    // Radius 2 keeps a 5×5 chunk apron baked ahead of sprint (radius 1's 3×3
    // let fast travel outrun the bake queue — fresh-load jag, owner 2026-07-07).
    prefetchRadiusChunks: 2,
    lruFloor: 25,
    lruCap: 40,
    // rAF-budgeted CPU bake. One active chunk advances by this many texture
    // rows per frame; finished chunks upload one CanvasTexture with no mips.
    bakeRowsPerFrame: 32,
    // Close-zoom surface tooth: one shared 128² tiling DataTexture multiplied
    // in terrain's MeshBasicMaterial shader. This is NOT per-chunk memory; the
    // streamed 1024² CanvasTexture ceiling stays fixed.
    detail: {
      texturePixels: 128,
      texelsPerCell: 1,
      amplitude: 0.08,
      fullStrengthBoundsWidthCells: 24,
      zeroStrengthBoundsWidthCells: 46,
    },
    fallbackWorldSeed: 0x0d3d_071e,
    // Back-compat re-export for legacy terrain consumers; palette rows live
    // under biomes.desert.
    palette: DESERT_BIOME.palette,
  },
  ground: {
    // Boot-time values only — post.ts overwrites near/far from zoom each
    // frame. fogColor MUST stay equal to renderer.clearColor (and to the
    // theme's "haze" swatch) or the horizon seam comes back.
    fogColor: "#c9ad82",
    fogNear: 85,
    fogFar: 185,
  },
  // ── Worldfeel environment (server world clock → presentation) ─────────
  environment: {
    sun: {
      // Server azimuth: sunrise=0, noon=π/2, dusk=π. With the north-up world
      // basis, env.dir = (-cos(a), -sin(a)) already gives sunrise west,
      // noon north, and dusk east; no presentation rotation belongs here.
      azimuthWorldOffsetRad: 0,
      // Shadow projection elevation clamp: the floor keeps horizon-grazing
      // sun from smearing shadows to infinity; the CEILING keeps zenith noon
      // from deleting them (owner taste: the desert grounds all day — a
      // stubby noon shadow beats none, classic PS2 move).
      minShadowElevationDeg: 9,
      maxShadowElevationDeg: 60,
      // Peak darkening of the projected-shadow pass.
      maxShadowStrength: 0.42,
      // Faint moon shadows under a bright moon (scaled by moon brightness).
      moonShadowFactor: 0.3,
      // Light tints: bone-white noon, ember horizon, slate-blue moonlight.
      tints: { noon: "#fff3e2", dawnDusk: "#ffb277", night: "#8fa0c8" },
    },
    wind: {
      // Presentation-only ambient wind: flora sway, tumbleweeds, dust drift.
      baseDirDeg: 115,
      wanderDeg: 40,
      wanderPeriodSec: 210,
      baseStrength: 0.3,
      gustStrength: 0.45,
      gustPeriodSec: 7.5,
    },
    grade: {
      anchors: [
        {
          minuteOfDay: 0,
          fogClearColor: "#2b3040",
          boneTint: [0.86, 0.92, 1.14],
          desaturate: 0.34,
          sceneDarken: 0.38,
          blackLift: 0.05,
          bloomStrength: 0.65,
        },
        {
          minuteOfDay: 360,
          fogClearColor: "#b97d58",
          boneTint: [1.1, 0.95, 0.82],
          desaturate: 0.16,
          sceneDarken: 0.85,
          blackLift: 0.04,
          bloomStrength: 0.5,
        },
        {
          minuteOfDay: 480,
          fogClearColor: "#c9a97e",
          boneTint: [1.06, 0.99, 0.88],
          desaturate: 0.18,
          sceneDarken: 0.96,
          blackLift: 0.015,
          bloomStrength: 0.18,
        },
        {
          minuteOfDay: 720,
          fogClearColor: "#c9ad82",
          boneTint: [1.04, 1.0, 0.9],
          desaturate: 0.2,
          sceneDarken: 1,
          blackLift: 0.03,
          bloomStrength: 0.35,
        },
        {
          minuteOfDay: 1080,
          fogClearColor: "#c99a6e",
          boneTint: [1.07, 0.97, 0.86],
          desaturate: 0.17,
          sceneDarken: 0.9,
          blackLift: 0.025,
          bloomStrength: 0.32,
        },
        {
          minuteOfDay: 1140,
          fogClearColor: "#b06a4a",
          boneTint: [1.12, 0.92, 0.85],
          desaturate: 0.14,
          sceneDarken: 0.8,
          blackLift: 0.04,
          bloomStrength: 0.55,
        },
        {
          minuteOfDay: 1260,
          fogClearColor: "#333a52",
          boneTint: [0.88, 0.94, 1.12],
          desaturate: 0.32,
          sceneDarken: 0.42,
          blackLift: 0.05,
          bloomStrength: 0.6,
        },
      ],
    },
    shadow: {
      // Sun-POV ortho depth target (shadow slice owns semantics + tuning).
      // 64 cells @ 2048 keeps ~the original texel density while letting the
      // Verdance titans (55–75u) throw full-length dawn shadows without a
      // screen-edge clip (Planetfall taste pass 2026-07-05).
      mapSize: 2048,
      radiusCells: 64,
      // Packed-depth receiver bias. Casters never self-receive in this slice,
      // so tune forgivingly against acne; DEV may override via __successor3dSunShadow.bias.
      bias: 0.00035,
    },
    flora: {
      enabled: true,
      densityScale: 1,
    },
  },
  pawn: {
    height: 1.7,
    defaultTint: "#d7d9d4",
    selectedTint: "#ffffff",
    shadowOpacity: 0.34,
    shadowWidth: 0.95,
    shadowDepth: 0.62,
    velocityYawEpsilonCellsPerFrame: 0.0025,
    // Visual-only compensation rotating the RENDERED pawn so the held rifle's
    // barrel — not the chest — points at the crosshair; tuned empirically.
    // This is renderer-only pose tuning; it never affects authority state.
    aimYawOffsetRad: 0,
    // Stationary local-player aim: the body tracks the aim heading directly at
    // this rate (fast — converges from any angle in <0.5s); the SlugthrowerRig bore
    // yaw-aligner keeps the gun on target during the transient. Torso yaw is
    // intentionally unused in this view (owner call 2026-07-03), and the
    // earlier hold/turn deadband hysteresis was removed after it read as
    // endless spinning when the cursor orbited.
    aimBodyTurnRadPerSec: 7,
    // LOD tier gating (render/pawns.ts): actors within hiFiRadiusCells of the
    // camera focus run the full per-frame animation mixer + weapon IK (HI-FI);
    // actors beyond are SIMULATION tier — they still exist, stream, and move
    // (position/yaw/gait-clip update every frame) but skip the expensive
    // mixer + IK eval. Radar-96 AOI era streams actors well beyond the ~24-cell
    // max view half-diagonal; hiFiRadiusCells (40) is the littlegrug +10-cell
    // bump (owner 2026-07-04) so pawns unfreeze into full animation earlier
    // without visible-state pop-in. Hysteresis stays at 4 cells so actors at the
    // boundary do not thrash tiers frame-to-frame.
    lod: {
      hiFiRadiusCells: 40,
      hysteresisCells: 4,
    },
  },
  // PawnForgeV2 animated character system (owned by the pawn/anim/weapons modules).
  pawnPack: {
    basePath: requireRuntimePublicPath("/assets/pawn-pack"),
    // Contract: pawn visual height ~1.7 world units; cooked mesh measures 1.7525 m.
    heightTargetUnits: 1.7,
    // Base locomotion (L0)
    idleSpeedCellsPerSec: 0.05,
    walkRunThresholdCellsPerSec: 3.2,
    backpedalDotThreshold: -0.15,
    baseCrossfadeSeconds: 0.11,
    overlayCrossfadeSeconds: 0.12,
    // Walk/run clip gate: server walk is 1.357 cells/s and Shift-run lands at
    // 6.525 cells/s, so the threshold sits between them with hysteresis room.
    // Unshifted movement stays in the walk gait; Shift is the only path to
    // run_f/rifle_run_f. Physical walk derivation: unarmed walk_f natural speed
    // is 1.399 m/s × (1.7 / 1.7525) = 1.357 cells/s, so walk_f plays at
    // timeScale ≈ 1.0. Armed rifle_walk_f currently runs ≈1.68x at walk speed;
    // that source clip is slower than the unarmed walk and can be retimed later.
    // Time-scale floor: the idle gate (idleSpeedCellsPerSec 0.05) owns
    // speeds below 0.05 cells/s, so the slowest displacement walk_f must
    // represent is ~0.05-0.1 cells/s -> speed/clipSpeed ≈ 0.04-0.07 against
    // the 1.357 cells/s walk clip. A 0.05 floor keeps playback tracking
    // displacement across that whole band (residual slide ≤ ~0.02 cells/s)
    // instead of the old 0.4 floor animating legs 4-8x faster than the
    // ground moves; it stays > 0 so the mixer never freezes mid-stride.
    timeScaleClamp: { min: 0.05, max: 5 },
    // Yaw
    yawLerpRadPerSec: 10,
    // Torso yaw sign: +1 rotates the torso toward positive aim delta (visually verified).
    torsoYawSign: 1,
    // Faction tint: body is subtly tinted; the blob shadow carries the strong relation color
    // so factions read at distance without fighting the PS2 skin material.
    bodyTintLerp: 0.3,
    shadowTintLerp: 0.75,
    sleepingShadowTint: "#3aa7ff",
    // Weapons / IK
    ikEaseSeconds: 0.12,
    magPullOutMeters: 0.12,
    magTweenSeconds: 0.25,
    // Deterministic bore leveling: the held weapon pivots around its grip
    // socket so pitch stays horizontal and yaw tracks the pawn/aim instead of
    // the Slugthrower clip's baked off-axis barrel. Pitch strength 0 disables pitch;
    // yawStrength 0 disables yaw. Resting yaw is used only when not aiming.
    boreLevel: {
      strength: 1,
      maxCorrectionRad: 0.6,
      yawStrength: 1,
      maxYawCorrectionRad: 0.45,
      restingYawRad: 0.1,
    },
    // Browser live-mount dial defaults; SlugthrowerRig exposes mutable copies as
    // window.__successor3dWeapon for grip/socket A/B passes.
    weaponMountDial: {
      posOffset: { x: 0, y: 0, z: 0 },
      rotOffsetDeg: { x: 0, y: 0, z: 0 },
    },
    // Support-hand IK contact: weapon-local offset added to the foregrip
    // socket so the WRIST bone (IK end effector) lands where the PALM wraps
    // the foregrip — without it the palm overshoots and the barrel rests on
    // the wrist (owner report 2026-07-03, viewed from behind). -z = toward
    // stock along the bore, -y = palm riding under the barrel.
    foregripContactOffset: { x: 0, y: -0.02, z: -0.055 },
    // Detached weapon death drop: brief deterministic settle, no physics sim.
    weaponDrop: {
      durationSeconds: 0.45,
      groundEpsilon: 0.025,
      slideCells: 0.15,
      tumbleRotations: 1.2,
    },
    // Out-of-combat back stow (owner spec 2026-07-03): the weapon rides a
    // spine-anchored socket — pistol grip at the right shoulder blade,
    // muzzle raking down-left across the back. Offsets are spine_03-local
    // and live-tunable via window.__successor3dWeapon (stow* dials); the
    // flourish is a world-space arc blend, never a reparent.
    weaponStow: {
      blendSeconds: 0.28,
      arcLift: 0.14,
      // Live-tuned 2026-07-03 (measured via muzzleWorld socket): grip end
      // high at the right shoulder blade, muzzle raking down-left — muzzle
      // lands ~0.92m, 0.12 cells to the pawn's anatomical left.
      posOffset: { x: 0.16, y: 0, z: -0.14 },
      rotOffsetDeg: { x: 85, y: -45, z: 0 },
    },
    // Vibrosword out-of-combat back stow: same spine_03-local schema as
    // weaponStow. Solved 2026-07-08 against the live skeleton (owner report:
    // sword floated at hip height, hilt through the left forearm, blade
    // across the thighs — read as "held wrong" at iso distance): guard rides
    // just behind/above the right shoulder blade, blade raking straight down
    // the back with a slight left-hip bias, flat against the back plane.
    swordStow: {
      blendSeconds: 0.28,
      arcLift: 0.14,
      posOffset: { x: -0.04, y: 0.25, z: -0.135 },
      rotOffsetDeg: { x: 91, y: 9, z: -93 },
    },
    // Reload montage: stretch the 4s clip to the server reload duration (clamped).
    reloadTimeScaleClamp: { min: 0.5, max: 2 },
  },
  input: {
    wheelStepPercent: 5,
    aimDeadZoneCells: 0.08,
    selectionPickCellSizePx: 32,
  },
  debug: {
    fpsSmoothing: 0.12,
  },
} as const;

export type Successor3dConfig = typeof SUCCESSOR_3D_CONFIG;
export type SuccessorBiomeId = keyof Successor3dConfig["biomes"];
