//! Status plate, target plate, group HUD, ability queue, interact chip,
//! toasts/banners, first steps and the death/clone overlay — ports of the
//! `client-3d` HUD panes (`statusPlate.ts`, `targetPlate.ts`, `groupHud.ts`,
//! `combatQueue.ts`, `extractionHud.ts`, `firstSteps.ts`, `deathOverlay.ts`)
//! onto the immediate-mode `UiBuilder`.

use successor_engine_render::ui::{ButtonStyle, UiBuilder};

use super::{
    BannerHud, ConnectionHud, GaugeHud, HudAction, HudState, InteractHud, LifeHud, Palette,
    QueueEntryStateHud, SprintHud, TargetHud, GROUP_CHIP_MAX, QUEUE_ROW_MAX,
};

/// Physical magazine pips cap (reference `MAX_PIPS`).
pub const MAX_PIPS: u32 = 48;

pub const PLATE_W: f32 = 300.0;
pub const PLATE_H: f32 = 162.0;

fn button_style(pal: &Palette) -> ButtonStyle {
    ButtonStyle {
        fill: pal.bg_cell,
        hover: pal.accent_soft,
        active: pal.accent_soft,
        edge: pal.hairline,
        text: pal.ink,
    }
}

/// One field gauge: label, track, fill, numeric readout. Low vitals (≤25%)
/// tint the fill toward danger.
fn gauge(
    ui: &mut UiBuilder,
    pal: &Palette,
    geometry: [f32; 3],
    label: &str,
    g: &GaugeHud,
    value_text: &str,
) {
    let [x, y, w] = geometry;
    ui.text(label, x, y, 1.5, pal.ink_dim);
    let track_y = y + 12.0;
    ui.rect(x, track_y, w, 8.0, pal.bg_cell);
    let frac = g.frac();
    if frac > 0.0 {
        let fill = if g.low() { pal.danger } else { pal.accent };
        ui.rect(x, track_y, w * frac, 8.0, fill);
    }
    ui.border(x, track_y, w, 8.0, 1.0, pal.hairline);
    ui.text(value_text, x + w + 8.0, y + 6.0, 1.8, pal.ink);
}

