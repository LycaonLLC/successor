import type {
  InventoryRow,
  ServerAuthorityResourceSpawnState,
  ServerAuthorityResourceStatsState,
} from "@successor/client/src/slice-core/gameState";
import { STAT_ORDER, statLabel } from "../crafting/composers";

export interface ResourceTaxonomyEntry {
  itemId: number;
  displayName: string;
  taxonomyPath: readonly string[];
}

/** One authoritative stat channel (the Rust 12-stat block, snake_case). */
export type ResourceStatKey = keyof ServerAuthorityResourceStatsState;

export interface ResourceStatRow {
  key: ResourceStatKey;
  label: string;
  value: number;
}

export interface ResourceDisplayInfo {
  displayName: string;
  taxonomyPath: readonly string[];
  taxonomySubtitle: string;
  variantLabel: string;
  variantCode: string | null;
  stats: readonly ResourceStatRow[];
  tooltip: string;
}

interface ResourceInfoOptions {
  category?: string | null | undefined;
  fallbackName?: string | null | undefined;
  spawn?: ServerAuthorityResourceSpawnState | null | undefined;
}

type ResourceContractRow = InventoryRow & {
  variantId?: unknown;
  variantLabel?: unknown;
  variantCode?: unknown;
  taxonomy?: { path?: unknown } | null;
  taxonomyPath?: unknown;
  stats?: unknown;
  statBlock?: unknown;
  resourceStats?: unknown;
  potency?: unknown;
  purity?: unknown;
};

const UNKNOWN_RESOURCE_TAXONOMY = ["Organic", "Unclassified"] as const;

const RESOURCE_TAXONOMY_BY_ITEM_ID: Readonly<Record<number, ResourceTaxonomyEntry>> = {
  2001: { itemId: 2001, displayName: "Iron", taxonomyPath: ["Inorganic", "Mineral", "Metal", "Iron"] },
  2007: { itemId: 2007, displayName: "Copper", taxonomyPath: ["Inorganic", "Mineral", "Metal", "Copper"] },
  2002: { itemId: 2002, displayName: "Petrochemical", taxonomyPath: ["Inorganic", "Chemical", "Petrochemical"] },
  2003: { itemId: 2003, displayName: "Flora", taxonomyPath: ["Organic", "Flora"] },
  2004: { itemId: 2004, displayName: "Gas", taxonomyPath: ["Inorganic", "Gas"] },
  2005: { itemId: 2005, displayName: "Liquid", taxonomyPath: ["Inorganic", "Liquid"] },
  2006: { itemId: 2006, displayName: "Clodpowder", taxonomyPath: ["Organic", "Creature Structural", "Clodpowder"] },
  2008: { itemId: 2008, displayName: "Carbon", taxonomyPath: ["Inorganic", "Mineral", "Carbon"] },
  2009: { itemId: 2009, displayName: "Fuel", taxonomyPath: ["Inorganic", "Chemical", "Fuel"] },
  2010: { itemId: 2010, displayName: "Polymer", taxonomyPath: ["Inorganic", "Chemical", "Polymer"] },
  2101: { itemId: 2101, displayName: "Creature Hide", taxonomyPath: ["Organic", "Creature Structural", "Hide"] },
  2102: { itemId: 2102, displayName: "Clodmeat", taxonomyPath: ["Organic", "Creature Food", "Clodmeat"] },
  2103: { itemId: 2103, displayName: "Clodbone", taxonomyPath: ["Organic", "Creature Structural", "Bone"] },
  2104: { itemId: 2104, displayName: "Creature Tissue", taxonomyPath: ["Organic", "Creature Structural", "Tissue"] },
};

export const resourceTaxonomyEntries: readonly ResourceTaxonomyEntry[] = Object.values(RESOURCE_TAXONOMY_BY_ITEM_ID);

export function resourceTaxonomyForItemId(itemId: number): ResourceTaxonomyEntry | null {
  return RESOURCE_TAXONOMY_BY_ITEM_ID[itemId] ?? null;
}

export function isResourceRow(row: InventoryRow, category?: string | null): boolean {
  if (category === "resource") return true;
  if (resourceTaxonomyForItemId(row.itemId)) return true;
  const contract = row as ResourceContractRow;
  if (readString(contract.variantLabel) || readString(contract.variantCode)) return true;
  if (readStatBlock(contract.stats) || readStatBlock(contract.statBlock) || readStatBlock(contract.resourceStats)) return true;
  return row.itemId >= 2001 && row.itemId < 3000;
}

export function resourceInfoForRow(row: InventoryRow, options: ResourceInfoOptions = {}): ResourceDisplayInfo | null {
  if (!isResourceRow(row, options.category)) return null;
  const contract = row as ResourceContractRow;
  const taxonomy = taxonomyPathForRow(contract);
  const taxonomySubtitle = formatTaxonomyPath(taxonomy);
  const variantCode = readString(contract.variantCode) ?? formatVariantCode(contract.variantId ?? row.variantId);
  const taxonomyName = resourceTaxonomyForItemId(row.itemId)?.displayName ?? null;
  const fallbackName = readString(options.fallbackName);
  const cleanedItemName = cleanedResourceItemName(row.item);
  const specificItemName = cleanedItemName && cleanedItemName !== taxonomyName && cleanedItemName !== fallbackName
    ? cleanedItemName
    : null;
  const variantLabel = readString(contract.variantLabel)
    ?? spawnLabel(options.spawn)
    ?? specificItemName
    ?? taxonomyName
    ?? fallbackName
    ?? cleanedItemName
    ?? "Resource";
  const stats = resourceStatsForRow(contract, options.spawn);
  const tooltip = buildResourceTooltip(variantLabel, taxonomySubtitle, variantCode, stats);
  return {
    displayName: variantLabel,
    taxonomyPath: taxonomy,
    taxonomySubtitle,
    variantLabel,
    variantCode,
    stats,
    tooltip,
  };
}

