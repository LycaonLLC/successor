/**
 * Scout movement family (combat-doctrine.md §5) — the sprint delta felt live.
 *
 * A plain marksman sprints a fixed burst (baseline), is granted the full scout
 * sprinting track + master, then sprints the identical burst. Authority
 * position (oracle truth) confirms the master scout covers measurably more
 * ground — the +36% sprint-speed + walk boost, felt in play.
 */
export default async function scoutSprint({ session, actorId, check, note, grantSkills, port }) {
  const id = actorId("a");
  // Keep the movement probe outside Dustgate's v8 authored facilities/props.
  const tui = session({ actorId: id, displayName: "ScoutRunner", spawnX: 540, spawnY: 540 });
  await tui.expect(/Signal locked/);

  const pos = async () => {
    const res = await fetch(`http://127.0.0.1:${port}/game/debug/oracle?freshAiDebug=1`);
    const oracle = await res.json();
    return oracle.actors?.[id] ?? null;
  };
  const sprintBurst = async () => {
    tui.send("/walk e 1.4 sprint");
    await tui.idle(1500);
    let lastP = await pos();
    for (let i = 0; i < 15; i++) {
      await tui.idle(100);
      const currentP = await pos();
      if (lastP && currentP && currentP.x === lastP.x && currentP.y === lastP.y) break;
      lastP = currentP;
    }
  };

  const p0 = await pos();
  await sprintBurst();
  const p1 = await pos();
  const baseline = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  await grantSkills(id, [
    "scout-novice", "scout-sprinting-i", "scout-sprinting-ii",
    "scout-sprinting-iii", "scout-sprinting-iv", "scout-master",
  ]);
  await tui.idle(500);
  const p2 = await pos();
  await sprintBurst();
  const p3 = await pos();
  const scout = Math.hypot(p3.x - p2.x, p3.y - p2.y);
  note(`baseline sprint ${baseline.toFixed(2)}c · master-scout sprint ${scout.toFixed(2)}c`);
  check("the plain sprint moved the pawn", baseline > 1);
  check("master scout sprints measurably farther than a plain marksman", scout > baseline * 1.1);
}
