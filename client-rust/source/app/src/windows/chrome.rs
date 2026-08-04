//! Shared window chrome: the restrained drawing kit every surface uses.
//!
//! Visual grammar (deliberately narrow, so twenty-one surfaces read as one
//! client):
//!   * **The frame perimeter is the only outline.** Rows, cards, and blocks are
//!     separated by translucent fills and sparse hairlines, never by their own
//!     borders. [`region`] paints a well fill plus one top hairline; [`Rows`]
//!     paints an alternating band. Nothing nests a box inside a box.
//!   * **Selection and focus are the only accents.** A selected row gets a 2 px
//!     left rail and a brighter fill; hover gets a fill only.
//!   * **The action column is reserved from the right and shrinks first.** Row
//!     labels truncate with an ellipsis instead of colliding with a control, so
//!     a frame dragged to its resize floor stays readable.
//!   * **Density comes from the surface family** ([`super::spec::Metrics`]), not
//!     from per-window literals.
//!
//! Metrics and tints are measured from the original dense windows
//! (`ui_options.inc`, `ui_auction.inc`, and the passing inventory crops): rows,
//! buttons, and tabs are 19 px; labels are 12 px and values 13 px; primary text
//! fields are 32 px; the content well is `#003848` with a `#004858` raised band
//! and a `#007890` rail.

use super::spec::{Metrics, Surface};
use super::{ACTIVE, DIM, LABEL, TEXT, VALUE};
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

// ── Measured metrics ────────────────────────────────────────────────────────

/// Generic row / button / tab height.
pub const ROW_H: f32 = 19.0;
/// Label cap height.
pub const LABEL_PX: f32 = 12.0;
/// Value cap height.
pub const VALUE_PX: f32 = 13.0;
/// Primary text-field height.
pub const FIELD_H: f32 = 32.0;
/// Tab strip height (same 19 px as every other control).
pub const TAB_H: f32 = ROW_H;

/// Convert a measured cap height in px into the 5×7 glyph scale `ui.text` takes.
pub const fn scale(cap_px: f32) -> f32 {
    cap_px / 7.0
}

// ── Measured tints ──────────────────────────────────────────────────────────

/// Content well fill (dominant tone inside a frame).
pub const WELL: [u8; 4] = [0x00, 0x38, 0x48, 210];
/// Raised band: alternating list rows and secondary blocks.
pub const WELL_RAISED: [u8; 4] = [0x00, 0x48, 0x58, 180];
/// Thin separator / border rail.
pub const RAIL: [u8; 4] = [0x00, 0x78, 0x90, 235];
/// Bright edge highlight.
pub const EDGE_BRIGHT: [u8; 4] = [0x90, 0xF0, 0xF8, 220];
/// Warning / gated state ink.
pub const WARN: [u8; 4] = [0xD6, 0x8A, 0x3E, 255];
/// Denial ink.
pub const DENY: [u8; 4] = [0xDE, 0x60, 0x54, 255];

/// Hairline used for section separators and region tops. Alias of [`RAIL`].
pub const HAIRLINE: [u8; 4] = RAIL;
/// Recessed content region fill. Alias of [`WELL`].
pub const REGION: [u8; 4] = WELL;
/// Alternating list band. Alias of [`WELL_RAISED`].
pub const BAND: [u8; 4] = WELL_RAISED;
/// Row hover.
pub const HOVER: [u8; 4] = [0x00, 0x5C, 0x70, 200];
/// Row selection fill (paired with the accent rail).
pub const SELECTED: [u8; 4] = [0x00, 0x6E, 0x86, 220];

/// Primary action control.
pub fn action_style() -> ButtonStyle {
    ButtonStyle {
        fill: [0, 0, 0, 0],
        hover: [0x00, 0x58, 0x68, 180],
        active: [0x00, 0xA8, 0xC8, 232],
        edge: RAIL,
        text: TEXT,
    }
}

/// Secondary / destructive control: same footprint, quieter fill, dim ink.
pub fn quiet_style() -> ButtonStyle {
    ButtonStyle {
        fill: [0, 0, 0, 0],
        hover: [0x00, 0x40, 0x4C, 150],
        active: [0x00, 0x78, 0x90, 216],
        edge: RAIL,
        text: DIM,
    }
}

