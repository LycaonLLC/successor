use crate::windows::live::shared::*;
use crate::windows::chrome::{self};
use crate::windows::{accent, dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn datapad(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    match ctx.tab {
        0 => {
            let mark = pane.reserve_footer();
            let area_id = model.character.area_id.to_ascii_uppercase();
            let player_x = model.farm.player_cell.0;
            let player_y = model.farm.player_cell.1;
            pane.field(
                ui,
                "POSITION",
                &format!(
                    "{} {}, {}",
                    if area_id.is_empty() { "UNKNOWN" } else { &area_id },
                    player_x,
                    player_y
                ),
            );

            if area_id.is_empty() {
                chrome::empty(ui, pane.x, pane.y, "NO TERRAIN DATA AVAILABLE");
            } else {
                pane.section(ui, "LOCAL TERRAIN CHART");
                let chart_h = 80.0f32.min((pane.bottom - pane.y - 120.0).max(40.0));
                let chart_y = pane.y;
                let chart_rect = [pane.x, chart_y, pane.w, chart_h];
                ui.border(chart_rect[0], chart_rect[1], chart_rect[2], chart_rect[3], 1.0, dim());

                let center_x = pane.x + pane.w * 0.5;
                let center_y = chart_y + chart_h * 0.5;

                // Center crosshair grid lines
                ui.line(pane.x + 4.0, center_y, pane.x + pane.w - 4.0, center_y, 1.0, dim());
                ui.line(center_x, chart_y + 4.0, center_x, chart_y + chart_h - 4.0, 1.0, dim());

                // Cardinal direction indicator
                ui.text("N", center_x - 3.0, chart_y + 4.0, pane.metrics.caption_px, accent());

                // Player blip
                ui.text("@", center_x - 3.0, center_y - 4.0, pane.metrics.caption_px, accent());

                // Waypoint markers relative to player cell
                for wp in model
                    .waypoints
                    .iter()
                    .filter(|w| w.area_id == model.character.area_id && w.active)
                {
                    let dx = (wp.x - player_x as f32) * 2.0;
                    let dy = (wp.y - player_y as f32) * 2.0;
                    let wx = center_x + dx;
                    let wy = center_y - dy;
                    if wx >= pane.x + 6.0
                        && wx <= pane.x + pane.w - 6.0
                        && wy >= chart_y + 6.0
                        && wy <= chart_y + chart_h - 6.0
                    {
                        ui.text("+", wx - 3.0, wy - 4.0, pane.metrics.caption_px, label());
                    }
                }

                pane.y = chart_y + chart_h + 6.0;
            }

            pane.section(ui, "WAYPOINTS");
            let mut rows = pane.rows();
            let mut any = false;
            for waypoint in model
                .waypoints
                .iter()
                .filter(|waypoint| {
                    waypoint.area_id == model.character.area_id
                        || model.character.area_id.is_empty()
                })
                .take(8)
            {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if row.quiet_action(ui, "DELETE") {
                    out.push(WindowAction::DeleteWaypoint(waypoint.id));
                }
                if row.quiet_action(ui, "RENAME") {
                    out.push(WindowAction::RenameWaypoint {
                        id: waypoint.id,
                        name: format!("{}*", waypoint.name),
                    });
                }
                if row.action(ui, if waypoint.active { "HIDE" } else { "SHOW" }) {
                    out.push(WindowAction::SetWaypointActive {
                        id: waypoint.id,
                        active: !waypoint.active,
                    });
                }
                row.value(ui, &format!("{:.1}, {:.1}", waypoint.x, waypoint.y));
                row.label_tinted(
                    ui,
                    &waypoint.name,
                    if waypoint.active { label() } else { dim() },
                );
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO WAYPOINTS IN THIS AREA");
            }
            pane.resume(&rows);

            if pane.footer(ui, mark, &["MARK HERE"]).is_some() {
                out.push(WindowAction::CreateWaypoint {
                    x: model.farm.player_cell.0 as f32,
                    y: model.farm.player_cell.1 as f32,
                    name: None,
                });
            }
        }
        1 => {
            pane.section(ui, "DRAFTED SCHEMATICS");
            let mut rows = pane.rows();
            let mut any = false;
            for draft in model.craft.drafts.iter().take(10) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if model.craft.factory.available && draft.remaining_uses > 0
                    && row.action(ui, "MANUFACTURE") {
                        out.push(WindowAction::Command(ClientCommand::FactoryManufacture {
                            factory_id: model.craft.factory.prop_id.clone().unwrap_or_default(),
                            schematic_id: draft.id.clone(),
                        }));
                    }
                row.value(ui, &format!("USES {}/{}", draft.remaining_uses, draft.max_uses));
                row.value(ui, &format!("RECIPE {}", draft.recipe_id));
                row.label(ui, &format!("OUT {} | {}", draft.output_item_id, draft.id));
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO DRAFTED SCHEMATICS");
            }
            pane.resume(&rows);
        }
        _ => crate::windows::live::bank::exchange(ui, pane.body(), pane.metrics, model, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::waypoints::Waypoint;
    use crate::hud::Icons;
    use crate::windows::model::DraftedSchematic;

    fn make_ctx(tab: usize) -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface("datapad").expect("datapad spec"),
            rect: [10.0, 10.0, 400.0, 350.0],
            tab,
        }
    }

    #[test]
    fn datapad_tab0_waypoint_actions_and_mark_here() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::sample();
        model.character.area_id = "dustgate".into();
        model.farm.player_cell = (100, 200);
        model.waypoints.push(Waypoint {
            id: 42,
            name: "Outpost Alpha".into(),
            x: 100.0,
            y: 200.0,
            area_id: "dustgate".into(),
            active: true,
            created_at_ms: 1000,
        });

        let mut out = Vec::new();
        ui.begin(1280, 720);
        datapad(&mut ui, make_ctx(0), &model, &mut out);

        assert!(ui.quads > 0, "datapad tab 0 must generate UI quads");

        let ctx = make_ctx(0);
        let pane_x = ctx.rect[0] + 8.0;
        let pane_y = ctx.rect[1] + 8.0;
        ui.set_input(pane_x + 10.0, pane_y + 120.0, true);
        ui.begin(1280, 720);
        out.clear();
        datapad(&mut ui, ctx, &model, &mut out);
        ui.set_input(pane_x + 10.0, pane_y + 120.0, false);
        ui.begin(1280, 720);
        datapad(&mut ui, ctx, &model, &mut out);
    }

    #[test]
    fn datapad_tab1_schematics_rendering() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::sample();
        model.craft.drafts.push(DraftedSchematic {
            id: "draft-1".into(),
            recipe_id: "blaster-r1".into(),
            output_item_id: 5001,
            max_uses: 5,
            remaining_uses: 3,
        });

        let mut out = Vec::new();
        ui.begin(1280, 720);
        datapad(&mut ui, make_ctx(1), &model, &mut out);

        assert!(ui.quads > 0, "datapad tab 1 must render schematics list");
    }

    #[test]
    fn datapad_tab2_data_exchange() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let model = WindowModel::sample();

        let mut out = Vec::new();
        ui.begin(1280, 720);
        datapad(&mut ui, make_ctx(2), &model, &mut out);

        assert!(ui.quads > 0, "datapad tab 2 must render exchange data");
    }
}
