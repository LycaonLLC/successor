import { describe, expect, it } from "vitest";
import { cleanActorName, stripTypeRead } from "./actorNames";

describe("actorNames (fe-polish C1 clean-name chain)", () => {
  it("strips the trailing actor descriptor from composite labels", () => {
    expect(stripTypeRead("Mori Maddox (a rogue trooper)")).toBe("Mori Maddox");
    expect(stripTypeRead("Camp Trainer (a profession trainer)")).toBe("Camp Trainer");
  });

  it("keeps labels without a trailing type read verbatim", () => {
    expect(stripTypeRead("Juno Rill")).toBe("Juno Rill");
    // Mid-name parentheticals are not type reads — only the trailing tail goes.
    expect(stripTypeRead("Vault 7-B (east) Door")).toBe("Vault 7-B (east) Door");
  });

  it("never strips down to an empty name", () => {
    expect(stripTypeRead("(a rogue trooper)")).toBe("(a rogue trooper)");
  });

  it("prefers display_name over the composite label", () => {
    expect(cleanActorName({ label: "Mori Maddox (a rogue trooper)", displayName: "Mori Maddox" }, "x")).toBe("Mori Maddox");
  });

  it("falls back to the stripped label when display_name is absent", () => {
    expect(cleanActorName({ label: "Mori Maddox (a rogue trooper)" }, "x")).toBe("Mori Maddox");
  });

  it("uses the fallback when nothing usable exists", () => {
    expect(cleanActorName(null, "actor-7")).toBe("actor-7");
    expect(cleanActorName({ label: "  " }, "actor-7")).toBe("actor-7");
  });
});
