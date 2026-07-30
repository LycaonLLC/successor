// Journey registry — ordered. The runner executes runnable journeys under a
// worker pool; skip-marked journeys are reported honestly with a reason.
import creation from "./creation.mjs";
import mapInput from "./map-input.mjs";
import startZone from "./start-zone.mjs";
import movement from "./movement.mjs";
import melee from "./melee.mjs";
import unarmed from "./unarmed.mjs";
import ranged from "./ranged.mjs";
import inventoryEquip from "./inventory-equip.mjs";
import inventoryModels from "./inventory-models.mjs";
import revive from "./revive.mjs";
import certification from "./certification.mjs";
import carbineProgression from "./carbine-progression.mjs";
import scoutSprint from "./scout-sprint.mjs";
import windows from "./windows.mjs";
import macros from "./macros.mjs";
import survey from "./survey.mjs";
import extractor from "./extractor.mjs";
import trainer from "./trainer.mjs";
import starterTools from "./starter-tools.mjs";
import travel from "./travel.mjs";
import exchange from "./exchange.mjs";
import craft from "./craft.mjs";
import weaponCraft from "./weapon-craft.mjs";
import medicCraft from "./medic-craft.mjs";
import loot from "./loot.mjs";
import lootDrops from "./loot-drops.mjs";
import creditChip from "./credit-chip.mjs";
import group from "./group.mjs";
import trade from "./trade.mjs";
import duel from "./duel.mjs";
import bankCloneCorpse from "./bank-clone-corpse.mjs";
import deathblow from "./deathblow.mjs";
import footlocker from "./footlocker.mjs";
import bankProximity from "./bank-proximity.mjs";
import associationTerminal from "./association-terminal.mjs";
import commerceInterior from "./commerce-interior.mjs";
import camp from "./camp.mjs";
import farm from "./farm.mjs";
import splice from "./splice.mjs";
import hairHelmet from "./hair-helmet.mjs";
import wearablePersistence from "./wearable-persistence.mjs";
import harvestCorpse from "./harvest-corpse.mjs";

export const journeys = [
  mapInput,
  creation,
  startZone,
  movement,
  melee,
  unarmed,
  ranged,
  inventoryEquip,
  inventoryModels,
  revive,
  certification,
  carbineProgression,
  scoutSprint,
  windows,
  hairHelmet,
  survey,
  extractor,
  trainer,
  starterTools,
  travel,
  exchange,
  craft,
  weaponCraft,
  medicCraft,
  loot,
  lootDrops,
  creditChip,
  group,
  trade,
  duel,
  bankCloneCorpse,
  bankProximity,
  associationTerminal,
  commerceInterior,
  deathblow,
  footlocker,
  camp,
  farm,
  splice,
  macros,
  wearablePersistence,
  harvestCorpse,
];
