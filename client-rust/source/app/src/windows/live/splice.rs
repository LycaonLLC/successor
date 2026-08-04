//! SPLICE — bioengineering gene bench surface.
//!
//! Three-stage splicing flow matching the web client (LAB -> BENCH -> SPLICE).
//!
//! Web reference: `client-3d/src/ui/splice/spliceWindow.ts`
//! Stages:
//! 1. LAB: specimen wild sampling, seed locker scan rows, scanned genome cards, begin splice.
//! 2. BENCH: sequence slots (parents/reagents), allele segregation selection (1A/1B/2A/2B), assemble gate.
//! 3. SPLICE: locus experimentation, remaining point pool, cultivar minting exit.

use std::cell::RefCell;

use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::{TextField, UiBuilder};
use successor_net::ClientCommand;

thread_local! {
    static SPLICE_NAME: RefCell<TextField> = RefCell::new(TextField::new(48));
    static SELECTED_STAGE: RefCell<Option<usize>> = const { RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn reset_ui_state() {
    SELECTED_STAGE.with(|s| *s.borrow_mut() = None);
    SPLICE_NAME.with(|f| f.borrow_mut().clear());
}

pub fn splice(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let cancel = if model.splice.session.is_some() {
        pane.reserve_footer()
    } else {
        None
    };

    // Determine auto stage from streamed session state.
    let auto_stage = match &model.splice.session {
        None => 0,
        Some(session) => match session.phase.as_str() {
            "browse" => 0,
            "slots" => 1,
            "assembled" => 2,
            _ => 0,
        },
    };

    // Stage rail header: LAB (0), BENCH (1), SPLICE (2).
    let rail_labels = ["1:LAB", "2:BENCH", "3:SPLICE"];

    if let Some(clicked) = pane.rail(ui, &rail_labels) {
        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(clicked));
    }

    let active_stage = SELECTED_STAGE.with(|s| *s.borrow()).unwrap_or(auto_stage);

    if let Some(session) = &model.splice.session {
        pane.field_pair(
            ui,
            ("SPECIES", &session.species_name),
            ("PHASE", &session.phase.to_ascii_uppercase()),
        );
    }

    match active_stage {
        // ── Stage 1: LAB ──────────────────────────────────────────────────────
        0 => {
            if let Some((species, label_str, in_range)) = &model.splice.sample_target {
                pane.section(ui, "WILD SPECIMEN");
                pane.field(ui, "TARGET", label_str);
                if *in_range {
                    if pane.rail(ui, &["GENE SAMPLE"]).is_some() {
                        out.push(WindowAction::Command(ClientCommand::GeneSample {
                            species: species.clone(),
                        }));
                    }
                } else {
                    pane.denied(ui, "OUT OF RANGE - STEP CLOSER TO SAMPLE");
                }
            }

            pane.section(ui, "SEED LOCKER / SAMPLES");
            if !model.splice.samples.is_empty() {
                let mut rows = pane.rows();
                for sample in model.splice.samples.iter().take(4) {
                    let Some(mut row) = rows.next(ui) else { break };
                    if row.action(ui, "SCAN") {
                        out.push(WindowAction::Command(ClientCommand::ScanGenome {
                            container: sample.container.clone(),
                            stack_id: sample.stack_id.clone(),
                            variant_id: sample.variant_id,
                        }));
                    }
                    row.value(ui, &qty(sample.available));
                    row.label(ui, &sample.item);
                }
                pane.resume(&rows);
            } else {
                pane.empty(ui, "NO SEED SAMPLES IN PACK");
            }

            if !model.splice.scans.is_empty() {
                pane.section(ui, "GENOME SCANS");
                let mut rows = pane.rows();
                for scan in model.splice.scans.iter().take(3) {
                    let Some(mut row) = rows.next(ui) else { break };
                    row.value(ui, &scan.tier.to_ascii_uppercase());
                    row.label(ui, &format!("{} ({})", scan.cultivar_name, scan.species_name));
                }
                pane.resume(&rows);
            }

            if model.splice.session.is_none() {
                if let Some((species, _, _)) = &model.splice.sample_target {
                    if pane.rail(ui, &["BEGIN SPLICE"]).is_some() {
                        out.push(WindowAction::Command(ClientCommand::SpliceBegin {
                            species: species.clone(),
                        }));
                    }
                } else {
                    pane.empty(ui, "SELECT A CREATURE OR ACQUIRE A SAMPLE TO BEGIN");
                }
            }
        }

        // ── Stage 2: BENCH ────────────────────────────────────────────────────
        1 => {
            let session = model.splice.session.as_ref();
            if let Some(session) = session {
                pane.section(ui, "SEQUENCE SLOTS");
                if !session.slots.is_empty() {
                    let mut rows = pane.rows();
                    for slot in &session.slots {
                        let Some(mut row) = rows.next(ui) else { break };
                        if slot.filled {
                            if row.quiet_action(ui, "CLEAR") {
                                out.push(WindowAction::Command(ClientCommand::SpliceClearSlot {
                                    slot_index: slot.slot_index,
                                }));
                            }
                            row.value(ui, "FILLED");
                            row.label_tinted(ui, &slot.label, label());
                        } else if let Some(sample) = model.splice.samples.first() {
                            if row.action(ui, "ASSIGN") {
                                out.push(WindowAction::Command(ClientCommand::SpliceAssignSlot {
                                    slot_index: slot.slot_index,
                                    container: sample.container.clone(),
                                    stack_id: sample.stack_id.clone(),
                                    variant_id: sample.variant_id,
                                }));
                            }
                            row.value(ui, "EMPTY");
                            row.label(ui, &slot.label);
                        } else {
                            row.value(ui, "NO SEED");
                            row.label_tinted(ui, &slot.label, dim());
                        }
                    }
                    pane.resume(&rows);
                } else {
                    pane.empty(ui, "NO SEQUENCE SLOTS AVAILABLE");
                }

                if !session.lines.is_empty() {
                    pane.section(ui, "ALLELE SEGREGATION");
                    let mut rows = pane.rows();
                    for line in session.lines.iter().take(5) {
                        let Some(mut row) = rows.next(ui) else { break };
                        for (parent, allele, label_str) in
                            [(1, 1, "2B"), (1, 0, "2A"), (0, 1, "1B"), (0, 0, "1A")]
                        {
                            if row.action(ui, label_str) {
                                out.push(WindowAction::Command(ClientCommand::SpliceChooseAllele {
                                    locus: line.locus,
                                    from_parent: parent,
                                    allele,
                                }));
                            }
                        }
                        row.value(ui, &format!("LOCUS {}", line.locus));
                        row.label(ui, &line.label);
                    }
                    pane.resume(&rows);
                }

                if session.can_assemble {
                    if pane.rail(ui, &["ASSEMBLE"]).is_some() {
                        out.push(WindowAction::Command(ClientCommand::SpliceAssemble {}));
                    }
                } else {
                    pane.denied(ui, "UNSEATED PARENTS - SEAT BOTH PARENT LINES TO ASSEMBLE");
                }
            } else {
                pane.denied(ui, "NO BENCH SESSION - BEGIN SPLICE FIRST");
            }
        }

        // ── Stage 3: SPLICE / FINISH ──────────────────────────────────────────
        _ => {
            let session = model.splice.session.as_ref();
            if let Some(session) = session {
                if session.phase == "assembled" {
                    pane.field_pair(
                        ui,
                        ("POINTS LEFT", &session.points_remaining.to_string()),
                        (
                            "ASSEMBLY",
                            &format!("{:.1}%", session.assembly_quality_milli as f32 / 10.0),
                        ),
                    );

                    pane.section(ui, "LOCI EXPERIMENTATION");
                    let mut rows = pane.rows();
                    for line in session.lines.iter().take(5) {
                        let Some(mut row) = rows.next(ui) else { break };
                        if line.can_raise && session.points_remaining > 0 && row.action(ui, "+1") {
                            out.push(WindowAction::Command(
                                ClientCommand::SpliceExperimentLocus {
                                    locus: line.locus,
                                    points: 1,
                                },
                            ));
                        }
                        row.value(ui, &format!("{} / {}", line.value_milli, line.cap_milli));
                        row.label_tinted(ui, &line.label, if line.can_raise { label() } else { dim() });
                    }
                    pane.resume(&rows);

                    pane.section(ui, "CULTIVAR NAME (OPTIONAL)");
                    let name_y = pane.y;
                    SPLICE_NAME.with(|field| {
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

                    if pane.rail(ui, &["MINT CULTIVAR"]).is_some() {
                        let entered_name = SPLICE_NAME.with(|f| f.borrow().text.clone());
                        let cultivar_name = if entered_name.trim().is_empty() {
                            None
                        } else {
                            Some(entered_name)
                        };
                        out.push(WindowAction::Command(ClientCommand::SpliceMint {
                            cultivar_name,
                        }));
                    }
                } else {
                    pane.denied(ui, "NOT ASSEMBLED YET - COMPLETE BENCH SEGREGATION FIRST");
                }
            } else {
                pane.denied(ui, "NO BENCH SESSION - BEGIN SPLICE FIRST");
            }
        }
    }

    if pane.footer(ui, cancel, &["CANCEL"]).is_some() {
        out.push(WindowAction::Command(ClientCommand::SpliceCancel {}));
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
            spec: spec::surface("splice").expect("splice spec"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn test_splice_stage_advance_and_commands() {
        reset_ui_state();
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let rect = [100.0, 100.0, 600.0, 500.0];

        // 1. Stage 0 (LAB) -> GeneSample & SpliceBegin
        let mut model = WindowModel::default();
        model.splice.sample_target = Some(("sunmelon".into(), "Wild Sunmelon".into(), true));

        // Click GENE SAMPLE rail button
        ui.set_input(110.0, 172.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        splice(&mut ui, test_ctx(rect), &model, &mut out);

        ui.set_input(110.0, 172.0, false);
        ui.begin(1280, 720);
        out.clear();
        splice(&mut ui, test_ctx(rect), &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::GeneSample {
                species: "sunmelon".into()
            })),
            "Expected GeneSample command"
        );

        // 2. Stage 1 (BENCH) -> SpliceAssemble command
        reset_ui_state();
        let mut model = WindowModel::default();
        model.splice.session = Some(SpliceSession {
            phase: "slots".into(),
            species_name: "Sunmelon".into(),
            can_assemble: true,
            ..Default::default()
        });

        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(1));
        ui.set_input(110.0, 193.0, true);
        ui.begin(1280, 720);
        out.clear();
        splice(&mut ui, test_ctx(rect), &model, &mut out);

        ui.set_input(110.0, 193.0, false);
        ui.begin(1280, 720);
        out.clear();
        splice(&mut ui, test_ctx(rect), &model, &mut out);

        assert!(
            out.contains(&WindowAction::Command(ClientCommand::SpliceAssemble {})),
            "Expected SpliceAssemble command"
        );
    }

    #[test]
    fn test_splice_denied_stages() {
        reset_ui_state();
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let rect = [100.0, 100.0, 600.0, 500.0];

        // Out of range specimen target -> denied state
        let mut model = WindowModel::default();
        model.splice.sample_target = Some(("sunmelon".into(), "Wild Sunmelon".into(), false));

        ui.begin(1280, 720);
        let mut out = Vec::new();
        splice(&mut ui, test_ctx(rect), &model, &mut out);
        assert!(
            !out.contains(&WindowAction::Command(ClientCommand::GeneSample {
                species: "sunmelon".into()
            })),
            "Out of range specimen emits no GeneSample"
        );

        // Select Stage 2 (SPLICE) when session is not assembled -> denied state
        let model_unfilled = WindowModel::default();
        SELECTED_STAGE.with(|s| *s.borrow_mut() = Some(2));

        ui.begin(1280, 720);
        out.clear();
        splice(&mut ui, test_ctx(rect), &model_unfilled, &mut out);
        assert!(out.is_empty(), "Denied stage 2 emits no commands");
    }
}
