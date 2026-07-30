import { createHash, createHmac, randomBytes, scrypt as nodeScrypt, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import {
  bugReportCategories,
  redactBugReportDiagnostics,
  type PersistBugReportInput,
  type PersistedBugReport,
} from "../support/bugReports.js";

const require = createRequire(import.meta.url);
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): { get(...parameters: unknown[]): Record<string, unknown> | undefined; all(...parameters: unknown[]): unknown[]; run(...parameters: unknown[]): { changes: number | bigint } };
  close(): void;
};
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => SqliteDatabase };

const KDF_N = 32_768;
const KDF_R = 8;
const KDF_P = 1;
const KDF_MAXMEM = 64 * 1024 * 1024;
const KDF_KEYLEN = 64;
const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CREDENTIAL_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const DEVICE_CREDENTIAL_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
const LAUNCH_TTL_MS = 45 * 1000;
const PLAY_TICKET_WINDOW_MS = 60 * 1000;
const MAX_PASSWORD_BYTES = 256;
const MAX_BODY_BYTES = 64 * 1024;
const DUMMY_SALT = Buffer.alloc(16, 0x5a);
const DUMMY_HASH = Buffer.alloc(KDF_KEYLEN, 0xa5);
const DEFAULT_MAX_OUTSTANDING_LAUNCHES_ACCOUNT = 16;
const DEFAULT_MAX_OUTSTANDING_LAUNCHES_ISSUER = 8;
const DEFAULT_MAX_OUTSTANDING_LAUNCHES_DEVICE = 8;
const DEFAULT_PLAY_TICKET_MINTS_PER_ACCOUNT = 30;
const DEFAULT_DEVICE_POLL_ATTEMPT_CAP = 32;
const DEFAULT_MAX_OUTSTANDING_DEVICE_AUTHORIZATIONS = 256;

export type AccountStatus = "active" | "pending_deletion";
export type SessionKind = "pre_auth" | "auth";
export type DeviceStatus = "pending" | "approved" | "denied" | "exchanged" | "revoked" | "expired";
export type LaunchPurpose = "game" | "chat";
export type LaunchProvenanceKind = "browser_session" | "device_credential" | "device_authorization";
export type AlphaErrorCode =
  | "ALPHA_RUNTIME_UNSUPPORTED"
  | "ALPHA_MIGRATION_INVALID"
  | "ALPHA_MIGRATION_CHECKSUM_MISMATCH"
  | "ALPHA_MIGRATION_NEWER"
  | "ALPHA_MIGRATION_UNKNOWN"
  | "ALPHA_MIGRATION_CORRUPT"
  | "ALPHA_REGISTRATION_CLOSED"
  | "ALPHA_REGISTRATION_CAP"
  | "ALPHA_CALLSIGN_INVALID"
  | "ALPHA_CALLSIGN_TAKEN"
  | "ALPHA_ACCOUNT_NOT_FOUND"
  | "ALPHA_ACCOUNT_DELETED"
  | "ALPHA_PASSWORD_INVALID"
  | "ALPHA_SESSION_INVALID"
  | "ALPHA_SESSION_EXPIRED"
  | "ALPHA_CSRF_INVALID"
  | "ALPHA_DEVICE_INVALID"
  | "ALPHA_DEVICE_SLOW_DOWN"
  | "ALPHA_DEVICE_SCOPE"
  | "ALPHA_DEVICE_STATE"
  | "ALPHA_CREDENTIAL_INVALID"
  | "ALPHA_LAUNCH_INVALID"
  | "ALPHA_LAUNCH_REPLAY"
  | "ALPHA_LEGAL_REQUIRED"
  | "ALPHA_ACCOUNT_PENDING_DELETION"
  | "ALPHA_LAUNCH_CAP"
  | "ALPHA_PLAY_TICKET_RATE"
  | "ALPHA_DEVICE_CAP";

