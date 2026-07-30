/**
 * Scout camp — CampFE's proof arc in text: pitch (kit consumed) → status truth
 * from the placedCamps stream → leave → grace countdown honesty → return resets
 * → armed strike → gone, nothing returns.
 *
 * Runtime-skips on clients whose generated verbs predate camps.
 */
export default async function camp({ session, actorId, grant, grantSkills, check, skip }) {
  const id = actorId("a");
  // v8 commerce facility occupies (500..512,498..507); use clear desert east
  // of the Dustgate hub while retaining a deterministic authored fixture cell.
  const tui = session({ actorId: id, displayName: "GateScout", spawnX: 530, spawnY: 530 });
  await tui.expect(/Signal locked/);
  await tui.say("/camp", /No camp on this ground/);
  await grantSkills(id, ["scout-novice"]);
  await grant(id, "campKit", 1);
  await tui.idle(900);
  await tui.say("/camp pitch", /canvas up, ground claimed|DENIED/);
  let standing = null;
  for (let attempt = 0; attempt < 4 && !standing; attempt += 1) {
    const poll = await tui.say("/camp", /Your camp stands (under your canvas|\S+ \d+c)|No camp/);
    if (poll.line.includes("Your camp stands")) standing = poll;
    else await tui.idle(800);
  }
  check("pitched camp streams back with status truth", standing !== null);
  if (!standing) return;
  check("standing camp speaks persistence honesty", standing.line.includes("persists while you camp here"));
  tui.send("/walk s 6");
  await tui.idle(7000);
  let counting = null;
  for (let attempt = 0; attempt < 6 && !counting; attempt += 1) {
    const poll = await tui.say("/camp", /collapses in \d+:\d\d|persists while you camp here/);
    if (poll.line.includes("collapses in")) counting = poll;
    else await tui.idle(1500);
  }
  check("abandoned camp counts down honestly (returning resets)", counting !== null);
  tui.send("/walk n 6");
  await tui.idle(7000);
  let reset = null;
  for (let attempt = 0; attempt < 6 && !reset; attempt += 1) {
    const poll = await tui.say("/camp", /persists while you camp here|collapses in/);
    if (poll.line.includes("persists")) reset = poll;
    else await tui.idle(1500);
  }
  check("returning resets the grace clock", reset !== null);
  await tui.say("/camp packup", /returns NOTHING to your pack — \/camp packup again to confirm/);
  await tui.say("/camp packup", /strike the camp — nothing returns to the pack|DENIED/);
  let gone = false;
  for (let attempt = 0; attempt < 4 && !gone; attempt += 1) {
    const poll = await tui.say("/camp", /No camp on this ground|Your camp stands/);
    gone = poll.line.includes("No camp");
    if (!gone) await tui.idle(800);
  }
  check("struck camp leaves the ground bare", gone);
}
