import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AlphaApiError, type AlphaApi, type LaunchEnvelope, type OwnedCharacter } from "./alphaApi";
import { saveCredential } from "./credentialStore";
import { cleanChatUrl, resolveCharacter, runHostedPlay, type SessionOutcome } from "./hosted";
import type { TuiOptions } from "../options";

const CREDENTIAL = "credential-secret-00000000000000000000000001";
const ROSTER: OwnedCharacter[] = [
  { id: "char_vex", name: "Vex Marrow", initialProfessionId: "scout", worldEntryClaimed: true },
  { id: "char_tally", name: "Tally Bright", initialProfessionId: "medic", worldEntryClaimed: false },
];

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
});

async function signedInStore(): Promise<{ dir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "successor-hosted-"));
  roots.push(root);
  const dir = path.join(root, "successor");
  await saveCredential({
    apiUrl: "http://127.0.0.1:9999",
    credential: CREDENTIAL,
    scopes: ["character:list", "play-ticket"],
    obtainedAt: new Date().toISOString(),
  }, { dir });
  return { dir };
}

interface Fake {
  api: AlphaApi;
  ticketCalls: string[];
  envelopes: LaunchEnvelope[];
  lines: string[];
  errors: string[];
  answers: Array<string | null>;
  prompts: string[];
  sessions: TuiOptions[];
  outcomes: SessionOutcome[];
}

function fake(roster: OwnedCharacter[] = ROSTER): Fake {
  const state: Fake = { ticketCalls: [], envelopes: [], lines: [], errors: [], answers: [], prompts: [], sessions: [], outcomes: [], api: null as unknown as AlphaApi };
  let mint = 0;
  state.api = {
    apiUrl: "http://127.0.0.1:9999",
    connectUrl: "http://127.0.0.1:9999/connect",
    async deviceStart() { throw new Error("not under test"); },
    async devicePoll() { throw new Error("not under test"); },
    async deviceLogout() { return "revoked" as const; },
    async listCharacters(credential) {
      expect(credential).toBe(CREDENTIAL);
      return roster;
    },
    async playTicket(credential, characterId) {
      expect(credential).toBe(CREDENTIAL);
      state.ticketCalls.push(characterId);
      mint += 1;
      const envelope: LaunchEnvelope = {
        gameTicket: `game-ticket-${mint}-secret`,
        chatTicket: `chat-ticket-${mint}-secret`,
        characterId,
        expiresAt: Date.now() + 45_000,
        endpoints: { game: "https://game.successorgame.com", chat: "" },
        release: { client: "dev", server: "dev", shard: "open-desert" },
      };
      state.envelopes.push(envelope);
      return envelope;
    },
  };
  return state;
}

function deps(state: Fake, interactive = true) {
  return {
    io: {
      print: (line: string) => state.lines.push(line),
      error: (line: string) => state.errors.push(line),
      question: async (prompt: string) => {
        state.prompts.push(prompt);
        return state.answers.shift() ?? null;
      },
      interactive,
    },
    makeApi: () => state.api,
    runSession: async (options: TuiOptions) => {
      state.sessions.push(options);
      return state.outcomes.shift() ?? { kind: "quit" as const, code: 0 };
    },
  };
}

function hostedOptions(overrides: Partial<{ character: string; plain: boolean; apiUrl: string }> = {}) {
  return {
    apiUrl: overrides.apiUrl ?? "https://www.successorgame.com",
    slicePath: path.join(os.tmpdir(), "slice.json"),
    plain: overrides.plain ?? false,
    verbose: false,
    intro: true,
    ...(overrides.character !== undefined ? { character: overrides.character } : {}),
  };
}

