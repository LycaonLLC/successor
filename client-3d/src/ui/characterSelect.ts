import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { runtimeBackendHttpBase } from "@successor/client/src/runtime/runtimeDefaults";
import { createLegacyCharacterSelectDataPort, type CharacterSelectDataPort } from "./characterSelectDataPort";
import { applyThemeVariables } from "./theme";
import { mountCharDollPreview, type CharDollAppearance, type CharDollFace, type CharDollPreview, type CharDollWornPiece } from "./charDollPreview";
import { readCachedCharacterAppearance } from "./appearanceCache";
import { characterSlotUiState, maxCharactersFromResponse, type CharacterSlotLimit } from "./characterSelectSlots";
import { filterCharacterNameInput, isValidCharacterName } from "./characterNameInput";
import {
  HAIR_COLORS as WARDROBE_HAIR_COLORS,
  HAIR_STYLES,
  wardrobePieceById,
} from "../assets/wardrobe.gen";
import {
  DEFAULT_FACE,
  FACE_BROW_COLORS,
  FACE_EYE_COLORS,
  FACE_LIP_COLORS,
  FACE_STYLE_IDS,
  FACE_STYLE_LABELS,
  type FaceStyleId,
} from "../assets/face.gen";

/**
 * CHARACTER SELECT / CREATE — the pre-world screen (owner spec 2026-07-06;
 * fixed-issue outfit cutover 2026-07-18).
 *
 * Desktop launch lands here: account roster with LD/online tags, live server
 * status, a 3D paper doll of the selected character, ENTER WORLD, and the
 * creator (name + initial profession + skin tone + hair style/color).
 * Clothing is NOT a creation choice: every recruit ships in the fixed
 * registry outfit (sky-blue bodysuit + canvas ankle boots) — the server owns
 * that loadout and the creator only previews it. Talks to the CharacterLane
 * HTTP API; the shard stays scratch — characters live in the server-side
 * store. `autoEnter=1` launches never reach this screen (labs).
 */

export interface CharacterWornPiece {
  item: string;
  colors: string[];
}

export interface CharacterApiRecord {
  id: string;
  /** Legacy roster responses include this; hosted creator state must omit it. */
  ownerRef?: string;
  name: string;
  appearance: CharDollAppearance;
  worn?: CharacterWornPiece[];
  position: { areaId: string; x: number; y: number; facing: string } | null;
  lastLogoutAt: string | null;
  lastSeenAt: string | null;
  totalPlayMs: number;
  liveState: "offline" | "online" | "linkdead";
  initialProfessionId: InitialProfessionId | null;
  worldEntryClaimed: boolean;
}

export interface CharactersResponse {
  server: { online: boolean; tick?: number; sessionCount?: number; actorCount?: number; shardId?: string };
  characters: CharacterApiRecord[];
  selectedCharacterId?: string;
  limits?: { maxCharacters?: number };
}

export interface CharacterEnterJoin {
  player: string;
  actorId: string;
  name: string;
  spawnArea: string;
  spawnX: number;
  spawnY: number;
  facing: string;
  appearance: CharDollAppearance;
  worn?: CharacterWornPiece[];
  /** Per-character record kinds (successor.macros.v1, …) — join-payload sync. */
  recordKinds?: Record<string, { version: number; items: unknown[] }>;
}

export interface CharacterSelectResult {
  character: CharacterApiRecord;
  /** Legacy selection includes a server-issued join; hosted selection does not. */
  join?: CharacterEnterJoin;
}
// Name shape/filter live in characterNameInput.ts (server registry mirror).
const POLL_MS = 5_000;
const SKIN_TONES = ["#e8c39a", "#d1a679", "#b98a5e", "#96684a", "#6f4a33", "#4a3223"] as const;

type InitialProfessionId = "marksman" | "scout" | "craftsman" | "medic" | "brawler";
const INITIAL_PROFESSIONS: readonly {
  id: InitialProfessionId;
  label: string;
  purpose: string;
  kit: string;
}[] = [
  { id: "marksman", label: "MARKSMAN", purpose: "Ranged combat", kit: "Slugthrower + iron slugs" },
  { id: "scout", label: "SCOUT", purpose: "Harvesting and fieldcraft", kit: "Scout processing kit" },
  { id: "craftsman", label: "CRAFTSMAN", purpose: "Surveying and fabrication", kit: "Multitool + mineral survey tool" },
  { id: "medic", label: "MEDIC", purpose: "Treatment and medicine", kit: "Multitool + field bandages" },
  { id: "brawler", label: "BRAWLER", purpose: "Close combat", kit: "Scrapline machete" },
] as const;

/** Hair styles: SHAVED + every manifest hair (legacy 3 + the ratified 24). */
const HAIR_STYLE_OPTIONS: readonly { id: string | null; label: string }[] = [
  { id: null, label: "SHAVED" },
  ...HAIR_STYLES.map((style) => ({ id: style.id, label: style.name.toUpperCase() })),
];

