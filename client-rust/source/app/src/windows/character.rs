//! CHARACTER — read-only sheet + the one action: profession-title select.
//!
//! Reads `WindowModel::character` (live `CharacterModel` projection: the
//! decoded player actor, active area, earned title options, career goal).
//! Emits `WindowAction::SetProfessionTitle(<title id>)` — the host maps it
//! onto `ClientCommand::SetProfessionTitle { title_id }`.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

fn bar(ui: &mut UiBuilder, x: f32, y: f32, w: f32, frac: f32, fill: [u8; 4], label: &str) {
    ui.rect(x, y, w, 16.0, SLOT);
    if frac > 0.0 {
        ui.rect(x, y, w * frac.clamp(0.0, 1.0), 16.0, fill);
    }

    ui.text(label, x + 4.0, y + 2.0, 1.6, TEXT);
}

pub fn draw(
    ui: &mut UiBuilder,
    ctx: super::Ctx,
    model: &WindowModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, _h] = ctx.rect;
    let c = &model.character;
    let p = &c.player;

    ui.text(&p.name, x, y, 3.0, ACCENT);
    let title = p
        .active_title
        .as_ref()
        .map(|t| t.label.as_str())
        .unwrap_or("NONE");
    ui.text(&format!("TITLE  {}", title), x, y + 30.0, 2.0, DIM);

    // Vitals.
    let bw = w - 4.0;
    bar(
        ui,
        x,
        y + 58.0,
        bw,
        p.health / p.health_max.max(1.0),
        [196, 72, 68, 235],
        &format!("HEALTH {}/{}", p.health as i32, p.health_max as i32),
    );
    bar(
        ui,
        x,
        y + 80.0,
        bw,
        p.action / p.action_max.max(1.0),
        [86, 156, 210, 235],
        &format!("ACTION {}/{}", p.action as i32, p.action_max as i32),
    );

    // Ledger — live projection scalars only.
    ui.text(&format!("AREA    {}", c.area_id), x, y + 108.0, 2.0, TEXT);
    ui.text(&format!("CREDITS {}", p.credits), x, y + 130.0, 2.0, ACCENT);
    let goal = c.career_goal_label.as_deref().unwrap_or("NONE");
    ui.text(&format!("GOAL    {}", goal), x, y + 152.0, 2.0, TEXT);

    // Professions (actor `professions[]`: label + accumulated XP).
    ui.text("PROFESSIONS", x, y + 182.0, 2.0, DIM);
    if p.professions.is_empty() {
        ui.text("NONE", x + 8.0, y + 206.0, 1.8, DIM);
    }
    for (i, prof) in p.professions.iter().enumerate() {
        let py = y + 206.0 + i as f32 * 22.0;
        ui.text(&prof.label, x + 8.0, py, 1.8, TEXT);
        ui.text(&format!("XP {}", prof.xp), x + 180.0, py, 1.8, ACCENT);
    }

    // Title selector — the sole action. Options are the earned titles the
    // projection derived from trained skill boxes; empty ⇒ nothing to set.
    let rows = p.professions.len().max(1);
    let ty = y + 206.0 + rows as f32 * 22.0 + 16.0;
    ui.text("SET TITLE", x, ty, 2.0, DIM);
    if c.title_options.is_empty() {
        ui.text("NO TITLES EARNED", x + 8.0, ty + 26.0, 1.8, DIM);
        return;
    }
    let bs = ButtonStyle::default();
    let bw2 = ((w - 16.0) / c.title_options.len().max(1) as f32).min(150.0);
    for (i, opt) in c.title_options.iter().enumerate() {
        let bx = x + i as f32 * (bw2 + 6.0);
        let mut style = bs;
        if p.active_title.as_ref() == Some(opt) {
            style.fill = [70, 92, 120, 240];
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
        // rect [100,100,600,700]; 1 profession row ⇒ ty = 100+206+22+16 = 344;
        // buttons at ty+22 = 366, first button x=100, w=min((600-16)/2,150)=150.
        let bx = 100.0 + 60.0;
        let by = 366.0 + 12.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        draw(
            &mut ui,
            test_ctx([100.0, 100.0, 600.0, 700.0]),
            &model,
            &icons,
            &mut out,
        );
        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        draw(
            &mut ui,
            test_ctx([100.0, 100.0, 600.0, 700.0]),
            &model,
            &icons,
            &mut out,
        );
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
        draw(
            &mut ui,
            test_ctx([100.0, 100.0, 600.0, 700.0]),
            &model,
            &icons,
            &mut out,
        );
        ui.set_input(160.0, 388.0, false);
        ui.begin(1280, 900);
        out.clear();
        draw(
            &mut ui,
            test_ctx([100.0, 100.0, 600.0, 700.0]),
            &model,
            &icons,
            &mut out,
        );
        assert!(
            out.is_empty(),
            "empty projection emits nothing, got {out:?}"
        );
    }
}
