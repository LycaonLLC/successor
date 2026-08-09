//! SKILLS — profession skill-box trees with trained/available/denied states.
//!
//! Reads `WindowModel::skills` (live `SkillsModel` projection: profession
//! trees joined from the checked-in progression spec + actor state, skill
//! point budget, wallet credits, and the in-range trainer gate). Clicking a
//! purchasable box emits `WindowAction::Button("skill:buy:<box id>")` — the
//! host routes it onto `ClientCommand::PurchaseSkillBox`. Trained and denied
//! boxes never emit; the deny reason is the authoritative copy from the
//! projection.

use super::{accent, dim, slot, text, WindowAction, WindowModel};
use crate::hud::Icons;
use successor_engine_render::ui::UiBuilder;

pub fn draw(
    ui: &mut UiBuilder,
    ctx: super::Ctx,
    model: &WindowModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = ctx.rect;
    let s = &model.skills;

    // ── Header: point budget, wallet, trainer gate ───────────────────────
    ui.text(
        &format!("SP {}/{}", s.skill_points_used, s.skill_points_cap),
        x,
        y,
        2.0,
        text(),
    );
    let cr = format!("CR {}", s.credits);
    let cr_w = ui.measure_text(&cr, 2.0);
    ui.text(&cr, x + w - cr_w, y, 2.0, accent());
    let trainer = match &s.trainer {
        Some(t) if t.in_range => format!("TRAINER {}", t.name),
        Some(t) => format!("TRAINER {} - {}", t.name, super::DENY_RANGE),
        None => "NO TRAINER IN RANGE".to_string(),
    };
    ui.text(
        &trainer,
        x,
        y + 22.0,
        1.8,
        if s.trainer.as_ref().is_some_and(|t| t.in_range) {
            text()
        } else {
            dim()
        },
    );

    if s.professions.is_empty() {
        ui.text("NO PROFESSION DATA", x, y + 48.0, 2.0, dim());
        return;
    }

    // ── Profession trees ─────────────────────────────────────────────────
    let mut cy = y + 48.0;
    for tree in &s.professions {
        if cy + 26.0 > y + h {
            return;
        }
        ui.text(
            &format!("{} - XP {}", tree.label, tree.xp),
            x,
            cy,
            2.2,
            accent(),
        );
        cy += 26.0;
        for b in &tree.boxes {
            if cy + 34.0 > y + h {
                return;
            }
            let resp = ui.interact(x, cy, w, 34.0);
            let clickable = s.trainer.as_ref().is_some_and(|trainer| trainer.in_range)
                && (b.available || b.trained);
            let fill = if clickable && resp.hovered {
                [36, 48, 64, 230]
            } else {
                slot()
            };
            ui.rect(x, cy, w, 34.0, fill);

            let text_col = if b.trained {
                accent()
            } else if b.available {
                text()
            } else {
                dim()
            };
            let mut lx = x + 8.0;
            if !b.trained && !b.available {
                if let Some((c, r)) = icons.cell("lock") {
                    ui.icon(c, r, lx, cy + 8.0, 18.0, 18.0, dim());
                }
                lx += 22.0;
            }
            ui.text(&b.label, lx, cy + 4.0, 2.0, text_col);
            // Right column: trained mark, cost line, or the deny reason.
            let right = if b.trained {
                "TRAINED".to_string()
            } else if b.available {
                let mut cost = format!("SP {} / XP {}", b.skill_point_cost, b.xp_cost);
                if b.credit_cost > 0 {
                    cost.push_str(&format!(" / CR {}", b.credit_cost));
                }
                cost
            } else {
                b.deny_reason.clone()
            };
            let right_w = ui.measure_text(&right, 1.6);
            ui.text(&right, x + w - right_w - 8.0, cy + 20.0, 1.6, text_col);
            if resp.clicked && clickable {
                let trainer_actor_id = s
                    .trainer
                    .as_ref()
                    .expect("clickable skills have an in-range trainer")
                    .actor_id
                    .clone();
                let command = if b.trained {
                    successor_net::ClientCommand::UnlearnSkillBox {
                        skill_box_id: b.id.clone(),
                        trainer_actor_id,
                    }
                } else {
                    successor_net::ClientCommand::PurchaseSkillBox {
                        skill_box_id: b.id.clone(),
                        trainer_actor_id,
                    }
                };
                out.push(WindowAction::Command(command));
            }
            cy += 40.0;
        }
        cy += 10.0;
    }
}

