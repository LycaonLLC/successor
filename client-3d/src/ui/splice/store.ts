import type {
  PlayState,
  ServerAuthorityGenomeScanState,
  ServerAuthoritySpliceSessionState,
} from "@successor/client/src/slice-core/gameState";

/**
 * SPLICE store — module-level accumulation of the gene-bench channel
 * (craft-store pattern: one PlayState per page, reset with the page).
 *
 * Two live surfaces feed it, both server-authoritative (the window never
 * moves the VM optimistically):
 *  - the streamed `spliceSession` VM (the bench readout — DEF-6);
 *  - the streamed `genomeScan` VM (the latest reveal — DEF-6).
 *
 * The store additionally keeps a SCAN CACHE keyed by (itemId, variantId).
 * `genomeScan` is a single "latest reveal", but the allele picker needs BOTH
 * seated parents' allele pairs at once — and a genome is immutable + reveal is
 * permanent (design §3.3), so caching every scan by its exact seed identity is
 * always sound and never stale. Seated parents look their alleles up here;
 * a miss (or a pre-allele tier) renders the locus honestly UNKNOWN.
 */

export type SpliceSessionVM = ServerAuthoritySpliceSessionState;
export type GenomeScanVM = ServerAuthorityGenomeScanState;

interface SpliceStoreState {
  session: SpliceSessionVM | null;
  latestScan: GenomeScanVM | null;
  scansByStack: Map<string, GenomeScanVM>;
}

const store: SpliceStoreState = {
  session: null,
  latestScan: null,
  scansByStack: new Map<string, GenomeScanVM>(),
};

let storeVersion = 0;

const scanKey = (itemId: number, variantId: number): string => `${itemId}:${variantId}`;

/** Monotonic counter bumped on every ingest — cheap re-render detection. */
export function spliceStoreVersion(): number {
  return storeVersion;
}

export function spliceSession(): SpliceSessionVM | null {
  return store.session;
}

export function latestGenomeScan(): GenomeScanVM | null {
  return store.latestScan;
}

/** The cached reveal for a specific seed stack, or null (never scanned). */
export function scanForStack(itemId: number, variantId: number): GenomeScanVM | null {
  return store.scansByStack.get(scanKey(itemId, variantId)) ?? null;
}

// ── Ingest (authority receive path + dev seam) ─────────────────────────────

export function ingestSpliceSession(session: SpliceSessionVM | null): void {
  store.session = session;
  storeVersion += 1;
}

export function ingestGenomeScan(scan: GenomeScanVM | null): void {
  store.latestScan = scan;
  if (scan) store.scansByStack.set(scanKey(scan.itemId, scan.variantId), scan);
  storeVersion += 1;
}

// ── Authority sync (live bind) ─────────────────────────────────────────────
// Normalizes the streamed spliceSession / genomeScan channels into the store.
// Identity-gated so identical wire objects cost nothing per frame. The
// composition root opts in (`enableSpliceAuthoritySync`); fixture harnesses
// that drive the store directly never enable it, so the feeds can't fight.

let authoritySyncEnabled = false;
let syncedSession: unknown = Symbol("never");
let syncedScan: unknown = Symbol("never");

export function enableSpliceAuthoritySync(): void {
  authoritySyncEnabled = true;
}

export function syncSpliceChannelFromAuthority(state: PlayState): void {
  if (!authoritySyncEnabled) return;
  const wireSession = state.serverAuthority.spliceSession;
  if (wireSession !== syncedSession) {
    syncedSession = wireSession;
    ingestSpliceSession((wireSession ?? null) as SpliceSessionVM | null);
  }
  const wireScan = state.serverAuthority.genomeScan;
  if (wireScan !== syncedScan) {
    syncedScan = wireScan;
    ingestGenomeScan((wireScan ?? null) as GenomeScanVM | null);
  }
}

// ── Dev fixture seam ───────────────────────────────────────────────────────
// Matches __successorCraftIngest: drives the window through every phase without
// a live sim (screenshots / unit-style DOM harness). DEV builds only.

export interface SpliceIngestPayload {
  session?: SpliceSessionVM | null;
  scan?: GenomeScanVM | null;
  scans?: readonly GenomeScanVM[];
}

declare global {
  interface Window {
    __successorSpliceIngest?: (payload: SpliceIngestPayload) => number;
  }
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  window.__successorSpliceIngest = (payload: SpliceIngestPayload): number => {
    if (payload.scans) {
      for (const scan of payload.scans) ingestGenomeScan(scan);
    }
    if (payload.scan !== undefined) ingestGenomeScan(payload.scan);
    if (payload.session !== undefined) ingestSpliceSession(payload.session);
    return storeVersion;
  };
}