/// Bottom-left status plate: tags, three gauges, RUN toggle, magazine pips /
/// swing timer, fine print. Emits [`HudAction::ToggleSprint`] on RUN click.
pub fn draw_status_plate(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    x: f32,
    y: f32,
    out: &mut Vec<HudAction>,
) {
    ui.panel(x, y, PLATE_W, PLATE_H, pal.bg_panel, pal.hairline);

    // ── Tag row ──────────────────────────────────────────────────────────
    let mut tag_x = x + 8.0;
    let tag_y = y + 6.0;
    let mut tag = |ui: &mut UiBuilder, text: &str, tint: [u8; 4]| {
        let w = UiBuilder::text_width(text, 1.4) + 8.0;
        ui.rect(tag_x, tag_y, w, 12.0, pal.bg_cell);
        ui.text(text, tag_x + 4.0, tag_y + 2.0, 1.4, tint);
        tag_x += w + 6.0;
    };
    if st.observer {
        tag(ui, "OBSERVER", pal.ink_dim);
    }
    if st.sheltered {
        tag(ui, "SHELTERED", pal.accent);
    }
    if let Some(campdown) = &st.camp_countdown {
        tag(ui, campdown, pal.danger);
    }
    if let Some(sampler) = &st.sampler_text {
        tag(ui, sampler, pal.accent);
    }
    if st.life != LifeHud::Alive {
        let stamp = if st.life == LifeHud::Respawning {
            "DEAD"
        } else {
            "DOWN"
        };
        tag(ui, stamp, pal.danger);
    }
    if let Some(sick) = &st.clone_sickness {
        tag(ui, sick, pal.ink_dim);
    }

    // ── Name + gauges ────────────────────────────────────────────────────
    ui.text(&st.name, x + 8.0, y + 20.0, 2.2, pal.accent);
    let gx = x + 8.0;
    let gw = PLATE_W - 70.0;
    gauge(
        ui,
        pal,
        [gx, y + 38.0, gw],
        "HEALTH",
        &st.health,
        &st.health_text,
    );
    gauge(
        ui,
        pal,
        [gx, y + 62.0, gw],
        "ACTION",
        &st.action,
        &st.action_text,
    );
    gauge(
        ui,
        pal,
        [gx, y + 86.0, gw],
        "SPIRIT",
        &st.spirit,
        &st.spirit_text,
    );

    // ── RUN toggle (keyboard twin: X) ────────────────────────────────────
    let (run_label, run_tint) = match st.sprint {
        SprintHud::Off => ("RUN", pal.ink_dim),
        SprintHud::On => ("RUN", pal.accent),
        SprintHud::Winded => ("WINDED", pal.danger),
    };
    let run_x = x + PLATE_W - 62.0;
    let run_y = y + 20.0;
    let mut style = button_style(pal);
    style.text = run_tint;
    if st.sprint == SprintHud::On {
        style.edge = pal.accent;
    }
    if ui.button(run_x, run_y, 54.0, 18.0, run_label, style) {
        out.push(HudAction::ToggleSprint);
    }
    ui.text("X", run_x + 2.0, run_y - 8.0, 1.2, pal.ink_dim);

    // ── Magazine / swing readout ─────────────────────────────────────────
    let mag_y = y + 110.0;
    if let Some(weapon) = &st.weapon {
        ui.text(&weapon.label, x + 8.0, mag_y, 1.6, pal.ink);
        let rounds_x = x + 8.0 + UiBuilder::text_width(&weapon.label, 1.6) + 10.0;
        ui.text(&weapon.rounds_text, rounds_x, mag_y, 1.6, pal.ink_dim);
        if weapon.melee {
            // Swing timer: fill sweeps to READY where pips normally live.
            let bar_y = mag_y + 14.0;
            let bar_w = PLATE_W - 16.0;
            ui.rect(x + 8.0, bar_y, bar_w, 6.0, pal.bg_cell);
            let fill = weapon.swing_frac.clamp(0.0, 1.0);
            let tint = if weapon.swing_ready {
                pal.accent
            } else {
                pal.ink_dim
            };
            ui.rect(x + 8.0, bar_y, bar_w * fill, 6.0, tint);
            ui.border(x + 8.0, bar_y, bar_w, 6.0, 1.0, pal.hairline);
        } else if weapon.magazine_size > 0 {
            // One pip per round (≤48); reload sweeps the pips back in.
            let count = weapon.magazine_size.min(MAX_PIPS);
            let filled = if weapon.reloading {
                ((weapon.reload_frac * count as f32).floor() as u32).min(count)
            } else {
                weapon.loaded_rounds.min(count)
            };
            let pip_w = ((PLATE_W - 16.0) / count as f32 - 2.0).clamp(2.0, 10.0);
            for i in 0..count {
                let px = x + 8.0 + i as f32 * (pip_w + 2.0);
                let tint = if i < filled { pal.accent } else { pal.bg_cell };
                ui.rect(px, mag_y + 14.0, pip_w, 8.0, tint);
            }
        }
    }

    // ── Fine print ───────────────────────────────────────────────────────
    let fine_tint = if st.connection == ConnectionHud::Live {
        pal.ink_dim
    } else {
        pal.danger
    };
    ui.text(&st.fine_text, x + 8.0, y + PLATE_H - 18.0, 1.4, fine_tint);
    if !st.area_label.is_empty() {
        let aw = UiBuilder::text_width(&st.area_label, 1.4);
        ui.text(
            &st.area_label,
            x + PLATE_W - aw - 8.0,
            y + PLATE_H - 18.0,
            1.4,
            pal.ink_dim,
        );
    }
}

