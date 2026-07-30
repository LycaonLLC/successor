import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import type { InventoryRow } from "@successor/client/src/slice-core/gameState";
import {
  collectInventoryItems,
  createCollectedItemsScratch,
  isLocalInventoryContainer,
} from "../inventory/data";
import { UI_ICONS } from "../icons";
import { spliceSlotIconSvg } from "../iconRegistry";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windows/windowManager";
import { createSpliceReceiptWatcher, type SpliceCommandPort, type SpliceReceipt } from "./commands";
import {
  latestGenomeScan,
  scanForStack,
  spliceSession,
  spliceStoreVersion,
  syncSpliceChannelFromAuthority,
  type GenomeScanVM,
  type SpliceSessionVM,
} from "./store";
import {
  locusLabel,
  SPLICE_COPY,
  spliceReasonLine,
  spliceStampFor,
  tierLabel,
  tierRevealsAlleles,
} from "./copy";

/**
 * SPLICE — the gene bench (Bio-Engineer B4) as a three-phase window, the
 * structural + aesthetic sibling of the craft bench.
 *
 * LAB (no session): the SEED LOCKER (crop-seed stacks, each SCAN-able) and the
 * selected seed's GENOME CARD — the tiered reveal spoken honestly (phenotype →
 * hidden variation → allele values → full sequence; sterility shouts). ACQUIRE
 * (sample a wild landrace) + OPEN THE BENCH (begin a splice for a species) live
 * here too. BENCH (SlotFill): two PARENT slots + four REAGENT slots fill by
 * double-click/drag from the pack, and the LOCI table renders each parent's
 * ALLELE PAIR with the segregation picker (one allele per parent per locus;
 * unscanned parents read UNKNOWN — the scan-tier honesty the sim enforces).
 * SPLICE (Assembled): per-locus experiment lines (points/caps) and MINT with a
 * named-cultivar receipt. Server truth only — phases key off the streamed
 * spliceSession VM; every reject flashes the player-language reason + ui_deny.
 */

import { SPLICE_WINDOW_ID } from "./spliceWindowIds";
export { SPLICE_WINDOW_ID };

export interface SpliceWindowDeps {
  commands: SpliceCommandPort;
  sfx?: SfxPlayer;
}

const STATUS_FLASH_MS = 2200;
const DISCARD_ARM_MS = 2600;
const SPLICE_DRAG_MIME = "text/x-sc3d-splice-seed";

/** Crop species the bench works (design §0.5 band 6_0xx). */
const SPECIES = [
  { key: "ashgrain", itemId: 6_001, label: "Ashgrain" },
  { key: "sunmelon", itemId: 6_002, label: "Sunmelon" },
  { key: "cavemoss", itemId: 6_003, label: "Cavemoss" },
] as const;
const SPECIES_BY_ITEM = new Map<number, (typeof SPECIES)[number]>(SPECIES.map((s) => [s.itemId, s]));
const CROP_SEED_ITEM_IDS = new Set<number>(SPECIES.map((s) => s.itemId));

/** Reagent item per bench reagent-slot offset (splice.rs REAGENT_*). */
const REAGENT_ITEM_IDS = [6_204, 6_205, 6_206, 6_207] as const;
const REAGENT_TOKENS = ["culture", "mutagen", "stabilizer", "serum"] as const;
const SPLICE_PARENT_SLOTS = 2;

type Phase = "lab" | "bench" | "finish";

function phaseOf(session: SpliceSessionVM | null): Phase {
  if (!session || session.phase === "browse") return "lab";
  return session.phase === "assembled" ? "finish" : "bench";
}

export function createSpliceWindowDefinition(deps: SpliceWindowDeps): WindowDefinition {
  return {
    id: SPLICE_WINDOW_ID,
    title: "GENE BENCH",
    icon: "splice",
    // Context-only bench: opened from the Splice Bench item/station routes —
    // no dock button, no global hotkey (owner ruling 2026-07-11).
    hotkey: null,
    dockVisible: false,
    minWidth: 600,
    minHeight: 460,
    defaultBounds: (viewport) => {
      const w = Math.max(600, Math.round(viewport.w * 0.5));
      const h = Math.max(460, Math.round(viewport.h * 0.68));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.4), w, h };
    },
    mount: (contentRoot, ctx) => mountSpliceContent(contentRoot, ctx, deps),
  };
}

