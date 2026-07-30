// Journey: character CREATION — fixed-issue outfit cutover (owner program
// 2026-07-18). Proves the creator loop end to end on the REAL charselect UI:
// name + skin + hair stepper/color (appearance only — clothing is NOT a
// choice) → choose one ordinary Brawler novice allocation → CREATE (payload
// carries NO worn set) → ENTER → the authority pawn wears EXACTLY the fixed
// registry outfit (baby-blue under_bodysuit #89cff0 + boots_canvas_ankle
// #303030/#808080) → BARE-START truth (exactly two fixed clothing rows,
// no profession gear or weapon, skill usage 16/250, scalar credits exactly
// 5,000) → relog shows the outfit on the roster doll (store persistence) →
// DELETE strikes a second throwaway record.
//
// Money shots: creator form (no wardrobe controls), in-world fixed-issue
// pawn, clothing inventory.
//
// HAIR: steps to hair_banded_mohawk — a NEW-style id — keeping this the
// end-to-end proof of the hair appearance substrate (pattern validation +
// manifest-driven render).

import { openDockWindow } from "./_helpers.mjs";

const DOCTRINE_STARTING_CREDITS = 5_000;

/** The immutable fixed-issue outfit (authority actors.rs + characterStore). */
const EXPECTED_WORN = [
  { item: "under_bodysuit", colors: ["#89cff0"] },
  { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
];

function wireFace(face) {
  return face
    ? {
        eyes: face.eyes,
        brows: face.brows,
        nose: face.nose,
        mouth: face.mouth,
        eye_color: face.eyeColor,
        brow_color: face.browColor,
        lip_color: face.lipColor,
      }
    : null;
}

function wireFaceSignature(face) {
  return face
    ? [
        face.eyes,
        face.brows,
        face.nose,
        face.mouth,
        face.eye_color,
        face.brow_color,
        face.lip_color,
      ].join(",")
    : "";
}

/** itemId → equipment id for the two fixed clothing inventory rows. */
const CLOTHING_EQUIPMENT_BY_ITEM_ID = new Map([
  [9_900_001, "under_bodysuit"],
  [7_319, "boots_canvas_ankle"],
]);

async function equipmentContractSnapshot(s, actorId, itemId, equipmentId) {
  const [probe, oracle, client] = await Promise.all([
    s.probe(),
    s.oracle(),
    s.page.evaluate(({ actorId: currentActorId, itemId: currentItemId }) => {
      const row = document.querySelector(`.inv-slot[data-item-id="${currentItemId}"]`);
      const rawCache = localStorage.getItem(`successor3d.appearance.${currentActorId}`);
      let cache = null;
      try {
        cache = rawCache ? JSON.parse(rawCache) : null;
      } catch {
        cache = null;
      }
      return {
        uiEquipped: row?.hasAttribute("data-equipped") ?? null,
        paperDollEquipmentIds: window.__successor3dInventoryPaperDollEquipmentIds ?? [],
        cacheEquipmentIds: cache?.equipmentIds ?? [],
      };
    }, { actorId, itemId }),
  ]);
  const actor = oracle?.actors?.[actorId];
  const row = (oracle?.inventory ?? []).find(
    (candidate) => String(candidate.container).startsWith(actorId) && Number(candidate.itemId) === itemId,
  );
  return {
    acceptedCommands: probe?.acceptedCommands ?? 0,
    rejectedCommands: probe?.rejectedCommands ?? 0,
    authorityWorn: (actor?.worn ?? []).some((piece) => piece.item === equipmentId),
    authorityRowEquipped: row?.equipped ?? null,
    clientProjectionWorn: (probe?.authorityPlayer?.worn ?? []).some((piece) => piece.item === equipmentId),
    worldAttached: (probe?.localEquipmentIds ?? []).includes(equipmentId),
    paperDollAttached: client.paperDollEquipmentIds.includes(equipmentId),
    cacheAttached: client.cacheEquipmentIds.includes(equipmentId),
    uiEquipped: client.uiEquipped,
  };
}

async function waitEquipmentContract(s, actorId, itemId, equipmentId, equipped, acceptedAfter = -1) {
  return s.waitProbeCall(
    () => equipmentContractSnapshot(s, actorId, itemId, equipmentId),
    (snapshot) => snapshot.acceptedCommands > acceptedAfter
      && snapshot.authorityWorn === equipped
      && snapshot.authorityRowEquipped === equipped
      && snapshot.clientProjectionWorn === equipped
      && snapshot.worldAttached === equipped
      && snapshot.paperDollAttached === equipped
      && snapshot.cacheAttached === equipped
      && snapshot.uiEquipped === equipped,
    {
      label: `${equipmentId} ${equipped ? "equip" : "unequip"} full authority-to-render contract`,
      timeoutMs: 15000,
    },
  );
}

export default {
  id: "creation",
  title: "Character Creation + Fixed Issue Outfit",
  timeoutMs: 150000,
  // No pre-seeded characters: the journey OWNS creation. Runner boots the
  // scratch backend with an empty disposable store and leaves us on charselect.
  characters: [],
  async run(ctx) {
    const s = ctx.primary;
    const page = s.page;

    // charselect online, zero characters.
    await s.waitFn(
      "!!window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.serverOnline === true",
      { timeoutMs: 20000, label: "charselect online" },
    );

    // ── CREATE MODE: appearance only, clothing is a fixed fact ──────────
    await page.click('[data-ref="newButton"]');
    // REGRESSION (2026-07-11): create mode opens on the BLANK canonical
    // draft — SHAVED — never a dressed lookalike of a roster character. The
    // doll previews the fixed registry outfit from the generated wardrobe
    // registry; there is NO draft worn state.
    const blank = await s.probe("__successor3dCharacterSelect");
    s.assert(blank.mode === "create", `mode ${blank.mode} != create after + NEW CHARACTER`);
    s.assert(blank.draftHair === null, `blank draft hair ${blank.draftHair} != null (SHAVED)`);
    s.assert(blank.draftWorn === undefined, `draftWorn probe survived the cutover: ${JSON.stringify(blank.draftWorn)}`);
    s.assert(
      JSON.stringify(blank.fixedWorn) === JSON.stringify(EXPECTED_WORN),
      `fixed preview worn drifted: ${JSON.stringify(blank.fixedWorn)}`,
    );
    s.assert(blank.draftInitialProfessionId === null, `blank draft profession ${blank.draftInitialProfessionId} != null`);

    // CUTOVER: zero wardrobe controls — no per-slot steppers, no zone dye
    // rows. Zero wardrobe steppers; one hair and four face steppers remain. The outfit is a static note.
    const wardrobeControls = await s.evalExpr(
      "document.querySelectorAll('.sc3d-cs-stepper[data-slot], .sc3d-cs-zonelabel, [data-ref=\"wardrobeSections\"]').length",
    );
    s.assert(wardrobeControls === 0, `${wardrobeControls} wardrobe controls survived the cutover`);
    const stepperCount = await s.evalExpr("document.querySelectorAll('.sc3d-cs-stepper').length");
    s.assert(stepperCount === 5, `stepper count ${stepperCount} != 5 (1 hair + 4 face)`);

    await page.fill('[data-ref="nameInput"]', "WardrobeProof");
    await page.click('[data-ref="createProfessionGrid"] [data-profession-id="brawler"]');
    const allocatedDraft = await s.probe("__successor3dCharacterSelect");
    s.assert(allocatedDraft.draftInitialProfessionId === "brawler", `draft profession ${allocatedDraft.draftInitialProfessionId} != brawler`);
    // skin: 4th tone.
    await page.click('[data-ref="skinRow"] .sc3d-cs-swatch:nth-of-type(4)');
    // hair: blank draft = SHAVED (option index 0); four ▶ steps land
    // hair_banded_mohawk (first NEW style, behind SHAVED + 3 legacy) —
    // proves the stepper AND the hair substrate. Color: moss (bold family).
    await page.click('[data-ref="hairStepper"] .sc3d-cs-stepbtn:last-of-type');
    await page.click('[data-ref="hairStepper"] .sc3d-cs-stepbtn:last-of-type');
    await page.click('[data-ref="hairStepper"] .sc3d-cs-stepbtn:last-of-type');
    await page.click('[data-ref="hairStepper"] .sc3d-cs-stepbtn:last-of-type');
    const hairSwatches = await page.$$('[aria-label="Hair color"] .sc3d-cs-swatch');
    s.assert(hairSwatches.length > 10, `hair color row too short (${hairSwatches.length})`);
    await hairSwatches[10].click();
    // Deliberately non-default mixed face. This must survive creator record,
    // Rust registration, client projection, atlas paint, and relog.
    for (const [ref, count] of [
      ["faceEyesStepper", 1],
      ["faceBrowsStepper", 2],
      ["faceNoseStepper", 3],
      ["faceMouthStepper", 4],
    ]) {
      for (let step = 0; step < count; step += 1) {
        await page.click(`[data-ref="${ref}"] .sc3d-cs-stepbtn:last-of-type`);
      }
    }
    await page.click('[data-ref="faceEyeColorRow"] .sc3d-cs-swatch:nth-of-type(3)');
    await page.click('[data-ref="faceBrowColorRow"] .sc3d-cs-swatch:nth-of-type(4)');
    await page.click('[data-ref="faceLipColorRow"] .sc3d-cs-swatch:nth-of-type(5)');
    await ctx.delay(400); // doll rebuild settle for the money shot
    await ctx.moneyShot("00-creator-fixed-issue");

    const draft = await s.probe("__successor3dCharacterSelect");
    s.assert(draft.draftHair === "hair_banded_mohawk", `draft hair ${draft.draftHair} != hair_banded_mohawk`);
    const expectedFace = wireFace(draft.draftFace);
    s.assert(expectedFace && expectedFace.eyes !== "stoic" && expectedFace.mouth !== "stoic",
      `creator face did not move off defaults: ${JSON.stringify(draft.draftFace)}`);
    const expectedFaceSignature = wireFaceSignature(expectedFace);

    // ── CREATE → roster ─────────────────────────────────────────────────
    await page.click('[data-ref="createButton"]');
    await s.waitFn(
      "window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.mode === \"select\" && window.__successor3dCharacterSelect.characterCount >= 1",
      { timeoutMs: 15000, label: "record filed" },
    );
    ctx.note("record filed: WardrobeProof");

    // ── ENTER → the pawn wears the fixed issue ──────────────────────────
    const characterId = await s.evalExpr("window.__successor3dCharacterSelect.selectedId");
    s.assert(typeof characterId === "string" && characterId.length > 0, "no selected character after create");
    await s.enterWorld(characterId);
    const world = await s.waitProbe(
      (p) => p.serverStatus === "connected"
        && p.authorityPlayer
        && (p.authorityPlayer.worn ?? []).length === EXPECTED_WORN.length
        && JSON.stringify(p.authorityPlayer.appearance?.face ?? null) === JSON.stringify(expectedFace)
        && p.localFacePaint?.attached === true
        && p.localFacePaint?.ready === true
        && p.localFacePaint?.signature === expectedFaceSignature,
      { label: "authority appearance and painted face", timeoutMs: 20000 },
    );
    const actorId = world.playerActorId ?? world.authorityPlayer?.id ?? characterId;
    s.assert(typeof actorId === "string" && actorId.length > 0, `no player actor id after enter (${JSON.stringify(world.authorityPlayer)})`);
    const worn = new Map(world.authorityPlayer.worn.map((piece) => [piece.item, piece.colors]));
    s.assert(worn.size === EXPECTED_WORN.length, `authority worn count ${worn.size} != ${EXPECTED_WORN.length}: ${JSON.stringify(world.authorityPlayer.worn)}`);
    for (const expected of EXPECTED_WORN) {
      s.assert(worn.has(expected.item), `authority worn missing ${expected.item} (${JSON.stringify(world.authorityPlayer.worn)})`);
      for (const [index, color] of expected.colors.entries()) {
        s.assert(worn.get(expected.item)?.[index] === color, `authority ${expected.item} color[${index}] ${worn.get(expected.item)?.[index]} != ${color}`);
      }
    }
    s.assert(world.authorityPlayer.appearance?.hair === "hair_banded_mohawk", "authority hair drifted");
    s.assert(JSON.stringify(world.authorityPlayer.appearance?.face ?? null) === JSON.stringify(expectedFace),
      `authority face drifted: ${JSON.stringify(world.authorityPlayer.appearance?.face ?? null)}`);
    s.assert(world.localFacePaint?.ready === true && world.localFacePaint?.signature === expectedFaceSignature,
      `world face paint did not finish: ${JSON.stringify(world.localFacePaint)}`);
    ctx.note(`authority worn: ${JSON.stringify(world.authorityPlayer.worn)}`);
    await ctx.delay(600); // pawn attach + palette settle
    await ctx.moneyShot("01-spawned-fixed-issue");

    const craftWindowClosed = await s.evalExpr(
      "document.querySelector('.sc3d-window[data-window=\"craft\"]')?.hidden === true",
    );
    s.assert(craftWindowClosed === true, "craft window opened without this character requesting it");

    // ── STARTER TRUTH: exactly two fixed clothing rows, no profession gear ─
    const expectedClothingIds = [...CLOTHING_EQUIPMENT_BY_ITEM_ID.keys()];
    const expectedColorByItem = new Map([
      [9_900_001, ["#89cff0"]],
      [7_319, ["#303030", "#808080"]],
    ]);
    const doctrine = await s.waitProbeCall(
      () => s.oracle(),
      (o) => {
        const actor = o?.actors?.[actorId];
        const ownedRows = (o?.inventory ?? []).filter((row) => String(row.container).startsWith(actorId));
        return actor
          && actor.credits === DOCTRINE_STARTING_CREDITS
          && actor.skillPointsUsed === 16
          && actor.skillPointsCap === 250
          && actor.weapon == null
          && ownedRows.length === 2
          && ownedRows.filter((row) => expectedClothingIds.includes(Number(row.itemId))).length === 2;
      },
      { label: "fixed clothing rows and no profession gear in oracle", timeoutMs: 12000 },
    );
    const actor = doctrine.actors[actorId];
    const ownedRows = (doctrine.inventory ?? []).filter((row) => String(row.container).startsWith(actorId));
    s.assert(actor.credits === DOCTRINE_STARTING_CREDITS, `credits ${actor.credits} != ${DOCTRINE_STARTING_CREDITS}`);
    s.assert(actor.skillPointsUsed === 16 && actor.skillPointsCap === 250, `starter SP ${actor.skillPointsUsed}/${actor.skillPointsCap} != 16/250`);
    s.assert(actor.weapon == null, `fixed creator unexpectedly has a weapon: ${JSON.stringify(actor.weapon)}`);
    s.assert(ownedRows.length === 2, `starter inventory row count ${ownedRows.length} != 2: ${JSON.stringify(ownedRows)}`);
    for (const row of ownedRows) {
      const expected = expectedColorByItem.get(Number(row.itemId));
      s.assert(expected && row.equipped === true && row.quantity === 1, `starter clothing row not equipped/quantity-one: ${JSON.stringify(row)}`);
      s.assert(JSON.stringify(row.colors ?? []) === JSON.stringify(expected), `starter clothing colors drifted: ${JSON.stringify(row)}`);
    }

    await openDockWindow(s, "inventory");
    await ctx.delay(600);
    const rows = await s.evalExpr(
      "[...document.querySelectorAll('.inv-slot')].map((slot) => ({ key: slot.dataset.key ?? '', itemId: Number(slot.dataset.itemId ?? 0), title: (slot.querySelector('.inv-slot-title')?.textContent ?? '').trim(), equipped: slot.hasAttribute('data-equipped') }))",
    );
    s.assert(rows.length === 2, `inventory UI row count ${rows.length} != 2: ${JSON.stringify(rows)}`);
    s.assert(rows.every((row) => expectedClothingIds.includes(row.itemId) && row.equipped), `inventory UI fixed clothing rows drifted: ${JSON.stringify(rows)}`);
    s.assert(!rows.some((row) => Number.isFinite(row.itemId) && !expectedClothingIds.includes(row.itemId)), `inventory UI exposed profession gear: ${JSON.stringify(rows)}`);
    ctx.note(`starter clothing UI rows: ${JSON.stringify(rows)}`);
    for (const [itemId, equipmentId] of CLOTHING_EQUIPMENT_BY_ITEM_ID) {
      const initial = await waitEquipmentContract(s, actorId, itemId, equipmentId, true);
      ctx.note(`${equipmentId} initial full contract -> ${JSON.stringify(initial)}`);
    }

    await ctx.moneyShot("03-inventory-clothing");
    await s.slash("/ui inventory");

    // ── RELOG: store persistence + roster doll ──────────────────────────
    const url = page.url();
    await s.goto(url);
    await s.waitFn(
      "!!window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.characterCount >= 1",
      { timeoutMs: 20000, label: "roster after relog" },
    );
    // Read-only char-doll render readiness (data-chardoll-ready) — not gameplay truth.
    // Blank stage cannot satisfy this; rebuild clears it until one painted dollRoot frame.
    await s.waitFn(
      "document.querySelector('[data-chardoll-ready=\"true\"]') !== null",
      { timeoutMs: 20000, label: "roster doll first rendered frame" },
    );
    // Tiny compositor settle for the screenshot API after the ready edge.
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await ctx.moneyShot("02-relog-roster");

    // Server record truth: GET /game/characters carries the fixed worn set.
    const records = await s.evalExpr(`fetch("${s.gameUrl}/game/characters").then((r) => r.json())`);
    const record = records.characters.find((candidate) => candidate.name === "WardrobeProof");
    s.assert(!!record, "record missing after relog");
    s.assert(JSON.stringify(record.worn ?? []) === JSON.stringify(EXPECTED_WORN), `record fixed worn palette drifted: ${JSON.stringify(record.worn ?? [])}`);
    s.assert(JSON.stringify(wireFace(record.appearance?.face ?? null)) === JSON.stringify(expectedFace),
      `record face drifted after relog: ${JSON.stringify(record.appearance?.face ?? null)}`);
    await s.enterWorld(characterId);
    let relogProbe;
    try {
      relogProbe = await s.waitProbe(
        (p) => {
          const player = p?.authorityPlayer;
          if (!player) return false;
          if (player.weapon != null) return false;
          if (player.skillPointsUsed !== 16) return false;
          if (JSON.stringify(player.appearance?.face ?? null) !== JSON.stringify(expectedFace)) return false;
          if (p.localFacePaint?.ready !== true || p.localFacePaint?.signature !== expectedFaceSignature) return false;
          if (JSON.stringify(player.worn ?? []) !== JSON.stringify(EXPECTED_WORN)) return false;
          const wornColors = player.wornColors ?? {};
          for (const piece of EXPECTED_WORN) {
            const actualColors = wornColors[piece.item];
            if (JSON.stringify(actualColors ?? []) !== JSON.stringify(piece.colors)) return false;
          }
          return true;
        },
        { label: "relog streamed authority actor state", timeoutMs: 20000 },
      );
    } catch (error) {
      const failed = await s.probe();
      const player = failed?.authorityPlayer ?? null;
      ctx.note(`relog authorityPlayer diagnostic -> ${JSON.stringify({
        playerActorId: failed?.playerActorId ?? null,
        authorityActorKeys: failed?.authorityActorKeys ?? null,
        serverStatus: failed?.serverStatus ?? null,
        localFacePaint: failed?.localFacePaint ?? null,
        authorityPlayer: player && {
          weapon: player.weapon ?? null,
          face: player.appearance?.face ?? null,
          skillPointsUsed: player.skillPointsUsed ?? null,
          skillPointsCap: player.skillPointsCap ?? null,
          worn: player.worn ?? null,
          wornColors: player.wornColors ?? null,
          linkDead: player.linkDead ?? null,
        },
      })}`);
      throw error;
    }

    const relogOracle = await s.waitProbeCall(
      () => s.oracle(),
      (o) => {
        const rowsNow = (o?.inventory ?? []).filter((row) => String(row.container).startsWith(actorId));
        return rowsNow.length === 2
          && rowsNow.every((row) => {
            const expectedColors = expectedColorByItem.get(Number(row.itemId));
            return expectedColors
              && row.equipped === true
              && row.quantity === 1
              && JSON.stringify(row.colors ?? []) === JSON.stringify(expectedColors);
          });
      },
      { label: "relog authority inventory rows", timeoutMs: 20000 },
    );

    const relogActor = relogProbe.authorityPlayer;
    const relogAuthorityRows = (relogOracle?.inventory ?? [])
      .filter((row) => String(row.container).startsWith(actorId));

    s.assert(
      JSON.stringify(relogActor?.worn ?? []) === JSON.stringify(EXPECTED_WORN),
      `relog authority worn palette drifted: ${JSON.stringify(relogActor?.worn ?? [])}`,
    );
    s.assert(relogAuthorityRows.length === 2, `relog authority clothing row count ${relogAuthorityRows.length} != 2`);
    for (const row of relogAuthorityRows) {
      const expectedColors = expectedColorByItem.get(Number(row.itemId));
      s.assert(expectedColors && row.equipped === true && row.quantity === 1, `relog authority clothing row drifted: ${JSON.stringify(row)}`);
      s.assert(JSON.stringify(row.colors ?? []) === JSON.stringify(expectedColors), `relog authority clothing palette drifted: ${JSON.stringify(row)}`);
    }
    await openDockWindow(s, "inventory");
    const relogRows = await s.evalExpr(
      "[...document.querySelectorAll('.inv-slot')].map((slot) => ({ itemId: Number(slot.dataset.itemId ?? 0), equipped: slot.hasAttribute('data-equipped') }))",
    );
    s.assert(relogRows.length === 2, `relog inventory duplicated rows: ${JSON.stringify(relogRows)}`);
    s.assert(relogRows.every((row) => expectedClothingIds.includes(row.itemId) && row.equipped), `relog clothing equipped state drifted: ${JSON.stringify(relogRows)}`);
    for (const [itemId, equipmentId] of CLOTHING_EQUIPMENT_BY_ITEM_ID) {
      const relogged = await waitEquipmentContract(s, actorId, itemId, equipmentId, true);
      ctx.note(`${equipmentId} relog full contract -> ${JSON.stringify(relogged)}`);
    }
    await s.slash("/ui inventory");

    // ── DELETE: pressure valve (two-step armed confirm) on a throwaway ──
    const created = await s.evalExpr(`fetch("${s.gameUrl}/game/characters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Throwaway", appearance: { skinTone: "#96684a", hair: null, hairMat: "hair_raven", face: null }, initialProfessionId: "marksman" }),
    }).then((r) => r.json())`);
    s.assert(created.id, "throwaway create failed");
    await s.goto(url);
    await s.waitFn(
      "!!window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.characterCount >= 2",
      { timeoutMs: 20000, label: "roster shows throwaway" },
    );
    await page.click(`.sc3d-cs-row[data-character-id="${created.id}"]`);
    const deleteSel = '[data-ref="deleteButton"]:not([disabled])';
    await page.waitForSelector(deleteSel, { timeout: 10000 });
    await page.click(deleteSel); // arm
    const armed = await s.evalExpr('document.querySelector(\'[data-ref="deleteButton"]\').hasAttribute("data-armed")');
    s.assert(armed === true, "delete did not arm on first press");
    await page.click(deleteSel); // confirm
    await s.waitFn(
      "window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.characterCount === 1",
      { timeoutMs: 15000, label: "record struck" },
    );
    ctx.note("delete: armed confirm struck Throwaway; WardrobeProof intact");
  },
};