/// Target status plate: relation-tinted name + left rail, health bar with
/// `current/max`, state chips, DOWN/DEAD stamp.
pub fn draw_target_plate(ui: &mut UiBuilder, pal: &Palette, target: &TargetHud, x: f32, y: f32) {
    let w = 280.0;
    let h = 84.0;
    let tint = target.relation.tint(pal);
    ui.panel(x, y, w, h, pal.bg_panel, pal.hairline);
    // Relation rail (left edge).
    ui.rect(x, y, 3.0, h, tint);
    ui.text(&target.name, x + 10.0, y + 8.0, 2.0, tint);
    if let Some(stamp) = target.stamp {
        let sw = UiBuilder::text_width(stamp, 2.0);
        ui.rect(x + w - sw - 18.0, y + 6.0, sw + 10.0, 16.0, pal.danger);
        ui.text(stamp, x + w - sw - 13.0, y + 8.0, 2.0, [10, 10, 10, 255]);
    }
    // Health `current/max` + bar.
    let hp = &target.health;
    let hp_text = if hp.max > 0.0 {
        format!(
            "{}/{}",
            hp.value.max(0.0).round() as i64,
            hp.max.round() as i64
        )
    } else {
        "—".to_string()
    };
    ui.text(&hp_text, x + 10.0, y + 28.0, 1.6, pal.ink);
    let bar_y = y + 42.0;
    ui.rect(x + 10.0, bar_y, w - 20.0, 8.0, pal.bg_cell);
    if hp.frac() > 0.0 {
        ui.rect(x + 10.0, bar_y, (w - 20.0) * hp.frac(), 8.0, pal.danger);
    }
    ui.border(x + 10.0, bar_y, w - 20.0, 8.0, 1.0, pal.hairline);
    // State chips (max 4).
    let mut cx = x + 10.0;
    for chip in &target.chips {
        let cw = UiBuilder::text_width(&chip.label, 1.4) + 8.0;
        if cx + cw > x + w - 8.0 {
            break;
        }
        let tint = if chip.danger { pal.danger } else { pal.ink_dim };
        ui.rect(cx, y + 58.0, cw, 14.0, pal.bg_cell);
        ui.border(cx, y + 58.0, cw, 14.0, 1.0, pal.hairline);
        ui.text(&chip.label, cx + 4.0, y + 61.0, 1.4, tint);
        cx += cw + 6.0;
    }
}

/// Group invite toast (top-center) + member rail. Emits GroupAccept/Decline.
pub fn draw_group(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    sw: f32,
    out: &mut Vec<HudAction>,
) {
    if let Some(inviter) = &st.group_invite_from {
        let w = 340.0;
        let x = (sw - w) * 0.5;
        let y = 18.0;
        ui.panel(x, y, w, 58.0, pal.bg_panel, pal.accent);
        ui.text("GROUP INVITE", x + 10.0, y + 6.0, 1.5, pal.ink_dim);
        ui.text(inviter, x + 10.0, y + 20.0, 2.0, pal.ink);
        let style = button_style(pal);
        if ui.button(x + w - 150.0, y + 26.0, 66.0, 22.0, "JOIN", style) {
            out.push(HudAction::GroupAccept);
        }
        if ui.button(x + w - 78.0, y + 26.0, 66.0, 22.0, "DECLINE", style) {
            out.push(HudAction::GroupDecline);
        }
    }

    // Member rail: one compact chip per OTHER member (≤5 + overflow count).
    if st.group_members.is_empty() {
        return;
    }
    let x = 16.0;
    let mut y = 110.0;
    for member in st.group_members.iter().take(GROUP_CHIP_MAX) {
        let w = 180.0;
        ui.panel(x, y, w, 30.0, pal.bg_panel, pal.hairline);
        if member.leader {
            ui.rect(x + 4.0, y + 4.0, 4.0, 4.0, pal.accent); // leader pip
        }
        ui.text(&member.name, x + 12.0, y + 4.0, 1.5, pal.ink);
        let tag = if member.link_dead {
            Some(("LD", pal.ink_dim))
        } else if member.down {
            Some(("DOWN", pal.danger))
        } else {
            None
        };
        if let Some((t, tint)) = tag {
            let tw = UiBuilder::text_width(t, 1.4);
            ui.text(t, x + w - tw - 6.0, y + 4.0, 1.4, tint);
        }
        // Health sliver.
        ui.rect(x + 12.0, y + 20.0, w - 24.0, 4.0, pal.bg_cell);
        let frac = member.health_frac.clamp(0.0, 1.0);
        if frac > 0.0 {
            let tint = if frac <= 0.25 { pal.danger } else { pal.accent };
            ui.rect(x + 12.0, y + 20.0, (w - 24.0) * frac, 4.0, tint);
        }
        y += 34.0;
    }
    let overflow = st.group_members.len().saturating_sub(GROUP_CHIP_MAX);
    if overflow > 0 {
        ui.text(&format!("+{overflow} MORE"), x, y + 2.0, 1.4, pal.ink_dim);
    }
}

