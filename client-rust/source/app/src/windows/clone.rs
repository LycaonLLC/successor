//! CLONING — clone facility bind / respawn UI.

use super::{WindowAction, ACCENT, DIM, SLOT, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug, Default)]
pub struct CloneFacility {
    pub id: String,
    pub name: String,
    pub zone: String,
    pub is_active_bind: bool,
}

#[derive(Clone, Debug, Default)]
pub struct CloneModel {
    pub facilities: Vec<CloneFacility>,
    pub selected_facility_id: Option<String>,
    pub backup_present: bool,
    pub backup_cost: u32,
    pub credits_vault: u32,
    pub credits_wallet: u32,
}

impl CloneModel {
    pub fn sample() -> Self {
        Self {
            facilities: vec![
                CloneFacility {
                    id: "dustgate-alpha".into(),
                    name: "DUSTGATE ALPHA".into(),
                    zone: "DESERT".into(),
                    is_active_bind: true,
                },
                CloneFacility {
                    id: "sandsea-basket".into(),
                    name: "SANDSEA BASKET".into(),
                    zone: "SANDSEA".into(),
                    is_active_bind: false,
                },
                CloneFacility {
                    id: "outpost-theta".into(),
                    name: "OUTPOST THETA".into(),
                    zone: "OUTPOST".into(),
                    is_active_bind: false,
                },
            ],
            selected_facility_id: Some("dustgate-alpha".into()),
            backup_present: true,
            backup_cost: 1000,
            credits_vault: 1250,
            credits_wallet: 450,
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &CloneModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header / Facility Info
    ui.text("CLONE TERMINAL", x, y, 2.2, ACCENT);

    // Draw clone icon if available
    if let Some((col, row)) = icons.cell("clone") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    // Backup info
    let status_y = y + 26.0;
    if model.backup_present {
        ui.text("BACKUP ON FILE", x, status_y, 1.8, [100, 220, 120, 255]);
    } else {
        ui.text("NO BACKUP ON FILE", x, status_y, 1.8, [220, 100, 100, 255]);
    }

    // Balances
    let bal_y = status_y + 18.0;
    ui.text(
        &format!(
            "VAULT: {} CR  WALLET: {} CR",
            model.credits_vault, model.credits_wallet
        ),
        x,
        bal_y,
        1.6,
        DIM,
    );

    // List of facilities
    let list_title_y = bal_y + 24.0;
    ui.text("SELECT CLONE FACILITY", x, list_title_y, 1.8, TEXT);

    let start_y = list_title_y + 20.0;
    let row_h = 32.0;
    let list_h = h - (start_y - y) - 46.0; // leave room for action buttons at the bottom
    let max_rows = (list_h / row_h).floor() as usize;

    for (i, fac) in model.facilities.iter().take(max_rows).enumerate() {
        let ry = start_y + i as f32 * row_h;
        let is_selected = model.selected_facility_id.as_ref() == Some(&fac.id);

        let bg_color = if is_selected { [46, 62, 86, 235] } else { SLOT };
        ui.rect(x, ry, w, row_h - 4.0, bg_color);

        // Name and zone
        ui.text(&fac.name, x + 8.0, ry + 6.0, 1.8, TEXT);
        ui.text(&fac.zone, x + w - 120.0, ry + 6.0, 1.6, DIM);

        if fac.is_active_bind {
            ui.text("BIND", x + w - 50.0, ry + 6.0, 1.6, ACCENT);
        }

        // Interaction
        let resp = ui.interact(x, ry, w, row_h - 4.0);
        if resp.clicked {
            out.push(WindowAction::Button(format!("clone:select:{}", fac.id)));
        }
    }

    // Buttons at the bottom
    let btn_y = y + h - 30.0;
    let btn_w = (w - 10.0) / 2.0;

    let mut bind_style = ButtonStyle::default();
    let has_selection = model.selected_facility_id.is_some();
    if !has_selection {
        bind_style.text = DIM;
    }

    // BIND button
    if ui.button(x, btn_y, btn_w, 26.0, "BIND", bind_style) && has_selection {
        if let Some(sel_id) = &model.selected_facility_id {
            out.push(WindowAction::Button(format!("clone:bind:{}", sel_id)));
        }
    }

    // RESPAWN button
    let respawn_style = ButtonStyle::default();
    if ui.button(
        x + btn_w + 10.0,
        btn_y,
        btn_w,
        26.0,
        "RESPAWN",
        respawn_style,
    ) {
        out.push(WindowAction::Button("clone:respawn".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clone_respawn_button_emits_action() {
        let icons = Icons::load();
        let model = CloneModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // rect = [10.0, 10.0, 300.0, 400.0]
        // btn_y = 10.0 + 400.0 - 30.0 = 380.0
        // btn_w = (300.0 - 10.0) / 2.0 = 145.0
        // RESPAWN button x = 10.0 + 145.0 + 10.0 = 165.0, y = 380.0, size = 145.0 x 26.0
        let bx = 165.0 + 50.0;
        let by = 380.0 + 10.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(
            &mut ui,
            [10.0, 10.0, 300.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(
            &mut ui,
            [10.0, 10.0, 300.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        assert!(
            out.contains(&WindowAction::Button("clone:respawn".into())),
            "Expected clone:respawn action, got {:?}",
            out
        );
    }
}
