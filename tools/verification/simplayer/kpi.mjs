// ACCEPTANCE ORACLES: per-session KPI + invariant monitors. The shard's own
// counters/receipts/oracle are the truth source — the driver-side tallies are
// cross-checked against the authoritative oracle actor stats, and mismatches
// are surfaced rather than hidden.

// Command kinds we roll up into headline KPI (accepted receipts only).
const KPI_KIND = {
  SampleResource: "samples",
  CraftFinalizePrototype: "crafts",
  ConfirmTrade: "trades",
  PlaceCamp: "camps",
  TakeLootItem: "loots",
  HarvestCorpse: "loots",
  PurchaseSkillBox: "trainings",
  DuelChallenge: "duelChallenges",
  DuelAccept: "duelAccepts",
  DuelYield: "duelYields",
  GroupInvite: "groupInvites",
  GroupAccept: "groupAccepts",
};

// Rejections that are an expected part of honest play (not a storm signal).
const BENIGN_REJECTS = new Set(["loot_no_rights", "target_unavailable", "out_of_range", "trade_not_locked", "no_pending_invite"]);

export function createKpi(player) {
  return {
    actorId: player.actorId,
    name: player.name,
    archetype: player.archetype,
    startedAtMs: Date.now(),
    endedAtMs: null,
    // headline counters (driver-observed, accepted receipts)
    counters: { samples: 0, crafts: 0, trades: 0, camps: 0, loots: 0, trainings: 0, duelChallenges: 0, duelAccepts: 0, duelYields: 0, groupInvites: 0, groupAccepts: 0, chatLines: 0 },
    // Combat/economy truth from the authority oracle.
    authoritative: { kills: 0, npcKills: 0, playerKills: 0, deaths: 0, damageDone: 0, damageTaken: 0, shotsFired: 0, hitsDealt: 0, distanceMovedCells: 0, creditsStart: null, creditsEnd: null },
    // command health
    receipts: { total: 0, accepted: 0, rejected: 0, byKind: {}, rejectedByReason: {}, rejectedByKindReason: {} },
    // invariant evidence
    invariants: {
      moveStalls: 0, moveFailures: 0, ingressBudgetExhausted: 0,
      rejectWindow: [], maxRejectsInWindow: 0,
      maxClientOracleDivergenceCells: 0, divergenceSamples: 0, sustainedDivergence: 0,
      lastProgressAtMs: Date.now(), maxNoProgressMs: 0,
    },
    breaches: [],
  };
}

// Feed every flow step (from the shared flow-context onStep hook).
export function recordStep(kpi, step) {
  if (step.receipt) {
    kpi.receipts.total += 1;
    const kind = step.receipt.commandKind ?? step.commandKind ?? "unknown";
    kpi.receipts.byKind[kind] = kpi.receipts.byKind[kind] ?? { accepted: 0, rejected: 0 };
    if (step.receipt.accepted === true) {
      kpi.receipts.accepted += 1;
      kpi.receipts.byKind[kind].accepted += 1;
      const headline = KPI_KIND[kind];
      if (headline) kpi.counters[headline] += 1;
      noteProgress(kpi);
    } else {
      kpi.receipts.rejected += 1;
      kpi.receipts.byKind[kind].rejected += 1;
      const reason = step.receipt.reasonCode ?? "unknown";
      kpi.receipts.rejectedByReason[reason] = (kpi.receipts.rejectedByReason[reason] ?? 0) + 1;
      const kindReason = `${kind}|${reason}`;
      kpi.receipts.rejectedByKindReason[kindReason] = (kpi.receipts.rejectedByKindReason[kindReason] ?? 0) + 1;
      noteReject(kpi, reason);
    }
  }
  if (step.primitive === "moveTo") {
    if (step.status === "fail") kpi.invariants.moveFailures += 1;
    if (typeof step.stalePulses === "number") kpi.invariants.moveStalls += step.stalePulses;
  }
}

export function noteReject(kpi, reason) {
  const now = Date.now();
  if (reason === "ingress_budget_exhausted") kpi.invariants.ingressBudgetExhausted += 1;
  if (BENIGN_REJECTS.has(reason)) return;
  kpi.invariants.rejectWindow.push(now);
  const cutoff = now - 30_000;
  kpi.invariants.rejectWindow = kpi.invariants.rejectWindow.filter((t) => t >= cutoff);
  kpi.invariants.maxRejectsInWindow = Math.max(kpi.invariants.maxRejectsInWindow, kpi.invariants.rejectWindow.length);
}

export function noteProgress(kpi) {
  const now = Date.now();
  kpi.invariants.maxNoProgressMs = Math.max(kpi.invariants.maxNoProgressMs, now - kpi.invariants.lastProgressAtMs);
  kpi.invariants.lastProgressAtMs = now;
  kpi.invariants.progressEvents = (kpi.invariants.progressEvents ?? 0) + 1;
}

