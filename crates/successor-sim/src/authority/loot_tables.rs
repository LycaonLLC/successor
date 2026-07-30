//! Humanoid loot tables: deterministic random drops rolled at death into the
//! existing corpse-container and loot-rights path.
//!
//! Invariants (owner brief):
//!
//! - Crafting stays king: every tier rolls quality below crafted MASTERWORK (900
//!   milli) except RELIC (legendary), the only tier reaching it.
//! - Legendaries are EXCEEDINGLY rare: `LOOT_LEGENDARY_WEIGHT_PPM` is calibrated
//!   (design §1) to ~1 genuinely-good legendary per MONTH of high-efficiency 24/7
//!   AFK farming (measured 258 kph sustained / 344 kph pure-TTK ceiling).
//! - No "wear what the guy is wearing": the roll is a pure function of
//!   `(death_tick, actor_id, area_id)` and never reads equipped gear or appearance.
//! - Determinism: house integer-hash RNG ceremony; no wall-clock, no float accum.
//! - No new commands, no wire field, no manifest churn: rarity + quality ride in
//!   the existing `variant_id` (LOOT_VARIANT_BASE namespace) and the item name.

use super::*;

// ---------------------------------------------------------------------------
// Tunable constants — the whole loot economy lives in this block.
// ---------------------------------------------------------------------------

/// The entire legendary economy in ONE knob: RELIC weight in parts-per-million.
/// 10 ppm = 1/100_000. Calibrated to roughly one good legendary per
/// month-of-high-efficiency-AFK anchor at the REALISTIC respawn-supply-bounded 24/7
/// macro rate (~100–160 kph, grounded by SimPlayer's oracle soak) — NOT the
/// instant-respawn TTK ceiling (258–344 kph), which a parked farmer never reaches.
/// Lands 0.72–1.15 legendaries/month across that band; ~1.9/mo at the theoretical
/// optimizer ceiling (acceptable tail). Pinned identically across every class so the
/// legendary rate cannot be farmed upward by choosing a "richer" class (design §1, §3.2).
/// Owner-retune line: casual↔generous is this one number.
pub(super) const LOOT_LEGENDARY_WEIGHT_PPM: u32 = 10;

/// Rolls per kill. v1 = single Diablo-style drop (anti-flood; design §8 F5).
const LOOT_ROLLS_PER_KILL: u32 = 1;

/// Variant-id namespace for rolled loot. House convention, disjoint from
/// medical (41M) / battery (32M) / schematic (52-53M): `base + tier*stride + quality`.
const LOOT_VARIANT_BASE: u32 = 60_000_000;
const LOOT_VARIANT_TIER_STRIDE: u32 = 1_000_000;

const LOOT_CEREMONY_SALT: u32 = 0x1007_ab1e;
const LOOT_SALT_TIER: u32 = 0x7132_0001;
const LOOT_SALT_QUALITY: u32 = 0x7132_0002;
const LOOT_SALT_ITEM: u32 = 0x7132_0003;
const LOOT_WARDROBE_WEIGHT_PPM: u32 = 30_000;
const LOOT_SALT_WARDROBE_CHANCE: u32 = 0x7132_0004;
const LOOT_SALT_WARDROBE_ITEM: u32 = 0x7132_0005;

/// Humanoid loot wardrobe aliases remain real wearable inventory rows. Their
/// deterministic 60M variants carry rarity and quality; the worn projection
/// resolves each numeric row to its canonical clothing key.
const CREATOR_CLOTHING_FIRST: u32 = 7_301;
const CREATOR_CLOTHING_COUNT: u32 = 35;

// Loot-table armor/clothing item ids. Acquisition remains loot-only outside
// explicitly gated debug grants. All eight rows are authority-wearable when
// carried with a valid nonzero loot variant. Weapons reuse the existing
// EQUIPPABLE bases (CRAFTED_SLUGTHROWER_ITEM_ID / VIBROSWORD_), so a rolled
// weapon is usable, not inert.
const ITEM_PLATE_VEST: u32 = 7_101;
const ITEM_KEVLAR_WRAP: u32 = 7_102;
const ITEM_GREAVES: u32 = 7_104;
const ITEM_FIELD_JACKET: u32 = 7_201;
const ITEM_CARGO_TROUSERS: u32 = 7_202;
const ITEM_SCOUT_CAP: u32 = 7_203;
const ITEM_HIDE_JACKET: u32 = 7_204;

