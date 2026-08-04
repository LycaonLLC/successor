//! ACTIONS — the command browser (`SwgCuiCommandBrowser`).
//!
//! One scannable row per bindable command in the toolbar registry: the command
//! name and its controls share the standard first line, and the command's
//! one-line description spans the full width beneath them, so a description is
//! bounded by the frame rather than by the action column. ASSIGN arms the
//! toolbar's pending assignment so the next slot click binds that command — the
//! original surface's whole job is getting commands onto the bar, and this port
//! keeps that as the primary action (the reference client drags a row onto a
//! slot; the immediate-mode port arms-then-clicks, which is the same two
//! gestures without a drag payload).
//!
//! A closing TOOLS section carries the surfaces that have no dock button and no
//! terminal of their own, so they stay reachable without inventing a second
//! dock: the support report and the survey tool.

use super::chrome::{self, Row, Rows};
use super::{Ctx, WindowAction, DIM};
use crate::hud::toolbar::{ActionKind, TOOLBAR_ACTIONS};
use crate::hud::Icons;
use successor_engine_render::ui::UiBuilder;

/// Context surfaces reachable from the browser: `(window id, label)`.
const TOOLS: [(&str, &str); 2] = [("survey", "SURVEY TOOL"), ("bug-report", "SUPPORT REPORT")];

pub fn draw(ui: &mut UiBuilder, ctx: Ctx, icons: &Icons, out: &mut Vec<WindowAction>) {
    let metrics = ctx.metrics();
    let [x, y, w, h] = ctx.rect;

    // The TOOLS rail is fixed at the bottom so the command list never pushes it
    // off a short frame.
    let tools_h = metrics.caption_px * 7.0 + 6.0 + TOOLS.len() as f32 * metrics.row_h;
    let list_h = (h - tools_h - 6.0).max(metrics.row_h);

    let hint_y = y;
    chrome::text_clipped(
        ui,
        "ASSIGN ARMS A SLOT. CLICK A TOOLBAR SLOT TO BIND.",
        x,
        hint_y,
        metrics.caption_px,
        w,
        DIM,
    );
    let list_y = hint_y + metrics.caption_px * 7.0 + 5.0;
    let mut rows = Rows::new([x, list_y, w, (list_h - (list_y - y)).max(0.0)], metrics);

    for action in TOOLBAR_ACTIONS.iter() {
        let row_h = metrics.row_h + metrics.caption_px * 7.0 + 2.0;
        let Some(mut row) = rows.next_tall(ui, row_h) else {
            break;
        };
        // The command name and its controls share the standard first line; the
        // description owns the full-width line beneath, so a caption is bounded
        // by the frame instead of stopping short of the ASSIGN column.
        let caption_y = row.split_caption_line();
        if row.action(ui, "ASSIGN") {
            out.push(WindowAction::BeginAssignAction(action.id.to_string()));
        }
        // Window shortcuts also open their surface directly, which is how the
        // reference options pane links into a window.
        if let ActionKind::Window(window_id) = action.kind {
            if row.action(ui, "OPEN") {
                out.push(WindowAction::OpenWindow(window_id.to_string()));
            }
        }
        glyph(ui, &row, icons, action.icon);
        // Indent the text past the glyph without a second column of chrome.
        row.indent(metrics.row_h - 1.0);
        row.label(ui, action.label);
        row.caption_line(ui, caption_y, action.description);
    }

    let mut cursor = y + list_h;
    cursor = chrome::section(ui, x, cursor, w, "TOOLS", metrics);
    let mut tools = Rows::new([x, cursor, w, (y + h - cursor).max(0.0)], metrics);
    for (window_id, label) in TOOLS {
        let Some(mut row) = tools.next(ui) else { break };
        // One control per tool row, parked in the command rows' OPEN column so
        // both sections share the same two right-hand columns.
        row.reserve_action();
        if row.action(ui, "OPEN") {
            out.push(WindowAction::OpenWindow(window_id.to_string()));
        }
        glyph(ui, &row, icons, window_id);
        row.indent(metrics.row_h - 1.0);
        row.label(ui, label);
    }
}

