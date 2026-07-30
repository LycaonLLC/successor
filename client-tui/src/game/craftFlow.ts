/**
 * /craft workbench flow — session ops onto the live wire (§9.2, bound at
 * CONTRACTS-LIVE 2026-07-08).
 *
 * Commands ride the registry's generated craft verbs (manifest tags 48-56)
 * so budgets/receipts flow like every other hand. Rendering consumes the
 * craftSession VM through an injected source: ExtractorFE's client ingest
 * lands that stream; until it does the source yields null and the flow
 * answers with wire truth only (receipts) — no fabricated screens.
 */

import type { CraftRecipeSummaryVM, CraftSessionVM, CraftSlotFillVM } from "@successor/client/src/slice-core/crafting/types";

import type { ServerAuthorityCraftSessionState, ServerAuthorityResourceStatsState } from "@successor/client/src/slice-core/gameState";

import type { GameSession } from "./session";
import type { ArmedConfirm } from "./armedConfirm";
import {
  composeAssembled,
  composeCancelWarning,
  composeExperimentDelta,
  composeRecipeInfo,
  composeRecipeList,
  composeSlotScreen,
  type CraftLine,
} from "../language/registers/craft";

/** Raw streamed session source — bound to serverAuthority.craftSession (a59ddde). */
export type CraftSessionSource = () => ServerAuthorityCraftSessionState | null;

export const CRAFT_CANCEL_KEY = "craft:cancel";

const STREAM_PENDING = "The bench has not spoken yet — /craft begin <recipe|n> opens the session channel.";

/**
 * Adapter: the streamed ServerAuthorityCraftSessionState → the VM contract
 * the composers speak (CraftWindowFE types). Two honest narrowings: recipe
 * `source` narrows to the trained/learned union (anything else drops the
 * channel), and slotScreen fills join `craftRelevantStat` from the detail's
 * slot specs by slotIndex (the wire carries it on the spec, not the fill).
 */
export function craftSessionVmFromState(state: ServerAuthorityCraftSessionState | null): CraftSessionVM | null {
  if (!state) return null;
  if (state.phase !== "slots" && state.phase !== "assembled") return null;
  const statBySlot = new Map<number, string>();
  for (const spec of state.detail?.slots ?? []) statBySlot.set(spec.slotIndex, String(spec.craftRelevantStat));
  const specBySlot = new Map<number, NonNullable<ServerAuthorityCraftSessionState["detail"]>["slots"][number]>();
  for (const spec of state.detail?.slots ?? []) specBySlot.set(spec.slotIndex, spec);
  return {
    phase: state.phase,
    recipeId: state.recipeId ?? "",
    slotScreen: state.slotScreen
      ? {
        recipeId: state.slotScreen.recipeId,
        canAssemble: state.slotScreen.canAssemble,
        slots: state.slotScreen.slots.map((slot) => {
          const spec = specBySlot.get(slot.slotIndex);
          return {
            slotIndex: slot.slotIndex,
            symbol: slot.symbol,
            resourceKindLabel: slot.resourceKindLabel,
            requiredQty: slot.requiredQty,
            requiredItemId: slot.requiredItemId ?? spec?.requiredItemId ?? null,
            requiredFamily: slot.requiredFamily ?? spec?.requiredFamily ?? null,
            requirementKind: slot.requirementKind ?? spec?.requirementKind,
            requiredItemName: slot.requiredItemName ?? spec?.requiredItemName ?? null,
            eligible: slot.eligible,
            assigned: slot.assigned ?? null,
            craftRelevantStat: (statBySlot.get(slot.slotIndex) ?? "craft-relevant stat") as CraftSlotFillVM["craftRelevantStat"],
          };
        }),
      }
      : null,
    assembled: state.assembled ?? null,
  };
}

/** Recipe browser rows straight off the streamed session state. */
export function craftRecipesFromState(state: ServerAuthorityCraftSessionState | null): CraftRecipeSummaryVM[] {
  return (state?.recipes ?? []).map((recipe) => ({
    recipeId: recipe.recipeId,
    name: recipe.name,
    category: recipe.category as CraftRecipeSummaryVM["category"],
    outputItemId: recipe.outputItemId,
    outputPreviewVariantId: recipe.outputPreviewVariantId,
    unlocked: recipe.unlocked,
    requiredToolItemId: recipe.requiredToolItemId,
    requiredProfession: recipe.requiredProfession,
    source: recipe.source === "learned" ? "learned" : "trained",
    remainingUses: recipe.remainingUses ?? null,
    handsCraftable: recipe.handsCraftable,
  }));
}

