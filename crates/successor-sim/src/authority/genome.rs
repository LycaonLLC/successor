//! Bio-Engineer genome schema, registry, and the joint seed-contract projections (B1).
//!
//! This module owns *what a seed IS* (bioengineer-design.md §0/§2): the immutable
//! diploid [`Genome`], the content-deduped [`CropGenomeRegistry`] that assigns each
//! distinct genome a sequential `u32` handle (= the seed `variant_id`), and the two
//! pure boundary functions Agriculture consumes at the plant/harvest edge:
//!   * [`project_agronomic`] — genome -> [`AgronomicProfile`] (called once at PlantSeed).
//!   * [`CropGenomeRegistry::mint_harvest_seed`] — parent handle -> child seed / None.
//!
//! Everything here is deterministic and float-free (the `extraction_math.rs` §C bar):
//! identical inputs always intern to the identical handle, for anyone, replay-safe.
#![deny(clippy::float_arithmetic)]
#![cfg_attr(not(test), allow(dead_code))]

use super::*;

/// Number of loci on a genome: 10 agronomic (map 1:1 to `AgronomicProfile`) + 3
/// breeding-meta (mutation_potential / potency / vigor). bioengineer-design.md §2.1.
pub(super) const GENOME_LOCUS_COUNT: usize = 13;

// Locus indices (design §2.3 order). The first ten drive the projection; the last
// three are breeding-facing only (never read by growth).
pub(super) const LOCUS_YIELD: usize = 0;
pub(super) const LOCUS_GROWTH_RATE: usize = 1;
pub(super) const LOCUS_WATER_ECONOMY: usize = 2;
pub(super) const LOCUS_HARDINESS: usize = 3;
pub(super) const LOCUS_STORM_RESISTANCE: usize = 4;
pub(super) const LOCUS_BLIGHT_RESISTANCE: usize = 5;
pub(super) const LOCUS_QUALITY: usize = 6;
pub(super) const LOCUS_REGROWTH: usize = 7;
pub(super) const LOCUS_SEASON: usize = 8;
pub(super) const LOCUS_STATURE: usize = 9;
pub(super) const LOCUS_MUTATION_POTENTIAL: usize = 10;
pub(super) const LOCUS_POTENCY: usize = 11;
pub(super) const LOCUS_VIGOR: usize = 12;

/// One diploid locus: two alleles, each milli `0..=1000` (design §2.1). The
/// expressed value of an additive/co-dominant trait is the allele average; the
/// hidden variation is the *spread* between the two alleles (the discovery layer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Locus {
    pub(super) a1: u16,
    pub(super) a2: u16,
}

impl Locus {
    pub(super) const fn new(a1: u16, a2: u16) -> Self {
        Self { a1, a2 }
    }

    pub(super) const fn homozygous(value: u16) -> Self {
        Self {
            a1: value,
            a2: value,
        }
    }

    /// Expressed (additive / co-dominant) value = allele average. Deterministic.
    pub(super) fn express(self) -> u16 {
        ((u32::from(self.a1) + u32::from(self.a2)) / 2).min(1_000) as u16
    }

    /// The stronger allele — the default "elite selection" pick during segregation.
    pub(super) fn elite(self) -> u16 {
        self.a1.max(self.a2)
    }

    /// True when the two alleles differ (secretly carries an unlike allele).
    pub(super) fn heterozygous(self) -> bool {
        self.a1 != self.a2
    }
}

/// Maker attribution + F-number + bounded parentage (design §2.7). Display-only:
/// NEVER gameplay-authoritative and NEVER part of the content-dedup key, so that
/// selfing a true-breeding parent re-interns to the identical handle (§2.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lineage {
    pub(super) breeder_id: String,
    pub(super) cultivar_name: String,
    pub(super) generation: u16,
    /// Parent handles (0 = wild / none). Bounded to two, not a full tree.
    pub(super) parents: [u32; 2],
}

impl Lineage {
    pub(super) fn wild(cultivar_name: String) -> Self {
        Self {
            breeder_id: String::new(),
            cultivar_name,
            generation: 0,
            parents: [0, 0],
        }
    }
}

