// The account page's character workshop bridge: exact-origin postMessage,
// safe roster state out, create/select in, one-shot handoff to /play/.
import { beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { Api } from "../src/api/client";
import type { ApiResult, Character, CreateCharacterInput } from "../src/api/types";
import { initAccountPage } from "../src/features/account";
import { SELECTED_CHARACTER_KEY, resetHandoffForTests } from "../src/features/characterHandoff";
import {
  CREATOR_CREATE_RESULT_TYPE,
  CREATOR_CREATE_TYPE,
  CREATOR_READY_TYPE,
  CREATOR_READY_TIMEOUT_MS,
  CREATOR_SELECT_TYPE,
  CREATOR_STATE_TYPE,
  initCreatorStage,
} from "../src/features/creator";
import { RUNTIME_POINTER_SCHEMA } from "../src/features/runtimePointer";
import { mountPage, settle } from "./helpers";

const ENTRY = "https://runtime.example/releases/0f3a/index.html";
const ORIGIN = "https://runtime.example";

const APPEARANCE = {
  skinTone: "#b98a5e",
  hair: "hair_mop",
  hairMat: "hair_raven",
  face: {
    eyes: "stoic",
    brows: "stoic",
    nose: "stoic",
    mouth: "stoic",
    eyeColor: "#7eb7c7",
    browColor: "#171313",
    lipColor: "#74443f",
  },
};

// Boundary fixture: what the server may report, including fields the child
// must never see. The extra keys make the type unrepresentable on purpose.
const ROOK = {
  id: "char_1234abcd5678ef90",
  name: "Rook",
  initialProfessionId: "scout",
  worldEntryClaimed: false,
  appearance: APPEARANCE,
  worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
  ownerRef: "acct-nope",
  sessionHint: "never",
} as unknown as Character;

const SAFE_ROOK = {
  id: "char_1234abcd5678ef90",
  name: "Rook",
  initialProfessionId: "scout",
  worldEntryClaimed: false,
  appearance: APPEARANCE,
  worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
};

/** Every message the parent posts into the workshop frame. */
interface OutMessage {
  type: string;
  characters?: { name: string }[];
  requestId?: string;
  ok?: boolean;
  error?: string;
}

function ok<T>(value: T): Promise<ApiResult<T>> {
  return Promise.resolve({ ok: true, value });
}

function stubPointer(body: unknown = { schema: RUNTIME_POINTER_SCHEMA, entry: ENTRY }, status = 200): Mock {
  // A fresh Response per call: bodies are one-read, and the stage may
  // fetch the pointer again after retry or re-login.
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

interface Rig {
  api: Api;
  navigate: Mock<(path: string) => void>;
  createCharacter: Mock<(input: CreateCharacterInput) => Promise<ApiResult<Character>>>;
}

function makeRig(roster: Character[]): Rig {
  const createCharacter = vi.fn<(input: CreateCharacterInput) => Promise<ApiResult<Character>>>(
    (input) => {
      const created: Character = {
        id: "char_new0000new0000aa",
        name: input.name,
        initialProfessionId: input.initialProfessionId,
        worldEntryClaimed: false,
        appearance: input.appearance,
        worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
      };
      roster.push(created);
      return ok(created);
    },
  );
  const api = {
    session: vi.fn(() => ok({ callsign: "wolf", setup: { characterCount: roster.length, maxCharacters: 5 } })),
    characters: vi.fn(() => ok({ characters: [...roster] })),
    createCharacter,
    logout: vi.fn(),
    deviceList: vi.fn(() => ok({ devices: [] })),
  } as unknown as Api;
  return { api, navigate: vi.fn<(path: string) => void>(), createCharacter };
}

function frameWindow(iframe: HTMLIFrameElement): Window {
  if (!iframe.contentWindow) throw new Error("workshop frame has no window");
  return iframe.contentWindow;
}

function retryButton(): HTMLButtonElement {
  const el = document.getElementById("creator-retry");
  if (!(el instanceof HTMLButtonElement)) throw new Error("missing retry button");
  return el;
}

function stageState(): string | undefined {
  return document.getElementById("creator-stage")?.dataset.stageState;
}

async function mountWorkshop(rig: Rig): Promise<HTMLIFrameElement> {
  mountPage("account/index.html");
  initAccountPage(document, rig.api, rig.navigate);
  await settle();
  await settle();
  const iframe = document.querySelector<HTMLIFrameElement>("#creator-stage iframe");
  if (!iframe) throw new Error("workshop iframe missing");
  return iframe;
}

function post(iframe: HTMLIFrameElement, data: unknown, origin: string = ORIGIN, source?: Window | null): void {
  window.dispatchEvent(
    new MessageEvent("message", { origin, source: source === undefined ? frameWindow(iframe) : source, data }),
  );
}

type PostSpy = MockInstance<Window["postMessage"]>;

function spyPost(iframe: HTMLIFrameElement): PostSpy {
  return vi.spyOn(frameWindow(iframe), "postMessage");
}

/** Collects posted payloads of one type, with targetOrigin verified. */
function sent(spy: PostSpy, type: string): OutMessage[] {
  const out: OutMessage[] = [];
  for (const call of spy.mock.calls) {
    const payload: unknown = call[0];
    if (payload === null || typeof payload !== "object" || !("type" in payload)) continue;
    if (payload.type !== type) continue;
    expect(call[1]).toBe(ORIGIN);
    // Guarded above; the payload shape is the parent's own outbound message.
    out.push(payload as OutMessage);
  }
  return out;
}

async function readyWorkshop(rig: Rig): Promise<{ iframe: HTMLIFrameElement; postMessage: PostSpy }> {
  const iframe = await mountWorkshop(rig);
  const postMessage = spyPost(iframe);
  post(iframe, { type: CREATOR_READY_TYPE });
  await settle();
  return { iframe, postMessage };
}

beforeEach(() => {
  window.sessionStorage.clear();
  resetHandoffForTests();
  vi.unstubAllGlobals();
});

describe("creator stage boot", () => {
  it("hosts the immutable runtime with the public creator mode flag only", async () => {
    const fetchMock = stubPointer();
    const iframe = await mountWorkshop(makeRig([ROOK]));
    expect(fetchMock).toHaveBeenCalledWith("/client/release.json", { cache: "no-store" });
    expect(iframe.src).toBe(`${ENTRY}?mode=creator`);
    // Nothing secret rides the URL: no ids, tickets, tokens, or callsigns.
    expect(iframe.src).not.toMatch(/char_|ticket|token|csrf|wolf/i);
    expect(iframe.title).toBe("Character workshop");
    expect(stageState()).toBe("loading");
  });

  it("preserves an existing entry query while appending the mode", async () => {
    stubPointer({ schema: RUNTIME_POINTER_SCHEMA, entry: `${ENTRY}?v=2` });
    const iframe = await mountWorkshop(makeRig([]));
    expect(iframe.src).toBe(`${ENTRY}?v=2&mode=creator`);
  });

  it("shows the honest unavailable state on a bad pointer — never the old plain form", async () => {
    stubPointer({ entry: ENTRY }); // no schema: rejected
    const rig = makeRig([ROOK]);
    mountPage("account/index.html");
    initAccountPage(document, rig.api);
    await settle();
    await settle();
    expect(document.querySelector("#creator-stage iframe")).toBeNull();
    expect(stageState()).toBe("unavailable");
    expect(document.getElementById("creator-status")?.textContent).toContain("not reachable");
    expect(retryButton().hidden).toBe(false);
    // The plain creation form is gone for good, not a silent fallback.
    expect(document.getElementById("create-character-form")).toBeNull();
    expect(document.getElementById("char-name")).toBeNull();
  });

  it("recovers through the retry action once the pointer is publishable", async () => {
    stubPointer({}, 404);
    const rig = makeRig([ROOK]);
    mountPage("account/index.html");
    initAccountPage(document, rig.api);
    await settle();
    await settle();
    expect(stageState()).toBe("unavailable");
    stubPointer();
    retryButton().click();
    await settle();
    await settle();
    expect(document.querySelector<HTMLIFrameElement>("#creator-stage iframe")?.src).toBe(`${ENTRY}?mode=creator`);
  });

  it("gives up on a runtime that never says ready, with retry offered", async () => {
    vi.useFakeTimers();
    try {
      stubPointer();
      const rig = makeRig([ROOK]);
      mountPage("account/index.html");
      const stage = initCreatorStage(document, rig.api);
      stage.activate();
      await vi.advanceTimersByTimeAsync(CREATOR_READY_TIMEOUT_MS + 1);
      expect(stageState()).toBe("unavailable");
      expect(document.querySelector("#creator-stage iframe")).toBeNull();
      expect(retryButton().hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("creator protocol bridge", () => {
  it("answers ready with the whitelisted roster state at the exact origin", async () => {
    stubPointer();
    const { postMessage } = await readyWorkshop(makeRig([ROOK]));
    expect(postMessage).toHaveBeenCalledTimes(1);
    const states = sent(postMessage, CREATOR_STATE_TYPE);
    expect(states).toHaveLength(1);
    // ownerRef / sessionHint never cross the boundary; exact equality proves it.
    expect(states[0]).toEqual({ type: CREATOR_STATE_TYPE, characters: [SAFE_ROOK] });
    expect(stageState()).toBe("live");
  });

  it("ignores messages from the wrong origin or the wrong window", async () => {
    stubPointer();
    const iframe = await mountWorkshop(makeRig([ROOK]));
    const postMessage = spyPost(iframe);
    post(iframe, { type: CREATOR_READY_TYPE }, "https://runtime.evil");
    post(iframe, { type: CREATOR_READY_TYPE }, ORIGIN, window);
    post(iframe, { type: CREATOR_READY_TYPE }, ORIGIN, null);
    await settle();
    expect(postMessage).not.toHaveBeenCalled();
    expect(stageState()).toBe("loading");
  });

  it("creates through the parent's same-origin API and reports the result", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    const { iframe, postMessage } = await readyWorkshop(rig);
    post(iframe, {
      type: CREATOR_CREATE_TYPE,
      requestId: "req-1",
      character: { name: "Vex-Marrow", initialProfessionId: "brawler", appearance: APPEARANCE, extra: "dropped" },
    });
    await settle();
    expect(rig.createCharacter).toHaveBeenCalledTimes(1);
    expect(rig.createCharacter.mock.calls[0]?.[0]).toEqual({
      name: "Vex-Marrow",
      initialProfessionId: "brawler",
      appearance: APPEARANCE,
      worn: [
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ],
    });
    expect(sent(postMessage, CREATOR_CREATE_RESULT_TYPE)).toEqual([
      { type: CREATOR_CREATE_RESULT_TYPE, requestId: "req-1", ok: true },
    ]);
    // Success is followed by refreshed state carrying the new character.
    const states = sent(postMessage, CREATOR_STATE_TYPE);
    expect(states).toHaveLength(2);
    expect(states[1]?.characters?.map((c) => c.name)).toEqual(["Rook", "Vex-Marrow"]);
    // The page's own roster list re-rendered too.
    await settle();
    expect(document.getElementById("roster-list")?.textContent).toContain("Vex-Marrow");
  });

  it("returns the mapped error copy when the service refuses a create", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    rig.createCharacter.mockResolvedValue({
      ok: false,
      error: { kind: "rejected", status: 409, code: "name_taken", message: "That character name is already in use." },
    });
    const { iframe, postMessage } = await readyWorkshop(rig);
    post(iframe, {
      type: CREATOR_CREATE_TYPE,
      requestId: "req-2",
      character: { name: "Rook", initialProfessionId: "scout", appearance: APPEARANCE },
    });
    await settle();
    expect(sent(postMessage, CREATOR_CREATE_RESULT_TYPE)).toEqual([
      { type: CREATOR_CREATE_RESULT_TYPE, requestId: "req-2", ok: false, error: "That character name is already in use." },
    ]);
    expect(sent(postMessage, CREATOR_STATE_TYPE)).toHaveLength(1);
  });

  it("rejects a bad name locally without spending an API call", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    const { iframe, postMessage } = await readyWorkshop(rig);
    post(iframe, {
      type: CREATOR_CREATE_TYPE,
      requestId: "req-3",
      character: { name: "R2-D2", initialProfessionId: "scout", appearance: APPEARANCE },
    });
    await settle();
    expect(rig.createCharacter).not.toHaveBeenCalled();
    expect(sent(postMessage, CREATOR_CREATE_RESULT_TYPE)).toEqual([
      { type: CREATOR_CREATE_RESULT_TYPE, requestId: "req-3", ok: false, error: "3–16 letters, with internal hyphens only." },
    ]);
  });

  it("drops malformed or unknown messages without any reply", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    const { iframe, postMessage } = await readyWorkshop(rig);
    postMessage.mockClear();
    post(iframe, { type: CREATOR_CREATE_TYPE }); // no requestId/character
    post(iframe, {
      type: CREATOR_CREATE_TYPE,
      requestId: "x".repeat(65),
      character: { name: "Rook", initialProfessionId: "scout", appearance: APPEARANCE },
    });
    post(iframe, {
      type: CREATOR_CREATE_TYPE,
      requestId: "req-4",
      character: { name: "Rook", initialProfessionId: "scout", appearance: { skinTone: "#fff" } },
    });
    post(iframe, { type: "successor.creator.debug.v1", payload: "?" });
    post(iframe, "just a string");
    post(iframe, null);
    await settle();
    expect(rig.createCharacter).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe("ENTER WORLD handoff", () => {
  it("stores the versioned one-shot id and navigates to /play/", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    const { iframe } = await readyWorkshop(rig);
    post(iframe, { type: CREATOR_SELECT_TYPE, characterId: ROOK.id });
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBe(ROOK.id);
    // The id under the versioned key is the only thing storage ever holds.
    expect(window.sessionStorage.length).toBe(1);
    expect(rig.navigate).toHaveBeenCalledWith("/play/");
  });

  it("refuses unknown or malformed character ids", async () => {
    stubPointer();
    const rig = makeRig([ROOK]);
    const { iframe } = await readyWorkshop(rig);
    post(iframe, { type: CREATOR_SELECT_TYPE, characterId: "char_notmine00000000" });
    post(iframe, { type: CREATOR_SELECT_TYPE, characterId: { evil: true } });
    post(iframe, { type: CREATOR_SELECT_TYPE });
    post(iframe, { type: CREATOR_SELECT_TYPE, characterId: "../../etc" });
    expect(window.sessionStorage.getItem(SELECTED_CHARACTER_KEY)).toBeNull();
    expect(rig.navigate).not.toHaveBeenCalled();
  });
});

describe("session lifecycle", () => {
  function fill(id: string, value: string): void {
    const el = document.getElementById(id);
    if (!(el instanceof HTMLInputElement)) throw new Error(`missing input ${id}`);
    el.value = value;
  }

  it("tears the workshop down on logout and reactivates on the next sign-in", async () => {
    stubPointer();
    let authenticated = true;
    const session = { callsign: "wolf", setup: { characterCount: 1, maxCharacters: 5 } };
    const signedOut = Promise.resolve({
      ok: false as const,
      error: { kind: "rejected" as const, status: 401, code: "invalid_session", message: "Your session expired. Sign in again." },
    });
    const api = {
      session: vi.fn(() => (authenticated ? ok(session) : signedOut)),
      characters: vi.fn(() => ok({ characters: [ROOK] })),
      createCharacter: vi.fn(),
      login: vi.fn(() => {
        authenticated = true;
        return ok(session);
      }),
      logout: vi.fn(() => {
        authenticated = false;
        return ok(undefined);
      }),
      deviceList: vi.fn(() => ok({ devices: [] })),
    } as unknown as Api;
    mountPage("account/index.html");
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.querySelector("#creator-stage iframe")).not.toBeNull();

    const logout = document.getElementById("logout-button");
    if (!(logout instanceof HTMLButtonElement)) throw new Error("missing logout button");
    logout.click();
    await settle();
    await settle();
    // Frame, listener, and the child's roster copy die with the session.
    expect(document.querySelector("#creator-stage iframe")).toBeNull();
    expect(stageState()).toBe("loading");
    expect(retryButton().hidden).toBe(true);

    fill("login-callsign", "wolf");
    fill("login-password", "long-enough-pw");
    const loginForm = document.getElementById("login-form");
    if (!(loginForm instanceof HTMLFormElement)) throw new Error("missing login form");
    loginForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await settle();
    await settle();
    const revived = document.querySelector<HTMLIFrameElement>("#creator-stage iframe");
    expect(revived).not.toBeNull();
    if (!revived) return;
    const postMessage = spyPost(revived);
    post(revived, { type: CREATOR_READY_TYPE });
    await settle();
    expect(sent(postMessage, CREATOR_STATE_TYPE)).toHaveLength(1);
    expect(stageState()).toBe("live");
  });

  it("lands a fresh registration on the workshop stage without activation scroll", async () => {
    stubPointer();
    let authenticated = false;
    const session = { callsign: "wolf-friend", setup: { characterCount: 0, maxCharacters: 5 } };
    const api = {
      session: vi.fn(() =>
        authenticated
          ? ok(session)
          : Promise.resolve({
              ok: false as const,
              error: { kind: "rejected" as const, status: 401, code: "unauthenticated", message: "Sign in first." },
            }),
      ),
      characters: vi.fn(() => ok({ characters: [] })),
      register: vi.fn(() => {
        authenticated = true;
        return ok(session);
      }),
      createCharacter: vi.fn(),
      deviceList: vi.fn(() => ok({ devices: [] })),
    } as unknown as Api;
    mountPage("account/index.html");
    initAccountPage(document, api);
    await settle();
    await settle();
    // Signed out: the stage section stays hidden and nothing is mounted.
    const section = document.getElementById("creator-section");
    if (!(section instanceof HTMLElement)) throw new Error("missing creator section");
    expect(section.hidden).toBe(true);
    expect(document.querySelector("#creator-stage iframe")).toBeNull();
    const scrolled = vi.spyOn(section, "scrollIntoView").mockImplementation(() => {});
    const heading = document.getElementById("h-creator");
    if (!(heading instanceof HTMLElement)) throw new Error("missing creator heading");
    const focused = vi.spyOn(heading, "focus");

    fill("reg-callsign", "wolf-friend");
    fill("reg-password", "long-enough-pw");
    fill("reg-password-repeat", "long-enough-pw");
    const legal = document.getElementById("reg-legal");
    if (!(legal instanceof HTMLInputElement)) throw new Error("missing legal checkbox");
    legal.checked = true;
    const registerForm = document.getElementById("register-form");
    if (!(registerForm instanceof HTMLFormElement)) throw new Error("missing register form");
    registerForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await settle();
    await settle();

    // Active: the section is revealed, the workshop mounts, and focus moves
    // to the workshop heading without scrolling the page.
    expect(section.hidden).toBe(false);
    expect(document.querySelector("#creator-stage iframe")).not.toBeNull();
    expect(scrolled).not.toHaveBeenCalled();
    expect(focused).toHaveBeenCalled();
  });

  it("never mounts the workshop for a signed-out visit", async () => {
    stubPointer();
    const api = {
      session: vi.fn(() =>
        Promise.resolve({
          ok: false as const,
          error: { kind: "rejected" as const, status: 401, code: "invalid_session", message: "Sign in first." },
        }),
      ),
      characters: vi.fn(),
      deviceList: vi.fn(),
    } as unknown as Api;
    mountPage("account/index.html");
    initAccountPage(document, api);
    await settle();
    await settle();
    expect(document.querySelector("#creator-stage iframe")).toBeNull();
    expect(api.characters).not.toHaveBeenCalled();
  });
});
