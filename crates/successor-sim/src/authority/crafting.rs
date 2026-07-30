use super::extraction_math::battery_runtime_seconds;
use super::*;

const PROFESSION_TRAINER_INTERACTION_RADIUS_MILLI_CELLS: i32 = 1_750;
const CRAFT_LOOTED_SCHEMATIC_VARIANT_BASE: u32 = 52_000_000;
const CRAFT_LOOTED_SCHEMATIC_RECIPE_STRIDE: u32 = 1_001;
const CRAFT_DRAFTED_SCHEMATIC_VARIANT_BASE: u32 = 53_000_000;
const CRAFT_LINE_FLOOR_MILLI: u16 = 100;
const CRAFT_ASSEMBLY_ROLL_SALT: u64 = 17;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CraftRecipeSlotDefinition {
    symbol: &'static str,
    resource_kind_label: &'static str,
    required_item_id: u32,
    required_family: Option<&'static str>,
    required_qty: u32,
    craft_relevant_stat: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CraftLineWeight {
    slot_index: u8,
    stat: &'static str,
    weight: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CraftLineDefinition {
    line_id: u8,
    label: &'static str,
    weights: &'static [CraftLineWeight],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CraftRecipeDefinition {
    id: &'static str,
    name: &'static str,
    category: &'static str,
    output_item_id: u32,
    output_preview_variant_id: u32,
    required_skill_box: &'static str,
    tier: u8,
    hands_craftable: bool,
    /// The profession whose track drives assembly/experimentation and receives
    /// craft XP. Most gear is Craftsman work; profession-specific field goods
    /// can instead use their owning profession.
    craft_profession: AuthorityProfessionKind,
    slots: &'static [CraftRecipeSlotDefinition],
    lines: &'static [CraftLineDefinition],
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CraftRecipeAccess {
    Locked,
    Profession,
    Learned,
    PermanentLoot {
        container: String,
        stack_id: u64,
        variant_id: u32,
    },
    LimitedLoot {
        container: String,
        stack_id: u64,
        variant_id: u32,
        remaining_uses: u16,
    },
}

impl CraftRecipeAccess {
    fn unlocked(&self) -> bool {
        !matches!(self, Self::Locked)
    }

    fn source_label(&self) -> &'static str {
        match self {
            Self::Locked => "locked",
            Self::Profession => "profession",
            Self::Learned => "learned",
            Self::PermanentLoot { .. } => "looted_schematic",
            Self::LimitedLoot { .. } => "looted_schematic",
        }
    }

    fn remaining_uses(&self) -> Option<u16> {
        match self {
            Self::LimitedLoot { remaining_uses, .. } => Some(*remaining_uses),
            _ => None,
        }
    }
}

const FIELD_MULTITOOL_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "casing",
        resource_kind_label: "Iron casing",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: CRAFT_FIELD_MULTITOOL_IRON_QTY,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "conductor",
        resource_kind_label: "Copper conductor",
        required_item_id: RESOURCE_COPPER_ITEM_ID,
        required_family: Some("copper"),
        required_qty: CRAFT_FIELD_MULTITOOL_COPPER_QTY,
        craft_relevant_stat: "conductivity",
    },
];

const CAMP_KIT_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "frame",
        resource_kind_label: "Bone frame",
        required_item_id: RESOURCE_CREATURE_BONE_ITEM_ID,
        required_family: Some("bone"),
        required_qty: 24,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "shell",
        resource_kind_label: "Hide cover",
        required_item_id: RESOURCE_CREATURE_HIDE_ITEM_ID,
        required_family: Some("hide"),
        required_qty: 36,
        craft_relevant_stat: "flexibility",
    },
];

const FIELD_MULTITOOL_QUALITY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "tensile_strength",
        weight: 45,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "conductivity",
        weight: 55,
    },
];

const FIELD_MULTITOOL_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "tool_quality",
    weights: &FIELD_MULTITOOL_QUALITY_WEIGHTS,
}];

const IRRIGATION_SPRINKLER_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "conductor",
        resource_kind_label: "Copper conductor",
        required_item_id: RESOURCE_COPPER_ITEM_ID,
        required_family: Some("copper"),
        required_qty: CRAFT_IRRIGATION_SPRINKLER_COPPER_QTY,
        craft_relevant_stat: "conductivity",
    },
    CraftRecipeSlotDefinition {
        symbol: "housing",
        resource_kind_label: "Polymer housing",
        required_item_id: RESOURCE_POLYMER_ITEM_ID,
        required_family: Some("polymer"),
        required_qty: CRAFT_IRRIGATION_SPRINKLER_POLYMER_QTY,
        craft_relevant_stat: "flexibility",
    },
];

const IRRIGATION_SPRINKLER_QUALITY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 55,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "flexibility",
        weight: 45,
    },
];

const IRRIGATION_SPRINKLER_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "tool_quality",
    weights: &IRRIGATION_SPRINKLER_QUALITY_WEIGHTS,
}];

// The sprinkler is a novice Craftsman structure because agriculture has no profession track yet.
// It uses the same Field Multitool quality line as other simple crafted tools.

const FUEL_SLOTS: [CraftRecipeSlotDefinition; 1] = [CraftRecipeSlotDefinition {
    symbol: "feedstock",
    resource_kind_label: "Petrochemical feedstock",
    required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
    required_family: Some("chemical"),
    required_qty: CRAFT_FUEL_PETROCHEMICAL_QTY,
    craft_relevant_stat: "chemical_purity",
}];

// Coil Slug ammunition: forged slug bodies + pressed Clodpowder charge wafers.
// Same material law as the legacy CraftItem ammo_slug_iron / slug_iron path;
// modern coverage is the slotted CRAFT_RECIPES session (begin/load/assemble/finalize).
const IRON_SLUG_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "body",
        resource_kind_label: "Iron slug body",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: CRAFT_SUPPLY_AMMO_IRON_QTY,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "charge",
        resource_kind_label: "Clodpowder charge wafer",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
        craft_relevant_stat: "potency",
    },
];
const POLYMER_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "feedstock",
        resource_kind_label: "Petrochemical feedstock",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: CRAFT_POLYMER_PETROCHEMICAL_QTY,
        craft_relevant_stat: "chemical_purity",
    },
    CraftRecipeSlotDefinition {
        symbol: "carbon",
        resource_kind_label: "Carbon matrix",
        required_item_id: RESOURCE_CARBON_ITEM_ID,
        required_family: Some("carbon"),
        required_qty: CRAFT_POLYMER_CARBON_QTY,
        craft_relevant_stat: "stability",
    },
];

const POLYMER_FLEXIBILITY_WEIGHTS: [CraftLineWeight; 4] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "chemical_purity",
        weight: 30,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "stability",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "density",
        weight: 25,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 25,
    },
];

const POLYMER_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "flexibility",
    weights: &POLYMER_FLEXIBILITY_WEIGHTS,
}];

const EXTRACTOR_BATTERY_SLOTS: [CraftRecipeSlotDefinition; 3] = [
    CraftRecipeSlotDefinition {
        symbol: "conductor",
        resource_kind_label: "Copper conductor",
        required_item_id: RESOURCE_COPPER_ITEM_ID,
        required_family: Some("copper"),
        required_qty: CRAFT_EXTRACTOR_BATTERY_COPPER_QTY,
        craft_relevant_stat: "conductivity",
    },
    CraftRecipeSlotDefinition {
        symbol: "casing",
        resource_kind_label: "Iron casing",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: CRAFT_EXTRACTOR_BATTERY_IRON_QTY,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "fuel",
        resource_kind_label: "Processed fuel",
        required_item_id: RESOURCE_FUEL_ITEM_ID,
        required_family: Some("fuel"),
        required_qty: CRAFT_EXTRACTOR_BATTERY_FUEL_QTY,
        craft_relevant_stat: "chemical_purity",
    },
];

const EXTRACTOR_BATTERY_RUNTIME_WEIGHTS: [CraftLineWeight; 4] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 45,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "tensile_strength",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "chemical_purity",
        weight: 25,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "stability",
        weight: 10,
    },
];

const EXTRACTOR_BATTERY_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "runtime",
    weights: &EXTRACTOR_BATTERY_RUNTIME_WEIGHTS,
}];

const METAL_EXTRACTOR_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "structural",
        resource_kind_label: "Iron structural frame",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: CRAFT_METAL_EXTRACTOR_IRON_QTY,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "conductor",
        resource_kind_label: "Copper conductor",
        required_item_id: RESOURCE_COPPER_ITEM_ID,
        required_family: Some("copper"),
        required_qty: CRAFT_METAL_EXTRACTOR_COPPER_QTY,
        craft_relevant_stat: "conductivity",
    },
];

const METAL_EXTRACTOR_RATE_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "tensile_strength",
        weight: 40,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "extraction_yield",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "conductivity",
        weight: 40,
    },
];

const METAL_EXTRACTOR_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "extraction_rate",
    weights: &METAL_EXTRACTOR_RATE_WEIGHTS,
}];

const SLUGTHROWER_SLOTS: [CraftRecipeSlotDefinition; 3] = [
    CraftRecipeSlotDefinition {
        symbol: "barrel",
        resource_kind_label: "Iron barrel and throw-coil",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: CRAFT_SLUGTHROWER_MINERAL_QTY,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "dielectric",
        resource_kind_label: "Petrochemical capacitor dielectric",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: CRAFT_SLUGTHROWER_CHEMICAL_QTY,
        craft_relevant_stat: "chemical_purity",
    },
    CraftRecipeSlotDefinition {
        symbol: "grip",
        resource_kind_label: "Polymer grip",
        required_item_id: RESOURCE_POLYMER_ITEM_ID,
        required_family: Some("polymer"),
        required_qty: CRAFT_SLUGTHROWER_POLYMER_QTY,
        craft_relevant_stat: "flexibility",
    },
];

const SLUGTHROWER_POWER_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "tensile_strength",
        weight: 38,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "density",
        weight: 22,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 40,
    },
];

const SLUGTHROWER_HANDLING_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "malleability",
        weight: 34,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 22,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "flexibility",
        weight: 44,
    },
];

const SLUGTHROWER_RELIABILITY_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 34,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 36,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "flexibility",
        weight: 30,
    },
];

const SLUGTHROWER_LINES: [CraftLineDefinition; 3] = [
    CraftLineDefinition {
        line_id: 0,
        label: "power",
        weights: &SLUGTHROWER_POWER_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "handling",
        weights: &SLUGTHROWER_HANDLING_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 2,
        label: "reliability",
        weights: &SLUGTHROWER_RELIABILITY_WEIGHTS,
    },
];

const FIELD_SABER_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "blade",
        resource_kind_label: "Iron blade stock",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: 10,
        craft_relevant_stat: "malleability",
    },
    CraftRecipeSlotDefinition {
        symbol: "grip",
        resource_kind_label: "Carbon grip scales",
        required_item_id: RESOURCE_CARBON_ITEM_ID,
        required_family: Some("carbon"),
        required_qty: 3,
        craft_relevant_stat: "stability",
    },
];

const QUARRY_CHOPPER_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "blade",
        resource_kind_label: "Dense iron blade stock",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: 14,
        craft_relevant_stat: "density",
    },
    CraftRecipeSlotDefinition {
        symbol: "grip",
        resource_kind_label: "Carbon grip scales",
        required_item_id: RESOURCE_CARBON_ITEM_ID,
        required_family: Some("carbon"),
        required_qty: 4,
        craft_relevant_stat: "stability",
    },
];

const PRIMITIVE_BLADE_TEMPO_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "malleability",
        weight: 70,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 30,
    },
];

const PRIMITIVE_BLADE_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "tempo",
    weights: &PRIMITIVE_BLADE_TEMPO_WEIGHTS,
}];

const QUARRY_CHOPPER_TEMPO_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "density",
        weight: 70,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 30,
    },
];

const QUARRY_CHOPPER_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "tempo",
    weights: &QUARRY_CHOPPER_TEMPO_WEIGHTS,
}];

const LIGHTNING_CARBINE_SLOTS: [CraftRecipeSlotDefinition; 4] = [
    CraftRecipeSlotDefinition {
        symbol: "receiver",
        resource_kind_label: "Conductive copper receiver",
        required_item_id: RESOURCE_COPPER_ITEM_ID,
        required_family: Some("copper"),
        required_qty: 18,
        craft_relevant_stat: "conductivity",
    },
    CraftRecipeSlotDefinition {
        symbol: "frame",
        resource_kind_label: "Iron barrel frame",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: 12,
        craft_relevant_stat: "tensile_strength",
    },
    CraftRecipeSlotDefinition {
        symbol: "insulator",
        resource_kind_label: "Polymer insulator",
        required_item_id: RESOURCE_POLYMER_ITEM_ID,
        required_family: Some("polymer"),
        required_qty: 10,
        craft_relevant_stat: "flexibility",
    },
    CraftRecipeSlotDefinition {
        symbol: "arc_medium",
        resource_kind_label: "Ionized gas charge",
        required_item_id: RESOURCE_GAS_ITEM_ID,
        required_family: Some("gas"),
        required_qty: 6,
        craft_relevant_stat: "stability",
    },
];

