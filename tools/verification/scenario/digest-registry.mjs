import fs from "node:fs/promises";
import path from "node:path";

const registrySchema = "successor.scenario-golden-digests.v1";
const registryFile = path.resolve(import.meta.dirname, "golden-digests.json");

export async function loadDigestRegistry() {
  const registry = JSON.parse(await fs.readFile(registryFile, "utf8"));
  if (registry?.schema !== registrySchema || !registry.scenarios || typeof registry.scenarios !== "object" || Array.isArray(registry.scenarios)) {
    throw new Error(`invalid golden digest registry ${registryFile}`);
  }
  return registry;
}

export function compareLaneParity(results, registry) {
  const byScenario = groupByScenario(results);
  const comparisons = [];
  for (const [scenario, laneResults] of byScenario) {
    const accel = laneResults.get("accel");
    const realtime = laneResults.get("realtime");
    if (!accel || !realtime) continue;
    const entry = registry.scenarios[scenario] ?? null;
    if (entry?.accelEligible === false) {
      comparisons.push({
        scenario,
        status: "demoted",
        accelEligible: false,
        reason: entry.demotion?.reason ?? "registry marks scenario realtime-only",
        divergenceStep: entry.demotion?.divergenceStep ?? null,
      });
      continue;
    }
    if (accel.status === "skip" || realtime.status === "skip") continue;
    const probeDivergence = firstProbeDivergence(accel.stateProbes ?? [], realtime.stateProbes ?? []);
    const digestEqual = typeof accel.finalSnapshotDigest === "string"
      && accel.finalSnapshotDigest === realtime.finalSnapshotDigest;
    if (digestEqual && !probeDivergence) {
      comparisons.push({
        scenario,
        status: "pass",
        accelEligible: true,
        digest: accel.finalSnapshotDigest,
        stateProbeCount: accel.stateProbes?.length ?? 0,
      });
      continue;
    }
    comparisons.push({
      scenario,
      status: "fail",
      accelEligible: false,
      reason: digestEqual ? "state probe divergence" : "final snapshot digest divergence",
      divergenceStep: probeDivergence?.afterStep ?? finalDivergenceStep(accel, realtime),
      accelDigest: accel.finalSnapshotDigest ?? null,
      realtimeDigest: realtime.finalSnapshotDigest ?? null,
      probeDivergence,
    });
  }
  return comparisons;
}


export function goldenDigestMismatches(results, registry) {
  const mismatches = [];
  for (const result of results) {
    if (result.status === "skip" || typeof result.finalSnapshotDigest !== "string") continue;
    const entry = registry.scenarios[result.scenario];
    if (!entry?.digest || !entry.lanes?.includes(result.lane)) continue;
    if (entry.digest === result.finalSnapshotDigest) continue;
    mismatches.push({
      scenario: result.scenario,
      lane: result.lane,
      expectedDigest: entry.digest,
      actualDigest: result.finalSnapshotDigest,
      divergenceStep: result.stateProbes?.at(-1)?.afterStep ?? result.steps?.at(-1)?.index ?? null,
    });
  }
  return mismatches;
}

export function evaluateGoldenAcceptance({ requestedLane, results }) {
  const reasons = [];
  if (requestedLane !== "all") reasons.push({ code: "LANE_ALL_REQUIRED", requestedLane });
  const byScenario = groupByScenario(results);
  if (byScenario.size === 0) reasons.push({ code: "NO_SCENARIO_RESULTS" });
  for (const scenario of [...byScenario.keys()].sort()) {
    const lanes = byScenario.get(scenario);
    const accel = lanes.get("accel");
    const realtime = lanes.get("realtime");
    if (!accel || !realtime) {
      reasons.push({ code: "BOTH_LANES_REQUIRED", scenario, lanes: [...lanes.keys()].sort() });
      continue;
    }
    if (accel.status !== "pass" || realtime.status !== "pass") {
      reasons.push({ code: "BOTH_LANES_MUST_PASS", scenario, accelStatus: accel.status, realtimeStatus: realtime.status });
      continue;
    }
    if (!sameString(accel.finalSnapshotDigest, realtime.finalSnapshotDigest)) {
      reasons.push({ code: "FINAL_DIGEST_MISMATCH", scenario, accel: accel.finalSnapshotDigest ?? null, realtime: realtime.finalSnapshotDigest ?? null });
    }
    if (!sameString(accel.finalStateHash, realtime.finalStateHash)) {
      reasons.push({ code: "FINAL_STATE_HASH_MISMATCH", scenario, accel: accel.finalStateHash ?? null, realtime: realtime.finalStateHash ?? null });
    }
    const probeDivergence = firstProbeDivergence(accel.stateProbes ?? [], realtime.stateProbes ?? []);
    if (probeDivergence) reasons.push({ code: "STATE_PROBE_MISMATCH", scenario, probeDivergence });
    const sourceReason = sourceIdentityMismatch(accel, realtime);
    if (sourceReason) reasons.push({ code: "SOURCE_IDENTITY_MISMATCH", scenario, ...sourceReason });
  }
  return { ok: reasons.length === 0, reasons };
}

