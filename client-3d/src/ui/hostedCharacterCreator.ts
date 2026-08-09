import type { CharacterApiRecord, CharactersResponse } from "./characterSelect";
import { type CharacterCreateInput, type CharacterCreateResult, type CharacterSelectDataPort, type CharacterSelectResult } from "./characterSelectDataPort";
import type { CharDollAppearance } from "./charDollPreview";

export const CREATOR_READY = "successor.creator.ready.v1" as const;
export const CREATOR_CREATE = "successor.creator.create.v1" as const;
export const CREATOR_SELECT = "successor.creator.select.v1" as const;
export const CREATOR_STATE = "successor.creator.state.v1" as const;
export const CREATOR_CREATE_RESULT = "successor.creator.create-result.v1" as const;

const MAX_ID_LENGTH = 128;
const MAX_ERROR_LENGTH = 128;
const REQUEST_TIMEOUT_MS = 10_000;
const FORBIDDEN_KEYS = new Set(["accountId", "account_id", "ownerRef", "owner_ref", "password", "ticket", "csrf", "csrfToken", "chat"]);

type HostedCharacterRecord = Omit<CharacterApiRecord, "ownerRef">;
export interface HostedCreatorState {
  characters: HostedCharacterRecord[];
  selectedCharacterId?: string;
}

export interface HostedCreatorCreateResult {
  type: typeof CREATOR_CREATE_RESULT;
  requestId: string;
  ok: boolean;
  error?: string;
}

interface CreatorStateMessage {
  type: typeof CREATOR_STATE;
  characters: HostedCharacterRecord[];
  selectedCharacterId?: string;
}

interface CreatorCreateMessage {
  type: typeof CREATOR_CREATE;
  requestId: string;
  character: {
    name: string;
    appearance: CharDollAppearance;
    initialProfessionId: string;
  };
}

interface CreatorSelectMessage {
  type: typeof CREATOR_SELECT;
  characterId: string;
}

type PendingCreate = {
  resolve: (result: HostedCreatorCreateResult) => void;
  timer: number;
};

export function exactCreatorOrigin(value: string | undefined): string {
  if (!value) throw new Error("Successor storefront origin is not configured");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Successor storefront origin must be an exact HTTPS origin");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.hostname.includes("*") || value !== parsed.origin) {
    throw new Error("Successor storefront origin must be an exact HTTPS origin");
  }
  return parsed.origin;
}

export function isCreatorMessageType(value: unknown): value is string {
  return value === CREATOR_STATE || value === CREATOR_CREATE_RESULT;
}