/// ACTION QUEUE — vertically stacked combat queue rows under the radar.
/// Click a row to cancel it (routes `CancelAbilityQueue`).
pub fn draw_queue(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    x: f32,
    y: f32,
    out: &mut Vec<HudAction>,
) {
    if st.queue.is_empty() && !st.repeat_armed {
        return;
    }
    let w = 232.0;
    let mut ry = y;
    if st.repeat_armed {
        ui.text("REPEAT ARMED", x + 4.0, ry, 1.4, pal.accent);
        ry += 14.0;
    }
    for entry in st.queue.iter().take(QUEUE_ROW_MAX) {
        let h = 26.0;
        let (edge, label_tint) = match entry.state {
            QueueEntryStateHud::Ready => (pal.accent, pal.ink),
            QueueEntryStateHud::Fired => (pal.accent, pal.accent),
            QueueEntryStateHud::Rejected => (pal.danger, pal.danger),
            QueueEntryStateHud::Queued => (pal.hairline, pal.ink),
        };
        ui.panel(x, ry, w, h, pal.bg_panel, edge);
        ui.text(&entry.label, x + 6.0, ry + 4.0, 1.5, label_tint);
        if entry.state == QueueEntryStateHud::Rejected && !entry.reason.is_empty() {
            ui.text(&entry.reason, x + 6.0, ry + 15.0, 1.3, pal.danger);
        } else if !entry.target_label.is_empty() {
            ui.text(&entry.target_label, x + 6.0, ry + 15.0, 1.3, pal.ink_dim);
        }
        // Cancel gadget.
        if ui.interact(x + w - 20.0, ry + 4.0, 16.0, 16.0).clicked {
            out.push(HudAction::QueueCancel(entry.entry_id.clone()));
        }
        ui.text("X", x + w - 16.0, ry + 6.0, 1.5, pal.ink_dim);
        ry += h + 4.0;
    }
}

/// Interaction chip: `[F] VERB` bottom-center, with an optional hold fill
/// (loot hold-to-take-all radial, drawn as a horizontal sweep).
pub fn draw_interact_chip(ui: &mut UiBuilder, pal: &Palette, chip: &InteractHud, cx: f32, y: f32) {
    let text_w = UiBuilder::text_width(&chip.label, 1.8);
    let w = text_w + 20.0;
    let x = cx - w * 0.5;
    ui.panel(x, y, w, 24.0, pal.bg_panel, pal.hairline);
    if let Some(frac) = chip.hold_frac {
        ui.rect(x, y + 21.0, w * frac.clamp(0.0, 1.0), 3.0, pal.accent);
    }
    ui.text(&chip.label, x + 10.0, y + 5.0, 1.8, pal.ink);
}

