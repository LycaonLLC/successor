# Successor — Grid-Structure Placement Framework

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against `main` before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner dawn brief 2026-07-08 (via Main): generalize the parcel/land machinery
(`agriculture-design.md` §A/§B) into **one placement framework for everything
players place** — campsites, homes, resource extractors, farm crops, and future
harvesters (auto-miners, moisture vaporators). Author: **AgricultureLead**.
Companion to `agriculture-design.md` (the farming instance of this framework) and
the `extraction-crafting-blueprint.md` (the extractor instance). Read-only scout of
`crates/successor-sim/src/authority/model.rs` (the 7 landed placed-entity structs),
`snapshots.rs`, `command_manifest.rs`.

> **Thesis:** the repo has already re-implemented "a thing a player/world places on
> the grid, owned + gated + persisted + hashed" **seven times** with near-identical
> skeletons. Every future placeable (camp, home, crop, vaporator, auto-miner) is
> the same shape again. This doc extracts the **shared primitive** so new
> placeables are a *class row + payload*, not a new subsystem — and so the landed
> ones can converge without a risky rewrite.
>
> **Two live precedents cited throughout:** the **landed extractor**
> (`PlacedExtractorState`, `authority/extractors.rs` — richest: owner + placement +
> power/battery + lazy accrual) and the **landed camp** (CampWeatherSim's `PlacedCampState`, abb617e in
> `authority/camps.rs`, 10 cargo tests — shape folded in per §D).

---

## A. The recurring shape (evidence — 7 landed entities already share a skeleton)

Every placed entity in `model.rs` carries the same conceptual columns; only the
**payload** and a few gating/timing choices differ.

| Entity (anchor) | id | area | placement | owner / gating | timing | class payload |
|---|---|---|---|---|---|---|
| `PlacedExtractorState` (:479) | `extractor_id` | ✔ | cell+position | `owner_actor_id` | `placed_at_tick` + `next_extractor_tick` (accrual) | family/resource/tool + hopper + **power(battery,mode)** |
| `AuthorityBlueprintState` (:4523) | `blueprint_id` | ✔ | **rect** x,y,w,h | (world/authoring) | `placed_at_tick` | `asset_id`, `state` (ghost) |
| `AuthorityStockpileZoneState` (:4537) | `zone_id` | ✔ | **rect** | (world/authoring) | `updated_at_tick` | `item_families`, `priority` (filter zone) |
| `AuthorityAllowedAreaState` (:4551) | `allowed_area_id` | ✔ | **rect** | `actor_ids` (assignment) | `updated_at_tick` | `name` (assignment zone) |
| `ExchangeContainerAuthorityState` (:5210) | `prop_id` | ✔ | cell+position + **rect+radius** | `owner_actor_id?` + `allowed_actor_ids` + `allowed_faction_ids` | — | container binding |
| `LootCacheAuthorityState` (:5226) | `prop_id` | ✔ | cell+position+radius | (world) | — | `container`, `emptied` (state flag) |
| `AmmoStockpileAuthorityState` (:5237) | `prop_id` | ✔ | cell+position+radius | `faction_id?` | — | `container`, `item_id`, `quantity` |
| **Parcel/Home** (agri §A.1) | `parcel_id` | ✔ | **rect** | `owner_character_id` | `claimed_at`/`upkeep` | build/yard zones, tiles, structures |
| **Crop tile** (agri §A.3) | (cell key) | ✔ (parcel) | cell | (parcel owner) | `planted_tick` + settle (accrual) | cached AgronomicProfile |
| **Camp** (CampWeatherSim) | `camp_id?` | ✔ | ? | ? | ? | ? (per §D) |

The columns that ALWAYS appear: **id, area, placement geometry, an owner/gating
notion, an optional timing/accrual clock, a class payload.** That is the primitive.

---

## B. The unifying primitive — a shared anchor + trait (NOT a god-struct)

**Design ruling:** the framework is a **shared embeddable core (`StructureAnchor`)
+ a trait (`PlacedStructure`) + shared helpers**, NOT a single mega-enum that all
entities are force-merged into. Rationale: the 7 landed entities are already
hashed/replay-locked; a forced struct merge would churn `write_stable_hash` and the
determinism gates for no behavior gain. New placeables **embed the anchor** from day
one; landed ones **retrofit to the trait** incrementally without changing their
stored bytes (§D). Simplest-primitive law, applied.

