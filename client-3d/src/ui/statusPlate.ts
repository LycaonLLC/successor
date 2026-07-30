import type { PlayState, ServerAuthorityActorState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { actorSprintRecoveryLocked, sprintToggleEnabled, toggleSprint } from "@successor/client/src/slice-core/movementSystem";
import { activeWeaponSpec } from "@successor/client/src/slice-core/loadoutSystem";
import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import { formatAbandonCountdown, pointInsideCampShelter } from "@successor/client/src/slice-core/campSystem";
import { SUCCESSOR_THEME, weaponDisplayName } from "./theme";
import { samplerPlateTag, ticksToSeconds } from "./extraction/actions";

/**
 * Quartermaster's status plate — the only in-world HUD.
 *
 * Bottom-left stamped slate: three field gauges (HEALTH / ACTION / SPIRIT),
 * physical magazine pips (one per round; reloads sweep the pips back in,
 * timed by reloadRemainingTicks/reloadTotalTicks), the weapon's stenciled
 * field designation, and a DOWN stamp + screen-edge vignette when the tracked
 * actor is not alive.
 *
 * Pure DOM/CSS above the PS2 canvas (crisp at any DPR, deliberately NOT
 * ps2-filtered); it reads PlayState every animation frame and never writes.
 * The tracked actor mirrors the camera's focus rule, so when the player is
 * observer-only the gauges follow the spectated actor.
 */
export interface StatusPlateController {
  dispose: () => void;
}

const MAX_PIPS = 48;

export function mountStatusPlate(shell: HTMLElement, state: PlayState, slice: SliceSnapshot): StatusPlateController {
  const strings = SUCCESSOR_THEME.strings;
  const plate = document.createElement("aside");
  plate.className = "successor3d-plate";
  plate.dataset.life = "alive";
  plate.dataset.signal = "none";
  plate.innerHTML = `
    <div class="successor3d-plate-tags">
      <span class="successor3d-plate-obs" data-ref="obs" hidden>${strings.observerTag}</span>
      <span class="successor3d-plate-sheltered" data-ref="sheltered" hidden>SHELTERED</span>
      <span class="successor3d-plate-campdown" data-ref="campdown" hidden></span>
      <span class="successor3d-plate-sampler" data-ref="sampler" hidden></span>
      <span class="successor3d-plate-stamp" data-ref="stamp" hidden>${strings.downStamp}</span>
    </div>
    <div class="successor3d-gauges">
      ${gaugeMarkup("health", strings.gaugeHealth)}
      ${gaugeMarkup("action", strings.gaugeAction)}
      ${gaugeMarkup("spirit", strings.gaugeSpirit)}
    </div>
    <button type="button" class="successor3d-run" data-ref="run" data-state="off" aria-pressed="false"
      title="Run · drains Action · winded until Action refills · X">
      <span class="successor3d-run-key">X</span>
      <span data-ref="runLabel">RUN</span>
    </button>
    <div class="successor3d-mag" data-ref="mag" hidden>
      <div class="successor3d-mag-head">
        <span class="successor3d-mag-weapon" data-ref="weapon">—</span>
        <span class="successor3d-mag-rounds" data-ref="rounds">—</span>
      </div>
      <div class="successor3d-pips" data-ref="pips"></div>
      <div class="successor3d-swing" data-ref="swing" hidden>
        <div class="successor3d-swing-fill" data-ref="swingFill"></div>
      </div>
    </div>
    <footer class="successor3d-plate-fine" data-ref="fine">${strings.noSignal}</footer>
  `;
  const vignette = document.createElement("div");
  vignette.className = "successor3d-vignette";
  shell.append(plate, vignette);

  const refs = {
    obs: getRef(plate, "obs"),
    sheltered: getRef(plate, "sheltered"),
    campdown: getRef(plate, "campdown"),
    sampler: getRef(plate, "sampler"),
    stamp: getRef(plate, "stamp"),
    mag: getRef(plate, "mag"),
    weapon: getRef(plate, "weapon"),
    rounds: getRef(plate, "rounds"),
    pips: getRef(plate, "pips"),
    swing: getRef(plate, "swing"),
    swingFill: getRef(plate, "swingFill"),
    fine: getRef(plate, "fine"),
    run: getRef(plate, "run"),
    runLabel: getRef(plate, "runLabel"),
    fills: {
      health: getRef(plate, "fill-health"),
      action: getRef(plate, "fill-action"),
      spirit: getRef(plate, "fill-spirit"),
    },
    values: {
      health: getRef(plate, "value-health"),
      action: getRef(plate, "value-action"),
      spirit: getRef(plate, "value-spirit"),
    },
  };

  // Last-applied DOM state; the frame loop only touches nodes on change.
  const applied = {
    observer: false,
    sheltered: false,
    campdown: "",
    sampler: "",
    life: "",
    signal: "",
    weaponLabel: "",
    roundsText: "",
    magVisible: false,
    magazineSize: -1,
    filledPips: -1,
    reloading: false,
    swingMode: false,
    swingFill: -1,
    swingReady: false,
    fine: "",
    runState: "",
    gauges: {
      health: { percent: -1, text: "" },
      action: { percent: -1, text: "" },
      spirit: { percent: -1, text: "" },
    },
  };
  let pipNodes: HTMLElement[] = [];
  let swingStartTick = 0;
  let swingEndTick = 0;

  const updateGauge = (vital: "health" | "action" | "spirit", value: number, max: number) => {
    const percent = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    const rounded = Math.round(percent);
    const gauge = applied.gauges[vital];
    if (gauge.percent !== rounded) {
      gauge.percent = rounded;
      refs.fills[vital].style.width = `${rounded}%`;
      refs.fills[vital].parentElement?.toggleAttribute("data-low", rounded <= 25);
    }
    const text = max > 0 ? `${Math.max(0, Math.round(value))}` : "—";
    if (gauge.text !== text) {
      gauge.text = text;
      refs.values[vital].textContent = text;
    }
  };

  // RUN toggle — the persistent-run HUD control (keyboard twin: X). A real
  // button: focusable, aria-pressed mirrors the intent, click flips it. The
  // WINDED state is the authority's sprint-recovery lock — intent stays
  // pressed while winded and running resumes on its own at full Action.
  refs.run.addEventListener("click", () => {
    toggleSprint(state);
  });

  let frameId = 0;
  const frame = () => {
    frameId = requestAnimationFrame(frame);
    const focusActorId = state.observerCamera.followActorId
      ?? state.serverAuthority.playerActorId
      ?? state.playerActorId;
    const actor: ServerAuthorityActorState | undefined = state.serverAuthority.actors[focusActorId];

    const signal = actor ? "live" : "none";
    if (applied.signal !== signal) {
      applied.signal = signal;
      plate.dataset.signal = signal;
    }

    const localForRun = state.serverAuthority.actors[state.serverAuthority.playerActorId ?? state.playerActorId];
    const runOn = sprintToggleEnabled(state);
    const runState = actorSprintRecoveryLocked(localForRun) ? "locked" : runOn ? "on" : "off";
    const runKey = `${runState}·${runOn}`;
    if (applied.runState !== runKey) {
      applied.runState = runKey;
      refs.run.dataset.state = runState;
      refs.run.setAttribute("aria-pressed", runOn ? "true" : "false");
      refs.runLabel.textContent = runState === "locked" ? "WINDED" : "RUN";
    }


    const localPlayerId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const observer = focusActorId !== localPlayerId;
    if (applied.observer !== observer) {
      applied.observer = observer;
      refs.obs.hidden = !observer;
    }

    // AUTO-SAMPLE tag: the LOCAL operative's armed server-side sample loop
    // (W4b). Shown only while the next sample is genuinely PENDING
    // (nextSampleTick ahead of the estimated server tick) — a live loop
    // re-arms within a patch of firing, while a break (move/stand/cancel/
    // death) or a lost clear-patch leaves the value at-or-behind the clock
    // and the tag drops instead of squatting stale. Countdown anchors
    // tick→wall-clock exactly like the swing timer (never a client timer).
    const nextSampleTick = state.serverAuthority.actors[localPlayerId]?.nextSampleTick ?? 0;
    let samplerText = "";
    if (nextSampleTick > 0) {
      const estimatedTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
      const remainingTicks = nextSampleTick - estimatedTick;
      if (remainingTicks > 0) {
        samplerText = samplerPlateTag(ticksToSeconds(remainingTicks, slice.tickRateHz));
      }
    }
    if (applied.sampler !== samplerText) {
      applied.sampler = samplerText;
      refs.sampler.hidden = samplerText.length === 0;
      if (samplerText.length > 0) refs.sampler.textContent = samplerText;
    }

    // SHELTERED tag: honest storm-shelter state — inside a camp's guaranteed
    // shelter box while an ACTIVE storm's damage circle covers this pawn.
    // Both reads are the AUTHORITY mirror (streamed weather + streamed camps,
    // authoritative actor origin — the position the sim charges), and the
    // camp box is the wire-conservative one: the tag can under-claim a
    // fringe step, never claim shelter the sim would still bill.
    const me = state.serverAuthority.actors[localPlayerId];
    const meX = me ? me.x : state.player.x;
    const meY = me ? me.y : state.player.y;
    let sheltered = false;
    if (pointInsideCampShelter(state.serverAuthority.placedCamps, state.activeAreaId, meX, meY)) {
      for (const event of state.weather) {
        if (event.areaId !== state.activeAreaId || event.phase !== "active") continue;
        const dx = meX - event.centerX;
        const dy = meY - event.centerY;
        if (dx * dx + dy * dy <= event.radiusCells * event.radiusCells) {
          sheltered = true;
          break;
        }
      }
    }
    if (applied.sheltered !== sheltered) {
      applied.sheltered = sheltered;
      refs.sheltered.hidden = !sheltered;
    }

    // CAMP COLLAPSE tag: the armed abandonment grace, streamed by the
    // authority to the owning session only (server-redacted). Visible from
    // anywhere — it matters most while you are AWAY from the tent.
    const ownCamp = state.serverAuthority.placedCamps.find(
      (camp) => camp.isOwner && typeof camp.abandonSecondsRemaining === "number",
    );
    const campdownText = ownCamp && typeof ownCamp.abandonSecondsRemaining === "number"
      ? `CAMP COLLAPSE · ${formatAbandonCountdown(ownCamp.abandonSecondsRemaining)}`
      : "";
    if (applied.campdown !== campdownText) {
      applied.campdown = campdownText;
      refs.campdown.hidden = campdownText.length === 0;
      if (campdownText.length > 0) refs.campdown.textContent = campdownText;
    }

    const life = actor?.lifeState ?? state.actors[focusActorId]?.lifeState ?? "alive";
    if (applied.life !== life) {
      applied.life = life;
      plate.dataset.life = life;
      const downed = life !== "alive";
      refs.stamp.hidden = !downed;
      refs.stamp.textContent = life === "respawning" ? strings.respawnStamp : strings.downStamp;
      vignette.toggleAttribute("data-active", downed);
    }

    if (actor) {
      updateGauge("health", actor.vitals.health, actor.maxVitals.health);
      updateGauge("action", actor.vitals.action, actor.maxVitals.action);
      updateGauge("spirit", actor.vitals.spirit, actor.maxVitals.spirit);
    } else {
      updateGauge("health", 0, 0);
      updateGauge("action", 0, 0);
      updateGauge("spirit", 0, 0);
    }

    const weapon = actor?.weapon ?? null;
    const spec = observer ? null : activeWeaponSpec(state);
    const isMelee = weapon !== null && spec?.caliber === "melee";
    const magVisible = weapon !== null && (weapon.magazineSize > 0 || isMelee);
    if (applied.magVisible !== magVisible) {
      applied.magVisible = magVisible;
      refs.mag.hidden = !magVisible;
    }
    if (applied.swingMode !== isMelee) {
      applied.swingMode = isMelee;
      refs.swing.hidden = !isMelee;
      refs.pips.hidden = isMelee;
      applied.roundsText = "";
      applied.magazineSize = -1;
    }
    if (magVisible && weapon) {
      const weaponLabel = weaponDisplayName(weapon.weaponId);
      if (applied.weaponLabel !== weaponLabel) {
        applied.weaponLabel = weaponLabel;
        refs.weapon.textContent = weaponLabel;
      }
      if (isMelee) {
        // Swing timer (owner ruling 2026-07-08): melee weapons show
        // time-to-next-swing where ammo normally lives, driven by the
        // owning-session ability queue's nextReadyTick (spec §F view).
        const est = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
        const nextReady = state.abilityQueue.view?.nextReadyTick ?? 0;
        if (nextReady !== swingEndTick) {
          swingStartTick = est;
          swingEndTick = nextReady;
        }
        const ready = est >= swingEndTick;
        let fill = 1;
        if (!ready && swingEndTick > swingStartTick) {
          fill = Math.max(0, Math.min(1, (est - swingStartTick) / (swingEndTick - swingStartTick)));
        }
        const pct = Math.round(fill * 100);
        if (applied.swingFill !== pct) {
          applied.swingFill = pct;
          refs.swingFill.style.width = `${pct}%`;
        }
        if (applied.swingReady !== ready) {
          applied.swingReady = ready;
          refs.swing.toggleAttribute("data-ready", ready);
          refs.rounds.textContent = ready ? "READY" : "SWING";
        }
      } else {
        const magazineSize = Math.min(weapon.magazineSize, MAX_PIPS);
        if (applied.magazineSize !== magazineSize) {
          applied.magazineSize = magazineSize;
          applied.filledPips = -1;
          refs.pips.textContent = "";
          pipNodes = [];
          for (let index = 0; index < magazineSize; index += 1) {
            const pip = document.createElement("span");
            pip.className = "successor3d-pip";
            refs.pips.appendChild(pip);
            pipNodes.push(pip);
          }
        }
        const reloading = weapon.reloadRemainingTicks > 0 && weapon.reloadTotalTicks > 0;
        if (applied.reloading !== reloading) {
          applied.reloading = reloading;
          refs.mag.toggleAttribute("data-reloading", reloading);
        }
        // Reload = pips refill sweep, timed by the authority's tick countdown.
        const filled = reloading
          ? Math.floor((1 - weapon.reloadRemainingTicks / weapon.reloadTotalTicks) * magazineSize)
          : Math.min(weapon.loadedRounds, magazineSize);
        if (applied.filledPips !== filled) {
          applied.filledPips = filled;
          for (let index = 0; index < pipNodes.length; index += 1) {
            const pip = pipNodes[index]!;
            if (!pip) continue;
            pip.className = index < filled
              ? (index === filled - 1 && reloading ? "successor3d-pip filled lead" : "successor3d-pip filled")
              : "successor3d-pip";
          }
        }
        // Reserve count rides the rounds readout for the LOCAL operative only
        // (observer focus shows the spectated actor's mag; their reserve is not
        // ours to know). Loot journey: kill → loot → this number ticks up
        // without opening anything.
        const reserve = spec ? state.loadout.ammo[spec.caliber]?.reserve ?? 0 : 0;
        const roundsText = reloading
          ? strings.rearming
          : state.loadout.unlimitedAmmo
            ? `${weapon.loadedRounds}/${weapon.magazineSize} ∞`
            : spec
              ? `${weapon.loadedRounds}/${weapon.magazineSize} · ${reserve}`
              : `${weapon.loadedRounds}/${weapon.magazineSize}`;
        if (applied.roundsText !== roundsText) {
          applied.roundsText = roundsText;
          refs.rounds.textContent = roundsText;
        }
      }
    }

    let fieldCount = 0;
    for (const id in state.serverAuthority.actors) {
      if (state.serverAuthority.actors[id]) fieldCount += 1;
    }
    const fine = actor
      ? `${state.serverAuthority.status.toUpperCase()} · ${fieldCount} IN FIELD`
      : strings.noSignal;
    if (applied.fine !== fine) {
      applied.fine = fine;
      refs.fine.textContent = fine;
    }
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      plate.remove();
      vignette.remove();
    },
  };
}

function gaugeMarkup(vital: string, label: string): string {
  return `
    <div class="successor3d-gauge" data-vital="${vital}">
      <span class="successor3d-gauge-label">${label}</span>
      <div class="successor3d-gauge-track">
        <div class="successor3d-gauge-fill" data-ref="fill-${vital}"></div>
      </div>
      <span class="successor3d-gauge-value" data-ref="value-${vital}">—</span>
    </div>
  `;
}

function getRef(root: HTMLElement, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!element) throw new Error(`missing plate ref ${name}`);
  return element;
}
