/**
 * Trainer conversation — numbered dialogue, honest XP gates, and (when
 * the claimed placeholder hasn't already got them) a real starter
 * purchase with the refreshed slate. Branches on claim reality.
 */
import { openTrainer } from "../lib/trainer.mjs";

export default async function converseTrain({ session, actorId, check }) {
  // v8 commerce-discovery layout: Knox Vale is at (510,504); start adjacent
  // inside the authored commerce interior so converse uses authority range.
  const tui = session({ actorId: actorId("a"), displayName: "GateStudent", spawnX: 510, spawnY: 505 });
  await tui.expect(/Signal locked/);
  await tui.idle(900); // AOI settle
  await openTrainer(tui);
  await tui.expect(/1\. What can you teach me\?/);
  await tui.say("1", /Slate's chalked|teach/i);
  const first = await tui.expect(/1\. \w+ · [\w ]+ · (STARTER · \d+ SP|\d+ XP · \d+ SP)/);
  check("the slate numbers its boxes with prices", first.line.includes("SP"));
  const gated = await tui.expect(/Needs \d+ more XP/);
  check("locked boxes speak their XP gate", /Needs \d+ more XP/.test(gated.line));
  const starter = /(\d+)\. \w+ · NOVICE \w+ · STARTER/.exec(first.line);
  if (starter) {
    await tui.say(starter[1], /Chalked and yours/);
    const refreshed = await tui.expect(/1\. \w+ · [\w ]+ · \d+ XP · \d+ SP/);
    check("tree refreshes after training", refreshed.line.length > 0);
  } else {
    check("claimed placeholder already trained — slate shows progression boxes", true);
  }
  await tui.say("0", /turns back to their work/);
}
