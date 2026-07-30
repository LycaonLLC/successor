# Bio-Engineer & Crop Engineering

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against `main` before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

**Author:** BioEngineerLead (Opus 4.8 research lead)  ·  **Date:** 2026-07-08  ·  **Status:** decision-ready design, no code yet
**Sibling doc:** `docs/future/agriculture-architecture.md` (land, soil, growth simulation, and farming client)
**Owner directive:** Bio-Engineer profession + crop engineering for the Successor MMO. "Way crazier than earlier sandbox design," fully deterministic (no slot-machine), terminator-seed economics as a *fun* market lever.

This doc owns: the **genetics/trait model**, the **seed-modification gameplay loop**, the **profession**, and the **seed economy**. AgricultureLead owns how a seed *grows*; I own what a seed *is*. §0 is the joint interface and is byte-identical in both docs.

Repo grounding (all claims below cite anchors):
- 12-attribute `ResourceStats` (u16, `0..1000` milli): `crates/successor-sim/src/authority/model.rs:16-29`.
- Weighted-stat crafting caps `CraftLineWeight`, assembly→experimentation→variant flow: `crates/successor-sim/src/authority/crafting.rs` (`craft_line_cap_milli_from_stats:1360`, `apply_craft_assemble:546`, `apply_craft_experiment:646`).
- Deterministic milli math primitives + variant packing: `model.rs:experiment_line:2538`, `model.rs:encode_slugthrower_variant:3631`.
- Lazy-derive placed-object precedent (`ExtractorState`): `model.rs:427-437`, `authority/extractors.rs`.
- Profession tree shape (novice/4-tracks/master, 8/6/4/2 SP, XP 0/100/300/650/1100/1800): `client/src/slice-core/specs/progression.v1.json`.
- Skill-point cap 250, full profession 97, `PurchaseSkillBox` (XP+SP+credits+prereqs+trainer radius+white trainer), bootstrap grants at novice: `docs/CANONICAL_CONTEXT.md`, `docs/RESOURCE_CRAFTING_FOUNDATION.md`.
- Item-id bands (5_0xx is the schematic lane — TAKEN): `authority.rs:284-368` (`LOOTED_SCHEMATIC_ITEM_ID=5_002`, `DRAFTED_SCHEMATIC_ITEM_ID=5_003`).

External + internal reference (see Appendix A for full citations):
- earlier sandbox design Bio-Engineer post-mortem (web): "mad scientist" fantasy + deep customization = the draw; **skill-tax, ruinous rolls, prohibitive grind, private-station running-cost** = why it hurt.
- Core3 emulator archaeology (Core3SocialEconomy / Core3WorldSim): the real `GeneticLabratory` model — dynamic caps from combined DNA × assembly modifier, profile-grouped experimentation with proportional split, and **crit-fail degrades a *different* stat group** (the exact volatility we design OUT).
- Genetics-in-games taxonomy (web): Stardew (random/low-agency) → Rune Factory/Ark (stat-weighted min-max) → Niche (Mendelian genotype/phenotype = discovery). Pillars: pick the fun (surprise vs optimization vs **discovery**), avoid RNG-hell, **investigation tools + strong genome UI are mandatory**.
- EVE T2 BPO (web): the "monopoly" is a *misconception* because an accessible path sets a price floor — the lesson for our terminator economy (§4).

---

## §0 — JOINT SEED CONTRACT  *(SHARED — byte-identical in `agriculture-design.md`)*

> This section is the sole interface between Bio-Engineer (what a seed IS) and Agriculture (how it grows). Both leads ratified it over IRC on 2026-07-08. Neither side may change it unilaterally.

### S0.1 What a seed is on the wire
A seed is an ordinary inventory item: `(seed_item_id, variant_id, quantity)`, stacking by `(item_id, variant_id)` like every other stack (`successor-net/src/lib.rs:85-88`).
- `seed_item_id` = **crop species** (one id per species; band §0.5).
- `variant_id` = a **genome handle**: a server-assigned, sequential, content-deduped `u32`. Identical genomes intern to the same handle, so identical seeds STACK; different genomes never merge (same rule as resource identity, `RESOURCE_CRAFTING_FOUNDATION.md` "Resource stat identity is exact by (item_id, variant_id)").

### S0.2 Why the handle is NOT the packed phenotype (forced by u32)
The growth-relevant phenotype is ~10 fields (below), most at full milli precision (`0..1000` ≈ 10 bits each) — roughly **100 bits** of state, versus a 32-bit `u32`. The repo's variant-packing convention packs only ~3 fields at 2-digit precision: `encode_slugthrower_variant = 31_000_000 + power×10^6 + handling×10^3 + reliability`, each `0..100` (`model.rs:3631`). **10 milli-fields cannot be pure-fn-decoded from one u32.** Therefore the full genome lives in a server-side **`CropGenomeRegistry`** side-table (Postgres durable, Redis hot), keyed by the handle. Bio-Engineer owns it; Agriculture never reads it.

### S0.3 The `AgronomicProfile` (the only thing growth reads)
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

### S0.4 The round trip (who computes what)
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

### S0.5 Item-id band (co-owned `6_xxx`; `5_0xx` is the schematic lane, `authority.rs:367-368`)
| Band | Owner | Contents |
|---|---|---|
| `6_0xx` | Bio-Engineer | **seeds** — one `item_id` per species, `variant_id` = genome handle |
| `6_1xx` | Agriculture | **produce** — one per species, `variant_id` = quality-encoded |
| `6_2xx` | Bio-Engineer | bio tools & reagents (Gene Sampler, Splicer, Scanner, culture medium, mutagen, stabilizer, serum, gene-lock kit) |
| `6_3xx` | Agriculture | farm placeables/structures (plot-stake, planter, sprinkler, greenhouse) |

Genome registry keyed by the handle. The scalar authority credit wallet remains
separate from seed inventory identity.

*(End §0 — shared block.)*

---

## §1 — THE PROFESSION: BIO-ENGINEER

### 1.1 Identity & fantasy
A dedicated specialized profession — the street-level **Genecrafter**. Cyberpunk gene-hacker who samples wild flora and creature tissue, splices genomes on a bench, and forges best-on-server crop lines. It is the systemic heir to earlier sandbox design Bio-Engineer's "mad scientist" fantasy — the single most beloved thing about the original — but with the pain designed out (see 1.6).