export function acceptGoldenDigestRegistry(registry, results, recordedAtCommit, requestedLane) {
  const acceptance = evaluateGoldenAcceptance({ requestedLane, results });
  if (!acceptance.ok) return { ...acceptance, registry: null };
  const updated = structuredClone(registry);
  for (const [scenario, laneResults] of groupByScenario(results)) {
    const accel = laneResults.get("accel");
    const realtime = laneResults.get("realtime");
    const previous = updated.scenarios[scenario] ?? {};
    updated.scenarios[scenario] = {
      ...previous,
      digest: accel.finalSnapshotDigest,
      stateHash: accel.finalStateHash,
      sourceIdentity: accel.sourceIdentity.before,
      recordedAtCommit,
      lanes: ["accel", "realtime"],
      accelEligible: true,
    };
    if (realtime.finalSnapshotDigest !== accel.finalSnapshotDigest) throw new Error(`golden acceptance invariant violated for ${scenario}`);
  }
  updated.schema = registrySchema;
  updated.scenarios = Object.fromEntries(Object.entries(updated.scenarios).sort(([left], [right]) => left.localeCompare(right)));
  return { ok: true, reasons: [], registry: updated };
}


export async function writeDigestRegistry(registry) {
  await fs.writeFile(registryFile, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registryFile;
}

export function speedRatios(results) {
  const ratios = [];
  for (const [scenario, lanes] of groupByScenario(results)) {
    const accel = lanes.get("accel");
    const realtime = lanes.get("realtime");
    if (!accel || !realtime || accel.status === "skip" || realtime.status === "skip") continue;
    const accelWallMs = Number(accel.wallDurationMs ?? accel.durationMs);
    const realtimeWallMs = Number(realtime.wallDurationMs ?? realtime.durationMs);
    ratios.push({
      scenario,
      accelWallMs: finiteRound(accelWallMs),
      realtimeWallMs: finiteRound(realtimeWallMs),
      realtimeOverAccel: accelWallMs > 0 && Number.isFinite(realtimeWallMs) ? finiteRound(realtimeWallMs / accelWallMs) : null,
    });
  }
  return ratios;
}

function groupByScenario(results) {
  const grouped = new Map();
  for (const result of results) {
    let lanes = grouped.get(result.scenario);
    if (!lanes) {
      lanes = new Map();
      grouped.set(result.scenario, lanes);
    }
    lanes.set(result.lane, result);
  }
  return grouped;
}

function firstProbeDivergence(accelProbes, realtimeProbes) {
  const count = Math.max(accelProbes.length, realtimeProbes.length);
  for (let index = 0; index < count; index += 1) {
    const accel = accelProbes[index] ?? null;
    const realtime = realtimeProbes[index] ?? null;
    if (accel?.afterStep === realtime?.afterStep && accel?.stateHash === realtime?.stateHash) continue;
    return {
      index,
      afterStep: accel?.afterStep ?? realtime?.afterStep ?? null,
      accel: accel ? { afterStep: accel.afterStep, tick: accel.tick, stateHash: accel.stateHash } : null,
      realtime: realtime ? { afterStep: realtime.afterStep, tick: realtime.tick, stateHash: realtime.stateHash } : null,
    };
  }
  return null;
}

function sameString(left, right) {
  return typeof left === "string" && left.length > 0 && left === right;
}

function sourceIdentityMismatch(accel, realtime) {
  const accelBefore = sourceIdentityKey(accel.sourceIdentity?.before);
  const accelAfter = sourceIdentityKey(accel.sourceIdentity?.after);
  const realtimeBefore = sourceIdentityKey(realtime.sourceIdentity?.before);
  const realtimeAfter = sourceIdentityKey(realtime.sourceIdentity?.after);
  if (!accelBefore || !accelAfter || !realtimeBefore || !realtimeAfter) {
    return { accelBefore, accelAfter, realtimeBefore, realtimeAfter, reason: "source identity missing" };
  }
  if (accelBefore !== accelAfter || accelBefore !== realtimeBefore || accelBefore !== realtimeAfter) {
    return { accelBefore, accelAfter, realtimeBefore, realtimeAfter, reason: "source identity changed or differs by lane" };
  }
  return null;
}

function sourceIdentityKey(identity) {
  if (!identity || typeof identity !== "object" || typeof identity.sourceHash !== "string" || identity.sourceHash.length === 0) return null;
  return JSON.stringify({
    schema: identity.schema ?? null,
    sourceHash: identity.sourceHash,
    fileCount: identity.fileCount ?? null,
    totalBytes: identity.totalBytes ?? null,
    provenance: identity.provenance ?? null,
  });
}
function finalDivergenceStep(accel, realtime) {
  return Math.max(
    Number(accel.steps?.at(-1)?.index ?? 0),
    Number(realtime.steps?.at(-1)?.index ?? 0),
  ) || null;
}

function finiteRound(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}
