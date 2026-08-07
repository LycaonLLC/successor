//! CHARACTER — read-only sheet + the one action: profession-title select.
//!
//! Reads `WindowModel::character` (live `CharacterModel` projection: the
//! decoded player actor, active area, earned title options, career goal).
//! Emits `WindowAction::SetProfessionTitle(<title id>)` — the host maps it
//! onto `ClientCommand::SetProfessionTitle { title_id }`.

use super::{accent, dim, slot, text, WindowAction, WindowModel};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder};

/// Portrait column share of the sheet. The inventory's equipment column takes
/// the original's 232/468 split; the sheet is text-heavy, so it takes a
/// narrower slice of the same portrait.
const PORTRAIT_WIDTH_RATIO: f32 = 0.34;
const PORTRAIT_MIN_W: f32 = 72.0;
const PORTRAIT_MAX_W: f32 = 200.0;
const PORTRAIT_GAP: f32 = 12.0;
/// Doll viewport aspect, from the original's 225x367 paperdoll rect.
const DOLL_ASPECT: f32 = 225.0 / 367.0;

fn bar(ui: &mut UiBuilder, x: f32, y: f32, w: f32, frac: f32, fill: [u8; 4], label: &str) {
    ui.rect(x, y, w, 16.0, slot());
    if frac > 0.0 {
        ui.rect(x, y, w * frac.clamp(0.0, 1.0), 16.0, fill);
    }

    ui.text(label, x + 4.0, y + 2.0, 1.6, text());
}

/// Portrait column carrying the live character doll, mirroring the inventory's
/// equipment column so the same character reads the same way in both windows.
/// The renderer composites the doll into this rect after the UI pass.
pub fn preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    let column_w = (w * PORTRAIT_WIDTH_RATIO).clamp(PORTRAIT_MIN_W, PORTRAIT_MAX_W);
    let column_w = column_w.min(w * 0.5);
    let avail_h = (h - 4.0).max(0.0);
    let preview_w = column_w.min(avail_h * DOLL_ASPECT);
    let preview_h = avail_h.min(column_w / DOLL_ASPECT);
    [x, y + (avail_h - preview_h) * 0.5, preview_w, preview_h]
}

