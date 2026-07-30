import type { LaunchProvenance, LaunchPurpose, RedeemedLaunch } from "../alpha/index.js";
import type { CharacterRecord, CharacterStore } from "../game/characterStore.js";
import type { GameActorAppearanceSnapshot, GameActorVitals, GameActorWornPiece } from "../game/protocol.js";
import type { ChatSessionIdentity } from "../chat/hub.js";
import type { RuntimeAuthConfig } from "./runtime.js";

export interface StandaloneLaunchIdentity extends ChatSessionIdentity {
  readonly actorId: string;
  readonly playerId: string;
  readonly accountId: string;
  readonly ownerRef: string;
  readonly characterId: string;
  readonly returningCharacter: boolean;
  readonly appearance: GameActorAppearanceSnapshot;
  readonly worn: GameActorWornPiece[];
  readonly wornColors: Record<string, string[]>;
  readonly professionIds: string[];
  readonly skillBoxIds: string[];
  readonly credits: number;
  readonly vitals?: GameActorVitals;
  readonly activeTitleId: string | null;
  readonly careerGoalId: string | null;
  readonly spawn?: {
    areaId: string;
    x: number;
    y: number;
    facing: "front" | "right" | "back" | "left";
  };
  readonly launchProvenance: LaunchProvenance;
  readonly clientReleaseId: string;
  readonly serverReleaseId: string;
  readonly issuer: string;
  readonly shardId: string;
}

export interface StandaloneLaunchStore {
  redeemCapability(input: {
    token: string;
    purpose: LaunchPurpose;
    shardId: string;
    clientReleaseId: string;
    serverReleaseId: string;
    issuer: string;
  }): Promise<RedeemedLaunch>;
  revokeLaunch(launchId: string, accountId?: string): Promise<void>;
}

export async function redeemStandaloneLaunch(
  token: string,
  purpose: LaunchPurpose,
  controlStore: StandaloneLaunchStore,
  characterStore: CharacterStore,
  config: Pick<RuntimeAuthConfig, "shardId" | "clientReleaseId" | "serverReleaseId" | "issuer">,
  isCharacterIdReserved?: (characterId: string) => boolean,
): Promise<StandaloneLaunchIdentity> {
  const launch = await controlStore.redeemCapability({
    token,
    purpose,
    shardId: config.shardId,
    clientReleaseId: config.clientReleaseId,
    serverReleaseId: config.serverReleaseId,
    issuer: config.issuer,
  });
  const character = characterStore.get(launch.characterId, launch.ownerRef);
  if (!character || isCharacterIdReserved?.(launch.characterId)) {
    await revokeFailedLaunch(controlStore, launch);
    throw new Error("launch character is not an exact owned durable character");
  }
  return standaloneIdentity(launch, character);
}

export function standaloneIdentity(launch: RedeemedLaunch, character: CharacterRecord): StandaloneLaunchIdentity {
  const professions = character.professions && typeof character.professions === "object"
    ? character.professions as Record<string, unknown>
    : null;
  const skillBoxIds = Array.isArray(professions?.skillBoxes)
    ? professions.skillBoxes.filter((value): value is string => typeof value === "string")
    : character.initialProfessionId ? [`${character.initialProfessionId}-novice`] : [];
  const credits = typeof professions?.credits === "number" && Number.isFinite(professions.credits)
    ? professions.credits
    : 0;
  const appearance = {
    skin: character.appearance.skinTone,
    hair: character.appearance.hair,
    hair_mat: character.appearance.hairMat,
    face: character.appearance.face
      ? {
        eyes: character.appearance.face.eyes,
        brows: character.appearance.face.brows,
        nose: character.appearance.face.nose,
        mouth: character.appearance.face.mouth,
        eye_color: character.appearance.face.eyeColor,
        brow_color: character.appearance.face.browColor,
        lip_color: character.appearance.face.lipColor,
      }
      : null,
  } satisfies GameActorAppearanceSnapshot;
  return {
    actorId: character.id,
    playerId: character.id,
    userId: character.id,
    displayName: character.name,
    zoneId: launch.shardId,
    accountId: launch.accountId,
    ownerRef: launch.ownerRef,
    characterId: character.id,
    returningCharacter: character.worldEntryClaimed,
    appearance,
    worn: character.worn.map((entry) => ({ item: entry.item, colors: [...entry.colors] })),
    wornColors: Object.fromEntries(Object.entries(character.wornColors).map(([item, colors]) => [item, [...colors]])),
    professionIds: character.initialProfessionId ? [character.initialProfessionId] : [],
    skillBoxIds,
    credits,
    ...(character.vitals ? { vitals: { ...character.vitals } } : {}),
    activeTitleId: character.activeTitleId,
    careerGoalId: character.careerGoalId,
    ...(character.position ? { spawn: { ...character.position } } : {}),
    launchProvenance: {
      launchId: launch.launchId,
      accountId: launch.accountId,
      ownerRef: launch.ownerRef,
      characterId: launch.characterId,
      issuer: launch.issuer,
    },
    clientReleaseId: launch.clientReleaseId,
    serverReleaseId: launch.serverReleaseId,
    issuer: launch.issuer,
    shardId: launch.shardId,
  };
}

async function revokeFailedLaunch(controlStore: StandaloneLaunchStore, launch: RedeemedLaunch): Promise<void> {
  try {
    await controlStore.revokeLaunch(launch.launchId, launch.accountId);
  } catch {
    // The capability was already consumed; preserve fail-closed behavior even
    // if cleanup races with account/device revocation.
  }
}
