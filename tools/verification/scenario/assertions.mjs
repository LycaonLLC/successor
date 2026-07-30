import crypto from "node:crypto";

export class ScenarioAssertionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ScenarioAssertionError";
    this.details = details;
  }
}

export function getPath(value, rawPath) {
  if (!rawPath) return value;
  const parts = String(rawPath)
    .replaceAll(/\[(\d+)\]/gu, ".$1")
    .split(".")
    .filter(Boolean);
  let current = value;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

export function resolveValue(value, context = {}) {
  if (typeof value !== "string") return value;
  if (!value.startsWith("$")) return value;
  const exact = valueFromToken(value, context);
  return exact === undefined ? value : exact;
}

export function interpolate(value, context = {}) {
  if (typeof value !== "string") return value;
  return value.replace(/\$[A-Za-z_][A-Za-z0-9_.-]*/gu, (token) => {
    const resolved = valueFromToken(token, context);
    return resolved === undefined || resolved === null ? token : String(resolved);
  });
}

export function matchObject(actual, expected, context = {}) {
  const failures = [];
  for (const [path, rule] of Object.entries(expected ?? {})) {
    const actualValue = getPath(actual, path);
    const ok = evaluateRule(actualValue, rule, context);
    if (!ok) {
      failures.push(`${path} expected ${describeRule(rule, context)} but got ${JSON.stringify(actualValue)}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function assertMatch(actual, expected, context = {}, label = "match") {
  const result = matchObject(actual, expected, context);
  if (!result.ok) {
    throw new ScenarioAssertionError(`${label} failed: ${result.failures.join("; ")}`, { actual, expected, failures: result.failures });
  }
  return true;
}

export function compareValues(actual, op, expected) {
  switch (op) {
    case "eq": return Object.is(actual, expected);
    case "ne": return !Object.is(actual, expected);
    case "gt": return Number(actual) > Number(expected);
    case "gte": return Number(actual) >= Number(expected);
    case "lt": return Number(actual) < Number(expected);
    case "lte": return Number(actual) <= Number(expected);
    case "contains": return typeof actual === "string" && actual.includes(String(expected));
    case "includes": return Array.isArray(actual) && actual.includes(expected);
    case "length": return (Array.isArray(actual) || typeof actual === "string") && actual.length === Number(expected);
    case "exists": return actual !== undefined && actual !== null;
    case "notExists": return actual === undefined || actual === null;
    default: throw new ScenarioAssertionError(`unsupported comparison op ${op}`);
  }
}

export function assertComparison({ actual, op = "eq", expected, label = "comparison" }) {
  if (!compareValues(actual, op, expected)) {
    throw new ScenarioAssertionError(`${label} expected ${op} ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`, { actual, op, expected });
  }
  return true;
}

export function stableStringify(value) {
  return JSON.stringify(sortForStableHash(value));
}

export function sha256Json(value) {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function compactOracleForDigest(oracle) {
  return {
    source: oracle?.source ?? null,
    counters: stableAuthorityCounters(oracle?.counters),
    actors: Object.fromEntries(Object.entries(oracle?.actors ?? {})
      .map(([id, actor]) => [id, {
        id: actor?.id ?? id,
        areaId: actor?.areaId ?? null,
        x: round(actor?.x),
        y: round(actor?.y),
        lifeState: actor?.lifeState ?? null,
        vitals: actor?.vitals ?? null,
        maxVitals: actor?.maxVitals ?? null,
        lootable: actor?.lootable ?? null,
        hasLoot: actor?.hasLoot ?? null,
        lootRightsActorId: actor?.lootRightsActorId ?? null,
      }])
      .sort(([left], [right]) => left.localeCompare(right))),
    inventory: [...(oracle?.inventory ?? [])]
      .map((row) => ({
        container: row.container,
        stackId: row.stackId ?? null,
        item: row.item,
        itemId: row.itemId,
        variantId: row.variantId,
        quantity: row.quantity,
        available: row.available,
        reserved: row.reserved,
      }))
      .sort((left, right) => `${left.container}:${left.itemId}:${left.variantId}:${left.stackId}`.localeCompare(`${right.container}:${right.itemId}:${right.variantId}:${right.stackId}`)),
  };
}

function stableAuthorityCounters(counters = {}) {
  return {
    acceptedCommands: counters.acceptedCommands ?? null,
    rejectedCommands: counters.rejectedCommands ?? null,
    shotsFired: counters.shotsFired ?? null,
    hits: counters.hits ?? null,
    deaths: counters.deaths ?? null,
    rejectedPackets: counters.rejectedPackets ?? null,
  };
}

export function findInventoryRow(oracle, condition = {}, context = {}) {
  const container = condition.container === undefined ? undefined : interpolate(String(resolveValue(condition.container, context)), context);
  const itemId = condition.itemId === undefined ? undefined : Number(resolveValue(condition.itemId, context));
  const variantId = condition.variantId === undefined ? undefined : Number(resolveValue(condition.variantId, context));
  const minAvailable = condition.minAvailable === undefined ? undefined : Number(resolveValue(condition.minAvailable, context));
  const rows = Array.isArray(oracle?.inventory) ? oracle.inventory : [];
  return rows.find((row) => {
    if (container !== undefined && String(row.container) !== container) return false;
    if (Number.isFinite(itemId) && Number(row.itemId) !== itemId) return false;
    if (Number.isFinite(variantId) && Number(row.variantId) !== variantId) return false;
    if (Number.isFinite(minAvailable) && Number(row.available ?? row.quantity ?? 0) < minAvailable) return false;
    return true;
  }) ?? null;
}

export function distanceCells(left, right) {
  return Math.hypot(Number(left?.x ?? 0) - Number(right?.x ?? 0), Number(left?.y ?? 0) - Number(right?.y ?? 0));
}

function evaluateRule(actualValue, rule, context) {
  if (isRuleObject(rule)) {
    if (rule.exists !== undefined) return rule.exists ? actualValue !== undefined && actualValue !== null : actualValue === undefined || actualValue === null;
    if (rule.regex !== undefined) return new RegExp(String(resolveValue(rule.regex, context)), "u").test(String(actualValue ?? ""));
    if (rule.includesObject !== undefined) {
      return Array.isArray(actualValue)
        && actualValue.some((entry) => matchObject(entry, rule.includesObject, context).ok);
    }
    if (rule.excludesObject !== undefined) {
      return !Array.isArray(actualValue)
        || !actualValue.some((entry) => matchObject(entry, rule.excludesObject, context).ok);
    }
    const op = rule.op ?? "eq";
    const expected = resolveValue(rule.value, context);
    return compareValues(actualValue, op, expected);
  }
  return deepEqual(actualValue, resolveValue(rule, context));
}

function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]));
}

function isRuleObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && ("op" in value || "value" in value || "exists" in value || "regex" in value || "includesObject" in value || "excludesObject" in value);
}

function valueFromToken(token, context) {
  const body = token.slice(1);
  if (body === "target") return context.vars?.target;
  if (body === "last_kill") return context.vars?.last_kill;
  if (body === "lastKill") return context.vars?.last_kill;
  if (body === "last_receipt") return context.lastReceipt;
  if (body === "last_event") return context.lastEvent;
  if (body.startsWith("captures.")) return getPath(context.captures, body.slice("captures.".length));
  if (body.startsWith("actors.")) return getPath(context.actors, body.slice("actors.".length));
  if (body.startsWith("vars.")) return getPath(context.vars, body.slice("vars.".length));
  if (body.startsWith("lastReceipt.")) return getPath(context.lastReceipt, body.slice("lastReceipt.".length));
  if (body.startsWith("lastEvent.")) return getPath(context.lastEvent, body.slice("lastEvent.".length));
  return undefined;
}

function describeRule(rule, context) {
  if (isRuleObject(rule)) {
    if (rule.exists !== undefined) return `exists=${rule.exists}`;
    if (rule.regex !== undefined) return `regex ${rule.regex}`;
    return `${rule.op ?? "eq"} ${JSON.stringify(resolveValue(rule.value, context))}`;
  }
  return `eq ${JSON.stringify(resolveValue(rule, context))}`;
}

function sortForStableHash(value) {
  if (Array.isArray(value)) return value.map(sortForStableHash);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortForStableHash(entry)]));
}

function round(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1000) / 1000 : null;
}