export function createHostedCharacterCreatorPort(options: {
  origin?: string;
  parentWindow?: Window;
  timeoutMs?: number;
} = {}): CharacterSelectDataPort & { dispose(): void } {
  if (typeof window === "undefined" && !options.parentWindow) throw new Error("Hosted creator requires a browser window");
  const childWindow = typeof window !== "undefined" ? window : options.parentWindow;
  const parentWindow = options.parentWindow ?? childWindow?.parent;
  if (!childWindow || !parentWindow || parentWindow === childWindow) throw new Error("Hosted creator requires a parent frame");
  const origin = exactCreatorOrigin(options.origin ?? import.meta.env.SUCCESSOR_STOREFRONT_ORIGIN);
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let current: CharactersResponse | null = null;
  let disposed = false;
  let requestCounter = 0;
  const stateWaiters = new Set<(response: CharactersResponse) => void>();
  const pending = new Map<string, PendingCreate>();

  const post = (message: CreatorReadyMessage | CreatorCreateMessage | CreatorSelectMessage): void => {
    if (disposed) return;
    parentWindow.postMessage(message, origin);
  };

  const ready = (): void => post({ type: CREATOR_READY });

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (disposed || event.source !== parentWindow || event.origin !== origin) return;
    const value = event.data;
    if (!isPlainRecord(value) || typeof value.type !== "string") return;
    if (value.type === CREATOR_STATE) {
      const state = parseState(value);
      if (!state) return;
      current = toCharactersResponse(state);
      for (const resolve of stateWaiters) resolve(current);
      stateWaiters.clear();
      return;
    }
    if (value.type === CREATOR_CREATE_RESULT) {
      const result = parseCreateResult(value);
      if (!result) return;
      const waiter = pending.get(result.requestId);
      if (!waiter) return;
      pending.delete(result.requestId);
      childWindow.clearTimeout(waiter.timer);
      if (result.ok) current = null;
      waiter.resolve(result);
    }
  };

  childWindow.addEventListener("message", onMessage);
  ready();

  const awaitState = (): Promise<CharactersResponse> => {
    if (current) return Promise.resolve(current);
    ready();
    return new Promise((resolve, reject) => {
      const waiter = (response: CharactersResponse): void => {
        childWindow.clearTimeout(timer);
        stateWaiters.delete(waiter);
        resolve(response);
      };
      const timer = childWindow.setTimeout(() => {
        stateWaiters.delete(waiter);
        reject(new Error("Hosted creator state timed out"));
      }, timeoutMs);
      stateWaiters.add(waiter);
    });
  };

  const port: CharacterSelectDataPort & { dispose(): void } = {
    hosted: true,
    list: () => awaitState(),
    create: async (input: CharacterCreateInput): Promise<CharacterCreateResult> => {
      const beforeIds = new Set(current?.characters.map((character) => character.id) ?? []);
      const requestId = nextRequestId(++requestCounter);
      const result = await new Promise<HostedCreatorCreateResult>((resolve) => {
        const timer = childWindow.setTimeout(() => {
          pending.delete(requestId);
          resolve({ type: CREATOR_CREATE_RESULT, requestId, ok: false, error: "create_timeout" });
        }, timeoutMs);
        pending.set(requestId, { resolve, timer });
        post({ type: CREATOR_CREATE, requestId, character: input });
      });
      if (!result.ok) return { ok: false, error: result.error ?? "create_failed" };
      const refreshed = await awaitState();
      const candidates = refreshed.characters.filter((character) => !beforeIds.has(character.id) && character.name === input.name);
      if (candidates.length !== 1) return { ok: false, error: "create_state_invalid" };
      return { ok: true, record: candidates[0] };
    },
    select: async (characterId: string): Promise<CharacterSelectResult> => {
      if (!isBoundedId(characterId)) return { ok: false, error: "invalid_character_id" };
      post({ type: CREATOR_SELECT, characterId });
      return { ok: true };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      childWindow.removeEventListener("message", onMessage);
      for (const waiter of pending.values()) {
        childWindow.clearTimeout(waiter.timer);
        waiter.resolve({ type: CREATOR_CREATE_RESULT, requestId: "", ok: false, error: "disposed" });
      }
      pending.clear();
      stateWaiters.clear();
    },
  };
  return port;
}

interface CreatorReadyMessage { type: typeof CREATOR_READY }

function nextRequestId(counter: number): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replaceAll("-", "") : String(Date.now());
  return `r${counter.toString(36)}-${random}`.slice(0, MAX_ID_LENGTH);
}

function parseState(value: Record<string, unknown>): HostedCreatorState | null {
  if (!hasOnlyKeys(value, ["type", "characters", "selectedCharacterId"]) || !Array.isArray(value.characters)) return null;
  if (value.selectedCharacterId !== undefined && !isBoundedId(value.selectedCharacterId)) return null;
  const characters = value.characters.map((candidate) => normalizeHostedCharacter(candidate));
  if (characters.some((candidate) => candidate === null)) return null;
  const normalizedCharacters = characters as HostedCharacterRecord[];
  if (value.selectedCharacterId && !normalizedCharacters.some((candidate) => candidate.id === value.selectedCharacterId)) return null;
  return { characters: normalizedCharacters, ...(value.selectedCharacterId ? { selectedCharacterId: value.selectedCharacterId } : {}) };
}

function parseCreateResult(value: Record<string, unknown>): HostedCreatorCreateResult | null {
  if (!hasOnlyKeys(value, ["type", "requestId", "ok", "error"]) || !isBoundedId(value.requestId) || typeof value.ok !== "boolean") return null;
  if (value.error !== undefined && !isBoundedText(value.error, MAX_ERROR_LENGTH)) return null;
  return { type: CREATOR_CREATE_RESULT, requestId: value.requestId, ok: value.ok, ...(typeof value.error === "string" ? { error: value.error } : {}) };
}

