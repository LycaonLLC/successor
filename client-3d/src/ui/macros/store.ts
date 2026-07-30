import { utf8ByteLength } from "@successor/client/src/slice-core/macroEngine/index";

/**
 * MACRO store — server-authoritative per-character command macros
 * (`successor.macros.v1`, SP3 record kind: 64 macros / 8 KiB bodies).
 *
 * Hosted path: the site parent alone holds cookie/CSRF and speaks alpha HTTP.
 * This module talks a character-bound data port over postMessage (or a test
 * double). Legacy local/dev still accepts a fetchImpl against game routes.
 *
 * CRUD responses always carry the FULL payload; the local list is replaced
 * wholesale. Conflict (409) also replaces from the returned current payload.
 */

export interface SavedMacro {
  id: string;
  name: string;
  iconId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface MacroCaps {
  maxItems: number;
  maxBodyBytes: number;
  maxNameCharacters: number;
}

export interface MacroMutationResult {
  ok: boolean;
  /** Status-foot line, established receipt voice ("SAVED · HEAL SELF"). */
  status: string;
  /** Stable code for deny wiring (`macro_rate_limited`, `invalid_macro`, …). */
  reasonCode?: string;
  macro: SavedMacro | null;
}

export type MacroStorePhase = "unbound" | "seeded" | "syncing" | "synced" | "link_down" | "denied";

export interface MacroStoreStatus {
  phase: MacroStorePhase;
  detail: string | null;
}

export interface MacroRecordPayloadLike {
  version?: unknown;
  items?: unknown;
  etag?: unknown;
  macros?: unknown;
  record?: unknown;
  caps?: unknown;
  macro?: unknown;
  error?: unknown;
  generation?: unknown;
  ok?: unknown;
  status?: unknown;
}

/** Hosted parent data-port surface. Parent owns HTTP; iframe never sees secrets. */
export interface MacroDataPort {
  list(): Promise<MacroRecordPayloadLike>;
  save(input: {
    id: string;
    name: string;
    iconId: string;
    body: string;
    etag: string;
  }): Promise<MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }>;
  delete(input: {
    macroId: string;
    etag: string;
  }): Promise<MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }>;
}

interface ConfigureMacroStoreOptions {
  characterId: string;
  seed?: MacroRecordPayloadLike | null;
  /** Hosted character-bound port (preferred). */
  dataPort?: MacroDataPort | null;
  /** Legacy/local HTTP base (dev game routes only). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export const MACRO_DEFAULT_CAPS: MacroCaps = {
  maxItems: 64,
  maxBodyBytes: 8 * 1024,
  maxNameCharacters: 48,
};

export const MACRO_DEFAULT_ICON_ID = "macro:command";

/** The SP3 record kind this store mirrors (characterStore.ts is the authority). */
export const SUCCESSOR_MACROS_RECORD_KIND = "successor.macros.v1";

const MACRO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

const macroList: SavedMacro[] = [];
let storeVersion = 0;
let caps: MacroCaps = { ...MACRO_DEFAULT_CAPS };
let status: MacroStoreStatus = { phase: "unbound", detail: null };
let apiBase: string | null = null;
let characterId: string | null = null;
let fetchImpl: typeof fetch | null = null;
let dataPort: MacroDataPort | null = null;
let payloadEtag: string | null = null;
/** Monotonic parent generation; unsolicited state below this is dropped. */
let appliedGeneration = 0;
let inFlight = false;
let focusBound = false;

export function macroStoreVersion(): number {
  return storeVersion;
}

export function macros(): readonly SavedMacro[] {
  return macroList;
}

export function macroCaps(): MacroCaps {
  return caps;
}

export function macroStoreStatus(): MacroStoreStatus {
  return status;
}

export function macroPayloadEtag(): string | null {
  return payloadEtag;
}

export function macroById(id: string): SavedMacro | null {
  return macroList.find((macro) => macro.id === id) ?? null;
}

/** Name lookup for `/macro run <name>` — case-insensitive, first match. */
export function macroByName(name: string): SavedMacro | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  return macroList.find((macro) => macro.name.toLowerCase() === needle)
    ?? macroList.find((macro) => macro.id.toLowerCase() === needle)
    ?? null;
}

