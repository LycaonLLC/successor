import { macroEngineCaps, type MacroEngineCapOverrides } from "./constants";

export type MacroValueToken =
  | { readonly kind: "number"; readonly value: number; readonly raw: string }
  | { readonly kind: "string"; readonly value: string; readonly raw: string }
  | { readonly kind: "id"; readonly value: string; readonly raw: string }
  | { readonly kind: "var"; readonly path: readonly string[]; readonly raw: string };

export interface MacroParsedArg {
  readonly key?: string;
  readonly value: MacroValueToken;
  readonly raw: string;
}

export type MacroPredicateOperator = "truthy" | "==" | "!=" | ">=" | "<=" | ">" | "<";

export interface MacroUntilPredicate {
  readonly queryVerb: string;
  readonly fieldPath: readonly string[];
  readonly operator: MacroPredicateOperator;
  readonly expected?: MacroValueToken;
}

export type MacroStatement =
  | { readonly type: "verb"; readonly verb: string; readonly args: readonly MacroParsedArg[]; readonly source: string; readonly line: number }
  | { readonly type: "pause"; readonly seconds: number; readonly source: string; readonly line: number }
  | { readonly type: "waitreceipt"; readonly timeoutSeconds?: number; readonly source: string; readonly line: number }
  | { readonly type: "until"; readonly predicate: MacroUntilPredicate; readonly timeoutSeconds?: number; readonly source: string; readonly line: number }
  | { readonly type: "onreject"; readonly policy: "halt" | "continue" | "goto"; readonly label?: string; readonly source: string; readonly line: number }
  | { readonly type: "goto"; readonly label: string; readonly source: string; readonly line: number }
  | { readonly type: "label"; readonly label: string; readonly source: string; readonly line: number }
  | { readonly type: "macro"; readonly action: "run" | "stop" | "list"; readonly name?: string; readonly args: readonly MacroParsedArg[]; readonly source: string; readonly line: number }
  | { readonly type: "dump"; readonly source: string; readonly line: number }
  | { type: "loopStart"; readonly count: number | "forever"; endIndex: number; readonly source: string; readonly line: number }
  | { type: "loopEnd"; startIndex: number; readonly source: string; readonly line: number };

export interface MacroProgram {
  readonly schema: "successor.macro-program.v1";
  readonly bodyBytes: number;
  readonly statements: readonly MacroStatement[];
  readonly labels: Readonly<Record<string, number>>;
}

export interface MacroParseOptions {
  readonly caps?: MacroEngineCapOverrides;
}

export class MacroParseError extends Error {
  readonly code: string;
  readonly line: number;
  readonly column: number;

  constructor(code: string, message: string, line: number, column = 1) {
    super(`${code} at ${line}:${column}: ${message}`);
    this.name = "MacroParseError";
    this.code = code;
    this.line = line;
    this.column = column;
  }
}

