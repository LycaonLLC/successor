# Resource and Crafting Foundation

Status: current authority and client foundation as of 2026-07-15.

Rust owns resource identity, sampling and extraction results, ingredient
consumption, crafted variants, inventory mutation, farming, creature harvest,
and progression checks. The 3D and terminal clients submit intent and present
the resulting state.

## Connected loops

The repository contains authority and client footing for:

- taking a universal hand sample, then using trained survey tools to map a
  selected resource family's concentration and properties;
- placing, fueling, monitoring, and collecting personal extractors;
- processing raw resources into derived materials;
- crafting through tools, schematics, ingredient slots, experimentation, and
  quality-bearing item variants;
- growing crops from seeds through staged plots, harvesting produce, processing
  ingredients, and preparing food;
- harvesting creature materials, sampling genes, scanning genomes, and using a
  splice workbench;
- carrying, stacking, transferring, trading, equipping, consuming, and
  examining the resulting items.

These loops are implemented to different depths. A recipe row, model, or UI
window is cataloged content until a normal player path reaches it in the
generated world.

## Resource identity

A resource stack is identified by `(item_id, variant_id)`. The item id selects
the family; the variant identifies an exact resource generation and its
properties. Two stacks with different variants do not merge simply because
they share a display name.

Current raw and processed resource ids are:

| Id | Resource |
| ---: | --- |
| 2001 | Iron |
| 2002 | Petrochemical |
| 2003 | Flora |
| 2004 | Gas |
| 2005 | Liquid |
| 2006 | Clodpowder |
| 2007 | Copper |
| 2008 | Carbon |
| 2009 | Fuel |
| 2010 | Polymer |
| 2101 | Creature Hide |
| 2102 | Clodmeat |
| 2103 | Clodbone |
| 2104 | Creature Tissue |

Resource properties are deterministic authority data. The active property set
includes the mechanical, chemical, organic, and extraction traits used by
recipes and quality calculations. Recipe code must request only the properties
that affect that recipe.

The current generator keeps a resource generation stable for a bounded world
cycle. Processing an exact input variant preserves a deterministic relationship
to that source rather than rolling an unrelated identity.

## Survey and extraction

Basic point sampling is a universal verb: any living player can kneel and work
a small sample loose at their current position without a profession or survey
tool. It is the bootstrap route into raw-resource play. A trained Craftsman who
owns the matching category survey tool can instead map the local heat field;
this full survey reveals where richer deposits lie. Placing a personal
extractor is also trained Craftsman work, consumes the matching category
extractor item, and continues the authority loop at a persistent world
location with its declared power or fuel inputs.

Hand sampling does not create Craftsman progression for an untrained player.
If the sampler has learned Craftsman, the same action can advance that
profession's survey track. In the 3D client, both resource toolbar actions
open the shared family picker: `TAKE SAMPLE` remains available without a tool,
while the richer `SURVEY` action stays locked until the matching survey tool is
carried (with the profession gate still enforced by authority).

Current field tools include:

| Id | Tool |
| ---: | --- |
| 3001 | Field Multitool |
| 3004 | Scout processing kit |
| 3006 | Personal mineral sampler |
| 3007 | Camp Kit |
| 3008 | Mineral survey tool |
| 3009 | Chemical survey device |
| 3010 | Gas survey tool |
| 3011 | Water survey tool |
| 3012 | Personal chemical extractor |
| 3013 | Personal gas harvester |
| 3014 | Survival moisture vaporator |

Numeric ids are the persistence contract. Current display names may change
without reallocating stored inventory identity.

## Crafting

Crafting is an authority transaction:

1. The client selects a tool or station and a known schematic.
2. The player assigns exact inventory variants to ingredient slots.
3. Rust validates profession, certification, location, quantity, and item
   availability.
4. Reservations aggregate by full stack identity. Rust validates the complete
   assignment before it consumes each stack once.
5. Assembly consumes the reserved stock atomically and records the
   resource-weighted cap and current normalized property value.
