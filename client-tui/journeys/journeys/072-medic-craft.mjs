/**
 * MEDIC WAVE — the component-based medical crafting tree, crafted in the MUD workbench.
 * A trained medic (medical-crafting IV) receives raw resources, crafts the three
 * named medical components plus the delivery shell, then crafts the ADVANCED
 * STIMPAK from those real component items. This is the end-to-end proof that
 * the component names are not flavor-only.
 */
export default async function medicCraft({ session, actorId, grant, grantSkills, check, note }) {
  const id = actorId("a");
  const tui = session({ actorId: id, displayName: "FieldMedic", spawnX: 514, spawnY: 514 });
  await tui.expect(/Signal locked/);

  await grantSkills(id, [
    "medic-novice",
    "medic-medical-crafting-i",
    "medic-medical-crafting-ii",
    "medic-medical-crafting-iii",
    "medic-medical-crafting-iv",
  ]);
  await grant(id, "multitool", 1);
  await grant(id, "clodpowder", 40);
  await grant(id, "chemical", 48);
  await grant(id, "water", 24);
  await grant(id, "iron", 64);
  await tui.idle(900); // grant deltas ride the next snapshot

  async function craftPrototype(recipeId, displayName, materialChecks = []) {
    await tui.say(`/craft begin ${recipeId}`, /clear the bench and lay the frame out/);
    await tui.expect(/SLOT Ⅰ —/);
    for (const pattern of materialChecks) {
      const material = await tui.expect(pattern);
      note(`TUI requirement line: ${material.line}`);
    }
    tui.send("/craft fill auto");
    await tui.expect(/Every slot is seated — \/craft assemble when ready/);
    tui.send("/craft assemble");
    await tui.expect(/bring the assembly together and hold your breath/);
    await tui.expect(/Assembly holds —/);
    tui.send("/craft prototype");
    await tui.expect(/comes off the bench into your pack/);
    note(`${displayName} crafted from raw resources`);
  }

  await craftPrototype("bio_effect_controller", "Biological Effect Controller", [/Clodpowder \(×8\)/, /Petrochemical \(×6\)/]);
  await craftPrototype("liquid_suspension", "Liquid Suspension", [/Water \(×12\)/, /Petrochemical \(×6\)/]);
  await craftPrototype("chemical_release_mechanism", "Chemical Release Duration Mechanism", [/Petrochemical \(×8\)/, /Iron \(×10\)/]);
  await craftPrototype("solid_delivery_shell", "Solid Delivery Shell", [/Iron \(×20\)/]);
  note("crafted all four medical component items from raw resources");

  await tui.say("/craft begin advanced_stimpak", /clear the bench and lay the frame out/);
  const becSlot = await tui.expect(/SLOT Ⅰ — Biological Effect Controller ×1/);
  const suspensionSlot = await tui.expect(/SLOT Ⅱ — Liquid Suspension ×1/);
  const releaseSlot = await tui.expect(/SLOT Ⅲ — Chemical Release Duration Mechanism ×1/);
  note(`TUI exact component slots: ${becSlot.line} / ${suspensionSlot.line} / ${releaseSlot.line}`);
  const pick = await tui.expect(/◆ bench pick/);
  check("the component slot screen streams with a bench pick", pick.line.includes("◆"));

  tui.send("/craft fill auto");
  await tui.expect(/Every slot is seated — \/craft assemble when ready/);
  tui.send("/craft assemble");
  await tui.expect(/bring the assembly together and hold your breath/);
  const band = await tui.expect(/Assembly holds — (\w+) work \(quality (\d+)%\)/);
  check(`assembly speaks the shared band word (${band.match[1]} @ ${band.match[2]}%)`, band.match[1].length > 0);

  const gauge = await tui.expect(/0\. \w+\s+(\d+) \/ cap (\d+)/);
  const before = Number(gauge.match[1]);
  const cap = Number(gauge.match[2]);
  note(`advanced-stimpak potency line: ${before} / cap ${cap}`);
  const pointsRow = await tui.expect(/Experimentation: (\d+) points?\./);
  const pointsBefore = Number(pointsRow.match[1]);
  note(`experimentation pool before spend: ${pointsBefore}`);

  tui.send("/craft exp 0 1");
  await tui.expect(/The experiment takes\./);
  // Server truth can rise, stall, or slip — assert the live player-facing copy for each.
  const delta = await tui.expect(
    /(?:You lean on \w+ — (\d+) → (\d+)\. (\d+) points? spent, (\d+) remain\.|The \w+ line refuses to move — (\d+) points? spent for nothing\. (\d+) remain\.|The experiment slips — \w+ falls (\d+) → (\d+)\. (\d+) remain\.)/,
  );
  let outcome;
  let narratedBefore;
  let narratedAfter;
  let pointsRemaining;
  if (delta.match[1] != null) {
    outcome = "rise";
    narratedBefore = Number(delta.match[1]);
    narratedAfter = Number(delta.match[2]);
    pointsRemaining = Number(delta.match[4]);
    check("rise narration spends exactly one point", Number(delta.match[3]) === 1);
  } else if (delta.match[5] != null) {
    outcome = "stall";
    narratedBefore = before;
    narratedAfter = before;
    pointsRemaining = Number(delta.match[6]);
    check("stall narration spends exactly one point", Number(delta.match[5]) === 1);
  } else {
    outcome = "slip";
    narratedBefore = Number(delta.match[7]);
    narratedAfter = Number(delta.match[8]);
    pointsRemaining = Number(delta.match[9]);
  }
  note(`experiment ${outcome}: ${narratedBefore} → ${narratedAfter}, ${pointsRemaining} remain`);
  check(
    `experiment narrates the server ${outcome} (${narratedBefore} → ${narratedAfter})`,
    outcome === "rise"
      ? narratedAfter > narratedBefore
      : outcome === "slip"
        ? narratedAfter < narratedBefore
        : narratedAfter === narratedBefore,
  );
  check("experiment delta starts from the assembled gauge", narratedBefore === before);
  check(
    "experimentation remaining drops by the spent point",
    pointsRemaining === pointsBefore - 1,
  );

  tui.send("/craft prototype");
  await tui.expect(/comes off the bench into your pack/);
  const inv = await tui.say("/inv advanced", /crafted-gear|Advanced Stimpak/i);
  check("the ADVANCED STIMPAK exists in the pack", /Advanced Stimpak|crafted-gear/i.test(inv.line));
  note(`advanced stimpak inventory line: ${inv.line}`);
}
