/** Movement — /walk displacement proven by /where deltas (DEF-1's regression). */
export default async function movement({ session, actorId, check }) {
  const tui = session({ actorId: actorId("a"), displayName: "GateWalker", spawnX: 520, spawnY: 520 });
  await tui.expect(/Signal locked/);
  const before = await tui.say("/where", /WHERE \S+ ([\d.]+),([\d.]+)/);
  const x0 = Number(before.match[1]);
  const y0 = Number(before.match[2]);
  await tui.say("/walk n 3", /You set off north\./);
  await tui.idle(4200); // the walk itself is time — the one honest sleep
  const after = await tui.say("/where", /WHERE \S+ ([\d.]+),([\d.]+)/);
  const x1 = Number(after.match[1]);
  const y1 = Number(after.match[2]);
  const northDx = x1 - x0;
  const northDy = y1 - y0;
  check(`walk displaced the actor (${x0},${y0} → ${x1},${y1})`, Math.hypot(northDx, northDy) > 1);
  check(`northward walk followed raw (0,-y): (${northDx.toFixed(2)},${northDy.toFixed(2)})`, Math.abs(northDx) <= 0.5 && northDy < -0.5);
  check("northward walk stayed on the screen-north axis", Math.abs(northDx) <= Math.abs(northDy) * 0.15 + 0.5);

  await tui.say("/walk w 3", /You set off west\./);
  await tui.idle(4200);
  const afterWest = await tui.say("/where", /WHERE \S+ ([\d.]+),([\d.]+)/);
  const x2 = Number(afterWest.match[1]);
  const y2 = Number(afterWest.match[2]);
  const westDx = x2 - x1;
  const westDy = y2 - y1;
  check(`westward walk followed raw (-x,0): (${westDx.toFixed(2)},${westDy.toFixed(2)})`, westDx < -0.5 && Math.abs(westDy) <= 0.5);
  check("westward walk stayed on the screen-west axis", Math.abs(westDy) <= Math.abs(westDx) * 0.15 + 0.5);
}
