import { describe, expect, it } from "vitest";

import { MacroParseError, parseMacroBody } from "./parser";

function statementTypes(body: string): string[] {
  return parseMacroBody(body).statements.map((statement) => statement.type);
}

describe("macroEngine parser", () => {
  it("parses verb lines, semicolon chains, comments, keyed args, quoted strings, numbers, and variables", () => {
    const program = parseMacroBody(`
# stripped comment
/attack $target action=basic_shot note="field bandage" amount=3.5 reason=$last.reasonCode; /sample family=metal # tail
label_done:
/goto label_done
`);

    expect(program.schema).toBe("successor.macro-program.v1");
    expect(statementTypes("/attack $target; /sample metal")).toEqual(["verb", "verb"]);
    expect(program.labels.label_done).toBe(2);
    const attack = program.statements[0];
    expect(attack).toMatchObject({ type: "verb", verb: "attack", line: 3 });
    if (attack?.type !== "verb") throw new Error("expected verb");
    expect(attack.args).toEqual([
      { value: { kind: "var", path: ["target"], raw: "$target" }, raw: "$target" },
      { key: "action", value: { kind: "id", value: "basic_shot", raw: "basic_shot" }, raw: "action=basic_shot" },
      { key: "note", value: { kind: "string", value: "field bandage", raw: "\"field bandage\"" }, raw: "note=\"field bandage\"" },
      { key: "amount", value: { kind: "number", value: 3.5, raw: "3.5" }, raw: "amount=3.5" },
      { key: "reason", value: { kind: "var", path: ["last", "reasonCode"], raw: "$last.reasonCode" }, raw: "reason=$last.reasonCode" },
    ]);
    expect(program.statements[1]).toMatchObject({ type: "verb", verb: "sample" });
    expect(program.statements[3]).toMatchObject({ type: "goto", label: "label_done" });
  });

  it("parses every macro-only construct", () => {
    const program = parseMacroBody(`
/pause 1.25
/onreject goto fail
/loop 2
/waitreceipt timeout=3s
/until vitals.action >= 50 timeout=4
/endloop
/macro run heal $target $1 mode=fast
/macro stop heal
/macro list
/macro heal $2
/dump
fail:
/onreject continue
/onreject halt
`);

    expect(program.statements.map((statement) => statement.type)).toEqual([
      "pause",
      "onreject",
      "loopStart",
      "waitreceipt",
      "until",
      "loopEnd",
      "macro",
      "macro",
      "macro",
      "macro",
      "dump",
      "label",
      "onreject",
      "onreject",
    ]);
    expect(program.statements[2]).toMatchObject({ type: "loopStart", count: 2, endIndex: 5 });
    expect(program.statements[5]).toMatchObject({ type: "loopEnd", startIndex: 2 });
    expect(program.statements[4]).toMatchObject({
      type: "until",
      predicate: { queryVerb: "vitals", fieldPath: ["action"], operator: ">=", expected: { kind: "number", value: 50, raw: "50" } },
      timeoutSeconds: 4,
    });
    expect(program.statements[6]).toMatchObject({ type: "macro", action: "run", name: "heal" });
    expect(program.statements[9]).toMatchObject({ type: "macro", action: "run", name: "heal" });
  });

  it("parses forever loops and truthy /until predicates", () => {
    const program = parseMacroBody("/loop forever\n/until nearby.hostile\n/endloop");
    expect(program.statements[0]).toMatchObject({ type: "loopStart", count: "forever", endIndex: 2 });
    expect(program.statements[1]).toMatchObject({ type: "until", predicate: { queryVerb: "nearby", fieldPath: ["hostile"], operator: "truthy" } });
  });

  it("rejects malformed grammar with stable reason codes", () => {
    const malformed: Array<[string, string]> = [
      ["attack target", "expected_slash_or_label"],
      ["/", "expected_verb"],
      ["/pause", "bad_pause"],
      ["/pause -1", "bad_pause"],
      ["/loop 0", "bad_loop"],
      ["/loop many", "bad_loop"],
      ["/endloop", "unmatched_endloop"],
      ["/loop 2\n/sample metal", "unclosed_loop"],
      ["/sample key=", "bad_arg_value"],
      ["/sample =value", "bad_arg_key"],
      ["/sample $last.", "bad_variable"],
      ["/sample \"unterminated", "unterminated_string"],
      ["/until", "bad_until"],
      ["/until vitals.action ~~ 10", "bad_until"],
      ["/onreject maybe", "bad_onreject"],
      ["/goto 1bad", "bad_goto"],
      ["label:\nlabel:", "duplicate_label"],
      ["/macro run", "bad_macro"],
      ["/waitreceipt nope=1", "bad_waitreceipt"],
    ];

    for (const [body, code] of malformed) {
      expect(() => parseMacroBody(body), body).toThrow(MacroParseError);
      try {
        parseMacroBody(body);
      } catch (error) {
        expect((error as MacroParseError).code, body).toBe(code);
      }
    }
  });

  it("enforces the byte-size cap during parsing", () => {
    expect(() => parseMacroBody("/sample metal", { caps: { bodyBytes: 5 } })).toThrow(/macro_body_too_large/);
  });
});
