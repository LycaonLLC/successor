//! Splice session — the Bio-Engineer creative heart (B4). Reuses the W6 craft
//! session SHAPE (slot-fill -> assemble -> per-line experiment -> mint) but is
//! FULLY DETERMINISTIC: no ai_rand assembly roll, no per-point success roll, no
//! cross-group crit-fail (the earlier sandbox design GeneticLabratory volatility we delete). Worst
//! case is a *predictable* suboptimal child. bioengineer-design.md §3.4.
//!
//! Three scarce levers make it a puzzle, not a menu (design §3.7):
//!   1. segregation — one allele per parent per locus (you cannot take everything);
//!   2. points     — capping one line abandons others this session;
//!   3. reagents   — premium culture/mutagen/stabilizer/serum ration the lift.
#![deny(clippy::float_arithmetic)]
#![cfg_attr(not(test), allow(dead_code))]

use super::*;

// ---- Slot layout: 2 parent-seed slots + 4 reagent slots (one per reagent). ----
pub(super) const SPLICE_PARENT_SLOTS: usize = 2;
pub(super) const SPLICE_REAGENT_SLOTS: usize = 4;
pub(super) const SPLICE_SLOT_COUNT: usize = SPLICE_PARENT_SLOTS + SPLICE_REAGENT_SLOTS;

// Reagent slot offsets (added to SPLICE_PARENT_SLOTS for the absolute slot index).
pub(super) const REAGENT_CULTURE: usize = 0;
pub(super) const REAGENT_MUTAGEN: usize = 1;
pub(super) const REAGENT_STABILIZER: usize = 2;
pub(super) const REAGENT_SERUM: usize = 3;

/// The reagent item id expected in each reagent slot (design §0.5 / §3.4).
pub(super) fn reagent_item_id_for_offset(offset: usize) -> u32 {
    match offset {
        REAGENT_CULTURE => CULTURE_MEDIUM_ITEM_ID,
        REAGENT_MUTAGEN => MUTAGEN_ITEM_ID,
        REAGENT_STABILIZER => STABILIZER_ITEM_ID,
        _ => SERUM_ITEM_ID,
    }
}

/// Per-locus splice descriptor: which reagent feeds its lift, and whether that
/// reagent's breakthrough is reserved for THIS locus (its one "full commit").
/// A reagent lifts every locus mapped to it, but can only break through on its
/// single primary — so Growth (culture secondary) never gets the +50 that Quality
/// (culture primary) does, exactly reproducing the §3.6 Gen-2 cap table.
#[derive(Debug, Clone, Copy)]
struct LocusSpliceDef {
    reagent_offset: usize,
    breakthrough_primary: bool,
}

const LOCUS_SPLICE: [LocusSpliceDef; GENOME_LOCUS_COUNT] = [
    // YIELD              <- mutagen  (mutagen's breakthrough primary)
    LocusSpliceDef {
        reagent_offset: REAGENT_MUTAGEN,
        breakthrough_primary: true,
    },
    // GROWTH_RATE        <- culture  (secondary; no breakthrough)
    LocusSpliceDef {
        reagent_offset: REAGENT_CULTURE,
        breakthrough_primary: false,
    },
    // WATER_ECONOMY      <- stabilizer (stabilizer's breakthrough primary)
    LocusSpliceDef {
        reagent_offset: REAGENT_STABILIZER,
        breakthrough_primary: true,
    },
    // HARDINESS          <- stabilizer (secondary)
    LocusSpliceDef {
        reagent_offset: REAGENT_STABILIZER,
        breakthrough_primary: false,
    },
    // STORM_RESISTANCE   <- stabilizer (secondary)
    LocusSpliceDef {
        reagent_offset: REAGENT_STABILIZER,
        breakthrough_primary: false,
    },
    // BLIGHT_RESISTANCE  <- serum   (serum's breakthrough primary)
    LocusSpliceDef {
        reagent_offset: REAGENT_SERUM,
        breakthrough_primary: true,
    },
    // QUALITY            <- culture (culture's breakthrough primary)
    LocusSpliceDef {
        reagent_offset: REAGENT_CULTURE,
        breakthrough_primary: true,
    },
    // REGROWTH           <- culture (secondary)
    LocusSpliceDef {
        reagent_offset: REAGENT_CULTURE,
        breakthrough_primary: false,
    },
    // SEASON             <- culture (secondary)
    LocusSpliceDef {
        reagent_offset: REAGENT_CULTURE,
        breakthrough_primary: false,
    },
    // STATURE            <- mutagen (secondary)
    LocusSpliceDef {
        reagent_offset: REAGENT_MUTAGEN,
        breakthrough_primary: false,
    },
    // MUTATION_POTENTIAL <- mutagen (secondary; meta)
    LocusSpliceDef {
        reagent_offset: REAGENT_MUTAGEN,
        breakthrough_primary: false,
    },
    // POTENCY            <- serum (secondary; meta)
    LocusSpliceDef {
        reagent_offset: REAGENT_SERUM,
        breakthrough_primary: false,
    },
    // VIGOR              <- serum (secondary; meta)
    LocusSpliceDef {
        reagent_offset: REAGENT_SERUM,
        breakthrough_primary: false,
    },
];

// ---- Balance constants (design §3.6). Owner-tunable. ----
pub(super) const SPLICE_REAGENT_LIFT_NUM: u16 = 300;
pub(super) const SPLICE_BREAKTHROUGH_MILLI: u16 = 50;
pub(super) const SPLICE_BREAKTHROUGH_REAGENT_THRESHOLD: u16 = 900;
/// Neutral reagent stat for an empty reagent slot: no lift, no penalty.
pub(super) const SPLICE_NEUTRAL_REAGENT_MILLI: u16 = 500;

// gain-per-point and base experimentation points by Splicing tier
// (0=novice .. 5=master). design §3.6.
const SPLICE_GAIN_BY_TIER: [u16; 6] = [2, 3, 4, 5, 6, 8];
const SPLICE_POINTS_BY_TIER: [u8; 6] = [8, 10, 12, 14, 16, 20];

pub(super) fn splice_gain_per_point(splicing_tier: u8) -> u16 {
    SPLICE_GAIN_BY_TIER[usize::from(splicing_tier).min(5)]
}

pub(super) fn splice_base_points(splicing_tier: u8) -> u8 {
    SPLICE_POINTS_BY_TIER[usize::from(splicing_tier).min(5)]
}

/// Deterministic assembly quality (design §3.4 step 2). Replaces craft's ai_rand
/// assembly roll with a culture-medium term: same inputs -> same assembly.
pub(super) fn splice_assembly_quality_milli(
    splice_skill_bonus: i32,
    splicer_tool_q: u16,
    culture_purity: u16,
) -> u16 {
    let tool_term = (i32::from(splicer_tool_q.min(1_000)) - 500) / 5;
    let culture_term = (i32::from(culture_purity.min(1_000)) - 500) / 5;
    let value = 350 + splice_skill_bonus / 2 + tool_term + culture_term;
    u16::try_from(value.clamp(100, 1_000)).unwrap_or(1_000)
}

