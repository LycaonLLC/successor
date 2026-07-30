import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRestoreRehearsalPlan,
  buildRollbackDecision,
  buildTelemetryReviewRecord,
  buildRetentionPolicy,
} from "./operator-loop.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const IMAGE = `registry.example/successor@sha256:${A}`;
const release = { sealSha256: A, imageDigest: A, clientManifestSha256: B };

const retention = {
  schema: "successor.backup-retention-policy.v1",
  enabled: true,
  keepRecent: 3,
  keepFailedGenerations: 2,
  maxAgeDays: 30,
  intervalMinutes: 60,
  archivePrefix: "state",
};

describe("operator loop contracts", () => {
  it("refuses rollback when state generation or digest is incompatible", () => {
    const current = { generation: "gen-2", compatibility: "save-v4-journal-v2", imageDigest: A };
    const target = { generation: "gen-1", expectedCurrentGeneration: "gen-2", compatibility: "save-v4-journal-v2", imageDigest: A };
    assert.equal(buildRollbackDecision({ current, target, requestedImageRef: IMAGE }).action, "rollback");
    assert.throws(() => buildRollbackDecision({ current: { ...current, generation: "gen-9" }, target, requestedImageRef: IMAGE }), /incompatible state generation/);
    assert.throws(() => buildRollbackDecision({ current, target: { ...target, imageDigest: B }, requestedImageRef: IMAGE }), /digest/);
  });

  it("binds telemetry review to release and session evidence", () => {
    const record = buildTelemetryReviewRecord({
      release,
      session: { id: "session-7", startedAt: "2026-07-24T10:00:00Z", endedAt: "2026-07-24T10:30:00Z", outcome: "pass" },
      metrics: [{ path: "metrics.json", sha256: A }],
      logs: [{ path: "server.log", sha256: B }],
      journal: [{ path: "journal.ndjson", sha256: A }],
      reviewedAt: "2026-07-24T10:31:00Z",
    });
    assert.equal(record.release.sealSha256, A);
    assert.equal(record.session.id, "session-7");
    assert.match(record.reviewSha256, /^[a-f0-9]{64}$/);
    assert.throws(() => buildTelemetryReviewRecord({ release, session: { id: "s", startedAt: "a", endedAt: "b" }, metrics: [], logs: [], journal: [] }), /evidence/);
  });

  it("rejects unsafe or missing retention policy", () => {
    assert.equal(buildRetentionPolicy(retention).keepRecent, 3);
    assert.throws(() => buildRetentionPolicy({ ...retention, enabled: false }), /enabled/);
    assert.throws(() => buildRetentionPolicy({ ...retention, keepRecent: 1 }), /two recent/);
    assert.throws(() => buildRetentionPolicy({ ...retention, archivePrefix: "" }), /prefix/);
  });

  it("plans isolated restore without live writer access", () => {
    const plan = buildRestoreRehearsalPlan({ archive: "/var/backups/state.tar.gz", liveStateDir: "/var/lib/successor", isolatedTargetDir: "/var/lib/restore-rehearsal/session-1", release, writerAccess: false });
    assert.equal(plan.mode, "isolated-read-only");
    assert.equal(plan.writerAccess, false);
    assert.throws(() => buildRestoreRehearsalPlan({ archive: "state.tar.gz", liveStateDir: "/var/lib/successor", isolatedTargetDir: "/var/lib/successor/rehearsal", writerAccess: false }), /isolated/);
    assert.throws(() => buildRestoreRehearsalPlan({ archive: "state.tar.gz", liveStateDir: "/var/lib/successor", isolatedTargetDir: "/var/lib/rehearsal", writerAccess: true }), /writer/);
  });
});
