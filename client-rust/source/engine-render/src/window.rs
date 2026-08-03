//! Desktop-style window manager (immediate-mode port of `client-3d`'s
//! `windowManager.ts`). Owns per-window bounds, open state, and z-order; drives
//! title-bar move, corner resize, focus-to-front, and close via the `UiBuilder`
//! pointer input. Input is resolved front-to-back in `update`; the host then
//! walks `z_order()` (back-to-front) drawing each window's chrome + content.
//!
//! Rendering stays renderer-agnostic: a window carries an optional icon atlas
//! cell `(col,row)` supplied by the host, never an icon id the engine can't
//! resolve.

use crate::ui::{RectangleStyle, UiBuilder};
use alloc::string::String;
use alloc::vec::Vec;

/// Title-strip height (px). Mirrors `TITLE_STRIP_PX` (scaled up for the 5×7
/// font's legibility).
pub const TITLE_H: f32 = 26.0;
/// Bottom-right resize gadget size (px).
pub const RESIZE_H: f32 = 16.0;
const EDGE_ATTRACTION_THRESHOLD: f32 = 4.0;
const DOUBLE_CLICK_MS: u64 = 350;

#[derive(Clone)]
struct Win {
    id: String,
    title: String,
    icon: Option<(u32, u32)>,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    min_w: f32,
    min_h: f32,
    open: bool,
    z: u32,
    restore_rect: Option<[f32; 4]>,
    maximized: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum DragMode {
    Move,
    Resize,
}

struct Drag {
    idx: usize,
    mode: DragMode,
    mx0: f32,
    my0: f32,
    bx: f32,
    by: f32,
    bw: f32,
    bh: f32,
}

/// Colors + metrics for window chrome.
#[derive(Clone, Copy, Debug)]
pub struct WindowStyle {
    pub frame: RectangleStyle,
    pub title_bar: [u8; 4],
    pub title_bar_focused: [u8; 4],
    pub edge: [u8; 4],
    pub text: [u8; 4],
    pub close: [u8; 4],
    pub resize: [u8; 4],
}

impl Default for WindowStyle {
    fn default() -> Self {
        Self {
            frame: RectangleStyle {
                north: [42, 116, 124, 190],
                south: [22, 58, 63, 170],
                east: [28, 76, 82, 175],
                west: [32, 88, 94, 180],
                center: [6, 12, 13, 238],
                north_east: [42, 116, 124, 190],
                north_west: [42, 116, 124, 190],
                south_east: [22, 58, 63, 170],
                south_west: [22, 58, 63, 170],
                west_width: 1.0,
                east_width: 1.0,
                north_height: 1.0,
                south_height: 1.0,
            },
            title_bar: [7, 15, 17, 244],
            title_bar_focused: [8, 27, 30, 248],
            edge: [54, 151, 160, 190],
            text: [220, 234, 235, 255],
            close: [211, 104, 88, 255],
            resize: [94, 154, 160, 190],
        }
    }
}

pub struct WindowManager {
    wins: Vec<Win>,
    z: u32,
    drag: Option<Drag>,
    sw: f32,
    sh: f32,
    captured: bool,
    last_title_click: Option<(usize, u64)>,
}

impl Default for WindowManager {
    fn default() -> Self {
        Self::new()
    }
}

impl WindowManager {
    pub fn new() -> Self {
        Self {
            wins: Vec::new(),
            z: 0,
            drag: None,
            sw: 1.0,
            sh: 1.0,
            captured: false,
            last_title_click: None,
        }
    }

    /// Register a (closed) window. `icon` is an atlas cell the host resolved.
    pub fn register(
        &mut self,
        id: &str,
        title: &str,
        icon: Option<(u32, u32)>,
        bounds: [f32; 4],
        min_w: f32,
        min_h: f32,
    ) {
        if self.find(id).is_some() {
            return;
        }
        self.z += 1;
        self.wins.push(Win {
            id: String::from(id),
            title: String::from(title),
            icon,
            x: bounds[0],
            y: bounds[1],
            w: bounds[2],
            h: bounds[3],
            min_w,
            min_h,
            open: false,
            z: self.z,
            restore_rect: None,
            maximized: false,
        });
    }

    fn find(&self, id: &str) -> Option<usize> {
        self.wins.iter().position(|w| w.id == id)
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.find(id).map(|i| self.wins[i].open).unwrap_or(false)
    }

    /// Current outer bounds for a registered window, whether open or closed.
    pub fn rect(&self, id: &str) -> Option<[f32; 4]> {
        self.find(id).map(|i| {
            let win = &self.wins[i];
            [win.x, win.y, win.w, win.h]
        })
    }

    pub fn open(&mut self, id: &str) {
        if let Some(i) = self.find(id) {
            self.wins[i].open = true;
            self.bring_to_front(i);
        }
    }

