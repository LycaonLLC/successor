// Character-bound macro data port on the site parent.
// Exact origin + exact source window, both directions. Parent alone holds the
// cookie session and CSRF token; the game iframe only ever sees capped macro
// payloads, ETags, operation/correlation ids, and safe error codes.
import type { Api } from "../api/client";

export const MACRO_PORT_READY_TYPE = "successor.macros.ready.v1";
export const MACRO_PORT_LIST_TYPE = "successor.macros.list.v1";
export const MACRO_PORT_SAVE_TYPE = "successor.macros.save.v1";
export const MACRO_PORT_DELETE_TYPE = "successor.macros.delete.v1";
export const MACRO_PORT_STATE_TYPE = "successor.macros.state.v1";
export const MACRO_PORT_RESULT_TYPE = "successor.macros.result.v1";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CHARACTER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MACRO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ETAG_PATTERN = /^[A-Za-z0-9._:/-]{8,128}$/;
const MAX_PENDING = 8;

export interface MacroPortCaps {
  maxItems: number;
  maxBodyBytes: number;
  maxNameCharacters: number;
  maxIconIdCharacters?: number;
}

export interface MacroPortItem {
  id: string;
  name: string;
  iconId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MacroPortPayload {
  version: number;
  items: MacroPortItem[];
  etag: string;
  caps: MacroPortCaps;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Rebuild a macro row field-by-field so extras never ride into the iframe. */
export function safeMacroItem(value: unknown): MacroPortItem | null {
  if (!isPlainRecord(value)) return null;
  if (!boundedString(value.id, 64) || !MACRO_ID_PATTERN.test(value.id)) return null;
  if (!boundedString(value.name, 48)) return null;
  if (!boundedString(value.iconId, 64)) return null;
  if (typeof value.body !== "string" || value.body.length > 16 * 1024) return null;
  return {
    id: value.id,
    name: value.name,
    iconId: value.iconId,
    body: value.body,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
  };
}

export function safeMacroPayload(value: unknown): MacroPortPayload | null {
  if (!isPlainRecord(value)) return null;
  const version =
    typeof value.version === "number" && Number.isInteger(value.version)
      ? value.version
      : isPlainRecord(value.record) && typeof value.record.version === "number" && Number.isInteger(value.record.version)
        ? value.record.version
        : null;
  if (version === null) return null;
  if (typeof value.etag !== "string" || !ETAG_PATTERN.test(value.etag)) return null;
  const capsRaw = value.caps;
  if (!isPlainRecord(capsRaw)) return null;
  const maxItems = capsRaw.maxItems;
  const maxBodyBytes = capsRaw.maxBodyBytes;
  const maxNameCharacters = capsRaw.maxNameCharacters;
  if (
    typeof maxItems !== "number" ||
    typeof maxBodyBytes !== "number" ||
    typeof maxNameCharacters !== "number"
  ) {
    return null;
  }
  const sourceItems = Array.isArray(value.macros)
    ? value.macros
    : isPlainRecord(value.record) && Array.isArray(value.record.items)
      ? value.record.items
      : Array.isArray(value.items)
        ? value.items
        : null;
  if (!sourceItems) return null;
  const items: MacroPortItem[] = [];
  for (const row of sourceItems) {
    const item = safeMacroItem(row);
    if (item) items.push(item);
    if (items.length >= maxItems) break;
  }
  const caps: MacroPortCaps = {
    maxItems,
    maxBodyBytes,
    maxNameCharacters,
  };
  if (typeof capsRaw.maxIconIdCharacters === "number") {
    caps.maxIconIdCharacters = capsRaw.maxIconIdCharacters;
  }
  return { version, items, etag: value.etag, caps };
}

export function parseMacroPortReady(data: Record<string, unknown>): { characterId: string } | null {
  if (data.type !== MACRO_PORT_READY_TYPE) return null;
  if (typeof data.characterId !== "string" || !CHARACTER_ID_PATTERN.test(data.characterId)) return null;
  return { characterId: data.characterId };
}

export function parseMacroPortList(data: Record<string, unknown>): { requestId: string; characterId: string } | null {
  if (data.type !== MACRO_PORT_LIST_TYPE) return null;
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) return null;
  if (typeof data.characterId !== "string" || !CHARACTER_ID_PATTERN.test(data.characterId)) return null;
  return { requestId: data.requestId, characterId: data.characterId };
}

export function parseMacroPortSave(data: Record<string, unknown>): {
  requestId: string;
  characterId: string;
  etag: string;
  macro: { id: string; name: string; iconId: string; body: string };
} | null {
  if (data.type !== MACRO_PORT_SAVE_TYPE) return null;
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) return null;
  if (typeof data.characterId !== "string" || !CHARACTER_ID_PATTERN.test(data.characterId)) return null;
  if (typeof data.etag !== "string" || !ETAG_PATTERN.test(data.etag)) return null;
  if (!isPlainRecord(data.macro)) return null;
  const macro = data.macro;
  if (typeof macro.id !== "string" || !MACRO_ID_PATTERN.test(macro.id)) return null;
  if (typeof macro.name !== "string" || macro.name.length === 0 || macro.name.length > 48) return null;
  if (typeof macro.iconId !== "string" || macro.iconId.length === 0 || macro.iconId.length > 64) return null;
  if (typeof macro.body !== "string") return null;
  return {
    requestId: data.requestId,
    characterId: data.characterId,
    etag: data.etag,
    macro: { id: macro.id, name: macro.name, iconId: macro.iconId, body: macro.body },
  };
}

