//! Status plate, target plate, group HUD, ability queue, interact chip,
//! toasts/banners, first steps and the death/clone overlay — ports of the
//! `client-3d` HUD panes (`statusPlate.ts`, `targetPlate.ts`, `groupHud.ts`,
//! `combatQueue.ts`, `extractionHud.ts`, `firstSteps.ts`, `deathOverlay.ts`)
//! onto the immediate-mode `UiBuilder`.

use successor_engine_render::ui::{ButtonStyle, UiBuilder};

use super::{
    BannerHud, GaugeHud, HudAction, HudState, InteractHud, LifeHud, Palette, QueueEntryStateHud,
    RelationHud, SprintHud, TargetHud, GROUP_CHIP_MAX, QUEUE_ROW_MAX,
};

/// Physical magazine pips cap (reference `MAX_PIPS`).
pub const MAX_PIPS: u32 = 48;

/// Measured player-status content well.
///
/// The height is exactly what the pane always draws: 4 top pad + 17 name/RUN
/// row + 33 pool stack + 5 floor. State chips ride the name row instead of
/// claiming a band of their own, and the weapon/magazine readout is its own
/// pane, so nothing here is reserved for content that may not exist. The
/// target, the group roster, and the weapon readout are separate panes of the
/// same grammar.
pub const PLATE_W: f32 = 300.0;
pub const PLATE_H: f32 = 59.0;

/// Weapon/magazine pane: one label+rounds row over the pip or swing bar.
pub const WEAPON_PLATE_W: f32 = 300.0;
pub const WEAPON_PLATE_H: f32 = 30.0;

/// One group member chip: name/state row over a health sliver, plus the gap to
/// the next chip. The reserved group rail is sized from these.
pub const GROUP_CHIP_H: f32 = 30.0;
pub const GROUP_CHIP_GAP: f32 = 4.0;

fn button_style(pal: &Palette) -> ButtonStyle {
    ButtonStyle {
        fill: pal.bg_cell,
        hover: pal.accent_soft,
        active: pal.accent_soft,
        edge: pal.hairline,
        text: pal.ink,
    }
}
pub(crate) fn readable_dim(pal: &Palette) -> [u8; 4] {
    let mut dim = pal.ink_dim;
    dim[3] = 230;
    dim
}

/// Hostility tint mapping derived systematically from [`RelationHud`] for target
/// plate names, frame accents, world nameplates, and target selection brackets.
pub fn hostility_tint(relation: RelationHud, pal: &Palette) -> [u8; 4] {
    relation.tint(pal)
}

/// Longest player weapon reach the authority will accept, in cells (== metres:
/// `WORLD_UNITS_PER_CELL` is 1.0). Mirrors the 18_000 milli-cell ceiling in the
/// authority's weapon profiles (`crates/successor-sim/src/authority/helpers.rs`).
/// The plate dims past this because `combat_roll.rs:1957` rejects the swing.
pub const MAX_WEAPON_REACH_CELLS: f32 = 18.0;

/// Pool tints. The original status window gives each pool its own hue so the
/// triple bar reads at a glance; only the third pool follows the theme accent.
pub const POOL_HEALTH: [u8; 4] = [0xD8, 0x42, 0x42, 255];
pub const POOL_ACTION: [u8; 4] = [0x68, 0xD0, 0x74, 255];

/// One pool in a status stack. The tint is the pool's identity, exactly as in
/// the original status window — there is no per-row word label to spend height
/// on; `value` is the compact `current/max` readout.
#[derive(Clone, Copy)]
pub struct Pool<'a> {
    pub gauge: &'a GaugeHud,
    pub tint: [u8; 4],
    pub value: &'a str,
}

/// Row pitch of a pool stack: a 7 px track plus its gap. The original packs
/// its three bars into roughly this rhythm.
pub const POOL_ROW_H: f32 = 11.0;
/// Readout glyph size inside a pool row.
const POOL_VALUE_PX: f32 = 1.1;
/// Height of a pool stack of `count` rows.
pub fn pool_stack_h(count: usize) -> f32 {
    POOL_ROW_H * count as f32
}

/// `current/max` readout for a pool, or `--` when the pool is unknown.
fn reading(g: &GaugeHud) -> String {
    if g.max > 0.0 {
        format!(
            "{}/{}",
            g.value.max(0.0).round() as i64,
            g.max.round() as i64
        )
    } else {
        "--".to_string()
    }
}