export function routeCraftFlow(
  session: GameSession,
  confirm: ArmedConfirm,
  craftSession: CraftSessionSource,
  args: readonly string[],
): CraftLine[] {
  const sub = (args[0] ?? "").toLowerCase();
  const usage = "Craft: /craft begin <recipe> · fill <slot> <n> | fill auto · clear <slot> · assemble · exp <line> <pts>… · prototype · draft <uses> · cancel";

  if (sub === "" || sub === "help") {
    const vm = craftSessionVmFromState(craftSession());
    if (vm) return renderSession(vm, recipeDisplayName(craftSession(), vm.recipeId));
    const recipes = craftRecipesFromState(craftSession());
    if (recipes.length > 0) return composeRecipeList(recipes);
    return [{ register: "system", text: usage }];
  }

  if (sub === "list") {
    const recipes = craftRecipesFromState(craftSession());
    if (recipes.length === 0) return [{ register: "system", text: STREAM_PENDING }];
    return composeRecipeList(recipes);
  }

  if (sub === "info") {
    const raw = craftSession();
    const detail = raw?.detail ?? null;
    if (!detail) return [{ register: "system", text: "No recipe detail on the bench — /craft begin <recipe|n> first." }];
    const name = raw?.recipes.find((recipe) => recipe.recipeId === detail.recipeId)?.name ?? detail.recipeId;
    return composeRecipeInfo({
      recipeId: detail.recipeId,
      outputItemId: detail.outputItemId,
      outputPreviewVariantId: detail.outputPreviewVariantId,
      statLines: detail.statLines,
      slots: detail.slots.map((slot) => ({
        slotIndex: slot.slotIndex,
        symbol: slot.symbol,
        resourceKindLabel: slot.resourceKindLabel,
        requiredItemId: slot.requiredItemId ?? null,
        requiredFamily: slot.requiredFamily ?? null,
        requirementKind: slot.requirementKind,
        requiredItemName: slot.requiredItemName ?? null,
        requiredQty: slot.requiredQty,
        // wire widens to `keyof … | string`; the spec's keys ARE the sim's stat vocabulary
        craftRelevantStat: slot.craftRelevantStat as keyof ServerAuthorityResourceStatsState,
      })),
    }, name);
  }

  if (sub === "begin") {
    const token = args[1]?.trim();
    if (!token) return [{ register: "system", text: "Begin what? /craft begin <recipe-id|n> (/craft list numbers them)" }];
    confirm.disarm();
    const recipes = craftRecipesFromState(craftSession());
    const index = Number(token);
    const byNumber = Number.isInteger(index) && index >= 1 && index <= recipes.length ? recipes[index - 1] : null;
    return [wireLine(session, `/craft-begin recipe_id=${byNumber?.recipeId ?? token}`)];
  }

  if (sub === "fill") {
    confirm.disarm();
    const vm = craftSessionVmFromState(craftSession());
    if (!vm || !vm.slotScreen) {
      return [{ register: "system", text: `Slot eligibility is server truth — it reaches the terminal with the session stream. ${STREAM_PENDING}` }];
    }
    if ((args[1] ?? "").toLowerCase() === "auto") return fillAuto(session, vm.slotScreen.slots);
    const slot = resolveSlot(vm.slotScreen.slots, args[1]);
    if (!slot) return [{ register: "reject", text: "No such slot — the screen numbers them Ⅰ, Ⅱ, …" }];
    const optionIndex = Number(args[2]);
    const option = Number.isInteger(optionIndex) && optionIndex >= 1 && optionIndex <= slot.eligible.length
      ? slot.eligible[optionIndex - 1]!
      : null;
    if (!option) return [{ register: "reject", text: `Slot ${args[1]} offers 1..${slot.eligible.length}.` }];
    return [wireLine(session, assignLine(slot, option.container, option.stackId, option.variantId))];
  }

  if (sub === "clear") {
    confirm.disarm();
    const vm = craftSessionVmFromState(craftSession());
    const slot = vm?.slotScreen ? resolveSlot(vm.slotScreen.slots, args[1]) : null;
    const slotIndex = slot?.slotIndex ?? (Number.isInteger(Number(args[1])) ? Number(args[1]) - 1 : null);
    if (slotIndex === null || slotIndex < 0) return [{ register: "system", text: "Clear which slot? /craft clear <slot>" }];
    return [wireLine(session, `/craft-clear-slot slot_index=${slotIndex}`)];
  }

  if (sub === "assemble") {
    confirm.disarm();
    return [wireLine(session, "/craft-assemble")];
  }

  if (sub === "exp" || sub === "experiment") {
    confirm.disarm();
    const pairs: Array<{ line: number; points: number }> = [];
    for (let i = 1; i + 1 < args.length + 1; i += 2) {
      const line = Number(args[i]);
      const points = Number(args[i + 1]);
      if (!Number.isInteger(line) || !Number.isInteger(points) || points <= 0) break;
      pairs.push({ line, points });
    }
    if (pairs.length === 0) return [{ register: "system", text: "Spend how? /craft exp <line> <points> [<line> <points>…]" }];
    return pairs.map((pair) => wireLine(session, `/craft-experiment line_id=${pair.line} points=${pair.points}`));
  }

  if (sub === "prototype") {
    confirm.disarm();
    return [wireLine(session, "/craft-finalize-prototype")];
  }

  if (sub === "draft") {
    confirm.disarm();
    const uses = Number(args[1]);
    if (!Number.isInteger(uses) || uses < 1 || uses > 1000) {
      return [{ register: "system", text: "Draft with how many uses? /craft draft <1..1000>" }];
    }
    return [wireLine(session, `/craft-draft-schematic max_uses=${uses}`)];
  }
  if (sub === "factory" || sub === "manufacture") {
    confirm.disarm();
    const factoryId = String(args[1] ?? "").trim();
    const schematicId = String(args[2] ?? "").trim();
    if (!factoryId || !schematicId) {
      return [{ register: "system", text: "Manufacture how? /craft factory <factory_id> <schematic_id>" }];
    }
    return [wireLine(session, `/factory-manufacture factory_id=${factoryId} schematic_id=${schematicId}`)];
  }

  if (sub === "cancel") {
    const vm = craftSessionVmFromState(craftSession());
    const slotsCommitted = vm?.slotScreen?.slots.filter((slot) => slot.assigned).length ?? 0;
    const pointsUnspent = vm?.assembled?.experimentationPointsRemaining ?? 0;
    const lossy = vm === null || slotsCommitted > 0 || pointsUnspent > 0;
    if (lossy && confirm.arm(CRAFT_CANCEL_KEY)) {
      return [vm
        ? composeCancelWarning(slotsCommitted, pointsUnspent)
        : { register: "reject", text: "Cancelling forfeits whatever the bench holds. Repeat /craft cancel within 10s to walk away." }];
    }
    confirm.confirm(CRAFT_CANCEL_KEY);
    return [wireLine(session, "/craft-cancel")];
  }

  return [{ register: "system", text: usage }];
}

