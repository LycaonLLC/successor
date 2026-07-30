import "./targetPlate.css";
import { actorNameplateFillStyle } from "@successor/client/src/slice-core/actorPresentationSystem";
import { actorTargetSummary, selectedActor } from "@successor/client/src/slice-core/selectionSystem";
import { serverAuthorityDisplayName } from "@successor/client/src/slice-core/npcSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { stripTypeRead } from "./actorNames";

/**
 * Target status plate — top-left HUD, adjacent right of the player plate.
 *
 * Renders while `state.selectedActorId` resolves to an actor. The combat
 * picture (2026-07-08 polish):
 *  - Relation-tinted name AND left rail (same fill-style source the overlay
 *    nameplates/bracket use) — a hostile reads hostile at a glance.
 *  - Health as `current/max` + bar; every observed drop leaves a bone ghost
 *    trail that holds ~280ms then drains, so single ticks stay visible.
 *  - State chips: HOSTILE/ALERTED attitude, KNEELING posture, then server
 *    statuses (4 chips max).
 *  - Target switch asserts instantly: bar transitions suppressed for the
 *    switch beat (no cross-target tween ghosts) + one 180ms border flash.
 *  - Death is honest: an observed alive→down transition stamps DOWN/DEAD,
 *    holds 1.6s, then releases the selection. Deliberately selecting an
 *    already-dead corpse never auto-clears.
 *
 * Fixed-position HUD above the PS2 canvas; reads PlayState every frame; the
 * ONLY write is the death auto-release of `state.selectedActorId`. Diff-gated
 * DOM updates mirror the statusPlate applied-cache pattern.
 */
export interface TargetPlateController {
  dispose: () => void;
}

const MAX_CHIPS = 4;
/** Ghost trail: hold after the last observed drop, then drain. */
const GHOST_HOLD_MS = 280;
const GHOST_DRAIN_PERCENT_PER_S = 90;
/** Damage flash + switch assert beats. */
const HIT_FLASH_MS = 160;
const SWITCH_ASSERT_MS = 180;
/** Observed death: DEAD/DOWN stamp holds this long, then the frame retires. */
const DEATH_RELEASE_MS = 1600;

interface StateChip {
  kind: "hostile" | "alerted" | "posture" | "status";
  label: string;
}