/// Draw a stack of pool rows into `rect`.
///
/// Track length encodes each pool's *maximum* relative to the deepest pool in
/// the stack, and the fill encodes current/max — the original status window's
/// convention, where a deeper pool is visibly a longer bar (measured off the
/// clean world-entry capture: 120/143/159 px tracks for 700/900/1000 pools).
/// Low pools (≤25%) tint toward danger.
///
/// `mirrored` flips the whole stack: labels and tracks anchor to the right
/// edge and readouts run down the left, which is how the original's target
/// window mirrors the player's.
fn draw_pools(
    ui: &mut UiBuilder,
    pal: &Palette,
    rect: [f32; 4],
    pools: &[Pool<'_>],
    mirrored: bool,
    dead: bool,
) {
    let [x, y, column, band_h] = rect;
    let value_w = pools
        .iter()
        .fold(0.0f32, |widest, pool| {
            widest.max(ui.measure_text(pool.value, POOL_VALUE_PX))
        })
        .min(column * 0.4);
    let track_room = (column - value_w - 6.0).max(16.0);
    let deepest = pools
        .iter()
        .fold(0.0f32, |deepest, pool| deepest.max(pool.gauge.max));
    for (index, pool) in pools.iter().enumerate() {
        let row_y = y + index as f32 * POOL_ROW_H;
        // A resized pane drops rows it cannot show rather than painting them
        // outside its own bounds.
        if row_y + POOL_ROW_H > y + band_h + 0.5 {
            break;
        }
        let track_w = if deepest <= 0.0 {
            track_room
        } else {
            (track_room * (pool.gauge.max / deepest)).max(16.0)
        };
        let (track_x, value_x) = if mirrored {
            (
                x + column - track_w,
                x + value_w - ui.measure_text(pool.value, POOL_VALUE_PX),
            )
        } else {
            (x, x + column - ui.measure_text(pool.value, POOL_VALUE_PX))
        };
        ui.rect(track_x, row_y, track_w, 7.0, pal.bg_cell);
        let frac = if dead { 0.0 } else { pool.gauge.frac() };
        if frac > 0.0 {
            let fill = if pool.gauge.low() {
                pal.danger
            } else {
                pool.tint
            };
            let filled = track_w * frac;
            let fill_x = if mirrored {
                track_x + track_w - filled
            } else {
                track_x
            };
            ui.rect(fill_x, row_y, filled, 7.0, fill);
        }
        let val_tint = if dead { pal.ink_dim } else { readable_dim(pal) };
        ui.text(pool.value, value_x, row_y, POOL_VALUE_PX, val_tint);
    }
}

/// Player status plate: tags, the three pool bars, RUN toggle and the magazine
/// pips / swing timer. Emits [`HudAction::ToggleSprint`] on RUN click.
///
/// `rect` is the pane's live bounds. Bands stack from the top and each one is
/// skipped when the pane is too short for it, so a resized plate condenses
/// instead of spilling. The notification strip owns the connection/area line.
pub fn draw_status_plate(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    rect: [f32; 4],
    out: &mut Vec<HudAction>,
) {
    let [x, y, plate_w, plate_h] = rect;
    let bottom = y + plate_h;
    let mut backing = pal.bg_panel;
    backing[3] = 230;
    ui.rect(x, y, plate_w, plate_h, backing);

    // ── State chips ride the name row ────────────────────────────────────
    // A dedicated tag band spent 13 px on content most sessions never carry.
    // The chips are short, the name row is 17 px tall, and the original keeps
    // state flags beside the name rather than above it.
    let mut cursor = y + 4.0;

    // ── Name + RUN toggle share one row ──────────────────────────────────
    let (run_label, run_tint) = match st.sprint {
        SprintHud::Off => ("RUN", pal.ink_dim),
        SprintHud::On => ("RUN", pal.accent),
        SprintHud::Winded => ("WINDED", pal.danger),
    };
    let run_w = 50.0f32.min((plate_w - 24.0).max(0.0));
    let run_x = x + plate_w - run_w - 6.0;
    let name_room = (run_x - (x + 8.0) - 6.0).max(0.0);
    let (name, name_clipped) = clip_name(ui, &st.name, 1.9, name_room);
    let name_end = ui.text(name, x + 8.0, cursor, 1.9, pal.accent);
    if name_clipped {
        ui.text("...", name_end, cursor, 1.9, pal.accent);
    }
    let mut style = button_style(pal);
    style.text = run_tint;
    if st.sprint == SprintHud::On {
        style.edge = pal.accent;
    }
    if run_w >= 30.0 && ui.button(run_x, cursor - 2.0, run_w, 16.0, run_label, style) {
        out.push(HudAction::ToggleSprint);
    }
    cursor += 17.0;

    // ── Pools: three tight bars, the original's whole status readout ─────
    let column = (plate_w - 16.0).max(48.0);
    let stack_room = (bottom - cursor - 4.0).max(0.0);
    draw_pools(
        ui,
        pal,
        [x + 8.0, cursor, column, stack_room.min(pool_stack_h(3))],
        &[
            Pool {
                gauge: &st.health,
                tint: POOL_HEALTH,
                value: &st.health_text,
            },
            Pool {
                gauge: &st.action,
                tint: POOL_ACTION,
                value: &st.action_text,
            },
            Pool {
                gauge: &st.spirit,
                tint: pal.accent,
                value: &st.spirit_text,
            },
        ],
        false,
        false,
    );
    cursor += stack_room.min(pool_stack_h(3));

    // Chips ride the right of the name row, so nothing below the pools is
    // reserved. `cursor` is retained only to document that the pane ends here.
    let _ = cursor;
    draw_state_chips(ui, pal, st, x, y + 4.0, run_x - (x + 8.0));
}

/// State flags as compact chips on the name row, right-aligned into the space
/// the name did not use. Dropped entirely when the row is too narrow — a
/// truncated flag is worse than none.
fn draw_state_chips(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    x: f32,
    y: f32,
    row_w: f32,
) {
    let mut right = x + 8.0 + row_w;
    let mut chip = |ui: &mut UiBuilder, text: &str, tint: [u8; 4]| {
        let w = ui.measure_text(text, 1.3) + 8.0;
        if right - w < x + 8.0 {
            return;
        }
        ui.rect(right - w, y + 2.0, w, 11.0, pal.bg_cell);
        ui.text(text, right - w + 4.0, y + 4.0, 1.3, tint);
        right -= w + 5.0;
    };
    if st.life != LifeHud::Alive {
        let stamp = if st.life == LifeHud::Respawning {
            "DEAD"
        } else {
            "DOWN"
        };
        chip(ui, stamp, pal.danger);
    }
    if let Some(sick) = &st.clone_sickness {
        chip(ui, sick, pal.ink_dim);
    }
    if let Some(campdown) = &st.camp_countdown {
        chip(ui, campdown, pal.danger);
    }
    if let Some(sampler) = &st.sampler_text {
        chip(ui, sampler, pal.accent);
    }
    if st.sheltered {
        chip(ui, "SHELTERED", pal.accent);
    }
    if st.observer {
        chip(ui, "OBSERVER", pal.ink_dim);
    }
}

/// Weapon/magazine pane: the label, the round count, and either the magazine
/// pips or the melee swing timer.
///
/// Its own pane rather than a band inside the status plate: it exists only
/// while something is wielded, and a plate sized to hold it stands half empty
/// the rest of the time. Nothing is painted when there is no weapon, so the
/// registered pane is invisible until it has something to say.
pub fn draw_weapon_plate(ui: &mut UiBuilder, pal: &Palette, st: &HudState, rect: [f32; 4]) {
    let Some(weapon) = &st.weapon else {
        return;
    };
    let [x, y, w, h] = rect;
    let bottom = y + h;
    let mut backing = pal.bg_panel;
    backing[3] = 230;
    ui.rect(x, y, w, h, backing);

    let mut cursor = y + 3.0;
    if cursor + 10.0 > bottom {
        return;
    }
    ui.text(&weapon.label, x + 8.0, cursor, 1.4, pal.ink);
    let rounds_x = x + 8.0 + ui.measure_text(&weapon.label, 1.4) + 8.0;
    ui.text(&weapon.rounds_text, rounds_x, cursor, 1.4, pal.ink_dim);
    cursor += 11.0;
    if cursor + 6.0 > bottom {
        return;
    }
    let bar_w = (w - 16.0).max(0.0);
    let bar_x = x + 8.0;
    if weapon.melee {
        // Swing timer: fill sweeps to READY where pips normally live.
        ui.rect(bar_x, cursor, bar_w, 6.0, pal.bg_cell);
        let fill = weapon.swing_frac.clamp(0.0, 1.0);
        let tint = if weapon.swing_ready {
            pal.accent
        } else {
            pal.ink_dim
        };
        ui.rect(bar_x, cursor, bar_w * fill, 6.0, tint);
    } else if weapon.magazine_size > 0 {
        // One pip per round (<=48); reload sweeps the pips back in.
        let count = weapon.magazine_size.min(MAX_PIPS);
        let filled = if weapon.reloading {
            ((weapon.reload_frac * count as f32).floor() as u32).min(count)
        } else {
            weapon.loaded_rounds.min(count)
        };
        let pip_w = (bar_w / count as f32 - 2.0).clamp(2.0, 10.0);
        for index in 0..count {
            let px = bar_x + index as f32 * (pip_w + 2.0);
            let tint = if index < filled { pal.accent } else { pal.bg_cell };
            ui.rect(px, cursor, pip_w, 6.0, tint);
        }
    }
}

/// Longest prefix of `name` that fits `max_w`, and whether it was cut.
fn clip_name<'a>(ui: &UiBuilder, name: &'a str, px: f32, max_w: f32) -> (&'a str, bool) {
    if ui.measure_text(name, px) <= max_w {
        return (name, false);
    }
    let budget = (max_w - ui.measure_text("...", px)).max(0.0);
    let mut end = 0;
    let mut width = 0.0;
    for (offset, ch) in name.char_indices() {
        let advance = ui.measure_text(&name[offset..offset + ch.len_utf8()], px);
        if width + advance > budget {
            break;
        }
        width += advance;
        end = offset + ch.len_utf8();
    }
    (&name[..end], true)
}

