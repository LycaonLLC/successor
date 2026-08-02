//! Desktop-style window manager (immediate-mode port of `client-3d`'s
//! `windowManager.ts`). Owns per-window bounds, open state, and z-order; drives
//! title-bar move, corner resize, focus-to-front, and close via the `UiBuilder`
//! pointer input. Input is resolved front-to-back in `update`; the host then
//! walks `z_order()` (back-to-front) drawing each window's chrome + content.
//!
//! Rendering stays renderer-agnostic: a window carries an optional icon atlas
//! cell `(col,row)` supplied by the host, never an icon id the engine can't
//! resolve.

use crate::ui::UiBuilder;
use alloc::string::String;
use alloc::vec::Vec;

/// Title-strip height (px). Mirrors `TITLE_STRIP_PX` (scaled up for the 5×7
/// font's legibility).
pub const TITLE_H: f32 = 26.0;
/// Bottom-right resize gadget size (px).
pub const RESIZE_H: f32 = 16.0;

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
    pub body: [u8; 4],
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
            body: [14, 18, 26, 235],
            title_bar: [26, 34, 48, 240],
            title_bar_focused: [46, 62, 86, 245],
            edge: [110, 140, 172, 255],
            text: [214, 226, 240, 255],
            close: [220, 120, 110, 255],
            resize: [120, 150, 180, 255],
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
        });
    }

    fn find(&self, id: &str) -> Option<usize> {
        self.wins.iter().position(|w| w.id == id)
    }

    pub fn is_open(&self, id: &str) -> bool {
        self.find(id).map(|i| self.wins[i].open).unwrap_or(false)
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

    /// Resolve pointer interaction (focus, move, resize, close) for this frame.
    /// Call once, before drawing, with the framebuffer size.
    pub fn update(&mut self, ui: &UiBuilder, screen_w: u32, screen_h: u32) {
        self.sw = screen_w.max(1) as f32;
        self.sh = screen_h.max(1) as f32;
        self.captured = false;
        let (mx, my) = ui.mouse();
        let down = ui.interact(0.0, 0.0, self.sw, self.sh).held; // any-down proxy

        // Continue or end an active drag.
        if let Some(d) = &self.drag {
            if !down {
                self.drag = None;
            } else {
                let idx = d.idx;
                let (dx, dy) = (mx - d.mx0, my - d.my0);
                match d.mode {
                    DragMode::Move => {
                        self.wins[idx].x = d.bx + dx;
                        self.wins[idx].y = d.by + dy;
                    }
                    DragMode::Resize => {
                        self.wins[idx].w = d.bw + dx;
                        self.wins[idx].h = d.bh + dy;
                    }
                }
                self.clamp(idx);
                self.captured = true;
                return;
            }
        }

        // New press: hit the topmost open window first.
        let press = ui.interact(0.0, 0.0, self.sw, self.sh).pressed;
        if !press {
            return;
        }
        let mut order = self.z_order();
        order.reverse(); // front-to-back
        for idx in order {
            let (x, y, w, h) = {
                let win = &self.wins[idx];
                (win.x, win.y, win.w, win.h)
            };
            if !UiBuilder::hit(x, y, w, h, mx, my) {
                continue;
            }
            self.bring_to_front(idx);
            self.captured = true;
            // Close box: right end of the title strip.
            let cb = TITLE_H;
            if UiBuilder::hit(x + w - cb, y, cb, TITLE_H, mx, my) {
                self.wins[idx].open = false;
                return;
            }
            // Resize gadget: bottom-right corner.
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
            // Title strip: move.
            if UiBuilder::hit(x, y, w - cb, TITLE_H, mx, my) {
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
            return; // topmost hit consumes the press
        }
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
        // Body.
        ui.rect(win.x, win.y, win.w, win.h, style.body);
        ui.border(win.x, win.y, win.w, win.h, 1.5, style.edge);
        // Title bar.
        let tb = if focused {
            style.title_bar_focused
        } else {
            style.title_bar
        };
        ui.rect(win.x, win.y, win.w, TITLE_H, tb);
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
        // Resize gadget.
        ui.rect(
            win.x + win.w - RESIZE_H,
            win.y + win.h - RESIZE_H,
            RESIZE_H,
            RESIZE_H,
            style.resize,
        );
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
}