fn draw_banner_line(ui: &mut UiBuilder, pal: &Palette, banner: &BannerHud, cx: f32, y: f32) {
    let text_w = UiBuilder::text_width(&banner.text, 1.7);
    let w = text_w + 18.0;
    let x = cx - w * 0.5;
    let tint = if banner.bad { pal.danger } else { pal.accent };
    ui.rect(x, y, w, 20.0, pal.bg_panel);
    ui.border(x, y, w, 20.0, 1.0, tint);
    ui.text(&banner.text, x + 9.0, y + 4.0, 1.7, tint);
}

/// Extraction/camp toast (one step above the toolbar) + the command
/// rejection/status banner. Both auto-expire on `until_ms`.
pub fn draw_toasts(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    now_ms: u64,
    sw: f32,
    sh: f32,
) {
    if let Some(toast) = &st.extraction_toast {
        if toast.until_ms > now_ms {
            draw_banner_line(ui, pal, toast, sw * 0.5, sh - 200.0);
        }
    }
    if let Some(banner) = &st.banner {
        if banner.until_ms > now_ms {
            draw_banner_line(ui, pal, banner, sw * 0.5, sh - 226.0);
        }
    }
}

/// FIRST STEPS — progressive one-shot guidance rows (bounded, no nag).
pub fn draw_first_steps(ui: &mut UiBuilder, pal: &Palette, st: &HudState, x: f32, y: f32) {
    if st.first_steps.is_empty() {
        return;
    }
    let mut ry = y;
    ui.text("FIRST STEPS", x, ry, 1.4, pal.ink_dim);
    ry += 14.0;
    for row in st.first_steps.iter().take(super::FIRST_STEP_ROW_MAX) {
        let tint = if row.done { pal.ink_dim } else { pal.ink };
        if !row.key.is_empty() {
            let kw = UiBuilder::text_width(&row.key, 1.5) + 6.0;
            ui.rect(x, ry, kw, 13.0, pal.bg_cell);
            ui.border(x, ry, kw, 13.0, 1.0, pal.hairline);
            ui.text(&row.key, x + 3.0, ry + 2.0, 1.5, pal.accent);
            ui.text(&row.text, x + kw + 6.0, ry + 2.0, 1.5, tint);
        } else {
            ui.text(&row.text, x, ry + 2.0, 1.5, tint);
        }
        if row.done {
            // Strike-through for completed rows.
            let tw = UiBuilder::text_width(&row.text, 1.5);
            ui.rect(x, ry + 7.0, tw + 14.0, 1.0, pal.ink_dim);
        }
        ry += 16.0;
    }
}

