#!/usr/bin/env node
// Imports and optimizes site media from ratified sources into site/public.
// Every output is committed; this script exists for provenance and refresh,
// not as a build step. Requires ImageMagick + cwebp.
//
// Sources:
// - Owner capture lane (source commit 8e1ed520, local Rust authority,
//   outfit matched to authority; provide its root via SUCCESSOR_OWNER_CAPTURES.
// - Verification farm client-3d journey proofs (run 1784899243000, 2026-07-24):
//   verification/ledgers/artifacts/client3d/
// Honest HUD included on purpose: these are evidence, not staged marketing.
// The `crop` is the deliberate mobile focus region (WxH+X+Y on the source).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const cli = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const input = (name, env, description) => {
  const value = cli(name) ?? process.env[env];
  if (!value) {
    throw new Error(`Missing ${description}; set ${env} or pass --${name} <path>`);
  }
  return resolve(value);
};
const ownerRoot = input("owner-captures", "SUCCESSOR_OWNER_CAPTURES", "owner capture root");
const proofsRoot = input("proofs", "SUCCESSOR_VERIFICATION_PROOFS", "verification proofs root");
const mobileSource = input("mobile", "SUCCESSOR_MOBILE_SOURCE", "mobile capture");
const audioSource = input("audio", "SUCCESSOR_AUDIO_SOURCE", "audio source");
const PROOFS = join(proofsRoot, "verify-full-1784899243000-3d-");
const OWNER_CAPTURES = ownerRoot;

const captures = [
  {
    out: "hero-pawn",
    src: `${OWNER_CAPTURES}/01-pawn-ancient-structure-1600x1000.png`,
    wide: 1400,
    quality: 76,
    wideOnly: true,
  },
  {
    // Phone hero: the planetfall travel screen stays legible at 360px where
    // zoomed-out isometric field captures do not.
    out: "hero-planetfall",
    src: `${PROOFS}-travel-a0/proofs/h3d-travel-02-arrival-verdance.png`,
    crop: "700x700+370+110",
    small: 700,
    quality: 80,
    smallOnly: true,
  },
  {
    out: "play-inventory",
    src: `${OWNER_CAPTURES}/04-inventory-truth-moment-1600x1000.png`,
    crop: "1000x840+300+50",
  },
  {
    out: "travel-planetfall",
    src: `${PROOFS}-travel-a0/proofs/h3d-travel-02-arrival-verdance.png`,
    crop: "980x700+230+120",
  },
  {
    out: "interior-cutaway",
    src: `${PROOFS}-commerce-interior-a0/proofs/h3d-commerce-interior-03-interior-cutaway.png`,
    crop: "1000x780+180+60",
  },
  {
    out: "craft-camp-kit",
    src: `${PROOFS}-camp-a0/proofs/h3d-camp-04-camp-kit-crafted.png`,
    crop: "760x700+250+130",
  },
  {
    out: "downed-recovery",
    src: `${PROOFS}-revive-a0/proofs/h3d-revive-01-downed.png`,
    crop: "980x700+230+120",
  },
  {
    out: "survey-heatmap",
    src: `${PROOFS}-survey-a0/proofs/h3d-survey-03-heatmap.png`,
    crop: "480x620+0+150",
  },
];

const MOBILE_SRC = mobileSource;
const AUDIO_SRC = audioSource;

const mediaDir = join(SITE, "public/media");
const audioDir = join(SITE, "public/audio");
mkdirSync(mediaDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

for (const capture of captures) {
  const { out, src, crop, wide = 1200, small = 640, quality = 76 } = capture;
  if (!existsSync(src)) {
    console.warn(`skip (source missing): ${src}`);
    continue;
  }
  if (!capture.smallOnly) {
    const tmpWide = join(tmpdir(), `site-media-${out}-wide.png`);
    run("magick", [src, "-resize", `${wide}x`, tmpWide]);
    run("cwebp", ["-quiet", "-q", String(quality), tmpWide, "-o", join(mediaDir, `${out}-${wide}.webp`)]);
  }
  if (!capture.wideOnly) {
    const tmpCrop = join(tmpdir(), `site-media-${out}-crop.png`);
    run("magick", [src, "-crop", crop, "+repage", "-resize", `${small}x`, tmpCrop]);
    run("cwebp", ["-quiet", "-q", String(quality), tmpCrop, "-o", join(mediaDir, `${out}-${small}.webp`)]);
  }
}

if (existsSync(MOBILE_SRC)) {
  // Native-size phone capture; displayed at ~20rem, no crop needed.
  run("cwebp", ["-quiet", "-q", "78", MOBILE_SRC, "-o", join(mediaDir, "mobile-surface-390.webp")]);
} else {
  console.warn(`skip (mobile capture missing): ${MOBILE_SRC}`);
}

if (existsSync(AUDIO_SRC)) {
  // Owner-ratified track, copied byte-for-byte. Never re-encode ratified audio.
  copyFileSync(AUDIO_SRC, join(audioDir, "old-intro-charcreate.mp3"));
} else {
  console.warn(`skip (audio source missing): ${AUDIO_SRC}`);
}

console.log("media import complete");
