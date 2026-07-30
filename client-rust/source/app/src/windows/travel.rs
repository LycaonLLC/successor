//! TRAVEL — Travel terminal destination selector.
use super::{WindowAction, ACCENT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug, Default)]
pub struct Destination {
    pub id: String,
    pub name: String,
    pub cost: u32,
    pub distance: u32,
}

#[derive(Clone, Debug, Default)]
pub struct TravelModel {
    pub destinations: Vec<Destination>,
}

impl TravelModel {
    pub fn sample() -> Self {
        Self {
            destinations: vec![
                Destination { id: "dustgate".into(), name: "DUSTGATE OUTPOST".into(), cost: 50, distance: 120 },
                Destination { id: "outpost_9".into(), name: "OUTPOST 9".into(), cost: 120, distance: 340 },
                Destination { id: "nexus_prime".into(), name: "NEXUS PRIME".into(), cost: 350, distance: 980 },
                Destination { id: "wreckage_site".into(), name: "WRECKAGE SITE".into(), cost: 80, distance: 200 },
            ],
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &TravelModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header
    if let Some((col, row)) = icons.cell("travel") {
        ui.icon(col, row, x + 10.0, y + 10.0, 24.0, 24.0, ACCENT);
    }
    ui.text("TRAVEL TERMINAL", x + 40.0, y + 14.0, 2.0, ACCENT);
    ui.rect(x + 10.0, y + 44.0, w - 20.0, 1.0, SLOT_EDGE);

    // List of destinations
    let mut cur_y = y + 54.0;
    let row_h = 40.0;
    let gap = 6.0;
    let button_style = ButtonStyle::default();

    for dest in &model.destinations {
        if cur_y + row_h > y + h - 10.0 {
            break;
        }

        let resp = ui.interact(x + 10.0, cur_y, w - 20.0, row_h);
        let fill = if resp.held {
            button_style.active
        } else if resp.hovered {
            button_style.hover
        } else {
            button_style.fill
        };
        ui.rect(x + 10.0, cur_y, w - 20.0, row_h, fill);
        ui.border(x + 10.0, cur_y, w - 20.0, row_h, 1.0, button_style.edge);

        // Text inside the row:
        // Left: Name
        ui.text(&dest.name.to_uppercase(), x + 20.0, cur_y + 12.0, 1.8, TEXT);

        // Right: DIST: X LY  COST: Y CR
        let info = format!("DIST {}  COST {} CR", dest.distance, dest.cost);
        let info_w = UiBuilder::text_width(&info, 1.6);
        ui.text(&info, x + w - 20.0 - info_w, cur_y + 13.0, 1.6, ACCENT);

        if resp.clicked {
            out.push(WindowAction::TravelTo(dest.id.clone()));
        }

        cur_y += row_h + gap;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::ui::UiBuilder;

    #[test]
    fn travel_select_emits_travel_to() {
        let icons = Icons::load();
        let model = TravelModel {
            destinations: vec![
                Destination { id: "test_dest".into(), name: "TEST DESTINATION".into(), cost: 10, distance: 50 },
            ],
        };
        let mut ui = UiBuilder::new(icons.meta);

        // Position coordinates calculated to hit the first row.
        let bx = 300.0;
        let by = 174.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 400.0, 500.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 400.0, 500.0], &model, &icons, &mut out);

        assert!(out.contains(&WindowAction::TravelTo("test_dest".into())));
    }
}