const labelPattern = /^[A-Za-z_][A-Za-z0-9_-]*:$/u;
const keyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const queryPathPattern = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u;
const numberPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const variablePattern = /^\$(?:[1-9]|[A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const operators: Record<string, true> = { "==": true, "!=": true, ">=": true, "<=": true, ">": true, "<": true };

export function parseMacroBody(body: string, options: MacroParseOptions = {}): MacroProgram {
  const caps = macroEngineCaps(options.caps);
  const bodyBytes = utf8ByteLength(body);
  if (bodyBytes > caps.bodyBytes) {
    throw new MacroParseError("macro_body_too_large", `macro body is ${bodyBytes} bytes, cap is ${caps.bodyBytes}`, 1);
  }

  const statements: MacroStatement[] = [];
  const labels: Record<string, number> = {};
  const lines = body.split(/\r?\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    const stripped = stripComment(lines[lineIndex] ?? "", lineNumber);
    for (const segment of splitStatements(stripped, lineNumber)) {
      const trimmed = segment.trim();
      if (trimmed.length === 0) continue;
      const statement = parseSegment(trimmed, lineNumber);
      if (statement.type === "label") {
        if (labels[statement.label] !== undefined) {
          throw new MacroParseError("duplicate_label", `duplicate label ${statement.label}`, lineNumber);
        }
        labels[statement.label] = statements.length;
      }
      statements.push(statement);
    }
  }

  linkLoops(statements);
  return {
    schema: "successor.macro-program.v1",
    bodyBytes,
    statements,
    labels,
  };
}

export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function parseSegment(segment: string, line: number): MacroStatement {
  if (labelPattern.test(segment)) {
    return { type: "label", label: segment.slice(0, -1), source: segment, line };
  }
  if (!segment.startsWith("/")) {
    throw new MacroParseError("expected_slash_or_label", "macro statements must start with / or be a label", line);
  }
  const tokens = tokenize(segment, line);
  if (tokens.length === 0) throw new MacroParseError("empty_statement", "empty macro statement", line);
  const verbToken = tokens[0] ?? "";
  if (!verbToken.startsWith("/") || verbToken.length === 1) {
    throw new MacroParseError("expected_verb", "expected /verb", line);
  }
  const verb = verbToken.slice(1).toLowerCase();
  const rest = tokens.slice(1);
  switch (verb) {
    case "pause":
      return parsePause(rest, segment, line);
    case "waitreceipt":
      return parseWaitReceipt(rest, segment, line);
    case "until":
      return parseUntil(rest, segment, line);
    case "onreject":
      return parseOnReject(rest, segment, line);
    case "goto":
      return parseGoto(rest, segment, line);
    case "macro":
      return parseMacro(rest, segment, line);
    case "dump":
      if (rest.length > 0) throw new MacroParseError("unexpected_arg", "/dump takes no arguments", line);
      return { type: "dump", source: segment, line };
    case "loop":
      return parseLoop(rest, segment, line);
    case "endloop":
      if (rest.length > 0) throw new MacroParseError("unexpected_arg", "/endloop takes no arguments", line);
      return { type: "loopEnd", startIndex: -1, source: segment, line };
    default:
      return { type: "verb", verb, args: rest.map((token) => parseArg(token, line)), source: segment, line };
  }
}

function parsePause(tokens: readonly string[], source: string, line: number): MacroStatement {
  if (tokens.length !== 1) throw new MacroParseError("bad_pause", "/pause requires exactly one seconds value", line);
  const seconds = parseDurationToken(tokens[0] ?? "", line, "bad_pause");
  return { type: "pause", seconds, source, line };
}

function parseWaitReceipt(tokens: readonly string[], source: string, line: number): MacroStatement {
  let timeoutSeconds: number | undefined;
  for (const token of tokens) {
    const parsed = parseArg(token, line);
    if (parsed.key !== "timeout") throw new MacroParseError("bad_waitreceipt", "/waitreceipt only accepts timeout=<seconds>", line);
    timeoutSeconds = durationFromValue(parsed.value, line, "bad_waitreceipt");
  }
  return timeoutSeconds === undefined
    ? { type: "waitreceipt", source, line }
    : { type: "waitreceipt", timeoutSeconds, source, line };
}

function parseUntil(tokens: readonly string[], source: string, line: number): MacroStatement {
  const predicateTokens: string[] = [];
  let timeoutSeconds: number | undefined;
  for (const token of tokens) {
    const equalIndex = token.indexOf("=");
    if (equalIndex > 0 && token.slice(0, equalIndex) === "timeout") {
      const arg = parseArg(token, line);
      timeoutSeconds = durationFromValue(arg.value, line, "bad_until");
    } else {
      predicateTokens.push(token);
    }
  }
  if (predicateTokens.length === 0) throw new MacroParseError("bad_until", "/until requires a query predicate", line);
  const queryPath = predicateTokens[0] ?? "";
  if (!queryPathPattern.test(queryPath)) throw new MacroParseError("bad_until", `invalid query path ${queryPath}`, line);
  const [queryVerb, ...fieldPath] = queryPath.split(".");
  if (!queryVerb) throw new MacroParseError("bad_until", "missing query verb", line);
  if (predicateTokens.length === 1) {
    return { type: "until", predicate: { queryVerb, fieldPath, operator: "truthy" }, timeoutSeconds, source, line };
  }
  const operator = predicateTokens[1] ?? "";
  if (!operators[operator]) throw new MacroParseError("bad_until", `invalid predicate operator ${operator}`, line);
  if (predicateTokens.length !== 3) throw new MacroParseError("bad_until", "/until predicates require one right-hand value", line);
  const expected = parseValue(predicateTokens[2] ?? "", line);
  return { type: "until", predicate: { queryVerb, fieldPath, operator: operator as MacroPredicateOperator, expected }, timeoutSeconds, source, line };
}

function parseOnReject(tokens: readonly string[], source: string, line: number): MacroStatement {
  const action = tokens[0]?.toLowerCase();
  if (action === "halt" || action === "continue") {
    if (tokens.length !== 1) throw new MacroParseError("bad_onreject", `/onreject ${action} takes no label`, line);
    return { type: "onreject", policy: action, source, line };
  }
  if (action === "goto") {
    if (tokens.length !== 2) throw new MacroParseError("bad_onreject", "/onreject goto requires one label", line);
    const label = tokens[1] ?? "";
    assertLabelName(label, line, "bad_onreject");
    return { type: "onreject", policy: "goto", label, source, line };
  }
  throw new MacroParseError("bad_onreject", "/onreject requires halt, continue, or goto <label>", line);
}

function parseGoto(tokens: readonly string[], source: string, line: number): MacroStatement {
  if (tokens.length !== 1) throw new MacroParseError("bad_goto", "/goto requires one label", line);
  const label = tokens[0] ?? "";
  assertLabelName(label, line, "bad_goto");
  return { type: "goto", label, source, line };
}

function parseMacro(tokens: readonly string[], source: string, line: number): MacroStatement {
  if (tokens.length === 0) throw new MacroParseError("bad_macro", "/macro requires run, stop, list, or a macro name", line);
  const first = tokens[0]?.toLowerCase() ?? "";
  if (first === "list") {
    if (tokens.length !== 1) throw new MacroParseError("bad_macro", "/macro list takes no arguments", line);
    return { type: "macro", action: "list", args: [], source, line };
  }
  if (first === "run") {
    if (tokens.length < 2) throw new MacroParseError("bad_macro", "/macro run requires a macro name", line);
    const name = tokenAsName(tokens[1] ?? "", line, "bad_macro");
    return { type: "macro", action: "run", name, args: tokens.slice(2).map((token) => parseArg(token, line)), source, line };
  }
  if (first === "stop") {
    if (tokens.length !== 2) throw new MacroParseError("bad_macro", "/macro stop requires a macro name or all", line);
    const name = tokenAsName(tokens[1] ?? "", line, "bad_macro");
    return { type: "macro", action: "stop", name, args: [], source, line };
  }
  const name = tokenAsName(tokens[0] ?? "", line, "bad_macro");
  return { type: "macro", action: "run", name, args: tokens.slice(1).map((token) => parseArg(token, line)), source, line };
}

function parseLoop(tokens: readonly string[], source: string, line: number): MacroStatement {
  if (tokens.length !== 1) throw new MacroParseError("bad_loop", "/loop requires a count or forever", line);
  const raw = tokens[0]?.toLowerCase() ?? "";
  if (raw === "forever") return { type: "loopStart", count: "forever", endIndex: -1, source, line };
  if (!/^\d+$/u.test(raw)) throw new MacroParseError("bad_loop", "/loop count must be a positive integer or forever", line);
  const count = Number.parseInt(raw, 10);
  if (count <= 0) throw new MacroParseError("bad_loop", "/loop count must be positive", line);
  return { type: "loopStart", count, endIndex: -1, source, line };
}

function parseArg(token: string, line: number): MacroParsedArg {
  const equalIndex = token.indexOf("=");
  if (equalIndex >= 0) {
    const key = token.slice(0, equalIndex);
    const valueRaw = token.slice(equalIndex + 1);
    if (!keyPattern.test(key)) throw new MacroParseError("bad_arg_key", `invalid key ${key || "<empty>"}`, line);
    if (valueRaw.length === 0) throw new MacroParseError("bad_arg_value", `missing value for ${key}`, line);
    return { key, value: parseValue(valueRaw, line), raw: token };
  }
  return { value: parseValue(token, line), raw: token };
}

function parseValue(token: string, line: number): MacroValueToken {
  if (token.length === 0) throw new MacroParseError("bad_value", "empty value", line);
  const first = token[0];
  if (first === "\"" || first === "'") {
    if (token.length < 2 || token[token.length - 1] !== first) {
      throw new MacroParseError("unterminated_string", "unterminated quoted string", line);
    }
    return { kind: "string", value: unescapeQuoted(token.slice(1, -1), first), raw: token };
  }
  if (token.startsWith("$")) {
    if (!variablePattern.test(token)) throw new MacroParseError("bad_variable", `invalid variable ${token}`, line);
    return { kind: "var", path: token.slice(1).split("."), raw: token };
  }
  if (numberPattern.test(token)) {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new MacroParseError("bad_number", `invalid number ${token}`, line);
    return { kind: "number", value, raw: token };
  }
  return { kind: "id", value: token, raw: token };
}

function parseDurationToken(token: string, line: number, code: string): number {
  const value = parseValue(token, line);
  return durationFromValue(value, line, code);
}

function durationFromValue(value: MacroValueToken, line: number, code: string): number {
  if (value.kind === "number") {
    if (value.value < 0) throw new MacroParseError(code, "duration must be non-negative", line);
    return value.value;
  }
  if ((value.kind === "id" || value.kind === "string") && /^\d+(?:\.\d+)?s$/u.test(value.value)) {
    return Number.parseFloat(value.value.slice(0, -1));
  }
  throw new MacroParseError(code, `duration must be numeric seconds, got ${value.raw}`, line);
}

function stripComment(line: string, lineNumber: number): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  if (quote) throw new MacroParseError("unterminated_string", "unterminated quoted string", lineNumber);
  return line;
}

function splitStatements(line: string, lineNumber: number): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === ";") {
      parts.push(line.slice(start, index));
      start = index + 1;
    }
  }
  if (quote) throw new MacroParseError("unterminated_string", "unterminated quoted string", lineNumber);
  parts.push(line.slice(start));
  return parts;
}

