//! Live HUD — the connected client's chrome, ported from the `client-3d`
//! reference surfaces (`ui/statusPlate.ts`, `ui/hud/*`, `ui/windows/dock.ts`).
//!
//! Everything here binds to [`HudState`], a plain-data projection built from
//! the authority store when packets apply (never per frame), so the draw path
//! renders prebuilt strings and numbers without steady-state allocation.
//! `HudState::default()` is the honest disconnected state (NO SIGNAL, empty
//! gauges) — there are no sample contacts, sectors, or shield values.
//!
//! Submodules:
//! - [`plate`]    — status plate, target plate, group rail, death overlay,
//!   interact chip, extraction toast, banners, first steps, ability queue.
//! - [`radar`]    — north-up tactical scope (classification + click actions).
//! - [`toolbar`]  — 12-slot toolbar (schema-3 doc), dock rail, action registry.
//! - [`overlays`] — world-anchored nameplates, chat bubbles, floating text.
//! - [`waypoints`] — character-scoped waypoint store (port of
//!   `ui/waypoints/store.ts`).

use successor_engine_render::font::{RasterFont, RasterGlyph};
use successor_engine_render::ui::{AtlasMeta, UiBuilder};

pub mod overlays;
pub mod plate;
pub mod radar;
pub mod toolbar;
pub mod waypoints;

const ICONS_A8: &[u8] = include_bytes!("../assets/ui/icons.a8");
const ICONS_JSON: &str = include_str!("../assets/ui/icons.json");
const UI_FONT_TTF: &[u8] = include_bytes!("../assets/ui/PT_Sans-Web-Bold.ttf");
const UI_ATLAS_W: usize = 512;
const UI_ATLAS_H: usize = 512;
const UI_FONT_SOURCE_PX: f32 = 32.0;

/// Parsed icon/font atlas: metadata, RGBA8 texture bytes, glyph metrics and
/// the stable icon-id map. Text and icons share one texture and one UI pass.
pub struct Icons {
    pub meta: AtlasMeta,
    pub rgba: Vec<u8>,
    pub font: RasterFont,
    map: Vec<(String, (u32, u32))>,
}

impl Icons {
    pub fn load() -> Self {
        let v: serde_json::Value = serde_json::from_str(ICONS_JSON).expect("icons.json parse");
        let u = |k: &str| v[k].as_u64().unwrap_or(0) as u32;
        let icon_w = u("width") as usize;
        let icon_h = u("height") as usize;
        let meta = AtlasMeta {
            cell: u("cell"),
            cols: u("cols"),
            width: UI_ATLAS_W as u32,
            height: UI_ATLAS_H as u32,
        };
        let mut map = Vec::new();
        if let Some(arr) = v["icons"].as_array() {
            for ic in arr {
                let id = ic["id"].as_str().unwrap_or("").to_string();
                let col = ic["col"].as_u64().unwrap_or(0) as u32;
                let row = ic["row"].as_u64().unwrap_or(0) as u32;
                map.push((id, (col, row)));
            }
        }

        let mut alpha = vec![0u8; UI_ATLAS_W * UI_ATLAS_H];
        for row in 0..icon_h {
            let src = &ICONS_A8[row * icon_w..(row + 1) * icon_w];
            let dst = &mut alpha[row * UI_ATLAS_W..row * UI_ATLAS_W + icon_w];
            dst.copy_from_slice(src);
        }

        let font = fontdue::Font::from_bytes(
            UI_FONT_TTF,
            fontdue::FontSettings {
                collection_index: 0,
                scale: UI_FONT_SOURCE_PX,
                load_substitutions: true,
            },
        )
        .expect("PT Sans font parse");
        let line = font
            .horizontal_line_metrics(UI_FONT_SOURCE_PX)
            .expect("PT Sans horizontal metrics");
        let mut glyphs = Vec::with_capacity(95);
        let mut atlas_x = 2usize;
        let mut atlas_y = icon_h + 4;
        let mut row_h = 0usize;
        for code in 32u8..=126 {
            let ch = code as char;
            let (metrics, bitmap) = font.rasterize(ch, UI_FONT_SOURCE_PX);
            if atlas_x + metrics.width + 2 > UI_ATLAS_W {
                atlas_x = 2;
                atlas_y += row_h + 2;
                row_h = 0;
            }
            assert!(
                atlas_y + metrics.height + 2 <= UI_ATLAS_H,
                "UI font atlas overflow"
            );
            for row in 0..metrics.height {
                let src = &bitmap[row * metrics.width..(row + 1) * metrics.width];
                let start = (atlas_y + row) * UI_ATLAS_W + atlas_x;
                alpha[start..start + metrics.width].copy_from_slice(src);
            }
            glyphs.push(RasterGlyph {
                ch,
                uv: (
                    atlas_x as f32 / UI_ATLAS_W as f32,
                    atlas_y as f32 / UI_ATLAS_H as f32,
                    (atlas_x + metrics.width) as f32 / UI_ATLAS_W as f32,
                    (atlas_y + metrics.height) as f32 / UI_ATLAS_H as f32,
                ),
                width: metrics.width as f32,
                height: metrics.height as f32,
                xmin: metrics.xmin as f32,
                ymin: metrics.ymin as f32,
                advance: metrics.advance_width,
            });
            atlas_x += metrics.width + 2;
            row_h = row_h.max(metrics.height);
        }
        let font = RasterFont {
            source_px: UI_FONT_SOURCE_PX,
            ascent: line.ascent,
            line_height: line.new_line_size,
            glyphs,
        };

        let mut rgba = vec![0u8; alpha.len() * 4];
        for (i, &a) in alpha.iter().enumerate() {
            rgba[i * 4] = 255;
            rgba[i * 4 + 1] = 255;
            rgba[i * 4 + 2] = 255;
            rgba[i * 4 + 3] = a;
        }
        Self {
            meta,
            rgba,
            font,
            map,
        }
    }