// ---------------------------------------------------------------------------
// Rarity tiers
// ---------------------------------------------------------------------------

/// Salvage-grade rarity ladder (design §2). Rank ascends; `Relic` is legendary.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum LootTier {
    Scrap,
    Stock,
    Marked,
    Choice,
    Prized,
    Relic,
}

impl LootTier {
    /// Ascending rank order (index into per-class weight arrays). Test-only iteration.
    #[cfg(test)]
    pub(super) const ALL: [LootTier; 6] = [
        LootTier::Scrap,
        LootTier::Stock,
        LootTier::Marked,
        LootTier::Choice,
        LootTier::Prized,
        LootTier::Relic,
    ];

    pub(super) const fn rank(self) -> u32 {
        match self {
            LootTier::Scrap => 0,
            LootTier::Stock => 1,
            LootTier::Marked => 2,
            LootTier::Choice => 3,
            LootTier::Prized => 4,
            LootTier::Relic => 5,
        }
    }

    pub(super) const fn from_rank(rank: u32) -> Option<LootTier> {
        match rank {
            0 => Some(LootTier::Scrap),
            1 => Some(LootTier::Stock),
            2 => Some(LootTier::Marked),
            3 => Some(LootTier::Choice),
            4 => Some(LootTier::Prized),
            5 => Some(LootTier::Relic),
            _ => None,
        }
    }

    /// One-word rarity label (design §2 house names). Test/telemetry aid.
    #[cfg(test)]
    pub(super) const fn word(self) -> &'static str {
        match self {
            LootTier::Scrap => "SCRAP",
            LootTier::Stock => "STOCK",
            LootTier::Marked => "MARKED",
            LootTier::Choice => "CHOICE",
            LootTier::Prized => "PRIZED",
            LootTier::Relic => "RELIC",
        }
    }

    /// Display-name adjective, e.g. "Relic Vibrosword", "Busted Combat Helm".
    const fn adjective(self) -> &'static str {
        match self {
            LootTier::Scrap => "Busted",
            LootTier::Stock => "Standard",
            LootTier::Marked => "Marked",
            LootTier::Choice => "Choice",
            LootTier::Prized => "Prized",
            LootTier::Relic => "Relic",
        }
    }

    /// Quality-milli band `(floor, span)`; rolled quality = `floor + roll % span`.
    /// Floors + ceilings are monotonic; every band caps below crafted MASTERWORK
    /// (900) except `Relic`, the only tier reaching it (design §4).
    const fn quality_band(self) -> (u16, u16) {
        match self {
            LootTier::Scrap => (0, 150),    // 0..=149    CRUDE
            LootTier::Stock => (40, 220),   // 40..=259   CRUDE-ROUGH
            LootTier::Marked => (150, 300), // 150..=449  ROUGH-FAIR
            LootTier::Choice => (320, 280), // 320..=599  FAIR-SOUND
            LootTier::Prized => (520, 320), // 520..=839  SOUND-FINE (still < 900)
            LootTier::Relic => (900, 101),  // 900..=1000 MASTERWORK+
        }
    }
}

// ---------------------------------------------------------------------------
// Item catalog + humanoid classes
/// A droppable base. Weapon ids (3_1xx) are existing equippable weapons; gear
/// ids (7_1xx / 7_2xx) are loot-acquired wearable clothing aliases.
#[derive(Clone, Copy, Debug)]
pub(super) struct LootItemBase {
    pub(super) item_id: u32,
    pub(super) name: &'static str,
}

const fn base(item_id: u32, name: &'static str) -> LootItemBase {
    LootItemBase { item_id, name }
}

