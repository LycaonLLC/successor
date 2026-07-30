import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCollectExtractorCommand,
  enqueueAuthorityCrankExtractorCommand,
  enqueueAuthorityHarvestCorpseCommand,
  enqueueAuthorityPackUpCampCommand,
  enqueueAuthorityStopCrankCommand,
  enqueueAuthorityToggleDoorCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { enqueueTakeAllLootStacks, interactionOptions, isHarvestableCreatureActor } from "@successor/client/src/slice-core/interactionSystem";
import { setActiveTravelTerminal } from "../travel/travelSystem";
import { CONVERSE_WINDOW_ID, setConverseTarget } from "../dialogue/converseWindowIds";
import { LOOT_WINDOW_ID, setLootTarget } from "../windows/defs/lootWindowIds";
import { armPackUpConfirm, disarmPackUpConfirm, packUpConfirmArmed } from "../camp/actions";
import {
  activeLootHold,
  beginLootHold,
  cancelLootHold,
  HOLD_TO_TAKE_ALL_MS,
  markLootHoldFired,
} from "../../overlay/lootHold";

/**
 * Interact dispatch — the F-verb's SEMANTICS. Pure dispatcher since the
 * banner rewrite (2026-07-08): presentation is the world-anchored chip on the
 * overlay canvas (overlay/interactChip.ts, which also publishes
 * `state.interactions.options` per frame).
 *
 * TAP vs HOLD on a lootable (owner ruling 2026-07-08): F-DOWN over a humanoid
 * corpse or loot cache ARMS a 1s hold instead of opening the window; a quick
 * release (tap) opens the LOOT window as before, but holding past
 * HOLD_TO_TAKE_ALL_MS fires the client-loop take-all (one TakeLootItem per
 * stack) and the release is swallowed. The chip paints the radial fill.
 * Creature corpses stay HARVEST and every other interactable
 * (door / extractor / trainer / terminal / exchange) fires immediately on
 * F-down — only loot arms a hold.
 */
export interface InteractPromptController {
  /** F-down: arm a loot hold, or dispatch the non-loot verb. */
  performSelected(): boolean;
  /** F-up: a tap opens the loot window; a fired hold is swallowed. */
  releaseSelected(): void;
  /** Per-frame: fire the take-all once the hold crosses the threshold, or
   *  drop the hold if the target slips out of selection/reach. */
  tick(nowMs: number): void;
  dispose(): void;
}

export interface InteractPromptDeps {
  openWindow: (id: string) => void;
  openBankTerminal: (propId: string) => void;
  openCloneTerminal: (propId: string) => void;
  openPaTerminal: (propId: string) => void;
  openFactoryTerminal: (propId: string) => void;
  sfx: SfxPlayer;
}

interface HeldLootTarget {
  optionId: string;
  kind: "corpse" | "cache";
  targetId: string;
  container: string;
  label: string;
}