/// One immutable seed genome (design §2.1). Interned to a `u32` handle by the
/// [`CropGenomeRegistry`]; identical genomes (species + loci + fertility) intern to
/// the same handle so identical seeds STACK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Genome {
    /// == the seed `item_id` (6_0xx crop species band).
    pub(super) species_id: u32,
    pub(super) loci: [Locus; GENOME_LOCUS_COUNT],
    /// `false` = terminator / gene-locked: grows a crop but mints no child seed.
    pub(super) fertile: bool,
    /// Breeder who gene-locked propagation (B5 Gene-Lock craft; None in B1-B4).
    pub(super) gene_lock: Option<String>,
    pub(super) lineage: Lineage,
}

impl Genome {
    /// The content-dedup key: the biologically meaningful genome only (species +
    /// loci + fertility). Lineage and the lock owner are provenance, deliberately
    /// excluded so identical genomes intern once regardless of who bred them or
    /// what generation they claim (design §2.4, §2.7).
    pub(super) fn content_key(&self) -> GenomeContentKey {
        GenomeContentKey {
            species_id: self.species_id,
            loci: self.loci,
            fertile: self.fertile,
        }
    }
}

/// Interning key — see [`Genome::content_key`]. Ord-comparable so the dedup index
/// is a `BTreeMap` (O(log n) mint, replay-stable iteration).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct GenomeContentKey {
    species_id: u32,
    loci: [Locus; GENOME_LOCUS_COUNT],
    fertile: bool,
}

/// The ONLY thing growth reads (design §0.3). Byte-identical §0.3 contract, pinned
/// with AgriCore: field order/names/types are LAW; neither lead changes the shape
/// unilaterally. Bio-Engineer produces it via [`project_agronomic`]; Agriculture
/// stores it on its crop record and writes its bytes into the crop's stable hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgronomicProfile {
    pub(super) growth_days_base: u16,
    pub(super) water_need_milli: u16,
    pub(super) yield_base: u32,
    pub(super) hardiness_milli: u16,
    pub(super) season_affinity: u8,
    pub(super) off_season_penalty_milli: u16,
    pub(super) storm_resistance_milli: u16,
    pub(super) blight_resistance_milli: u16,
    pub(super) regrowth_days: u16,
    pub(super) tile_footprint: u8,
    pub(super) quality_potential_milli: u16,
}

// ---- Projection balance table (design §2.3). All milli integer math. ----
const YIELD_MIN_UNITS: u32 = 4;
const YIELD_MAX_UNITS: u32 = 40;
const GDAYS_MIN: u16 = 2;
const GDAYS_MAX: u16 = 12;
const WNEED_MIN_MILLI: u16 = 100;
const REGROW_THRESHOLD_MILLI: u16 = 600;
const REGROW_DAYS_MIN: u16 = 3;
const REGROW_DAYS_MAX: u16 = 15;
const STATURE_MEDIUM_MILLI: u16 = 700;
const STATURE_LARGE_MILLI: u16 = 900;

fn yield_base_from_milli(express: u16) -> u32 {
    YIELD_MIN_UNITS
        + (YIELD_MAX_UNITS - YIELD_MIN_UNITS).saturating_mul(u32::from(express.min(1_000))) / 1_000
}

fn growth_days_from_milli(express: u16) -> u16 {
    let inverse = 1_000u32.saturating_sub(u32::from(express.min(1_000)));
    GDAYS_MIN
        + u16::try_from(u32::from(GDAYS_MAX - GDAYS_MIN).saturating_mul(inverse) / 1_000)
            .unwrap_or(GDAYS_MAX - GDAYS_MIN)
}

fn water_need_from_milli(express: u16) -> u16 {
    1_000u16
        .saturating_sub(express.min(1_000))
        .max(WNEED_MIN_MILLI)
}