//                                       weapons (equippable)                 wearable loot
const POOL_ROGUE_TROOPER: &[LootItemBase] = &[
    base(CRAFTED_SLUGTHROWER_ITEM_ID, "Slugthrower"),
    base(ITEM_PLATE_VEST, "Plate Vest"),
    base(COMBAT_HELM_ITEM_ID, "Combat Helm"),
    base(ITEM_FIELD_JACKET, "Field Jacket"),
    base(ITEM_CARGO_TROUSERS, "Cargo Trousers"),
];

const POOL_ROGUE_BRAWLER: &[LootItemBase] = &[
    base(VIBROSWORD_WEAPON_ITEM_ID, "Vibrosword"),
    base(ITEM_PLATE_VEST, "Plate Vest"),
    base(ITEM_GREAVES, "Greaves"),
    base(COMBAT_HELM_ITEM_ID, "Combat Helm"),
    base(ITEM_HIDE_JACKET, "Hide Jacket"),
];

const POOL_ROGUE_DEADEYE: &[LootItemBase] = &[
    base(CRAFTED_SLUGTHROWER_ITEM_ID, "Slugthrower"),
    base(ITEM_KEVLAR_WRAP, "Kevlar Wrap"),
    base(ITEM_SCOUT_CAP, "Scout Cap"),
    base(ITEM_FIELD_JACKET, "Field Jacket"),
    base(ITEM_CARGO_TROUSERS, "Cargo Trousers"),
];

/// Weapon bases that are real equippable items (a rolled weapon must be usable).
#[cfg(test)]
const EQUIPPABLE_WEAPON_ITEM_IDS: [u32; 2] =
    [CRAFTED_SLUGTHROWER_ITEM_ID, VIBROSWORD_WEAPON_ITEM_ID];

/// Farmable humanoid combat classes that carry a loot table (design §5).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum HumanoidLootClass {
    Trooper,
    Brawler,
    Deadeye,
}

impl HumanoidLootClass {
    /// Maps a combat role → loot class. Returns `None` for creatures
    /// (harvest-corpse path), players, vendors, trainers, and everything else.
    pub(super) fn from_role(role: &str) -> Option<Self> {
        match role {
            "skirmisher" => Some(HumanoidLootClass::Trooper),
            "skirmisher_brawler" => Some(HumanoidLootClass::Brawler),
            "skirmisher_deadeye" => Some(HumanoidLootClass::Deadeye),
            _ => None,
        }
    }

    /// Tier weights in ppm, indexed by tier rank (Scrap..Relic). NOTHING is the
    /// remainder to 1_000_000. `Relic` is pinned to `LOOT_LEGENDARY_WEIGHT_PPM`
    /// for every class (design §3.2).
    const fn tier_weights_ppm(self) -> [u32; 6] {
        match self {
            //                                Scrap    Stock    Marked  Choice Prized Relic
            HumanoidLootClass::Trooper => [
                300_000,
                115_000,
                22_000,
                2_800,
                100,
                LOOT_LEGENDARY_WEIGHT_PPM,
            ],
            HumanoidLootClass::Brawler => [
                310_000,
                120_000,
                20_000,
                2_500,
                90,
                LOOT_LEGENDARY_WEIGHT_PPM,
            ],
            HumanoidLootClass::Deadeye => [
                320_000,
                140_000,
                30_000,
                4_000,
                150,
                LOOT_LEGENDARY_WEIGHT_PPM,
            ],
        }
    }

    const fn item_pool(self) -> &'static [LootItemBase] {
        match self {
            HumanoidLootClass::Trooper => POOL_ROGUE_TROOPER,
            HumanoidLootClass::Brawler => POOL_ROGUE_BRAWLER,
            HumanoidLootClass::Deadeye => POOL_ROGUE_DEADEYE,
        }
    }
}

// ---------------------------------------------------------------------------
// Variant encoding (rarity stamp) — no wire field, decodable (design §6)
// ---------------------------------------------------------------------------

