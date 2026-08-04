//! World-anchored overlay chrome: nameplates, spatial chat bubbles and
//! floating combat/status text (ports of `actorPresentation` nameplates,
//! `spatialBubbleSystem.ts` and the combat float vocabulary).
//!
//! The overlay layer never projects world coordinates itself — the world
//! renderer resolves each anchor to screen px and calls the draw helpers, so
//! this module stays camera-agnostic. All pools are bounded; expired entries
//! recycle in place without per-frame heap work.

use successor_engine_render::font::GLYPH_H;
use successor_engine_render::ui::UiBuilder;

use super::{
    plate::{hostility_tint, readable_dim},
    sanitize_text, Palette, RelationHud,
};

// Reference tuning (`client/src/slice-core/specs/tuning.v1.json` spatialChat).
pub const BUBBLE_MIN_TTL_MS: f32 = 2200.0;
pub const BUBBLE_MAX_TTL_MS: f32 = 7000.0;
pub const BUBBLE_MS_PER_CHAR: f32 = 56.0;
pub const BUBBLE_FADE_IN_MS: f32 = 120.0;
pub const BUBBLE_FADE_OUT_MS: f32 = 320.0;
pub const BUBBLE_MAX_STACK: usize = 3;
pub const BUBBLE_ACTOR_MAX: usize = 16;
pub const BUBBLE_POOL_MAX: usize = BUBBLE_MAX_STACK * BUBBLE_ACTOR_MAX;
/// Bubble body cap before wrap (sanitized chars).
pub const BUBBLE_TEXT_MAX: usize = 160;
pub const BUBBLE_MAX_LINES: usize = 4;
pub const BUBBLE_LINE_CHARS: usize = 28;

pub const FLOAT_POOL_MAX: usize = 48;
pub const FLOAT_TTL_MS: f32 = 900.0;
pub const FLOAT_RISE_PX: f32 = 34.0;

pub const NAMEPLATE_NAME_MAX: usize = 24;

