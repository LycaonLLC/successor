/**
 * CHARACTER NAME — client mirror of the server registry contract:
 * 3–16 total chars, ASCII letters, optional SINGLE hyphens only BETWEEN
 * letter runs. No spaces, numbers, symbols, leading/trailing/repeated
 * hyphens. The server stays the authority (`name_taken`, final shape) —
 * this only keeps the visible input honest while typing.
 */

/** Full contract: letter run, then optional (-letterrun)* — length checked
 * separately so the regex stays readable. */
const NAME_SHAPE = /^[A-Za-z]+(?:-[A-Za-z]+)*$/u;

export const CHARACTER_NAME_MIN = 3;
export const CHARACTER_NAME_MAX = 16;

/** True when `name` satisfies the full registry contract. */
export function isValidCharacterName(name: string): boolean {
  return name.length >= CHARACTER_NAME_MIN
    && name.length <= CHARACTER_NAME_MAX
    && NAME_SHAPE.test(name);
}

/** Live input filter — keeps the field typeable mid-word: strips anything
 * outside [A-Za-z-], drops leading hyphens, collapses hyphen runs, caps at
 * 16. A TRAILING hyphen survives (the player is mid "Mara-Lyn"); validity
 * still flags it until letters follow. */
export function filterCharacterNameInput(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[^A-Za-z-]/gu, "")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, CHARACTER_NAME_MAX);
}
