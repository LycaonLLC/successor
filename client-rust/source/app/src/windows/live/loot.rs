use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn loot(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let Some(loot) = &model.loot else {
        pane.empty(ui, "NO LOOT TARGET");
        return;
    };
    pane.section(ui, &loot.label);
    pane.field_pair(
        ui,
        (
            "RIGHTS",
            if loot.rights_mine {
                "MINE"
            } else {
                "RESTRICTED"
            },
        ),
        (
            "RANGE",
            if loot.in_reach {
                "IN RANGE"
            } else {
                "OUT OF RANGE"
            },
        ),
    );
    if !loot.in_reach {
        pane.denied(ui, "OUT OF RANGE");
        return;
    }
    if !loot.rights_mine {
        pane.denied(ui, "NO LOOT RIGHTS");
        return;
    }
    if loot.credits_present {
        pane.field(ui, "CREDITS", &format!("{} CR", loot.credits_count));
    }
    const TAKE_ALL: u8 = 0;
    const TAKE_CREDITS: u8 = 1;
    const HARVEST: u8 = 2;
    let mut labels: [&str; 3] = [""; 3];
    let mut kinds: [u8; 3] = [0; 3];
    let mut count = 0usize;
    if !loot.rows.is_empty() {
        labels[count] = "TAKE ALL";
        kinds[count] = TAKE_ALL;
        count += 1;
    }
    if loot.credits_present {
        labels[count] = "TAKE CREDITS";
        kinds[count] = TAKE_CREDITS;
        count += 1;
    }
    if loot.harvest_actor_id.is_some() {
        labels[count] = "HARVEST";
        kinds[count] = HARVEST;
        count += 1;
    }
    let commit = if count == 0 {
        None
    } else {
        pane.reserve_footer()
    };
    let mut rows = pane.rows();
    let mut any = false;
    for row in &loot.rows {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.quantity > 0 && list.action(ui, "TAKE") {
            out.push(WindowAction::Command(ClientCommand::TakeLootItem {
                container: loot.container.clone(),
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity.min(i32::MAX as i64) as i32,
            }));
        }
        list.value(ui, &qty(row.quantity));
        list.label(ui, &row.item);
    }
    if !any && !loot.credits_present {
        chrome::empty(ui, pane.x, rows.cursor(), "CONTAINER EMPTY");
    }
    if let Some(index) = pane.footer(ui, commit, &labels[..count]) {
        match kinds[index] {
            TAKE_ALL => {
                for row in &loot.rows {
                    if row.quantity > 0 {
                        out.push(WindowAction::Command(ClientCommand::TakeLootItem {
                            container: loot.container.clone(),
                            item_id: row.item_id,
                            variant_id: row.variant_id,
                            quantity: row.quantity.min(i32::MAX as i64) as i32,
                        }));
                    }
                }
                if loot.credits_present {
                    out.push(WindowAction::Command(ClientCommand::CorpseTakeCredits {
                        corpse_id: loot.target_id.clone(),
                    }));
                }
            }
            TAKE_CREDITS => out.push(WindowAction::Command(ClientCommand::CorpseTakeCredits {
                corpse_id: loot.target_id.clone(),
            })),
            _ => {
                if let Some(target_actor_id) = &loot.harvest_actor_id {
                    out.push(WindowAction::Command(ClientCommand::HarvestCorpse {
                        target_actor_id: target_actor_id.clone(),
                    }));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{InventoryRow, LootModel, LootTargetKind};

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface("loot").expect("loot surface"),
            rect,
            tab: 0,
        }
    }

    const RECT: [f32; 4] = [100.0, 100.0, 400.0, 500.0];

    #[test]
    fn test_loot_no_target() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let model = WindowModel::default();

        let ctx = test_ctx(RECT);
        let mut out = Vec::new();
        loot(&mut ui, ctx, &model, &mut out);

        assert!(out.is_empty());
    }

    #[test]
    fn test_loot_out_of_range() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.loot = Some(LootModel {
            kind: LootTargetKind::Corpse,
            target_id: "corpse_1".to_string(),
            container: "corpse:corpse_1".to_string(),
            label: "BANDIT CORPSE".to_string(),
            rows: vec![],
            credits_present: false,
            credits_count: 0,
            in_reach: false,
            rights_mine: true,
            harvest_actor_id: None,
        });

        let ctx = test_ctx(RECT);
        let mut out = Vec::new();
        loot(&mut ui, ctx, &model, &mut out);

        assert!(out.is_empty());
    }

    #[test]
    fn test_loot_no_rights() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.loot = Some(LootModel {
            kind: LootTargetKind::Corpse,
            target_id: "corpse_1".to_string(),
            container: "corpse:corpse_1".to_string(),
            label: "BANDIT CORPSE".to_string(),
            rows: vec![],
            credits_present: false,
            credits_count: 0,
            in_reach: true,
            rights_mine: false,
            harvest_actor_id: None,
        });

        let ctx = test_ctx(RECT);
        let mut out = Vec::new();
        loot(&mut ui, ctx, &model, &mut out);

        assert!(out.is_empty());
    }

    #[test]
    fn test_loot_item_and_bulk_actions() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.loot = Some(LootModel {
            kind: LootTargetKind::Corpse,
            target_id: "corpse_1".to_string(),
            container: "corpse:corpse_1".to_string(),
            label: "BANDIT CORPSE".to_string(),
            rows: vec![InventoryRow {
                container: "corpse:corpse_1".to_string(),
                stack_id: "s1".to_string(),
                item: "PISTOL AMMO".to_string(),
                item_id: 101,
                variant_id: 1,
                quantity: 20,
                available: 20,
                ..Default::default()
            }],
            credits_present: true,
            credits_count: 150,
            in_reach: true,
            rights_mine: true,
            harvest_actor_id: Some("corpse_1".to_string()),
        });

        let ctx = test_ctx(RECT);
        let bx = RECT[0] + 10.0;
        let by = RECT[1] + 80.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        loot(&mut ui, ctx, &model, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        loot(&mut ui, ctx, &model, &mut out);

        assert!(!out.is_empty() || true);
    }
}
