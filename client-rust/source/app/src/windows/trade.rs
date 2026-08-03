//! TRADE — Secure two-party item exchange content view.
use super::{WindowAction, ACCENT, DIM, SLOT, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug)]
pub struct ItemStack {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub qty: u32,
}

#[derive(Clone, Debug, Default)]
pub struct TradeModel {
    pub my_inventory: Vec<ItemStack>,
    pub my_offer: Vec<ItemStack>,
    pub their_offer: Vec<ItemStack>,
    pub my_accepted: bool,
    pub their_accepted: bool,
}

impl TradeModel {
    pub fn sample() -> Self {
        Self {
            my_inventory: vec![
                ItemStack {
                    id: 10,
                    name: "MEDKIT".into(),
                    kind: "item-medical".into(),
                    qty: 2,
                },
                ItemStack {
                    id: 11,
                    name: "SCRAP ALLOY".into(),
                    kind: "item-resource".into(),
                    qty: 100,
                },
            ],
            my_offer: vec![ItemStack {
                id: 12,
                name: "SLUGTHROWER".into(),
                kind: "item-weapon".into(),
                qty: 1,
            }],
            their_offer: vec![ItemStack {
                id: 20,
                name: "RIFLE AMMO".into(),
                kind: "item-ammo".into(),
                qty: 120,
            }],
            my_accepted: false,
            their_accepted: true,
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &TradeModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    let col_y = y + 8.0;
    let col_h = h - 60.0; // bottom space for Accept + Lock states
    let col_w = (w - 24.0) / 2.0;

    let col_my_x = x + 8.0;
    let col_their_x = x + 16.0 + col_w;

    let section_h = (col_h - 20.0) / 2.0;

    // ── Left Column: Inventory (Can Offer) ──
    ui.text("CAN OFFER", col_my_x, col_y, 1.8, DIM);
    let mut iy = col_y + 18.0;
    if model.my_inventory.is_empty() {
        ui.text("NO ITEMS", col_my_x + 4.0, iy, 1.6, DIM);
    } else {
        for item in &model.my_inventory {
            if iy + 30.0 > col_y + section_h {
                break;
            }
            ui.rect(col_my_x, iy, col_w, 28.0, SLOT);

            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, col_my_x + 4.0, iy + 4.0, 20.0, 20.0, TEXT);
            }

            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, col_my_x + 28.0, iy + 6.0, 1.6, TEXT);

            // OFFER button
            let btn_w = 46.0;
            let btn_x = col_my_x + col_w - btn_w - 4.0;
            let btn_y = iy + 3.0;
            if ui.button(btn_x, btn_y, btn_w, 22.0, "OFFER", ButtonStyle::default()) {
                out.push(WindowAction::TradeOffer(item.id));
            }

            iy += 32.0;
        }
    }

    // ── Left Column: Your Offer ──
    let offer_y = col_y + section_h + 10.0;
    ui.text("YOUR OFFER", col_my_x, offer_y, 1.8, DIM);
    let mut oy = offer_y + 18.0;
    if model.my_offer.is_empty() {
        ui.text("NO OFFER", col_my_x + 4.0, oy, 1.6, DIM);
    } else {
        for item in &model.my_offer {
            if oy + 30.0 > col_y + col_h {
                break;
            }
            ui.rect(col_my_x, oy, col_w, 28.0, SLOT);

            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, col_my_x + 4.0, oy + 4.0, 20.0, 20.0, TEXT);
            }

            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, col_my_x + 28.0, oy + 6.0, 1.6, TEXT);

            oy += 32.0;
        }
    }

    // ── Right Column: Their Offer ──
    ui.text("THEIR OFFER", col_their_x, col_y, 1.8, DIM);
    let mut ty = col_y + 18.0;
    if model.their_offer.is_empty() {
        ui.text("NO OFFER", col_their_x + 4.0, ty, 1.6, DIM);
    } else {
        for item in &model.their_offer {
            if ty + 30.0 > col_y + col_h {
                break;
            }
            ui.rect(col_their_x, ty, col_w, 28.0, SLOT);

            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, col_their_x + 4.0, ty + 4.0, 20.0, 20.0, TEXT);
            }

            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, col_their_x + 28.0, ty + 6.0, 1.6, TEXT);

            ty += 32.0;
        }
    }

    // ── Bottom Area: Lock States & Accept Button ──
    let bottom_y = y + h - 50.0;

    // Lock states indicators
    let my_status = if model.my_accepted {
        "YOU: LOCKED"
    } else {
        "YOU: UNLOCKED"
    };
    let my_color = if model.my_accepted { ACCENT } else { DIM };
    ui.text(my_status, x + 8.0, bottom_y + 8.0, 1.8, my_color);

    let their_status = if model.their_accepted {
        "PARTNER: LOCKED"
    } else {
        "PARTNER: UNLOCKED"
    };
    let their_color = if model.their_accepted { ACCENT } else { DIM };
    ui.text(their_status, x + 8.0, bottom_y + 24.0, 1.8, their_color);

    // ACCEPT button
    let btn_w = 120.0;
    let btn_h = 32.0;
    let btn_x = x + w - btn_w - 8.0;
    let btn_y = bottom_y + 4.0;

    let mut accept_style = ButtonStyle::default();
    if model.my_accepted {
        accept_style.fill = [40, 140, 60, 210]; // green when accepted
    } else {
        accept_style.fill = [180, 130, 40, 210]; // warm accent-like color
    }

    let accept_label = if model.my_accepted {
        "ACCEPTED"
    } else {
        "ACCEPT"
    };
    if ui.button(btn_x, btn_y, btn_w, btn_h, accept_label, accept_style) {
        out.push(WindowAction::TradeAccept);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trade_offer_button_emits_action() {
        let icons = Icons::load();
        let model = TradeModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 500.0, 400.0]
        // col_w = (500 - 24) / 2 = 238.
        // col_my_x = 100 + 8 = 108.
        // col_y = 100 + 8 = 108.
        // First item iy = 108 + 18 = 126.
        // Button "OFFER" is at btn_x = col_my_x + col_w - btn_w - 4 = 108 + 238 - 46 - 4 = 296.
        // btn_y = 126 + 3 = 129.
        // Center is roughly 319, 140.
        let bx = 319.0;
        let by = 140.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(
            &mut ui,
            [100.0, 100.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(
            &mut ui,
            [100.0, 100.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        assert_eq!(out, vec![WindowAction::TradeOffer(10)]);
    }

    #[test]
    fn trade_accept_button_emits_action() {
        let icons = Icons::load();
        let model = TradeModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 500.0, 400.0]
        // bottom_y = 100 + 400 - 50 = 450.
        // btn_w = 120.
        // btn_x = 100 + 500 - 120 - 8 = 472.
        // btn_y = 450 + 4 = 454.
        // Center is roughly 532, 470.
        let bx = 532.0;
        let by = 470.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(
            &mut ui,
            [100.0, 100.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(
            &mut ui,
            [100.0, 100.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        assert_eq!(out, vec![WindowAction::TradeAccept]);
    }
}
