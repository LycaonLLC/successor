//! Typed view models the window content reads. Projected from the authority
//! store (`game::authority::AuthorityStore`) in the connected client; the demo
//! seeds representative values. Kept plain-data so content layout is
//! deterministic and unit-testable.

/// Item category → toolbar/inventory glyph id (`icons.ts` vocabulary).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Weapon,
    Ammo,
    Medical,
    Resource,
    Tool,
    Gear,
    Currency,
    Item,
}

impl ItemKind {
    /// Icon id for this category (resolved against the baked atlas by the host).
    pub fn icon(self) -> &'static str {
        match self {
            ItemKind::Weapon => "item-weapon",
            ItemKind::Ammo => "item-ammo",
            ItemKind::Medical => "item-medical",
            ItemKind::Resource => "item-resource",
            ItemKind::Tool => "item-tool",
            ItemKind::Gear => "item-gear",
            ItemKind::Currency => "item-currency",
            ItemKind::Item => "item-item",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ItemStack {
    pub id: u32,
    pub name: String,
    pub kind: ItemKind,
    pub qty: u32,
    /// Equipped (worn/wielded) — inventory renders an equip pip.
    pub equipped: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Inventory {
    pub items: Vec<ItemStack>,
    pub credits: u64,
    pub capacity: usize,
    /// Currently selected item id (for the examine sidebar).
    pub selected: Option<u32>,
}

#[derive(Clone, Debug, Default)]
pub struct Profession {
    pub label: String,
    pub level: u32,
}

#[derive(Clone, Debug, Default)]
pub struct CharacterSheet {
    pub name: String,
    pub health: f32,
    pub health_max: f32,
    pub action: f32,
    pub action_max: f32,
    pub armor: i32,
    pub credits: u64,
    pub title: String,
    pub professions: Vec<Profession>,
    /// Selectable profession titles for the one action this window exposes.
    pub title_options: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SkillNode {
    pub label: String,
    /// 0..1 progress toward the next rank.
    pub progress: f32,
    pub rank: u32,
    pub locked: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Skills {
    pub nodes: Vec<SkillNode>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OptionKind {
    Slider(f32), // 0..1
    Toggle(bool),
}

#[derive(Clone, Debug)]
pub struct OptionRow {
    pub label: String,
    pub kind: OptionKind,
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub rows: Vec<OptionRow>,
}

/// Aggregate the windows read from. Fields default empty; each window renders an
/// "empty" state when its section is unset.
#[derive(Clone, Debug, Default)]
pub struct WindowModel {
    pub inventory: Inventory,
    pub character: CharacterSheet,
    pub skills: Skills,
    pub options: Options,
}

impl WindowModel {
    /// Representative sample state for demos + screenshot verification.
    pub fn sample() -> Self {
        let items = vec![
            ItemStack {
                id: 1,
                name: "SLUGTHROWER".into(),
                kind: ItemKind::Weapon,
                qty: 1,
                equipped: true,
            },
            ItemStack {
                id: 2,
                name: "RIFLE AMMO".into(),
                kind: ItemKind::Ammo,
                qty: 240,
                equipped: false,
            },
            ItemStack {
                id: 3,
                name: "MEDKIT".into(),
                kind: ItemKind::Medical,
                qty: 4,
                equipped: false,
            },
            ItemStack {
                id: 4,
                name: "SCRAP ALLOY".into(),
                kind: ItemKind::Resource,
                qty: 58,
                equipped: false,
            },
            ItemStack {
                id: 5,
                name: "SURVEY TOOL".into(),
                kind: ItemKind::Tool,
                qty: 1,
                equipped: false,
            },
            ItemStack {
                id: 6,
                name: "FLAK VEST".into(),
                kind: ItemKind::Gear,
                qty: 1,
                equipped: true,
            },
            ItemStack {
                id: 7,
                name: "RATION".into(),
                kind: ItemKind::Item,
                qty: 12,
                equipped: false,
            },
        ];
        Self {
            inventory: Inventory {
                items,
                credits: 1280,
                capacity: 24,
                selected: Some(1),
            },
            character: CharacterSheet {
                name: "DRIFTER".into(),
                health: 100.0,
                health_max: 100.0,
                action: 84.0,
                action_max: 120.0,
                armor: 42,
                credits: 1280,
                title: "MARKSMAN".into(),
                professions: vec![
                    Profession {
                        label: "COMBAT".into(),
                        level: 7,
                    },
                    Profession {
                        label: "MEDICINE".into(),
                        level: 3,
                    },
                    Profession {
                        label: "SURVEY".into(),
                        level: 5,
                    },
                ],
                title_options: vec!["MARKSMAN".into(), "MEDIC".into(), "SURVEYOR".into()],
            },
            skills: Skills {
                nodes: vec![
                    SkillNode {
                        label: "RIFLES".into(),
                        progress: 0.8,
                        rank: 4,
                        locked: false,
                    },
                    SkillNode {
                        label: "MEDICINE".into(),
                        progress: 0.4,
                        rank: 2,
                        locked: false,
                    },
                    SkillNode {
                        label: "SURVEY".into(),
                        progress: 0.6,
                        rank: 3,
                        locked: false,
                    },
                    SkillNode {
                        label: "CRAFTING".into(),
                        progress: 0.2,
                        rank: 1,
                        locked: false,
                    },
                    SkillNode {
                        label: "PILOTING".into(),
                        progress: 0.0,
                        rank: 0,
                        locked: true,
                    },
                ],
            },
            options: Options {
                rows: vec![
                    OptionRow {
                        label: "MASTER VOLUME".into(),
                        kind: OptionKind::Slider(0.75),
                    },
                    OptionRow {
                        label: "MUSIC VOLUME".into(),
                        kind: OptionKind::Slider(0.5),
                    },
                    OptionRow {
                        label: "FULLSCREEN".into(),
                        kind: OptionKind::Toggle(true),
                    },
                    OptionRow {
                        label: "INVERT Y".into(),
                        kind: OptionKind::Toggle(false),
                    },
                    OptionRow {
                        label: "SHOW FPS".into(),
                        kind: OptionKind::Toggle(false),
                    },
                ],
            },
        }
    }
}