### 1.2 Hybrid prerequisite (branches off Medic + Craftsman)
Per owner canon, Bio-Engineer is a hybrid elite whose novice box is gated on boxes from **both** parent professions — established sandbox-style, but symmetric and cheap enough to avoid the "skill-tax" failure. It reads biology from Medic and experimentation/assembly from Craftsman.

`bioengineer-novice` prerequisites (both required):
- `craftsman-experimentation-ii` (transitively: `craftsman-novice` → `craftsman-experimentation-i` → `-ii`)
- `medic-medical-crafting-ii` (transitively: `medic-novice` → `medic-medical-crafting-i` → `-ii`)

Prereq cost = Craftsman(16+8+6) + Medic(16+8+6) = **60 SP**, symmetric across parents. Full Bio-Engineer = **97 SP** (curve below). Total to a mastered Bio-Engineer with the required parent boxes = **157 SP**, well inside the 250 cap (`CANONICAL_CONTEXT.md`), leaving ~93 SP for deeper parent lines or a partial third profession. No foreign profession must be *mastered* just to sample (the earlier sandbox design Ranger skill-tax is explicitly avoided — sampling lives in our own Sequencing track).

### 1.3 Tree (novice + 4 tracks + master, on the canonical 8/6/4/2 curve)
Emit into `progression.v1.json` with `"bioengineer": "Bio-Engineer"` added to `professions`. Node shape matches existing professions exactly (`row`/`column`/`phase`/`track`/`xpCost`/`skillPointCost`/`prerequisites`/`grants`/`title`).

| Node | Track | Col | XP | SP | Grants (gameplay hooks) |
|---|---|---|---|---|---|
| `bioengineer-novice` | novice | 1 | 0 | 16 | Gene Sampler + Genome Scanner + **starter seed packet**; Sequencing & Splice fundamentals. Title **Novice Bio-Engineer**. |
| `bioengineer-sequencing-i..iv` | sequencing | 0 | 100/300/650/1100 | 8/6/4/2 | Gene-scanner depth (reveal hidden alleles → allele values → mutation-potential); wild-flora sample yield/quality; creature-tissue sampling (from `-iii`). |
| `bioengineer-splicing-i..iv` | splicing | 1 | 100/300/650/1100 | 8/6/4/2 | +splice experimentation points; +simultaneous editable loci; +deterministic gain-per-point (consistency); assembly quality. |
| `bioengineer-cultivation-i..iv` | cultivation | 2 | 100/300/650/1100 | 8/6/4/2 | True-breeding stabilization (shrink heterozygous spread); bio-reagent potency (culture medium/mutagen/stabilizer/serum); produce-quality realization. |
| `bioengineer-genelock-i..iv` | genelock | 3 | 100/300/650/1100 | 8/6/4/2 | Sterile-seed craft (`-i`); sterility guarantee + **Seed Vault** (`-ii/-iii`); cultivar registration/patent + landrace-vault access (`-iv`). |
| `bioengineer-master` | master | 1 | 1800 | 1 | **Master Bio-Engineer** title; guaranteed primary-line capping; **Chimeric Splice** (extra locus / master-gated cross-kingdom graft); Apex Cultivar registration. |

SP total = 16 + (8+6+4+2)×4 + 1 = **97** ✔ (identical to Craftsman/Medic/Marksman/Scout/Brawler).