/// Target status plate: the player plate mirrored — relation-tinted name and
/// rail on the right, pool tracks anchored right with their readouts down the
/// left, then range/level and state chips.
///
/// `rect` is the pane's live bounds. Each band is skipped when the pane is too
/// short for it, so nothing escapes the container on a resize.
pub fn draw_target_plate(ui: &mut UiBuilder, pal: &Palette, target: &TargetHud, rect: [f32; 4]) {
    let [x, y, w, h] = rect;
    let bottom = y + h;
    let dead = !target.alive;
    let out_of_range = target
        .distance_m
        .is_some_and(|d| !d.is_finite() || d > MAX_WEAPON_REACH_CELLS);

    let tint = if dead {
        readable_dim(pal)
    } else {
        hostility_tint(target.relation, pal)
    };
    let accent_rail_tint = if dead {
        pal.bg_cell
    } else {
        hostility_tint(target.relation, pal)
    };

    let mut backing = pal.bg_panel;
    backing[3] = 220;
    ui.rect(x, y, w, h, backing);

    // Relation rail on the right edge: the target plate is the player plate
    // mirrored. Suppressed when dead.
    ui.rect(x + w - 3.0, y, 3.0, h, accent_rail_tint);

    let mut cursor = y + 4.0;
    if cursor + 14.0 > bottom {
        return;
    }

    // Top row: Level chip (left of name), Name (right-aligned), Stamp (if any).
    let stamp_w = target
        .stamp
        .map(|stamp| ui.measure_text(stamp, 1.6) + 10.0 + 6.0)
        .unwrap_or(0.0);

    let level_str = target.level.map(|lvl| format!("{lvl}"));
    let level_chip_w = level_str
        .as_ref()
        .map(|s| ui.measure_text(s, 1.2) + 6.0)
        .unwrap_or(0.0);
    let level_w = if level_str.is_some() {
        level_chip_w + 4.0
    } else {
        0.0
    };

    let name_room = (w - 18.0 - stamp_w - level_w).max(0.0);
    let (name, name_clipped) = clip_name(ui, &target.name, 1.9, name_room);
    let name_w = ui.measure_text(name, 1.9)
        + if name_clipped {
            ui.measure_text("...", 1.9)
        } else {
            0.0
        };

    let name_end = ui.text(name, x + w - 8.0 - name_w, cursor, 1.9, tint);
    if name_clipped {
        ui.text("...", name_end, cursor, 1.9, tint);
    }

    // Strike-through line for dead target name
    if dead && name_w > 0.0 {
        ui.line(
            x + w - 8.0 - name_w,
            cursor + 7.0,
            x + w - 8.0,
            cursor + 7.0,
            1.0,
            readable_dim(pal),
        );
    }

    // Level chip left of the name
    if let Some(ref lvl_s) = level_str {
        let chip_x = x + w - 8.0 - name_w - level_chip_w - 4.0;
        if chip_x >= x + 6.0 {
            ui.rect(chip_x, cursor + 2.0, level_chip_w, 13.0, pal.bg_cell);
            ui.text(
                lvl_s,
                chip_x + 3.0,
                cursor + 3.0,
                1.2,
                if dead { pal.ink_dim } else { readable_dim(pal) },
            );
        }
    }

    if let Some(stamp) = target.stamp {
        let sw = ui.measure_text(stamp, 1.6);
        ui.rect(x + 6.0, cursor - 1.0, sw + 10.0, 14.0, pal.danger);
        ui.text(stamp, x + 11.0, cursor, 1.6, [10, 10, 10, 255]);
    }
    cursor += 17.0;

    // Sub-row: Compact distance right-aligned under name (if present)
    if cursor + 10.0 <= bottom {
        if let Some(distance) = target.distance_m {
            let (dist_text, dist_tint) = if !distance.is_finite() || distance > MAX_WEAPON_REACH_CELLS {
                ("OUT OF RANGE".to_string(), pal.danger)
            } else {
                (
                    format!("{:.0}M", distance.max(0.0)),
                    if dead { pal.ink_dim } else { readable_dim(pal) },
                )
            };
            let dist_w = ui.measure_text(&dist_text, 1.2);
            ui.text(
                &dist_text,
                x + w - 8.0 - dist_w,
                cursor,
                1.2,
                dist_tint,
            );
            cursor += 12.0;
        }
    }

    // Pools, mirrored. Empty when dead.
    let hp = &target.health;
    let hp_text = reading(hp);
    let action_text = target.action.as_ref().map(reading);
    let spirit_text = target.spirit.as_ref().map(reading);
    let health_pool = Pool {
        gauge: hp,
        tint: if dead { readable_dim(pal) } else { POOL_HEALTH },
        value: &hp_text,
    };
    let mut pools = [health_pool; 3];
    let mut pool_count = 1;
    if let (Some(action), Some(text)) = (target.action.as_ref(), action_text.as_deref()) {
        pools[pool_count] = Pool {
            gauge: action,
            tint: if dead { readable_dim(pal) } else { POOL_ACTION },
            value: text,
        };
        pool_count += 1;
    }
    if let (Some(spirit), Some(text)) = (target.spirit.as_ref(), spirit_text.as_deref()) {
        pools[pool_count] = Pool {
            gauge: spirit,
            tint: if dead { readable_dim(pal) } else { pal.accent },
            value: text,
        };
        pool_count += 1;
    }
    let stack_h = pool_stack_h(pool_count).min((bottom - cursor - 2.0).max(0.0));
    draw_pools(
        ui,
        pal,
        [x + 8.0, cursor, (w - 16.0).max(48.0), stack_h],
        &pools[..pool_count],
        true,
        dead,
    );
    cursor += stack_h + 3.0;

    // State chips (max 4), right-aligned on the band under the readouts.
    // Dimmed when out of range or dead.
    let mut cx = x + w - 8.0;
    for chip in &target.chips {
        let cw = ui.measure_text(&chip.label, 1.3) + 8.0;
        if cx - cw < x + 6.0 || cursor + 12.0 > bottom {
            break;
        }
        let chip_tint = if dead || out_of_range {
            pal.ink_dim
        } else if chip.danger {
            pal.danger
        } else {
            pal.ink_dim
        };
        ui.rect(cx - cw, cursor, cw, 12.0, pal.bg_cell);
        ui.text(&chip.label, cx - cw + 4.0, cursor + 2.0, 1.3, chip_tint);
        cx -= cw + 5.0;
    }
}

