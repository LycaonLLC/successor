/**
 * CRAFT register — the workbench as a mode of the prose (design §9.2,
 * Main-approved 2026-07-08).
 *
 * Pure composers over the shared craft presentation contract. The server owns every
 * truth: recommendation, eligibility, caps, quality; these functions only
 * phrase it. Result words come from the ONE shared band table
 * (slice-core/craftResultBands — owner-ratified voice set), so a prototype
 * stamped FINE in the 3D window reads FINE in this prose.
 *
 * Wire binding waits on CraftSimW67's CONTRACTS-LIVE; until then the router
 * answers with the honest unbound deny (CraftWindowFE's port pattern).
 */

import { craftResultWord } from "@successor/client/src/slice-core/craftResultBands";
import { slotMaterialLine, slotQtyText, slotRequirementLabel } from "@successor/client/src/slice-core/crafting/slotPresentation";
import type {
  CraftAssembledVM,
  CraftRecipeDetailVM,
  CraftRecipeSummaryVM,
  CraftSlotFillVM,
  CraftSlotScreenVM,
} from "@successor/client/src/slice-core/crafting/types";

export interface CraftLine {
  register: string;
  text: string;
}

const SLOT_NUMERALS = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ"] as const;

function slotNumeral(index: number): string {
  return SLOT_NUMERALS[index] ?? `#${index + 1}`;
}

/** `1. ⚙ Extractor Battery — component · multitool · trained` */
export function composeRecipeList(recipes: readonly CraftRecipeSummaryVM[]): CraftLine[] {
  if (recipes.length === 0) {
    return [{ register: "system", text: "You know no recipes yet — training and salvage both teach." }];
  }
  const lines: CraftLine[] = [{ register: "help", text: "Known recipes:" }];
  recipes.forEach((recipe, index) => {
    const uses = recipe.remainingUses !== undefined && recipe.remainingUses !== null
      ? ` · ${recipe.remainingUses} uses left`
      : "";
    const source = recipe.source === "learned" ? " · learned" : "";
    const hands = recipe.handsCraftable ? " · hands-craftable" : "";
    const lock = recipe.unlocked ? "" : " · LOCKED";
    lines.push({
      register: recipe.unlocked ? "system" : "receipt",
      text: `  ${index + 1}. ${recipe.name} — ${recipe.category}${source}${uses}${hands}${lock}`,
    });
  });
  return lines;
}

/** Detail block: slots wanted + stat ceilings, in prose. */
export function composeRecipeInfo(detail: CraftRecipeDetailVM, name: string): CraftLine[] {
  const wants = detail.slots
    .map((slot) => {
      const material = slotMaterialLine(slot);
      const label = slotRequirementLabel(slot);
      return material
        ? `${slotNumeral(slot.slotIndex)} ${label} — ${material}`
        : `${slotNumeral(slot.slotIndex)} ${label} ${slotQtyText(slot)}`;
    })
    .join(" · ");
  const lines: CraftLine[] = [
    { register: "survey", text: `${name}: the frame wants ${wants}.` },
  ];
  for (const line of detail.statLines) {
    lines.push({ register: "system", text: `  ${line.label}: ceiling ~${Math.round(line.capEstimateMilli / 10) / 100}` });
  }
  return lines;
}

/** Session-open beat + the slot screen (recommendation surfaced both ways). */
export function composeSlotScreen(screen: CraftSlotScreenVM, recipeName: string): CraftLine[] {
  const lines: CraftLine[] = [
    { register: "survey", text: `You lay out the tools. The ${recipeName.toLowerCase()} wants:` },
  ];
  for (const slot of screen.slots) {
    lines.push(...composeSlotBlock(slot));
  }
  const recommended = screen.slots.find((slot) => !slot.assigned && slot.eligible.some((option) => option.recommended));
  const pick = recommended?.eligible.find((option) => option.recommended);
  if (pick) {
    lines.push({
      register: "survey",
      text: `The bench likes the ${pick.name} lot for its ${String(recommended!.craftRelevantStat).replaceAll("_", " ")}.`,
    });
  }
  lines.push({
    register: "system",
    text: screen.canAssemble
      ? "Every slot is seated — /craft assemble when ready. (/craft fill <slot> <n> · /craft clear <slot> · /craft cancel)"
      : "/craft fill <slot> <n> seats a lot · /craft fill auto takes every bench pick · /craft cancel walks away.",
  });
  return lines;
}