```rust
/// The shared placement core every player-placeable embeds (new entities) or maps onto (landed).
pub struct StructureAnchor {
    id: String,                 // deterministic mint: "{class}:{owner_key|world}:{seq}" (next_*_id pattern)
    class: StructureClass,
    area_id: String,
    footprint: Footprint,       // unifies the point-vs-rect split above
    owner: OwnerScope,          // unifies owner_actor_id / faction_id / character_id / none
    gating: Gating,
    persistence: PersistenceClass,
    placed_at_tick: u64,
}

enum Footprint {                                   // the two placement shapes seen in §A
    Cell { cell: AuthorityCell, position: AuthorityPosition, interaction_radius_milli: i32 },
    Rect { x: i32, y: i32, width: u32, height: u32 },      // cells
}
enum OwnerScope {                                  // durability + gating scope
    World,                    // fixture/authoring (loot, blueprint, stockpile-zone)
    Actor(String),           // runtime pawn (extractor, camp-while-deployed)
    Character(String),       // DURABLE across sessions (home/parcel — survives logout/deletion)
    Faction(String),         // shared (ammo stockpile)
}
struct Gating { public: bool, allowed_actors: BTreeSet<String>, allowed_factions: BTreeSet<String> }

enum PersistenceClass {
    Durable,                          // home/parcel — forever, Postgres-mirrored, released on char-delete
    Deployable,                       // extractor/camp — persists until collected/destroyed by owner
    Ephemeral { teardown_tick: Option<u64> }, // presence-gated decay: None while owner in radius, Some(deadline) on leave, reset on return (camp's exact model)
    Authoring,                        // blueprint ghost — editor-only, not a world object
    WorldStatic,                      // fixture-authored (exchange/loot/ammo today)
}

/// Optional capability mix-ins (compose only what a class needs):
struct PowerBinding { mode: PowerMode, battery_remaining_seconds: u32, battery_variant_id: u32 } // extractor precedent
struct AccrualClock { next_tick: u64, interval_ticks: u64 }   // lazy closed-form: hopper fill / crop growth
struct ShelterBinding;   // footprint contributes an AuthorityWeatherShelterBox (T4) — CAMP + GREENHOUSE share this; zero bespoke immunity
```

```rust
/// Shared behavior — landed entities implement it without changing their stored shape.
trait PlacedStructure {
    fn anchor(&self) -> &StructureAnchor;
    fn hash_into(&self, w: &mut StateWriter);                 // one hash discipline for all anchors
    fn aoi_row(&self, viewer: &ActorAuthorityState) -> PlacedStructureAoiRow;  // shared AOI + owner-detail gating
    fn on_settle(&mut self, now: u64) {}                      // default no-op; extractor/crop override (accrual)
}
```

**Shared helpers (the real DRY win):**
- `mint_structure_id(class, owner, &mut next_seq)` — one deterministic id mint (the `next_extractor_id`/`next_parcel_id` pattern, unified).
- `validate_placement(anchor, world)` — one gate: area exists, footprint in-bounds + clear, region/POI/road/water buffers, no-overlap, **per-player/per-class limit**, funds (if a sink).
- `is_actor_allowed(anchor, actor)` — one gating check (owner ∨ allow-list ∨ faction ∨ public), reused by every interaction command.
- `hash_anchor(w, anchor)` — one hash contributor; all anchor-bearing state joins `write_stable_hash` uniformly.
- `placed_structures` **AOI section** — one snapshot section carries every anchor (class + footprint + coarse state + owner flag); owner-detail rides class-specific side-channels (extractor hopper %, farm plot, camp status).

---

## C. What varies per structure class

The anchor is constant; each class picks a footprint, an owner scope, a limit, a
persistence class, and which optional capabilities it composes. This table IS the
extension point — a new placeable is a new row, not a new subsystem.