/// Group invite toast (top-center) + member rail. Emits GroupAccept/Decline.
///
/// `rail` is the reserved group rect directly beneath the player status plate;
/// members stack down it and stop at its floor rather than running under the
/// panes below.
pub fn draw_group(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    sw: f32,
    rail: [f32; 4],
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
    let [x, rail_y, rail_w, rail_h] = rail;
    let rail_bottom = rail_y + rail_h;
    let mut y = rail_y;
    for member in st.group_members.iter().take(GROUP_CHIP_MAX) {
        let w = rail_w;
        if y + GROUP_CHIP_H > rail_bottom {
            break;
        }
        ui.panel(x, y, w, GROUP_CHIP_H, pal.bg_panel, pal.hairline);
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
            let tw = ui.measure_text(t, 1.4);
            ui.text(t, x + w - tw - 6.0, y + 4.0, 1.4, tint);
        }
        // Health sliver.
        ui.rect(x + 12.0, y + 20.0, w - 24.0, 4.0, pal.bg_cell);
        let frac = member.health_frac.clamp(0.0, 1.0);
        if frac > 0.0 {
            let tint = if frac <= 0.25 { pal.danger } else { pal.accent };
            ui.rect(x + 12.0, y + 20.0, (w - 24.0) * frac, 4.0, tint);
        }
        y += GROUP_CHIP_H + GROUP_CHIP_GAP;
    }
    let overflow = st.group_members.len().saturating_sub(GROUP_CHIP_MAX);
    if overflow > 0 && y + 8.0 <= rail_bottom {
        ui.text(&format!("+{overflow} MORE"), x, y + 2.0, 1.4, pal.ink_dim);
    }
}