/// Left edge of the sheet's text column: past the portrait, or the frame edge
/// when the window is too narrow to carry one.
fn text_origin(rect: [f32; 4]) -> f32 {
    let preview = preview_rect(rect);
    if preview[2] <= PORTRAIT_MIN_W * 0.5 {
        rect[0]
    } else {
        preview[0] + preview[2] + PORTRAIT_GAP
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    ctx: super::Ctx,
    model: &WindowModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [_, y, _, _] = ctx.rect;
    let c = &model.character;
    let p = &c.player;

    // The live doll composites into the portrait column after the UI pass; the
    // sheet's text starts past it.
    let preview = preview_rect(ctx.rect);
    super::chrome::region(ui, preview);
    super::chrome::viewer_seat(ui, preview);
    let x = text_origin(ctx.rect);
    let w = (ctx.rect[0] + ctx.rect[2] - x).max(0.0);

    ui.text(&p.name, x, y, 3.0, accent());
    let title = p
        .active_title
        .as_ref()
        .map(|t| t.label.as_str())
        .unwrap_or("NONE");
    ui.text(&format!("TITLE  {}", title), x, y + 30.0, 2.0, dim());

    // Vitals.
    let bw = w - 4.0;
    bar(
        ui,
        x,
        y + 58.0,
        bw,
        p.health / p.health_max.max(1.0),
        crate::hud::plate::POOL_HEALTH,
        &format!("HEALTH {}/{}", p.health as i32, p.health_max as i32),
    );
    bar(
        ui,
        x,
        y + 80.0,
        bw,
        p.action / p.action_max.max(1.0),
        crate::hud::plate::POOL_ACTION,
        &format!("ACTION {}/{}", p.action as i32, p.action_max as i32),
    );

    // Ledger — live projection scalars only.
    ui.text(&format!("AREA    {}", c.area_id), x, y + 108.0, 2.0, text());
    ui.text(&format!("CREDITS {}", p.credits), x, y + 130.0, 2.0, accent());
    let goal = c.career_goal_label.as_deref().unwrap_or("NONE");
    ui.text(&format!("GOAL    {}", goal), x, y + 152.0, 2.0, text());

    // Professions (actor `professions[]`: label + accumulated XP).
    ui.text("PROFESSIONS", x, y + 182.0, 2.0, dim());
    if p.professions.is_empty() {
        ui.text("NONE", x + 8.0, y + 206.0, 1.8, dim());
    }
    for (i, prof) in p.professions.iter().enumerate() {
        let py = y + 206.0 + i as f32 * 22.0;
        ui.text(&prof.label, x + 8.0, py, 1.8, text());
        ui.text(&format!("XP {}", prof.xp), x + 180.0, py, 1.8, accent());
    }

    // Title selector — the sole action. Options are the earned titles the
    // projection derived from trained skill boxes; empty ⇒ nothing to set.
    let rows = p.professions.len().max(1);
    let ty = y + 206.0 + rows as f32 * 22.0 + 16.0;
    ui.text("SET TITLE", x, ty, 2.0, dim());
    if c.title_options.is_empty() {
        ui.text("NO TITLES EARNED", x + 8.0, ty + 26.0, 1.8, dim());
        return;
    }
    let bs = crate::hud::button_style();
    let bw2 = ((w - 16.0) / c.title_options.len().max(1) as f32).min(150.0);
    for (i, opt) in c.title_options.iter().enumerate() {
        let bx = x + i as f32 * (bw2 + 6.0);
        let mut style = bs;
        if p.active_title.as_ref() == Some(opt) {
            style.fill = style.active;
        }
        if ui.button(bx, ty + 22.0, bw2, 26.0, &opt.label, style) {
            out.push(WindowAction::SetProfessionTitle(opt.id.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    /// Fixed surface context for layout-independent assertions.
    fn test_ctx(rect: [f32; 4]) -> crate::windows::Ctx {
        crate::windows::Ctx {
            spec: crate::windows::spec::surface("character").expect("character surface"),
            rect,
            tab: 0,
        }
    }

    /// The sheet frame every case draws into.
    const RECT: [f32; 4] = [100.0, 100.0, 600.0, 700.0];

    use super::*;
    use crate::windows::model::{ProfessionState, ProfessionTitle};

    /// Explicit test fixture — `WindowModel::sample()` is intentionally empty
    /// so demo/test state can never masquerade as a live projection.
    fn fixture() -> WindowModel {
        let mut m = WindowModel::sample();
        m.character.player.name = "VETT".into();
        m.character.player.health = 80.0;
        m.character.player.health_max = 100.0;
        m.character.player.action = 40.0;
        m.character.player.action_max = 120.0;
        m.character.player.credits = 1250;
        m.character.area_id = "open-desert".into();
        m.character.player.professions = vec![ProfessionState {
            id: "marksman".into(),
            label: "MARKSMAN".into(),
            xp: 1200,
            ..Default::default()
        }];
        m.character.title_options = vec![
            ProfessionTitle {
                id: "title-novice-marksman".into(),
                label: "MARKSMAN".into(),
                skill_box_id: "marksman_novice".into(),
            },
            ProfessionTitle {
                id: "title-scout".into(),
                label: "SCOUT".into(),
                skill_box_id: "scout_novice".into(),
            },
        ];
        m
    }

    #[test]
    fn title_button_emits_title_id() {
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        // 1 profession row ⇒ ty = y + 206 + 22 + 16; buttons sit at ty + 22.
        // The text column starts past the portrait, so the button's x is
        // derived from the layout rather than pinned to the frame edge.
        let bx = text_origin(RECT) + 60.0;
        let by = 100.0 + 206.0 + 22.0 + 16.0 + 22.0 + 12.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        assert!(
            matches!(
                out.first(),
                Some(WindowAction::SetProfessionTitle(t)) if t == "title-novice-marksman"
            ),
            "first title option emits its wire id, got {out:?}"
        );
    }

    #[test]
    fn empty_model_renders_without_actions() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        ui.set_input(160.0, 388.0, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        ui.set_input(160.0, 388.0, false);
        ui.begin(1280, 900);
        out.clear();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        assert!(
            out.is_empty(),
            "empty projection emits nothing, got {out:?}"
        );
    }
}