/// DEATH / CLONE overlay — fullscreen state driven by the server life state.
/// Backdrop is visual-only; only the panel takes clicks (chat stays usable).
pub fn draw_death_overlay(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    sw: f32,
    sh: f32,
    out: &mut Vec<HudAction>,
) {
    if st.life == LifeHud::Alive {
        return;
    }
    // Screen-edge vignette (visual only).
    let edge = [pal.danger[0], pal.danger[1], pal.danger[2], 46];
    ui.rect(0.0, 0.0, sw, 42.0, edge);
    ui.rect(0.0, sh - 42.0, sw, 42.0, edge);
    ui.rect(0.0, 42.0, 42.0, sh - 84.0, edge);
    ui.rect(sw - 42.0, 42.0, 42.0, sh - 84.0, edge);

    let w = 360.0;
    let h = 120.0;
    let x = (sw - w) * 0.5;
    let y = sh * 0.28;
    ui.panel(x, y, w, h, pal.bg_panel, pal.danger);
    let (title, help) = if st.life == LifeHud::Downed {
        ("YOU ARE DOWN", "HOLD FOR AID — OR BURN A CLONE TO GIVE UP.")
    } else {
        ("YOU DIED", "ACTIVATE A CLONE TO RETURN TO THE FIELD.")
    };
    let tw = UiBuilder::text_width(title, 3.0);
    ui.text(title, x + (w - tw) * 0.5, y + 12.0, 3.0, pal.danger);
    let hw = UiBuilder::text_width(help, 1.5);
    ui.text(help, x + (w - hw) * 0.5, y + 44.0, 1.5, pal.ink_dim);
    let mut style = button_style(pal);
    style.edge = pal.danger;
    if ui.button(
        x + (w - 180.0) * 0.5,
        y + 68.0,
        180.0,
        30.0,
        "ACTIVATE CLONE",
        style,
    ) {
        out.push(HudAction::CloneRespawn);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::{palette, Icons};
    use successor_engine_render::ui::UiBuilder;

    fn ui() -> UiBuilder {
        UiBuilder::new(Icons::load().meta)
    }

    #[test]
    fn disconnected_plate_draws_without_actions() {
        let mut ui = ui();
        ui.begin(1280, 720);
        let st = HudState::default();
        let mut out = Vec::new();
        draw_status_plate(&mut ui, &palette(0), &st, 16.0, 542.0, &mut out);
        assert!(ui.quads > 0);
        assert!(out.is_empty());
    }

    #[test]
    fn run_button_click_emits_toggle_sprint() {
        let mut ui = ui();
        let st = HudState::default();
        let pal = palette(0);
        // RUN button rect: x = 16 + PLATE_W - 62, y = 100 + 20, 54x18.
        let bx = 16.0 + PLATE_W - 62.0 + 20.0;
        let by = 100.0 + 20.0 + 9.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw_status_plate(&mut ui, &pal, &st, 16.0, 100.0, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_status_plate(&mut ui, &pal, &st, 16.0, 100.0, &mut out);
        assert_eq!(out, vec![HudAction::ToggleSprint]);
    }

    #[test]
    fn death_overlay_only_when_not_alive() {
        let mut ui = ui();
        ui.begin(1280, 720);
        let mut st = HudState::default();
        let mut out = Vec::new();
        draw_death_overlay(&mut ui, &palette(0), &st, 1280.0, 720.0, &mut out);
        assert_eq!(ui.quads, 0);
        st.life = LifeHud::Respawning;
        ui.begin(1280, 720);
        draw_death_overlay(&mut ui, &palette(0), &st, 1280.0, 720.0, &mut out);
        assert!(ui.quads > 0);
    }

    #[test]
    fn queue_rows_are_bounded_and_cancelable() {
        let mut ui = ui();
        let pal = palette(0);
        let mut st = HudState::default();
        for i in 0..10 {
            st.queue.push(crate::hud::QueueEntryHud {
                entry_id: format!("q{i}"),
                label: "SHOT".into(),
                target_label: "TARGET".into(),
                state: QueueEntryStateHud::Queued,
                reason: String::new(),
            });
        }
        // Click the first row's cancel gadget: x=1038+232-20+8, y=200+4+8.
        let bx = 1038.0 + 232.0 - 20.0 + 8.0;
        let by = 200.0 + 4.0 + 8.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw_queue(&mut ui, &pal, &st, 1038.0, 200.0, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_queue(&mut ui, &pal, &st, 1038.0, 200.0, &mut out);
        assert_eq!(out, vec![HudAction::QueueCancel("q0".into())]);
    }

    #[test]
    fn group_invite_join_and_decline() {
        let mut ui = ui();
        let pal = palette(0);
        let st = HudState {
            group_invite_from: Some("KESTREL".into()),
            ..HudState::default()
        };
        // JOIN button: x = (1280-340)/2 + 340 - 150 + 33, y = 18 + 26 + 11.
        let bx = (1280.0 - 340.0) * 0.5 + 340.0 - 150.0 + 33.0;
        let by = 18.0 + 26.0 + 11.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw_group(&mut ui, &pal, &st, 1280.0, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_group(&mut ui, &pal, &st, 1280.0, &mut out);
        assert_eq!(out, vec![HudAction::GroupAccept]);
    }
}