export class AlphaControlStoreError extends Error {
  readonly code: AlphaErrorCode;
  constructor(code: AlphaErrorCode, message: string = code) {
    super(message);
    this.name = "AlphaControlStoreError";
    this.code = code;
  }
}

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const MIGRATION_SQL_V1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
CREATE TABLE accounts (
  account_id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL UNIQUE,
  callsign TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  kdf_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending_deletion')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE legal_acceptances (
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL,
  version TEXT NOT NULL,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, legal_name)
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_hash TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pre_auth', 'auth')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX sessions_account_idx ON sessions(account_id);
CREATE TABLE device_authorizations (
  authorization_id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL UNIQUE,
  user_code_hmac TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'exchanged', 'revoked', 'expired')),
  account_id TEXT REFERENCES accounts(account_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_poll_at INTEGER,
  poll_interval_ms INTEGER NOT NULL,
  poll_attempts INTEGER NOT NULL,
  approved_at INTEGER,
  exchanged_at INTEGER
);
CREATE TABLE device_credentials (
  credential_id TEXT PRIMARY KEY,
  credential_hash TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE launches (
  launch_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
  owner_ref TEXT NOT NULL,
  character_id TEXT NOT NULL,
  shard_id TEXT NOT NULL,
  client_release_id TEXT NOT NULL,
  server_release_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  provenance_kind TEXT NOT NULL CHECK (provenance_kind IN ('browser_session', 'device_credential', 'device_authorization')),
  provenance_id TEXT NOT NULL
);
CREATE INDEX launches_account_idx ON launches(account_id);
CREATE INDEX launches_provenance_idx ON launches(provenance_kind, provenance_id, revoked_at, expires_at);
CREATE INDEX launches_issuer_active_idx ON launches(account_id, issuer, revoked_at, expires_at);
CREATE INDEX launches_mint_window_idx ON launches(account_id, created_at);
CREATE INDEX device_authorizations_expiry_idx ON device_authorizations(status, expires_at);
CREATE INDEX device_credentials_expiry_idx ON device_credentials(revoked_at, idle_expires_at, absolute_expires_at);
CREATE TRIGGER launches_provenance_immutable_update BEFORE UPDATE OF provenance_kind, provenance_id ON launches
BEGIN
  SELECT RAISE(ABORT, 'launch provenance immutable');
END;
CREATE TABLE launch_capabilities (
  capability_id TEXT PRIMARY KEY,
  launch_id TEXT NOT NULL REFERENCES launches(launch_id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('game', 'chat')),
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX launch_purpose_once_idx ON launch_capabilities(launch_id, purpose);
`;

const MIGRATION_SQL_V2 = `
CREATE TABLE bug_reports (
  report_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  account_id TEXT REFERENCES accounts(account_id) ON DELETE SET NULL,
  owner_ref TEXT NOT NULL,
  character_id TEXT NOT NULL,
  launch_id TEXT REFERENCES launches(launch_id) ON DELETE SET NULL,
  shard_id TEXT NOT NULL,
  client_release_id TEXT NOT NULL,
  server_release_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('gameplay', 'interface', 'connection', 'graphics_audio', 'other')),
  body TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
  resolution_note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bug_reports_status_created_idx ON bug_reports(status, created_at DESC);
CREATE INDEX bug_reports_character_created_idx ON bug_reports(character_id, created_at DESC);
`;

export const MIGRATIONS: readonly MigrationDefinition[] = Object.freeze([
  {
    version: 1,
    name: "alpha-control-current-v1",
    sql: MIGRATION_SQL_V1,
    checksum: "76421d1f10191c6c7bf40f75610c4ae9b64931dd9ecf63ad76f3365f14827dc5",
  },
  {
    version: 2,
    name: "alpha-control-bug-reports-v2",
    sql: MIGRATION_SQL_V2,
    checksum: "b42f94dbcc2939109e5fcbb28069ddc215bb2eb8873df522b704aee701994c73",
  },
]);

export interface ControlSchemaHead {
  readonly version: number;
  readonly checksum: string;
}

/**
 * World durability is bound to the control schema head, but an explicitly
 * additive control migration must not invalidate an otherwise compatible
 * gameplay checkpoint. Exact heads always match (including the legacy
 * non-standalone `{0, ""}` sentinel); the only cross-head lineage currently
 * accepted is the checksum-pinned v1 -> v2 bug-report-ledger addition.
 */
export function controlSchemaHeadCanUpgrade(
  candidate: unknown,
  expected: unknown,
): boolean {
  if (!isControlSchemaHead(candidate) || !isControlSchemaHead(expected)) return false;
  if (
    candidate.version === expected.version
    && candidate.checksum === expected.checksum
  ) {
    return true;
  }
  const v1 = MIGRATIONS[0];
  const v2 = MIGRATIONS[1];
  return candidate.version === v1?.version
    && candidate.checksum === v1.checksum
    && expected.version === v2?.version
    && expected.checksum === v2.checksum;
}

function isControlSchemaHead(value: unknown): value is ControlSchemaHead {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Number.isSafeInteger((value as { version?: unknown }).version)
    && typeof (value as { checksum?: unknown }).checksum === "string";
}

export interface AlphaControlStoreOptions {
  readonly dbPath: string;
  readonly registrationOpen?: boolean;
  readonly registrationCap?: number;
  readonly claimSecret: Uint8Array;
  readonly now?: () => number;
  readonly busyTimeoutMs?: number;
  readonly requiredLegalVersions?: Readonly<Record<string, string>>;
  readonly maxOutstandingLaunchesPerAccount?: number;
  readonly maxOutstandingLaunchesPerIssuer?: number;
  readonly maxOutstandingLaunchesPerDevice?: number;
  readonly playTicketMintLimitPerAccount?: number;
  readonly devicePollAttemptCap?: number;
  readonly maxOutstandingDeviceAuthorizations?: number;
  readonly migrations?: readonly MigrationDefinition[];
}

export interface AccountView {
  readonly accountId: string;
  readonly ownerRef: string;
  readonly callsign: string;
  readonly status: AccountStatus;
  readonly createdAt: number;
}
export interface RegistrationInput {
  readonly callsign: string;
  readonly password: string;
  readonly legalAcceptance?: Readonly<Record<string, string>>;
}
export interface SessionCredentials {
  readonly token: string;
  readonly csrfToken: string;
  readonly expiresAt: number;
  readonly accountId?: string;
}
export interface SessionView {
  readonly sessionId: string;
  readonly accountId?: string;
  readonly kind: SessionKind;
  readonly expiresAt: number;
  readonly absoluteExpiresAt: number;
}
export interface DeviceStartInput {
  readonly clientId: string;
  readonly releaseId: string;
  readonly scopes: readonly string[];
}
export interface DeviceStartResult {
  readonly authorizationId: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresAt: number;
  readonly pollIntervalMs: number;
  readonly scopes: readonly string[];
}
export interface DevicePollResult {
  readonly status: DeviceStatus | "slow_down";
  readonly expiresAt: number;
  readonly retryAfterMs?: number;
  readonly credential?: string;
  readonly accountId?: string;
  readonly scopes?: readonly string[];
}
export interface LaunchProvenanceInput {
  readonly kind: LaunchProvenanceKind;
  readonly id: string;
}

export interface LaunchInput {
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  readonly provenance: LaunchProvenanceInput;
}
export interface LaunchEnvelope {
  readonly launchId: string;
  readonly gameTicket: string;
  readonly chatTicket: string;
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  readonly expiresAt: number;
}
export interface LaunchProvenance {
  readonly launchId: string;
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly issuer: string;
  readonly provenanceKind?: LaunchProvenanceKind;
  readonly provenanceId?: string;
}

export interface RedeemCapabilityInput {
  readonly token: string;
  readonly purpose: LaunchPurpose;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
}

export interface CharacterLaunchAdapter {
  list(ownerRef: string): unknown[];
  get(characterId: string, ownerRef: string): unknown | null;
}

export interface RedeemLaunchInput {
  readonly token: string;
  readonly purpose: LaunchPurpose;
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
}
export interface RedeemedLaunch {
  readonly launchId: string;
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly shardId: string;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  readonly purpose: LaunchPurpose;
}

function nowMs(clock: () => number): number {
  return Math.floor(clock());
}
function token(): string {
  return randomBytes(32).toString("base64url");
}
function id(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function hmac(secret: Uint8Array, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}
function humanCode(): string {
  return randomBytes(8).toString("base64url").replace(/[-_]/g, "").slice(0, 10).toUpperCase();
}
function normalizeCode(code: string): string {
  return code.normalize("NFKC").trim().toUpperCase();
}
export function normalizeCallsign(callsign: string): string {
  const normalized = callsign.normalize("NFKC").trim().toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(normalized)) {
    throw new AlphaControlStoreError("ALPHA_CALLSIGN_INVALID");
  }
  return normalized;
}
type ParsedKdf = { version: number; n: number; r: number; p: number; salt: Buffer; hash: Buffer };

function assertBody(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_BODY_BYTES) {
    throw new AlphaControlStoreError("ALPHA_PASSWORD_INVALID", "input too large");
  }
}
function assertPassword(value: string): void {
  assertBody(value);
  if (Buffer.byteLength(value, "utf8") === 0 || Buffer.byteLength(value, "utf8") > MAX_PASSWORD_BYTES) {
    throw new AlphaControlStoreError("ALPHA_PASSWORD_INVALID");
  }
}
function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
function parseKdf(encoded: string): ParsedKdf {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") throw new AlphaControlStoreError("ALPHA_PASSWORD_INVALID");
  const versionText = parts[1];
  const nText = parts[2];
  const rText = parts[3];
  const pText = parts[4];
  const hashText = parts[5];
  if (!versionText || !nText || !rText || !pText || !hashText) throw new AlphaControlStoreError("ALPHA_PASSWORD_INVALID");
  const [saltText, keyText] = hashText.split(":");
  const version = Number(versionText.replace("v", ""));
  const n = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (!Number.isSafeInteger(version) || !Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || !saltText || !keyText) {
    throw new AlphaControlStoreError("ALPHA_PASSWORD_INVALID");
  }
  return { version, n, r, p, salt: Buffer.from(saltText, "hex"), hash: Buffer.from(keyText, "hex") };
}
async function deriveScrypt(password: string, salt: Uint8Array, keylen: number, options: { N: number; r: number; p: number; maxmem: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

async function passwordHash(password: string, salt = randomBytes(16)): Promise<{ encoded: string; salt: string }> {
  assertPassword(password);
  const output = await deriveScrypt(password, salt, KDF_KEYLEN, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM });
  return { encoded: `scrypt$v1$${KDF_N}$${KDF_R}$${KDF_P}$${salt.toString("hex")}:${output.toString("hex")}`, salt: salt.toString("hex") };
}

class KdfSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
const kdfSemaphore = new KdfSemaphore(4);

async function verifyPasswordEncoded(password: string, encoded: string): Promise<{ ok: boolean; rehash: boolean }> {
  assertPassword(password);
  let parsed: ParsedKdf;
  try {
    parsed = parseKdf(encoded);
  } catch {
    await deriveScrypt(password, DUMMY_SALT, KDF_KEYLEN, { N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM });
    return { ok: false, rehash: false };
  }
  const derived = await deriveScrypt(password, parsed.salt, parsed.hash.length, { N: parsed.n, r: parsed.r, p: parsed.p, maxmem: KDF_MAXMEM });
  const ok = equalBytes(derived, parsed.hash);
  return { ok, rehash: ok && (parsed.version !== 1 || parsed.n !== KDF_N || parsed.r !== KDF_R || parsed.p !== KDF_P) };
}

function migrationChecksum(migration: MigrationDefinition): string {
  return createHash("sha256").update(migration.sql, "utf8").digest("hex");
}
function fail(code: AlphaErrorCode, message?: string): never {
  throw new AlphaControlStoreError(code, message);
}

export class AlphaControlStore {
  private readonly db: SqliteDatabase;
  private readonly clock: () => number;
  private readonly claimSecret: Uint8Array;
  private readonly registrationOpen: boolean;
  private readonly registrationCap: number;
  private readonly requiredLegalVersions: Readonly<Record<string, string>>;
  private readonly maxOutstandingLaunchesPerAccount: number;
  private readonly maxOutstandingLaunchesPerIssuer: number;
  private readonly maxOutstandingLaunchesPerDevice: number;
  private readonly playTicketMintLimitPerAccount: number;
  private readonly devicePollAttemptCap: number;
  private readonly maxOutstandingDeviceAuthorizations: number;
  private closed = false;

  constructor(options: AlphaControlStoreOptions) {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22 || typeof DatabaseSync !== "function") fail("ALPHA_RUNTIME_UNSUPPORTED", "Node >= 22 with node:sqlite is required");
    if (options.claimSecret.byteLength < 32) fail("ALPHA_MIGRATION_INVALID", "claim secret must be at least 256 bits");
    if (!options.dbPath) fail("ALPHA_MIGRATION_INVALID", "dbPath is required");
    this.clock = options.now ?? Date.now;
    this.claimSecret = Buffer.from(options.claimSecret);
    this.registrationOpen = options.registrationOpen ?? false;
    this.registrationCap = options.registrationCap ?? 64;
    this.requiredLegalVersions = options.requiredLegalVersions ?? {};
    this.maxOutstandingLaunchesPerAccount = options.maxOutstandingLaunchesPerAccount ?? DEFAULT_MAX_OUTSTANDING_LAUNCHES_ACCOUNT;
    this.maxOutstandingLaunchesPerIssuer = options.maxOutstandingLaunchesPerIssuer ?? DEFAULT_MAX_OUTSTANDING_LAUNCHES_ISSUER;
    this.maxOutstandingLaunchesPerDevice = options.maxOutstandingLaunchesPerDevice ?? DEFAULT_MAX_OUTSTANDING_LAUNCHES_DEVICE;
    this.playTicketMintLimitPerAccount = options.playTicketMintLimitPerAccount ?? DEFAULT_PLAY_TICKET_MINTS_PER_ACCOUNT;
    this.devicePollAttemptCap = options.devicePollAttemptCap ?? DEFAULT_DEVICE_POLL_ATTEMPT_CAP;
    this.maxOutstandingDeviceAuthorizations = options.maxOutstandingDeviceAuthorizations ?? DEFAULT_MAX_OUTSTANDING_DEVICE_AUTHORIZATIONS;
    if (![this.maxOutstandingLaunchesPerAccount, this.maxOutstandingLaunchesPerIssuer, this.maxOutstandingLaunchesPerDevice, this.playTicketMintLimitPerAccount, this.devicePollAttemptCap, this.maxOutstandingDeviceAuthorizations].every((value) => Number.isInteger(value) && value >= 1 && value <= 10000)) fail("ALPHA_MIGRATION_INVALID", "invalid alpha cap");
    if (!Number.isInteger(this.registrationCap) || this.registrationCap < 1) fail("ALPHA_MIGRATION_INVALID", "invalid registration cap");
    this.db = new DatabaseSync(options.dbPath);
    try {
      this.applyPragmas(options.busyTimeoutMs ?? 5000);
      this.applyMigrations(options.migrations ?? MIGRATIONS);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private applyPragmas(busyTimeoutMs: number): void {
    if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 120_000) fail("ALPHA_MIGRATION_INVALID", "invalid busy timeout");
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;");
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    const journal = String(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase();
    const synchronous = Number(this.db.prepare("PRAGMA synchronous").get()?.synchronous);
    const foreignKeys = Number(this.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
    const trustedSchema = Number(this.db.prepare("PRAGMA trusted_schema").get()?.trusted_schema);
    const busyTimeout = Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout);
    if (journal !== "wal" || synchronous !== 2 || foreignKeys !== 1 || trustedSchema !== 0 || busyTimeout !== busyTimeoutMs) {
      fail("ALPHA_MIGRATION_CORRUPT", "startup pragma audit failed");
    }
  }

  private applyMigrations(migrations: readonly MigrationDefinition[]): void {
    const defs = [...migrations].sort((a, b) => a.version - b.version);
    if (defs.length === 0 || defs.some((migration, index) => migration.version !== index + 1 || migration.name.length === 0 || migrationChecksum(migration) !== migration.checksum)) {
      fail("ALPHA_MIGRATION_CHECKSUM_MISMATCH", "migration definition checksum mismatch");
    }
    const tableExists = Boolean(this.db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get());
    if (!tableExists) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const migration = defs[0];
        if (!migration) fail("ALPHA_MIGRATION_INVALID");
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migration.checksum, nowMs(this.clock));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    const rows = this.db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>;
    const maxApplied = rows.at(-1)?.version ?? 0;
    if (maxApplied > defs.length) fail("ALPHA_MIGRATION_NEWER", "database migration is newer than this binary");
    for (const row of rows) {
      const migration = defs.find((candidate) => candidate.version === row.version);
      if (!migration) fail("ALPHA_MIGRATION_UNKNOWN", `unknown migration ${row.version}`);
      if (migration.checksum !== row.checksum || migration.name !== row.name) fail("ALPHA_MIGRATION_CHECKSUM_MISMATCH", `migration ${row.version} checksum mismatch`);
    }
    for (const migration of defs.filter((candidate) => candidate.version > maxApplied)) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migration.sql);
        this.db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migration.checksum, nowMs(this.clock));
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private accountRow(accountId: string): AccountView {
    const row = this.db.prepare("SELECT account_id, owner_ref, callsign, status, created_at FROM accounts WHERE account_id = ?").get(accountId) as { account_id: string; owner_ref: string; callsign: string; status: AccountStatus; created_at: number } | undefined;
    if (!row) fail("ALPHA_ACCOUNT_NOT_FOUND");
    return { accountId: row.account_id, ownerRef: row.owner_ref, callsign: row.callsign, status: row.status, createdAt: row.created_at };
  }

  async registerAccount(input: RegistrationInput): Promise<AccountView> {
    if (!this.registrationOpen) fail("ALPHA_REGISTRATION_CLOSED");
    const callsign = normalizeCallsign(input.callsign);
    assertPassword(input.password);
    const hashed = await kdfSemaphore.run(() => passwordHash(input.password));
    const now = nowMs(this.clock);
    return this.transaction(() => {
      const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE status = 'active'").get() as { count: number }).count);
      if (count >= this.registrationCap) fail("ALPHA_REGISTRATION_CAP");
      const ownerRef = `owner_${randomBytes(16).toString("hex")}`;
      const accountId = id("acct");
      try {
        this.db.prepare("INSERT INTO accounts(account_id, owner_ref, callsign, password_hash, password_salt, kdf_version, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)").run(accountId, ownerRef, callsign, hashed.encoded, hashed.salt, 1, now);
      } catch (error) {
        if (String(error).includes("UNIQUE")) fail("ALPHA_CALLSIGN_TAKEN");
        throw error;
      }
      for (const [legalName, version] of Object.entries(input.legalAcceptance ?? {})) {
        this.db.prepare("INSERT INTO legal_acceptances(account_id, legal_name, version, accepted_at) VALUES (?, ?, ?, ?)").run(accountId, legalName, version, now);
      }
      return this.accountRow(accountId);
    });
  }

  async verifyPassword(callsignInput: string, password: string): Promise<AccountView> {
    const callsign = normalizeCallsign(callsignInput);
    assertPassword(password);
    const row = this.db.prepare("SELECT account_id, password_hash, status FROM accounts WHERE callsign = ?").get(callsign) as { account_id: string; password_hash: string; status: AccountStatus } | undefined;
    const result = await kdfSemaphore.run(() => verifyPasswordEncoded(password, row?.password_hash ?? `scrypt$v1$${KDF_N}$${KDF_R}$${KDF_P}$${DUMMY_SALT.toString("hex")}:${DUMMY_HASH.toString("hex")}`));
    if (!row || !result.ok) fail("ALPHA_PASSWORD_INVALID");
    if (row.status !== "active") fail("ALPHA_ACCOUNT_DELETED");
    if (result.rehash) {
      const replacement = await kdfSemaphore.run(() => passwordHash(password));
      this.db.prepare("UPDATE accounts SET password_hash=?, password_salt=?, kdf_version=1 WHERE account_id=? AND status='active'").run(replacement.encoded, replacement.salt, row.account_id);
    }
    return this.accountRow(row.account_id);
  }

  async authenticate(callsignInput: string, password: string): Promise<{ account: AccountView; session: SessionCredentials; rehashed: boolean }> {
    const callsign = normalizeCallsign(callsignInput);
    assertPassword(password);
    const row = this.db.prepare("SELECT account_id, password_hash, status FROM accounts WHERE callsign = ?").get(callsign) as { account_id: string; password_hash: string; status: AccountStatus } | undefined;
    const result = await kdfSemaphore.run(() => verifyPasswordEncoded(password, row?.password_hash ?? `scrypt$v1$${KDF_N}$${KDF_R}$${KDF_P}$${DUMMY_SALT.toString("hex")}:${DUMMY_HASH.toString("hex")}`));
    if (!row || !result.ok) fail("ALPHA_PASSWORD_INVALID");
    if (row.status !== "active") fail("ALPHA_ACCOUNT_DELETED");
    if (result.rehash) {
      const replacement = await kdfSemaphore.run(() => passwordHash(password));
      this.db.prepare("UPDATE accounts SET password_hash=?, password_salt=?, kdf_version=1 WHERE account_id=? AND status='active'").run(replacement.encoded, replacement.salt, row.account_id);
    }
    const account = this.accountRow(row.account_id);
    return { account, session: await this.createAuthSession(row.account_id), rehashed: result.rehash };
  }

  async createPreAuthSession(): Promise<SessionCredentials> {
    return this.createSession("pre_auth");
  }
  getAccount(accountId: string): AccountView {
    return this.accountRow(accountId);
  }

  createBugReport(input: PersistBugReportInput): PersistedBugReport {
    const body = input.body
      .trim()
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
    const validId = (value: string, max: number): boolean => {
      const bytes = Buffer.byteLength(value, "utf8");
      return bytes >= 1 && bytes <= max;
    };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.requestId)
      || !bugReportCategories.includes(input.category)
      || body.length < 20
      || body.length > 4_000
      || !validId(input.ownerRef, 128)
      || !validId(input.characterId, 64)
      || !validId(input.shardId, 128)
      || !validId(input.clientReleaseId, 128)
      || !validId(input.serverReleaseId, 256)
      || (input.accountId !== undefined && !validId(input.accountId, 128))
      || (input.launchId !== undefined && !validId(input.launchId, 128))
    ) {
      fail("ALPHA_MIGRATION_INVALID", "invalid bug report");
    }
    const diagnostics = redactBugReportDiagnostics(input.diagnostics);
    const diagnosticsJson = JSON.stringify(diagnostics);
    if (Buffer.byteLength(body, "utf8") > 16 * 1_024 || Buffer.byteLength(diagnosticsJson, "utf8") > 24 * 1_024) {
      fail("ALPHA_MIGRATION_INVALID", "bug report is too large");
    }
    const createdAt = nowMs(this.clock);
    const reportId = id("bug");
    this.db.prepare(`
      INSERT OR IGNORE INTO bug_reports(
        report_id, request_id, account_id, owner_ref, character_id, launch_id,
        shard_id, client_release_id, server_release_id, category, body,
        diagnostics_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reportId,
      input.requestId,
      input.accountId ?? null,
      input.ownerRef,
      input.characterId,
      input.launchId ?? null,
      input.shardId,
      input.clientReleaseId,
      input.serverReleaseId,
      input.category,
      body,
      diagnosticsJson,
      createdAt,
      createdAt,
    );
    const row = this.db.prepare(
      "SELECT report_id, created_at FROM bug_reports WHERE request_id = ?",
    ).get(input.requestId) as { report_id: string; created_at: number } | undefined;
    if (!row) fail("ALPHA_MIGRATION_CORRUPT", "bug report insert failed");
    return { reportId: row.report_id, createdAt: row.created_at };
  }

  async createAuthSession(accountId: string): Promise<SessionCredentials> {
    const account = this.accountRow(accountId);
    if (account.status !== "active") fail("ALPHA_ACCOUNT_DELETED");
    return this.createSession("auth", accountId);
  }
  private async createSession(kind: SessionKind, accountId?: string): Promise<SessionCredentials> {
    const now = nowMs(this.clock);
    const sessionToken = token();
    const csrfToken = token();
    const absolute = now + SESSION_ABSOLUTE_MS;
    const idle = Math.min(now + SESSION_IDLE_MS, absolute);
    this.db.prepare("INSERT INTO sessions(session_id, token_hash, csrf_hash, account_id, kind, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id("sess"), digest(sessionToken), digest(csrfToken), accountId ?? null, kind, now, now, idle, absolute);
    return { token: sessionToken, csrfToken, expiresAt: idle, accountId };
  }
  async rotateSession(oldToken: string, accountId: string): Promise<SessionCredentials> {
    const session = this.requireSession(oldToken);
    if (session.kind !== "pre_auth") fail("ALPHA_SESSION_INVALID");
    this.transaction(() => this.db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL").run(nowMs(this.clock), digest(oldToken)));
    return this.createAuthSession(accountId);
  }
  private requireSession(rawToken: string): SessionView & { sessionId: string; csrfHash: string; revokedAt?: number } {
    const row = this.db.prepare("SELECT session_id, account_id, kind, csrf_hash, idle_expires_at, absolute_expires_at, revoked_at FROM sessions WHERE token_hash=?").get(digest(rawToken)) as { session_id: string; account_id?: string; kind: SessionKind; csrf_hash: string; idle_expires_at: number; absolute_expires_at: number; revoked_at?: number } | undefined;
    if (!row || row.revoked_at) fail("ALPHA_SESSION_INVALID");
    const now = nowMs(this.clock);
    if (now >= row.idle_expires_at || now >= row.absolute_expires_at) fail("ALPHA_SESSION_EXPIRED");
    return { sessionId: row.session_id, accountId: row.account_id, kind: row.kind, csrfHash: row.csrf_hash, expiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at, revokedAt: row.revoked_at };
  }
  async inspectSession(rawToken: string, csrfToken?: string): Promise<SessionView> {
    const session = this.requireSession(rawToken);
    if (csrfToken && !equalBytes(Buffer.from(session.csrfHash, "hex"), Buffer.from(digest(csrfToken), "hex"))) fail("ALPHA_CSRF_INVALID");
    const now = nowMs(this.clock);
    const idle = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt);
    this.db.prepare("UPDATE sessions SET last_seen_at=?, idle_expires_at=? WHERE session_id=? AND revoked_at IS NULL").run(now, idle, session.sessionId);
    return { sessionId: session.sessionId, accountId: session.accountId, kind: session.kind, expiresAt: idle, absoluteExpiresAt: session.absoluteExpiresAt };
  }
  async revokeSession(rawToken: string): Promise<{ accountId?: string; launchIds: string[] }> {
    return this.transaction(() => {
      const session = this.requireSession(rawToken);
      const now = nowMs(this.clock);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL").run(now, session.sessionId);
      if (!session.accountId) return { launchIds: [] };
      const launchIds = this.revokeLaunchesByProvenance(session.accountId, "browser_session", session.sessionId, now);
      return { accountId: session.accountId, launchIds };
    });
  }
  async refreshCsrf(rawToken: string): Promise<string> {
    const session = this.requireSession(rawToken);
    const csrfToken = token();
    this.db.prepare("UPDATE sessions SET csrf_hash=? WHERE session_id=? AND revoked_at IS NULL").run(digest(csrfToken), session.sessionId);
    return csrfToken;
  }

  async acceptLegal(accountId: string, legalName: string, version: string): Promise<void> {
    const account = this.accountRow(accountId);
    if (account.status !== "active") fail("ALPHA_ACCOUNT_DELETED");
    this.db.prepare("INSERT INTO legal_acceptances(account_id, legal_name, version, accepted_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, legal_name) DO UPDATE SET version=excluded.version, accepted_at=excluded.accepted_at").run(accountId, legalName, version, nowMs(this.clock));
  }

  async startDeviceAuthorization(input: DeviceStartInput): Promise<DeviceStartResult> {
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((scope) => scope !== "character:list" && scope !== "play-ticket")) fail("ALPHA_DEVICE_SCOPE");
    const deviceCode = token();
    const userCode = humanCode();
    const now = nowMs(this.clock);
    const expiresAt = now + DEVICE_TTL_MS;
    const authorizationId = id("device");
    return this.transaction(() => {
      this.db.prepare("UPDATE device_authorizations SET status='expired' WHERE authorization_id IN (SELECT authorization_id FROM device_authorizations WHERE status IN ('pending','approved') AND expires_at <= ? LIMIT 1000)").run(now);
      const outstanding = Number((this.db.prepare("SELECT COUNT(*) AS count FROM device_authorizations WHERE status IN ('pending','approved') AND expires_at > ?").get(now) as { count: number }).count);
      if (outstanding >= this.maxOutstandingDeviceAuthorizations) fail("ALPHA_DEVICE_CAP");
      this.db.prepare("INSERT INTO device_authorizations(authorization_id, device_code_hash, user_code_hmac, client_id, release_id, scopes, status, created_at, expires_at, poll_interval_ms, poll_attempts) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, 5000, 0)").run(authorizationId, digest(deviceCode), hmac(this.claimSecret, userCode), input.clientId, input.releaseId, JSON.stringify(scopes), now, expiresAt);
      return { authorizationId, deviceCode, userCode, expiresAt, pollIntervalMs: 5000, scopes };
    });
  }
  async approveDevice(userCode: string, accountId: string): Promise<void> {
    const account = this.accountRow(accountId);
    if (account.status !== "active") fail("ALPHA_ACCOUNT_DELETED");
    this.transaction(() => {
      const row = this.db.prepare("SELECT authorization_id, status, expires_at FROM device_authorizations WHERE user_code_hmac=?").get(hmac(this.claimSecret, normalizeCode(userCode))) as { authorization_id: string; status: DeviceStatus; expires_at: number } | undefined;
      if (!row) fail("ALPHA_DEVICE_INVALID");
      if (nowMs(this.clock) >= row.expires_at) {
        this.db.prepare("UPDATE device_authorizations SET status='expired' WHERE authorization_id=? AND status='pending'").run(row.authorization_id);
        fail("ALPHA_DEVICE_STATE");
      }
      if (row.status !== "pending") fail("ALPHA_DEVICE_STATE");
      this.db.prepare("UPDATE device_authorizations SET status='approved', account_id=?, approved_at=? WHERE authorization_id=? AND status='pending'").run(accountId, nowMs(this.clock), row.authorization_id);
    });
  }
  async denyDevice(userCode: string): Promise<void> {
    const row = this.db.prepare("SELECT authorization_id, status FROM device_authorizations WHERE user_code_hmac=?").get(hmac(this.claimSecret, normalizeCode(userCode))) as { authorization_id: string; status: DeviceStatus } | undefined;
    if (!row) fail("ALPHA_DEVICE_INVALID");
    this.db.prepare("UPDATE device_authorizations SET status='denied' WHERE authorization_id=? AND status='pending'").run(row.authorization_id);
  }
  async pollDevice(deviceCode: string): Promise<DevicePollResult> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM device_authorizations WHERE device_code_hash=?").get(digest(deviceCode)) as { authorization_id: string; status: DeviceStatus; expires_at: number; last_poll_at?: number; poll_interval_ms: number; poll_attempts: number; account_id?: string; scopes: string } | undefined;
      if (!row) fail("ALPHA_DEVICE_INVALID");
      const now = nowMs(this.clock);
      if (now >= row.expires_at && !["exchanged", "revoked", "denied"].includes(row.status)) {
        this.db.prepare("UPDATE device_authorizations SET status='expired' WHERE authorization_id=?").run(row.authorization_id);
        return { status: "expired", expiresAt: row.expires_at };
      }
      if (row.status === "exchanged") fail("ALPHA_DEVICE_STATE");
      if (row.poll_attempts >= this.devicePollAttemptCap) {
        this.db.prepare("UPDATE device_authorizations SET status='expired' WHERE authorization_id=? AND status IN ('pending', 'approved')").run(row.authorization_id);
        return { status: "expired", expiresAt: row.expires_at };
      }
      if (row.last_poll_at !== undefined && now - row.last_poll_at < row.poll_interval_ms) {
        const nextInterval = Math.min(row.poll_interval_ms + 5000, 30_000);
        this.db.prepare("UPDATE device_authorizations SET last_poll_at=?, poll_attempts=poll_attempts+1, poll_interval_ms=? WHERE authorization_id=?").run(now, nextInterval, row.authorization_id);
        return { status: "slow_down", expiresAt: row.expires_at, retryAfterMs: nextInterval };
      }
      this.db.prepare("UPDATE device_authorizations SET last_poll_at=?, poll_attempts=poll_attempts+1 WHERE authorization_id=?").run(now, row.authorization_id);
      if (row.status === "approved") {
        const credential = token();
        const scopes = JSON.parse(row.scopes) as string[];
        const credentialId = id("cred");
        this.db.prepare("INSERT INTO device_credentials(credential_id, credential_hash, account_id, client_id, release_id, scopes, created_at, last_used_at, idle_expires_at, absolute_expires_at) SELECT ?, ?, account_id, client_id, release_id, scopes, ?, ?, ?, ? FROM device_authorizations WHERE authorization_id=? AND status='approved'").run(credentialId, digest(credential), now, now, now + DEVICE_CREDENTIAL_IDLE_MS, now + DEVICE_CREDENTIAL_ABSOLUTE_MS, row.authorization_id);
        this.db.prepare("UPDATE device_authorizations SET status='exchanged', exchanged_at=? WHERE authorization_id=? AND status='approved'").run(now, row.authorization_id);
        return { status: "exchanged", expiresAt: row.expires_at, credential, accountId: row.account_id, scopes };
      }
      return { status: row.status, expiresAt: row.expires_at, accountId: row.account_id, scopes: JSON.parse(row.scopes) as string[] };
    });
  }
  async revokeDeviceAuthorization(deviceCode: string): Promise<{ accountId?: string; launchIds: string[] }> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT authorization_id, account_id, status FROM device_authorizations WHERE device_code_hash=?").get(digest(deviceCode)) as { authorization_id: string; account_id?: string; status: DeviceStatus } | undefined;
      if (!row || !["pending", "approved"].includes(row.status)) fail("ALPHA_DEVICE_INVALID");
      const now = nowMs(this.clock);
      this.db.prepare("UPDATE device_authorizations SET status='revoked' WHERE authorization_id=? AND status IN ('pending','approved')").run(row.authorization_id);
      const launchIds = row.account_id ? this.revokeLaunchesByProvenance(row.account_id, "device_authorization", row.authorization_id, now) : [];
      return { accountId: row.account_id, launchIds };
    });
  }
  listDevices(accountId: string): Array<{ id: string; kind: "authorization" | "credential"; clientId: string; releaseId: string; status: string; expiresAt: number }> {
    this.accountRow(accountId);
    const rows = this.db.prepare("SELECT authorization_id AS id, 'authorization' AS kind, client_id, release_id, status, expires_at FROM device_authorizations WHERE account_id=? UNION ALL SELECT credential_id AS id, 'credential' AS kind, client_id, release_id, CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS status, absolute_expires_at AS expires_at FROM device_credentials WHERE account_id=? ORDER BY expires_at DESC").all(accountId, accountId) as Array<{ id: string; kind: "authorization" | "credential"; client_id: string; release_id: string; status: string; expires_at: number }>;
    return rows.map((row) => ({ id: row.id, kind: row.kind, clientId: row.client_id, releaseId: row.release_id, status: row.status, expiresAt: row.expires_at }));
  }
  async revokeDeviceForAccount(accountId: string, deviceId: string): Promise<{ launchIds: string[] }> {
    return this.transaction(() => {
      this.accountRow(accountId);
      const now = nowMs(this.clock);
      const authorization = this.db.prepare("UPDATE device_authorizations SET status='revoked' WHERE authorization_id=? AND account_id=? AND status IN ('pending','approved')").run(deviceId, accountId);
      if (Number(authorization.changes) === 1) return { launchIds: this.revokeLaunchesByProvenance(accountId, "device_authorization", deviceId, now) };
      const credential = this.db.prepare("UPDATE device_credentials SET revoked_at=? WHERE credential_id=? AND account_id=? AND revoked_at IS NULL").run(now, deviceId, accountId);
      if (Number(credential.changes) !== 1) fail("ALPHA_DEVICE_INVALID");
      return { launchIds: this.revokeLaunchesByProvenance(accountId, "device_credential", deviceId, now) };
    });
  }

  async revokeDeviceCredential(credential: string): Promise<{ accountId: string; launchIds: string[] }> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT credential_id, account_id FROM device_credentials WHERE credential_hash=? AND revoked_at IS NULL").get(digest(credential)) as { credential_id: string; account_id: string } | undefined;
      if (!row) fail("ALPHA_CREDENTIAL_INVALID");
      const now = nowMs(this.clock);
      const changed = this.db.prepare("UPDATE device_credentials SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL").run(now, row.credential_id);
      if (Number(changed.changes) !== 1) fail("ALPHA_CREDENTIAL_INVALID");
      return { accountId: row.account_id, launchIds: this.revokeLaunchesByProvenance(row.account_id, "device_credential", row.credential_id, now) };
    });
  }
  async inspectDeviceCredential(credential: string): Promise<{ credentialId: string; accountId: string; clientId: string; releaseId: string; scopes: readonly string[] }> {
    const row = this.db.prepare("SELECT * FROM device_credentials WHERE credential_hash=?").get(digest(credential)) as { credential_id: string; account_id: string; client_id: string; release_id: string; scopes: string; last_used_at: number; idle_expires_at: number; absolute_expires_at: number; revoked_at?: number } | undefined;
    if (!row || row.revoked_at) fail("ALPHA_CREDENTIAL_INVALID");
    const now = nowMs(this.clock);
    if (now >= row.idle_expires_at || now >= row.absolute_expires_at) fail("ALPHA_CREDENTIAL_INVALID");
    const account = this.accountRow(row.account_id);
    if (account.status !== "active") fail("ALPHA_ACCOUNT_PENDING_DELETION");
    const idle = Math.min(now + DEVICE_CREDENTIAL_IDLE_MS, row.absolute_expires_at);
    this.db.prepare("UPDATE device_credentials SET last_used_at=?, idle_expires_at=? WHERE credential_id=?").run(now, idle, row.credential_id);
    return { credentialId: row.credential_id, accountId: row.account_id, clientId: row.client_id, releaseId: row.release_id, scopes: JSON.parse(row.scopes) as string[] };
  }

  async cleanupExpired(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail("ALPHA_MIGRATION_INVALID", "cleanup limit out of bounds");
    return this.transaction(() => {
      const now = nowMs(this.clock);
      let cleaned = 0;
      cleaned += Number(this.db.prepare("DELETE FROM sessions WHERE session_id IN (SELECT session_id FROM sessions WHERE revoked_at IS NOT NULL OR idle_expires_at <= ? OR absolute_expires_at <= ? LIMIT ?)").run(now, now, limit).changes);
      cleaned += Number(this.db.prepare("DELETE FROM device_authorizations WHERE authorization_id IN (SELECT authorization_id FROM device_authorizations WHERE status IN ('denied','revoked','expired','exchanged') OR expires_at <= ? LIMIT ?)").run(now, limit).changes);
      cleaned += Number(this.db.prepare("DELETE FROM device_credentials WHERE credential_id IN (SELECT credential_id FROM device_credentials WHERE revoked_at IS NOT NULL OR idle_expires_at <= ? OR absolute_expires_at <= ? LIMIT ?)").run(now, now, limit).changes);
      cleaned += Number(this.db.prepare("DELETE FROM launches WHERE launch_id IN (SELECT launch_id FROM launches WHERE revoked_at IS NOT NULL OR expires_at <= ? LIMIT ?)").run(now, limit).changes);
      return cleaned;
    });
  }

  private assertLegal(accountId: string): void {
    for (const [name, version] of Object.entries(this.requiredLegalVersions)) {
      const row = this.db.prepare("SELECT 1 AS accepted FROM legal_acceptances WHERE account_id=? AND legal_name=? AND version=?").get(accountId, name, version);
      if (!row) fail("ALPHA_LEGAL_REQUIRED");
    }
  }
  async createLaunch(input: LaunchInput): Promise<LaunchEnvelope> {
    const account = this.accountRow(input.accountId);
    if (account.status !== "active") fail("ALPHA_ACCOUNT_PENDING_DELETION");
    if (account.ownerRef !== input.ownerRef) fail("ALPHA_LAUNCH_INVALID");
    this.assertLegal(input.accountId);
    const provenanceKind = input.provenance.kind;
    const provenanceId = input.provenance.id;
    if (!provenanceId) fail("ALPHA_LAUNCH_INVALID");
    const gameTicket = token();
    const chatTicket = token();
    const now = nowMs(this.clock);
    const expiresAt = now + LAUNCH_TTL_MS;
    const launchId = id("launch");
    this.transaction(() => {
      const outstanding = Number((this.db.prepare("SELECT COUNT(*) AS count FROM launches WHERE account_id=? AND revoked_at IS NULL AND expires_at > ?").get(input.accountId, now) as { count: number }).count);
      if (outstanding >= this.maxOutstandingLaunchesPerAccount) fail("ALPHA_LAUNCH_CAP");
      const issuerOutstanding = Number((this.db.prepare("SELECT COUNT(*) AS count FROM launches WHERE account_id=? AND issuer=? AND revoked_at IS NULL AND expires_at > ?").get(input.accountId, input.issuer, now) as { count: number }).count);
      if (issuerOutstanding >= this.maxOutstandingLaunchesPerIssuer) fail("ALPHA_LAUNCH_CAP");
      if (provenanceKind === "device_credential" || provenanceKind === "device_authorization") {
        const deviceOutstanding = Number((this.db.prepare("SELECT COUNT(*) AS count FROM launches WHERE account_id=? AND provenance_kind=? AND provenance_id=? AND revoked_at IS NULL AND expires_at > ?").get(input.accountId, provenanceKind, provenanceId, now) as { count: number }).count);
        if (deviceOutstanding >= this.maxOutstandingLaunchesPerDevice) fail("ALPHA_LAUNCH_CAP");
      }
      const minted = Number((this.db.prepare("SELECT COUNT(*) AS count FROM launches WHERE account_id=? AND created_at > ?").get(input.accountId, now - PLAY_TICKET_WINDOW_MS) as { count: number }).count);
      if (minted >= this.playTicketMintLimitPerAccount) fail("ALPHA_PLAY_TICKET_RATE");
      this.db.prepare("INSERT INTO launches(launch_id, account_id, owner_ref, character_id, shard_id, client_release_id, server_release_id, issuer, created_at, expires_at, provenance_kind, provenance_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(launchId, input.accountId, input.ownerRef, input.characterId, input.shardId, input.clientReleaseId, input.serverReleaseId, input.issuer, now, expiresAt, provenanceKind, provenanceId);
      this.db.prepare("INSERT INTO launch_capabilities(capability_id, launch_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, 'game', ?, ?, ?), (?, ?, 'chat', ?, ?, ?)").run(id("cap"), launchId, digest(gameTicket), now, expiresAt, id("cap"), launchId, digest(chatTicket), now, expiresAt);
    });
    return { launchId, gameTicket, chatTicket, accountId: input.accountId, ownerRef: input.ownerRef, characterId: input.characterId, shardId: input.shardId, clientReleaseId: input.clientReleaseId, serverReleaseId: input.serverReleaseId, issuer: input.issuer, expiresAt };
  }
  async redeemLaunch(input: RedeemLaunchInput): Promise<RedeemedLaunch> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT c.capability_id, c.launch_id, c.purpose, c.expires_at, c.consumed_at, c.revoked_at, l.account_id, l.owner_ref, l.character_id, l.shard_id, l.client_release_id, l.server_release_id, l.issuer, l.revoked_at AS launch_revoked_at, a.status AS account_status FROM launch_capabilities c JOIN launches l ON l.launch_id=c.launch_id JOIN accounts a ON a.account_id=l.account_id WHERE c.token_hash=? AND c.purpose=?").get(digest(input.token), input.purpose) as { capability_id: string; launch_id: string; purpose: LaunchPurpose; expires_at: number; consumed_at?: number; revoked_at?: number; launch_revoked_at?: number; account_id: string; owner_ref: string; character_id: string; shard_id: string; client_release_id: string; server_release_id: string; issuer: string; account_status: AccountStatus } | undefined;
      if (!row || row.consumed_at || row.revoked_at || row.launch_revoked_at || row.account_status !== "active" || nowMs(this.clock) >= row.expires_at) fail(row?.consumed_at ? "ALPHA_LAUNCH_REPLAY" : "ALPHA_LAUNCH_INVALID");
      if (row.account_id !== input.accountId || row.owner_ref !== input.ownerRef || row.character_id !== input.characterId || row.shard_id !== input.shardId || row.client_release_id !== input.clientReleaseId || row.server_release_id !== input.serverReleaseId || row.issuer !== input.issuer) fail("ALPHA_LAUNCH_INVALID");
      const updated = this.db.prepare("UPDATE launch_capabilities SET consumed_at=? WHERE capability_id=? AND consumed_at IS NULL AND revoked_at IS NULL").run(nowMs(this.clock), row.capability_id);
      if (Number(updated.changes) !== 1) fail("ALPHA_LAUNCH_REPLAY");
      return { launchId: row.launch_id, accountId: row.account_id, ownerRef: row.owner_ref, characterId: row.character_id, shardId: row.shard_id, clientReleaseId: row.client_release_id, serverReleaseId: row.server_release_id, issuer: row.issuer, purpose: row.purpose };
    });
  }
  async redeemCapability(input: RedeemCapabilityInput): Promise<RedeemedLaunch> {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT c.capability_id, c.launch_id, c.purpose, c.expires_at, c.consumed_at, c.revoked_at, l.account_id, l.owner_ref, l.character_id, l.shard_id, l.client_release_id, l.server_release_id, l.issuer, l.revoked_at AS launch_revoked_at, a.status AS account_status FROM launch_capabilities c JOIN launches l ON l.launch_id=c.launch_id JOIN accounts a ON a.account_id=l.account_id WHERE c.token_hash=? AND c.purpose=?").get(digest(input.token), input.purpose) as { capability_id: string; launch_id: string; purpose: LaunchPurpose; expires_at: number; consumed_at?: number; revoked_at?: number; launch_revoked_at?: number; account_id: string; owner_ref: string; character_id: string; shard_id: string; client_release_id: string; server_release_id: string; issuer: string; account_status: AccountStatus } | undefined;
      if (!row || row.account_status !== "active" || row.consumed_at || row.revoked_at || row.launch_revoked_at || nowMs(this.clock) >= row.expires_at) fail(row?.consumed_at ? "ALPHA_LAUNCH_REPLAY" : "ALPHA_LAUNCH_INVALID");
      if (row.shard_id !== input.shardId || row.client_release_id !== input.clientReleaseId || row.server_release_id !== input.serverReleaseId || row.issuer !== input.issuer) fail("ALPHA_LAUNCH_INVALID");
      const updated = this.db.prepare("UPDATE launch_capabilities SET consumed_at=? WHERE capability_id=? AND consumed_at IS NULL AND revoked_at IS NULL").run(nowMs(this.clock), row.capability_id);
      if (Number(updated.changes) !== 1) fail("ALPHA_LAUNCH_REPLAY");
      return { launchId: row.launch_id, accountId: row.account_id, ownerRef: row.owner_ref, characterId: row.character_id, shardId: row.shard_id, clientReleaseId: row.client_release_id, serverReleaseId: row.server_release_id, issuer: row.issuer, purpose: row.purpose };
    });
  }
  private revokeLaunchesByProvenance(accountId: string, provenanceKind: LaunchProvenanceKind, provenanceId: string, now: number): string[] {
    const rows = this.db.prepare("SELECT launch_id FROM launches WHERE account_id=? AND provenance_kind=? AND provenance_id=? AND revoked_at IS NULL").all(accountId, provenanceKind, provenanceId) as Array<{ launch_id: string }>;
    this.db.prepare("UPDATE launches SET revoked_at=? WHERE account_id=? AND provenance_kind=? AND provenance_id=? AND revoked_at IS NULL").run(now, accountId, provenanceKind, provenanceId);
    this.db.prepare("UPDATE launch_capabilities SET revoked_at=? WHERE launch_id IN (SELECT launch_id FROM launches WHERE account_id=? AND provenance_kind=? AND provenance_id=?) AND revoked_at IS NULL").run(now, accountId, provenanceKind, provenanceId);
    return rows.map((row) => row.launch_id);
  }

  async revokeLaunch(launchId: string, accountId?: string): Promise<void> {
    const now = nowMs(this.clock);
    this.transaction(() => {
      const result = accountId
        ? this.db.prepare("UPDATE launches SET revoked_at=? WHERE launch_id=? AND account_id=? AND revoked_at IS NULL").run(now, launchId, accountId)
        : this.db.prepare("UPDATE launches SET revoked_at=? WHERE launch_id=? AND revoked_at IS NULL").run(now, launchId);
      if (Number(result.changes) !== 1) fail("ALPHA_LAUNCH_INVALID");
      this.db.prepare("UPDATE launch_capabilities SET revoked_at=? WHERE launch_id=? AND revoked_at IS NULL").run(now, launchId);
    });
  }
  async revokeAccount(accountId: string): Promise<{ launchIds: string[] }> {
    return this.transaction(() => {
      const account = this.accountRow(accountId);
      if (account.status === "pending_deletion") return { launchIds: [] };
      const now = nowMs(this.clock);
      const launches = this.db.prepare("SELECT launch_id FROM launches WHERE account_id=? AND revoked_at IS NULL").all(accountId) as Array<{ launch_id: string }>;
      this.db.prepare("UPDATE accounts SET status='pending_deletion', deleted_at=? WHERE account_id=? AND status='active'").run(now, accountId);
      this.db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(now, accountId);
      this.db.prepare("UPDATE device_authorizations SET status='revoked' WHERE account_id=? AND status IN ('pending','approved')").run(accountId);
      this.db.prepare("UPDATE device_credentials SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(now, accountId);
      this.db.prepare("UPDATE launches SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(now, accountId);
      this.db.prepare("UPDATE launch_capabilities SET revoked_at=? WHERE launch_id IN (SELECT launch_id FROM launches WHERE account_id=?) AND revoked_at IS NULL").run(now, accountId);
      return { launchIds: launches.map((row) => row.launch_id) };
    });
  }

  auditOwnerRefs(ownerRefs: readonly string[]): void {
    for (const ownerRef of ownerRefs) {
      const row = this.db.prepare("SELECT 1 AS present FROM accounts WHERE owner_ref=? AND status IN ('active', 'pending_deletion')").get(ownerRef);
      if (!row) fail("ALPHA_MIGRATION_CORRUPT", "durable owner has no account tombstone");
    }
  }

  auditPragmas(): { journalMode: string; synchronous: number; foreignKeys: number; trustedSchema: number; busyTimeoutMs: number } {
    return {
      journalMode: String(this.db.prepare("PRAGMA journal_mode").get()?.journal_mode ?? ""),
      synchronous: Number(this.db.prepare("PRAGMA synchronous").get()?.synchronous),
      foreignKeys: Number(this.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
      trustedSchema: Number(this.db.prepare("PRAGMA trusted_schema").get()?.trusted_schema),
      busyTimeoutMs: Number(this.db.prepare("PRAGMA busy_timeout").get()?.timeout),
    };
  }
  schemaHead(): { version: number; checksum: string } {
    const row = this.db.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1").get() as { version: number; checksum: string } | undefined;
    if (!row) fail("ALPHA_MIGRATION_CORRUPT");
    return row;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

export async function verifyPasswordForTests(password: string, encoded: string): Promise<{ ok: boolean; rehash: boolean }> {
  return kdfSemaphore.run(() => verifyPasswordEncoded(password, encoded));
}
export const ALPHA_KDF = Object.freeze({ version: 1, N: KDF_N, r: KDF_R, p: KDF_P, maxmem: KDF_MAXMEM, semaphoreLimit: 4 });
export const ALPHA_TTLS = Object.freeze({ sessionIdleMs: SESSION_IDLE_MS, sessionAbsoluteMs: SESSION_ABSOLUTE_MS, deviceMs: DEVICE_TTL_MS, deviceCredentialIdleMs: DEVICE_CREDENTIAL_IDLE_MS, deviceCredentialAbsoluteMs: DEVICE_CREDENTIAL_ABSOLUTE_MS, launchMs: LAUNCH_TTL_MS });
export const ALPHA_LIMITS = Object.freeze({ maxPasswordBytes: MAX_PASSWORD_BYTES, maxBodyBytes: MAX_BODY_BYTES, maxOutstandingLaunchesPerAccount: DEFAULT_MAX_OUTSTANDING_LAUNCHES_ACCOUNT, maxOutstandingLaunchesPerIssuer: DEFAULT_MAX_OUTSTANDING_LAUNCHES_ISSUER, maxOutstandingLaunchesPerDevice: DEFAULT_MAX_OUTSTANDING_LAUNCHES_DEVICE, playTicketMintLimitPerAccount: DEFAULT_PLAY_TICKET_MINTS_PER_ACCOUNT, devicePollAttemptCap: DEFAULT_DEVICE_POLL_ATTEMPT_CAP, maxOutstandingDeviceAuthorizations: DEFAULT_MAX_OUTSTANDING_DEVICE_AUTHORIZATIONS });
export function migrationChecksumForTests(migration: MigrationDefinition): string {
  return migrationChecksum(migration);
}
