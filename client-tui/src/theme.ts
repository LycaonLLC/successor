/**
 * Quartermaster's Slate, terminal edition.
 *
 * The headed client's fixed semantic palette (oxide/
 * olive/bone on soot, brass pips, the cyan scope accent) translated into
 * terminal color: truecolor first, an authored 256-color fallback second,
 * bare bold/dim last. Roles are SEMANTIC — panes and composers name a role
 * (`ink`, `danger`, `brass`), never a hex — so degrade is one table swap.
 */

export type ColorMode = "truecolor" | "ansi256" | "mono";

export interface ThemeColor {
  /** 24-bit reference swatch. */
  rgb: readonly [number, number, number];
  /** Authored xterm-256 fallback (NOT a naive quantize — picked for contrast). */
  ansi256: number;
}

/** Fixed swatches (3D parity: SUCCESSOR_THEME.palette + sc3d chrome). */
export const SLATE = {
  /** Sun-bleached primary text (bone #e4d7b4). */
  ink: { rgb: [228, 215, 180], ansi256: 187 },
  /** Secondary text / labels (boneDim #a2946f). */
  dim: { rgb: [162, 148, 111], ansi256: 144 },
  /** Whisper: hairlines, latent chrome (derived soot-lifted). */
  faint: { rgb: [104, 95, 74], ansi256: 101 },
  /** Rust-red stamps: HEALTH, DOWN, rejections (oxide #a63c20). */
  oxide: { rgb: [166, 60, 32], ansi256: 130 },
  /** Field-drab: ACTION (olive #767446). */
  olive: { rgb: [118, 116, 70], ansi256: 101 },
  /** Brass/cartridge: SPIRIT, ammo pips (ochre #b98c3a). */
  brass: { rgb: [185, 140, 58], ansi256: 172 },
  /** Scope accent: self, waypoints, focus (sc3d accent #48d6e6). */
  accent: { rgb: [72, 214, 230], ansi256: 80 },
  /** Hostile / danger (sc3d danger #e34a4a). */
  danger: { rgb: [227, 74, 74], ansi256: 167 },
  /** Alerted contacts / cautions (radar amber #f1d06b). */
  amber: { rgb: [241, 208, 107], ansi256: 221 },
  /** Confirmations, FIRED beats (field-green, queue parity). */
  green: { rgb: [122, 197, 118], ansi256: 114 },
  /** Desert haze — scene prose warmth (haze #c9ad82). */
  haze: { rgb: [201, 173, 130], ansi256: 180 },
  /** Backdrop plate (soot #17130d) — used sparingly; terminals keep their bg. */
  soot: { rgb: [23, 19, 13], ansi256: 233 },
  /** Raised plate for gauges/chat strip (soot lifted). */
  plate: { rgb: [38, 33, 24], ansi256: 235 },
} as const satisfies Record<string, ThemeColor>;

export type SlateRole = keyof typeof SLATE;

/** Log registers → color roles (one voice, one ink discipline). */
export const REGISTER_ROLE: Record<string, SlateRole> = {
  scene: "haze",
  world: "ink",
  combat: "ink",
  "combat-own": "ink",
  receipt: "dim",
  reject: "oxide",
  survey: "brass",
  loot: "brass",
  system: "dim",
  chat: "ink",
  help: "dim",
};

export interface ThemeStrings {
  masthead: string;
  theatre: string;
  gaugeHealth: string;
  gaugeAction: string;
  gaugeSpirit: string;
  downStamp: string;
  respawnStamp: string;
  rearming: string;
  swingReady: string;
  swing: string;
  noSignal: string;
}

/** Stenciled vocabulary (statusPlate parity where the surfaces overlap). */
export const STRINGS: ThemeStrings = {
  masthead: "SUCCESSOR",
  theatre: "OPEN DESERT THEATRE",
  gaugeHealth: "HEALTH",
  gaugeAction: "ACTION",
  gaugeSpirit: "SPIRIT",
  downStamp: "DOWN",
  respawnStamp: "RESPAWN",
  rearming: "REARMING",
  swingReady: "READY",
  swing: "SWING",
  noSignal: "AWAITING FIELD MANIFEST",
};

/** Sim weapon ids → stenciled field designations (theme.ts parity). */
const WEAPON_NAMES: Record<string, string> = {
  slugthrower: "SLUGTHROWER",
  vibrosword: "VIBROSWORD",
};

export function weaponDisplayName(weaponId: string | null | undefined): string {
  if (!weaponId) return "UNARMED";
  return WEAPON_NAMES[weaponId] ?? weaponId.replace(/-/g, " ").toUpperCase();
}

export function detectColorMode(env: NodeJS.ProcessEnv = process.env): ColorMode {
  if (env.NO_COLOR) return "mono";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  if (colorterm.includes("truecolor") || colorterm.includes("24bit")) return "truecolor";
  const term = env.TERM ?? "";
  if (term === "dumb" || term === "") return "mono";
  if (/-direct|kitty|ghostty|wezterm|alacritty|iterm/i.test(term)) return "truecolor";
  if (/256color/.test(term)) return "ansi256";
  return "ansi256";
}