pub(super) fn encode_loot_variant(tier: LootTier, quality_milli: u16) -> u32 {
    LOOT_VARIANT_BASE + tier.rank() * LOOT_VARIANT_TIER_STRIDE + u32::from(quality_milli.min(1_000))
}

/// Inverse of `encode_loot_variant`. Runtime recovery uses the same decoder as
/// loot verification so a persisted rolled item keeps its canonical rarity name.
pub(super) fn decode_loot_variant(variant_id: u32) -> Option<(LootTier, u16)> {
    let encoded = variant_id.checked_sub(LOOT_VARIANT_BASE)?;
    let rank = encoded / LOOT_VARIANT_TIER_STRIDE;
    let quality = encoded % LOOT_VARIANT_TIER_STRIDE;
    if quality > 1_000 {
        return None;
    }
    Some((LootTier::from_rank(rank)?, quality as u16))
}

/// Resolve the exact display name stored for a rolled loot stack. This is the
/// durable recovery path for loot-acquired wearable aliases absent from the
/// ordinary inventory catalog.
pub(super) fn rolled_loot_item_name(item_id: u32, variant_id: u32) -> Option<String> {
    let (tier, _) = decode_loot_variant(variant_id)?;
    let item = [
        HumanoidLootClass::Trooper,
        HumanoidLootClass::Brawler,
        HumanoidLootClass::Deadeye,
    ]
    .into_iter()
    .flat_map(|class| class.item_pool().iter())
    .find(|item| item.item_id == item_id)?;
    Some(format!("{} {}", tier.adjective(), item.name))
}

// ---------------------------------------------------------------------------
// Deterministic integer RNG ceremony (float-free; matches genome.rs shape)
// ---------------------------------------------------------------------------

const fn loot_mix_u32(mut x: u32) -> u32 {
    x ^= x >> 16;
    x = x.wrapping_mul(0x7feb_352d);
    x ^= x >> 15;
    x = x.wrapping_mul(0x846c_a68b);
    x ^= x >> 16;
    x
}

fn loot_hash32(parts: &[u32]) -> u32 {
    let mut hash = 0x811c_9dc5_u32;
    for part in parts {
        hash = loot_mix_u32(hash ^ part.wrapping_mul(0x0100_0193));
    }
    hash
}

/// House RNG ceremony seed: a pure function of (death_tick, actor_id, area_id,
/// roll_index). No wall-clock, no float. Same inputs → same seed, forever.
fn loot_seed(death_tick: u64, actor_id: &str, area_id: &str, roll_index: u32) -> u32 {
    loot_hash32(&[
        death_tick as u32,
        (death_tick >> 32) as u32,
        string_hash32(actor_id),
        string_hash32(area_id),
        roll_index,
        LOOT_CEREMONY_SALT,
    ])
}

fn loot_draw(seed: u32, salt: u32) -> u32 {
    loot_hash32(&[seed, salt])
}

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RolledLoot {
    pub(super) item_id: u32,
    pub(super) variant_id: u32,
    pub(super) item_name: String,
    pub(super) quantity: u32,
}

/// Roll the tier for a seed; `None` = NOTHING (the remainder mass). The named
/// tiers occupy `[0, sum_of_named_weights)` of the ppm space; NOTHING occupies the
/// rest, so each tier's probability is exactly `weight / 1_000_000` (design §3).
fn roll_tier(class: HumanoidLootClass, seed: u32) -> Option<LootTier> {
    let weights = class.tier_weights_ppm();
    let named: u32 = weights.iter().sum();
    debug_assert!(named <= 1_000_000, "named tier weights must not exceed 1e6");
    let roll = loot_draw(seed, LOOT_SALT_TIER) % 1_000_000;
    if roll >= named {
        return None;
    }
    let mut acc = 0u32;
    for (index, weight) in weights.iter().enumerate() {
        acc = acc.saturating_add(*weight);
        if roll < acc {
            return LootTier::from_rank(index as u32);
        }
    }
    None
}