| Class | Footprint | Owner scope | Per-player limit | Persistence | Power | Accrual | Shelter | Payload |
|---|---|---|---|---|---|---|---|---|
| **Home / Parcel** | Rect 16²/24²/32² | **Character** | **1 / planet** | Durable | — | — | — | build+yard zones, tiles, structures |
| **Crop tile** | Cell | (parcel owner) | ≤ yard tiles | Durable (in parcel) | — | ✔ growth settle | — | cached `AgronomicProfile` |
| **Greenhouse** (farm structure) | Rect | (parcel owner) | ≤ yard | Durable | — | — | **✔** | translucent shell |
| **Sprinkler** (farm structure) | Cell + radius | (parcel owner) | ≤ yard | Durable | — | passive auto-water | — | coverage tier |
| **Extractor** (LANDED) | Cell | **Actor** | **1 / player** | Deployable | **✔ battery** | ✔ hopper | — | family/resource/tool/hopper |
| **Camp** (LANDED abb617e, CampWeatherSim) | Cell 5×5 AABB | **Actor** | **1 / player** | **Ephemeral (presence-gated)** | — | — | **✔** | `render_kind` |
| **Auto-miner** (future harvester) | Cell | Actor | budget (fork) | Deployable | ✔ battery | ✔ `f(tool, concentration)` | — | mineral family |
| **Moisture vaporator** (future harvester) | Cell | Actor | budget (fork) | Deployable | ✔ battery | ✔ `f(tool, ambient-humidity)` | — | water family |
| Exchange / Loot / Ammo (LANDED, world) | Cell + rect/radius | World / Faction | — | WorldStatic | — | — | — | container |
| Blueprint (LANDED, authoring) | Rect | World | — | Authoring | — | — | — | asset ghost + `state` |
| Stockpile-zone / Allowed-area (LANDED) | Rect | World / assignment | — | WorldStatic / Authoring | — | — | — | filter / assignment |

Reading the table: **camp = extractor with {no power, no accrual, +shelter,
Ephemeral instead of Deployable}**; **home = a big Rect, Character-owned, Durable,
carrying sub-structures**; **harvesters = extractor with a different accrual input
(concentration → humidity) and resource family**. Nobody hand-rolls the id mint,
placement validation, gating check, hash, or AOI again.

---

## D. Migration / mapping — how the landed entities converge (hash-safe)

Two adoption modes, chosen to **never churn a landed entity's stored bytes**:

