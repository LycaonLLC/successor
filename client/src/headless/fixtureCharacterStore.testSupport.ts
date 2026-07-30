import fs from "node:fs/promises";

const initialProfessionIds = ["marksman", "scout", "craftsman", "medic", "brawler"] as const;

type FixtureCharacter = {
  initialProfessionId?: unknown;
  professions?: {
    skillBoxes?: unknown;
  } | null;
};

type FixtureCharacterStore = {
  characters?: unknown;
};

/**
 * Old verification fixtures predate the required creator profession field.
 * Resolve those disposable records through the same one-choice contract while
 * preserving any richer authored profession snapshot already in the fixture.
 */
export async function resolveFixtureInitialProfessions(storePath: string): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(storePath, "utf8")) as FixtureCharacterStore;
  if (!Array.isArray(parsed.characters)) throw new Error("fixture character store has no characters array");

  for (const value of parsed.characters) {
    if (!value || typeof value !== "object") throw new Error("fixture character store contains an invalid character");
    const character = value as FixtureCharacter;
    if (typeof character.initialProfessionId === "string") continue;

    const skillBoxes = Array.isArray(character.professions?.skillBoxes)
      ? character.professions.skillBoxes.filter((entry): entry is string => typeof entry === "string")
      : [];
    character.initialProfessionId = initialProfessionIds.find((professionId) => (
      skillBoxes.includes(`${professionId}-novice`)
    )) ?? "marksman";
  }

  await fs.writeFile(storePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}