const LIGHTNING_POWER_WEIGHTS: [CraftLineWeight; 4] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 35,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "tensile_strength",
        weight: 25,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "flexibility",
        weight: 15,
    },
    CraftLineWeight {
        slot_index: 3,
        stat: "stability",
        weight: 25,
    },
];

const LIGHTNING_HANDLING_WEIGHTS: [CraftLineWeight; 4] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "malleability",
        weight: 25,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "density",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "flexibility",
        weight: 35,
    },
    CraftLineWeight {
        slot_index: 3,
        stat: "stability",
        weight: 20,
    },
];

const LIGHTNING_RELIABILITY_WEIGHTS: [CraftLineWeight; 4] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "conductivity",
        weight: 30,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "tensile_strength",
        weight: 25,
    },
    CraftLineWeight {
        slot_index: 2,
        stat: "flexibility",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 3,
        stat: "stability",
        weight: 25,
    },
];

const LIGHTNING_CARBINE_LINES: [CraftLineDefinition; 3] = [
    CraftLineDefinition {
        line_id: 0,
        label: "power",
        weights: &LIGHTNING_POWER_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "handling",
        weights: &LIGHTNING_HANDLING_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 2,
        label: "reliability",
        weights: &LIGHTNING_RELIABILITY_WEIGHTS,
    },
];

// ── Medical crafting: component quality carries into the final product through
// `craft_slot_stats`. ──

// Component: Solid Delivery Shell (mineral only).
const SOLID_DELIVERY_SHELL_SLOTS: [CraftRecipeSlotDefinition; 1] = [CraftRecipeSlotDefinition {
    symbol: "shell",
    resource_kind_label: "Mineral casing",
    required_item_id: RESOURCE_MINERAL_ITEM_ID,
    required_family: Some("mineral"),
    required_qty: 20,
    craft_relevant_stat: "tensile_strength",
}];
const SOLID_DELIVERY_SHELL_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "tensile_strength",
        weight: 60,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "density",
        weight: 40,
    },
];
const SOLID_DELIVERY_SHELL_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "shell",
    weights: &SOLID_DELIVERY_SHELL_WEIGHTS,
}];

// Component: Biological Effect Controller (organic clodpowder + chemical).
const BEC_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "agent",
        resource_kind_label: "Bio agent (clodpowder)",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: 8,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "reagent",
        resource_kind_label: "Chemical reagent",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 6,
        craft_relevant_stat: "chemical_purity",
    },
];
const BEC_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "potency",
        weight: 60,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 40,
    },
];
const BEC_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "bio_effect",
    weights: &BEC_WEIGHTS,
}];

// Component: Liquid Suspension (water + chemical) — the water extraction family's customer.
const LIQUID_SUSPENSION_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "solvent",
        resource_kind_label: "Water solvent",
        required_item_id: RESOURCE_LIQUID_ITEM_ID,
        required_family: Some("water"),
        required_qty: 12,
        craft_relevant_stat: "chemical_purity",
    },
    CraftRecipeSlotDefinition {
        symbol: "reagent",
        resource_kind_label: "Chemical reagent",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 6,
        craft_relevant_stat: "chemical_purity",
    },
];
const LIQUID_SUSPENSION_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "chemical_purity",
        weight: 45,
    },
    CraftLineWeight {
        slot_index: 0,
        stat: "stability",
        weight: 20,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 35,
    },
];
const LIQUID_SUSPENSION_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "suspension",
    weights: &LIQUID_SUSPENSION_WEIGHTS,
}];

// Component: Chemical Release Duration Mechanism (chemical + mineral).
const CRDM_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "regulator",
        resource_kind_label: "Chemical regulator",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 8,
        craft_relevant_stat: "stability",
    },
    CraftRecipeSlotDefinition {
        symbol: "frame",
        resource_kind_label: "Mineral frame",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: 10,
        craft_relevant_stat: "stability",
    },
];
const CRDM_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "stability",
        weight: 55,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 45,
    },
];
const CRDM_LINES: [CraftLineDefinition; 1] = [CraftLineDefinition {
    line_id: 0,
    label: "duration",
    weights: &CRDM_WEIGHTS,
}];

// BASIC STIMPAK — organic (clodpowder) + inorganic (mineral), simple 2-slot (owner).
const BASIC_STIMPAK_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "biogel",
        resource_kind_label: "Bio-gel (clodpowder)",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: 12,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "salts",
        resource_kind_label: "Mineral salts",
        required_item_id: RESOURCE_MINERAL_ITEM_ID,
        required_family: Some("mineral"),
        required_qty: 8,
        craft_relevant_stat: "stability",
    },
];
const BASIC_STIMPAK_POTENCY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "potency",
        weight: 70,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 30,
    },
];
const BASIC_STIMPAK_QUANTITY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "extraction_yield",
        weight: 55,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "malleability",
        weight: 45,
    },
];
const BASIC_STIMPAK_LINES: [CraftLineDefinition; 2] = [
    CraftLineDefinition {
        line_id: 0,
        label: "potency",
        weights: &BASIC_STIMPAK_POTENCY_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "quantity",
        weights: &BASIC_STIMPAK_QUANTITY_WEIGHTS,
    },
];

// ADVANCED STIMPAK — BEC + LS + CRDM + Solid Delivery Shell. Component quality
// (potency channel synthesized by craft_slot_stats) drives the heal-line cap.
const ADVANCED_STIMPAK_SLOTS: [CraftRecipeSlotDefinition; 4] = [
    CraftRecipeSlotDefinition {
        symbol: "controller",
        resource_kind_label: "Biological Effect Controller",
        required_item_id: BIO_EFFECT_CONTROLLER_ITEM_ID,
        required_family: Some("component"),
        required_qty: CRAFT_ADVANCED_STIMPAK_COMPONENT_QTY,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "suspension",
        resource_kind_label: "Liquid Suspension",
        required_item_id: LIQUID_SUSPENSION_ITEM_ID,
        required_family: Some("component"),
        required_qty: CRAFT_ADVANCED_STIMPAK_COMPONENT_QTY,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "regulator",
        resource_kind_label: "Chemical Release Duration Mechanism",
        required_item_id: CHEMICAL_RELEASE_MECHANISM_ITEM_ID,
        required_family: Some("component"),
        required_qty: CRAFT_ADVANCED_STIMPAK_COMPONENT_QTY,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "shell",
        resource_kind_label: "Solid Delivery Shell",
        required_item_id: SOLID_DELIVERY_SHELL_ITEM_ID,
        required_family: Some("component"),
        required_qty: CRAFT_ADVANCED_STIMPAK_COMPONENT_QTY,
        craft_relevant_stat: "potency",
    },
];
const ADVANCED_STIMPAK_POTENCY_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "potency",
        weight: 55,
    }, // BEC — the healing effect
    CraftLineWeight {
        slot_index: 1,
        stat: "potency",
        weight: 20,
    }, // LS — dispersion
    CraftLineWeight {
        slot_index: 3,
        stat: "potency",
        weight: 25,
    }, // Shell — clean delivery
];
const ADVANCED_STIMPAK_QUANTITY_WEIGHTS: [CraftLineWeight; 3] = [
    CraftLineWeight {
        slot_index: 2,
        stat: "potency",
        weight: 45,
    }, // CRDM — sustained release
    CraftLineWeight {
        slot_index: 1,
        stat: "potency",
        weight: 30,
    }, // LS — volume
    CraftLineWeight {
        slot_index: 3,
        stat: "potency",
        weight: 25,
    }, // Shell
];
const ADVANCED_STIMPAK_LINES: [CraftLineDefinition; 2] = [
    CraftLineDefinition {
        line_id: 0,
        label: "potency",
        weights: &ADVANCED_STIMPAK_POTENCY_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "quantity",
        weights: &ADVANCED_STIMPAK_QUANTITY_WEIGHTS,
    },
];

// BUFF PACKS — the component-built buff-pack line. Body pack (clodpowder + chemical) -> health;
// Spirit pack (clodpowder + gas) -> action/spirit (per the landed vitals model).
const BODY_PACK_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "stimulant",
        resource_kind_label: "Bio-stimulant (clodpowder)",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: 12,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "binder",
        resource_kind_label: "Chemical binder",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 8,
        craft_relevant_stat: "chemical_purity",
    },
];
const SPIRIT_PACK_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "stimulant",
        resource_kind_label: "Bio-stimulant (clodpowder)",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: 12,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "inhalant",
        resource_kind_label: "Gas inhalant",
        required_item_id: RESOURCE_GAS_ITEM_ID,
        required_family: Some("gas"),
        required_qty: 8,
        craft_relevant_stat: "chemical_purity",
    },
];
const ENHANCEMENT_PACK_POTENCY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "potency",
        weight: 60,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 40,
    },
];
const ENHANCEMENT_PACK_QUANTITY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "extraction_yield",
        weight: 55,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 45,
    },
];
const ENHANCEMENT_PACK_LINES: [CraftLineDefinition; 2] = [
    CraftLineDefinition {
        line_id: 0,
        label: "potency",
        weights: &ENHANCEMENT_PACK_POTENCY_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "quantity",
        weights: &ENHANCEMENT_PACK_QUANTITY_WEIGHTS,
    },
];

// ANTI-STATE STIMS — anti-dizzy uses clodpowder; anti-blind uses water eyewash.
const ANTI_DIZZY_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "neuro",
        resource_kind_label: "Neuro-agent (clodpowder)",
        required_item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        required_family: Some("clodpowder"),
        required_qty: 10,
        craft_relevant_stat: "potency",
    },
    CraftRecipeSlotDefinition {
        symbol: "counter",
        resource_kind_label: "Chemical counter-agent",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 8,
        craft_relevant_stat: "chemical_purity",
    },
];
const ANTI_BLIND_SLOTS: [CraftRecipeSlotDefinition; 2] = [
    CraftRecipeSlotDefinition {
        symbol: "eyewash",
        resource_kind_label: "Water eyewash",
        required_item_id: RESOURCE_LIQUID_ITEM_ID,
        required_family: Some("water"),
        required_qty: 10,
        craft_relevant_stat: "chemical_purity",
    },
    CraftRecipeSlotDefinition {
        symbol: "counter",
        resource_kind_label: "Chemical counter-agent",
        required_item_id: RESOURCE_CHEMICAL_ITEM_ID,
        required_family: Some("chemical"),
        required_qty: 8,
        craft_relevant_stat: "chemical_purity",
    },
];
const ANTI_STATE_DEFENSE_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "potency",
        weight: 60,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 40,
    },
];
const ANTI_BLIND_DEFENSE_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "chemical_purity",
        weight: 60,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "chemical_purity",
        weight: 40,
    },
];
const ANTI_STATE_QUANTITY_WEIGHTS: [CraftLineWeight; 2] = [
    CraftLineWeight {
        slot_index: 0,
        stat: "extraction_yield",
        weight: 55,
    },
    CraftLineWeight {
        slot_index: 1,
        stat: "stability",
        weight: 45,
    },
];
const ANTI_STATE_LINES: [CraftLineDefinition; 2] = [
    CraftLineDefinition {
        line_id: 0,
        label: "defense",
        weights: &ANTI_STATE_DEFENSE_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "quantity",
        weights: &ANTI_STATE_QUANTITY_WEIGHTS,
    },
];
const ANTI_BLIND_LINES: [CraftLineDefinition; 2] = [
    CraftLineDefinition {
        line_id: 0,
        label: "defense",
        weights: &ANTI_BLIND_DEFENSE_WEIGHTS,
    },
    CraftLineDefinition {
        line_id: 1,
        label: "quantity",
        weights: &ANTI_STATE_QUANTITY_WEIGHTS,
    },
];

