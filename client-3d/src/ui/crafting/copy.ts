/**
 * CRAFT copy — every player-facing string for the crafting flow, in one map.
 *
 * DESIGN.md copy law: no dev strings reach a player; server reasonCodes get
 * player-language lines; chrome text is minimal short nouns; explanations
 * live on hover. Voice: the requisition office — dry, factual, field-worn.
 */

// ── Reason codes (§A.8 + queue denials) ────────────────────────────────────
// Keys are normalized (lowercase, separators stripped) so the same line
// answers `CraftSlotUnfilled`, `craft_slot_unfilled` and `CRAFT SLOT UNFILLED`.

const REASON_LINES: Readonly<Record<string, string>> = {
  craftsessionactive: "Finish the work on your bench first.",
  nocraftsession: "Nothing on the bench.",
  craftslotunfilled: "Fill every slot to assemble.",
  craftslotmismatch: "That material doesn't fit this slot.",
  craftslotquantity: "Not enough of that stack for this slot.",
  craftalreadyassembled: "Already assembled — choose an exit.",
  craftnotassembled: "Assemble first.",
  invalidexperimentline: "That line can't take more work.",
  noexperimentpoints: "No experimentation points left.",
  schematicusesexceeded: "This schematic is spent.",
  unknownfactory: "No factory on record there.",
  notatfactory: "Step up to the factory workbench.",
  factorydraftmissing: "That draft is not in your pack.",
  factorydraftmismatch: "That draft is not yours.",
  ingredientunavailable: "Missing locked materials for this run.",
  unknownrecipe: "No such pattern on record.",
  recipelocked: "You haven't trained that pattern.",
  missingcrafttool: "No crafting tool in your pack.",
  missingtool: "No crafting tool in your pack.",
  missingprofession: "You haven't trained that pattern.",
  insufficientresources: "Not enough materials in your pack.",
  inventoryfull: "Your pack is full.",
  datapadfull: "Your datapad is full.",
  invalidmaxuses: "Use count must be 1 to 1000.",
  actordead: "Not while you're down.",
  actorbusy: "Finish what you're doing first.",
};

/** Fallback: prettify an unmapped code without leaking dev casing. */
function fallbackReasonLine(code: string): string {
  const words = code
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .trim()
    .toLowerCase();
  return words.length > 0 ? `Refused — ${words}.` : "Refused by the field office.";
}

/** Player-language line for a server reject reasonCode. Never dev-cased. */
export function craftReasonLine(reasonCode: string | null | undefined): string {
  if (!reasonCode) return "Refused by the field office.";
  const key = reasonCode.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return REASON_LINES[key] ?? fallbackReasonLine(reasonCode);
}

// ── Recipe short descriptions (browser ledger; ≤60 chars, dry tone) ────────

const RECIPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  field_multitool: "One tool for every field job. Builds without a bench.",
  metal_extractor: "Deployable rig that pulls ore while you're elsewhere.",
  extractor_battery: "Bottled charge for an extractor. Conductor sets the hours.",
  slugthrower: "Coil-driven slug rifle. Iron in, trouble out.",
  iron_slug: "Pressed iron coil slugs. Charge wafer launches the pack.",
  shard_slug: "Shard coil slugs. Same press as iron, harder bite.",
  spike_slug: "Spike coil slugs. Same press as iron, deeper punch.",
};

const FALLBACK_DESCRIPTION = "Field pattern. Materials decide the quality.";

export function recipeDescription(recipeId: string): string {
  return RECIPE_DESCRIPTIONS[recipeId] ?? FALLBACK_DESCRIPTION;
}

// ── Fixed flow copy (short nouns / honest gates) ───────────────────────────

