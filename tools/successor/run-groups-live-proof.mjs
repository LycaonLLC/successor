import path from "node:path";
import { runScenarioFile } from "../verification/scenario/runner.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const port = Number(process.env.GROUPS_PROOF_PORT ?? 28151);
const runId = `groups-live-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
const scenarioPath = path.join(repoRoot, "tools/verification/scenario/scenarios/groups-xp-live.scenario.json");
const artifactDir = path.join(repoRoot, "verification/ledgers/artifacts/groups-live", runId);

const report = await runScenarioFile({ repoRoot, scenarioPath, runId, port, artifactDir });
console.log(JSON.stringify({
  status: report.status,
  scenario: report.scenario,
  port: report.port,
  unit: report.unit,
  durationMs: report.durationMs,
  failures: report.failures,
  teardownOk: report.teardown?.ok,
  artifactPath: report.artifactPath,
}, null, 2));
process.exit(report.status === "pass" ? 0 : 1);
