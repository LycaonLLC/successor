//! Deterministic first-run HUD placement.
//!
//! [`compute`] is deliberately a registration policy, not a live layout pass:
//! the workspace manager owns every persistent pane after first registration or
//! restore. Its defaults preserve the sparse arrangement measured from the
//! clean original-client world-entry capture while guaranteeing that the real
//! pane floors remain fully visible and non-overlapping at every supported
//! framebuffer.
//!
//! The player plate is flush top-left, the command bar stays as near the
//! top-centre as its neighbour gutter allows, and the target/queue hold the
//! right rail. At 800×600, the adaptable panes contract toward their measured
//! floors rather than crossing bands.

use successor_engine_render::window::{BOTTOM_RAIL, SIDE_MARGIN, TOP_RAIL};

/// Screen edge gutter for panes that are not intentionally flush.
pub const MARGIN: f32 = 6.0;
/// Gap kept between neighbouring first-run panes.
pub const GUTTER: f32 = 7.0;

/// Measured command bar default and source-verified resize floor.
pub const BAR_W: f32 = 474.0;
pub const BAR_H: f32 = 64.0;
pub const BAR_MIN_W: f32 = 260.0;
pub const BAR_MIN_H: f32 = 48.0;
/// Player status plate default and resize floor. Keep these in lockstep with
/// `plate::draw_status_plate`: the manager cannot register a smaller default
/// than the renderer's measured content well.
pub const PLATE_W: f32 = super::plate::PLATE_W;
pub const PLATE_H: f32 = super::plate::PLATE_H;
pub const PLATE_MIN_W: f32 = 240.0;
pub const PLATE_MIN_H: f32 = 120.0;
/// Target status stays in the top-right rail, beneath the command bar.
pub const TARGET_W: f32 = 280.0;
pub const TARGET_H: f32 = 84.0;
pub const TARGET_MIN_W: f32 = 200.0;
pub const TARGET_MIN_H: f32 = 64.0;
pub const CHAT_W: f32 = 512.0;
pub const CHAT_H: f32 = 145.0;
pub const CHAT_MIN_W: f32 = 160.0;
pub const CHAT_MIN_H: f32 = 96.0;
pub const QUEUE_W: f32 = 232.0;
pub const QUEUE_H: f32 = 180.0;
pub const QUEUE_MIN_W: f32 = 160.0;
pub const QUEUE_MIN_H: f32 = 60.0;
pub const STRIP_W: f32 = 296.0;
pub const STRIP_H: f32 = 49.0;
pub const STRIP_MIN_W: f32 = 200.0;
pub const STRIP_MIN_H: f32 = 32.0;
/// Measured radar content square. Its chromeless workspace rect preserves the
/// former content lane, including the artwork's intentional surrounding air.
pub const RADAR_SIZE: f32 = 148.0;
/// Measured left edge of the radar content (capture: `x=21..169`).
pub const RADAR_INSET: f32 = 21.0;
/// Space between the radar workspace lane and the chat console.
pub const RADAR_CHAT_GUTTER: f32 = 8.0;
/// Window dock rail (a Successor addition, not a persistent HUD pane).
pub const DOCK_BTN: f32 = 30.0;

/// Resolved HUD geometry for one framebuffer. Every rect is `[x, y, w, h]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HudLayout {
    /// Player status plate, top-left.
    pub plate: [f32; 4],
    /// Target plate, top-right beneath the command bar.
    pub target: [f32; 4],
    /// Command bar (toolbar slots), fixed size, top-center.
    pub bar: [f32; 4],
    /// Tactical radar's managed outer frame, fixed bottom-left.
    pub radar: [f32; 4],
    /// Chat console, bottom, clear of the radar frame and status strip.
    pub chat: [f32; 4],
    /// Command/receipt status strip, bottom-right.
    pub strip: [f32; 4],
    /// Ability queue, under the target plate.
    pub queue: [f32; 4],
    /// Window dock rail, right edge.
    pub dock: [f32; 4],
    /// Interaction chip, bottom-center above the chat band.
    pub chip: [f32; 2],
    /// Toast/banner baseline, above the chip.
    pub toast: [f32; 2],
    /// First-steps guidance rail, left edge below the plate.
    pub guidance: [f32; 2],
}

/// Interpolate only through the compact 800→1024 band. Larger viewports retain
/// the measured defaults; 800×600 reaches the source-verified resize floor.
fn compact_dimension(floor: f32, default: f32, viewport_w: f32) -> f32 {
    let progress = ((viewport_w - 800.0) / (1024.0 - 800.0)).clamp(0.0, 1.0);
    floor + (default - floor) * progress
}