/// Total experimentation points = base (skill) + an assembly-quality bonus in
/// [-4..+5] (design §3.4 step 2). Never negative.
pub(super) fn splice_points_total(base_points: u8, assembly_quality_milli: u16) -> u8 {
    let bonus = (i32::from(assembly_quality_milli.min(1_000)) - 500) / 100;
    u8::try_from((i32::from(base_points) + bonus).clamp(0, i32::from(u8::MAX))).unwrap_or(u8::MAX)
}

fn splice_express(a1: u16, a2: u16) -> u16 {
    u16::try_from((u32::from(a1) + u32::from(a2)) / 2)
        .unwrap_or(1_000)
        .min(1_000)
}

/// Master + premium + full-commit gate for the +50 breakthrough (design §3.4 step 3).
pub(super) fn splice_breakthrough_eligible(
    is_master: bool,
    reagent_stat: u16,
    breakthrough_primary: bool,
) -> bool {
    is_master && breakthrough_primary && reagent_stat >= SPLICE_BREAKTHROUGH_REAGENT_THRESHOLD
}

/// Genetic ceiling per locus (design §3.4 step 3): base + reagent lift gated by
/// mutation-potential + a master breakthrough. Premium reagent only lifts UP.
pub(super) fn splice_line_cap_milli(
    base: u16,
    reagent_stat: u16,
    mut_gate_milli: u16,
    breakthrough: bool,
) -> u16 {
    let lift = u32::from(reagent_stat.saturating_sub(500))
        .saturating_mul(u32::from(SPLICE_REAGENT_LIFT_NUM))
        / 1_000;
    let gated = lift.saturating_mul(u32::from(mut_gate_milli.min(1_000))) / 1_000;
    let brk = if breakthrough {
        u32::from(SPLICE_BREAKTHROUGH_MILLI)
    } else {
        0
    };
    u16::try_from((u32::from(base) + gated + brk).min(1_000)).unwrap_or(1_000)
}

/// Deterministic experimentation lift toward the cap (design §3.4 step 4): no
/// per-point RNG, no crit-fail. value = min(base + points*gain, cap).
pub(super) fn splice_experiment_value(base: u16, cap: u16, points: u8, gain_per_point: u16) -> u16 {
    let lifted =
        u32::from(base).saturating_add(u32::from(points).saturating_mul(u32::from(gain_per_point)));
    u16::try_from(lifted.min(u32::from(cap)))
        .unwrap_or(cap)
        .min(cap)
}

/// Choose one allele from a parent locus for segregation. `None` = default elite
/// selection (the stronger allele); `Some(0|1)` = an explicit player pick.
fn choose_allele(locus: Locus, pick: Option<u8>) -> u16 {
    match pick {
        Some(0) => locus.a1,
        Some(1) => locus.a2,
        _ => locus.elite(),
    }
}

/// Segregate a child locus: a1 from parent A, a2 from parent B (design §2.5).
pub(super) fn splice_segregate(
    parent_a: Locus,
    parent_b: Locus,
    pick_a: Option<u8>,
    pick_b: Option<u8>,
) -> Locus {
    Locus::new(
        choose_allele(parent_a, pick_a),
        choose_allele(parent_b, pick_b),
    )
}

// ---- Session state (mirrors CraftSessionState shape; model.rs holds the field). ----
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum SpliceSessionPhase {
    SlotFill,
    Assembled,
}

impl SpliceSessionPhase {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::SlotFill => 1,
            Self::Assembled => 2,
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::SlotFill => "slots",
            Self::Assembled => "assembled",
        }
    }
}

/// One filled splice slot (a parent seed in 0..2, or a reagent in 2..6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpliceSlotState {
    pub(super) slot_index: u8,
    pub(super) container: String,
    pub(super) stack_id: u64,
    pub(super) item_id: u32,
    pub(super) variant_id: u32,
}

/// One assembled per-locus experiment line (design §3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpliceLineState {
    pub(super) locus: u8,
    pub(super) label: String,
    pub(super) base_milli: u16,
    pub(super) value_milli: u16,
    pub(super) cap_milli: u16,
}

/// The splice session (design §3.4). Held on the actor exactly like `craft_session`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SpliceSessionState {
    pub(super) species_id: u32,
    pub(super) phase: SpliceSessionPhase,
    pub(super) slots: Vec<Option<SpliceSlotState>>,
    /// Per-locus segregation overrides: locus -> (pick from A, pick from B).
    pub(super) allele_choices: BTreeMap<u8, (Option<u8>, Option<u8>)>,
    pub(super) assembly_quality_milli: u16,
    pub(super) points_total: u8,
    pub(super) points_remaining: u8,
    pub(super) gain_per_point: u16,
    /// The segregated child (pre-experimentation alleles); set at assemble.
    pub(super) child_alleles: Vec<Locus>,
    pub(super) lines: Vec<SpliceLineState>,
    pub(super) parent_handles: [u32; 2],
    pub(super) child_generation: u16,
}

impl SpliceSessionState {
    pub(super) fn new(species_id: u32) -> Self {
        Self {
            species_id,
            phase: SpliceSessionPhase::SlotFill,
            slots: vec![None; SPLICE_SLOT_COUNT],
            allele_choices: BTreeMap::new(),
            assembly_quality_milli: 0,
            points_total: 0,
            points_remaining: 0,
            gain_per_point: 0,
            child_alleles: Vec::new(),
            lines: Vec::new(),
            parent_handles: [0, 0],
            child_generation: 0,
        }
    }

    pub(super) fn line(&self, locus: u8) -> Option<&SpliceLineState> {
        self.lines.iter().find(|line| line.locus == locus)
    }
}

/// Splice inputs derived from the actor's skill + tools + reagents (design §3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SpliceContext {
    pub(super) splice_skill_bonus: i32,
    pub(super) splicing_tier: u8,
    pub(super) is_master: bool,
    pub(super) splicer_tool_q: u16,
    /// Reagent potency by offset: [culture, mutagen, stabilizer, serum].
    pub(super) reagent_potency: [u16; SPLICE_REAGENT_SLOTS],
}

/// The deterministic locus label used in the session snapshot + timeline.
pub(super) fn locus_label(locus: usize) -> &'static str {
    match locus {
        LOCUS_YIELD => "yield",
        LOCUS_GROWTH_RATE => "growth_rate",
        LOCUS_WATER_ECONOMY => "water_economy",
        LOCUS_HARDINESS => "hardiness",
        LOCUS_STORM_RESISTANCE => "storm_resistance",
        LOCUS_BLIGHT_RESISTANCE => "blight_resistance",
        LOCUS_QUALITY => "quality",
        LOCUS_REGROWTH => "regrowth",
        LOCUS_SEASON => "season_affinity",
        LOCUS_STATURE => "stature",
        LOCUS_MUTATION_POTENTIAL => "mutation_potential",
        LOCUS_POTENCY => "potency",
        _ => "vigor",
    }
}