// Rubber-band / desync: client-predicted vs oracle-authoritative position gap.
export function recordDivergence(kpi, clientPos, oraclePos, thresholdCells) {
  if (!clientPos || !oraclePos) return;
  const d = Math.hypot(Number(clientPos.x) - Number(oraclePos.x), Number(clientPos.y) - Number(oraclePos.y));
  kpi.invariants.divergenceSamples += 1;
  kpi.invariants.maxClientOracleDivergenceCells = Math.max(kpi.invariants.maxClientOracleDivergenceCells, round(d));
  if (d > thresholdCells) kpi.invariants.sustainedDivergence += 1;
}

// Reconcile authoritative stats from an oracle actor snapshot.
export function syncAuthoritative(kpi, oracleActor, walletCredits) {
  if (oracleActor?.stats) {
    const s = oracleActor.stats;
    kpi.authoritative.kills = num(s.kills);
    kpi.authoritative.npcKills = num(s.npcKills);
    kpi.authoritative.playerKills = num(s.playerKills);
    kpi.authoritative.deaths = num(s.deaths);
    kpi.authoritative.damageDone = num(s.damageDone);
    kpi.authoritative.damageTaken = num(s.damageTaken);
    kpi.authoritative.shotsFired = num(s.shotsFired);
    kpi.authoritative.hitsDealt = num(s.hitsDealt);
    kpi.authoritative.distanceMovedCells = round(num(s.distanceMovedCells));
    if (oracleActor.stats.longArc) kpi.authoritative.longArc = oracleActor.stats.longArc;
  }
  if (typeof walletCredits === "number") {
    if (kpi.authoritative.creditsStart === null) kpi.authoritative.creditsStart = walletCredits;
    kpi.authoritative.creditsEnd = walletCredits;
  }
}

export function countChat(kpi) { kpi.counters.chatLines += 1; }

// Evaluate invariant breaches against thresholds (fork points, tuned conservative
// for human-paced play; documented in sim-player-design.md).
export function evaluateInvariants(kpi, thresholds) {
  const t = thresholds;
  const b = [];
  if (kpi.invariants.ingressBudgetExhausted > t.maxIngressBudgetExhausted) {
    b.push(`reject-storm: ${kpi.invariants.ingressBudgetExhausted} ingress_budget_exhausted rejects (>${t.maxIngressBudgetExhausted}); human pacing should never rate-limit`);
  }
  if (kpi.invariants.maxRejectsInWindow > t.maxRejectsPer30s) {
    b.push(`reject-storm: ${kpi.invariants.maxRejectsInWindow} non-benign rejects in a 30s window (>${t.maxRejectsPer30s})`);
  }
  if (kpi.invariants.moveFailures > t.maxMoveFailures) {
    b.push(`stuck-loop: ${kpi.invariants.moveFailures} moveTo max-pulses failures (>${t.maxMoveFailures})`);
  }
  if (kpi.invariants.observedDurationMs >= t.maxNoProgressMs && (kpi.invariants.progressEvents ?? 0) === 0) {
    b.push(`stuck-loop: ${Math.round(kpi.invariants.maxNoProgressMs / 1000)}s with no accepted authority command (>${Math.round(t.maxNoProgressMs / 1000)}s)`);
  }
  if (kpi.invariants.sustainedDivergence > t.maxSustainedDivergenceSamples) {
    b.push(`rubber-band: ${kpi.invariants.sustainedDivergence} samples with client/oracle divergence >${t.rubberBandCells} cells (max ${kpi.invariants.maxClientOracleDivergenceCells})`);
  }
  kpi.breaches = b;
  return b;
}

export function finalizeKpi(kpi, thresholds) {
  kpi.endedAtMs = Date.now();
  const observedMs = Math.max(0, kpi.endedAtMs - kpi.startedAtMs);
  kpi.invariants.observedDurationMs = observedMs;
  kpi.invariants.maxNoProgressMs = Math.max(kpi.invariants.maxNoProgressMs, observedMs);
  const hours = Math.max(1e-6, observedMs / 3_600_000);
  kpi.derived = {
    sessionMinutes: round(observedMs / 60_000),
    killsPerHour: round(kpi.authoritative.npcKills / hours),
    rejectRate: kpi.receipts.total > 0 ? round(kpi.receipts.rejected / kpi.receipts.total) : 0,
    creditsDelta: (kpi.authoritative.creditsEnd ?? 0) - (kpi.authoritative.creditsStart ?? 0),
  };
  evaluateInvariants(kpi, thresholds);
  return kpi;
}

export function defaultThresholds() {
  return {
    maxIngressBudgetExhausted: 0,     // human pacing must never trip the token bucket
    maxRejectsPer30s: 12,             // FORK: tune against real reject profile
    maxMoveFailures: 3,               // tolerate rare arrival-misses (terrain); a true freeze is caught by maxNoProgressMs
    maxNoProgressMs: 120_000,         // 2 min with zero accepted commands => frozen
    rubberBandCells: 6,               // client/oracle gap that reads as desync
    maxSustainedDivergenceSamples: 3, // transient gaps ok; sustained is rubber-band
  };
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round(v) { return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0; }