function normalizeHostedCharacter(value: unknown): HostedCharacterRecord | null {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key))) return null;
  const allowedKeys = ["id", "name", "initialProfessionId", "worldEntryClaimed", "appearance", "worn", "position", "lastLogoutAt", "lastSeenAt", "totalPlayMs", "liveState"];
  if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return null;
  if (!isBoundedId(value.id) || typeof value.name !== "string" || value.name.length > 64) return null;
  if (typeof value.initialProfessionId !== "string" && value.initialProfessionId !== null) return null;
  if (value.initialProfessionId !== null && !isBoundedId(value.initialProfessionId, 32)) return null;
  if (typeof value.worldEntryClaimed !== "boolean") return null;
  const appearance = value.appearance;
  if (!isHostedAppearance(appearance)) return null;
  if (value.worn !== undefined && (!Array.isArray(value.worn) || value.worn.some((piece) => !isHostedWornPiece(piece)))) return null;
  if (value.position !== undefined && value.position !== null && !isPlainRecord(value.position)) return null;
  const lastLogoutAt = value.lastLogoutAt === undefined || value.lastLogoutAt === null ? null : typeof value.lastLogoutAt === "string" ? value.lastLogoutAt : null;
  const lastSeenAt = value.lastSeenAt === undefined || value.lastSeenAt === null ? null : typeof value.lastSeenAt === "string" ? value.lastSeenAt : null;
  if (value.lastLogoutAt !== undefined && value.lastLogoutAt !== null && lastLogoutAt === null) return null;
  if (value.lastSeenAt !== undefined && value.lastSeenAt !== null && lastSeenAt === null) return null;
  const totalPlayMs = value.totalPlayMs === undefined ? 0 : value.totalPlayMs;
  if (!Number.isFinite(totalPlayMs)) return null;
  const liveState = value.liveState === undefined ? "offline" : value.liveState;
  if (liveState !== "offline" && liveState !== "online" && liveState !== "linkdead") return null;
  return {
    id: value.id,
    name: value.name,
    appearance,
    ...(value.worn !== undefined ? { worn: value.worn } : {}),
    position: value.position === undefined ? null : value.position,
    lastLogoutAt,
    lastSeenAt,
    totalPlayMs,
    liveState,
    initialProfessionId: value.initialProfessionId,
    worldEntryClaimed: value.worldEntryClaimed,
  } as HostedCharacterRecord;
}

function isHostedAppearance(value: unknown): value is CharDollAppearance {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => FORBIDDEN_KEYS.has(key) || !["body", "skinTone", "hair", "hairMat", "face"].includes(key))) return false;
  if ((value.body !== "male" && value.body !== "female") || typeof value.skinTone !== "string" || value.skinTone.length > 64 || (value.hair !== null && typeof value.hair !== "string") || (typeof value.hair === "string" && value.hair.length > 64) || typeof value.hairMat !== "string" || value.hairMat.length > 64) return false;
  if (!Object.prototype.hasOwnProperty.call(value, "face")) return false;
  if (value.face === null) return true;
  if (!isPlainRecord(value.face) || Object.keys(value.face).some((key) => !["eyes", "brows", "nose", "mouth", "eyeColor", "browColor", "lipColor"].includes(key))) return false;
  const face = value.face;
  return ["eyes", "brows", "nose", "mouth", "eyeColor", "browColor", "lipColor"].every((key) => {
    const field = face[key];
    return typeof field === "string" && field.length <= 64;
  });
}

function isHostedWornPiece(value: unknown): boolean {
  if (!isPlainRecord(value) || Object.keys(value).some((key) => !["item", "colors"].includes(key))) return false;
  return isBoundedId(value.item, 128) && Array.isArray(value.colors) && value.colors.every((color) => typeof color === "string" && color.length > 0 && color.length <= 64);
}

function toCharactersResponse(state: HostedCreatorState): CharactersResponse {
  return {
    server: { online: true, actorCount: state.characters.filter((character) => character.liveState !== "offline").length, sessionCount: 0 },
    characters: state.characters,
    ...(state.selectedCharacterId ? { selectedCharacterId: state.selectedCharacterId } : {}),
  };
}

function isBoundedId(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) && value.length <= max;
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