const CRAFT_RECIPES: [CraftRecipeDefinition; 32] = [
    CraftRecipeDefinition {
        id: "field_multitool",
        name: "Field Multitool",
        category: "tool",
        output_item_id: FIELD_MULTITOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: true,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_MULTITOOL_SLOTS,
        lines: &FIELD_MULTITOOL_LINES,
    },
    CraftRecipeDefinition {
        id: "camp_kit",
        name: "Camp Kit",
        category: "supply",
        output_item_id: CAMP_KIT_ITEM_ID,
        output_preview_variant_id: 0,
        required_skill_box: "scout-novice",
        tier: 1,
        hands_craftable: true,
        craft_profession: AuthorityProfessionKind::Scout,
        slots: &CAMP_KIT_SLOTS,
        lines: &[],
    },
    CraftRecipeDefinition {
        id: "iron_slug",
        name: "Iron Slug",
        category: "supply",
        output_item_id: AMMO_SLUG_IRON_ITEM_ID,
        output_preview_variant_id: 0,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &IRON_SLUG_SLOTS,
        lines: &[],
    },
    CraftRecipeDefinition {
        id: "shard_slug",
        name: "Shard Slug",
        category: "supply",
        output_item_id: AMMO_SLUG_SHARD_ITEM_ID,
        output_preview_variant_id: 0,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &IRON_SLUG_SLOTS,
        lines: &[],
    },
    CraftRecipeDefinition {
        id: "spike_slug",
        name: "Spike Slug",
        category: "supply",
        output_item_id: AMMO_SLUG_SPIKE_ITEM_ID,
        output_preview_variant_id: 0,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &IRON_SLUG_SLOTS,
        lines: &[],
    },
    CraftRecipeDefinition {
        id: "fuel",
        name: "Fuel",
        category: "component",
        output_item_id: RESOURCE_FUEL_ITEM_ID,
        output_preview_variant_id: 47_230_000,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FUEL_SLOTS,
        lines: &[],
    },
    CraftRecipeDefinition {
        id: "polymer",
        name: "Polymer",
        category: "component",
        output_item_id: RESOURCE_POLYMER_ITEM_ID,
        output_preview_variant_id: 48_000_650,
        required_skill_box: "craftsman-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &POLYMER_SLOTS,
        lines: &POLYMER_LINES,
    },
    CraftRecipeDefinition {
        id: "extractor_battery",
        name: "Extractor Battery",
        category: "component",
        output_item_id: EXTRACTOR_BATTERY_ITEM_ID,
        output_preview_variant_id: EXTRACTOR_BATTERY_VARIANT_BASE + 8_640,
        required_skill_box: "craftsman-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &EXTRACTOR_BATTERY_SLOTS,
        lines: &EXTRACTOR_BATTERY_LINES,
    },
    CraftRecipeDefinition {
        id: "metal_extractor",
        name: "Personal Mineral Sampler",
        category: "tool",
        output_item_id: METAL_EXTRACTOR_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &METAL_EXTRACTOR_SLOTS,
        lines: &METAL_EXTRACTOR_LINES,
    },
    CraftRecipeDefinition {
        id: "slugthrower",
        name: "Crafted Slugthrower Mk I",
        category: "weapon",
        output_item_id: CRAFTED_SLUGTHROWER_ITEM_ID,
        output_preview_variant_id: 81_050_050,
        required_skill_box: "craftsman-assembly-i",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &SLUGTHROWER_SLOTS,
        lines: &SLUGTHROWER_LINES,
    },
    CraftRecipeDefinition {
        id: "field_saber",
        name: "Field Saber",
        category: "weapon",
        output_item_id: FIELD_SABER_ITEM_ID,
        output_preview_variant_id: MELEE_WEAPON_SPEED_VARIANT_BASE + 1_050,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_SABER_SLOTS,
        lines: &PRIMITIVE_BLADE_LINES,
    },
    CraftRecipeDefinition {
        id: "quarry_chopper",
        name: "Quarry Chopper",
        category: "weapon",
        output_item_id: QUARRY_CHOPPER_ITEM_ID,
        output_preview_variant_id: MELEE_WEAPON_SPEED_VARIANT_BASE + 1_350,
        required_skill_box: "craftsman-assembly-i",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &QUARRY_CHOPPER_SLOTS,
        lines: &QUARRY_CHOPPER_LINES,
    },
    CraftRecipeDefinition {
        id: "kiln_carbine",
        name: "Kiln Energy Cell Carbine",
        category: "weapon",
        output_item_id: KILN_ENERGY_CELL_ITEM_ID,
        output_preview_variant_id: 81_060_055,
        required_skill_box: "craftsman-assembly-iii",
        tier: 4,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &SLUGTHROWER_SLOTS,
        lines: &SLUGTHROWER_LINES,
    },
    CraftRecipeDefinition {
        id: "lightning_carbine",
        name: "Lightning Carbine",
        category: "weapon",
        output_item_id: LIGHTNING_CARBINE_ITEM_ID,
        output_preview_variant_id: 81_065_060,
        required_skill_box: "craftsman-assembly-iv",
        tier: 5,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &LIGHTNING_CARBINE_SLOTS,
        lines: &LIGHTNING_CARBINE_LINES,
    },
    CraftRecipeDefinition {
        id: "mineral_survey_tool",
        name: "Mineral Survey Tool",
        category: "tool",
        output_item_id: MINERAL_SURVEY_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_MULTITOOL_SLOTS,
        lines: &FIELD_MULTITOOL_LINES,
    },
    CraftRecipeDefinition {
        id: "chemical_survey_tool",
        name: "Chemical Survey Device",
        category: "tool",
        output_item_id: CHEMICAL_SURVEY_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_MULTITOOL_SLOTS,
        lines: &FIELD_MULTITOOL_LINES,
    },
    CraftRecipeDefinition {
        id: "gas_survey_tool",
        name: "Gas Survey Tool",
        category: "tool",
        output_item_id: GAS_SURVEY_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_MULTITOOL_SLOTS,
        lines: &FIELD_MULTITOOL_LINES,
    },
    CraftRecipeDefinition {
        id: "water_survey_tool",
        name: "Water Survey Tool",
        category: "tool",
        output_item_id: WATER_SURVEY_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 1,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &FIELD_MULTITOOL_SLOTS,
        lines: &FIELD_MULTITOOL_LINES,
    },
    CraftRecipeDefinition {
        id: "chemical_extractor",
        name: "Personal Chemical Extractor",
        category: "tool",
        output_item_id: CHEMICAL_EXTRACTOR_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &METAL_EXTRACTOR_SLOTS,
        lines: &METAL_EXTRACTOR_LINES,
    },
    CraftRecipeDefinition {
        id: "gas_extractor",
        name: "Personal Gas Harvester",
        category: "tool",
        output_item_id: GAS_EXTRACTOR_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &METAL_EXTRACTOR_SLOTS,
        lines: &METAL_EXTRACTOR_LINES,
    },
    CraftRecipeDefinition {
        id: "water_extractor",
        name: "Survival Moisture Vaporator",
        category: "tool",
        output_item_id: WATER_EXTRACTOR_TOOL_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &METAL_EXTRACTOR_SLOTS,
        lines: &METAL_EXTRACTOR_LINES,
    },
    // ── MEDIC WAVE recipes (medic-gated; category drives the FE tab) ──
    CraftRecipeDefinition {
        id: "solid_delivery_shell",
        name: "Solid Delivery Shell",
        category: "component",
        output_item_id: SOLID_DELIVERY_SHELL_ITEM_ID,
        output_preview_variant_id: 650,
        required_skill_box: "medic-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &SOLID_DELIVERY_SHELL_SLOTS,
        lines: &SOLID_DELIVERY_SHELL_LINES,
    },
    CraftRecipeDefinition {
        id: "bio_effect_controller",
        name: "Biological Effect Controller",
        category: "component",
        output_item_id: BIO_EFFECT_CONTROLLER_ITEM_ID,
        output_preview_variant_id: 650,
        required_skill_box: "medic-medical-crafting-i",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &BEC_SLOTS,
        lines: &BEC_LINES,
    },
    CraftRecipeDefinition {
        id: "liquid_suspension",
        name: "Liquid Suspension",
        category: "component",
        output_item_id: LIQUID_SUSPENSION_ITEM_ID,
        output_preview_variant_id: 650,
        required_skill_box: "medic-medical-crafting-i",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &LIQUID_SUSPENSION_SLOTS,
        lines: &LIQUID_SUSPENSION_LINES,
    },
    CraftRecipeDefinition {
        id: "chemical_release_mechanism",
        name: "Chemical Release Duration Mechanism",
        category: "component",
        output_item_id: CHEMICAL_RELEASE_MECHANISM_ITEM_ID,
        output_preview_variant_id: 650,
        required_skill_box: "medic-medical-crafting-ii",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &CRDM_SLOTS,
        lines: &CRDM_LINES,
    },
    CraftRecipeDefinition {
        id: "basic_stimpak",
        name: "Basic Stimpak",
        category: "supply",
        output_item_id: STIMPAK_A_ITEM_ID,
        output_preview_variant_id: 42_120_012,
        required_skill_box: "medic-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &BASIC_STIMPAK_SLOTS,
        lines: &BASIC_STIMPAK_LINES,
    },
    CraftRecipeDefinition {
        id: "advanced_stimpak",
        name: "Advanced Stimpak",
        category: "supply",
        output_item_id: ADVANCED_STIMPAK_ITEM_ID,
        output_preview_variant_id: 45_280_018,
        required_skill_box: "medic-medical-crafting-ii",
        tier: 4,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &ADVANCED_STIMPAK_SLOTS,
        lines: &ADVANCED_STIMPAK_LINES,
    },
    CraftRecipeDefinition {
        id: "body_enhancement_pack",
        name: "Body Enhancement Pack",
        category: "supply",
        output_item_id: BODY_ENHANCEMENT_PACK_A_ITEM_ID,
        output_preview_variant_id: 43_070_020,
        required_skill_box: "medic-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &BODY_PACK_SLOTS,
        lines: &ENHANCEMENT_PACK_LINES,
    },
    CraftRecipeDefinition {
        id: "spirit_enhancement_pack",
        name: "Spirit Enhancement Pack",
        category: "supply",
        output_item_id: SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID,
        output_preview_variant_id: 44_075_020,
        required_skill_box: "medic-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &SPIRIT_PACK_SLOTS,
        lines: &ENHANCEMENT_PACK_LINES,
    },
    CraftRecipeDefinition {
        id: "anti_dizzy_stim",
        name: "Anti-Dizzy Stim",
        category: "supply",
        output_item_id: ANTI_DIZZY_STIM_ITEM_ID,
        output_preview_variant_id: 46_200_008,
        required_skill_box: "medic-medical-crafting-i",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &ANTI_DIZZY_SLOTS,
        lines: &ANTI_STATE_LINES,
    },
    CraftRecipeDefinition {
        id: "anti_blind_stim",
        name: "Anti-Blind Stim",
        category: "supply",
        output_item_id: ANTI_BLIND_STIM_ITEM_ID,
        output_preview_variant_id: 47_200_008,
        required_skill_box: "medic-medical-crafting-i",
        tier: 3,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Medic,
        slots: &ANTI_BLIND_SLOTS,
        lines: &ANTI_BLIND_LINES,
    },
    CraftRecipeDefinition {
        id: "irrigation_sprinkler",
        name: "Irrigation Sprinkler",
        category: "tool",
        output_item_id: IRRIGATION_SPRINKLER_ITEM_ID,
        output_preview_variant_id: STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
        required_skill_box: "craftsman-novice",
        tier: 2,
        hands_craftable: false,
        craft_profession: AuthorityProfessionKind::Craftsman,
        slots: &IRRIGATION_SPRINKLER_SLOTS,
        lines: &IRRIGATION_SPRINKLER_LINES,
    },
];