fn regrowth_days_from_milli(express: u16) -> u16 {
    if express < REGROW_THRESHOLD_MILLI {
        return 0;
    }
    let span = u32::from(express - REGROW_THRESHOLD_MILLI);
    let range = u32::from(REGROW_DAYS_MAX - REGROW_DAYS_MIN);
    let denom = u32::from(1_000 - REGROW_THRESHOLD_MILLI);
    REGROW_DAYS_MIN + u16::try_from(range.saturating_mul(span) / denom).unwrap_or(0)
}

/// Dominant-categorical: the stronger allele bands into one favoured season bit
/// (spring/summer/autumn/winter = 1/2/4/8); off-season penalty scales inversely
/// with the expressed strength (design §2.3 row 9).
fn season_affinity_from_locus(locus: &Locus) -> u8 {
    let band = (u32::from(locus.elite().min(1_000)) * 4 / 1_001) as u8; // 0..=3
    1u8 << band
}

fn off_season_penalty_from_milli(express: u16) -> u16 {
    1_000u16.saturating_sub(express.min(1_000))
}

fn tile_footprint_from_milli(express: u16) -> u8 {
    if express < STATURE_MEDIUM_MILLI {
        1
    } else if express < STATURE_LARGE_MILLI {
        2
    } else {
        3
    }
}

/// Pure per-locus closed-form projection (design §0.4, §2.3). Allocation-free.
/// Agriculture calls this ONCE at PlantSeed and caches the result on the crop.
pub(super) fn project_agronomic(genome: &Genome) -> AgronomicProfile {
    let e = |index: usize| genome.loci[index].express();
    AgronomicProfile {
        yield_base: yield_base_from_milli(e(LOCUS_YIELD)),
        growth_days_base: growth_days_from_milli(e(LOCUS_GROWTH_RATE)),
        water_need_milli: water_need_from_milli(e(LOCUS_WATER_ECONOMY)),
        hardiness_milli: e(LOCUS_HARDINESS),
        storm_resistance_milli: e(LOCUS_STORM_RESISTANCE),
        blight_resistance_milli: e(LOCUS_BLIGHT_RESISTANCE),
        quality_potential_milli: e(LOCUS_QUALITY),
        regrowth_days: regrowth_days_from_milli(e(LOCUS_REGROWTH)),
        season_affinity: season_affinity_from_locus(&genome.loci[LOCUS_SEASON]),
        off_season_penalty_milli: off_season_penalty_from_milli(e(LOCUS_SEASON)),
        tile_footprint: tile_footprint_from_milli(e(LOCUS_STATURE)),
    }
}

/// Result of a harvest-seed mint (design §0.4). `seed_variant_id` is the child
/// genome handle (== parent handle for the base true-breeding case, so children
/// STACK); `qty` scales with tending quality and the parent's vigor locus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct HarvestSeed {
    pub(super) seed_variant_id: u32,
    pub(super) qty: u32,
}

const HARVEST_SEED_BASE_QTY: u32 = 2;
const HARVEST_SEED_TENDING_BONUS_MAX: u32 = 4;
const HARVEST_SEED_VIGOR_BONUS_MAX: u32 = 4;

// ---- Crop species registry (design §2.3 "constants live in a balance table"). ----
#[derive(Debug, Clone, Copy)]
pub(super) struct CropSpeciesDef {
    pub(super) item_id: u32,
    pub(super) key: &'static str,
    pub(super) name: &'static str,
    /// Wild base for the mutation_potential locus (design §3.6: Ashgrain = 800).
    pub(super) mutation_potential_base: u16,
}

