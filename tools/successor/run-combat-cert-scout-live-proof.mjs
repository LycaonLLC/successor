// Live proof for the COMBAT & WEAPONS wave C1 (weapon certification) + C2 (scout
// movement). Drives the REAL server + Rust authority bridge (systemd-run) — the
// day's DEF-5..9 lesson: in-process proofs lie. Two proofs:
//   1. weapon-certification-gate scenario: uncertified equip -> honest
//      weapon_not_certified reject; grant Rifle III -> equip accepted; certified
//      equipped rifle fires a combat event at the adjacent rogue.
//   2. scout sprint displacement: baseline sprint vs master-scout sprint through
//      the real Move command path; assert the scout burst travels farther.
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { startFixtureServer, fetchJson, allocatePorts, runScenarioFile } from "../verification/scenario/runner.mjs";
import { resolveFixture, materializeFixtureSlice, writeFixtureCharacterStore } from "../verification/scenario/fixture-registry.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const runId = `combat-cert-scout-${stamp}`;
const artifactDir = path.join(repoRoot, "verification/ledgers/artifacts/combat-cert-scout", runId);
await fs.mkdir(artifactDir, { recursive: true });

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, { method: "POST", timeout: 4000, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout"))); req.on("error", reject); req.end(body);
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const [certPort, scoutPort] = await allocatePorts(2, { base: 28140 });
const failures = [];

// ── Proof 1: certification gate (self-asserting scenario) ──────────────────
const certReport = await runScenarioFile({
  repoRoot,
  scenarioPath: path.join(repoRoot, "tools/verification/scenario/scenarios/weapon-certification-gate.scenario.json"),
  runId, port: certPort, artifactDir,
});
if (certReport.status !== "pass") failures.push(`cert scenario failed: ${JSON.stringify(certReport.failures)}`);
const certCmdReceipts = certReport.transcript.map((t) => t?.recv).filter((r) => r?.commandKind === "SetEquippedWeapon" && r?.receipt);
const certEvidence = {
  rejectBeat: certReport.transcript.find((t) => t?.recv?.receipt?.reasonCode === "weapon_not_certified")?.recv?.receipt ?? null,
  equipsAcceptedAfterCert: certCmdReceipts.filter((r) => r.receipt.accepted).length,
  combatFired: certReport.transcript.some((t) => t?.recv?.event === "combat" || t?.recv?.type === "event" && t?.recv?.event === "combat"),
};

// ── Proof 2: scout sprint displacement (joined actor, real Move path) ──────
const scoutReport = await runScenarioFile({
  repoRoot,
  scenarioPath: path.join(repoRoot, "tools/verification/scenario/scenarios/scout-sprint-delta.scenario.json"),
  runId, port: scoutPort, artifactDir,
});
if (scoutReport.status !== "pass") failures.push(`scout scenario failed: ${JSON.stringify(scoutReport.failures)}`);
const scoutDeltas = scoutReport.transcript.filter((t) => t?.expect === "queryDelta").map((t) => t.delta);
const [baselineDeltaCells, scoutDeltaCells] = scoutDeltas;
const scout = {
  scenarioStatus: scoutReport.status,
  port: scoutPort,
  baselineDeltaCells: baselineDeltaCells ?? null,
  scoutDeltaCells: scoutDeltaCells ?? null,
  speedupRatio: baselineDeltaCells > 0 ? Number((scoutDeltaCells / baselineDeltaCells).toFixed(3)) : null,
  artifact: scoutReport.artifactPath,
};
if (!(scoutDeltaCells > baselineDeltaCells * 1.1)) {
  failures.push(`scout sprint not measurably faster: baseline=${baselineDeltaCells} scout=${scoutDeltaCells}`);
}

const proof = {
  schema: "successor.combat-cert-scout-live-proof.v1",
  runId,
  mainTip: "off 43f6a6e (combat-doctrine/wave)",
  status: failures.length === 0 ? "pass" : "fail",
  server: "real GameShard + Rust authority_bridge_server (systemd-run)",
  certification: { scenarioStatus: certReport.status, port: certPort, ...certEvidence, artifact: certReport.artifactPath },
  scoutMovement: scout,
  failures,
};
const proofPath = path.join(artifactDir, "summary.json");
await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
console.log(JSON.stringify(proof, null, 2));
console.log(`\nproof written: ${path.relative(repoRoot, proofPath)}`);
process.exit(failures.length === 0 ? 0 : 1);
