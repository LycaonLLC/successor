# Successor — Agriculture + Farming World: Staged Architecture Blueprint

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner directive 2026-07-08 ("go buck wild, kill earlier sandbox design or any other game at the
implementation"). Author: **AgricultureLead** (farming-world systems architect).
Coordinated with **BioEngineerLead** (genetics/seed/economy) over the joint
**seed→soil contract** (§A.4). Read-only scout of `crates/successor-sim/src/authority/{model,economy,extractors,crafting,tick_lifecycle,snapshots,state}.rs`,
`crates/successor-sim/src/{lib,command_manifest}.rs`, `client/src/slice-core/worldClockSystem.ts`,
`client-3d/public/assets/world-items/house_h1_*.json`, `tools/successor/configure-open-desert-fixture.mjs`,
`docs/{CANONICAL_CONTEXT,RESOURCE_CRAFTING_FOUNDATION,ASSET_PIPELINE}.md`, and the
sibling historical extraction/crafting research. This is decision-ready
staging, not FE code — the farming FE is Main's/Fable's to build; §E is the
data/command contract it consumes.

> **Prime directive (owner):** a REAL simulated farming game **on par with
> Stardew Valley** — charming FE + gameplay aesthetic — inside Successor's
> deterministic fixed-tick Rust authority (no wall-clock, replay-locked). Player
> housing is the **MINI-MAYOR** model (NOT earlier sandbox design player-cities): a character buys a
> parcel and claims a grid square; **ONE lot per planet per character**. Farming
> is its own gameplay loop that integrates with the crafting-menu paradigm where
> it fits.
>
> **Method directive (owner, inherited from the extraction blueprint):** "make
> sure we do all our math right, think from first principles." Every rate/size
> number in §C is derived, worked, degenerate-tested, and unit-testable.

---

## 0. Foundation truths that shaped every decision (verified anchors)

| # | Truth | Anchor | Consequence |
|---|---|---|---|
| T1 | `house_h1` footprint = **5×4 = 20 cells**; mesh 4.6×3.8 m; interior clear 2.35 m; door clear 1.06×2.04 m at cell `[4,3]`; front `+Z` | `client-3d/public/assets/world-items/house_h1_manifest.json` (`footprint_cells`, `interior_clear_height_m`, `door_cells`); `house_h1_collision.json` (`footprint.spanX/spanZ`) | Parcel sizing is **derived** from a measured build unit, not guessed. |
| T2 | House placed into a **5×4 cell rect**, uniform scale ≈1.05 → **1 cell ≈ 1 m** | `tools/successor/configure-open-desert-fixture.mjs:626` (`cellSize {w:5,h:4}`) + `structureCollisionFromSidecar` scale math | Lot dims translate cleanly to metres; "32×32 lot" ≈ 32 m homestead. |
| T3 | Seasons **already exist**: worldClock calendar = **6 months × 30 days = 180-day year** (First Cycle, Second Cycle, Third Cycle, Fourth Cycle, Fifth Cycle, Sixth Cycle); `monthIndex`/`dayOfMonth`/`dayIndex` are **pure fns of tick** | `client/src/slice-core/worldClockSystem.ts` (`WorldClockCalendar.months`, `worldClockStateAtTick`, `calendarDateForDay`) | Seasonal crop mechanics need **ZERO new clock state** — read season off the authority tick. |
| T4 | Weather = `AuthorityWeatherHazard{center,radius,dps}` with an **`AuthorityWeatherShelterBox` exemption** — an actor inside a shelter box takes no weather damage | `crates/successor-sim/src/authority/tick_lifecycle.rs:380 tick_weather_hazards`; exemption `authority/tests.rs:9259`; hazards fed from shard `authority_bridge.rs:738 weather_hazards` | The **greenhouse is a free primitive**: a shelter box over a plot ⇒ storm-proof crops. |
| T5 | Placed, owner-gated, container/rect entities are a **proven stored pattern** | `LootCacheAuthorityState` BTreeMap (`snapshots.rs:50`); `AuthorityStockpileZoneState{zone_id,area_id,x,y,…}` (`model.rs:4429`); `owner_actor_id`/`allowed_actor_ids` (`model.rs:3265`); all join `write_stable_hash` (`snapshots.rs:870-892`) | A **parcel is a new stored rectangle entity** (BTreeMap, owner-keyed, hashed) — a sibling of stockpile-zone/allowed-area. |
| T6 | Authoring **rectangle-claim commands already ship**: `SetStockpileZone`, `SetAllowedArea`, `PlaceBlueprint` (owner + area + `x,y,w,h` + filters) | `command_manifest.rs:1182/1202/1212` | `ClaimParcel` reuses this exact rectangle-authoring shape. |
| T7 | The **extractor** is a landed sibling with a **lazy closed-form** accrual doctrine (store constants + `placed_at_tick`, derive the hopper on access; no per-tick loop) | `authority/extractors.rs`; `PlacedExtractorState` (`model.rs:492`); `placed_extractors`/`next_extractor_id` (`authority.rs:711`) | **Crop growth reuses lazy closed-form** — settle a tile on access/event, never per-tick. |
| T8 | Commands are **manifest-driven** (`successor.commands.manifest.v1`, drift-gated by SP0) and support **durable intents** that auto-repeat server-side and break on movement/posture/area/death | `command_manifest.rs` (`CommandSpec`, `DurableIntent`); `SampleResource` 30 s loop (`:819-827`) | New farming verbs register in the manifest; the **tending loop is a durable intent** (the `SampleResource` precedent). |
| T9 | A `u32 variant_id` packs only ~3 stats at 0–999 (Slugthrower 81M, medical 41M, battery 32M encodings) | `authority.rs:369 EXTRACTOR_BATTERY_VARIANT_BASE`; `crafting.rs` variant encode/decode | A full crop genome **cannot** fit a variant_id → the seed carries a **genome handle** + registry (§A.4, co-designed with BioEngineerLead). |
| T10 | **Planets and cities exist** as first-class ids (travel system) | `command_manifest.rs:942 BuyTravelTicket{to_planet_id,to_city_id}` | "One lot **per planet** per character" keys cleanly to an existing id space. |
| T11 | 12-attribute `ResourceStats` (0–1000 milli) + `(item_id,variant_id)` exact identity + `100000` stack caps + scalar authority credit wallet | `docs/RESOURCE_CRAFTING_FOUNDATION.md`; item ids `authority.rs:366-368` (battery 3201, looted-schem 5002, drafted-schem 5003) | Produce/soil quality reuse the milli/variant discipline; **credits are the land sink**. |
| T12 | Movement: walk `1.357` cells/s, sprint `6.525` cells/s; actors never block actors; open-desert collision currently OFF (cover cosmetic) | `docs/CANONICAL_CONTEXT.md` (movement tuning) | A 32-cell lot ≈ 24 s walk / 5 s sprint to cross — a homestead, not a trek. |

### The replay/hash reality (inherited from the extraction blueprint, verified)

`stable_state_hash_hex()` = `write_stable_hash` over **stored** state only
(`snapshots.rs`). Derived registries (resource spawns, world-clock date, weather
hazards fed as input) are **NOT** hashed. `verification/golden-replays/` is empty
— there are **no committed golden hex hashes to regenerate**. The "ceremony" for
any wave that adds **stored** state is therefore mechanical, not hex-editing:

1. Add the new field to `write_stable_hash` (omission breaks determinism/desync gates — that *is* the test).
2. Keep it deterministic: `BTreeMap`/sorted iteration, tick math only, **no wall-clock, no HashMap order, native == wasm32**.
3. Update **relational** tests that count things (`SnapshotDeltaBundle` section count, registry-length asserts, "command X leaves hash unchanged" lists).
4. Re-run `cargo test --workspace` + the wasm determinism audit + `pnpm --dir client verify:resource-crafting-foundation`.

Pure functions and derived data (season lookup, growth math, blight field) do
**not** touch the hash → cheaper waves. Parcels, tiles, and crop records **do**
(they are stored) → they pay the ceremony.

---

## Time-model ruling — crops anchor to GAME-DAYS (refines F1)

`GAME_DAY_SECONDS=300` (`worldClockSystem.ts` default, dev) is a **presentation
knob**: dev day = 5 real minutes for fast visual QA. Two anchors are possible and
the choice is **not** the same as the extractor's:

- The **extractor** anchors to **real seconds** (`EXTRACTOR_FULL_FILL_SECONDS = 86_400`) because an idle harvester is valued in **AFK real time**.
- **Crops anchor to GAME-DAYS**, because the Stardew charm *is* the seasonal
  calendar: a "4-day crop" must fit inside a game-month/season on the shared
  worldClock, and "plant in Second Cycle, harvest before Third Cycle" must mean
  something. Growth is still **closed-form in ticks** (deterministic,
  offline-safe) — it just converts game-days → ticks via `ticksPerGameDay(config)`
  rather than using a raw real-second constant.

```text
TICK_RATE_HZ            = 30
ticksPerGameDay(config) = tickRateHz * realSecondsPerGameDay   // dev: 30*300 = 9_000 ticks/game-day
GROWTH is measured in game-days, stored/derived in ticks, PRESENTED in game-days.
```

**Single owner tuning knob (flagged, §H F-Time):** `realSecondsPerGameDay` sets
the entire farming cadence. Dev `300 s` makes a game-day = 5 real min (a 4-day
crop = 20 real min — good for QA, brutal for offline MMO play). A production value
of **~3600–7200 s (1–2 real hrs/game-day)** makes a 4-day crop ≈ 4–8 real hours
and a 30-day season ≈ 1.5–2.5 real weeks — the MMO rhythm this design assumes.
This is one number; every §C relationship holds when it changes.

---

## A. Data model

Everything below is **stored state** (joins `write_stable_hash`) unless marked
*derived*. All quality/rate values are **milli ∈ [0,1000]** (1000 = 100.0%),
matching the codebase's milli discipline. All maps are `BTreeMap`/sorted for
deterministic hashing.

### A.1 The parcel — a claimed rectangle entity (owner req: mini-mayor, 1/planet/char)

New stored state on `SliceAuthorityState`, a sibling of `placed_extractors` /
`ammo_stockpiles` / stockpile zones:

```rust
parcels: BTreeMap<String, ParcelAuthorityState>,   // key = parcel id; deterministic
next_parcel_id: u64,                               // sequential mint (next_extractor_id pattern)
```
```rust
pub(super) struct ParcelAuthorityState {
    id: String,                       // "parcel:{planet}:{seq}" — deterministic mint
    owner_character_id: String,       // DURABLE owner (survives sessions/logout/deletion) — NOT the transient actor id
    planet_id: String,                // 1-per-(owner_character_id, planet_id) enforced at claim
    area_id: String,                  // overworld area the rect lives in
    name: String,                     // owner label ("Dune Hollow Farm")
    rect: AuthorityRect,              // {x, y, w, h} in cells — the claimed grid square
    tier: ParcelTier,                 // Homestead | Farmstead | Plantation (§C.0 dims)
    build_zone: AuthorityRect,        // sub-rect reserved for house-class structures (4× house_h1)
    farm_yard: AuthorityRect,         // sub-rect where tilling/planting is legal
    claimed_tick: u64,
    upkeep_paid_through_tick: u64,    // §H F5: lapse PAUSES the farm, never confiscates
    rained_through_tick: u64,         // set on rain onset over area (§C.2 lazy moisture)
    tiles: BTreeMap<CellKey, TileAuthorityState>,       // ONLY tilled/planted cells; untilled = absent
    structures: BTreeMap<String, FarmStructureState>,   // planter/sprinkler/greenhouse/plot-stake
}
enum ParcelTier { Homestead, Farmstead, Plantation }
```

- **1-per-planet-per-char** (owner LAW): `ClaimParcel` rejects if any parcel has
  `owner_character_id == claimant && planet_id == planet` (`ParcelAlreadyOwnedOnPlanet`).
  The claimant is the **character id** from the session ticket, not the runtime
  actor id — land is durable across sessions.
- **Actor→character resolution:** gating (`is_parcel_owner`) needs the acting
  actor's character. Add `character_id: Option<String>` to `ActorAuthorityState`,
  set at spawn from the session ticket (the identity chain already binds
  character→actor; `docs/CANONICAL_CONTEXT.md` Identity Chain). Small honest
  addition — flagged in §Appendix. Fallback: shard-side gate if the field is
  deferred, but Rust-side gate is the deterministic choice.
- **Greenhouse shelter:** a placed greenhouse `FarmStructureState` contributes an
  `AuthorityWeatherShelterBox` (T4) covering its footprint, so storms skip crops
  under it — **zero new weather code**.

### A.2 Tiles — the farm substrate (sparse, lazy)

```rust
pub(super) struct TileAuthorityState {
    tilled: bool,                     // hoe made it plantable
    moisture_milli: u16,             // 0..1000; decays, refilled by water/rain/sprinkler
    fertilizer: Option<FertilizerApplied>,   // {kind, variant_id} — pre/anytime per §C.4
    crop: Option<CropAuthorityState>,
    last_settle_tick: u64,           // last tick moisture+growth were advanced (lazy settle anchor)
}
enum TileStage /*derived, NOT stored*/ { Untilled, TilledDry, TilledWet, Sown, Growing(u8 /*stage*/), Mature, Dormant }
```

Tiles are stored **only** when non-default (tilled or cropped). An untilled cell
is simply absent from `parcel.tiles`. The player-visible `TileStage` is **derived
on access** by `settle_tile` (§C.1) — never stored, never per-tick.

### A.3 Crop record — cached agronomic profile (closed-form growth, T7 doctrine)

```rust
pub(super) struct CropAuthorityState {
    seed_item_id: u32,                // 6_0xx species (BioEngineerLead's band)
    seed_variant_id: u32,             // genome HANDLE (T9; §A.4) — for produce/child lineage + display
    planted_tick: u64,
    profile: AgronomicProfile,        // CACHED at PlantSeed via project_agronomic() — the ONLY thing growth reads
    accumulated_growth_ticks: u64,    // progress toward maturity; advanced by settle_tile
    drought_ticks: u64,               // consecutive dry ticks toward dormancy (reset on water/rain)
    blight: BlightState,              // None | Infected { since_tick } (§C.6)
    harvests_remaining: u16,          // regrowth counter (§C / profile.regrowth_days); 0 after last harvest
    tending_quality_milli: u16,       // running tending score → produce/seed quality (§C.4)
}
enum BlightState { None, Infected { since_tick: u64 } }
```

This is **exactly `PlacedExtractorState`'s shape**: store constants
(`seed_*`, `profile`) + an accrual clock (`planted_tick`, `accumulated_growth_ticks`)
and derive the rest closed-form. The hot path (growth tick / snapshot encode)
reads **only** the cached `profile` — zero genome registry access, zero cross-system
call. The cold path (`PlantSeed`) pays one `project_agronomic()` read.

### A.4 The seed→soil contract (JOINT — byte-identical shared block)

*Mirrored verbatim from `docs/future/bioengineer-and-crop-engineering.md` §0. This is the sole
interface between the two lanes; neither lead may change it unilaterally (ratified
2026-07-08 over IRC). BioEngineerLead owns what a seed IS; AgricultureLead owns how
it grows.*

> This section is the sole interface between Bio-Engineer (what a seed IS) and Agriculture (how it grows). Both leads ratified it over IRC on 2026-07-08. Neither side may change it unilaterally.

#### S0.1 What a seed is on the wire
A seed is an ordinary inventory item: `(seed_item_id, variant_id, quantity)`, stacking by `(item_id, variant_id)` like every other stack (`successor-net/src/lib.rs:85-88`).
- `seed_item_id` = **crop species** (one id per species; band §0.5).
- `variant_id` = a **genome handle**: a server-assigned, sequential, content-deduped `u32`. Identical genomes intern to the same handle, so identical seeds STACK; different genomes never merge (same rule as resource identity, `RESOURCE_CRAFTING_FOUNDATION.md` "Resource stat identity is exact by (item_id, variant_id)").

#### S0.2 Why the handle is NOT the packed phenotype (forced by u32)
The growth-relevant phenotype is ~10 fields (below), most at full milli precision (`0..1000` ≈ 10 bits each) — roughly **100 bits** of state, versus a 32-bit `u32`. The repo's variant-packing convention packs only ~3 fields at 2-digit precision: `encode_slugthrower_variant = 31_000_000 + power×10^6 + handling×10^3 + reliability`, each `0..100` (`model.rs:3631`). **10 milli-fields cannot be pure-fn-decoded from one u32.** Therefore the full genome lives in a server-side **`CropGenomeRegistry`** side-table (Postgres durable, Redis hot), keyed by the handle. Bio-Engineer owns it; Agriculture never reads it.

#### S0.3 The `AgronomicProfile` (the only thing growth reads)
Bio-Engineer exposes one pure projection function. Agriculture calls it **once at `PlantSeed`** and caches the result on the crop record — exactly how `ExtractorState` stores `resource_variant_id`/`tool_variant_id` as constants and accrues its hopper closed-form (`model.rs:427-437`). The growth tick loop then reads only the cached struct: zero registry, zero genome, closed-form (honors the lazy-hopper doctrine and the canon "derive once, cache effective stats" rule).

```
fn project_agronomic(genome: &Genome) -> AgronomicProfile   // BIO-ENGINEER owns; pure/deterministic

struct AgronomicProfile {           // all milli 0..1000 unless noted
    growth_days_base:      u16,     // GAME-days to maturity, ideal conditions; Agri converts days->ticks via ticksPerGameDay(config)
    water_need_milli:      u16,     // thirst / day depletion rate
    yield_base:            u32,     // harvest quantity (units)
    hardiness_milli:       u16,     // neglect grace + wither resistance
    season_affinity:       u8,      // bitmask of favourable seasons
    off_season_penalty_milli: u16,  // penalty when grown off-affinity
    storm_resistance_milli:   u16,  // weather-v2 integration
    blight_resistance_milli:  u16,  // deterministic pest/blight events
    regrowth_days:         u16,     // 0 = single-harvest; >0 = perennial re-fruit interval (GAME-days; Agri converts)
    tile_footprint:        u8,      // 1 = 1x1; packed NxM for giant crops
    quality_potential_milli:  u16,  // CAPS harvested produce quality (feeds economy + crafting)
}
```

#### S0.4 The round trip (who computes what)
```
PLANT:   player plants (seed_item_id, variant_id).
         Agriculture resolves handle -> genome (one cold-path registry read),
         calls project_agronomic(genome), stores AgronomicProfile + planted_tick on the crop.
GROW:    Agriculture ticks growth closed-form from (planted_tick, AgronomicProfile, deterministic
         weather + player tending). Accumulates a single tending_quality_milli (0..1000) =
         how consistently watered / fertile / storm- & blight-spared.  [Agriculture owns entirely.]
HARVEST: Agriculture mints PRODUCE itself = quality is min(quality_potential_milli, f(tending_quality_milli)).
         For child seeds it calls:
           fn mint_harvest_seed(parent_variant_id, tending_quality_milli, ctx_seed)
               -> Option<{ seed_variant_id, qty }>   // BIO-ENGINEER owns
         None  => sterile / gene-locked (no propagation).
         Some  => default: a TRUE-BREEDING child = same handle (stacks); qty scaled by tending.
                  (A skill-gated "field selection" technique may nudge the child within a bounded,
                  deterministic envelope; base farming never gambles the genome.)
```
Genes never cross into soil; soil never crosses into genes. The only values on the wire are the `AgronomicProfile` (down at plant), one `tending_quality_milli` scalar (up at harvest), and the seed handle (down at harvest). The cached `AgronomicProfile` is part of stored crop state and joins the crop's `write_stable_hash`.

#### S0.5 Item-id band (co-owned `6_xxx`; `5_0xx` is the schematic lane, `authority.rs:367-368`)
| Band | Owner | Contents |
|---|---|---|
| `6_0xx` | Bio-Engineer | **seeds** — one `item_id` per species, `variant_id` = genome handle |
| `6_1xx` | Agriculture | **produce** — one per species, `variant_id` = quality-encoded |
| `6_2xx` | Bio-Engineer | bio tools & reagents (Gene Sampler, Splicer, Scanner, culture medium, mutagen, stabilizer, serum, gene-lock kit) |
| `6_3xx` | Agriculture | farm placeables/structures (plot-stake, planter, sprinkler, greenhouse) |

Genome registry keyed by the handle. The scalar authority credit wallet remains
separate from seed inventory identity.

*(End §0 — shared block.)*

### A.5 Item-id + recipe consts (AgricultureLead side)

```rust
// placeables / structures (6_3xx) — crafted deployables, stack cap 1 unless noted
const PLOT_STAKE_ITEM_ID: u32       = 6_300;   // the claim/deed marker (doubles as scarecrow — crow-guard flavor)
const IRRIGATION_SPRINKLER_ITEM_ID: u32 = 6_301;   // auto-water radius (offline autonomy; Stardew sprinkler analog)
const GREENHOUSE_KIT_ITEM_ID: u32   = 6_302;   // craftable structure → contributes an AuthorityWeatherShelterBox (T4)
const PLANTER_BOX_ITEM_ID: u32      = 6_303;   // decorative/portable single-tile planter
// produce band (6_1xx) — one id per produce family, variant = quality band
const PRODUCE_ID_BASE: u32          = 6_100;
// recipes (session path or one-shot; §B) mirror CRAFT_* consts in authority.rs
```

Greenhouse is a **craftable collab recipe** (owner ruling 2026-07-08):
Craftsman structural inputs + BioEngineerLead bio inputs → `GREENHOUSE_KIT_ITEM_ID`.
Detailed in §E.5 asset manifest.

### A.6 New reject reasons (each gets a player-language map per DESIGN.md "no dev copy", §E.6)

`ParcelAlreadyOwnedOnPlanet, NotInHousingRegion, ParcelOverlap, TooCloseToPoi,
TooCloseToRoad, NotParcelOwner, OutsideFarmYard, TileNotTilled, TileAlreadyTilled,
TileOccupied, TileEmpty, WrongSeason, CropNotMature, CropDormant, NoWaterAction,
SeedNotOwned, StructureFootprintBlocked, UpkeepNotDue`.

---

## B. Command / protocol surface

Each new command lands in the **same four mechanical layers** the extractor/craft
verbs use, plus the SP0 manifest (drift-gated):

```text
successor-net ClientCommand enum + wire  →  server protocol.ts Zod
  →  rustAuthorityBridge commandKind + shard.ts accept/reject maps
  →  client authorityCommandSystem AuthorityClientCommand union + enqueue*
  +  command_manifest.rs CommandSpec (verb, args, reason_codes, durable_intent)  [SP0 drift gate]
```

Manifest registration means every farming verb **auto-derives** its slash command,
query surface, and macro/driver binding through the landed SP1 verb layer + SP2
macro engine + SP5 headless driver — a bot can `till`/`plant`/`water`/`harvest`
the moment the manifest row exists.

### B.1 Land commands (mini-mayor claim flow)

| Command | Payload | Handler (economy.rs sibling, e.g. `land.rs`) | Notes |
|---|---|---|---|
| `ClaimParcel` | `{ planet_id, area_id, x, y, tier }` | `apply_claim_parcel` | Validates housing-region (F7), 1-per-planet-per-char, **spends credits** (land sink). **LAND WAVE:** origin **lattice-snapped** (8-cell quantum; receipt reports requested→snapped); overlap is exact **lattice-cell** (DIRECT ADJACENCY legal, no forced gap); POI/road + **central no-claim** are lattice-aligned exclusion zones. Mints parcel + `build_zone` + `farm_yard`. **durable_intent: `placed_parcel`**. Auto-waypoint for owner. |
| `RenameParcel` | `{ parcel_id, name }` | `apply_rename_parcel` | Owner-only cosmetic. |
| `PayUpkeep` | `{ parcel_id }` | `apply_pay_upkeep` | Owner-only; spends credits, extends `upkeep_paid_through_tick`. §H F5: lapse ⇒ farm pauses, never confiscation. |
| `AbandonParcel` | `{ parcel_id }` | `apply_abandon_parcel` | Owner-only; releases the claim + tiles/crops, returns placed **structure** items (crops lost — you chose to leave). Frees the 1/planet slot. |

Claim purchase point (owner req: "purchase from where? credits sink"): a **Land
Registry terminal** prop in each city (sibling of the travel terminal / mission
terminal). Interacting opens the claim UI; the terminal validates region + funds
and emits `ClaimParcel`. This keeps land buying a **town-return loop** and a clean
credits sink.

### B.2 Farm-loop commands (all: owner + inside `farm_yard` + point-blank adjacency)

| Command | Payload | Durable intent | Behavior |
|---|---|---|---|
| `TillTile` | `{ parcel_id, cell }` | — | Hoe verb; creates `TileAuthorityState{tilled:true}`. Rejects outside yard / already tilled. |
| `PlantSeed` | `{ parcel_id, cell, container, stack_id, variant_id }` | — | Consumes 1 seed; **calls `project_agronomic()` (cold path)**; creates `CropAuthorityState` with cached profile. Rejects if not tilled / occupied / (fork F-Season: wrong season). |
| `WaterTile` | `{ parcel_id, cell }` | — | Settles tile (§C.1), sets `moisture_milli=1000`, resets `drought_ticks`. Discrete single-tile verb. |
| `TendPlot` | `{ parcel_id, stop }` | **`plot_tending`** | **The charm escape-valve.** Durable auto-repeat (the `SampleResource` precedent): while set + kneeling + in-parcel, waters dry tiles + pulls weeds on a cadence; breaks on move/stand/area/death/`stop=true`. Bulk "tend my farm" without per-tile clicking. |
| `Fertilize` | `{ parcel_id, cell, container, stack_id, variant_id }` | — | Applies one `FertilizerApplied` (quality/speed/yield line, §C.4). One kind per tile. |
| `HarvestCrop` | `{ parcel_id, cell }` | — | Requires `Mature`. Mints **produce** (§C.4) + optional **child seeds** (`mint_harvest_seed`); if `regrowth_days>0 && harvests_remaining>0` resets to a growing stage, else clears crop → `TilledDry`. |
| `TreatBlight` | `{ parcel_id, cell, container, stack_id, variant_id }` | — | Consumes a BioEngineerLead blight tonic (6_2xx) → clears `BlightState::Infected` (§C.6). |
| `ClearTile` | `{ parcel_id, cell }` | — | Scythe verb; removes crop/dormant/weeds → `TilledDry`. |

`TendPlot` is deliberately a durable intent, not a per-tile macro: it keeps the
loop **charming** (one action tends the plot) while remaining server-authoritative
and macro/driver-scriptable.

### B.3 Structure commands (reuse the placeable/blueprint pattern, T5/T6)

| Command | Payload | Behavior |
|---|---|---|
| `PlaceFarmStructure` | `{ parcel_id, structure_item_id, cell }` | Owner + inside parcel + clear footprint. Consumes the 6_3xx item; mints `FarmStructureState`. A **greenhouse** additionally registers an `AuthorityWeatherShelterBox` over its footprint (T4). A **sprinkler** registers an auto-water radius (§C.2). |
| `RemoveFarmStructure` | `{ parcel_id, structure_id }` | Owner-only; returns the item, drops any shelter/sprinkler effect. |

### B.4 Server→client channels (mirror `surveyResult` / `craftSession` / `placedExtractors`)

- **`parcels` AOI section** (nearby render + coarse crop stage + boundary + owner
  flag) — a new `SnapshotDeltaBundle` section (bump the count, ceremony).
- **`farmPlot` owner-detail channel** (drained per frame like
  `serverAuthority.surveyResults`) — per-tile detail (stage, moisture, blight,
  time-to-mature) for the owner's open farming HUD. Session-targeted, owner-only.
- Reject codes flow through the existing shard reject map with §E.6 player copy.

---

## C. The math (first principles, worked, degenerate, unit-tested)

Units: **milli** everywhere (1000 = 100%). Growth is tracked in
**milli-game-days**; time is ticks; season/rain are read from the world clock and
weather input. The settle function runs **per-game-day, lazily on access** (T7) —
never per-tick, and O(1) in the active case (0–1 elapsed days).

### C.0 Parcel dimensions — derived from `house_h1` (T1/T2), 3 tiers (F6 ratified)

`house_h1` = **5×4 = 20 cells** (T1). Owner: "house footprint ~4× a house_h1-class
build + a YARD sized for farming." Each lot is a **lattice-aligned square claim**
(origin on the 8-cell quantum; tier dims 16/24/32 = 2/3/4 quantum — perfect tiling)
with a 1-cell **internal no-build ring** (a walk corridor between adjacent builds,
NOT an overlap gap — adjacency is legal), a **build zone** sized to hold its
house-class count, and a **farm yard** (the tillable Stardew surface).

| Tier (house class) | Lot | Setback | Interior | Build zone | Holds | Farm yard (tillable) | Cross time (walk/sprint) |
|---|---|---|---|---|---|---|---|
| **Homestead** (h1) | 16×16 = 256 | 1-cell ring | 14×14 | ~6×8 = 48 | 1× house_h1 (20) | ~12×12 = **144** | 12 s / 2.5 s |
| **Farmstead** (h2) | 24×24 = 576 | 1-cell ring | 22×22 | ~9×9 = 81 | 2× house_h1 (40) | ~18×16 = **288** | 18 s / 4 s |
| **Plantation** (h3) | 32×32 = 1024 | 1-cell ring | 30×30 | 10×10 = 100 | 4× house_h1 (80) ✓ owner "4×" | ~24×20 = **480** | 24 s / 5 s |

Build-zone ≥ house count checks: 48≥20, 81≥40, 100≥80 — all hold with circulation
to spare. Cross times from T12 (walk 1.357, sprint 6.525 cells/s): a lot feels like
a homestead, not a trek.

**World-density sanity (1024×1024 overworld = 1,048,576 cells):** a fully packed
planet holds ≤ ~1024 Plantations or ~4096 Homesteads; after POI/road/terrain
exclusion, realistically ~300–1500 lots/planet. With **1/planet/char** + multiple
planets (T10), that scales to a real population and makes prime land **scarce** —
which is exactly what powers the credits land sink (§F/§G).

### C.1 Growth — per-game-day lazy settle (deterministic, offline-safe)

```
ticksPerGameDay      = tickRateHz * realSecondsPerGameDay            // T-model
maturity_milli_days  = growth_days_base * 1000
stage (0..NUM_VISUAL_STAGES-1) = min(N-1, accumulated_growth_days_milli * N / maturity_milli_days)   // N=5
```

`settle_tile(parcel, tile, now)` advances the tile from `tile.last_settle_tick`
across each whole game-day boundary in `(last_settle_tick, now]`. Per game-day `d`:

```
season_factor = in_season(profile.season_affinity, month_of(d)) ? 1000 : off_season_penalty_milli
watered = sprinkler_covers(tile) || moisture_milli > MOISTURE_GROWTH_THRESHOLD || rain_covers(parcel, d)
if watered && !blight_halted:
    accumulated_growth_days_milli += 1000 * season_factor / 1000        // capped at maturity
    drought_days = 0
    tending_quality_milli += (season_factor==1000 ? TENDING_GOOD_DAY_DELTA : 0)   // clamp 0..1000
else:
    drought_days += 1
    tending_quality_milli = sat_sub(tending_quality_milli, TENDING_BAD_DAY_DELTA)
    if drought_days >= wither_grace_days(profile.hardiness_milli): stage := Dormant   // RECOVERABLE (F5)
moisture_milli = (sprinkler||rain(d)) ? 1000 : sat_sub(moisture_milli, decay_per_day(profile.water_need_milli))
```

The loop is bounded by elapsed whole days (usually 0–1 for an active farmer; a
bounded integer loop for offline catch-up). It is **pure integer math over the
authority tick + stored tile state** → deterministic, native == wasm32, and
identical on replay. `last_settle_tick` advances to the last whole day boundary
(sub-day remainder preserved). Settle is called on: water, plant, harvest, rain
onset, storm onset, `TendPlot` cadence, and **snapshot-encode for the owner's open
HUD** — nowhere else.

Constants:
```
MOISTURE_FULL_MILLI              = 1000
MOISTURE_DECAY_BASE_PER_GAME_DAY = 1000     // decay_per_day = BASE * water_need_milli / 1000
MOISTURE_GROWTH_THRESHOLD_MILLI  = 0        // any moisture > 0 counts as "watered today"
NUM_VISUAL_STAGES                = 5        // sprout → seedling → growing → budding → mature
WITHER_GRACE_BASE_DAYS           = 2
WITHER_GRACE_MAX_EXTRA_DAYS      = 6        // wither_grace_days = 2 + hardiness_milli*6/1000  → 2..8 dry days
```

### C.2 Watering / moisture — thirst, rain, sprinklers (offline reconciliation)

`decay_per_day = MOISTURE_DECAY_BASE_PER_GAME_DAY * water_need_milli / 1000`:

| water_need_milli | decay/day | watered runway from full | feel |
|---|---|---|---|
| 1000 | 1000 | **1 day** | thirsty staple — daily watering (Stardew classic) |
| 500 | 500 | **2 days** | forgiving |
| 250 | 250 | **4 days** | drought-tolerant / desert-adapted |

- **`WaterTile`** sets moisture = 1000 (resets drought). **Rain** (weather input)
  sets `parcel.rained_through_tick` = rain end → outdoor tiles count watered for
  that window (auto-water; no energy cost — Stardew rain). **Sprinklers**
  (`IRRIGATION_SPRINKLER_ITEM_ID`, tiered coverage below) hold covered tiles at
  full each day → **never dry → offline-safe farms** (the automation escape-valve).

| Sprinkler tier | Coverage | Craft gate |
|---|---|---|
| Basic | + shape (4 tiles) | Novice farm skill |
| Quality | 3×3 (8 tiles) | Mid farm skill |
| Deep | 5×5 (24 tiles) | High farm skill |

- **The MMO/offline reconciliation (charm-critical):** an always-on world means
  time passes while logged off. Three humane guards keep this charming, not
  punishing: (1) tune production `realSecondsPerGameDay` so a game-day ≈ 1–2 real
  hours (§T-model), (2) sprinklers + rain cover offline watering, (3) neglect
  **pauses** growth and goes **Dormant (recoverable forever)** per §C.3 — it never
  destroys the seed. Offline never loses your farm; at worst it loses *time*.

### C.3 Wither = recoverable dormancy (owner F5 philosophy, charm-first)

earlier sandbox design's decay-to-destruction was the anti-fun. Per owner F5 ("lapse ⇒ pause + weeds,
recoverable, never confiscation or item loss"), neglect **never kills a crop**:

```
drought > wither_grace_days  →  Dormant  (visual wilt/brown, growth halted)
Dormant + WaterTile          →  resume growth from the SAME accumulated progress (no seed loss)
```

Stakes come from **lost time + lost quality/yield** (tending_quality decays under
neglect, §C.4), never from lost items or land. Off-season default:
`off_season_penalty_milli` **slows** growth (e.g. 300 = 30% speed) rather than
killing — a `0` value makes it a hard seasonal pause (fork F-Season).

### C.4 Yield & quality — tending realizes the seed's genetic potential

```
produce_qty          = max(1, yield_base * (1000 + fertilizer_yield_bonus_milli) / 1000)
produce_quality_milli = min( quality_potential_milli,                       // genome sets the CEILING (BioEngineerLead)
                             quality_potential_milli * tending_quality_milli / 1000 )  // tending realizes it (AgricultureLead)
```
```
TENDING_START_MILLI     = 500
TENDING_GOOD_DAY_DELTA  = 60     // on-time watered, in-season, blight-free day
TENDING_BAD_DAY_DELTA   = 90     // dry / neglected / blighted day (bad bites harder than good heals)
```

Perfect tending (→1000) realizes the full genetic `quality_potential`; sloppy
tending wastes it. You can **never exceed** the seed's potential — that ceiling is
BioEngineerLead's breeding reward. Produce `variant_id` encodes the quality band
(medical-craft precedent). Fertilizer lines (§B.2 `Fertilize`): `speed`
(−growth_days), `quality` (+tending floor), `yield` (+qty) — one kind per tile,
Stardew-style.

Harvest also calls `mint_harvest_seed(parent_variant, tending_quality_milli, ctx)`
(§A.4): `None` = sterile; else stackable true-breeding child seeds, `qty` scaled by
tending — feeding BioEngineerLead's breeding loop.

### C.5 Storm damage & the greenhouse (reuses T4, zero new weather code)

A storm is a fed `AuthorityWeatherHazard` (T4). On **storm onset** over a parcel,
settle affected tiles and apply a one-time **setback** to outdoor crops
(deduped by storm id / `parcel.last_storm_tick`):

```
setback_milli_days = STORM_SETBACK_DAYS(=2) * 1000 * (1000 - storm_resistance_milli) / 1000
accumulated_growth_days_milli = sat_sub(accumulated_growth_days_milli, setback_milli_days)   // never below 0, never kills
```

A crop under a **greenhouse** (`GREENHOUSE_KIT` → `AuthorityWeatherShelterBox`, T4)
is **fully immune** (the shelter-box exemption already skips weather effects). The
setback effect is stored (hashed), driven by the deterministic hazard input — the
same pattern as actor `weather_damage_accumulated_milli`.

### C.6 Blight — deterministic seeded events (no RNG state)

Each planted tile, each game-day, rolls a **deterministic** blight chance:

```
seed  = hash("blight:{parcel_id}:{cell}:{day_index}")            // day_index = pure fn of tick (T3)
chance_milli = BLIGHT_BASE_CHANCE_MILLI_PER_DAY(=40) * (1000 - blight_resistance_milli) / 1000
if (seed % 1000) < chance_milli: crop.blight = Infected{since_tick}
```

`Infected` **halts growth** and **spreads** to an adjacent planted tile of the
**same species** each day (monoculture penalty → emergent **crop-rotation** depth,
and a reason to buy BioEngineerLead's resistant strains). `TreatBlight` (bio tonic,
6_2xx) clears it → resume. Uncured blight never destroys — it just costs time until
cured. Fully deterministic (seeded hash + world-clock day), replay-safe, no stored
RNG.

### C.7 Multi-tile crops (giant crops / trees)

`tile_footprint` packs W×H (`0x22` = 2×2). A multi-tile crop stores its
`CropAuthorityState` on an **anchor cell**; covered cells hold a lightweight
`OccupiedBy(anchor)` marker. `PlantSeed` rejects unless every footprint cell is
tilled + empty + inside the yard. Harvest/water/clear resolve through the anchor.
**Trees** are the permanent case: `regrowth_days > 0` with a high/renewing
`harvests_remaining` — plant once, harvest each cycle.

### C.8 Worked examples (dev config, ticksPerGameDay = 9000; values in game-days)

Crop "Grubroot": `growth_days_base=4, water_need=1000, hardiness=300 (grace≈4d),
season=Second Cycle, off_season_penalty=300, storm_res=200, blight_res=400,
regrowth_days=0, quality_potential=700`.

| # | Scenario | Outcome | Rule shown |
|---|---|---|---|
| 1 | Watered daily, in-season | mature day 4; quality = 700×(tending→~1000)/1000 = **700** | ideal realizes full potential ✓ |
| 2 | Skip watering day 2 (runway 1d) | day2 pauses → mature **day 5**; quality ~650 (one bad day) | skip = +1 day, not death (Stardew) ✓ |
| 3 | water_need=250, hardiness=800 (runway 4d, grace≈7d) | water once, ignore ~4d growing then ~7 dry days before Dormant | drought-tolerant genome ✓ |
| 4 | Planted off-season (penalty 300) | grows at 30% → ~13 days if watered; penalty 0 ⇒ pauses till its month | seasonal affinity ✓ (fork F-Season) |
| 5 | Storm onset, no greenhouse | −2×(1−0.2)=**1.6 game-days** knocked off; under greenhouse **0** | shelter-box immunity ✓ |
| 6 | Blight fires day 3, cured day 4 | halt 1 day, resume; uncured spreads to same-species neighbor | deterministic blight + rotation ✓ |
| 7 | Neglected 30 days offline | Dormant; one `WaterTile` on return resumes from saved progress | offline never destroys ✓ (F5) |

### C.9 Degenerate cases

1. **now ≤ last_settle_tick** → settle is a no-op (idempotent; double-settle safe).
2. **days_elapsed huge (long offline)** → bounded per-day loop; after moisture
   hits 0 and drought passes grace, the tail collapses to "Dormant, no further
   change" (recoverable on next water).
3. **quality_potential = 0** → produce still yields `qty` at quality 0 (a real but
   worthless crop) — never a divide-by-zero, never a null harvest.
4. **water_need = 0** → decay 0 → never dries (a cactus-tier genome); valid.
5. **off_season_penalty = 0 planted off-season** → 0 growth/day, never Dormant from
   season alone (season pause ≠ drought); resumes when its month returns.
6. **season crosses mid-growth** → settle evaluates season per game-day, so a crop
   planted late in-season correctly slows as it crosses into off-season.
7. **integer truncation** → all `*milli/1000` truncate toward zero, deterministic;
   worst-case < 1 milli-day/day drift (< 0.1% over a crop life).
8. **storm + greenhouse mid-storm removal** → shelter box is checked at storm-onset
   settle; removing the greenhouse after onset doesn't retroactively apply the
   dodged setback (matches actor shelter semantics).

### C.10 Suggested unit tests (Rust `#[test]`, mirroring extraction's relational style)

```
parcel_dims_derived_from_house_h1_hold_tier_invariants        // build_zone >= 4x house for Plantation
parcel_claim_second_on_same_planet_same_char_rejected         // 1/planet/char
parcel_claim_overlap_and_poi_buffer_rejected
growth_ideal_matures_in_growth_days_base                      // example #1
growth_skipped_water_day_delays_by_one_not_death              // example #2 (pause)
growth_drought_tolerant_genome_survives_runway_plus_grace     // example #3
growth_off_season_penalty_scales_rate                         // example #4
growth_off_season_zero_pauses_without_dormancy                // degenerate #5
wither_is_dormant_and_recoverable_never_seed_loss             // example #7 / F5
moisture_decay_matches_water_need_runway_table
storm_setback_scales_with_resistance_and_greenhouse_immunizes // example #5
blight_is_deterministic_and_resistance_lowers_chance          // seeded, replay twice == equal
blight_spreads_same_species_and_treat_clears
yield_quality_capped_by_potential_and_scaled_by_tending       // §C.4
settle_is_idempotent_and_deterministic                        // now<=last => no-op; run twice => equal hash
multi_tile_crop_requires_full_footprint_tilled
parcel_and_tile_state_participate_in_stable_hash              // assert_ne! on claim/plant (ceremony)
```

---

## D. Staged waves (each independently shippable + gateable)

Replay-class legend (from the extraction blueprint): **[client]** client-only ·
**[TS]** server plumbing · **[pure-fn]** new tested fns, no state · **[stored]**
adds stored state → joins `write_stable_hash`, pays the ceremony (add-to-hash +
determinism/participation re-gate + relational test edits; no hex to regenerate).

### W0 — Client/TS scaffolds (**TONIGHT**, zero Rust) `[client][TS]`
Farming-HUD view-model **mocks** against §E for Fable; claim/registry UI shell;
per-stage crop **model placeholders**; hoe/plant/water/harvest verb stubs routed
through the SP1 verb layer; §E.6 reason-copy map. Gate: `pnpm --dir client test` + `build` + visual.

### W1 — PARCEL claim (stored) `[stored][TS][client]`
`parcels: BTreeMap` + `ParcelAuthorityState` + `next_parcel_id`;
`ClaimParcel/AbandonParcel/RenameParcel/PayUpkeep`; **`parcels` AOI section**;
Land Registry terminal prop; 1/planet/char + region/overlap/POI/road buffers +
**credits sink**; `ActorAuthorityState.character_id` (durable owner resolution).
**Ceremony:** parcels join `write_stable_hash`; clear-on-nothing (parcels persist
through death); section count bump. Gate: `cargo test --workspace`,
`verify:resource-crafting-foundation`, LIVE claim→see-boundary→abandon proof chain
(command→receipt→Rust event→AOI→render, per VERIFICATION.md, disposable ports).

### W2 — TILES + till/plant/clear (stored) `[stored][TS]` — **dep: BioEngineerLead 6_0xx seeds + `project_agronomic`**
`TileAuthorityState` + `CropAuthorityState` (cached profile) on the parcel;
`TillTile/PlantSeed/ClearTile`; `PlantSeed` calls `project_agronomic()` (cold path,
caches profile). **Ceremony:** tiles/crops join the hash (nested BTreeMap, sorted).
Gate: `cargo test`, live till→plant→see-sprout. **Integration gate with
BioEngineerLead:** seed item ids resolve + `project_agronomic` returns a valid
profile (joint fixture).

### W3 — GROWTH + water (pure-fn + stored) `[pure-fn][stored][TS][client]`
`settle_tile` (§C.1) + all §C constants + `WaterTile` + **`TendPlot` durable
intent** + sprinkler structure + moisture/season/wither. §C.10 pure-fn tests land
here (they need no state). **Ceremony:** the settle *mutation* participates in the
hash; determinism/idempotence tests. Gate: `cargo test extractor_-style
growth_/moisture_/wither_ suite`, live plant→water→watch-stage-advance (fast dev
day).

### W4 — WEATHER / BLIGHT / fertilizer (pure-fn + stored) `[pure-fn][stored][client]`
Storm setback via fed hazard input (§C.5) + **greenhouse shelter-box** (T4) +
deterministic blight (§C.6) + `TreatBlight` + `Fertilize`. **Ceremony:** setback /
blight state join the hash (deterministic given hazard input, like actor weather
damage). Gate: storm-onset setback test, greenhouse-immunity test, blight
determinism (run twice == equal), live storm-over-open-plot vs under-greenhouse.

### W5 — HARVEST + produce/seed (stored) `[stored][client]` — **dep: BioEngineerLead `mint_harvest_seed` + genome registry**
`HarvestCrop` → produce mint (6_1xx, quality §C.4) + `mint_harvest_seed` (child
seeds) + regrowth reset. **Ceremony:** harvest mutation + produce inventory rows.
Gate: `cargo test`, live grow→harvest→produce-in-bag→child-seed proof.
**Integration gate with BioEngineerLead:** `mint_harvest_seed` round-trips a
stackable child seed; genome registry write/read.

### W6 — FE farming HUD + charm visuals (**client**) `[client]`
The full §E surface: verbs on radial/toolbar, tile targeting, per-stage GLB
visuals, farming/plot window, claim UI, CHARM palette/animation. Gate: live X11
owner-visible proof (grow-to-harvest journey, disposable ports per the integration
gate).

### W7 — PAWN LABOR (stored, **scope-cut, seams pre-built**)
A hired-hand pawn tends the plot through the generic authority job scheduler.
Seams already exist: `TendPlot` is
the primitive; a pawn work-policy row (`SetPawnWorkPolicy`, `command_manifest.rs:1172`)
targets "tend parcel P". W7 adds only the derive-farm-job path + a farmhand pawn
role. **Not planned into any earlier wave's todo.**

### Wave → replay-class matrix

| Wave | client | TS | pure-fn | stored (ceremony) | cross-lane dep |
|---|:--:|:--:|:--:|:--:|:--|
| W0 | ✔ | ✔ | | | — |
| W1 | ✔ | ✔ | | ✔ | — |
| W2 | | ✔ | | ✔ | BioEngineerLead seeds + project_agronomic |
| W3 | ✔ | ✔ | ✔ | ✔ | — |
| W4 | ✔ | | ✔ | ✔ | — |
| W5 | ✔ | | | ✔ | BioEngineerLead mint_harvest_seed + registry |
| W6 | ✔ | | | | (consumes W1–W5) |
| W7 (cut) | ✔ | ✔ | | ✔ | generic pawn jobs |

**Ship-tonight set: W0** (all client/TS scaffolds). **First Rust wave: W1** (parcel
stored-state — the foundation everything hangs on). W2/W5 sequence with
BioEngineerLead's seed lanes at their integration gates.

---

## E. FE surface spec + data contracts

Framed through the canonical UI rules (`docs/CANONICAL_CONTEXT.md`): windowed,
draggable/resizable HUD panels; **low-text, icon+meter driven** with hover-`i`
detail; single-cursor model (left-click target, right-click radial, double-click
default action); iso **locked camera + matcap + PS2 post**. FE is Main's/Fable's;
these are the contracts + the charm brief.

### E.1 Interaction model — the four farming verbs

Farming is **verb-on-tile**, integrated with the existing cursor/radial model:

- **Equip a farm tool** (hoe / watering can / scythe / seed pouch) to a toolbar
  slot (the landed 12-slot toolbar). The equipped tool sets the **active verb**.
- **Target a tile:** hover shows a tile highlight (tilled/wet/crop state readout in
  a compact tooltip). Left-click / double-click runs the active verb on that tile;
  right-click opens the tile **radial** (Till / Plant / Water / Fertilize / Harvest
  / Clear — only legal verbs enabled, per §A.6 reject reasons).
- **`TendPlot`** is a single "tend" action (toolbar or radial on your own plot):
  kneel + auto-water/weed the plot on a cadence until you move — the charm
  escape-valve, not per-tile clicking.
- **Claim flow:** interact with a **Land Registry terminal** in town → claim UI
  (map picker of eligible grid squares in housing regions, tier + price, confirm →
  `ClaimParcel`). Mirrors the mission/travel terminal pattern.

Verbs auto-derive slash (`/till /plant /water /harvest /tend`) + query
(`/plot <parcel>`) surfaces via the SP1 verb layer — free bot/driver play.

### E.2 Growth visuals per stage + the CHARM brief (for the Fable FE lane)

Crops are the **color POP** against Successor's desert/cyberpunk grays — this is
where the Stardew charm lives. All effects are **presentation-only**, driven by the
authoritative `stage`/`health`/`moisture`/`blight` from the `farmPlot` channel +
`parcels` AOI (canonical "FE derives from authority").

- **5 stage models per species** (sprout → seedling → growing → budding → mature),
  swapped by `stage` (§C.1). Each stage GLB reads silhouette-first (≤3 shapes) for
  the iso camera; **props color-only material rule** (ASSET_PIPELINE §5 — palette
  color slots, NEVER textures).
- **Juice:** squash-stretch **pop** on each stage advance (a satisfying "it grew!"
  beat); gentle idle **sway** (reuse the env WIND already in `client-3d`); mature
  crops get a subtle **bob + rim shimmer** so "ready to harvest" reads at a glance;
  **harvest** = particle burst + produce icon pops toward the bag + a pluck SFX
  (reuse the `inventory_transfer` sfx family).
- **Soil feedback:** tilled soil = darker furrowed decal; **watered** soil visibly
  **darkens/sheens** (instant read of "done"); fertilized soil gets a faint tint.
- **State reads:** Dormant/withered = wilt droop + desaturated brown (never a
  "dead" skull — it's recoverable); Blighted = sickly desat + drifting spore motes;
  greenhouse crops sit under a translucent shell.
- **Seasonal + day/night tint:** crops inherit the worldClock lighting (lush in
  Second Cycle, golden-dry in Third Cycle, pale in Sixth Cycle) via the existing env
  color grading — free seasonal atmosphere.
- **Palette north star:** warm earth browns + vivid saturated crop hues (greens,
  harvest golds, fruit reds/purples) as the deliberate chromatic relief from the
  gunmetal world. Charming, readable, unmistakably "the farm."

### E.3 Farming HUD / windows

- **Plot window** (owner, opens on your parcel): a compact **tile-grid overview**
  of the farm yard — each cell an icon showing stage + a moisture pip + blight
  flag; hover-`i` for time-to-mature/quality-so-far. Bulk actions (Tend, Water All
  visible). Windowed/draggable like inventory.
- **Claim/Registry UI:** map picker (eligible squares highlighted, buffers shown),
  tier cards (dims + price + yard size), confirm.
- **Tile tooltip:** on-hover micro-readout (state, moisture, crop + stage/ETA).
- All low-text, icon+meter, hover-detail — canonical UI discipline.

### E.4 View-model data contracts (Main's FE consumes; shapes are the contract)

```ts
interface ParcelVM {                    // parcels AOI section → boundary render + owner HUD
  parcelId: string; planetId: string; areaId: string; name: string;
  rect: { x: number; y: number; w: number; h: number };
  tier: "homestead" | "farmstead" | "plantation";
  buildZone: { x: number; y: number; w: number; h: number };
  farmYard: { x: number; y: number; w: number; h: number };
  isOwner: boolean;
  upkeepDueInGameDays: number | null;   // null = no upkeep model (fork F5 off)
}
interface FarmPlotVM {                   // farmPlot owner-detail channel (like surveyResult)
  parcelId: string; tiles: FarmTileVM[];
}
interface FarmTileVM {
  cellX: number; cellY: number; tilled: boolean; moisturePct: number;   // 0..100
  fertilizer: "none" | "speed" | "quality" | "yield";
  crop: FarmCropVM | null;
  legalVerbs: ("till"|"plant"|"water"|"fertilize"|"harvest"|"clear"|"treat")[];  // drives radial enable
}
interface FarmCropVM {
  seedItemId: number; species: string; stage: number; stageCount: number;       // 0..stageCount-1
  health: "vigorous" | "wilting" | "dormant"; blight: "none" | "infected";
  timeToMatureGameDays: number | null;   // null when mature
  qualitySoFarMilli: number;             // running tending realization (0..1000)
  footprint: { w: number; h: number };   // multi-tile anchor
}
interface ClaimOfferVM {                 // Land Registry UI
  planetId: string; tiers: { tier: string; lotCells: number; yardTiles: number; pricecredits: number; available: number }[];
  eligibleSquares: { x: number; y: number; tier: string }[];   // server-validated (region/overlap/buffers)
}
// commands: TillTile / PlantSeed{container,stackId,variantId} / WaterTile / TendPlot{stop}
//           Fertilize{...} / HarvestCrop / ClearTile / TreatBlight{...} / ClaimParcel{planetId,x,y,tier}
```

### E.5 Asset manifest + per-asset sourcing

Sourcing follows owner canon (**Fable hand-authors hero models; bulk = Gemini
-with-reference; Synty checked but VERIFIED for scale/interaction**) and the
`docs/ASSET_PIPELINE.md` lanes. **Two material rules apply** (verify the consumer
before authoring): held tools ride the **weapon path (keeps MAP/palette)**; crops,
props, and structures ride **`props.ts` (keeps COLOR only — NO textures)**. All
world GLBs: y=0 ground origin, instanced, iso silhouette budget (≤3 shapes), flat
-lit, provenance manifest per `ASSET_PROVENANCE_POLICY.md`, delivered as inbox
**handoff packets** (never direct edits to another session's files).

| Asset | Count | Pipeline lane | Sourcing recommendation | Material rule |
|---|---|---|---|---|
| **Farm tools** (hoe, watering can, scythe, seed pouch) | ~4 | held-item / weapon lane (`socket_hand.R`, `*_attach.json`) | **Hand-author (Fable)** — always on-screen in hand, animation-critical (the tool verbs read from the swing) | weapon path (palette map) |
| **Hero crop species** (signature 3–5) | 5×5 stages = 25 | prop / world-item (per stage GLB) | **Hand-author (Fable)** — sets the crop style register + the **recipe** the bulk lane follows | props color-only |
| **Bulk crop catalog** (dozens of species) | N×5 stages (100s) | prop / world-item | **Gemini-with-reference + procedural stalk lab** (run the hero recipe; Synty nature packs checked for ref, verified for scale) — the affordable variant-storm catalog play | props color-only |
| **Soil tiles** (untilled/tilled/watered/fertilized) | ~4–8 | texture / Surface-Fill terrain | **Procedural pack / gpt-image-2 flat** (tileable, flat-lit, post-floor-tested) | flat albedo |
| **Plot-stake / scarecrow** (deed marker = farm identity, doubles as crow-guard flavor) | 1 + tier tints | prop | **Hand-author (Fable)** — identity asset, the icon of "your farm" | props color-only |
| **Fences / gates / paths / decor** | ~8–12 | prop | **Synty checked + VERIFIED** (generic farm/nature kit) or Gemini-ref | props color-only |
| **Sprinkler** (3 tiers) | 3 | prop | **Gemini-ref** (small cyberpunk-industrial device; hand-author if it becomes hero) | props color-only |
| **Greenhouse kit** (walk-in, contributes shelter box) | 1 kit + tiers | **structure / building lane** (cutaway `HK_*` slots, footprint manifest, T4 shelter box) | **Hand-author kit (Fable)** — walk-in interior + the collab recipe surface | building color-only + translucent shell |
| **Planter box** (portable single-tile) | 1–2 | prop | **Gemini-ref** | props color-only |
| **Produce inventory icons** | N produce | inventory SVG silhouette (RESOURCE_CRAFTING_FOUNDATION icon direction) | **Procedural / omp-image flat**, bulk | inventory (lit) |
| **Land Registry terminal** | 1 | prop | **Gemini-ref** or reuse existing terminal art | props color-only |

**The scale play (how this "kills earlier sandbox design at implementation"):** hero species + the
per-stage stalk lab establish a **captured recipe** (`pawnforgev2/recipes/` ritual,
ASSET_PIPELINE §2.6); the bulk catalog is then generated by **cheaper models
turning recipe knobs** (species silhouette, palette, stage curve) against numeric
gates — a large, coherent crop catalog without hand-building each one. Crop GLBs
are tiny instanced props (frustum-culling disabled, cheap at density), so a big
farm of many plants stays performant.

### E.6 Reason-code → player-language map (samples; FE completes the set, "no dev copy")

`ParcelAlreadyOwnedOnPlanet`→"You already hold land on this planet." ·
`NotInHousingRegion`→"You can't stake a claim here." ·
`ParcelOverlap`→"That land is already claimed." ·
`TooCloseToPoi`/`TooCloseToRoad`→"Too close to the road/landmark to build." ·
`OutsideFarmYard`→"You can only farm inside your yard." ·
`TileNotTilled`→"Till the soil first." · `TileOccupied`→"Something's already
planted here." · `WrongSeason`→"This seed won't take root this season." ·
`CropNotMature`→"Not ready to harvest yet." · `CropDormant`→"This plant is parched
— water it to revive it." · `UpkeepNotDue`→"Your deed is paid up."

---

## F. Griefing, persistence, character deletion

**Griefing (mini-mayor = private lots, geometry-guarded):**
- **Adjacency (LAND WAVE — owner law):** plots MAY be DIRECTLY ADJACENT (share an
  exact edge) — the old forced walk-around GAP is gone. The 1-cell **internal
  no-build ring** (build_zone/farm_yard inset, §C.0) still leaves a 2-cell walk
  corridor between adjacent BUILDS. `ClaimParcel` rejects only true overlap (a shared
  lattice cell); the **global 8-cell lattice + no-deadzone audit** guarantee no
  unclaimable sliver can be griefed into existence. Truth doc:
  `docs/future/parcel-lattice-contract.md`.
- **View-blocking is a non-issue by construction:** the iso **locked camera +
  cutaway building doctrine** (ASSET_PIPELINE §5b) hides roofs and stubs
  camera-facing walls when you're inside a footprint — a neighbor's tall build
  cannot occlude your view the way free-camera MMOs suffer. Nothing to grief.
- **Private protection (F4 ratified):** only the owning **character** can
  till/plant/water/harvest/place inside their claim (`NotParcelOwner`). Actors
  never block actors (T12), so neighbors may walk through your lot but **cannot act
  on your tiles or trample crops** (pass-through is cosmetic).
- **POI/road buffers** (F7) keep claims off critical infrastructure and prevent the
  earlier sandbox design "housing line" wall by using **designated housing regions** rather than
  build-anywhere.

**Persistence:**
- **Rust authority** holds live parcel/tile/crop stored-state, covered by the
  landed **versioned export/import** persistence (B1 PersistRestore: "world
  survives bit-identical" across restart). Farms survive server restarts for free.
- **Postgres** is the durable mirror/ledger for land ownership rows
  (`owner_character_id, planet_id, area_id, rect, tier, claimed_tick,
  upkeep_paid_through_tick`) — it answers the 1/planet/char query, is the
  cross-session truth, and backs the registry. **Redis** holds claim locks +
  hot presence. (Canonical: Postgres owns character/inventory/ledgers → land is a
  durable character asset.) BioEngineerLead's `CropGenomeRegistry` sits beside it
  (Postgres durable / Redis hot).

**Character deletion:** on confirmed deletion (Postgres cascade), **release all
parcels** owned by that `owner_character_id` — clear the Rust stored-state + the
Postgres rows; freed land returns to the claimable pool (no ghost lots; land is
scarce). Seeds/produce in the deleted character's inventory follow normal
character-deletion inventory rules; unreferenced genome handles GC per
BioEngineerLead's registry. **Rec: immediate release** (fork F-Deletion: add a
short reclaim-grace only if the owner wants deletion-regret protection).

---

## G. Biome fertility → the market meta (owner addition)

Biomes already exist (desert/forest, `docs/CANONICAL_CONTEXT.md`), and fertility
is the lever that turns farming into a **regional economy**. A per-biome
`biome_fertility_milli` scales effective growth rate and inverts into effective
water need at settle time (deterministic, read from area/biome data): **forest/
plains are fertile** (faster growth, lower effective thirst, most species viable)
while **desert is poor** (slow, thirsty, few species thrive). This makes *where* you
stake a claim a strategic economic decision: fertile land is scarce and contested,
so its credits price runs hot and fertile-region farmers flood the market with
cheap staples; desert farmers, forced onto BioEngineerLead's **drought-adapted /
high-value genomes**, command premiums on specialty and rare crops that simply
can't be grown in bulk elsewhere. Land price tracks fertility, genetics unlock
marginal land, and geography creates trade — one loop binding land scarcity (§C.0),
the seed genome (§A.4), and the credits sink (§F). That geographic economic depth
is where Successor goes *past* earlier sandbox design, whose resources were weekly-procedural spawns
rather than land you improve. (Fork F-BiomeHarsh: desert penalty severity — rec:
meaningful niche, never unfarmable.)

---

## H. Open forks for the owner (defaults + ratification status)

| Fork | Options | Recommended default | Status |
|---|---|---|---|
| **F1 growth clock** | real-tick (extractor-style) vs **game-day-anchored** closed-form | Game-day-anchored, closed-form, presented in game-days (seasonal coherence) | **RATIFIED (Main)** |
| **F2 labor gate** | ArcheAge labor-points vs none | **None** — no labor currency; soft Action sip only (charm > chore) | **RATIFIED (Main)** |
| **F3 watering** | manual-only vs **moisture + tend-intent + craftable sprinkler** | Moisture decay + `TendPlot` durable intent + tiered sprinklers (offline-safe) | **RATIFIED (Main)** |
| **F4 theft/PvP** | open-world theft vs **private-protected lots** | Private lots fully protected; no trample/steal inside a claim | **RATIFIED (Main)** |
| **F6 lot tiers** | single size vs **3 tiers by house class** | Homestead 16² / Farmstead 24² / Plantation 32²; **1/planet/char regardless** | **RATIFIED (Main)** |
| **F7 placement** | build-anywhere vs **designated housing regions + biome fertility** | Owner-designated regions, biome-gated, POI/road/water buffers | **RATIFIED (Main)** |
| **F8 seed interface** | variant-pack vs **handle + registry** | Genome handle + registry; cached AgronomicProfile (§A.4) | **RATIFIED (Main + BioEngineerLead)** |
| **F5 land upkeep** | one-time buy vs **light periodic upkeep** | Light credits upkeep; **lapse ⇒ farm PAUSES + weeds, recoverable; NEVER confiscation or item loss** | **Main-ruled, PENDING OWNER** (does upkeep exist at all?) |
| **F-Time** | production `realSecondsPerGameDay` | ~3600–5400 s (1–1.5 real hr/game-day) so crops span real hours, seasons span real weeks | **PENDING OWNER** (one tuning number) |
| **F-Season** | off-season **slow** (penalty>0) vs **hard pause** (0) vs Stardew death | Slow (charm); allow hard seasonal gates per-species for strategy | **PENDING OWNER** |
| **F-Wither** | crops **never die** from neglect (Dormant forever) vs weeds-after-long-neglect (seed lost) | **Never die** — neglect costs time+quality, never the seed (max charm, F5-consistent) | **PENDING OWNER** |
| **F-Wild** | private-only vs **public/wild planting** (ArcheAge unprotected farms + theft/crime) | Private-only for v1; public farms as a later social/PvP fork | **PENDING OWNER** |
| **F-BiomeHarsh** | desert penalty severity | Meaningful niche, never unfarmable | **PENDING OWNER** |
| **F-Deletion** | immediate land release vs reclaim-grace | Immediate release (no ghost lots) | **PENDING OWNER** |
| **F-PawnLabor** | farmhands now vs later | Seams now (W7 pre-built), ship later | **PENDING OWNER** |

---

## Appendix — one-line change map (fast orientation for implementers)

- `authority.rs`: `+PLOT_STAKE_ITEM_ID(6300)`, `+IRRIGATION_SPRINKLER_ITEM_ID(6301)`,
  `+GREENHOUSE_KIT_ITEM_ID(6302)`, `+PLANTER_BOX_ITEM_ID(6303)`, `+PRODUCE_ID_BASE(6100)`,
  `+CRAFT_GREENHOUSE_*`/farm-recipe consts, all §C constants; `SliceAuthorityState
  +parcels +next_parcel_id`; `AuthorityRejectReason +` §A.6.
- `model.rs`: `+ParcelAuthorityState/ParcelTier/TileAuthorityState/CropAuthorityState/
  BlightState/FarmStructureState/FertilizerApplied`, `+AgronomicProfile` (joint,
  §A.4); `ActorAuthorityState +character_id`; `+settle_tile/decay_per_day/
  wither_grace_days/in_season/blight fns` (pure).
- `land.rs` (new): `+apply_claim/abandon/rename_parcel +apply_pay_upkeep` + region/
  overlap/POI/buffer validation + credits sink.
- `farming.rs` (new): `+apply_till/plant/water/tend/fertilize/harvest/clear/treat_blight`
  + `+apply_place/remove_farm_structure`; harvest calls BioEngineerLead's
  `mint_harvest_seed`; plant calls `project_agronomic`.
- `tick_lifecycle.rs`: `+tick_plot_tending()` (durable-intent cadence, active tenders
  only, `SampleResource` loop pattern) beside `tick_pending_resource_samples`;
  rain-onset → `parcel.rained_through_tick`; storm-onset → parcel setback settle.
  (Growth/blight are **lazy on settle** — no per-tick loop.)
- `snapshots.rs`: `write_stable_hash +parcels` (nested tiles/crops/structures,
  sorted); `+parcels` delta section (section count bump); no clear-on-death for
  parcels.
- `command_manifest.rs`: `+ClaimParcel/AbandonParcel/RenameParcel/PayUpkeep/TillTile/
  PlantSeed/WaterTile/TendPlot(durable)/Fertilize/HarvestCrop/ClearTile/TreatBlight/
  PlaceFarmStructure/RemoveFarmStructure` rows (verbs, args, reason_codes, durable_intent).
- `successor-net/lib.rs`: `ClientCommand +` the 14 farming variants + wire tags.
- `server`: `protocol.ts` Zod, `rustAuthorityBridge.ts commandKind`, `shard.ts`
  accept/reject maps — + the 14 entries; Postgres `parcels` table + release-on-
  character-delete; Land Registry terminal fixture prop.
- `client`: `authorityCommandSystem.ts` union +`enqueue*`; farm-tool verbs;
  `parcels` AOI + `farmPlot` channel ingestion; §E view-models; §E.2 charm visuals;
  §E.5 asset packets (crop stages, tools, structures, soil, produce icons).

---

### Cross-lane contract summary (with BioEngineerLead — mirrored in both docs)

- Seed = `item_id` (6_0xx) + `variant_id` (content-deduped genome **handle**).
- Full genome → `CropGenomeRegistry` (his); growth never reads it.
- `AgronomicProfile` (10 fields, §A.4) = the phenotype growth reads; projected once
  at `PlantSeed`, cached on the crop record.
- 3 boundary fns (his, pure): `project_agronomic` (plant), produce mint (mine),
  `mint_harvest_seed` (harvest).
- Band: 6_0xx seeds / 6_1xx produce / 6_2xx bio tools / 6_3xx farm placeables.
- Integration gates: W2 (seeds + `project_agronomic`), W5 (`mint_harvest_seed` +
  registry).

*Authored by AgricultureLead, 2026-07-08. Every claimed repo truth carries an
anchor in §0 or inline. Forks in §H await owner ruling; all else is decision-ready.*

---

## §I. Addendum — Grid-Structure Placement Framework (sibling doc)

Per Main's dawn commission (2026-07-08), the parcel/land machinery in §A.1/§B/§C.0
is **generalized into a reusable placement framework** covering everything players
place — campsites, homes, extractors, farm crops, and future harvesters (auto-miner,
moisture vaporator). It lives as a companion doc:

See `docs/future/grid-structure-framework.md`.

It extracts the shared `StructureAnchor` + `PlacedStructure` trait + helpers from the
7 landed placed-entity structs, cites the landed **extractor** and landed **camp**
(`PlacedCampState`, CampWeatherSim) as the two live precedents, maps every existing
entity on **hash-safe** (impl-only retrofit, zero stored-byte churn), and specs the
moisture-vaporator/auto-miner content hooks as `StructureClass::Harvester` rows
reusing the extractor's power+accrual. The parcel (Durable/Character), crop tile
(Durable/accrual), greenhouse (Durable/shelter), and sprinkler are the farming
instances of that framework.