pub(super) const CROP_SPECIES: [CropSpeciesDef; 9] = [
    CropSpeciesDef {
        item_id: CROP_ASHGRAIN_ITEM_ID,
        key: "ashgrain",
        name: "Ashgrain",
        mutation_potential_base: 800,
    },
    CropSpeciesDef {
        item_id: CROP_SUNMELON_ITEM_ID,
        key: "sunmelon",
        name: "Sunmelon",
        mutation_potential_base: 620,
    },
    CropSpeciesDef {
        item_id: CROP_CAVEMOSS_ITEM_ID,
        key: "cavemoss",
        name: "Cavemoss",
        mutation_potential_base: 700,
    },
    CropSpeciesDef {
        item_id: CROP_EMBERBEAN_ITEM_ID,
        key: "emberbean",
        name: "Emberbean",
        mutation_potential_base: 560,
    },
    CropSpeciesDef {
        item_id: CROP_RIFTROOT_ITEM_ID,
        key: "riftroot",
        name: "Riftroot",
        mutation_potential_base: 650,
    },
    CropSpeciesDef {
        item_id: CROP_BRINELEAF_ITEM_ID,
        key: "brineleaf",
        name: "Brineleaf",
        mutation_potential_base: 720,
    },
    CropSpeciesDef {
        item_id: CROP_GLASSPEPPER_ITEM_ID,
        key: "glasspepper",
        name: "Glasspepper",
        mutation_potential_base: 760,
    },
    CropSpeciesDef {
        item_id: CROP_COILREED_ITEM_ID,
        key: "coilreed",
        name: "Coilreed",
        mutation_potential_base: 590,
    },
    CropSpeciesDef {
        item_id: CROP_NIGHTPLUM_ITEM_ID,
        key: "nightplum",
        name: "Nightplum",
        mutation_potential_base: 680,
    },
];

pub(super) fn crop_species_by_key(key: &str) -> Option<&'static CropSpeciesDef> {
    let normalized = normalize_command_key(key);
    CROP_SPECIES
        .iter()
        .find(|species| species.key == normalized)
}

pub(super) fn crop_species_by_item_id(item_id: u32) -> Option<&'static CropSpeciesDef> {
    CROP_SPECIES
        .iter()
        .find(|species| species.item_id == item_id)
}

pub(super) fn is_crop_seed_item_id(item_id: u32) -> bool {
    crop_species_by_item_id(item_id).is_some()
}

/// Server-side genome side-table (design §0.2, §2.4). Maps a content-deduped
/// sequential `u32` handle to the full genome. Chosen over variant-packing because
/// ~100 bits of genome cannot round-trip through a 32-bit variant; chosen over
/// resource-style regeneration because a genome is *bred*, carrying hidden
/// recessives + lineage that cannot be re-rolled from a compact seed. Durable,
/// curated state — it joins the authority stable hash so replay is exact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CropGenomeRegistry {
    /// handle -> genome (serialized + hashed; BTreeMap keeps handle order stable).
    genomes: BTreeMap<u32, Genome>,
    /// Next handle to assign. Sequential (not hash-truncated) so it never collides
    /// and advances deterministically in tick order (design §2.4).
    next_handle: u32,
    /// content-dedup index; derived from `genomes`, rebuilt on import, never hashed.
    #[serde(skip)]
    content_index: BTreeMap<GenomeContentKey, u32>,
}

