// Same-origin /alpha-api/* client. Auth lives in an HttpOnly cookie the
// browser manages; the CSRF token lives in this module's memory and nowhere
// else — never in browser storage and never in a script-readable cookie.
import type {
  ApiError,
  ApiResult,
  Character,
  CharacterList,
  CreateCharacterInput,
  DeviceList,
  LaunchContext,
  LoginInput,
  MacroListPayload,
  RegisterInput,
  SessionInfo,
} from "./types";

const BASE = "/alpha-api";
const UNAVAILABLE_MESSAGE =
  "The account service is not reachable from this page yet. Nothing was changed.";
const ERROR_MESSAGES: Record<string, string> = {
  invalid_session: "Your session expired. Sign in again.",
  invalid_request: "Some details need another look. Check the fields and try again.",
  invalid_credentials: "Callsign or password did not match.",
  login_failed: "Callsign or password did not match.",
  callsign_taken: "That callsign is already in use.",
  registration_cap: "Registration is currently full. Please try again later.",
  registration_closed: "Registration is closed right now.",
  registration_failed: "Could not create that account. Try again in a moment.",
  legal_required: "Accept the terms and privacy note to continue.",
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  device_not_found: "That device is no longer available.",
  character_not_found: "That character is no longer available.",
  invalid_name: "Use 3–16 letters with optional internal hyphens.",
  name_taken: "That character name is already in use.",
  slots_full: "All character slots are full.",
  invalid_auth: "Your session expired. Sign in again.",
  macro_rate_limited: "Macro changes are temporarily limited. Try again shortly.",
  etag_mismatch: "Macros changed elsewhere. The list was refreshed.",
  etag_required: "Macro sync is not ready yet. Try again.",
  invalid_macro: "That macro could not be saved.",
  macro_not_found: "That macro is no longer available.",
  macro_limit_exceeded: "Macro storage is full for this character.",
  macro_too_large: "That macro is too large to save.",
};

let csrfToken: string | null = null;

function unavailable<T>(): ApiResult<T> {
  return { ok: false, error: { kind: "unavailable", message: UNAVAILABLE_MESSAGE } };
}

async function parseError(res: Response): Promise<ApiError & { body?: unknown }> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === "object" && "error" in body) {
      const detail = (body as { error?: unknown }).error;
      if (typeof detail === "string") {
        return {
          kind: "rejected",
          status: res.status,
          code: detail,
          message: ERROR_MESSAGES[detail] ?? "The service refused that. Try again in a moment.",
          body,
        };
      }
      if (
        detail !== null &&
        typeof detail === "object" &&
        "message" in detail &&
        typeof detail.message === "string"
      ) {
        const code =
          "code" in detail && typeof detail.code === "string" ? detail.code : "rejected";
        return {
          kind: "rejected",
          status: res.status,
          code,
          message: ERROR_MESSAGES[code] ?? detail.message,
        };
      }
    }
  } catch {
    // Non-JSON error bodies fall through to the generic mapping below.
  }
  if (res.status >= 500) {
    return { kind: "unavailable", message: UNAVAILABLE_MESSAGE };
  }
  return {
    kind: "rejected",
    status: res.status,
    code: "rejected",
    message: "The service refused that. Try again in a moment.",
  };
}

async function requestJson<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
  } catch {
    return unavailable();
  }
  if (res.status >= 500) return unavailable();
  if (!res.ok) return { ok: false, error: await parseError(res) };
  if (res.status === 204) return { ok: true, value: undefined as T };
  try {
    // Boundary cast: /alpha-api/* is same-origin and versioned with this
    // site release; response shapes are owned by the same seal.
    const value = (await res.json()) as T;
    return { ok: true, value };
  } catch {
    return unavailable();
  }
}

function get<T>(path: string): Promise<ApiResult<T>> {
  return requestJson<T>(path, { method: "GET", headers: { accept: "application/json" } });
}