    pub fn ui_builder(&self) -> UiBuilder {
        UiBuilder::new_with_font(self.meta, self.font.clone())
    }

    /// Atlas cell `(col, row)` for an icon id.
    pub fn cell(&self, id: &str) -> Option<(u32, u32)> {
        self.map.iter().find(|(k, _)| k == id).map(|(_, c)| *c)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

// ── Theme palettes (exact port of `ui/uiTheme.ts` UI_THEMES) ────────────────

/// Themeable palette — the seven chrome colours plus danger.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Palette {
    pub bg_panel: [u8; 4],
    pub bg_cell: [u8; 4],
    pub ink: [u8; 4],
    pub ink_dim: [u8; 4],
    pub hairline: [u8; 4],
    pub accent: [u8; 4],
    pub accent_soft: [u8; 4],
    pub danger: [u8; 4],
}

const fn hex(rgb: u32) -> [u8; 4] {
    [
        ((rgb >> 16) & 0xff) as u8,
        ((rgb >> 8) & 0xff) as u8,
        (rgb & 0xff) as u8,
        255,
    ]
}

/// Panel fills carry the reference translucency (DOM panels sit on glass).
const fn hexa(rgb: u32, a: u8) -> [u8; 4] {
    let c = hex(rgb);
    [c[0], c[1], c[2], a]
}

pub const THEME_COUNT: usize = 4;

/// SIGNAL / PHOSPHOR / AMBER / OXIDE — ids, labels and swatch order match the
/// reference cycle (signal→phosphor→amber→oxide→signal).
pub const THEME_IDS: [&str; THEME_COUNT] = ["signal", "phosphor", "amber", "oxide"];
pub const THEME_LABELS: [&str; THEME_COUNT] = ["SIGNAL", "PHOSPHOR", "AMBER", "OXIDE"];

pub const THEMES: [Palette; THEME_COUNT] = [
    // signal
    Palette {
        bg_panel: hexa(0x070b0d, 232),
        bg_cell: hexa(0x0b1216, 235),
        ink: hex(0xcfe9ef),
        ink_dim: hex(0x5f818c),
        hairline: hex(0x1d2f37),
        accent: hex(0x48d6e6),
        accent_soft: hex(0x0f3b44),
        danger: hex(0xe34a4a),
    },
    // phosphor
    Palette {
        bg_panel: hexa(0x050a06, 232),
        bg_cell: hexa(0x08120a, 235),
        ink: hex(0x56e07a),
        ink_dim: hex(0x2f8f4b),
        hairline: hex(0x123321),
        accent: hex(0x46ff7a),
        accent_soft: hex(0x0e3a1c),
        danger: hex(0xe34a4a),
    },
    // amber
    Palette {
        bg_panel: hexa(0x0a0703, 232),
        bg_cell: hexa(0x120d05, 235),
        ink: hex(0xffd98c),
        ink_dim: hex(0xa07c3c),
        hairline: hex(0x3a2a12),
        accent: hex(0xffb24a),
        accent_soft: hex(0x3a270c),
        danger: hex(0xe34a4a),
    },
    // oxide
    Palette {
        bg_panel: hexa(0x0c0605, 232),
        bg_cell: hexa(0x150a07, 235),
        ink: hex(0xe6d4b8),
        ink_dim: hex(0x8a7355),
        hairline: hex(0x3a201a),
        accent: hex(0xc44a26),
        accent_soft: hex(0x3a160e),
        danger: hex(0xd83a3a),
    },
];

/// Palette for a theme index (out-of-range folds to the default SIGNAL).
pub fn palette(theme_index: usize) -> Palette {
    THEMES[theme_index % THEME_COUNT]
}

/// Theme index for a stored id; unknown ids reset to SIGNAL (0).
pub fn theme_index_for_id(id: &str) -> usize {
    THEME_IDS.iter().position(|t| *t == id).unwrap_or(0)
}

// ── Text hygiene ────────────────────────────────────────────────────────────

/// Sanitize server/player text before shaping: strips control characters,
/// collapses whitespace runs, and caps the length in chars. Everything the
/// HUD renders from a non-static source flows through here.
pub fn sanitize_text(input: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(input.len().min(max_chars * 4));
    let mut count = 0usize;
    let mut last_space = true; // also trims leading whitespace
    for ch in input.chars() {
        if count >= max_chars {
            break;
        }
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
                count += 1;
                last_space = true;
            }
            continue;
        }
        if ch.is_control() {
            continue;
        }
        last_space = false;
        out.push(ch);
        count += 1;
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Remove a trailing descriptor such as `(a rogue trooper)` from a label
/// (port of `actorNameSystem.stripTypeRead`).
pub fn strip_type_read(label: &str) -> String {
    let trimmed = label.trim();
    if let Some(open) = trimmed.rfind('(') {
        if trimmed.ends_with(')') && !trimmed[open + 1..trimmed.len() - 1].contains('(') {
            let stripped = trimmed[..open].trim_end();
            if !stripped.is_empty() {
                return stripped.to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Clean actor name: `display_name` first, then `label` with the trailing
/// type read stripped, then the fallback (port of `cleanActorName`).
pub fn clean_actor_name(display_name: &str, label: &str, fallback: &str) -> String {
    let display = display_name.trim();
    if !display.is_empty() {
        return sanitize_text(display, 48);
    }
    let label = label.trim();
    if !label.is_empty() {
        return sanitize_text(&strip_type_read(label), 48);
    }
    fallback.to_string()
}

// ── Live HUD state ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ConnectionHud {
    /// No accepted snapshot / actor — plate reads NO SIGNAL.
    #[default]
    NoSignal,
    Live,
    Reconnecting,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GaugeHud {
    pub value: f32,
    pub max: f32,
}

impl GaugeHud {
    pub fn frac(&self) -> f32 {
        if self.max > 0.0 {
            (self.value / self.max).clamp(0.0, 1.0)
        } else {
            0.0
        }
    }
    /// Low-vital emphasis threshold (reference: ≤25%).
    pub fn low(&self) -> bool {
        self.max > 0.0 && self.frac() <= 0.25
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LifeHud {
    #[default]
    Alive,
    Downed,
    Respawning,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SprintHud {
    #[default]
    Off,
    On,
    /// Authority sprint-recovery lock — label reads WINDED.
    Winded,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WeaponHud {
    /// Stenciled field designation (already display-cleaned).
    pub label: String,
    pub melee: bool,
    pub magazine_size: u32,
    pub loaded_rounds: u32,
    /// Prebuilt rounds readout (`7/8 · 24`, `REARMING…`, `READY`).
    pub rounds_text: String,
    pub reloading: bool,
    /// 0..1 refill sweep progress while reloading.
    pub reload_frac: f32,
    /// Melee swing timer (time-to-next-swing where ammo normally lives).
    pub swing_ready: bool,
    pub swing_frac: f32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RelationHud {
    Hostile,
    Alerted,
    #[default]
    Neutral,
    Friendly,
    Grouped,
}

impl RelationHud {
    pub fn tint(self, pal: &Palette) -> [u8; 4] {
        match self {
            RelationHud::Hostile => pal.danger,
            RelationHud::Alerted => [232, 168, 74, 255],
            RelationHud::Neutral => pal.ink,
            RelationHud::Friendly => [110, 214, 130, 255],
            RelationHud::Grouped => pal.accent,
        }
    }
}

/// Target plate state chip (attitude/posture/status; MAX 4 — reference cap).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChipHud {
    pub label: String,
    pub danger: bool,
}

pub const TARGET_CHIP_MAX: usize = 4;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TargetHud {
    pub actor_id: String,
    pub name: String,
    pub relation: RelationHud,
    pub health: GaugeHud,
    pub alive: bool,
    /// DOWN/DEAD stamp text once an observed death holds the frame.
    pub stamp: Option<&'static str>,
    pub chips: Vec<ChipHud>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct GroupMemberHud {
    pub actor_id: String,
    pub name: String,
    pub leader: bool,
    pub health_frac: f32,
    pub down: bool,
    pub link_dead: bool,
}

/// Member rail cap (reference `MAX_MEMBER_CHIPS`).
pub const GROUP_CHIP_MAX: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RadarClass {
    Hostile,
    Passive,
    Civilian,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RadarContactHud {
    pub actor_id: String,
    /// Raw world-cell deltas in the shared north-up basis (+x east, +y south).
    pub dx_cells: f32,
    pub dy_cells: f32,
    pub class: RadarClass,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RadarWaypointHud {
    pub id: u32,
    pub dx_cells: f32,
    pub dy_cells: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueEntryStateHud {
    Queued,
    Ready,
    /// Fired this frame — pane flashes then retires the row.
    Fired,
    Rejected,
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueueEntryHud {
    pub entry_id: String,
    pub label: String,
    pub target_label: String,
    pub state: QueueEntryStateHud,
    /// Short deny stamp (combat reason copy) for rejected rows.
    pub reason: String,
}

pub const QUEUE_ROW_MAX: usize = 6;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InteractHud {
    /// Chip copy, e.g. `[F] OPEN DOOR`.
    pub label: String,
    /// Radial hold fill for loot hold-to-take-all.
    pub hold_frac: Option<f32>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct BannerHud {
    pub text: String,
    pub bad: bool,
    /// Wall-clock (monotonic ms) after which the banner stops drawing.
    pub until_ms: u64,
}

/// First-steps guidance rows (progressive disclosure — bounded).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FirstStepRowHud {
    pub key: String,
    pub text: String,
    pub done: bool,
}

pub const FIRST_STEP_ROW_MAX: usize = 3;

/// Live values every HUD panel binds to. Built by [`HudState::project`] from
/// the authority store; `Default` is the honest disconnected state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HudState {
    pub connection: ConnectionHud,
    /// Fine-print line: `<STATUS> · N IN FIELD` or `NO SIGNAL` (prebuilt).
    pub fine_text: String,
    pub name: String,
    pub observer: bool,
    pub health: GaugeHud,
    pub action: GaugeHud,
    pub spirit: GaugeHud,
    /// Prebuilt numeric gauge readouts (value or `—`).
    pub health_text: String,
    pub action_text: String,
    pub spirit_text: String,
    pub life: LifeHud,
    pub sprint: SprintHud,
    pub weapon: Option<WeaponHud>,
    pub sheltered: bool,
    /// `CAMP COLLAPSE · MM:SS` when the owned camp abandon grace is armed.
    pub camp_countdown: Option<String>,
    /// `AUTO-SAMPLE · N.NS` while the sample loop is pending.
    pub sampler_text: Option<String>,
    pub credits: Option<i64>,
    /// Streamed area id (uppercased for display) — never a hard-coded sector.
    pub area_label: String,
    pub position: Option<(f32, f32)>,
    pub target: Option<TargetHud>,
    pub group_invite_from: Option<String>,
    pub group_members: Vec<GroupMemberHud>,
    pub radar_contacts: Vec<RadarContactHud>,
    pub radar_waypoints: Vec<RadarWaypointHud>,
    pub queue: Vec<QueueEntryHud>,
    pub repeat_armed: bool,
    pub interact: Option<InteractHud>,
    pub extraction_toast: Option<BannerHud>,
    pub banner: Option<BannerHud>,
    /// `CLONE SICKNESS · MM:SS` chip while the post-clone debuff ticks down.
    pub clone_sickness: Option<String>,
    pub crosshair: bool,
    pub first_steps: Vec<FirstStepRowHud>,
}

impl HudState {
    /// Rebuild the store-derived portion of the HUD state. Call after applying
    /// a network packet (NOT per frame). Fields owned by other systems
    /// (interact, banners, first steps, radar waypoints, sprint intent,
    /// extraction toast) are left untouched.
    pub fn project(
        &mut self,
        store: &crate::game::authority::AuthorityStore,
        player_id: &str,
        selected_actor_id: Option<&str>,
    ) {
        let player = store
            .actors
            .get(&store.player_actor_id)
            .or_else(|| store.actors.get(player_id));
        match player {
            Some(a) => {
                self.connection = ConnectionHud::Live;
                self.name = clean_actor_name(&a.display_name, &a.label, player_id).to_uppercase();
                self.health = GaugeHud {
                    value: a.vitals.health,
                    max: a.max_vitals.health,
                };
                self.action = GaugeHud {
                    value: a.vitals.action,
                    max: a.max_vitals.action,
                };
                self.spirit = GaugeHud {
                    value: a.vitals.spirit,
                    max: a.max_vitals.spirit,
                };
                self.health_text = gauge_text(&self.health);
                self.action_text = gauge_text(&self.action);
                self.spirit_text = gauge_text(&self.spirit);
                self.life = match a.life_state.as_str() {
                    "downed" => LifeHud::Downed,
                    "respawning" => LifeHud::Respawning,
                    _ => LifeHud::Alive,
                };
                self.credits = a.credits;
                self.area_label = sanitize_text(&a.area_id, 32).to_uppercase();
                self.position = Some((a.x, a.y));
                self.weapon = a.weapon.as_ref().and_then(|w| {
                    let id = w.weapon_id.as_deref()?;
                    let reloading = w.reload_remaining_ticks.unwrap_or(0) > 0;
                    Some(WeaponHud {
                        label: weapon_display_name(id),
                        melee: id.contains("sword") || id.contains("melee"),
                        magazine_size: 0,
                        loaded_rounds: 0,
                        rounds_text: if reloading {
                            "REARMING…".to_string()
                        } else {
                            String::new()
                        },
                        reloading,
                        reload_frac: 0.0,
                        swing_ready: !reloading,
                        swing_frac: if reloading { 0.0 } else { 1.0 },
                    })
                });
                let count = store.actors.len();
                self.fine_text = format!("LIVE · {count} IN FIELD");
            }
            None => {
                let live = self.connection == ConnectionHud::Reconnecting;
                if !live {
                    self.connection = ConnectionHud::NoSignal;
                }
                self.fine_text = if live {
                    "RELINKING…".to_string()
                } else {
                    "NO SIGNAL".to_string()
                };
                self.health = GaugeHud::default();
                self.action = GaugeHud::default();
                self.spirit = GaugeHud::default();
                self.health_text = "—".into();
                self.action_text = "—".into();
                self.spirit_text = "—".into();
                self.weapon = None;
                self.position = None;
            }
        }

        // Target plate from the selection (relation-tinted; chips bounded).
        self.target = selected_actor_id.and_then(|sel| {
            let a = store.actors.get(sel)?;
            let alive = a.life_state == "alive";
            let mut chips: Vec<ChipHud> = Vec::with_capacity(TARGET_CHIP_MAX);
            if !alive {
                // stamp carries death; chips stay for posture/status
            }
            if a.posture.as_deref() == Some("kneel") && chips.len() < TARGET_CHIP_MAX {
                chips.push(ChipHud {
                    label: "KNEELING".into(),
                    danger: false,
                });
            }
            for status in &a.statuses {
                if chips.len() >= TARGET_CHIP_MAX {
                    break;
                }
                if let Some(label) = status.as_str().map(str::to_string).or_else(|| {
                    status
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }) {
                    chips.push(ChipHud {
                        label: sanitize_text(&label, 16).to_uppercase(),
                        danger: false,
                    });
                }
            }
            let relation = relation_for(a, player_id);
            if relation == RelationHud::Hostile && chips.len() < TARGET_CHIP_MAX {
                chips.insert(
                    0,
                    ChipHud {
                        label: "HOSTILE".into(),
                        danger: true,
                    },
                );
                chips.truncate(TARGET_CHIP_MAX);
            }
            Some(TargetHud {
                actor_id: sel.to_string(),
                name: clean_actor_name(&a.display_name, &a.label, sel).to_uppercase(),
                relation,
                health: GaugeHud {
                    value: a.vitals.health,
                    max: a.max_vitals.health,
                },
                alive,
                stamp: match a.life_state.as_str() {
                    "downed" => Some("DOWN"),
                    "respawning" | "dead" => Some("DEAD"),
                    _ => None,
                },
                chips,
            })
        });

        // Group HUD from the streamed groups section (owning-session channel).
        self.group_invite_from = None;
        self.group_members.clear();
        if let Some(groups) = &store.groups {
            if let Some(invite) = groups.get("pendingInvite") {
                self.group_invite_from = invite
                    .get("fromName")
                    .or_else(|| invite.get("from"))
                    .and_then(|v| v.as_str())
                    .map(|s| sanitize_text(s, 32).to_uppercase());
            }
            if let Some(members) = groups.get("members").and_then(|v| v.as_array()) {
                for m in members {
                    if self.group_members.len() > GROUP_CHIP_MAX {
                        break;
                    }
                    let id = m.get("actorId").and_then(|v| v.as_str()).unwrap_or("");
                    if id == player_id || id == store.player_actor_id {
                        continue; // self stays on the status plate
                    }
                    let name = m
                        .get("name")
                        .and_then(|v| v.as_str())
                        .map(|s| sanitize_text(s, 24).to_uppercase())
                        .unwrap_or_else(|| id.to_string());
                    let health = m.get("healthFrac").and_then(|v| v.as_f64()).unwrap_or(1.0);
                    self.group_members.push(GroupMemberHud {
                        actor_id: id.to_string(),
                        name,
                        leader: m.get("leader").and_then(|v| v.as_bool()).unwrap_or(false),
                        health_frac: health as f32,
                        down: m.get("down").and_then(|v| v.as_bool()).unwrap_or(false),
                        link_dead: m.get("linkDead").and_then(|v| v.as_bool()).unwrap_or(false),
                    });
                }
            }
        }

        // Radar contacts: relation-filtered live actors around the player.
        self.radar_contacts.clear();
        if let Some((px, py)) = self.position {
            for (id, a) in store.render_actors() {
                if id == player_id || *id == store.player_actor_id {
                    continue;
                }
                let dx = a.x - px;
                let dy = a.y - py;
                if dx * dx + dy * dy > radar::RADIUS_CELLS * radar::RADIUS_CELLS * 4.0 {
                    continue; // beyond twice the scope — never plotted, skip early
                }
                let class = match relation_for(a, player_id) {
                    RelationHud::Hostile | RelationHud::Alerted => RadarClass::Hostile,
                    RelationHud::Friendly | RelationHud::Grouped => RadarClass::Civilian,
                    RelationHud::Neutral => {
                        if a.role.as_deref() == Some("npc") || a.role.as_deref() == Some("trainer")
                        {
                            RadarClass::Civilian
                        } else {
                            RadarClass::Passive
                        }
                    }
                };
                self.radar_contacts.push(RadarContactHud {
                    actor_id: id.clone(),
                    dx_cells: dx,
                    dy_cells: dy,
                    class,
                });
            }
        }
    }
}

fn gauge_text(g: &GaugeHud) -> String {
    if g.max > 0.0 {
        format!("{}", g.value.max(0.0).round() as i64)
    } else {
        "—".to_string()
    }
}

/// Relation classification from streamed actor fields (faction/pvp/social).
pub fn relation_for(
    a: &successor_client_proto::packets::GameActorSnapshot,
    _player_id: &str,
) -> RelationHud {
    if a.pvp_status.as_deref() == Some("hostile") {
        return RelationHud::Hostile;
    }
    match a.faction_id.as_deref() {
        Some("hostile") | Some("raider") | Some("feral") => RelationHud::Hostile,
        Some("settler") | Some("friendly") => RelationHud::Friendly,
        _ => match a.social_group.as_deref() {
            Some("hostile") => RelationHud::Hostile,
            Some("friendly") => RelationHud::Friendly,
            _ => RelationHud::Neutral,
        },
    }
}

/// Weapon id → stenciled field designation (port of `theme.weaponDisplayName`).
pub fn weapon_display_name(weapon_id: &str) -> String {
    let cleaned = weapon_id.trim().trim_start_matches("weapon_");
    let mut out = String::with_capacity(cleaned.len());
    for ch in cleaned.chars() {
        if ch == '_' || ch == '-' {
            out.push(' ');
        } else {
            out.push(ch.to_ascii_uppercase());
        }
    }
    if out.is_empty() {
        "SIDEARM".to_string()
    } else {
        out
    }
}

// ── HUD intents ─────────────────────────────────────────────────────────────

/// Intents the HUD emits; the connected host routes them through the public
/// gameplay action path (`game::actions`) or the window manager. The HUD
/// never mutates authority-owned state.
#[derive(Clone, Debug, PartialEq)]
pub enum HudAction {
    ToggleWindow(&'static str),
    OpenWindow(&'static str),
    /// A toolbar verb slot fired (registry action id).
    RunVerb(&'static str),
    /// A toolbar item slot fired (item catalog id).
    UseToolbarItem(String),
    ToggleSprint,
    GroupAccept,
    GroupDecline,
    CloneRespawn,
    RadarSelect(String),
    RadarMove {
        dx_cells: f32,
        dy_cells: f32,
    },
    QueueCancel(String),
    CycleTheme,
    /// Toolbar layout/binds changed — host persists the doc (Local scope).
    ToolbarChanged,
}

// ── Window registry ─────────────────────────────────────────────────────────

/// Permanent (dock-visible) windows: id, title, icon id, hotkey code.
/// Mirrors the reference dock set exactly.
pub const PERMANENT_WINDOWS: [(&str, &str, &str, &str); 8] = [
    ("character", "CHARACTER", "character", "KeyC"),
    ("inventory", "INVENTORY", "inventory", "KeyI"),
    ("datapad", "DATAPAD", "datapad", "KeyP"),
    ("skills", "SKILLS", "skills", "KeyK"),
    ("actions", "ACTIONS", "actions", "KeyB"),
    ("macros", "MACROS", "macro", "KeyM"),
    ("options", "OPTIONS", "options", "KeyO"),
    ("pa", "ASSOCIATION", "association", "KeyG"),
];

/// Context windows: opened only from their terminal/target/item routes —
/// never from the dock. (id, title, icon id).
pub const CONTEXT_WINDOWS: [(&str, &str, &str); 12] = [
    ("craft", "CRAFT", "craft"),
    ("splice", "SPLICE", "splice"),
    ("converse", "CONVERSE", "converse"),
    ("trade", "TRADE", "trade"),
    ("bug-report", "REPORT", "bug-report"),
    ("examine", "EXAMINE", "examine"),
    ("survey", "SURVEY", "survey"),
    ("travel", "TRAVEL", "travel"),
    ("loot", "LOOT", "loot"),
    ("bank", "BANK", "bank"),
    ("clone", "CLONE", "clone-facility"),
    ("build", "LAND / BUILD", "build"),
];

/// Registered windows for the standalone UI demo (`--demo ui`): the union of
/// the permanent + context sets, sample-backed. Demo-only — the connected
/// runtime registers PERMANENT_WINDOWS/CONTEXT_WINDOWS itself.
pub const DEMO_WINDOWS: [(&str, &str, &str); 18] = [
    ("inventory", "INVENTORY", "inventory"),
    ("character", "CHARACTER", "character"),
    ("skills", "SKILLS", "skills"),
    ("options", "OPTIONS", "options"),
    ("datapad", "DATAPAD", "datapad"),
    ("loot", "LOOT", "loot"),
    ("bank", "BANK", "bank"),
    ("trade", "TRADE", "trade"),
    ("craft", "CRAFT", "craft"),
    ("survey", "SURVEY", "survey"),
    ("converse", "CONVERSE", "converse"),
    ("travel", "TRAVEL", "travel"),
    ("clone", "CLONE", "clone-facility"),
    ("pa", "ASSOCIATION", "association"),
    ("splice", "SPLICE", "splice"),
    ("macros", "MACROS", "macro"),
    ("actions", "ACTIONS", "actions"),
    ("bug-report", "REPORT", "bug-report"),
];

/// Short key glyph for a `KeyboardEvent.code`-style bind (dock badges,
/// toolbar hotkey corners). Port of `icons.hotkeyGlyph`.
pub fn code_glyph(code: &str) -> &str {
    match code {
        "Digit1" => "1",
        "Digit2" => "2",
        "Digit3" => "3",
        "Digit4" => "4",
        "Digit5" => "5",
        "Digit6" => "6",
        "Digit7" => "7",
        "Digit8" => "8",
        "Digit9" => "9",
        "Digit0" => "0",
        "Minus" => "-",
        "Equal" => "=",
        _ => code.strip_prefix("Key").unwrap_or(code),
    }
}

// ── Frame composition ───────────────────────────────────────────────────────

/// Everything `build_hud` needs beyond the projection: mutable toolbar (drag
/// and rebind state), theme palette, monotonic time and pointer capture.
pub struct HudFrame<'a> {
    pub state: &'a HudState,
    pub toolbar: &'a mut toolbar::Toolbar,
    pub palette: Palette,
    pub now_ms: u64,
    /// Pointer already captured by a window/overlay — HUD stays visual-only.
    pub captured: bool,
    /// Right-button pressed edge this frame (slot clear).
    pub right_pressed: bool,
}

/// Build the connected HUD chrome. Pushes intents into `out` (caller-owned,
/// cleared per frame). Draw order: plates → radar → queue → overlays chrome →
/// dock → toolbar → death overlay (topmost).
pub fn build_hud(
    ui: &mut UiBuilder,
    icons: &Icons,
    frame: &mut HudFrame,
    w: u32,
    h: u32,
    out: &mut Vec<HudAction>,
) {
    let sw = w as f32;
    let sh = h as f32;
    let pal = frame.palette;
    let st = frame.state;

    // Player and target plates share the top-left information rail, matching
    // the web client's scan order and leaving the lower-left corner for chat.
    plate::draw_status_plate(ui, &pal, st, 16.0, 16.0, out);

    if let Some(target) = &st.target {
        plate::draw_target_plate(ui, &pal, target, 16.0 + plate::PLATE_W + 10.0, 16.0);
    }

    // Group invite toast (top-center) + member rail (under the target plate).
    plate::draw_group(ui, &pal, st, sw, out);

    // Radar (top-right) + click routing (suppressed while captured).
    radar::draw_radar(
        ui,
        &pal,
        st,
        sw - radar::PANEL_W - 56.0,
        16.0,
        frame.captured,
        out,
    );

    // Ability queue pane (right edge, under the radar).
    plate::draw_queue(
        ui,
        &pal,
        st,
        sw - 232.0 - 56.0,
        16.0 + radar::PANEL_H + 12.0,
        out,
    );

    // Interact chip (bottom-center, above the toolbar).
    if let Some(chip) = &st.interact {
        plate::draw_interact_chip(ui, &pal, chip, sw * 0.5, sh - 148.0);
    }

    // Extraction/camp toast + command banners.
    plate::draw_toasts(ui, &pal, st, frame.now_ms, sw, sh);

    // First-steps guidance (left edge, mid-height).
    plate::draw_first_steps(ui, &pal, st, 16.0, sh * 0.42);

    // Crosshair (combat option; context-sensitive).
    if st.crosshair && st.weapon.is_some() && st.life == LifeHud::Alive {
        let cx = sw * 0.5;
        let cy = sh * 0.5;
        ui.rect(cx - 7.0, cy - 1.0, 5.0, 2.0, pal.accent);
        ui.rect(cx + 2.0, cy - 1.0, 5.0, 2.0, pal.accent);
        ui.rect(cx - 1.0, cy - 7.0, 2.0, 5.0, pal.accent);
        ui.rect(cx - 1.0, cy + 2.0, 2.0, 5.0, pal.accent);
    }

    // Dock (right rail) + toolbar (bottom-center).
    toolbar::draw_dock(ui, icons, &pal, frame.toolbar, sw, sh, frame.captured, out);
    toolbar::draw_toolbar(
        ui,
        icons,
        &pal,
        frame.toolbar,
        st,
        sw,
        sh,
        frame.captured,
        frame.right_pressed,
        frame.now_ms,
        out,
    );

    // Death / clone overlay draws over everything but keeps chat usable
    // (backdrop is visual-only; only the panel takes clicks).
    plate::draw_death_overlay(ui, &pal, st, sw, sh, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_state_is_disconnected_and_sample_free() {
        let st = HudState::default();
        assert_eq!(st.connection, ConnectionHud::NoSignal);
        assert!(st.name.is_empty());
        assert!(st.area_label.is_empty());
        assert!(st.weapon.is_none());
        assert!(st.target.is_none());
        assert!(st.radar_contacts.is_empty());
        assert_eq!(st.health.max, 0.0);
        assert_eq!(st.spirit.max, 0.0);
    }

    #[test]
    fn sanitize_strips_controls_and_bounds() {
        assert_eq!(sanitize_text("a\x07b\nc", 16), "ab c"); // control dropped, newline collapses
        assert_eq!(sanitize_text("  hello   world  ", 32), "hello world");
        assert_eq!(sanitize_text("xxxxxxxxxx", 4), "xxxx");
        assert_eq!(sanitize_text("\u{202e}rtl\u{0000}", 8), "\u{202e}rtl");
    }

    #[test]
    fn clean_actor_name_prefers_display_then_stripped_label() {
        assert_eq!(
            clean_actor_name("Mori Maddox", "ignored", "fb"),
            "Mori Maddox"
        );
        assert_eq!(
            clean_actor_name("", "Mori Maddox (a rogue trooper)", "fb"),
            "Mori Maddox"
        );
        assert_eq!(clean_actor_name("", "", "fb"), "fb");
    }

    #[test]
    fn themes_match_reference_order_and_accents() {
        assert_eq!(THEME_IDS, ["signal", "phosphor", "amber", "oxide"]);
        assert_eq!(palette(0).accent, [0x48, 0xd6, 0xe6, 255]);
        assert_eq!(palette(1).accent, [0x46, 0xff, 0x7a, 255]);
        assert_eq!(palette(2).accent, [0xff, 0xb2, 0x4a, 255]);
        assert_eq!(palette(3).accent, [0xc4, 0x4a, 0x26, 255]);
        assert_eq!(theme_index_for_id("amber"), 2);
        assert_eq!(theme_index_for_id("unknown"), 0);
    }

    #[test]
    fn projection_from_empty_store_reads_no_signal() {
        let store = crate::game::authority::AuthorityStore::new();
        let mut st = HudState::default();
        st.project(&store, "me", None);
        assert_eq!(st.connection, ConnectionHud::NoSignal);
        assert_eq!(st.fine_text, "NO SIGNAL");
        assert_eq!(st.health_text, "—");
    }

    #[test]
    fn weapon_display_name_folds_ids() {
        assert_eq!(
            weapon_display_name("weapon_slugthrower_mk2"),
            "SLUGTHROWER MK2"
        );
        assert_eq!(weapon_display_name(""), "SIDEARM");
    }
}
