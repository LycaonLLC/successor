export type CharacterSlotLimit = number | null;

export interface CharacterLimitsPayload {
  limits?: { maxCharacters?: number };
}

export interface CharacterSlotUiState {
  slotsText: string;
  newCharacterDisabled: boolean;
  newCharacterLabel: string;
}

export function maxCharactersFromResponse(data: CharacterLimitsPayload): CharacterSlotLimit {
  const maxCharacters = data.limits?.maxCharacters;
  return typeof maxCharacters === "number" && Number.isFinite(maxCharacters) && maxCharacters >= 0
    ? Math.trunc(maxCharacters)
    : null;
}

export function characterSlotUiState(characterCount: number, maxCharacters: CharacterSlotLimit): CharacterSlotUiState {
  const slotsFull = maxCharacters !== null && characterCount >= maxCharacters;
  return {
    slotsText: `${characterCount} / ${maxCharacters ?? "—"}`,
    newCharacterDisabled: slotsFull,
    newCharacterLabel: slotsFull ? "SLOTS FULL — GET MORE AT SUCCESSORGAME.COM" : "+ NEW CHARACTER",
  };
}
