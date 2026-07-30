import { describe, expect, it, vi } from "vitest";
import type { Api } from "../src/api/client";
import type { ApiResult } from "../src/api/types";
import { initConnectPage } from "../src/features/connect";
import { mountPage, settle } from "./helpers";

function ok<T>(value: T): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: true, value });
}

describe("device decision browser contract", () => {
  it("handles the server's 204 decision response and renders approval", async () => {
    mountPage("connect/index.html");
    const api = {
      session: vi.fn(() => ok({ callsign: "wolf", setup: { characterCount: 0, maxCharacters: 5 } })),
      register: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
      characters: vi.fn(),
      createCharacter: vi.fn(),
      playTicket: vi.fn(),
      deviceDecision: vi.fn(() => ok(undefined)),
      deviceList: vi.fn(() => ok({ devices: [] })),
      deviceRevoke: vi.fn(),
      deleteAccount: vi.fn(),
    } as unknown as Api;

    initConnectPage(document, api);
    await settle();
    const input = document.getElementById("device-code");
    if (!(input instanceof HTMLInputElement)) throw new Error("missing device code input");
    input.value = "ABCD1234";
    const form = document.getElementById("device-decision-form");
    const approve = form?.querySelector<HTMLButtonElement>('button[value="approved"]');
    if (!(form instanceof HTMLFormElement) || !approve) throw new Error("missing decision form");
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: approve }));

    await vi.waitFor(() => expect(document.getElementById("decision-result")?.hidden).toBe(false));
    expect(api.deviceDecision).toHaveBeenCalledWith("ABCD1234", "approved");
    expect(document.getElementById("decision-result")?.textContent).toContain("Approved.");
  });
});
