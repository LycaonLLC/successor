import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/client";
import type { ApiResult, Character, SessionInfo } from "../src/api/types";
import { initAccountPage } from "../src/features/account";
import {
  consumeSelectedCharacterId,
  resetHandoffForTests,
  SELECTED_CHARACTER_KEY,
  storeSelectedCharacterId,
} from "../src/features/characterHandoff";
import { mountPage, settle } from "./helpers";

const session: SessionInfo = {
  callsign: "wolf",
  setup: { characterCount: 0, maxCharacters: 5 },
  legal: { terms: "2026-07-24", privacy: "2026-07-24" },
  status: "active",
};

const appearance = { body: "male" as const, skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null };
const worn = [{ item: "under_bodysuit", colors: ["#89cff0"] }];

const scout: Character = {
  id: "char_aaaa1111bbbb2222",
  name: "Rook",
  initialProfessionId: "scout",
  worldEntryClaimed: false,
  appearance,
  worn,
};

const farmer: Character = {
  id: "char_cccc3333dddd4444",
  name: "Marrow",
  initialProfessionId: "farmer",
  worldEntryClaimed: true,
  appearance,
  worn,
};

function ok<T>(value: T): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function rejected<T>(
  code = "invalid_session",
  message = "Your session expired. Sign in again.",
  status = 401,
): Promise<ApiResult<T>> {
  return Promise.resolve({
    ok: false,
    error: { kind: "rejected", status, code, message },
  });
}

function rejectedSession(
  code = "invalid_session",
  message = "Your session expired. Sign in again.",
  status = 401,
): Promise<ApiResult<SessionInfo>> {
  return rejected<SessionInfo>(code, message, status);
}

function unavailable<T>(
  message = "The account service is not reachable from this page yet. Nothing was changed.",
): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: false, error: { kind: "unavailable", message } });
}

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    session: vi.fn(() => ok(session)),
    register: vi.fn(() => rejectedSession()),
    login: vi.fn(() => rejectedSession()),
    logout: vi.fn(() => ok(undefined)),
    characters: vi.fn(() => ok({ characters: [] })),
    createCharacter: vi.fn(() => rejected<never>()),
    playTicket: vi.fn(() => rejected<never>()),
    deviceDecision: vi.fn(() => rejected<never>()),
    deviceList: vi.fn(() => ok({ devices: [] })),
    deviceRevoke: vi.fn(() => ok(undefined)),
    deleteAccount: vi.fn(() => rejected<never>()),
    ...overrides,
  } as Api;
}