impl Default for CropGenomeRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl CropGenomeRegistry {
    pub(super) fn new() -> Self {
        Self {
            genomes: BTreeMap::new(),
            next_handle: 1,
            content_index: BTreeMap::new(),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.genomes.len()
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.genomes.is_empty()
    }

    pub(super) fn next_handle(&self) -> u32 {
        self.next_handle
    }

    /// Intern a genome, returning its handle. Identical content reuses the existing
    /// handle (so identical seeds STACK and the first breeder's provenance stands);
    /// new content takes the next sequential handle. Deterministic + replay-stable.
    pub(super) fn intern(&mut self, genome: Genome) -> u32 {
        let key = genome.content_key();
        if let Some(existing) = self.content_index.get(&key) {
            return *existing;
        }
        let handle = self.next_handle.max(1);
        self.next_handle = handle.saturating_add(1).max(1);
        self.content_index.insert(key, handle);
        self.genomes.insert(handle, genome);
        handle
    }

    /// Resolve a seed stack `(item_id, variant_id)` to its genome. `variant_id` is
    /// the handle; the species guard rejects a handle minted under another species.
    pub(super) fn resolve(&self, seed_item_id: u32, variant_id: u32) -> Option<&Genome> {
        let genome = self.genomes.get(&variant_id)?;
        (genome.species_id == seed_item_id).then_some(genome)
    }

    pub(super) fn get(&self, handle: u32) -> Option<&Genome> {
        self.genomes.get(&handle)
    }

    /// Rebuild the dedup index from `genomes` (call after deserialize / import).
    pub(super) fn rebuild_content_index(&mut self) {
        self.content_index.clear();
        for (handle, genome) in &self.genomes {
            self.content_index
                .entry(genome.content_key())
                .or_insert(*handle);
        }
        self.next_handle = self.next_handle.max(
            self.genomes
                .keys()
                .copied()
                .max()
                .map(|max| max.saturating_add(1))
                .unwrap_or(1),
        );
    }

    /// Fold the registry into the authority stable hash. An EMPTY registry writes
    /// ZERO bytes, so genome-free scenarios keep byte-identical hashes (no play:gate
    /// re-baseline); a minting scenario diverges exactly where it should.
    pub(super) fn write_stable_hash(&self, w: &mut StateWriter) {
        if self.genomes.is_empty() {
            return;
        }
        w.write_u32(u32::try_from(self.genomes.len()).expect("genome count fits u32"));
        for (handle, genome) in &self.genomes {
            w.write_u32(*handle)
                .write_u32(genome.species_id)
                .write_bool(genome.fertile);
            match &genome.gene_lock {
                Some(owner) => {
                    w.write_bool(true);
                    write_string(w, owner);
                }
                None => {
                    w.write_bool(false);
                }
            }
            for locus in &genome.loci {
                w.write_u32(u32::from(locus.a1))
                    .write_u32(u32::from(locus.a2));
            }
            write_string(w, &genome.lineage.breeder_id);
            write_string(w, &genome.lineage.cultivar_name);
            w.write_u32(u32::from(genome.lineage.generation))
                .write_u32(genome.lineage.parents[0])
                .write_u32(genome.lineage.parents[1]);
        }
        w.write_u64(u64::from(self.next_handle));
    }

    /// Mint a harvest child seed from a planted parent (design §0.4). Sterile /
    /// gene-locked parents propagate nothing (`None`); fertile parents yield a
    /// TRUE-BREEDING child = the same handle, quantity scaled by tending + vigor.
    /// `ctx_seed` is reserved for a future skill-gated "field selection" nudge.
    pub(super) fn mint_harvest_seed(
        &self,
        parent_variant_id: u32,
        tending_quality_milli: u16,
        _ctx_seed: u32,
    ) -> Option<HarvestSeed> {
        let parent = self.genomes.get(&parent_variant_id)?;
        if !parent.fertile {
            return None;
        }
        let tending = u32::from(tending_quality_milli.min(1_000));
        let vigor = u32::from(parent.loci[LOCUS_VIGOR].express());
        let qty = HARVEST_SEED_BASE_QTY
            + HARVEST_SEED_TENDING_BONUS_MAX.saturating_mul(tending) / 1_000
            + HARVEST_SEED_VIGOR_BONUS_MAX.saturating_mul(vigor) / 1_000;
        Some(HarvestSeed {
            seed_variant_id: parent_variant_id,
            qty: qty.max(1),
        })
    }
}

// ---- Deterministic integer hashing for wild-genome generation (float-free). ----
const fn mix_u32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

fn genome_hash32(parts: &[u32]) -> u32 {
    let mut hash = 0x811c_9dc5_u32;
    for part in parts {
        hash = mix_u32(hash ^ part.wrapping_mul(0x0100_0193));
    }
    hash
}

fn roll_milli(seed: u32, salt: u32, floor: u16, span: u16) -> u16 {
    if span == 0 {
        return floor;
    }
    let roll = genome_hash32(&[seed, salt]) % u32::from(span);
    floor
        .saturating_add(u16::try_from(roll).unwrap_or(0))
        .min(1_000)
}

/// Deterministically sample a wild-flora landrace genome (design §3.2). Produces
/// modest, usually heterozygous alleles with one or two hidden elite recessives
/// (the reason to scan). Fully a function of (species, area, epoch, sample index).
pub(super) fn wild_landrace_genome(
    species: &CropSpeciesDef,
    area_id: &str,
    epoch: u64,
    sample_index: u64,
) -> Genome {
    let seed = genome_hash32(&[
        species.item_id,
        string_hash32(area_id),
        epoch as u32,
        (epoch >> 32) as u32,
        sample_index as u32,
        0x5eed_1a2b,
    ]);
    let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
    for (index, locus) in loci.iter_mut().enumerate() {
        let salt = (index as u32).wrapping_mul(2).wrapping_add(1);
        // Modest wild alleles, independent rolls -> naturally heterozygous.
        let a1 = roll_milli(seed, salt, 300, 400);
        let a2 = roll_milli(seed, salt.wrapping_add(101), 300, 400);
        *locus = Locus::new(a1, a2);
    }
    // Species mutation_potential base (design §3.6: Ashgrain = 800).
    loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(species.mutation_potential_base);
    // Inject two hidden elite recessives: high allele hidden behind a modest twin.
    for pick in 0..2u32 {
        let target = (genome_hash32(&[seed, 0xe111_7e00 + pick]) % 10) as usize; // agronomic loci 0..9
        let elite = roll_milli(seed, 0xe111_7e80 + pick, 720, 250);
        let locus = &mut loci[target];
        // Keep the weaker allele modest so the phenotype stays unremarkable.
        if locus.a1 <= locus.a2 {
            locus.a1 = locus.a1.min(560);
            locus.a2 = elite;
        } else {
            locus.a2 = locus.a2.min(560);
            locus.a1 = elite;
        }
    }
    let cultivar_name = wild_cultivar_name(seed);
    Genome {
        species_id: species.item_id,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage::wild(cultivar_name),
    }
}

/// Auto-generated cultivar name in the "named resource spawn" convention (§2.7).
pub(super) fn wild_cultivar_name(seed: u32) -> String {
    const PREFIX: [&str; 8] = [
        "Dust", "Verdant", "Ash", "Kestrel", "Dax", "Ember", "Sable", "Wren",
    ];
    const SUFFIX: [&str; 8] = [
        "line", "mere", "field", "grove", "run", "reach", "fall", "crest",
    ];
    let prefix = PREFIX[(seed % 8) as usize];
    let suffix = SUFFIX[((seed >> 8) % 8) as usize];
    let number = (seed >> 16) % 90 + 1;
    format!("{prefix}{suffix}-{number}")
}

// ---- Genome scan reveal tiers (design §3.3). Earned information, deterministic. ----
/// How much of a genome the Genome Scanner reveals, gated by the Sequencing track.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum GenomeScanTier {
    /// Novice: expressed phenotype only (the AgronomicProfile).
    Phenotype,
    /// Sequencing I-II: which loci are heterozygous (hide something).
    HiddenPresence,
    /// Sequencing III: exact allele values.
    AlleleValues,
    /// Sequencing IV / Master: mutation-potential + lineage depth.
    Full,
}