### 1.4 XP sources = bio-engineering *actions* (server-owned, track-specific)
Mirrors the canon pattern (Marksman XP from damage, Craftsman from craft loops). Rust grants:
- **Sequencing XP** — wild-flora sampling, creature-tissue sampling, genome scans that reveal new information.
- **Splicing XP** — assembling a splice session + spending splice experimentation points (mirrors `CRAFT_XP_PER_EXPERIMENT_POINT`, `crafting.rs:apply_craft_experiment`).
- **Cultivation XP** — crafting bio-reagents; stabilizing a genome toward true-breeding.
- **Gene-Lock XP** — crafting sterile seeds; registering/patenting a cultivar.
- **Provenance trickle (optional hook)** — a small Splicing/Cultivation XP drip when *another* player harvests a high-husbandry crop of a cultivar you bred (the earlier sandbox design "your goods live in the world" prestige loop; gated + capped so it can't be farmed).

### 1.5 Trainer, dialogue hooks, bootstrap
White non-combat **Genecrafter** trainer (a "Gene-Lab Technician"), same `PurchaseSkillBox` gate as all professions (XP + SP + credits + prereqs + trainer radius + white-trainer, `CANONICAL_CONTEXT.md`). Dialogue tree (hooks for TrainerDialogueFE's incoming system):
1. *Greet* → 2. *"What is bio-engineering?"* (genotype vs phenotype, scanning) → 3. *"Get me started"* (**idempotent bootstrap grant**: Gene Sampler `6_201` + Genome Scanner `6_203` + a fixed low-tier fertile **Starter Seed Packet** `6_0xx`; points player at wild flora) → 4. *"Train me"* (skill-box purchase) → 5. *"The splicer"* (explains the session) → 6. *"Gene-locking & selling"* (explains the sterile economy).

Bootstrap mirrors "learning Novice Craftsman grants one General Crafting Tool + one Iron Survey Tool" (`RESOURCE_CRAFTING_FOUNDATION.md`). This is the **seed-acquisition bootstrap** (owner's open question resolved): guaranteed trainer packet for entry (no RNG wall), then wild-flora sampling as the ongoing source (Core3WorldSim confirms wild sampling is the thematic sandbox-design lineage bootstrap), with rare wild "landrace" loot as flavor/advanced genetics.

### 1.6 earlier sandbox design failure modes, designed out (explicit)
| earlier sandbox design Bio-Engineer pain (web + Core3) | Successor fix |
|---|---|
| **Skill-tax**: had to master Ranger just to sample DNA | Sampling is native to our **Sequencing** track. No foreign mastery. |
| **Ruinous rolls**: one bad experimentation roll wasted hours; crit-fail degraded a *different* stat group (`GeneticLabratory::experimentRow`) | **Fully deterministic** splice (§3.4): no per-point RNG, no crit-fail, no cross-group degradation. Worst case is a *predictable* suboptimal child. |
| **Prohibitive grind / bot reliance** | Generational pacing is the limiter, not clicks; the loop is a puzzle, not a macro (§3.6). |
| **Private-station running cost** locked out casuals | Splice bench is a `6_2xx` **tool**, hands-usable like the crafting tool; a shared/parcel bench is a *convenience*, not a gate. |
| **Watered-down output** vs wild | Player cultivars can *exceed* wild landraces via directed selection over generations (§3.5). |

---

## §2 — GENETICS / TRAIT MODEL (what a seed variant IS)

### 2.1 The genome (authoritative, in `CropGenomeRegistry`)
Every seed handle resolves to one immutable `Genome`. Milli conventions match `ResourceStats` (`u16`, `0..1000`, `model.rs:16-29`).

```
struct Genome {                         // interned -> u32 handle (variant_id); content-deduped so identical genomes STACK
    species_id:   u16,                  // == seed_item_id (6_0xx)
    loci:         [Locus; 13],          // 10 agronomic + 3 breeding-meta (below)
    fertile:      bool,                 // false = terminator / gene-locked (mint_harvest_seed -> None)
    gene_lock:    Option<PlayerId>,     // who locked propagation
    lineage:      Lineage,
}
struct Locus  { a1: u16, a2: u16 }      // diploid: two alleles, each 0..1000
struct Lineage {
    breeder_id:    PlayerId,            // maker attribution (like crafted-item maker)
    cultivar_name: String,             // named like resource spawns ("Daxmere") — generated or player-set
    generation:    u16,                 // F-number
    parents:       [u32; 2],            // parent handles (0 = wild/none); bounded, not a full tree
}
```

### 2.2 Expressed phenotype = deterministic function of the allele pair
Per locus, the **expressed** value is a fixed dominance rule (authored per trait in the species template). Quantitative traits are **additive/co-dominant** (`express = (a1 + a2) / 2`) — the standard quantitative-genetics model, smooth and predictable. A few traits are **Mendelian switches** (dominant categorical). This split is the deterministic realization of Niche's genotype/phenotype (the industry benchmark for "genetics as gameplay").

The **hidden variation** is the *spread* between `a1` and `a2`. Two seeds both expressing `600` can be `600/600` (true-breeding) or `400/800` (heterozygous — secretly carrying an elite `800` allele and a weak `400`). This is the discovery layer: the phenotype tells you what it *is*, the genotype tells you what it can *become*.

### 2.3 The trait set (chosen with rationale) and its closed-form projection
`project_agronomic` is a per-locus closed-form map (this is the pure fn Agriculture calls once at plant, §0.4). Constants (`*_MIN/MAX`) live in a balance table.

| # | Locus | Dominance | → `AgronomicProfile` field | Projection (milli math) | Why it exists |
|---|---|---|---|---|---|
| 1 | `yield` | additive | `yield_base` | `YIELD_MIN + (YIELD_MAX-YIELD_MIN)·e/1000` | core value: harvest quantity |
| 2 | `growth_rate` | additive | `growth_days_base` | `GDAYS_MIN + (GDAYS_MAX-GDAYS_MIN)·(1000-e)/1000` (inverse) | pacing lever + iteration gate (§3.4) |
| 3 | `water_economy` | additive | `water_need_milli` | `1000 - e` (floor `WNEED_MIN`) | drought vs thirsty; ties to soil/weather |
| 4 | `hardiness` | additive | `hardiness_milli` | `e` | neglect grace — casual-friendly |
| 5 | `storm_resistance` | additive | `storm_resistance_milli` | `e` | weather-v2 survival |
| 6 | `blight_resistance` | additive | `blight_resistance_milli` | `e` | deterministic pest events |
| 7 | `quality_potential` | additive | `quality_potential_milli` | `e` | **economy driver**: caps produce quality |
| 8 | `regrowth` | Mendelian threshold | `regrowth_days` | `e ≥ REGROW_THR ? RG_DAYS_MIN+… : 0` | perennial vs single-harvest |
| 9 | `season_affinity` | dominant categorical | `season_affinity` + `off_season_penalty_milli` | dominant allele → season bitmask; penalty `= 1000-e'` | seasonal identity |
| 10 | `stature` | banded | `tile_footprint` | `band(e) → 1x1 / 2x2 / …` | giant crops, spatial cost |
| 11 | `mutation_potential` | additive | *(breeding-only)* | caps how far reagent-lift + experimentation reach (§3) | improvability vs stability trade |
| 12 | `potency` | additive | *(breeding-only)* | feeds bio-reagent & medicinal-crop value | Medic-heritage crossover |
| 13 | `vigor` | additive | *(breeding-only)* | scales harvest seed viability/count vs tending | hybrid-vigor flavor |

10 profile loci map 1:1 to the 10 `AgronomicProfile` fields (two inversions, one threshold, two categoricals); 3 meta loci are breeding-facing only. `project_agronomic` is therefore a direct, allocation-free read.

### 2.4 Encoding recommendation — **side-table keyed by a content-deduped handle** (RECOMMENDED)
Decision the owner asked for (immutable variant-packing vs side-table like schematics): **side-table.**
- **Why not pack into the variant:** impossible — §0.2 (≈100 bits vs 32; repo packs ≤3 two-digit fields, `encode_slugthrower_variant`).
- **Why a content-deduped sequential handle:** identical genomes must stack. A sequential `u32` counter (same shape as `next_extractor_id` / `next_inventory_stack_id`, `extractors.rs`/`tests.rs`) is replay-deterministic; a `content → handle` dedup map ensures identical genomes reuse one handle (so 40 seeds off one true-breeding plant = one stack of 40). Sequential (not hash-truncated) avoids u32 birthday collisions (~65k) across a server's cultivar space.
- **Why side-table (not regenerated from a small seed like resources):** resources *roll* their 12 stats from `(item_id, variant)` deterministically (`resource_stats_for_item_variant`, `model.rs:1993`); a genome is *authored by breeding*, carries hidden recessives + lineage, and cannot be regenerated from a compact seed. It is durable, curated state → Postgres (`CANONICAL_CONTEXT.md` "inventory and item ownership" / "audit records"), Redis-hot for the plant-time lookup.
- **Cost:** one registry read on the cold path (`PlantSeed`, `SpliceMint`, tooltip). The hot path (growth tick) touches only the cached `AgronomicProfile`. Zero new inventory/wire plumbing — seeds ride the existing `(item_id, variant_id, quantity)` stack model (`successor-net/src/lib.rs:85`).

### 2.5 Inheritance / crossbreeding — deterministic directed segregation (NO slot-machine)
A splice of parents A × B produces exactly **one** child genome, fully determined by inputs. Owner mandate: *same parents + same actor context (skill, tools, reagents, choices) = same child.*
- **Segregation (the big lever):** for each locus the child takes **one allele from each parent** — `child.a1 ∈ {A.a1, A.a2}`, `child.a2 ∈ {B.a1, B.a2}`. *Which* allele is the player's **choice** per locus (default: each parent's higher allele — "elite selection"). No dice: the choice is configuration.
- **Directed mutation (the fine lever):** experimentation points then lift the child's expressed value toward a per-locus cap (§3.4), raising both alleles equally so zygosity (true-breeding vs hetero) is preserved.
- **Selfing** (A × A, or A × sibling) is how you *fix* an elite heterozygote into a true-breeding homozygote across a generation (§3.5, worked example).
- **Determinism proof obligation:** named unit test `identical_inputs_yield_identical_genome_handle` (Appendix B). There is **no** per-point RNG and **no** cross-group crit-fail (the earlier sandbox design `GeneticLabratory` volatility we delete).

### 2.6 Sterile flag (terminator) mechanics
`fertile: bool` on the genome. A sterile seed grows and produces crop **normally** (growth reads the same `AgronomicProfile`), but `mint_harvest_seed` returns `None` → no child seeds. Set by the **Gene-Lock** track's terminator craft (§4), which takes a fertile genome and mints a sterile-flagged sibling handle (same loci, `fertile=false`, `gene_lock=Some(breeder)`). Growth never needs the flag — it only matters at harvest — so it stays out of the `AgronomicProfile` and the split stays clean.

### 2.7 Lineage / provenance
Every genome carries `breeder_id`, `cultivar_name`, `generation`, and up to two `parents` handles (maker attribution, like crafted-item provenance; Core3 wrote crafted stats + a serial onto the prototype — we do the same on the genome). Named cultivars echo the "named resource spawn" convention ("Daxmere"): auto-generated on first mint, player-renamable when registered (§4). Seed/produce tooltips and the cultivar ladder read this; it is display-only, never gameplay-authoritative.

---

## §3 — THE ENGINEERING LOOP  *(the creative heart)*

### 3.1 The loop
```mermaid
flowchart LR
  A[ACQUIRE\nwild-flora sample /\ncreature tissue /\ntrainer packet /\nlandrace loot] --> B[ANALYZE\nGenome Scanner:\nreveal alleles\n(earned information)]
  B --> C[SPLICE\nsession machine:\nslots + assembly +\nper-locus experiment lines]
  C --> D[GROW\nAgriculture grows it\n= the ITERATION GATE\ngenerations, real time]
  D --> E[SELECT\nscan offspring,\nkeep the best]
  E --> C
  D --> F[SELL / GENE-LOCK\nfertile or sterile\ncultivar to market]
```
Five verbs: **Acquire → Analyze → Splice → Grow → Select**, closing back to Splice. Growth is the iteration gate (3.4). The design converts earlier gene-crafting design's slot-machine into **information asymmetry** (what you know via scanning) + **directed optimization** (splice choices) + **generational compounding** — three earned advantages, zero luck.

### 3.2 Acquire — where genetic material comes from
- **Wild-flora sampling** (Sequencing) — a `Gene Sampler` (`6_201`) used on wild plant nodes, exactly the survey/sample verb pattern (`SurveyResource`/`SampleResource`, kneel-gated, own cooldown lane; `RESOURCE_CRAFTING_FOUNDATION.md` "Survey Slice v1"). Yields a **wild landrace seed** — a genome with modest, often heterozygous alleles and one or two surprising elite recessives (the reason to scan). Core3WorldSim confirms wild `/sample` (quality 0–7 from skill) is the sandbox-design lineage bootstrap.
- **Creature-tissue sampling** (Sequencing `-iii`+) — sample glandular/structural tissue off a downed creature (crossover with Scout's harvest, `2101-2104`) for **animal-derived alleles** (e.g., a toughness allele into a crop). This is the "way crazier than earlier sandbox design" cross-kingdom hook, master-gated for expression (fork §6.2).
- **Trainer starter packet** — guaranteed, deterministic entry seed at Novice (1.5). No RNG wall.
- **Landrace loot** — rare wild cultivars as flavor/advanced genetics.

### 3.3 Analyze — the Genome Scanner (earned information, not a gamble)
The `Genome Scanner` (`6_203`) reveals genome data in tiers gated by the **Sequencing** track — the "investigation tool" the genetics-in-games literature says is *mandatory* (else players resort to spreadsheets):
- Novice: **expressed phenotype** only (the `AgronomicProfile`).
- Sequencing I–II: **hidden allele presence** (this locus is heterozygous — it hides something).
- Sequencing III: **exact allele values** (`a1`/`a2`).
- Sequencing IV / Master: **mutation-potential + lineage depth** (how far it can be pushed; full ancestry).
Reveal is deterministic and permanent (once scanned, known) — the mystery is *information you earn*, not a die you roll. This is the skill expression the whole profession rotates around.

### 3.4 Splice — the session machine (reuses the W6 crafting primitives verbatim)
The splice session is the crafting session machine applied to genomes. **Simplest-primitives law honored: a splice IS a recipe-with-weights.** Mapping to the landed Rust (`crafting.rs`, `model.rs`):

| Crafting primitive (landed) | Splice reuse |
|---|---|
| `CraftSessionState { phase, slots, assembly_quality_milli, experimentation_points_remaining, lines }` (`model.rs:160-167`) | `SpliceSessionState` — same shape |
| `CraftSlotSpecSnapshot` / `apply_craft_assign_slot` | 2 **parent-seed** slots + up to 4 **reagent** slots (culture medium / mutagen / stabilizer / serum) |
| `CraftLineWeight { slot_index, stat, weight }` (`crafting.rs:106`) | per-locus **allele/reagent weights** → the line cap |
| `craft_line_cap_milli_from_stats` (`crafting.rs:1360`) | `splice_line_cap_milli` (below) |
| `apply_craft_assemble` → `craft_assembly_quality_milli` (`crafting.rs:546,1406`) | `splice_assemble` → deterministic assembly (below) |
| `apply_craft_experiment` → `experiment_line` (`crafting.rs:646`, `model.rs:2538`) | `splice_experiment_locus` → **deterministic** lift (below) |
| `craft_output_variant_id` → `encode_slugthrower_variant` (`crafting.rs:1420`) | `mint_genome` → intern to a handle (§2.4) |
| Commands `CraftItem`/`CraftAssignSlot`/`CraftClearSlot`/`CraftExperiment`/`FinalizePrototype` | `SpliceBegin`/`SpliceAssignSlot`/`SpliceClearSlot`/`SpliceExperimentLocus`/`SpliceMint` |

**The math (milli, `u16 0..1000`; §C style — matches `extraction_math.rs` conventions).** Constants live in a balance table; illustrative values in brackets.

```
// (1) Segregation — child alleles are CHOSEN, not rolled (per locus L):
child.a1 = choose(parentA at L)   // default: max(A.a1,A.a2); player may override
child.a2 = choose(parentB at L)   // default: max(B.a1,B.a2); player may override
base_L   = (child.a1 + child.a2) / 2                              // expressed start (additive)

// (2) Assembly quality — DETERMINISTIC (BE divergence: no ai_rand roll):
assembly_q = clamp( 350
                  + splice_skill_bonus/2                          // Splicing track: 0(novice)..~300(master)
                  + (splicer_tool_q - 500)/5
                  + (culture_medium_purity - 500)/5 , 100, 1000 )
points_total = splice_points(Splicing track) + (assembly_q - 500)/100   // [-4..+5] bonus points

// (3) Genetic ceiling per locus — from alleles + reagent (mirrors craft_line_cap shape):
mut_gate   = express(mutation_potential)/1000                     // 0..1
lift_L     = max(0, reagent_stat_L - 500) * REAGENT_LIFT_NUM/1000  // [REAGENT_LIFT_NUM=300]; premium reagent only lifts UP
brk_L      = (Master AND reagent_stat_L >= 900 AND full_commit_L) ? BREAKTHROUGH : 0   // [BREAKTHROUGH=50]
cap_L      = clamp( base_L + lift_L*mut_gate + brk_L , 0, 1000 )

// (4) Experimentation — DETERMINISTIC lift toward cap (no per-point RNG, no crit-fail):
gain(skill) = {novice:2, I:3, II:4, III:5, IV:6, master:8}         // milli per point
value_L     = min( base_L + points_L * gain(skill) , cap_L )
```

Divergences from the landed craft primitive, all in service of the owner's stricter BE determinism mandate ("no one lucks into a best craft"):
- Assembly replaces the `ai_rand` `assembly_roll` term with a deterministic culture-medium term. **Same inputs → same assembly.**
- Experimentation replaces the seeded `+4/+1` success roll (`experiment_line_with_bonus`, `model.rs:2549`) with a deterministic `gain(skill)` schedule. **No crit-fail, no cross-group degradation** (the earlier sandbox design `GeneticLabratory::experimentRow` volatility, deleted).
- **Owner calibration satisfied:** at Master + top reagents + **full points on the primary line**, `points_total·gain = 21·8 = 168 ≥` a typical homozygous-elite gap (`cap−base ≈ 158`) → the primary line caps *reliably, exactly*. Split your points and you don't cap the primary but you lift secondaries — skill "buys consistency + guaranteed capping + extra on secondary lines," verbatim.

### 3.5 Grow — the iteration gate (generations)
You cannot re-roll instantly. To *validate* a spliced cultivar you must **grow it** on AgricultureLead's soil, which takes real time (`growth_days_base` × `ticksPerGameDay`). This is the deliberate pacing limiter that replaces earlier sandbox design's click-grind:
- Growth time is the natural anti-spam cadence — no bot can shortcut a generation.
- It makes `growth_rate` genuinely valuable meta: a faster cultivar iterates faster, so **breeding for speed first** is a real strategy.
- Husbandry (`tending_quality_milli`) feeds produce quality and seed viability/count (via the `vigor` locus), so growing well matters — but never gambles the genome (base farming is true-breeding, §0.4).

### 3.6 WORKED EXAMPLE — two generations, deterministic, on paper
Species **Ashgrain** (`6_001`). Balance consts used: `REAGENT_LIFT_NUM=300`, `BREAKTHROUGH=50`, `gain={novice 2, I 3, II 4, III 5, IV 6, master 8}`, `splice_points={novice 8, I 10, II 12, III 14, IV 16, master 20}`, `mutation_potential(Ashgrain)=800 → mut_gate 0.8`. Profile consts: `GDAYS 2..12`, `YIELD 4..40`, `WNEED floor 100`. Four loci shown (YIELD, GROWTH_RATE, WATER_ECONOMY, QUALITY); the other nine carry along identically.

**Parents (after Genome Scanner reveal):**
| Locus | Dustline (wild landrace) `a1/a2` (express) | Verdant-9 (market fertile) `a1/a2` (express) |
|---|---|---|
| YIELD | 420/460 (440) | **700**/540 (620) ← hides elite 700 |
| GROWTH_RATE | 610/**650** (630) | 400/380 (390) |
| WATER_ECONOMY | 720/**780** (750) | 260/300 (280) |
| QUALITY | 300/340 (320) | **780**/760 (770) |

The puzzle the scan reveals: Dustline owns drought+speed; Verdant-9 owns yield+quality **and secretly carries a 700 yield allele** behind its 620 phenotype. Neither parent is good at everything. Goal: a fast, drought-hardy, high-yield, high-quality true-breeding grain.

**GENERATION 1 — Dustline × Verdant-9 (mid-skill: Splicing II, mid-grade reagents).**
Inputs: `splice_skill_bonus≈120`, splicer tool `600`, culture medium purity `600`, mutagen potency `650`, stabilizer stability `640`.
```
assembly_q  = clamp(350 + 120/2 + (600-500)/5 + (600-500)/5, 100,1000) = 450
points_total= 12 + (450-500)/100 = 12        gain(II)=4     editable loci = 4
```
Segregation choices (grab V9's hidden 700 yield + 780 quality; Dustline's 780 water + 650 growth):
| Locus | child `a1/a2` | base | reagent→lift(×0.8) | cap | pts | **value** |
|---|---|---|---|---|---|---|
| YIELD | 460/700 | 580 | mutagen650→36 | 616 | 4 | **596** |
| GROWTH_RATE | 650/400 | 525 | culture600→24 | 549 | 1 | **529** |
| WATER_ECONOMY | 780/300 | 540 | stabilizer640→33 | 573 | 2 | **548** |
| QUALITY | 340/780 | 560 | culture600→24 | 584 | 5 | **580** |

→ **Ashgrain F1**: YIELD 596 / GROWTH 529 / WATER 548 / QUALITY 580 — already beats *both* parents' weak side (Dustline QUALITY 320; V9 WATER 280). But it is **heterozygous at every locus** (post-lift alleles YIELD 476/716, GROWTH 654/404, WATER 788/308, QUALITY 360/800) → its harvested seeds would segregate. F1 is a **stepping stone**, not the product. A scan confirms it now *carries* elite alleles ≈716/654/788/800.

**GENERATION 2 — F1 × F1 selfing (Master Bio-Engineer, premium reagents).**
Inputs: `splice_skill_bonus≈300`, splicer `950`, culture purity `940`, mutagen potency `950`, stabilizer `950`.
```
assembly_q  = clamp(350 + 300/2 + (950-500)/5 + (940-500)/5, 100,1000) = 678
points_total= 20 + (678-500)/100 = 21        gain(master)=8
```
Selfing lets you pick the **elite allele from both copies** → the child goes **homozygous elite** (true-breeding). Caps now carry the master breakthrough where reagent ≥ 900 and the line is fully committed:
| Locus | child `a1/a2` | base | lift(×0.8) | +brk | cap |
|---|---|---|---|---|---|
| YIELD | 716/716 | 716 | mutagen950→108 | +50 | **874** |
| GROWTH_RATE | 654/654 | 654 | culture940→105 | — | 759 |
| WATER_ECONOMY | 788/788 | 788 | stabilizer950→108 | +50 | 946 |
| QUALITY | 800/800 | 800 | culture940→105 | +50 | 955 |

**Strategy A — cap the primary (owner determinism showcase):** dump all 21 points into YIELD.
`YIELD = min(716 + 21·8, 874) = min(884, 874) = 874` → **capped exactly** (gap 158 ≤ budget 168). Others rest at base.
→ **Ashgrain 'Kestrel'**: YIELD **874** (homozygous, true-breeding), QUALITY 800, WATER 788, GROWTH 654 — server-best yield.

**Strategy B — balanced (6/6/5/4):** YIELD 764 / QUALITY 848 / WATER 828 / GROWTH 686 — no single cap, all strong. The scarce-points trade-off *is* the skill: cap one, or lift all. Both outcomes are 100% deterministic.

**Closing the loop — project 'Kestrel' back to Agriculture (`project_agronomic`):**
```
yield 874  -> yield_base       = 4 + 36·874/1000  ≈ 35 units
growth 654 -> growth_days_base = 2 + 10·(1000-654)/1000 ≈ 5 game-days
water  788 -> water_need_milli = 1000 - 788 = 212   (drought-hardy)
quality 800-> quality_potential_milli = 800         (produce caps at 800 with ideal husbandry)
```
A ~5-day, ~35-unit, drought-hardy, high-quality, true-breeding grain. **Determinism:** identical (parents, segregation choices, reagent variants, skill, tool) → the identical Kestrel handle, for anyone. Nobody lucks into it; you *earn* it with scanning knowledge + reagent investment + two generations of grow-time.

### 3.7 Why it is FUN and skill-expressive (not a menu grind)
- **Discovery** (the scanner): two identical-looking 620-yield seeds can hide a 700 vs a 540 — knowing which is a pure skill/knowledge edge. This is the genre's proven "genetics as gameplay" pillar, made deterministic.
- **Three interacting scarce levers**: (1) *segregation* — one allele per parent per locus, so you physically cannot take everything; (2) *points* — capping one line means abandoning others this session; (3) *reagents* — premium culture medium/mutagen/stabilizer are expensive crafts (a sink), so lift is rationed. Optimizing across all three is the puzzle.
- **Generational compounding**: the big jumps come from *combining the right alleles* (segregation) then *fixing them true-breeding* (selfing) across generations — a legible, multi-session arc, not a one-shot jackpot.
- **No punishment loops**: deterministic means no crit-fail wiping hours (earlier sandbox design's fatal flaw), no bot-macro grind (grow-time paces it), no skill-tax (sampling is native).
- **Mastery is visible**: a master's Kestrel is provably beyond a novice's reach — but the novice's outputs are still deterministic and improvable, so the ladder is always climbable.

### 3.8 Command surface (mirrors the crafting commands 1:1)
Server-authoritative, in `successor-net` + the dev-gated authority route, exactly like `CraftItem`/`CraftAssignSlot`/… (`command_manifest.rs`):
- `SpliceBegin { species_id }` — open a session at a splice bench (`6_202`).
- `SpliceAssignSlot { slot_index, container, stack_id, variant_id }` — parent seeds (slots 0–1) + reagents (2–5).
- `SpliceChooseAllele { locus, from_parent, allele }` — directed segregation choice (defaults applied if omitted).
- `SpliceAssemble {}` — lock inputs, compute assembly_q, points_total, per-locus base+cap (deterministic).
- `SpliceExperimentLocus { locus, points }` — deterministic lift toward cap (rejects `invalid_experiment_line` past cap, mirrors `apply_craft_experiment`).
- `SpliceMint { cultivar_name? }` — intern the child genome → seed handle in inventory; stamps lineage/provenance.
- `GeneLockSeed { container, stack_id, variant_id }` — Gene-Lock track: mint a sterile sibling handle (§4).
- `ScanGenome { container, stack_id, variant_id }` — reveal tier by Sequencing skill.
- `RegisterCultivar { variant_id, name }` — Gene-Lock `-iv`: name + publish to the ladder (§4).
Reason codes reuse `invalid_experiment_line`, `craft_not_assembled`, `ingredient_unavailable`, `schematic_uses_exceeded` shapes (`command_manifest.rs:524-538`).

---

## §4 — SEED ECONOMY

### 4.1 Fertile vs sterile (the terminator lever)
Two products from one cultivar:
- **Fertile seed** — buyer can grow *and* propagate (`mint_harvest_seed` returns true-breeding children). Cheaper per seed; the breeder cedes genetic control (buyers become competitors).
- **Sterile / gene-locked seed** — buyer grows the crop but harvests **no** child seeds (`fertile=false` → `mint_harvest_seed → None`, §2.6). The breeder keeps exclusive control of the line's genetics and sells a **recurring** consumable. This is the owner's deliberate, fun "Monsanto" mechanic: terminator-seed economics as a market lever, not a bug.

The strategic choice per cultivar is the fun: flood the market with cheap fertile seed and dominate on volume, or gate a premium line behind sterile seed and dominate on control. A breeder can even sell *both* — fertile at a high price for those who want to breed from it, sterile cheaper for pure farmers.

### 4.2 Provenance, named cultivars, and the ladder
- **Maker attribution**: every genome carries `breeder_id` (like crafted-item makers; Core3 wrote maker + serial onto the prototype). Seed and produce tooltips show "bred by <player>".
- **Named cultivars**: `cultivar_name` echoes the "named resource spawn" convention ("Daxmere"); auto-generated on first mint, player-renamable at registration. "Ashgrain 'Kestrel'" is a brand.
- **Cultivar ladder**: a server board ranking registered cultivars by trait (best YIELD, best QUALITY, …) with breeder attribution — the prestige loop that made earlier sandbox design BE beloved ("the prestige of creating unique, rare cultivars"). Display-only; never gameplay-authoritative.

### 4.3 Market-control dynamics + anti-degenerate safeguards (the EVE T2 BPO lesson)
EVE's T2-BPO "monopoly" is largely a *misconception*: because an accessible path (Invention) sets a price floor, BPO holders can't truly price out the market, and the legacy advantage became a resented "wealth-stratification remnant." Two lessons, both designed in:

1. **Keep the accessible floor.** Fertile seeds + always-samplable **wild landraces** guarantee a baseline supply and a price floor. A best-on-server sterile line commands a premium but can never *fully* corner the crop, because any farmer can grow adequate fertile/wild stock, and any master BE can breed toward the leader. The terminator lever grants *control of a specific elite line*, not a chokehold on the crop category.
2. **No lottery-locked advantage.** Unlike a T2 BPO (a one-time seeded artifact), a Successor cultivar is **reproducible by determinism**: the moat is skill + reagent supply + grow-time, all earnable. Anyone can climb the same ladder. The leader stays ahead only by *continuing to breed*, not by holding a frozen asset.

Anti-degenerate safeguards (owner's explicit worry — "can the server's best line be lost forever?"):
- **Genomes are durable.** The `CropGenomeRegistry` is Postgres-persistent; a cultivar's genome never vanishes even if all seed stacks are consumed.
- **Seed Vault** (Gene-Lock `-ii/-iii`): a breeder archives a genome against loss; recovering a vault entry re-mints seeds. A quit breeder's line survives in the registry/vault.
- **Landrace vault / wild re-sampling**: base alleles are always re-obtainable from wild flora, so *any* lineage is re-breedable from scratch given effort. No genetics are ever globally extinct.
- **Sterile-only seller quits → nothing bricks**: buyers only ever bought *crop* (produce), not genes; the market simply re-forms around the next breeder. Healthy dependency, not a dead end.

### 4.4 Pricing sinks (credits)
Every step burns value, keeping the economy from inflating (the scalar
authority credit wallet described in `RESOURCE_CRAFTING_FOUNDATION.md`):
- **Reagent crafts** consume real resources (culture medium/mutagen/stabilizer/serum ← chemical/flora/creature inputs) — a resource sink feeding every splice.
- **Gene-lock craft** (sterile mint) has a per-use cost.
- **Cultivar registration / patent fee** (credits) to publish a named cultivar to the ladder.
- **Seed Vault upkeep** — periodic credits cost to keep an archived genome.
- **Trainer + respec** (`SetCareerGoal`) costs, per canon.
Consumers (fertile-seed buyers, sterile-crop farmers) recirculate credits to breeders, who sink it into reagents/registration — a closed loop.

---

## §5 — STAGED WAVES (ceremony discipline)

Each wave ships behind the standard gate trio: **deterministic unit tests** (milli math/state), **live authority tests** (command/result boundary), **browser visual proof**. Order mirrors `RESOURCE_CRAFTING_FOUNDATION.md`'s "Implementation Order". B1 is a hard dependency shared with AgricultureLead.

- **B1 — Genome schema + registry + the joint contract.** `Genome`/`Locus`/`Lineage` types; `CropGenomeRegistry` (content-deduped sequential handle); `project_agronomic`; `mint_harvest_seed`. Deterministic-generation tests (Appendix B). *Ships with AgricultureLead's growth-sim reading the cached `AgronomicProfile`.* No player-facing gameplay yet — schema + interface.
- **B2 — Profession tree + trainer + bootstrap.** `bioengineer` in `progression.v1.json` (novice hybrid prereq, 4 tracks, master); Genecrafter trainer + dialogue hooks; idempotent Novice grant (Gene Sampler + Scanner + starter packet). Skill-box purchase gating via `PurchaseSkillBox`.
- **B3 — Acquire + Analyze.** Wild-flora sampling (`Gene Sampler`, survey/sample pattern) + creature-tissue sampling; `ScanGenome` tiered reveal. First seed in hand + readable genome UI (the mandatory investigation surface).
- **B4 — The Splice session machine** (the creative heart). `SpliceBegin/AssignSlot/ChooseAllele/Assemble/ExperimentLocus/Mint`, reusing the `CraftSession` primitives; deterministic assembly + per-locus caps + lift. Tests assert the §3.6 worked example numerically + `identical_inputs_yield_identical_handle`.
- **B5 — Sterile / Gene-Lock + provenance + Seed Vault.** `GeneLockSeed`, `RegisterCultivar`, vault archive/restore; lineage stamping; cultivar tooltips.
- **B6 — Seed economy surfaces.** Fertile/sterile market listings, cultivar ladder, pricing sinks + credits flows; bio-reagent & medicinal-crop crafts (the Medic-heritage consumables a BE sells to farmers/medics).
- **B7 — "Way crazier" stretch.** Master-gated cross-kingdom splicing (creature-derived alleles into crops), perennials/regrowth, the Chimeric Splice capstone.

Coordination: B1's `AgronomicProfile`/`tending_quality` shapes and B4's grow-time iteration cadence are locked with AgricultureLead (§0); any change to §0 requires both leads.

---

## §6 — OPEN FORKS (recommended defaults; all ratified by Main 2026-07-08)

| # | Fork | Options | **Default (ratified)** | Rationale |
|---|---|---|---|---|
| 1 | Genotype model | haploid (1 allele/trait) vs **diploid** (dom/recessive) | **Diploid** | Hidden recessives = the discovery layer (genotype≠phenotype), the genre's proven fun, made deterministic via the scanner. |
| 2 | Cross-kingdom splice (animal genes → crops) | never / always / **master-gated** | **Master-gated (B7)** | The "way crazier than earlier sandbox design" hook, but plant-only for v1 so scope stays bounded. |
| 3 | Sterility model | **hard sterile bit** vs F1-hybrid-degrade | **Hard bit** | Clean, matches the owner's explicit terminator ask; F1-degrade noted as a softer future alternative. |
| 4 | Husbandry → genome? | genome nudge vs **produce-quality + seed-count only** | **Produce/count only** | Base farming stays predictable + stackable; genetic change lives in the deliberate splice loop. Skill-gated "field selection" is the bounded exception (§0.4). |
| 5 | Seed-acquisition bootstrap | trainer packet / wild sampling / loot | **Trainer packet (entry) + wild sampling (ongoing)** | Guaranteed no-RNG entry; wild sampling is the sandbox-design lineage main source (Core3WorldSim); loot = flavor. |
| 6 | Mutation source | seeded variance vs **pure directed** | **Pure directed** (points push alleles) | Owner's no-slot-machine mandate; "breakthrough" is a *prepared-edge threshold*, not a roll. |
| 7 | Genome storage | packed variant vs **side-table handle** | **Side-table handle** | u32 can't hold ~100 bits (§0.2); handle gives stacking + full fidelity + zero new plumbing. |
| 8 | Trait count | 6 / **~10 profile + 3 meta** / more | **~10 + 3** | 10 map 1:1 to `AgronomicProfile`; 3 meta drive breeding. Trim to 6 only if v1 UI proves heavy. |

Additional design calls made in-doc (not blocking, flagged for owner awareness):
- **Splice determinism diverges from landed craft** (deterministic assembly + gain schedule, no `ai_rand`) — deliberate, to meet the stricter BE mandate. If the owner prefers BE to share craft's seeded rolls, that's a one-line swap back to `experiment_line` (§3.4).
- **Provenance XP trickle** (§1.4) is a hook, default OFF until abuse-tested.

---

## Appendix A — Research citations

**earlier sandbox design Bio-Engineer (design lineage + failure modes):**
- Core3SocialEconomy (internal archaeology, `external implementation/.../GeneticLabratory.cpp`): dynamic caps from combined DNA × assembly modifier; profile-grouped experimentation with proportional split; **crit-fail decrements + 50% cross-group degradation** (the volatility we delete); maker/serial provenance on the prototype.
- Core3WorldSim (internal archaeology): wild-creature `/sample` (quality 0–7 from skill) as the DNA bootstrap; verdict that wild flora sampling / loot is the thematic crop-seed bootstrap.

**Genetics-in-games taxonomy (fun pillars, UI mandate):**
- Niche (Mendelian genotype/phenotype benchmark): https://www.strayfawnstudio.com / https://www.ladiesgamers.com
- Stardew (random/low-agency) & Rune Factory/Ark (stat-weighted min-max, inheritance pools, 55%-higher-parent + rare mutation): https://www.gamespot.com , https://steamcommunity.com
- Pillars (pick surprise/optimization/**discovery**; avoid RNG-hell; investigation tool + genome UI mandatory): community design threads via https://www.reddit.com

**Seed-economy precedent (terminator vs open-path floor):**
- EVE T2 BPO market analysis (monopoly is a misconception; accessible path sets the floor; "wealth-stratification remnant"): https://www.eveonline.com , https://www.reddit.com/r/Eve
- Terminator/GURT seed economics (sterility → repurchase dependency): https://www.etcgroup.org , https://geneticliteracyproject.org

**Repo anchors:** `crates/successor-sim/src/authority/{model.rs,crafting.rs,economy.rs,extractors.rs,authority.rs}`, `crates/successor-net/src/lib.rs`, `client/src/slice-core/specs/progression.v1.json`, `docs/{CANONICAL_CONTEXT,RESOURCE_CRAFTING_FOUNDATION}.md`.

---

## Appendix B — Named unit tests (deterministic bar, §C style)

Genetics math must meet the `extraction_math.rs` bar: milli units, worked numbers, degenerate cases, named tests. Minimum set:

- `project_agronomic_maps_loci_to_profile_exact` — Kestrel loci → `{yield_base≈35, growth_days_base≈5, water_need_milli=212, quality_potential_milli=800}` (§3.6 numbers, exact).
- `identical_inputs_yield_identical_genome_handle` — same (parents, choices, reagents, skill, tool) → same handle; content-dedup interns to one id.
- `selfing_true_breeding_parent_is_identity` — homozygous parent, 0 points, no lift → child handle == parent handle.
- `zero_points_yields_segregation_value` — `value_L == base_L` when `points_L == 0`.
- `subpar_reagent_gives_no_lift_no_penalty` — reagent stat ≤ 500 → `lift_L == 0`, `cap_L == base_L`, experimentation cannot move or degrade the locus.
- `master_top_reagent_full_points_caps_primary_line` — Gen-2 YIELD: `min(716 + 21·8, 874) == 874` (primary caps reliably; owner calibration).
- `split_points_do_not_cap_but_lift_secondaries` — Strategy B numbers (764/848/828/686), all < their caps.
- `breakthrough_requires_master_premium_fullcommit` — `brk_L == 0` unless Master ∧ reagent ≥ 900 ∧ full commit; else `== BREAKTHROUGH`.
- `heterozygous_f1_segregates_to_homozygous_elite_at_gen2` — F1 hetero alleles → Gen-2 selfing → homozygous elite → true-breeding.
- `sterile_genome_mints_no_child_seed` — `fertile=false` ⇒ `mint_harvest_seed → None`; crop still produced.
- `content_dedup_stacks_identical_seeds` — two independent identical mints share a handle and stack.
- `genome_handle_is_stable_across_replay` — sequential counter advances deterministically in tick order (replay-safe).

---

*End of design. §0 is the authoritative shared seed contract; changes require both BioEngineerLead and AgricultureLead.*