/** Render whichever phase the session VM is in (composers own the words). */
export function renderSession(vm: CraftSessionVM, displayName?: string): CraftLine[] {
  if (vm.phase === "assembled" && vm.assembled) return composeAssembled(vm.assembled);
  if (vm.slotScreen) return composeSlotScreen(vm.slotScreen, displayName ?? vm.recipeId);
  return [{ register: "system", text: "The bench is between states — give it a beat." }];
}

/** Human recipe name off the streamed ledger; falls back to the id. */
export function recipeDisplayName(state: ServerAuthorityCraftSessionState | null, recipeId: string): string {
  return state?.recipes.find((recipe) => recipe.recipeId === recipeId)?.name ?? recipeId;
}

function fillAuto(session: GameSession, slots: readonly CraftSlotFillVM[]): CraftLine[] {
  const lines: CraftLine[] = [];
  for (const slot of slots) {
    if (slot.assigned) continue;
    // "fill auto takes every bench pick" — the pick is server judgment (the
    // recommended flag adapts to stock, ties, depletion). No flag, no guess:
    // seating eligible[0] would silently overrule the bench.
    const pick = slot.eligible.find((option) => option.recommended);
    if (!pick) {
      lines.push({
        register: "receipt",
        text: slot.eligible.length === 0
          ? `Slot ${slot.slotIndex + 1}: nothing eligible — the bench pick skips it.`
          : `Slot ${slot.slotIndex + 1}: the bench offers no pick — /craft fill ${slot.slotIndex + 1} <n> to choose by hand.`,
      });
      continue;
    }
    lines.push(wireLine(session, assignLine(slot, pick.container, pick.stackId, pick.variantId)));
  }
  if (lines.length === 0) lines.push({ register: "system", text: "Every slot is already seated." });
  return lines;
}