function mountSpliceContent(
  contentRoot: HTMLElement,
  ctx: WindowContext,
  deps: SpliceWindowDeps,
): WindowContentHandle {
  const { state } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-splice";
  root.innerHTML = `
    <div class="scp-splice-chrome">
      <nav class="scp-splice-rail" data-ref="rail" aria-label="Splice phase"></nav>

      <section class="scp-splice-surface scp-splice-lab" data-ref="labSurface">
        <div class="scp-splice-locker">
          <header class="scp-splice-locker-head"><span class="scp-section-title">${SPLICE_COPY.lab.lockerTitle}</span></header>
          <div class="scp-splice-seedlist" data-ref="seedList"></div>
          <div class="scp-empty" data-ref="seedEmpty" hidden>
            <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.splice}</span>
            <span>${SPLICE_COPY.lab.lockerEmpty}</span>
            <small>${SPLICE_COPY.lab.lockerEmptyHint}</small>
          </div>
        </div>
        <div class="scp-splice-labside">
          <div class="scp-splice-card" data-ref="card" hidden></div>
          <div class="scp-splice-card scp-splice-card--idle" data-ref="cardIdle">
            <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.splice}</span>
            <span>${SPLICE_COPY.lab.cardIdle}</span>
          </div>
          <div class="scp-splice-acquire">
            <nav class="scp-tabs scp-splice-species" data-ref="species" role="tablist"></nav>
            <div class="scp-splice-acquire-actions">
              <button type="button" class="scp-splice-btn" data-ref="sampleBtn" title="${SPLICE_COPY.lab.sampleHint}">${SPLICE_COPY.lab.sampleTitle}</button>
              <button type="button" class="scp-splice-btn scp-splice-btn--accent" data-ref="beginBtn" title="${SPLICE_COPY.lab.beginHint}">${SPLICE_COPY.lab.begin}</button>
            </div>
            <span class="scp-splice-note" data-ref="acquireNote"></span>
          </div>
        </div>
      </section>

      <section class="scp-splice-surface scp-splice-bench" data-ref="benchSurface" hidden>
        <header class="scp-splice-phase-head">
          <strong data-ref="benchName"></strong>
          <span>${SPLICE_COPY.bench.assign}</span>
        </header>
        <div class="scp-splice-bench-body">
          <div class="scp-splice-slotcol">
            <span class="scp-section-title">${SPLICE_COPY.bench.parents}</span>
            <div class="scp-splice-slotcards" data-ref="parentCards"></div>
            <span class="scp-section-title">${SPLICE_COPY.bench.reagents}</span>
            <div class="scp-splice-slotcards" data-ref="reagentCards"></div>
            <div class="scp-splice-options">
              <header class="scp-splice-options-head"><span data-ref="optHead">${SPLICE_COPY.bench.packTitle}</span></header>
              <div class="scp-splice-optlist" data-ref="optList"></div>
              <div class="scp-empty scp-splice-optempty" data-ref="optEmpty" hidden><span>${SPLICE_COPY.bench.packEmpty}</span></div>
            </div>
          </div>
          <div class="scp-splice-locicol">
            <header class="scp-splice-loci-head">
              <span class="scp-section-title">${SPLICE_COPY.bench.lociTitle}</span>
              <small>${SPLICE_COPY.bench.lociHint}</small>
            </header>
            <div class="scp-splice-loci-colhead" aria-hidden="true">
              <span class="scp-splice-colhead-locus">LOCUS</span>
              <span class="scp-splice-colhead-a">${SPLICE_COPY.bench.parentAHeader}</span>
              <span class="scp-splice-colhead-mid">CHILD</span>
              <span class="scp-splice-colhead-b">${SPLICE_COPY.bench.parentBHeader}</span>
            </div>
            <div class="scp-splice-loci" data-ref="lociList"></div>
          </div>
        </div>
        <footer class="scp-splice-cta">
          <button type="button" class="scp-splice-btn scp-splice-btn--accent" data-ref="assemble">${SPLICE_COPY.bench.assemble}</button>
          <span class="scp-splice-note" data-ref="assembleNote"></span>
          <button type="button" class="scp-splice-btn" data-ref="benchCancel" title="${SPLICE_COPY.bench.cancelFree}">${SPLICE_COPY.bench.cancel}</button>
        </footer>
      </section>

      <section class="scp-splice-surface scp-splice-finish" data-ref="finishSurface" hidden>
        <header class="scp-splice-phase-head scp-splice-finish-head">
          <div class="scp-splice-quality">
            <span class="scp-splice-stamp" data-ref="stamp"></span>
            <span class="scp-splice-quality-line" data-ref="quality"></span>
          </div>
          <div class="scp-splice-points" title="${SPLICE_COPY.finish.applyHint}">
            <span>${SPLICE_COPY.finish.points}</span>
            <strong data-ref="points"></strong>
          </div>
        </header>
        <div class="scp-splice-lines" data-ref="lines"></div>
        <div class="scp-splice-mintrow">
          <button type="button" class="scp-splice-btn scp-splice-exit" data-ref="experiment" title="${SPLICE_COPY.finish.applyHint}">${SPLICE_COPY.finish.apply}</button>
          <input class="scp-splice-mintname" data-ref="mintName" type="text" maxlength="28" aria-label="${SPLICE_COPY.finish.mintName}" placeholder="${SPLICE_COPY.finish.mintNamePlaceholder}" />
          <button type="button" class="scp-splice-btn scp-splice-btn--accent" data-ref="mint" title="${SPLICE_COPY.finish.mintHint}">${SPLICE_COPY.finish.mint}</button>
        </div>
        <footer class="scp-splice-discard" title="${SPLICE_COPY.finish.cancelHint}">
          <button type="button" class="scp-splice-btn scp-splice-btn--danger" data-ref="discard">${SPLICE_COPY.finish.cancel}</button>
          <span class="scp-splice-note" data-ref="discardNote"></span>
        </footer>
      </section>

      <footer class="scp-status-foot">
        <span class="scp-status-line" data-ref="status"></span>
        <span class="scp-splice-session-tag" data-ref="sessionTag"></span>
      </footer>
    </div>
  `;
  contentRoot.appendChild(root);

  const railEl = ref(root, "rail");
  const labSurface = ref(root, "labSurface");
  const seedListEl = ref(root, "seedList");
  const seedEmptyEl = ref(root, "seedEmpty");
  const cardEl = ref(root, "card");
  const cardIdleEl = ref(root, "cardIdle");
  const speciesEl = ref(root, "species");
  const sampleBtn = ref(root, "sampleBtn") as HTMLButtonElement;
  const beginBtn = ref(root, "beginBtn") as HTMLButtonElement;
  const acquireNoteEl = ref(root, "acquireNote");
  const benchSurface = ref(root, "benchSurface");
  const benchNameEl = ref(root, "benchName");
  const parentCardsEl = ref(root, "parentCards");
  const reagentCardsEl = ref(root, "reagentCards");
  const optHeadEl = ref(root, "optHead");
  const optListEl = ref(root, "optList");
  const optEmptyEl = ref(root, "optEmpty");
  const lociListEl = ref(root, "lociList");
  const assembleBtn = ref(root, "assemble") as HTMLButtonElement;
  const assembleNoteEl = ref(root, "assembleNote");
  const benchCancelBtn = ref(root, "benchCancel") as HTMLButtonElement;
  const finishSurface = ref(root, "finishSurface");
  const stampEl = ref(root, "stamp");
  const qualityEl = ref(root, "quality");
  const pointsEl = ref(root, "points");
  const linesEl = ref(root, "lines");
  const experimentBtn = ref(root, "experiment") as HTMLButtonElement;
  const mintNameInput = ref(root, "mintName") as HTMLInputElement;
  const mintBtn = ref(root, "mint") as HTMLButtonElement;
  const discardBtn = ref(root, "discard") as HTMLButtonElement;
  const discardNoteEl = ref(root, "discardNote");
  const statusEl = ref(root, "status");
  const sessionTagEl = ref(root, "sessionTag");

  // ── Local UI state ─────────────────────────────────────────────────────
  let disposed = false;
  let appliedVersion = -1;
  let uiDirty = true;
  let selectedSpecies = SPECIES[0].key as string;
  let selectedSeedKey: string | null = null;
  let selectedSlotIndex = 0;
  /** Per-locus segregation override: locus -> { a?: 0|1, b?: 0|1 }. */
  const alleleChoices = new Map<number, { a?: number; b?: number }>();
  /** Per-locus staged experiment points before EXPERIMENT sends them. */
  let pendingExp = new Map<number, number>();
  let armedDiscardAt = 0;
  let latestMintName: string | null = null;
  let discardWasArmed = false;
  let statusFlashTimer = 0;
  let prevPhase: Phase | null = null;
  let prevParentKeys = "";
  let prevSessionSig = "";

  const receiptWatcher = createSpliceReceiptWatcher(state);
  const receiptScratch: SpliceReceipt[] = [];
  const seedScratch = createCollectedItemsScratch();
  const optScratch = createCollectedItemsScratch();

  const flash = (message: string, ok: boolean): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusEl.toggleAttribute("data-bad", !ok);
    statusFlashTimer = window.setTimeout(() => statusEl.toggleAttribute("data-flash", false), STATUS_FLASH_MS);
  };

  const queueFeedback = (queued: boolean): boolean => {
    if (queued) {
      deps.sfx?.play("ui_button_tick");
    } else {
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(`${SPLICE_COPY.deny} · No authority link.`, false);
    }
    return queued;
  };

  // ── Data helpers ────────────────────────────────────────────────────────
  const cropSeedRows = (): InventoryRow[] => collectInventoryItems(
    state,
    (row) => CROP_SEED_ITEM_IDS.has(row.itemId) && isLocalInventoryContainer(state, row.container),
    seedScratch,
  ).map((vm) => vm.row);

  const seedKey = (row: InventoryRow): string => `${row.itemId}:${row.variantId}`;

  /** Rows eligible for the selected slot, with an effective-available count
   *  that subtracts seats this stack already holds in OTHER slots (so a
   *  single seed can't be seated as both parents, but a stack of ≥2 can self). */
  const optionRowsForSlot = (session: SpliceSessionVM, slotIndex: number): { row: InventoryRow; remaining: number }[] => {
    const expectedItemId = slotIndex < SPLICE_PARENT_SLOTS
      ? session.speciesId
      : REAGENT_ITEM_IDS[slotIndex - SPLICE_PARENT_SLOTS];
    if (!expectedItemId) return [];
    const rows = collectInventoryItems(
      state,
      (row) => row.itemId === expectedItemId && isLocalInventoryContainer(state, row.container),
      optScratch,
    ).map((vm) => vm.row);
    return rows.map((row) => {
      let seatedElsewhere = 0;
      for (const slot of session.slots) {
        if (slot.slotIndex === slotIndex) continue;
        if (slot.filled && slot.itemId === row.itemId && slot.variantId === row.variantId) seatedElsewhere += 1;
      }
      return { row, remaining: row.available - seatedElsewhere };
    });
  };

  const parentScan = (session: SpliceSessionVM, parentIdx: 0 | 1): GenomeScanVM | null => {
    const slot = session.slots[parentIdx];
    if (!slot || !slot.filled) return null;
    return scanForStack(slot.itemId, slot.variantId);
  };

  const eliteIndex = (a1?: number, a2?: number): 0 | 1 => ((a1 ?? 0) >= (a2 ?? 0) ? 0 : 1);
  const chosenIndexFor = (locus: number, side: "a" | "b", scan: GenomeScanVM | null): 0 | 1 => {
    const override = alleleChoices.get(locus)?.[side];
    if (override === 0 || override === 1) return override;
    const l = scan?.loci.find((row) => row.locus === locus);
    return eliteIndex(l?.a1, l?.a2);
  };

  // ── Phase rail ────────────────────────────────────────────────────────
  const railSteps: HTMLElement[] = [];
  for (const [index, label] of SPLICE_COPY.phases.entries()) {
    const step = document.createElement("span");
    step.className = "scp-splice-rail-step";
    step.textContent = label;
    railEl.appendChild(step);
    railSteps.push(step);
    if (index < SPLICE_COPY.phases.length - 1) {
      const tick = document.createElement("i");
      tick.className = "scp-splice-rail-tick";
      tick.setAttribute("aria-hidden", "true");
      railEl.appendChild(tick);
    }
  }
  const applyRail = (phase: Phase): void => {
    const active = phase === "lab" ? 0 : phase === "bench" ? 1 : 2;
    for (const [index, step] of railSteps.entries()) {
      step.toggleAttribute("data-active", index === active);
      step.toggleAttribute("data-done", index < active);
    }
  };

  // ── Species chips ───────────────────────────────────────────────────────
  for (const species of SPECIES) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "scp-tab";
    tab.dataset.species = species.key;
    tab.textContent = species.label;
    speciesEl.appendChild(tab);
  }
  speciesEl.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".scp-tab") : null;
    const key = tab?.dataset.species;
    if (!key || key === selectedSpecies) return;
    selectedSpecies = key;
    uiDirty = true;
  });

  // ── LAB interactions ────────────────────────────────────────────────────
  seedListEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const rowEl = target?.closest<HTMLElement>(".scp-splice-seedrow");
    if (!rowEl) return;
    if (target?.closest("[data-scan]")) {
      const container = rowEl.dataset.container ?? "";
      const stackId = rowEl.dataset.stackId ?? "";
      const variantId = Number(rowEl.dataset.variantId ?? "0");
      if (queueFeedback(deps.commands.scanGenome(container, stackId, variantId))) flash("SCANNING…", true);
      return;
    }
    const key = rowEl.dataset.key ?? null;
    if (key !== selectedSeedKey) {
      selectedSeedKey = key;
      uiDirty = true;
    }
  });
  sampleBtn.addEventListener("click", () => {
    if (queueFeedback(deps.commands.geneSample(selectedSpecies))) flash("SAMPLING WILD FLORA…", true);
  });
  beginBtn.addEventListener("click", () => {
    if (queueFeedback(deps.commands.begin(selectedSpecies))) {
      const label = SPECIES.find((s) => s.key === selectedSpecies)?.label ?? selectedSpecies;
      flash(`${label.toUpperCase()} · BENCH OPEN`, true);
    }
  });

  // ── BENCH interactions ──────────────────────────────────────────────────
  const seatOption = (slotIndex: number, seat: { container: string; stackId: string; variantId: number; item: string }): void => {
    if (!seat.stackId || seat.stackId === "0") return;
    if (queueFeedback(deps.commands.assignSlot(slotIndex, seat.container, seat.stackId, seat.variantId))) {
      flash(`${(seat.item || "SEED").toUpperCase()} · SEATED`, true);
    }
  };
  const onSlotCardClick = (event: Event): void => {
    const target = event.target instanceof Element ? event.target : null;
    const card = target?.closest<HTMLElement>(".scp-splice-slotcard");
    if (!card) return;
    const slotIndex = Number(card.dataset.slotIndex ?? "0");
    if (target?.closest("[data-clear]")) {
      queueFeedback(deps.commands.clearSlot(slotIndex));
      return;
    }
    if (slotIndex !== selectedSlotIndex) {
      selectedSlotIndex = slotIndex;
      uiDirty = true;
    }
  };
  parentCardsEl.addEventListener("click", onSlotCardClick);
  reagentCardsEl.addEventListener("click", onSlotCardClick);
  const onSlotDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer?.types.includes(SPLICE_DRAG_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };
  const onSlotDrop = (event: DragEvent): void => {
    const raw = event.dataTransfer?.getData(SPLICE_DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const card = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-splice-slotcard") : null;
    if (!card) return;
    try {
      const payload = JSON.parse(raw) as { container: string; stackId: string; variantId: number; item: string };
      seatOption(Number(card.dataset.slotIndex ?? "0"), payload);
    } catch {
      // malformed foreign payload — ignore
    }
  };
  parentCardsEl.addEventListener("dragover", onSlotDragOver);
  parentCardsEl.addEventListener("drop", onSlotDrop);
  reagentCardsEl.addEventListener("dragover", onSlotDragOver);
  reagentCardsEl.addEventListener("drop", onSlotDrop);

  optListEl.addEventListener("dblclick", (event) => {
    const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-splice-opt") : null;
    if (!rowEl || rowEl.hasAttribute("data-short")) return;
    seatOption(selectedSlotIndex, optionPayloadOf(rowEl));
  });
  optListEl.addEventListener("dragstart", (event) => {
    const rowEl = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-splice-opt") : null;
    if (!rowEl || rowEl.hasAttribute("data-short") || !event.dataTransfer) return;
    event.dataTransfer.setData(SPLICE_DRAG_MIME, JSON.stringify(optionPayloadOf(rowEl)));
    event.dataTransfer.effectAllowed = "move";
  });

  lociListEl.addEventListener("click", (event) => {
    const chip = event.target instanceof Element ? event.target.closest<HTMLElement>(".scp-splice-allele[data-pick]") : null;
    if (!chip) return;
    const locus = Number(chip.dataset.locus ?? "-1");
    const side = chip.dataset.side === "b" ? "b" : "a";
    const allele = Number(chip.dataset.allele ?? "0") === 1 ? 1 : 0;
    if (locus < 0) return;
    const entry = alleleChoices.get(locus) ?? {};
    entry[side] = allele;
    alleleChoices.set(locus, entry);
    if (queueFeedback(deps.commands.chooseAllele(locus, side === "a" ? 0 : 1, allele))) uiDirty = true;
  });

  assembleBtn.addEventListener("click", () => {
    if (assembleBtn.disabled) return;
    queueFeedback(deps.commands.assemble());
  });
  benchCancelBtn.addEventListener("click", () => queueFeedback(deps.commands.cancel()));

  // ── FINISH interactions ─────────────────────────────────────────────────
  linesEl.addEventListener("click", (event) => {
    const btn = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-spend]") : null;
    if (!btn) return;
    const session = spliceSession();
    if (!session) return;
    const lineEl = btn.closest<HTMLElement>(".scp-splice-line");
    const locus = Number(lineEl?.dataset.locus ?? "-1");
    const line = session.lines.find((row) => row.locus === locus);
    if (!line || locus < 0) return;
    const delta = btn.dataset.spend === "+" ? 1 : -1;
    const staged = totalStaged();
    const current = pendingExp.get(locus) ?? 0;
    const next = current + delta;
    if (next < 0) return;
    if (delta > 0 && (staged >= session.pointsRemaining || !line.canRaise)) {
      deps.sfx?.play(successorAudioIds.uiDeny);
      return;
    }
    const map = new Map(pendingExp);
    if (next === 0) map.delete(locus); else map.set(locus, next);
    pendingExp = map;
    deps.sfx?.play("ui_button_tick");
    uiDirty = true;
  });
  experimentBtn.addEventListener("click", () => {
    if (experimentBtn.disabled) return;
    const spends = [...pendingExp.entries()].filter(([, points]) => points > 0);
    if (spends.length === 0) return;
    let queuedAll = true;
    for (const [locus, points] of spends) queuedAll = deps.commands.experiment(locus, points) && queuedAll;
    queueFeedback(queuedAll);
    if (queuedAll) {
      pendingExp = new Map();
      uiDirty = true;
    }
  });
  mintBtn.addEventListener("click", () => {
    if (mintBtn.disabled) return;
    const name = mintNameInput.value.trim();
    latestMintName = name.length > 0 ? name : null;
    if (queueFeedback(deps.commands.mint(latestMintName))) flash("MINTING…", true);
  });
  mintNameInput.addEventListener("keydown", (event) => {
    if (event.code === "Enter") { event.preventDefault(); mintBtn.click(); }
    else if (event.code === "Escape") { event.preventDefault(); event.stopPropagation(); mintNameInput.blur(); }
  });
  discardBtn.addEventListener("click", () => {
    const now = performance.now();
    if (armedDiscardAt === 0 || now - armedDiscardAt > DISCARD_ARM_MS) {
      armedDiscardAt = now;
      deps.sfx?.play(successorAudioIds.uiDeny);
      flash(SPLICE_COPY.finish.cancelArm, false);
      uiDirty = true;
      return;
    }
    armedDiscardAt = 0;
    discardWasArmed = true;
    queueFeedback(deps.commands.cancel());
    uiDirty = true;
  });

  const totalStaged = (): number => [...pendingExp.values()].reduce((sum, n) => sum + n, 0);

  // ── Renderers ─────────────────────────────────────────────────────────
  const renderGenomeCard = (scan: GenomeScanVM | null): void => {
    cardEl.hidden = scan === null;
    cardIdleEl.hidden = scan !== null;
    if (!scan) return;
    const rows: string[] = [];
    rows.push(`<div class="scp-splice-card-head">
      <strong>«${escapeHtml(scan.cultivarName)}»</strong>
      <span class="scp-splice-card-species">${escapeHtml(scan.speciesName)}</span>
      <span class="scp-splice-card-tags">
        <b class="${scan.fertile ? "scp-splice-fertile" : "scp-splice-sterile"}">${scan.fertile ? SPLICE_COPY.lab.fertile : SPLICE_COPY.lab.sterile}</b>
        <span class="scp-splice-tier">read at ${escapeHtml(tierLabel(scan.tier))}${scan.generation !== undefined ? ` · G${scan.generation}` : ""}</span>
      </span>
    </div>`);
    const showAlleles = tierRevealsAlleles(scan.tier);
    for (const locus of scan.loci) {
      let alleleCell = "";
      if (showAlleles && locus.a1 !== undefined && locus.a2 !== undefined) {
        alleleCell = `<span class="scp-splice-alleles">${locus.a1}<i>|</i>${locus.a2}${locus.heterozygous ? " <em>het</em>" : ""}</span>`;
      } else if (locus.heterozygous !== undefined) {
        alleleCell = `<span class="scp-splice-alleles scp-splice-alleles--hint">${locus.heterozygous ? "mixed" : "true-breeding"}</span>`;
      }
      rows.push(`<div class="scp-splice-card-locus"><span>${escapeHtml(locusLabel(locus.label))}</span><b>${locus.expressMilli}</b>${alleleCell}</div>`);
    }
    if (scan.mutationPotentialMilli !== undefined) rows.push(`<div class="scp-splice-card-meta">mutation potential <b>${scan.mutationPotentialMilli}</b></div>`);
    if (scan.breederId) rows.push(`<div class="scp-splice-card-meta">bred by ${escapeHtml(scan.breederId)}</div>`);
    cardEl.innerHTML = rows.join("");
  };

  const renderLab = (): void => {
    const rows = cropSeedRows();
    seedEmptyEl.hidden = rows.length > 0;
    if (rows.length > 0 && !rows.some((row) => seedKey(row) === selectedSeedKey)) selectedSeedKey = seedKey(rows[0]!);
    seedListEl.textContent = "";
    for (const row of rows) {
      const key = seedKey(row);
      const scan = scanForStack(row.itemId, row.variantId);
      const el = document.createElement("div");
      el.className = "scp-splice-seedrow";
      el.dataset.key = key;
      el.dataset.container = row.container;
      el.dataset.stackId = String(row.stackId ?? 0);
      el.dataset.variantId = String(row.variantId);
      el.toggleAttribute("data-selected", key === selectedSeedKey);
      const speciesLabel = SPECIES_BY_ITEM.get(row.itemId)?.label ?? row.item;
      const title = scan ? scan.cultivarName : speciesLabel;
      const sub = scan ? `${speciesLabel} · ${SPLICE_COPY.lab.scanned}` : SPLICE_COPY.lab.unscanned;
      el.innerHTML = `
        <span class="scp-splice-seed-glyph" aria-hidden="true">${spliceSlotIconSvg("parent") ?? UI_ICONS.splice}</span>
        <div class="scp-splice-seed-main"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(sub)}</span></div>
        <span class="scp-splice-seed-qty">×${row.available}</span>
        <button type="button" class="scp-splice-btn scp-splice-seed-scan" data-scan>${SPLICE_COPY.lab.scan}</button>
      `;
      seedListEl.appendChild(el);
    }
    for (const tab of speciesEl.querySelectorAll<HTMLButtonElement>(".scp-tab")) {
      tab.setAttribute("aria-selected", tab.dataset.species === selectedSpecies ? "true" : "false");
    }
    const selectedRow = rows.find((row) => seedKey(row) === selectedSeedKey) ?? null;
    const selectedScan = selectedRow ? scanForStack(selectedRow.itemId, selectedRow.variantId) : latestGenomeScan();
    renderGenomeCard(selectedScan);
    acquireNoteEl.textContent = "";
  };

  const renderSlotCard = (session: SpliceSessionVM, container: HTMLElement, kind: "parent" | "reagent"): void => {
    container.textContent = "";
    for (const slot of session.slots) {
      if (slot.kind !== kind) continue;
      const el = document.createElement("div");
      el.className = "scp-splice-slotcard";
      el.dataset.slotIndex = String(slot.slotIndex);
      el.toggleAttribute("data-selected", slot.slotIndex === selectedSlotIndex);
      el.toggleAttribute("data-filled", slot.filled);
      const token = kind === "parent" ? "parent" : REAGENT_TOKENS[slot.slotIndex - SPLICE_PARENT_SLOTS] ?? "serum";
      const scan = slot.filled && kind === "parent" ? scanForStack(slot.itemId, slot.variantId) : null;
      const seated = slot.filled ? (scan?.cultivarName ?? slot.label) : "empty";
      el.innerHTML = `
        <span class="scp-splice-slot-glyph" aria-hidden="true">${spliceSlotIconSvg(token) ?? UI_ICONS.splice}</span>
        <div class="scp-splice-slot-main"><strong>${escapeHtml(slot.label.toUpperCase())}</strong><span data-empty="${slot.filled ? "false" : "true"}">${escapeHtml(seated)}</span></div>
        <button type="button" class="scp-splice-btn scp-splice-slot-clear" data-clear ${slot.filled ? "" : "hidden"}>${SPLICE_COPY.bench.clear}</button>
      `;
      container.appendChild(el);
    }
  };

  const renderBench = (session: SpliceSessionVM): void => {
    benchNameEl.textContent = session.speciesName || "GENE BENCH";
    // Selected slot must exist; default to the first parent.
    if (!session.slots.some((slot) => slot.slotIndex === selectedSlotIndex)) selectedSlotIndex = 0;
    renderSlotCard(session, parentCardsEl, "parent");
    renderSlotCard(session, reagentCardsEl, "reagent");

    const options = optionRowsForSlot(session, selectedSlotIndex);
    const selSlot = session.slots.find((slot) => slot.slotIndex === selectedSlotIndex);
    optHeadEl.textContent = `${SPLICE_COPY.bench.packTitle} · ${(selSlot?.label ?? "").toUpperCase()}`;
    optEmptyEl.hidden = options.length > 0;
    optListEl.textContent = "";
    for (const { row, remaining } of options) {
      const scan = scanForStack(row.itemId, row.variantId);
      const el = document.createElement("div");
      el.className = "scp-splice-opt";
      el.draggable = remaining > 0;
      el.dataset.container = row.container;
      el.dataset.stackId = String(row.stackId ?? 0);
      el.dataset.variantId = String(row.variantId);
      el.dataset.item = row.item;
      el.toggleAttribute("data-short", remaining <= 0);
      const title = scan?.cultivarName ?? row.item;
      el.innerHTML = `
        <div class="scp-splice-opt-main"><strong>${escapeHtml(title)}</strong>${scan ? "" : `<span class="scp-splice-opt-hint">${SPLICE_COPY.lab.unscanned.toLowerCase()}</span>`}</div>
        <span class="scp-splice-opt-qty">×${Math.max(0, remaining)}</span>
      `;
      optListEl.appendChild(el);
    }

    renderLoci(session);

    const canAssemble = session.canAssemble;
    assembleBtn.disabled = !canAssemble;
    assembleNoteEl.textContent = canAssemble ? SPLICE_COPY.bench.assembleWarn : SPLICE_COPY.bench.assembleGate;
    assembleNoteEl.toggleAttribute("data-warn", canAssemble);
  };

  const renderLoci = (session: SpliceSessionVM): void => {
    const scanA = parentScan(session, 0);
    const scanB = parentScan(session, 1);
    const seatedA = session.slots[0]?.filled ?? false;
    const seatedB = session.slots[1]?.filled ?? false;
    lociListEl.textContent = "";
    // Locus rows come from whichever parent scan is available (both share the
    // 13-locus order); fall back to a fixed 0..12 when neither is scanned yet.
    const loci = (scanA ?? scanB)?.loci.map((row) => ({ locus: row.locus, label: row.label }))
      ?? Array.from({ length: 13 }, (_v, i) => ({ locus: i, label: "" }));
    for (const { locus, label } of loci) {
      const el = document.createElement("div");
      el.className = "scp-splice-locus";
      el.dataset.locus = String(locus);
      const cellA = alleleCell(locus, "a", scanA, seatedA);
      const cellB = alleleCell(locus, "b", scanB, seatedB);
      const base = previewBase(locus, scanA, scanB);
      el.innerHTML = `
        <span class="scp-splice-locus-label">${escapeHtml(label ? locusLabel(label) : `L${locus}`)}</span>
        <span class="scp-splice-locus-side" data-side="a">${cellA}</span>
        <span class="scp-splice-locus-base">${base}</span>
        <span class="scp-splice-locus-side" data-side="b">${cellB}</span>
      `;
      lociListEl.appendChild(el);
    }
  };

  const alleleCell = (locus: number, side: "a" | "b", scan: GenomeScanVM | null, seated: boolean): string => {
    if (!seated) return `<span class="scp-splice-allele scp-splice-allele--empty">seat ${side.toUpperCase()}</span>`;
    const l = scan?.loci.find((row) => row.locus === locus);
    if (!l || l.a1 === undefined || l.a2 === undefined) {
      return `<span class="scp-splice-allele scp-splice-allele--unknown" title="Scan this parent to allele-values tier">${SPLICE_COPY.bench.unknown}</span>`;
    }
    const chosen = chosenIndexFor(locus, side, scan);
    const chip = (index: 0 | 1, value: number): string => {
      const isElite = eliteIndex(l.a1, l.a2) === index;
      const eliteMark = isElite ? ` <em title="${SPLICE_COPY.bench.elite} allele">\u2605</em>` : "";
      return `<button type="button" class="scp-splice-allele" data-pick data-locus="${locus}" data-side="${side}" data-allele="${index}"${chosen === index ? " data-chosen" : ""}${isElite ? " data-elite" : ""}>${value}${eliteMark}</button>`;
    };
    return `${chip(0, l.a1)}${chip(1, l.a2)}`;
  };

  const previewBase = (locus: number, scanA: GenomeScanVM | null, scanB: GenomeScanVM | null): string => {
    const la = scanA?.loci.find((row) => row.locus === locus);
    const lb = scanB?.loci.find((row) => row.locus === locus);
    if (!la || la.a1 === undefined || la.a2 === undefined || !lb || lb.a1 === undefined || lb.a2 === undefined) return "—";
    const va = chosenIndexFor(locus, "a", scanA) === 0 ? la.a1 : la.a2;
    const vb = chosenIndexFor(locus, "b", scanB) === 0 ? lb.a1 : lb.a2;
    return String(Math.floor((va + vb) / 2));
  };

  const renderFinish = (session: SpliceSessionVM): void => {
    const stamp = spliceStampFor(session.assemblyQualityMilli);
    stampEl.textContent = stamp.stamp;
    qualityEl.textContent = `${SPLICE_COPY.finish.quality} ${Math.round(session.assemblyQualityMilli / 10)}%`;
    const staged = totalStaged();
    pointsEl.textContent = staged > 0 ? `${session.pointsRemaining - staged} / ${session.pointsRemaining}` : String(session.pointsRemaining);

    linesEl.textContent = "";
    for (const line of session.lines) {
      const staging = pendingExp.get(line.locus) ?? 0;
      const el = document.createElement("div");
      el.className = "scp-splice-line";
      el.dataset.locus = String(line.locus);
      el.toggleAttribute("data-capped", !line.canRaise);
      const valuePct = line.capMilli > 0 ? Math.round((line.valueMilli / 1000) * 100) : 0;
      const capPct = line.capMilli > 0 ? Math.round((line.capMilli / 1000) * 100) : 0;
      el.innerHTML = `
        <span class="scp-splice-line-label">${escapeHtml(locusLabel(line.label))}</span>
        <span class="scp-splice-line-bar" aria-hidden="true"><i class="scp-splice-line-fill" style="width:${valuePct}%"></i><i class="scp-splice-line-cap" style="left:${capPct}%"></i></span>
        <span class="scp-splice-line-vals">${line.valueMilli} / ${line.capMilli}</span>
        <span class="scp-splice-line-mark"${staging > 0 ? " data-marked" : ""}>${staging > 0 ? `+${staging}` : line.canRaise ? "" : SPLICE_COPY.finish.lineCapped}</span>
        <span class="scp-splice-line-spend">
          <button type="button" class="scp-splice-step" data-spend="-" aria-label="Unmark point"${staging <= 0 ? " disabled" : ""}>−</button>
          <b>${staging}</b>
          <button type="button" class="scp-splice-step" data-spend="+" aria-label="Mark point"${!line.canRaise || staged >= session.pointsRemaining ? " disabled" : ""}>+</button>
        </span>
      `;
      linesEl.appendChild(el);
    }
    experimentBtn.disabled = staged <= 0;
    discardBtn.toggleAttribute("data-armed", armedDiscardAt > 0);
    discardNoteEl.textContent = armedDiscardAt > 0 ? SPLICE_COPY.finish.cancelArm : "";
  };

  const renderAll = (): void => {
    const session = spliceSession();
    const phase = phaseOf(session);
    labSurface.hidden = phase !== "lab";
    benchSurface.hidden = phase !== "bench";
    finishSurface.hidden = phase !== "finish";
    applyRail(phase);
    if (phase === "lab") renderLab();
    else if (phase === "bench" && session) renderBench(session);
    else if (phase === "finish" && session) renderFinish(session);
    const tag = session && phase !== "lab" ? `BENCH · ${(session.speciesName || "").toUpperCase()}` : "";
    if (sessionTagEl.textContent !== tag) sessionTagEl.textContent = tag;
  };

  // ── Receipts → toast vocabulary ─────────────────────────────────────────
  const handleReceipts = (): void => {
    receiptScratch.length = 0;
    receiptWatcher.poll(receiptScratch);
    for (const receipt of receiptScratch) {
      if (!receipt.accepted) {
        deps.sfx?.play(successorAudioIds.uiDeny);
        flash(`${SPLICE_COPY.deny} · ${spliceReasonLine(receipt.reasonCode)}`, false);
        continue;
      }
      if (receipt.kind === "GeneSample") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        flash("WILD GENOME BANKED", true);
      } else if (receipt.kind === "SpliceMint") {
        deps.sfx?.play(successorAudioIds.itemTransfer);
        const name = latestMintName;
        flash(name ? `${SPLICE_COPY.finish.minted} · «${name}»` : SPLICE_COPY.finish.minted, true);
        latestMintName = null;
      } else if (receipt.kind === "SpliceCancel") {
        // A cancel that closed an assembled session is a discard; otherwise a
        // free bench close.
        flash(discardWasArmed ? SPLICE_COPY.finish.discarded : "BENCH CLOSED", true);
        discardWasArmed = false;
      }
    }
  };

  // ── Frame update ────────────────────────────────────────────────────────
  return {
    update(): void {
      syncSpliceChannelFromAuthority(state);
      // Capture the mint name at send-time so the receipt can name it.
      handleReceipts();

      const session = spliceSession();
      const phase = phaseOf(session);
      if (phase !== prevPhase) {
        if (phase === "lab") {
          pendingExp = new Map();
          alleleChoices.clear();
          armedDiscardAt = 0;
        }
        if (phase === "bench") selectedSlotIndex = 0;
        prevPhase = phase;
        uiDirty = true;
      }

      // Reset segregation overrides when a parent seed changes (stale indices).
      if (session && phase === "bench") {
        const parentKeys = `${session.slots[0]?.variantId ?? 0}:${session.slots[1]?.variantId ?? 0}`;
        if (parentKeys !== prevParentKeys) {
          alleleChoices.clear();
          prevParentKeys = parentKeys;
          uiDirty = true;
        }
      }

      if (armedDiscardAt > 0 && performance.now() - armedDiscardAt > DISCARD_ARM_MS) {
        armedDiscardAt = 0;
        uiDirty = true;
      }

      const version = spliceStoreVersion();
      const sig = `${phase}|${version}`;
      if (version !== appliedVersion || uiDirty || sig !== prevSessionSig) {
        appliedVersion = version;
        prevSessionSig = sig;
        uiDirty = false;
        renderAll();
      }
    },
    onResized(): void {
      uiDirty = true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      root.remove();
    },
  };

}

function optionPayloadOf(row: HTMLElement): { container: string; stackId: string; variantId: number; item: string } {
  return {
    container: row.dataset.container ?? "",
    stackId: row.dataset.stackId ?? "0",
    variantId: Number(row.dataset.variantId ?? "0"),
    item: row.dataset.item ?? "",
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (ch) => (
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
  ));
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`splice window: missing data-ref="${name}"`);
  return el;
}
