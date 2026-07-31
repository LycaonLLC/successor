//! Baked-icon atlas loader + a sample HUD built with the engine's immediate-mode
//! `UiBuilder`. The atlas (`assets/ui/icons.*`, produced by
//! `tools/bake-assets`) is embedded and expanded to RGBA8 (coverage → alpha)
//! for `Renderer::set_ui_atlas`.

use successor_engine_render::ui::{AtlasMeta, ButtonStyle, TextField, UiBuilder};

const ICONS_A8: &[u8] = include_bytes!("../assets/ui/icons.a8");
const ICONS_JSON: &str = include_str!("../assets/ui/icons.json");

/// Parsed icon atlas: metadata, the RGBA8 texture bytes, and the id → cell map.
pub struct Icons {
    pub meta: AtlasMeta,
    pub rgba: Vec<u8>,
    map: Vec<(String, (u32, u32))>,
}

impl Icons {
    pub fn load() -> Self {
        let v: serde_json::Value = serde_json::from_str(ICONS_JSON).expect("icons.json parse");
        let u = |k: &str| v[k].as_u64().unwrap_or(0) as u32;
        let meta = AtlasMeta {
            cell: u("cell"),
            cols: u("cols"),
            width: u("width"),
            height: u("height"),
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
        // Expand single-channel coverage to RGBA8 (white with coverage in alpha).
        let mut rgba = vec![0u8; ICONS_A8.len() * 4];
        for (i, &a) in ICONS_A8.iter().enumerate() {
            rgba[i * 4] = 255;
            rgba[i * 4 + 1] = 255;
            rgba[i * 4 + 2] = 255;
            rgba[i * 4 + 3] = a;
        }
        Self { meta, rgba, map }
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

/// Colors of the PS2-era chrome (dark translucent panels, warm edges).
const PANEL: [u8; 4] = [14, 18, 26, 220];
const EDGE: [u8; 4] = [120, 150, 180, 255];
const TEXT: [u8; 4] = [210, 222, 236, 255];
const ICON: [u8; 4] = [206, 224, 242, 255];
const ACCENT: [u8; 4] = [240, 196, 96, 255];

/// Live values the HUD panels bind to. Populated from the authority store in
/// the connected client; the demo animates it.
#[derive(Clone, Debug)]
pub struct HudState {
    pub name: String,
    pub hp: f32,
    pub hp_max: f32,
    pub ap: f32,
    pub ap_max: f32,
    pub shield: f32,
    pub shield_max: f32,
    pub sector: String,
    pub coord: (i32, i32),
    pub target: Option<(String, f32)>, // name, hp fraction 0..1
}

impl Default for HudState {
    fn default() -> Self {
        Self {
            name: "DRIFTER".into(),
            hp: 100.0,
            hp_max: 100.0,
            ap: 84.0,
            ap_max: 120.0,
            shield: 60.0,
            shield_max: 100.0,
            sector: "SECTOR 7".into(),
            coord: (512, 513),
            target: None,
        }
    }
}

/// A labeled filled bar: track + proportional fill + `label` overlay.
#[allow(clippy::too_many_arguments)]
fn bar(ui: &mut UiBuilder, x: f32, y: f32, w: f32, h: f32, frac: f32, fill: [u8; 4], label: &str) {
    ui.rect(x, y, w, h, [26, 32, 42, 220]);
    let f = frac.clamp(0.0, 1.0);
    if f > 0.0 {
        ui.rect(x, y, w * f, h, fill);
    }
    ui.border(x, y, w, h, 1.0, [70, 90, 110, 255]);
    ui.text(label, x + 4.0, y + (h - 7.0 * 1.6) * 0.5, 1.6, TEXT);
}

/// Build the HUD: vitals panel (name + HP/AP/shield bars), minimap frame with
/// sector + coordinates, a target frame (top-center, when a target is set), a
/// focusable search field, and the bottom action bar of icon buttons. Returns
/// the id of any action-bar button clicked this frame (input routing).
pub fn build_hud<'a>(
    ui: &mut UiBuilder,
    icons: &Icons,
    state: &HudState,
    search: &mut TextField,
    captured: bool,
    w: u32,
    h: u32,
) -> Option<&'a str> {
    let sw = w as f32;
    let sh = h as f32;
    let mut clicked: Option<&'a str> = None;

    // ── Top-left vitals panel ────────────────────────────────────────────
    ui.panel(16.0, 16.0, 320.0, 118.0, PANEL, EDGE);
    ui.text(&state.name, 30.0, 26.0, 2.6, ACCENT);
    let bx = 30.0;
    let bw = 292.0;
    bar(
        ui,
        bx,
        52.0,
        bw,
        18.0,
        state.hp / state.hp_max.max(1.0),
        [196, 72, 68, 235],
        &format!("HP {}/{}", state.hp as i32, state.hp_max as i32),
    );
    bar(
        ui,
        bx,
        74.0,
        bw,
        18.0,
        state.ap / state.ap_max.max(1.0),
        [86, 156, 210, 235],
        &format!("AP {}/{}", state.ap as i32, state.ap_max as i32),
    );
    bar(
        ui,
        bx,
        96.0,
        bw,
        18.0,
        state.shield / state.shield_max.max(1.0),
        [120, 200, 150, 235],
        &format!("SHIELD {}", state.shield as i32),
    );

    // ── Minimap frame (top-right) with sector + coordinates ──────────────
    let mm = 180.0;
    let mmx = sw - mm - 16.0;
    ui.panel(mmx, 16.0, mm, mm, PANEL, EDGE);
    // Player blip at center + a couple of contacts.
    ui.rect(
        mmx + mm * 0.5 - 3.0,
        16.0 + mm * 0.5 - 3.0,
        6.0,
        6.0,
        ACCENT,
    );
    ui.rect(
        mmx + mm * 0.32,
        16.0 + mm * 0.4,
        4.0,
        4.0,
        [196, 72, 68, 255],
    );
    ui.rect(
        mmx + mm * 0.66,
        16.0 + mm * 0.62,
        4.0,
        4.0,
        [120, 200, 150, 255],
    );
    ui.text(&state.sector, mmx + 6.0, 16.0 + mm + 6.0, 2.0, TEXT);
    ui.text(
        &format!("{} {}", state.coord.0, state.coord.1),
        mmx + 6.0,
        16.0 + mm + 30.0,
        2.0,
        ACCENT,
    );

    // ── Target frame (top-center) ────────────────────────────────────────
    if let Some((name, frac)) = &state.target {
        let tw = 300.0;
        let tx = (sw - tw) * 0.5;
        ui.panel(tx, 20.0, tw, 56.0, PANEL, [196, 96, 90, 255]);
        ui.text(name, tx + 10.0, 28.0, 2.4, TEXT);
        bar(
            ui,
            tx + 10.0,
            52.0,
            tw - 20.0,
            16.0,
            *frac,
            [196, 72, 68, 235],
            "",
        );
    }

    // ── Search / command field (focusable, typed input) ──────────────────
    ui.text("SEARCH", 20.0, sh - 148.0, 2.0, TEXT);
    ui.text_field(search, 20.0, sh - 128.0, 320.0, 30.0, 2.2, true);

    // ── Bottom action bar (icon buttons) ─────────────────────────────────
    const BAR: [&str; 12] = [
        "inventory",
        "character",
        "skills",
        "crosshair",
        "reload",
        "kneel",
        "converse",
        "craft",
        "trade",
        "survey",
        "datapad",
        "options",
    ];
    let n = BAR.len() as f32;
    let slot = 56.0;
    let pad = 8.0;
    let bar_w = n * slot + (n + 1.0) * pad;
    let bar_h = slot + 2.0 * pad;
    let bx = (sw - bar_w) * 0.5;
    let by = sh - bar_h - 20.0;
    ui.panel(bx, by, bar_w, bar_h, PANEL, EDGE);
    let style = ButtonStyle {
        text: ICON,
        ..ButtonStyle::default()
    };
    for (i, id) in BAR.iter().enumerate() {
        let cx = bx + pad + i as f32 * (slot + pad);
        let cy = by + pad;
        if let Some((col, row)) = icons.cell(id) {
            if ui.icon_button(col, row, cx, cy, slot, style) && !captured {
                clicked = Some(*id);
            }
        }
        let key = format!("{}", (i + 1) % 10);
        ui.text(&key, cx + 4.0, cy + 4.0, 1.6, ACCENT);
    }
    clicked
}

/// Registered windows: (id, title, icon id). Bounds cascade at registration.
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
    ("pa", "ARMOR", "item-gear"),
    ("splice", "SPLICE", "splice"),
    ("macros", "MACROS", "macro"),
    ("actions", "ACTIONS", "actions"),
    ("bug-report", "REPORT", "bug-report"),
];