function assignLine(slot: CraftSlotFillVM, container: string, stackId: string, variantId: number): string {
  return `/craft-assign-slot slot_index=${slot.slotIndex} container=${container} stack_id=${stackId} variant_id=${variantId}`;
}

/** One registry line onto the wire; echoes the registry's own text. */
function wireLine(session: GameSession, line: string): CraftLine {
  const result = session.executeVerb(line);
  if (!result) return { register: "reject", text: `The bench does not know that shape (${line}).` };
  const rejected = result.class === "authority" && result.data.queued === false;
  return { register: rejected ? "reject" : "receipt", text: result.text };
}

function resolveSlot(slots: readonly CraftSlotFillVM[], token: string | undefined): CraftSlotFillVM | null {
  if (!token) return null;
  const numerals = ["ⅰ", "ⅱ", "ⅲ", "ⅳ", "ⅴ", "ⅵ", "ⅶ", "ⅷ", "ⅸ"];
  const lowered = token.trim().toLowerCase();
  const byNumeral = numerals.indexOf(lowered);
  const index = byNumeral !== -1 ? byNumeral : Number(lowered) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  return slots.find((slot) => slot.slotIndex === index) ?? null;
}

/** Receipt kinds whose ACCEPT warrants a refreshed session render. */
const CRAFT_RENDER_KINDS: Record<string, true> = {
  CraftBegin: true,
  CraftAssignSlot: true,
  CraftClearSlot: true,
  CraftAssemble: true,
  CraftExperiment: true,
};

export interface CraftNarrator {
  /** True when an accepted receipt of `kind` should schedule a render. */
  wantsRender(kind: string | undefined): boolean;
  /** Refreshed session block + experiment-delta prose (VM diff, server truth). */
  render(): CraftLine[];
}

/**
 * Narrates the session stream after craft receipts: experiment deltas come
 * from diffing the refreshed assembled VM against the previous one — the
 * numbers are always the server's, never predicted.
 */
export function createCraftNarrator(session: GameSession, craftSession: CraftSessionSource): CraftNarrator {
  let lastAssembled: CraftSessionVM["assembled"] = null;
  return {
    wantsRender(kind) {
      return kind !== undefined && CRAFT_RENDER_KINDS[kind] === true;
    },
    render() {
      const vm = craftSessionVmFromState(craftSession());
      const lines: CraftLine[] = [];
      if (vm?.assembled && lastAssembled && vm.recipeId === lastAssembled.recipeId) {
        const pointsSpent = Math.max(0, lastAssembled.experimentationPointsRemaining - vm.assembled.experimentationPointsRemaining);
        for (const line of vm.assembled.lines) {
          const prior = lastAssembled.lines.find((candidate) => candidate.lineId === line.lineId);
          if (prior && prior.valueMilli !== line.valueMilli) {
            lines.push(composeExperimentDelta(line.label, prior.valueMilli, line.valueMilli, pointsSpent, vm.assembled.experimentationPointsRemaining));
          }
        }
      }
      if (vm) lines.push(...renderSession(vm, recipeDisplayName(craftSession(), vm.recipeId)));
      lastAssembled = vm?.assembled ? { ...vm.assembled, lines: vm.assembled.lines.map((line) => ({ ...line })) } : null;
      return lines;
    },
  };
}