const HAIR_COLOR_OPTIONS: readonly { id: string; hex: string }[] =
  WARDROBE_HAIR_COLORS.map((color) => ({ id: color.id, hex: color.hex }));

/** Fixed-issue outfit, previewed from the generated wardrobe registry so the
 * creator doll wears exactly what the server files: sky-blue bodysuit
 * (#89cff0) + canvas ankle boots (item 7319). Never part of the creation
 * payload — the server owns the loadout. */
const FIXED_STARTER_ITEM_IDS = ["under_bodysuit", "boots_canvas_ankle"] as const;
const FIXED_STARTER_WORN: readonly CharacterWornPiece[] = FIXED_STARTER_ITEM_IDS.flatMap((id) => {
  const piece = wardrobePieceById(id);
  return piece ? [{ item: piece.id, colors: piece.zones.map((zone) => zone.default) }] : [];
});

/** Blank canonical draft: SHAVED. Create mode must never look like the
 * selected character (owner report 2026-07-11 — a roster pawn could visually
 * masquerade as the "new" draft when defaults matched its appearance).
 * hairMat stays preset so picking any style lands on a sane color. */
const DEFAULT_APPEARANCE: CharDollAppearance = {
  body: "male",
  skinTone: SKIN_TONES[1],
  hair: null,
  hairMat: "hair_umber",
  face: DEFAULT_FACE,
};

/** Face features cycled by the creator steppers, in panel order. */
const FACE_FEATURES = ["eyes", "brows", "nose", "mouth"] as const;
type FaceFeature = typeof FACE_FEATURES[number];
const FACE_FEATURE_TITLES: Record<FaceFeature, string> = {
  eyes: "EYES",
  brows: "BROWS",
  nose: "NOSE",
  mouth: "MOUTH",
};

function blankCreatorDraft(): CharDollAppearance {
  return { ...DEFAULT_APPEARANCE, face: { ...DEFAULT_FACE } };
}

interface SelectProbe {
  mode: "select" | "create";
  serverOnline: boolean;
  characterCount: number;
  selectedId: string | null;
  draftName: string;
  /** Fixed-issue preview worn set (registry-resolved) — verification bridge. */
  fixedWorn: readonly CharacterWornPiece[];
  draftHair: string | null;
  draftFace: CharDollFace | null;
  draftInitialProfessionId: InitialProfessionId | null;
  lastError: string | null;
}

declare global {
  interface Window {
    /** Verification bridge for human-emulated flows. */
    __successor3dCharacterSelect?: SelectProbe;
  }
}