function fill(id: string, value: string): void {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${id}`);
  el.value = value;
}

function submit(formId: string): void {
  const form = document.getElementById(formId);
  if (!(form instanceof HTMLFormElement)) throw new Error(`no form ${formId}`);
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetHandoffForTests();
  mountPage("account/index.html");
});

describe("account roster states", () => {
  it("shows empty roster copy and no enter controls", async () => {
    const api = makeApi({ characters: vi.fn(() => ok({ characters: [] })) });
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.getElementById("roster-status")?.textContent).toContain("No characters yet");
    expect(document.querySelectorAll("#roster-list .roster-launch")).toHaveLength(0);
  });

  it("renders one character as waiting to enter with an Enter control", async () => {
    const api = makeApi({ characters: vi.fn(() => ok({ characters: [scout] })) });
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.getElementById("roster-status")?.textContent).toContain("1 of 5");
    const rows = document.querySelectorAll("#roster-list .roster-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain("Rook");
    expect(rows[0]?.textContent).toMatch(/waiting to enter/i);
    const enter = rows[0]?.querySelector(".roster-launch");
    expect(enter instanceof HTMLButtonElement).toBe(true);
    expect(enter?.getAttribute("aria-label")).toContain("Rook");
  });

  it("renders many characters with pending and entered states", async () => {
    const api = makeApi({ characters: vi.fn(() => ok({ characters: [scout, farmer] })) });
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.getElementById("roster-status")?.textContent).toContain("2 of 5");
    const metas = [...document.querySelectorAll("#roster-list .roster-meta")].map((el) => el.textContent);
    expect(metas.some((m) => m?.includes("waiting to enter"))).toBe(true);
    expect(metas.some((m) => m?.includes("in the world"))).toBe(true);
    expect(document.querySelectorAll("#roster-list .roster-launch")).toHaveLength(2);
  });

  it("stores a one-shot handoff and navigates on explicit Enter", async () => {
    const navigate = vi.fn();
    const api = makeApi({ characters: vi.fn(() => ok({ characters: [scout, farmer] })) });
    initAccountPage(document, api, navigate);
    await settle();
    await settle();
    const enter = document.querySelector<HTMLButtonElement>("#roster-list .roster-launch");
    expect(enter).not.toBeNull();
    enter?.click();
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBe(scout.id);
    expect(navigate).toHaveBeenCalledWith("/play/");
    // Navigation is mocked, so /play/ has not consumed the direct-entry
    // handoff or minted its ticket yet.
    expect(api.playTicket).not.toHaveBeenCalled();
  });
});

describe("account session recovery", () => {
  it("recovers a stale session by showing the sign-in benches", async () => {
    const api = makeApi({
      session: vi.fn(() =>
        rejectedSession("invalid_session", "Your session expired. Sign in again."),
      ),
    });
    initAccountPage(document, api);
    await settle();
    expect(document.body.dataset.sessionState).toBe("none");
    expect(document.getElementById("auth-benches")?.hidden).toBe(false);
    expect(document.getElementById("roster-section")?.hidden).toBe(true);
    expect(document.getElementById("creator-section")?.hidden).toBe(true);
  });

  it("shows player-language copy for rejected credentials", async () => {
    const api = makeApi({
      session: vi.fn(() => rejectedSession()),
      login: vi.fn(() =>
        rejectedSession("invalid_credentials", "Callsign or password did not match.", 401),
      ),
    });
    initAccountPage(document, api);
    await settle();
    fill("login-callsign", "wolf");
    fill("login-password", "wrong-password");
    submit("login-form");
    await settle();
    await settle();
    expect(document.querySelector("#login-form .form-status")?.textContent).toBe(
      "Callsign or password did not match.",
    );
    expect(document.querySelector("#login-form .form-status")?.classList.contains("is-error")).toBe(
      true,
    );
    expect(document.body.dataset.sessionState).toBe("none");
  });

  it("surfaces API failure on roster load and retries", async () => {
    let fail = true;
    const characters = vi.fn(() =>
      fail ? unavailable<{ characters: Character[] }>() : ok({ characters: [scout] }),
    );
    const api = makeApi({ characters });
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.getElementById("roster-status")?.textContent).toMatch(/Could not load/i);
    const retry = document.getElementById("roster-retry");
    expect(retry instanceof HTMLButtonElement && retry.hidden).toBe(false);
    fail = false;
    retry?.dispatchEvent(new Event("click", { bubbles: true }));
    await settle();
    await settle();
    expect(document.querySelectorAll("#roster-list .roster-row")).toHaveLength(1);
    expect(document.getElementById("roster-retry")?.hidden).toBe(true);
  });

  it("logs out and returns to the benches with focus on callsign", async () => {
    let authenticated = true;
    const api = makeApi({
      session: vi.fn(() => (authenticated ? ok(session) : rejectedSession())),
      characters: vi.fn(() => ok({ characters: [scout] })),
      logout: vi.fn(() => {
        authenticated = false;
        return ok(undefined);
      }),
    });
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.body.dataset.sessionState).toBe("active");
    const logout = document.getElementById("logout-button");
    if (!(logout instanceof HTMLButtonElement)) throw new Error("missing logout");
    logout.click();
    await settle();
    await settle();
    expect(document.body.dataset.sessionState).toBe("none");
    expect(document.getElementById("auth-benches")?.hidden).toBe(false);
    expect(document.activeElement?.id).toBe("login-callsign");
  });
});

describe("handoff storage denial and secrets", () => {
  it("keeps a one-shot in-memory handoff when sessionStorage throws", () => {
    const setItem = vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    const getItem = vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new DOMException("Denied", "SecurityError");
    });
    expect(storeSelectedCharacterId(window, scout.id)).toBe(true);
    expect(consumeSelectedCharacterId(window)).toBe(scout.id);
    expect(consumeSelectedCharacterId(window)).toBeNull();
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it("never writes character ids into the account page URL", async () => {
    const navigate = vi.fn();
    const api = makeApi({ characters: vi.fn(() => ok({ characters: [scout] })) });
    initAccountPage(document, api, navigate);
    await settle();
    await settle();
    document.querySelector<HTMLButtonElement>("#roster-list .roster-launch")?.click();
    expect(navigate).toHaveBeenCalledWith("/play/");
    expect(String(navigate.mock.calls[0]?.[0])).not.toMatch(/char_|ticket|csrf|token/i);
    expect(window.location.href).not.toMatch(/char_|ticket|csrf/i);
  });

  it("marks invalid fields for assistive tech and moves focus there", async () => {
    const api = makeApi({ session: vi.fn(() => rejectedSession()) });
    initAccountPage(document, api);
    await settle();
    submit("login-form");
    await settle();
    const callsign = document.getElementById("login-callsign");
    expect(callsign?.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(callsign);
  });
});
