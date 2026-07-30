import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCloneSaveSkillBackupCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { UI_ICONS } from "../../icons";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * CLONING — the clone terminal's screen, windowed (travel-kiosk grammar).
 *
 * One fact and one verb. The fact: whether a skill backup is on file, when
 * it was saved and how many skill boxes it holds (the owner-scoped
 * `serverAuthority.bank` projection carries all of it — backup lives in the
 * bank account). The verb: SAVE / UPDATE BACKUP at the authoritative
 * 1,000-credit price, spent bank-first with the wallet covering shortfall.
 * The consequences panel says exactly what a clone restores and what it
 * never touches, before the player pays — no surprise on death. The balances
 * line under the cost shows the vault and wallet the payment draws from, so
 * a disabled button is never a mystery.
 *
 * `CloneSaveSkillBackup` is the only command here; the server re-validates
 * range, life state, and funds regardless of the client gates.
 */

import {
  activeCloneTerminal,
  CLONE_TERMINAL_WINDOW_ID,
  setActiveCloneTerminal,
} from "./cloneTerminalWindowIds";
export { activeCloneTerminal, CLONE_TERMINAL_WINDOW_ID, setActiveCloneTerminal };
/** Shared sim-side interaction reach (HARVEST_INTERACTION_RADIUS). */
const CLONE_REACH_CELLS = 1.75;
const STATUS_FLASH_MS = 2600;

function cloneTerminalDistance(state: PlayState, slice: SliceSnapshot, propId: string): number | null {
  const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[actorId];
  const areaId = me?.areaId ?? state.activeAreaId;
  const x = me?.x ?? state.player.x;
  const y = me?.y ?? state.player.y;
  const prop = slice.props.find((candidate) => candidate.id === propId && candidate.areaId === areaId);
  if (!prop) return null;
  return Math.hypot(x + 0.5 - (prop.cell.x + prop.size.w / 2), y + 0.5 - (prop.cell.y + prop.size.h / 2));
}

export function withinCloneTerminalRange(state: PlayState, slice: SliceSnapshot, propId: string): boolean {
  const distance = cloneTerminalDistance(state, slice, propId);
  return distance !== null && distance <= CLONE_REACH_CELLS;
}

/** Nearest in-reach clone terminal (dock/`/ui` open adopts the one beside you). */
export function nearestCloneTerminalInRange(state: PlayState, slice: SliceSnapshot): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const prop of slice.props) {
    if (prop.kind !== "clone_terminal") continue;
    const distance = cloneTerminalDistance(state, slice, prop.id);
    if (distance !== null && distance <= CLONE_REACH_CELLS && distance < bestDistance) {
      best = prop.id;
      bestDistance = distance;
    }
  }
  return best;
}

export function createCloneTerminalWindowDefinition(deps: { sfx?: SfxPlayer } = {}): WindowDefinition {
  return {
    id: CLONE_TERMINAL_WINDOW_ID,
    title: "CLONING",
    icon: "clone-facility",
    hotkey: null,
    minWidth: 400,
    minHeight: 320,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(400, Math.round(viewport.w * 0.3));
      const h = Math.max(320, Math.round(viewport.h * 0.44));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.42), w, h };
    },
    mount: (contentRoot, ctx) => mountCloneTerminalContent(contentRoot, ctx, deps),
  };
}

