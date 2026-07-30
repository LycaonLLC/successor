import { describe, expect, it } from "vitest";

import { KeyDecoder } from "./input";

describe("key decoder", () => {
  it("decodes printables, enter, backspace, ctrl chords", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("a")).toEqual([{ kind: "char", value: "a" }]);
    expect(decoder.push("\r")).toEqual([{ kind: "special", value: "", name: "enter" }]);
    expect(decoder.push("\u007f")).toEqual([{ kind: "special", value: "", name: "backspace" }]);
    expect(decoder.push("\u0003")).toEqual([{ kind: "char", value: "c", ctrl: true }]);
  });

  it("decodes CSI and SS3 arrows plus page keys", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001b[A")).toEqual([{ kind: "special", value: "", name: "up" }]);
    expect(decoder.push("\u001bOD")).toEqual([{ kind: "special", value: "", name: "left" }]);
    expect(decoder.push("\u001b[5~")).toEqual([{ kind: "special", value: "", name: "pageup" }]);
    expect(decoder.push("\u001b[3~")).toEqual([{ kind: "special", value: "", name: "delete" }]);
  });

  it("buffers partial escape sequences across chunks", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001b[")).toEqual([]);
    expect(decoder.push("B")).toEqual([{ kind: "special", value: "", name: "down" }]);
  });

  it("delivers bracketed paste as ONE event (macro bodies survive)", () => {
    const decoder = new KeyDecoder();
    const events = decoder.push("\u001b[200~/attack $target; /pause 1\u001b[201~");
    expect(events).toEqual([{ kind: "paste", value: "/attack $target; /pause 1" }]);
  });

  it("splits paste across chunks without losing bytes", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001b[200~half ")).toEqual([]);
    expect(decoder.push("done\u001b[201~x")).toEqual([
      { kind: "paste", value: "half done" },
      { kind: "char", value: "x" },
    ]);
  });

  it("marks alt-prefixed keys", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001bf")).toEqual([{ kind: "char", value: "f", alt: true }]);
  });

  it("decodes multi-byte UTF-8 printables as single events", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("字")).toEqual([{ kind: "char", value: "字" }]);
  });
});