impl SliceAuthorityState {
    pub(super) fn actor_has_field_multitool(&self, actor_id: &str) -> bool {
        self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == FIELD_MULTITOOL_ITEM_ID
                && row.available > 0
                && actor_owns_inventory_container(actor_id, &row.container)
        })
    }

    pub(super) fn require_actor_field_multitool(
        &self,
        actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        if self.actor_has_field_multitool(actor_id) {
            Ok(())
        } else {
            Err(AuthorityRejectReason::MissingSurveyTool)
        }
    }

    pub(super) fn actor_field_multitool_quality_milli(&self, actor_id: &str) -> u16 {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == FIELD_MULTITOOL_ITEM_ID
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| u16::try_from(row.variant_id.min(1_000)).unwrap_or(500))
            .max()
            .unwrap_or(500)
    }

    pub(super) fn actor_has_starter_tool_item(
        &self,
        actor: &ActorAuthorityState,
        item_id: u32,
    ) -> bool {
        self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == item_id
                && row.available > 0
                && (actor_owns_inventory_container(&actor.id, &row.container)
                    || (row.container == EXCHANGE_CONTAINER
                        && self.actor_within_exchange_interaction_range(actor)))
        })
    }

    pub(super) fn trainer_teaches_profession(
        &self,
        trainer: &ActorAuthorityState,
        profession: AuthorityProfessionKind,
    ) -> bool {
        trainer.professions.learned.is_empty() || trainer.professions.has(profession)
    }

    pub(super) fn require_profession_trainer_for_actor(
        &self,
        actor: &ActorAuthorityState,
        trainer_actor_id: &str,
        profession: AuthorityProfessionKind,
    ) -> Result<ActorAuthorityState, AuthorityRejectReason> {
        let trainer = self
            .runtime
            .durable
            .actors
            .get(trainer_actor_id)
            .ok_or(AuthorityRejectReason::TrainerUnavailable)?;
        if trainer.life_state != AuthorityLifeState::Alive
            || trainer.area_id != actor.area_id
            || !is_profession_trainer_authority_actor(trainer)
            || !self.trainer_teaches_profession(trainer, profession)
            || position_distance_milli(actor.position, trainer.position)
                > PROFESSION_TRAINER_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::TrainerUnavailable);
        }
        Ok(trainer.clone())
    }

    pub(super) fn apply_request_starter_tool(
        &mut self,
        config: &SliceAuthorityConfig,
        trainer_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        self.require_profession_trainer_for_actor(
            &actor,
            trainer_actor_id,
            AuthorityProfessionKind::Craftsman,
        )?;
        let has_multitool = self.actor_has_starter_tool_item(&actor, FIELD_MULTITOOL_ITEM_ID);
        let has_mineral_survey_tool =
            self.actor_has_starter_tool_item(&actor, MINERAL_SURVEY_TOOL_ITEM_ID);
        if has_multitool && has_mineral_survey_tool {
            return Err(AuthorityRejectReason::ToolAlreadyHeld);
        }
        if self.runtime.durable.tick < actor.next_starter_tool_request_tick {
            return Err(AuthorityRejectReason::StarterToolCooldown);
        }
        if !has_multitool {
            let item_name = inventory_item_name(FIELD_MULTITOOL_ITEM_ID)
                .ok_or(AuthorityRejectReason::UnknownItem)?;
            // Toolmaker identity: starter quality scales 500 -> 650 with tools-IV.
            self.add_actor_inventory_stack(
                &actor.id,
                FIELD_MULTITOOL_ITEM_ID,
                actor
                    .professions
                    .craftsman_tools_starter_grant_quality_milli(),
                item_name,
                1,
                1,
                "field-pack",
            );
        }
        if !has_mineral_survey_tool {
            let item_name = inventory_item_name(MINERAL_SURVEY_TOOL_ITEM_ID)
                .ok_or(AuthorityRejectReason::UnknownItem)?;
            self.add_actor_inventory_stack(
                &actor.id,
                MINERAL_SURVEY_TOOL_ITEM_ID,
                STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
                item_name,
                1,
                1,
                "field-pack",
            );
        }
        let cooldown_ticks = ms_to_ticks_round(
            REQUEST_STARTER_TOOL_COOLDOWN_MS,
            self.runtime.durable.world.tick_rate_hz,
        );
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.next_starter_tool_request_tick =
                self.runtime.durable.tick.saturating_add(cooldown_ticks);
        }
        let issued = match (has_multitool, has_mineral_survey_tool) {
            (false, false) => "a Field Multitool and Mineral Survey Tool",
            (false, true) => "a Field Multitool",
            (true, false) => "a Mineral Survey Tool",
            (true, true) => unreachable!("complete starter kit rejected above"),
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} received {} from {}", actor.id, issued, trainer_actor_id),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_craft_begin(
        &mut self,
        config: &SliceAuthorityConfig,
        recipe_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        if actor.craft_session.is_some() {
            return Err(AuthorityRejectReason::CraftSessionActive);
        }
        let recipe = craft_recipe(recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let access = self.craft_recipe_access(&actor, recipe);
        if !access.unlocked() {
            return Err(AuthorityRejectReason::UnknownSchematic);
        }
        self.craft_tool_quality_for_recipe(&actor.id, recipe)?;
        let limited_schematic = match access {
            CraftRecipeAccess::LimitedLoot {
                container,
                stack_id,
                variant_id,
                remaining_uses,
            } => Some(CraftLimitedSchematicUseState {
                container,
                stack_id,
                variant_id,
                remaining_uses,
            }),
            CraftRecipeAccess::PermanentLoot {
                container,
                stack_id,
                variant_id,
            } => {
                self.consume_exact_actor_stack(
                    &actor.id,
                    &container,
                    stack_id,
                    LOOTED_SCHEMATIC_ITEM_ID,
                    variant_id,
                    1,
                )?;
                if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
                    live.known_recipe_ids.insert(recipe.id.to_owned());
                }
                None
            }
            _ => None,
        };
        let session = CraftSessionState {
            recipe_id: recipe.id.to_owned(),
            phase: CraftSessionPhase::SlotFill,
            slots: vec![None; recipe.slots.len()],
            resource_locks: Vec::new(),
            assembly_seed: 0,
            assembly_quality_milli: 0,
            experimentation_points_remaining: 0,
            lines: Vec::new(),
            limited_schematic,
        };
        let actor_id = actor.id.clone();
        self.runtime
            .durable
            .actors
            .get_mut(&actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .craft_session = Some(session);
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} began crafting {}", actor.id, recipe.name),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_assign_slot(
        &mut self,
        config: &SliceAuthorityConfig,
        slot_index: u8,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?;
        if session.phase != CraftSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::CraftAlreadyAssembled);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let slot = recipe
            .slots
            .get(usize::from(slot_index))
            .ok_or(AuthorityRejectReason::CraftSlotMismatch)?;
        let parsed_stack_id =
            parse_craft_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let (_, row) = self
            .find_exact_actor_stack(&actor.id, container, parsed_stack_id, variant_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if row.item_id != slot.required_item_id {
            return Err(AuthorityRejectReason::CraftSlotMismatch);
        }
        let stats = craft_slot_stats(row.item_id, row.variant_id)
            .ok_or(AuthorityRejectReason::CraftSlotMismatch)?;
        let assignment = CraftSlotAssignmentState {
            slot_index,
            container: row.container,
            stack_id: row.stack_id,
            item_id: row.item_id,
            variant_id: row.variant_id,
            quantity: slot.required_qty,
            stats,
        };
        let mut candidate_slots = session.slots.clone();
        candidate_slots[usize::from(slot_index)] = Some(assignment);
        let candidate_assignments = candidate_slots.into_iter().flatten().collect::<Vec<_>>();
        self.validate_craft_assignment_reservations(&actor.id, &candidate_assignments)?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .craft_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoCraftSession)?;
        live_session.slots[usize::from(slot_index)] = candidate_assignments
            .into_iter()
            .find(|a| a.slot_index == slot_index);
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_clear_slot(
        &mut self,
        config: &SliceAuthorityConfig,
        slot_index: u8,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let session = live
            .craft_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoCraftSession)?;
        if session.phase != CraftSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::CraftAlreadyAssembled);
        }
        let slot = session
            .slots
            .get_mut(usize::from(slot_index))
            .ok_or(AuthorityRejectReason::CraftSlotMismatch)?;
        *slot = None;
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_assemble(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?
            .clone();
        if session.phase != CraftSessionPhase::SlotFill {
            return Err(AuthorityRejectReason::CraftAlreadyAssembled);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let assignments = filled_craft_slots(&session, recipe)?;
        self.validate_craft_assignment_reservations(&actor.id, &assignments)?;
        if let Some(limited) = session.limited_schematic.as_ref() {
            self.validate_limited_schematic_use(&actor.id, limited)?;
        }
        let tool_quality_milli = self.craft_tool_quality_for_recipe(&actor.id, recipe)?;
        let mut consumed = BTreeMap::<(String, u64, u32, u32), u32>::new();
        for assignment in &assignments {
            let key = (
                assignment.container.clone(),
                assignment.stack_id,
                assignment.item_id,
                assignment.variant_id,
            );
            let quantity = consumed.entry(key).or_default();
            *quantity = quantity.saturating_add(assignment.quantity);
        }
        for ((container, stack_id, item_id, variant_id), quantity) in consumed {
            self.consume_exact_actor_stack(
                &actor.id, &container, stack_id, item_id, variant_id, quantity,
            )?;
        }
        if let Some(limited) = session.limited_schematic.as_ref() {
            self.consume_limited_schematic_use(&actor.id, limited)?;
        }
        let assembly_seed = craft_assembly_seed(
            config.craft_roll_key,
            &actor.id,
            recipe.id,
            self.runtime.durable.tick,
        );
        let assembly_roll = (ai_rand(
            assembly_seed,
            self.runtime.durable.tick,
            CRAFT_ASSEMBLY_ROLL_SALT,
        ) * 1_000.0) as i32;
        let assembly_quality_milli = craft_assembly_quality_milli(
            assembly_roll,
            actor
                .professions
                .craft_assembly_bonus(recipe.craft_profession),
            tool_quality_milli,
        );
        let lines = recipe
            .lines
            .iter()
            .map(|line| {
                let cap_milli = craft_line_cap_milli(line, &assignments);
                let value_milli = craft_initial_line_value_milli(cap_milli, assembly_quality_milli);
                CraftSessionLineState {
                    line_id: line.line_id,
                    label: line.label.to_owned(),
                    value_milli,
                    cap_milli,
                }
            })
            .collect::<Vec<_>>();
        let resource_locks = assignments
            .iter()
            .map(|assignment| CraftResourceLock {
                item_id: assignment.item_id,
                variant_id: assignment.variant_id,
                quantity: assignment.quantity,
            })
            .collect::<Vec<_>>();
        let xp = CRAFT_XP_PER_TIER.saturating_mul(u64::from(recipe.tier));
        let total_xp = self.award_profession_tracks_xp(
            &actor.id,
            recipe.craft_profession,
            craft_assembly_xp_tracks(recipe.craft_profession),
            xp,
        )?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .craft_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoCraftSession)?;
        live_session.phase = CraftSessionPhase::Assembled;
        live_session.resource_locks = resource_locks;
        live_session.assembly_seed = assembly_seed;
        live_session.assembly_quality_milli = assembly_quality_milli;
        live_session.experimentation_points_remaining = live
            .professions
            .craft_experimentation_points(recipe.craft_profession);
        live_session.lines = lines;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} assembled {} (+{} {} XP, total {})",
                actor.id,
                recipe.name,
                xp,
                recipe.craft_profession.label(),
                total_xp
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_experiment(
        &mut self,
        config: &SliceAuthorityConfig,
        line_id: u8,
        points: u8,
    ) -> Result<(), AuthorityRejectReason> {
        if points == 0 {
            return Err(AuthorityRejectReason::InvalidExperimentLine);
        }
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?
            .clone();
        if session.phase != CraftSessionPhase::Assembled {
            return Err(AuthorityRejectReason::CraftNotAssembled);
        }
        if points > session.experimentation_points_remaining {
            return Err(AuthorityRejectReason::InvalidExperimentation);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let tool_quality_milli = self.craft_tool_quality_for_recipe(&actor.id, recipe)?;
        let line = session
            .lines
            .iter()
            .find(|line| line.line_id == line_id)
            .ok_or(AuthorityRejectReason::InvalidExperimentLine)?;
        if line.value_milli >= line.cap_milli {
            return Err(AuthorityRejectReason::InvalidExperimentLine);
        }
        let tool_bonus = (i32::from(tool_quality_milli) - 500) / 10;
        let experimentation_bonus = actor
            .professions
            .craft_experimentation_bonus(recipe.craft_profession)
            .saturating_add(tool_bonus);
        let malleability_milli = craft_line_malleability_milli(recipe, &session, line_id);
        let attempt_salt = u64::from(line_id)
            .saturating_add(1)
            .saturating_mul(1_000)
            .saturating_add(u64::from(session.experimentation_points_remaining))
            .saturating_add(u64::from(points).saturating_mul(10_000));
        let new_value = experiment_line_with_context(
            line.value_milli,
            line.cap_milli,
            session.assembly_seed,
            attempt_salt,
            points,
            experimentation_bonus,
            malleability_milli,
        );
        let xp = CRAFT_XP_PER_EXPERIMENT_POINT.saturating_mul(u64::from(points));
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            recipe.craft_profession,
            craft_experiment_xp_track(recipe.craft_profession),
            xp,
        )?;
        let live = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let live_session = live
            .craft_session
            .as_mut()
            .ok_or(AuthorityRejectReason::NoCraftSession)?;
        let live_line = live_session
            .lines
            .iter_mut()
            .find(|line| line.line_id == line_id)
            .ok_or(AuthorityRejectReason::InvalidExperimentLine)?;
        live_line.value_milli = new_value;
        live_session.experimentation_points_remaining = live_session
            .experimentation_points_remaining
            .saturating_sub(points);
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} experimented on {} line {} with {} point(s) (+{} {} XP, total {})",
                actor.id,
                recipe.name,
                line_id,
                points,
                xp,
                recipe.craft_profession.label(),
                total_xp
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }
    pub(super) fn apply_craft_finalize_prototype(
        &mut self,
        config: &SliceAuthorityConfig,
        custom_name: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?
            .clone();
        if session.phase != CraftSessionPhase::Assembled {
            return Err(AuthorityRejectReason::CraftNotAssembled);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let custom_name = normalize_craft_name(custom_name)?;
        let variant_id = apply_crafted_tool_quality_floor(
            recipe,
            craft_output_variant_id(recipe, &session)?,
            &actor,
        );
        let item_name = custom_name.unwrap_or_else(|| recipe.name.to_owned());
        let stack_cap = crafted_output_stack_cap(recipe.output_item_id);
        self.add_actor_named_inventory_stack(
            &actor.id,
            recipe.output_item_id,
            variant_id,
            &item_name,
            crafted_output_quantity(recipe),
            stack_cap,
            crafted_output_container_suffix(recipe.output_item_id),
        );
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.craft_session = None;
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} finalized {} prototype", actor.id, recipe.name),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_finalize_practice(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?
            .clone();
        if session.phase != CraftSessionPhase::Assembled {
            return Err(AuthorityRejectReason::CraftNotAssembled);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let base_xp = CRAFT_XP_PER_TIER.saturating_mul(u64::from(recipe.tier));
        let rounded_practice_xp = base_xp.saturating_mul(105).saturating_add(50) / 100;
        let extra_xp = rounded_practice_xp.saturating_sub(base_xp);
        let total_xp = self.award_profession_tracks_xp(
            &actor.id,
            recipe.craft_profession,
            craft_assembly_xp_tracks(recipe.craft_profession),
            extra_xp,
        )?;
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.craft_session = None;
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} completed {} practice (+{} {} XP, total {})",
                actor.id,
                recipe.name,
                extra_xp,
                recipe.craft_profession.label(),
                total_xp
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_craft_draft_schematic(
        &mut self,
        config: &SliceAuthorityConfig,
        max_uses: u16,
    ) -> Result<(), AuthorityRejectReason> {
        let uses = max_uses.min(1_000);
        if uses == 0 {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        }
        let actor = self.ready_craft_actor(config)?.clone();
        let session = actor
            .craft_session
            .as_ref()
            .ok_or(AuthorityRejectReason::NoCraftSession)?
            .clone();
        if session.phase != CraftSessionPhase::Assembled {
            return Err(AuthorityRejectReason::CraftNotAssembled);
        }
        let recipe =
            craft_recipe(&session.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        let output_variant_id = craft_output_variant_id(recipe, &session)?;
        let seq = self.runtime.durable.next_drafted_schematic_id.max(1);
        self.runtime.durable.next_drafted_schematic_id = seq.saturating_add(1).max(1);
        let id = format!("draft:{}:{}", actor.id, seq);
        let variant_id = CRAFT_DRAFTED_SCHEMATIC_VARIANT_BASE
            .saturating_add(u32::try_from(seq.min(u64::from(u32::MAX))).unwrap_or(u32::MAX));
        self.runtime.durable.drafted_schematics.insert(
            id.clone(),
            DraftedSchematicState {
                id: id.clone(),
                owner_actor_id: actor.id.clone(),
                recipe_id: recipe.id.to_owned(),
                resource_locks: session.resource_locks.clone(),
                output_item_id: recipe.output_item_id,
                output_variant_id,
                schematic_item_variant_id: variant_id,
                max_uses: uses,
                remaining_uses: uses,
            },
        );
        self.add_actor_inventory_stack(
            &actor.id,
            DRAFTED_SCHEMATIC_ITEM_ID,
            variant_id,
            &format!("Drafted Factory Schematic: {}", recipe.name),
            1,
            1,
            "datapad",
        );
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.craft_session = None;
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} drafted schematic {} for {} use(s)", actor.id, id, uses),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(super) fn apply_factory_manufacture(
        &mut self,
        config: &SliceAuthorityConfig,
        factory_id: &str,
        schematic_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let factory_id = factory_id.trim();
        let schematic_id = schematic_id.trim();
        if factory_id.is_empty() {
            return Err(AuthorityRejectReason::UnknownFactory);
        }
        if schematic_id.is_empty() {
            return Err(AuthorityRejectReason::UnknownSchematic);
        }
        let terminal = self
            .runtime
            .durable
            .world
            .terminals
            .iter()
            .find(|terminal| terminal.id == factory_id && terminal.kind == "factory")
            .cloned()
            .ok_or(AuthorityRejectReason::UnknownFactory)?;
        if terminal.area_id != actor.area_id
            || position_distance_milli(actor.position, AuthorityPosition::from_cell(terminal.cell))
                > banking::TERMINAL_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::NotAtFactory);
        }
        let schematic = self
            .runtime
            .durable
            .drafted_schematics
            .get(schematic_id)
            .cloned()
            .ok_or(AuthorityRejectReason::UnknownSchematic)?;
        if schematic.owner_actor_id != actor.id {
            return Err(AuthorityRejectReason::FactoryDraftMismatch);
        }
        if schematic.remaining_uses == 0 {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        }
        // Known recipe required before any mutation; no fallback after debits.
        let recipe =
            craft_recipe(&schematic.recipe_id).ok_or(AuthorityRejectReason::UnknownSchematic)?;
        if recipe.output_item_id != schematic.output_item_id {
            return Err(AuthorityRejectReason::UnknownSchematic);
        }
        let output_qty = crafted_output_quantity(recipe);
        if output_qty == 0 {
            return Err(AuthorityRejectReason::UnknownSchematic);
        }
        let stack_cap = crafted_output_stack_cap(recipe.output_item_id);
        let container_suffix = crafted_output_container_suffix(recipe.output_item_id);
        let item_name = recipe.name.to_owned();
        if schematic.schematic_item_variant_id == 0 {
            return Err(AuthorityRejectReason::FactoryDraftMissing);
        }
        let physical_available = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == DRAFTED_SCHEMATIC_ITEM_ID
                    && row.variant_id == schematic.schematic_item_variant_id
                    && row.available > 0
                    && actor_owns_inventory_container(&actor.id, &row.container)
            })
            .try_fold(0u32, |acc, row| acc.checked_add(row.available))
            .ok_or(AuthorityRejectReason::FactoryDraftMissing)?;
        if physical_available == 0 {
            return Err(AuthorityRejectReason::FactoryDraftMissing);
        }
        let remaining_uses = schematic
            .remaining_uses
            .checked_sub(1)
            .ok_or(AuthorityRejectReason::SchematicUsesExceeded)?;
        let spent = remaining_uses == 0;
        let physical_reserved: u32 = if spent { 1 } else { 0 };
        if physical_available < physical_reserved {
            return Err(AuthorityRejectReason::FactoryDraftMissing);
        }
        let mut required: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        for lock in &schematic.resource_locks {
            if lock.quantity == 0 {
                continue;
            }
            let key = (lock.item_id, lock.variant_id);
            let entry = required.entry(key).or_insert(0);
            *entry = entry
                .checked_add(lock.quantity)
                .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
        }
        let mut debit_plan: Vec<(String, u64, u32, u32, u32)> = Vec::new();
        for ((item_id, variant_id), need) in required.iter() {
            let mut remaining = *need;
            let mut candidates: Vec<(String, u64, u32)> = Vec::new();
            for row in self.runtime.durable.inventory.iter().filter(|row| {
                row.item_id == *item_id
                    && row.variant_id == *variant_id
                    && row.available > 0
                    && actor_owns_inventory_container(&actor.id, &row.container)
            }) {
                let mut available = row.available;
                if spent
                    && *item_id == DRAFTED_SCHEMATIC_ITEM_ID
                    && *variant_id == schematic.schematic_item_variant_id
                {
                    available = available.saturating_sub(physical_reserved);
                }
                if available > 0 {
                    candidates.push((row.container.clone(), row.stack_id, available));
                }
            }
            candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
            let available_total = candidates
                .iter()
                .try_fold(0u32, |acc, c| acc.checked_add(c.2))
                .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
            if available_total < remaining {
                return Err(AuthorityRejectReason::IngredientUnavailable);
            }
            for (container, stack_id, available) in candidates {
                if remaining == 0 {
                    break;
                }
                let take = available.min(remaining);
                if take == 0 {
                    continue;
                }
                debit_plan.push((container, stack_id, *item_id, *variant_id, take));
                remaining = remaining
                    .checked_sub(take)
                    .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
            }
            if remaining > 0 {
                return Err(AuthorityRejectReason::IngredientUnavailable);
            }
        }
        let mut draft_retire_plan: Option<(String, u64, u32, u32, u32)> = None;
        if spent {
            let mut draft_candidates: Vec<(String, u64, u32)> = self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|row| {
                    row.item_id == DRAFTED_SCHEMATIC_ITEM_ID
                        && row.variant_id == schematic.schematic_item_variant_id
                        && row.available > 0
                        && actor_owns_inventory_container(&actor.id, &row.container)
                })
                .map(|row| (row.container.clone(), row.stack_id, row.available))
                .collect();
            draft_candidates.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
            let (container, stack_id, available) = draft_candidates
                .into_iter()
                .next()
                .ok_or(AuthorityRejectReason::FactoryDraftMissing)?;
            if available == 0 {
                return Err(AuthorityRejectReason::FactoryDraftMissing);
            }
            draft_retire_plan = Some((
                container,
                stack_id,
                DRAFTED_SCHEMATIC_ITEM_ID,
                schematic.schematic_item_variant_id,
                1,
            ));
        }
        for (container, stack_id, item_id, variant_id, quantity) in
            debit_plan.iter().chain(draft_retire_plan.iter())
        {
            self.validate_exact_actor_stack(
                &actor.id,
                container,
                *stack_id,
                *item_id,
                *variant_id,
                *quantity,
            )?;
        }
        // Mutation phase is infallible after prevalidation: apply planned stack
        // debits directly, then mint output, then retire draft/uses. No fallible
        // helper calls after this point, so rejects cannot leave partial spends.
        let apply_exact = |inventory: &mut Vec<InventoryStackSnapshot>,
                           container: &str,
                           stack_id: u64,
                           item_id: u32,
                           variant_id: u32,
                           quantity: u32| {
            if let Some(row) = inventory.iter_mut().find(|row| {
                row.container == container
                    && row.stack_id == stack_id
                    && row.item_id == item_id
                    && row.variant_id == variant_id
            }) {
                row.quantity = row.quantity.saturating_sub(quantity);
                row.available = row.available.saturating_sub(quantity);
                row.reserved = row.reserved.min(row.quantity);
            }
        };
        for (container, stack_id, item_id, variant_id, quantity) in &debit_plan {
            apply_exact(
                &mut self.runtime.durable.inventory,
                container,
                *stack_id,
                *item_id,
                *variant_id,
                *quantity,
            );
        }
        if let Some((container, stack_id, item_id, variant_id, quantity)) =
            draft_retire_plan.as_ref()
        {
            apply_exact(
                &mut self.runtime.durable.inventory,
                container,
                *stack_id,
                *item_id,
                *variant_id,
                *quantity,
            );
        }
        self.prune_empty_inventory_rows();
        self.add_actor_named_inventory_stack(
            &actor.id,
            schematic.output_item_id,
            schematic.output_variant_id,
            &item_name,
            output_qty,
            stack_cap,
            container_suffix,
        );
        if spent {
            self.runtime.durable.drafted_schematics.remove(schematic_id);
        } else if let Some(live) = self
            .runtime
            .durable
            .drafted_schematics
            .get_mut(schematic_id)
        {
            live.remaining_uses = remaining_uses;
        }
        self.runtime.pending_factory_receipt = Some(AuthorityFactoryManufactureSnapshot {
            factory_id: factory_id.to_owned(),
            schematic_id: schematic_id.to_owned(),
            recipe_id: schematic.recipe_id.clone(),
            output_item_id: schematic.output_item_id,
            output_variant_id: schematic.output_variant_id,
            output_quantity: output_qty,
            remaining_uses,
            max_uses: schematic.max_uses,
            spent,
            tick: self.runtime.durable.tick,
        });
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} manufactured {} at {} ({} use(s) left)",
                actor.id, schematic_id, factory_id, remaining_uses
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_craft_cancel(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self.ready_craft_actor(config)?.clone();
        let Some(session) = actor.craft_session.as_ref().cloned() else {
            self.publish_craft_session(config);
            return Ok(());
        };
        let recipe_name = craft_recipe(&session.recipe_id)
            .map(|recipe| recipe.name)
            .unwrap_or(session.recipe_id.as_str());
        if let Some(live) = self.runtime.durable.actors.get_mut(&actor.id) {
            live.craft_session = None;
        }
        let loss_note = if session.phase == CraftSessionPhase::Assembled {
            " after assembly; resources remain consumed"
        } else {
            " before assembly"
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} cancelled {}{}", actor.id, recipe_name, loss_note),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        self.publish_craft_session(config);
        Ok(())
    }

    pub(crate) fn craft_session_snapshot_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<AuthorityCraftSessionSnapshot> {
        let actor = self.runtime.durable.actors.get(&config.player_actor_id)?;
        let recipes = self.craft_recipe_summaries_for_actor(actor);
        let Some(session) = actor.craft_session.as_ref() else {
            return Some(AuthorityCraftSessionSnapshot {
                phase: "browse".to_owned(),
                recipe_id: None,
                recipes,
                detail: None,
                slot_screen: None,
                details: self.craft_recipe_details_for_actor(actor, None),
                assembled: None,
                tick: self.runtime.durable.tick,
            });
        };
        let recipe = craft_recipe(&session.recipe_id)?;
        let detail = Some(self.craft_recipe_detail_snapshot(actor, recipe, Some(session)));
        let slot_screen = (session.phase == CraftSessionPhase::SlotFill)
            .then(|| self.craft_slot_screen_snapshot(actor, recipe, session));
        let assembled = (session.phase == CraftSessionPhase::Assembled)
            .then(|| self.craft_assembled_snapshot(actor, recipe, session))
            .transpose()
            .ok()
            .flatten();
        Some(AuthorityCraftSessionSnapshot {
            phase: session.phase.label().to_owned(),
            recipe_id: Some(recipe.id.to_owned()),
            recipes,
            detail,
            slot_screen,
            assembled,
            details: self.craft_recipe_details_for_actor(actor, Some(session)),
            tick: self.runtime.durable.tick,
        })
    }

    fn publish_craft_session(&mut self, config: &SliceAuthorityConfig) {
        self.runtime.pending_craft_session = self.craft_session_snapshot_for_observer(config);
    }

    fn ready_craft_actor(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Result<&ActorAuthorityState, AuthorityRejectReason> {
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
        Ok(actor)
    }

    fn craft_tool_quality_for_recipe(
        &self,
        actor_id: &str,
        recipe: &CraftRecipeDefinition,
    ) -> Result<u16, AuthorityRejectReason> {
        if self.actor_has_field_multitool(actor_id) {
            Ok(self.actor_field_multitool_quality_milli(actor_id))
        } else if recipe.hands_craftable {
            Ok(IMPROVISED_HANDS_TOOL_QUALITY_MILLI)
        } else {
            Err(AuthorityRejectReason::MissingSurveyTool)
        }
    }

    fn craft_recipe_access(
        &self,
        actor: &ActorAuthorityState,
        recipe: &CraftRecipeDefinition,
    ) -> CraftRecipeAccess {
        if actor.professions.has_skill_box(recipe.required_skill_box) {
            return CraftRecipeAccess::Profession;
        }
        if actor.known_recipe_ids.contains(recipe.id) {
            return CraftRecipeAccess::Learned;
        }
        let mut best_limited: Option<CraftRecipeAccess> = None;
        for row in self.runtime.durable.inventory.iter().filter(|row| {
            row.item_id == LOOTED_SCHEMATIC_ITEM_ID
                && row.available > 0
                && actor_owns_inventory_container(&actor.id, &row.container)
        }) {
            let Some((recipe_id, remaining_uses)) = decode_looted_schematic_variant(row.variant_id)
            else {
                continue;
            };
            if recipe_id != recipe.id {
                continue;
            }
            if remaining_uses == 0 {
                return CraftRecipeAccess::PermanentLoot {
                    container: row.container.clone(),
                    stack_id: row.stack_id,
                    variant_id: row.variant_id,
                };
            }
            let replace = match &best_limited {
                Some(CraftRecipeAccess::LimitedLoot {
                    remaining_uses: best,
                    ..
                }) => remaining_uses > *best,
                _ => true,
            };
            if replace {
                best_limited = Some(CraftRecipeAccess::LimitedLoot {
                    container: row.container.clone(),
                    stack_id: row.stack_id,
                    variant_id: row.variant_id,
                    remaining_uses,
                });
            }
        }
        best_limited.unwrap_or(CraftRecipeAccess::Locked)
    }

    fn craft_recipe_summaries_for_actor(
        &self,
        actor: &ActorAuthorityState,
    ) -> Vec<CraftRecipeSummarySnapshot> {
        ordered_craft_recipes()
            .into_iter()
            .map(|recipe| {
                let access = self.craft_recipe_access(actor, recipe);
                CraftRecipeSummarySnapshot {
                    recipe_id: recipe.id.to_owned(),
                    name: recipe.name.to_owned(),
                    category: recipe.category.to_owned(),
                    output_item_id: recipe.output_item_id,
                    output_preview_variant_id: recipe.output_preview_variant_id,
                    unlocked: access.unlocked(),
                    required_tool_item_id: if recipe.hands_craftable {
                        0
                    } else {
                        FIELD_MULTITOOL_ITEM_ID
                    },
                    required_profession: recipe.required_skill_box.to_owned(),
                    hands_craftable: recipe.hands_craftable,
                    source: access.source_label().to_owned(),
                    remaining_uses: access.remaining_uses(),
                }
            })
            .collect()
    }

    fn craft_recipe_detail_snapshot(
        &self,
        actor: &ActorAuthorityState,
        recipe: &CraftRecipeDefinition,
        session: Option<&CraftSessionState>,
    ) -> CraftRecipeDetailSnapshot {
        let slots = recipe
            .slots
            .iter()
            .enumerate()
            .map(|(index, slot)| CraftSlotSpecSnapshot {
                slot_index: u8::try_from(index).unwrap_or(u8::MAX),
                symbol: slot.symbol.to_owned(),
                resource_kind_label: slot.resource_kind_label.to_owned(),
                required_item_id: Some(slot.required_item_id),
                required_family: slot.required_family.map(str::to_owned),
                requirement_kind: craft_slot_requirement_kind(slot).to_owned(),
                required_item_name: craft_required_item_name(slot.required_item_id).to_owned(),
                required_qty: slot.required_qty,
                craft_relevant_stat: slot.craft_relevant_stat.to_owned(),
            })
            .collect::<Vec<_>>();
        let best_stats = recipe
            .slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                session
                    .filter(|session| session.recipe_id == recipe.id)
                    .and_then(|session| session.slots.get(index))
                    .and_then(|slot| slot.as_ref().map(|assignment| assignment.stats))
                    .or_else(|| self.best_craft_slot_stats(actor, slot))
            })
            .collect::<Vec<_>>();
        let stat_lines = recipe
            .lines
            .iter()
            .map(|line| CraftStatLinePreviewSnapshot {
                line_id: line.line_id,
                label: line.label.to_owned(),
                cap_estimate_milli: craft_line_cap_milli_from_stats(line, |slot_index| {
                    best_stats.get(usize::from(slot_index)).copied().flatten()
                }),
            })
            .collect();
        CraftRecipeDetailSnapshot {
            recipe_id: recipe.id.to_owned(),
            output_item_id: recipe.output_item_id,
            output_preview_variant_id: recipe.output_preview_variant_id,
            slots,
            stat_lines,
        }
    }

    fn craft_recipe_details_for_actor(
        &self,
        actor: &ActorAuthorityState,
        active_session: Option<&CraftSessionState>,
    ) -> Vec<CraftRecipeDetailSnapshot> {
        ordered_craft_recipes()
            .into_iter()
            .map(|recipe| {
                let session = active_session.filter(|session| session.recipe_id == recipe.id);
                self.craft_recipe_detail_snapshot(actor, recipe, session)
            })
            .collect()
    }

    fn craft_slot_screen_snapshot(
        &self,
        actor: &ActorAuthorityState,
        recipe: &CraftRecipeDefinition,
        session: &CraftSessionState,
    ) -> CraftSlotScreenSnapshot {
        let slots = recipe
            .slots
            .iter()
            .enumerate()
            .map(|(index, slot)| self.craft_slot_fill_snapshot(actor, session, index, slot))
            .collect::<Vec<_>>();
        let can_assemble =
            session.slots.len() == recipe.slots.len() && session.slots.iter().all(Option::is_some);
        CraftSlotScreenSnapshot {
            recipe_id: recipe.id.to_owned(),
            slots,
            can_assemble,
        }
    }

    fn craft_slot_fill_snapshot(
        &self,
        actor: &ActorAuthorityState,
        session: &CraftSessionState,
        index: usize,
        slot: &CraftRecipeSlotDefinition,
    ) -> CraftSlotFillSnapshot {
        let best_stat = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter_map(|row| self.craft_resource_option(actor, row, slot))
            .filter(|option| option.qty_available >= slot.required_qty)
            .map(|option| option.craft_relevant_stat_value)
            .max()
            .unwrap_or(0);
        let mut eligible = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter_map(|row| self.craft_resource_option(actor, row, slot))
            .map(|mut option| {
                option.recommended = option.qty_available >= slot.required_qty
                    && option.craft_relevant_stat_value == best_stat
                    && best_stat > 0;
                option
            })
            .collect::<Vec<_>>();
        eligible.sort_by(|left, right| {
            right
                .craft_relevant_stat_value
                .cmp(&left.craft_relevant_stat_value)
                .then_with(|| left.container.cmp(&right.container))
                .then_with(|| left.stack_id.cmp(&right.stack_id))
                .then_with(|| left.variant_id.cmp(&right.variant_id))
        });
        let assigned = session
            .slots
            .get(index)
            .and_then(|assignment| assignment.as_ref())
            .map(|assignment| CraftSlotAssignmentSnapshot {
                container: assignment.container.clone(),
                stack_id: assignment.stack_id.to_string(),
                variant_id: assignment.variant_id,
            });
        CraftSlotFillSnapshot {
            slot_index: u8::try_from(index).unwrap_or(u8::MAX),
            symbol: slot.symbol.to_owned(),
            resource_kind_label: slot.resource_kind_label.to_owned(),
            required_item_id: Some(slot.required_item_id),
            required_family: slot.required_family.map(str::to_owned),
            requirement_kind: craft_slot_requirement_kind(slot).to_owned(),
            required_item_name: craft_required_item_name(slot.required_item_id).to_owned(),
            required_qty: slot.required_qty,
            eligible,
            assigned,
        }
    }

    fn craft_resource_option(
        &self,
        actor: &ActorAuthorityState,
        row: &InventoryStackSnapshot,
        slot: &CraftRecipeSlotDefinition,
    ) -> Option<CraftResourceOptionSnapshot> {
        if row.item_id != slot.required_item_id
            || !actor_owns_inventory_container(&actor.id, &row.container)
        {
            return None;
        }
        let stats = craft_slot_stats(row.item_id, row.variant_id)?;
        Some(CraftResourceOptionSnapshot {
            container: row.container.clone(),
            stack_id: row.stack_id.to_string(),
            item_id: row.item_id,
            variant_id: row.variant_id,
            name: row.item.clone(),
            qty_available: row.available,
            craft_relevant_stat_value: resource_stat_value(stats, slot.craft_relevant_stat),
            recommended: false,
            stats: stats.into(),
        })
    }

    fn best_craft_slot_stats(
        &self,
        actor: &ActorAuthorityState,
        slot: &CraftRecipeSlotDefinition,
    ) -> Option<ResourceStats> {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter_map(|row| {
                if row.item_id != slot.required_item_id
                    || row.available < slot.required_qty
                    || !actor_owns_inventory_container(&actor.id, &row.container)
                {
                    return None;
                }
                let stats = craft_slot_stats(row.item_id, row.variant_id)?;
                Some((resource_stat_value(stats, slot.craft_relevant_stat), stats))
            })
            .max_by_key(|(value, _)| *value)
            .map(|(_, stats)| stats)
    }

    fn craft_assembled_snapshot(
        &self,
        actor: &ActorAuthorityState,
        recipe: &CraftRecipeDefinition,
        session: &CraftSessionState,
    ) -> Result<CraftAssembledSnapshot, AuthorityRejectReason> {
        let output_preview_variant_id = craft_output_variant_id(recipe, session)?;
        let tool_quality_milli = self.actor_field_multitool_quality_milli(&actor.id);
        Ok(CraftAssembledSnapshot {
            recipe_id: recipe.id.to_owned(),
            assembly_quality_milli: session.assembly_quality_milli,
            experimentation_points_remaining: session.experimentation_points_remaining,
            lines: session
                .lines
                .iter()
                .map(|line| CraftAssembledLineSnapshot {
                    line_id: line.line_id,
                    label: line.label.clone(),
                    value_milli: line.value_milli,
                    cap_milli: line.cap_milli,
                    can_raise: line.value_milli < line.cap_milli
                        && session.experimentation_points_remaining > 0,
                    one_point_success_milli: craft_one_point_success_milli(
                        recipe,
                        session,
                        line.line_id,
                        actor
                            .professions
                            .craft_experimentation_bonus(recipe.craft_profession),
                        tool_quality_milli,
                    ),
                    batch_risk_per_extra_point_milli: craft_batch_risk_per_extra_point_milli(),
                })
                .collect(),
            output_preview_variant_id,
        })
    }

    fn find_exact_actor_stack(
        &self,
        actor_id: &str,
        container: &str,
        stack_id: u64,
        variant_id: u32,
    ) -> Option<(usize, InventoryStackSnapshot)> {
        self.runtime
            .durable
            .inventory
            .iter()
            .enumerate()
            .find(|(_, row)| {
                row.container == container
                    && row.stack_id == stack_id
                    && row.variant_id == variant_id
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|(index, row)| (index, row.clone()))
    }

    pub(super) fn validate_craft_assignment_reservations(
        &self,
        actor_id: &str,
        assignments: &[CraftSlotAssignmentState],
    ) -> Result<(), AuthorityRejectReason> {
        let mut required_by_stack = BTreeMap::<(String, u64, u32, u32), u32>::new();
        for assignment in assignments {
            let key = (
                assignment.container.clone(),
                assignment.stack_id,
                assignment.item_id,
                assignment.variant_id,
            );
            let required = required_by_stack.entry(key).or_default();
            *required = required.saturating_add(assignment.quantity);
        }
        for ((container, stack_id, item_id, variant_id), required) in required_by_stack {
            let Some((_, row)) =
                self.find_exact_actor_stack(actor_id, &container, stack_id, variant_id)
            else {
                return Err(AuthorityRejectReason::ItemUnavailable);
            };
            if row.item_id != item_id || row.available < required {
                return Err(AuthorityRejectReason::CraftSlotMismatch);
            }
        }
        Ok(())
    }

    fn validate_exact_actor_stack(
        &self,
        actor_id: &str,
        container: &str,
        stack_id: u64,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let Some((_, row)) = self.find_exact_actor_stack(actor_id, container, stack_id, variant_id)
        else {
            return Err(AuthorityRejectReason::ItemUnavailable);
        };
        if row.item_id != item_id || row.available < quantity {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        Ok(())
    }

    pub(super) fn consume_exact_actor_stack(
        &mut self,
        actor_id: &str,
        container: &str,
        stack_id: u64,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        self.validate_exact_actor_stack(
            actor_id, container, stack_id, item_id, variant_id, quantity,
        )?;
        let index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| {
                row.container == container
                    && row.stack_id == stack_id
                    && row.item_id == item_id
                    && row.variant_id == variant_id
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let row = self
            .runtime
            .durable
            .inventory
            .get_mut(index)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        row.quantity = row.quantity.saturating_sub(quantity);
        row.available = row.available.saturating_sub(quantity);
        row.reserved = row.reserved.min(row.quantity);
        self.prune_empty_inventory_rows();
        Ok(())
    }

    fn validate_limited_schematic_use(
        &self,
        actor_id: &str,
        limited: &CraftLimitedSchematicUseState,
    ) -> Result<(), AuthorityRejectReason> {
        let Some((_, row)) = self.find_exact_actor_stack(
            actor_id,
            &limited.container,
            limited.stack_id,
            limited.variant_id,
        ) else {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        };
        if row.item_id != LOOTED_SCHEMATIC_ITEM_ID || row.available == 0 {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        }
        let Some((_, remaining_uses)) = decode_looted_schematic_variant(row.variant_id) else {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        };
        if remaining_uses == 0 {
            return Err(AuthorityRejectReason::SchematicUsesExceeded);
        }
        Ok(())
    }

    fn consume_limited_schematic_use(
        &mut self,
        actor_id: &str,
        limited: &CraftLimitedSchematicUseState,
    ) -> Result<(), AuthorityRejectReason> {
        self.validate_limited_schematic_use(actor_id, limited)?;
        let (_, remaining_uses) = decode_looted_schematic_variant(limited.variant_id)
            .ok_or(AuthorityRejectReason::SchematicUsesExceeded)?;
        self.consume_exact_actor_stack(
            actor_id,
            &limited.container,
            limited.stack_id,
            LOOTED_SCHEMATIC_ITEM_ID,
            limited.variant_id,
            1,
        )?;
        if remaining_uses > 1 {
            let recipe_id = decode_looted_schematic_variant(limited.variant_id)
                .map(|(recipe_id, _)| recipe_id)
                .ok_or(AuthorityRejectReason::SchematicUsesExceeded)?;
            let variant_id = encode_looted_schematic_variant(recipe_id, remaining_uses - 1)
                .ok_or(AuthorityRejectReason::SchematicUsesExceeded)?;
            let item_name = inventory_item_name(LOOTED_SCHEMATIC_ITEM_ID)
                .ok_or(AuthorityRejectReason::UnknownItem)?;
            self.add_actor_inventory_stack(
                actor_id,
                LOOTED_SCHEMATIC_ITEM_ID,
                variant_id,
                item_name,
                1,
                1,
                "datapad",
            );
        }
        Ok(())
    }
}

fn craft_slot_requirement_kind(slot: &CraftRecipeSlotDefinition) -> &'static str {
    match slot.required_family {
        Some("component") | None => "item",
        Some(_) => "material_family",
    }
}

fn craft_required_item_name(item_id: u32) -> &'static str {
    match item_id {
        RESOURCE_MINERAL_ITEM_ID => "Iron",
        RESOURCE_COPPER_ITEM_ID => "Copper",
        RESOURCE_CHEMICAL_ITEM_ID => "Petrochemical",
        RESOURCE_FLORA_ITEM_ID => "Flora",
        RESOURCE_GAS_ITEM_ID => "Gas",
        RESOURCE_LIQUID_ITEM_ID => "Water",
        RESOURCE_CLODPOWDER_ITEM_ID => "Clodpowder",
        RESOURCE_CARBON_ITEM_ID => "Carbon",
        RESOURCE_FUEL_ITEM_ID => "Fuel",
        RESOURCE_POLYMER_ITEM_ID => "Polymer",
        RESOURCE_CREATURE_HIDE_ITEM_ID => "Hide",
        RESOURCE_CREATURE_BONE_ITEM_ID => "Bone",
        RESOURCE_CREATURE_MEAT_ITEM_ID => "Meat",
        RESOURCE_CREATURE_STRUCTURAL_ITEM_ID => "Structural Tissue",
        _ => inventory_item_name(item_id).unwrap_or("Unknown Item"),
    }
}