    pub fn close(&mut self, id: &str) {
        if let Some(i) = self.find(id) {
            self.wins[i].open = false;
        }
    }

    pub fn toggle(&mut self, id: &str) {
        if let Some(i) = self.find(id) {
            if self.wins[i].open {
                self.wins[i].open = false;
            } else {
                self.wins[i].open = true;
                self.bring_to_front(i);
            }
        }
    }

    pub fn any_open(&self) -> bool {
        self.wins.iter().any(|w| w.open)
    }

    fn bring_to_front(&mut self, idx: usize) {
        self.z += 1;
        self.wins[idx].z = self.z;
    }

    /// Open windows, back-to-front (ascending z) — the host draw order.
    pub fn z_order(&self) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.wins.len())
            .filter(|&i| self.wins[i].open)
            .collect();
        idx.sort_by_key(|&i| self.wins[i].z);
        idx
    }
    /// Fill a caller-owned draw-order buffer without allocating.
    pub fn fill_z_order(&self, out: &mut Vec<usize>) {
        out.clear();
        out.extend((0..self.wins.len()).filter(|&index| self.wins[index].open));
        out.sort_unstable_by_key(|&index| self.wins[index].z);
    }

    pub fn window_id(&self, idx: usize) -> &str {
        &self.wins[idx].id
    }

    fn clamp(&mut self, idx: usize) {
        let w = &mut self.wins[idx];
        let vw = self.sw;
        let vh = self.sh;
        w.w = w.w.clamp(w.min_w.min(vw), vw);
        w.h = w.h.clamp(w.min_h.min(vh), vh);
        w.x = w.x.clamp(0.0, (vw - TITLE_H * 5.0).max(0.0));
        w.y = w.y.clamp(0.0, (vh - TITLE_H).max(0.0));
    }

    fn snap_move(&mut self, idx: usize) {
        let (mut x, mut y, w, h) = {
            let win = &self.wins[idx];
            (win.x, win.y, win.w, win.h)
        };
        let mut left = 0.0;
        let mut right = self.sw;
        let mut top = 0.0;
        let mut bottom = self.sh;
        for (other_idx, other) in self.wins.iter().enumerate() {
            if other_idx == idx || !other.open {
                continue;
            }
            let horizontal_overlap = other.x < x + w && other.x + other.w > x;
            if horizontal_overlap {
                let other_bottom = other.y + other.h;
                if other_bottom > top && (other_bottom - y).abs() < (top - y).abs() {
                    top = other_bottom;
                }
                if other.y < bottom && (other.y - (y + h)).abs() < (bottom - (y + h)).abs() {
                    bottom = other.y;
                }
            }
            let vertical_overlap = other.y < y + h && other.y + other.h > y;
            if vertical_overlap {
                let other_right = other.x + other.w;
                if other_right > left && (other_right - x).abs() < (left - x).abs() {
                    left = other_right;
                }
                if other.x < right && (other.x - (x + w)).abs() < (right - (x + w)).abs() {
                    right = other.x;
                }
            }
        }
        if (x + w - right).abs() < EDGE_ATTRACTION_THRESHOLD {
            x = right - w;
        }
        if (x - left).abs() < EDGE_ATTRACTION_THRESHOLD {
            x = left;
        }
        if (y + h - bottom).abs() < EDGE_ATTRACTION_THRESHOLD {
            y = bottom - h;
        }
        if (y - top).abs() < EDGE_ATTRACTION_THRESHOLD {
            y = top;
        }
        self.wins[idx].x = x;
        self.wins[idx].y = y;
    }

    fn toggle_maximize_idx(&mut self, idx: usize) {
        let win = &mut self.wins[idx];
        if win.maximized {
            if let Some([x, y, w, h]) = win.restore_rect.take() {
                win.x = x;
                win.y = y;
                win.w = w;
                win.h = h;
            }
            win.maximized = false;
        } else {
            win.restore_rect = Some([win.x, win.y, win.w, win.h]);
            win.x = 0.0;
            win.y = 0.0;
            win.w = self.sw;
            win.h = self.sh;
            win.maximized = true;
        }
    }

    /// Resolve focus, move, resize, close, maximize, and workspace-edge snap.
    pub fn update_at(&mut self, ui: &UiBuilder, screen_w: u32, screen_h: u32, now_ms: u64) {
        self.sw = screen_w.max(1) as f32;
        self.sh = screen_h.max(1) as f32;
        self.captured = false;
        let (mx, my) = ui.mouse();
        let down = ui.interact(0.0, 0.0, self.sw, self.sh).held;

        if self.drag.is_some() {
            if !down {
                self.drag = None;
            } else {
                let (idx, mode, mx0, my0, bx, by, bw, bh) = {
                    let d = self.drag.as_ref().expect("drag checked");
                    (d.idx, d.mode, d.mx0, d.my0, d.bx, d.by, d.bw, d.bh)
                };
                let (dx, dy) = (mx - mx0, my - my0);
                match mode {
                    DragMode::Move => {
                        self.wins[idx].x = bx + dx;
                        self.wins[idx].y = by + dy;
                    }
                    DragMode::Resize => {
                        self.wins[idx].w = bw + dx;
                        self.wins[idx].h = bh + dy;
                        self.wins[idx].maximized = false;
                    }
                }
                self.clamp(idx);
                if mode == DragMode::Move {
                    self.snap_move(idx);
                }
                self.captured = true;
                return;
            }
        }

        if !ui.interact(0.0, 0.0, self.sw, self.sh).pressed {
            return;
        }
        let target = self
            .wins
            .iter()
            .enumerate()
            .filter(|(_, win)| win.open && UiBuilder::hit(win.x, win.y, win.w, win.h, mx, my))
            .max_by_key(|(_, win)| win.z)
            .map(|(idx, _)| idx);
        let Some(idx) = target else {
            return;
        };
        let (x, y, w, h) = {
            let win = &self.wins[idx];
            (win.x, win.y, win.w, win.h)
        };
        self.bring_to_front(idx);
        self.captured = true;
        let cb = TITLE_H;
        if UiBuilder::hit(x + w - cb, y, cb, TITLE_H, mx, my) {
            self.wins[idx].open = false;
            self.drag = None;
            return;
        }
        if UiBuilder::hit(x + w - cb * 2.0, y, cb, TITLE_H, mx, my) {
            self.toggle_maximize_idx(idx);
            self.last_title_click = None;
            return;
        }
        if UiBuilder::hit(
            x + w - RESIZE_H,
            y + h - RESIZE_H,
            RESIZE_H,
            RESIZE_H,
            mx,
            my,
        ) {
            self.drag = Some(Drag {
                idx,
                mode: DragMode::Resize,
                mx0: mx,
                my0: my,
                bx: x,
                by: y,
                bw: w,
                bh: h,
            });
            return;
        }
        if UiBuilder::hit(x, y, w - cb * 2.0, TITLE_H, mx, my) {
            let double = self.last_title_click.is_some_and(|(last_idx, last_ms)| {
                last_idx == idx && now_ms.saturating_sub(last_ms) <= DOUBLE_CLICK_MS
            });
            if double {
                self.toggle_maximize_idx(idx);
                self.last_title_click = None;
            } else {
                self.last_title_click = Some((idx, now_ms));
                self.drag = Some(Drag {
                    idx,
                    mode: DragMode::Move,
                    mx0: mx,
                    my0: my,
                    bx: x,
                    by: y,
                    bw: w,
                    bh: h,
                });
            }
        }
    }

    /// Compatibility entry for deterministic tests that do not model time.
    pub fn update(&mut self, ui: &UiBuilder, screen_w: u32, screen_h: u32) {
        self.update_at(ui, screen_w, screen_h, 0);
    }

    /// Whether this frame's pointer press/drag landed on a window (so the host
    /// should not also treat it as a background/HUD click).
    pub fn pointer_captured(&self) -> bool {
        self.captured
    }

    /// Draw one window's chrome (title bar + icon + title + close + body panel +
    /// resize gadget) and return its inner content rect `(x, y, w, h)` (px).
    pub fn draw_chrome(&self, ui: &mut UiBuilder, idx: usize, style: WindowStyle) -> [f32; 4] {
        let win = &self.wins[idx];
        let focused = self.wins.iter().filter(|w| w.open).map(|w| w.z).max() == Some(win.z);
        // One quiet outer edge and a soft shadow; content establishes its own
        // hierarchy through spacing and fill rather than nested outlines.
        ui.rect(win.x + 3.0, win.y + 4.0, win.w, win.h, [0, 0, 0, 76]);
        ui.nine_slice(win.x, win.y, win.w, win.h, &style.frame);
        // Title bar.
        let tb = if focused {
            style.title_bar_focused
        } else {
            style.title_bar
        };
        ui.rect(win.x, win.y, win.w, TITLE_H, tb);
        if focused {
            ui.rect(win.x, win.y + TITLE_H - 1.0, win.w, 1.0, style.edge);
        }
        let mut tx = win.x + 8.0;
        if let Some((col, row)) = win.icon {
            ui.icon(
                col,
                row,
                win.x + 4.0,
                win.y + 4.0,
                TITLE_H - 8.0,
                TITLE_H - 8.0,
                style.text,
            );
            tx = win.x + TITLE_H + 2.0;
        }
        let px = 2.2;
        ui.text(
            &win.title,
            tx,
            win.y + (TITLE_H - 7.0 * px) * 0.5,
            px,
            style.text,
        );
        // Close box (draw an X).
        let cb = TITLE_H;
        let cx = win.x + win.w - cb;
        ui.text(
            "X",
            cx + cb * 0.5 - 5.0,
            win.y + (TITLE_H - 7.0 * px) * 0.5,
            px,
            style.close,
        );
        // Minimal maximize glyph: a single corner, not another framed box.
        let mx = cx - cb;
        ui.line(
            mx + 8.0,
            win.y + 8.0,
            mx + cb - 8.0,
            win.y + 8.0,
            1.2,
            style.text,
        );
        ui.line(
            mx + cb - 8.0,
            win.y + 8.0,
            mx + cb - 8.0,
            win.y + 15.0,
            1.2,
            style.text,
        );
        // Two short corner strokes preserve resize affordance without a badge.
        let rx = win.x + win.w;
        let ry = win.y + win.h;
        ui.line(rx - 11.0, ry - 3.0, rx - 3.0, ry - 11.0, 1.2, style.resize);
        ui.line(rx - 7.0, ry - 3.0, rx - 3.0, ry - 7.0, 1.2, style.resize);
        // Content rect (below title, padded).
        let pad = 6.0;
        [
            win.x + pad,
            win.y + TITLE_H + pad,
            win.w - 2.0 * pad,
            win.h - TITLE_H - 2.0 * pad,
        ]
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::ui::{AtlasMeta, UiBuilder};

    const ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };

    fn wm() -> WindowManager {
        let mut m = WindowManager::new();
        m.register(
            "inv",
            "INVENTORY",
            None,
            [100.0, 100.0, 300.0, 200.0],
            160.0,
            120.0,
        );
        m.register(
            "char",
            "CHARACTER",
            None,
            [200.0, 150.0, 300.0, 200.0],
            160.0,
            120.0,
        );
        m
    }

    #[test]
    fn open_close_toggle() {
        let mut m = wm();
        assert!(!m.is_open("inv"));
        m.open("inv");
        assert!(m.is_open("inv"));
        m.toggle("inv");
        assert!(!m.is_open("inv"));
        assert!(!m.any_open());
    }

    #[test]
    fn focus_brings_to_front_in_z_order() {
        let mut m = wm();
        m.open("inv");
        m.open("char");
        // char opened last → front (last in z_order).
        let order = m.z_order();
        assert_eq!(m.window_id(*order.last().unwrap()), "char");
        // Click on inv (at 100,100) brings it to front.
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(120.0, 110.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        let order = m.z_order();
        assert_eq!(m.window_id(*order.last().unwrap()), "inv");
    }

    #[test]
    fn title_drag_moves_window() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        // Press on inv title strip (100,100)+(10,10).
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        // Drag by (+40,+30).
        ui.set_input(150.0, 140.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        let rect = m.draw_chrome(&mut ui, m.find("inv").unwrap(), WindowStyle::default());
        // content x = new window x (140) + pad(6).
        assert!(
            (rect[0] - (140.0 + 6.0)).abs() < 1e-3,
            "moved x, got {}",
            rect[0]
        );
    }

    #[test]
    fn resize_respects_minimum() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        // Press on the resize gadget (bottom-right of 100,100,300,200 → ~400,300).
        ui.set_input(400.0 - 4.0, 300.0 - 4.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        // Drag far up-left to shrink below min.
        ui.set_input(120.0, 120.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        let i = m.find("inv").unwrap();
        assert!(m.wins[i].w >= m.wins[i].min_w, "clamped to min width");
        assert!(m.wins[i].h >= m.wins[i].min_h, "clamped to min height");
    }

    #[test]
    fn close_box_click_closes() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        // Close box: x + w - TITLE_H .. → 100+300-26=374 .. 400, y 100..126.
        ui.set_input(387.0, 110.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        assert!(!m.is_open("inv"), "close box closed the window");
    }

    #[test]
    fn moving_window_snaps_to_workspace_edge() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        ui.set_input(12.0, 110.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        let win = &m.wins[m.find("inv").unwrap()];
        assert_eq!(win.x, 0.0, "two-pixel edge gap should attract");
    }

    #[test]
    fn title_double_click_maximizes_and_restores() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 100);
        ui.set_input(110.0, 110.0, false);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 140);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 200);
        let win = &m.wins[m.find("inv").unwrap()];
        assert_eq!([win.x, win.y, win.w, win.h], [0.0, 0.0, 1280.0, 720.0]);

        ui.set_input(10.0, 10.0, false);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 240);
        ui.set_input(10.0, 10.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 500);
        ui.set_input(10.0, 10.0, false);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 540);
        ui.set_input(10.0, 10.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 600);
        let win = &m.wins[m.find("inv").unwrap()];
        assert_eq!([win.x, win.y, win.w, win.h], [100.0, 100.0, 300.0, 200.0]);
    }
}