/// TTL scales with body length (reference `spatialBubbleTtlMs`).
pub fn bubble_ttl_ms(body: &str) -> f32 {
    (body.chars().count() as f32 * BUBBLE_MS_PER_CHAR).clamp(BUBBLE_MIN_TTL_MS, BUBBLE_MAX_TTL_MS)
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bubble {
    /// Owning actor; bubbles with an unknown/missing anchor never fall back
    /// to another pawn (reference actor-ownership rule).
    pub actor_id: String,
    pub lines: Vec<String>,
    pub ttl_ms: f32,
    pub total_ms: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FloatTone {
    Damage,
    Heal,
    Miss,
    Deflect,
    Status,
    Reject,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FloatText {
    pub actor_id: String,
    pub text: String,
    pub tone: FloatTone,
    pub age_ms: f32,
}

/// Greedy word wrap at a fixed column budget (5×7 font is monospaced), with a
/// trailing ellipsis when the line cap truncates the body.
pub fn wrap_bubble_text(body: &str, max_chars: usize, max_lines: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::with_capacity(max_lines);
    let mut current = String::new();
    let mut truncated = false;
    for word in body.split_whitespace() {
        let mut word = word;
        // Hard-split words longer than a line.
        while word.chars().count() > max_chars {
            if lines.len() == max_lines {
                truncated = true;
                break;
            }
            if !current.is_empty() {
                lines.push(core::mem::take(&mut current));
                continue;
            }
            let split: String = word.chars().take(max_chars).collect();
            let rest_start = split.len();
            lines.push(split);
            word = &word[rest_start..];
        }
        if truncated {
            break;
        }
        let needed = if current.is_empty() {
            word.chars().count()
        } else {
            current.chars().count() + 1 + word.chars().count()
        };
        if needed <= max_chars {
            if !current.is_empty() {
                current.push(' ');
            }
            current.push_str(word);
        } else {
            if lines.len() == max_lines {
                truncated = true;
                break;
            }
            lines.push(core::mem::take(&mut current));
            current.push_str(word);
        }
    }
    if !current.is_empty() && lines.len() < max_lines {
        lines.push(current);
    } else if !current.is_empty() {
        truncated = true;
    }
    if lines.len() > max_lines {
        lines.truncate(max_lines);
        truncated = true;
    }
    if truncated {
        if let Some(last) = lines.last_mut() {
            while last.chars().count() > max_chars.saturating_sub(1) {
                last.pop();
            }
            last.push('…');
        }
    }
    lines
}

/// Bounded overlay pools. The connected runtime owns one instance.
#[derive(Default)]
pub struct Overlays {
    pub bubbles: Vec<Bubble>,
    pub floats: Vec<FloatText>,
}

impl Overlays {
    pub fn new() -> Self {
        Self {
            bubbles: Vec::with_capacity(BUBBLE_POOL_MAX),
            floats: Vec::with_capacity(FLOAT_POOL_MAX),
        }
    }

    /// Enqueue a LOCAL chat bubble over its speaker. Text is sanitized and
    /// wrapped here — bubbles never render raw wire bytes.
    pub fn push_bubble(&mut self, actor_id: &str, body: &str) {
        let text = sanitize_text(body, BUBBLE_TEXT_MAX);
        if text.is_empty() || actor_id.is_empty() {
            return;
        }
        let ttl = bubble_ttl_ms(&text);
        self.bubbles.insert(
            0,
            Bubble {
                actor_id: actor_id.to_string(),
                lines: wrap_bubble_text(&text, BUBBLE_LINE_CHARS, BUBBLE_MAX_LINES),
                ttl_ms: ttl,
                total_ms: ttl,
            },
        );
        let mut actor_count = 0usize;
        self.bubbles.retain(|bubble| {
            if bubble.actor_id == actor_id {
                actor_count += 1;
                actor_count <= BUBBLE_MAX_STACK
            } else {
                true
            }
        });
        self.bubbles.truncate(BUBBLE_POOL_MAX);
    }

    /// Enqueue floating combat/status text over an actor (bounded pool —
    /// oldest entry recycles when full).
    pub fn push_float(&mut self, actor_id: &str, text: &str, tone: FloatTone) {
        if actor_id.is_empty() {
            return;
        }
        let text = sanitize_text(text, 24);
        if text.is_empty() {
            return;
        }
        if self.floats.len() >= FLOAT_POOL_MAX {
            // Recycle the oldest.
            let oldest = self
                .floats
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.age_ms.total_cmp(&b.1.age_ms))
                .map(|(i, _)| i)
                .unwrap_or(0);
            self.floats.swap_remove(oldest);
        }
        self.floats.push(FloatText {
            actor_id: actor_id.to_string(),
            text,
            tone,
            age_ms: 0.0,
        });
    }

    /// Age pools; expired entries drop.
    pub fn update(&mut self, dt_ms: f32) {
        self.bubbles.retain_mut(|b| {
            b.ttl_ms -= dt_ms;
            b.ttl_ms > 0.0
        });
        self.floats.retain_mut(|f| {
            f.age_ms += dt_ms;
            f.age_ms < FLOAT_TTL_MS
        });
    }

    /// Draw every anchored overlay. `anchor` resolves an actor id to the
    /// screen-px point above its head; `None` skips (off-screen/occluded/
    /// despawned anchors draw nothing — no fallback pawn).
    pub fn draw<F: Fn(&str) -> Option<(f32, f32)>>(
        &self,
        ui: &mut UiBuilder,
        pal: &Palette,
        sw: f32,
        sh: f32,
        anchor: F,
    ) {
        for (index, bubble) in self.bubbles.iter().enumerate() {
            if let Some((x, y)) = anchor(&bubble.actor_id) {
                let stack_offset = self.bubbles[..index]
                    .iter()
                    .filter(|newer| newer.actor_id == bubble.actor_id)
                    .map(|newer| bubble_dimensions(ui, newer).1 + 5.0)
                    .sum::<f32>();
                draw_bubble(ui, bubble, x, y - stack_offset, sw);
            }
        }
        for ft in &self.floats {
            if let Some((x, y)) = anchor(&ft.actor_id) {
                draw_float(ui, pal, ft, x, y, sh);
            }
        }
    }
}

fn alpha_scale(color: [u8; 4], alpha: f32) -> [u8; 4] {
    [
        color[0],
        color[1],
        color[2],
        (color[3] as f32 * alpha.clamp(0.0, 1.0)) as u8,
    ]
}

/// Original-client speech bubble: centered black prose on a translucent pale
/// rectangle with a tapered spout. It is clamped to the screen and fades at
/// the same ingress/egress timings as the runtime contract.
fn bubble_dimensions(ui: &UiBuilder, bubble: &Bubble) -> (f32, f32) {
    let text_px = 1.5;
    let line_h = 7.0 * text_px + 3.0;
    let widest = bubble
        .lines
        .iter()
        .map(|line| ui.measure_text(line, text_px))
        .fold(0.0f32, f32::max);
    (widest + 16.0, bubble.lines.len() as f32 * line_h + 9.0)
}

fn draw_bubble(ui: &mut UiBuilder, bubble: &Bubble, x: f32, y: f32, screen_w: f32) {
    let text_px = 1.5;
    let line_h = 7.0 * text_px + 3.0;
    let (width, height) = bubble_dimensions(ui, bubble);
    let mut bubble_x = x - width * 0.5;
    bubble_x = bubble_x.clamp(4.0, (screen_w - width - 4.0).max(4.0));
    let bubble_y = (y - height - 7.0).max(4.0);

    let lived = bubble.total_ms - bubble.ttl_ms;
    let fade_in = (lived / BUBBLE_FADE_IN_MS).clamp(0.0, 1.0);
    let fade_out = (bubble.ttl_ms / BUBBLE_FADE_OUT_MS).clamp(0.0, 1.0);
    let alpha = fade_in.min(fade_out);
    let background = alpha_scale([214, 222, 211, 202], alpha);
    let edge = alpha_scale([242, 247, 237, 226], alpha);
    let ink = alpha_scale([14, 20, 20, 255], alpha);

    ui.rect(
        bubble_x + 2.0,
        bubble_y + 3.0,
        width,
        height,
        alpha_scale([0, 0, 0, 76], alpha),
    );
    ui.rect(bubble_x, bubble_y, width, height, background);
    ui.border(bubble_x, bubble_y, width, height, 1.0, edge);

    let tail_x = x.clamp(bubble_x + 8.0, bubble_x + width - 8.0);
    ui.rect(tail_x - 3.0, bubble_y + height, 6.0, 2.0, background);
    ui.rect(tail_x - 2.0, bubble_y + height + 2.0, 4.0, 2.0, background);
    ui.rect(tail_x - 1.0, bubble_y + height + 4.0, 2.0, 2.0, background);

    for (index, line) in bubble.lines.iter().enumerate() {
        let line_width = ui.measure_text(line, text_px);
        ui.text(
            line,
            bubble_x + (width - line_width) * 0.5,
            bubble_y + 5.0 + index as f32 * line_h,
            text_px,
            ink,
        );
    }
}

fn draw_float(ui: &mut UiBuilder, pal: &Palette, ft: &FloatText, x: f32, y: f32, _sh: f32) {
    let t = (ft.age_ms / FLOAT_TTL_MS).clamp(0.0, 1.0);
    let rise = t * FLOAT_RISE_PX;
    let alpha = 1.0 - t * t; // ease-out fade
    let tint = match ft.tone {
        FloatTone::Damage => pal.danger,
        FloatTone::Heal => [110, 214, 130, 255],
        FloatTone::Miss | FloatTone::Deflect => pal.ink_dim,
        FloatTone::Status => pal.accent,
        FloatTone::Reject => pal.danger,
    };
    let px = if ft.tone == FloatTone::Damage {
        2.0
    } else {
        1.6
    };
    let tw = ui.measure_text(&ft.text, px);
    ui.text(
        &ft.text,
        x - tw * 0.5,
        (y - 18.0 - rise).max(2.0),
        px,
        alpha_scale(tint, alpha),
    );
}

/// Screen-space lift from the head anchor to the name's baseline. Mirrors
/// `nameplateScreenLiftPx` in `client-3d/src/overlay/nameplates.ts` so a pawn
/// wears its name at the same height in both clients.
pub const NAMEPLATE_SCREEN_LIFT_PX: f32 = 24.0;

/// Original-client-shaped nameplate: unboxed centered text, relation color,
/// parenthesized title/role, and a subtle target bracket. The host owns
/// visibility and distance opacity.
///
/// `y` is the BASELINE the name sits on, matching the web renderer's canvas
/// `fillText`. The engine's `ui.text` anchors glyph TOPS, so the name is lifted
/// by its own cap height here; passing a top-anchored y instead dropped the
/// whole plate a full text height onto the pawn's head.
#[allow(clippy::too_many_arguments)]
pub fn draw_nameplate(
    ui: &mut UiBuilder,
    pal: &Palette,
    name: &str,
    descriptor: Option<&str>,
    relation: RelationHud,
    life_tag: Option<&str>,
    selected: bool,
    opacity: f32,
    x: f32,
    y: f32,
) {
    if name.is_empty() || opacity <= 0.0 {
        return;
    }
    let is_dead = life_tag.is_some_and(|t| t == "DEAD" || t == "DOWN");
    let name_px = 1.45;
    let base_hostility_tint = hostility_tint(relation, pal);
    let base_tint = if is_dead {
        readable_dim(pal)
    } else {
        base_hostility_tint
    };
    let tint = alpha_scale(base_tint, opacity);
    let shadow = alpha_scale([0, 0, 0, 220], opacity);
    // Cap height of the 5x7 face at this scale. Lifting by it turns the
    // caller's baseline into the glyph top the engine actually wants.
    let name_cap = GLYPH_H as f32 * name_px;
    let name_top = y - name_cap;
    let name_width = ui.measure_text(name, name_px);
    let name_x = x - name_width * 0.5;
    ui.text(name, name_x + 1.0, name_top + 1.0, name_px, shadow);
    ui.text(name, name_x, name_top, name_px, tint);

    if is_dead {
        let strike_tint = alpha_scale(readable_dim(pal), opacity);
        let strike_y = name_top + name_cap * 0.5;
        ui.line(
            name_x,
            strike_y,
            name_x + name_width,
            strike_y,
            1.0,
            strike_tint,
        );
    }

    let mut line_y = y + 2.0;
    let desc_val = descriptor.filter(|value| !value.is_empty());
    if let Some(desc) = desc_val {
        let descriptor_px = 1.2;
        let width = ui.measure_text(desc, descriptor_px);
        ui.text(
            desc,
            x - width * 0.5 + 1.0,
            line_y + 1.0,
            descriptor_px,
            shadow,
        );
        ui.text(
            desc,
            x - width * 0.5,
            line_y,
            descriptor_px,
            alpha_scale(pal.ink_dim, opacity),
        );
        line_y += 10.0;
    }
    if let Some(tag) = life_tag {
        let width = ui.measure_text(tag, 1.25);
        let tag_tint = if is_dead {
            alpha_scale(readable_dim(pal), opacity)
        } else {
            alpha_scale(pal.danger, opacity)
        };
        ui.text(
            tag,
            x - width * 0.5,
            line_y,
            1.25,
            tag_tint,
        );
        line_y += 10.0;
    }

    if selected {
        let mut max_w = name_width;
        if let Some(desc) = desc_val {
            max_w = max_w.max(ui.measure_text(desc, 1.2));
        }
        if let Some(tag) = life_tag {
            max_w = max_w.max(ui.measure_text(tag, 1.25));
        }

        let pad_x = 6.0;
        let pad_y = 3.0;
        let left = x - max_w * 0.5 - pad_x;
        let right = x + max_w * 0.5 + pad_x;
        let top = y - pad_y;
        let bottom = line_y - 2.0;

        let arm = 5.0f32.min((right - left) * 0.25).min((bottom - top) * 0.25);
        let bracket_base = if is_dead {
            readable_dim(pal)
        } else {
            base_hostility_tint
        };
        let bracket = alpha_scale(bracket_base, opacity);

        // Corner brackets
        ui.line(left, top, left + arm, top, 1.0, bracket);
        ui.line(left, top, left, top + arm, 1.0, bracket);

        ui.line(right - arm, top, right, top, 1.0, bracket);
        ui.line(right, top, right, top + arm, 1.0, bracket);

        ui.line(left, bottom, left + arm, bottom, 1.0, bracket);
        ui.line(left, bottom - arm, left, bottom, 1.0, bracket);

        ui.line(right - arm, bottom, right, bottom, 1.0, bracket);
        ui.line(right, bottom - arm, right, bottom, 1.0, bracket);

        // Baseline tick
        let tick_w = 6.0;
        ui.line(x - tick_w * 0.5, bottom, x + tick_w * 0.5, bottom, 1.0, bracket);
        ui.line(x, bottom, x, bottom - 3.0, 1.0, bracket);
    }
}

/// Contextual label for the nearest tangible world object. SWG exposes object
/// names as the same unboxed, projected text family as creature plates.
pub fn draw_world_label(
    ui: &mut UiBuilder,
    pal: &Palette,
    label: &str,
    action: Option<&str>,
    x: f32,
    y: f32,
) {
    if label.is_empty() {
        return;
    }
    let text_px = 1.35;
    let width = ui.measure_text(label, text_px);
    let text_x = x - width * 0.5;
    ui.text(label, text_x + 1.0, y + 1.0, text_px, [0, 0, 0, 220]);
    ui.text(label, text_x, y, text_px, pal.ink);
    if let Some(action) = action {
        let action_px = 1.1;
        let action_width = ui.measure_text(action, action_px);
        ui.text(
            action,
            x - action_width * 0.5 + 1.0,
            y + 12.0,
            action_px,
            [0, 0, 0, 220],
        );
        ui.text(
            action,
            x - action_width * 0.5,
            y + 11.0,
            action_px,
            pal.accent,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::{palette, Icons};

    #[test]
    fn bubble_ttl_follows_reference_curve() {
        assert_eq!(bubble_ttl_ms("hi"), BUBBLE_MIN_TTL_MS);
        assert_eq!(bubble_ttl_ms(&"x".repeat(200)), BUBBLE_MAX_TTL_MS);
        let mid = bubble_ttl_ms(&"x".repeat(80));
        assert!((mid - 80.0 * BUBBLE_MS_PER_CHAR).abs() < 1e-3);
    }

    #[test]
    fn bubble_stack_is_bounded_and_sanitized() {
        let mut ov = Overlays::new();
        for i in 0..6 {
            ov.push_bubble("actor", &format!("message {i}"));
        }
        assert_eq!(ov.bubbles.len(), BUBBLE_MAX_STACK);
        assert_eq!(ov.bubbles[0].lines[0], "message 5", "newest first");
        ov.push_bubble("actor", "   \u{7}\u{8}   ");
        assert_eq!(
            ov.bubbles.len(),
            BUBBLE_MAX_STACK,
            "empty-after-sanitize dropped"
        );
        ov.push_bubble("", "orphan");
        assert!(
            ov.bubbles.iter().all(|b| !b.actor_id.is_empty()),
            "ownerless bubbles never enqueue"
        );
    }

    #[test]
    fn bubble_stack_limit_is_per_actor_not_global() {
        let mut overlays = Overlays::new();
        for actor in ["a", "b"] {
            for index in 0..BUBBLE_MAX_STACK {
                overlays.push_bubble(actor, &format!("{actor}-{index}"));
            }
        }
        assert_eq!(overlays.bubbles.len(), BUBBLE_MAX_STACK * 2);
        assert_eq!(
            overlays
                .bubbles
                .iter()
                .filter(|bubble| bubble.actor_id == "a")
                .count(),
            BUBBLE_MAX_STACK
        );
    }

    #[test]
    fn wrap_caps_lines_with_ellipsis() {
        let lines = wrap_bubble_text(&"word ".repeat(40), 10, 3);
        assert_eq!(lines.len(), 3);
        assert!(lines[2].ends_with('…'));
        let short = wrap_bubble_text("two words", 28, 4);
        assert_eq!(short, vec!["two words".to_string()]);
        // Oversized single word hard-splits instead of overflowing.
        let split = wrap_bubble_text("abcdefghijklmnop", 6, 4);
        assert!(split[0].chars().count() <= 6);
    }

    #[test]
    fn float_pool_recycles_oldest() {
        let mut ov = Overlays::new();
        for i in 0..FLOAT_POOL_MAX {
            ov.push_float("a", &format!("{i}"), FloatTone::Damage);
        }
        ov.update(100.0); // age everyone
        ov.push_float("a", "newest", FloatTone::Heal);
        assert_eq!(ov.floats.len(), FLOAT_POOL_MAX);
        assert!(ov.floats.iter().any(|f| f.text == "newest"));
    }

    #[test]
    fn update_expires_pools() {
        let mut ov = Overlays::new();
        ov.push_bubble("a", "hello there");
        ov.push_float("a", "12", FloatTone::Damage);
        ov.update(BUBBLE_MAX_TTL_MS + 1.0);
        assert!(ov.bubbles.is_empty());
        assert!(ov.floats.is_empty());
    }

    #[test]
    fn draw_skips_unresolved_anchors() {
        let icons = Icons::load();
        let mut ui = successor_engine_render::ui::UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let mut ov = Overlays::new();
        ov.push_bubble("gone", "hello");
        ov.draw(&mut ui, &palette(0), 1280.0, 720.0, |_| None);
        assert_eq!(ui.quads, 0, "no fallback anchor for unknown actors");
        ov.draw(&mut ui, &palette(0), 1280.0, 720.0, |_| {
            Some((400.0, 300.0))
        });
        assert!(ui.quads > 0);
    }
    #[test]
    fn hostility_tint_agreement_between_plate_and_overlay() {
        let pal = palette(0);
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        draw_nameplate(
            &mut ui,
            &pal,
            "IMPERIAL SOLDIER",
            Some("ROOKIE"),
            RelationHud::Hostile,
            None,
            true,
            1.0,
            400.0,
            300.0,
        );
        assert!(ui.quads > 0, "selection indicator draws quads");
        assert_eq!(
            hostility_tint(RelationHud::Hostile, &pal),
            [0xd3, 0x3b, 0x32, 255],
            "the overlay must draw the shared hostile ink, not a theme tone"
        );
    }

    #[test]
    fn bracket_geometry_stays_inside_plate_bounds() {
        let pal = palette(0);
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let x = 400.0f32;
        let y = 300.0f32;
        draw_nameplate(
            &mut ui,
            &pal,
            "TARGET NAME",
            Some("DESCRIPTOR"),
            RelationHud::Hostile,
            Some("TAG"),
            true,
            1.0,
            x,
            y,
        );

        let max_w = ui.measure_text("TARGET NAME", 1.45)
            .max(ui.measure_text("DESCRIPTOR", 1.2))
            .max(ui.measure_text("TAG", 1.25));
        // `y` is the name's baseline, so the plate reaches a full cap height
        // above it before the bracket's own padding.
        let name_cap = GLYPH_H as f32 * 1.45;
        let left = x - max_w * 0.5 - 6.0 - 0.5;
        let right = x + max_w * 0.5 + 6.0 + 0.5;
        let top = y - name_cap - 3.0 - 0.5;
        let bottom = y + 32.0 - 0.5; // descriptor + tag below the baseline

        let mut min_px = f32::MAX;
        let mut max_px = f32::MIN;
        let mut min_py = f32::MAX;
        let mut max_py = f32::MIN;

        for vertex in ui.buf.chunks_exact(8) {
            let px = (vertex[0] + 1.0) * 0.5 * 1280.0;
            let py = (1.0 - vertex[1]) * 0.5 * 720.0;
            min_px = min_px.min(px);
            max_px = max_px.max(px);
            min_py = min_py.min(py);
            max_py = max_py.max(py);
        }

        assert!(min_px >= left, "brackets min_px {min_px} >= left {left}");
        assert!(max_px <= right, "brackets max_px {max_px} <= right {right}");
        assert!(min_py >= top, "brackets min_py {min_py} >= top {top}");
        assert!(max_py <= bottom, "brackets max_py {max_py} <= bottom {bottom}");
    }

    #[test]
    fn dead_target_overlay_presentation() {
        let pal = palette(0);
        let icons = Icons::load();

        let mut ui_alive = UiBuilder::new(icons.meta);
        ui_alive.begin(1280, 720);
        draw_nameplate(
            &mut ui_alive,
            &pal,
            "TARGET NAME",
            None,
            RelationHud::Hostile,
            None,
            false,
            1.0,
            400.0,
            300.0,
        );

        let mut ui_dead = UiBuilder::new(icons.meta);
        ui_dead.begin(1280, 720);
        draw_nameplate(
            &mut ui_dead,
            &pal,
            "TARGET NAME",
            None,
            RelationHud::Hostile,
            Some("DEAD"),
            false,
            1.0,
            400.0,
            300.0,
        );

        assert!(ui_dead.quads > ui_alive.quads, "dead nameplate must emit extra quads for strike-through line");
    }
}