export const CRAFT_COPY = {
  /** Phase rail steps, in order. */
  phases: ["SCHEMATIC", "LOAD", "ASSEMBLE", "TUNE", "FINISH"] as const,
  browser: {
    listTitle: "KNOWN RECIPES",
    empty: "No recipes known",
    emptyHint: "Train a profession or learn one from the field.",
    locked: "Not trained yet",
    limitedUses: (remaining: number) => `${remaining} use${remaining === 1 ? "" : "s"} left`,
    searchPlaceholder: "Filter patterns",
    searchLabel: "Filter recipes by name",
    showIneligible: "SHOW INELIGIBLE",
    hideIneligible: "HIDE INELIGIBLE",
    eligibilityHint: "Include recipes locked behind profession skill boxes.",
    eligibleEmpty: "No eligible recipes",
    eligibleEmptyHint: "Show ineligible to inspect profession paths.",
    searchEmpty: "No patterns match",
    searchEmptyHint: "Clear the filter to see every pattern.",
    groupKnown: (known: number, total: number) => `${known}/${total} KNOWN`,
    nextUp: "NEXT UP",
    sourceTrained: "TRAINED",
    sourceLearned: "LEARNED",
    bareHands: "BARE HANDS",
    bareHandsHint: "No tool held — working bare-handed. Expect rough results.",
    toolGateHint: "Needs a crafting tool in your pack.",
    begin: "BEGIN ASSEMBLY",
    requirements: "REQUIRED MATERIALS",
    limits: "EXPECTED LIMITS",
    limitsHint: "Ceilings, not promises — materials set the real numbers.",
    ready: "READY",
    missing: "MISSING",
    carried: (owned: number) => `${owned.toLocaleString("en-US")} carried`,
  },
  slots: {
    title: "LOAD MATERIALS",
    qualityInfo: "How true the stock is. Quality times each slot's weight sets the cap pin on every line — poor stock caps tuning low, fine stock opens the range.",
    eligibleTitle: "IN YOUR PACK",
    eligibleEmpty: "Nothing in your pack fits this slot",
    recommended: "BEST FIT",
    shortStack: "Stack too small",
    shortStackNeed: (own: number, need: number) => `OWN ${own.toLocaleString("en-US")} · NEED ${need.toLocaleString("en-US")}`,
    assign: "Click LOAD to fill the slot — drag or double-click also works",
    load: "LOAD",
    loadedTag: "LOADED",
    activeSlot: (label: string, qty: number) => `LOADING · ${label.toUpperCase()} · ×${qty}`,
    clear: "CLEAR",
    assemble: "ASSEMBLE",
    assembleGate: "Fill every slot to assemble.",
    assembleWarn: "Assembly spends the loaded materials.",
    cancel: "CANCEL",
    cancelFree: "Nothing is spent yet — cancelling is free.",
  },
  tune: {
    points: "TUNE POINTS",
    poolOf: (left: number, max: number) => `${left} / ${max}`,
    settle: "ASSEMBLY TRUE — LINES SET FROM SEATED MATERIALS",
    linesTitle: "PROPERTY LINES",
    capInfo: "The pin is this line's ceiling — material quality times slot weight. Tuning can push the caret to the pin, never past it. Better stock, further pin.",
    riskInfo: "Each marked point is one tuning attempt. Stacking points on a line pushes harder but succeeds less often; a failed attempt can slip the line the wrong way. Nothing is rolled until you press EXPERIMENT.",
    towardCap: "TOWARD CAP · BETTER",
    hold: (chance: string) => `HOLD ${chance}`,
    slip: (chance: string) => `SLIP ${chance}`,
    slipWarn: "A slip moves the line the wrong way.",
    toFinish: "TO FINISH",
  },
  finish: {
    title: "FINISH",
    quality: "ASSEMBLY",
    apply: "EXPERIMENT",
    applyHint: "Spend marked points on the marked lines.",
    backToTune: "BACK TO TUNE",
    nameLabel: "ITEM NAME",
    nameHint: "Empty keeps the schematic name.",
    namePlaceholder: "Name it (optional)",
    modeLabel: "LEAVE THE BENCH AS",
    prototype: "PROTOTYPE",
    prototypeNote: "Build the item into your pack.",
    prototypeGo: "CREATE PROTOTYPE",
    practice: "PRACTICE",
    practiceNote: "+5% base XP · materials spent · no item.",
    practiceGo: "RUN PRACTICE",
    practiceInfo: "A training pass. The loaded materials are consumed and no item is made. Pays the full assembly XP plus 5%.",
    draft: "DRAFT SCHEMATIC",
    draftNote: "Record the tuned result as a limited-use pattern.",
    draftGo: "DRAFT SCHEMATIC",
    draftHint: "Freeze this result as a factory pattern — it goes to your datapad.",
    draftUses: "USES",
    draftUsesInfo: "How many times this schematic can be crafted from before it is spent. 1 to 1000.",
    lineCapped: "At its ceiling",
    lineRaised: (points: number) => `+${points} marked`,
    abandon: "ABANDON",
    abandonArm: "MATERIALS WILL BE LOST — ABANDON AGAIN TO CONFIRM",
    abandonHint: "The loaded materials are already spent. Abandoning forfeits them.",
    prototypeDone: "PROTOTYPE TO PACK",
    practiceDone: "PRACTICE LOGGED",
    practiceDoneSub: "+5% BASE XP · MATERIALS SPENT · NO ITEM",
    draftDone: "DRAFT TO DATAPAD",
  },
  drafts: {
    tabTitle: "SCHEMATICS",
    title: "FACTORY DRAFTS",
    empty: "No drafts on file",
    emptyHint: "Finish an assembly and choose DRAFT SCHEMATIC.",
    uses: (remaining: number, max: number) => `${remaining}/${max} USES`,
    spent: "SPENT",
    manufacture: "MANUFACTURE",
    manufactureQueued: "Factory run queued.",
    manufactureBlocked: "Could not queue factory run.",
    needFactory: "Use the Dustgate factory workbench to spend this draft.",
    manufactureDone: "Factory run complete.",
    manufactureSpent: "Draft spent — pattern retired.",
    locks: "LOCKED MATERIALS",
    stats: "FROZEN RESULT",
  },
  deny: "DENIED",
} as const;
