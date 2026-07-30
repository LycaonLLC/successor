const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 2_500;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const DEFAULT_SITE_URL = "";

type RuntimeHeartbeatTimer = NodeJS.Timeout;

export interface RuntimeHeartbeatConfig {
  siteUrl: string;
  runtimeSecret: string;
  runtimeBearerToken: string;
  shardId: string;
  releaseId: string;
}

export interface RuntimeHeartbeatLogger {
  warn(fields: { reason: string }, message: string): void;
  info(fields: { reason: string }, message: string): void;
}

export interface RuntimeHeartbeatOptions {
  config: RuntimeHeartbeatConfig | null;
  isReady: () => boolean;
  logger?: RuntimeHeartbeatLogger;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export function runtimeHeartbeatConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeHeartbeatConfig | null {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const siteUrl = env.SUCCESSOR_SITE_URL?.trim() ?? DEFAULT_SITE_URL;
  const hosted = nodeEnv !== "test" && (nodeEnv === "production" || siteUrl.length > 0);
  if (!hosted) return null;

  const runtimeSecret = env.SUCCESSOR_RUNTIME_SECRET?.trim();
  const runtimeBearerToken = env.SUCCESSOR_RUNTIME_BEARER_TOKEN?.trim();
  const shardId = env.SUCCESSOR_SHARD_ID?.trim();
  const releaseId = env.SUCCESSOR_RELEASE_ID?.trim();
  if (!siteUrl || !runtimeSecret || !runtimeBearerToken || !shardId || !releaseId) return null;
  return { siteUrl: siteUrl.replace(/\/+$/u, ""), runtimeSecret, runtimeBearerToken, shardId, releaseId };
}

export class RuntimeHeartbeat {
  private readonly config: RuntimeHeartbeatConfig | null;
  private readonly isReady: () => boolean;
  private readonly logger?: RuntimeHeartbeatLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private interval: RuntimeHeartbeatTimer | undefined;
  private controller: AbortController | undefined;
  private started = false;
  private failureReason: string | undefined;
  private lastFailureLogAt = 0;

  constructor(options: RuntimeHeartbeatOptions) {
    this.config = options.config;
    this.isReady = options.isReady;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || !this.config) return;
    this.started = true;
    this.interval = setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.controller?.abort();
    this.controller = undefined;
  }

  private async tick(): Promise<void> {
    if (!this.started || !this.config || this.controller || !this.isReady()) return;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.config.siteUrl}/api/v1/storefront/successor/runtime/heartbeat`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Successor-Runtime/1.0",
          "x-successor-runtime-key": this.config.runtimeSecret,
          Authorization: `Bearer ${this.config.runtimeBearerToken}`,
          "x-successor-shard-id": this.config.shardId,
          "x-successor-release-id": this.config.releaseId,
        },
        body: JSON.stringify({ readiness: "ready" }),
        signal: controller.signal,
      });
      if (!response.ok) {
        this.reportFailure(`http_${boundedStatus(response.status)}`);
      } else {
        this.reportSuccess();
      }
    } catch {
      if (!this.started) return;
      this.reportFailure(controller.signal.aborted ? "timeout" : "network_error");
    } finally {
      clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }

  private reportFailure(reason: string): void {
    const now = this.now();
    if (this.failureReason !== reason || now - this.lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
      this.logger?.warn({ reason }, "successor runtime heartbeat failed");
      this.lastFailureLogAt = now;
    }
    this.failureReason = reason;
  }

  private reportSuccess(): void {
    if (this.failureReason) {
      this.logger?.info({ reason: "recovered" }, "successor runtime heartbeat recovered");
      this.failureReason = undefined;
    }
  }
}

function boundedStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
}