export function parseMacroPortDelete(data: Record<string, unknown>): {
  requestId: string;
  characterId: string;
  etag: string;
  macroId: string;
} | null {
  if (data.type !== MACRO_PORT_DELETE_TYPE) return null;
  if (typeof data.requestId !== "string" || !REQUEST_ID_PATTERN.test(data.requestId)) return null;
  if (typeof data.characterId !== "string" || !CHARACTER_ID_PATTERN.test(data.characterId)) return null;
  if (typeof data.etag !== "string" || !ETAG_PATTERN.test(data.etag)) return null;
  if (typeof data.macroId !== "string" || !MACRO_ID_PATTERN.test(data.macroId)) return null;
  return {
    requestId: data.requestId,
    characterId: data.characterId,
    etag: data.etag,
    macroId: data.macroId,
  };
}

/** Secret-bearing keys that must never appear on macro port wire messages. */
const SECRET_MESSAGE_KEYS = new Set([
  "csrf",
  "csrftoken",
  "cookie",
  "cookies",
  "password",
  "ownerref",
  "accountid",
  "session",
  "sessionid",
  "authorization",
  "token",
  "__host-successor_session",
]);

/** Top-level keys allowed on parent→child macro port messages. */
const MACRO_STATE_KEYS = new Set([
  "type",
  "characterId",
  "etag",
  "version",
  "caps",
  "macros",
  "correlationId",
  "generation",
]);
const MACRO_RESULT_KEYS = new Set([
  "type",
  "requestId",
  "characterId",
  "ok",
  "operation",
  "error",
  "etag",
  "version",
  "caps",
  "macros",
  "macro",
  "generation",
]);
const MACRO_ITEM_KEYS = new Set(["id", "name", "iconId", "body", "createdAt", "updatedAt"]);
const MACRO_CAPS_KEYS = new Set([
  "maxItems",
  "maxBodyBytes",
  "maxNameCharacters",
  "maxIconIdCharacters",
]);

/**
 * Structural secret guard only. Never scans player-authored name/body/icon text —
 * words like "password" or "cookie" are legal macro content. Rejects unknown keys
 * and secret-bearing field names at every object level of the outbound message.
 */
export function assertSecretFreeMacroMessage(message: Record<string, unknown>): void {
  const type = message.type;
  if (type !== MACRO_PORT_STATE_TYPE && type !== MACRO_PORT_RESULT_TYPE) {
    throw new Error("macro port message type not allowlisted");
  }
  const allowedTop = type === MACRO_PORT_STATE_TYPE ? MACRO_STATE_KEYS : MACRO_RESULT_KEYS;
  assertAllowlistedObject(message, allowedTop, "message");
  if (message.caps !== undefined) {
    if (!isPlainRecord(message.caps)) throw new Error("macro port caps must be an object");
    assertAllowlistedObject(message.caps, MACRO_CAPS_KEYS, "caps");
  }
  if (message.macros !== undefined) {
    if (!Array.isArray(message.macros)) throw new Error("macro port macros must be an array");
    for (const row of message.macros) {
      if (!isPlainRecord(row)) throw new Error("macro port macro row must be an object");
      assertAllowlistedObject(row, MACRO_ITEM_KEYS, "macro");
    }
  }
  if (message.macro !== undefined) {
    if (!isPlainRecord(message.macro)) throw new Error("macro port macro must be an object");
    assertAllowlistedObject(message.macro, MACRO_ITEM_KEYS, "macro");
  }
}

