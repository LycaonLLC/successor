/**
 * Combat VFX tunables — single source of truth for all fx/** visuals.
 *
 * Coordinate contract (see successor3d-renderer-contract.md):
 *   sim (x, y) -> world (x, 0, y)   (sim-y becomes world-z)
 *   1 cell = 1 world unit.
 * Combat event points (originPoint / hitPoint) are already in the
 * continuous space where a pawn centre sits at actor.x + 0.5, so they map
 * DIRECTLY to world x/z with no extra offset.
 */

export interface BoltStyle {
  coreColor: number;
  headColor: number;
  radiusMul: number;
  headScaleMul: number;
  lengthMul: number;
  arc: boolean;
  hit?: "splash" | "implosion" | "discharge" | "emberburst";
  dark?: boolean;
  wobbleAmp?: number;
  wobbleHz?: number;
  stutterHz?: number;
  flicker?: boolean;
}


export const FX_CONFIG = {
  /** Ground plane reference height for settling particles. */
  groundY: 0.012,
  /** Muzzle / chest fallback height when no real muzzle socket is available. */
  chestHeight: 1.35,

  particles: {
    /** Max particles in the additive layer (muzzle flash + sparks share it). */
    additiveMax: 768,
    /** Max particles in the normal-blend layer retained for shared non-additive puffs. */
    residueMax: 192,
    normalMax: 512,
    /** Multiplier on the ortho world->pixel scale so sparks stay readable without blooming. */
    pointSizeBoost: 3,
    /** Canvas edge size for the procedural radial-gradient glow sprite. */
    glowSpriteSize: 64,
  },

  muzzle: {
    /** Max simultaneous flash point lights; beyond this flashes stay as restrained sprites. */
    maxSimultaneousLights: 2,
    lightColor: 0xffca78,
    lightPeak: 3.2,
    lightDurationSec: 0.045,
    lightDistance: 1.75,
    lightDecay: 2.0,
    /** Velocity drag for flash particles (heavier => flash stays tight to the muzzle). */
    flashDrag: 3.8,
    /** Core pop count, cone-streak count, ember count (per shot, restrained base). */
    coreCount: 1,
    coneCount: 6,
    emberCount: 2,
  },

  tracers: {
    /** Pooled tracer streaks (each = core cylinder mesh + head glow sprite). */
    poolSize: 48,
    coreColor: 0xffe39a,
    headColor: 0xfff0c0,
    radiusBase: 0.026,
    radiusPerMag: 0.004,
    /** Minimum streak length so a near-still frame reads without forming a beam. */
    minStreakLength: 0.22,
    /** Begin fading over the final fraction of total range. */
    fadeStartFraction: 0.75,
    /** Drop cosmetic bolts whose presentation speed is at/below this. */
    instantSpeedThreshold: 2,
  },

  /** Burst origin height (world-y) per hit zone. */
  zoneHeight: {
    head: 1.55,
    torso: 1.15,
    left_arm: 1.15,
    right_arm: 1.15,
    legs: 0.45,
  } as Record<string, number>,

  hit: {
    /** Spark burst (shield/dodge/deflect): readable ricochet streaks + small impact pops. */
    sparkStreakCount: 10,
    sparkFlashCount: 2,
    /** Modest magnitude boost applied when the target is killed. */
    killedMagnitudeBoost: 0.22,
    /**
     * Visual body radius (cells): a bolt that HITS a pawn terminates at the
     * collision surface facing the shooter — never the centre axis (owner
     * report 2026-07-08: bolts read as passing half a body deep before
     * vanishing). Misses still streak past; deflects stop at the blade.
     */
    impactSurfaceRadiusCells: 0.34,
    /**
     * Restrained hit-confirm pop for landed (blood) bolt arrivals: a brief
     * spark/flash at the impact surface so the round visibly ENDS somewhere.
     * Kept low — the blood burst stays the flesh language.
     */
    landedImpactSparkMag: 0.55,
  },

  /**
   * Personal Shield Generator shell (fx/shield.ts bubble + fx/shieldFormfit.ts
   * body-fit experiment). Runtime mode is toggled through
   * `window.__successorFx.psgTest("bubble" | "formfit")` so both reads can be
   * compared in-game. Colour canon is the 3D PSG identity (#2fd8ff, 540 ms
   * envelope); low-charge shells burn toward ember amber. Bubble radii wrap the
   * pawn from belt origin; intensity is the additive premultiplier (rim/ripple
   * crests are meant to trip the post pass's bloom extract).
   */
  psgShield: {
    mode: "formfit" as "bubble" | "formfit",
    poolSize: 6,
    lifeMs: 540,
    popMs: 70,
    color: 0x2fd8ff,
    lowChargeColor: 0xffb347,
    radiusX: 0.80,
    radiusY: 0.95,
    centerY: 0.92,
    intensity: 1.0,
    hexCellsAround: 14,
    hexRows: 9,
    rippleArcPerSecond: 5.2,
    formfit: {
      inflate: 0.045,
      hexCellsAround: 20,
      hexHeightRows: 6.5,
      intensity: 0.8,
      centerHeight: 0.9,
    },
  } as {
    mode: "bubble" | "formfit";
    poolSize: number;
    lifeMs: number;
    popMs: number;
    color: number;
    lowChargeColor: number;
    radiusX: number;
    radiusY: number;
    centerY: number;
    intensity: number;
    hexCellsAround: number;
    hexRows: number;
    rippleArcPerSecond: number;
    formfit: {
      inflate: number;
      hexCellsAround: number;
      hexHeightRows: number;
      intensity: number;
      centerHeight: number;
    };
  },

  /**
   * Pawn rim light (render/pawnRim.ts): cool sky-bounce fresnel edge on all
   * pawn-family matcap materials (body, gear, held weapons). Subtle by
   * design — it lifts silhouettes at iso distance without fighting the
   * matcap sculpt or the ToD grade.
   */
  pawnRim: {
    color: 0xbfdcff,
    strength: 0.34,
    power: 2.6,
  },


  /**
   * Cosmetic bolt style set (owner brief 2026-07-08: "diff sorts of bolts/
   * energy for future weapons"). Each style drives the pooled tracer's
   * core/head/streak parameters; `arc` additionally enables the jagged
   * lightning polyline. Weapon ids map via boltStyleForWeapon; unmapped
   * weapons fire `ballistic`. Test any style in-game without combat:
   * window.__successorFx.boltTest("plasma") — fans test rounds from the
   * player muzzle (slugthrower origin works).
   */
  boltStyles: {
    /** Tungsten tracer — the ballistic coil-slug family (slugthrower). */
    ballistic: {
      coreColor: 0xffe39a,
      headColor: 0xfff0c0,
      radiusMul: 1.0,
      headScaleMul: 1.0,
      lengthMul: 1.0,
      arc: false,
    },
    /** Energy slug — fat teal core, slow-feel glow. */
    plasma: {
      coreColor: 0x3fe8ff,
      headColor: 0x9ff7ff,
      radiusMul: 2.2,
      headScaleMul: 1.7,
      lengthMul: 0.55,
      arc: false,
      hit: "splash",
    },
    /** Burning scatter ember — orange, short, angry. */
    ember: {
      coreColor: 0xff7a1f,
      headColor: 0xffc37a,
      radiusMul: 1.5,
      headScaleMul: 1.2,
      lengthMul: 0.7,
      arc: false,
      hit: "emberburst",
    },
    /** Rail lance — violet-white needle, screen-length streak. */
    lance: {
      coreColor: 0xd9b8ff,
      headColor: 0xf3eaff,
      radiusMul: 0.55,
      headScaleMul: 0.8,
      lengthMul: 3.2,
      arc: false,
      hit: "splash",
    },
    /** Tesla arc — jagged crackling bolt, blue-white. */
    arc: {
      coreColor: 0x7fd4ff,
      headColor: 0xe8f8ff,
      radiusMul: 0.8,
      headScaleMul: 1.3,
      lengthMul: 1.0,
      arc: true,
      hit: "discharge",
    },
    /** Tranq needle — thin sickly green, minimal glow. */
    needle: {
      coreColor: 0x8aff5a,
      headColor: 0xc8ffb0,
      radiusMul: 0.5,
      headScaleMul: 0.6,
      lengthMul: 1.3,
      arc: false,
    },
    /** Void round — light-swallowing slug ringed in violet. */
    void: { coreColor: 0x0a0612, headColor: 0x9b4dff, radiusMul: 1.6, headScaleMul: 1.5, lengthMul: 0.8, arc: false, dark: true, hit: "implosion" },
    /** Serpent bolt — S-curves visibly in flight. */
    serpent: { coreColor: 0x2fffb0, headColor: 0xbfffe4, radiusMul: 0.7, headScaleMul: 1.0, lengthMul: 1.6, arc: false, wobbleAmp: 0.12, wobbleHz: 3, hit: "splash" },
    /** Wisp — spectral flame, gutters and flickers. */
    wisp: { coreColor: 0x8affd8, headColor: 0xe8fff4, radiusMul: 1.3, headScaleMul: 1.4, lengthMul: 0.5, arc: false, flicker: true, wobbleAmp: 0.05, wobbleHz: 7, hit: "implosion" },
    /** Pulse rifle — stuttering dash-chase read. */
    pulse: { coreColor: 0xffd23f, headColor: 0xfff3c0, radiusMul: 0.9, headScaleMul: 0.9, lengthMul: 1.7, arc: false, stutterHz: 9, hit: "splash" },
    /** Magnum fireball — heavy incendiary slug. */
    magnum: { coreColor: 0xff5533, headColor: 0xffb27a, radiusMul: 2.8, headScaleMul: 2.4, lengthMul: 0.45, arc: false, hit: "emberburst" },
  } satisfies Record<string, BoltStyle>,
  
  /**
   * Blood palette library. Current organic actors use red; green and blue stay
   * available for future alien/toxic and synthetic/coolant identities. Every
   * blood burst can leave persistent ground residue sized by severity.
   * Triples are linear RGB for the particle layer.
   */
  blood: {
    residuePerHit: 3,
    residueLifeMinS: 10,
    residueLifeMaxS: 18,
    palettes: {
      red: {
        spray: [0.62, 0.05, 0.05],
        drip: [0.5, 0.04, 0.04],
        residue: [0.38, 0.018, 0.022],
      },
      green: {
        spray: [0.28, 0.55, 0.08],
        drip: [0.2, 0.42, 0.06],
        residue: [0.13, 0.28, 0.05],
      },
      blue: {
        spray: [0.12, 0.35, 0.72],
        drip: [0.08, 0.26, 0.6],
        residue: [0.05, 0.16, 0.4],
      },
    },
  },

  /**
   * Beam family (fx/beams.ts) — full-line weapon effects (owner brief:
   * "more full line effects like the lightning... for other guns that shoot
   * electricity style... a few diff types"). Distinct line identities:
   *   arcbeam   one hot trunk + flickering side-FORKS (electricity weapon)
   *   pulsebeam segmented dashes TRAVELING along the line (energy repeater)
   *   searbeam  solid core+halo lance that BLOOMS at contact, one-shot
   */
  beamsFx: {
    poolPerKind: 4,
    arcbeam: { lifeMs: 900, color: 0xa9e8ff, forks: 4, forkLen: 0.55, jitter: 0.08, strobeHz: 13 },
    pulsebeam: { lifeMs: 1000, color: 0xffd23f, dashes: 7, dashLen: 0.5, speed: 14 },
    searbeam: { lifeMs: 550, coreColor: 0xfff6da, haloColor: 0xff9a3d, bloomScale: 0.9 },
  },

  /**
   * Force-power-class effects (fx/powers.ts) — caster/target driven,
   * showcase-first until the mechanics land authoritatively.
   */
  powersFx: {
    poolPerKind: 4,
    lightning: { lifeMs: 1400, color: 0x9fd8ff, strobeHz: 12, braidR: 0.22, jitter: 0.1 },
    push: { lifeMs: 500, color: 0xd8c9a8, range: 4.5, debris: 6 },
    channel: { lifeMs: 2000, color: 0xb08aff, motes: 12 },
    healcast: { lifeMs: 1200, color: 0xffd76a, motes: 10, arcHeight: 1.4 },
  },

  /**
   * Status-effect transients (fx/status.ts) — the pop when a state LANDS on
   * a pawn (owner brief 2026-07-08: "transient things that pop up as big
   * effects when someone gets hit with a blind or a bleed or a poison...").
   * Each owns ONE motion verb (identity doctrine from the hit archetypes):
   * blind=IRIS, bleed=ARTERIAL, poison=RISE-BUBBLE, disease=SWARM,
   * burning=LICK, intimidate=SLAM-RADIAL, hot=DRIFT-UP, bigheal=PILLAR-BLOOM.
   * Colors are inherent to the status (not caller params).
   */
  statusFx: {
    poolPerKind: 6,
    blind: { lifeMs: 650, color: 0xfff2c0, veilScale: 0.9, irisStart: 0.7 },
    bleed: { lifeMs: 900, color: 0x6e0a0a, jets: 3, dropsPerJet: 5, speed: 2.4, gravity: 6.5 },
    poison: { lifeMs: 1400, color: 0x5ad13a, motes: 9, riseSpeed: 0.55, wobbleHz: 2.2 },
    disease: { lifeMs: 1600, color: 0x6b7a2a, spores: 11, orbitR: 0.42, jitter: 0.11 },
    burning: { lifeMs: 1300, color: 0xff6a1f, tongues: 9, height: 1.2, flickerHz: 11 },
    intimidate: { lifeMs: 620, color: 0x8a1020, ringEnd: 1.6, flashScale: 0.8 },
    hot: { lifeMs: 2200, color: 0x8fe8a0, sparkles: 8, riseSpeed: 0.32 },
    bigheal: { lifeMs: 1100, color: 0xffd76a, pillarHeight: 2.6, ringEnd: 1.1, sparkles: 10 },
    /** Stimpak aura — the SECULAR heal: clinical vitals-surge, no gold, no pillar. */
    stim: { lifeMs: 700, color: 0x7fffd0, ticks: 5, ringScale: 0.55 },
    /** Spice arc — archetypal drug language: rush (upper), haze (trip), crash (comedown). */
    spicerush: { lifeMs: 750, color: 0xff5aa0, rings: 2, streaks: 6 },
    spicehaze: { lifeMs: 2400, color: 0xb07aff, motes: 10, drift: 0.5 },
    spicecrash: { lifeMs: 1600, color: 0x9db4d8, motes: 9, sink: 0.6 },
  },

  /** Styled impact effects (fx/hits.ts) — spawned ALONGSIDE the legacy spark/blood read when the arriving bolt's style names a hit archetype. */
  hitFx: {
    poolPerKind: 10,
    splash: { lifeMs: 300, startRadius: 0.12, endRadius: 0.85, popScale: 0.5 },
    implosion: { lifeMs: 380, sprites: 10, startRadius: 0.62, popScale: 1.05 },
    discharge: { lifeMs: 320, lines: 5, reach: 0.95, jitter: 0.13, flashScale: 0.55, strobeHz: 11, tipScale: 0.085 },
    emberburst: { lifeMs: 900, sprites: 8, speed: 2.6, gravity: 5.5, spriteScale: 0.24 },
    /** Crystal burst: out, FREEZE mid-air, drop. The pause is the identity. */
    shatter: { lifeMs: 620, shards: 7, burstRadius: 0.42, glintScale: 0.4 },
    /** Vertical eruption — the only impact that goes UP. */
    geyser: { lifeMs: 800, sprites: 9, columnHeight: 1.1, speedY: 4.2, gravity: 7 },
    /** Alien flower: unfold, hold, wilt. */
    petals: { lifeMs: 780, petals: 6, radius: 0.3, petalW: 0.12, petalH: 0.22 },
    /** Luminous moths spiralling off the wound. */
    orbit: { lifeMs: 750, sprites: 8, omega: 9, baseRadius: 0.14, growth: 0.55, spriteScale: 0.13 },
  },

} as const;


/** Bolt style id — keys of FX_CONFIG.boltStyles. */
export type BoltStyleId = keyof typeof FX_CONFIG.boltStyles;

/** Blood palette id — keys of FX_CONFIG.blood.palettes. */
export type BloodPaletteId = keyof typeof FX_CONFIG.blood.palettes;
export const BLOOD_PALETTE_IDS: readonly BloodPaletteId[] = ["red", "green", "blue"];
export type BloodPalette = (typeof FX_CONFIG.blood.palettes)[BloodPaletteId];

/**
 * Map a weapon id to its cosmetic bolt style. Ballistic firearms are the
 * default; future energy weapons opt in here (single source of truth so
 * events/tracers/roll bolts all agree).
 */
export function boltStyleForWeapon(weaponId: string | undefined | null): BoltStyleId {
  switch (weaponId) {
    // future wiring examples: "rail-lance" -> "lance"
    case "sleep-dart-pistol":
      return "needle";
    /** Tesla family — the lightning carbine crackles. */
    case "lightning-carbine":
      return "arc";
    /** Energy carbine fires the fat teal plasma slug. */
    case "wpn-carbine":
      return "plasma";
    default:
      return "ballistic";
  }
}
