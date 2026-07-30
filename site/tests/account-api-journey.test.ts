import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/client";
import type { ApiResult, SessionInfo } from "../src/api/types";
import { initAccountPage } from "../src/features/account";
import { mountPage, settle } from "./helpers";

const session: SessionInfo = {
  callsign: "wolf-friend",
  setup: { characterCount: 0, maxCharacters: 5 },
  legal: { terms: "2026-07-24", privacy: "2026-07-24" },
  status: "active",
};

function ok<T>(value: T): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function rejected<T>(): Promise<ApiResult<T>> {
  return Promise.resolve({
    ok: false,
    error: { kind: "rejected", status: 401, code: "invalid_session", message: "Your session expired. Sign in again." },
  });
}

function fill(id: string, value: string): void {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  input.value = value;
}

describe("new account browser journey", () => {
  it("shows the authenticated account panel after a successful register without reload", async () => {
    mountPage("account/index.html");
    let authenticated = false;
    const api = {
      session: vi.fn(() => (authenticated ? ok(session) : rejected<SessionInfo>())),
      register: vi.fn(() => {
        authenticated = true;
        return ok(session);
      }),
      login: vi.fn(() => rejected<SessionInfo>()),
      logout: vi.fn(() => ok(undefined)),
      characters: vi.fn(() => ok({ characters: [] })),
      createCharacter: vi.fn(() => rejected()),
      playTicket: vi.fn(() => rejected()),
      deviceDecision: vi.fn(() => rejected()),
      deviceList: vi.fn(() => ok({ devices: [] })),
      deviceRevoke: vi.fn(() => ok(undefined)),
      deleteAccount: vi.fn(() => rejected()),
    } as unknown as Api;

    initAccountPage(document, api);
    await settle();
    fill("reg-callsign", "wolf-friend");
    fill("reg-password", "long-enough-pw");
    fill("reg-password-repeat", "long-enough-pw");
    const legal = document.getElementById("reg-legal");
    if (legal instanceof HTMLInputElement) legal.checked = true;
    document.getElementById("register-form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(document.body.dataset.sessionState).toBe("active"));
    expect(document.getElementById("auth-benches")?.hidden).toBe(true);
    expect(document.getElementById("roster-section")?.hidden).toBe(false);
    expect(document.querySelector('[data-slot="session-callsign"]')?.textContent).toBe("wolf-friend");
    expect(document.querySelector("#register-form .form-status")?.textContent).toContain("Account created");
    expect(api.session).toHaveBeenCalledTimes(2);
    expect(api.characters).toHaveBeenCalled();
    expect(api.deviceList).toHaveBeenCalled();
  });
});
