export interface AuthorityActorProbeValue {
  linkDead?: boolean;
  professions?: readonly { id: string; xp: number; trackXp?: Readonly<Record<string, number>>; skillBoxes?: readonly string[] }[];
}

/** Reuse caller storage; actor identity is read-only authority evidence. */
export function syncAuthorityActorKeys(
  target: string[],
  actors: Readonly<Record<string, AuthorityActorProbeValue | undefined>>,
): void {
  let count = 0;
  for (const actorKey in actors) {
    if (actors[actorKey] === undefined) continue;
    target[count] = actorKey;
    count += 1;
  }
  target.length = count;
  target.sort();
}

export function authorityActorLinkDead(
  actors: Readonly<Record<string, AuthorityActorProbeValue | undefined>>,
  actorKey: string,
): boolean | null {
  const actor = actors[actorKey];
  return actor === undefined ? null : actor.linkDead === true;
}

export function authorityProfessionXp(
  actors: Readonly<Record<string, AuthorityActorProbeValue | undefined>>,
  actorKey: string,
  professionId: string,
): number | null {
  const actor = actors[actorKey];
  if (!actor) return null;
  const profession = actor.professions?.find((candidate) => candidate.id === professionId);
  return profession && Number.isFinite(profession.xp) ? profession.xp : null;
}

export function authorityProfessionTrackXp(
  actors: Readonly<Record<string, AuthorityActorProbeValue | undefined>>,
  actorKey: string,
  professionId: string,
  trackId: string,
): number | null {
  const actor = actors[actorKey];
  if (!actor) return null;
  const profession = actor.professions?.find((candidate) => candidate.id === professionId);
  const xp = profession?.trackXp?.[trackId];
  return typeof xp === "number" && Number.isFinite(xp) ? xp : 0;
}

export function authorityActorHasSkillBox(
  actors: Readonly<Record<string, AuthorityActorProbeValue | undefined>>,
  actorKey: string,
  skillBoxId: string,
): boolean | null {
  const actor = actors[actorKey];
  if (!actor) return null;
  return actor.professions?.some((profession) => profession.skillBoxes?.includes(skillBoxId)) ?? false;
}