fn ordered_craft_recipes() -> Vec<&'static CraftRecipeDefinition> {
    let mut recipes = CRAFT_RECIPES.iter().collect::<Vec<_>>();
    recipes.sort_by_key(|recipe| {
        (
            recipe.category,
            recipe.craft_profession.id(),
            recipe.tier,
            recipe.required_skill_box,
            recipe.id,
        )
    });
    recipes
}

fn craft_recipe(recipe_id: &str) -> Option<&'static CraftRecipeDefinition> {
    let normalized = normalize_command_key(recipe_id);
    CRAFT_RECIPES.iter().find(|recipe| recipe.id == normalized)
}

fn filled_craft_slots(
    session: &CraftSessionState,
    recipe: &CraftRecipeDefinition,
) -> Result<Vec<CraftSlotAssignmentState>, AuthorityRejectReason> {
    if session.slots.len() != recipe.slots.len() {
        return Err(AuthorityRejectReason::CraftSlotUnfilled);
    }
    let mut filled = Vec::with_capacity(session.slots.len());
    for (index, slot) in session.slots.iter().enumerate() {
        let assignment = slot
            .as_ref()
            .ok_or(AuthorityRejectReason::CraftSlotUnfilled)?
            .clone();
        let definition = recipe
            .slots
            .get(index)
            .ok_or(AuthorityRejectReason::CraftSlotMismatch)?;
        if assignment.item_id != definition.required_item_id
            || assignment.quantity != definition.required_qty
            || usize::from(assignment.slot_index) != index
        {
            return Err(AuthorityRejectReason::CraftSlotMismatch);
        }
        filled.push(assignment);
    }
    Ok(filled)
}