/**
 * Bind the store to a character + transport. A join-payload seed applies
 * synchronously (no fetch); without one the caller should `refreshMacros()`.
 */
export function configureMacroStore(options: ConfigureMacroStoreOptions): void {
  characterId = options.characterId;
  dataPort = options.dataPort ?? null;
  apiBase = options.apiBase ? options.apiBase.replace(/\/+$/u, "") : null;
  fetchImpl = options.fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  macroList.length = 0;
  caps = { ...MACRO_DEFAULT_CAPS };
  payloadEtag = null;
  appliedGeneration = 0;
  const seeded = options.seed ? applyPayload(options.seed) : false;
  status = seeded
    ? { phase: "seeded", detail: null }
    : { phase: "unbound", detail: null };
  storeVersion += 1;
  ensureFocusRefresh();
}

/** Test/lab hook: drop the binding so a fresh configure starts clean. */
export function resetMacroStoreForTest(): void {
  apiBase = null;
  characterId = null;
  fetchImpl = null;
  dataPort = null;
  payloadEtag = null;
  appliedGeneration = 0;
  inFlight = false;
  macroList.length = 0;
  caps = { ...MACRO_DEFAULT_CAPS };
  status = { phase: "unbound", detail: null };
  storeVersion += 1;
  if (focusBound && typeof window !== "undefined") {
    window.removeEventListener("focus", onWindowFocus);
    focusBound = false;
  }
}

/**
 * Full-list replacement from parent state push or external seed refresh.
 * Ordering is generation-monotonic (not ETag-string order):
 * - Unsolicited state with generation < last applied mutation generation is dropped
 *   even after inFlight clears (slow focus/list begun before mutation).
 * - Unsolicited state during inFlight is also dropped.
 * - Solicited mutation/list results pass generation through and advance the watermark.
 */
export function adoptMacroPayload(
  payload: MacroRecordPayloadLike,
  options: { unsolicited?: boolean; generation?: number } = {},
): boolean {
  const generation = typeof options.generation === "number" && Number.isInteger(options.generation)
    ? options.generation
    : typeof payload.generation === "number" && Number.isInteger(payload.generation)
      ? payload.generation
      : null;
  if (options.unsolicited) {
    if (inFlight) return false;
    if (generation !== null && generation < appliedGeneration) return false;
  }
  const replaced = applyPayload(payload);
  if (!replaced) return false;
  if (generation !== null && generation > appliedGeneration) {
    appliedGeneration = generation;
  }
  setStatus("synced", null);
  storeVersion += 1;
  return true;
}

export function macroAppliedGeneration(): number {
  return appliedGeneration;
}

export async function refreshMacros(): Promise<MacroMutationResult> {

  return request("list", null, null, "SYNCED");
}

export interface MacroSaveInput {
  id?: string | null;
  name: string;
  iconId?: string | null;
  body: string;
}

export async function saveMacro(input: MacroSaveInput): Promise<MacroMutationResult> {
  const name = normalizeMacroName(input.name);
  if (!name) return deny("invalid_macro", "DENIED · NAME REQUIRED");
  if (name.length > caps.maxNameCharacters) {
    return deny("invalid_macro", `DENIED · NAME OVER ${caps.maxNameCharacters}`);
  }
  const bytes = utf8ByteLength(input.body);
  if (bytes > caps.maxBodyBytes) {
    return deny("macro_too_large", `DENIED · BODY ${bytes} / ${caps.maxBodyBytes} BYTES`);
  }
  if (input.body.trim().length === 0) return deny("invalid_macro", "DENIED · BODY REQUIRED");
  const id = input.id && MACRO_ID_PATTERN.test(input.id)
    ? input.id
    : slugMacroId(name, macroList.map((macro) => macro.id));
  const duplicate = macroList.find((macro) => macro.id !== id && macro.name.toLowerCase() === name.toLowerCase());
  if (duplicate) return deny("invalid_macro", `DENIED · NAME TAKEN BY ${duplicate.name.toUpperCase()}`);
  if (!macroById(id) && macroList.length >= caps.maxItems) {
    return deny("macro_limit_exceeded", `DENIED · CAP ${caps.maxItems}/${caps.maxItems} — DELETE ONE FIRST`);
  }
  const body = {
    id,
    name,
    iconId: input.iconId && input.iconId.length > 0 ? input.iconId : MACRO_DEFAULT_ICON_ID,
    body: input.body,
  };
  return request("save", null, body, `SAVED · ${name.toUpperCase()}`);
}