export function mountInteractPrompt(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
  deps: InteractPromptDeps,
): InteractPromptController {
  void shell; // presentation lives on the overlay canvas now

  const selectedOption = () => {
    const options = interactionOptions(slice, state);
    state.interactions.options = options;
    if (options.length === 0) return null;
    const index = Math.max(0, Math.min(state.interactions.selectedIndex, options.length - 1));
    return options[index] ?? null;
  };

  /** The selected option as a hold-eligible loot target, or null. Creature
   *  corpses are not loot-all (they harvest), so they never arm a hold. */
  const heldLootTargetFor = (option: ReturnType<typeof selectedOption>): HeldLootTarget | null => {
    if (!option) return null;
    if (option.kind === "corpse") {
      const actor = state.serverAuthority.actors[option.targetId];
      if (actor && isHarvestableCreatureActor(actor)) return null;
      return { optionId: option.id, kind: "corpse", targetId: option.targetId, container: `corpse:${option.targetId}`, label: option.label };
    }
    if (option.kind === "lootCache") {
      return {
        optionId: option.id,
        kind: "cache",
        targetId: option.targetId,
        container: option.container ?? `cache:${option.targetId}`,
        label: option.label,
      };
    }
    return null;
  };
  const openLootWindow = (target: HeldLootTarget): void => {
    const authoredContainer = target.kind === "cache"
      ? slice.props?.find((prop) => prop.id === target.targetId)?.container
      : undefined;
    setLootTarget({
      kind: target.kind,
      id: target.targetId,
      ...(target.kind === "cache" && (target.container ?? authoredContainer) !== undefined
        ? { container: target.container ?? authoredContainer }
        : {}),
    });
    deps.openWindow(LOOT_WINDOW_ID);
    deps.sfx.play("ui_button_tick");
  };

  const fireTakeAll = (target: HeldLootTarget): void => {
    const queued = enqueueTakeAllLootStacks(state, slice, target.container);
    markLootHoldFired();
    if (queued > 0) {
      deps.sfx.play("item_transfer");
      state.status = `stripped ${target.label.toLowerCase()} — ${queued} stack${queued === 1 ? "" : "s"} claimed`;
    } else {
      deps.sfx.play("ui_deny");
      state.status = `${target.label.toLowerCase()} — nothing to take`;
    }
  };

  return {
    performSelected(): boolean {
      const selected = selectedOption();
      if (!selected) return false;
      // Loot targets ARM a hold (tap→window on release, hold→take-all). Every
      // other verb dispatches immediately on F-down, unchanged.
      const loot = heldLootTargetFor(selected);
      if (loot) {
        beginLootHold(loot.optionId, loot.container, loot.label, performance.now());
        return true;
      }
      if (selected.kind === "extractor") {
        const extractor = state.serverAuthority.placedExtractors.find(
          (entry) => entry.extractorId === selected.targetId,
        );
        const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
        const queued = extractor?.mode === "manual"
          ? enqueueAuthorityStopCrankCommand(state.authorityCommands, issuedAtTick)
          : (extractor?.hopperPct ?? 0) > 0
            ? enqueueAuthorityCollectExtractorCommand(state.authorityCommands, selected.targetId, issuedAtTick)
            : enqueueAuthorityCrankExtractorCommand(state.authorityCommands, selected.targetId, issuedAtTick);
        if (queued) deps.sfx.play("ui_button_tick");
        return Boolean(queued);
      }
      if (selected.kind === "camp") {
        const nowMs = performance.now();
        if (!packUpConfirmArmed(selected.targetId, nowMs)) {
          armPackUpConfirm(selected.targetId, nowMs);
          state.status = "F again — nothing returns";
          deps.sfx.play("ui_button_tick");
          return true;
        }
        disarmPackUpConfirm();
        const queued = enqueueAuthorityPackUpCampCommand(
          state.authorityCommands,
          authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
        );
        if (queued) deps.sfx.play("ui_button_tick");
        return Boolean(queued);
      }
      if (selected.kind === "corpse") {
        // Creature corpses are harvested; lootable humanoid corpses arm a hold above.
        const queued = enqueueAuthorityHarvestCorpseCommand(
          state.authorityCommands,
          selected.targetId,
          authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
        );
        if (queued) deps.sfx.play("ui_button_tick");
        return Boolean(queued);
      }
      if (selected.kind === "exchange") {
        deps.openWindow("datapad");
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "trainer") {
        setConverseTarget(selected.targetId);
        state.selectedActorId = selected.targetId;
        deps.openWindow(CONVERSE_WINDOW_ID);
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "travelTerminal") {
        setActiveTravelTerminal(selected.targetId);
        deps.openWindow("travel");
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "factoryTerminal") {
        deps.openFactoryTerminal(selected.targetId);
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "bankTerminal") {
        deps.openBankTerminal(selected.targetId);
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "cloneTerminal") {
        deps.openCloneTerminal(selected.targetId);
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "paTerminal") {
        deps.openPaTerminal(selected.targetId);
        deps.sfx.play("ui_button_tick");
        return true;
      }
      if (selected.kind === "door") {
        const queued = enqueueAuthorityToggleDoorCommand(
          state.authorityCommands,
          selected.targetId,
          authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
        );
        if (queued) deps.sfx.play("ui_button_tick");
        return Boolean(queued);
      }
      return false;
    },
    releaseSelected(): void {
      const hold = activeLootHold();
      if (!hold) return;
      // A slow frame can span the entire hold interval, so key-up must enforce
      // the same threshold as tick(). Otherwise a genuine 1s hold can be
      // misread as a tap merely because no render frame landed before release.
      const target = heldLootTargetFor(selectedOption());
      if (!hold.fired
        && target
        && target.optionId === hold.optionId
        && performance.now() - hold.startMs >= HOLD_TO_TAKE_ALL_MS) {
        fireTakeAll(target);
      }
      // A fired hold already took-all — swallow the release. An un-fired hold
      // was a TAP: open the loot window on the still-selected target.
      if (!hold.fired) {
        if (target && target.optionId === hold.optionId) openLootWindow(target);
      }
      cancelLootHold();
    },
    tick(nowMs: number): void {
      const hold = activeLootHold();
      if (!hold || hold.fired) return;
      // Re-resolve every frame: if the held target is no longer the selected
      // in-reach option (walked away, V-cycled, corpse faded), drop the hold so
      // the ring resets and the release can't mis-fire a stale window.
      const target = heldLootTargetFor(selectedOption());
      if (!target || target.optionId !== hold.optionId) {
        cancelLootHold();
        return;
      }
      if (nowMs - hold.startMs >= HOLD_TO_TAKE_ALL_MS) {
        fireTakeAll(target);
      }
    },
    dispose(): void {
      cancelLootHold();
    },
  };
}
