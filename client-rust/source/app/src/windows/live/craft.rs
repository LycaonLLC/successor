//! CRAFT — portable field crafting surface.
//!
//! Five-stage crafting flow matching the web client (SCHEMATIC -> LOAD -> ASSEMBLE -> TUNE -> FINISH).
//!
//! Web reference: `client-3d/src/ui/crafting/craftWindow.ts`
//! Stages:
//! 1. SCHEMATIC: recipe browser, category/name filter, required tools, begin command.
//! 2. LOAD: component slots showing required vs loaded stacks, assign/clear controls.
//! 3. ASSEMBLE: assembly gate check, assemble command.
//! 4. TUNE: property experimentation lines, remaining point pool, +1 tuning.
//! 5. FINISH: final quality readout, custom item naming, prototype/practice/draft exits.

use std::cell::RefCell;

use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::{TextField, UiBuilder};
use successor_net::ClientCommand;

thread_local! {
    static CRAFT_FILTER: RefCell<TextField> = RefCell::new(TextField::new(32));
    static CRAFT_NAME: RefCell<TextField> = RefCell::new(TextField::new(48));
    static SELECTED_STAGE: RefCell<Option<usize>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn reset_ui_state() {
    SELECTED_STAGE.with(|s| *s.borrow_mut() = None);
    CRAFT_FILTER.with(|f| f.borrow_mut().clear());
    CRAFT_NAME.with(|f| f.borrow_mut().clear());
}

pub fn craft(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let cancel = if model.craft.session.is_some() {
        pane.reserve_footer()
    } else {
        None
    };

    // Determine auto stage from streamed session state.
    let auto_stage = match &model.craft.session {
        None => 0,
        Some(session) => match session.phase.as_str() {
            "browse" => 0,
            "slots" => {
                let can = session.slot_screen.as_ref().map(|s| s.can_assemble).unwrap_or(false);
                if can { 2 } else { 1 }
            }
            "assembled" => 3,
            _ => 0,
        },
    };

    // Stage rail header: SCHEMATIC (0), LOAD (1), ASSEMBLE (2), TUNE (3), FINISH (4).
    let rail_labels = [
        "1:SCHEMATIC",
        "2:LOAD",
        "3:ASSEMBLE",
        "4:TUNE",
        "5:FINISH",
    ];

    if let Some(clicked) = pane.rail(ui, &rail_labels) {
        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(clicked));
    }

    let active_stage = SELECTED_STAGE.with(|s| *s.borrow()).unwrap_or(auto_stage);

    if let Some(session) = &model.craft.session {
        pane.field_pair(
            ui,
            ("PHASE", &session.phase.to_ascii_uppercase()),
            (
                "RECIPE",
                session.recipe_id.as_deref().unwrap_or("NONE SELECTED"),
            ),
        );
    }

    match active_stage {
        // ── Stage 1: SCHEMATIC ────────────────────────────────────────────────
        0 => {
            pane.section(ui, "FILTER PATTERNS");
            let filter_y = pane.y;
            CRAFT_FILTER.with(|field| {
                ui.text_field(
                    &mut field.borrow_mut(),
                    pane.x,
                    filter_y,
                    pane.w,
                    chrome::FIELD_H,
                    1.0,
                    true,
                    crate::hud::button_style(),
                );
            });
            pane.y += chrome::FIELD_H + 6.0;

            pane.section(ui, "SCHEMATICS");
            let filter_text = CRAFT_FILTER.with(|f| f.borrow().text.to_ascii_uppercase());

            if let Some(session) = &model.craft.session {
                let mut rows = pane.rows();
                let mut match_count = 0;
                let mut any = false;

                for recipe in &session.recipes {
                    any = true;
                    let matches_filter = filter_text.is_empty()
                        || recipe.name.to_ascii_uppercase().contains(&filter_text)
                        || recipe.category.to_ascii_uppercase().contains(&filter_text);
                    if !matches_filter {
                        continue;
                    }
                    match_count += 1;

                    let Some(mut row) = rows.next(ui) else { break };
                    if recipe.unlocked {
                        if row.action(ui, "BEGIN") {
                            out.push(WindowAction::Command(ClientCommand::CraftBegin {
                                recipe_id: recipe.recipe_id.clone(),
                            }));
                        }
                        let display = format!("[{}] {}", recipe.category, recipe.name);
                        row.label_tinted(ui, &display, label());
                    } else {
                        let display = format!("[LOCKED] {}", recipe.name);
                        row.label_tinted(ui, &display, dim());
                    }
                }

                if !any {
                    chrome::empty(ui, pane.x, rows.cursor(), "NO SCHEMATICS KNOWN");
                } else if match_count == 0 {
                    chrome::empty(ui, pane.x, rows.cursor(), "NO PATTERNS MATCH FILTER");
                }
                pane.resume(&rows);
            } else {
                pane.empty(ui, "NO ACTIVE CRAFT SESSION - START BENCH");
            }

            if model.craft.session.is_none() {
                if let Some(trainer_actor_id) = &model.craft.trainer_actor_id {
                    if pane.rail(ui, &["REQUEST STARTER TOOL"]).is_some() {
                        out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
                            trainer_actor_id: trainer_actor_id.clone(),
                        }));
                    }
                }
            }
        }

        // ── Stage 2: LOAD (Component Slots) ──────────────────────────────────
        1 => {
            let session = model.craft.session.as_ref();
            let screen = session.and_then(|s| s.slot_screen.as_ref());

            if let Some(screen) = screen {
                pane.section(ui, "COMPONENT SLOTS");
                let mut rows = pane.rows();
                let mut any = false;

                for slot in &screen.slots {
                    any = true;
                    let Some(mut row) = rows.next(ui) else { break };

                    if slot.assigned.is_some() {
                        if row.quiet_action(ui, "CLEAR") {
                            out.push(WindowAction::Command(ClientCommand::CraftClearSlot {
                                slot_index: slot.slot_index,
                            }));
                        }
                        row.value(ui, "LOADED");
                        let req_name = slot.required_item_name.as_deref().unwrap_or("");
                        let desc = if req_name.is_empty() {
                            format!("{} x{}", slot.symbol, slot.required_qty)
                        } else {
                            format!("{} ({}) x{}", slot.symbol, req_name, slot.required_qty)
                        };
                        row.label_tinted(ui, &desc, label());
                    } else {
                        let best = slot
                            .eligible
                            .iter()
                            .find(|resource| resource.recommended)
                            .or_else(|| slot.eligible.first());

                        if let Some(resource) = best {
                            let short = resource.qty_available < slot.required_qty;
                            if !short && row.action(ui, "ASSIGN") {
                                out.push(WindowAction::Command(ClientCommand::CraftAssignSlot {
                                    slot_index: slot.slot_index,
                                    container: resource.container.clone(),
                                    stack_id: resource.stack_id.clone(),
                                    variant_id: resource.variant_id,
                                }));
                            }
                            if short {
                                row.value(ui, &format!("SHORT ({}/{})", resource.qty_available, slot.required_qty));
                                row.label_tinted(ui, &slot.resource_kind_label, dim());
                            } else {
                                row.value(ui, &format!("FIT x{}", resource.qty_available));
                                row.label(ui, &slot.resource_kind_label);
                            }
                        } else {
                            row.value(ui, "NO MATERIAL");
                            row.label_tinted(ui, &slot.resource_kind_label, dim());
                        }
                    }
                }

                if !any {
                    chrome::empty(ui, pane.x, rows.cursor(), "NO COMPONENT SLOTS");
                }
                pane.resume(&rows);
            } else {
                pane.denied(ui, "NO ACTIVE COMPONENT SLOTS - BEGIN A SCHEMATIC FIRST");
            }
        }

        // ── Stage 3: ASSEMBLE ────────────────────────────────────────────────
        2 => {
            let session = model.craft.session.as_ref();
            let screen = session.and_then(|s| s.slot_screen.as_ref());

            if let Some(screen) = screen {
                pane.section(ui, "ASSEMBLE GATE");
                let filled = screen.slots.iter().filter(|s| s.assigned.is_some()).count();
                let total = screen.slots.len();

                pane.field_pair(
                    ui,
                    ("SLOTS FILLED", &format!("{filled} / {total}")),
                    ("GATE", if screen.can_assemble { "READY" } else { "INCOMPLETE" }),
                );

                if screen.can_assemble {
                    if pane.rail(ui, &["ASSEMBLE"]).is_some() {
                        out.push(WindowAction::Command(ClientCommand::CraftAssemble {}));
                    }
                } else {
                    pane.denied(ui, "UNFILLED SLOTS - FILL EVERY SLOT TO ASSEMBLE");
                }
            } else {
                pane.denied(ui, "NOT AT ASSEMBLY STAGE - BEGIN A SCHEMATIC FIRST");
            }
        }

        // ── Stage 4: TUNE (Experimentation) ──────────────────────────────────
        3 => {
            let session = model.craft.session.as_ref();
            let assembled = session.and_then(|s| s.assembled.as_ref());

            if let Some(assembled) = assembled {
                pane.field_pair(
                    ui,
                    ("POINTS LEFT", &assembled.experimentation_points_remaining.to_string()),
                    (
                        "ASSEMBLY",
                        &format!("{:.1}%", assembled.assembly_quality_milli as f32 / 10.0),
                    ),
                );

                pane.section(ui, "PROPERTY EXPERIMENTATION");
                let mut rows = pane.rows();

                for line in &assembled.lines {
                    let Some(mut row) = rows.next(ui) else { break };
                    if line.can_raise
                        && assembled.experimentation_points_remaining > 0
                        && row.action(ui, "+1")
                    {
                        out.push(WindowAction::Command(ClientCommand::CraftExperiment {
                            line_id: line.line_id,
                            points: 1,
                        }));
                    }

                    let chance_text = if let Some(h) = line.one_point_success_milli {
                        format!(" ({}%)", h / 10)
                    } else {
                        String::new()
                    };

                    row.value(ui, &format!("{} / {}{}", line.value_milli, line.cap_milli, chance_text));
                    row.label_tinted(ui, &line.label, if line.can_raise { label() } else { dim() });
                }
                pane.resume(&rows);

                if pane.rail(ui, &["PROCEED TO FINISH"]).is_some() {
                    SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(4));
                }
            } else {
                pane.denied(ui, "NOT ASSEMBLED YET - COMPLETE ASSEMBLY FIRST");
            }
        }

        // ── Stage 5: FINISH ──────────────────────────────────────────────────
        _ => {
            let session = model.craft.session.as_ref();
            let assembled = session.and_then(|s| s.assembled.as_ref());

            if let Some(assembled) = assembled {
                pane.field(
                    ui,
                    "FINAL ASSEMBLY QUALITY",
                    &format!("{:.1}%", assembled.assembly_quality_milli as f32 / 10.0),
                );

                pane.section(ui, "CUSTOM ITEM NAME (OPTIONAL)");
                let name_y = pane.y;
                CRAFT_NAME.with(|field| {
                    ui.text_field(
                        &mut field.borrow_mut(),
                        pane.x,
                        name_y,
                        pane.w,
                        chrome::FIELD_H,
                        1.0,
                        true,
                        crate::hud::button_style(),
                    );
                });
                pane.y += chrome::FIELD_H + 6.0;

                pane.section(ui, "LEAVE BENCH AS");
                if let Some(index) = pane.rail(ui, &["PROTOTYPE", "PRACTICE", "DRAFT"]) {
                    let entered_name = CRAFT_NAME.with(|f| f.borrow().text.clone());
                    let custom_name = if entered_name.trim().is_empty() {
                        assembled.recipe_id.clone()
                    } else {
                        entered_name
                    };

                    let command = match index {
                        0 => ClientCommand::CraftFinalizePrototype { custom_name },
                        1 => ClientCommand::CraftFinalizePractice {},
                        _ => ClientCommand::CraftDraftSchematic { max_uses: 100 },
                    };
                    out.push(WindowAction::Command(command));
                }
            } else {
                pane.denied(ui, "NOT ASSEMBLED YET - COMPLETE ASSEMBLY FIRST");
            }
        }
    }

    // Factory Section (if factory terminal active).
    if model.craft.factory.available {
        if let Some(factory_id) = model.craft.factory.prop_id.as_ref() {
            pane.section(ui, "FACTORY DRAFTS");
            let mut rows = pane.rows();
            let mut any = false;

            for draft in model.craft.drafts.iter().take(5) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if draft.remaining_uses > 0 && row.action(ui, "MANUFACTURE") {
                    out.push(WindowAction::Command(ClientCommand::FactoryManufacture {
                        factory_id: factory_id.clone(),
                        schematic_id: draft.id.clone(),
                    }));
                }
                row.value(ui, &format!("{} USES", draft.remaining_uses));
                row.label(ui, &draft.recipe_id);
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO DRAFTED SCHEMATICS");
            }
            pane.resume(&rows);
        }
    } else if !model.craft.factory.note.is_empty() {
        pane.empty(ui, &model.craft.factory.note);
    }

    if pane.footer(ui, cancel, &["CANCEL SESSION"]).is_some() {
        out.push(WindowAction::Command(ClientCommand::CraftCancel {}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::*;
    use crate::windows::spec;

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: spec::surface("craft").expect("craft spec"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn test_craft_stage_advance_and_commands() {
        reset_ui_state();
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let rect = [100.0, 100.0, 600.0, 500.0];

        // 1. Stage 0 (SCHEMATIC) -> BEGIN recipe
        let mut model = WindowModel::default();
        model.craft.session = Some(CraftSession {
            phase: "browse".into(),
            recipes: vec![CraftRecipeSummary {
                recipe_id: "slugthrower".into(),
                name: "Slugthrower Pistol".into(),
                category: "WEAPON".into(),
                unlocked: true,
                ..Default::default()
            }],
            ..Default::default()
        });

        // Click BEGIN button on recipe row
        ui.set_input(660.0, 225.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        craft(&mut ui, test_ctx(rect), &model, &mut out);

        ui.set_input(660.0, 225.0, false);
        ui.begin(1280, 720);
        out.clear();
        craft(&mut ui, test_ctx(rect), &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::CraftBegin {
                recipe_id: "slugthrower".into()
            })),
            "Expected CraftBegin command emission"
        );

        // 2. Stage 1 (LOAD) -> ASSIGN slot
        reset_ui_state();
        let mut model = WindowModel::default();
        model.craft.session = Some(CraftSession {
            phase: "slots".into(),
            slot_screen: Some(CraftSlotScreen {
                recipe_id: "slugthrower".into(),
                slots: vec![CraftSlotFill {
                    slot_index: 0,
                    symbol: "metal".into(),
                    resource_kind_label: "Copper".into(),
                    required_qty: 10,
                    eligible: vec![CraftResourceOption {
                        container: "inv".into(),
                        stack_id: "stk1".into(),
                        variant_id: 1,
                        name: "Copper Ore".into(),
                        qty_available: 50,
                        recommended: true,
                        ..Default::default()
                    }],
                    assigned: None,
                    ..Default::default()
                }],
                can_assemble: false,
            }),
            ..Default::default()
        });

        // Render in Stage 1
        ui.set_input(0.0, 0.0, false);
        ui.begin(1280, 720);
        out.clear();
        craft(&mut ui, test_ctx(rect), &model, &mut out);

        // 3. Stage 2 (ASSEMBLE) -> CraftAssemble command
        reset_ui_state();
        let mut model = WindowModel::default();
        model.craft.session = Some(CraftSession {
            phase: "slots".into(),
            slot_screen: Some(CraftSlotScreen {
                recipe_id: "slugthrower".into(),
                slots: vec![],
                can_assemble: true,
            }),
            ..Default::default()
        });

        ui.set_input(110.0, 190.0, true);
        ui.begin(1280, 720);
        out.clear();
        craft(&mut ui, test_ctx(rect), &model, &mut out);

        ui.set_input(110.0, 190.0, false);
        ui.begin(1280, 720);
        out.clear();
        craft(&mut ui, test_ctx(rect), &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::CraftAssemble {})),
            "Expected CraftAssemble command"
        );
    }

    #[test]
    fn test_craft_denied_stages() {
        reset_ui_state();
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let rect = [100.0, 100.0, 600.0, 500.0];

        // Session is None, select Stage 3 (TUNE) -> denied state
        let model = WindowModel::default();
        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(3));

        ui.begin(1280, 720);
        let mut out = Vec::new();
        craft(&mut ui, test_ctx(rect), &model, &mut out);
        assert!(out.is_empty(), "Denied stage emits no commands");

        // Select Stage 2 (ASSEMBLE) when slots are not ready -> denied state
        let mut model_slots = WindowModel::default();
        model_slots.craft.session = Some(CraftSession {
            phase: "slots".into(),
            slot_screen: Some(CraftSlotScreen {
                recipe_id: "slugthrower".into(),
                slots: vec![],
                can_assemble: false,
            }),
            ..Default::default()
        });

        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(2));
        ui.begin(1280, 720);
        out.clear();
        craft(&mut ui, test_ctx(rect), &model_slots, &mut out);
        assert!(
            !out.contains(&WindowAction::Command(ClientCommand::CraftAssemble {})),
            "Denied assemble stage emits no assemble command"
        );
    }
}