fn craft_line_cap_milli(
    line: &CraftLineDefinition,
    assignments: &[CraftSlotAssignmentState],
) -> u16 {
    craft_line_cap_milli_from_stats(line, |slot_index| {
        assignments
            .get(usize::from(slot_index))
            .map(|assignment| assignment.stats)
    })
}

fn craft_line_cap_milli_from_stats<F>(line: &CraftLineDefinition, mut stats_for_slot: F) -> u16
where
    F: FnMut(u8) -> Option<ResourceStats>,
{
    let mut weighted_sum = 0_u32;
    let mut weight_sum = 0_u32;
    for weight in line.weights {
        let Some(stats) = stats_for_slot(weight.slot_index) else {
            continue;
        };
        weighted_sum = weighted_sum.saturating_add(
            u32::from(resource_stat_value(stats, weight.stat)).saturating_mul(weight.weight),
        );
        weight_sum = weight_sum.saturating_add(weight.weight);
    }
    if weight_sum == 0 {
        return 0;
    }
    let normalized = weighted_sum / weight_sum;
    u16::try_from(450 + normalized.min(1_000).saturating_mul(550) / 1_000).unwrap_or(1_000)
}

fn craft_initial_line_value_milli(cap_milli: u16, assembly_quality_milli: u16) -> u16 {
    if cap_milli <= CRAFT_LINE_FLOOR_MILLI {
        return cap_milli;
    }
    let span = cap_milli.saturating_sub(CRAFT_LINE_FLOOR_MILLI);
    CRAFT_LINE_FLOOR_MILLI
        .saturating_add(
            u16::try_from(
                u32::from(span).saturating_mul(u32::from(assembly_quality_milli.min(1_000)))
                    / 1_000,
            )
            .unwrap_or(u16::MAX),
        )
        .min(cap_milli)
}