/// Tab control. Selection is expressed by the underline in [`tabs`], so the
/// body stays flat.
fn tab_style(active: bool) -> ButtonStyle {
    ButtonStyle {
        fill: if active {
            [0x00, 0x58, 0x6C, 226]
        } else {
            [0x00, 0x30, 0x3E, 190]
        },
        hover: [0x00, 0x62, 0x78, 232],
        active: [0x00, 0x8C, 0xA8, 244],
        edge: RAIL,
        text: if active { TEXT } else { DIM },
    }
}

/// Header: surface title, family caption, one full-width hairline. Returns the
/// content-start `y`. Surfaces whose body opens with a live 3D viewport declare
/// `header: false` and keep their caption in the frame title bar instead.
pub fn header(ui: &mut UiBuilder, rect: [f32; 4], spec: &Surface) -> f32 {
    let [x, y, w, _] = rect;
    let metrics = spec.metrics();
    ui.text(spec.title, x, y, metrics.heading_px, ACTIVE);
    let caption = spec.family.caption();
    let caption_w = ui.measure_text(caption, metrics.caption_px);
    let title_w = ui.measure_text(spec.title, metrics.heading_px);
    // The caption right-aligns when it can stand clear of the heading.
    if title_w + 14.0 + caption_w <= w {
        ui.text(
            caption,
            x + w - caption_w,
            y + metrics.heading_px * 7.0 - metrics.caption_px * 7.0,
            metrics.caption_px,
            DIM,
        );
    }
    let baseline = y + metrics.heading_px * 7.0 + 4.0;
    ui.rect(x, baseline, w, 1.0, RAIL);
    baseline + 6.0
}

/// Body origin for a surface: below the header and tab strip when it has them.
/// Kept in sync with [`header`] and [`tabs`] so geometry tests can predict the
/// first content row without drawing.
pub fn body_top(rect: [f32; 4], spec: &Surface) -> f32 {
    let metrics = spec.metrics();
    let mut y = rect[1];
    if spec.header {
        y += metrics.heading_px * 7.0 + 4.0 + 6.0;
    }
    if !spec.tabs.is_empty() {
        y += TAB_H + 8.0;
    }
    y
}

/// Underline-selected tab strip. Returns the clicked index, if any. Tabs share
/// the width evenly and never draw a border — the 2 px accent underline is the
/// only selection signal.
pub fn tabs(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    w: f32,
    labels: &[&str],
    active: usize,
) -> Option<usize> {
    if labels.is_empty() {
        return None;
    }
    let gap = 3.0;
    let count = labels.len() as f32;
    let tab_w = ((w - gap * (count - 1.0)) / count).max(28.0);
    let mut clicked = None;
    for (index, label) in labels.iter().enumerate() {
        let tab_x = x + index as f32 * (tab_w + gap);
        let is_active = index == active;
        if ui.button(tab_x, y, tab_w, TAB_H, label, tab_style(is_active)) {
            clicked = Some(index);
        }
        if is_active {
            ui.rect(tab_x, y + TAB_H - 2.0, tab_w, 2.0, ACTIVE);
        }
    }
    clicked
}

/// Sparse section separator: a dim label over one hairline. Returns the `y`
/// below it.
pub fn section(ui: &mut UiBuilder, x: f32, y: f32, w: f32, label: &str, metrics: Metrics) -> f32 {
    let label_w = ui.measure_text(label, metrics.caption_px);
    ui.text(label, x, y, metrics.caption_px, DIM);
    let rule_x = x + label_w + 8.0;
    if rule_x < x + w {
        ui.rect(
            rule_x,
            y + metrics.caption_px * 3.5,
            x + w - rule_x,
            1.0,
            RAIL,
        );
    }
    y + metrics.caption_px * 7.0 + 6.0
}

/// A true content region: well fill plus one top hairline. Never a full border —
/// the frame perimeter already encloses everything.
pub fn region(ui: &mut UiBuilder, rect: [f32; 4]) {
    let [x, y, w, h] = rect;
    if w <= 0.0 || h <= 0.0 {
        return;
    }
    ui.rect(x, y, w, h, WELL);
    ui.rect(x, y, w, 1.0, RAIL);
}