6. Experimentation spends one or more points. Material malleability shapes the
   chance, every point after the first subtracts 50 milli chance, and an attempt
   can raise or lower the value without crossing zero or the cap.
7. Finalization either creates a prototype, completes Practice with no item, or
   records a limited-use drafted schematic. All three clear the session.

The bridge gives each shard a private 32-byte craft-roll key. Actor ids, recipe
ids, ticks, and prior receipts are not enough to predict the next roll. A
persistent shard atomically publishes the key beside its checkpoint as a
mode-0600 `.craft-roll-key` sidecar, reuses it for bridge and process restarts,
and includes it in a full-domain migration backup. The key is neither projected
to clients nor stored in Rust craft snapshots.

Prototype names are optional. Empty input uses the canonical recipe name;
nonempty input is normalized and limited to 48 safe characters. Named outputs
with the same item and variant remain separate stacks when their names differ.
Practice consumes the assembled stock, creates no item or schematic, and
raises total base assembly XP to rounded 105%. Drafted schematics record a
maximum of 1 to 1000 uses. They do not imply a factory loop; factory
manufacturing is not implemented.

Crafted stats are encoded in the output variant when an item can differ by
quality. Combat and equipment systems read those authoritative stats from the
owned item; a client preview cannot change them.

### Public behavior cross-check