function mountCloneTerminalContent(contentRoot: HTMLElement, ctx: WindowContext, deps: { sfx?: SfxPlayer }): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-cloneterm";
  root.innerHTML = `
    <header class="scp-cloneterm-head">
      <span class="scp-cloneterm-link" data-ref="link">NO TERMINAL LINK</span>
      <span class="scp-cloneterm-headnote">DUSTGATE CLONING FACILITY</span>
    </header>
    <section class="scp-cloneterm-backup" aria-label="Skill backup status">
      <span class="scp-cloneterm-glyph" aria-hidden="true">${UI_ICONS["clone-facility"]}</span>
      <div class="scp-cloneterm-facts">
        <span class="scp-cloneterm-status" data-ref="backupStatus">—</span>
        <span class="scp-cloneterm-detail" data-ref="backupDetail"></span>
      </div>
    </section>
    <section class="scp-cloneterm-terms" aria-label="What cloning restores">
      <div class="scp-cloneterm-term">CLONE RESTORES THIS BACKUP · PROFESSIONS, XP AND SKILLS</div>
      <div class="scp-cloneterm-term">ITEMS AND WALLET CREDITS STAY ON YOUR CORPSE · NOT SAVED HERE</div>
      <div class="scp-cloneterm-term" data-ref="fundsNote">VAULT PAYS FIRST · WALLET COVERS SHORTFALL</div>
    </section>
    <div class="scp-cloneterm-costline">
      <span>BACKUP COST</span>
      <span class="scp-cloneterm-cost" data-ref="cost">1,000 CR</span>
    </div>
    <div class="scp-cloneterm-balances" data-ref="balances" aria-label="Your vault and wallet balances">VAULT — · WALLET —</div>
    <button type="button" class="scp-cloneterm-save" data-ref="save" disabled>SAVE BACKUP</button>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const linkEl = mustRef(root, "link");
  const backupStatusEl = mustRef(root, "backupStatus");
  const backupDetailEl = mustRef(root, "backupDetail");
  const costEl = mustRef(root, "cost");
  const balancesEl = mustRef(root, "balances");
  const saveEl = mustRef(root, "save") as HTMLButtonElement;
  const statusEl = mustRef(root, "status");

  const rejectWatcher = createRejectWatcher(state, ["CloneSaveSkillBackup"]);

  let renderKey = "";
  let statusFlashUntil = 0;
  let linked = false;

  const flashStatus = (text: string): void => {
    statusEl.textContent = text;
    statusFlashUntil = performance.now() + STATUS_FLASH_MS;
  };

  saveEl.addEventListener("click", () => {
    if (!linked) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("LINK LOST · RETURN TO TERMINAL");
      return;
    }
    const bank = state.serverAuthority.bank;
    if (!bank) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus("LINKING…");
      return;
    }
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const wallet = Math.max(0, Math.trunc(state.serverAuthority.actors[actorId]?.credits ?? 0));
    if (bank.credits + wallet < bank.backupCost) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flashStatus(`INSUFFICIENT CREDITS · NEED ${bank.backupCost.toLocaleString()}`);
      return;
    }
    enqueueAuthorityCloneSaveSkillBackupCommand(
      state.authorityCommands,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    deps.sfx?.play(successorAudioIds.itemTransfer);
    flashStatus("SAVING BACKUP…");
  });

  const update = (): void => {
    const nowMs = performance.now();
    let terminalId = activeCloneTerminal();
    if (!terminalId || !withinCloneTerminalRange(state, slice, terminalId)) {
      const nearby = nearestCloneTerminalInRange(state, slice);
      if (nearby && nearby !== terminalId) {
        setActiveCloneTerminal(nearby);
        terminalId = nearby;
      }
    }
    linked = terminalId !== null && withinCloneTerminalRange(state, slice, terminalId);
    const bank = state.serverAuthority.bank;
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const wallet = Math.max(0, Math.trunc(state.serverAuthority.actors[actorId]?.credits ?? 0));

    const denied = rejectWatcher.poll();
    if (denied) flashStatus(denied);

    const nextKey = [
      linked ? terminalId : "offline",
      bank ? `${bank.backupPresent}:${bank.backupSavedTick ?? "-"}:${bank.backupSkillCount}:${bank.backupCost}:${bank.credits}` : "waiting",
      wallet,
    ].join("|");
    if (nextKey !== renderKey) {
      renderKey = nextKey;

      linkEl.textContent = !linked ? "NO TERMINAL LINK" : bank ? "TERMINAL LINKED" : "LINKING…";
      linkEl.toggleAttribute("data-denied", !linked);

      if (!bank) {
        backupStatusEl.textContent = "READING RECORD…";
        backupDetailEl.textContent = "";
        costEl.textContent = "1,000 CR";
      } else if (bank.backupPresent) {
        backupStatusEl.textContent = "BACKUP ON FILE";
        backupStatusEl.toggleAttribute("data-empty", false);
        backupDetailEl.textContent = `${bank.backupSkillCount.toLocaleString()} SKILL BOX${bank.backupSkillCount === 1 ? "" : "ES"} · SAVED ${formatSavedAgo(bank.backupSavedTick, slice, state)}`;
        costEl.textContent = `${bank.backupCost.toLocaleString()} CR`;
      } else {
        backupStatusEl.textContent = "NO BACKUP ON FILE";
        backupStatusEl.toggleAttribute("data-empty", true);
        backupDetailEl.textContent = "DIE WITHOUT ONE AND YOUR CLONE KEEPS NOTHING LEARNED";
        costEl.textContent = `${bank.backupCost.toLocaleString()} CR`;
      }

      // The two purses the cost draws from — vault first, then wallet. The
      // vault shows "—" until the owner projection streams; the wallet is
      // always known from the actor row.
      balancesEl.textContent = `VAULT ${bank ? `${bank.credits.toLocaleString()} CR` : "—"} · WALLET ${wallet.toLocaleString()} CR`;

      const affordable = bank !== null && bank.credits + wallet >= bank.backupCost;
      saveEl.textContent = bank?.backupPresent ? "UPDATE BACKUP" : "SAVE BACKUP";
      saveEl.disabled = !linked || bank === null || !affordable;
      saveEl.title = !linked
        ? "Step within reach of the clone terminal"
        : bank === null
          ? "Waiting for the terminal record"
          : affordable
            ? ""
            : `Costs ${bank.backupCost.toLocaleString()} credits (vault + wallet)`;

      if (!linked) {
        statusEl.textContent = "LINK LOST · RETURN TO TERMINAL";
        statusFlashUntil = 0;
      } else if (nowMs > statusFlashUntil) {
        statusEl.textContent = "";
      }
    }
    if (linked && nowMs > statusFlashUntil && statusFlashUntil !== 0) {
      statusEl.textContent = "";
      statusFlashUntil = 0;
    }
  };

  return {
    update,
    onResized: () => {
      // Single-column rail; nothing to re-measure.
    },
    dispose: () => {
      contentRoot.innerHTML = "";
    },
  };
}

/** "SAVED 12m AGO" from the authoritative saved tick, "SAVED —" if unknown. */
function formatSavedAgo(savedTick: number | null, slice: SliceSnapshot, state: PlayState): string {
  if (savedTick === null) return "—";
  const nowTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  const seconds = Math.max(0, Math.round((nowTick - savedTick) / Math.max(1, slice.tickRateHz)));
  if (seconds < 60) return "JUST NOW";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  return `${hours}H ${minutes % 60}M AGO`;
}

function mustRef(root: HTMLElement, ref: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);
  if (!el) throw new Error(`clone terminal window: missing ref ${ref}`);
  return el;
}
