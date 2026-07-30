/**
 * Trainer helpers. Two truths shape these:
 * — arrival prose groups figures ("three figures drift into scope"), so
 *   names can't be waited on: try the conversation, wait out a patrol
 *   swing, try again.
 * — players CLAIM authored camp placeholders and inherit their skill
 *   boxes, so "is craftsman trained?" varies per claim: journeys branch
 *   on reality instead of assuming a fresh sheet.
 */

export async function openTrainer(tui, { tries = 6, gapMs = 1_800 } = {}) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const result = await tui.say("/converse", /⟨Knox Vale⟩|find a trainer first/);
    if (result.line.includes("⟨Knox Vale⟩")) return;
    await tui.idle(gapMs);
  }
  throw new Error("no camp trainer entered scope within the patience window");
}

/**
 * Make sure this actor can open craftsman recipes: try the bench first;
 * an UNKNOWN SCHEMATIC deny routes through the trainer purchase. Returns
 * "inherited" (claimed a crafter placeholder) or "trained".
 */
export async function ensureCraftsman(tui, recipeId) {
  const attempt = await tui.say(`/craft begin ${recipeId}`, /UNKNOWN SCHEMATIC|MISSING SURVEY TOOL|clear the bench and lay the frame out/);
  if (attempt.line.includes("clear the bench")) {
    await tui.say("/craft cancel", /sweep the bench clear|walks away|CANCEL/i);
    return "inherited";
  }
  await openTrainer(tui);
  await tui.say("1", /Slate's chalked|teach/i);
  const row = await tui.expect(/(\d+)\. CRAFTSMAN · NOVICE CRAFTSMAN · STARTER/);
  await tui.say(row.match[1], /Chalked and yours/);
  await tui.say("0", /turns back to their work/);
  return "trained";
}
