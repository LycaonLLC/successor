import type { GameActorSnapshot } from "./protocol.js";
import type { CharacterRecord } from "./characterStore.js";

export interface CharacterAuthoritySeed {
  professionIds?: string[];
  skillBoxIds: string[];
  professions?: GameActorSnapshot["professions"];
  skillPointsCap?: number;
  credits?: number;
}

/**
 * Convert both historical CharacterStore progression shapes into one exact
 * actor-rebuild seed. The store is only consulted after Rust has retired an
 * offline actor; a still-checkpointed actor remains authoritative.
 */
export function characterAuthoritySeed(character: CharacterRecord): CharacterAuthoritySeed {
  const professions = character.professions;
  if (professions === null) return { skillBoxIds: [] };
  const rows = Array.isArray(professions) ? professions : [];
  const state = isRecord(professions) && !Array.isArray(professions) ? professions : null;
  const normalizedProfessions = rows.length > 0
    ? normalizedProfessionSnapshots(rows)
    : normalizedProfessionStateSnapshots(state);
  const skillBoxIds = normalizedStringIds(rows.flatMap((row) => (
    isRecord(row) && Array.isArray(row.skillBoxes) ? row.skillBoxes : []
  )).concat(state && Array.isArray(state.skillBoxes) ? state.skillBoxes : []));
  const professionIds = normalizedStringIds([
    ...(state && Array.isArray(state.learned) ? state.learned : []),
    ...skillBoxIds.map(professionIdForSkillBox),
  ]);
  const credits = [
    normalizedCharacterCredits(character.credits),
    normalizedCharacterCredits(state?.credits),
    ...rows.map((row) => isRecord(row) ? normalizedCharacterCredits(row.credits) : undefined),
  ].find((value): value is number => value !== undefined);
  const skillPointsCap = [
    normalizedSkillPointCap(character.skillPointCap),
    normalizedSkillPointCap(state?.skillPointCap),
    ...rows.map((row) => isRecord(row) ? normalizedSkillPointCap(row.skillPointCap) : undefined),
  ].find((value): value is number => value !== undefined);
  return {
    professionIds,
    skillBoxIds,
    ...(normalizedProfessions.length === 0 ? {} : { professions: normalizedProfessions }),
    ...(skillPointsCap === undefined ? {} : { skillPointsCap }),
    ...(credits === undefined ? {} : { credits }),
  };
}

function normalizedProfessionSnapshots(rows: unknown[]): NonNullable<GameActorSnapshot["professions"]> {
  return rows.flatMap((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || row.id.trim().length === 0) return [];
    const id = row.id.trim();
    const label = typeof row.label === "string" && row.label.trim()
      ? row.label.trim()
      : professionLabel(id);
    const xp = normalizedCharacterCredits(row.xp) ?? 0;
    const trackXp = normalizedNumberRecord(row.trackXp);
    const skillPoints = normalizedSkillPointCap(row.skillPoints) ?? 0;
    const skillBoxes = normalizedStringIds(Array.isArray(row.skillBoxes) ? row.skillBoxes : []);
    return [{
      id,
      label,
      xp,
      ...(Object.keys(trackXp).length === 0 ? {} : { trackXp }),
      skillPoints,
      skillBoxes,
    }];
  });
}

function normalizedProfessionStateSnapshots(
  state: Record<string, unknown> | null,
): NonNullable<GameActorSnapshot["professions"]> {
  if (!state) return [];
  const xp = normalizedNumberRecord(state.xp);
  const flatTrackXp = normalizedNumberRecord(state.trackXp);
  const ids = normalizedStringIds([
    ...Object.keys(xp),
    ...Object.keys(flatTrackXp).map((key) => key.split(":", 1)[0]),
  ]);
  const skillBoxes = normalizedStringIds(Array.isArray(state.skillBoxes) ? state.skillBoxes : []);
  return ids.map((id) => {
    const prefix = `${id}:`;
    const trackXp = Object.fromEntries(Object.entries(flatTrackXp)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]));
    return {
      id,
      label: professionLabel(id),
      xp: xp[id] ?? 0,
      ...(Object.keys(trackXp).length === 0 ? {} : { trackXp }),
      skillPoints: 0,
      skillBoxes: skillBoxes.filter((skillBoxId) => skillBoxId.startsWith(`${id}-`)),
    };
  });
}

function normalizedNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, amount]) => {
    const normalizedKey = key.trim();
    const normalizedAmount = normalizedCharacterCredits(amount);
    return normalizedKey && normalizedAmount !== undefined ? [[normalizedKey, normalizedAmount]] : [];
  }));
}

function professionLabel(id: string): string {
  if (id === "bioengineer") return "Bio-Engineer";
  return id.length === 0 ? id : `${id[0]!.toUpperCase()}${id.slice(1)}`;
}

function professionIdForSkillBox(skillBoxId: string): string {
  return [
    "bioengineer",
    "craftsman",
    "marksman",
    "brawler",
    "commando",
    "medic",
    "scout",
  ].find((professionId) => skillBoxId.startsWith(`${professionId}-`)) ?? "";
}

function normalizedStringIds(values: unknown[]): string[] {
  return [...new Set(values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0))];
}

function normalizedCharacterCredits(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

function normalizedSkillPointCap(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(65_535, Math.max(0, Math.trunc(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
