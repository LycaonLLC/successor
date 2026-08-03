//! World-anchored overlay chrome: nameplates, spatial chat bubbles and
//! floating combat/status text (ports of `actorPresentation` nameplates,
//! `spatialBubbleSystem.ts` and the combat float vocabulary).
//!
//! The overlay layer never projects world coordinates itself — the world
//! renderer resolves each anchor to screen px and calls the draw helpers, so
//! this module stays camera-agnostic. All pools are bounded; expired entries
//! recycle in place without per-frame heap work.

use successor_engine_render::ui::UiBuilder;

use super::{sanitize_text, Palette, RelationHud};

// Reference tuning (`client/src/slice-core/specs/tuning.v1.json` spatialChat).
pub const BUBBLE_MIN_TTL_MS: f32 = 2200.0;
pub const BUBBLE_MAX_TTL_MS: f32 = 7000.0;
pub const BUBBLE_MS_PER_CHAR: f32 = 56.0;
pub const BUBBLE_FADE_IN_MS: f32 = 120.0;
pub const BUBBLE_FADE_OUT_MS: f32 = 320.0;
pub const BUBBLE_MAX_STACK: usize = 3;
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
            bubbles: Vec::with_capacity(BUBBLE_MAX_STACK),
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
        self.bubbles.truncate(BUBBLE_MAX_STACK);
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
        for bubble in self.bubbles.iter().rev() {
            if let Some((x, y)) = anchor(&bubble.actor_id) {
                draw_bubble(ui, pal, bubble, x, y, sw);
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

/// One speech bubble above a pawn, clamped to the screen edges. Fade-in and
/// fade-out follow the reference timings.
fn draw_bubble(ui: &mut UiBuilder, pal: &Palette, bubble: &Bubble, x: f32, y: f32, sw: f32) {
    let px = 1.5;
    let line_h = 7.0 * px + 3.0;
    let widest = bubble
        .lines
        .iter()
        .map(|l| UiBuilder::text_width(l, px))
        .fold(0.0f32, f32::max);
    let pad_x = 8.0;
    let pad_y = 6.0;
    let w = widest + pad_x * 2.0;
    let h = bubble.lines.len() as f32 * line_h + pad_y * 2.0 - 3.0;
    let mut bx = x - w * 0.5;
    bx = bx.clamp(4.0, (sw - w - 4.0).max(4.0));
    let by = (y - h - 6.0).max(4.0);

    let lived = bubble.total_ms - bubble.ttl_ms;
    let fade_in = (lived / BUBBLE_FADE_IN_MS).clamp(0.0, 1.0);
    let fade_out = (bubble.ttl_ms / BUBBLE_FADE_OUT_MS).clamp(0.0, 1.0);
    let alpha = fade_in.min(fade_out);

    ui.rect(bx, by, w, h, alpha_scale(pal.bg_panel, alpha));

    // Anchor nib.
    ui.rect(x - 2.0, by + h, 4.0, 4.0, alpha_scale(pal.hairline, alpha));
    for (i, line) in bubble.lines.iter().enumerate() {
        ui.text(
            line,
            bx + pad_x,
            by + pad_y + i as f32 * line_h,
            px,
            alpha_scale(pal.ink, alpha),
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
    let tw = UiBuilder::text_width(&ft.text, px);
    ui.text(
        &ft.text,
        x - tw * 0.5,
        (y - 18.0 - rise).max(2.0),
        px,
        alpha_scale(tint, alpha),
    );
}

/// A nameplate above a pawn using pre-sanitized projection strings: clean name
/// (relation-tinted), optional descriptor line, and DOWN/DEAD tag. The host
/// applies distance/occlusion culling before calling.
#[allow(clippy::too_many_arguments)]
pub fn draw_nameplate(
    ui: &mut UiBuilder,
    pal: &Palette,
    name: &str,
    descriptor: Option<&str>,
    relation: RelationHud,
    life_tag: Option<&str>,
    x: f32,
    y: f32,
) {
    if name.is_empty() {
        return;
    }
    let px = 1.7;
    let tint = relation.tint(pal);
    let nw = UiBuilder::text_width(name, px);
    ui.text(name, x - nw * 0.5 + 1.0, y + 1.0, px, [0, 0, 0, 210]);
    ui.text(name, x - nw * 0.5, y, px, tint);
    let mut line_y = y + 14.0;
    if let Some(desc) = descriptor.filter(|desc| !desc.is_empty()) {
        let dw = UiBuilder::text_width(desc, 1.35);
        ui.text(desc, x - dw * 0.5 + 1.0, line_y + 1.0, 1.35, [0, 0, 0, 210]);
        ui.text(desc, x - dw * 0.5, line_y, 1.35, pal.ink_dim);
        line_y += 11.0;
    }
    if let Some(tag) = life_tag {
        let tw = UiBuilder::text_width(tag, 1.4);
        ui.text(tag, x - tw * 0.5, line_y, 1.4, pal.danger);
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
}
