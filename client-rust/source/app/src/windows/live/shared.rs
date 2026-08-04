//! Helpers every connected surface body shares: the pane cursor, the
//! wrapped-prose writer, and the retained text fields.

use std::cell::RefCell;

use crate::windows::chrome::{self, Rows};
use crate::windows::spec::{Density, Metrics};
use crate::windows::{accent, Ctx};
use successor_engine_render::ui::{TextField, UiBuilder};

thread_local! {
    pub(crate) static GUILD_NAME: RefCell<TextField> = RefCell::new(TextField::new(32));
    pub(crate) static GUILD_TAG: RefCell<TextField> = RefCell::new(TextField::new(5));
    pub(crate) static MACRO_NAME: RefCell<TextField> = RefCell::new(TextField::new(48));
    pub(crate) static MACRO_BODY: RefCell<TextField> = RefCell::new(TextField::new(8 * 1024));
}

/// A surface body: the rect the dispatcher already inset below the header and
/// tab strip, plus a cursor that never runs past its floor.
pub(crate) struct Pane {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) w: f32,
    /// Content floor. Shrinks when a commit rail is reserved, so the list above
    /// can never draw under it.
    pub(crate) bottom: f32,
    pub(crate) metrics: Metrics,
}

impl Pane {
    pub(crate) fn open(ctx: Ctx) -> Self {
        let [x, y, w, h] = ctx.rect;
        Self {
            x,
            y,
            w: w.max(0.0),
            bottom: y + h.max(0.0),
            metrics: ctx.metrics(),
        }
    }

    /// Rect still free below the cursor.
    pub(crate) fn body(&self) -> [f32; 4] {
        [self.x, self.y, self.w, (self.bottom - self.y).max(0.0)]
    }

    /// A row list over the free body.
    pub(crate) fn rows(&self) -> Rows {
        Rows::new(self.body(), self.metrics)
    }

    /// Adopt a finished list's cursor so the next section continues below it.
    pub(crate) fn resume(&mut self, rows: &Rows) {
        self.y = rows.cursor().min(self.bottom);
    }

    /// Sparse section rule.
    pub(crate) fn section(&mut self, ui: &mut UiBuilder, label: &str) {
        self.y = chrome::section(ui, self.x, self.y, self.w, label, self.metrics);
    }

    /// One label/value line.
    pub(crate) fn field(&mut self, ui: &mut UiBuilder, label: &str, value: &str) {
        self.y = chrome::field(ui, self.x, self.y, self.w, label, value, self.metrics);
    }

    /// Two label/value pairs on one line — the readout strip a terminal opens
    /// with, at half the vertical cost of stacking them.
    pub(crate) fn field_pair(&mut self, ui: &mut UiBuilder, left: (&str, &str), right: (&str, &str)) {
        let half = ((self.w - 12.0) * 0.5).max(0.0);
        chrome::field(ui, self.x, self.y, half, left.0, left.1, self.metrics);
        self.y = chrome::field(
            ui,
            self.x + half + 12.0,
            self.y,
            half,
            right.0,
            right.1,
            self.metrics,
        );
    }

    /// Explicit empty state at the cursor.
    pub(crate) fn empty(&mut self, ui: &mut UiBuilder, note: &str) {
        chrome::empty(ui, self.x, self.y, note);
        self.y += self.metrics.row_h;
    }

    /// Gate denial at the cursor.
    pub(crate) fn denied(&mut self, ui: &mut UiBuilder, note: &str) {
        chrome::denied(ui, self.x, self.y, note);
        self.y += self.metrics.row_h;
    }

    /// Vertical space one action rail occupies.
    pub(crate) fn rail_h(&self) -> f32 {
        self.metrics.action_h + 3.0
    }

    /// Inline action rail at the cursor. `None` when it was not clicked or the
    /// pane has no room left for it.
    pub(crate) fn rail(&mut self, ui: &mut UiBuilder, labels: &[&str]) -> Option<usize> {
        let height = self.rail_h();
        if labels.is_empty() || self.y + height > self.bottom {
            return None;
        }
        let clicked = chrome::action_rail(ui, self.x, self.y, self.w, labels, self.metrics);
        self.y += height + 5.0;
        clicked
    }

    /// Reserve the commit rail against the pane floor, shrinking the body above
    /// it. `None` when the pane is too short to hold one without eating the
    /// content it commits.
    pub(crate) fn reserve_footer(&mut self) -> Option<f32> {
        let top = self.bottom - self.rail_h();
        if top <= self.y {
            return None;
        }
        self.bottom = top - 5.0;
        Some(top)
    }

    /// Draw a rail into the space [`Pane::reserve_footer`] set aside.
    pub(crate) fn footer(&self, ui: &mut UiBuilder, at: Option<f32>, labels: &[&str]) -> Option<usize> {
        let y = at?;
        if labels.is_empty() {
            return None;
        }
        chrome::action_rail(ui, self.x, y, self.w, labels, self.metrics)
    }
}

/// Stack quantity in the form the dense columns use. The UI font rasterizes
/// ASCII only, so the `×` this file used to draw was an invisible advance.
pub(crate) fn qty(count: impl core::fmt::Display) -> String {
    format!("x{count}")
}

/// Draw `text` as wrapped lines in `w`, stopping at `bottom`. Returns the `y`
/// below the last line. Breaks on spaces and slices the source in place, so a
/// long NPC delivery costs no allocation.
#[allow(clippy::too_many_arguments)]
pub(crate) fn prose(
    ui: &mut UiBuilder,
    text: &str,
    x: f32,
    y: f32,
    w: f32,
    bottom: f32,
    px: f32,
    rgba: [u8; 4],
) -> f32 {
    let line_h = px * 7.0 + 4.0;
    let mut cursor = y;
    let mut rest = text.trim();
    while !rest.is_empty() && cursor + line_h <= bottom {
        let mut end = rest.len();
        let mut wrap = None;
        let mut width = 0.0;
        for (offset, ch) in rest.char_indices() {
            width += ui.measure_text(&rest[offset..offset + ch.len_utf8()], px);
            if width > w {
                // Always take at least one character, or a narrow pane loops.
                end = offset.max(ch.len_utf8());
                break;
            }
            if ch == ' ' {
                wrap = Some(offset);
            }
        }
        // Prefer the last word boundary so words are never split mid-glyph.
        let (draw_end, skip) = match wrap {
            Some(space) if end < rest.len() => (space, space + 1),
            _ => (end, end),
        };
        ui.text(&rest[..draw_end], x, cursor, px, rgba);
        cursor += line_h;
        rest = rest[skip..].trim_start();
    }
    cursor
}

/// A heading-weight line for content that names itself — an examined object, a
/// prop label — on the surfaces whose viewer takes the header's place.
pub(crate) fn heading(pane: &mut Pane, ui: &mut UiBuilder, text: &str) {
    let px = pane.metrics.heading_px;
    chrome::text_clipped(ui, text, pane.x, pane.y, px, pane.w, accent());
    pane.y += px * 7.0 + 5.0;
}

/// Standalone unavailable pane: a section rule over one dim line. Used where a
/// surface has no spec-backed body to draw at all.
pub fn unavailable_window(ui: &mut UiBuilder, rect: [f32; 4], caption: &str, note: &str) {
    let metrics = Density::List.metrics();
    let [x, y, w, _] = rect;
    let body = chrome::section(ui, x, y, w.max(0.0), caption, metrics);
    chrome::empty(ui, x, body, note);
}
