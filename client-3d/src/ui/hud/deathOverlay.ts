import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCloneRespawnCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createRejectWatcher } from "../windows/defs/commandReceipts";

/**
 * DEATH / CLONE overlay — fullscreen HUD state, roll-slice death flow
 * (owner spec 2026-07-03: established sandbox-style clone activation replaces the silent
 * 28-minute respawn wall).
 *
 * Driven entirely by the SERVER life state of the local pawn:
 *   downed     → "YOU ARE DOWN": hold for aid, or burn a clone (give up).
 *   respawning → "YOU DIED": clone activation + field-recovery countdown.
 *   alive      → hidden; a small CLONE SICKNESS chip lingers while the
 *                post-clone debuff ticks down.
 *
 * The backdrop is visual only (pointer-events none) — chat stays usable
 * while dead, so `/clone` parity works. Only the panel takes clicks.
 * DOM writes are diff-gated (actionQueue pattern); state is never mutated
 * except by enqueueing CloneRespawn.
 */
export interface DeathOverlayController {
  dispose: () => void;
}

const RESPAWN_PENDING_TIMEOUT_MS = 6000;
const FLASH_MS = 1800;

export function mountDeathOverlay(
  shell: HTMLElement,
  state: PlayState,
  slice: SliceSnapshot,
): DeathOverlayController {
  const backdrop = document.createElement("div");
  backdrop.className = "sc3d-death-backdrop";
  backdrop.hidden = true;
  const panel = document.createElement("section");
  panel.className = "sc3d-death-panel";
  panel.hidden = true;
  panel.innerHTML = `
    <header class="sc3d-death-head">
      <span class="sc3d-death-title" data-ref="title"></span>
      <span class="sc3d-death-stamp" data-ref="stamp"></span>
    </header>
    <p class="sc3d-death-line" data-ref="line"></p>
    <div class="sc3d-incap" data-ref="incap" hidden>
      <span class="sc3d-incap-clock" data-ref="clock"></span>
      <div class="sc3d-incap-pips" data-ref="pips" data-count="0" aria-label="incapacitation count">
        <i></i><i></i><i></i>
      </div>
      <span class="sc3d-incap-warn" data-ref="warn"></span>
    </div>
    <div class="sc3d-death-facilities" data-ref="facilities"></div>
    <div class="sc3d-death-foot">
      <span class="sc3d-death-recovery" data-ref="recovery"></span>
      <span class="sc3d-death-status" data-ref="status"></span>
    </div>
  `;
  shell.appendChild(backdrop);
  shell.appendChild(panel);

  // Owner (2026-07-06): the panel must never trap the view while downed —
  // drag it anywhere by its header. Session-scoped position; viewport-clamped.
  const head = panel.querySelector<HTMLElement>(".sc3d-death-head");
  if (head) {
    head.style.cursor = "grab";
    let dragging = false;
    let grabDx = 0;
    let grabDy = 0;
    head.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if ((event.target as HTMLElement).closest("button")) return;
      event.stopPropagation();
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      grabDx = event.clientX - rect.left;
      grabDy = event.clientY - rect.top;
      dragging = true;
      head.setPointerCapture(event.pointerId);
      head.style.cursor = "grabbing";
    });
    head.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const rect = panel.getBoundingClientRect();
      const x = Math.max(4, Math.min(window.innerWidth - rect.width - 4, event.clientX - grabDx));
      const y = Math.max(4, Math.min(window.innerHeight - rect.height - 4, event.clientY - grabDy));
      panel.dataset.dragged = "true";
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
    });
    const endDrag = (event: PointerEvent): void => {
      if (!dragging) return;
      dragging = false;
      head.releasePointerCapture(event.pointerId);
      head.style.cursor = "grab";
    };
    head.addEventListener("pointerup", endDrag);
    head.addEventListener("pointercancel", endDrag);
  }

  const sickChip = document.createElement("aside");
  sickChip.className = "sc3d-sickchip";
  sickChip.hidden = true;
  shell.appendChild(sickChip);

  const titleEl = ref(panel, "title");
  const stampEl = ref(panel, "stamp");
  const lineEl = ref(panel, "line");
  const incapEl = ref(panel, "incap");
  const clockEl = ref(panel, "clock");
  const pipsEl = ref(panel, "pips");
  const warnEl = ref(panel, "warn");
  const facilitiesEl = ref(panel, "facilities");
  const recoveryEl = ref(panel, "recovery");
  const statusEl = ref(panel, "status");

  const rejectWatcher = createRejectWatcher(state, ["CloneRespawn"]);

  let pendingSinceMs: number | null = null;
  let flashTimer = 0;
  const flash = (message: string): void => {
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => statusEl.toggleAttribute("data-flash", false), FLASH_MS);
  };

  const activateClone = (facilityId: string | undefined): void => {
    if (pendingSinceMs !== null) return;
    const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = enqueueAuthorityCloneRespawnCommand(state.authorityCommands, tick, facilityId);
    if (queued) {
      pendingSinceMs = performance.now();
      flash("ACTIVATING CLONE…");
    } else {
      flash("CLONE DENIED");
    }
  };

  // Facility buttons rebuild when the list OR the panel mode changes.
  // Downed = incap: the timer is the story — clone-out shrinks to a single
  // de-emphasized GIVE UP escape hatch. Dead = full facility list.
  let facilitySignature = "";
  const rebuildFacilities = (compact: boolean): void => {
    const facilities = slice.cloneFacilities ?? [];
    const signature = (compact ? "c|" : "f|") + facilities.map((facility) => facility.id).join("|");
    if (signature === facilitySignature) return;
    facilitySignature = signature;
    facilitiesEl.textContent = "";
    if (facilities.length === 0) {
      const none = document.createElement("span");
      none.className = "sc3d-death-nofacility";
      none.textContent = "NO CLONE FACILITY REGISTERED";
      facilitiesEl.appendChild(none);
      return;
    }
    const list = compact ? facilities.slice(0, 1) : facilities;
    for (const facility of list) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sc3d-death-clonebtn";
      if (compact) button.dataset.giveup = "true";
      button.dataset.facilityId = facility.id;
      button.textContent = compact
        ? "GIVE UP · NEAREST CLONE FACILITY"
        : `ACTIVATE CLONE · ${(facility.label ?? facility.id).toUpperCase()}`;
      button.addEventListener("pointerdown", (event) => {
        // Panel floats over the world canvas — keep clicks out of world input.
        event.stopPropagation();
        event.preventDefault();
        activateClone(facility.id);
      });
      facilitiesEl.appendChild(button);
    }
  };

  const applied = {
    phase: "alive" as "alive" | "downed" | "respawning",
    visible: false,
    recovery: "",
    pending: false,
    sickSeconds: -1,
    clockText: "",
    incapCount: -1,
    warnText: "",
  };

  // Incap fields stream as ADDITIVE optionals on the actor state (authority
  // contract: incapRemainingMs / incapCount); absent -> classic downed copy.
  interface IncapFields {
    incapRemainingMs?: number;
    incapCount?: number;
  }

  let frameId = 0;
  const frame = (): void => {
    frameId = requestAnimationFrame(frame);
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[playerActorId];
    const phase = (me?.lifeState ?? "alive") as typeof applied.phase;
    const estTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);

    const denied = rejectWatcher.poll();
    if (denied) {
      pendingSinceMs = null;
      flash(denied);
    }
    if (pendingSinceMs !== null) {
      if (phase === "alive") {
        pendingSinceMs = null; // clone landed — server flipped us back
      } else if (performance.now() - pendingSinceMs > RESPAWN_PENDING_TIMEOUT_MS) {
        pendingSinceMs = null;
        flash("NO CLONE RESPONSE");
      }
    }

    const visible = phase !== "alive";
    if (applied.visible !== visible) {
      applied.visible = visible;
      backdrop.hidden = !visible;
      panel.hidden = !visible;
      if (!visible) {
        statusEl.textContent = "";
        panel.removeAttribute("data-phase");
        backdrop.removeAttribute("data-phase");
        applied.phase = "alive";   // repeat-incap: force the phase branch to reapply
      }
    }
    // Post-clone sickness chip (alive only; server decays the clock).
    const sickMs = me?.cloneSicknessRemainingMs ?? 0;
    const sickSeconds = phase === "alive" && sickMs > 0
      ? Math.ceil(sickMs / 1000)
      : -1;
    if (applied.sickSeconds !== sickSeconds) {
      applied.sickSeconds = sickSeconds;
      sickChip.hidden = sickSeconds <= 0;
      if (sickSeconds > 0) sickChip.textContent = `CLONE SICKNESS · ${sickSeconds}s`;
    }

    if (!visible) return;

    if (applied.phase !== phase) {
      applied.phase = phase;
      panel.dataset.phase = phase;
      backdrop.dataset.phase = phase;
      if (phase === "downed") {
        titleEl.textContent = "INCAPACITATED";
        stampEl.textContent = "";      // owner: no red DOWN stamp — title carries it
        stampEl.hidden = true;
        lineEl.textContent = "hold for aid — a medic can still raise you";
      } else {
        titleEl.textContent = "YOU DIED";
        stampEl.hidden = false;
        stampEl.textContent = "DEAD";
        lineEl.textContent = "clone activation ready";
      }
    }
    rebuildFacilities(phase === "downed");

    // Incap zone (downed only): get-up countdown + 3-strike pips.
    const inc = me as (typeof me & IncapFields) | undefined;
    const showIncap = phase === "downed";
    if (incapEl.hidden !== !showIncap) incapEl.hidden = !showIncap;
    if (showIncap) {
      const remainMs = Math.max(0, inc?.incapRemainingMs ?? 0);
      const total = Math.ceil(remainMs / 1000);
      const clockText = remainMs > 0
        ? `ON YOUR FEET IN ${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
        : "GETTING UP…";
      if (applied.clockText !== clockText) {
        applied.clockText = clockText;
        clockEl.textContent = clockText;
      }
      const count = Math.max(0, Math.min(3, inc?.incapCount ?? 0));
      if (applied.incapCount !== count) {
        applied.incapCount = count;
        pipsEl.dataset.count = String(count);
      }
      const warnText = count >= 2 ? "NEXT FALL IS FINAL" : "";
      if (applied.warnText !== warnText) {
        applied.warnText = warnText;
        warnEl.textContent = warnText;
      }
    }

    // Field-recovery countdown (the old silent auto-respawn, made honest).
    const respawnAtTick = me?.respawnAtTick ?? 0;
    let recovery = "";
    if (phase === "respawning" && respawnAtTick > estTick) {
      const seconds = Math.ceil((respawnAtTick - estTick) / Math.max(1, slice.tickRateHz));
      const mm = Math.floor(seconds / 60);
      const ss = seconds % 60;
      recovery = `FIELD RECOVERY · ${mm}:${String(ss).padStart(2, "0")}`;
    }
    if (applied.recovery !== recovery) {
      applied.recovery = recovery;
      recoveryEl.textContent = recovery;
    }

    const pending = pendingSinceMs !== null;
    if (applied.pending !== pending) {
      applied.pending = pending;
      for (const button of facilitiesEl.querySelectorAll<HTMLButtonElement>("button")) {
        button.disabled = pending;
      }
    }
  };
  frameId = requestAnimationFrame(frame);

  return {
    dispose() {
      cancelAnimationFrame(frameId);
      window.clearTimeout(flashTimer);
      backdrop.remove();
      panel.remove();
      sickChip.remove();
    },
  };
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`death overlay: missing data-ref="${name}"`);
  return el;
}
