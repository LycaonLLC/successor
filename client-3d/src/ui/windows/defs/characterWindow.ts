import {
  authorityIssuedAtServerTick,
  enqueueAuthoritySetProfessionTitleCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import {
  professionDefinitions,
  skillNodeDefinitions,
} from "@successor/client/src/slice-core/progressionSystem";
import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";

/**
 * CHARACTER — read-only sheet over the authority actor, plus ONE action:
 * the profession-title dropdown (SetProfessionTitle command, title_id = the
 * title-carrying skill-box id from the shared profession contract).
 *
 * Vitals gauges update imperatively every frame (regen ticks constantly);
 * the identity/professions/title/status blocks rebuild only when their
 * render key changes — the same split the status plate uses.
 */
export function createCharacterWindowDefinition(): WindowDefinition {
  return {
    id: "character",
    title: "CHARACTER",
    icon: "character",
    hotkey: "KeyC",
    minWidth: 320,
    minHeight: 360,
    // Compact default (fe-polish §1.13): the sheet is ~5 short sections —
    // the old 0.72·vh default left the lower half dead glass. Strip lives in
    // the y≈118 lane (§1.30 cascade): clear of the left-stack bodies that
    // buried it in the all-open pile.
    boundsRevision: 2,
    defaultBounds: (viewport) => {
      const w = 380;
      const h = Math.min(470, Math.round(viewport.h * 0.56));
      return { x: Math.max(12, Math.round(viewport.w * 0.14)), y: Math.min(118, Math.round(viewport.h * 0.13)), w, h };
    },
    mount: (contentRoot, ctx) => mountCharacterContent(contentRoot, ctx),
  };
}

interface TitleOption {
  id: string;
  label: string;
  professionLabel: string;
}

function mountCharacterContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-character";
  root.innerHTML = `
    <header class="scp-identity">
      <span class="scp-identity-name" data-ref="name">\u2014</span>
      <span class="scp-identity-tag" data-ref="tag" hidden></span>
      <span class="scp-identity-title" data-ref="title" hidden></span>
    </header>
    <section class="scp-section">
      <div class="scp-gauges" data-ref="gauges">
        ${gaugeMarkup("health", "HEALTH")}
        ${gaugeMarkup("action", "ACTION")}
        ${gaugeMarkup("spirit", "SPIRIT")}
      </div>
    </section>
    <section class="scp-section">
      <div class="scp-ledger-grid" data-ref="ledger"></div>
    </section>
    <section class="scp-section">
      <h3 class="scp-section-title">PROFESSIONS</h3>
      <div class="scp-professions" data-ref="professions"></div>
    </section>
    <section class="scp-section">
      <h3 class="scp-section-title" title="Shown after your name on the nameplate">TITLE</h3>
      <select class="scp-select" data-ref="titleSelect" aria-label="Active title"></select>
    </section>
    <section class="scp-section" data-ref="statusSection" hidden>
      <h3 class="scp-section-title">STATUS</h3>
      <div class="scp-chips" data-ref="statuses"></div>
    </section>
  `;
  contentRoot.appendChild(root);

  const nameEl = ref(root, "name");
  const tagEl = ref(root, "tag");
  const titleEl = ref(root, "title");
  const ledgerEl = ref(root, "ledger");
  const professionsEl = ref(root, "professions");
  const titleSelect = ref(root, "titleSelect") as HTMLSelectElement;
  const statusSection = ref(root, "statusSection");
  const statusesEl = ref(root, "statuses");
  const fills = {
    health: root.querySelector<HTMLElement>('[data-ref="fill-health"]')!,
    action: root.querySelector<HTMLElement>('[data-ref="fill-action"]')!,
    spirit: root.querySelector<HTMLElement>('[data-ref="fill-spirit"]')!,
  };
  const values = {
    health: root.querySelector<HTMLElement>('[data-ref="value-health"]')!,
    action: root.querySelector<HTMLElement>('[data-ref="value-action"]')!,
    spirit: root.querySelector<HTMLElement>('[data-ref="value-spirit"]')!,
  };

  const appliedGauges = {
    health: { percent: -1, text: "" },
    action: { percent: -1, text: "" },
    spirit: { percent: -1, text: "" },
  };
  let sheetKey = "";

  titleSelect.addEventListener("change", () => {
    const queued = enqueueAuthoritySetProfessionTitleCommand(
      state.authorityCommands,
      titleSelect.value || null,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (queued) {
      const label = titleSelect.options[titleSelect.selectedIndex]?.textContent?.trim() ?? titleSelect.value;
      state.status = titleSelect.value ? `title ${label}` : "title cleared";
    }
  });

  const playerActor = (): ServerAuthorityActorState | null => {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    return state.serverAuthority.actors[actorId] ?? null;
  };

  const updateGauge = (vital: "health" | "action" | "spirit", value: number, max: number): void => {
    const percent = max > 0 ? Math.round(Math.max(0, Math.min(100, (value / max) * 100))) : 0;
    const gauge = appliedGauges[vital];
    if (gauge.percent !== percent) {
      gauge.percent = percent;
      fills[vital].style.width = `${percent}%`;
      fills[vital].parentElement?.toggleAttribute("data-low", percent <= 25);
    }
    const text = max > 0 ? `${Math.max(0, Math.round(value))}` : "\u2014";
    if (gauge.text !== text) {
      gauge.text = text;
      values[vital].textContent = text;
    }
  };

  const rebuildSheet = (actor: ServerAuthorityActorState | null): void => {
    // Identity
    nameEl.textContent = (actor?.label ?? "\u2014").toUpperCase();
    const tag = actor?.playerOrganizationTag ?? null;
    tagEl.hidden = !tag;
    if (tag) tagEl.textContent = `\u27E8${tag}\u27E9`;
    const activeTitle = actor?.activeTitle ?? null;
    titleEl.hidden = !activeTitle;
    if (activeTitle) titleEl.textContent = activeTitle.label;

    // Ledger: credits + skill points.
    ledgerEl.textContent = "";
    appendLedger(ledgerEl, "CREDITS", formatInteger(actor?.credits ?? 0));
    appendLedger(ledgerEl, "SKILL PTS", `${formatInteger(actor?.skillPointsUsed ?? 0)} / ${formatInteger(actor?.skillPointsCap ?? 250)}`);

    // Professions
    professionsEl.textContent = "";
    const professions = actor?.professions ?? [];
    if (professions.length === 0) {
      const empty = document.createElement("span");
      empty.className = "scp-empty-line";
      empty.textContent = "NONE LEARNED";
      professionsEl.appendChild(empty);
    }
    for (const profession of professions) {
      const row = document.createElement("div");
      row.className = "scp-profession-row";
      row.title = `${formatInteger(profession.xp)} XP · ${formatInteger(profession.skillPoints)} SP spent`;
      const label = document.createElement("span");
      label.className = "scp-profession-name";
      label.textContent = (professionDefinitions[profession.id as keyof typeof professionDefinitions] ?? profession.id).toUpperCase();
      const xp = document.createElement("span");
      xp.className = "scp-profession-xp";
      xp.textContent = `${formatInteger(profession.xp)} XP`;
      row.append(label, xp);
      professionsEl.appendChild(row);
    }

    // Title options — title-carrying skill nodes the actor has trained.
    const options = actor ? availableTitleOptions(actor) : [];
    const activeTitleId = actor?.activeTitle?.id ?? "";
    titleSelect.textContent = "";
    titleSelect.disabled = options.length === 0;
    titleSelect.title = options.length === 0 ? "No learned title boxes" : "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "NO TITLE";
    none.selected = !activeTitleId;
    titleSelect.appendChild(none);
    for (const option of options) {
      const el = document.createElement("option");
      el.value = option.id;
      // C21: many titles already end in the track name ("Novice Marksman" ·
      // Marksman) — only append the track when it adds information.
      el.textContent = option.label.toLowerCase().includes(option.professionLabel.toLowerCase())
        ? option.label
        : `${option.label} · ${option.professionLabel}`;
      el.selected = option.id === activeTitleId;
      titleSelect.appendChild(el);
    }

    // Statuses
    const statuses = actor?.statuses ?? [];
    statusSection.hidden = statuses.length === 0;
    statusesEl.textContent = "";
    for (const status of statuses) {
      const chip = document.createElement("span");
      chip.className = "scp-chip";
      chip.textContent = status.label.toUpperCase();
      statusesEl.appendChild(chip);
    }
  };

  return {
    update(): void {
      const actor = playerActor();
      if (actor) {
        updateGauge("health", actor.vitals.health, actor.maxVitals.health);
        updateGauge("action", actor.vitals.action, actor.maxVitals.action);
        updateGauge("spirit", actor.vitals.spirit, actor.maxVitals.spirit);
      } else {
        updateGauge("health", 0, 0);
        updateGauge("action", 0, 0);
        updateGauge("spirit", 0, 0);
      }
      const key = sheetRenderKey(state, actor);
      if (key !== sheetKey) {
        sheetKey = key;
        rebuildSheet(actor);
      }
    },
    onResized(): void {
      // Static layout — nothing rect-dependent.
    },
    dispose(): void {
      root.remove();
    },
  };
}

function availableTitleOptions(actor: ServerAuthorityActorState): TitleOption[] {
  const learned = new Set<string>();
  for (const profession of actor.professions ?? []) {
    for (const skillBoxId of profession.skillBoxes ?? []) {
      if (skillBoxId) learned.add(skillBoxId);
    }
  }
  const options: TitleOption[] = skillNodeDefinitions
    .filter((node) => typeof node.title === "string" && node.title.length > 0 && learned.has(node.id))
    .map((node) => ({
      id: node.id,
      label: node.title ?? node.label,
      professionLabel: professionDefinitions[node.profession] ?? node.profession,
    }));
  const activeTitle = actor.activeTitle;
  if (activeTitle && learned.has(activeTitle.skillBoxId) && !options.some((option) => option.id === activeTitle.id)) {
    options.push({
      id: activeTitle.id,
      label: activeTitle.label,
      professionLabel: professionDefinitions[
        skillNodeDefinitions.find((node) => node.id === activeTitle.skillBoxId)?.profession ?? "marksman"
      ],
    });
  }
  return options;
}

function sheetRenderKey(state: PlayState, actor: ServerAuthorityActorState | null): string {
  return [
    actor?.label ?? "",
    actor?.playerOrganizationTag ?? "",
    actor?.activeTitle?.id ?? "",
    actor?.activeTitle?.label ?? "",
    actor?.credits ?? 0,
    actor?.skillPointsUsed ?? 0,
    actor?.skillPointsCap ?? 0,
    (actor?.statuses ?? []).map((status) => status.label).join(","),
    ...(actor?.professions ?? []).map((profession) => (
      `${profession.id}:${profession.xp}:${profession.skillPoints}:${(profession.skillBoxes ?? []).length}`
    )),
    state.serverAuthority.connected ? "on" : "off",
  ].join("|");
}

function gaugeMarkup(vital: string, label: string): string {
  return `
    <div class="successor3d-gauge" data-vital="${vital}">
      <span class="successor3d-gauge-label">${label}</span>
      <div class="successor3d-gauge-track">
        <div class="successor3d-gauge-fill" data-ref="fill-${vital}"></div>
      </div>
      <span class="successor3d-gauge-value" data-ref="value-${vital}">\u2014</span>
    </div>
  `;
}

function appendLedger(parent: HTMLElement, label: string, value: string): void {
  const labelEl = document.createElement("span");
  labelEl.className = "scp-ledger-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("b");
  valueEl.className = "scp-ledger-value";
  valueEl.textContent = value;
  parent.append(labelEl, valueEl);
}

function formatInteger(value: number): string {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)).toLocaleString();
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`character window: missing data-ref="${name}"`);
  return el;
}
