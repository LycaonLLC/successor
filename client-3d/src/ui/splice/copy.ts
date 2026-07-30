import { craftResultWord } from "@successor/client/src/slice-core/craftResultBands";

/**
 * SPLICE copy — every player-facing string for the gene bench, in one map.
 * DESIGN.md copy law: no dev strings reach a player; server reasonCodes get
 * player-language lines; chrome is short nouns; explanations live on hover.
 * Voice: the gene-lab tech — precise, unsentimental, faintly proud of the work.
 */

// ── Reason codes (splice reject union + shared denials) ─────────────────────
const REASON_LINES: Readonly<Record<string, string>> = {
  missinggenesampler: "No Gene Sampler in your pack.",
  missinggenomescanner: "No Genome Scanner in your pack.",
  missingsplicebench: "No Splice Bench in your pack.",
  genomeunavailable: "That genome isn't on record — scan or resample the seed.",
  splicesessionactive: "Finish the splice on your bench first.",
  nosplicesession: "Nothing on the bench.",
  spliceslotmismatch: "That doesn't belong in this slot.",
  splicealreadyassembled: "Already assembled — experiment or mint.",
  splicenotassembled: "Seat both parents and assemble first.",
  invalidsplicelocus: "No such locus.",
  invalidspliceexperiment: "That line can't take more work.",
  ingredientunavailable: "Not enough of that stack for the bench.",
  unknowncropspecies: "Unknown crop species.",
  itemunavailable: "That stack isn't in your pack.",
  targetunavailable: "You haven't trained the gene bench.",
  economycooldown: "The sampler is still recharging.",
  samplecooldown: "The sampler is still recharging.",
  containerfull: "Your pack is full.",
  inventoryfull: "Your pack is full.",
  actordead: "Not while you're down.",
  actorasleep: "Not while you're resting.",
};

function fallbackReasonLine(code: string): string {
  const words = code
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words.length > 0 ? `Refused — ${words}.` : "Refused at the bench.";
}

/** Player-language line for a server reject reasonCode. Never dev-cased. */
export function spliceReasonLine(reasonCode: string | null | undefined): string {
  if (!reasonCode) return "Refused at the bench.";
  const key = reasonCode.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return REASON_LINES[key] ?? fallbackReasonLine(reasonCode);
}

// ── Locus display labels (wire label -> compact chrome noun) ────────────────
const LOCUS_LABELS: Readonly<Record<string, string>> = {
  yield: "YIELD",
  growth_rate: "GROWTH",
  water_economy: "WATER",
  hardiness: "HARDINESS",
  storm_resistance: "STORM",
  blight_resistance: "BLIGHT",
  quality: "QUALITY",
  regrowth: "REGROWTH",
  season_affinity: "SEASON",
  stature: "STATURE",
  mutation_potential: "MUTATION",
  potency: "POTENCY",
  vigor: "VIGOR",
};

export function locusLabel(wireLabel: string): string {
  const key = wireLabel.trim().toLowerCase();
  return LOCUS_LABELS[key] ?? wireLabel.replace(/_/gu, " ").toUpperCase();
}

// ── Scan-tier display (honest reveal names) ─────────────────────────────────
const TIER_LABELS: Readonly<Record<string, string>> = {
  phenotype: "phenotype only",
  hidden_presence: "hidden variation",
  allele_values: "allele values",
  full: "full sequence",
};

export function tierLabel(tier: string): string {
  return TIER_LABELS[tier] ?? tier.replace(/_/gu, " ");
}

/** True once the reveal exposes the exact allele pair (design §3.3). */
export function tierRevealsAlleles(tier: string): boolean {
  return tier === "allele_values" || tier === "full";
}

// ── Assembly stamp (shared band word + gene-bench flavor) ───────────────────
const STAMP_LINES: Readonly<Record<string, string>> = {
  MASTERWORK: "A clean assembly — the loci hold.",
  FINE: "Tighter than the parents ran.",
  SOUND: "Stable. The line will breed true with work.",
  FAIR: "Workable. The caps are modest.",
  ROUGH: "It assembled. Don't expect elite caps.",
  CRUDE: "Barely coalesced.",
};

export interface AssemblyStampTier {
  stamp: string;
  line: string;
}

export function spliceStampFor(qualityMilli: number): AssemblyStampTier {
  const stamp = craftResultWord(qualityMilli);
  return { stamp, line: STAMP_LINES[stamp] ?? "" };
}

// ── Fixed flow copy (short nouns / honest gates) ────────────────────────────
export const SPLICE_COPY = {
  /** Phase rail steps, in order. */
  phases: ["LAB", "BENCH", "SPLICE"] as const,
  lab: {
    lockerTitle: "SEED LOCKER",
    lockerEmpty: "No crop seeds in your pack",
    lockerEmptyHint: "Sample wild flora or learn a starter packet.",
    scan: "SCAN",
    scanned: "SCANNED",
    unscanned: "UNSCANNED",
    cardIdle: "Select a seed to read its genome",
    sampleTitle: "SAMPLE WILD FLORA",
    sampleHint: "Bank a wild landrace as seed (the sampler has its own cadence).",
    beginTitle: "OPEN THE BENCH",
    beginHint: "Spread two parent seeds and splice a new cultivar.",
    begin: "BEGIN SPLICE",
    sterile: "STERILE — mints no child seed",
    fertile: "FERTILE",
  },
  bench: {
    parents: "PARENT LINES",
    reagents: "REAGENTS",
    packTitle: "IN YOUR PACK",
    packEmpty: "Nothing here fits this slot",
    assign: "Double-click or drag to seat",
    clear: "CLEAR",
    lociTitle: "LOCI — segregation",
    lociHint: "Pick one allele from each parent per locus. Unscanned parents read UNKNOWN.",
    parentAShort: "A",
    parentBShort: "B",
    parentAHeader: "PARENT A",
    parentBHeader: "PARENT B",
    unknown: "UNKNOWN",
    elite: "elite",
    basePreview: "child",
    assemble: "ASSEMBLE",
    assembleGate: "Seat both parent lines to assemble.",
    assembleWarn: "Assembly spends the seated seeds and reagents.",
    cancel: "CANCEL",
    cancelFree: "Nothing spent yet — cancelling is free.",
  },
  finish: {
    title: "SPLICE",
    quality: "ASSEMBLY",
    points: "EXPERIMENT POINTS",
    apply: "EXPERIMENT",
    applyHint: "Spend marked points on the marked loci.",
    lineCapped: "At its ceiling",
    mintName: "CULTIVAR NAME",
    mintNamePlaceholder: "(auto-named if blank)",
    mint: "MINT SEED",
    mintHint: "Intern the child genome — a named seed to your pack.",
    cancel: "DISCARD",
    cancelArm: "INPUTS ARE SPENT — DISCARD AGAIN TO CONFIRM",
    cancelHint: "The seated seeds and reagents are already spent. Discarding forfeits them.",
    minted: "CULTIVAR MINTED",
    discarded: "DISCARDED · INPUTS FORFEITED",
  },
  deny: "DENIED",
} as const;