export function renderCharacterSelect(root: HTMLElement, injectedPort?: CharacterSelectDataPort): Promise<CharacterSelectResult> {
  applyThemeVariables();
  const params = new URLSearchParams(window.location.search);
  const apiBase = runtimeBackendHttpBase({ gameWsUrl: getLaunchIdentity().gameWsUrl, searchParams: params });
  const dataPort = injectedPort ?? createLegacyCharacterSelectDataPort(apiBase);

  root.innerHTML = `
    <main class="successor3d-shell sc3d-charselect" data-state="entry" data-mode="select">
      <div class="sc3d-cs-backdrop"></div>

      <section class="sc3d-cs-win sc3d-cs-roster" aria-label="Characters">
        <header class="sc3d-cs-title"><span>SUCCESSOR</span><em data-ref="slots">— / —</em></header>
        <div class="sc3d-cs-list" data-ref="list" role="listbox" aria-label="Character roster"></div>
        <button type="button" class="sc3d-cs-newbtn" data-ref="newButton">+ NEW CHARACTER</button>
      </section>

      <section class="sc3d-cs-doll" aria-label="Character preview">
        <div class="sc3d-cs-dollhost" data-ref="dollHost"></div>
        <p class="sc3d-cs-dollname" data-ref="dollName"></p>
      </section>

      <section class="sc3d-cs-win sc3d-cs-side" aria-label="Server">
        <div data-ref="sidePanels">
          <div data-panel="select">
            <header class="sc3d-cs-title"><span>FIELD OFFICE</span><em data-ref="serverTag">…</em></header>
            <dl class="sc3d-cs-status">
              <div><dt>IN FIELD</dt><dd data-ref="rosterLine">—</dd></div>
              <div><dt>SESSIONS</dt><dd data-ref="sessionsLine">—</dd></div>
            </dl>
            <div class="sc3d-cs-summary" data-ref="summary"></div>
            <div class="sc3d-cs-profresolve" data-ref="professionResolve" hidden>
              <p>THIS LEGACY RECORD NEEDS ONE NORMAL NOVICE ALLOCATION BEFORE DEPLOYMENT.</p>
              <div class="sc3d-cs-profgrid" data-ref="resolveProfessionGrid"></div>
              <button type="button" class="sc3d-cs-profconfirm" data-ref="resolveProfessionButton" disabled>CONFIRM ALLOCATION</button>
            </div>
            <button type="button" class="sc3d-cs-enter" data-ref="enterButton" disabled>ENTER WORLD</button>
            <button type="button" class="sc3d-cs-delete" data-ref="deleteButton" disabled>DELETE CHARACTER</button>
            <p class="sc3d-cs-note" data-ref="note" role="status"></p>
          </div>
          <div data-panel="create" hidden>
            <header class="sc3d-cs-title"><span>NEW CHARACTER</span><em>REGISTRY FORM</em></header>
            <div class="sc3d-cs-create-scroll" data-ref="createScroll">
              <label class="sc3d-cs-field">
                <span>NAME</span>
                <input data-ref="nameInput" type="text" maxlength="16" spellcheck="false" autocomplete="off" placeholder="Marlow or Mara-Lyn" />
              </label>
              <p class="sc3d-cs-fieldnote" data-ref="nameNote">3–16 letters · single hyphens between names · no spaces or numbers</p>
              <div class="sc3d-cs-secthead"><b>INITIAL PROFESSION</b><span>16 SKILL POINTS</span></div>
              <p class="sc3d-cs-fieldnote">A normal novice allocation. Skill points only — no gear comes with it. You can unlearn it later.</p>
              <div class="sc3d-cs-profgrid" data-ref="createProfessionGrid"></div>
              <div class="sc3d-cs-secthead"><b>BODY</b><span>2 TYPES</span></div>
              <div class="sc3d-cs-stepper" data-ref="bodyStepper" aria-label="Body type"></div>
              <div class="sc3d-cs-secthead"><b>SKIN</b></div>
              <div class="sc3d-cs-swatchrow" data-ref="skinRow" aria-label="Skin tone"></div>
              <div class="sc3d-cs-secthead"><b>HAIR</b><span data-ref="hairCount"></span></div>
              <div class="sc3d-cs-stepper" data-ref="hairStepper" aria-label="Hair style"></div>
              <div class="sc3d-cs-swatchrow" data-mini data-ref="hairColorRow" aria-label="Hair color"></div>
              <div class="sc3d-cs-secthead"><b>FACE</b><span>4,096 BASE COMBOS</span></div>
              <div class="sc3d-cs-stepper" data-ref="faceEyesStepper" aria-label="Eye style"></div>
              <div class="sc3d-cs-stepper" data-ref="faceBrowsStepper" aria-label="Brow style"></div>
              <div class="sc3d-cs-stepper" data-ref="faceNoseStepper" aria-label="Nose style"></div>
              <div class="sc3d-cs-stepper" data-ref="faceMouthStepper" aria-label="Mouth style"></div>
              <div class="sc3d-cs-secthead"><b>EYE COLOR</b></div>
              <div class="sc3d-cs-swatchrow" data-mini data-ref="faceEyeColorRow" aria-label="Eye color"></div>
              <div class="sc3d-cs-secthead"><b>BROW COLOR</b></div>
              <div class="sc3d-cs-swatchrow" data-mini data-ref="faceBrowColorRow" aria-label="Brow color"></div>
              <div class="sc3d-cs-secthead"><b>LIP COLOR</b></div>
              <div class="sc3d-cs-swatchrow" data-mini data-ref="faceLipColorRow" aria-label="Lip color"></div>
              <div class="sc3d-cs-chiprow"><button type="button" class="sc3d-cs-chip" data-ref="faceRandomize">RANDOMIZE FACE</button></div>
              <div class="sc3d-cs-secthead"><b>STANDARD ISSUE</b></div>
              <p class="sc3d-cs-fieldnote">Every recruit ships in the registry bodysuit and canvas ankle boots — shown on the doll. Field gear replaces them.</p>
            </div>
            <div class="sc3d-cs-createactions">
              <button type="button" class="sc3d-cs-enter" data-ref="createButton" disabled>CREATE</button>
              <button type="button" class="sc3d-cs-cancel" data-ref="cancelButton">CANCEL</button>
            </div>
            <p class="sc3d-cs-note" data-ref="createNote" role="status"></p>
          </div>
        </div>
      </section>
    </main>
  `;

  const shell = required<HTMLElement>(root, ".sc3d-charselect");
  const refs = {
    slots: required<HTMLElement>(root, '[data-ref="slots"]'),
    list: required<HTMLElement>(root, '[data-ref="list"]'),
    newButton: required<HTMLButtonElement>(root, '[data-ref="newButton"]'),
    dollHost: required<HTMLElement>(root, '[data-ref="dollHost"]'),
    dollName: required<HTMLElement>(root, '[data-ref="dollName"]'),
    serverTag: required<HTMLElement>(root, '[data-ref="serverTag"]'),
    rosterLine: required<HTMLElement>(root, '[data-ref="rosterLine"]'),
    sessionsLine: required<HTMLElement>(root, '[data-ref="sessionsLine"]'),
    summary: required<HTMLElement>(root, '[data-ref="summary"]'),
    professionResolve: required<HTMLElement>(root, '[data-ref="professionResolve"]'),
    resolveProfessionGrid: required<HTMLElement>(root, '[data-ref="resolveProfessionGrid"]'),
    resolveProfessionButton: required<HTMLButtonElement>(root, '[data-ref="resolveProfessionButton"]'),
    enterButton: required<HTMLButtonElement>(root, '[data-ref="enterButton"]'),
    note: required<HTMLElement>(root, '[data-ref="note"]'),
    nameInput: required<HTMLInputElement>(root, '[data-ref="nameInput"]'),
    nameNote: required<HTMLElement>(root, '[data-ref="nameNote"]'),
    createProfessionGrid: required<HTMLElement>(root, '[data-ref="createProfessionGrid"]'),
    bodyStepper: required<HTMLElement>(root, '[data-ref="bodyStepper"]'),
    skinRow: required<HTMLElement>(root, '[data-ref="skinRow"]'),
    hairCount: required<HTMLElement>(root, '[data-ref="hairCount"]'),
    hairStepper: required<HTMLElement>(root, '[data-ref="hairStepper"]'),
    hairColorRow: required<HTMLElement>(root, '[data-ref="hairColorRow"]'),
    faceEyesStepper: required<HTMLElement>(root, '[data-ref="faceEyesStepper"]'),
    faceBrowsStepper: required<HTMLElement>(root, '[data-ref="faceBrowsStepper"]'),
    faceNoseStepper: required<HTMLElement>(root, '[data-ref="faceNoseStepper"]'),
    faceMouthStepper: required<HTMLElement>(root, '[data-ref="faceMouthStepper"]'),
    faceEyeColorRow: required<HTMLElement>(root, '[data-ref="faceEyeColorRow"]'),
    faceBrowColorRow: required<HTMLElement>(root, '[data-ref="faceBrowColorRow"]'),
    faceLipColorRow: required<HTMLElement>(root, '[data-ref="faceLipColorRow"]'),
    faceRandomize: required<HTMLButtonElement>(root, '[data-ref="faceRandomize"]'),
    deleteButton: required<HTMLButtonElement>(root, '[data-ref="deleteButton"]'),
    createButton: required<HTMLButtonElement>(root, '[data-ref="createButton"]'),
    cancelButton: required<HTMLButtonElement>(root, '[data-ref="cancelButton"]'),
    createNote: required<HTMLElement>(root, '[data-ref="createNote"]'),
    panels: root.querySelectorAll<HTMLElement>("[data-panel]"),
  };

  let mode: "select" | "create" = "select";
  let serverOnline = false;
  let characters: CharacterApiRecord[] = [];
  let maxCharacters: CharacterSlotLimit = null;
  let selectedId: string | null = null;
  let draft: CharDollAppearance = blankCreatorDraft();
  let draftInitialProfessionId: InitialProfessionId | null = null;
  let doll: CharDollPreview | null = null;
  let entering = false;
  let deleteArmed = false;
  let deleting = false;
  let creating = false;
  let resolvingInitialProfession = false;
  let resolveProfessionCharacterId: string | null = null;
  let resolveProfessionDraft: InitialProfessionId | null = null;
  let lastError: string | null = null;

  void mountCharDollPreview(refs.dollHost).then((mounted) => {
    doll = mounted;
    syncDoll();
  }).catch((error: unknown) => {
    console.error("character select: doll preview failed", error);
    refs.dollHost.textContent = "PREVIEW OFFLINE";
  });

  const probe = (): void => {
    window.__successor3dCharacterSelect = {
      mode,
      serverOnline,
      characterCount: characters.length,
      selectedId,
      draftName: refs.nameInput.value,
      fixedWorn: FIXED_STARTER_WORN,
      draftHair: draft.hair,
      draftFace: draft.face ? { ...draft.face } : null,
      draftInitialProfessionId,
      lastError,
    };
  };

  const selected = (): CharacterApiRecord | null => characters.find((record) => record.id === selectedId) ?? null;

  const dollWornFor = (record: CharacterApiRecord, cachedWorn: readonly CharDollWornPiece[] | undefined): readonly CharDollWornPiece[] =>
    (cachedWorn && cachedWorn.length > 0 ? cachedWorn : record.worn ?? []);

  const syncDoll = (): void => {
    const record = selected();
    if (doll) {
      if (mode === "create") {
        doll.setAppearance({ ...draft, worn: FIXED_STARTER_WORN });
      } else if (record) {
        const cached = readCachedCharacterAppearance(record.id);
        const base = cached ?? record.appearance;
        doll.setAppearance({ ...base, worn: dollWornFor(record, cached?.worn) });
      }
    }
    refs.dollName.textContent = mode === "create"
      ? (refs.nameInput.value || "—").toUpperCase()
      : (selected()?.name ?? "").toUpperCase();
    // Every draft mutation routes through here — keep the verification probe
    // current (picker clicks previously left __successor3dCharacterSelect stale).
    probe();
  };

  const liveTag = (record: CharacterApiRecord): string =>
    record.liveState === "linkdead" ? " (LD)" : record.liveState === "online" ? " · ONLINE" : "";

  const initialProfessionLabel = (id: InitialProfessionId | null): string =>
    INITIAL_PROFESSIONS.find((profession) => profession.id === id)?.label ?? "REQUIRED";

  const renderProfessionChoices = (
    host: HTMLElement,
    active: InitialProfessionId | null,
    onPick: (id: InitialProfessionId) => void,
  ): void => {
    host.textContent = "";
    for (const profession of INITIAL_PROFESSIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sc3d-cs-profcard";
      button.dataset.professionId = profession.id;
      button.toggleAttribute("data-active", profession.id === active);
      button.setAttribute("aria-pressed", String(profession.id === active));
      button.innerHTML = `<b>${profession.label}</b><span>${profession.purpose}</span><small>${profession.kit}</small>`;
      button.addEventListener("click", () => onPick(profession.id));
      host.appendChild(button);
    }
  };

  const renderCreateProfessionChoices = (): void => {
    renderProfessionChoices(refs.createProfessionGrid, draftInitialProfessionId, (professionId) => {
      draftInitialProfessionId = professionId;
      refs.createButton.disabled = creating || draftInitialProfessionId === null;
      renderCreateProfessionChoices();
      probe();
    });
  };

  const renderList = (): void => {
    const slotUi = characterSlotUiState(characters.length, maxCharacters);
    refs.slots.textContent = slotUi.slotsText;
    refs.list.textContent = "";
    for (const record of characters) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "sc3d-cs-row";
      row.dataset.characterId = record.id;
      row.setAttribute("role", "option");
      row.toggleAttribute("data-active", record.id === selectedId);
      row.toggleAttribute("data-linkdead", record.liveState === "linkdead");
      const seen = record.lastLogoutAt ? relativeTime(record.lastLogoutAt) : "NEW RECRUIT";
      const where = record.position ? record.position.areaId.replace(/-/gu, " ").toUpperCase() : "UNDEPLOYED";
      row.innerHTML = `
        <strong>${escapeHtml(record.name)}${liveTag(record)}</strong>
        <small>${escapeHtml(where)} · ${escapeHtml(seen)}</small>
      `;
      refs.list.appendChild(row);
    }
    refs.newButton.disabled = slotUi.newCharacterDisabled;
    refs.newButton.textContent = slotUi.newCharacterLabel;
  };

  const renderSummary = (): void => {
    const record = selected();
    refs.summary.textContent = "";
    if (!record) {
      refs.enterButton.disabled = true;
      refs.deleteButton.disabled = true;
      refs.deleteButton.hidden = dataPort.hosted;
      refs.professionResolve.hidden = dataPort.hosted;
      refs.deleteButton.textContent = "DELETE CHARACTER";
      refs.professionResolve.hidden = true;
      return;
    }
    const lines: Array<[string, string]> = [
      ["OPERATIVE", record.name.toUpperCase()],
      ["INITIAL ALLOCATION", initialProfessionLabel(record.initialProfessionId)],
      ["LAST POSITION", record.position ? `${record.position.areaId.replace(/-/gu, " ").toUpperCase()} · ${Math.round(record.position.x)},${Math.round(record.position.y)}` : "DEFAULT DEPLOYMENT"],
      ["FIELD TIME", playTime(record.totalPlayMs)],
    ];
    for (const [k, v] of lines) {
      const div = document.createElement("div");
      div.className = "sc3d-cs-sumline";
      div.innerHTML = `<span>${k}</span><b>${escapeHtml(v)}</b>`;
      refs.summary.appendChild(div);
    }
    const initialProfessionRequired = !record.worldEntryClaimed && record.initialProfessionId === null;
    if (resolveProfessionCharacterId !== record.id) {
      resolveProfessionCharacterId = record.id;
      resolveProfessionDraft = null;
    }
    refs.professionResolve.hidden = dataPort.hosted || !initialProfessionRequired;
    refs.deleteButton.hidden = dataPort.hosted;
    if (initialProfessionRequired && !dataPort.hosted) {
      renderProfessionChoices(refs.resolveProfessionGrid, resolveProfessionDraft, (professionId) => {
        resolveProfessionDraft = professionId;
        renderSummary();
        probe();
      });
      refs.resolveProfessionButton.disabled = resolveProfessionDraft === null || resolvingInitialProfession;
    }
    refs.enterButton.disabled = !serverOnline || entering || initialProfessionRequired;
    refs.enterButton.textContent = record.liveState === "linkdead" ? "RECONNECT (LD)" : "ENTER WORLD";
    // DELETE: offline records only (a live/LD actor still owns the world
    // slot); two-step armed confirm — the second press is the irreversible one.
    const deletable = record.liveState === "offline" && serverOnline && !deleting;
    refs.deleteButton.disabled = !deletable;
    refs.deleteButton.toggleAttribute("data-armed", deleteArmed && deletable);
    refs.deleteButton.textContent = record.liveState !== "offline"
      ? "IN THE FIELD — NO DELETE"
      : deleteArmed
        ? "CONFIRM · NOTHING RETURNS"
        : "DELETE CHARACTER";
  };

  const setMode = (next: "select" | "create"): void => {
    mode = next;
    deleteArmed = false;
    shell.dataset.mode = next;
    for (const panel of refs.panels) panel.hidden = panel.dataset.panel !== next;
    if (next === "create") {
      refs.nameInput.value = "";
      refs.createNote.textContent = "";
      draft = blankCreatorDraft();
      draftInitialProfessionId = null;
      renderCreatorRows();
      renderCreateProfessionChoices();
      refs.createButton.disabled = true;
    }
    syncDoll();
    probe();
  };

  const swatchButton = (hex: string, title: string, active: boolean, onPick: () => void): HTMLButtonElement => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "sc3d-cs-swatch";
    swatch.style.background = hex;
    swatch.title = title;
    swatch.toggleAttribute("data-active", active);
    swatch.addEventListener("click", onPick);
    return swatch;
  };

  const stepper = (
    host: HTMLElement,
    label: string,
    onStep: (delta: number) => void,
  ): void => {
    host.textContent = "";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "sc3d-cs-stepbtn";
    back.textContent = "◀";
    back.addEventListener("click", () => onStep(-1));
    const name = document.createElement("span");
    name.className = "sc3d-cs-stepname";
    name.textContent = label;
    const forward = document.createElement("button");
    forward.type = "button";
    forward.className = "sc3d-cs-stepbtn";
    forward.textContent = "▶";
    forward.addEventListener("click", () => onStep(1));
    host.append(back, name, forward);
  };

  const renderCreatorRows = (): void => {
    const body = draft.body ?? "male";
    stepper(refs.bodyStepper, body === "female" ? "BODY TYPE 2" : "BODY TYPE 1", () => {
      draft.body = body === "female" ? "male" : "female";
      renderCreatorRows();
      syncDoll();
    });

    refs.skinRow.textContent = "";
    for (const tone of SKIN_TONES) {
      refs.skinRow.appendChild(swatchButton(tone, tone, draft.skinTone === tone, () => {
        draft.skinTone = tone;
        renderCreatorRows();
        syncDoll();
      }));
    }

    // HAIR — style stepper (SHAVED + 27 manifest styles) + color swatches.
    const hairIndex = Math.max(0, HAIR_STYLE_OPTIONS.findIndex((option) => option.id === draft.hair));
    refs.hairCount.textContent = `${hairIndex + 1}/${HAIR_STYLE_OPTIONS.length}`;
    stepper(refs.hairStepper, HAIR_STYLE_OPTIONS[hairIndex]!.label, (delta) => {
      const next = (hairIndex + delta + HAIR_STYLE_OPTIONS.length) % HAIR_STYLE_OPTIONS.length;
      draft.hair = HAIR_STYLE_OPTIONS[next]!.id;
      renderCreatorRows();
      syncDoll();
    });
    refs.hairColorRow.textContent = "";
    for (const color of HAIR_COLOR_OPTIONS) {
      const swatch = swatchButton(color.hex, color.id, draft.hairMat === color.id, () => {
        if (draft.hair === null) return;
        draft.hairMat = color.id;
        renderCreatorRows();
        syncDoll();
      });
      swatch.toggleAttribute("data-disabled", draft.hair === null);
      refs.hairColorRow.appendChild(swatch);
    }

    // FACE — four style steppers + eye/brow/lip palettes (face.gen registry;
    // the server validates the same generated ids, so drift is impossible).
    const face = draft.face ?? (draft.face = { ...DEFAULT_FACE });
    const featureSteppers: Record<FaceFeature, HTMLElement> = {
      eyes: refs.faceEyesStepper,
      brows: refs.faceBrowsStepper,
      nose: refs.faceNoseStepper,
      mouth: refs.faceMouthStepper,
    };
    for (const feature of FACE_FEATURES) {
      const styleIndex = Math.max(0, FACE_STYLE_IDS.indexOf(face[feature] as FaceStyleId));
      const label = `${FACE_FEATURE_TITLES[feature]} · ${FACE_STYLE_LABELS[FACE_STYLE_IDS[styleIndex]!].toUpperCase()} (${styleIndex + 1}/${FACE_STYLE_IDS.length})`;
      stepper(featureSteppers[feature], label, (delta) => {
        const next = (styleIndex + delta + FACE_STYLE_IDS.length) % FACE_STYLE_IDS.length;
        face[feature] = FACE_STYLE_IDS[next]!;
        renderCreatorRows();
        syncDoll();
      });
    }
    const facePalettes: readonly { host: HTMLElement; colors: readonly string[]; key: "eyeColor" | "browColor" | "lipColor" }[] = [
      { host: refs.faceEyeColorRow, colors: FACE_EYE_COLORS, key: "eyeColor" },
      { host: refs.faceBrowColorRow, colors: FACE_BROW_COLORS, key: "browColor" },
      { host: refs.faceLipColorRow, colors: FACE_LIP_COLORS, key: "lipColor" },
    ];
    for (const palette of facePalettes) {
      palette.host.textContent = "";
      for (const hex of palette.colors) {
        palette.host.appendChild(swatchButton(hex, hex, face[palette.key] === hex, () => {
          face[palette.key] = hex;
          renderCreatorRows();
          syncDoll();
        }));
      }
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      const data = await dataPort.list();
      serverOnline = data.server.online !== false;
      characters = data.characters;
      maxCharacters = maxCharactersFromResponse(data);
      if (!selectedId || !characters.some((record) => record.id === selectedId)) {
        selectedId = data.selectedCharacterId ?? characters[0]?.id ?? null;
      }
      refs.serverTag.textContent = "LIVE";
      refs.serverTag.toggleAttribute("data-offline", false);
      // C16: the raw shard id is operator vocabulary — LIVE/UNREACHABLE plus
      // the live counts say everything a player can use. IN FIELD counts live
      // actors (matches the status plate line); the roster list counts itself.
      refs.rosterLine.textContent = String(data.server.actorCount ?? "—");
      refs.sessionsLine.textContent = String(data.server.sessionCount ?? "—");
      lastError = null;
    } catch {
      serverOnline = false;
      refs.serverTag.textContent = "UNREACHABLE";
      refs.serverTag.toggleAttribute("data-offline", true);
      lastError = "server_unreachable";
    }
    renderList();
    renderSummary();
    syncDoll();
    probe();
  };

  return new Promise<CharacterSelectResult>((resolve) => {
    let pollTimer = 0;

    const finish = (result: CharacterSelectResult): void => {
      window.clearInterval(pollTimer);
      doll?.dispose();
      resolve(result);
    };

    refs.list.addEventListener("click", (event) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".sc3d-cs-row") : null;
      if (!row?.dataset.characterId) return;
      selectedId = row.dataset.characterId;
      deleteArmed = false;
      renderList();
      renderSummary();
      syncDoll();
      probe();
    });

    refs.newButton.addEventListener("click", () => setMode("create"));
    refs.cancelButton.addEventListener("click", () => setMode("select"));

    refs.faceRandomize.addEventListener("click", () => {
      const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;
      draft.face = {
        eyes: pick(FACE_STYLE_IDS),
        brows: pick(FACE_STYLE_IDS),
        nose: pick(FACE_STYLE_IDS),
        mouth: pick(FACE_STYLE_IDS),
        eyeColor: pick(FACE_EYE_COLORS),
        browColor: pick(FACE_BROW_COLORS),
        lipColor: pick(FACE_LIP_COLORS),
      };
      renderCreatorRows();
      syncDoll();
    });

    refs.nameInput.addEventListener("input", () => {
      const normalized = filterCharacterNameInput(refs.nameInput.value);
      if (refs.nameInput.value !== normalized) refs.nameInput.value = normalized;
      refs.nameNote.toggleAttribute("data-bad", refs.nameInput.value.length > 0 && !isValidCharacterName(refs.nameInput.value));
      syncDoll();
      probe();
    });

    refs.createButton.addEventListener("click", () => {
      void (async () => {
        const name = refs.nameInput.value;
        if (!isValidCharacterName(name)) {
          refs.createNote.textContent = "NAME MUST BE 3–16 LETTERS · HYPHENS ONLY BETWEEN NAMES";
          return;
        }
        if (!draftInitialProfessionId) {
          refs.createNote.textContent = "CHOOSE ONE INITIAL PROFESSION";
          return;
        }
        creating = true;
        refs.createButton.disabled = true;
        refs.createNote.textContent = "FILING…";
        try {
          const outcome = await dataPort.create({ name, appearance: draft, initialProfessionId: draftInitialProfessionId });
          if (outcome.ok) {
            await refresh();
            const record = outcome.record ?? selected();
            if (record) {
              selectedId = record.id;
              setMode("select");
              renderList();
              renderSummary();
              refs.note.textContent = `${record.name.toUpperCase()} REGISTERED`;
            } else {
              refs.createNote.textContent = "REGISTRY REFUSED THE FORM";
              lastError = "create_failed";
            }
          } else {
            const error = outcome.error;
            refs.createNote.textContent = error === "name_taken" ? "NAME ALREADY TAKEN"
              : error === "slots_full" ? "ALL SLOTS FULL"
              : error === "invalid_initial_profession" ? "CHOOSE ONE INITIAL PROFESSION"
              : "REGISTRY REFUSED THE FORM";
            lastError = error ?? "create_failed";
          }
        } catch {
          refs.createNote.textContent = "REGISTRY UNREACHABLE";
          lastError = "create_failed";
        } finally {
          creating = false;
          refs.createButton.disabled = draftInitialProfessionId === null;
          probe();
        }
      })();
    });

    refs.resolveProfessionButton.addEventListener("click", () => {
      if (dataPort.hosted) return;
      void (async () => {
        const record = selected();
        const initialProfessionId = resolveProfessionDraft;
        if (!record || !initialProfessionId || record.worldEntryClaimed || record.initialProfessionId !== null || resolvingInitialProfession) return;
        resolvingInitialProfession = true;
        renderSummary();
        refs.note.textContent = "COMMITTING INITIAL ALLOCATION…";
        try {
          const response = await fetch(`${apiBase}/game/characters/${encodeURIComponent(record.id)}/initial-profession`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ initialProfessionId }),
          });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            refs.note.textContent = body.error === "character_already_entered"
              ? "RECORD ALREADY DEPLOYED"
              : body.error === "initial_profession_locked"
                ? "ALLOCATION ALREADY COMMITTED"
                : "ALLOCATION REFUSED";
            lastError = body.error ?? "initial_profession_failed";
            return;
          }
          const updated = (await response.json()) as CharacterApiRecord;
          characters = characters.map((candidate) => candidate.id === updated.id
            ? { ...candidate, ...updated }
            : candidate);
          resolveProfessionDraft = null;
          refs.note.textContent = `${initialProfessionLabel(updated.initialProfessionId)} ALLOCATED · 16 SP`;
          lastError = null;
        } catch {
          refs.note.textContent = "REGISTRY UNREACHABLE";
          lastError = "initial_profession_failed";
        } finally {
          resolvingInitialProfession = false;
          renderList();
          renderSummary();
          probe();
        }
      })();
    });

    refs.enterButton.addEventListener("click", () => {
      void (async () => {
        const record = selected();
        if (!record || entering) return;
        entering = true;
        refs.enterButton.disabled = true;
        refs.note.textContent = "TRANSMITTING DEPLOYMENT…";
        try {
          const outcome = await dataPort.select(record.id);
          if (!outcome.ok || (!outcome.join && !dataPort.hosted)) {
            refs.note.textContent = outcome.error === "already_online" ? "CHARACTER ALREADY IN THE FIELD" : "DEPLOYMENT REFUSED";
            lastError = outcome.error ?? "enter_failed";
            entering = false;
            renderSummary();
            probe();
            return;
          }
          finish({ character: record, ...(outcome.join ? { join: outcome.join } : {}) });
        } catch {
          refs.note.textContent = "DEPLOYMENT LINK FAILED";
          lastError = "enter_failed";
          entering = false;
          renderSummary();
          probe();
        }
      })();
    });

    refs.deleteButton.addEventListener("click", () => {
      if (dataPort.hosted) return;
      const record = selected();
      if (!record || deleting || record.liveState !== "offline") return;
      if (!deleteArmed) {
        // First press arms; anything else (reselect, mode change) disarms.
        deleteArmed = true;
        renderSummary();
        return;
      }
      void (async () => {
        deleting = true;
        deleteArmed = false;
        renderSummary();
        refs.note.textContent = "STRIKING RECORD…";
        try {
          const response = await fetch(`${apiBase}/game/characters/${encodeURIComponent(record.id)}`, { method: "DELETE" });
          if (!response.ok) {
            const body = (await response.json().catch(() => ({}))) as { error?: string };
            refs.note.textContent = body.error === "character_online" ? "CHARACTER STILL IN THE FIELD" : "REGISTRY REFUSED THE STRIKE";
            lastError = body.error ?? "delete_failed";
          } else {
            refs.note.textContent = `${record.name.toUpperCase()} STRUCK FROM REGISTRY`;
            selectedId = null;
          }
        } catch {
          refs.note.textContent = "REGISTRY UNREACHABLE";
          lastError = "delete_failed";
        } finally {
          deleting = false;
          await refresh();
        }
      })();
    });

    void refresh();
    pollTimer = window.setInterval(() => void refresh(), POLL_MS);
    probe();
  });
}

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "JUST NOW";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "JUST NOW";
  if (minutes < 60) return `${minutes}M AGO`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}H AGO`;
  return `${Math.floor(hours / 24)}D AGO`;
}

function playTime(totalMs: number): string {
  const minutes = Math.floor((totalMs || 0) / 60_000);
  if (minutes < 60) return `${minutes}M`;
  return `${Math.floor(minutes / 60)}H ${minutes % 60}M`;
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`character select: missing ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}
