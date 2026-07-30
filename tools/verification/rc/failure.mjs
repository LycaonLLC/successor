import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectory } from "./path-security.mjs";

const MAX_EVENTS = 200;
const MAX_TEXT = 500;

export function createFailureBundle({ step, reason, code = "behavioral-failure", events = [], gates = {}, cleanup = null } = {}) {
  return {
    schema: "successor.rc-proof.failure.v1",
    step: String(step ?? "unknown").slice(0, 120),
    code: String(code).slice(0, 120),
    reason: String(reason ?? "unspecified").slice(0, MAX_TEXT),
    events: Array.isArray(events) ? events.slice(-MAX_EVENTS).map((event) => boundEvent(event)) : [],
    gates: boundGates(gates),
    ...(cleanup && typeof cleanup === "object" ? { cleanup: boundGates(cleanup) } : {}),
  };
}

export async function writeFailureBundle(root, bundle) {
  const targetRoot = path.resolve(String(root ?? ""));
  const privateFailure = await ensurePrivateDirectory(targetRoot, "failure");
  const target = path.join(privateFailure.path, "bundle.json");
  try {
    const existing = await fs.lstat(target);
    if (existing.isSymbolicLink()) throw new Error("failure bundle symlink refused");
    if (!existing.isFile()) throw new Error("failure bundle must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const realTargetRoot = await fs.realpath(targetRoot);
  const realFailure = await fs.realpath(privateFailure.path);
  if (realFailure !== realTargetRoot && !realFailure.startsWith(`${realTargetRoot}${path.sep}`)) throw new Error("failure bundle path escapes evidence root");
  await fs.writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
    if (error?.code !== "EEXIST") throw error;
    await fs.writeFile(target, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
  });
  return target;
}

function boundEvent(event) {
  if (!event || typeof event !== "object") return { type: "event" };
  const out = { type: String(event.type ?? "event").slice(0, 80) };
  if (Number.isFinite(Number(event.atMs))) out.atMs = Math.max(0, Math.trunc(Number(event.atMs)));
  for (const key of ["step", "actor", "kind", "status", "reason", "route", "phase"]) if (typeof event[key] === "string") out[key] = event[key].slice(0, MAX_TEXT);
  return out;
}
function boundGates(gates) { return Object.fromEntries(Object.entries(gates && typeof gates === "object" ? gates : {}).slice(0, 100).map(([key, value]) => [String(key).slice(0, 120), typeof value === "object" && value ? boundGates(value) : typeof value === "string" ? value.slice(0, MAX_TEXT) : Boolean(value)])); }
