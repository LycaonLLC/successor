import type { GameShardStatus } from "./shard.js";

export const gameMetricsSchema = "successor.metrics.v1";

export interface GameMetricsPayload {
  schema: typeof gameMetricsSchema;
  tick: number;
  authority: GameShardStatus["authority"]["metrics"] | null;
  exchange: unknown;
}

export function metricsPayloadFromStatus(status: GameShardStatus): GameMetricsPayload {
  const authority = status.authority as GameShardStatus["authority"] & { exchangeMetrics?: unknown };
  return {
    schema: gameMetricsSchema,
    tick: status.tick,
    authority: status.authority.metrics ?? null,
    exchange: authority.exchangeMetrics ?? null,
  };
}