/// Assemble the child (segregation + per-locus base/cap) deterministically.
/// PURE over the parent genomes + choices + context — the command handler simply
/// resolves parents from the registry and reagent potencies from slots, then
/// calls this. Returns the segregated child alleles + the assembled lines.
pub(super) fn splice_assemble_core(
    parent_a: &Genome,
    parent_b: &Genome,
    choices: &BTreeMap<u8, (Option<u8>, Option<u8>)>,
    ctx: &SpliceContext,
) -> (Vec<Locus>, Vec<SpliceLineState>, u16, u8, u16) {
    let assembly_q = splice_assembly_quality_milli(
        ctx.splice_skill_bonus,
        ctx.splicer_tool_q,
        ctx.reagent_potency[REAGENT_CULTURE],
    );
    let points_total = splice_points_total(splice_base_points(ctx.splicing_tier), assembly_q);
    let gain = splice_gain_per_point(ctx.splicing_tier);

    let mut child_alleles = Vec::with_capacity(GENOME_LOCUS_COUNT);
    let mut lines = Vec::with_capacity(GENOME_LOCUS_COUNT);
    for (locus, def) in LOCUS_SPLICE.iter().copied().enumerate() {
        let (pick_a, pick_b) = choices
            .get(&u8::try_from(locus).unwrap_or(0))
            .copied()
            .unwrap_or((None, None));
        let child = splice_segregate(parent_a.loci[locus], parent_b.loci[locus], pick_a, pick_b);
        let base = splice_express(child.a1, child.a2);
        let reagent_stat = ctx.reagent_potency[def.reagent_offset];
        // mutation-potential gate: expressed on the CHILD's mutation_potential locus.
        let mut_gate = splice_segregate(
            parent_a.loci[LOCUS_MUTATION_POTENTIAL],
            parent_b.loci[LOCUS_MUTATION_POTENTIAL],
            None,
            None,
        );
        let mut_gate_milli = splice_express(mut_gate.a1, mut_gate.a2);
        let breakthrough =
            splice_breakthrough_eligible(ctx.is_master, reagent_stat, def.breakthrough_primary);
        let cap = splice_line_cap_milli(base, reagent_stat, mut_gate_milli, breakthrough);
        child_alleles.push(child);
        lines.push(SpliceLineState {
            locus: u8::try_from(locus).unwrap_or(0),
            label: locus_label(locus).to_owned(),
            base_milli: base,
            value_milli: base,
            cap_milli: cap,
        });
    }
    (child_alleles, lines, assembly_q, points_total, gain)
}

/// Fold a finished session's experiment values back into the child genome: raise
/// BOTH alleles by (value - base) per locus so zygosity is preserved (§2.5) and
/// express() equals the achieved value. Returns the final child alleles.
pub(super) fn splice_mint_alleles(session: &SpliceSessionState) -> Vec<Locus> {
    session
        .child_alleles
        .iter()
        .enumerate()
        .map(|(index, child)| {
            let delta = session
                .line(u8::try_from(index).unwrap_or(0))
                .map(|line| line.value_milli.saturating_sub(line.base_milli))
                .unwrap_or(0);
            // Clamp to the documented 0..=1000 milli domain so lifted alleles never
            // leave out-of-domain values in scans / content keys / the stable hash (P2-3).
            Locus::new(
                child.a1.saturating_add(delta).min(1_000),
                child.a2.saturating_add(delta).min(1_000),
            )
        })
        .collect()
}

// ---- Public snapshot VMs (receipt/bridge; mirror the craft-session VM shape). ----

/// A pub, wire-facing mirror of the pub(super) `AgronomicProfile` so the scan VM
/// can ship the projected phenotype without leaking the internal type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAgronomicProfileSnapshot {
    pub growth_days_base: u16,
    pub water_need_milli: u16,
    pub yield_base: u32,
    pub hardiness_milli: u16,
    pub season_affinity: u8,
    pub off_season_penalty_milli: u16,
    pub storm_resistance_milli: u16,
    pub blight_resistance_milli: u16,
    pub regrowth_days: u16,
    pub tile_footprint: u8,
    pub quality_potential_milli: u16,
}