/// Resolve first-run HUD geometry for a framebuffer.
pub fn compute(viewport_w: f32, viewport_h: f32) -> HudLayout {
    let vw = viewport_w.max(320.0);
    let vh = viewport_h.max(240.0);

    // Top band: player status is flush-left. The command bar stays centred
    // until that would cross the player gutter; the target uses the separate
    // top-right rail below it, matching the existing Successor arrangement.
    let plate_w = compact_dimension(PLATE_MIN_W, PLATE_W, vw);
    let plate_h = compact_dimension(PLATE_MIN_H, PLATE_H, vw);
    let plate = [0.0, 0.0, plate_w, plate_h];

    let target_w = compact_dimension(TARGET_MIN_W, TARGET_W, vw);
    let target_h = compact_dimension(TARGET_MIN_H, TARGET_H, vw);
    let target = [vw - MARGIN - target_w, BAR_H + GUTTER, target_w, target_h];

    let bar_room = (vw - plate_w - GUTTER - MARGIN).max(BAR_MIN_W);
    let bar_w = BAR_W.min(bar_room).max(BAR_MIN_W);
    let bar_x = ((vw - bar_w) * 0.5)
        .max(plate[0] + plate[2] + GUTTER)
        .min(vw - MARGIN - bar_w);
    let bar = [bar_x, 0.0, bar_w, BAR_H];

    // Preserve the radar's pre-existing 148 px instrument lane. The manager
    // now suppresses workspace chrome, but the surrounding lane still keeps
    // the scope and coordinate rail at the measured visual position.
    let radar_content_size = RADAR_SIZE.min(vw * 0.3).min(vh * 0.3);
    let radar_w = radar_content_size + SIDE_MARGIN * 2.0 + 1.0;
    let radar_h = radar_content_size + TOP_RAIL + BOTTOM_RAIL;
    let radar = [
        (RADAR_INSET - SIDE_MARGIN).max(0.0),
        vh - radar_h,
        radar_w,
        radar_h,
    ];

    // Bottom band: radar → chat → notification strip, each separated by its
    // gutter. The compact strip releases horizontal room to chat at 800 px.
    let strip_w = compact_dimension(STRIP_MIN_W, STRIP_W, vw);
    let strip_h = compact_dimension(STRIP_MIN_H, STRIP_H, vw);
    let strip = [
        vw - strip_w - MARGIN,
        vh - strip_h - MARGIN,
        strip_w,
        strip_h,
    ];
    let chat_x = radar[0] + radar[2] + RADAR_CHAT_GUTTER;
    let chat_room = (strip[0] - GUTTER - chat_x).max(CHAT_MIN_W);
    let chat_w = CHAT_W.min(chat_room);
    let chat_h = compact_dimension(CHAT_MIN_H, CHAT_H, vw);
    let chat = [chat_x, vh - chat_h - MARGIN, chat_w, chat_h];

    // The ability queue stays inboard of the fixed launcher rail, directly
    // beneath the top-right target plate.
    let queue_w = compact_dimension(QUEUE_MIN_W, QUEUE_W, vw);
    let queue_x = (vw - MARGIN - DOCK_BTN - GUTTER - queue_w).max(MARGIN);
    let queue_y = target[1] + target[3] + GUTTER;
    let queue_h = QUEUE_H.min((chat[1] - queue_y - GUTTER).max(QUEUE_MIN_H));
    let queue = [queue_x, queue_y, queue_w, queue_h];

    // The dock remains a fixed Successor launcher, not a manager-owned HUD
    // pane. Its geometry is retained solely for the existing dock renderer.
    let dock_h = (vh * 0.5).min(360.0);
    let dock = [
        vw - MARGIN - DOCK_BTN,
        (vh - dock_h) * 0.5,
        DOCK_BTN,
        dock_h,
    ];

    // Transient overlays are intentionally not registration defaults.
    let chip_y = (chat[1] - 26.0).max(bar[1] + bar[3] + GUTTER);
    let chip = [vw * 0.5, chip_y];
    let toast = [vw * 0.5, (chip_y - 24.0).max(bar[1] + bar[3] + GUTTER)];
    let guidance = [MARGIN, plate[1] + plate[3] + 24.0];

    HudLayout {
        plate,
        target,
        bar,
        radar,
        chat,
        strip,
        queue,
        dock,
        chip,
        toast,
        guidance,
    }
}