/// Pure deterministic loot roll for one death. Reused verbatim by tests. Never
/// reads equipped gear or appearance (zero wear-what-drops coupling — the inputs
/// are only death context).
pub(super) fn roll_humanoid_loot(
    class: HumanoidLootClass,
    death_tick: u64,
    actor_id: &str,
    area_id: &str,
    roll_index: u32,
) -> Option<RolledLoot> {
    let seed = loot_seed(death_tick, actor_id, area_id, roll_index);
    let tier = roll_tier(class, seed)?;
    let (floor, span) = tier.quality_band();
    let quality_milli = floor
        .saturating_add(
            u16::try_from(loot_draw(seed, LOOT_SALT_QUALITY) % u32::from(span.max(1))).unwrap_or(0),
        )
        .min(1_000);
    let pool = class.item_pool();
    let base = pool[loot_draw(seed, LOOT_SALT_ITEM) as usize % pool.len()];
    Some(RolledLoot {
        item_id: base.item_id,
        variant_id: encode_loot_variant(tier, quality_milli),
        item_name: format!("{} {}", tier.adjective(), base.name),
        quantity: 1,
    })
}

/// Independent ordinary creator-clothing roll.
fn roll_humanoid_wardrobe(
    death_tick: u64,
    actor_id: &str,
    area_id: &str,
    roll_index: u32,
) -> Option<RolledLoot> {
    let seed = loot_seed(death_tick, actor_id, area_id, roll_index);
    if loot_draw(seed, LOOT_SALT_WARDROBE_CHANCE) % 1_000_000 >= LOOT_WARDROBE_WEIGHT_PPM {
        return None;
    }
    let item_id = CREATOR_CLOTHING_FIRST
        + (loot_draw(seed, LOOT_SALT_WARDROBE_ITEM) % CREATOR_CLOTHING_COUNT);
    Some(RolledLoot {
        item_id,
        variant_id: 0,
        item_name: creator_clothing_item_key(item_id)?.to_owned(),
        quantity: 1,
    })
}