impl From<AgronomicProfile> for AuthorityAgronomicProfileSnapshot {
    fn from(profile: AgronomicProfile) -> Self {
        Self {
            growth_days_base: profile.growth_days_base,
            water_need_milli: profile.water_need_milli,
            yield_base: profile.yield_base,
            hardiness_milli: profile.hardiness_milli,
            season_affinity: profile.season_affinity,
            off_season_penalty_milli: profile.off_season_penalty_milli,
            storm_resistance_milli: profile.storm_resistance_milli,
            blight_resistance_milli: profile.blight_resistance_milli,
            regrowth_days: profile.regrowth_days,
            tile_footprint: profile.tile_footprint,
            quality_potential_milli: profile.quality_potential_milli,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySpliceSlotSnapshot {
    pub slot_index: u8,
    /// "parent" for slots 0..2, "reagent" for 2..6.
    pub kind: String,
    pub label: String,
    pub filled: bool,
    pub item_id: u32,
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySpliceLineSnapshot {
    pub locus: u8,
    pub label: String,
    pub base_milli: u16,
    pub value_milli: u16,
    pub cap_milli: u16,
    pub can_raise: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySpliceSessionSnapshot {
    pub phase: String,
    pub species_id: u32,
    pub species_name: String,
    pub slots: Vec<AuthoritySpliceSlotSnapshot>,
    pub lines: Vec<AuthoritySpliceLineSnapshot>,
    pub assembly_quality_milli: u16,
    pub points_total: u8,
    pub points_remaining: u8,
    pub can_assemble: bool,
    pub tick: u64,
}

/// One locus row of a genome scan, tier-gated (design §3.3). `heterozygous` is
/// revealed at Sequencing I-II; exact `a1`/`a2` at Sequencing III+.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGenomeScanLocusSnapshot {
    pub locus: u8,
    pub label: String,
    pub express_milli: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heterozygous: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a1: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a2: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGenomeScanSnapshot {
    pub item_id: u32,
    pub variant_id: u32,
    pub species_name: String,
    pub cultivar_name: String,
    pub tier: String,
    pub fertile: bool,
    pub profile: AuthorityAgronomicProfileSnapshot,
    pub loci: Vec<AuthorityGenomeScanLocusSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mutation_potential_milli: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub breeder_id: Option<String>,
    /// Parent genome handles (0 = wild/none), revealed at Full tier — the B5
    /// provenance surface (§3.3 "full ancestry"). Makes lineage readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parents: Option<[u32; 2]>,
    /// Parent cultivar names for the non-wild parents (resolved from the registry),
    /// so the reveal reads "bred from Dustline × Verdant-9", not raw handles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_cultivars: Option<Vec<String>>,
    pub tick: u64,
}

// ---- Command handlers (server-authoritative; mirror the craft command lane). ----
impl SliceAuthorityState {
    fn ready_bio_actor(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Result<ActorAuthorityState, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        Ok(actor.clone())
    }

    fn actor_holds_bio_item(&self, actor_id: &str, item_id: u32) -> bool {
        self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == item_id
                && row.available > 0
                && actor_owns_inventory_container(actor_id, &row.container)
        })
    }

    /// The held tool's quality, encoded in its variant_id like the field multitool.
    fn actor_bio_tool_quality_milli(&self, actor_id: &str, item_id: u32) -> u16 {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| u16::try_from(row.variant_id.min(1_000)).unwrap_or(500))
            .max()
            .unwrap_or(500)
    }

    fn find_actor_stack_exact(
        &self,
        actor_id: &str,
        container: &str,
        stack_id: u64,
        variant_id: u32,
    ) -> Option<InventoryStackSnapshot> {
        self.runtime
            .durable
            .inventory
            .iter()
            .find(|row| {
                row.container == container
                    && row.stack_id == stack_id
                    && row.variant_id == variant_id
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .cloned()
    }

    fn splice_context_for(
        &self,
        actor: &ActorAuthorityState,
        session: &SpliceSessionState,
    ) -> SpliceContext {
        let mut reagent_potency = [SPLICE_NEUTRAL_REAGENT_MILLI; SPLICE_REAGENT_SLOTS];
        for (offset, potency) in reagent_potency.iter_mut().enumerate() {
            if let Some(Some(slot)) = session.slots.get(SPLICE_PARENT_SLOTS + offset) {
                *potency = u16::try_from(slot.variant_id.min(1_000)).unwrap_or(500);
            }
        }
        SpliceContext {
            splice_skill_bonus: actor.professions.bioengineer_splice_skill_bonus(),
            splicing_tier: actor.professions.bioengineer_splicing_tier(),
            is_master: actor.professions.bioengineer_is_master(),
            splicer_tool_q: self.actor_bio_tool_quality_milli(&actor.id, SPLICE_BENCH_ITEM_ID),
            reagent_potency,
        }
    }

    /// B3 Acquire: sample a deterministic wild-flora landrace seed (§3.2).
    pub(super) fn apply_gene_sample(
        &mut self,
        config: &SliceAuthorityConfig,
        species: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        if !self.actor_holds_bio_item(&actor.id, GENE_SAMPLER_ITEM_ID) {
            return Err(AuthorityRejectReason::MissingGeneSampler);
        }
        let species = crop_species_by_key(species)
            .copied()
            .ok_or(AuthorityRejectReason::UnknownCropSpecies)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        let epoch = self.runtime.durable.tick / RESOURCE_SPAWN_EPOCH_TICKS;
        let genome =
            wild_landrace_genome(&species, &actor.area_id, epoch, self.runtime.durable.tick);
        let cultivar = genome.lineage.cultivar_name.clone();
        let handle = self.runtime.durable.crop_genomes.intern(genome);
        let sequencing_tier = actor.professions.bioengineer_sequencing_tier();
        let qty = 1 + u32::from(sequencing_tier);
        let item_name =
            inventory_item_name(species.item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        let stack_cap = Self::inventory_stack_cap_for_item(species.item_id, BIO_SEED_STACK_CAP);
        self.add_actor_inventory_stack(
            &actor.id,
            species.item_id,
            handle,
            item_name,
            qty,
            stack_cap,
            "field-pack",
        );
        self.set_actor_economy_action_cooldown(&actor.id, BIO_SAMPLE_ACTION_MS)?;
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::BioEngineer,
            "sequencing",
            BIO_XP_PER_SAMPLE,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} sampled wild {} '{}' (handle {handle}, +{BIO_XP_PER_SAMPLE} Sequencing XP, total {total_xp})",
                actor.id, species.name, cultivar
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    /// B3 Analyze: reveal a seed's genome, tier-gated by the Sequencing track (§3.3).
    pub(super) fn apply_scan_genome(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        if !self.actor_holds_bio_item(&actor.id, GENOME_SCANNER_ITEM_ID) {
            return Err(AuthorityRejectReason::MissingGenomeScanner);
        }
        let parsed_stack_id =
            parse_bio_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let row = self
            .find_actor_stack_exact(&actor.id, container, parsed_stack_id, variant_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if !is_crop_seed_item_id(row.item_id) {
            return Err(AuthorityRejectReason::GenomeUnavailable);
        }
        let genome = self
            .runtime
            .durable
            .crop_genomes
            .resolve(row.item_id, variant_id)
            .ok_or(AuthorityRejectReason::GenomeUnavailable)?
            .clone();
        let tier =
            GenomeScanTier::from_sequencing_tier(actor.professions.bioengineer_sequencing_tier());
        let newly_scanned = {
            let live = self
                .runtime
                .durable
                .actors
                .get_mut(&actor.id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            live.scanned_genomes.insert(variant_id)
        };
        // Earned-information XP only when the scan reveals something new (§1.4).
        if newly_scanned {
            self.award_profession_track_xp(
                &actor.id,
                AuthorityProfessionKind::BioEngineer,
                "sequencing",
                BIO_XP_PER_SCAN,
            )?;
        }
        self.runtime.pending_genome_scan =
            Some(self.genome_scan_snapshot(row.item_id, variant_id, &genome, tier));
        Ok(())
    }

    /// B4: open a splice session at a splice bench (§3.8).
    pub(super) fn apply_splice_begin(
        &mut self,
        config: &SliceAuthorityConfig,
        species: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        if actor.splice_session.is_some() {
            return Err(AuthorityRejectReason::SpliceSessionActive);
        }
        if !actor.professions.has_skill_box("bioengineer-novice") {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if !self.actor_holds_bio_item(&actor.id, SPLICE_BENCH_ITEM_ID) {
            return Err(AuthorityRejectReason::MissingSpliceBench);
        }
        let species = crop_species_by_key(species)
            .copied()
            .ok_or(AuthorityRejectReason::UnknownCropSpecies)?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        live.splice_session = Some(SpliceSessionState::new(species.item_id));
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} opened a splice session for {}", actor.id, species.name),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_splice_session(config);
        Ok(())
    }

    pub(super) fn apply_splice_assign_slot(
        &mut self,
        config: &SliceAuthorityConfig,
        slot_index: u8,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        let session = actor
            .splice_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        if session.phase != SpliceSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::SpliceAlreadyAssembled);
        }
        let index = usize::from(slot_index);
        if index >= SPLICE_SLOT_COUNT {
            return Err(AuthorityRejectReason::SpliceSlotMismatch);
        }
        let parsed_stack_id =
            parse_bio_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let row = self
            .find_actor_stack_exact(&actor.id, container, parsed_stack_id, variant_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        // Parent slots take a crop seed of the session species; reagent slots take
        // the reagent item mapped to that offset (§3.4).
        if index < SPLICE_PARENT_SLOTS {
            if row.item_id != session.species_id {
                return Err(AuthorityRejectReason::SpliceSlotMismatch);
            }
            if self
                .runtime
                .durable
                .crop_genomes
                .resolve(row.item_id, variant_id)
                .is_none()
            {
                return Err(AuthorityRejectReason::GenomeUnavailable);
            }
        } else {
            let expected = reagent_item_id_for_offset(index - SPLICE_PARENT_SLOTS);
            if row.item_id != expected {
                return Err(AuthorityRejectReason::SpliceSlotMismatch);
            }
        }
        let assignment = SpliceSlotState {
            slot_index,
            container: row.container,
            stack_id: row.stack_id,
            item_id: row.item_id,
            variant_id: row.variant_id,
        };
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .splice_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        live_session.slots[index] = Some(assignment);
        self.publish_splice_session(config);
        Ok(())
    }

    pub(super) fn apply_splice_clear_slot(
        &mut self,
        config: &SliceAuthorityConfig,
        slot_index: u8,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let session = live
            .splice_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        if session.phase != SpliceSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::SpliceAlreadyAssembled);
        }
        let slot = session
            .slots
            .get_mut(usize::from(slot_index))
            .ok_or(AuthorityRejectReason::SpliceSlotMismatch)?;
        *slot = None;
        self.publish_splice_session(config);
        Ok(())
    }

    /// Directed segregation choice: which allele to take from each parent (§2.5).
    pub(super) fn apply_splice_choose_allele(
        &mut self,
        config: &SliceAuthorityConfig,
        locus: u8,
        from_parent: u8,
        allele: u8,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        if usize::from(locus) >= GENOME_LOCUS_COUNT {
            return Err(AuthorityRejectReason::InvalidSpliceLocus);
        }
        if from_parent > 1 || allele > 1 {
            return Err(AuthorityRejectReason::SpliceSlotMismatch);
        }
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let session = live
            .splice_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        if session.phase != SpliceSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::SpliceAlreadyAssembled);
        }
        let entry = session.allele_choices.entry(locus).or_insert((None, None));
        if from_parent == 0 {
            entry.0 = Some(allele);
        } else {
            entry.1 = Some(allele);
        }
        self.publish_splice_session(config);
        Ok(())
    }

    pub(super) fn apply_splice_assemble(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        let session = actor
            .splice_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?
            .clone();
        if session.phase != SpliceSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::SpliceAlreadyAssembled);
        }
        let parent_slot_a = session.slots[0]
            .as_ref()
            .ok_or(AuthorityRejectReason::SpliceSlotMismatch)?;
        let parent_slot_b = session.slots[1]
            .as_ref()
            .ok_or(AuthorityRejectReason::SpliceSlotMismatch)?;
        let parent_a = self
            .runtime
            .durable
            .crop_genomes
            .resolve(parent_slot_a.item_id, parent_slot_a.variant_id)
            .ok_or(AuthorityRejectReason::GenomeUnavailable)?
            .clone();
        let parent_b = self
            .runtime
            .durable
            .crop_genomes
            .resolve(parent_slot_b.item_id, parent_slot_b.variant_id)
            .ok_or(AuthorityRejectReason::GenomeUnavailable)?
            .clone();
        let ctx = self.splice_context_for(&actor, &session);
        // Validate + consume inputs (point of no return, like craft assemble):
        // one seed per parent slot, one reagent per filled reagent slot. Aggregate
        // the cumulative demand per (item_id, variant_id) FIRST and validate the
        // whole set before consuming any — selfing assigns the same seed variant to
        // both parent slots, so a per-slot check could pass while the total exceeds
        // stock and burn the first seed on reject (P1-3, all-or-nothing).
        let mut splice_demand: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        for slot in session.slots.iter().flatten() {
            *splice_demand
                .entry((slot.item_id, slot.variant_id))
                .or_insert(0) += 1;
        }
        for (&(item_id, variant_id), &need) in &splice_demand {
            if self.actor_inventory_available_variant(&actor.id, item_id, variant_id) < need {
                return Err(AuthorityRejectReason::IngredientUnavailable);
            }
        }
        for (&(item_id, variant_id), &need) in &splice_demand {
            self.consume_actor_inventory_variant(&actor.id, item_id, variant_id, need)?;
        }
        let (child_alleles, lines, assembly_q, points_total, gain) =
            splice_assemble_core(&parent_a, &parent_b, &session.allele_choices, &ctx);
        let child_generation = parent_a
            .lineage
            .generation
            .max(parent_b.lineage.generation)
            .saturating_add(1);
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::BioEngineer,
            "splicing",
            BIO_XP_PER_SPLICE_ASSEMBLE,
        )?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .splice_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        live_session.phase = SpliceSessionPhase::Assembled;
        live_session.assembly_quality_milli = assembly_q;
        live_session.points_total = points_total;
        live_session.points_remaining = points_total;
        live_session.gain_per_point = gain;
        live_session.child_alleles = child_alleles;
        live_session.lines = lines;
        live_session.parent_handles = [parent_slot_a.variant_id, parent_slot_b.variant_id];
        live_session.child_generation = child_generation;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} assembled a splice (assembly {assembly_q}, {points_total} points, +{BIO_XP_PER_SPLICE_ASSEMBLE} Splicing XP, total {total_xp})",
                actor.id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_splice_session(config);
        Ok(())
    }

    pub(super) fn apply_splice_experiment_locus(
        &mut self,
        config: &SliceAuthorityConfig,
        locus: u8,
        points: u8,
    ) -> Result<(), AuthorityRejectReason> {
        if points == 0 {
            return Err(AuthorityRejectReason::InvalidSpliceExperiment);
        }
        let actor = self.ready_bio_actor(config)?;
        let session = actor
            .splice_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        if session.phase != SpliceSessionPhase::Assembled {
            return Err(AuthorityRejectReason::SpliceNotAssembled);
        }
        if points > session.points_remaining {
            return Err(AuthorityRejectReason::InvalidSpliceExperiment);
        }
        let gain = session.gain_per_point;
        let line = session
            .line(locus)
            .ok_or(AuthorityRejectReason::InvalidSpliceLocus)?;
        if line.value_milli >= line.cap_milli {
            return Err(AuthorityRejectReason::InvalidSpliceExperiment);
        }
        let new_value = splice_experiment_value(line.value_milli, line.cap_milli, points, gain);
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::BioEngineer,
            "splicing",
            BIO_XP_PER_SPLICE_POINT.saturating_mul(u64::from(points)),
        )?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .splice_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?;
        let live_line = live_session
            .lines
            .iter_mut()
            .find(|line| line.locus == locus)
            .ok_or(AuthorityRejectReason::InvalidSpliceLocus)?;
        live_line.value_milli = new_value;
        live_session.points_remaining = live_session.points_remaining.saturating_sub(points);
        let _ = total_xp;
        self.publish_splice_session(config);
        Ok(())
    }

    /// Mint the child genome into the registry and hand the seed to the breeder (§3.4).
    pub(super) fn apply_splice_mint(
        &mut self,
        config: &SliceAuthorityConfig,
        cultivar_name: Option<&str>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        let session = actor
            .splice_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoSpliceSession)?
            .clone();
        if session.phase != SpliceSessionPhase::Assembled {
            return Err(AuthorityRejectReason::SpliceNotAssembled);
        }
        let lifted = splice_mint_alleles(&session);
        if lifted.len() != GENOME_LOCUS_COUNT {
            return Err(AuthorityRejectReason::SpliceNotAssembled);
        }
        let mut loci = [Locus::homozygous(0); GENOME_LOCUS_COUNT];
        for (index, locus) in lifted.into_iter().enumerate() {
            loci[index] = locus;
        }
        let cultivar = cultivar_name
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| minted_cultivar_name(session.species_id, &loci));
        // A spliced child inherits sterility from EITHER parent: a sterile /
        // gene-locked parent can never launder its genetics into a fertile child
        // (closes the terminator invariant across breeding, P1-2). Handle 0 = no
        // parent, which contributes no sterility.
        let child_fertile = session.parent_handles.iter().all(|&handle| {
            handle == 0
                || self
                    .runtime
                    .durable
                    .crop_genomes
                    .get(handle)
                    .map(|parent| parent.fertile)
                    .unwrap_or(true)
        });
        let genome = Genome {
            species_id: session.species_id,
            loci,
            fertile: child_fertile,
            gene_lock: None,
            lineage: Lineage {
                breeder_id: actor.id.clone(),
                cultivar_name: cultivar.clone(),
                generation: session.child_generation,
                parents: session.parent_handles,
            },
        };
        let handle = self.runtime.durable.crop_genomes.intern(genome);
        let item_name =
            inventory_item_name(session.species_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        let stack_cap = Self::inventory_stack_cap_for_item(session.species_id, BIO_SEED_STACK_CAP);
        self.add_actor_inventory_stack(
            &actor.id,
            session.species_id,
            handle,
            item_name,
            SPLICE_MINT_SEED_QTY,
            stack_cap,
            "field-pack",
        );
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::BioEngineer,
            "splicing",
            BIO_XP_PER_SPLICE_MINT,
        )?;
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.splice_session = None;
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} minted cultivar '{cultivar}' (handle {handle}, gen {}, +{BIO_XP_PER_SPLICE_MINT} Splicing XP, total {total_xp})",
                actor.id, session.child_generation
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_splice_session(config);
        Ok(())
    }

    pub(super) fn apply_splice_cancel(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_bio_actor(config)?;
        let had_assembled = actor
            .splice_session
            .as_ref()
            .map(|session| session.phase == SpliceSessionPhase::Assembled)
            .unwrap_or(false);
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.splice_session = None;
        }
        let note = if had_assembled {
            " after assembly; consumed inputs are not returned"
        } else {
            " before assembly"
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} cancelled the splice session{note}", actor.id),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_splice_session(config);
        Ok(())
    }

    fn genome_scan_snapshot(
        &self,
        item_id: u32,
        variant_id: u32,
        genome: &Genome,
        tier: GenomeScanTier,
    ) -> AuthorityGenomeScanSnapshot {
        let species_name = crop_species_by_item_id(item_id)
            .map(|species| species.name.to_owned())
            .unwrap_or_else(|| "Unknown".to_owned());
        let reveal_presence = !matches!(tier, GenomeScanTier::Phenotype);
        let reveal_alleles = matches!(tier, GenomeScanTier::AlleleValues | GenomeScanTier::Full);
        let reveal_full = matches!(tier, GenomeScanTier::Full);
        let loci = genome
            .loci
            .iter()
            .enumerate()
            .map(|(index, locus)| AuthorityGenomeScanLocusSnapshot {
                locus: u8::try_from(index).unwrap_or(0),
                label: locus_label(index).to_owned(),
                express_milli: locus.express(),
                heterozygous: reveal_presence.then_some(locus.heterozygous()),
                a1: reveal_alleles.then_some(locus.a1),
                a2: reveal_alleles.then_some(locus.a2),
            })
            .collect();
        AuthorityGenomeScanSnapshot {
            item_id,
            variant_id,
            species_name,
            cultivar_name: genome.lineage.cultivar_name.clone(),
            tier: scan_tier_label(tier).to_owned(),
            fertile: genome.fertile,
            profile: project_agronomic(genome).into(),
            loci,
            mutation_potential_milli: reveal_full
                .then(|| genome.loci[LOCUS_MUTATION_POTENTIAL].express()),
            generation: reveal_full.then_some(genome.lineage.generation),
            breeder_id: reveal_full
                .then(|| genome.lineage.breeder_id.clone())
                .filter(|id| !id.is_empty()),
            parents: reveal_full.then_some(genome.lineage.parents),
            parent_cultivars: reveal_full.then(|| {
                genome
                    .lineage
                    .parents
                    .iter()
                    .filter(|handle| **handle != 0)
                    .filter_map(|handle| self.runtime.durable.crop_genomes.get(*handle))
                    .map(|parent| parent.lineage.cultivar_name.clone())
                    .collect::<Vec<_>>()
            }),
            tick: self.runtime.durable.tick,
        }
    }

    pub(crate) fn splice_session_snapshot_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<AuthoritySpliceSessionSnapshot> {
        let actor = self.runtime.durable.actors.get(&config.player_actor_id)?;
        let Some(session) = actor.splice_session.as_ref() else {
            return Some(AuthoritySpliceSessionSnapshot {
                phase: "browse".to_owned(),
                species_id: 0,
                species_name: String::new(),
                slots: Vec::new(),
                lines: Vec::new(),
                assembly_quality_milli: 0,
                points_total: 0,
                points_remaining: 0,
                can_assemble: false,
                tick: self.runtime.durable.tick,
            });
        };
        let species_name = crop_species_by_item_id(session.species_id)
            .map(|species| species.name.to_owned())
            .unwrap_or_default();
        let slots = session
            .slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                let is_parent = index < SPLICE_PARENT_SLOTS;
                let label = if is_parent {
                    format!("parent {}", index + 1)
                } else {
                    reagent_label(index - SPLICE_PARENT_SLOTS).to_owned()
                };
                AuthoritySpliceSlotSnapshot {
                    slot_index: u8::try_from(index).unwrap_or(0),
                    kind: if is_parent { "parent" } else { "reagent" }.to_owned(),
                    label,
                    filled: slot.is_some(),
                    item_id: slot.as_ref().map(|s| s.item_id).unwrap_or(0),
                    variant_id: slot.as_ref().map(|s| s.variant_id).unwrap_or(0),
                }
            })
            .collect();
        let lines = session
            .lines
            .iter()
            .map(|line| AuthoritySpliceLineSnapshot {
                locus: line.locus,
                label: line.label.clone(),
                base_milli: line.base_milli,
                value_milli: line.value_milli,
                cap_milli: line.cap_milli,
                can_raise: line.value_milli < line.cap_milli && session.points_remaining > 0,
            })
            .collect();
        let can_assemble = session.phase == SpliceSessionPhase::SlotFill
            && session.slots[0].is_some()
            && session.slots[1].is_some();
        Some(AuthoritySpliceSessionSnapshot {
            phase: session.phase.label().to_owned(),
            species_id: session.species_id,
            species_name,
            slots,
            lines,
            assembly_quality_milli: session.assembly_quality_milli,
            points_total: session.points_total,
            points_remaining: session.points_remaining,
            can_assemble,
            tick: self.runtime.durable.tick,
        })
    }

    fn publish_splice_session(&mut self, config: &SliceAuthorityConfig) {
        self.runtime.pending_splice_session = self.splice_session_snapshot_for_observer(config);
    }

    /// Idempotent Bio-Engineer novice grant (design §1.5): Gene Sampler + Genome
    /// Scanner + Splice Bench + a fixed low-tier fertile Starter Seed Packet.
    pub(super) fn ensure_actor_bioengineer_novice_kit(&mut self, actor_id: &str) {
        for (item_id, name) in [
            (GENE_SAMPLER_ITEM_ID, "Gene Sampler"),
            (GENOME_SCANNER_ITEM_ID, "Genome Scanner"),
            (SPLICE_BENCH_ITEM_ID, "Splice Bench"),
        ] {
            if !self.actor_holds_bio_item(actor_id, item_id) {
                self.add_actor_inventory_stack(
                    actor_id,
                    item_id,
                    BIO_STARTER_TOOL_QUALITY_MILLI,
                    name,
                    1,
                    1,
                    "field-pack",
                );
            }
        }
        // Starter Seed Packet: a fixed fertile Ashgrain landrace (no RNG wall).
        if !self.actor_holds_bio_item(actor_id, CROP_ASHGRAIN_ITEM_ID) {
            let handle = self
                .runtime
                .durable
                .crop_genomes
                .intern(bio_starter_genome());
            if let Some(name) = inventory_item_name(CROP_ASHGRAIN_ITEM_ID) {
                self.add_actor_inventory_stack(
                    actor_id,
                    CROP_ASHGRAIN_ITEM_ID,
                    handle,
                    name,
                    BIO_STARTER_SEED_PACKET_QTY,
                    BIO_SEED_STACK_CAP,
                    "field-pack",
                );
            }
        }
    }
}

