import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// First-session legibility contract on the COMMITTED open-desert slice:
// exactly one trainer remains a short breadcrumb walk from spawn. Starter
// caches were removed; encounter footlockers are remote durable loot.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const slicePath = path.join(__dirname, "../../client/public/successor-slice/open-desert-slice.json");
const slice = JSON.parse(readFileSync(slicePath, "utf8"));

const TRAINER_MIN_WALK_CELLS = 4;
const TRAINER_WALK_CELLS = 12;

const player = slice.actors.find((actor) => actor.role === "player");
const playerWeaponPresentations = [
  [3101, "Slugthrower"],
  [3103, "Vibrosword"],
  [3104, "Plasma Sword"],
  [3105, "Scrapline Machete"],
  [3106, "Field Saber"],
  [3107, "Quarry Chopper"],
  [3111, "STEN Mk II"],
  [3112, "Kiln Energy Cell Carbine"],
  [3121, "Lightning Carbine"],
  [3122, "Badge Bolt Pistol"],
  [3123, "Slagrail Vanguard"],
  [3124, "Coilgate Scatter"],
  [3125, "Kiln Long Pattern"],
  [3126, "Bastion LMG"],
  [3127, "Flare Net Launcher"],
];

describe("open-desert first-session legibility", () => {
  test("player spawns in the camp area", () => {
    assert.ok(player, "slice has a player actor");
    assert.strictEqual(player.areaId, "open-desert-overworld");
  });

  test("exactly one starter trainer stands a real short walk from spawn", () => {
    const trainers = slice.actors.filter((actor) => actor.areaId === player.areaId && actor.role === "profession_trainer");
    assert.strictEqual(trainers.length, 1, "one unambiguous breadcrumb target");
    const trainer = trainers[0];
    const distance = Math.hypot(trainer.cell.x - player.cell.x, trainer.cell.y - player.cell.y);
    assert.ok(distance <= TRAINER_WALK_CELLS);
    assert.ok(distance >= TRAINER_MIN_WALK_CELLS);
    assert.ok((trainer.professionIds ?? []).length > 0);
  });

  test("starter cache clutter and inventory are absent", () => {
    const bannedIds = [
      "open-desert-cache-01",
      "open-desert-cache-02",
      "open-desert-cache-03",
      "open-desert-camp-fallen-block",
      "open-desert-camp-road-barrier",
      "open-desert-camp-plinth",
      "open-desert-camp-brick",
      "open-desert-camp-brick-shard",
    ];
    assert.deepStrictEqual(slice.props.filter((prop) => bannedIds.includes(prop.id)), []);
    assert.deepStrictEqual(slice.inventory.filter((row) => row.container.startsWith("cache:")), []);
  });

  test("player owns exactly one row for every concrete weapon presentation", () => {
    const playerWeapons = slice.inventory
      .filter((row) => row.container === "player:field-pack" && row.itemId >= 3101 && row.itemId <= 3127)
      .map((row) => [row.itemId, row.item, row.variantId, row.quantity, row.reserved, row.available]);
    assert.strictEqual(playerWeapons.length, playerWeaponPresentations.length);
    assert.deepStrictEqual(
      playerWeapons,
      playerWeaponPresentations.map(([itemId, item]) => [itemId, item, 0, 1, 0, 1]),
    );
  });

  test("GR0K stays a social presence, never a role-bearing authority", () => {
    const grok = slice.actors.find((actor) => actor.id === "grok");
    assert.ok(grok, "GR0K present in the camp");
    assert.strictEqual(grok.role, "scripted_player");
    assert.deepStrictEqual(grok.professionIds ?? [], [], "GR0K teaches nothing");
  });
});