function composeSlotBlock(slot: CraftSlotFillVM): CraftLine[] {
  const material = slotMaterialLine(slot);
  const label = slotRequirementLabel(slot);
  const qty = material ? "" : ` ${slotQtyText(slot)}`;
  const header = slot.assigned
    ? `SLOT ${slotNumeral(slot.slotIndex)} — ${label}${qty}   [seated]`
    : `SLOT ${slotNumeral(slot.slotIndex)} — ${label}${qty}   [empty]`;
  const lines: CraftLine[] = [{ register: "help", text: header }];
  if (material) {
    lines.push({ register: "system", text: `    ${material}` });
  }
  if (!slot.assigned && slot.eligible.length === 0) {
    lines.push({ register: "receipt", text: "    nothing eligible in your pack" });
    return lines;
  }
  slot.eligible.forEach((option, index) => {
    const seated = slot.assigned && slot.assigned.stackId === option.stackId && slot.assigned.container === option.container;
    const marks = [
      option.recommended ? "◆ bench pick" : null,
      seated ? "seated" : null,
    ].filter(Boolean).join(" · ");
    lines.push({
      register: seated ? "survey" : "system",
      text: `    ${index + 1}. ${option.name} ×${option.qtyAvailable} — ${String(slot.craftRelevantStat).replaceAll("_", " ")} ${option.craftRelevantStatValue}${marks ? `  ${marks}` : ""}`,
    });
  });
  return lines;
}

const GAUGE_WIDTH = 8;

/** Assembled phase: quality band word + numbered stat gauge rows + points. */
export function composeAssembled(assembled: CraftAssembledVM): CraftLine[] {
  const word = craftResultWord(assembled.assemblyQualityMilli);
  const lines: CraftLine[] = [
    { register: "survey", text: `Assembly holds — ${word} work (quality ${Math.round(assembled.assemblyQualityMilli / 10)}%).` },
  ];
  for (const line of assembled.lines) {
    const frac = line.capMilli > 0 ? Math.max(0, Math.min(1, line.valueMilli / line.capMilli)) : 0;
    const filled = Math.round(frac * GAUGE_WIDTH);
    const gauge = "▰".repeat(filled) + "▱".repeat(GAUGE_WIDTH - filled);
    const raisable = line.canRaise ? "" : "  (at cap)";
    lines.push({
      register: "system",
      text: `  ${line.lineId}. ${line.label.toUpperCase().padEnd(12)} ${line.valueMilli} / cap ${line.capMilli}  ${gauge}${raisable}`,
    });
  }
  lines.push({
    register: "system",
    text: `Experimentation: ${assembled.experimentationPointsRemaining} point${assembled.experimentationPointsRemaining === 1 ? "" : "s"}. /craft exp <line> <pts>… · /craft prototype · /craft draft <uses> · /craft cancel`,
  });
  return lines;
}

/** Experiment outcome narration from the refreshed VM (server truth). */
export function composeExperimentDelta(
  lineLabel: string,
  beforeMilli: number,
  afterMilli: number,
  pointsSpent: number,
  pointsRemaining: number,
): CraftLine {
  if (afterMilli > beforeMilli) {
    return {
      register: "survey",
      text: `You lean on ${lineLabel.toUpperCase()} — ${beforeMilli} → ${afterMilli}. ${pointsSpent} point${pointsSpent === 1 ? "" : "s"} spent, ${pointsRemaining} remain.`,
    };
  }
  if (afterMilli === beforeMilli) {
    return {
      register: "receipt",
      text: `The ${lineLabel.toUpperCase()} line refuses to move — ${pointsSpent} point${pointsSpent === 1 ? "" : "s"} spent for nothing. ${pointsRemaining} remain.`,
    };
  }
  return {
    register: "reject",
    text: `The experiment slips — ${lineLabel.toUpperCase()} falls ${beforeMilli} → ${afterMilli}. ${pointsRemaining} remain.`,
  };
}

/** Prototype landing: the band word is the same one the 3D window stamps. */
export function composePrototypeLine(recipeName: string, qualityMilli: number): CraftLine {
  return {
    register: "loot",
    text: `The prototype comes off the bench ${craftResultWord(qualityMilli)}: ${recipeName}, into your pack.`,
  };
}

export function composeDraftLine(recipeName: string, uses: number): CraftLine {
  return {
    register: "loot",
    text: `You commit the work to a factory draft — ${recipeName} ×${uses} uses, filed to your datapad.`,
  };
}

/** Lossy-cancel armed warning (the text twin of the 3D confirm dialog). */
export function composeCancelWarning(slotsCommitted: number, pointsUnspent: number): CraftLine {
  const held = [
    slotsCommitted > 0 ? `${slotsCommitted} slot${slotsCommitted === 1 ? "" : "s"} committed` : null,
    pointsUnspent > 0 ? `${pointsUnspent} point${pointsUnspent === 1 ? "" : "s"} unspent` : null,
  ].filter(Boolean).join(", ");
  return {
    register: "reject",
    text: `Cancelling forfeits the assembled work (${held}). Repeat /craft cancel within 10s to walk away.`,
  };
}