/// Horizontal value meter (vitals, concentration, progress). Track then fill;
/// no outline.
pub fn meter(ui: &mut UiBuilder, x: f32, y: f32, w: f32, h: f32, frac: f32, tint: [u8; 4]) {
    ui.rect(x, y, w, h, [0x00, 0x28, 0x30, 235]);
    let filled = w * frac.clamp(0.0, 1.0);
    if filled > 0.0 {
        ui.rect(x, y, filled, h, tint);
    }
}

/// Longest character prefix of `text` that fits `max_w` at `px`, and whether it
/// was cut. Truncation is how a narrow frame stays readable.
pub fn clip<'a>(ui: &UiBuilder, text: &'a str, px: f32, max_w: f32) -> (&'a str, bool) {
    if max_w <= 0.0 {
        return ("", !text.is_empty());
    }
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

/// Draw `text` clipped to `max_w`, appending a dim ellipsis when cut. Returns
/// the x cursor after the text.
pub fn text_clipped(
    ui: &mut UiBuilder,
    text: &str,
    x: f32,
    y: f32,
    px: f32,
    max_w: f32,
    rgba: [u8; 4],
) -> f32 {
    let (head, cut) = clip(ui, text, px, max_w);
    let end = ui.text(head, x, y, px, rgba);
    if cut {
        ui.text("...", end, y, px, DIM);
        return end + ui.measure_text("...", px);
    }
    end
}

/// Explicit unavailable/empty state. One dim line, no placeholder furniture.
pub fn empty(ui: &mut UiBuilder, x: f32, y: f32, note: &str) {
    ui.text(
        if note.is_empty() { "UNAVAILABLE" } else { note },
        x,
        y,
        scale(LABEL_PX),
        DIM,
    );
}

/// A gated/denied notice: warning ink, same single line.
pub fn denied(ui: &mut UiBuilder, x: f32, y: f32, note: &str) {
    ui.text(
        if note.is_empty() { "UNAVAILABLE" } else { note },
        x,
        y,
        scale(LABEL_PX),
        WARN,
    );
}

/// Label/value pair on one baseline; the value right-aligns to `w`.
pub fn field(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    w: f32,
    label: &str,
    value: &str,
    metrics: Metrics,
) -> f32 {
    ui.text(label, x, y + 1.0, metrics.caption_px, LABEL);
    let label_w = ui.measure_text(label, metrics.caption_px) + 10.0;
    let value_w = ui.measure_text(value, metrics.label_px);
    let available = (w - label_w).max(0.0);
    let value_x = if value_w <= available {
        x + w - value_w
    } else {
        x + label_w
    };
    text_clipped(ui, value, value_x, y, metrics.label_px, available, VALUE);
    y + metrics.row_h - 4.0
}

/// A vertical run of scannable rows with a right-hand action column.
///
/// The cursor stops at `bottom`, so a resized frame drops rows instead of
/// drawing past its content rect. Row bands alternate; nothing is boxed.
pub struct Rows {
    x: f32,
    y: f32,
    w: f32,
    bottom: f32,
    metrics: Metrics,
    index: usize,
}

impl Rows {
    pub fn new(rect: [f32; 4], metrics: Metrics) -> Self {
        Self {
            x: rect[0],
            y: rect[1],
            w: rect[2],
            bottom: rect[1] + rect[3],
            metrics,
            index: 0,
        }
    }

    /// Current cursor `y` (for trailing content under the list).
    pub fn cursor(&self) -> f32 {
        self.y
    }

    /// Advance the cursor without emitting a row (spacers, sub-lines).
    pub fn advance(&mut self, dy: f32) {
        self.y += dy;
    }

    /// Whether another row of `height` still fits.
    pub fn fits(&self, height: f32) -> bool {
        self.y + height <= self.bottom
    }

    pub fn metrics(&self) -> Metrics {
        self.metrics
    }

    /// Begin the next row. `None` once the list runs out of vertical room.
    pub fn next(&mut self, ui: &mut UiBuilder) -> Option<Row> {
        self.row_with_height(ui, self.metrics.row_h, false)
    }

    /// Begin the next row, marked as the current selection.
    pub fn next_selected(&mut self, ui: &mut UiBuilder, selected: bool) -> Option<Row> {
        self.row_with_height(ui, self.metrics.row_h, selected)
    }

    /// Begin a taller row (two-line entries: label plus qualifier).
    pub fn next_tall(&mut self, ui: &mut UiBuilder, height: f32) -> Option<Row> {
        self.row_with_height(ui, height, false)
    }

    fn row_with_height(&mut self, ui: &mut UiBuilder, height: f32, selected: bool) -> Option<Row> {
        if !self.fits(height) {
            return None;
        }
        let y = self.y;
        let (mouse_x, mouse_y) = ui.mouse();
        let band_h = height - 1.0;
        let hovered = UiBuilder::hit(self.x, y, self.w, band_h, mouse_x, mouse_y);
        if selected {
            ui.rect(self.x, y, self.w, band_h, SELECTED);
            ui.rect(self.x, y, 2.0, band_h, ACTIVE);
        } else if hovered {
            ui.rect(self.x, y, self.w, band_h, HOVER);
        } else if self.index % 2 == 1 {
            ui.rect(self.x, y, self.w, band_h, WELL_RAISED);
        }
        self.index += 1;
        self.y += height;
        Some(Row {
            x: self.x,
            y,
            w: self.w,
            h: band_h,
            metrics: self.metrics,
            right: self.x + self.w,
            action_right: self.x + self.w,
            selected,
            hovered,
        })
    }
}

/// One list row. Actions pack from the right; the label region is whatever is
/// left, and long labels truncate.
pub struct Row {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub metrics: Metrics,
    /// Band right edge, fixed at construction so an indent cannot move it.
    right: f32,
    action_right: f32,
    pub selected: bool,
    pub hovered: bool,
}

impl Row {
    /// Action control width at this row's width: the column shrinks before the
    /// label does, and never below a legible floor.
    pub fn action_w(&self) -> f32 {
        (self.w * 0.24).clamp(46.0, self.metrics.action_w)
    }

    /// Leave one standard action column empty so controls in a shorter row
    /// align with sibling rows that carry two actions.
    pub fn reserve_action(&mut self) {
        let left = self.action_right - self.action_w();
        if left >= self.x + 40.0 {
            self.action_right = left - 3.0;
        }
    }

    /// Shift the text origin right, for rows that lead with a glyph. The band,
    /// the action column, and the row's right edge all stay where they are.
    pub fn indent(&mut self, dx: f32) {
        self.x += dx;
    }

    /// Place the next action, right to left. Returns true when clicked.
    pub fn action(&mut self, ui: &mut UiBuilder, label: &str) -> bool {
        self.action_styled(ui, label, action_style())
    }

    /// A quieter action (destructive or secondary) in the same column.
    pub fn quiet_action(&mut self, ui: &mut UiBuilder, label: &str) -> bool {
        self.action_styled(ui, label, quiet_style())
    }

    fn action_styled(&mut self, ui: &mut UiBuilder, label: &str, style: ButtonStyle) -> bool {
        let width = self.action_w();
        let left = self.action_right - width;
        if left < self.x + 40.0 {
            // No room for another control at this width; drop it rather than
            // overlap the label.
            return false;
        }
        let height = self.metrics.action_h.min(self.h);
        let clicked = ui.button(
            left,
            self.y + (self.h - height) * 0.5,
            width,
            height,
            label,
            style,
        );
        self.action_right = left - 3.0;
        clicked
    }

    /// Width still available for text before the action column.
    pub fn text_w(&self) -> f32 {
        (self.action_right - self.x - self.metrics.gutter - 4.0).max(0.0)
    }

    /// Primary row label, clipped to the free width.
    pub fn label(&self, ui: &mut UiBuilder, text: &str) {
        let px = self.metrics.label_px;
        text_clipped(
            ui,
            text,
            self.x + self.metrics.gutter,
            self.y + (self.h - px * 7.0) * 0.5,
            px,
            self.text_w(),
            LABEL,
        );
    }

    /// Primary label plus a dim qualifier under it (two-line rows).
    pub fn label_caption(&self, ui: &mut UiBuilder, text: &str, caption: &str) {
        let px = self.metrics.label_px;
        let cpx = self.metrics.caption_px;
        let block = px * 7.0 + cpx * 7.0 + 2.0;
        let top = self.y + ((self.h - block) * 0.5).max(1.0);
        let text_w = self.text_w();
        text_clipped(
            ui,
            text,
            self.x + self.metrics.gutter,
            top,
            px,
            text_w,
            LABEL,
        );
        text_clipped(
            ui,
            caption,
            self.x + self.metrics.gutter,
            top + px * 7.0 + 2.0,
            cpx,
            text_w,
            DIM,
        );
    }

    /// Split a tall row into the standard first line — label plus the action
    /// columns — and a caption line under it. Returns the caption's top `y`.
    ///
    /// Call this before placing actions or a leading glyph: both centre on the
    /// row height it collapses. Where [`Row::label_caption`] keeps the
    /// qualifier inside the label block beside the controls, this hands the
    /// second line the row's whole width, so a description truncates only when
    /// the frame itself is too narrow.
    pub fn split_caption_line(&mut self) -> f32 {
        let top = self.y + self.metrics.row_h;
        self.h = self.h.min(self.metrics.row_h - 1.0);
        top
    }

    /// Width the caption line has: everything from the text origin to the row's
    /// right edge, unlike [`Row::text_w`], which stops at the action column.
    pub fn caption_w(&self) -> f32 {
        (self.right - self.x - self.metrics.gutter - 4.0).max(0.0)
    }

    /// The caption line opened by [`Row::split_caption_line`]: one dim line
    /// across the row's whole width, bounded by the frame alone.
    pub fn caption_line(&self, ui: &mut UiBuilder, top: f32, text: &str) {
        text_clipped(
            ui,
            text,
            self.x + self.metrics.gutter,
            top,
            self.metrics.caption_px,
            self.caption_w(),
            DIM,
        );
    }

    /// Label tinted by state (dim when unavailable, warn when gated).
    pub fn label_tinted(&self, ui: &mut UiBuilder, text: &str, rgba: [u8; 4]) {
        let px = self.metrics.label_px;
        text_clipped(
            ui,
            text,
            self.x + self.metrics.gutter,
            self.y + (self.h - px * 7.0) * 0.5,
            px,
            self.text_w(),
            rgba,
        );
    }

    /// A right-aligned value left of the action column (quantities, prices).
    pub fn value(&mut self, ui: &mut UiBuilder, text: &str) {
        let px = self.metrics.label_px;
        let width = ui.measure_text(text, px);
        let left = self.action_right - width;
        if left <= self.x + self.metrics.gutter {
            return;
        }
        ui.text(text, left, self.y + (self.h - px * 7.0) * 0.5, px, VALUE);
        self.action_right = left - 8.0;
    }

    /// Whole-row click target (selection). Consumed after the actions so a
    /// button press is not also a row select.
    pub fn clicked(&self, ui: &UiBuilder) -> bool {
        ui.interact(self.x, self.y, self.text_w(), self.h).clicked
    }
}

/// A footer action rail: `labels` share the width evenly along one baseline.
/// Returns the clicked index. Used for commit rows (ASSEMBLE / CANCEL) so
/// primary actions land in the same place on every surface.
pub fn action_rail(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    w: f32,
    labels: &[&str],
    metrics: Metrics,
) -> Option<usize> {
    if labels.is_empty() {
        return None;
    }
    let gap = 4.0;
    let count = labels.len() as f32;
    let each = ((w - gap * (count - 1.0)) / count).max(44.0);
    let mut clicked = None;
    for (index, label) in labels.iter().enumerate() {
        let bx = x + index as f32 * (each + gap);
        if bx + each > x + w + 0.5 {
            break;
        }
        if ui.button(bx, y, each, metrics.action_h + 3.0, label, action_style()) {
            clicked = Some(index);
        }
    }
    clicked
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::spec::{self, Density};

    fn builder() -> UiBuilder {
        UiBuilder::new(crate::hud::Icons::load().meta)
    }

    #[test]
    fn measured_metrics_match_the_original_density() {
        assert_eq!(ROW_H, 19.0, "generic rows/buttons/tabs are 19 px");
        assert_eq!(TAB_H, ROW_H, "tabs share the generic control height");
        assert_eq!(LABEL_PX, 12.0);
        assert_eq!(VALUE_PX, 13.0);
        assert_eq!(FIELD_H, 32.0);
        // Every family stays on the measured pitch rather than card rows.
        for surface in &spec::SURFACES {
            let metrics = surface.metrics();
            assert!(
                metrics.row_h <= 30.0,
                "{} row pitch {} is a card, not a row",
                surface.id,
                metrics.row_h
            );
        }
    }

    #[test]
    fn clip_truncates_instead_of_overflowing() {
        let ui = builder();
        let (head, cut) = clip(&ui, "PORTABLE MINERAL EXTRACTOR", 1.5, 40.0);
        assert!(cut, "a long label must report truncation");
        assert!(
            ui.measure_text(head, 1.5) + ui.measure_text("...", 1.5) <= 40.0,
            "clipped label plus ellipsis must fit the budget"
        );
        let (head, cut) = clip(&ui, "CR 40", 1.5, 200.0);
        assert!(!cut);
        assert_eq!(head, "CR 40");
        assert_eq!(clip(&ui, "ANY", 1.5, 0.0), ("", true));
    }

    #[test]
    fn rows_stop_at_the_content_bottom() {
        let mut ui = builder();
        ui.begin(1280, 720);
        let metrics = Density::List.metrics();
        let mut rows = Rows::new([0.0, 0.0, 300.0, metrics.row_h * 3.0], metrics);
        assert!(rows.next(&mut ui).is_some());
        assert!(rows.next(&mut ui).is_some());
        assert!(rows.next(&mut ui).is_some());
        assert!(
            rows.next(&mut ui).is_none(),
            "a row list must not draw past its rect"
        );
    }

    #[test]
    fn narrow_rows_keep_the_label_clear_of_the_action_column() {
        let mut ui = builder();
        ui.begin(1280, 720);
        let metrics = Density::List.metrics();
        let mut rows = Rows::new([0.0, 0.0, 180.0, 200.0], metrics);
        let mut row = rows.next(&mut ui).expect("first row");
        assert!(!row.action(&mut ui, "TAKE"));
        assert!(
            row.text_w() > 0.0,
            "the label region collapsed at the narrow width"
        );
        assert!(
            row.action_w() >= 46.0,
            "the action control fell below the legible floor"
        );
    }

    /// A split row confines its controls to the first line and hands the caption
    /// line the row's whole width, so a description is bounded by the frame
    /// rather than by the action column it would otherwise stop short of.
    #[test]
    fn a_split_row_hands_the_caption_line_the_full_width() {
        let mut ui = builder();
        ui.begin(1280, 720);
        let metrics = Density::List.metrics();
        let tall = metrics.row_h + metrics.caption_px * 7.0 + 2.0;
        let mut rows = Rows::new([0.0, 0.0, 300.0, 200.0], metrics);
        let mut row = rows.next_tall(&mut ui, tall).expect("tall row");
        let caption_y = row.split_caption_line();
        assert_eq!(
            caption_y,
            row.y + metrics.row_h,
            "the caption must open the line under the controls"
        );
        assert_eq!(
            row.h,
            metrics.row_h - 1.0,
            "controls must be confined to the first line"
        );
        assert!(
            caption_y >= row.y + row.h,
            "the caption line must clear the control line"
        );
        row.action(&mut ui, "ASSIGN");
        row.action(&mut ui, "OPEN");
        row.indent(metrics.row_h - 1.0);
        assert!(
            row.caption_w() >= row.text_w() + row.action_w() * 2.0,
            "the caption line must clear both action columns: {} against a label \
             region of {}",
            row.caption_w(),
            row.text_w()
        );
    }

    #[test]
    fn body_top_matches_the_drawn_header_and_tabs() {
        let mut ui = builder();
        ui.begin(1280, 720);
        for id in ["bank", "datapad", "inventory", "examine"] {
            let surface = spec::surface(id).expect("spec");
            let rect = [10.0, 20.0, 400.0, 300.0];
            let predicted = body_top(rect, surface);
            let mut drawn = if surface.header {
                header(&mut ui, rect, surface)
            } else {
                rect[1]
            };
            if !surface.tabs.is_empty() {
                drawn += TAB_H + 8.0;
            }
            assert!(
                (predicted - drawn).abs() <= 0.5,
                "{id}: body_top {predicted} disagrees with drawn {drawn}"
            );
        }
    }

    #[test]
    fn a_row_action_reports_its_click() {
        let mut ui = builder();
        let metrics = Density::List.metrics();
        let mut clicked = false;
        for down in [true, false] {
            ui.set_input(300.0 - 30.0, metrics.row_h * 0.5, down);
            ui.begin(1280, 720);
            let mut rows = Rows::new([0.0, 0.0, 300.0, 200.0], metrics);
            let mut row = rows.next(&mut ui).expect("row");
            clicked = row.action(&mut ui, "TAKE");
        }
        assert!(clicked, "release inside the action must report a click");
    }
}
