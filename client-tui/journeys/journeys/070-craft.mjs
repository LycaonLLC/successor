/**
 * The full craft session — access (trained or inherited via placeholder
 * claim) → begin → streamed slot screen with bench picks → fill auto →
 * assemble with the SHARED band word → experiment delta prose →
 * prototype into crafted-gear.
 */
import { ensureCraftsman } from "../lib/trainer.mjs";

export default async function craft({ session, actorId, grant, check, note }) {
  const id = actorId("a");
  // v8 commerce-discovery layout: Knox Vale is at (510,504).
  const tui = session({ actorId: id, displayName: "GateSmith", spawnX: 510, spawnY: 505 });
  await tui.expect(/Signal locked/);
  // the survey tool (item 3001, de-specified naming) gates craft-begin AHEAD
  // of recipe access since the bootstrap-crafter change — grant it first
  await grant(id, "multitool", 1);
  await tui.idle(900);
  const access = await ensureCraftsman(tui, "extractor_battery");
  note(`craftsman access: ${access}`);
  // quantities sized for the resource-units rebalance (grams; ResourceDoctrine
  // 9169b02) — harmlessly large under the old units, sufficient under the new.
  await grant(id, "copper", 5000);
  await grant(id, "iron", 2000);
  await grant(id, "fuel", 12);
  await tui.idle(900); // the grant deltas ride the next snapshot
  await tui.say("/craft begin extractor_battery", /clear the bench and lay the frame out/);
  await tui.expect(/SLOT Ⅰ —/);
  await tui.expect(/SLOT Ⅱ —/);
  await tui.expect(/SLOT Ⅲ —/);
  await tui.expect(/Fuel \(×12\)/);
  const pick = await tui.expect(/◆ bench pick/);
  check("slot screen streams with the bench pick flagged", pick.line.includes("◆"));
  tui.send("/craft fill auto");
  await tui.expect(/Every slot is seated — \/craft assemble when ready/);
  tui.send("/craft assemble");
  await tui.expect(/bring the assembly together and hold your breath/);
  const band = await tui.expect(/Assembly holds — (\w+) work \(quality (\d+)%\)/);
  check(`assembly speaks the shared band word (${band.match[1]} @ ${band.match[2]}%)`, band.match[1].length > 0);
  const gauge = await tui.expect(/0\. \w+\s+(\d+) \/ cap (\d+)/);
  const statBefore = Number(gauge.match[1]);
  const pointsRow = await tui.expect(/Experimentation: (\d+) points?\./);
  const pointsBefore = Number(pointsRow.match[1]);
  tui.send("/craft exp 0 1");
  await tui.expect(/The experiment takes\./);
  // Live craft copy narrates rise, stall, or slip from server truth.
  const delta = await tui.expect(
    /(?:You lean on \w+ — (\d+) → (\d+)\. (\d+) points? spent, (\d+) remain\.|The \w+ line refuses to move — (\d+) points? spent for nothing\. (\d+) remain\.|The experiment slips — \w+ falls (\d+) → (\d+)\. (\d+) remain\.)/,
  );
  let outcome;
  let before;
  let after;
  let pointsRemaining;
  if (delta.match[1] != null) {
    outcome = "rise";
    before = Number(delta.match[1]);
    after = Number(delta.match[2]);
    pointsRemaining = Number(delta.match[4]);
    check("rise narration spends exactly one point", Number(delta.match[3]) === 1);
  } else if (delta.match[5] != null) {
    outcome = "stall";
    before = statBefore;
    after = statBefore;
    pointsRemaining = Number(delta.match[6]);
    check("stall narration spends exactly one point", Number(delta.match[5]) === 1);
  } else {
    outcome = "slip";
    before = Number(delta.match[7]);
    after = Number(delta.match[8]);
    pointsRemaining = Number(delta.match[9]);
  }
  note(`experiment ${outcome}: ${before} → ${after}, ${pointsRemaining} remain`);
  check(
    `experiment quality changes in the narrated direction (${before} → ${after})`,
    outcome === "rise" ? after > before : outcome === "slip" ? after < before : after === before,
  );
  check("experiment delta starts from the assembled gauge", before === statBefore);
  check(
    "experimentation remaining drops by the spent point",
    pointsRemaining === pointsBefore - 1,
  );
  tui.send("/craft prototype");
  await tui.expect(/comes off the bench into your pack/);
  const inv = await tui.say("/inv battery", /crafted-gear/);
  check("the battery EXISTS in crafted-gear", inv.line.includes("crafted-gear"));
}
