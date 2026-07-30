import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { deriveChatUrl, helpText, hostedChatUrl, parseTuiArgs } from "./options";

const ENV = { SUCCESSOR_SLICE_PATH: path.join(os.tmpdir(), "slice.json") };

describe("successor-tui argument surface", () => {
  it("defaults to hosted account play", () => {
    const parsed = parseTuiArgs([], ENV);
    expect(parsed).toMatchObject({ kind: "hosted" });
    if (typeof parsed === "string" || parsed.kind !== "hosted") throw new Error("expected hosted");
    expect(parsed.hosted.apiUrl).toBe("https://www.successorgame.com");
    expect(parsed.hosted.slicePath).toBe(path.join(os.tmpdir(), "slice.json"));
    expect(parsed.hosted.intro).toBe(true);
  });

  it("parses hosted flags", () => {
    const parsed = parseTuiArgs(["--plain", "--no-intro", "--character", "Vex Marrow", "--api-url", "http://127.0.0.1:8080"], ENV);
    if (typeof parsed === "string" || parsed.kind !== "hosted") throw new Error("expected hosted");
    expect(parsed.hosted).toMatchObject({ plain: true, intro: false, character: "Vex Marrow", apiUrl: "http://127.0.0.1:8080" });
  });

  it("refuses hand-carried tickets outside --legacy: flag and environment", () => {
    expect(() => parseTuiArgs(["--ticket", "value"], ENV)).toThrow(/legacy-only/u);
    expect(() => parseTuiArgs([], { ...ENV, SUCCESSOR_TICKET: "value" })).toThrow(/never reads a ticket from the environment/u);
    expect(() => parseTuiArgs(["--game-url", "http://127.0.0.1:1"], ENV)).toThrow(/legacy-only/u);
    expect(() => parseTuiArgs(["--chat-url", "ws://127.0.0.1:1"], ENV)).toThrow(/legacy-only/u);
  });

  it("keeps the old surface intact behind an explicit --legacy", () => {
    const parsed = parseTuiArgs(
      ["--legacy", "--plain", "--no-intro", "--game-url", "http://127.0.0.1:28093", "--player-id", "op", "--ticket", "legacy-ticket"],
      { ...ENV, SUCCESSOR_TICKET: "env-ticket" },
    );
    if (typeof parsed === "string" || parsed.kind !== "legacy") throw new Error("expected legacy");
    expect(parsed.legacy.ticket).toBe("legacy-ticket");
    expect(parsed.legacy.plain).toBe(true);
    expect(parsed.legacy.intro).toBe(false);
    // legacy keeps its historical chat URL contract, ticket query included
    expect(parsed.legacy.chatUrl).toContain("ticket=legacy-ticket");
  });

  it("parses the account subcommands", () => {
    expect(parseTuiArgs(["login"], ENV)).toMatchObject({ kind: "login", account: { openBrowser: false } });
    expect(parseTuiArgs(["login", "--open-browser"], ENV)).toMatchObject({ kind: "login", account: { openBrowser: true } });
    expect(parseTuiArgs(["logout"], ENV)).toMatchObject({ kind: "logout" });
    expect(parseTuiArgs(["account", "--api-url", "http://127.0.0.1:2"], ENV)).toMatchObject({ kind: "account", account: { apiUrl: "http://127.0.0.1:2" } });
    expect(() => parseTuiArgs(["logout", "--open-browser"], ENV)).toThrow(/only applies to successor-tui login/u);
    expect(() => parseTuiArgs(["login", "--what"], ENV)).toThrow(/unknown successor-tui login option/u);
  });

  it("keeps hosted chat URLs free of any query", () => {
    expect(hostedChatUrl("https://game.successorgame.com")).toBe("wss://game.successorgame.com/chat/ws");
    expect(hostedChatUrl("http://127.0.0.1:28093")).toBe("ws://127.0.0.1:28093/chat/ws");
    // the legacy derivation is the one that may carry identity/ticket query
    expect(deriveChatUrl({ endpoint: "http://127.0.0.1:1", ticket: "t" })).toContain("ticket=t");
  });

  it("documents the split surface", () => {
    const help = helpText();
    for (const expected of ["successor-tui login", "successor-tui logout", "successor-tui account", "--legacy", "--character", "--open-browser", "--no-intro"]) {
      expect(help).toContain(expected);
    }
    expect(help).not.toContain("SUCCESSOR_TICKET");
  });
});
