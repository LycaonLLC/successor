import type {
  GameActorLongArcProfileSnapshot,
  GameActorRecentStatsSnapshot,
  GameActorStatsSnapshot,
} from "./protocol.js";

type ActorStatsForLongArc = Omit<GameActorStatsSnapshot, "longArc">;

export function deriveActorLongArcProfile(stats: ActorStatsForLongArc): GameActorLongArcProfileSnapshot {
  const shotsFired = finite(stats.shotsFired);
  const hitsDealt = finite(stats.hitsDealt);
  const damageDone = finite(stats.damageDone);
  const damageTaken = finite(stats.damageTaken);
  const kills = finite(stats.kills);
  const deaths = finite(stats.deaths);
  const moved = finite(stats.distanceMovedCells);
  const recent10s = recent(stats.recent10s);
  const recent60s = recent(stats.recent60s);
  const recentDamageDone = recent60s.damageDone > 0 ? recent60s.damageDone : recent10s.damageDone;
  const recentDamageTaken = recent60s.damageTaken > 0 ? recent60s.damageTaken : recent10s.damageTaken;
  const pressureScore = round((recentDamageDone - recentDamageTaken) / Math.max(40, recentDamageDone + recentDamageTaken));

  return {
    schema: "successor.actor-long-arc-profile.v1",
    sample: "authority_lifetime",
    combat: {
      hitRate: ratio(hitsDealt, shotsFired),
      killDeathRatio: round(kills / Math.max(1, deaths)),
      damageTradeRatio: ratio(damageDone, damageTaken),
      damagePerShot: ratio(damageDone, shotsFired),
      damagePerHit: ratio(damageDone, hitsDealt),
      damageTakenPerDeath: ratio(damageTaken, deaths),
      netDamage: round(damageDone - damageTaken),
    },
    mobility: {
      distanceMovedCells: round(moved),
      damageDonePerCell: ratio(damageDone, moved),
      damageTakenPerCell: ratio(damageTaken, moved),
      cellsPerDeath: ratio(moved, deaths),
    },
    recent: {
      pressureScore,
      damageDone10s: round(recent10s.damageDone),
      damageTaken10s: round(recent10s.damageTaken),
      damageDone60s: round(recent60s.damageDone),
      damageTaken60s: round(recent60s.damageTaken),
      kills60s: round(recent60s.kills),
      deaths60s: round(recent60s.deaths),
      shots60s: round(recent60s.shotsFired),
      hits60s: round(recent60s.hitsDealt),
      moved60s: round(recent60s.distanceMovedCells),
    },
    engagement: {
      lastDamageDealtTick: finiteOrNull(stats.lastDamageDealtTick),
      lastDamageTakenTick: finiteOrNull(stats.lastDamageTakenTick),
      lastKillTick: finiteOrNull(stats.lastKillTick),
      lastDeathCause: stats.lastDeath?.cause ?? null,
      lastDeathKillerActorId: stats.lastDeath?.killerActorId ?? null,
    },
  };
}

function recent(row: GameActorRecentStatsSnapshot | undefined): GameActorRecentStatsSnapshot {
  return {
    windowSeconds: finite(row?.windowSeconds),
    damageDone: finite(row?.damageDone),
    damageTaken: finite(row?.damageTaken),
    kills: finite(row?.kills),
    npcKills: finite(row?.npcKills),
    playerKills: finite(row?.playerKills),
    deaths: finite(row?.deaths),
    shotsFired: finite(row?.shotsFired),
    hitsDealt: finite(row?.hitsDealt),
    hitsTaken: finite(row?.hitsTaken),
    distanceMovedCells: finite(row?.distanceMovedCells),
  };
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return round(numerator / denominator);
}

function finite(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function finiteOrNull(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