export async function deleteMacro(id: string): Promise<MacroMutationResult> {
  const existing = macroById(id);
  if (!existing) return deny("macro_not_found", "DENIED · MACRO GONE");
  return request("delete", id, null, `DELETED · ${existing.name.toUpperCase()}`);
}

type RequestKind = "list" | "save" | "delete";

async function request(
  kind: RequestKind,
  macroId: string | null,
  body: Record<string, unknown> | null,
  okStatus: string,
): Promise<MacroMutationResult> {
  if (!characterId || (!dataPort && (!apiBase || !fetchImpl))) {
    return deny("store_unbound", "DENIED · NO CHARACTER RECORD");
  }
  if (inFlight) return deny("store_busy", "DENIED · TRANSMISSION IN FLIGHT");
  inFlight = true;
  if (kind === "list") setStatus("syncing", null);
  try {
    if ((kind === "save" || kind === "delete") && !payloadEtag) {
      // Pull current list/ETag once under the same in-flight lock, then mutate.
      if (dataPort) {
        const listed = await dataPort.list();
        applyPayload(listed);
      } else if (apiBase && fetchImpl && characterId) {
        const response = await fetchImpl(`${apiBase}/game/characters/${encodeURIComponent(characterId)}/macros`);
        const listed = (await response.json().catch(() => ({}))) as MacroRecordPayloadLike;
        if (response.ok) applyPayload(listed);
      }
      if (!payloadEtag) return deny("etag_required", "DENIED · ETAG REQUIRED");
    }
    if (dataPort) {
      return await requestViaDataPort(kind, macroId, body, okStatus);
    }
    return await requestViaFetch(kind, macroId, body, okStatus);
  } catch {
    setStatus("link_down", null);
    return deny("link_down", "DENIED · LINK DOWN");
  } finally {
    inFlight = false;
  }
}