/// Whether two rects overlap.
fn overlaps(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

impl HudLayout {
    /// Persistent manager-owned defaults, for collision checks and host wiring.
    /// The fixed window-launcher dock is intentionally excluded.
    pub fn rects(&self) -> [(&'static str, [f32; 4]); 7] {
        [
            ("plate", self.plate),
            ("target", self.target),
            ("bar", self.bar),
            ("radar", self.radar),
            ("chat", self.chat),
            ("strip", self.strip),
            ("queue", self.queue),
        ]
    }

    /// First overlapping pair, if any. `None` means the layout is legal.
    pub fn first_overlap(&self) -> Option<(&'static str, &'static str)> {
        let rects = self.rects();
        for (index, (name, rect)) in rects.iter().enumerate() {
            for (other_name, other) in rects.iter().skip(index + 1) {
                if overlaps(*rect, *other) {
                    return Some((name, other_name));
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every framebuffer required by the persistent-HUD contract.
    const SIZES: [(f32, f32); 4] = [
        (800.0, 600.0),
        (1024.0, 768.0),
        (1280.0, 1024.0),
        (1600.0, 1200.0),
    ];

    #[test]
    fn no_hud_element_overlaps_at_any_supported_framebuffer() {
        for (vw, vh) in SIZES {
            let layout = compute(vw, vh);
            assert_eq!(
                layout.first_overlap(),
                None,
                "overlap at {vw}x{vh}: {layout:?}"
            );
        }
    }

    #[test]
    fn every_element_stays_on_screen() {
        for (vw, vh) in SIZES {
            let layout = compute(vw, vh);
            for (name, [x, y, w, h]) in layout.rects() {
                assert!(
                    x >= 0.0 && y >= 0.0 && x + w <= vw + 0.5 && y + h <= vh + 0.5,
                    "{name} escapes {vw}x{vh}: {:?}",
                    [x, y, w, h]
                );
            }
        }
    }

    #[test]
    fn defaults_contract_toward_floors_without_crossing_bands() {
        let compact = compute(800.0, 600.0);
        let measured = compute(1024.0, 768.0);
        let large = compute(1600.0, 1200.0);

        assert_eq!(compact.plate[2], PLATE_MIN_W);
        assert_eq!(compact.plate[3], PLATE_MIN_H);
        assert_eq!(compact.target[2], TARGET_MIN_W);
        assert_eq!(compact.target[3], TARGET_MIN_H);
        assert_eq!(compact.queue[2], QUEUE_MIN_W);
        assert_eq!(compact.strip[2], STRIP_MIN_W);
        assert_eq!(compact.strip[3], STRIP_MIN_H);

        assert_eq!(measured.plate[2], PLATE_W);
        assert_eq!(measured.plate[3], PLATE_H);
        assert_eq!(measured.target[2], TARGET_W);
        assert_eq!(measured.target[3], TARGET_H);
        assert_eq!(measured.bar[2], BAR_W);
        assert_eq!(measured.bar[3], BAR_H);
        assert_eq!(measured.chat[2], CHAT_W);
        assert_eq!(measured.chat[3], CHAT_H);
        assert_eq!(measured.queue[2], QUEUE_W);
        assert_eq!(measured.strip[2], STRIP_W);
        assert_eq!(measured.strip[3], STRIP_H);

        // Above the compact band, measured defaults stay fixed. The radar lane
        // is fixed at every supported framebuffer.
        assert_eq!(large.bar[2], BAR_W);
        assert_eq!(large.plate[2], PLATE_W);
        assert_eq!(large.chat[2], CHAT_W);
        assert_eq!(large.radar[2], measured.radar[2]);
        assert_eq!(large.radar[3], measured.radar[3]);

        // A centre-preferred bar may shift right only enough to clear the
        // flush player plate; it never crosses that required gutter.
        for (vw, vh) in SIZES {
            let layout = compute(vw, vh);
            assert!(layout.bar[0] >= layout.plate[0] + layout.plate[2] + GUTTER);
            assert!(
                (layout.bar[0] + layout.bar[2] * 0.5) >= vw * 0.5,
                "command bar crossed left of centre at {vw}x{vh}"
            );
        }
    }

    #[test]
    fn matches_the_measured_1024_registration_defaults() {
        let layout = compute(1024.0, 768.0);
        assert_eq!(layout.plate, [0.0, 0.0, PLATE_W, PLATE_H]);
        assert_eq!(layout.bar, [307.0, 0.0, BAR_W, BAR_H]);
        assert_eq!(layout.target, [738.0, 71.0, TARGET_W, TARGET_H]);
        assert_eq!(layout.queue, [749.0, 162.0, QUEUE_W, QUEUE_H]);

        // Chat stays clear of the complete radar lane and status strip.
        assert_eq!(
            layout.chat[0],
            layout.radar[0] + layout.radar[2] + RADAR_CHAT_GUTTER
        );
        assert_eq!(layout.chat[2], CHAT_W);
        assert_eq!(layout.chat[3], CHAT_H);
        assert_eq!(layout.chat[1], 617.0);

        // The registration rect preserves the original instrument lane even
        // though the manager now suppresses workspace chrome for HUD panes.
        assert_eq!(layout.radar[2], RADAR_SIZE + SIDE_MARGIN * 2.0 + 1.0);
        assert_eq!(layout.radar[3], RADAR_SIZE + TOP_RAIL + BOTTOM_RAIL);
        assert_eq!(layout.radar[1] + layout.radar[3], 768.0);
        assert_eq!(layout.strip, [722.0, 713.0, STRIP_W, STRIP_H]);
    }

    #[test]
    fn the_bottom_center_stack_clears_the_chat_band() {
        for (vw, vh) in SIZES {
            let layout = compute(vw, vh);
            assert!(
                layout.chip[1] + 24.0 <= layout.chat[1] + 0.5,
                "interact chip overlaps chat at {vw}x{vh}"
            );
            assert!(
                layout.toast[1] < layout.chip[1],
                "toast must sit above the chip at {vw}x{vh}"
            );
        }
    }
}