fn craft_assembly_quality_milli(
    assembly_roll_milli: i32,
    skill_bonus: i32,
    tool_quality_milli: u16,
) -> u16 {
    let tool_bonus = (i32::from(tool_quality_milli.min(1_000)) - 500) / 5;
    let value = 350_i32
        .saturating_add(assembly_roll_milli.clamp(0, 1_000) / 2)
        .saturating_add(skill_bonus.max(0) / 4)
        .saturating_add(tool_bonus)
        .clamp(100, 1_000);
    u16::try_from(value).unwrap_or(1_000)
}

/// Craftsman tools track: raise the FLOOR of crafted tool-class quality (+0..+150 milli).
/// The field-multitool / metal-extractor variants ARE the quality milli, so the floor lifts
/// low outcomes toward a trained toolmaker's baseline. Non-tool recipes pass through, and a
/// novice/untrained craftsman has floor 0 (crafted tools are unchanged).
fn apply_crafted_tool_quality_floor(
    recipe: &CraftRecipeDefinition,
    variant_id: u32,
    actor: &ActorAuthorityState,
) -> u32 {
    if recipe.category != "tool" {
        return variant_id;
    }
    let floor = u32::try_from(
        actor
            .professions
            .craftsman_tools_quality_floor_bonus_milli()
            .max(0),
    )
    .unwrap_or(0);
    variant_id.max(floor).min(1_000)
}

fn craft_line_malleability_milli(
    recipe: &CraftRecipeDefinition,
    session: &CraftSessionState,
    line_id: u8,
) -> u16 {
    let Some(line) = recipe.lines.iter().find(|line| line.line_id == line_id) else {
        return 500;
    };
    let mut weighted = 0_u32;
    let mut weights = 0_u32;
    for weight in line.weights {
        if let Some(stats) = session
            .slots
            .get(usize::from(weight.slot_index))
            .and_then(|slot| slot.as_ref())
            .map(|slot| slot.stats)
        {
            weighted = weighted.saturating_add(u32::from(stats.malleability) * weight.weight);
            weights = weights.saturating_add(weight.weight);
        }
    }
    u16::try_from(weighted.checked_div(weights).unwrap_or(500).min(1_000)).unwrap_or(1_000)
}

fn craft_one_point_success_milli(
    recipe: &CraftRecipeDefinition,
    session: &CraftSessionState,
    line_id: u8,
    bonus: i32,
    tool_quality_milli: u16,
) -> u16 {
    let tool_bonus = (i32::from(tool_quality_milli.min(1_000)) - 500) / 10;
    let malleability = craft_line_malleability_milli(recipe, session, line_id);
    u16::try_from(
        500_i32
            .saturating_add((i32::from(malleability) - 500) / 4)
            .saturating_add((bonus.saturating_add(tool_bonus)).saturating_mul(2))
            .clamp(100, 950),
    )
    .unwrap_or(950)
}

pub(super) fn craft_batch_risk_per_extra_point_milli() -> u16 {
    50
}