/// The row's leading atlas glyph, centred on the row's first line. Both
/// sections call this, so TOOLS keeps the command rows' glyph rhythm and text
/// inset instead of starting flush at the gutter.
fn glyph(ui: &mut UiBuilder, row: &Row, icons: &Icons, id: &str) {
    let Some((column, glyph_row)) = icons.cell(id) else {
        return;
    };
    let size = row.metrics.row_h - 5.0;
    ui.icon(
        column,
        glyph_row,
        row.x + row.metrics.gutter,
        row.y + (row.h - size) * 0.5,
        size,
        size,
        super::LABEL,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::spec;

    fn ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: spec::surface("actions").expect("actions surface"),
            rect,
            tab: 0,
        }
    }

    fn click(
        ui: &mut UiBuilder,
        icons: &Icons,
        rect: [f32; 4],
        cx: f32,
        cy: f32,
    ) -> Vec<WindowAction> {
        let mut out = Vec::new();
        for down in [true, false] {
            ui.set_input(cx, cy, down);
            ui.begin(1280, 720);
            out.clear();
            draw(ui, ctx(rect), icons, &mut out);
        }
        out
    }

    #[test]
    fn every_registry_command_is_listed_and_assignable() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        // Tall enough for the whole registry plus the tools rail.
        let rect = [0.0, 0.0, 320.0, 900.0];
        let metrics = ctx(rect).metrics();
        let list_y = metrics.caption_px * 7.0 + 5.0;
        let action_w = (rect[2] * 0.24).clamp(46.0, metrics.action_w);
        // First registry row's ASSIGN control. Controls ride the row's standard
        // first line, above the description line.
        let out = click(
            &mut ui,
            &icons,
            rect,
            rect[2] - action_w * 0.5,
            list_y + metrics.row_h * 0.5,
        );
        let first = TOOLBAR_ACTIONS[0].id;
        assert!(
            out.contains(&WindowAction::BeginAssignAction(first.to_string())),
            "the first command row must arm assignment for {first}, got {out:?}"
        );
    }

    /// TOOLS rows carry one action, and it sits in the same column as the
    /// command rows' OPEN control rather than jumping to the ASSIGN column.
    #[test]
    fn tools_rail_opens_the_dockless_surfaces_in_the_open_column() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let rect = [0.0, 0.0, 320.0, 400.0];
        let metrics = ctx(rect).metrics();
        let tools_h = metrics.caption_px * 7.0 + 6.0 + TOOLS.len() as f32 * metrics.row_h;
        let list_h = (rect[3] - tools_h - 6.0).max(metrics.row_h);
        let first_tool_y = list_h + metrics.caption_px * 7.0 + 6.0 + metrics.row_h * 0.5;
        let action_w = (rect[2] * 0.24).clamp(46.0, metrics.action_w);
        let open_column_x = rect[2] - action_w - 3.0 - action_w * 0.5;
        let outer_column_x = rect[2] - action_w * 0.5;

        let out = click(&mut ui, &icons, rect, open_column_x, first_tool_y);
        assert!(
            out.contains(&WindowAction::OpenWindow("survey".into())),
            "the tools rail must open the survey surface, got {out:?}"
        );

        let outer = click(&mut ui, &icons, rect, outer_column_x, first_tool_y);
        assert!(
            outer.is_empty(),
            "the reserved outer column must stay empty on tool rows, got {outer:?}"
        );
    }

    #[test]
    fn no_intents_without_a_click() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, ctx([0.0, 0.0, 300.0, 280.0]), &icons, &mut out);
        assert!(out.is_empty());
        assert!(ui.quads > 0, "the browser must draw at its resize floor");
    }
}