function tokenize(segment: string, line: number): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < segment.length) {
    while (index < segment.length && /\s/u.test(segment[index] ?? "")) index += 1;
    if (index >= segment.length) break;
    const start = index;
    let quote: string | null = null;
    let escaped = false;
    while (index < segment.length) {
      const char = segment[index] ?? "";
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\" && quote) {
        escaped = true;
        index += 1;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        index += 1;
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        index += 1;
        continue;
      }
      if (/\s/u.test(char)) break;
      index += 1;
    }
    if (quote) throw new MacroParseError("unterminated_string", "unterminated quoted string", line, start + 1);
    tokens.push(segment.slice(start, index));
  }
  return tokens;
}

function unescapeQuoted(value: string, quote: string): string {
  let output = "";
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      if (char === quote || char === "\\") {
        output += char;
      } else if (char === "n") {
        output += "\n";
      } else if (char === "t") {
        output += "\t";
      } else {
        output += char;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    output += char;
  }
  if (escaped) output += "\\";
  return output;
}

function linkLoops(statements: MacroStatement[]): void {
  const stack: number[] = [];
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    if (!statement) continue;
    if (statement.type === "loopStart") {
      stack.push(index);
    } else if (statement.type === "loopEnd") {
      const start = stack.pop();
      if (start === undefined) throw new MacroParseError("unmatched_endloop", "/endloop without /loop", statement.line);
      const startStatement = statements[start];
      if (startStatement?.type === "loopStart") startStatement.endIndex = index;
      statement.startIndex = start;
    }
  }
  const dangling = stack.pop();
  if (dangling !== undefined) {
    const statement = statements[dangling];
    throw new MacroParseError("unclosed_loop", "/loop without /endloop", statement?.line ?? 1);
  }
}

function tokenAsName(token: string, line: number, code: string): string {
  const value = parseValue(token, line);
  if (value.kind !== "id" && value.kind !== "string" && value.kind !== "number") {
    throw new MacroParseError(code, "macro name must be an id or quoted string", line);
  }
  const name = String(value.value).trim();
  if (!name) throw new MacroParseError(code, "macro name cannot be empty", line);
  return name;
}

function assertLabelName(label: string, line: number, code: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(label)) throw new MacroParseError(code, `invalid label ${label}`, line);
}