impl SliceAuthorityState {
    /// Roll humanoid loot at death and deposit into the EXISTING corpse container,
    /// alongside any inventory the corpse already moved. Returns whether the corpse
    /// now holds available rolled loot (feeds `has_loot` → 5-minute lootable-body
    /// timer). Fires ONLY for population-spawned humanoid combat NPCs (design §5);
    /// the loot-rights path and take-loot flow are untouched.
    pub(super) fn roll_and_deposit_humanoid_loot(
        &mut self,
        actor_id: &str,
        death_tick: u64,
    ) -> bool {
        let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
            return false;
        };
        // Farmable-population gate: spawn-zone origin + recognized humanoid combat
        // role. Hand-placed set-piece / test-scaffold actors (spawn_zone_id == None)
        // and creatures / players (role mismatch) never roll (design §5, §8 F3).
        if actor.spawn_zone_id.is_none() {
            return false;
        }
        let Some(class) = HumanoidLootClass::from_role(&actor.role) else {
            return false;
        };
        let area_id = actor.area_id.clone();
        for roll_index in 0..LOOT_ROLLS_PER_KILL {
            if let Some(rolled) =
                roll_humanoid_loot(class, death_tick, actor_id, &area_id, roll_index)
            {
                self.deposit_corpse_loot(actor_id, rolled);
            }
            if let Some(wardrobe) =
                roll_humanoid_wardrobe(death_tick, actor_id, &area_id, roll_index)
            {
                self.deposit_corpse_loot(actor_id, wardrobe);
            }
        }
        let container = format!("corpse:{actor_id}");
        self.runtime
            .durable
            .inventory
            .iter()
            .any(|row| row.container == container && row.available > 0)
    }

    fn deposit_corpse_loot(&mut self, actor_id: &str, rolled: RolledLoot) {
        let container = format!("corpse:{actor_id}");
        let stack_id = {
            let counter = self
                .runtime
                .durable
                .inventory_stack_counters
                .entry(container.clone())
                .or_insert(0);
            let id = *counter;
            *counter = counter.saturating_add(1);
            id
        };
        self.runtime.durable.inventory.push(InventoryStackSnapshot {
            stack_id,
            container,
            item: rolled.item_name,
            item_id: rolled.item_id,
            variant_id: rolled.variant_id,
            quantity: rolled.quantity,
            reserved: 0,
            available: rolled.quantity,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLASSES: [HumanoidLootClass; 3] = [
        HumanoidLootClass::Trooper,
        HumanoidLootClass::Brawler,
        HumanoidLootClass::Deadeye,
    ];

    #[test]
    fn wardrobe_roll_is_deterministic_creator_id_variant_zero_quantity_one() {
        let mut first = None;
        for tick in 0..200_000u64 {
            let roll = roll_humanoid_wardrobe(tick, "rogue", "overworld", 0);
            if let Some(rolled) = &roll {
                assert!(
                    (CREATOR_CLOTHING_FIRST..CREATOR_CLOTHING_FIRST + CREATOR_CLOTHING_COUNT)
                        .contains(&rolled.item_id)
                );
                assert_eq!(
                    rolled.item_name,
                    creator_clothing_item_key(rolled.item_id).unwrap()
                );
                assert_eq!(rolled.variant_id, 0);
                assert_eq!(rolled.quantity, 1);
                first = Some((tick, rolled.clone()));
                break;
            }
        }
        let (tick, expected) = first.expect("3% wardrobe roll should hit in sample");
        for _ in 0..32 {
            assert_eq!(
                roll_humanoid_wardrobe(tick, "rogue", "overworld", 0),
                Some(expected.clone())
            );
        }
    }

    #[test]
    fn wardrobe_roll_distribution_is_near_three_percent() {
        const N: u64 = 1_000_000;
        let hits = (0..N)
            .filter(|tick| roll_humanoid_wardrobe(*tick, "rogue", "overworld", 0).is_some())
            .count() as u64;
        let observed_ppm = hits * 1_000_000 / N;
        assert!(
            (27_000..=33_000).contains(&observed_ppm),
            "wardrobe observed {observed_ppm}ppm ({hits}/{N}), expected near 30_000ppm"
        );
        println!("WARDROBE_DIST hits={hits} total={N} observed_ppm={observed_ppm}");
    }

    #[test]
    fn wardrobe_roll_does_not_perturb_existing_rarity_output() {
        let mut wardrobe_hit = false;
        for tick in 0..50_000u64 {
            let before =
                roll_humanoid_loot(HumanoidLootClass::Trooper, tick, "rogue", "overworld", 0);
            let wardrobe = roll_humanoid_wardrobe(tick, "rogue", "overworld", 0);
            wardrobe_hit |= wardrobe.is_some();
            let after =
                roll_humanoid_loot(HumanoidLootClass::Trooper, tick, "rogue", "overworld", 0);
            assert_eq!(
                before, after,
                "wardrobe salts changed rarity output at tick {tick}"
            );
        }
        assert!(wardrobe_hit, "invariance sweep must include a wardrobe hit");
        assert_ne!(LOOT_SALT_WARDROBE_CHANCE, LOOT_SALT_TIER);
        assert_ne!(LOOT_SALT_WARDROBE_ITEM, LOOT_SALT_ITEM);
    }

    /// Chi-square-ish sanity over a large deterministic sweep: observed tier
    /// proportions must match the ppm weights and be strictly monotonic. Fixed
    /// seed (tick-varied), so counts are exactly reproducible.
    #[test]
    fn loot_tier_distribution_matches_weights_at_scale() {
        let class = HumanoidLootClass::Trooper;
        const N: u64 = 4_000_000;
        let mut counts = [0u64; 6];
        let mut nothing = 0u64;
        for tick in 0..N {
            match roll_tier(class, loot_seed(tick, "rogue", "overworld", 0)) {
                Some(tier) => counts[tier.rank() as usize] += 1,
                None => nothing += 1,
            }
        }
        assert_eq!(counts.iter().sum::<u64>() + nothing, N);

        // Strict monotonic descent Scrap > Stock > Marked > Choice > Prized > Relic.
        for rank in 1..6 {
            assert!(
                counts[rank - 1] > counts[rank],
                "tier rank {rank} not monotonic: {counts:?}"
            );
        }
        assert!(
            nothing > counts[0],
            "NOTHING must dominate: nothing={nothing} {counts:?}"
        );

        // Observed ppm within tolerance of the configured weights.
        let weights = class.tier_weights_ppm();
        for (rank, &weight) in weights.iter().enumerate() {
            let observed_ppm = counts[rank] * 1_000_000 / N;
            let expected_ppm = u64::from(weight);
            let tol_ppm = (expected_ppm / 16).max(6);
            let delta = observed_ppm.abs_diff(expected_ppm);
            assert!(
                delta <= tol_ppm,
                "tier rank {rank}: observed {observed_ppm}ppm vs expected {expected_ppm}ppm (tol {tol_ppm})"
            );
        }
        let relic = counts[LootTier::Relic.rank() as usize];
        // RELIC ~ N * 10e-6 = 40 at N=4M — exceedingly rare by construction.
        assert!(relic <= 80, "RELIC leaked too often: {relic} in {N}");
        println!("DIST counts={counts:?} nothing={nothing} relic={relic}");
    }

    #[test]
    fn loot_rarity_monotonicity_and_quality_below_crafted() {
        const MASTERWORK_FLOOR_MILLI: u16 = 900;
        for window in 1..LootTier::ALL.len() {
            assert!(LootTier::ALL[window].rank() > LootTier::ALL[window - 1].rank());
            assert_eq!(
                LootTier::from_rank(LootTier::ALL[window].rank()),
                Some(LootTier::ALL[window])
            );
        }
        let mut prev_floor = 0u16;
        let mut prev_ceil = 0u16;
        for (index, tier) in LootTier::ALL.iter().enumerate() {
            let (floor, span) = tier.quality_band();
            assert!(span > 0);
            let ceil = floor + span - 1;
            if index > 0 {
                assert!(floor >= prev_floor, "{} floor regressed", tier.word());
                assert!(ceil > prev_ceil, "{} ceil regressed", tier.word());
            }
            if *tier == LootTier::Relic {
                assert!(
                    floor >= MASTERWORK_FLOOR_MILLI,
                    "legendary must reach masterwork"
                );
            } else {
                assert!(
                    ceil < MASTERWORK_FLOOR_MILLI,
                    "{} must roll below crafted masterwork (ceil {ceil})",
                    tier.word()
                );
            }
            prev_floor = floor;
            prev_ceil = ceil;
        }
        for class in CLASSES {
            let weights = class.tier_weights_ppm();
            for rank in 1..weights.len() {
                assert!(
                    weights[rank - 1] > weights[rank],
                    "{class:?} weights not descending: {weights:?}"
                );
            }
            assert_eq!(
                weights[LootTier::Relic.rank() as usize],
                LOOT_LEGENDARY_WEIGHT_PPM,
                "{class:?} legendary weight must be the pinned global anchor"
            );
            assert!(
                weights.iter().sum::<u32>() < 1_000_000,
                "{class:?} must leave a NOTHING remainder"
            );
        }
    }

    #[test]
    fn no_legendary_in_cheap_runs() {
        // A short farming session (500 consecutive kills) at several fixed seeds
        // must NEVER yield a RELIC — deterministic, so this is an exact guarantee.
        for class in CLASSES {
            for base_tick in [1_000u64, 50_000, 750_000, 12_345_678] {
                let mut relics = 0u32;
                for kill in 0..500u64 {
                    if roll_tier(
                        class,
                        loot_seed(base_tick + kill, "rogue-cheap", "overworld", 0),
                    ) == Some(LootTier::Relic)
                    {
                        relics += 1;
                    }
                }
                assert_eq!(
                    relics, 0,
                    "cheap 500-kill run {class:?}@{base_tick} leaked a legendary"
                );
            }
        }
    }

    #[test]
    fn loot_variant_encoding_round_trips_and_is_namespaced() {
        for tier in LootTier::ALL {
            for quality in [0u16, 40, 149, 259, 449, 599, 839, 900, 1000] {
                let variant = encode_loot_variant(tier, quality);
                assert!(
                    (LOOT_VARIANT_BASE..=65_001_000).contains(&variant),
                    "variant {variant} outside namespace"
                );
                let (decoded_tier, decoded_quality) =
                    decode_loot_variant(variant).expect("decodes");
                assert_eq!(decoded_tier, tier);
                assert_eq!(decoded_quality, quality.min(1_000));
            }
        }
        // Values below the base (incl. schematic 52M / medical 41M spaces) are not loot.
        assert!(decode_loot_variant(0).is_none());
        assert!(decode_loot_variant(41_000_500).is_none());
        assert!(decode_loot_variant(52_000_500).is_none());
        assert!(decode_loot_variant(59_999_999).is_none());
        // Malformed quality (> 1000 inside a tier stride) is rejected.
        assert!(decode_loot_variant(LOOT_VARIANT_BASE + 1_500).is_none());
    }

    #[test]
    fn drops_are_table_driven_not_equipment_driven() {
        // The roll takes ONLY death context (class, tick, actor, area) — there is
        // no equipped-weapon/appearance parameter, so a drop can never be "what the
        // guy was wearing". Every pool base is reachable; weapons and clothing
        // aliases retain their own deterministic inventory identity.
        for class in CLASSES {
            let pool_ids: std::collections::BTreeSet<u32> =
                class.item_pool().iter().map(|item| item.item_id).collect();
            let mut seen = std::collections::BTreeSet::new();
            let mut saw_weapon = false;
            for tick in 0..20_000u64 {
                if let Some(rolled) = roll_humanoid_loot(class, tick, "rogue", "overworld", 0) {
                    assert!(
                        pool_ids.contains(&rolled.item_id),
                        "rolled id not in {class:?} pool"
                    );
                    seen.insert(rolled.item_id);
                    if EQUIPPABLE_WEAPON_ITEM_IDS.contains(&rolled.item_id) {
                        saw_weapon = true;
                    } else {
                        // Non-weapon drops are loot-acquired wearable aliases.
                        assert!(
                            (7_101..=7_299).contains(&rolled.item_id),
                            "unexpected gear id {}",
                            rolled.item_id
                        );
                    }
                }
            }
            assert_eq!(
                seen.len(),
                pool_ids.len(),
                "{class:?}: every pool item should be reachable"
            );
            assert!(
                saw_weapon,
                "{class:?}: should drop an equippable weapon across the sweep"
            );
        }
    }

    #[test]
    fn roll_is_deterministic_and_context_sensitive() {
        let baseline =
            roll_humanoid_loot(HumanoidLootClass::Trooper, 1234, "rogue-01", "overworld", 0);
        for _ in 0..128 {
            assert_eq!(
                roll_humanoid_loot(HumanoidLootClass::Trooper, 1234, "rogue-01", "overworld", 0),
                baseline,
                "identical inputs must roll identically"
            );
        }
        let by_actor: Vec<_> = (0..64u32)
            .map(|i| {
                roll_humanoid_loot(
                    HumanoidLootClass::Trooper,
                    1234,
                    &format!("rogue-{i}"),
                    "overworld",
                    0,
                )
            })
            .collect();
        assert!(
            by_actor.iter().any(|r| *r != baseline),
            "roll must depend on actor id"
        );
        let by_tick: Vec<_> = (0..64u64)
            .map(|t| {
                roll_humanoid_loot(
                    HumanoidLootClass::Trooper,
                    2_000 + t,
                    "rogue-01",
                    "overworld",
                    0,
                )
            })
            .collect();
        assert!(
            by_tick.iter().any(|r| *r != baseline),
            "roll must depend on death tick"
        );
        let area_a =
            roll_humanoid_loot(HumanoidLootClass::Trooper, 1234, "rogue-01", "verdance", 0);
        let area_b =
            roll_humanoid_loot(HumanoidLootClass::Trooper, 1234, "rogue-01", "verdance", 0);
        assert_eq!(area_a, area_b, "area-seeded roll still deterministic");
    }
}
