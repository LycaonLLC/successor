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
use successor_engine_render::ui::{AtlasMeta, TextField, UiBuilder};

pub mod layout;
pub mod overlays;
pub mod plate;
pub mod radar;
pub mod toolbar;
pub mod waypoints;

const ICONS_A8: &[u8] = include_bytes!("../assets/ui/icons.a8");
const ICONS_JSON: &str = include_str!("../assets/ui/icons.json");
const UI_FONT_TTF: &[u8] = include_bytes!("../assets/ui/PT_Sans-Web-Bold.ttf");
const LOADING_DESTINATION_PNG: &[u8] =
    include_bytes!("../assets/ui/generated/loading-destination-atlas.png");
const NAV_WEDGE_LEFT_PNG: &[u8] = include_bytes!("../assets/ui/generated/nav-wedge-left.png");
const NAV_WEDGE_RIGHT_PNG: &[u8] = include_bytes!("../assets/ui/generated/nav-wedge-right.png");
const ROSTER_CHEVRON_PNG: &[u8] = include_bytes!("../assets/ui/generated/row-chevron.png");
const RADIAL_TICK_CROWN_PNG: &[u8] = include_bytes!("../assets/ui/generated/radial-tick-crown.png");
const PROGRESS_ARC_PNG: &[u8] = include_bytes!("../assets/ui/generated/progress-arc.png");
const UI_ATLAS_W: usize = 1024;
const UI_ATLAS_H: usize = 1024;
const UI_FONT_REGION_W: usize = 512;
const UI_FONT_SOURCE_PX: f32 = 32.0;

const fn authored_uv(x: usize, y: usize, w: usize, h: usize) -> (f32, f32, f32, f32) {
    (
        x as f32 / UI_ATLAS_W as f32,
        y as f32 / UI_ATLAS_H as f32,
        (x + w) as f32 / UI_ATLAS_W as f32,
        (y + h) as f32 / UI_ATLAS_H as f32,
    )
}

pub const LOADING_DESTINATION_UV: (f32, f32, f32, f32) = authored_uv(512, 0, 512, 512);
pub const NAV_WEDGE_LEFT_UV: (f32, f32, f32, f32) = authored_uv(512, 512, 77, 109);
pub const NAV_WEDGE_RIGHT_UV: (f32, f32, f32, f32) = authored_uv(608, 512, 85, 109);
pub const ROSTER_CHEVRON_UV: (f32, f32, f32, f32) = authored_uv(704, 512, 75, 97);
pub const RADIAL_TICK_CROWN_UV: (f32, f32, f32, f32) = authored_uv(800, 512, 147, 143);
pub const PROGRESS_ARC_UV: (f32, f32, f32, f32) = authored_uv(512, 672, 132, 135);