describe("hosted play", () => {
  it("refuses to run without a stored credential", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "successor-hosted-"));
    roots.push(root);
    const state = fake();
    const code = await runHostedPlay(hostedOptions(), { ...deps(state), store: { dir: path.join(root, "none") } });
    expect(code).toBe(1);
    expect(state.errors.join("\n")).toContain("successor-tui login");
    expect(state.sessions).toHaveLength(0);
  });

  it("launches with --character by name: split tickets in options, clean chat URL, nothing leaked", async () => {
    const { dir } = await signedInStore();
    const state = fake();
    const code = await runHostedPlay(hostedOptions({ character: "vex marrow" }), { ...deps(state), store: { dir } });
    expect(code).toBe(0);
    expect(state.ticketCalls).toEqual(["char_vex"]);
    expect(state.sessions).toHaveLength(1);
    const options = state.sessions[0]!;
    expect(options.endpoint).toBe("https://game.successorgame.com");
    expect(options.characterId).toBe("char_vex");
    expect(options.displayName).toBe("Vex Marrow");
    expect(options.hosted?.gameTicket).toBe("game-ticket-1-secret");
    expect(options.hosted?.chatTicket).toBe("chat-ticket-1-secret");
    // chat URL is derived, ws-scheme, and carries no query at all
    expect(options.chatUrl).toBe("wss://game.successorgame.com/chat/ws");
    expect(options.chatUrl).not.toContain("?");
    expect(options.ticket).toBeUndefined();
    // no ticket in anything human-visible, in argv, or in the environment
    const visible = [...state.lines, ...state.errors].join("\n");
    for (const secret of ["game-ticket-1-secret", "chat-ticket-1-secret", CREDENTIAL]) {
      expect(visible).not.toContain(secret);
      expect(process.argv.join(" ")).not.toContain(secret);
      expect(JSON.stringify(process.env)).not.toContain(secret);
      expect(options.endpoint).not.toContain(secret);
      expect(options.chatUrl ?? "").not.toContain(secret);
    }
  });

  it("selects from the roster by number, and bare Enter takes the first character", async () => {
    const { dir } = await signedInStore();
    const picked = fake();
    picked.answers = ["2"];
    expect(await runHostedPlay(hostedOptions(), { ...deps(picked), store: { dir } })).toBe(0);
    expect(picked.ticketCalls).toEqual(["char_tally"]);
    expect(picked.lines.join("\n")).toContain("1. Vex Marrow — scout");

    const first = fake();
    first.answers = [""];
    expect(await runHostedPlay(hostedOptions(), { ...deps(first), store: { dir } })).toBe(0);
    expect(first.ticketCalls).toEqual(["char_vex"]);
  });

  it("goes straight in with one character on the account: no prompt, one line", async () => {
    const { dir } = await signedInStore();
    const solo = fake([ROSTER[0]!]);
    expect(await runHostedPlay(hostedOptions(), { ...deps(solo), store: { dir } })).toBe(0);
    expect(solo.ticketCalls).toEqual(["char_vex"]);
    expect(solo.prompts).toHaveLength(0);
    expect(solo.lines).toEqual(["Playing Vex Marrow."]);

    // No terminal, same account: nothing to ask, so it still goes in.
    const piped = fake([ROSTER[0]!]);
    expect(await runHostedPlay(hostedOptions(), { ...deps(piped, false), store: { dir } })).toBe(0);
    expect(piped.ticketCalls).toEqual(["char_vex"]);
    expect(piped.errors).toHaveLength(0);

    // --character still wins over the auto-pick, even when it is wrong.
    const wrong = fake([ROSTER[0]!]);
    expect(await runHostedPlay(hostedOptions({ character: "nobody" }), { ...deps(wrong), store: { dir } })).toBe(2);
    expect(wrong.sessions).toHaveLength(0);
  });

  it("keeps the menu for more than one character, and q leaves without minting", async () => {
    const { dir } = await signedInStore();
    const quit = fake();
    quit.answers = ["q"];
    expect(await runHostedPlay(hostedOptions(), { ...deps(quit), store: { dir } })).toBe(0);
    expect(quit.prompts).toHaveLength(1);
    expect(quit.ticketCalls).toHaveLength(0);
    expect(quit.sessions).toHaveLength(0);
  });

  it("carries the plain flag through to the session (plain and fullscreen flows)", async () => {
    const { dir } = await signedInStore();
    const plain = fake();
    await runHostedPlay(hostedOptions({ character: "char_vex", plain: true }), { ...deps(plain), store: { dir } });
    expect(plain.sessions[0]!.plain).toBe(true);
    const full = fake();
    await runHostedPlay(hostedOptions({ character: "char_vex" }), { ...deps(full), store: { dir } });
    expect(full.sessions[0]!.plain).toBe(false);
  });

  it("either-leg failure spends the launch, says so once, and remints on the next Enter", async () => {
    const { dir } = await signedInStore();
    const state = fake();
    state.outcomes = [{ kind: "leg-failed", notice: "the chat connection was refused or dropped" }, { kind: "quit", code: 0 }];
    state.answers = [""]; // Enter: try again
    const code = await runHostedPlay(hostedOptions({ character: "char_vex" }), { ...deps(state), store: { dir } });
    expect(code).toBe(0);
    expect(state.ticketCalls).toEqual(["char_vex", "char_vex"]);
    // fresh envelope on the second attempt — never the spent pair
    expect(state.sessions[1]!.hosted?.gameTicket).toBe("game-ticket-2-secret");
    expect(state.sessions[1]!.hosted?.chatTicket).toBe("chat-ticket-2-secret");
    const failureLines = state.errors.filter((line) => line.startsWith("Launch failed"));
    expect(failureLines).toHaveLength(1);
  });

  it("gives up after one failed leg when not interactive", async () => {
    const { dir } = await signedInStore();
    const state = fake();
    state.outcomes = [{ kind: "leg-failed", notice: "the game connection dropped" }];
    const code = await runHostedPlay(hostedOptions({ character: "char_vex" }), { ...deps(state, false), store: { dir } });
    expect(code).toBe(1);
    expect(state.ticketCalls).toHaveLength(1);
  });

  it("explains an empty roster and a revoked credential", async () => {
    const { dir } = await signedInStore();
    const empty = fake([]);
    expect(await runHostedPlay(hostedOptions(), { ...deps(empty), store: { dir } })).toBe(1);
    expect(empty.errors.join("\n")).toContain("No characters");

    const revoked = fake();
    revoked.api.listCharacters = async () => {
      throw new AlphaApiError("AUTH_REJECTED", "no", 401);
    };
    expect(await runHostedPlay(hostedOptions(), { ...deps(revoked), store: { dir } })).toBe(1);
    expect(revoked.errors.join("\n")).toContain("successor-tui login");
  });
});

describe("hosted helpers", () => {
  it("scrubs server chat endpoints and derives when absent", () => {
    expect(cleanChatUrl("", "https://game.host")).toBe("wss://game.host/chat/ws");
    expect(cleanChatUrl("https://chat.host/chat/ws", "https://game.host")).toBe("wss://chat.host/chat/ws");
    expect(cleanChatUrl("wss://chat.host/chat/ws?ticket=leak#frag", "https://game.host")).toBe("wss://chat.host/chat/ws");
  });

  it("resolves --character by exact id and unique case-insensitive name", () => {
    expect(resolveCharacter(ROSTER, "char_tally")).toMatchObject({ id: "char_tally" });
    expect(resolveCharacter(ROSTER, "VEX MARROW")).toMatchObject({ id: "char_vex" });
    expect(resolveCharacter(ROSTER, "nobody")).toMatchObject({ error: expect.stringContaining("Vex Marrow") });
  });
});