#[cfg(test)]
mod tests {
    fn test_ctx(rect: [f32; 4]) -> crate::windows::Ctx {
        crate::windows::Ctx {
            spec: crate::windows::spec::surface("skills").expect("skills surface"),
            rect,
            tab: 0,
        }
    }

    use super::*;
    use crate::windows::model::{ProfessionTreeView, SkillBoxView, TrainerView};

    /// Explicit test fixture — `WindowModel::sample()` is intentionally empty
    /// so demo/test state can never masquerade as a live projection.
    fn fixture() -> WindowModel {
        let mut m = WindowModel::sample();
        m.skills.skill_points_used = 10;
        m.skills.skill_points_cap = 250;
        m.skills.credits = 500;
        m.skills.trainer = Some(TrainerView {
            actor_id: "trainer-1".into(),
            name: "SGT HALE".into(),
            profession_id: "marksman".into(),
            in_range: true,
        });
        m.skills.professions = vec![ProfessionTreeView {
            id: "marksman".into(),
            label: "MARKSMAN".into(),
            xp: 1200,
            boxes: vec![
                SkillBoxView {
                    id: "marksman_novice".into(),
                    label: "NOVICE MARKSMAN".into(),
                    trained: true,
                    ..Default::default()
                },
                SkillBoxView {
                    id: "marksman_rifles_1".into(),
                    label: "RIFLES I".into(),
                    xp_cost: 400,
                    skill_point_cost: 2,
                    available: true,
                    ..Default::default()
                },
                SkillBoxView {
                    id: "marksman_pistols_1".into(),
                    label: "PISTOLS I".into(),
                    xp_cost: 400,
                    skill_point_cost: 2,
                    available: false,
                    deny_reason: "REQUIRES 1000 MARKSMAN XP".into(),
                    ..Default::default()
                },
            ],
        }];
        m
    }

    /// Row geometry for rect [100,100,500,400]: tree header at y=148, boxes
    /// start at 174 and advance 40 ⇒ box0 174, box1 214, box2 254.
    const RECT: [f32; 4] = [100.0, 100.0, 500.0, 400.0];

    fn click(
        ui: &mut UiBuilder,
        model: &WindowModel,
        icons: &Icons,
        cx: f32,
        cy: f32,
    ) -> Vec<WindowAction> {
        ui.set_input(cx, cy, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(ui, test_ctx(RECT), model, icons, &mut out);
        ui.set_input(cx, cy, false);
        ui.begin(1280, 720);
        out.clear();
        draw(ui, test_ctx(RECT), model, icons, &mut out);
        out
    }

    #[test]
    fn clicking_available_box_emits_purchase_intent() {
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        let out = click(&mut ui, &model, &icons, 150.0, 230.0);
        assert_eq!(
            out,
            vec![WindowAction::Command(
                successor_net::ClientCommand::PurchaseSkillBox {
                    skill_box_id: "marksman_rifles_1".into(),
                    trainer_actor_id: "trainer-1".into(),
                }
            )],
            "available untrained box emits the typed purchase command"
        );
    }

    #[test]
    fn trained_box_unlearns_and_denied_box_ignores_click() {
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        let out = click(&mut ui, &model, &icons, 150.0, 190.0);
        assert_eq!(
            out,
            vec![WindowAction::Command(
                successor_net::ClientCommand::UnlearnSkillBox {
                    skill_box_id: "marksman_novice".into(),
                    trainer_actor_id: "trainer-1".into(),
                }
            )],
            "trained box emits the typed unlearn command"
        );
        let out = click(&mut ui, &model, &icons, 150.0, 270.0);
        assert!(out.is_empty(), "denied box emits nothing, got {out:?}");
    }

    #[test]
    fn empty_model_renders_without_actions() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        let out = click(&mut ui, &model, &icons, 150.0, 230.0);
        assert!(
            out.is_empty(),
            "empty projection emits nothing, got {out:?}"
        );
    }
}