fn blit_png(rgba: &mut [u8], bytes: &[u8], x: usize, y: usize, w: usize, h: usize) {
    let image = successor_engine_core::image::decode_image("image/png", bytes)
        .expect("authored UI image decode");
    assert_eq!((image.width as usize, image.height as usize), (w, h));
    for row in 0..h {
        let src = &image.pixels[row * w * 4..(row + 1) * w * 4];
        let start = ((y + row) * UI_ATLAS_W + x) * 4;
        rgba[start..start + w * 4].copy_from_slice(src);
    }
}

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
            if atlas_x + metrics.width + 2 > UI_FONT_REGION_W {
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
        blit_png(&mut rgba, LOADING_DESTINATION_PNG, 512, 0, 512, 512);
        blit_png(&mut rgba, NAV_WEDGE_LEFT_PNG, 512, 512, 77, 109);
        blit_png(&mut rgba, NAV_WEDGE_RIGHT_PNG, 608, 512, 85, 109);
        blit_png(&mut rgba, ROSTER_CHEVRON_PNG, 704, 512, 75, 97);
        blit_png(&mut rgba, RADIAL_TICK_CROWN_PNG, 800, 512, 147, 143);
        blit_png(&mut rgba, PROGRESS_ARC_PNG, 512, 672, 132, 135);
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

/// Theme palettes.
///
/// Panel and cell tones are derived from each theme's accent rather than being
/// a near-black slab: the original's pane is a translucent tint under a bright
/// outline (`ui_options.inc` centre `#003848`), and a black fill reads as a
/// hole punched in the world, not a surface. Every pair below is checked
/// against WCAG AA at small-text size — ink clears 7.2:1 on its own panel,
/// dim ink clears 4.6:1, and the accent clears 4.7:1 — so no theme has
/// unreadable type.
pub const THEMES: [Palette; THEME_COUNT] = [
    // signal
    Palette {
        bg_panel: hexa(0x113337, 232),
        bg_cell: hexa(0x0a1e20, 235),
        ink: hex(0xcfe9ef),
        ink_dim: hex(0x899a9e),
        hairline: hex(0x1a4d53),
        accent: hex(0x48d6e6),
        accent_soft: hex(0x164045),
        danger: hex(0xe34a4a),
    },
    // phosphor
    Palette {
        bg_panel: hexa(0x113d1d, 232),
        bg_cell: hexa(0x0a2411, 235),
        ink: hex(0x9cf0b4),
        ink_dim: hex(0x45b362),
        hairline: hex(0x195c2c),
        accent: hex(0x46ff7a),
        accent_soft: hex(0x154c25),
        danger: hex(0xe34a4a),
    },
    // amber
    Palette {
        bg_panel: hexa(0x3d2b12, 232),
        bg_cell: hexa(0x24190a, 235),
        ink: hex(0xffd98c),
        ink_dim: hex(0xad945f),
        hairline: hex(0x5c401b),
        accent: hex(0xffb24a),
        accent_soft: hex(0x4c3516),
        danger: hex(0xe34a4a),
    },
    // oxide
    Palette {
        bg_panel: hexa(0x36190e, 232),
        bg_cell: hexa(0x1f0e08, 235),
        ink: hex(0xe6d4b8),
        ink_dim: hex(0x938876),
        hairline: hex(0x512515),
        accent: hex(0xe0673a),
        accent_soft: hex(0x431f11),
        danger: hex(0xe34a4a),
    },
];

/// Palette for a theme index (out-of-range folds to the default SIGNAL).
pub fn palette(theme_index: usize) -> Palette {
    THEMES[theme_index % THEME_COUNT]
}

/// Workspace frame chrome for a palette.
///
/// `WindowStyle::default` carries the measured Signal tones as literals, which
/// left every frame cyan under any other theme. The grammar is what is fixed —
/// translucent pane, one bright perimeter, dark ink on the caption rail — so
/// the tones come from the theme and only the structure is hardcoded.
pub fn window_style(
    palette: &Palette,
) -> successor_engine_render::window::WindowStyle {
    let mut style = successor_engine_render::window::WindowStyle::default();
    let bright = palette.accent;
    let inset = shade(palette.accent, 0.42);
    style.frame.center = palette.bg_panel;
    style.frame.north = with_alpha(bright, 210);
    style.frame.north_east = with_alpha(bright, 210);
    style.frame.north_west = with_alpha(bright, 210);
    style.frame.south = with_alpha(inset, 220);
    style.frame.east = with_alpha(inset, 220);
    style.frame.west = with_alpha(inset, 220);
    style.frame.south_east = with_alpha(inset, 220);
    style.frame.south_west = with_alpha(inset, 220);
    style.title_bar = with_alpha(inset, 232);
    style.title_bar_focused = with_alpha(bright, 236);
    style.edge = with_alpha(bright, 204);
    // Caption ink is dark ON the bright rail, so it darkens with the accent
    // rather than staying a fixed navy that would vanish on amber.
    style.caption_text = with_alpha(shade(palette.accent, 0.18), 255);
    style.close = style.caption_text;
    style.text = palette.ink;
    style.resize = with_alpha(bright, 220);
    style
}

/// Button chrome for the active theme.
///
/// `ButtonStyle::default` is a fixed slate blue that the engine cannot theme —
/// it has no palette. It was the single largest unthemed surface in the UI,
/// frozen across chat, options, macros, the bug report, the inventory footer
/// and the character sheet. Every app-side button reads this instead.
pub fn button_style() -> successor_engine_render::ui::ButtonStyle {
    let palette = active_palette();
    successor_engine_render::ui::ButtonStyle {
        fill: faded(palette.bg_cell),
        hover: with_alpha(palette.accent_soft, 235),
        active: with_alpha(shade(palette.accent, 0.55), 240),
        edge: palette.hairline,
        text: palette.ink,
    }
}

fn shade(rgba: [u8; 4], factor: f32) -> [u8; 4] {
    let scale = |c: u8| (c as f32 * factor).round().clamp(0.0, 255.0) as u8;
    [scale(rgba[0]), scale(rgba[1]), scale(rgba[2]), rgba[3]]
}

fn with_alpha(rgba: [u8; 4], alpha: u8) -> [u8; 4] {
    [rgba[0], rgba[1], rgba[2], alpha]
}

/// Theme index for a stored id; unknown ids reset to SIGNAL (0).
pub fn theme_index_for_id(id: &str) -> usize {
    THEME_IDS.iter().position(|t| *t == id).unwrap_or(0)
}

/// Opacity band for the transparency settings. The floor is where a pane stops
/// separating itself from terrain; the ceiling is opaque.
pub const MIN_UI_OPACITY: f32 = 0.35;
pub const MAX_UI_OPACITY: f32 = 1.0;

thread_local! {
    static ACTIVE_PALETTE: core::cell::Cell<Palette> = const { core::cell::Cell::new(THEMES[0]) };
    static FILL_OPACITY: core::cell::Cell<f32> = const { core::cell::Cell::new(1.0) };
}

/// Theme palette for the frame being drawn.
///
/// Window surfaces used to carry their own hardcoded ink, so switching themes
/// recoloured the HUD and left every workspace frame cyan. The host publishes
/// the active palette once per frame and every surface reads it from here, so
/// one theme covers the whole UI.
pub fn active_palette() -> Palette {
    ACTIVE_PALETTE.with(core::cell::Cell::get)
}

pub fn set_active_palette(palette: Palette) {
    ACTIVE_PALETTE.with(|active| active.set(palette));
}

/// Alpha scale for pane, well, and slot FILLS.
///
/// Fills only. The original's window transparency fades the pane and leaves
/// the type and the bright perimeter at full strength, because a translucent
/// glyph is unreadable over terrain.
pub fn fill_opacity() -> f32 {
    FILL_OPACITY.with(core::cell::Cell::get)
}

pub fn set_fill_opacity(value: f32) {
    let value = if value.is_finite() {
        value.clamp(MIN_UI_OPACITY, MAX_UI_OPACITY)
    } else {
        MAX_UI_OPACITY
    };
    FILL_OPACITY.with(|opacity| opacity.set(value));
}

/// Scale a fill colour's alpha by [`fill_opacity`].
pub fn faded(rgba: [u8; 4]) -> [u8; 4] {
    let alpha = (rgba[3] as f32 * fill_opacity()).round().clamp(0.0, 255.0) as u8;
    [rgba[0], rgba[1], rgba[2], alpha]
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

/// Who an actor is to you, as the nameplate and radar read it.
///
/// Owner ruling 2026-08-04, and it is the authority over both clients: an NPC
/// name is white; a corpse is white; a passive attackable NPC is yellow and
/// turns red once it has been attacked; an aggressive attackable NPC is red; a
/// neutral player is bright blue; a player in your guild or faction is purple;
/// and a player open to you in PVP is red.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RelationHud {
    /// Will fight you now: aggressive NPC, a provoked passive, or a PVP-open player.
    Hostile,
    /// Attackable but will not start it. Becomes [`RelationHud::Hostile`] once engaged.
    Attackable,
    /// Not a combatant, and every corpse.
    #[default]
    Social,
    /// Another player with no standing either way.
    Player,
    /// Another player in your guild or faction.
    Allied,
}

impl RelationHud {
    /// Relation ink is actor identity, not chrome, so it never follows the
    /// theme: an ally is the same purple in every palette, and in the web
    /// client too.
    pub fn tint(self, _pal: &Palette) -> [u8; 4] {
        match self {
            RelationHud::Hostile => [0xd3, 0x3b, 0x32, 255],
            RelationHud::Attackable => [0xf1, 0xd0, 0x6b, 255],
            RelationHud::Social => [0xf8, 0xf7, 0xf1, 255],
            RelationHud::Player => [0x4a, 0xa9, 0xff, 255],
            RelationHud::Allied => [0xb0, 0x66, 0xff, 255],
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
    /// Present only when the selected authority frame carries a real action
    /// pool (objects and simple creatures expose health alone).
    pub action: Option<GaugeHud>,
    /// Present only when the selected authority frame carries a real spirit
    /// pool (objects and simple creatures expose health alone).
    pub spirit: Option<GaugeHud>,
    /// North-up world-plane distance from the authority-selected player.
    pub distance_m: Option<f32>,
    /// No level field exists in the current authority actor snapshot, so this
    /// remains `None` until such a field is streamed.
    pub level: Option<u32>,
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
    pub world_seed: i32,
    pub biome: crate::world::terrain::Biome,
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
        let player_position = player.map(|actor| (actor.x, actor.y));
        // Standing is judged against the looking player's own organization.
        let viewer_org = player
            .and_then(|actor| actor.player_organization_id.as_deref())
            .filter(|org| !org.is_empty());
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
                            "REARMING...".to_string()
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
                self.fine_text = format!("LIVE / {count} IN FIELD");
            }
            None => {
                let live = self.connection == ConnectionHud::Reconnecting;
                if !live {
                    self.connection = ConnectionHud::NoSignal;
                }
                self.fine_text = if live {
                    "RELINKING...".to_string()
                } else {
                    "NO SIGNAL".to_string()
                };
                self.health = GaugeHud::default();
                self.action = GaugeHud::default();
                self.spirit = GaugeHud::default();
                self.health_text = "--".into();
                self.action_text = "--".into();
                self.spirit_text = "--".into();
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
            let relation = relation_for(a, player_id, viewer_org);
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
            let distance_m = player_position
                .map(|(player_x, player_y)| (a.x - player_x).hypot(a.y - player_y))
                .filter(|distance| distance.is_finite());
            Some(TargetHud {
                actor_id: sel.to_string(),
                name: clean_actor_name(&a.display_name, &a.label, sel).to_uppercase(),
                relation,
                health: GaugeHud {
                    value: a.vitals.health,
                    max: a.max_vitals.health,
                },
                action: (a.max_vitals.action > 0.0).then_some(GaugeHud {
                    value: a.vitals.action,
                    max: a.max_vitals.action,
                }),
                spirit: (a.max_vitals.spirit > 0.0).then_some(GaugeHud {
                    value: a.vitals.spirit,
                    max: a.max_vitals.spirit,
                }),
                distance_m,
                level: None,
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
                let class = match relation_for(a, player_id, viewer_org) {
                    RelationHud::Hostile => RadarClass::Hostile,
                    RelationHud::Attackable => RadarClass::Passive,
                    RelationHud::Social | RelationHud::Player | RelationHud::Allied => {
                        RadarClass::Civilian
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
        "--".to_string()
    }
}

/// Whether an actor fights at all, mirroring `actorRoleProfiles` in
/// `client/src/slice-core/npcSystem.ts`. Roles the table does not name are
/// social, which is the safe read: an unknown actor is not painted as a threat.
fn is_combat_role(role: Option<&str>) -> bool {
    matches!(role, Some("creature") | Some("range_guard"))
        || role.is_some_and(|r| r.starts_with("skirmisher"))
}

fn is_player_role(role: Option<&str>) -> bool {
    matches!(role, Some("player") | Some("agent_player"))
}

/// Relation classification from streamed actor fields.
///
/// `viewer_org` is the looking player's guild/faction id; without it no actor
/// can be an ally, which is the correct fallback rather than guessing.
pub fn relation_for(
    a: &successor_client_proto::packets::GameActorSnapshot,
    _player_id: &str,
    viewer_org: Option<&str>,
) -> RelationHud {
    // A corpse is a corpse whatever it was in life.
    if matches!(a.life_state.as_str(), "dead" | "downed" | "respawning") {
        return RelationHud::Social;
    }

    let role = a.role.as_deref();
    if is_player_role(role) {
        if a.pvp_status.as_deref() == Some("hostile") {
            return RelationHud::Hostile;
        }
        let allied = match (viewer_org, a.player_organization_id.as_deref()) {
            (Some(mine), Some(theirs)) => !mine.is_empty() && mine == theirs,
            _ => false,
        };
        return if allied {
            RelationHud::Allied
        } else {
            RelationHud::Player
        };
    }

    if !is_combat_role(role) {
        return RelationHud::Social;
    }

    // A passive only reads yellow until it has been drawn into a fight; once
    // engaged it is as dangerous as anything that opened on sight.
    let aggressive = a.will_auto_aggro.unwrap_or(false);
    let engaged = a.in_combat.unwrap_or(false);
    if aggressive || engaged {
        RelationHud::Hostile
    } else {
        RelationHud::Attackable
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

/// Stable host id for the player-status plate.
pub const PLAYER_STATUS_ID: &str = "hud.player-status";
/// Stable host id for the current-target plate.
pub const TARGET_STATUS_ID: &str = "hud.target-status";
/// Stable host id for the wielded-weapon readout.
pub const WEAPON_STATUS_ID: &str = "hud.weapon-status";
/// Stable host id for the group roster.
pub const GROUP_ROSTER_ID: &str = "hud.group-roster";
/// Stable host id for the twelve-slot command bar.
pub const COMMAND_BAR_ID: &str = "hud.command-bar";
/// Stable host id for the persistent chat console.
pub const CHAT_CONSOLE_ID: &str = "hud.chat-console";
/// Stable host id for the ability queue.
pub const ABILITY_QUEUE_ID: &str = "hud.ability-queue";
/// Stable host id for the compact notifications/status strip.
pub const STATUS_STRIP_ID: &str = "hud.notifications";
/// Stable host id for the managed ground radar.
pub const GROUND_RADAR_ID: &str = "ground-radar";

/// Caption carried by the manager chrome when a host elects to show it.
pub const GROUND_RADAR_TITLE: &str = "RADAR";
/// Atlas icon used by the radar's workspace icon.
pub const GROUND_RADAR_ICON: &str = "survey";
/// Measured `SwgCuiGroundRadar` workspace lane: a fixed 32×32 icon at (0,64).
pub const GROUND_RADAR_ICON_SLOT: (f32, f32) = (0.0, 64.0);

/// Largest viewport in the supported HUD matrix. Hosts that know their first
/// framebuffer should prefer [`register_hud_surfaces_at`] so first-run defaults
/// come directly from that framebuffer's [`layout::compute`] result.
const HUD_REGISTRATION_VIEWPORT: (f32, f32) = (1600.0, 1200.0);

/// A persistent, manager-owned HUD pane. `default_rect` resolves its first-run
/// rect from [`layout::compute`]; it is never consulted after registration or a
/// persisted layout restore.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HudSurface {
    pub id: &'static str,
    pub title: &'static str,
    pub icon: &'static str,
    pub min_size: [f32; 2],
    kind: HudSurfaceKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HudSurfaceKind {
    PlayerStatus,
    WeaponStatus,
    GroupRoster,
    TargetStatus,
    CommandBar,
    ChatConsole,
    AbilityQueue,
    StatusStrip,
    GroundRadar,
}

impl HudSurface {
    /// First-run content rect for this surface at a particular framebuffer.
    pub fn default_rect(self, layout: layout::HudLayout) -> [f32; 4] {
        match self.kind {
            HudSurfaceKind::PlayerStatus => layout.plate,
            HudSurfaceKind::WeaponStatus => layout.weapon,
            HudSurfaceKind::GroupRoster => layout.group,
            HudSurfaceKind::TargetStatus => layout.target,
            HudSurfaceKind::CommandBar => layout.bar,
            HudSurfaceKind::ChatConsole => layout.chat,
            HudSurfaceKind::AbilityQueue => layout.queue,
            HudSurfaceKind::StatusStrip => layout.strip,
            HudSurfaceKind::GroundRadar => layout.radar,
        }
    }

    /// Whether first run opens this pane.
    ///
    /// The status strip is the one HUD pane that tells the player nothing they
    /// are not already looking at - shard state and the zone name, parked in
    /// the bottom-right corner over the world. It stays registered and stays
    /// reachable, it just does not claim a corner before anyone asks for it.
    pub fn opens_on_first_run(self) -> bool {
        !matches!(self.kind, HudSurfaceKind::StatusStrip)
    }
}

/// Number of persistent HUD workspace panes.
pub const HUD_SURFACE_COUNT: usize = 9;

/// Every persistent HUD surface. These are workspace windows, but normal play
/// leaves them chromeless and locked so no frame intercepts gameplay input.
pub const HUD_SURFACES: [HudSurface; HUD_SURFACE_COUNT] = [
    HudSurface {
        id: PLAYER_STATUS_ID,
        title: "PLAYER STATUS",
        icon: "character",
        min_size: [layout::PLATE_MIN_W, layout::PLATE_MIN_H],
        kind: HudSurfaceKind::PlayerStatus,
    },
    HudSurface {
        id: WEAPON_STATUS_ID,
        title: "WEAPON",
        icon: "weapon",
        min_size: [layout::WEAPON_MIN_W, layout::WEAPON_MIN_H],
        kind: HudSurfaceKind::WeaponStatus,
    },
    HudSurface {
        id: GROUP_ROSTER_ID,
        title: "GROUP",
        icon: "association",
        min_size: [layout::PLATE_MIN_W, plate::GROUP_CHIP_H],
        kind: HudSurfaceKind::GroupRoster,
    },
    HudSurface {
        id: TARGET_STATUS_ID,
        title: "TARGET STATUS",
        icon: "crosshair",
        min_size: [layout::TARGET_MIN_W, layout::TARGET_MIN_H],
        kind: HudSurfaceKind::TargetStatus,
    },
    HudSurface {
        id: COMMAND_BAR_ID,
        title: "COMMAND BAR",
        icon: "actions",
        min_size: [layout::BAR_MIN_W, layout::BAR_MIN_H],
        kind: HudSurfaceKind::CommandBar,
    },
    HudSurface {
        id: CHAT_CONSOLE_ID,
        title: "CHAT CONSOLE",
        icon: "converse",
        min_size: [layout::CHAT_MIN_W, layout::CHAT_MIN_H],
        kind: HudSurfaceKind::ChatConsole,
    },
    HudSurface {
        id: ABILITY_QUEUE_ID,
        title: "ABILITY QUEUE",
        icon: "actions",
        min_size: [layout::QUEUE_MIN_W, layout::QUEUE_MIN_H],
        kind: HudSurfaceKind::AbilityQueue,
    },
    HudSurface {
        id: STATUS_STRIP_ID,
        title: "NOTIFICATIONS",
        icon: "options",
        min_size: [layout::STRIP_MIN_W, layout::STRIP_MIN_H],
        kind: HudSurfaceKind::StatusStrip,
    },
    HudSurface {
        id: GROUND_RADAR_ID,
        title: GROUND_RADAR_TITLE,
        icon: GROUND_RADAR_ICON,
        min_size: [layout::RADAR_LANE_W, layout::RADAR_LANE_H],
        kind: HudSurfaceKind::GroundRadar,
    },
];

/// Registry lookup without allocating. The stable descriptor is also the
/// source of truth for whether a manager frame is a HUD pane.
pub fn hud_surface(id: &str) -> Option<&'static HudSurface> {
    HUD_SURFACES.iter().find(|surface| surface.id == id)
}

/// Whether `id` names one of the persistent HUD workspace panes.
pub fn is_hud_surface(id: &str) -> bool {
    hud_surface(id).is_some()
}

/// Apply layout-derived first-run bounds to every registered HUD pane.
///
/// Hosts that restored any user geometry should call
/// [`apply_missing_hud_surface_defaults`] instead, so an older layout document
/// that lacks a newly added pane does not reset the panes it did contain.
pub fn apply_hud_surface_defaults(
    manager: &mut successor_engine_render::window::WindowManager,
    viewport: (f32, f32),
) {
    apply_missing_hud_surface_defaults(manager, viewport, &[true; HUD_SURFACE_COUNT]);
}

/// Apply layout-derived first-run bounds only for pane slots absent from a
/// persisted workspace document.
pub fn apply_missing_hud_surface_defaults(
    manager: &mut successor_engine_render::window::WindowManager,
    viewport: (f32, f32),
    missing: &[bool; HUD_SURFACE_COUNT],
) {
    let defaults = layout::compute(viewport.0, viewport.1);
    for (surface, missing) in HUD_SURFACES.iter().zip(missing) {
        if *missing {
            let _ = manager.set_rect(surface.id, surface.default_rect(defaults));
        }
    }
}

fn register_hud_surface(
    manager: &mut successor_engine_render::window::WindowManager,
    surface: HudSurface,
    icon: Option<(u32, u32)>,
    defaults: layout::HudLayout,
) {
    let bounds = surface.default_rect(defaults);
    manager.register(
        surface.id,
        surface.title,
        icon,
        bounds,
        surface.min_size[0],
        surface.min_size[1],
    );
    // HUD panes own their visual content. At rest they have neither workspace
    // chrome nor pointer capture; right-clicking a pane unlocks its manager
    // move/resize gestures through `set_hud_surface_locked`.
    manager.set_chrome(surface.id, false);
    manager.set_interactive(surface.id, false);
    if surface.id == GROUND_RADAR_ID {
        manager.set_icon_slot(surface.id, Some(GROUND_RADAR_ICON_SLOT));
    }
    if surface.opens_on_first_run() {
        manager.open(surface.id);
    }
}

fn register_hud_surfaces_with_at<F>(
    manager: &mut successor_engine_render::window::WindowManager,
    viewport: (f32, f32),
    mut icon_for: F,
) where
    F: FnMut(&str) -> Option<(u32, u32)>,
{
    let defaults = layout::compute(viewport.0, viewport.1);
    for surface in HUD_SURFACES {
        register_hud_surface(manager, surface, icon_for(surface.icon), defaults);
    }
}

/// Register every persistent HUD pane at an explicit framebuffer. This is the
/// host entry point for first-run registration and deterministic layout tests.
pub fn register_hud_surfaces_at(
    manager: &mut successor_engine_render::window::WindowManager,
    icons: &Icons,
    viewport: (f32, f32),
) {
    register_hud_surfaces_with_at(manager, viewport, |icon| icons.cell(icon));
}

/// Register every persistent HUD pane using the supported-max fallback. A host
/// should follow this with [`apply_hud_surface_defaults`] once it knows the
/// first framebuffer, unless it restores persisted geometry first.
pub fn register_hud_surfaces(
    manager: &mut successor_engine_render::window::WindowManager,
    icons: &Icons,
) {
    register_hud_surfaces_at(manager, icons, HUD_REGISTRATION_VIEWPORT);
}

/// Register only the ground radar for hosts that do not own the complete HUD
/// registry yet. New hosts should use [`register_hud_surfaces_at`].
pub(crate) fn register_ground_radar_at(
    manager: &mut successor_engine_render::window::WindowManager,
    icon: Option<(u32, u32)>,
    viewport: (f32, f32),
) {
    let defaults = layout::compute(viewport.0, viewport.1);
    let surface = *hud_surface(GROUND_RADAR_ID).expect("ground radar is registered");
    register_hud_surface(manager, surface, icon, defaults);
}

/// Register the one managed radar frame, including its workspace icon slot.
pub fn register_ground_radar(
    manager: &mut successor_engine_render::window::WindowManager,
    icon: Option<(u32, u32)>,
) {
    register_ground_radar_at(manager, icon, HUD_REGISTRATION_VIEWPORT);
}

/// Toggle the per-pane layout lock for the frontmost HUD surface under a
/// right-click. Locked panes are visual-only; unlocked panes opt into the
/// manager's body move and eight-edge resize gestures.
pub fn toggle_hud_surface_lock_at(
    manager: &mut successor_engine_render::window::WindowManager,
    mouse_x: f32,
    mouse_y: f32,
) -> Option<&'static str> {
    let order = manager.z_order();
    for index in order.into_iter().rev() {
        let id = manager.window_id(index);
        if !manager.is_open(id) || manager.is_iconified(id) {
            continue;
        }
        let Some(rect) = manager.rect(id) else {
            continue;
        };
        if !successor_engine_render::ui::UiBuilder::hit(
            rect[0], rect[1], rect[2], rect[3], mouse_x, mouse_y,
        ) {
            continue;
        }
        let surface = hud_surface(id)?;
        manager.set_interactive(surface.id, !manager.is_interactive(surface.id));
        return Some(surface.id);
    }
    None
}

/// Restore a persistent HUD pane's lock bit. `locked` is stored alongside its
/// manager geometry by the connected host.
pub fn set_hud_surface_locked(
    manager: &mut successor_engine_render::window::WindowManager,
    id: &str,
    locked: bool,
) -> bool {
    let Some(surface) = hud_surface(id) else {
        return false;
    };
    manager.set_interactive(surface.id, !locked);
    true
}

/// Draw the only layout-edit affordance. It is deliberately hover-only: normal
/// play has no rail, perimeter, close control, or pointer interception.
pub fn draw_hud_layout_affordance(
    ui: &mut UiBuilder,
    manager: &successor_engine_render::window::WindowManager,
    id: &str,
    palette: &Palette,
) {
    if !manager.is_interactive(id) || !manager.is_open(id) {
        return;
    }
    let Some([x, y, w, h]) = manager.content_rect(id) else {
        return;
    };
    let (mouse_x, mouse_y) = ui.mouse();
    if !UiBuilder::hit(x, y, w, h, mouse_x, mouse_y) {
        return;
    }
    let mut tint = palette.accent;
    tint[3] = 220;
    ui.border(x, y, w, h, 1.0, tint);
    // The two-pixel top stroke is the revealed body-drag surface; every edge
    // and corner remains resize-active through WindowManager::update_at.
    ui.rect(x, y, w, 2.0, tint);
}

// ── Window registry ─────────────────────────────────────────────────────────

/// Dock-visible windows: `(id, title, icon id, hotkey code)`. Generated from
/// [`crate::windows::spec::SURFACES`] so the registry and the surface specs
/// cannot drift.
pub const PERMANENT_WINDOWS: [(&str, &str, &str, &str); 8] = permanent_windows();

/// Context windows: opened from their terminal/target/roster/item route, never
/// from the dock. `(id, title, icon id)`.
pub const CONTEXT_WINDOWS: [(&str, &str, &str); 13] = context_windows();

/// Every registered surface, for the standalone UI demo (`--demo ui`). The
/// union of the permanent and context sets by construction.
pub const DEMO_WINDOWS: [(&str, &str, &str); 21] = demo_windows();

const fn permanent_windows() -> [(&'static str, &'static str, &'static str, &'static str); 8] {
    let mut out = [("", "", "", ""); 8];
    let mut index = 0;
    let mut slot = 0;
    while index < crate::windows::spec::SURFACES.len() {
        let surface = &crate::windows::spec::SURFACES[index];
        if surface.dock {
            out[slot] = (surface.id, surface.title, surface.icon, surface.hotkey);
            slot += 1;
        }
        index += 1;
    }
    out
}

const fn context_windows() -> [(&'static str, &'static str, &'static str); 13] {
    let mut out = [("", "", ""); 13];
    let mut index = 0;
    let mut slot = 0;
    while index < crate::windows::spec::SURFACES.len() {
        let surface = &crate::windows::spec::SURFACES[index];
        if !surface.dock {
            out[slot] = (surface.id, surface.title, surface.icon);
            slot += 1;
        }
        index += 1;
    }
    out
}

const fn demo_windows() -> [(&'static str, &'static str, &'static str); 21] {
    let mut out = [("", "", ""); 21];
    let mut index = 0;
    while index < crate::windows::spec::SURFACES.len() {
        let surface = &crate::windows::spec::SURFACES[index];
        out[index] = (surface.id, surface.title, surface.icon);
        index += 1;
    }
    out
}

/// Window a dock hotkey code opens. The registry is the single source of truth
/// for the advertised binds, so the host's key routing and the dock badges
/// cannot disagree.
pub fn window_for_code(code: &str) -> Option<&'static str> {
    if code.is_empty() {
        return None;
    }
    PERMANENT_WINDOWS
        .iter()
        .find(|(_, _, _, hotkey)| *hotkey == code)
        .map(|(id, _, _, _)| *id)
}

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
        "Semicolon" => ";",
        "Comma" => ",",
        "Period" => ".",
        "Slash" => "/",
        "Tab" => "TAB",
        "Escape" => "ESC",
        "" => "",
        _ => code.strip_prefix("Key").unwrap_or(code),
    }
}

// ── Frame composition ───────────────────────────────────────────────────────

/// Everything `build_hud` needs beyond the projection: mutable toolbar/chat
/// state, theme palette, monotonic time and pointer capture.
pub struct HudFrame<'a> {
    pub state: &'a HudState,
    pub toolbar: &'a mut toolbar::Toolbar,
    /// The connected host supplies this; standalone visual demos have no chat
    /// transport and pass `None`.
    pub chat: Option<(&'a mut crate::game::chat_net::ChatClient, &'a mut TextField)>,
    pub palette: Palette,
    pub now_ms: u64,
    /// Pointer already captured by a window/overlay — HUD stays visual-only.
    pub captured: bool,
    /// Right-button pressed edge for toolbar slot clear. The host consumes a
    /// HUD-pane layout-lock click before this draw path runs.
    pub right_pressed: bool,
}

fn hud_content_rect(
    manager: &successor_engine_render::window::WindowManager,
    id: &str,
) -> Option<[f32; 4]> {
    (manager.is_open(id) && !manager.is_iconified(id))
        .then(|| manager.content_rect(id))
        .flatten()
}

/// Longest UTF-8 prefix that leaves room for an ellipsis when it is needed.
/// Status text is authority-provided, so clipping must never split a codepoint.
fn clip_status_text<'a>(ui: &UiBuilder, text: &'a str, px: f32, max_w: f32) -> (&'a str, bool) {
    if ui.measure_text(text, px) <= max_w {
        return (text, false);
    }
    let budget = (max_w - ui.measure_text("...", px)).max(0.0);
    let mut end = 0;
    let mut width = 0.0;
    for (offset, ch) in text.char_indices() {
        let advance = ui.measure_text(&text[offset..offset + ch.len_utf8()], px);
        if width + advance > budget {
            break;
        }
        width += advance;
        end = offset + ch.len_utf8();
    }
    (&text[..end], true)
}

/// Compact notification/status region. It deliberately has one content well
/// and no nested card or divider, matching the sparse HUD grammar.
fn draw_status_strip(ui: &mut UiBuilder, palette: &Palette, state: &HudState, rect: [f32; 4]) {
    let [x, y, w, h] = rect;
    let mut backing = palette.bg_panel;
    backing[3] = 220;
    ui.rect(x, y, w, h, backing);

    let primary = if state.fine_text.is_empty() {
        "NO SIGNAL"
    } else {
        state.fine_text.as_str()
    };
    let px = 1.35;
    let text_y = y + (h - 14.0).max(0.0) * 0.5;
    let primary_tint = if state.connection == ConnectionHud::Live {
        palette.ink_dim
    } else {
        palette.danger
    };
    let area_w = ui.measure_text(&state.area_label, px);
    let show_area = !state.area_label.is_empty() && area_w + ui.measure_text("...", px) + 24.0 <= w;
    let primary_room = (w - 16.0 - if show_area { area_w + 8.0 } else { 0.0 }).max(0.0);
    let (primary, clipped) = clip_status_text(ui, primary, px, primary_room);
    let primary_end = ui.text(primary, x + 8.0, text_y, px, primary_tint);
    if clipped {
        ui.text("...", primary_end, text_y, px, primary_tint);
    }
    if show_area {
        ui.text(
            &state.area_label,
            x + w - area_w - 8.0,
            text_y,
            px,
            palette.ink,
        );
    }
}

/// Build the connected HUD. Persistent panes draw into their live,
/// manager-owned content rects; `layout::compute` is never consulted here.
/// The host sets UI input enabled only when `frame.captured` is false before
/// calling this function, so an unlocked pane cannot also activate HUD content.
pub fn build_hud(
    ui: &mut UiBuilder,
    icons: &Icons,
    frame: &mut HudFrame,
    manager: &successor_engine_render::window::WindowManager,
    w: u32,
    h: u32,
    out: &mut Vec<HudAction>,
) {
    let sw = w as f32;
    let sh = h as f32;
    let pal = frame.palette;
    let st = frame.state;
    let player_rect = hud_content_rect(manager, PLAYER_STATUS_ID);
    let target_rect = hud_content_rect(manager, TARGET_STATUS_ID);
    let command_rect = hud_content_rect(manager, COMMAND_BAR_ID);
    let chat_rect = hud_content_rect(manager, CHAT_CONSOLE_ID);
    let queue_rect = hud_content_rect(manager, ABILITY_QUEUE_ID);
    let strip_rect = hud_content_rect(manager, STATUS_STRIP_ID);
    let radar_rect = hud_content_rect(manager, GROUND_RADAR_ID);

    if let Some(rect) = player_rect {
        plate::draw_status_plate(ui, &pal, st, rect, out);
    }
    if let (Some(target), Some(rect)) = (&st.target, target_rect) {
        plate::draw_target_plate(ui, &pal, target, rect);
    }
    if let Some(rect) = queue_rect {
        plate::draw_queue(ui, &pal, st, rect, out);
    }
    if let Some(rect) = strip_rect {
        draw_status_strip(ui, &pal, st, rect);
    }
    if let Some(rect) = radar_rect {
        radar::draw_radar(ui, &pal, st, rect, frame.captured, out);
    }
    if let (Some(rect), Some((chat_client, chat_input))) = (chat_rect, frame.chat.as_mut()) {
        crate::game::chat_ui::draw_chat_pane(
            ui,
            chat_client,
            chat_input,
            rect[0],
            rect[1],
            rect[2],
            rect[3],
        );
    }

    // Group roster and weapon readout are managed panes of the same grammar as
    // the player plate: each paints nothing when it has no content, so an
    // unarmed solo player sees one tight status plate and no empty furniture.
    if let Some(rect) = hud_content_rect(manager, WEAPON_STATUS_ID) {
        plate::draw_weapon_plate(ui, &pal, st, rect);
    }
    let group_rail = hud_content_rect(manager, GROUP_ROSTER_ID)
        .unwrap_or_else(|| layout::compute(sw, sh).group);
    plate::draw_group(ui, &pal, st, sw, group_rail, out);

    // Interact chip and toasts stay tied to the live chat pane, so they follow
    // a player-moved console without becoming persistent surfaces themselves.
    let chat_anchor = chat_rect.unwrap_or([sw * 0.5, sh - 32.0, 0.0, 0.0]);
    let chip_x = chat_anchor[0] + chat_anchor[2] * 0.5;
    let chip_y = chat_anchor[1] - 26.0;
    if let Some(chip) = &st.interact {
        plate::draw_interact_chip(ui, &pal, chip, chip_x, chip_y);
    }
    plate::draw_toasts(ui, &pal, st, frame.now_ms, chip_x, chip_y - 24.0);

    // First-steps guidance follows the live player plate rather than a stale
    // default origin.
    let player_anchor = player_rect.unwrap_or([layout::MARGIN, 0.0, 0.0, 0.0]);
    plate::draw_first_steps(
        ui,
        &pal,
        st,
        player_anchor[0] + layout::MARGIN,
        player_anchor[1] + player_anchor[3] + 24.0,
    );

    // No fixed screen-centre crosshair. The original client has no such
    // reticle on the ground HUD: aim lives on the pointer, which switches to
    // `ui_cursor_attack` over a valid target. See `engine_render::cursor`.

    // The fixed Successor launcher rail is not a persistent pane. The command
    // bar itself, however, is manager-owned and receives its live rect above.
    let dock_h = (sh * 0.5).min(360.0);
    let dock = [
        sw - layout::MARGIN - layout::DOCK_BTN,
        (sh - dock_h) * 0.5,
        layout::DOCK_BTN,
        dock_h,
    ];
    toolbar::draw_dock(ui, icons, &pal, frame.toolbar, dock, frame.captured, out);
    if let Some(rect) = command_rect {
        toolbar::draw_toolbar(
            ui,
            icons,
            &pal,
            frame.toolbar,
            st,
            rect,
            frame.captured,
            frame.right_pressed,
            frame.now_ms,
            out,
        );
    }

    // Unlocked panes get one hover-revealed functional outline. At rest this
    // loop emits nothing, preserving the original HUD's chromeless appearance.
    for surface in HUD_SURFACES {
        draw_hud_layout_affordance(ui, manager, surface.id, &pal);
    }

    // Death / clone overlay draws over everything but keeps chat usable
    // (backdrop is visual-only; only the panel takes clicks).
    plate::draw_death_overlay(ui, &pal, st, sw, sh, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(role: &str) -> successor_client_proto::packets::GameActorSnapshot {
        successor_client_proto::packets::GameActorSnapshot {
            role: Some(role.to_string()),
            life_state: "alive".to_string(),
            ..Default::default()
        }
    }

    /// Owner ruling 2026-08-04. Each arm is a distinct in-world read, so they
    /// are asserted individually rather than as one table.
    #[test]
    fn relations_follow_the_owner_ruling() {
        // An NPC that does not fight, and anything dead, is not a threat read.
        assert_eq!(relation_for(&actor("profession_trainer"), "me", None), RelationHud::Social);
        let mut corpse = actor("skirmisher");
        corpse.will_auto_aggro = Some(true);
        corpse.life_state = "dead".to_string();
        assert_eq!(relation_for(&corpse, "me", None), RelationHud::Social);

        // A passive attackable is yellow until something starts a fight.
        let mut passive = actor("creature");
        passive.will_auto_aggro = Some(false);
        assert_eq!(relation_for(&passive, "me", None), RelationHud::Attackable);
        passive.in_combat = Some(true);
        assert_eq!(
            relation_for(&passive, "me", None),
            RelationHud::Hostile,
            "a provoked passive must escalate to the hostile read"
        );

        // Anything that opens on sight is hostile from the start.
        let mut aggressive = actor("skirmisher_assault");
        aggressive.will_auto_aggro = Some(true);
        assert_eq!(relation_for(&aggressive, "me", None), RelationHud::Hostile);
    }

    #[test]
    fn player_standing_reads_pvp_then_organization() {
        let neutral = actor("player");
        assert_eq!(relation_for(&neutral, "me", None), RelationHud::Player);

        let mut ally = actor("player");
        ally.player_organization_id = Some("guild-a".to_string());
        assert_eq!(relation_for(&ally, "me", Some("guild-a")), RelationHud::Allied);
        assert_eq!(
            relation_for(&ally, "me", Some("guild-b")),
            RelationHud::Player,
            "a different organization is not an ally"
        );
        assert_eq!(
            relation_for(&ally, "me", None),
            RelationHud::Player,
            "an unaffiliated viewer has no allies"
        );

        // PVP outranks shared colours: an open enemy reads red even in-guild.
        let mut enemy = ally.clone();
        enemy.pvp_status = Some("hostile".to_string());
        assert_eq!(relation_for(&enemy, "me", Some("guild-a")), RelationHud::Hostile);
    }

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
    fn ground_radar_registration_uses_the_managed_layout_frame() {
        let mut manager = successor_engine_render::window::WindowManager::new();
        register_ground_radar_at(&mut manager, None, (1024.0, 768.0));
        let layout = layout::compute(1024.0, 768.0);
        assert_eq!(manager.rect(GROUND_RADAR_ID), Some(layout.radar));
        // HUD panes are chromeless, so the pane owns its whole rect and the
        // scope no longer sits inside workspace rails.
        assert!(!manager.has_chrome(GROUND_RADAR_ID));
        assert!(!manager.is_interactive(GROUND_RADAR_ID));
        assert_eq!(manager.content_rect(GROUND_RADAR_ID), Some(layout.radar));
        assert!(manager.is_open(GROUND_RADAR_ID));
        assert_eq!(
            manager.icon_rect(GROUND_RADAR_ID),
            Some([
                GROUND_RADAR_ICON_SLOT.0,
                GROUND_RADAR_ICON_SLOT.1,
                successor_engine_render::window::ICON_SLOT,
                successor_engine_render::window::ICON_SLOT,
            ])
        );
        assert!(manager.iconify(GROUND_RADAR_ID));
        assert!(manager.is_iconified(GROUND_RADAR_ID));
    }

    const TEST_ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };

    #[test]
    fn every_hud_registration_default_matches_layout_compute() {
        for viewport in [
            (800.0, 600.0),
            (1024.0, 768.0),
            (1280.0, 1024.0),
            (1600.0, 1200.0),
        ] {
            let mut manager = successor_engine_render::window::WindowManager::new();
            register_hud_surfaces_with_at(&mut manager, viewport, |_| None);
            let mut ui = UiBuilder::new(TEST_ATLAS);
            ui.set_input(0.0, 0.0, false);
            ui.begin(viewport.0 as u32, viewport.1 as u32);
            manager.update(&ui, viewport.0 as u32, viewport.1 as u32);
            let defaults = layout::compute(viewport.0, viewport.1);
            for surface in HUD_SURFACES {
                let expected = surface.default_rect(defaults);
                assert_eq!(
                    manager.rect(surface.id),
                    Some(expected),
                    "{} default drifted at {}x{}",
                    surface.id,
                    viewport.0,
                    viewport.1
                );
                assert_eq!(manager.content_rect(surface.id), Some(expected));
                assert_eq!(
                    manager.is_open(surface.id),
                    surface.opens_on_first_run(),
                    "{} first-run visibility drifted",
                    surface.id
                );
                assert!(!manager.has_chrome(surface.id));
                assert!(!manager.is_interactive(surface.id));
            }
        }
    }

    #[test]
    fn locked_hud_needs_layout_edit_before_manager_captures_or_moves() {
        let mut manager = successor_engine_render::window::WindowManager::new();
        register_hud_surfaces_with_at(&mut manager, (1024.0, 768.0), |_| None);
        let mut ui = UiBuilder::new(TEST_ATLAS);
        let original = manager.rect(PLAYER_STATUS_ID).unwrap();

        // Normal play: clicking the status pane is gameplay-transparent.
        ui.set_input(100.0, 30.0, false);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        ui.set_input(100.0, 30.0, true);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        assert!(!manager.pointer_captured());
        assert_eq!(manager.rect(PLAYER_STATUS_ID), Some(original));

        // A right-click context toggle unlocks exactly this pane. The manager
        // then owns its body drag and every edge/corner resize gesture.
        assert_eq!(
            toggle_hud_surface_lock_at(&mut manager, 100.0, 30.0),
            Some(PLAYER_STATUS_ID)
        );
        assert!(manager.is_interactive(PLAYER_STATUS_ID));
        ui.set_input(100.0, 30.0, false);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        ui.set_input(100.0, 30.0, true);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        assert!(manager.pointer_captured());
        ui.set_input(140.0, 60.0, true);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        let moved = manager.rect(PLAYER_STATUS_ID).unwrap();
        assert_eq!(moved[0], original[0] + 40.0);
        assert_eq!(moved[1], original[1] + 30.0);
        ui.set_input(140.0, 60.0, false);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);

        let resize_x = moved[0] + moved[2] - 2.0;
        let resize_y = moved[1] + moved[3] - 2.0;
        ui.set_input(resize_x, resize_y, true);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        ui.set_input(resize_x + 36.0, resize_y + 24.0, true);
        ui.begin(1024, 768);
        manager.update(&ui, 1024, 768);
        let resized = manager.rect(PLAYER_STATUS_ID).unwrap();
        assert_eq!(resized[2], moved[2] + 36.0);
        assert_eq!(resized[3], moved[3] + 24.0);
    }

    #[test]
    fn hud_workspace_state_round_trip_keeps_geometry_open_order_and_lock() {
        let mut previous = successor_engine_render::window::WindowManager::new();
        register_hud_surfaces_with_at(&mut previous, (1280.0, 1024.0), |_| None);
        assert!(set_hud_surface_locked(
            &mut previous,
            PLAYER_STATUS_ID,
            false
        ));
        assert!(previous.set_rect(PLAYER_STATUS_ID, [90.0, 70.0, 360.0, 220.0]));
        previous.close(TARGET_STATUS_ID);
        previous.open(COMMAND_BAR_ID);

        let mut restored = successor_engine_render::window::WindowManager::new();
        register_hud_surfaces_with_at(&mut restored, (1280.0, 1024.0), |_| None);
        restored.restore_workspace_state_from(&previous);

        assert_eq!(
            restored.rect(PLAYER_STATUS_ID),
            Some([90.0, 70.0, 360.0, 220.0])
        );
        assert!(restored.is_interactive(PLAYER_STATUS_ID));
        assert!(!restored.is_open(TARGET_STATUS_ID));
        let order = restored.z_order();
        assert_eq!(
            restored.window_id(*order.last().expect("command bar is open")),
            COMMAND_BAR_ID
        );
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
        // Oxide's original rust accent could not clear 4.5:1 on any warm dark
        // pane, so it was lifted rather than leaving one theme unreadable.
        assert_eq!(palette(3).accent, [0xe0, 0x67, 0x3a, 255]);
        assert_eq!(theme_index_for_id("amber"), 2);
        assert_eq!(theme_index_for_id("unknown"), 0);
    }

    /// Every theme has to be readable, and no theme may paint a pane that
    /// reads as a hole in the world rather than a surface.
    #[test]
    fn every_theme_is_readable_and_tinted() {
        fn luminance(rgba: [u8; 4]) -> f32 {
            let channel = |value: u8| {
                let c = value as f32 / 255.0;
                if c <= 0.04045 {
                    c / 12.92
                } else {
                    ((c + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2])
        }
        fn contrast(a: [u8; 4], b: [u8; 4]) -> f32 {
            let (la, lb) = (luminance(a), luminance(b));
            (la.max(lb) + 0.05) / (la.min(lb) + 0.05)
        }
        for (index, theme) in THEMES.iter().enumerate() {
            let id = THEME_IDS[index];
            // A pane tone this dark is a black slab, not a translucent tint.
            let brightest = theme.bg_panel[..3].iter().copied().max().unwrap_or(0);
            assert!(
                brightest > 40,
                "{id} panel {:?} is a near-black slab",
                &theme.bg_panel[..3]
            );
            // WCAG AA at small-text size, which is the size this UI uses.
            for (label, ink) in [
                ("ink", theme.ink),
                ("ink_dim", theme.ink_dim),
                ("accent", theme.accent),
            ] {
                let on_panel = contrast(ink, theme.bg_panel);
                let on_cell = contrast(ink, theme.bg_cell);
                assert!(
                    on_panel >= 4.5,
                    "{id} {label} is {on_panel:.2}:1 on its panel"
                );
                assert!(on_cell >= 4.5, "{id} {label} is {on_cell:.2}:1 on its cell");
            }
        }
    }

    #[test]
    fn projection_from_empty_store_reads_no_signal() {
        let store = crate::game::authority::AuthorityStore::new();
        let mut st = HudState::default();
        st.project(&store, "me", None);
        assert_eq!(st.connection, ConnectionHud::NoSignal);
        assert_eq!(st.fine_text, "NO SIGNAL");
        assert_eq!(st.health_text, "--");
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