async function requestViaDataPort(
  kind: RequestKind,
  macroId: string | null,
  body: Record<string, unknown> | null,
  okStatus: string,
): Promise<MacroMutationResult> {
  if (!dataPort) return deny("store_unbound", "DENIED · NO CHARACTER RECORD");
  let payload: MacroRecordPayloadLike;
  if (kind === "list") {
    payload = await dataPort.list();
  } else if (kind === "save") {
    if (!body || typeof body.id !== "string" || typeof body.name !== "string" || typeof body.body !== "string") {
      return deny("invalid_macro", "DENIED · INVALID MACRO");
    }
    payload = await dataPort.save({
      id: body.id,
      name: body.name,
      iconId: typeof body.iconId === "string" ? body.iconId : MACRO_DEFAULT_ICON_ID,
      body: body.body,
      etag: payloadEtag ?? "",
    });
  } else {
    if (!macroId) return deny("macro_not_found", "DENIED · MACRO GONE");
    payload = await dataPort.delete({ macroId, etag: payloadEtag ?? "" });
  }

  const errorCode = typeof payload.error === "string" ? payload.error : null;
  const failed = payload.ok === false || (typeof payload.status === "number" && payload.status >= 400) || Boolean(errorCode && kind !== "list" && !payloadItems(payload));
  const generation = typeof payload.generation === "number" && Number.isInteger(payload.generation)
    ? payload.generation
    : null;
  // Solicited waiter path. Generation watermark advances so later stale
  // unsolicited state from an earlier epoch cannot roll the library backward.
  if (generation !== null && generation < appliedGeneration && kind === "list") {
    setStatus("synced", null);
    return failed
      ? deny(errorCode ?? "macros_unavailable", denyStatus(errorCode ?? "macros_unavailable", payload as Record<string, unknown>))
      : { ok: true, status: okStatus, macro: null };
  }
  // Correlated mutation results advance the ordering watermark on any higher
  // generation — including ok:false macros_unavailable after a durable write
  // whose body could not be projected. Do not require applyPayload success.
  // List results and ordinary same-generation API failures do not bump here.
  if (kind !== "list" && generation !== null && generation > appliedGeneration) {
    appliedGeneration = generation;
  }
  const replaced = applyPayload(payload);
  if (replaced) {
    if (generation !== null && generation > appliedGeneration) appliedGeneration = generation;
    storeVersion += 1;
  }
  if (failed) {
    const reason = errorCode ?? "macro_write_failed";
    const denied = deny(reason, denyStatus(reason, payload as Record<string, unknown>));
    setStatus(reason === "etag_mismatch" ? "synced" : "denied", denied.status);
    return denied;
  }
  setStatus("synced", null);
  storeVersion += 1;
  const savedMacro = normalizeMacro(payload.macro);
  return { ok: true, status: okStatus, macro: savedMacro };
}

async function requestViaFetch(
  kind: RequestKind,
  macroId: string | null,
  body: Record<string, unknown> | null,
  okStatus: string,
): Promise<MacroMutationResult> {
  if (!apiBase || !characterId || !fetchImpl) {
    return deny("store_unbound", "DENIED · NO CHARACTER RECORD");
  }
  const method = kind === "list" ? "GET" : kind === "save" ? "POST" : "DELETE";
  const url = `${apiBase}/game/characters/${encodeURIComponent(characterId)}/macros${macroId ? `/${encodeURIComponent(macroId)}` : ""}`;
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if ((kind === "save" || kind === "delete") && payloadEtag) {
    headers["if-match"] = payloadEtag;
  }
  const response = await fetchImpl(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    // Conflict: replace from current full payload when present, then deny.
    if (response.status === 409) {
      applyPayload(payload as MacroRecordPayloadLike);
      storeVersion += 1;
    }
    const reason = typeof payload.error === "string" ? payload.error : `http_${response.status}`;
    const denied = deny(reason, denyStatus(reason, payload));
    setStatus(response.status === 409 ? "synced" : "denied", denied.status);
    return denied;
  }
  applyPayload(payload as MacroRecordPayloadLike);
  setStatus("synced", null);
  storeVersion += 1;
  const savedMacro = normalizeMacro(payload.macro);
  return { ok: true, status: okStatus, macro: savedMacro };
}

/** Map server error codes to the status-foot deny voice. */
export function denyStatus(reason: string, payload: Record<string, unknown> = {}): string {
  switch (reason) {
    case "macro_rate_limited": {
      const retryMs = typeof payload.retryAfterMs === "number" ? payload.retryAfterMs : null;
      return retryMs ? `DENIED · RATE LIMITED — RETRY ${Math.ceil(retryMs / 1000)}S` : "DENIED · RATE LIMITED";
    }
    case "macro_limit_exceeded":
      return "DENIED · MACRO CAP REACHED";
    case "macro_too_large":
      return "DENIED · MACRO TOO LARGE";
    case "invalid_macro":
      return "DENIED · INVALID MACRO";
    case "macro_not_found":
      return "DENIED · MACRO GONE";
    case "character_not_found":
      return "DENIED · NO CHARACTER RECORD";
    case "etag_mismatch":
      return "DENIED · MACRO CONFLICT — REFRESHED";
    case "etag_required":
      return "DENIED · ETAG REQUIRED";
    default:
      return `DENIED · ${reason.replaceAll("_", " ").toUpperCase()}`;
  }
}

