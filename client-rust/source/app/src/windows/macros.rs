//! MACROS — macro/scripting bench UI.

use super::{WindowAction, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use std::cell::RefCell;
use successor_engine_render::ui::{ButtonStyle, TextField, UiBuilder};

thread_local! {
    static NAME_FIELD: RefCell<TextField> = RefCell::new(TextField::new(48));
    static BODY_FIELD: RefCell<TextField> = RefCell::new(TextField::new(256));
    static PREV_SEL_IDX: RefCell<Option<usize>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug, Default)]
pub struct MacroItem {
    pub name: String,
    pub body: String,
}

#[derive(Clone, Debug, Default)]
pub struct MacrosModel {
    pub macros: Vec<MacroItem>,
    pub selected_index: Option<usize>,
}

impl MacrosModel {
    pub fn sample() -> Self {
        Self {
            macros: vec![
                MacroItem {
                    name: "HEAL SELF".into(),
                    body: "/target self\n/use stim\n/pause 1.0".into(),
                },
                MacroItem {
                    name: "ATTACK TARGET".into(),
                    body: "/attack\n/pause 0.5".into(),
                },
                MacroItem {
                    name: "FLAWLESS COMBAT".into(),
                    body: "/target nearest\n/attack\n/use shield-overload".into(),
                },
            ],
            selected_index: Some(0),
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &MacrosModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header
    ui.text("MACRO SCRIPT BENCH", x, y, 2.2, ACCENT);

    // Draw icon if available
    if let Some((col, row)) = icons.cell("macro") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    // Synchronize static text fields when selection changes
    let sel_idx = model.selected_index;
    let mut selection_changed = false;
    PREV_SEL_IDX.with(|prev| {
        let mut p = prev.borrow_mut();
        if *p != sel_idx {
            *p = sel_idx;
            selection_changed = true;
        }
    });

    if selection_changed {
        if let Some(idx) = sel_idx {
            if let Some(item) = model.macros.get(idx) {
                NAME_FIELD.with(|f| {
                    let mut f = f.borrow_mut();
                    f.clear();
                    for c in item.name.chars() {
                        f.insert(c);
                    }
                });
                BODY_FIELD.with(|f| {
                    let mut f = f.borrow_mut();
                    f.clear();
                    for c in item.body.chars() {
                        f.insert(c);
                    }
                });
            }
        } else {
            NAME_FIELD.with(|f| f.borrow_mut().clear());
            BODY_FIELD.with(|f| f.borrow_mut().clear());
        }
    }

    // Layout Split: Left (60%) = list, Right (40%) = editor
    let left_w = w * 0.58;
    let right_w = w - left_w - 12.0;
    let start_y = y + 26.0;

    // --- Left side: Directory list ---
    ui.text("MACRO DIRECTORY", x, start_y, 1.8, DIM);
    let list_start_y = start_y + 18.0;
    let row_h = 36.0;

    for (i, item) in model.macros.iter().enumerate() {
        let ry = list_start_y + i as f32 * row_h;
        if ry + row_h > y + h - 10.0 {
            break;
        }

        let is_selected = model.selected_index == Some(i);
        let bg_color = if is_selected { [46, 62, 86, 235] } else { SLOT };
        ui.rect(x, ry, left_w, row_h - 4.0, bg_color);
        ui.border(
            x,
            ry,
            left_w,
            row_h - 4.0,
            1.0,
            if is_selected { ACCENT } else { SLOT_EDGE },
        );

        // Name and first line preview
        ui.text(&item.name, x + 6.0, ry + 4.0, 1.6, TEXT);
        let first_line = item.body.lines().next().unwrap_or("");
        ui.text(first_line, x + 6.0, ry + 18.0, 1.4, DIM);

        // Individual RUN button on row
        let run_btn_w = 40.0;
        let run_btn_x = x + left_w - run_btn_w - 6.0;
        let run_btn_y = ry + 4.0;
        if ui.button(
            run_btn_x,
            run_btn_y,
            run_btn_w,
            20.0,
            "RUN",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Button(format!("macro:run:{}", i)));
        }

        // Selection interaction on the rest of row
        let row_resp = ui.interact(x, ry, left_w - run_btn_w - 12.0, row_h - 4.0);
        if row_resp.clicked {
            out.push(WindowAction::Button(format!("macro:select:{}", i)));
        }
    }

    // --- Right side: Editor panel ---
    let rx = x + left_w + 12.0;
    ui.text("EDITOR / PREVIEW", rx, start_y, 1.8, DIM);

    // Designation Field
    let des_y = start_y + 18.0;
    ui.text("DESIGNATION", rx, des_y, 1.4, DIM);
    NAME_FIELD.with(|f| {
        let mut f = f.borrow_mut();
        ui.text_field(&mut f, rx, des_y + 12.0, right_w, 22.0, 1.6, true);
    });

    // Command Body Field
    let body_y = des_y + 40.0;
    ui.text("COMMAND BODY", rx, body_y, 1.4, DIM);
    BODY_FIELD.with(|f| {
        let mut f = f.borrow_mut();
        ui.text_field(&mut f, rx, body_y + 12.0, right_w, 44.0, 1.6, true);
    });

    // Render static preview from text fields
    let preview_y = body_y + 62.0;
    ui.text("PREVIEW:", rx, preview_y, 1.4, DIM);

    let name_str = NAME_FIELD.with(|f| f.borrow().text.clone());
    let body_str = BODY_FIELD.with(|f| f.borrow().text.clone());

    let display_preview = if !name_str.is_empty() {
        format!("{}: {}", name_str, body_str.lines().next().unwrap_or(""))
    } else {
        "NO MACRO SELECTED".into()
    };
    ui.text(&display_preview, rx, preview_y + 12.0, 1.4, ACCENT);

    // Editor Actions
    let btn_y = y + h - 30.0;
    let right_btn_w = (right_w - 8.0) / 2.0;

    // RUN buffer button
    let run_style = ButtonStyle::default();
    if ui.button(rx, btn_y, right_btn_w, 26.0, "RUN CMD", run_style) {
        out.push(WindowAction::Button(format!("macro:run:{}", body_str)));
    }

    // NEW macro button
    let new_style = ButtonStyle::default();
    if ui.button(
        rx + right_btn_w + 8.0,
        btn_y,
        right_btn_w,
        26.0,
        "NEW",
        new_style,
    ) {
        out.push(WindowAction::Button("macro:new".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macro_run_first_item_emits_action() {
        let icons = Icons::load();
        let model = MacrosModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // rect = [10.0, 10.0, 500.0, 400.0]
        // left_w = 500 * 0.58 = 290.0
        // list_start_y = 10.0 + 26.0 + 18.0 = 54.0
        // First item row y = 54.0. run_btn_x = 10.0 + 290.0 - 40.0 - 6.0 = 254.0
        // run_btn_y = 54.0 + 4.0 = 58.0. Size = 40 x 20.
        let bx = 254.0 + 20.0;
        let by = 58.0 + 10.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(
            &mut ui,
            [10.0, 10.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(
            &mut ui,
            [10.0, 10.0, 500.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        assert!(
            out.contains(&WindowAction::Button("macro:run:0".into())),
            "Expected macro:run:0 action, got {:?}",
            out
        );
    }
}
