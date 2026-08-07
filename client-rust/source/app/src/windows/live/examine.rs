use crate::windows::live::shared::*;
use crate::windows::chrome::{self};
use crate::windows::model::ItemKind;
use crate::windows::{accent, label, value, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn examine(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    if let Some(actor) = &model.examine.actor {
        let preview = examine_preview_rect(ctx.rect);
        chrome::region(ui, preview);
        chrome::viewer_seat(ui, preview);
        pane.y = preview[1] + preview[3] + 8.0;
        let revive = if actor.life_state == "alive" {
            None
        } else {
            pane.reserve_footer()
        };
        heading(&mut pane, ui, &actor.name);
        pane.field(ui, "TYPE", &actor.descriptor.to_ascii_uppercase());
        pane.field(ui, "STATE", &actor.life_state.to_ascii_uppercase());

        let ratio = if actor.health_max > 0.0 {
            (actor.health / actor.health_max).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let reading = format!("{:.0}/{:.0}", actor.health, actor.health_max);
        let label_w = ui.measure_text("HEALTH", metrics.caption_px) + 10.0;
        let reading_w = ui.measure_text(&reading, metrics.caption_px);
        ui.text("HEALTH", pane.x, pane.y + 1.0, metrics.caption_px, label());
        let track_w = (pane.w - label_w - reading_w - 8.0).max(0.0);
        if track_w > 0.0 {
            chrome::meter(
                ui,
                pane.x + label_w,
                pane.y + 2.0,
                track_w,
                6.0,
                ratio,
                accent(),
            );
        }
        ui.text(
            &reading,
            pane.x + pane.w - reading_w,
            pane.y,
            metrics.caption_px,
            value(),
        );
        pane.y += metrics.row_h - 4.0;

        pane.field(
            ui,
            "FACTION",
            &actor
                .faction_id
                .as_deref()
                .unwrap_or("UNKNOWN")
                .to_ascii_uppercase(),
        );
        if let Some(org) = &actor.organization_tag {
            pane.field(ui, "ORG", &org.to_ascii_uppercase());
        }
        if !actor.pvp_status.is_empty() {
            pane.field(ui, "PVP", &actor.pvp_status.to_ascii_uppercase());
        }

        if pane.footer(ui, revive, &["REVIVE / STABILIZE"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::ReviveActor {
                target_actor_id: actor.actor_id.clone(),
            }));
        }
        return;
    }
    if let Some(item) = &model.examine.item {
        let preview = examine_item_preview_rect(ctx.rect);
        chrome::region(ui, preview);
        pane.y = preview[1] + preview[3] + 8.0;
        heading(&mut pane, ui, &item.item);
        pane.field(ui, "CLASS", item.kind().label());
        pane.field_pair(
            ui,
            ("QTY", &item.quantity.to_string()),
            ("VARIANT", &item.variant_id.to_string()),
        );
        match (item.potency, item.purity) {
            (Some(potency), Some(purity)) => pane.field_pair(
                ui,
                ("POTENCY", &potency.to_string()),
                ("PURITY", &purity.to_string()),
            ),
            (Some(potency), None) => pane.field(ui, "POTENCY", &potency.to_string()),
            (None, Some(purity)) => pane.field(ui, "PURITY", &purity.to_string()),
            (None, None) => {}
        }

        if let Some(stats) = &item.resource_stats {
            pane.y += 4.0;
            heading(&mut pane, ui, "RESOURCE ATTRIBUTES");
            let rows = stats.rows();
            for chunk in rows.chunks(2) {
                if chunk.len() == 2 {
                    pane.field_pair(
                        ui,
                        (chunk[0].0, &chunk[0].1.to_string()),
                        (chunk[1].0, &chunk[1].1.to_string()),
                    );
                } else if chunk.len() == 1 {
                    pane.field(ui, chunk[0].0, &chunk[0].1.to_string());
                }
            }
        }

        if item.kind() == ItemKind::Weapon || item.variant_id >= 31_000_000 || item.item_id == 3101 {
            pane.y += 4.0;
            heading(&mut pane, ui, "WEAPON SPECIFICATIONS");
            let variant = item.variant_id;
            let (power, handling, reliability) = if variant >= 31_000_000 {
                let encoded = variant - 31_000_000;
                (
                    (encoded / 1_000_000).min(100),
                    ((encoded / 1_000) % 1_000).min(100),
                    (encoded % 1_000).min(100),
                )
            } else {
                (0, 0, 0)
            };
            pane.field_pair(
                ui,
                ("POWER", &format!("{power}/100")),
                ("HANDLING", &format!("{handling}/100")),
            );
            pane.field_pair(
                ui,
                ("RELIABILITY", &format!("{reliability}/100")),
                ("RANGE BANDS", "Point 6m / Ideal 15m / Max 30m"),
            );
        }
        return;
    }
    if let Some((prop_id, label)) = &model.examine.prop {
        heading(&mut pane, ui, label);
        pane.field(ui, "SUBJECT", "WORLD PROP");
        pane.field(ui, "PROP ID", prop_id);
    } else {
        pane.empty(ui, "NOTHING SELECTED");
    }
}

/// Actor viewer rect. The EXAMINE spec declares `header: false` and no tabs, so
/// this is anchored at the content origin and the attributes reflow beneath it.
pub fn examine_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    let preview_h = (h * 0.54).max(170.0);
    let preview_w = (preview_h * 0.60).min(w);
    [x + (w - preview_w) * 0.5, y, preview_w, preview_h]
}

