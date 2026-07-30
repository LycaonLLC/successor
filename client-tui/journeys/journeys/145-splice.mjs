/**
 * The gene bench — the TUI is the FIRST client that plays splice (no 3D
 * FE surface exists). Full arc over the repaired wire (DEF-7/8 fixed at
 * a20036d): sample two wild landraces where you stand → spread the bench
 * → seat both parents → assemble (defaults inherit) → mint a named
 * cultivar → seed oracle. The bench READOUT (DEF-6 surface) streams as
 * spliceSession and renders on phase changes + bare /splice.
 */
export default async function splice({ session, actorId, grant, grantSkills, check, skip }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "GateGeneist", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked/);
  await grant(id, "geneSampler", 1);
  await grant(id, "spliceBench", 1);
  await grantSkills(id, ["bioengineer-novice"]); // hybrid-elite gate: fixture route
  await tui.idle(900);
  await tui.say("/splice sample ashgrain", /GENE-SAMPLE QUEUED/);
  const sampled = await tui.expect(/sampler chews a wild cutting|GENE SAMPLE DENIED/, { timeoutMs: 6_000 }).catch(() => null);
  check("DEF-7/DEF-8: GeneSample reaches the sim and answers", sampled !== null);
  if (!sampled) return;
  // second parent: the sampler has an economy cadence — wait it out
  let second = false;
  for (let attempt = 0; attempt < 5 && !second; attempt += 1) {
    await tui.idle(2500);
    const again = await tui.say("/splice sample ashgrain", /sampler chews a wild cutting|ECONOMY COOLDOWN/);
    second = again.line.includes("sampler chews");
  }
  check("two wild genomes banked (cooldown honored)", second);
  const seeds = await tui.say("/inv ashgrain", /INV (\d+) STACK/);
  check(`seed stacks in the pack (${seeds.match[1]})`, Number(seeds.match[1]) >= 1);
  tui.send("/splice begin ashgrain");
  const bench = await tui.expect(/GENE BENCH — Ashgrain · SLOTS/, { timeoutMs: 6_000 }).catch(() => null);
  check("DEF-6: the gene bench readout reaches the terminal", bench !== null);
  await tui.expect(/spread the parent lines across the gene bench/);
  await tui.say("/splice fill 1 ashgrain", /QUEUED/);
  await tui.idle(700);
  await tui.say("/splice fill 2 ashgrain", /QUEUED/);
  await tui.idle(900);
  await tui.say("/splice assemble", /splice takes — a new line holds together|DENIED/);
  const mint = await tui.say("/splice mint Gate Strain", /mint the cultivar — seed stock, named and yours|DENIED/);
  check("the cultivar mints (splice E2E, first client ever)", mint.line.includes("named and yours"));
  const after = await tui.say("/inv ashgrain", /INV (\d+) STACK/);
  check(`minted seed joins the pack (${after.match[1]} stacks)`, Number(after.match[1]) >= 1);
}
