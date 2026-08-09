// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CharDollAppearance } from "./charDollPreview";

// Doll preview is WebGL — replace it with a call recorder so the test can
// assert exactly what appearance the create transition renders.
const { dollAppearances } = vi.hoisted(() => ({
  dollAppearances: [] as CharDollAppearance[],
}));

vi.mock("./charDollPreview", () => ({
  mountCharDollPreview: () =>
    Promise.resolve({
      setAppearance: (appearance: CharDollAppearance) => {
        dollAppearances.push(appearance);
      },
      dispose: () => {},
    }),
}));

import { renderCharacterSelect, type CharacterApiRecord, type CharactersResponse } from "./characterSelect";

// A roster character that differs from EVERY canonical creator default:
// dark skin, afro hair, crimson dye, dressed in a dyed tank. If any of this
// bleeds into the + NEW CHARACTER draft, the assertions below name it.
const DRESSED_RECORD: CharacterApiRecord = {
  id: "char-dressed",
  ownerRef: "acct-1",
  name: "Chungas",
  appearance: { body: "female", skinTone: "#4a3223", hair: "hair_afro2", hairMat: "hair_crimson", face: null },
  worn: [{ item: "top_rigged_tank", colors: ["#804040", "#3f7472"] }],
  position: null,
  lastLogoutAt: null,
  lastSeenAt: null,
  totalPlayMs: 0,
  liveState: "offline",
  initialProfessionId: "marksman",
  worldEntryClaimed: true,
};

