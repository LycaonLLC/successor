import { describe, expect, it } from "vitest";

import { characterSlotUiState, maxCharactersFromResponse, type CharacterLimitsPayload } from "./characterSelectSlots";

const response = (maxCharacters: number | undefined): CharacterLimitsPayload => ({
  limits: maxCharacters === undefined ? undefined : { maxCharacters },
});

describe("character select slot limits", () => {
  it("reads the slot cap from the /game/characters limits payload", () => {
    expect(maxCharactersFromResponse(response(3))).toBe(3);
    expect(maxCharactersFromResponse(response(0))).toBe(0);
    expect(maxCharactersFromResponse(response(undefined))).toBeNull();
  });

  it("uses the server cap for slot text and the upsell full-state label", () => {
    expect(characterSlotUiState(2, 3)).toEqual({
      slotsText: "2 / 3",
      newCharacterDisabled: false,
      newCharacterLabel: "+ NEW CHARACTER",
    });
    expect(characterSlotUiState(3, 3)).toEqual({
      slotsText: "3 / 3",
      newCharacterDisabled: true,
      newCharacterLabel: "SLOTS FULL — GET MORE AT SUCCESSORGAME.COM",
    });
  });
});