function assertAllowlistedObject(
  value: Record<string, unknown>,
  allowed: Set<string>,
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (SECRET_MESSAGE_KEYS.has(key.toLowerCase())) {
      throw new Error(`macro port ${label} leaked secret field ${key}`);
    }
    if (!allowed.has(key)) {
      throw new Error(`macro port ${label} has non-allowlisted field ${key}`);
    }
  }
}

export function publicMacroStateMessage(
  characterId: string,
  payload: MacroPortPayload,
  correlationId?: string,
  generation?: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: MACRO_PORT_STATE_TYPE,
    characterId,
    etag: payload.etag,
    version: payload.version,
    caps: { ...payload.caps },
    macros: payload.items.map((item) => ({ ...item })),
  };
  if (correlationId) message.correlationId = correlationId;
  if (typeof generation === "number" && Number.isInteger(generation) && generation >= 0) {
    message.generation = generation;
  }
  assertSecretFreeMacroMessage(message);
  return message;
}

export function publicMacroResultMessage(input: {
  requestId: string;
  characterId: string;
  ok: boolean;
  operation: "list" | "save" | "delete";
  error?: string;
  payload?: MacroPortPayload | null;
  macro?: MacroPortItem | null;
  generation?: number;
}): Record<string, unknown> {
  const message: Record<string, unknown> = {
    type: MACRO_PORT_RESULT_TYPE,
    requestId: input.requestId,
    characterId: input.characterId,
    ok: input.ok,
    operation: input.operation,
  };
  if (input.error) message.error = input.error;
  if (input.payload) {
    message.etag = input.payload.etag;
    message.version = input.payload.version;
    message.caps = { ...input.payload.caps };
    message.macros = input.payload.items.map((item) => ({ ...item }));
  }
  if (input.macro) message.macro = { ...input.macro };
  if (typeof input.generation === "number" && Number.isInteger(input.generation) && input.generation >= 0) {
    message.generation = input.generation;
  }
  assertSecretFreeMacroMessage(message);
  return message;
}

export interface MacroPortBridgeOptions {
  api: Api;
  iframe: HTMLIFrameElement;
  clientOrigin: string;
  /** Character id bound at launch; messages for any other id are dropped. */
  characterId: string;
  win?: Window;
}

export interface MacroPortBridge {
  dispose: () => void;
  refresh: () => Promise<void>;
}

/**
 * Attach the character-bound macro data port to a live game iframe.
 * Parent performs all /alpha-api macro HTTP; iframe only speaks versioned messages.
 */