impl GenomeScanTier {
    /// Map a Sequencing track box-count (0 = novice only .. 5 = master) to a tier.
    pub(super) fn from_sequencing_tier(tier: u8) -> Self {
        match tier {
            0 => Self::Phenotype,
            1 | 2 => Self::HiddenPresence,
            3 => Self::AlleleValues,
            _ => Self::Full,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn ashgrain_kestrel() -> Genome {
        // Worked example §3.6 closing projection: the four cited loci at Kestrel's
        // homozygous expressed values; the rest parked (do not affect the assert).
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_YIELD] = Locus::homozygous(874);
        loci[LOCUS_GROWTH_RATE] = Locus::homozygous(654);
        loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(788);
        loci[LOCUS_QUALITY] = Locus::homozygous(800);
        loci[LOCUS_REGROWTH] = Locus::homozygous(0); // single-harvest
        Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage {
                breeder_id: "player".to_owned(),
                cultivar_name: "Kestrel".to_owned(),
                generation: 2,
                parents: [11, 11],
            },
        }
    }

    #[test]
    fn project_agronomic_maps_loci_to_profile_exact() {
        // design Appendix B: Kestrel loci -> profile, exact §3.6 numbers.
        let profile = project_agronomic(&ashgrain_kestrel());
        assert_eq!(profile.yield_base, 35); // 4 + 36*874/1000 = 35
        assert_eq!(profile.growth_days_base, 5); // 2 + 10*(1000-654)/1000 = 5
        assert_eq!(profile.water_need_milli, 212); // 1000 - 788
        assert_eq!(profile.quality_potential_milli, 800);
    }