fn craft_output_variant_id(
    recipe: &CraftRecipeDefinition,
    session: &CraftSessionState,
) -> Result<u32, AuthorityRejectReason> {
    match recipe.id {
        "field_multitool"
        | "mineral_survey_tool"
        | "chemical_survey_tool"
        | "gas_survey_tool"
        | "irrigation_sprinkler"
        | "water_survey_tool" => Ok(u32::from(line_value(session, 0)?.min(1_000))),
        "camp_kit" | "iron_slug" | "shard_slug" | "spike_slug" => Ok(0),
        "fuel" => {
            let chemical_variant_id = craft_source_variant_id(session, 0)?;
            Ok(fuel_variant_from_chemical_variant(chemical_variant_id))
        }
        "polymer" => {
            let chemical_variant_id = craft_source_variant_id(session, 0)?;
            let carbon_variant_id = craft_source_variant_id(session, 1)?;
            Ok(polymer_variant_from_source_variants(
                chemical_variant_id,
                carbon_variant_id,
                line_value(session, 0)?.min(1_000),
            ))
        }
        "extractor_battery" => {
            let copper_conductivity = session
                .slots
                .first()
                .and_then(|slot| slot.as_ref())
                .map(|slot| slot.stats.conductivity)
                .ok_or(AuthorityRejectReason::CraftSlotUnfilled)?;
            let craft_quality = line_value(session, 0)?.min(1_000);
            Ok(encode_battery_variant(battery_runtime_seconds(
                copper_conductivity,
                craft_quality,
            )))
        }
        "metal_extractor" | "chemical_extractor" | "gas_extractor" | "water_extractor" => {
            Ok(u32::from(line_value(session, 0)?.min(1_000)))
        }
        "slugthrower" | "kiln_carbine" | "lightning_carbine" => {
            let stats = SlugthrowerCraftStats {
                power: line_value(session, 0)?.min(1_000) / 10,
                handling: line_value(session, 1)?.min(1_000) / 10,
                reliability: line_value(session, 2)?.min(1_000) / 10,
            };
            Ok(encode_slugthrower_variant(stats))
        }
        "field_saber" => {
            let tempo = u64::from(line_value(session, 0)?.min(1_000));
            Ok(encode_melee_weapon_speed_variant_ms(
                1_150_u64.saturating_sub(tempo.saturating_mul(250) / 1_000),
            ))
        }
        "quarry_chopper" => {
            let tempo = u64::from(line_value(session, 0)?.min(1_000));
            Ok(encode_melee_weapon_speed_variant_ms(
                1_500_u64.saturating_sub(tempo.saturating_mul(300) / 1_000),
            ))
        }
        // Medical components: quality-as-variant (like tools). Slotted into the
        // Advanced Stimpak, where craft_slot_stats reads this quality back.
        "solid_delivery_shell"
        | "bio_effect_controller"
        | "liquid_suspension"
        | "chemical_release_mechanism" => Ok(u32::from(line_value(session, 0)?.min(1_000))),
        // Medical consumables: two lines -> MedicalCraftStats -> encoded variant.
        "basic_stimpak"
        | "advanced_stimpak"
        | "body_enhancement_pack"
        | "spirit_enhancement_pack"
        | "anti_dizzy_stim"
        | "anti_blind_stim" => {
            let kind = craft_recipe_medical_kind(recipe.id)
                .ok_or(AuthorityRejectReason::UnknownSchematic)?;
            let stats = medical_stats_from_craft_lines(
                kind,
                line_value(session, 0)?,
                line_value(session, 1)?,
            );
            Ok(encode_medical_variant(kind, stats))
        }
        _ => Err(AuthorityRejectReason::UnknownSchematic),
    }
}

fn craft_source_variant_id(
    session: &CraftSessionState,
    slot_index: usize,
) -> Result<u32, AuthorityRejectReason> {
    session
        .slots
        .get(slot_index)
        .and_then(|slot| slot.as_ref())
        .map(|slot| slot.variant_id)
        .ok_or(AuthorityRejectReason::CraftSlotUnfilled)
}

fn line_value(session: &CraftSessionState, line_id: u8) -> Result<u16, AuthorityRejectReason> {
    session
        .lines
        .iter()
        .find(|line| line.line_id == line_id)
        .map(|line| line.value_milli)
        .ok_or(AuthorityRejectReason::InvalidExperimentLine)
}

fn crafted_output_stack_cap(item_id: u32) -> u32 {
    match item_id {
        AMMO_SLUG_IRON_ITEM_ID | AMMO_SLUG_SHARD_ITEM_ID | AMMO_SLUG_SPIKE_ITEM_ID => {
            AMMO_SLUG_STACK_CAP
        }
        CAMP_KIT_ITEM_ID => CAMP_KIT_STACK_CAP,
        EXTRACTOR_BATTERY_ITEM_ID => EXTRACTOR_BATTERY_STACK_CAP,
        IRRIGATION_SPRINKLER_ITEM_ID => FARM_STRUCTURE_STACK_CAP,
        MINERAL_SURVEY_TOOL_ITEM_ID
        | CHEMICAL_SURVEY_TOOL_ITEM_ID
        | GAS_SURVEY_TOOL_ITEM_ID
        | WATER_SURVEY_TOOL_ITEM_ID => SURVEY_TOOL_STACK_CAP,
        METAL_EXTRACTOR_TOOL_ITEM_ID
        | CHEMICAL_EXTRACTOR_TOOL_ITEM_ID
        | GAS_EXTRACTOR_TOOL_ITEM_ID
        | WATER_EXTRACTOR_TOOL_ITEM_ID => METAL_EXTRACTOR_STACK_CAP,
        STIMPAK_A_ITEM_ID => STIMPAK_A_STACK_CAP,
        ADVANCED_STIMPAK_ITEM_ID => ADVANCED_STIMPAK_STACK_CAP,
        BODY_ENHANCEMENT_PACK_A_ITEM_ID | SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID => {
            ENHANCEMENT_PACK_A_STACK_CAP
        }
        ANTI_DIZZY_STIM_ITEM_ID | ANTI_BLIND_STIM_ITEM_ID => ANTI_STATE_STIM_STACK_CAP,
        BIO_EFFECT_CONTROLLER_ITEM_ID
        | LIQUID_SUSPENSION_ITEM_ID
        | CHEMICAL_RELEASE_MECHANISM_ITEM_ID
        | SOLID_DELIVERY_SHELL_ITEM_ID => MEDICAL_COMPONENT_STACK_CAP,
        item if is_resource_item_id(item) => RESOURCE_STACK_CAP,
        _ => 1,
    }
}

fn crafted_output_quantity(recipe: &CraftRecipeDefinition) -> u32 {
    match recipe.id {
        "fuel" => CRAFT_FUEL_OUTPUT_QTY,
        "polymer" => CRAFT_POLYMER_OUTPUT_QTY,
        "iron_slug" | "shard_slug" | "spike_slug" => CRAFT_SUPPLY_AMMO_OUTPUT_QTY,
        _ => 1,
    }
}

fn crafted_output_container_suffix(item_id: u32) -> &'static str {
    if item_id == CAMP_KIT_ITEM_ID
        || matches!(
            item_id,
            AMMO_SLUG_IRON_ITEM_ID | AMMO_SLUG_SHARD_ITEM_ID | AMMO_SLUG_SPIKE_ITEM_ID
        )
    {
        "field-supplies"
    } else if is_resource_item_id(item_id) {
        "resource-crate"
    } else {
        "crafted-gear"
    }
}

pub(super) fn normalize_craft_name(value: &str) -> Result<Option<String>, AuthorityRejectReason> {
    if value.chars().any(|character| character.is_control()) {
        return Err(AuthorityRejectReason::InvalidCraftName);
    }
    if value.trim().is_empty() {
        return Ok(None);
    }
    let mut normalized = String::with_capacity(value.len().min(48));
    let mut pending_space = false;
    for character in value.chars() {
        if character.is_control() {
            return Err(AuthorityRejectReason::InvalidCraftName);
        }
        if character.is_whitespace() {
            pending_space = true;
            continue;
        }
        let allowed = character.is_ascii_alphanumeric()
            || character.is_alphanumeric()
            || matches!(character, '\'' | '-' | '.');
        if !allowed || character.is_control() {
            return Err(AuthorityRejectReason::InvalidCraftName);
        }
        if pending_space && !normalized.is_empty() {
            normalized.push(' ');
        }
        pending_space = false;
        normalized.push(character);
    }
    let count = normalized.chars().count();
    if !(1..=48).contains(&count) {
        return Err(AuthorityRejectReason::InvalidCraftName);
    }
    Ok(Some(normalized))
}

/// MEDIC WAVE: W6 recipe id -> the medical kind whose variant it encodes.
fn craft_recipe_medical_kind(recipe_id: &str) -> Option<MedicalSchematicKind> {
    match recipe_id {
        "basic_stimpak" => Some(MedicalSchematicKind::StimpakA),
        "advanced_stimpak" => Some(MedicalSchematicKind::AdvancedStimpak),
        "body_enhancement_pack" => Some(MedicalSchematicKind::BodyEnhancementPackA),
        "spirit_enhancement_pack" => Some(MedicalSchematicKind::SpiritEnhancementPackA),
        "anti_dizzy_stim" => Some(MedicalSchematicKind::AntiDizzyStim),
        "anti_blind_stim" => Some(MedicalSchematicKind::AntiBlindStim),
        _ => None,
    }
}

/// Which profession tracks a craft assembly pays.
fn craft_assembly_xp_tracks(profession: AuthorityProfessionKind) -> &'static [&'static str] {
    match profession {
        AuthorityProfessionKind::Medic => &["medical-crafting"],
        AuthorityProfessionKind::Scout => &["campcraft"],
        _ => &["assembly"],
    }
}

/// Which profession track a craft experiment point pays.
fn craft_experiment_xp_track(profession: AuthorityProfessionKind) -> &'static str {
    match profession {
        AuthorityProfessionKind::Medic => "medical-crafting",
        AuthorityProfessionKind::Scout => "campcraft",
        _ => "experimentation",
    }
}

#[cfg(test)]
pub(super) fn authority_crafting_unlock_catalog() -> BTreeMap<String, Vec<String>> {
    let mut catalog = BTreeMap::<String, Vec<String>>::new();
    for recipe in CRAFT_RECIPES {
        catalog
            .entry(recipe.required_skill_box.to_owned())
            .or_default()
            .push(recipe.name.to_owned());
    }
    catalog
}

fn parse_craft_stack_id(value: &str) -> Option<u64> {
    let stack_id = value.trim().parse::<u64>().ok()?;
    (stack_id > 0).then_some(stack_id)
}

fn looted_schematic_recipe_code(recipe_id: &str) -> Option<u32> {
    match normalize_command_key(recipe_id).as_str() {
        "slugthrower" => Some(1),
        "metal_extractor" => Some(2),
        "extractor_battery" => Some(3),
        "field_multitool" => Some(4),
        _ => None,
    }
}

fn looted_schematic_recipe_id(code: u32) -> Option<&'static str> {
    match code {
        1 => Some("slugthrower"),
        2 => Some("metal_extractor"),
        3 => Some("extractor_battery"),
        4 => Some("field_multitool"),
        _ => None,
    }
}

pub(super) fn encode_looted_schematic_variant(recipe_id: &str, remaining_uses: u16) -> Option<u32> {
    let code = looted_schematic_recipe_code(recipe_id)?;
    Some(
        CRAFT_LOOTED_SCHEMATIC_VARIANT_BASE
            .saturating_add(code.saturating_mul(CRAFT_LOOTED_SCHEMATIC_RECIPE_STRIDE))
            .saturating_add(u32::from(remaining_uses.min(1_000))),
    )
}

pub(super) fn decode_looted_schematic_variant(variant_id: u32) -> Option<(&'static str, u16)> {
    let encoded = variant_id.checked_sub(CRAFT_LOOTED_SCHEMATIC_VARIANT_BASE)?;
    let code = encoded / CRAFT_LOOTED_SCHEMATIC_RECIPE_STRIDE;
    let remaining = encoded % CRAFT_LOOTED_SCHEMATIC_RECIPE_STRIDE;
    let recipe_id = looted_schematic_recipe_id(code)?;
    if remaining <= 1_000 {
        Some((recipe_id, u16::try_from(remaining).ok()?))
    } else {
        None
    }
}
pub(super) fn craft_assembly_seed(
    key: [u8; 32],
    actor_id: &str,
    recipe_id: &str,
    tick: u64,
) -> u32 {
    let mut hasher = blake3::Hasher::new_keyed(&key);
    hasher.update(actor_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(recipe_id.as_bytes());
    hasher.update(&[0]);
    hasher.update(&tick.to_le_bytes());
    let digest = hasher.finalize();
    u32::from_le_bytes(
        digest.as_bytes()[..4]
            .try_into()
            .expect("blake3 digest has 4 bytes"),
    )
}
