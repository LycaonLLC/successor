// The character workshop: the real 3D client, embedded. The account page
// hosts the immutable client runtime with ?mode=creator and speaks the
// versioned creator protocol over postMessage — exact origin, exact source
// window, both directions. The parent keeps all API and CSRF work on its
// own origin; the child only ever sees the safe roster and create results.
// Character ids stay in messages and one versioned one-shot storage key.
import type { Api } from "../api/client";
import type { Character, CharacterAppearance, CharacterFaceConfig } from "../api/types";
import { isCharacterId, storeSelectedCharacterId } from "./characterHandoff";
import { loadRuntimePointer } from "./runtimePointer";

// Child -> parent.
export const CREATOR_READY_TYPE = "successor.creator.ready.v1";
export const CREATOR_CREATE_TYPE = "successor.creator.create.v1";
export const CREATOR_SELECT_TYPE = "successor.creator.select.v1";
// Parent -> child.
export const CREATOR_STATE_TYPE = "successor.creator.state.v1";
export const CREATOR_CREATE_RESULT_TYPE = "successor.creator.create-result.v1";

export const CREATOR_READY_TIMEOUT_MS = 20_000;

export const CHARACTER_NAME_PATTERN = /^[A-Za-z]+(?:-[A-Za-z]+)*$/;
const PROFESSION_PATTERN = /^[a-z][a-z_-]{0,31}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_PENDING_CREATES = 4;

// Starter clothing is fixed by owner ruling: creation accepts no clothing
// choices. Appearance is the player's, shaped inside the client itself.
export const STARTER_WORN = [
  { item: "under_bodysuit", colors: ["#89cff0"] },
  { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
] as const;

const POINTER_DOWN_COPY =
  "The character workshop is not reachable right now. Nothing was changed — try again in a moment.";
const READY_TIMEOUT_COPY = "The workshop took too long to answer. Try again.";
const ROSTER_DOWN_COPY = "Your characters could not be loaded. Try again.";
const LOADING_COPY = "Starting the character workshop…";

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** Rebuilds the child-supplied appearance field by field; extras never ride along. */
function copyAppearance(value: unknown): CharacterAppearance | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!boundedString(v.skinTone, 64) || !boundedString(v.hairMat, 64)) return null;
  if (v.hair !== null && !boundedString(v.hair, 64)) return null;
  let face: CharacterFaceConfig | null = null;
  if (v.face !== null && v.face !== undefined) {
    const f = v.face as Record<string, unknown>;
    if (typeof f !== "object") return null;
    const fields = ["eyes", "brows", "nose", "mouth", "eyeColor", "browColor", "lipColor"] as const;
    for (const field of fields) if (!boundedString(f[field], 64)) return null;
    face = {
      eyes: f.eyes as string,
      brows: f.brows as string,
      nose: f.nose as string,
      mouth: f.mouth as string,
      eyeColor: f.eyeColor as string,
      browColor: f.browColor as string,
      lipColor: f.lipColor as string,
    };
  }
  return { skinTone: v.skinTone, hair: v.hair === null ? null : (v.hair as string), hairMat: v.hairMat, face };
}

export interface CreatorCreateMessage {
  type: typeof CREATOR_CREATE_TYPE;
  requestId: string;
  character: { name: string; initialProfessionId: string; appearance: CharacterAppearance };
}

/** Shape guard for successor.creator.create.v1. Malformed input reads as absent. */
export function parseCreatorCreate(data: Record<string, unknown>): CreatorCreateMessage | null {
  if (data.type !== CREATOR_CREATE_TYPE) return null;
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) return null;
  const character = data.character;
  if (character === null || typeof character !== "object") return null;
  const c = character as Record<string, unknown>;
  if (!boundedString(c.name, 64) || !boundedString(c.initialProfessionId, 32)) return null;
  if (!PROFESSION_PATTERN.test(c.initialProfessionId)) return null;
  const appearance = copyAppearance(c.appearance);
  if (appearance === null) return null;
  return {
    type: CREATOR_CREATE_TYPE,
    requestId: data.requestId,
    character: { name: c.name, initialProfessionId: c.initialProfessionId, appearance },
  };
}

/** Whitelists exactly what the child may see about a character. */
export function safeRosterCharacter(character: Character): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    id: character.id,
    name: character.name,
    initialProfessionId: character.initialProfessionId,
    worldEntryClaimed: character.worldEntryClaimed === true,
  };
  if (character.appearance) {
    const { skinTone, hair, hairMat, face } = character.appearance;
    safe.appearance = {
      skinTone,
      hair,
      hairMat,
      face: face
        ? {
            eyes: face.eyes,
            brows: face.brows,
            nose: face.nose,
            mouth: face.mouth,
            eyeColor: face.eyeColor,
            browColor: face.browColor,
            lipColor: face.lipColor,
          }
        : null,
    };
  }
  if (Array.isArray(character.worn)) {
    safe.worn = character.worn.map((entry) => ({ item: entry.item, colors: [...entry.colors] }));
  }
  return safe;
}

export interface CreatorStageOptions {
  navigate?: (path: string) => void;
  onRosterChanged?: () => void;
  readyTimeoutMs?: number;
}

export interface CreatorStage {
  /** Starts the stage once a session is active. Safe to call repeatedly. */
  activate: () => void;
  /** Re-sends the safe roster state to a live workshop (e.g. after re-login). */
  refresh: () => Promise<void>;
  /** Tears the workshop down when the session ends; a later login reactivates. */
  deactivate: () => void;
}