function deny(reasonCode: string, statusText: string): MacroMutationResult {
  return { ok: false, status: statusText, reasonCode, macro: null };
}

function setStatus(phase: MacroStorePhase, detail: string | null): void {
  status = { phase, detail };
  storeVersion += 1;
}

/** Replace the list from any payload shape carrying items (join seed or CRUD response). */
function applyPayload(payload: MacroRecordPayloadLike): boolean {
  const rows = payloadItems(payload);
  if (!rows) return false;
  macroList.length = 0;
  for (const row of rows) {
    const macro = normalizeMacro(row);
    if (macro) macroList.push(macro);
    if (macroList.length >= caps.maxItems) break;
  }
  const nextCaps = normalizeCaps(payload.caps);
  if (nextCaps) caps = nextCaps;
  if (typeof payload.etag === "string" && payload.etag.length >= 8) {
    payloadEtag = payload.etag;
  }
  return true;
}

function payloadItems(payload: MacroRecordPayloadLike): unknown[] | null {
  if (Array.isArray(payload.macros)) return payload.macros;
  if (Array.isArray(payload.items)) return payload.items;
  const record = payload.record;
  if (record && typeof record === "object" && !Array.isArray(record)) {
    const items = (record as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
  }
  return null;
}

function normalizeMacro(value: unknown): SavedMacro | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" && MACRO_ID_PATTERN.test(row.id) ? row.id : null;
  const name = typeof row.name === "string" ? normalizeMacroName(row.name) : "";
  const body = typeof row.body === "string" ? row.body : null;
  if (!id || !name || body === null) return null;
  return {
    id,
    name,
    iconId: typeof row.iconId === "string" && row.iconId.length > 0 ? row.iconId : MACRO_DEFAULT_ICON_ID,
    body,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
  };
}

function normalizeCaps(value: unknown): MacroCaps | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Record<string, unknown>;
  const maxItems = positiveInt(row.maxItems);
  const maxBodyBytes = positiveInt(row.maxBodyBytes);
  const maxNameCharacters = positiveInt(row.maxNameCharacters);
  if (!maxItems || !maxBodyBytes) return null;
  return {
    maxItems,
    maxBodyBytes,
    maxNameCharacters: maxNameCharacters ?? MACRO_DEFAULT_CAPS.maxNameCharacters,
  };
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function normalizeMacroName(value: string): string {
  return value
    .normalize("NFKC")
    // Server rejects control characters outright; strip instead of denying —
    // BEFORE trim/collapse so stripped chars can't leave stray spaces.
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, MACRO_DEFAULT_CAPS.maxNameCharacters);
}

/** First non-comment line of a body — the library row preview. */
export function macroPreviewLine(body: string): string {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    return line.length > 72 ? `${line.slice(0, 71)}…` : line;
  }
  return "(empty)";
}

