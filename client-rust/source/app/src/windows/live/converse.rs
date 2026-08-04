use crate::windows::live::shared::*;
use crate::windows::chrome::{self, Rows};
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn converse(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let metrics = ctx.metrics();
    let [x, y, w, h] = ctx.rect;
    let Some(npc) = &model.converse.npc else {
        chrome::empty(ui, x, y, "NO DIALOGUE TARGET");
        return;
    };
    let preview = converse_preview_rect(ctx.rect);
    chrome::region(ui, preview);
    chrome::viewer_seat(ui, preview);
    let name_w = ui.measure_text(&npc.name, metrics.label_px);
    let caption_y = preview[1] + preview[3] + 6.0;
    chrome::text_clipped(
        ui,
        &npc.name,
        x + ((preview[2] - name_w) * 0.5).max(0.0),
        caption_y,
        metrics.label_px,
        preview[2],
        label(),
    );
    let role_text = if npc.profession_id.is_empty() {
        "TRAINER".to_string()
    } else {
        npc.profession_id.to_ascii_uppercase()
    };
    let role_w = ui.measure_text(&role_text, metrics.caption_px);
    ui.text(
        &role_text,
        x + ((preview[2] - role_w) * 0.5).max(0.0),
        caption_y + metrics.label_px * 7.0 + 4.0,
        metrics.caption_px,
        dim(),
    );

    // Prose and replies share the column beside the portrait, so the viewer
    // keeps its full height at every frame size.
    let column_x = x + preview[2] + 10.0;
    let column_w = (w - preview[2] - 10.0).max(0.0);
    let prose_h = (h * 0.28).clamp(metrics.row_h * 2.0, 120.0);
    chrome::region(ui, [column_x, y, column_w, prose_h]);
    let scrollback;
    let (body, tint) = if model.converse.deliveries.is_empty() {
        ("State your business.", dim())
    } else {
        scrollback = model
            .converse
            .deliveries
            .iter()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|d| format!("{}: {}", d.speaker.to_ascii_uppercase(), d.body))
            .collect::<Vec<_>>()
            .join("\n");
        (scrollback.as_str(), label())
    };
    prose(
        ui,
        body,
        column_x + metrics.gutter,
        y + 6.0,
        (column_w - metrics.gutter * 2.0).max(0.0),
        y + prose_h - 4.0,
        metrics.label_px,
        tint,
    );

    let replies_y = y + prose_h + 8.0;
    let mut rows = Rows::new(
        [column_x, replies_y, column_w, (y + h - replies_y).max(0.0)],
        metrics,
    );
    let mut number = 1usize;
    for (goal_id, label) in &model.converse.career_goals {
        let active = model.converse.career_goal_id.as_deref() == Some(goal_id.as_str());
        let Some(row) = rows.next_selected(ui, active) else {
            return;
        };
        let text = if active {
            format!("{number}. ACTIVE CAREER GOAL: {label}")
        } else {
            format!("{number}. SET CAREER: {label}")
        };
        row.label(ui, &text);
        if row.clicked(ui) && !active {
            out.push(WindowAction::Command(ClientCommand::SetCareerGoal {
                goal_id: goal_id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
    }
    for skill in &model.converse.teachable {
        let Some(row) = rows.next(ui) else { return };
        row.label(ui, &format!("{number}. LEARN {}", skill.label));
        if row.clicked(ui) {
            out.push(WindowAction::Command(ClientCommand::PurchaseSkillBox {
                skill_box_id: skill.id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
    }
    if let Some(row) = rows.next(ui) {
        row.label(ui, &format!("{number}. REQUEST STARTER TOOL"));
        if row.clicked(ui) {
            out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
    }
}

/// NPC viewer rect. Anchored at the content origin — the CONVERSE spec declares
/// `header: false` and no tabs, so the body rect and the frame content rect
/// coincide and `connected_scene` places the live viewport from the same call.
pub fn converse_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, _, _] = rect;
    [x, y, 82.0, 136.0]
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{DialogueDelivery, SkillBoxView, TrainerView};
    use crate::windows::spec;

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: spec::surface("converse").expect("converse spec"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn test_converse_empty_state() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0]);
        let model = WindowModel::default();
        let mut out = Vec::new();
        converse(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_converse_options_rendering_and_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 500.0, 400.0]);
        let mut model = WindowModel::default();
        model.converse.npc = Some(TrainerView {
            actor_id: "npc_trainer_1".into(),
            name: "Master Instructor".into(),
            profession_id: "combat".into(),
            in_range: true,
        });
        model.converse.deliveries = vec![DialogueDelivery {
            actor_id: "npc_trainer_1".into(),
            speaker: "Master Instructor".into(),
            body: "Welcome novice.".into(),
            tick: 100,
        }];
        model.converse.career_goals = vec![("scout_path".into(), "Scout".into())];
        model.converse.teachable = vec![SkillBoxView {
            id: "marksman_1".into(),
            label: "Marksman I".into(),
            ..Default::default()
        }];

        // Frame 1: Mouse press on row 1 (career goal)
        ui.set_input(150.0, 130.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        converse(&mut ui, ctx, &model, &mut out);

        // Frame 2: Mouse release -> click triggered
        ui.set_input(150.0, 130.0, false);
        ui.begin(1280, 720);
        out.clear();
        converse(&mut ui, ctx, &model, &mut out);

        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::SetCareerGoal { goal_id, .. }) if goal_id == "scout_path"
        ));
    }
}
