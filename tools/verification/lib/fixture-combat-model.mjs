export const canonicalFixtureCombatModels = Object.freeze(["roll"]);

const canonicalFixtureCombatModelSet = new Set(canonicalFixtureCombatModels);

export function validateFixtureCombatModel(value, label = "fixture") {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !canonicalFixtureCombatModelSet.has(value)) {
    throw new Error(`${label}: combatModel must be one of ${canonicalFixtureCombatModels.join(", ")}; received ${JSON.stringify(value)}`);
  }
  return value;
}