export function formatTaxonomyPath(path: readonly string[] | null | undefined): string {
  const normalized = normalizeTaxonomyPath(path);
  return normalized.map((part) => part.toUpperCase()).join(" · ");
}

export function formatVariantCode(variantId: unknown): string | null {
  if (variantId === null || variantId === undefined) return null;
  const raw = String(variantId).trim();
  if (!raw || raw === "0") return null;
  const compact = raw.replace(/[^a-z0-9]/giu, "").toUpperCase();
  if (!compact || compact === "0") return null;
  return compact.length >= 4 ? compact.slice(-4) : compact.padStart(4, "0");
}

export function renderResourceStatRows(host: HTMLElement, stats: readonly ResourceStatRow[] | null | undefined): void {
  host.textContent = "";
  if (!stats || stats.length === 0) {
    host.hidden = true;
    return;
  }
  for (const stat of stats) {
    const row = document.createElement("div");
    row.className = "inv-stat-row";
    const meterWidth = Math.max(1, Math.min(100, Math.round(stat.value / 10)));
    row.innerHTML = `
      <span class="inv-stat-label">${stat.label}</span>
      <span class="inv-stat-meter" aria-hidden="true"><span class="inv-stat-fill" style="width:${meterWidth}%"></span></span>
      <span class="inv-stat-value">${stat.value}</span>
    `;
    host.appendChild(row);
  }
  host.hidden = false;
}

function taxonomyPathForRow(row: ResourceContractRow): readonly string[] {
  const authored = readTaxonomyPath(row.taxonomyPath) ?? readTaxonomyPath(row.taxonomy?.path);
  if (authored) return authored;
  return resourceTaxonomyForItemId(row.itemId)?.taxonomyPath ?? UNKNOWN_RESOURCE_TAXONOMY;
}

function normalizeTaxonomyPath(path: readonly string[] | null | undefined): readonly string[] {
  const normalized = path
    ?.map((part) => part.trim())
    .filter((part) => part.length > 0) ?? [];
  return normalized.length > 0 ? normalized : UNKNOWN_RESOURCE_TAXONOMY;
}

function readTaxonomyPath(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const parts = value
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts : null;
}

function resourceStatsForRow(
  row: ResourceContractRow,
  spawn: ServerAuthorityResourceSpawnState | null | undefined,
): readonly ResourceStatRow[] {
  // The authoritative full block wins; older contract spellings, the legacy
  // top-level potency/purity pair, and finally the live spawn stats fall in
  // behind it — same fallback ladder the pre-resourceStats rows relied on.
  const source = readStatBlock(row.resourceStats)
    ?? readStatBlock(row.stats)
    ?? readStatBlock(row.statBlock)
    ?? (row.potency !== undefined || row.purity !== undefined ? readStatBlock(row) : null)
    ?? readStatBlock(spawn?.stats ?? null);
  if (!source) return [];
  const rows: ResourceStatRow[] = [];
  for (const key of STAT_ORDER) {
    // Legacy blocks spell chemical_purity as bare "purity" — same channel.
    const value = key === "chemical_purity"
      ? readStatValue(source, key) ?? readStatValue(source, "purity")
      : readStatValue(source, key);
    if (value !== null) rows.push({ key, label: statLabel(key), value });
  }
  return rows;
}

function readStatBlock(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readStatValue(source: Record<string, unknown>, key: string): number | null {
  const raw = source[key];
  const numeric = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(1000, Math.round(numeric));
}

function spawnLabel(spawn: ServerAuthorityResourceSpawnState | null | undefined): string | null {
  const name = readString(spawn?.name);
  const classLabel = readString(spawn?.classLabel);
  if (name && classLabel) return `${name} - ${classLabel}`;
  return name || classLabel ? name ?? classLabel ?? "" : null;
}

function cleanedResourceItemName(item: string): string | null {
  const cleaned = item
    .replace(/\s+[CMPSTYFN]\d{2,4}\b/gu, "")
    .replace(/\s+P\d+\/Q\d+\b/gu, "")
    .trim();
  if (!cleaned || cleaned === String(Number(cleaned))) return null;
  return cleaned;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildResourceTooltip(
  variantLabel: string,
  taxonomySubtitle: string,
  variantCode: string | null,
  stats: readonly ResourceStatRow[],
): string {
  const lines = [variantLabel];
  if (variantCode) lines.push(`Variant ${variantCode}`);
  lines.push(taxonomySubtitle);
  for (const stat of stats) lines.push(`${stat.label} ${stat.value}`);
  return lines.join("\n");
}