/** The immutable fixed-issue outfit the create doll must preview. */
const FIXED_WORN = [
  { item: "under_bodysuit", colors: ["#89cff0"] },
  { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
];

const ROSTER_RESPONSE: CharactersResponse = {
  server: { online: true, sessionCount: 0, actorCount: 0 },
  characters: [DRESSED_RECORD],
  limits: { maxCharacters: 3 },
};

const joinFor = (record: CharacterApiRecord) => ({
  ok: true,
  join: {
    player: "local",
    actorId: record.id,
    name: record.name,
    spawnArea: "open-desert-overworld",
    spawnX: 512,
    spawnY: 512,
    facing: "right",
    appearance: record.appearance,
    worn: record.worn ?? [],
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  dollAppearances.length = 0;
  delete window.__successor3dCharacterSelect;
  document.body.innerHTML = "";
});

describe("character creator blank draft", () => {
  it("+ NEW CHARACTER always opens the blank canonical draft, never the selected character", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify(ROSTER_RESPONSE), { status: 200 })),
      ),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    void renderCharacterSelect(root);

    // Roster loaded, dressed character auto-selected, doll wears its outfit.
    await vi.waitFor(() => {
      expect(window.__successor3dCharacterSelect?.characterCount).toBe(1);
      expect(dollAppearances.length).toBeGreaterThan(0);
    });
    expect(window.__successor3dCharacterSelect?.selectedId).toBe("char-dressed");
    const selectedDoll = dollAppearances.at(-1)!;
    expect(selectedDoll.hair).toBe("hair_afro2");
    expect(selectedDoll.worn).toEqual(DRESSED_RECORD.worn);

    // Transition into create mode.
    root.querySelector<HTMLButtonElement>('[data-ref="newButton"]')!.click();

    const probe = window.__successor3dCharacterSelect!;
    expect(dollAppearances.at(-1)?.body).toBe("male");
    expect(probe.mode).toBe("create");
    // Blank canonical draft: SHAVED — no selected appearance, hair, or dye
    // state retained. Clothing is not draft state at all: the doll previews
    // the fixed registry outfit, resolved from the generated wardrobe
    // registry (baby-blue bodysuit + canvas ankle boots). The face draft is
    // the canonical DEFAULT_FACE (stoic set), never the roster character's.
    expect(probe.draftHair).toBeNull();
    expect(probe.draftFace).toEqual({
      eyes: "stoic",
      brows: "stoic",
      nose: "stoic",
      mouth: "stoic",
      eyeColor: "#7eb7c7",
      browColor: "#171313",
      lipColor: "#74443f",
    });
    expect(probe.fixedWorn).toEqual(FIXED_WORN);
    expect(probe.draftName).toBe("");

    const createDoll = dollAppearances.at(-1)!;
    expect(createDoll.hair).toBeNull();
    expect(createDoll.worn).toEqual(FIXED_WORN);
    expect(createDoll.equipmentIds ?? []).toEqual([]);
    expect(createDoll.skinTone).not.toBe(DRESSED_RECORD.appearance.skinTone);
    expect(createDoll.hairMat).not.toBe(DRESSED_RECORD.appearance.hairMat);
    expect(createDoll.face).toEqual(probe.draftFace);
  });

  it("requires an ordinary initial allocation and submits the selected profession with creation", async () => {
    const created: CharacterApiRecord = {
      ...DRESSED_RECORD,
      id: "char-brawler",
      name: "Bruiser",
      initialProfessionId: "brawler",
      worldEntryClaimed: false,
    };
    let registered = false;
    const requests: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/game/characters")) {
        const body = JSON.parse(String(init?.body)) as unknown;
        requests.push({ url, method, body });
        registered = true;
        return new Response(JSON.stringify(created), { status: 201 });
      }
      if (method === "POST" && url.endsWith(`/game/characters/${created.id}/enter`)) {
        return new Response(JSON.stringify(joinFor(created)), { status: 200 });
      }
      return new Response(JSON.stringify({
        ...ROSTER_RESPONSE,
        characters: registered ? [created] : ROSTER_RESPONSE.characters,
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const root = document.createElement("div");
    document.body.appendChild(root);
    const selected = renderCharacterSelect(root);
    await vi.waitFor(() => expect(window.__successor3dCharacterSelect?.characterCount).toBe(1));

    root.querySelector<HTMLButtonElement>('[data-ref="newButton"]')!.click();
    root.querySelectorAll<HTMLButtonElement>('[data-ref="bodyStepper"] button')[1]!.click();
    expect(dollAppearances.at(-1)?.body).toBe("female");
    const createButton = root.querySelector<HTMLButtonElement>('[data-ref="createButton"]')!;
    expect(createButton.disabled).toBe(true);
    expect(window.__successor3dCharacterSelect?.draftInitialProfessionId).toBeNull();

    const nameInput = root.querySelector<HTMLInputElement>('[data-ref="nameInput"]')!;
    nameInput.value = "Bruiser";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>('[data-ref="createProfessionGrid"] [data-profession-id="brawler"]')!.click();
    expect(window.__successor3dCharacterSelect?.draftInitialProfessionId).toBe("brawler");
    expect(createButton.disabled).toBe(false);

    createButton.click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toMatchObject({
      name: "Bruiser",
      initialProfessionId: "brawler",
      appearance: {
        body: "female",
        face: {
          eyes: "stoic",
          brows: "stoic",
          nose: "stoic",
          mouth: "stoic",
          eyeColor: "#7eb7c7",
          browColor: "#171313",
          lipColor: "#74443f",
        },
      },
    });
    // Creation must not choose clothing: no worn key survives in the payload.
    expect(Object.keys(requests[0]!.body as Record<string, unknown>).sort()).toEqual([
      "appearance",
      "initialProfessionId",
      "name",
    ]);
    await vi.waitFor(() => expect(window.__successor3dCharacterSelect?.mode).toBe("select"));
    root.querySelector<HTMLButtonElement>('[data-ref="enterButton"]')!.click();
    await expect(selected).resolves.toMatchObject({ character: { id: created.id } });
  });

  it("offers no wardrobe controls — clothing is a fixed visual fact, not a choice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(ROSTER_RESPONSE), { status: 200 }))),
    );
    const root = document.createElement("div");
    document.body.appendChild(root);
    void renderCharacterSelect(root);
    await vi.waitFor(() => expect(window.__successor3dCharacterSelect?.characterCount).toBe(1));

    root.querySelector<HTMLButtonElement>('[data-ref="newButton"]')!.click();
    const createPanel = root.querySelector<HTMLElement>('[data-panel="create"]')!;
    expect(createPanel.hidden).toBe(false);

    // Every wardrobe surface is gone: per-slot steppers, zone dye rows, the
    // wardrobeSections host itself.
    expect(root.querySelector('[data-ref="wardrobeSections"]')).toBeNull();
    expect(root.querySelectorAll(".sc3d-cs-stepper[data-slot]")).toHaveLength(0);
    expect(root.querySelectorAll(".sc3d-cs-zonelabel")).toHaveLength(0);
    // Appearance steppers: BODY, HAIR, and the four FACE feature steppers —
    // still zero clothing steppers ([data-slot] stays empty).
    expect(root.querySelectorAll(".sc3d-cs-stepper")).toHaveLength(6);
    expect(root.querySelector('[data-ref="bodyStepper"]')).not.toBeNull();
    expect(root.querySelector('[data-ref="hairStepper"]')).not.toBeNull();
    for (const ref of ["faceEyesStepper", "faceBrowsStepper", "faceNoseStepper", "faceMouthStepper"]) {
      expect(root.querySelector(`[data-ref="${ref}"]`)).not.toBeNull();
    }
    expect(root.querySelector('[data-ref="faceRandomize"]')).not.toBeNull();

    // The fixed outfit surfaces only as a static note — zero controls in it.
    const notes = [...createPanel.querySelectorAll(".sc3d-cs-fieldnote")].map((el) => el.textContent ?? "");
    expect(notes.some((text) => /registry bodysuit/iu.test(text))).toBe(true);

    // Keyboard/a11y: every interactive create control is a native button or
    // text input (tab-reachable, key-activatable), and profession cards
    // expose pressed state.
    for (const el of createPanel.querySelectorAll<HTMLElement>("button, input")) {
      expect(["BUTTON", "INPUT"]).toContain(el.tagName);
    }
    const cards = createPanel.querySelectorAll(".sc3d-cs-profcard");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.tagName).toBe("BUTTON");
      expect(card.getAttribute("aria-pressed")).not.toBeNull();
    }
  });

  it("blocks a legacy pending record until one retry-safe allocation is resolved", async () => {
    const legacy: CharacterApiRecord = {
      ...DRESSED_RECORD,
      id: "char-legacy",
      name: "Legacy",
      initialProfessionId: null,
      worldEntryClaimed: false,
    };
    const resolved: CharacterApiRecord = { ...legacy, initialProfessionId: "scout" };
    let committed = false;
    const allocationBodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PUT" && url.endsWith(`/game/characters/${legacy.id}/initial-profession`)) {
        allocationBodies.push(JSON.parse(String(init?.body)) as unknown);
        committed = true;
        return new Response(JSON.stringify(resolved), { status: 200 });
      }
      if (method === "POST" && url.endsWith(`/game/characters/${legacy.id}/enter`)) {
        return new Response(JSON.stringify(joinFor(resolved)), { status: 200 });
      }
      return new Response(JSON.stringify({
        ...ROSTER_RESPONSE,
        characters: [committed ? resolved : legacy],
      }), { status: 200 });
    }));

    const root = document.createElement("div");
    document.body.appendChild(root);
    const selected = renderCharacterSelect(root);
    await vi.waitFor(() => expect(window.__successor3dCharacterSelect?.selectedId).toBe(legacy.id));

    const enterButton = root.querySelector<HTMLButtonElement>('[data-ref="enterButton"]')!;
    const resolvePanel = root.querySelector<HTMLElement>('[data-ref="professionResolve"]')!;
    const confirmButton = root.querySelector<HTMLButtonElement>('[data-ref="resolveProfessionButton"]')!;
    expect(resolvePanel.hidden).toBe(false);
    expect(enterButton.disabled).toBe(true);
    expect(confirmButton.disabled).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-ref="resolveProfessionGrid"] [data-profession-id="scout"]')!.click();
    expect(confirmButton.disabled).toBe(false);
    confirmButton.click();
    await vi.waitFor(() => expect(allocationBodies).toEqual([{ initialProfessionId: "scout" }]));
    await vi.waitFor(() => expect(enterButton.disabled).toBe(false));
    expect(resolvePanel.hidden).toBe(true);

    enterButton.click();
    await expect(selected).resolves.toMatchObject({ character: { id: legacy.id } });
  });
});
