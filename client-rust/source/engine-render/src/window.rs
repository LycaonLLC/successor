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

/// Caption strip height. `ui_options.inc` captions are 19 px, all caps,
/// `bold_13`, 6 px left margin.
pub const CAPTION_H: f32 = 19.0;
/// Caption glyph cap height.
pub const CAPTION_TEXT_PX: f32 = 13.0;
/// Caption left margin.
pub const CAPTION_MARGIN: f32 = 6.0;
/// Outer top rail: the caption plus the frame's own inset above the content.
pub const TOP_RAIL: f32 = 29.0;
/// Outer bottom rail.
pub const BOTTOM_RAIL: f32 = 23.0;
/// Left/right content margin.
pub const SIDE_MARGIN: f32 = 6.0;
/// Caption close-control footprint — 16x16 in the original.
pub const CONTROL: f32 = 16.0;
/// Retained name for the caption strip height used by hosts that compute their
/// own insets. Prefer [`WindowManager::content_rect`].
pub const TITLE_H: f32 = TOP_RAIL;
/// Pointer inset used to discover every resize edge and corner.
/// `UIWidget.cpp` RESIZE_MARGIN is 8: a press within 8 px of an edge resizes
/// and a press further inside moves.
pub const RESIZE_H: f32 = 8.0;
/// Workspace icon slot size (`CuiWorkspaceIcon` slots are 32x32 and
/// resolution independent).
pub const ICON_SLOT: f32 = 32.0;
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
    /// Minimized into its workspace icon slot.
    iconified: bool,
    /// Workspace icon slot origin. `None` ⇒ the frame cannot minimize, which
    /// mirrors `CuiWorkspace::iconify` requiring `mediator.getIcon()`.
    icon_slot: Option<(f32, f32)>,
    /// Whether pointer gestures reach this frame. HUD panes register as
    /// chromeless, non-interactive surfaces and only become draggable while
    /// the host has layout editing on.
    interactive: bool,
    /// Whether the frame paints caption, perimeter, and close control. A
    /// chromeless frame occupies its whole rect as content.
    chrome: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ResizeEdges {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DragMode {
    Move,
    Resize(ResizeEdges),
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

/// Colors for frame chrome. Values are measured from the original frame
/// includes and window crops: base tint `#00D6FB`, inset `#01687E`, bright
/// outline `#1CFFFF`, caption ink `#00354F` on the bright rail.
#[derive(Clone, Copy, Debug)]
pub struct WindowStyle {
    pub frame: RectangleStyle,
    /// Unfocused caption rail (inset tone).
    pub title_bar: [u8; 4],
    /// Focused caption rail (base tint).
    pub title_bar_focused: [u8; 4],
    pub edge: [u8; 4],
    /// Ink for caption text and caption controls: dark on the bright rail.
    pub caption_text: [u8; 4],
    /// Ink for chrome text drawn on the pane rather than the rail.
    pub text: [u8; 4],
    pub close: [u8; 4],
    pub resize: [u8; 4],
}

impl Default for WindowStyle {
    fn default() -> Self {
        // The original frame is a translucent teal pane under one bright cyan
        // outline, with the caption rail carrying dark ink. Focus lives in the
        // rail's brightness, never in stacked opaque cards.
        Self {
            frame: RectangleStyle {
                north: [0x1C, 0xFF, 0xFF, 210],
                south: [0x01, 0x68, 0x7E, 220],
                east: [0x01, 0x68, 0x7E, 220],
                west: [0x01, 0x68, 0x7E, 220],
                center: [0x00, 0x38, 0x48, 226],
                north_east: [0x1C, 0xFF, 0xFF, 210],
                north_west: [0x1C, 0xFF, 0xFF, 210],
                south_east: [0x01, 0x68, 0x7E, 220],
                south_west: [0x01, 0x68, 0x7E, 220],
                west_width: 1.0,
                east_width: 1.0,
                north_height: 1.0,
                south_height: 1.0,
            },
            title_bar: [0x01, 0x68, 0x7E, 232],
            title_bar_focused: [0x00, 0xD6, 0xFB, 236],
            edge: [0x1C, 0xFF, 0xFF, 204],
            caption_text: [0x00, 0x35, 0x4F, 255],
            text: [0x97, 0xFF, 0xFF, 255],
            close: [0x00, 0x35, 0x4F, 255],
            resize: [0x1C, 0xFF, 0xFF, 220],
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
    geometry_dirty: bool,
    last_icon_click: Option<(usize, u64)>,
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
            geometry_dirty: false,
            last_icon_click: None,
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
            iconified: false,
            icon_slot: None,
            interactive: true,
            chrome: true,
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

    /// Replace a title without disturbing focus or geometry.
    pub fn set_title(&mut self, id: &str, title: &str) {
        if let Some(index) = self.find(id) {
            if self.wins[index].title != title {
                self.wins[index].title.clear();
                self.wins[index].title.push_str(title);
            }
        }
    }

    /// Restore persisted outer bounds. Invalid rows are ignored; the next
    /// viewport update performs the resolution-dependent clamp.
    pub fn set_rect(&mut self, id: &str, bounds: [f32; 4]) -> bool {
        if !bounds.iter().all(|value| value.is_finite()) || bounds[2] <= 0.0 || bounds[3] <= 0.0 {
            return false;
        }
        let Some(index) = self.find(id) else {
            return false;
        };
        let win = &mut self.wins[index];
        win.x = bounds[0];
        win.y = bounds[1];
        win.w = bounds[2].max(win.min_w);
        win.h = bounds[3].max(win.min_h);
        true
    }

    /// Visit every registered window's stable id and preferred (restored)
    /// geometry without allocating in the window manager.
    pub fn for_each_geometry<F: FnMut(&str, [f32; 4])>(&self, mut visit: F) {
        for win in &self.wins {
            let bounds = [win.x, win.y, win.w, win.h];
            visit(&win.id, bounds);
        }
    }

    /// Restore renderer-neutral frame state into an identically registered
    /// manager after GPU/context reconstruction. Fresh registration retains
    /// current icons, titles, and resize floors; geometry, visibility, focus
    /// order, and completed-gesture dirtiness transfer without allocation.
    pub fn restore_workspace_state_from(&mut self, previous: &Self) {
        self.z = previous.z;
        self.sw = previous.sw;
        self.sh = previous.sh;
        self.geometry_dirty = previous.geometry_dirty;
        self.drag = None;
        self.captured = false;
        self.last_icon_click = None;
        for win in &mut self.wins {
            let Some(old) = previous.wins.iter().find(|old| old.id == win.id) else {
                continue;
            };
            win.x = old.x;
            win.y = old.y;
            win.w = old.w;
            win.h = old.h;
            win.open = old.open;
            win.z = old.z;
            win.iconified = old.iconified && win.icon_slot.is_some();
            win.interactive = old.interactive;
            win.chrome = old.chrome;
        }
    }

    /// A completed resize/move marks geometry dirty; an in-progress pointer
    /// frame never does. A changed viewport clamp is persisted separately.
    pub fn take_geometry_dirty(&mut self) -> bool {
        core::mem::take(&mut self.geometry_dirty)
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

    /// Whether pointer gestures reach a frame. HUD panes stay non-interactive
    /// during play so gameplay input passes through, then become movable and
    /// resizable while the host is editing the HUD layout.
    pub fn set_interactive(&mut self, id: &str, interactive: bool) {
        if let Some(index) = self.find(id) {
            self.wins[index].interactive = interactive;
            if !interactive && self.drag.as_ref().is_some_and(|drag| drag.idx == index) {
                self.drag = None;
            }
        }
    }

    pub fn is_interactive(&self, id: &str) -> bool {
        self.find(id)
            .is_some_and(|index| self.wins[index].interactive)
    }

    /// Whether a frame paints window chrome. A chromeless frame draws no
    /// caption, perimeter, or close control, and its content rect is its whole
    /// rect — the shape HUD panes need.
    pub fn set_chrome(&mut self, id: &str, chrome: bool) {
        if let Some(index) = self.find(id) {
            self.wins[index].chrome = chrome;
        }
    }

    pub fn has_chrome(&self, id: &str) -> bool {
        self.find(id).is_some_and(|index| self.wins[index].chrome)
    }

    pub fn any_open(&self) -> bool {
        self.wins.iter().any(|w| w.open)
    }

    fn bring_to_front(&mut self, idx: usize) {
        self.z += 1;
        self.wins[idx].z = self.z;
    }

    /// Draw-order rank of an open window: 0 is furthest back. Composited 3D
    /// surfaces key their layer off this so a viewer paints over its own
    /// panel but under every window stacked above it.
    pub fn z_rank(&self, id: &str) -> Option<usize> {
        let target = self.wins.iter().find(|win| win.open && win.id == id)?;
        Some(
            self.wins
                .iter()
                .filter(|win| win.open && win.z < target.z)
                .count(),
        )
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

    fn clamp(&mut self, idx: usize) -> bool {
        let win = &mut self.wins[idx];
        let before = [win.x, win.y, win.w, win.h];
        let vw = self.sw;
        let vh = self.sh;
        win.w = win.w.clamp(win.min_w.min(vw), vw);
        win.h = win.h.clamp(win.min_h.min(vh), vh);
        win.x = win.x.clamp(0.0, (vw - win.w).max(0.0));
        win.y = win.y.clamp(0.0, (vh - win.h).max(0.0));
        before != [win.x, win.y, win.w, win.h]
    }

    fn resize_edges(win: &Win, mx: f32, my: f32) -> Option<ResizeEdges> {
        let edges = ResizeEdges {
            left: mx <= win.x + RESIZE_H,
            right: mx >= win.x + win.w - RESIZE_H,
            top: my <= win.y + RESIZE_H,
            bottom: my >= win.y + win.h - RESIZE_H,
        };
        (edges.left || edges.right || edges.top || edges.bottom).then_some(edges)
    }

    fn resize_drag(&mut self, idx: usize, edges: ResizeEdges, drag: [f32; 6], delta: [f32; 2]) {
        let [bx, by, bw, bh, min_w, min_h] = drag;
        let [dx, dy] = delta;
        let right = bx + bw;
        let bottom = by + bh;
        let mut x = bx;
        let mut y = by;
        let mut w = bw;
        let mut h = bh;

        if edges.left {
            x = (bx + dx).clamp(0.0, right - min_w.min(self.sw));
            w = right - x;
        } else if edges.right {
            w = (bw + dx).clamp(min_w.min(self.sw), self.sw - bx);
        }
        if edges.top {
            y = (by + dy).clamp(0.0, bottom - min_h.min(self.sh));
            h = bottom - y;
        } else if edges.bottom {
            h = (bh + dy).clamp(min_h.min(self.sh), self.sh - by);
        }

        let win = &mut self.wins[idx];
        win.x = x;
        win.y = y;
        win.w = w;
        win.h = h;
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

    /// Resolve focus, move, all-edge resize, close, and workspace attraction.
    /// Pointer presses are tested against the frontmost window.
    pub fn update_at(&mut self, ui: &UiBuilder, screen_w: u32, screen_h: u32, now_ms: u64) {
        let next_sw = screen_w.max(1) as f32;
        let next_sh = screen_h.max(1) as f32;
        let viewport_changed = self.sw != next_sw || self.sh != next_sh;
        self.sw = next_sw;
        self.sh = next_sh;
        if viewport_changed {
            let mut changed = false;
            for index in 0..self.wins.len() {
                changed |= self.clamp(index);
            }
            self.geometry_dirty |= changed;
        }
        self.captured = false;
        let (mx, my) = ui.mouse();
        let state = ui.interact(0.0, 0.0, self.sw, self.sh);
        let down = state.held;

        if self.drag.is_some() {
            if !down {
                self.drag = None;
                self.geometry_dirty = true;
            } else {
                let (idx, mode, mx0, my0, bx, by, bw, bh) = {
                    let drag = self.drag.as_ref().expect("drag checked");
                    (
                        drag.idx, drag.mode, drag.mx0, drag.my0, drag.bx, drag.by, drag.bw, drag.bh,
                    )
                };
                let delta = [mx - mx0, my - my0];
                match mode {
                    DragMode::Move => {
                        self.wins[idx].x = bx + delta[0];
                        self.wins[idx].y = by + delta[1];
                        self.clamp(idx);
                        self.snap_move(idx);
                    }
                    DragMode::Resize(edges) => {
                        let min_w = self.wins[idx].min_w;
                        let min_h = self.wins[idx].min_h;
                        self.resize_drag(idx, edges, [bx, by, bw, bh, min_w, min_h], delta);
                    }
                }
                self.captured = true;
                return;
            }
        }

        if !state.pressed {
            return;
        }
        // A workspace icon restores only on a double click
        // (`CuiWorkspaceIcon::ProcessMessage` → `restoreFromIcon`).
        if let Some(index) = self.icon_slot_at(mx, my) {
            self.captured = true;
            let double = self.last_icon_click.is_some_and(|(last_index, last_ms)| {
                last_index == index && now_ms.saturating_sub(last_ms) <= DOUBLE_CLICK_MS
            });
            if double {
                self.wins[index].iconified = false;
                self.bring_to_front(index);
                self.last_icon_click = None;
            } else {
                self.last_icon_click = Some((index, now_ms));
            }
            return;
        }
        let target = self
            .wins
            .iter()
            .enumerate()
            .filter(|(_, win)| {
                win.open
                    && win.interactive
                    && !win.iconified
                    && UiBuilder::hit(win.x, win.y, win.w, win.h, mx, my)
            })
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
        // The 16x16 close control is flush to the rail's right edge, in the
        // same place `draw_chrome` paints it. A chromeless frame has no rail
        // and no close control, so its whole body is the move surface — the
        // unlocked `AcceptsMoveFromChildren` behaviour of the original's
        // `SwgCuiLockableMediator`.
        let chromeless = !self.wins[idx].chrome;
        let close_x = if chromeless {
            x + w
        } else {
            x + w - 2.0 - CONTROL
        };
        let control_y = y + 1.0 + (CAPTION_H - CONTROL) * 0.5;
        let resize_edges = Self::resize_edges(&self.wins[idx], mx, my);
        let on_outer_border =
            mx <= x + 2.0 || mx >= x + w - 2.0 || my <= y + 2.0 || my >= y + h - 2.0;
        if on_outer_border {
            if let Some(edges) = resize_edges {
                self.drag = Some(Drag {
                    idx,
                    mode: DragMode::Resize(edges),
                    mx0: mx,
                    my0: my,
                    bx: x,
                    by: y,
                    bw: w,
                    bh: h,
                });
                return;
            }
        }
        if !chromeless && UiBuilder::hit(close_x, control_y, CONTROL, CONTROL, mx, my) {
            self.wins[idx].open = false;
            self.drag = None;
            return;
        }
        if let Some(edges) = resize_edges {
            self.drag = Some(Drag {
                idx,
                mode: DragMode::Resize(edges),
                mx0: mx,
                my0: my,
                bx: x,
                by: y,
                bw: w,
                bh: h,
            });
            return;
        }
        let move_h = if chromeless { h } else { CAPTION_H + 2.0 };
        if UiBuilder::hit(x, y, close_x - x, move_h, mx, my) {
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

    /// Compatibility entry for deterministic tests that do not model time.
    pub fn update(&mut self, ui: &UiBuilder, screen_w: u32, screen_h: u32) {
        self.update_at(ui, screen_w, screen_h, 0);
    }

    /// Whether this frame's pointer press/drag landed on a window (so the host
    /// should not also treat it as a background/HUD click).
    pub fn pointer_captured(&self) -> bool {
        self.captured
    }

    /// Whether an open frame sits under this point right now.
    ///
    /// `pointer_captured` only latches on the frame a press is processed, and
    /// the host reads it before the windows run, so on the press itself it
    /// still reads false and the click reaches the world behind the panel.
    /// This is the same hit test the press uses, answerable at any time.
    pub fn covers(&self, x: f32, y: f32) -> bool {
        self.wins.iter().any(|win| {
            win.open
                && win.interactive
                && !win.iconified
                && UiBuilder::hit(win.x, win.y, win.w, win.h, x, y)
        })
    }

    /// Id of the frontmost open frame (the focused one), if any.
    pub fn focused_id(&self) -> Option<&str> {
        self.focused_index()
            .map(|index| self.wins[index].id.as_str())
    }

    fn focused_index(&self) -> Option<usize> {
        self.wins
            .iter()
            .enumerate()
            .filter(|(_, win)| win.open && !win.iconified)
            .max_by_key(|(_, win)| win.z)
            .map(|(index, _)| index)
    }

    /// Index of the open, iconified frame whose workspace icon slot contains
    /// the pointer.
    fn icon_slot_at(&self, mx: f32, my: f32) -> Option<usize> {
        self.wins.iter().position(|win| {
            win.open
                && win.iconified
                && win
                    .icon_slot
                    .is_some_and(|(x, y)| UiBuilder::hit(x, y, ICON_SLOT, ICON_SLOT, mx, my))
        })
    }

    /// Press the focused frame's close control, the way `UIPage::ProcessMessage`
    /// presses `FindCancelButton` on an unmodified Escape. Returns the id that
    /// closed so the host can report it; `None` when no frame is focused.
    pub fn close_focused(&mut self) -> Option<String> {
        let index = self.focused_index()?;
        self.wins[index].open = false;
        self.drag = None;
        self.captured = false;
        Some(self.wins[index].id.clone())
    }

    /// Iconify a frame into its workspace icon slot (`CuiWorkspace::iconify`).
    /// Only frames that declare an icon slot can minimize, which is why the
    /// original matrix minimizes the ground radar rather than a plain frame.
    pub fn iconify(&mut self, id: &str) -> bool {
        let Some(index) = self.index_of(id) else {
            return false;
        };
        if self.wins[index].icon_slot.is_none() || self.wins[index].iconified {
            return false;
        }
        self.wins[index].iconified = true;
        self.drag = None;
        true
    }

    /// Restore an iconified frame. `CuiWorkspaceIcon::ProcessMessage` only
    /// restores on `LeftMouseDoubleClick`, so the host must gate this on a real
    /// double click.
    pub fn restore_from_icon(&mut self, id: &str) -> bool {
        let Some(index) = self.index_of(id) else {
            return false;
        };
        if !self.wins[index].iconified {
            return false;
        }
        self.wins[index].iconified = false;
        self.bring_to_front(index);
        true
    }

    pub fn is_iconified(&self, id: &str) -> bool {
        self.index_of(id)
            .is_some_and(|index| self.wins[index].iconified)
    }

    /// Screen rect of a frame's workspace icon slot, when it has one.
    pub fn icon_rect(&self, id: &str) -> Option<[f32; 4]> {
        let index = self.index_of(id)?;
        let (x, y) = self.wins[index].icon_slot?;
        Some([x, y, ICON_SLOT, ICON_SLOT])
    }

    /// Give a frame a workspace icon slot, making it minimizable.
    pub fn set_icon_slot(&mut self, id: &str, slot: Option<(f32, f32)>) {
        if let Some(index) = self.index_of(id) {
            self.wins[index].icon_slot = slot;
            if slot.is_none() {
                self.wins[index].iconified = false;
            }
        }
    }

    fn index_of(&self, id: &str) -> Option<usize> {
        self.wins.iter().position(|win| win.id == id)
    }

    /// Content rect for a frame id: the caller draws inside this instead of
    /// re-deriving the frame insets (`ui_options.inc`: 29 px top rail, 23 px
    /// bottom rail, 6/7 px side margins).
    pub fn content_rect(&self, id: &str) -> Option<[f32; 4]> {
        let index = self.index_of(id)?;
        Some(Self::content_rect_of(&self.wins[index]))
    }

    fn content_rect_of(win: &Win) -> [f32; 4] {
        if !win.chrome {
            return [win.x, win.y, win.w.max(0.0), win.h.max(0.0)];
        }
        [
            win.x + SIDE_MARGIN,
            win.y + TOP_RAIL,
            (win.w - SIDE_MARGIN * 2.0 - 1.0).max(0.0),
            (win.h - TOP_RAIL - BOTTOM_RAIL).max(0.0),
        ]
    }

    /// Draw one frame's chrome and return its content rect.
    ///
    /// Grammar comes from the original `ui_options.inc` frame: a 29 px top rail
    /// carrying a 19 px all-caps caption in dark ink over the bright rail, a
    /// 23 px bottom rail, one bright hairline perimeter, and a persistent
    /// 16x16 close control flush to the caption's right edge. Nothing else is
    /// outlined — the perimeter is the only box.
    pub fn draw_chrome(&self, ui: &mut UiBuilder, idx: usize, style: WindowStyle) -> [f32; 4] {
        let win = &self.wins[idx];
        let (pointer_x, pointer_y) = ui.mouse();

        // Minimized: the frame collapses to its workspace icon slot and the
        // content rect goes empty, so surface content draws nothing. This
        // resolves before chrome, so a chromeless pane with an icon slot still
        // shows its icon.
        if win.iconified {
            if let Some((slot_x, slot_y)) = win.icon_slot {
                ui.rect(slot_x, slot_y, ICON_SLOT, ICON_SLOT, style.title_bar);
                ui.rect(slot_x, slot_y, ICON_SLOT, 1.0, style.edge);
                if let Some((column, row)) = win.icon {
                    ui.icon(
                        column,
                        row,
                        slot_x + 5.0,
                        slot_y + 5.0,
                        ICON_SLOT - 10.0,
                        ICON_SLOT - 10.0,
                        style.text,
                    );
                }
                return [slot_x, slot_y, 0.0, 0.0];
            }
            return [win.x, win.y, 0.0, 0.0];
        }

        // Chromeless frames (HUD panes) paint no chrome: the surface owns its
        // whole rect and supplies its own look.
        if !win.chrome {
            return Self::content_rect_of(win);
        }

        let focused = self.focused_index() == Some(idx);
        let resize_hover = Self::resize_edges(win, pointer_x, pointer_y).is_some();
        let right = win.x + win.w;
        let bottom = win.y + win.h;

        // Drop shadow, translucent pane, one bright perimeter.
        ui.rect(win.x + 3.0, win.y + 4.0, win.w, win.h, [0, 0, 0, 96]);
        ui.nine_slice(win.x, win.y, win.w, win.h, &style.frame);
        ui.border(win.x, win.y, win.w, win.h, 1.0, style.edge);

        // Caption rail: bright when focused, inset when not. The caption itself
        // is dark ink on the rail, which is what the original does.
        let rail = if focused {
            style.title_bar_focused
        } else {
            style.title_bar
        };
        ui.rect(win.x + 1.0, win.y + 1.0, win.w - 2.0, CAPTION_H, rail);
        ui.rect(
            win.x + 1.0,
            win.y + TOP_RAIL - 1.0,
            win.w - 2.0,
            1.0,
            style.edge,
        );
        // Bottom rail: same inset tone, one hairline above it.
        ui.rect(
            win.x + 1.0,
            bottom - BOTTOM_RAIL,
            win.w - 2.0,
            1.0,
            style.edge,
        );

        let mut text_x = win.x + CAPTION_MARGIN;
        if let Some((column, row)) = win.icon {
            let glyph = CAPTION_H - 6.0;
            ui.icon(
                column,
                row,
                win.x + CAPTION_MARGIN,
                win.y + 1.0 + (CAPTION_H - glyph) * 0.5,
                glyph,
                glyph,
                style.caption_text,
            );
            text_x = win.x + CAPTION_MARGIN + glyph + 4.0;
        }
        let caption_px = CAPTION_TEXT_PX / 7.0;
        let controls_w = CONTROL + 2.0;
        let caption_w = (right - text_x - controls_w - 4.0).max(0.0);
        let (caption, clipped) = clip_to(ui, &win.title, caption_px, caption_w);
        let caption_y = win.y + 1.0 + (CAPTION_H - CAPTION_TEXT_PX) * 0.5;
        let end = ui.text(caption, text_x, caption_y, caption_px, style.caption_text);
        if clipped {
            ui.text("...", end, caption_y, caption_px, style.caption_text);
        }

        let close_x = right - 2.0 - CONTROL;
        let top = win.y + 1.0 + (CAPTION_H - CONTROL) * 0.5;
        // Close: an X inside its persistent 16x16 cancel control.
        ui.line(
            close_x + 4.0,
            top + 4.0,
            close_x + CONTROL - 4.0,
            top + CONTROL - 4.0,
            1.4,
            style.close,
        );
        ui.line(
            close_x + CONTROL - 4.0,
            top + 4.0,
            close_x + 4.0,
            top + CONTROL - 4.0,
            1.4,
            style.close,
        );

        if resize_hover {
            ui.line(
                right - 12.0,
                bottom - 3.0,
                right - 3.0,
                bottom - 12.0,
                1.2,
                style.resize,
            );
            ui.line(
                right - 7.0,
                bottom - 3.0,
                right - 3.0,
                bottom - 7.0,
                1.2,
                style.resize,
            );
        }

        Self::content_rect_of(win)
    }
}

/// Longest prefix of `text` that fits `max_w`, and whether it was cut.
fn clip_to<'a>(ui: &UiBuilder, text: &'a str, px: f32, max_w: f32) -> (&'a str, bool) {
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

    /// HUD panes register chromeless and non-interactive: gameplay keeps the
    /// pointer until the pane is unlocked, and then the whole body drags.
    #[test]
    fn chromeless_pane_takes_no_pointer_until_unlocked() {
        let mut m = wm();
        m.set_chrome("inv", false);
        m.set_interactive("inv", false);
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);

        // Press well inside the body: locked, so nothing is captured or moved.
        ui.set_input(200.0, 200.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        assert!(!m.pointer_captured(), "a locked HUD pane must pass clicks");
        ui.set_input(240.0, 230.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        assert_eq!(m.rect("inv"), Some([100.0, 100.0, 300.0, 200.0]));

        // Unlocked, the same body press drags — no caption strip needed.
        ui.set_input(0.0, 0.0, false);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        m.set_interactive("inv", true);
        ui.set_input(200.0, 200.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        assert!(m.pointer_captured());
        ui.set_input(240.0, 230.0, true);
        ui.begin(1280, 720);
        m.update(&ui, 1280, 720);
        assert_eq!(m.rect("inv"), Some([140.0, 130.0, 300.0, 200.0]));
    }

    /// A chromeless pane owns its whole rect: no rails, no close control.
    #[test]
    fn chromeless_pane_content_is_the_whole_frame() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(1280, 720);
        let idx = m.find("inv").unwrap();

        let framed = m.draw_chrome(&mut ui, idx, WindowStyle::default());
        assert_eq!(framed[1], 100.0 + TOP_RAIL);
        let framed_quads = ui.quads;

        m.set_chrome("inv", false);
        let bare = m.draw_chrome(&mut ui, idx, WindowStyle::default());
        assert_eq!(bare, [100.0, 100.0, 300.0, 200.0]);
        assert_eq!(
            ui.quads, framed_quads,
            "a chromeless frame must not paint chrome"
        );
        assert_eq!(m.content_rect("inv"), Some(bare));
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
    fn every_window_edge_resizes_from_its_anchored_side() {
        let mut manager = wm();
        manager.open("inv");
        let mut ui = UiBuilder::new(ATLAS);

        // Left edge: the right side remains fixed at x=400.
        ui.set_input(102.0, 180.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        ui.set_input(62.0, 180.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        let left = manager.rect("inv").unwrap();
        assert_eq!(left, [60.0, 100.0, 340.0, 200.0]);

        // Finish that gesture, restore, then use the top edge. The bottom
        // remains fixed at y=300.
        ui.set_input(62.0, 180.0, false);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert!(manager.set_rect("inv", [100.0, 100.0, 300.0, 200.0]));
        ui.set_input(250.0, 102.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        ui.set_input(250.0, 72.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert_eq!(manager.rect("inv").unwrap(), [100.0, 70.0, 300.0, 230.0]);

        // Right and bottom edges grow away from the fixed origin.
        ui.set_input(250.0, 72.0, false);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert!(manager.set_rect("inv", [100.0, 100.0, 300.0, 200.0]));
        ui.set_input(398.0, 180.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        ui.set_input(448.0, 180.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert_eq!(manager.rect("inv").unwrap(), [100.0, 100.0, 350.0, 200.0]);

        ui.set_input(448.0, 180.0, false);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert!(manager.set_rect("inv", [100.0, 100.0, 300.0, 200.0]));
        ui.set_input(250.0, 298.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        ui.set_input(250.0, 338.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert_eq!(manager.rect("inv").unwrap(), [100.0, 100.0, 300.0, 240.0]);
    }

    #[test]
    fn completed_window_gesture_marks_serializable_geometry_dirty() {
        let mut manager = wm();
        manager.open("inv");
        assert!(!manager.take_geometry_dirty());
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        ui.set_input(150.0, 140.0, true);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert!(
            !manager.take_geometry_dirty(),
            "in-flight drag is not persisted"
        );
        ui.set_input(150.0, 140.0, false);
        ui.begin(1280, 720);
        manager.update(&ui, 1280, 720);
        assert!(manager.take_geometry_dirty());

        let mut rows = Vec::new();
        manager.for_each_geometry(|id, bounds| rows.push((id.to_string(), bounds)));
        assert_eq!(rows[0], ("inv".to_string(), [140.0, 130.0, 300.0, 200.0]));
    }

    #[test]
    fn context_rebuild_preserves_completed_layout_open_order_and_dirty_save() {
        let mut previous = wm();
        previous.open("char");
        previous.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        previous.update(&ui, 1280, 720);
        ui.set_input(150.0, 140.0, true);
        ui.begin(1280, 720);
        previous.update(&ui, 1280, 720);
        ui.set_input(150.0, 140.0, false);
        ui.begin(1280, 720);
        previous.update(&ui, 1280, 720);

        let mut rebuilt = wm();
        rebuilt.restore_workspace_state_from(&previous);

        assert_eq!(rebuilt.rect("inv"), Some([140.0, 130.0, 300.0, 200.0]));
        assert!(rebuilt.is_open("char"));
        assert!(rebuilt.is_open("inv"));
        let order = rebuilt.z_order();
        assert_eq!(rebuilt.window_id(order[0]), "char");
        assert_eq!(rebuilt.window_id(order[1]), "inv");
        assert!(!rebuilt.pointer_captured());
        assert!(rebuilt.take_geometry_dirty());
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
    fn title_double_click_keeps_standard_frame_dragging() {
        let mut m = wm();
        m.open("inv");
        let mut ui = UiBuilder::new(ATLAS);
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 100);
        ui.set_input(110.0, 110.0, false);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 140);

        // A second title press stays a held move rather than maximizing.
        ui.set_input(110.0, 110.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 200);
        ui.set_input(150.0, 140.0, true);
        ui.begin(1280, 720);
        m.update_at(&ui, 1280, 720, 220);

        assert_eq!(m.rect("inv"), Some([140.0, 130.0, 300.0, 200.0]));
    }
}