export function initCreatorStage(doc: Document, api: Api, options: CreatorStageOptions = {}): CreatorStage {
  const stage = doc.getElementById("creator-stage");
  const status = doc.getElementById("creator-status");
  const retry = doc.getElementById("creator-retry");
  const win = doc.defaultView;
  if (!(stage instanceof HTMLElement) || !(retry instanceof HTMLButtonElement) || !status || !win) {
    return { activate: () => {}, refresh: async () => {}, deactivate: () => {} };
  }
  const navigate =
    options.navigate ??
    ((path: string) => {
      win.location.assign(path);
    });
  const readyTimeoutMs = options.readyTimeoutMs ?? CREATOR_READY_TIMEOUT_MS;

  let started = false;
  let teardown: (() => void) | null = null;
  let refreshState: (() => Promise<void>) | null = null;

  const setState = (state: "loading" | "live" | "unavailable", message: string): void => {
    stage.dataset.stageState = state;
    status.textContent = message;
    retry.hidden = state !== "unavailable";
  };

  const start = async (): Promise<void> => {
    teardown?.();
    setState("loading", LOADING_COPY);

    const entry = await loadRuntimePointer(doc.baseURI);
    if (entry === null) {
      setState("unavailable", POINTER_DOWN_COPY);
      return;
    }
    // Public mode flag only; the URL never carries ids, tickets, or tokens.
    const creatorUrl = new URL(entry.href);
    creatorUrl.searchParams.set("mode", "creator");
    const creatorOrigin = creatorUrl.origin;

    let roster: Character[] = [];
    let ready = false;
    const pendingCreates = new Set<string>();

    const iframe = doc.createElement("iframe");
    iframe.className = "stage-frame";
    iframe.title = "Character workshop";
    iframe.setAttribute("allow", "fullscreen");

    const cleanup = (): void => {
      win.removeEventListener("message", onMessage);
      win.clearTimeout(readyDeadline);
      iframe.remove();
      teardown = null;
      refreshState = null;
    };
    const fail = (message: string): void => {
      cleanup();
      setState("unavailable", message);
    };

    const sendState = async (): Promise<boolean> => {
      const result = await api.characters();
      if (!result.ok) return false;
      roster = result.value.characters;
      iframe.contentWindow?.postMessage(
        { type: CREATOR_STATE_TYPE, characters: roster.map(safeRosterCharacter) },
        creatorOrigin,
      );
      return true;
    };

    const handleCreate = async (message: CreatorCreateMessage): Promise<void> => {
      const { requestId, character } = message;
      if (pendingCreates.has(requestId) || pendingCreates.size >= MAX_PENDING_CREATES) return;
      const reply = (ok: boolean, error?: string): void => {
        iframe.contentWindow?.postMessage(
          { type: CREATOR_CREATE_RESULT_TYPE, requestId, ok, ...(error === undefined ? {} : { error }) },
          creatorOrigin,
        );
      };
      const name = character.name.trim();
      if (name.length < 3 || name.length > 16 || !CHARACTER_NAME_PATTERN.test(name)) {
        reply(false, "3–16 letters, with internal hyphens only.");
        return;
      }
      pendingCreates.add(requestId);
      const result = await api.createCharacter({
        name,
        initialProfessionId: character.initialProfessionId,
        appearance: character.appearance,
        worn: STARTER_WORN.map((entry_) => ({ item: entry_.item, colors: [...entry_.colors] })),
      });
      pendingCreates.delete(requestId);
      if (!result.ok) {
        // Our own mapped copy only — never raw server detail.
        reply(false, result.error.message);
        return;
      }
      reply(true);
      await sendState();
      options.onRosterChanged?.();
    };

    const onMessage = (event: MessageEvent): void => {
      // Exact origin and exact source window, or the message never existed.
      if (event.origin !== creatorOrigin || event.source !== iframe.contentWindow) return;
      const data: unknown = event.data;
      if (data === null || typeof data !== "object" || !("type" in data)) return;
      const message = data as Record<string, unknown>;
      if (message.type === CREATOR_READY_TYPE) {
        void (async () => {
          const wasReady = ready;
          ready = true;
          win.clearTimeout(readyDeadline);
          if (await sendState()) {
            if (!wasReady) setState("live", "");
          } else if (!wasReady) {
            fail(ROSTER_DOWN_COPY);
          }
        })();
      } else if (message.type === CREATOR_CREATE_TYPE) {
        const create = parseCreatorCreate(message);
        if (create !== null) void handleCreate(create);
      } else if (message.type === CREATOR_SELECT_TYPE) {
        // ENTER WORLD from inside the workshop: known character ids only.
        const characterId = message.characterId;
        if (!isCharacterId(characterId)) return;
        if (!roster.some((character) => character.id === characterId)) return;
        storeSelectedCharacterId(win, characterId);
        navigate("/play/");
      }
      // Unknown types are dropped without reply.
    };

    win.addEventListener("message", onMessage);
    const readyDeadline = win.setTimeout(() => {
      if (!ready) fail(READY_TIMEOUT_COPY);
    }, readyTimeoutMs);
    teardown = cleanup;
    refreshState = async () => {
      if (ready) await sendState();
    };
    stage.append(iframe);
    iframe.src = creatorUrl.href;
  };

  retry.addEventListener("click", () => {
    if (stage.dataset.stageState === "unavailable") void start();
  });

  return {
    activate: () => {
      if (started) return;
      started = true;
      void start();
    },
    refresh: async () => {
      await refreshState?.();
    },
    deactivate: () => {
      if (!started) return;
      started = false;
      // Drop the frame, listener, and deadline; the child and its roster
      // copy die with the frame. The veil returns to loading so the next
      // login starts clean.
      teardown?.();
      setState("loading", LOADING_COPY);
    },
  };
}
