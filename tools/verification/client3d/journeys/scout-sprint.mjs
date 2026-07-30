// Journey: scout sprint speed (combat-doctrine.md §5). A plain marksman sprints
// a fixed burst (baseline), is granted the full scout sprinting track + master,
// then sprints the identical burst. Authority displacement proves the master
// scout covers measurably more ground. Money shots: baseline, scout.
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

async function sprintNorth(ctx, s) {
  const before = (await s.probe()).authorityPlayer;
  await s.dispatchKeys("keydown", ["ShiftLeft", "KeyW"]);
  for (let i = 0; i < 10; i += 1) await ctx.delay(300);
  await s.dispatchKeys("keyup", ["KeyW", "ShiftLeft"]);
  await s.releaseAll();
  await ctx.delay(500);
  const after = (await s.probe()).authorityPlayer;
  return dist(before, after);
}

export default {
  id: "scout-sprint",
  title: "Scout sprint speed (baseline vs master)",
  timeoutMs: 90000,
  characters: [{ role: "primary", id: "h3d-scout-probe", name: "ScoutProbe", x: 520, y: 700, facing: "right", equip: "slugthrower", initialProfessionId: "marksman" }],
  async run(ctx) {
    const s = ctx.primary;
    await s.waitProbe((p) => p.serverStatus === "connected" && p.authorityPlayer, { label: "spawn" });
    await ctx.moneyShot("00-spawn");

    const baseline = await sprintNorth(ctx, s);
    await ctx.moneyShot("01-baseline-sprint");

    await ctx.debugCommand({ DebugGrantSkillBoxes: { skill_box_ids: [
      "scout-novice", "scout-sprinting-i", "scout-sprinting-ii",
      "scout-sprinting-iii", "scout-sprinting-iv", "scout-master",
    ] } });
    await ctx.delay(500);

    const scout = await sprintNorth(ctx, s);
    ctx.note(`baseline sprint ${baseline.toFixed(2)}c vs master-scout ${scout.toFixed(2)}c`);
    await ctx.moneyShot("02-scout-sprint");

    s.assert(baseline > 2, `baseline sprint too small: ${baseline.toFixed(2)}c`);
    s.assert(scout > baseline * 1.1, `master scout must sprint farther: baseline ${baseline.toFixed(2)}c vs scout ${scout.toFixed(2)}c`);
  },
};
