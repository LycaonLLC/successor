use crate::windows::live::shared::*;
use crate::windows::{Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn clone_terminal(
    ui: &mut UiBuilder,
    ctx: Ctx,
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let mut pane = Pane::open(ctx);
    let clone = &model.clone;
    if !clone.gate.available {
        pane.denied(ui, &clone.gate.note);
        return;
    }
    let commit = pane.reserve_footer();
    heading(&mut pane, ui, "CLONING TERMINAL");
    pane.field(
        ui,
        "STATUS",
        if clone.backup_present {
            "BACKUP ON FILE"
        } else {
            "NO BACKUP ON FILE"
        },
    );
    pane.field_pair(
        ui,
        ("SKILLS SAVED", &clone.backup_skill_count.to_string()),
        ("BACKUP COST", &format!("{} CR", clone.backup_cost)),
    );
    pane.field_pair(
        ui,
        ("VAULT BALANCE", &format!("{} CR", clone.vault_credits)),
        ("WALLET BALANCE", &format!("{} CR", clone.wallet_credits)),
    );
    if clone.clone_sickness_remaining_ms > 0 {
        pane.field(
            ui,
            "SICKNESS",
            &format!("{}s", clone.clone_sickness_remaining_ms / 1000),
        );
    }

    pane.y += 4.0;
    heading(&mut pane, ui, "CLONING TERMS");
    pane.field(ui, "RESTORES", "PROFESSIONS, XP AND SKILLS");
    pane.field(ui, "FUNDS", "VAULT PAYS FIRST - WALLET COVERS SHORTFALL");

    let save_label = if clone.backup_present {
        "UPDATE SKILL BACKUP"
    } else {
        "SAVE SKILL BACKUP"
    };
    let labels: &[&str] = if clone.dead {
        &[save_label, "RESPAWN FROM CLONE"]
    } else {
        &[save_label]
    };
    if let Some(index) = pane.footer(ui, commit, labels) {
        let command = if index == 0 {
            ClientCommand::CloneSaveSkillBackup {}
        } else {
            ClientCommand::CloneRespawn {
                facility_id: clone.gate.prop_id.clone(),
            }
        };
        out.push(WindowAction::Command(command));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::Gate;
    use crate::windows::spec;

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: spec::surface("clone").expect("clone spec"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn test_clone_gate_closed() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0]);
        let mut model = WindowModel::default();
        model.clone.gate = Gate::closed("CLONE TERMINAL OUT OF REACH");
        let mut out = Vec::new();
        clone_terminal(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_clone_save_backup_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0]);
        let mut model = WindowModel::default();
        model.clone.gate = Gate::open("clone_term_1");
        model.clone.backup_present = false;
        model.clone.backup_cost = 1000;
        model.clone.vault_credits = 5000;

        let button_y = ctx.rect[1] + ctx.rect[3] - 12.0;
        let button_x = ctx.rect[0] + ctx.rect[2] * 0.5;

        // Frame 1: Press
        ui.set_input(button_x, button_y, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        clone_terminal(&mut ui, ctx, &model, &mut out);

        // Frame 2: Release
        ui.set_input(button_x, button_y, false);
        ui.begin(1280, 720);
        out.clear();
        clone_terminal(&mut ui, ctx, &model, &mut out);
        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::CloneSaveSkillBackup {})
        ));
    }

    #[test]
    fn test_clone_respawn_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0]);
        let mut model = WindowModel::default();
        model.clone.gate = Gate::open("clone_term_1");
        model.clone.dead = true;
        let button_y = ctx.rect[1] + ctx.rect[3] - 12.0;
        let right_button_x = ctx.rect[0] + ctx.rect[2] * 0.75;

        // Frame 1: Press
        ui.set_input(right_button_x, button_y, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        clone_terminal(&mut ui, ctx, &model, &mut out);

        // Frame 2: Release
        ui.set_input(right_button_x, button_y, false);
        ui.begin(1280, 720);
        out.clear();
        clone_terminal(&mut ui, ctx, &model, &mut out);

        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::CloneRespawn { facility_id })
                if facility_id.as_deref() == Some("clone_term_1")
        ));
    }
}
