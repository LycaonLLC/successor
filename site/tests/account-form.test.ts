import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/client";
import type { ApiResult } from "../src/api/types";
import { initAccountPage } from "../src/features/account";
import { mountPage, settle } from "./helpers";

function ok<T>(value: T): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function unavailable<T>(): Promise<ApiResult<T>> {
  return Promise.resolve({
    ok: false,
    error: { kind: "unavailable", message: "The account service is not reachable from this page yet. Nothing was changed." },
  });
}

const signedOut = (): Promise<ApiResult<never>> =>
  Promise.resolve({
    ok: false,
    error: { kind: "rejected", status: 401, code: "unauthenticated", message: "Sign in first." },
  });

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    session: vi.fn(() => signedOut()),
    register: vi.fn(() => unavailable()),
    login: vi.fn(() => unavailable()),
    logout: vi.fn(() => ok(undefined)),
    characters: vi.fn(() => ok({ characters: [] })),
    createCharacter: vi.fn(() => unavailable()),
    playTicket: vi.fn(() => unavailable()),
    deviceDecision: vi.fn(() => unavailable()),
    deviceList: vi.fn(() => ok({ devices: [] })),
    deviceRevoke: vi.fn(() => ok(undefined)),
    deleteAccount: vi.fn(() => unavailable()),
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

function fillValidRegistration(): void {
  fill("reg-callsign", "wolf-friend");
  fill("reg-password", "long-enough-pw");
  fill("reg-password-repeat", "long-enough-pw");
  const legal = document.getElementById("reg-legal");
  if (legal instanceof HTMLInputElement) legal.checked = true;
}

describe("account forms", () => {
  beforeEach(() => {
    mountPage("account/index.html");
  });

  it("register blocks mismatched passwords before any network call", async () => {
    const api = makeApi();
    initAccountPage(document, api);
    await settle();
    fill("reg-callsign", "wolf-friend");
    fill("reg-password", "long-enough-pw");
    fill("reg-password-repeat", "different-pw!!");
    const legal = document.getElementById("reg-legal");
    if (legal instanceof HTMLInputElement) legal.checked = true;
    submit("register-form");
    await settle();
    expect(api.register).not.toHaveBeenCalled();
    const field = document.getElementById("reg-password-repeat")?.closest(".field");
    expect(field?.querySelector(".field-error")?.textContent).toBe("These do not match.");
  });

  it("register requires the legal acceptance box", async () => {
    const api = makeApi();
    initAccountPage(document, api);
    await settle();
    fill("reg-callsign", "wolf-friend");
    fill("reg-password", "long-enough-pw");
    fill("reg-password-repeat", "long-enough-pw");
    submit("register-form");
    await settle();
    expect(api.register).not.toHaveBeenCalled();
    expect(document.querySelector('.field-error[data-for="reg-legal"]')?.textContent).toContain(
      "Required",
    );
  });

  it("register sends the accepted legal versions", async () => {
    const session = { callsign: "wolf-friend", setup: { characterCount: 0, maxCharacters: 5 } };
    const api = makeApi({
      register: vi.fn(() => ok(session)),
      session: vi.fn(() => ok(session)),
    });
    initAccountPage(document, api);
    await settle();
    fillValidRegistration();
    submit("register-form");
    await vi.waitFor(() => expect(api.register).toHaveBeenCalledTimes(1));
    expect(api.register).toHaveBeenCalledWith({
      callsign: "wolf-friend",
      password: "long-enough-pw",
      legal: { terms: "2026-07-24", privacy: "2026-07-24" },
    });
  });

  it("an unreachable service shows the honest notice and re-enables the button", async () => {
    const api = makeApi();
    initAccountPage(document, api);
    await settle();
    fill("login-callsign", "wolf");
    fill("login-password", "long-enough-pw");
    submit("login-form");
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledTimes(1));
    await settle();
    const status = document.getElementById("api-status");
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toContain("not reachable");
    const button = document.querySelector<HTMLButtonElement>('#login-form button[type="submit"]');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("Sign in");
  });

  it("a successful sign-in reveals the session panels and fills the callsign", async () => {
    const wolf = { callsign: "wolf", setup: { characterCount: 0, maxCharacters: 5 } };
    let signedIn = false;
    const api = makeApi({
      session: vi.fn(() => (signedIn ? ok(wolf) : signedOut())) as Api["session"],
      login: vi.fn(() => {
        signedIn = true;
        return ok(wolf);
      }),
    });
    initAccountPage(document, api);
    await settle();
    expect(document.body.dataset.sessionState).toBe("none");
    fill("login-callsign", "wolf");
    fill("login-password", "long-enough-pw");
    submit("login-form");
    await vi.waitFor(() => expect(document.body.dataset.sessionState).toBe("active"));
    expect(document.querySelector('[data-slot="session-callsign"]')?.textContent).toBe("wolf");
    expect(document.getElementById("auth-benches")?.hidden).toBe(true);
    expect(document.getElementById("roster-section")?.hidden).toBe(false);
    await vi.waitFor(() =>
      expect(document.getElementById("roster-status")?.textContent).toContain("No characters yet"),
    );
  });
});