export function mountTargetPlate(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
): TargetPlateController {
  const plate = document.createElement("aside");
  plate.className = "sc3d-target-plate";
  plate.hidden = true;
  plate.innerHTML = `
    <header class="sc3d-target-head">
      <span class="sc3d-target-name" data-ref="name">\u2014</span>
      <span class="sc3d-target-stamp" data-ref="stamp" hidden></span>
    </header>
    <div class="sc3d-target-gauge">
      <div class="sc3d-target-track">
        <div class="sc3d-target-ghost" data-ref="ghost"></div>
        <div class="sc3d-target-fill" data-ref="fill"></div>
      </div>
      <span class="sc3d-target-value" data-ref="value">\u2014</span>
    </div>
    <div class="sc3d-target-chips" data-ref="chips"></div>
  `;
  shell.appendChild(plate);

  const nameEl = ref(plate, "name");
  const stampEl = ref(plate, "stamp");
  const ghostEl = ref(plate, "ghost");
  const fillEl = ref(plate, "fill");
  const valueEl = ref(plate, "value");
  const chipsEl = ref(plate, "chips");

  const applied = {
    visible: false,
    name: "",
    color: "",
    stamp: "",
    percent: -1,
    ghostPercent: -1,
    value: "",
    chips: "",
  };

  // Per-shown-target bookkeeping (all reset on switch).
  let shownTargetId: string | null = null;
  let ghostPercent = 0;
  let lastDropAtMs = 0;
  let sawAlive = false;
  let observedDeathAtMs = 0;
  let switchAtMs = 0;
  let hitAtMs = 0;
  let lastFrameAtMs = 0;

  let frameId = 0;
  const frame = () => {
    frameId = requestAnimationFrame(frame);
    const now = performance.now();
    const dtMs = lastFrameAtMs > 0 ? Math.min(100, now - lastFrameAtMs) : 16;
    lastFrameAtMs = now;

    const actor = state.selectedActorId ? selectedActor(slice, state) : null;
    const visible = actor !== null;
    if (applied.visible !== visible) {
      applied.visible = visible;
      plate.hidden = !visible;
    }
    if (!actor) {
      shownTargetId = null;
      return;
    }

    const summary = actorTargetSummary(actor, state, slice);
    const dead = summary.statuses.some((status) => status.id === "dead");
    const alive = summary.lifeState === "alive";

    const maxHealth = summary.maxVitals.health;
    const health = Math.max(0, summary.vitals.health);
    const percent = maxHealth > 0 ? Math.max(0, Math.min(100, (health / maxHealth) * 100)) : 0;
    const roundedPercent = Math.round(percent);

    // ── Target switch: new frame asserts instantly, old bookkeeping dies. ──
    if (shownTargetId !== actor.id) {
      shownTargetId = actor.id;
      ghostPercent = percent;
      lastDropAtMs = 0;
      sawAlive = alive;
      observedDeathAtMs = 0;
      hitAtMs = 0;
      switchAtMs = now;
      plate.setAttribute("data-switch", "");
    } else if (switchAtMs > 0 && now - switchAtMs > SWITCH_ASSERT_MS) {
      switchAtMs = 0;
      plate.removeAttribute("data-switch");
    }

    // ── Death honesty: observed alive→down stamps, holds, then releases. ──
    if (alive) {
      sawAlive = true;
      observedDeathAtMs = 0; // stood back up before release — keep the target
    } else if (sawAlive && observedDeathAtMs === 0) {
      observedDeathAtMs = now;
    }
    if (observedDeathAtMs > 0 && now - observedDeathAtMs > DEATH_RELEASE_MS) {
      if (state.selectedActorId === actor.id) state.selectedActorId = null;
      return; // next frame hides the plate
    }

    // Clean-name chain (C1): display_name-grade name on the band — the type
    // read lives on examine, never in the plate's 1-line budget. Dead targets
    // read "Corpse · Name" (the "of" prose cost the name its band). The
    // summary path keeps owning species/corpse naming; only the trailing
    // type read is stripped when no authoritative display_name exists.
    const corpse = summary.name.startsWith("Corpse of ");
    const display = serverAuthorityDisplayName(state.serverAuthority.actors[actor.id]?.displayName);
    const clean = display ?? stripTypeRead(corpse ? summary.name.slice("Corpse of ".length) : summary.name);
    const plateName = corpse ? `Corpse · ${clean}` : clean;
    if (applied.name !== plateName) {
      applied.name = plateName;
      nameEl.textContent = plateName;
    }
    // Relation tint — the SAME color source the overlay nameplates/bracket
    // use, on the name AND the left rail, so a hostile reads hostile here too.
    const color = actorNameplateFillStyle(actor, dead, slice, state) ?? "";
    if (applied.color !== color) {
      applied.color = color;
      nameEl.style.color = color;
      plate.style.borderLeftColor = color;
    }

    const stamp = alive ? "" : (dead ? "DEAD" : "DOWN");
    if (applied.stamp !== stamp) {
      applied.stamp = stamp;
      stampEl.hidden = stamp === "";
      stampEl.textContent = stamp;
    }

    // ── Health bar + recent-damage ghost trail. ──
    if (percent < ghostPercent - 0.01) {
      // A drop this frame re-arms the hold; the flash marks the tick.
      if (applied.percent >= 0 && roundedPercent < applied.percent) {
        lastDropAtMs = now;
        hitAtMs = now;
        plate.setAttribute("data-hit", "");
      }
      if (now - lastDropAtMs > GHOST_HOLD_MS) {
        ghostPercent = Math.max(percent, ghostPercent - (GHOST_DRAIN_PERCENT_PER_S * dtMs) / 1000);
      }
    } else {
      ghostPercent = percent; // heals snap the trail shut
    }
    if (hitAtMs > 0 && now - hitAtMs > HIT_FLASH_MS) {
      hitAtMs = 0;
      plate.removeAttribute("data-hit");
    }

    if (applied.percent !== roundedPercent) {
      applied.percent = roundedPercent;
      fillEl.style.width = `${roundedPercent}%`;
      fillEl.parentElement?.toggleAttribute("data-low", roundedPercent <= 25);
    }
    const roundedGhost = Math.round(ghostPercent * 2) / 2;
    if (applied.ghostPercent !== roundedGhost) {
      applied.ghostPercent = roundedGhost;
      ghostEl.style.width = `${roundedGhost}%`;
    }

    const valueText = maxHealth > 0 ? `${Math.round(health)}/${Math.round(maxHealth)}` : "\u2014";
    if (applied.value !== valueText) {
      applied.value = valueText;
      valueEl.textContent = valueText;
    }

    // ── State chips: attitude, posture, then server statuses. ──
    const chips = targetStateChips(state, actor.id, alive, summary.statuses);
    let chipsKey = "";
    for (const chip of chips) chipsKey += `${chip.kind}:${chip.label}\u0000`;
    if (applied.chips !== chipsKey) {
      applied.chips = chipsKey;
      chipsEl.textContent = "";
      for (const chip of chips) {
        const el = document.createElement("span");
        el.className = "sc3d-target-chip";
        if (chip.kind !== "status" && chip.kind !== "posture") el.setAttribute("data-kind", chip.kind);
        el.textContent = chip.label.toUpperCase();
        chipsEl.appendChild(el);
      }
    }
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      plate.remove();
    },
  };
}

/** Attitude (HOSTILE/ALERTED) + posture (KNEELING) + statuses, MAX_CHIPS cap. */
export function targetStateChips(
  state: PlayState,
  actorId: string,
  alive: boolean,
  statuses: readonly { id: string; label: string }[],
): StateChip[] {
  const chips: StateChip[] = [];
  const server = state.serverAuthority.actors[actorId];
  const self = actorId === (state.serverAuthority.playerActorId ?? state.playerActorId);
  if (server && alive && !self) {
    if (server.aiAttitude === "hostile") chips.push({ kind: "hostile", label: "HOSTILE" });
    else if (server.aiAttitude === "alerted") chips.push({ kind: "alerted", label: "ALERTED" });
    const posture = server.posture;
    if (posture === "kneeling" || posture === "kneeling_down") {
      chips.push({ kind: "posture", label: "KNEELING" });
    }
  }
  for (const status of statuses) {
    if (chips.length >= MAX_CHIPS) break;
    chips.push({ kind: "status", label: status.label });
  }
  return chips.slice(0, MAX_CHIPS);
}

function ref(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!element) throw new Error(`missing target plate ref ${name}`);
  return element;
}