/** Server id pattern: alnum head, then [A-Za-z0-9_-], ≤64 chars, unique. */
export function slugMacroId(name: string, existingIds: readonly string[]): string {
  const base = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^[_-]+|[_-]+$/gu, "")
    .slice(0, 56) || "macro";
  const head = /^[a-z0-9]/u.test(base) ? base : `m${base}`;
  if (!existingIds.includes(head)) return head;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${head}_${i}`;
    if (!existingIds.includes(candidate)) return candidate;
  }
  return `${head}_${Date.now().toString(36)}`;
}

function onWindowFocus(): void {
  if (!characterId || (!dataPort && !apiBase)) return;
  void refreshMacros();
}

function ensureFocusRefresh(): void {
  if (focusBound || typeof window === "undefined") return;
  window.addEventListener("focus", onWindowFocus);
  focusBound = true;
}

/**
 * Hosted iframe data-port adapter. Speaks the versioned parent protocol and
 * never touches cookies, CSRF, owner, or account identity.
 */
export interface ParentMacroDataPort extends MacroDataPort {
  /** Test seam: deliver a parent message without a real window event. */
  __deliverForTest(message: Record<string, unknown>): void;
  /** Test seam: count in-flight mutation waiters (save/delete only). */
  __mutationInFlightForTest(): number;
}

export function createParentMacroDataPort(options: {
  characterId: string;
  parentOrigin: string;
  requestTimeoutMs?: number;
  /** When false, skip window listener/ready announce (unit tests). Default true. */
  bindWindow?: boolean;
}): ParentMacroDataPort {
  const timeoutMs = options.requestTimeoutMs ?? 8_000;
  const bindWindow = options.bindWindow !== false;
  let nextId = 1;
  const pending = new Map<string, {
    resolve: (value: MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }) => void;
    timer: ReturnType<typeof setTimeout>;
    kind: "list" | "mutation";
  }>();

  const deliver = (message: Record<string, unknown>): void => {
    if (message.type === "successor.macros.state.v1") {
      if (message.characterId !== options.characterId) return;
      const generation = typeof message.generation === "number" && Number.isInteger(message.generation)
        ? message.generation
        : undefined;
      // Unsolicited focus/list: drop while mutating and drop any epoch older than
      // the last applied mutation (late responses begun pre-mutation).
      adoptMacroPayload(
        {
          version: message.version,
          macros: message.macros,
          items: message.macros,
          etag: message.etag,
          caps: message.caps,
          generation,
        },
        { unsolicited: true, generation },
      );
      return;
    }
    if (message.type !== "successor.macros.result.v1") return;
    if (typeof message.requestId !== "string") return;
    if (message.characterId !== options.characterId) return;
    const waiter = pending.get(message.requestId);
    if (!waiter) return;
    pending.delete(message.requestId);
    clearTimeout(waiter.timer);
    const payload: MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number } = {
      version: message.version,
      items: message.macros,
      macros: message.macros,
      etag: message.etag,
      caps: message.caps,
      macro: message.macro,
      generation: typeof message.generation === "number" ? message.generation : undefined,
      ok: message.ok === true,
      error: typeof message.error === "string" ? message.error : undefined,
      status: message.ok === true ? 200 : (message.error === "etag_mismatch" ? 409 : 400),
    };
    waiter.resolve(payload);
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== options.parentOrigin || event.source !== window.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    deliver(data as Record<string, unknown>);
  };

  if (bindWindow && typeof window !== "undefined") {
    window.addEventListener("message", onMessage);
  }

  const call = (
    type: string,
    extra: Record<string, unknown>,
    kind: "list" | "mutation",
  ): Promise<MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }> => {
    const requestId = `m${nextId++}`;
    let resolve!: (value: MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }) => void;
    const promise = new Promise<MacroRecordPayloadLike & { ok?: boolean; error?: string; status?: number }>((res) => {
      resolve = res;
    });
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ ok: false, error: "link_down", status: 0 });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer, kind });
    if (bindWindow && typeof window !== "undefined") {
      window.parent.postMessage(
        {
          type,
          requestId,
          characterId: options.characterId,
          ...extra,
        },
        options.parentOrigin,
      );
    }
    return promise;
  };

  // Announce readiness so the parent can push the first full list.
  if (bindWindow && typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage(
      { type: "successor.macros.ready.v1", characterId: options.characterId },
      options.parentOrigin,
    );
  }

  return {
    list: () => call("successor.macros.list.v1", {}, "list"),
    save: (input) => call("successor.macros.save.v1", {
      etag: input.etag,
      macro: { id: input.id, name: input.name, iconId: input.iconId, body: input.body },
    }, "mutation"),
    delete: (input) => call("successor.macros.delete.v1", {
      etag: input.etag,
      macroId: input.macroId,
    }, "mutation"),
    __deliverForTest: deliver,
    __mutationInFlightForTest: () => {
      let count = 0;
      for (const waiter of pending.values()) {
        if (waiter.kind === "mutation") count += 1;
      }
      return count;
    },
  };
}
