use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{accent, dim, label, value, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn survey(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    // Camp placement belongs to the whole surface, not to either pane, so it
    // rides the commit rail and stays reachable from both tabs.
    let can_place = !model.survey.own_camp_placed;
    let can_pack = model
        .survey
        .camps
        .iter()
        .any(|camp| camp.vm.is_owner && camp.in_footprint);
    let camp_labels: &[&str] = match (can_place, can_pack) {
        (true, true) => &["PLACE CAMP", "PACK UP CAMP"],
        (true, false) => &["PLACE CAMP"],
        (false, true) => &["PACK UP CAMP"],
        (false, false) => &[],
    };
    let camp_rail = if camp_labels.is_empty() {
        None
    } else {
        pane.reserve_footer()
    };

    if ctx.tab == 0 {
        // Tab 0: RESOURCES & CONCENTRATION READOUT
        if model.survey.sample_cooldown_ticks > 0 {
            let secs = (model.survey.sample_cooldown_ticks + 29) / 30;
            pane.field(ui, "COOLDOWN", &format!("SAMPLE READY IN {secs}s"));
        }

        let mut rows = pane.rows();
        let mut any = false;

        for family in &model.survey.families {
            any = true;
            let result = model.survey.result_for(&family.family);
            let rich = result.and_then(|r| r.richest());
            let peak_milli = rich.map(|(_, _, m)| m).unwrap_or(0);
            let frac = (peak_milli as f32 / 1000.0).clamp(0.0, 1.0);

            let height = pane.metrics.row_h + 18.0;
            let Some(mut row) = rows.next_tall(ui, height) else {
                break;
            };

            // Right-to-left action buttons
            if row.action(ui, "PLACE") {
                out.push(WindowAction::Command(ClientCommand::PlaceExtractor {
                    family: family.family.clone(),
                }));
            }
            if row.action(ui, "SURVEY") {
                out.push(WindowAction::Command(ClientCommand::SurveyResource {
                    family: family.family.clone(),
                }));
            }
            if model.survey.sample_cooldown_ticks <= 0 {
                if row.action(ui, "SAMPLE") {
                    out.push(WindowAction::Command(ClientCommand::SampleResource {
                        family: family.family.clone(),
                        stop: false,
                    }));
                }
            } else {
                row.reserve_action();
            }

            // Concentration value readout & caption
            let val_str = format!("{:.1}%", peak_milli as f32 / 10.0);
            row.value(ui, &val_str);

            match rich {
                Some((rx, ry, _)) => {
                    let spawn_name = result.map(|r| r.spawn_name.as_str()).unwrap_or("UNKNOWN");
                    let caption = format!("{spawn_name} - PEAK {rx:.0}, {ry:.0}");
                    row.label_caption(ui, &family.label, &caption);
                }
                None => {
                    row.label_caption(ui, &family.label, "UNSCANNED");
                }
            }

            // Concentration Meter Bar (heart of the tool)
            let meter_x = row.x + pane.metrics.gutter;
            let meter_w = (row.text_w() - pane.metrics.gutter).max(0.0);
            let meter_y = row.y + row.h - 6.0;
            if meter_w > 0.0 {
                chrome::meter(ui, meter_x, meter_y, meter_w, 4.0, frac, accent());
            }
        }

        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO RESOURCE FAMILIES");
        }

        pane.resume(&rows);

        // Spawn Taxonomy / Breakdown if space remains
        if !model.survey.spawns.is_empty() && pane.y + pane.metrics.row_h + 20.0 <= pane.bottom {
            pane.section(ui, "SPAWN TAXONOMY");
            let mut spawn_rows = pane.rows();
            // `label_caption` writes a name over a class line, so the row has to
            // carry both. A plain `next` row is one line tall and the class line
            // lands on top of the following spawn's name.
            let height = pane.metrics.row_h + 18.0;
            for spawn in &model.survey.spawns {
                let Some(mut r) = spawn_rows.next_tall(ui, height) else {
                    break;
                };

                let active_stats: Vec<String> = spawn
                    .stats
                    .rows()
                    .iter()
                    .filter(|(_, v)| *v > 0)
                    .take(3)
                    .map(|(k, v)| format!("{k} {v}"))
                    .collect();

                if !active_stats.is_empty() {
                    r.value(ui, &active_stats.join(" - "));
                }
                r.label_caption(ui, &spawn.name, &spawn.class_label);
            }
            pane.resume(&spawn_rows);
        }
    } else {
        // Tab 1: EXTRACTORS & PLACED CAMPS
        pane.section(ui, "EXTRACTORS");
        let mut rows = pane.rows();
        let mut any_extractors = false;

        for extractor in &model.survey.extractors {
            any_extractors = true;
            let vm = &extractor.vm;
            let owner_verbs = extractor.in_reach && vm.is_owner;
            let sub_rail = if owner_verbs {
                pane.rail_h() + 4.0
            } else {
                0.0
            };
            let meter_h = 8.0;
            let needed_h = pane.metrics.row_h + meter_h + sub_rail;

            if !rows.fits(needed_h) {
                break;
            }

            let Some(mut row) = rows.next_tall(ui, pane.metrics.row_h + meter_h) else {
                break;
            };

            row.value(ui, &format!("YIELD {}", vm.collectable_units));
            row.value(ui, &vm.mode.to_ascii_uppercase());

            let reach_note = if extractor.in_reach {
                "IN REACH"
            } else {
                "OUT OF REACH"
            };
            let caption = format!("CELL {}, {} - {}", vm.cell_x, vm.cell_y, reach_note);
            row.label_tinted(
                ui,
                &vm.family_label,
                if extractor.in_reach { label() } else { dim() },
            );
            row.label_caption(ui, &vm.family_label, &caption);

            // Hopper / Battery meters
            let frac_hopper = (vm.hopper_pct as f32 / 100.0).clamp(0.0, 1.0);
            let frac_batt = (vm.battery_pct as f32 / 100.0).clamp(0.0, 1.0);
            let meter_y = row.y + row.h - 5.0;
            let meter_w = (row.text_w() - pane.metrics.gutter).max(0.0);

            if meter_w > 0.0 {
                let half_w = (meter_w - 4.0) * 0.5;
                chrome::meter(
                    ui,
                    row.x + pane.metrics.gutter,
                    meter_y,
                    half_w,
                    3.0,
                    frac_hopper,
                    accent(),
                );
                if vm.battery_pct > 0.0 || vm.mode == "battery" {
                    chrome::meter(
                        ui,
                        row.x + pane.metrics.gutter + half_w + 4.0,
                        meter_y,
                        half_w,
                        3.0,
                        frac_batt,
                        value(),
                    );
                }
            }

            if owner_verbs {
                let labels: &[&str] = if model.survey.batteries.is_empty() {
                    &["CRANK", "STOP", "COLLECT", "DESTROY"]
                } else {
                    &["CRANK", "STOP", "COLLECT", "DESTROY", "BATTERY"]
                };
                let indent = pane.metrics.gutter;
                let clicked = chrome::action_rail(
                    ui,
                    pane.x + indent,
                    rows.cursor(),
                    (pane.w - indent).max(0.0),
                    labels,
                    pane.metrics,
                );
                if let Some(index) = clicked {
                    let command = match index {
                        0 => Some(ClientCommand::CrankExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        1 => Some(ClientCommand::StopCrank {}),
                        2 => Some(ClientCommand::CollectExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        3 => Some(ClientCommand::DestroyExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        _ => model.survey.batteries.first().map(|battery| {
                            ClientCommand::InsertBattery {
                                extractor_id: vm.extractor_id.clone(),
                                container: battery.container.clone(),
                                stack_id: battery.stack_id.clone(),
                                variant_id: battery.variant_id,
                            }
                        }),
                    };
                    if let Some(command) = command {
                        out.push(WindowAction::Command(command));
                    }
                }
                rows.advance(sub_rail);
            }
        }

        if !any_extractors {
            chrome::empty(ui, pane.x, rows.cursor(), "NO EXTRACTORS PLACED");
        }

        pane.resume(&rows);

        // Placed Camps Section if space remains
        if pane.y + pane.metrics.row_h <= pane.bottom {
            pane.section(ui, "PLACED CAMPS");
            let mut camp_rows = pane.rows();
            let mut any_camps = false;

            let camp_h = pane.metrics.row_h + 18.0;
            for camp in &model.survey.camps {
                any_camps = true;
                let Some(mut r) = camp_rows.next_tall(ui, camp_h) else {
                    break;
                };

                let owner_str = if camp.vm.is_owner { "OWNER" } else { "VISITOR" };
                let footprint_str = if camp.in_footprint { "FOOTPRINT" } else { "OUTSIDE" };
                r.value(ui, footprint_str);
                r.value(ui, owner_str);
                let caption = format!("CELL {}, {}", camp.vm.cell_x, camp.vm.cell_y);
                r.label_caption(ui, &camp.vm.render_kind.to_ascii_uppercase(), &caption);
            }

            if !any_camps {
                chrome::empty(ui, pane.x, camp_rows.cursor(), "NO CAMPS IN RANGE");
            }
            pane.resume(&camp_rows);
        }
    }

    if let Some(index) = pane.footer(ui, camp_rail, camp_labels) {
        let command = if index == 0 && can_place {
            ClientCommand::PlaceCamp {}
        } else {
            ClientCommand::PackUpCamp {}
        };
        out.push(WindowAction::Command(command));
    }
}

pub fn agriculture(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    if model.farm.parcels.is_empty() {
        pane.field(
            ui,
            "UNCLAIMED",
            &format!("{}, {}", model.farm.player_cell.0, model.farm.player_cell.1),
        );
        if pane.rail(ui, &["CLAIM PARCEL"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::ClaimParcel {
                planet_id: model.farm.planet_id.clone(),
                area_id: model.farm.area_id.clone(),
                x: model.farm.player_cell.0 as i32,
                y: model.farm.player_cell.1 as i32,
                tier: "homestead".into(),
            }));
        }
        return;
    }
    if ctx.tab == 0 {
        for parcel in model
            .farm
            .parcels
            .iter()
            .filter(|parcel| parcel.is_owner)
            .take(2)
        {
            pane.section(ui, &parcel.name);
            pane.field(ui, "TIER", &parcel.tier.to_ascii_uppercase());
            if let Some(index) = pane.rail(ui, &["UPKEEP", "RENAME", "ABANDON"]) {
                let command = match index {
                    0 => ClientCommand::PayUpkeep {
                        parcel_id: parcel.parcel_id.clone(),
                    },
                    1 => ClientCommand::RenameParcel {
                        parcel_id: parcel.parcel_id.clone(),
                        name: format!("{} Homestead", parcel.name),
                    },
                    _ => ClientCommand::AbandonParcel {
                        parcel_id: parcel.parcel_id.clone(),
                    },
                };
                out.push(WindowAction::Command(command));
            }
            if let Some(plot) = model.farm.plot_for(&parcel.parcel_id) {
                let mut rows = pane.rows();
                for tile in plot.tiles.iter().take(5) {
                    let legal = |verb: &str| {
                        tile.legal_verbs
                            .iter()
                            .any(|candidate| candidate.eq_ignore_ascii_case(verb))
                    };
                    let seed = legal("PlantSeed")
                        .then(|| model.farm.seeds.first())
                        .flatten();
                    let fertilizer = legal("Fertilize")
                        .then(|| model.farm.fertilizers.first())
                        .flatten();
                    let sow_labels: &[&str] = match (seed.is_some(), fertilizer.is_some()) {
                        (true, true) => &["PLANT", "FERTILIZE"],
                        (true, false) => &["PLANT"],
                        (false, true) => &["FERTILIZE"],
                        (false, false) => &[],
                    };
                    let sow_h = if sow_labels.is_empty() {
                        0.0
                    } else {
                        pane.rail_h() + 4.0
                    };
                    if !rows.fits(metrics.row_h + sow_h) {
                        break;
                    }
                    let Some(mut row) = rows.next(ui) else { break };
                    if legal("HarvestCrop") && row.action(ui, "HARVEST") {
                        out.push(WindowAction::Command(ClientCommand::HarvestCrop {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("ClearTile") && row.quiet_action(ui, "CLEAR") {
                        out.push(WindowAction::Command(ClientCommand::ClearTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("WaterTile") && row.action(ui, "WATER") {
                        out.push(WindowAction::Command(ClientCommand::WaterTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("TillTile") && row.action(ui, "TILL") {
                        out.push(WindowAction::Command(ClientCommand::TillTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    row.value(ui, &format!("{:.0}% WET", tile.moisture_pct));
                    row.value(
                        ui,
                        tile.crop
                            .as_ref()
                            .map(|crop| crop.species.as_str())
                            .unwrap_or(if tile.tilled { "TILLED" } else { "UNTILLED" }),
                    );
                    row.label(ui, &format!("{}, {}", tile.cell_x, tile.cell_y));
                    if sow_labels.is_empty() {
                        continue;
                    }
                    let indent = metrics.gutter;
                    let clicked = chrome::action_rail(
                        ui,
                        pane.x + indent,
                        rows.cursor(),
                        (pane.w - indent).max(0.0),
                        sow_labels,
                        metrics,
                    );
                    if let Some(index) = clicked {
                        let command = if index == 0 && seed.is_some() {
                            seed.map(|seed| ClientCommand::PlantSeed {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: seed.container.clone(),
                                stack_id: seed.stack_id.clone(),
                                variant_id: seed.variant_id,
                            })
                        } else {
                            fertilizer.map(|fertilizer| ClientCommand::Fertilize {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: fertilizer.container.clone(),
                                stack_id: fertilizer.stack_id.clone(),
                                variant_id: fertilizer.variant_id,
                            })
                        };
                        if let Some(command) = command {
                            out.push(WindowAction::Command(command));
                        }
                    }
                    rows.advance(sow_h);
                }
                pane.resume(&rows);
            }
            let structure = model.farm.structures.first();
            let labels: &[&str] = if structure.is_some() {
                &["TEND PLOT", "PLACE STRUCTURE"]
            } else {
                &["TEND PLOT"]
            };
            if let Some(index) = pane.rail(ui, labels) {
                let command = if index == 0 {
                    Some(ClientCommand::TendPlot {
                        parcel_id: parcel.parcel_id.clone(),
                        stop: false,
                    })
                } else {
                    structure.map(|structure| ClientCommand::PlaceFarmStructure {
                        parcel_id: parcel.parcel_id.clone(),
                        structure_item_id: structure.item_id,
                        cell_x: model.farm.player_cell.0 as i32,
                        cell_y: model.farm.player_cell.1 as i32,
                    })
                };
                if let Some(command) = command {
                    out.push(WindowAction::Command(command));
                }
            }
        }
        return;
    }

    let mut targeted = false;
    if let (Some(parcel), Some(ghost)) = (&model.build.parcel, &model.build.ghost) {
        targeted = true;
        pane.section(ui, "CATALOG");
        let mut rows = pane.rows();
        for item in model.build.catalog.iter().take(4) {
            let Some(mut row) = rows.next(ui) else { break };
            let enabled = ghost.valid && model.build.affordable(item);
            if enabled && row.action(ui, "PLACE") {
                out.push(WindowAction::Command(ClientCommand::BuildPlace {
                    catalog_id: item.catalog_id.clone(),
                    parcel_id: parcel.parcel_id.clone(),
                    cell_x: ghost.cell_x as i32,
                    cell_y: ghost.cell_y as i32,
                    rotation_quarters: ghost.rotation_quarters,
                    palette: None,
                }));
            }
            let mut costs = String::new();
            for (material, units) in &item.costs {
                if !costs.is_empty() {
                    costs.push_str(", ");
                }
                costs.push_str(&units.to_string());
                costs.push(' ');
                costs.push_str(&material.to_ascii_uppercase());
            }
            row.value(ui, &costs);
            row.label_tinted(ui, &item.label, if enabled { label() } else { dim() });
        }
        pane.resume(&rows);
    }
    pane.section(ui, "PLACED");
    let mut rows = pane.rows();
    let mut placed = false;
    for component in model.build.components.iter().take(3) {
        placed = true;
        let Some(mut row) = rows.next(ui) else { break };
        if row.quiet_action(ui, "REMOVE") {
            out.push(WindowAction::Command(ClientCommand::BuildRemove {
                component_id: component.component_id.clone(),
            }));
        }
        if component.kind.contains("door") && row.action(ui, "TOGGLE") {
            out.push(WindowAction::Command(ClientCommand::BuildToggleDoor {
                component_id: component.component_id.clone(),
            }));
        }
        row.label(ui, &component.catalog_id);
    }
    if !placed {
        chrome::empty(
            ui,
            pane.x,
            rows.cursor(),
            if targeted {
                "NOTHING PLACED YET"
            } else {
                "NO PLACEMENT TARGET"
            },
        );
    }
    pane.resume(&rows);
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::model::{
        CampView, ExtractorView, PlacedCamp, PlacedExtractor, ResourceSpawn, ResourceStats,
        SurveyFamilyOption, SurveyResult,
    };
    use crate::windows::spec;

    fn test_ctx(tab: usize) -> Ctx {
        Ctx {
            spec: spec::surface("survey").expect("survey surface spec"),
            rect: [0.0, 0.0, 360.0, 432.0],
            tab,
        }
    }

    #[test]
    fn test_empty_resource_state() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let ctx = test_ctx(0);
        let model = WindowModel::default();
        let mut out = Vec::new();
        survey(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty(), "empty survey model should emit no actions");
    }

    #[test]
    fn test_concentration_readout() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let ctx = test_ctx(0);
        let mut model = WindowModel::default();
        model.survey.families = vec![SurveyFamilyOption {
            family: "metal".into(),
            label: "METAL".into(),
        }];
        model.survey.results = vec![SurveyResult {
            family: "metal".into(),
            area_id: "area-1".into(),
            spawn_id: "spawn-1".into(),
            spawn_name: "Iron Ore Vein".into(),
            center_x: 10.0,
            center_y: -20.0,
            range_cells: 30,
            step_cells: 2,
            cols: 3,
            rows: 3,
            concentration_milli: vec![100, 750, 400, 200, 850, 300, 0, 50, 600],
            cooldown_until_tick: 0,
            tick: 100,
        }];
        model.survey.spawns = vec![ResourceSpawn {
            spawn_id: "spawn-1".into(),
            family: "metal".into(),
            name: "Iron Ore Vein".into(),
            class_label: "Mineral Deposit".into(),
            variant_id: 1,
            stats: ResourceStats {
                density: 85,
                conductivity: 90,
                ..Default::default()
            },
        }];

        let mut out = Vec::new();
        survey(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_survey_sample_place_commands() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx(0);

        let mut model = WindowModel::default();
        model.survey.families = vec![SurveyFamilyOption {
            family: "metal".into(),
            label: "METAL".into(),
        }];

        // 1. Test PLACE button click
        // Row 0 at y ~ 0.0..36.0. PLACE button action is placed right-to-left.
        let (px, py) = (320.0, 15.0);
        ui.set_input(px, py, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        survey(&mut ui, ctx, &model, &mut out);

        ui.set_input(px, py, false);
        ui.begin(1280, 720);
        out.clear();
        survey(&mut ui, ctx, &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::PlaceExtractor {
                family: "metal".into()
            })),
            "clicking PLACE should emit PlaceExtractor command"
        );

        // 2. Test SURVEY button click (middle action button in row)
        let (sx, sy) = (230.0, 15.0);
        ui.set_input(sx, sy, true);
        ui.begin(1280, 720);
        out.clear();
        survey(&mut ui, ctx, &model, &mut out);

        ui.set_input(sx, sy, false);
        ui.begin(1280, 720);
        out.clear();
        survey(&mut ui, ctx, &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::SurveyResource {
                family: "metal".into()
            })),
            "clicking SURVEY should emit SurveyResource command"
        );

        // 3. Test SAMPLE button click (leftmost action button in row)
        let (smx, smy) = (140.0, 15.0);
        ui.set_input(smx, smy, true);
        ui.begin(1280, 720);
        out.clear();
        survey(&mut ui, ctx, &model, &mut out);

        ui.set_input(smx, smy, false);
        ui.begin(1280, 720);
        out.clear();
        survey(&mut ui, ctx, &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::SampleResource {
                family: "metal".into(),
                stop: false,
            })),
            "clicking SAMPLE should emit SampleResource command"
        );
    }

    #[test]
    fn test_extractors_and_camps_tab() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let ctx = test_ctx(1);
        let mut model = WindowModel::default();
        model.survey.extractors = vec![ExtractorView {
            vm: PlacedExtractor {
                extractor_id: "ext-1".into(),
                area_id: "area-1".into(),
                cell_x: 10,
                cell_y: 20,
                mode: "manual".into(),
                biome: "desert".into(),
                hopper_pct: 45.0,
                collectable_units: 120,
                battery_pct: 0.0,
                is_owner: true,
                family_label: "METAL EXTRACTOR".into(),
            },
            distance: 1.0,
            in_reach: true,
        }];
        model.survey.camps = vec![CampView {
            vm: PlacedCamp {
                camp_id: "camp-1".into(),
                area_id: "area-1".into(),
                cell_x: 5,
                cell_y: 5,
                is_owner: true,
                render_kind: "frontier".into(),
                abandon_seconds_remaining: None,
            },
            distance: 1.0,
            in_footprint: true,
        }];

        let mut out = Vec::new();
        survey(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }
}