/// ACTION QUEUE — vertically stacked combat queue rows.
/// Click a row's gadget to cancel it (routes `CancelAbilityQueue`).
///
/// `rect` is the pane's live bounds; rows stop at its bottom edge.
pub fn draw_queue(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    rect: [f32; 4],
    out: &mut Vec<HudAction>,
) {
    if st.queue.is_empty() && !st.repeat_armed {
        return;
    }
    let [x, y, w, pane_h] = rect;
    let bottom = y + pane_h;
    let mut ry = y;
    if st.repeat_armed {
        ui.text("REPEAT ARMED", x + 4.0, ry, 1.4, pal.accent);
        ry += 14.0;
    }
    for entry in st.queue.iter().take(QUEUE_ROW_MAX) {
        let h = 26.0;
        if ry + h > bottom {
            break;
        }
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
    let text_w = ui.measure_text(&chip.label, 1.8);
    let w = text_w + 20.0;
    let x = cx - w * 0.5;
    ui.panel(x, y, w, 24.0, pal.bg_panel, pal.hairline);
    if let Some(frac) = chip.hold_frac {
        ui.rect(x, y + 21.0, w * frac.clamp(0.0, 1.0), 3.0, pal.accent);
    }
    ui.text(&chip.label, x + 10.0, y + 5.0, 1.8, pal.ink);
}

fn draw_banner_line(ui: &mut UiBuilder, pal: &Palette, banner: &BannerHud, cx: f32, y: f32) {
    let text_w = ui.measure_text(&banner.text, 1.7);
    let w = text_w + 18.0;
    let x = cx - w * 0.5;
    let tint = if banner.bad { pal.danger } else { pal.accent };
    ui.rect(x, y, w, 20.0, pal.bg_panel);

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
            let kw = ui.measure_text(&row.key, 1.5) + 6.0;
            ui.rect(x, ry, kw, 13.0, pal.bg_cell);

            ui.text(&row.key, x + 3.0, ry + 2.0, 1.5, pal.accent);
            ui.text(&row.text, x + kw + 6.0, ry + 2.0, 1.5, tint);
        } else {
            ui.text(&row.text, x, ry + 2.0, 1.5, tint);
        }
        if row.done {
            // Strike-through for completed rows.
            let tw = ui.measure_text(&row.text, 1.5);
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
        ("YOU ARE DOWN", "HOLD FOR AID - OR BURN A CLONE TO GIVE UP.")
    } else {
        ("YOU DIED", "ACTIVATE A CLONE TO RETURN TO THE FIELD.")
    };
    let tw = ui.measure_text(title, 3.0);
    ui.text(title, x + (w - tw) * 0.5, y + 12.0, 3.0, pal.danger);
    let hw = ui.measure_text(help, 1.5);
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
    use crate::hud::{palette, GroupMemberHud, Icons};
    use successor_engine_render::ui::UiBuilder;

    fn ui() -> UiBuilder {
        UiBuilder::new(Icons::load().meta)
    }

    /// The reserved group rail from the default 1280x720 layout.
    const GROUP_RAIL: [f32; 4] = {
        let l = crate::hud::layout::GROUP_H;
        [0.0, PLATE_H + crate::hud::layout::GUTTER, PLATE_W, l]
    };

    #[test]
    fn disconnected_plate_draws_without_actions() {
        let mut ui = ui();
        ui.begin(1280, 720);
        let st = HudState::default();
        let mut out = Vec::new();
        draw_status_plate(
            &mut ui,
            &palette(0),
            &st,
            [16.0, 542.0, PLATE_W, PLATE_H],
            &mut out,
        );
        assert!(ui.quads > 0);
        assert!(out.is_empty());
    }

    /// Screen-pixel bounds of everything drawn into `ui` this frame, read back
    /// from the NDC vertex buffer (`pos:2, uv:2, color:4`).
    fn drawn_bounds(ui: &UiBuilder, sw: f32, sh: f32) -> [f32; 4] {
        let mut min = [f32::MAX; 2];
        let mut max = [f32::MIN; 2];
        for vertex in ui.buf.chunks_exact(8) {
            let px = (vertex[0] + 1.0) * 0.5 * sw;
            let py = (1.0 - vertex[1]) * 0.5 * sh;
            min[0] = min[0].min(px);
            min[1] = min[1].min(py);
            max[0] = max[0].max(px);
            max[1] = max[1].max(py);
        }
        [min[0], min[1], max[0], max[1]]
    }

    fn populated_state() -> HudState {
        HudState {
            name: "A VERY LONG OPERATIVE NAME".into(),
            health: GaugeHud {
                value: 616.0,
                max: 700.0,
            },
            action: GaugeHud {
                value: 540.0,
                max: 900.0,
            },
            spirit: GaugeHud {
                value: 1000.0,
                max: 1000.0,
            },
            health_text: "616".into(),
            action_text: "540".into(),
            spirit_text: "1000".into(),
            weapon: Some(crate::hud::WeaponHud {
                label: "SLUGTHROWER PISTOL".into(),
                magazine_size: 8,
                loaded_rounds: 6,
                rounds_text: "6/8".into(),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    /// Both status panes are resizable surfaces, so every band has to stay
    /// inside the rect it was handed — at the resize floor as well as the
    /// default size.
    #[test]
    fn status_panes_stay_inside_every_pane_size() {
        let pal = palette(0);
        let st = populated_state();
        let target = TargetHud {
            name: "RAIDER SCOUT WITH A LONG NAME".into(),
            relation: crate::hud::RelationHud::Hostile,
            health: GaugeHud {
                value: 434.0,
                max: 700.0,
            },
            action: Some(GaugeHud {
                value: 720.0,
                max: 900.0,
            }),
            spirit: Some(GaugeHud {
                value: 850.0,
                max: 1000.0,
            }),
            distance_m: Some(23.0),
            level: Some(12),
            alive: true,
            stamp: Some("DOWN"),
            chips: vec![
                crate::hud::ChipHud {
                    label: "HOSTILE".into(),
                    danger: true,
                },
                crate::hud::ChipHud {
                    label: "SHIELDED".into(),
                    danger: false,
                },
            ],
            ..Default::default()
        };
        for size in [
            [180.0, 44.0],
            [200.0, 56.0],
            [PLATE_W, PLATE_H],
            [420.0, 160.0],
        ] {
            let rect = [40.0, 60.0, size[0], size[1]];
            let mut plate_ui = ui();
            plate_ui.begin(1280, 720);
            let mut out = Vec::new();
            draw_status_plate(&mut plate_ui, &pal, &st, rect, &mut out);
            let bounds = drawn_bounds(&plate_ui, 1280.0, 720.0);
            assert!(
                bounds[0] >= rect[0] - 0.5
                    && bounds[1] >= rect[1] - 0.5
                    && bounds[2] <= rect[0] + rect[2] + 0.5
                    && bounds[3] <= rect[1] + rect[3] + 0.5,
                "player plate escaped {rect:?}: {bounds:?}"
            );

            let mut target_ui = ui();
            target_ui.begin(1280, 720);
            draw_target_plate(&mut target_ui, &pal, &target, rect);
            let bounds = drawn_bounds(&target_ui, 1280.0, 720.0);
            assert!(
                bounds[0] >= rect[0] - 0.5
                    && bounds[1] >= rect[1] - 0.5
                    && bounds[2] <= rect[0] + rect[2] + 0.5
                    && bounds[3] <= rect[1] + rect[3] + 0.5,
                "target plate escaped {rect:?}: {bounds:?}"
            );
        }
    }

    #[test]
    fn run_button_click_emits_toggle_sprint() {
        let mut ui = ui();
        let st = HudState::default();
        let pal = palette(0);
        // RUN shares the name row: 50x16 at the pane's right edge, 6 px in,
        // two pixels above the name baseline (pane y + 4).
        let bx = 16.0 + PLATE_W - 50.0 - 6.0 + 25.0;
        let by = 100.0 + 4.0 - 2.0 + 8.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw_status_plate(
            &mut ui,
            &pal,
            &st,
            [16.0, 100.0, PLATE_W, PLATE_H],
            &mut out,
        );
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_status_plate(
            &mut ui,
            &pal,
            &st,
            [16.0, 100.0, PLATE_W, PLATE_H],
            &mut out,
        );
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
        draw_queue(&mut ui, &pal, &st, [1038.0, 200.0, 232.0, 240.0], &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_queue(&mut ui, &pal, &st, [1038.0, 200.0, 232.0, 240.0], &mut out);
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
        draw_group(&mut ui, &pal, &st, 1280.0, GROUP_RAIL, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw_group(&mut ui, &pal, &st, 1280.0, GROUP_RAIL, &mut out);
        assert_eq!(out, vec![HudAction::GroupAccept]);
    }

    #[test]
    fn group_rail_stacks_under_the_plate_and_stops_at_its_floor() {
        // Six members against a rail with room for two: the rail must clip to
        // its own floor instead of running down over the panes below it.
        let pal = palette(0);
        let members: Vec<GroupMemberHud> = (0..6)
            .map(|i| GroupMemberHud {
                actor_id: format!("actor-{i}"),
                name: format!("MEMBER {i}"),
                leader: i == 0,
                health_frac: 1.0,
                down: false,
                link_dead: false,
            })
            .collect();
        let st = HudState {
            group_members: members,
            ..HudState::default()
        };
        let short_rail = [0.0, 100.0, 300.0, GROUP_CHIP_H * 2.0 + GROUP_CHIP_GAP];

        let mut short_ui = ui();
        short_ui.begin(1280, 720);
        let mut out = Vec::new();
        draw_group(&mut short_ui, &pal, &st, 1280.0, short_rail, &mut out);
        let clipped = short_ui.quads;

        let mut full_ui = ui();
        full_ui.begin(1280, 720);
        out.clear();
        draw_group(&mut full_ui, &pal, &st, 1280.0, GROUP_RAIL, &mut out);
        let full = full_ui.quads;

        // The short rail admits strictly fewer chips than the reserved rail,
        // and the reserved rail is sized to hold the whole capped run.
        assert!(clipped < full, "clipped={clipped} full={full}");
        assert!(
            GROUP_RAIL[3]
                >= GROUP_CHIP_H * GROUP_CHIP_MAX as f32
                    + GROUP_CHIP_GAP * (GROUP_CHIP_MAX as f32 - 1.0)
        );
    }

    #[test]
    fn hostility_tint_systematic_mapping() {
        let pal = palette(0);
        assert_eq!(hostility_tint(RelationHud::Hostile, &pal), pal.danger);
        assert_eq!(hostility_tint(RelationHud::Alerted, &pal), [232, 168, 74, 255]);
        assert_eq!(hostility_tint(RelationHud::Neutral, &pal), pal.ink);
        assert_eq!(hostility_tint(RelationHud::Friendly, &pal), [110, 214, 130, 255]);
        assert_eq!(hostility_tint(RelationHud::Grouped, &pal), pal.accent);
    }

    #[test]
    fn target_plate_level_and_distance_presence_and_absence() {
        let pal = palette(0);
        let t_present = TargetHud {
            name: "TARGET".into(),
            relation: RelationHud::Hostile,
            level: Some(80),
            distance_m: Some(14.2),
            alive: true,
            health: GaugeHud { value: 100.0, max: 100.0 },
            ..Default::default()
        };
        let mut ui_pres = ui();
        ui_pres.begin(1280, 720);
        draw_target_plate(&mut ui_pres, &pal, &t_present, [10.0, 10.0, PLATE_W, PLATE_H]);
        let quads_pres = ui_pres.quads;

        let mut t_absent = t_present.clone();
        t_absent.level = None;
        t_absent.distance_m = None;
        let mut ui_abs = ui();
        ui_abs.begin(1280, 720);
        draw_target_plate(&mut ui_abs, &pal, &t_absent, [10.0, 10.0, PLATE_W, PLATE_H]);
        let quads_abs = ui_abs.quads;

        assert!(quads_pres > quads_abs, "present level/distance must emit quads for level chip & distance text");
    }

    #[test]
    fn dead_target_presentation_in_plate() {
        let pal = palette(0);
        let t_alive = TargetHud {
            name: "TARGET".into(),
            relation: RelationHud::Hostile,
            alive: true,
            health: GaugeHud { value: 100.0, max: 100.0 },
            ..Default::default()
        };
        let mut t_dead = t_alive.clone();
        t_dead.alive = false;

        let mut ui_a = ui();
        ui_a.begin(1280, 720);
        draw_target_plate(&mut ui_a, &pal, &t_alive, [10.0, 10.0, PLATE_W, PLATE_H]);

        let mut ui_d = ui();
        ui_d.begin(1280, 720);
        draw_target_plate(&mut ui_d, &pal, &t_dead, [10.0, 10.0, PLATE_W, PLATE_H]);

        // Dead target plate draws empty pools (fewer filled quads than alive full health) and strike-through line
        assert!(ui_d.quads > 0, "dead target plate must render UI quads");
        assert!(!ui_d.buf.is_empty(), "dead target plate must render vertex data");
    }
}