/// Item viewer rect, same contract as [`examine_preview_rect`].
pub fn examine_item_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    [x, y, w, w.min((h * 0.62).max(190.0))]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{ExamineActor, InventoryRow, ResourceStats};
    use crate::windows::spec;

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: spec::surface("examine").expect("examine spec"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn test_examine_empty() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 300.0, 400.0]);
        let model = WindowModel::default();
        let mut out = Vec::new();
        examine(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_examine_actor_revive_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 300.0, 400.0]);
        let mut model = WindowModel::default();
        model.examine.actor = Some(ExamineActor {
            actor_id: "actor_downed_1".into(),
            name: "Fallen Guard".into(),
            descriptor: "humanoid".into(),
            life_state: "incapacitated".into(),
            faction_id: Some("wardens".into()),
            pvp_status: "pvp_enabled".into(),
            organization_tag: Some("CORP".into()),
            health: 0.0,
            health_max: 100.0,
        });

        // Frame 1: Press revive button at footer
        let button_y = ctx.rect[1] + ctx.rect[3] - 12.0;
        let button_x = ctx.rect[0] + ctx.rect[2] * 0.5;
        ui.set_input(button_x, button_y, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        examine(&mut ui, ctx, &model, &mut out);

        // Frame 2: Release
        ui.set_input(button_x, button_y, false);
        ui.begin(1280, 720);
        out.clear();
        examine(&mut ui, ctx, &model, &mut out);

        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::ReviveActor { target_actor_id }) if target_actor_id == "actor_downed_1"
        ));
    }

    #[test]
    fn test_examine_item_branches() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 300.0, 500.0]);

        // Test resource item branch
        let mut model = WindowModel::default();
        model.examine.item = Some(InventoryRow {
            item: "Refined Copper".into(),
            item_id: 2001,
            quantity: 50,
            resource_stats: Some(ResourceStats {
                conductivity: 85,
                malleability: 90,
                ..Default::default()
            }),
            ..Default::default()
        });
        let mut out = Vec::new();
        examine(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());

        // Test weapon item branch with encoded variant
        model.examine.item = Some(InventoryRow {
            item: "C-10 Slugthrower".into(),
            item_id: 3101,
            variant_id: 31_085_070,
            quantity: 1,
            ..Default::default()
        });
        examine(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_examine_prop_branch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 300.0, 400.0]);
        let mut model = WindowModel::default();
        model.examine.prop = Some(("prop_crate_99".into(), "Storage Crate".into()));
        let mut out = Vec::new();
        examine(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }
}