### D.1 New placeables — embed `StructureAnchor` from day one
Home/parcel, crop tile, greenhouse, sprinkler, and future harvesters are
un-landed, so they embed the anchor + capabilities directly and reuse every shared
helper. **Camp is the key case:** CampWeatherSim's `PlacedCampState { camp_id,
owner_actor_id, area_id, cell, position, placed_at_tick, teardown_tick: Option }`
in `placed_camps: BTreeMap` is *already* an exact `placed_extractors` sibling — it
IS the anchor pattern, minus power/accrual, plus a `ShelterBinding` and the
presence-gated `teardown_tick`. It adopts the trait for free.

### D.2 Landed entities — retrofit the trait, keep the bytes
Each landed struct gets a thin `impl PlacedStructure` that **delegates to its
existing fields** — no field moves, no stored-shape change, so `write_stable_hash`
output is byte-identical and no ceremony/golden re-gate is needed.

| Landed entity | Anchor mapping (adapter impl) | Persistence class | Action | Hash impact |
|---|---|---|---|---|
| `PlacedExtractorState` | id=`extractor_id`, owner=`Actor(owner_actor_id)`, footprint=`Cell`, +Power+Accrual | Deployable | trait impl (near 1:1) | none |
| `PlacedCampState` (LANDED abb617e) | id=`camp_id`, owner=`Actor`, footprint=`Cell` 5×5, +Shelter, Ephemeral(`teardown_tick`) | Ephemeral | born on the anchor | none |
| `ExchangeContainerAuthorityState` | id=`prop_id`, owner=`owner_actor_id?`+allow-lists, footprint=`Cell`+rect/radius | WorldStatic | trait impl | none |
| `AmmoStockpileAuthorityState` | id=`prop_id`, owner=`Faction(faction_id?)`, footprint=`Cell`+radius | WorldStatic | trait impl | none |
| `LootCacheAuthorityState` | id=`prop_id`, owner=`World`, footprint=`Cell`+radius, payload=`emptied` | WorldStatic | trait impl | none |
| `AuthorityBlueprintState` | id=`blueprint_id`, owner=`World`, footprint=`Rect`, payload=asset+`state` | Authoring | trait impl | none |
| `AuthorityStockpileZoneState` | id=`zone_id`, owner=`World`, footprint=`Rect`, payload=filter | WorldStatic | trait impl | none |
| `AuthorityAllowedAreaState` | id=`allowed_area_id`, owner=assignment(`actor_ids`), footprint=`Rect` | Authoring | trait impl | none |

**Net:** zero forced rewrites, zero hash ceremony for landed entities; the framework
lands as a trait + helpers + one shared AOI section, and the *value* is realized the
moment the next placeable (home, harvester) is built on it instead of copy-pasting a
9th skeleton. The convergence is opt-in and monotonic.

---

## E. Content hooks — moisture vaporator & auto-miner (owner's named futures)

Both are `StructureClass::Harvester` — **the extractor with a different accrual
INPUT and output family**. The extractor's landed contract is `f(tool, concentration)`
(`extraction_math`, blueprint §C.1); generalize the input to a **field scalar**:

```rust
enum HarvestInput { Concentration { family: String }, Humidity }   // extractor | vaporator
// unified accrual, one shape for extractor / auto-miner / vaporator:
fn harvest_milli_per_sec(tool_rate_milli: u16, field_milli: u16) -> u32 { /* = c*t/1000, blueprint §C.1 */ }
fn input_field_milli(input: &HarvestInput, cell, tick, biome, weather) -> u16 { ... }  // deterministic
```

- **Auto-miner** — it is *already* 90% the landed **battery extractor**: autonomous,
  battery-powered, hopper-accruing `f(tool, concentration)` on a mineral vein. The
  only deltas: it's a fixed emplacement (Deployable, owner-gated) and can target any
  registered mineral family (copper is already a registry row per the extraction
  blueprint). **Net new work: a class label + a per-player budget knob.** The
  machinery exists.
- **Moisture vaporator** (the earlier sandbox design homage) — same machine, `input = Humidity`,
  `output = water (liquid family 2005)`. `input_field_milli(Humidity, …)` is a new
  **deterministic humidity field**: a sibling of `resource_concentration_milli`
  seeded per cell, **modulated by biome + season + weather** (rain spikes it,
  desert *day* is bone-dry, desert *night* recovers, forest is humid). Because
  weather is fed input and season is a pure fn of tick (agri §T-model), humidity is
  deterministic — no wall-clock, replay-locked. **Economic twist:** the vaporator
  *thrives where farms fail* — the desert can't grow staples (agri §G biome
  fertility) but it *can* harvest water, giving arid-region players a real export
  and closing the regional-market loop from the other side.

Both drop in as: one `StructureClass::Harvester` variant + one `HarvestInput` arm +
a registry/balance row. No new placement, gating, power, hopper, collect, hash, or
AOI code — all inherited from the anchor + the extractor's power/accrual mixins.

---

## F. Command surface (per-class verbs, one shared core)

**Ruling:** keep **per-class manifest verbs** (explicit player intent, clean SP1
slash/query derivation, distinct reason codes) but route them through **one shared
lifecycle core** so the validation/gating/mint/hash logic exists once.

```
place  verbs: ClaimParcel · PlaceExtractor(landed) · PlaceCamp(landed) · PlaceFarmStructure · PlaceHarvester
              → all call place_structure(anchor_spec): area+bounds+footprint-clear + region/POI/buffers
                + per-player/per-class limit + gating default + funds sink → mint id → insert → hash
collect verbs: CollectExtractor(landed) · HarvestCrop · (camp auto-teardown)      → shared owner-gate + payload move
remove  verbs: DestroyExtractor(landed) · AbandonParcel · TeardownCamp(landed) · RemoveFarmStructure
              → shared owner-gate + item return + anchor removal + limit free