fn parse_bio_stack_id(value: &str) -> Option<u64> {
    let stack_id = value.trim().parse::<u64>().ok()?;
    (stack_id > 0).then_some(stack_id)
}

fn reagent_label(offset: usize) -> &'static str {
    match offset {
        REAGENT_CULTURE => "culture medium",
        REAGENT_MUTAGEN => "mutagen",
        REAGENT_STABILIZER => "stabilizer",
        _ => "serum",
    }
}

fn scan_tier_label(tier: GenomeScanTier) -> &'static str {
    match tier {
        GenomeScanTier::Phenotype => "phenotype",
        GenomeScanTier::HiddenPresence => "hidden_presence",
        GenomeScanTier::AlleleValues => "allele_values",
        GenomeScanTier::Full => "full",
    }
}

/// Deterministic auto-generated cultivar name from the minted genome content.
fn minted_cultivar_name(species_id: u32, loci: &[Locus; GENOME_LOCUS_COUNT]) -> String {
    let mut hash = species_id;
    for locus in loci {
        hash ^= (u32::from(locus.a1) << 16) ^ u32::from(locus.a2);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    wild_cultivar_name(hash)
}

/// A fixed, deterministic low-tier fertile Ashgrain the trainer packet grants.
fn bio_starter_genome() -> Genome {
    let species = &CROP_SPECIES[0]; // Ashgrain
    let mut loci = [Locus::homozygous(440); GENOME_LOCUS_COUNT];
    loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(species.mutation_potential_base);
    loci[LOCUS_VIGOR] = Locus::homozygous(500);
    loci[LOCUS_REGROWTH] = Locus::homozygous(0);
    Genome {
        species_id: species.item_id,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage::wild("Homestead".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Worked-example parents (design §3.6). Only the four cited loci carry
    // meaningful values; the rest are parked (they "carry along identically").
    fn dustline() -> Genome {
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_YIELD] = Locus::new(420, 460);
        loci[LOCUS_GROWTH_RATE] = Locus::new(610, 650);
        loci[LOCUS_WATER_ECONOMY] = Locus::new(720, 780);
        loci[LOCUS_QUALITY] = Locus::new(300, 340);
        loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(800); // Ashgrain mut_gate 0.8
        Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("Dustline".to_owned()),
        }
    }

    fn verdant9() -> Genome {
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_YIELD] = Locus::new(700, 540); // hides elite 700
        loci[LOCUS_GROWTH_RATE] = Locus::new(400, 380);
        loci[LOCUS_WATER_ECONOMY] = Locus::new(260, 300);
        loci[LOCUS_QUALITY] = Locus::new(780, 760);
        loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(800);
        Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("Verdant-9".to_owned()),
        }
    }

    fn no_choices() -> BTreeMap<u8, (Option<u8>, Option<u8>)> {
        BTreeMap::new()
    }

    #[test]
    fn assembly_quality_and_points_match_worked_example() {
        // G1 mid-skill (design §3.6): skill 120, tool 600, culture 600.
        assert_eq!(splice_assembly_quality_milli(120, 600, 600), 450);
        assert_eq!(splice_points_total(12, 450), 12); // Splicing II base 12
                                                      // G2 master: skill 300, tool 950, culture 940.
        assert_eq!(splice_assembly_quality_milli(300, 950, 940), 678);
        assert_eq!(splice_points_total(20, 678), 21); // master base 20
    }

    #[test]
    fn generation_one_reproduces_f1_exactly() {
        // design §3.6 Gen-1: Dustline x Verdant-9, Splicing II, mid reagents.
        let ctx = SpliceContext {
            splice_skill_bonus: 120,
            splicing_tier: 2, // Splicing II
            is_master: false,
            splicer_tool_q: 600,
            reagent_potency: [600, 650, 640, 500], // culture, mutagen, stabilizer, serum
        };
        let (child, lines, assembly_q, points_total, gain) =
            splice_assemble_core(&dustline(), &verdant9(), &no_choices(), &ctx);
        assert_eq!(assembly_q, 450);
        assert_eq!(points_total, 12);
        assert_eq!(gain, 4);
        // Default elite selection reproduces the doc's child alleles.
        assert_eq!(child[LOCUS_YIELD], Locus::new(460, 700));
        assert_eq!(child[LOCUS_GROWTH_RATE], Locus::new(650, 400));
        assert_eq!(child[LOCUS_WATER_ECONOMY], Locus::new(780, 300));
        assert_eq!(child[LOCUS_QUALITY], Locus::new(340, 780));
        // Bases and caps, exact.
        let l = |locus: usize| lines[locus].clone();
        assert_eq!(
            (l(LOCUS_YIELD).base_milli, l(LOCUS_YIELD).cap_milli),
            (580, 616)
        );
        assert_eq!(
            (
                l(LOCUS_GROWTH_RATE).base_milli,
                l(LOCUS_GROWTH_RATE).cap_milli
            ),
            (525, 549)
        );
        assert_eq!(
            (
                l(LOCUS_WATER_ECONOMY).base_milli,
                l(LOCUS_WATER_ECONOMY).cap_milli
            ),
            (540, 573)
        );
        assert_eq!(
            (l(LOCUS_QUALITY).base_milli, l(LOCUS_QUALITY).cap_milli),
            (560, 584)
        );
        // Point spend YIELD 4 / GROWTH 1 / WATER 2 / QUALITY 5 (sums to 12) -> F1 values.
        assert_eq!(splice_experiment_value(580, 616, 4, gain), 596);
        assert_eq!(splice_experiment_value(525, 549, 1, gain), 529);
        assert_eq!(splice_experiment_value(540, 573, 2, gain), 548);
        assert_eq!(splice_experiment_value(560, 584, 5, gain), 580);
    }

    // Build the F1 stepping-stone genome from Gen-1 (post-lift alleles: both
    // alleles raised by value-base, preserving zygosity, design §2.5 / §3.6).
    fn ashgrain_f1() -> Genome {
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_YIELD] = Locus::new(476, 716); // 460/700 + 16
        loci[LOCUS_GROWTH_RATE] = Locus::new(654, 404); // 650/400 + 4
        loci[LOCUS_WATER_ECONOMY] = Locus::new(788, 308); // 780/300 + 8
        loci[LOCUS_QUALITY] = Locus::new(360, 800); // 340/780 + 20
        loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(800);
        Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("Ashgrain F1".to_owned()),
        }
    }

    fn gen2_master_ctx() -> SpliceContext {
        SpliceContext {
            splice_skill_bonus: 300,
            splicing_tier: 5, // master
            is_master: true,
            splicer_tool_q: 950,
            reagent_potency: [940, 950, 950, 500], // culture, mutagen, stabilizer, serum
        }
    }

    #[test]
    fn generation_two_selfing_segregates_to_homozygous_elite() {
        // design Appendix B: F1 hetero alleles -> Gen-2 selfing -> homozygous elite.
        let (child, _lines, _aq, _pt, _g) = splice_assemble_core(
            &ashgrain_f1(),
            &ashgrain_f1(),
            &no_choices(),
            &gen2_master_ctx(),
        );
        assert_eq!(child[LOCUS_YIELD], Locus::new(716, 716));
        assert_eq!(child[LOCUS_GROWTH_RATE], Locus::new(654, 654));
        assert_eq!(child[LOCUS_WATER_ECONOMY], Locus::new(788, 788));
        assert_eq!(child[LOCUS_QUALITY], Locus::new(800, 800));
    }

    #[test]
    fn master_top_reagent_full_points_caps_primary_line() {
        // design Appendix B: Gen-2 YIELD caps at 874 (gap 158 <= budget 21*8=168).
        let (_child, lines, assembly_q, points_total, gain) = splice_assemble_core(
            &ashgrain_f1(),
            &ashgrain_f1(),
            &no_choices(),
            &gen2_master_ctx(),
        );
        assert_eq!(assembly_q, 678);
        assert_eq!(points_total, 21);
        assert_eq!(gain, 8);
        // Cap table (design §3.6): YIELD/WATER/QUALITY breakthrough, GROWTH not.
        assert_eq!(lines[LOCUS_YIELD].cap_milli, 874);
        assert_eq!(lines[LOCUS_GROWTH_RATE].cap_milli, 759);
        assert_eq!(lines[LOCUS_WATER_ECONOMY].cap_milli, 946);
        assert_eq!(lines[LOCUS_QUALITY].cap_milli, 955);
        // Strategy A: all 21 points into YIELD caps it exactly.
        assert_eq!(splice_experiment_value(716, 874, 21, gain), 874);
        // Determinism inequality (owner calibration): budget >= gap.
        assert!(21 * u32::from(gain) >= 874 - 716);
        assert_eq!(21 * u32::from(gain), 168);
        assert_eq!(874 - 716, 158);
    }

    #[test]
    fn split_points_do_not_cap_but_lift_secondaries() {
        // design Appendix B Strategy B (6/6/5/4): all below their caps.
        let (_child, lines, _aq, _pt, gain) = splice_assemble_core(
            &ashgrain_f1(),
            &ashgrain_f1(),
            &no_choices(),
            &gen2_master_ctx(),
        );
        let value = |locus: usize, points: u8| {
            splice_experiment_value(
                lines[locus].base_milli,
                lines[locus].cap_milli,
                points,
                gain,
            )
        };
        assert_eq!(value(LOCUS_YIELD, 6), 764);
        assert_eq!(value(LOCUS_QUALITY, 6), 848);
        assert_eq!(value(LOCUS_WATER_ECONOMY, 5), 828);
        assert_eq!(value(LOCUS_GROWTH_RATE, 4), 686);
    }

    #[test]
    fn zero_points_yields_segregation_value() {
        // design Appendix B: value == base when no points spent.
        assert_eq!(splice_experiment_value(580, 616, 0, 4), 580);
    }

    #[test]
    fn subpar_reagent_gives_no_lift_no_penalty() {
        // design Appendix B: reagent <= 500 -> lift 0, cap == base, cannot move.
        let cap = splice_line_cap_milli(580, 500, 800, false);
        assert_eq!(cap, 580);
        // A worse-than-neutral reagent still never degrades below base.
        assert_eq!(splice_line_cap_milli(580, 200, 800, false), 580);
        assert_eq!(splice_experiment_value(580, cap, 10, 8), 580);
    }

    #[test]
    fn breakthrough_requires_master_premium_fullcommit() {
        // design Appendix B: brk gated on master AND reagent>=900 AND primary.
        assert!(splice_breakthrough_eligible(true, 900, true));
        assert!(!splice_breakthrough_eligible(false, 950, true)); // not master
        assert!(!splice_breakthrough_eligible(true, 899, true)); // reagent < 900
        assert!(!splice_breakthrough_eligible(true, 950, false)); // not primary
                                                                  // And the +50 shows up in the cap only when eligible.
        assert_eq!(splice_line_cap_milli(716, 950, 800, true), 874);
        assert_eq!(splice_line_cap_milli(716, 950, 800, false), 824);
    }

    #[test]
    fn player_allele_override_changes_segregation() {
        // Default elite grabs V9's 700; overriding to a1=0 (Dustline 420) drops it.
        let mut choices = no_choices();
        choices.insert(u8::try_from(LOCUS_YIELD).unwrap(), (Some(0), Some(1))); // A.a1=420, B.a2=540
        let ctx = SpliceContext {
            splice_skill_bonus: 120,
            splicing_tier: 2,
            is_master: false,
            splicer_tool_q: 600,
            reagent_potency: [600, 650, 640, 500],
        };
        let (child, _l, _a, _p, _g) =
            splice_assemble_core(&dustline(), &verdant9(), &choices, &ctx);
        assert_eq!(child[LOCUS_YIELD], Locus::new(420, 540));
    }

    #[test]
    fn mint_alleles_clamp_to_milli_domain() {
        // P2-3: a heterozygous elite child (1000/0) lifted 500->1000 would raise the
        // high allele to 1500; it must clamp to the documented 0..=1000 domain so
        // out-of-domain alleles never enter scans / content keys / the stable hash.
        let mut session = SpliceSessionState::new(CROP_ASHGRAIN_ITEM_ID);
        session.child_alleles = vec![Locus::new(1_000, 0)];
        session.lines = vec![SpliceLineState {
            locus: 0,
            label: "yield".to_owned(),
            base_milli: 500,
            value_milli: 1_000,
            cap_milli: 1_000,
        }];
        let minted = splice_mint_alleles(&session);
        assert_eq!(minted[0], Locus::new(1_000, 500)); // 1000+500 clamped to 1000; 0+500=500
        assert!(minted[0].a1 <= 1_000 && minted[0].a2 <= 1_000);
    }

    #[test]
    fn mint_alleles_lift_both_evenly_preserving_zygosity() {
        // A hetero line lifted by experimentation raises both alleles by value-base.
        let mut session = SpliceSessionState::new(CROP_ASHGRAIN_ITEM_ID);
        session.child_alleles = vec![Locus::new(460, 700)];
        session.lines = vec![SpliceLineState {
            locus: 0,
            label: "yield".to_owned(),
            base_milli: 580,
            value_milli: 596,
            cap_milli: 616,
        }];
        let minted = splice_mint_alleles(&session);
        assert_eq!(minted[0], Locus::new(476, 716)); // +16 on both, express 596
        assert_eq!(splice_express(minted[0].a1, minted[0].a2), 596);
    }
}