    #[test]
    fn water_need_floors_at_minimum() {
        // A drought-perfect cultivar (water_economy 950) floors, never underflows.
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(950);
        let genome = Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        };
        assert_eq!(project_agronomic(&genome).water_need_milli, WNEED_MIN_MILLI);
    }

    #[test]
    fn content_dedup_stacks_identical_seeds() {
        // design Appendix B: two independent identical mints share a handle.
        let mut registry = CropGenomeRegistry::new();
        let make = |breeder: &str, generation: u16| Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(600); GENOME_LOCUS_COUNT],
            fertile: true,
            gene_lock: None,
            lineage: Lineage {
                breeder_id: breeder.to_owned(),
                cultivar_name: format!("{breeder}-cultivar"),
                generation,
                parents: [0, 0],
            },
        };
        // Different lineage (breeder/generation) but identical content -> one handle.
        let first = registry.intern(make("alice", 1));
        let second = registry.intern(make("bob", 7));
        assert_eq!(first, second);
        assert_eq!(registry.len(), 1);
        // First breeder's provenance stands (dedup keeps the first mint).
        assert_eq!(registry.get(first).unwrap().lineage.breeder_id, "alice");
    }

    #[test]
    fn distinct_genomes_never_merge() {
        let mut registry = CropGenomeRegistry::new();
        let base = |value: u16| Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(value); GENOME_LOCUS_COUNT],
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        };
        let a = registry.intern(base(600));
        let b = registry.intern(base(601));
        assert_ne!(a, b);
        assert_eq!(registry.len(), 2);
        // Fertility is content-bearing: a sterile sibling gets its own handle.
        let mut sterile = base(600);
        sterile.fertile = false;
        let c = registry.intern(sterile);
        assert_ne!(a, c);
        assert_eq!(registry.len(), 3);
    }

    #[test]
    fn genome_handle_is_stable_across_replay() {
        // design Appendix B: the sequential counter advances deterministically in
        // insertion (tick) order; the same mint order yields the same handles.
        let build = || {
            let mut registry = CropGenomeRegistry::new();
            let mut handles = Vec::new();
            for value in [500u16, 700, 500, 900, 700] {
                handles.push(registry.intern(Genome {
                    species_id: CROP_ASHGRAIN_ITEM_ID,
                    loci: [Locus::homozygous(value); GENOME_LOCUS_COUNT],
                    fertile: true,
                    gene_lock: None,
                    lineage: Lineage::wild("t".to_owned()),
                }));
            }
            (registry.next_handle(), handles)
        };
        let (next_a, handles_a) = build();
        let (next_b, handles_b) = build();
        assert_eq!(handles_a, handles_b);
        assert_eq!(handles_a, vec![1, 2, 1, 3, 2]); // dedup of repeats, 3 distinct
        assert_eq!(next_a, next_b);
        assert_eq!(next_a, 4);
    }

    #[test]
    fn rebuild_content_index_recovers_dedup_after_import() {
        let mut registry = CropGenomeRegistry::new();
        let genome = Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(640); GENOME_LOCUS_COUNT],
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        };
        let handle = registry.intern(genome.clone());
        // Simulate a reload: drop the derived index, rebuild from genomes.
        registry.content_index.clear();
        registry.rebuild_content_index();
        // Re-interning identical content resolves to the original handle (no dup).
        assert_eq!(registry.intern(genome), handle);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn sterile_genome_mints_no_child_seed() {
        // design Appendix B: fertile=false => mint_harvest_seed -> None.
        let mut registry = CropGenomeRegistry::new();
        let fertile = registry.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(600); GENOME_LOCUS_COUNT],
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        });
        let sterile = registry.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(600); GENOME_LOCUS_COUNT],
            fertile: false,
            gene_lock: Some("breeder".to_owned()),
            lineage: Lineage::wild("t".to_owned()),
        });
        // Fertile parent -> a true-breeding child on the SAME handle (stacks).
        let child = registry.mint_harvest_seed(fertile, 1_000, 0).unwrap();
        assert_eq!(child.seed_variant_id, fertile);
        assert!(child.qty >= 1);
        // Sterile parent -> nothing propagates.
        assert!(registry.mint_harvest_seed(sterile, 1_000, 0).is_none());
    }

    #[test]
    fn harvest_seed_qty_scales_with_tending() {
        let mut registry = CropGenomeRegistry::new();
        let mut loci = [Locus::homozygous(500); GENOME_LOCUS_COUNT];
        loci[LOCUS_VIGOR] = Locus::homozygous(1_000);
        let handle = registry.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        });
        let neglected = registry.mint_harvest_seed(handle, 0, 0).unwrap().qty;
        let tended = registry.mint_harvest_seed(handle, 1_000, 0).unwrap().qty;
        assert!(
            tended > neglected,
            "tending {tended} should beat neglect {neglected}"
        );
    }

    #[test]
    fn wild_landrace_is_deterministic_and_carries_hidden_elite() {
        let species = crop_species_by_key("ashgrain").unwrap();
        let a = wild_landrace_genome(species, "open-desert", 3, 0);
        let b = wild_landrace_genome(species, "open-desert", 3, 0);
        assert_eq!(a, b, "same inputs must produce the identical wild genome");
        let different = wild_landrace_genome(species, "open-desert", 3, 1);
        assert_ne!(
            a, different,
            "a different sample index yields a different seed"
        );
        assert_eq!(
            a.loci[LOCUS_MUTATION_POTENTIAL].express(),
            species.mutation_potential_base
        );
        // At least one agronomic locus hides an elite recessive (>= 720).
        let hides_elite = a.loci[..10]
            .iter()
            .any(|locus| locus.heterozygous() && locus.elite() >= 720);
        assert!(hides_elite, "wild landrace should hide an elite recessive");
    }

    #[test]
    fn resolve_guards_species_mismatch() {
        let mut registry = CropGenomeRegistry::new();
        let handle = registry.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci: [Locus::homozygous(600); GENOME_LOCUS_COUNT],
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild("t".to_owned()),
        });
        assert!(registry.resolve(CROP_ASHGRAIN_ITEM_ID, handle).is_some());
        // Same handle, wrong species item id -> no genome.
        assert!(registry.resolve(CROP_SUNMELON_ITEM_ID, handle).is_none());
    }
    #[test]
    fn crop_species_catalog_has_all_nine_deterministic_rows() {
        let expected = [
            (6_001, "ashgrain", 800),
            (6_002, "sunmelon", 620),
            (6_003, "cavemoss", 700),
            (6_004, "emberbean", 560),
            (6_005, "riftroot", 650),
            (6_006, "brineleaf", 720),
            (6_007, "glasspepper", 760),
            (6_008, "coilreed", 590),
            (6_009, "nightplum", 680),
        ];
        assert_eq!(CROP_SPECIES.len(), expected.len());
        let mut ids = BTreeSet::new();
        for (item_id, key, mutation_base) in expected {
            let species = crop_species_by_key(key).expect("catalog key resolves");
            assert_eq!(species.item_id, item_id);
            assert_eq!(species.key, key);
            assert_eq!(species.mutation_potential_base, mutation_base);
            assert!(ids.insert(species.item_id), "duplicate crop id {item_id}");
            assert_eq!(
                crop_species_by_item_id(item_id).map(|row| row.key),
                Some(key)
            );
            assert_eq!(produce_item_id_for_species(item_id), item_id + 100);
        }
        assert_eq!(ids.len(), 9);
    }
}