async function fetchCsrf(): Promise<ApiResult<string>> {
  const result = await get<{ csrfToken: string; authenticated: boolean }>("/csrf");
  if (!result.ok) return result;
  csrfToken = result.value.csrfToken;
  return { ok: true, value: result.value.csrfToken };
}

async function mutate<T>(
  path: string,
  body?: unknown,
  method: "POST" | "DELETE" = "POST",
  extraHeaders?: Record<string, string>,
): Promise<ApiResult<T>> {
  if (csrfToken === null) {
    const seeded = await fetchCsrf();
    if (!seeded.ok) return seeded;
  }
  const attempt = () =>
    requestJson<T>(path, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-csrf-token": csrfToken ?? "",
        ...(extraHeaders ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let result = await attempt();
  if (
    !result.ok &&
    result.error.kind === "rejected" &&
    ((result.error.status === 403 && /csrf/i.test(result.error.code)) ||
      (result.error.status === 401 && result.error.code === "invalid_session"))
  ) {
    // Session rotated under us; take one fresh token and retry once.
    csrfToken = null;
    const seeded = await fetchCsrf();
    if (!seeded.ok) return seeded;
    result = await attempt();
  }
  return result;
}

/** Register/login/logout rotate the session; the old CSRF token dies with it. */
async function mutateRotating<T>(
  path: string,
  body?: unknown,
  method: "POST" | "DELETE" = "POST",
): Promise<ApiResult<T>> {
  const result = await mutate<T>(path, body, method);
  if (result.ok) csrfToken = null;
  return result;
}

export const api = {
  session: () => get<SessionInfo>("/session"),
  register: (input: RegisterInput) => mutateRotating<SessionInfo>("/register", input),
  login: (input: LoginInput) => mutateRotating<SessionInfo>("/login", input),
  logout: () => mutateRotating<void>("/logout", {}),
  characters: () => get<CharacterList>("/characters"),
  createCharacter: (input: CreateCharacterInput) => mutate<Character>("/characters", input),
  playTicket: async (characterId: string, clientReleaseId?: string): Promise<ApiResult<LaunchContext>> => {
    const result = await mutate<Omit<LaunchContext, "schema">>("/play-ticket", {
      characterId,
      ...(clientReleaseId ? { clientReleaseId } : {}),
    });
    if (!result.ok) return result;
    return { ok: true, value: { schema: "successor.launch-context.v1", ...result.value } };
  },
  deviceDecision: (userCode: string, decision: "approved" | "denied") =>
    mutate<void>("/device/decision", {
      userCode,
      decision: decision === "approved" ? "approve" : "deny",
    }),
  deviceList: () => get<DeviceList>("/devices"),
  deviceRevoke: (deviceId: string) =>
    mutate<void>(`/devices/${encodeURIComponent(deviceId)}`, undefined, "DELETE"),
  deleteAccount: (password: string) =>
    mutateRotating<{ status: "pending_deletion" }>("/account", { password }, "DELETE"),
  listMacros: (characterId: string) =>
    get<MacroListPayload>(`/characters/${encodeURIComponent(characterId)}/macros`),
  saveMacro: (
    characterId: string,
    macro: { id: string; name: string; iconId: string; body: string },
    etag: string,
  ) =>
    mutate<MacroListPayload>(
      `/characters/${encodeURIComponent(characterId)}/macros`,
      macro,
      "POST",
      { "if-match": etag },
    ),
  deleteMacro: (characterId: string, macroId: string, etag: string) =>
    mutate<MacroListPayload>(
      `/characters/${encodeURIComponent(characterId)}/macros/${encodeURIComponent(macroId)}`,
      {},
      "DELETE",
      { "if-match": etag },
    ),
};

export type Api = typeof api;

/** Test hook: forget the in-memory CSRF token. */
export function resetClientStateForTests(): void {
  csrfToken = null;
}