```

The manifest already carries the landed rows (`PlaceExtractor/CollectExtractor/
DestroyExtractor/PlaceBlueprint/SetStockpileZone/SetAllowedArea`,
`command_manifest.rs`); the framework adds `ClaimParcel/PlaceFarmStructure/
PlaceCamp/PlaceHarvester` as siblings with the same arg/reason/durable-intent
shape. Durable-intent placement (`placed_parcel`, `placed_extractor`,
`placed_camp`) is the shared pattern.

---

## G. Persistence, hash, and AOI — one discipline for all anchors

- **Hash:** every anchor-bearing map joins `write_stable_hash` via `hash_anchor`
  (one contributor). Deployable/Durable/Ephemeral are stored → hashed; Authoring/
  WorldStatic already are. Determinism rules unchanged (BTreeMap, tick math, native
  == wasm32).
- **Hash byte-order is sacred — the real G1 gate (per CampWeatherSim):** `hash_anchor`/
  `hash_into` **relocate** serialization code; they must NOT change the bytes or field
  order any landed entity already emits. Each landed `impl` reproduces its existing
  `write_stable_hash` sequence **verbatim, in place** — e.g. camp writes
  `camp_id / owner / area / cell / position / placed_at_tick` + teardown (`bool` + `tick`)
  **immediately after the extractor records**, and that exact order + presence is pinned.
  The trait's default emit is for **greenfield** entities only; landed entities override
  to their frozen order. `stable_state_hash` staying **byte-identical** is the G1
  pass/fail, co-reviewed with ExtractionW34 + CampWeatherSim.
- **AOI:** **consolidate to one `placedStructures` delta section** (class + footprint
  + coarse state + owner flag) instead of a section per class (extractor has one
  today; camp/parcel/harvester would each add one → section-count churn). Owner
  detail rides class side-channels (extractor hopper %, `farmPlot`, camp
  `abandon_seconds_remaining`). *(Consolidation is opt-in; the landed extractor
  section can merge when convenient — fork GF4.)*
- **Persistence class → durability:**
  - **Durable** (home/parcel) → Rust stored-state + **Postgres mirror**, released on character deletion (agri §F).
  - **Deployable** (extractor/camp/harvester) → Rust stored-state, survives restart via the landed versioned export/import (B1 PersistRestore); no external mirror.
  - **Ephemeral** (camp) → `teardown_tick` decays it in-sim; presence resets it; nothing external needed.
  - **Authoring/WorldStatic** → fixture/export as today.

---

## H. Adoption waves (trait-first, retrofit-incremental — disrupts no landed lane)

| Wave | Content | Replay class | Coordinate with |
|---|---|---|---|
| **G1** | `StructureAnchor` + `PlacedStructure` trait + shared helpers (mint/validate/gating/`hash_anchor`/AOI); retrofit **extractor + camp** as the proving twins | pure scaffold — **hash byte-unchanged** for landed | ExtractionW34 (extractor), CampWeatherSim (camp) |
| **G2** | New placeables born on the anchor: home/parcel (agri W1), crop (agri W2/W3), greenhouse/sprinkler (agri W4/W6) | stored (agri already pays this) | — |
| **G3** | Retrofit remaining landed entities to the trait (exchange/loot/ammo/blueprint/zone/allowed-area) — impl-only | hash-safe, opportunistic | fixture owners |
| **G4** | Harvester content class: `HarvestInput` + auto-miner + moisture-vaporator humidity field + balance | derived field + stored entity | ExtractionW34 |

G1 is a **pure refactor** (extract the shared shape from two structs that are
already twins) — its gate is "workspace hash unchanged + all placed-entity tests
green." Everything after is additive.

---

## I. Open forks (defaults + status)

| Fork | Options | Recommended default | Status |
|---|---|---|---|
| **GF1 shape** | god-struct enum vs **anchor + trait + helpers** | Anchor + trait + helpers (no forced merge; hash-safe) | rec by design |
| **GF2 structure budget** | per-class limits vs a global per-player deployable cap | Per-class now (extractor 1, camp 1, home 1/planet); global budget as a later balance knob | PENDING OWNER |
| **GF3 owner scope** | Actor vs Character for deployables | Home=Character (durable); extractor/camp=Actor. Reconsider extractor→Character if it must survive logout | PENDING OWNER |
| **GF4 AOI** | per-class sections vs **one `placedStructures` section** | Unify to one section (saves section-count churn) | PENDING (coordinate landed extractor AOI) |
| **GF5 vaporator field** | humidity source + desert behavior | biome+season+weather field; **vaporator thrives in desert** (water economy) | PENDING OWNER |
| **GF6 harvester limits** | how many auto-miners/vaporators per player | small per-class budget (fits GF2) | PENDING OWNER |
| **GF7 commands** | unified `PlaceStructure(class)` vs per-class verbs | Per-class verbs + shared core (clean manifest/SP1) | rec by design |

---

*Authored by AgricultureLead, 2026-07-08, on Main's commission. Precedents cited:
landed `PlacedExtractorState` (`authority/extractors.rs`, `model.rs:479`) + landed
`PlacedCampState` (CampWeatherSim, `authority/camps.rs`, abb617e). Companion
to `agriculture-design.md` (§A/§B parcel machinery, generalized here) and
`extraction-crafting-blueprint.md`. G1 is a hash-neutral refactor; coordinate with
ExtractionW34 + CampWeatherSim before landing.*
