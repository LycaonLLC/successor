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

use successor_engine_render::window::SIDE_MARGIN;

/// Screen edge gutter for panes that are not intentionally flush.
pub const MARGIN: f32 = 6.0;
/// Gap kept between neighbouring first-run panes.
pub const GUTTER: f32 = 7.0;

/// Framebuffer the HUD sizes were measured against.
pub const REFERENCE_W: f32 = 1024.0;
pub const REFERENCE_H: f32 = 768.0;
/// Ceiling on growth: past this the HUD is simply large, not more readable.
const MAX_UI_SCALE: f32 = 2.0;

/// Uniform HUD scale for a framebuffer.
///
/// Every pane size here was measured off the original client at 1024x768. Held
/// at those literal pixels the whole HUD shrinks into a corner of a large
/// display, so panes grow with the viewport instead. The smaller axis drives
/// the factor so a wide framebuffer cannot push the bottom band off screen,
/// and the floor is 1.0: at or below the reference the measured pixels are
/// used unchanged, which is what the resize-floor contract depends on.
pub fn ui_scale(viewport_w: f32, viewport_h: f32) -> f32 {
    let by_width = viewport_w / REFERENCE_W;
    let by_height = viewport_h / REFERENCE_H;
    by_width.min(by_height).clamp(1.0, MAX_UI_SCALE)
}

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
pub const PLATE_MIN_H: f32 = 46.0;
/// Weapon/magazine pane: its own lane under the player plate, because it only
/// exists while something is wielded.
pub const WEAPON_W: f32 = super::plate::WEAPON_PLATE_W;
pub const WEAPON_H: f32 = super::plate::WEAPON_PLATE_H;
pub const WEAPON_MIN_W: f32 = 160.0;
pub const WEAPON_MIN_H: f32 = 24.0;
/// Group rail: the lane directly beneath the player plate belongs to group
/// members and nothing else. It is sized for the full chip run so a filling
/// group never pushes into the panes below.
pub const GROUP_W: f32 = PLATE_W;
pub const GROUP_H: f32 = super::plate::GROUP_CHIP_H * super::GROUP_CHIP_MAX as f32
    + super::plate::GROUP_CHIP_GAP * (super::GROUP_CHIP_MAX as f32 - 1.0);
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
/// Air above the scope inside its lane. Mirrors `radar::SCOPE_Y`, which is the
/// inset the radar itself draws at; keeping the lane and the renderer in step
/// is what stops the scope sitting off-centre in its own pane.
pub const RADAR_SCOPE_INSET: f32 = 2.0;
/// The radar's registration lane, and its resize floor: the scope is a fixed
/// instrument, so the pane that carries it does not usefully shrink. Both the
/// default and the floor come from here so they cannot drift apart - a floor
/// above the default silently clamps the pane larger on first run.
pub const RADAR_LANE_W: f32 = RADAR_SIZE + SIDE_MARGIN * 2.0 + 1.0;
pub const RADAR_LANE_H: f32 = RADAR_SIZE + super::radar::COORD_RAIL + RADAR_SCOPE_INSET;
/// Window dock rail (a Successor addition, not a persistent HUD pane).
pub const DOCK_BTN: f32 = 30.0;

/// Resolved HUD geometry for one framebuffer. Every rect is `[x, y, w, h]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HudLayout {
    /// Player status plate, top-left.
    pub plate: [f32; 4],
    /// Weapon/magazine pane, directly beneath the plate.
    pub weapon: [f32; 4],
    /// Group member rail, directly beneath the plate.
    pub group: [f32; 4],
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
///
/// The band arithmetic below is written in the measured 1024x768 reference
/// space. Solving it against a reference-sized viewport and scaling the result
/// keeps every anchor exact — `(vw / s) * s == vw`, so a flush edge stays flush
/// — while pane sizes, gutters, and margins all grow together.
pub fn compute(viewport_w: f32, viewport_h: f32) -> HudLayout {
    let scale = ui_scale(viewport_w.max(320.0), viewport_h.max(240.0));
    if scale <= 1.0 {
        return compute_reference(viewport_w, viewport_h);
    }
    compute_reference(viewport_w / scale, viewport_h / scale).scaled(scale)
}

