import { afterEach, describe, expect, it } from "vitest";
import {
  CREATOR_CREATE,
  CREATOR_CREATE_RESULT,
  CREATOR_SELECT,
  CREATOR_STATE,
  createHostedCharacterCreatorPort,
  exactCreatorOrigin,
} from "./hostedCharacterCreator";

const ORIGIN = "https://successor.example";

function fakeWindow(): { child: Window; parent: Window; sent: Array<{ value: unknown; origin: string }>; emit: (event: MessageEvent<unknown>) => void } {
  const listeners = new Set<(event: MessageEvent<unknown>) => void>();
  const sent: Array<{ value: unknown; origin: string }> = [];
  const parent = { postMessage: (value: unknown, origin: string) => sent.push({ value, origin }) } as unknown as Window;
  const child = {
    parent,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.add(listener as (event: MessageEvent<unknown>) => void),
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => listeners.delete(listener as (event: MessageEvent<unknown>) => void),
    setTimeout,
    clearTimeout,
  } as unknown as Window;
  return {
    child,
    parent,
    sent,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

const minimalSiteCharacter = {
  id: "char-min",
  name: "Mara",
  initialProfessionId: "scout" as const,
  worldEntryClaimed: false,
  appearance: { body: "female" as const, skinTone: "#d1a679", hair: null, hairMat: "hair_umber", face: null },
  worn: [],
};

const character = {
  id: "char-1",
  name: "Marlow",
  appearance: { body: "male" as const, skinTone: "#d1a679", hair: null, hairMat: "hair_umber", face: null },
  position: null,
  lastLogoutAt: null,
  lastSeenAt: null,
  totalPlayMs: 0,
  liveState: "offline" as const,
  initialProfessionId: "scout" as const,
  worldEntryClaimed: false,
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("hosted creator protocol", () => {
  it("requires the compiled exact HTTPS storefront origin", () => {
    expect(exactCreatorOrigin(ORIGIN)).toBe(ORIGIN);
    expect(() => exactCreatorOrigin("https://successor.example/creator")).toThrow();
    expect(() => exactCreatorOrigin("https://*.example")).toThrow();
    expect(() => exactCreatorOrigin("http://successor.example")).toThrow();
  });

  it("rejects malformed or wrong-source state and accepts a valid state", async () => {
    const fake = fakeWindow();
    Object.defineProperty(globalThis, "window", { configurable: true, value: fake.child });
    const port = createHostedCharacterCreatorPort({ origin: ORIGIN, parentWindow: fake.parent, timeoutMs: 100 });
    const pending = port.list();
    fake.emit({ source: fake.parent, origin: "https://attacker.example", data: { type: CREATOR_STATE, characters: [character] } } as MessageEvent);
    fake.emit({ source: {} as Window, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [character] } } as MessageEvent);
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [{ ...character, ownerRef: "secret" }] } } as MessageEvent);
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [{ ...character, appearance: { ...character.appearance, body: "synthetic" } }] } } as MessageEvent);
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [minimalSiteCharacter] } } as MessageEvent);
    await expect(pending).resolves.toMatchObject({ characters: [{ id: "char-min", position: null, totalPlayMs: 0, liveState: "offline" }] });
    expect(fake.sent[0]).toEqual({ value: { type: "successor.creator.ready.v1" }, origin: ORIGIN });
    port.dispose();
  });

  it("sends bounded create and ENTER WORLD selection messages", async () => {
    const fake = fakeWindow();
    Object.defineProperty(globalThis, "window", { configurable: true, value: fake.child });
    const port = createHostedCharacterCreatorPort({ origin: ORIGIN, parentWindow: fake.parent, timeoutMs: 100 });
    const list = port.list();
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [character] } } as MessageEvent);
    await list;

    const creating = port.create({ name: "Mara", appearance: character.appearance, initialProfessionId: "scout" });
    const createMessage = fake.sent.find((entry) => (entry.value as { type?: string }).type === CREATOR_CREATE)?.value as { requestId: string };
    expect(createMessage.requestId.length).toBeGreaterThan(0);
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_CREATE_RESULT, requestId: createMessage.requestId, ok: true } } as MessageEvent);
    let settled = false;
    void creating.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    const createdCharacter = { ...character, id: "char-2", name: "Mara" };
    fake.emit({ source: fake.parent, origin: ORIGIN, data: { type: CREATOR_STATE, characters: [createdCharacter], selectedCharacterId: "char-2" } } as MessageEvent);
    await expect(creating).resolves.toMatchObject({ ok: true, record: { id: "char-2", name: "Mara" } });
    await expect(port.list()).resolves.toMatchObject({ characters: [{ id: "char-2", name: "Mara" }], selectedCharacterId: "char-2" });

    await expect(port.select("char-2")).resolves.toEqual({ ok: true });
    expect(fake.sent.some((entry) => (entry.value as { type?: string }).type === CREATOR_SELECT && entry.origin === ORIGIN)).toBe(true);
    expect(fake.sent.some((entry) => (entry.value as { type?: string }).type === CREATOR_CREATE_RESULT)).toBe(false);
    port.dispose();
  });
});
