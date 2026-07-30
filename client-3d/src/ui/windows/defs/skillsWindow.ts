import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPurchaseSkillBoxCommand,
  enqueueAuthorityUnlearnSkillBoxCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type {
  PlayState,
  ServerAuthorityActorState,
  ServerAuthorityProfessionState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  professionDefinitions,
  skillNodeDefinitions,
  type ProfessionId,
  type SkillNodeState,
} from "@successor/client/src/slice-core/progressionSystem";
import {
  nearestProfessionTrainer,
  professionTrainerById,
  professionTrainerInteractionRadiusCells,
  type ProfessionTrainerCandidate,
} from "@successor/client/src/slice-core/professionTrainerSystem";
import { UI_ICONS } from "../../icons";
import { createRejectWatcher } from "./commandReceipts";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * SKILLS — profession tracks left, skill-box grid right (remake).
 *
 * Box states (DESIGN.md, icon-first): OWNED = accent border; OPEN
 * (purchasable) = filled accent; LOCKED = ink-dim with a lock glyph — the
 * REASON lives on hover only. PENDING = queued train/unlearn awaiting the ack.
 *
 * Purchases wire `PurchaseSkillBox`; owned boxes wire `UnlearnSkillBox`. Both
 * commands REQUIRE a trainer: the SELECTED actor wins when it is a trainer in
 * interaction range; nearby trainers are informational until selected.
 * With no trainer the purchase is disabled behind a trainer glyph (hover:
 * "Select a trainer"). The footer mirrors `state.status`, which carries both
 * queue confirmations and the authority's reject reasons.
 *
 * Data reads mirror professionsPanelSystem: authority actor professions,
 * trained boxes (+ synthetic `<id>-novice` for learned tracks), per-track XP,
 * credits, skill-point caps, pending skill-change envelopes.
 */
export function createSkillsWindowDefinition(): WindowDefinition {
  return {
    id: "skills",
    title: "SKILLS",
    icon: "skills",
    hotkey: "KeyK",
    minWidth: 560,
    minHeight: 400,
    // r2 cascade (fe-polish §1.30): right-of-center with the strip in the
    // y≈118 lane — the mid-height slot was buried under the craft/actions
    // bodies in the all-open pile at 1920.
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = Math.max(560, Math.round(viewport.w * 0.52));
      const h = Math.max(400, Math.round(viewport.h * 0.62));
      const x = Math.min(viewport.w - w - 12, Math.round((viewport.w - w) / 2) + 80);
      return { x: Math.max(12, x), y: Math.min(118, Math.round(viewport.h * 0.13)), w, h };
    },
    mount: (contentRoot, ctx) => mountSkillsContent(contentRoot, ctx),
  };
}

const PROFESSION_PRIORITY: readonly ProfessionId[] = ["marksman", "scout", "craftsman", "medic", "brawler"];
const STATUS_FLASH_MS = 2600;

function mountSkillsContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-skills";
  root.innerHTML = `
    <div class="scp-skills-body">
      <nav class="scp-tracks" data-ref="tracks" aria-label="Professions"></nav>
      <div class="scp-tree-wrap">
        <header class="scp-tree-head" data-ref="treeHead"></header>
        <div class="scp-tree" data-ref="tree"></div>
      </div>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status"></span>
      <span class="scp-trainer-line" data-ref="trainer"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const tracksEl = ref(root, "tracks");
  const treeHeadEl = ref(root, "treeHead");
  const treeEl = ref(root, "tree");
  const statusEl = ref(root, "status");
  const trainerEl = ref(root, "trainer");

  let renderKey = "";
  let lastStatus = "";
  let statusFlashTimer = 0;
  // Only THIS window's command kind may flash here — a rejected fire or
  // exchange command must never read as a skills denial.
  const rejectWatcher = createRejectWatcher(state, ["PurchaseSkillBox", "UnlearnSkillBox"]);

  const playerActor = (): ServerAuthorityActorState | null => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    return state.serverAuthority.actors[actorId] ?? null;
  };

  const selectedProfession = (): ProfessionId => {
    const selected = state.professionUi.selectedProfessionId;
    return selected && PROFESSION_PRIORITY.includes(selected) ? selected : "marksman";
  };

  /**
   * The purchase gate (P5.3, owner-approved): ONLY the SELECTED actor counts,
   * and only while inside interaction range — selection is the 3D client's
   * targeting modality, and gating on it keeps the command's trainer explicit
   * (never silently routed to an off-screen trainer). The nearest trainer is
   * surfaced as informational hover text in the footer, not as a gate.
   */
  const selectedTrainer = (): ProfessionTrainerCandidate | null => {
    const selected = professionTrainerById(slice, state, state.selectedActorId);
    if (selected && selected.distanceCells <= professionTrainerInteractionRadiusCells) return selected;
    return null;
  };

  /**
   * In-flight skill changes, command_id → action + skill_box_id. The shared authority
   * client splices `authorityCommands.pending` on flush (before any receipt),
   * so a direct pending read lasts only a sub-frame. In a per-frame window
   * that would flicker the box back to purchasable during the ack window
   * (double-click hazard). This local map holds PENDING from enqueue until
   * the receipt for that command_id lands in the receipt log (accepted or
   * rejected), with the authoritative trained/untrained state as the safety
   * net against log eviction.
   */
  const inFlightSkillActions = new Map<number, { kind: "train" | "unlearn"; skillBoxId: string }>();

  const settleInFlightSkillActions = (trainedNow: (skillBoxId: string) => boolean): void => {
    if (inFlightSkillActions.size === 0) return;
    const log = state.serverAuthority.receiptLog;
    for (const [commandId, action] of inFlightSkillActions) {
      let settled = action.kind === "train"
        ? trainedNow(action.skillBoxId)
        : !trainedNow(action.skillBoxId);
      if (!settled) {
        for (let i = log.length - 1; i >= 0; i -= 1) {
          if (log[i]!.commandId === commandId) {
            settled = true;
            break;
          }
        }
      }
      if (settled) inFlightSkillActions.delete(commandId);
    }
  };

  // ── Click delegation: track select + box train/unlearn ───────────────────
  root.addEventListener("click", (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    const trackBtn = target?.closest<HTMLButtonElement>("[data-track]");
    if (trackBtn) {
      const id = trackBtn.dataset.track as ProfessionId;
      if (PROFESSION_PRIORITY.includes(id)) {
        state.professionUi.selectedProfessionId = id;
        renderKey = ""; // force rebuild
      }
      return;
    }
    const boxBtn = target?.closest<HTMLButtonElement>("[data-skill-box]");
    if (!boxBtn || boxBtn.disabled) return;
    const skillBoxId = boxBtn.dataset.skillBox ?? "";
    const trainerActorId = boxBtn.dataset.trainer ?? "";
    const action = boxBtn.dataset.action === "unlearn" ? "unlearn" : "train";
    if (!skillBoxId || !trainerActorId) return;
    const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    const queued = action === "unlearn"
      ? enqueueAuthorityUnlearnSkillBoxCommand(
        state.authorityCommands,
        skillBoxId,
        trainerActorId,
        issuedAtTick,
      )
      : enqueueAuthorityPurchaseSkillBoxCommand(
        state.authorityCommands,
        skillBoxId,
        trainerActorId,
        issuedAtTick,
      );
    if (queued) {
      inFlightSkillActions.set(queued.command_id, { kind: action, skillBoxId });
      state.status = action === "unlearn" ? `unlearning ${skillBoxId}` : `training ${skillBoxId}`;
    }
    renderKey = "";
  });

  const rebuild = (): void => {
    const actor = playerActor();
    const professionId = selectedProfession();
    const trainer = selectedTrainer();
    state.professionUi.trainerActorId = trainer?.source.id ?? null;
    const byId = new Map((actor?.professions ?? []).map((profession) => [profession.id, profession]));

    // Left rail: all five tracks, learned state visible at a glance.
    tracksEl.textContent = "";
    for (const id of PROFESSION_PRIORITY) {
      const profession = byId.get(id) ?? null;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "scp-track";
      btn.dataset.track = id;
      btn.toggleAttribute("data-selected", id === professionId);
      btn.toggleAttribute("data-learned", profession !== null);
      btn.title = profession
        ? `${formatInteger(profession.xp)} profession XP available across its earned track pools`
        : "Not learned — novice box opens the profession";
      const label = document.createElement("strong");
      label.textContent = (professionDefinitions[id] ?? id).toUpperCase();
      const meta = document.createElement("span");
      // Unlearned reads UNTRAINED (P2.17): the bare em dash looked like a
      // missing subline beside the siblings' "0 XP".
      meta.textContent = profession ? `${formatInteger(profession.xp)} XP` : "UNTRAINED";
      btn.append(label, meta);
      tracksEl.appendChild(btn);
    }

    // Header: track label + SP ledger.
    const profession = byId.get(professionId) ?? null;
    treeHeadEl.textContent = "";
    const headLabel = document.createElement("strong");
    headLabel.textContent = (professionDefinitions[professionId] ?? professionId).toUpperCase();
    const headMeta = document.createElement("span");
    headMeta.title = "Skill points used / cap";
    headMeta.textContent = `SP ${formatInteger(actor?.skillPointsUsed ?? 0)}/${formatInteger(actor?.skillPointsCap ?? 250)} · CR ${formatInteger(actor?.credits ?? 0)}`;
    treeHeadEl.append(headLabel, headMeta);

    // Grid: master row 1, tiers 4..1, novice row 6.
    treeEl.textContent = "";
    const nodes = skillNodeDefinitions
      .filter((node) => node.profession === professionId && typeof node.row === "number" && typeof node.column === "number");
    const pending = new Set([...inFlightSkillActions.values()].map((action) => action.skillBoxId));
    for (const node of nodes) {
      treeEl.appendChild(buildSkillBox(actor, profession, node, trainer, pending));
    }
  };

  const buildSkillBox = (
    actor: ServerAuthorityActorState | null,
    profession: ServerAuthorityProfessionState | null,
    node: SkillNodeState,
    trainer: ProfessionTrainerCandidate | null,
    pending: Set<string>,
  ): HTMLButtonElement => {
    const learned = profession !== null;
    const novice = node.id.endsWith("-novice");
    const trainedBoxes = trainedSkillBoxes(profession);
    const trained = trainedBoxes.has(node.id);
    const queued = pending.has(node.id);
    const hasLearnedDependent = skillNodeDefinitions.some((candidate) => (
      trainedBoxes.has(candidate.id) && (candidate.prerequisites ?? []).includes(node.id)
    ));
    const xp = skillNodeXp(profession, node);
    const xpCost = Math.max(0, node.xpCost ?? 0);
    const spCost = Math.max(0, node.skillPointCost ?? 0);
    const creditCost = typeof node.creditCost === "number" && Number.isFinite(node.creditCost)
      ? Math.max(0, Math.trunc(node.creditCost))
      : 0;
    const prereqsMet = (node.prerequisites ?? []).every((required) => trainedBoxes.has(required));
    const hasXp = xp >= xpCost;
    const hasCredits = (actor?.credits ?? 0) >= creditCost;
    const hasSkillPoints = (actor?.skillPointsUsed ?? 0) + spCost <= (actor?.skillPointsCap ?? 250);
    const accessible = learned || novice;
    const canTrain = accessible && !trained && !queued && prereqsMet && hasXp && hasCredits && hasSkillPoints && trainer !== null;
    const canUnlearn = trained && !queued && !hasLearnedDependent && trainer !== null;

    const boxState = queued ? "pending" : trained ? "owned" : canTrain ? "open" : "locked";
    // The REASON is hover-only (copy principle) — never inline text.
    const reason = queued
      ? "Skill change queued — awaiting authority"
      : trained
        ? hasLearnedDependent
          ? "Unlearn dependent boxes first"
          : trainer === null
            ? "Select a trainer to unlearn this box"
            : `Unlearn and recover ${formatInteger(spCost)} SP plus ${formatInteger(xpCost)} XP. Credits are not refunded.`
        : !accessible
          ? "Learn the novice box first"
          : !prereqsMet
            ? "Prerequisite box not trained"
            : !hasXp
              ? `Needs ${formatInteger(xpCost - xp)} more XP`
              : !hasCredits
                ? `Needs ${formatInteger(creditCost)} credits`
                : !hasSkillPoints
                  ? "Not enough free skill points"
                  : trainer === null
                    ? "Select a trainer"
                    : `Ready to train — ${costLine(node, creditCost)}`;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scp-skill-box";
    btn.dataset.skillBox = node.id;
    btn.dataset.trainer = trainer?.source.id ?? "";
    btn.dataset.action = trained ? "unlearn" : "train";
    btn.dataset.state = boxState;
    btn.style.cssText = gridStyle(node);
    btn.title = skillNodeHoverText(profession, node, reason, trained, creditCost);
    btn.setAttribute(
      "aria-label",
      trained
        ? `${node.label}. ${hasLearnedDependent ? "Unlearn dependent boxes first." : `Unlearn and recover ${spCost} skill points.`}`
        : `${node.label}. ${reason}`,
    );
    btn.disabled = !(canTrain || canUnlearn);

    const top = document.createElement("span");
    top.className = "scp-skill-box-top";
    const label = document.createElement("strong");
    label.textContent = node.label.toUpperCase();
    top.appendChild(label);
    if (boxState === "locked") {
      top.appendChild(glyph(trainer === null && accessible && prereqsMet && hasXp && hasCredits && hasSkillPoints ? "trainer" : "lock"));
    }
    if (boxState === "pending") {
      const spin = document.createElement("span");
      spin.className = "scp-skill-pending";
      spin.setAttribute("aria-hidden", "true");
      spin.textContent = "\u2026";
      top.appendChild(spin);
    }
    btn.appendChild(top);

    const meter = document.createElement("i");
    meter.className = "scp-skill-xp";
    const fill = trained ? 100 : !accessible ? 0 : xpCost <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((xp / xpCost) * 100)));
    meter.style.setProperty("--fill", `${fill}`);
    btn.appendChild(meter);

    const cost = document.createElement("small");
    cost.className = "scp-skill-cost";
    cost.textContent = trained && canUnlearn
      ? `UNLEARN · +${formatInteger(spCost)} SP`
      : trained
        ? "TRAINED"
        : costLine(node, creditCost);
    btn.appendChild(cost);

    return btn;
  };

  return {
    update(): void {
      const actor = playerActor();
      const trainer = selectedTrainer();
      // Settle in-flight purchases whose receipt landed (or whose box the
      // authority now reports trained) BEFORE keying the rebuild.
      settleInFlightSkillActions((skillBoxId) => actorHasSkillBox(actor, skillBoxId));
      const pendingIds = new Set([...inFlightSkillActions.values()].map((action) => action.skillBoxId));
      const key = skillsRenderKey(state, actor, trainer, selectedProfession(), pendingIds);
      if (key !== renderKey) {
        renderKey = key;
        rebuild();
      }
      // Trainer line (persistent, factual) + status flash (transient). The
      // gate is the SELECTED trainer; the nearest one is hover info only.
      const trainerText = trainer
        ? `TRAINER · ${trainer.source.label.toUpperCase()}`
        : "SELECT A TRAINER";
      if (trainerEl.textContent !== trainerText) {
        trainerEl.textContent = trainerText;
        trainerEl.toggleAttribute("data-missing", trainer === null);
      }
      if (trainer === null) {
        const nearest = nearestProfessionTrainer(slice, state);
        const hint = nearest
          ? `Nearest trainer: ${nearest.source.label} (${Math.round(nearest.distanceCells)} cells)`
          : "No trainer in this district";
        if (trainerEl.title !== hint) trainerEl.title = hint;
      } else if (trainerEl.title !== "") {
        trainerEl.title = "";
      }
      // Server reject reasons outrank the generic status line.
      const denied = rejectWatcher.poll();
      const statusText = denied ?? (state.status !== lastStatus ? state.status.toUpperCase() : null);
      if (statusText !== null) {
        lastStatus = state.status;
        statusEl.textContent = statusText;
        statusEl.toggleAttribute("data-flash", true);
        window.clearTimeout(statusFlashTimer);
        statusFlashTimer = window.setTimeout(() => {
          statusEl.toggleAttribute("data-flash", false);
        }, STATUS_FLASH_MS);
      }
    },
    onResized(): void {
      // Grid is fr-based — nothing rect-dependent.
    },
    dispose(): void {
      window.clearTimeout(statusFlashTimer);
      root.remove();
    },
  };
}

function trainedSkillBoxes(profession: ServerAuthorityProfessionState | null): Set<string> {
  // Profession snapshots are also emitted for boxless banked XP. Only the
  // authority's explicit box ledger proves ownership; synthesizing novice
  // from snapshot presence would make an untrained XP track actionable.
  return new Set(profession?.skillBoxes ?? []);
}

function actorHasSkillBox(actor: ServerAuthorityActorState | null, skillBoxId: string): boolean {
  return (actor?.professions ?? []).some((profession) => (
    (profession.skillBoxes ?? []).includes(skillBoxId)
  ));
}


export function skillNodeXp(profession: ServerAuthorityProfessionState | null, node: SkillNodeState): number {
  if (!profession) return 0;
  const professionXp = Math.max(0, Math.trunc(profession.xp ?? 0));
  const track = typeof node.track === "string" ? node.track : "";
  if (track && track !== "novice" && track !== "master") {
    const trackXp = profession.trackXp?.[track];
    if (typeof trackXp === "number" && Number.isFinite(trackXp)) {
      return Math.min(professionXp, Math.max(0, Math.trunc(trackXp)));
    }
    // Authority requires both the general profession pool and the exact track
    // pool. An absent track is zero; falling back to profession XP paints
    // unrelated bars and falsely implies trainable progress.
    return 0;
  }
  return professionXp;
}

function gridStyle(node: SkillNodeState): string {
  if (node.id.endsWith("-master")) return "grid-row:1;grid-column:4 / 6";
  if (node.id.endsWith("-novice")) return "grid-row:6;grid-column:4 / 6";
  const tier = Math.max(1, Math.min(4, node.row ?? 1));
  const row = 6 - tier;
  const column = Math.max(0, Math.min(3, node.column ?? 0)) * 2 + 1;
  return `grid-row:${row};grid-column:${column} / ${column + 2}`;
}

function costLine(node: SkillNodeState, creditCost: number): string {
  return [
    (node.xpCost ?? 0) > 0 ? `${formatInteger(node.xpCost ?? 0)} ${skillNodeXpType(node)}` : "STARTER",
    (node.skillPointCost ?? 0) > 0 ? `${formatInteger(node.skillPointCost ?? 0)} SP` : null,
    creditCost > 0 ? `${formatInteger(creditCost)} CR` : null,
  ].filter(Boolean).join(" · ");
}

function skillNodeXpType(node: SkillNodeState): string {
  const track = typeof node.track === "string" ? node.track : "";
  if (!track || track === "novice" || track === "master") return "PROFESSION XP";
  return `${track.replaceAll("-", " ").toUpperCase()} XP`;
}

export function skillNodeHoverText(
  profession: ServerAuthorityProfessionState | null,
  node: SkillNodeState,
  reason: string,
  trained: boolean,
  creditCost = 0,
): string {
  const xpCost = Math.max(0, Math.trunc(node.xpCost ?? 0));
  const spCost = Math.max(0, Math.trunc(node.skillPointCost ?? 0));
  const xpType = skillNodeXpType(node);
  const usableXp = skillNodeXp(profession, node);
  const lines = [
    `${trained ? "TRAINED" : "STATUS"} · ${reason}`,
    xpCost > 0
      ? `${xpType} · ${formatInteger(usableXp)} usable / ${formatInteger(xpCost)} required`
      : `${xpType} · no XP requirement`,
    `COST · ${costLine(node, creditCost)}`,
  ];
  const track = typeof node.track === "string" ? node.track : "";
  if (profession && track && track !== "novice" && track !== "master") {
    const rawTrackXp = profession.trackXp?.[track];
    lines.push(
      `POOLS · ${formatInteger(profession.xp)} profession / ${formatInteger(
        typeof rawTrackXp === "number" && Number.isFinite(rawTrackXp) ? rawTrackXp : 0,
      )} ${track.replaceAll("-", " ")} (smaller pool is usable)`,
    );
  }
  if (node.description) lines.push(`EFFECT · ${node.description}`);
  if (node.grants.length > 0) lines.push(`BONUSES · ${node.grants.join(" · ")}`);
  if ((node.weaponCertifications?.length ?? 0) > 0) {
    lines.push(`WEAPON CERTS · ${node.weaponCertifications!.join(" · ")}`);
  }
  if ((node.craftingSchematics?.length ?? 0) > 0) {
    lines.push(`CRAFT SCHEMATICS · ${node.craftingSchematics!.join(" · ")}`);
  }
  if ((node.abilities?.length ?? 0) > 0) {
    lines.push(`AUTHORITY UNLOCKS · ${node.abilities!.join(" · ")}`);
  }
  if (trained) {
    lines.push(`UNLEARN · restores ${formatInteger(spCost)} SP and ${formatInteger(xpCost)} ${xpType}`);
  }
  return lines.join("\n");
}

function skillsRenderKey(
  state: PlayState,
  actor: ServerAuthorityActorState | null,
  trainer: ProfessionTrainerCandidate | null,
  professionId: ProfessionId,
  pendingIds: ReadonlySet<string>,
): string {
  return [
    professionId,
    trainer?.source.id ?? "no-trainer",
    actor?.credits ?? 0,
    actor?.skillPointsUsed ?? 0,
    actor?.skillPointsCap ?? 0,
    ...(actor?.professions ?? []).map((profession) => [
      profession.id,
      profession.xp,
      profession.skillPoints,
      Object.entries(profession.trackXp ?? {}).map(([track, xp]) => `${track}:${xp}`).sort().join("."),
      (profession.skillBoxes ?? []).slice().sort().join("."),
    ].join(":")),
    [...pendingIds].sort().join(","),
  ].join("|");
}

function glyph(id: "lock" | "trainer"): HTMLElement {
  const span = document.createElement("span");
  span.className = "scp-skill-glyph";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = UI_ICONS[id];
  return span;
}

function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)).toLocaleString();
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`skills window: missing data-ref="${name}"`);
  return el;
}