The July 2026 pass checked behavior against SWGEmu Core3 commit
`6856f315a80b5250635b2272695caec1d64204ed` without copying its implementation
code. The reference confirmed assembly inputs and tool modifiers in
[`CraftingManagerImplementation.cpp`](https://github.com/swgemu/Core3/blob/6856f315a80b5250635b2272695caec1d64204ed/MMO%43oreORB/src/server/zone/managers/crafting/CraftingManagerImplementation.cpp),
weighted resource reachability in
[`ResourceLabratory.cpp`](https://github.com/swgemu/Core3/blob/6856f315a80b5250635b2272695caec1d64204ed/MMO%43oreORB/src/server/zone/managers/crafting/labratories/ResourceLabratory.cpp),
batch-sensitive experimentation in
[`SharedLabratory.cpp`](https://github.com/swgemu/Core3/blob/6856f315a80b5250635b2272695caec1d64204ed/MMO%43oreORB/src/server/zone/managers/crafting/labratories/SharedLabratory.cpp),
ascending and descending property mapping in
[`CraftingValues.cpp`](https://github.com/swgemu/Core3/blob/6856f315a80b5250635b2272695caec1d64204ed/MMO%43oreORB/src/server/zone/objects/manufactureschematic/craftingvalues/CraftingValues.cpp),
and custom-name, Practice, and bounded-use schematic behavior in
[`CraftingSessionImplementation.cpp`](https://github.com/swgemu/Core3/blob/6856f315a80b5250635b2272695caec1d64204ed/MMO%43oreORB/src/server/zone/objects/player/sessions/crafting/CraftingSessionImplementation.cpp).

Important current product ids include:

| Range or id | Content |
| ---: | --- |
| 1001..1009 | Medical supplies and state treatments |
| 1101..1103 | Iron, Shard, and Spike Slugs |
| 1201..1204 | Medical components |
| 3007 | Camp Kit |
| 3101 | Crafted Slugthrower Mk I |
| 3103 | Vibrosword |
| 3104 | Plasma Sword |
| 3105..3107 | Scrapline Machete, Field Saber, and Quarry Chopper |
| 3111 | STEN Mk II |
| 3112 | Kiln Energy Cell Carbine |
| 3121 | Lightning Carbine |
| 3201 | Extractor Battery |
| 5002..5003 | Looted and drafted schematics |
| 7203 | Field Cap |
| 9002 | Credit Chip, a physical voucher redeemable into wallet credits |

Credits are the only monetary denomination. The Rust-owned scalar actor wallet
funds training, trade offers, parcel claims, upkeep, banking, and organization
fees. A fresh character starts with 5,000 credits. Credit Chips remain physical,
lootable, and tradeable inventory objects, but redeem into that same wallet;
they are not a second currency. Item 9001 is retired. Authority load migration
folds character-owned legacy 9001 value into wallet credits and converts loose
legacy value into Credit Chips so an upgrade does not destroy stored value.

The provisional weapon recipe ladder separates assembly skill from wielding
certification. Craftsman Novice and Assembly I make the primitive Field Saber
and Quarry Chopper. Assembly III and IV make the Kiln and Lightning carbines.
Rust still applies the Brawler or Marksman certification when the output is
equipped.

The exact recipes, quantities, caps, stat weights, and certification
requirements live in the Rust content tables and tests. This document does not
duplicate balance constants that are likely to change.

The basic Camp Kit is an intentional bootstrap recipe: Novice Scout can
assemble one by hand from 24 bone and 36 hide through the same slotted crafting
UI as other recipes. A carried raw-resource stack exposes `OPEN CRAFTING`, so
this hands-craftable route does not depend on owning a Field Multitool.
Placement also requires Novice Scout and consumes the kit,
creating a shelter in the game world. The camp persists while its owner remains
nearby. After the owner leaves, it collapses only once they have been away for
more than ten minutes; later Scout campcraft boxes retain their shelter-radius
and abandonment-grace bonuses. The older single-command `CraftItem camp_kit`
route remains as compatibility, not as the primary UI path.

## Farming, food, and bioengineering

The current content ranges are:

| Range or id | Content |
| ---: | --- |
| 6001..6009 | Seed cassettes |
| 6101..6109 | Harvested crops |
| 6201..6208 | Gene-lab tools and reagents |
| 6301 | Irrigation sprinkler |
| 6310..6312 | Growth, quality, and yield amendments |
| 6313..6324 | Density, savor, nutrient, and batch additives |
| 6401..6415 | Processed ingredients |
| 6501..6520 | Prepared foods and drinks |

Crop state, irrigation, additives, growth, quality, yield, harvest, and food
effects are authority-owned. The 3D client has authored crop-stage, produce,
seed, additive, ingredient, food, and laboratory models. Asset presence is not
proof that every recipe and placement path is complete.

Creature harvesting uses the same generic material and inventory contracts for
current Gaia wildlife. Species-specific genetics can affect derived variants,
but the resource families remain shared content rather than a separate combat
or fixture system.

## Inventory presentation

The graphical client renders inventory items as 3D turntables. It contains
procedural container families for raw resources and ammunition plus GLBs for
promoted tools, equipment, crops, food, and laboratory items. Fifteen generated
filled silhouettes mark resource-container families, while 18 generated SVG
silhouettes identify craft-purpose inputs; semantic color plates remain a
secondary cue rather than the only identifier.

The terminal client renders the same ids, quantities, variants, equipment, and
craft outcomes as text. Renderer-neutral item copy and rules belong in
`client/`; model loading and Three.js previews belong in `client-3d/`.

## Stack and transaction rules

- Stack caps are authority data and may differ by item family.
- Reservations prevent the same quantity from being spent by overlapping
  trades or crafting sessions.
- Craft completion consumes exact reserved inputs and creates one authoritative
  output transaction.
- Transfer, trade, loot, craft, consume, and equip operations must leave a
  deterministic inventory result suitable for persistence and replay.
- Physical currency items and account-side balances are distinct contracts.

## Source locations

- Authority and content tables: `crates/successor-sim/src/authority.rs` and
  `crates/successor-sim/src/authority/`
- Wire commands: `crates/successor-net/`
- Shared inventory and crafting projection: `client/src/slice-core/`
- 3D inventory, crafting, farming, survey, and splice UI: `client-3d/src/ui/`
- Terminal commands and panes: `client-tui/src/`
- Item and crop models: `client-3d/public/assets/items/`

## Verification

Use focused Rust and client tests while editing a subsystem, then run the
repository gates from `docs/VERIFICATION.md`. End-to-end resource proof should
start from the generated open-desert world and a normal player command path.
Debug grants may prepare a focused fixture, but they are not evidence that the
player acquisition loop is finished.