export function attachMacroPortBridge(options: MacroPortBridgeOptions): MacroPortBridge {
  const win = options.win ?? options.iframe.ownerDocument?.defaultView;
  if (!win) {
    return { dispose: () => {}, refresh: async () => {} };
  }
  const pending = new Set<string>();
  let disposed = false;
  /** Bumps on every committed save/delete so in-flight list/focus can detect supersession. */
  let macroEpoch = 0;

  const post = (message: Record<string, unknown>): void => {
    if (disposed) return;
    assertSecretFreeMacroMessage(message);
    options.iframe.contentWindow?.postMessage(message, options.clientOrigin);
  };

  const loadList = async (): Promise<MacroPortPayload | null> => {
    const result = await options.api.listMacros(options.characterId);
    if (!result.ok) return null;
    const payload = safeMacroPayload(result.value);
    if (!payload) return null;
    return payload;
  };

  /**
   * Fetch + push full list. Captures epoch at start; if a mutation commits while
   * the fetch is in flight, this push is dropped.
   */
  const pushState = async (correlationId?: string): Promise<boolean> => {
    const startedAt = macroEpoch;
    const payload = await loadList();
    if (!payload || disposed) return false;
    if (startedAt !== macroEpoch) return false;
    post(publicMacroStateMessage(options.characterId, payload, correlationId, macroEpoch));
    return true;
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    if (event.origin !== options.clientOrigin || event.source !== options.iframe.contentWindow) return;
    const data: unknown = event.data;
    if (!isPlainRecord(data) || typeof data.type !== "string") return;

    if (data.type === MACRO_PORT_READY_TYPE) {
      const ready = parseMacroPortReady(data);
      if (!ready || ready.characterId !== options.characterId) return;
      void pushState();
      return;
    }

    if (data.type === MACRO_PORT_LIST_TYPE) {
      const list = parseMacroPortList(data);
      if (!list || list.characterId !== options.characterId) return;
      if (pending.has(list.requestId) || pending.size >= MAX_PENDING) return;
      pending.add(list.requestId);
      void (async () => {
        const startedAt = macroEpoch;
        const payload = await loadList();
        pending.delete(list.requestId);
        if (startedAt !== macroEpoch) {
          // Superseded by a committed mutation; do not reply with pre-mutation bytes.
          return;
        }
        if (!payload) {
          post(
            publicMacroResultMessage({
              requestId: list.requestId,
              characterId: options.characterId,
              ok: false,
              operation: "list",
              error: "macros_unavailable",
              generation: macroEpoch,
            }),
          );
          return;
        }
        post(
          publicMacroResultMessage({
            requestId: list.requestId,
            characterId: options.characterId,
            ok: true,
            operation: "list",
            payload,
            generation: macroEpoch,
          }),
        );
        post(publicMacroStateMessage(options.characterId, payload, list.requestId, macroEpoch));
      })();
      return;
    }

    if (data.type === MACRO_PORT_SAVE_TYPE) {
      const save = parseMacroPortSave(data);
      if (!save || save.characterId !== options.characterId) return;
      if (pending.has(save.requestId) || pending.size >= MAX_PENDING) return;
      pending.add(save.requestId);
      void (async () => {
        const result = await options.api.saveMacro(options.characterId, save.macro, save.etag);
        pending.delete(save.requestId);
        if (!result.ok) {
          const bodyPayload =
            result.error.kind === "rejected" && "body" in result.error
              ? safeMacroPayload(result.error.body)
              : null;
          const payload = bodyPayload;
          post(
            publicMacroResultMessage({
              requestId: save.requestId,
              characterId: options.characterId,
              ok: false,
              operation: "save",
              error: result.error.kind === "rejected" ? result.error.code : "macros_unavailable",
              payload,
              generation: macroEpoch,
            }),
          );
          if (payload) post(publicMacroStateMessage(options.characterId, payload, save.requestId, macroEpoch));
          return;
        }
        // Durable write already committed server-side; invalidate any pre-write list/focus now.
        macroEpoch += 1;
        const payload = safeMacroPayload(result.value);
        if (!payload) {
          post(
            publicMacroResultMessage({
              requestId: save.requestId,
              characterId: options.characterId,
              ok: false,
              operation: "save",
              error: "macros_unavailable",
              generation: macroEpoch,
            }),
          );
          return;
        }
        const macro = safeMacroItem(
          isPlainRecord(result.value) ? result.value.macro : null,
        );
        post(
          publicMacroResultMessage({
            requestId: save.requestId,
            characterId: options.characterId,
            ok: true,
            operation: "save",
            payload,
            macro,
            generation: macroEpoch,
          }),
        );
        post(publicMacroStateMessage(options.characterId, payload, save.requestId, macroEpoch));
      })();
      return;
    }

    if (data.type === MACRO_PORT_DELETE_TYPE) {
      const del = parseMacroPortDelete(data);
      if (!del || del.characterId !== options.characterId) return;
      if (pending.has(del.requestId) || pending.size >= MAX_PENDING) return;
      pending.add(del.requestId);
      void (async () => {
        const result = await options.api.deleteMacro(options.characterId, del.macroId, del.etag);
        pending.delete(del.requestId);
        if (!result.ok) {
          const bodyPayload =
            result.error.kind === "rejected" && "body" in result.error
              ? safeMacroPayload(result.error.body)
              : null;
          post(
            publicMacroResultMessage({
              requestId: del.requestId,
              characterId: options.characterId,
              ok: false,
              operation: "delete",
              error: result.error.kind === "rejected" ? result.error.code : "macros_unavailable",
              payload: bodyPayload,
              generation: macroEpoch,
            }),
          );
          if (bodyPayload) post(publicMacroStateMessage(options.characterId, bodyPayload, del.requestId, macroEpoch));
          return;
        }
        // Durable delete already committed server-side; invalidate any pre-write list/focus now.
        macroEpoch += 1;
        const payload = safeMacroPayload(result.value);
        if (!payload) {
          post(
            publicMacroResultMessage({
              requestId: del.requestId,
              characterId: options.characterId,
              ok: false,
              operation: "delete",
              error: "macros_unavailable",
              generation: macroEpoch,
            }),
          );
          return;
        }
        post(
          publicMacroResultMessage({
            requestId: del.requestId,
            characterId: options.characterId,
            ok: true,
            operation: "delete",
            payload,
            generation: macroEpoch,
          }),
        );
        post(publicMacroStateMessage(options.characterId, payload, del.requestId, macroEpoch));
      })();
    }
  };

  const onFocus = (): void => {
    void pushState();
  };

  win.addEventListener("message", onMessage);
  win.addEventListener("focus", onFocus);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      win.removeEventListener("message", onMessage);
      win.removeEventListener("focus", onFocus);
      pending.clear();
    },
    refresh: async () => {
      await pushState();
    },
  };
}