fn compute_reference(viewport_w: f32, viewport_h: f32) -> HudLayout {
    let vw = viewport_w.max(320.0);
    let vh = viewport_h.max(240.0);

    // Top band: player status is flush-left. The command bar stays centred
    // until that would cross the player gutter; the target uses the separate
    // top-right rail below it, matching the existing Successor arrangement.
    let plate_w = compact_dimension(PLATE_MIN_W, PLATE_W, vw);
    let plate_h = compact_dimension(PLATE_MIN_H, PLATE_H, vw);
    let plate = [0.0, 0.0, plate_w, plate_h];

    // The plate's column continues downward: weapon readout, then the group.
    // Each is its own pane, so an unarmed solo player shows one tight plate
    // and nothing else.
    let weapon_y = plate[1] + plate[3] + GUTTER;
    let weapon = [plate[0], weapon_y, plate_w.min(WEAPON_W), WEAPON_H];
    let group_y = weapon[1] + weapon[3] + GUTTER;
    let group = [plate[0], group_y, plate_w, GROUP_H];

    let target_w = compact_dimension(TARGET_MIN_W, TARGET_W, vw);
    let target_h = compact_dimension(TARGET_MIN_H, TARGET_H, vw);

    // The command bar is a fixed twelve-slot rail; narrowing it resizes every
    // slot, so its measured width is not negotiable and the band is planned
    // around it.
    let bar_room = (vw - plate_w - GUTTER - MARGIN).max(BAR_MIN_W);
    let bar_w = BAR_W.min(bar_room).max(BAR_MIN_W);
    let bar_left = plate[0] + plate[2] + GUTTER;

    // Flush top-right, mirroring the player plate's flush top-left: the two are
    // the same kind of readout - you and your mark - so they take opposite
    // corners of one band. Only where the bar still fits between them; below
    // that width the target keeps its old lane under the bar instead of
    // overlapping it.
    let shares_top_band = bar_left + bar_w + GUTTER + target_w <= vw;
    let target = if shares_top_band {
        [vw - target_w, 0.0, target_w, target_h]
    } else {
        [vw - MARGIN - target_w, BAR_H + GUTTER, target_w, target_h]
    };

    let bar_right_stop = if shares_top_band {
        target[0] - GUTTER
    } else {
        vw - MARGIN
    };
    let bar_x = ((vw - bar_w) * 0.5)
        .min(bar_right_stop - bar_w)
        .max(bar_left);
    let bar = [bar_x, 0.0, bar_w, BAR_H];

    // The radar is chromeless: the manager suppresses its caption and footer,
    // so reserving a caption rail and a bottom rail inside its pane only buys
    // 52 px of dead band around the scope. The lane is the scope plus its own
    // coordinate readout, nothing more.
    let radar_content_size = RADAR_SIZE.min(vw * 0.3).min(vh * 0.3);
    let radar_w = radar_content_size + SIDE_MARGIN * 2.0 + 1.0;
    let radar_h = radar_content_size + super::radar::COORD_RAIL + RADAR_SCOPE_INSET;
    let radar = [
        (RADAR_INSET - SIDE_MARGIN).max(0.0),
        vh - radar_h - MARGIN,
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
    let guidance = [MARGIN, group[1] + group[3] + 24.0];

    HudLayout {
        plate,
        weapon,
        group,
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

impl HudLayout {
    /// Multiply every rect and anchor by a uniform factor.
    fn scaled(self, scale: f32) -> Self {
        let rect = |r: [f32; 4]| [r[0] * scale, r[1] * scale, r[2] * scale, r[3] * scale];
        let point = |p: [f32; 2]| [p[0] * scale, p[1] * scale];
        Self {
            plate: rect(self.plate),
            weapon: rect(self.weapon),
            group: rect(self.group),
            target: rect(self.target),
            bar: rect(self.bar),
            radar: rect(self.radar),
            chat: rect(self.chat),
            strip: rect(self.strip),
            queue: rect(self.queue),
            dock: rect(self.dock),
            chip: point(self.chip),
            toast: point(self.toast),
            guidance: point(self.guidance),
        }
    }
}

/// Whether two rects overlap.
fn overlaps(a: [f32; 4], b: [f32; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

impl HudLayout {
    /// Persistent manager-owned defaults, for collision checks and host wiring.
    /// The fixed window-launcher dock is intentionally excluded.
    pub fn rects(&self) -> [(&'static str, [f32; 4]); 8] {
        [
            ("plate", self.plate),
            ("group", self.group),
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

        // Past the reference the HUD grows with the framebuffer instead of
        // shrinking into a corner: every pane is the measured pixel size times
        // the uniform scale, and the radar lane scales with them.
        let scale = ui_scale(1600.0, 1200.0);
        assert!(scale > 1.0, "1600x1200 is above the reference");
        let close = |left: f32, right: f32| (left - right).abs() < 0.01;
        assert!(close(large.bar[2], BAR_W * scale));
        assert!(close(large.plate[2], PLATE_W * scale));
        assert!(close(large.chat[2], CHAT_W * scale));
        assert!(close(large.radar[2], measured.radar[2] * scale));
        assert!(close(large.radar[3], measured.radar[3] * scale));
        // Flush and right-rail anchors survive the scale exactly.
        assert!(close(large.plate[0], 0.0));
        assert!(close(
            large.strip[0] + large.strip[2],
            1600.0 - MARGIN * scale
        ));

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

        // The radar lane is the scope plus the coordinate rail the radar itself
        // draws - not a window's caption and footer, which this pane suppresses
        // and which only ever showed up as dead band around the instrument.
        assert_eq!(layout.radar[2], RADAR_LANE_W);
        assert_eq!(layout.radar[3], RADAR_LANE_H);
        assert_eq!(layout.radar[1] + layout.radar[3], 768.0 - MARGIN);
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
