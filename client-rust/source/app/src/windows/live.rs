//! Authority-backed connected workflow windows.
//!
//! These views read only `WindowModel` and emit exact `ClientCommand` values;
//! unavailable context is rendered explicitly and never falls back to samples.

use std::cell::RefCell;

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT_EDGE, TEXT};
use successor_engine_render::ui::{ButtonStyle, TextField, UiBuilder};
use successor_net::{ClientCommand, TradeItemSpec};
thread_local! {
    static GUILD_NAME: RefCell<TextField> = RefCell::new(TextField::new(32));
    static GUILD_TAG: RefCell<TextField> = RefCell::new(TextField::new(5));
    static DATAPAD_TAB: RefCell<usize> = const { RefCell::new(0) };
    static MACRO_NAME: RefCell<TextField> = RefCell::new(TextField::new(48));
    static MACRO_BODY: RefCell<TextField> = RefCell::new(TextField::new(8 * 1024));
}

fn title(ui: &mut UiBuilder, rect: [f32; 4], text: &str) -> f32 {
    ui.text(text, rect[0], rect[1], 2.2, ACCENT);
    ui.rect(rect[0], rect[1] + 18.0, rect[2], 1.0, SLOT_EDGE);
    rect[1] + 26.0
}

fn unavailable(ui: &mut UiBuilder, x: f32, y: f32, note: &str) {
    ui.text(
        if note.is_empty() { "UNAVAILABLE" } else { note },
        x,
        y,
        1.8,
        DIM,
    );
}

pub fn unavailable_window(ui: &mut UiBuilder, rect: [f32; 4], heading: &str, note: &str) {
    let y = title(ui, rect, heading);
    unavailable(ui, rect[0], y, note);
}
pub fn bank(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "BANK / EXCHANGE");
    if !model.bank.gate.available {
        unavailable(ui, x, y, &model.bank.gate.note);
        return;
    }
    let Some(bank) = &model.bank.bank else {
        unavailable(ui, x, y, "BANK STATE UNAVAILABLE");
        return;
    };
    ui.text(
        &format!("WALLET {}  VAULT {}", model.inventory.credits, bank.credits),
        x,
        y,
        1.8,
        TEXT,
    );
    y += 24.0;
    let half = (w - 8.0) * 0.5;
    if ui.button(x, y, half, 24.0, "DEPOSIT 100 CR", ButtonStyle::default()) {
        out.push(WindowAction::Command(ClientCommand::BankDepositCredits {
            amount: model.inventory.credits.clamp(0, 100) as u64,
        }));
    }
    if ui.button(
        x + half + 8.0,
        y,
        half,
        24.0,
        "WITHDRAW 100 CR",
        ButtonStyle::default(),
    ) {
        out.push(WindowAction::Command(ClientCommand::BankWithdrawCredits {
            amount: bank.credits.clamp(0, 100) as u64,
        }));
    }
    y += 32.0;
    for row in model.inventory.held().take(4) {
        ui.text(
            &format!("{} ×{}", row.item, row.available),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if row.available > 0
            && ui.button(x + w - 74.0, y, 74.0, 24.0, "STORE", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::BankStoreItem {
                source_stack_id: row.stack_id.clone(),
                quantity: row.available as u32,
            }));
        }
        y += 28.0;
    }
    for row in bank.items.iter().take(4) {
        ui.text(
            &format!("VAULT {} ×{}", row.item, row.quantity),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if row.quantity > 0
            && ui.button(x + w - 74.0, y, 74.0, 24.0, "TAKE", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::BankRetrieveItem {
                bank_stack_id: row.stack_id.clone(),
                quantity: row.quantity as u32,
            }));
        }
        y += 28.0;
    }
    if y + 28.0 < rect[1] + h
        && ui.button(
            x,
            y,
            w,
            24.0,
            "SAVE CLONE SKILL BACKUP",
            ButtonStyle::default(),
        )
    {
        out.push(WindowAction::Command(
            ClientCommand::CloneSaveSkillBackup {},
        ));
    }
}

pub fn exchange(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "DATAPAD · EXCHANGE");
    let mut any = false;
    for row in model.inventory.exchange().take(10) {
        any = true;
        ui.text(
            &format!("{} ×{}", row.item, row.quantity),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if row.quantity > 0
            && ui.button(
                x + w - 86.0,
                y,
                86.0,
                24.0,
                "RETRIEVE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::RetrieveFromExchange {
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity as u32,
            }));
        }
        y += 28.0;
    }
    if !any {
        unavailable(ui, x, y, "EXCHANGE EMPTY");
    }
}

pub fn survey(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "RESOURCES / EXTRACTION");
    for family in model.survey.families.iter().take(4) {
        ui.text(&family.label, x, y + 5.0, 1.6, TEXT);
        let bw = 64.0;
        if model.survey.sample_cooldown_ticks <= 0
            && ui.button(
                x + w - bw * 3.0 - 8.0,
                y,
                bw,
                24.0,
                "SAMPLE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::SampleResource {
                family: family.family.clone(),
                stop: false,
            }));
        }
        if ui.button(
            x + w - bw * 2.0 - 4.0,
            y,
            bw,
            24.0,
            "SURVEY",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::SurveyResource {
                family: family.family.clone(),
            }));
        }
        if ui.button(x + w - bw, y, bw, 24.0, "PLACE", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::PlaceExtractor {
                family: family.family.clone(),
            }));
        }
        y += 28.0;
        if let Some((rx, ry, concentration)) = model
            .survey
            .result_for(&family.family)
            .and_then(|result| result.richest())
        {
            ui.text(
                &format!("RICH POINT {rx:.0},{ry:.0} · {}%", concentration / 10),
                x + 12.0,
                y,
                1.4,
                DIM,
            );
            y += 18.0;
        }
    }
    for extractor in model.survey.extractors.iter().take(3) {
        if y + 54.0 > rect[1] + h {
            return;
        }
        let vm = &extractor.vm;
        ui.text(
            &format!(
                "{} · {} · OUT {}",
                vm.family_label,
                vm.mode.to_ascii_uppercase(),
                vm.collectable_units
            ),
            x,
            y,
            1.5,
            if extractor.in_reach { TEXT } else { DIM },
        );
        y += 20.0;
        if extractor.in_reach && vm.is_owner {
            let mut bx = x;
            let bw = (w - 16.0) / 5.0;
            let commands = [
                (
                    "CRANK",
                    ClientCommand::CrankExtractor {
                        extractor_id: vm.extractor_id.clone(),
                    },
                ),
                ("STOP", ClientCommand::StopCrank {}),
                (
                    "COLLECT",
                    ClientCommand::CollectExtractor {
                        extractor_id: vm.extractor_id.clone(),
                    },
                ),
                (
                    "DESTROY",
                    ClientCommand::DestroyExtractor {
                        extractor_id: vm.extractor_id.clone(),
                    },
                ),
            ];
            for (label, command) in commands {
                if ui.button(bx, y, bw, 22.0, label, ButtonStyle::default()) {
                    out.push(WindowAction::Command(command));
                }
                bx += bw + 4.0;
            }
            if let Some(battery) = model.survey.batteries.first() {
                if ui.button(bx, y, bw, 22.0, "BATTERY", ButtonStyle::default()) {
                    out.push(WindowAction::Command(ClientCommand::InsertBattery {
                        extractor_id: vm.extractor_id.clone(),
                        container: battery.container.clone(),
                        stack_id: battery.stack_id.clone(),
                        variant_id: battery.variant_id,
                    }));
                }
            }
            y += 28.0;
        }
    }
    if !model.survey.own_camp_placed
        && ui.button(x, y, w, 24.0, "PLACE CAMP", ButtonStyle::default())
    {
        out.push(WindowAction::Command(ClientCommand::PlaceCamp {}));
    }
    for camp in &model.survey.camps {
        if camp.vm.is_owner
            && camp.in_footprint
            && ui.button(x, y + 28.0, w, 24.0, "PACK UP CAMP", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::PackUpCamp {}));
            break;
        }
    }
}

pub fn craft(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "CRAFT / FACTORY");
    if let Some(session) = &model.craft.session {
        ui.text(
            &format!("PHASE {}", session.phase.to_ascii_uppercase()),
            x,
            y,
            1.7,
            TEXT,
        );
        y += 24.0;
        if session.phase == "browse" {
            for recipe in session.recipes.iter().take(7) {
                ui.text(
                    &recipe.name,
                    x,
                    y + 5.0,
                    1.6,
                    if recipe.unlocked { TEXT } else { DIM },
                );
                if recipe.unlocked
                    && ui.button(x + w - 70.0, y, 70.0, 24.0, "BEGIN", ButtonStyle::default())
                {
                    out.push(WindowAction::Command(ClientCommand::CraftBegin {
                        recipe_id: recipe.recipe_id.clone(),
                    }));
                }
                y += 28.0;
            }
        }
        if let Some(screen) = &session.slot_screen {
            for slot in screen.slots.iter().take(6) {
                ui.text(
                    &format!("{} · {}", slot.symbol, slot.resource_kind_label),
                    x,
                    y + 5.0,
                    1.5,
                    TEXT,
                );
                if slot.assigned.is_some() {
                    if ui.button(x + w - 70.0, y, 70.0, 24.0, "CLEAR", ButtonStyle::default()) {
                        out.push(WindowAction::Command(ClientCommand::CraftClearSlot {
                            slot_index: slot.slot_index,
                        }));
                    }
                } else if let Some(resource) = slot
                    .eligible
                    .iter()
                    .find(|resource| resource.recommended)
                    .or_else(|| slot.eligible.first())
                {
                    if ui.button(
                        x + w - 70.0,
                        y,
                        70.0,
                        24.0,
                        "ASSIGN",
                        ButtonStyle::default(),
                    ) {
                        out.push(WindowAction::Command(ClientCommand::CraftAssignSlot {
                            slot_index: slot.slot_index,
                            container: resource.container.clone(),
                            stack_id: resource.stack_id.clone(),
                            variant_id: resource.variant_id,
                        }));
                    }
                }
                y += 28.0;
            }
            if screen.can_assemble && ui.button(x, y, w, 24.0, "ASSEMBLE", ButtonStyle::default()) {
                out.push(WindowAction::Command(ClientCommand::CraftAssemble {}));
                y += 28.0;
            }
        }
        if let Some(assembled) = &session.assembled {
            for line in assembled.lines.iter().take(4) {
                ui.text(
                    &format!("{} · {}/{}", line.label, line.value_milli, line.cap_milli),
                    x,
                    y + 5.0,
                    1.5,
                    TEXT,
                );
                if line.can_raise
                    && assembled.experimentation_points_remaining > 0
                    && ui.button(x + w - 70.0, y, 70.0, 24.0, "+1", ButtonStyle::default())
                {
                    out.push(WindowAction::Command(ClientCommand::CraftExperiment {
                        line_id: line.line_id,
                        points: 1,
                    }));
                }
                y += 28.0;
            }
            let bw = (w - 12.0) / 3.0;
            if ui.button(x, y, bw, 24.0, "PROTOTYPE", ButtonStyle::default()) {
                out.push(WindowAction::Command(
                    ClientCommand::CraftFinalizePrototype {
                        custom_name: assembled.recipe_id.clone(),
                    },
                ));
            }
            if ui.button(
                x + bw + 6.0,
                y,
                bw,
                24.0,
                "PRACTICE",
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(
                    ClientCommand::CraftFinalizePractice {},
                ));
            }
            if ui.button(
                x + (bw + 6.0) * 2.0,
                y,
                bw,
                24.0,
                "DRAFT",
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(ClientCommand::CraftDraftSchematic {
                    max_uses: 100,
                }));
            }
            y += 30.0;
        }
        if y + 26.0 < rect[1] + h
            && ui.button(x, y, w, 24.0, "CANCEL SESSION", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::CraftCancel {}));
        }
    } else if let Some(trainer_actor_id) = &model.craft.trainer_actor_id {
        if ui.button(
            x,
            y,
            w,
            24.0,
            "REQUEST STARTER TOOL",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
                trainer_actor_id: trainer_actor_id.clone(),
            }));
        }
        y += 30.0;
    } else {
        unavailable(ui, x, y, "NO ACTIVE CRAFT SESSION");
        y += 24.0;
    }
    if model.craft.factory.available {
        let Some(factory_id) = model.craft.factory.prop_id.as_ref() else {
            return;
        };
        for draft in model.craft.drafts.iter().take(5) {
            ui.text(
                &format!("{} · {} USES", draft.recipe_id, draft.remaining_uses),
                x,
                y + 5.0,
                1.5,
                TEXT,
            );
            if draft.remaining_uses > 0
                && ui.button(
                    x + w - 92.0,
                    y,
                    92.0,
                    24.0,
                    "MANUFACTURE",
                    ButtonStyle::default(),
                )
            {
                out.push(WindowAction::Command(ClientCommand::FactoryManufacture {
                    factory_id: factory_id.clone(),
                    schematic_id: draft.id.clone(),
                }));
            }
            y += 28.0;
        }
    } else if !model.craft.factory.note.is_empty() {
        unavailable(ui, x, y, &model.craft.factory.note);
    }
}

pub fn clone_terminal(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "CLONE TERMINAL");
    let clone = &model.clone;
    if !clone.gate.available {
        unavailable(ui, x, y, &clone.gate.note);
        return;
    }
    ui.text(
        &format!(
            "BACKUP {} · {} SKILLS · COST {}",
            if clone.backup_present {
                "READY"
            } else {
                "NONE"
            },
            clone.backup_skill_count,
            clone.backup_cost
        ),
        x,
        y,
        1.7,
        TEXT,
    );
    y += 28.0;
    if ui.button(x, y, w, 24.0, "SAVE SKILL BACKUP", ButtonStyle::default()) {
        out.push(WindowAction::Command(
            ClientCommand::CloneSaveSkillBackup {},
        ));
    }
    y += 30.0;
    if clone.dead && ui.button(x, y, w, 28.0, "RESPAWN FROM CLONE", ButtonStyle::default()) {
        out.push(WindowAction::Command(ClientCommand::CloneRespawn {
            facility_id: clone.gate.prop_id.clone(),
        }));
    }
}

pub fn converse_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, _, _] = rect;
    [x, y, 82.0, 136.0]
}

pub fn converse(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    let Some(npc) = &model.converse.npc else {
        unavailable(ui, x, y, "NO DIALOGUE TARGET");
        return;
    };
    let preview = converse_preview_rect(rect);
    ui.rect(
        preview[0],
        preview[1],
        preview[2],
        preview[3],
        [4, 10, 10, 24],
    );

    let name_w = UiBuilder::text_width(&npc.name, 1.45);
    ui.text(
        &npc.name,
        x + (preview[2] - name_w) * 0.5,
        y + preview[3] + 8.0,
        1.45,
        TEXT,
    );
    ui.text("TRAINER", x + 26.0, y + preview[3] + 27.0, 1.1, DIM);

    let dialogue_x = x + preview[2] + 10.0;
    let dialogue_w = w - preview[2] - 10.0;
    ui.rect(dialogue_x, y, dialogue_w, 102.0, [6, 13, 14, 220]);

    if let Some(delivery) = model.converse.deliveries.last() {
        ui.text(&delivery.body, dialogue_x + 8.0, y + 9.0, 1.45, TEXT);
    } else {
        ui.text("State your business.", dialogue_x + 8.0, y + 9.0, 1.45, DIM);
    }

    let mut response_y = y + 118.0;
    let mut number = 1usize;
    for (goal_id, label) in model.converse.career_goals.iter().take(3) {
        let active = model.converse.career_goal_id.as_deref() == Some(goal_id.as_str());
        let text = if active {
            format!("{}  ACTIVE CAREER GOAL", number)
        } else {
            format!("{}  {}", number, label)
        };
        if ui.button(
            dialogue_x,
            response_y,
            dialogue_w,
            23.0,
            &text,
            ButtonStyle::default(),
        ) && !active
        {
            out.push(WindowAction::Command(ClientCommand::SetCareerGoal {
                goal_id: goal_id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
        response_y += 26.0;
    }
    for skill in model.converse.teachable.iter().take(3) {
        let text = format!("{}  LEARN {}", number, skill.label);
        if ui.button(
            dialogue_x,
            response_y,
            dialogue_w,
            23.0,
            &text,
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::PurchaseSkillBox {
                skill_box_id: skill.id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
        response_y += 26.0;
    }
    if response_y + 23.0 < y + h
        && ui.button(
            dialogue_x,
            response_y,
            dialogue_w,
            23.0,
            &format!("{}  REQUEST STARTER TOOL", number),
            ButtonStyle::default(),
        )
    {
        out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
            trainer_actor_id: npc.actor_id.clone(),
        }));
    }
}

pub fn travel(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "TRAVEL");
    if !model.travel.gate.available {
        unavailable(ui, x, y, &model.travel.gate.note);
        return;
    }
    let terminal_prop_id = model
        .travel
        .gate
        .prop_id
        .as_ref()
        .expect("open travel gate has a prop id");
    for planet in &model.travel.planets {
        for city in &planet.cities {
            let is_origin = model
                .travel
                .origin
                .as_ref()
                .is_some_and(|origin| origin.0 == planet.id && origin.1 == city.id);
            ui.text(
                &format!("{} · {}", planet.label, city.label),
                x,
                y + 5.0,
                if is_origin { 1.5 } else { 1.7 },
                if is_origin { DIM } else { TEXT },
            );
            if !is_origin
                && ui.button(
                    x + w - 82.0,
                    y,
                    82.0,
                    24.0,
                    "BUY TICKET",
                    ButtonStyle::default(),
                )
            {
                out.push(WindowAction::Command(ClientCommand::PurchaseTravelTicket {
                    terminal_prop_id: terminal_prop_id.clone(),
                    to_planet_id: planet.id.clone(),
                    to_city_id: city.id.clone(),
                }));
            }
            y += 28.0;
        }
    }
    for ticket in &model.travel.tickets {
        let travel = ticket
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("travelTicket"));
        let ticket_id = travel
            .and_then(|value| value.get("ticketId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        ui.text(
            &ticket
                .ticket_destination()
                .unwrap_or_else(|| ticket.item.to_ascii_uppercase()),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if ui.button(x + w - 82.0, y, 82.0, 24.0, "USE", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::UseTravelTicket {
                container: Some(ticket.container.clone()),
                stack_id: Some(ticket.stack_id.clone()),
                ticket_id,
                item_id: ticket.item_key.clone(),
                item_numeric_id: Some(ticket.item_id),
                variant_id: Some(ticket.variant_id),
            }));
        }
        y += 28.0;
    }
}

pub fn examine_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    let preview_h = (h * 0.54).max(170.0);
    let preview_w = (preview_h * 0.60).min(w);
    [x + (w - preview_w) * 0.5, y, preview_w, preview_h]
}

pub fn examine_item_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    [x, y, w, w.min((h * 0.62).max(190.0))]
}

pub fn examine(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    if let Some(actor) = &model.examine.actor {
        let preview = examine_preview_rect(rect);
        ui.rect(
            preview[0],
            preview[1],
            preview[2],
            preview[3],
            [4, 10, 10, 24],
        );

        let info_y = y + preview[3] + 10.0;
        ui.text(&actor.name, x + 8.0, info_y, 1.8, TEXT);
        ui.text(
            &actor.descriptor.to_ascii_uppercase(),
            x + 8.0,
            info_y + 23.0,
            1.1,
            DIM,
        );
        ui.text(
            &actor.life_state.to_ascii_uppercase(),
            x + 8.0,
            info_y + 42.0,
            1.2,
            TEXT,
        );
        let gauge_y = info_y + 65.0;
        ui.text("HEALTH", x + 8.0, gauge_y, 1.05, DIM);
        let ratio = if actor.health_max > 0.0 {
            (actor.health / actor.health_max).clamp(0.0, 1.0)
        } else {
            0.0
        };
        ui.rect(x + 58.0, gauge_y + 1.0, w - 98.0, 7.0, [8, 24, 26, 235]);
        ui.rect(x + 58.0, gauge_y + 1.0, (w - 98.0) * ratio, 7.0, ACCENT);
        ui.text(
            &format!("{:.0}/{:.0}", actor.health, actor.health_max),
            x + w - 36.0,
            gauge_y,
            1.05,
            TEXT,
        );
        let faction = actor
            .faction_id
            .as_deref()
            .unwrap_or("UNKNOWN")
            .to_ascii_uppercase();
        ui.text("FACTION", x + 8.0, gauge_y + 22.0, 1.05, DIM);
        ui.text(&faction, x + 58.0, gauge_y + 22.0, 1.05, TEXT);
        if actor.life_state != "alive"
            && ui.button(
                x + 8.0,
                y + h - 28.0,
                w - 16.0,
                22.0,
                "REVIVE / STABILIZE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::ReviveActor {
                target_actor_id: actor.actor_id.clone(),
            }));
        }
        return;
    }
    if let Some(item) = &model.examine.item {
        let preview = examine_item_preview_rect(rect);
        ui.rect(
            preview[0],
            preview[1],
            preview[2],
            preview[3],
            [4, 10, 10, 18],
        );
        let info_y = preview[1] + preview[3] + 10.0;
        ui.text(&item.item, x + 6.0, info_y, 1.8, TEXT);
        ui.text(
            &format!(
                "{} · QTY {} · VARIANT {}",
                item.kind().label(),
                item.quantity,
                item.variant_id
            ),
            x + 6.0,
            info_y + 23.0,
            1.15,
            DIM,
        );
        if let Some(potency) = item.potency {
            ui.text(
                &format!("POTENCY {potency}"),
                x + 6.0,
                info_y + 43.0,
                1.15,
                TEXT,
            );
        }
        if let Some(purity) = item.purity {
            ui.text(
                &format!("PURITY {purity}"),
                x + w * 0.5,
                info_y + 43.0,
                1.15,
                TEXT,
            );
        }
        return;
    }
    if let Some((_, label)) = &model.examine.prop {
        ui.text(label, x, y, 2.0, TEXT);
    } else {
        unavailable(ui, x, y, "NOTHING SELECTED");
    }
}

pub fn loot(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "LOOT");
    let Some(loot) = &model.loot else {
        unavailable(ui, x, y, "NO LOOT TARGET");
        return;
    };
    ui.text(&loot.label, x, y, 1.8, TEXT);
    y += 24.0;
    if !loot.in_reach || !loot.rights_mine {
        unavailable(
            ui,
            x,
            y,
            if !loot.in_reach {
                "OUT OF RANGE"
            } else {
                "NO LOOT RIGHTS"
            },
        );
        return;
    }
    for row in loot.rows.iter().take(7) {
        ui.text(
            &format!("{} ×{}", row.item, row.quantity),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if row.quantity > 0
            && ui.button(x + w - 70.0, y, 70.0, 24.0, "TAKE", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::TakeLootItem {
                container: loot.container.clone(),
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity.min(i32::MAX as i64) as i32,
            }));
        }
        y += 28.0;
    }
    if loot.credits_present && ui.button(x, y, w, 24.0, "TAKE CREDITS", ButtonStyle::default()) {
        out.push(WindowAction::Command(ClientCommand::CorpseTakeCredits {
            corpse_id: loot.target_id.clone(),
        }));
        y += 28.0;
    }
    if let Some(target_actor_id) = &loot.harvest_actor_id {
        if ui.button(x, y, w, 24.0, "HARVEST CORPSE", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::HarvestCorpse {
                target_actor_id: target_actor_id.clone(),
            }));
        }
    }
    if !loot.rows.is_empty() && ui.button(x, y, w, 24.0, "LOOT ALL", ButtonStyle::default()) {
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
}

pub fn macros_live(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "MACROS");
    for item in model.macros.iter().take(8) {
        ui.text(&item.name.to_uppercase(), x, y + 5.0, 1.5, TEXT);
        if ui.button(x + w - 136.0, y, 64.0, 22.0, "RUN", ButtonStyle::default()) {
            out.push(WindowAction::RunMacro(item.name.clone()));
        }
        if ui.button(
            x + w - 68.0,
            y,
            68.0,
            22.0,
            "DELETE",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::DeleteMacro(item.name.clone()));
        }
        y += 26.0;
    }
    ui.text("NAME", x, y, 1.3, DIM);
    y += 14.0;
    MACRO_NAME.with(|field| {
        ui.text_field(&mut field.borrow_mut(), x, y, w, 24.0, 1.5, true);
    });
    y += 30.0;
    ui.text(
        "BODY · ATTACK / RELOAD / KNEEL / STAND / PEACE / CLONE / WAIT N / CALL NAME",
        x,
        y,
        1.2,
        DIM,
    );
    y += 14.0;
    let body_h = (rect[1] + h - y - 30.0).max(44.0);
    MACRO_BODY.with(|field| {
        ui.text_field(&mut field.borrow_mut(), x, y, w, body_h, 1.4, true);
    });
    let name = MACRO_NAME.with(|field| field.borrow().text.clone());
    let body = MACRO_BODY.with(|field| field.borrow().text.clone());
    if !name.trim().is_empty()
        && !body.trim().is_empty()
        && ui.button(
            x,
            rect[1] + h - 24.0,
            w,
            22.0,
            "SAVE MACRO",
            ButtonStyle::default(),
        )
    {
        out.push(WindowAction::SaveMacro { name, body });
    }
}

pub fn datapad(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "DATAPAD");
    let selected = DATAPAD_TAB.with(|tab| *tab.borrow());
    let tabs = ["MAP", "SCHEMATICS", "DATA"];
    let tab_w = (w - 8.0) / 3.0;
    for (index, label) in tabs.into_iter().enumerate() {
        if ui.button(
            x + index as f32 * (tab_w + 4.0),
            y,
            tab_w,
            24.0,
            label,
            ButtonStyle::default(),
        ) {
            DATAPAD_TAB.with(|tab| *tab.borrow_mut() = index);
        }
    }
    y += 32.0;
    match selected {
        0 => {
            ui.text(
                &format!(
                    "{} · {},{}",
                    model.character.area_id, model.farm.player_cell.0, model.farm.player_cell.1
                ),
                x,
                y,
                1.6,
                TEXT,
            );
            if ui.button(
                x + w - 104.0,
                y - 5.0,
                104.0,
                24.0,
                "MARK HERE",
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::CreateWaypoint {
                    x: model.farm.player_cell.0 as f32,
                    y: model.farm.player_cell.1 as f32,
                    name: None,
                });
            }
            y += 30.0;
            for waypoint in model
                .waypoints
                .iter()
                .filter(|waypoint| waypoint.area_id == model.character.area_id)
                .take(8)
            {
                ui.text(
                    &format!("{} · {:.1},{:.1}", waypoint.name, waypoint.x, waypoint.y),
                    x,
                    y + 5.0,
                    1.5,
                    if waypoint.active { TEXT } else { DIM },
                );
                if ui.button(
                    x + w - 136.0,
                    y,
                    64.0,
                    22.0,
                    if waypoint.active { "HIDE" } else { "SHOW" },
                    ButtonStyle::default(),
                ) {
                    out.push(WindowAction::SetWaypointActive {
                        id: waypoint.id,
                        active: !waypoint.active,
                    });
                }
                if ui.button(
                    x + w - 68.0,
                    y,
                    68.0,
                    22.0,
                    "DELETE",
                    ButtonStyle::default(),
                ) {
                    out.push(WindowAction::DeleteWaypoint(waypoint.id));
                }
                y += 27.0;
            }
        }
        1 => {
            if model.craft.drafts.is_empty() {
                unavailable(ui, x, y, "NO DRAFTED SCHEMATICS");
            }
            for draft in model.craft.drafts.iter().take(10) {
                ui.text(
                    &format!(
                        "{} · RECIPE {} · OUTPUT {}",
                        draft.id, draft.recipe_id, draft.output_item_id
                    ),
                    x,
                    y,
                    1.5,
                    TEXT,
                );
                y += 24.0;
                if y > rect[1] + h - 20.0 {
                    break;
                }
            }
        }
        _ => {
            exchange(ui, [x, y, w, rect[1] + h - y], model, out);
        }
    }
}

pub fn guild(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "PLAYER ASSOCIATION");
    for invite in &model.pa.view.pending_invites {
        ui.text(
            &format!("INVITE · [{}] {}", invite.guild_tag, invite.guild_name),
            x,
            y,
            1.6,
            TEXT,
        );
        if ui.button(
            x + w - 136.0,
            y - 5.0,
            64.0,
            22.0,
            "ACCEPT",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::GuildAcceptInvite {
                invite_id: invite.invite_id.clone(),
            }));
        }
        if ui.button(
            x + w - 68.0,
            y - 5.0,
            68.0,
            22.0,
            "DECLINE",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::GuildDeclineInvite {
                invite_id: invite.invite_id.clone(),
            }));
        }
        y += 28.0;
    }
    let Some(guild) = &model.pa.view.guild else {
        if !model.pa.gate.available {
            unavailable(ui, x, y, &model.pa.gate.note);
            return;
        }
        ui.text(
            &format!(
                "CHARTER FEE {} CR",
                crate::windows::model::GUILD_CHARTER_FEE_CREDITS
            ),
            x,
            y,
            1.5,
            if model.pa.wallet_credits >= crate::windows::model::GUILD_CHARTER_FEE_CREDITS {
                TEXT
            } else {
                DIM
            },
        );
        y += 22.0;
        GUILD_NAME.with(|field| {
            ui.text_field(&mut field.borrow_mut(), x, y, w - 72.0, 24.0, 1.5, true);
        });
        GUILD_TAG.with(|field| {
            ui.text_field(
                &mut field.borrow_mut(),
                x + w - 68.0,
                y,
                68.0,
                24.0,
                1.5,
                true,
            );
        });
        y += 30.0;
        let name = GUILD_NAME.with(|field| field.borrow().text.trim().to_string());
        let tag = GUILD_TAG.with(|field| field.borrow().text.trim().to_string());
        if !name.is_empty()
            && !tag.is_empty()
            && model.pa.wallet_credits >= crate::windows::model::GUILD_CHARTER_FEE_CREDITS
            && ui.button(x, y, w, 24.0, "CREATE ASSOCIATION", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::GuildCreate {
                name,
                tag,
                terminal_prop_id: model.pa.gate.prop_id.clone().unwrap_or_default(),
            }));
        }
        return;
    };
    ui.text(
        &format!(
            "[{}] {} · {} MEMBERS",
            guild.tag, guild.name, guild.member_count
        ),
        x,
        y,
        1.8,
        TEXT,
    );
    y += 25.0;
    if model.pa.has_permission("invite") {
        if let Some((actor_id, label)) = &model.pa.target {
            if ui.button(
                x,
                y,
                w,
                23.0,
                &format!("INVITE {label}"),
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(ClientCommand::GuildInvite {
                    target_actor_id: actor_id.clone(),
                }));
            }
            y += 28.0;
        }
    }
    for member in model.pa.view.roster.iter().take(6) {
        ui.text(
            &format!(
                "{} · {}{}",
                member.name,
                member.role.to_ascii_uppercase(),
                if member.online { "" } else { " · OFFLINE" }
            ),
            x,
            y + 5.0,
            1.4,
            TEXT,
        );
        if member.actor_id != model.pa.my_actor_id {
            let mut bx = x + w - 142.0;
            if model.pa.has_permission("roles") {
                let next = if member.role == "officer" {
                    "member"
                } else {
                    "officer"
                };
                if ui.button(bx, y, 68.0, 22.0, next, ButtonStyle::default()) {
                    out.push(WindowAction::Command(ClientCommand::GuildSetRole {
                        target_actor_id: member.actor_id.clone(),
                        role: next.into(),
                    }));
                }
                bx += 72.0;
            }
            if model.pa.has_permission("kick")
                && ui.button(bx, y, 68.0, 22.0, "KICK", ButtonStyle::default())
            {
                out.push(WindowAction::Command(ClientCommand::GuildKick {
                    target_actor_id: member.actor_id.clone(),
                }));
            }
            if model.pa.is_leader()
                && ui.button(x, y + 22.0, 90.0, 20.0, "TRANSFER", ButtonStyle::default())
            {
                out.push(WindowAction::Command(
                    ClientCommand::GuildTransferLeadership {
                        target_actor_id: member.actor_id.clone(),
                    },
                ));
            }
            if model.pa.has_permission("roles")
                && ui.button(
                    x + 94.0,
                    y + 22.0,
                    94.0,
                    20.0,
                    "ALL PERMS",
                    ButtonStyle::default(),
                )
            {
                out.push(WindowAction::Command(ClientCommand::GuildSetPermissions {
                    target_actor_id: member.actor_id.clone(),
                    permissions: u8::MAX,
                }));
            }
        }
        y += 46.0;
        if y > rect[1] + h - 90.0 {
            break;
        }
    }
    if model.pa.has_permission("war") {
        for candidate in model
            .pa
            .view
            .directory
            .iter()
            .filter(|entry| entry.id != guild.id)
            .take(2)
        {
            if ui.button(
                x,
                y,
                w,
                22.0,
                &format!("DECLARE WAR · [{}] {}", candidate.tag, candidate.name),
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(ClientCommand::GuildDeclareWar {
                    opposing_guild_id: candidate.id.clone(),
                }));
            }
            y += 26.0;
        }
        for war in &guild.wars {
            let command = if war.state == "incoming" {
                ClientCommand::GuildAcceptWar {
                    opposing_guild_id: war.opposing_guild_id.clone(),
                }
            } else {
                ClientCommand::GuildRescindWar {
                    opposing_guild_id: war.opposing_guild_id.clone(),
                }
            };
            if ui.button(
                x,
                y,
                w,
                22.0,
                &format!(
                    "{} WAR · [{}] {}",
                    if war.state == "incoming" {
                        "ACCEPT"
                    } else {
                        "RESCIND"
                    },
                    war.opposing_tag,
                    war.opposing_name
                ),
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(command));
            }
            y += 26.0;
        }
    }
    let command = if model.pa.is_leader() {
        ClientCommand::GuildDisband {}
    } else {
        ClientCommand::GuildLeave {}
    };
    if ui.button(
        x,
        rect[1] + h - 24.0,
        w,
        22.0,
        if model.pa.is_leader() {
            "DISBAND ASSOCIATION"
        } else {
            "LEAVE ASSOCIATION"
        },
        ButtonStyle::default(),
    ) {
        out.push(WindowAction::Command(command));
    }
}

pub fn agriculture(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "LAND / AGRICULTURE / BUILD");
    if model.farm.parcels.is_empty() {
        ui.text(
            &format!(
                "UNCLAIMED · {},{}",
                model.farm.player_cell.0, model.farm.player_cell.1
            ),
            x,
            y,
            1.5,
            TEXT,
        );
        if ui.button(
            x + w - 92.0,
            y - 5.0,
            92.0,
            24.0,
            "CLAIM",
            ButtonStyle::default(),
        ) {
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
    for parcel in model
        .farm
        .parcels
        .iter()
        .filter(|parcel| parcel.is_owner)
        .take(2)
    {
        ui.text(
            &format!("{} · {}", parcel.name, parcel.tier.to_ascii_uppercase()),
            x,
            y,
            1.7,
            TEXT,
        );
        y += 24.0;
        let bw = (w - 12.0) / 3.0;
        if ui.button(x, y, bw, 22.0, "UPKEEP", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::PayUpkeep {
                parcel_id: parcel.parcel_id.clone(),
            }));
        }
        if ui.button(x + bw + 6.0, y, bw, 22.0, "RENAME", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::RenameParcel {
                parcel_id: parcel.parcel_id.clone(),
                name: format!("{} Homestead", parcel.name),
            }));
        }
        if ui.button(
            x + (bw + 6.0) * 2.0,
            y,
            bw,
            22.0,
            "ABANDON",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::AbandonParcel {
                parcel_id: parcel.parcel_id.clone(),
            }));
        }
        y += 28.0;
        if let Some(plot) = model.farm.plot_for(&parcel.parcel_id) {
            for tile in plot.tiles.iter().take(5) {
                let legal = |verb: &str| {
                    tile.legal_verbs
                        .iter()
                        .any(|v| v.eq_ignore_ascii_case(verb))
                };
                ui.text(
                    &format!(
                        "{},{} · {} · {:.0}% WATER",
                        tile.cell_x,
                        tile.cell_y,
                        tile.crop
                            .as_ref()
                            .map(|c| c.species.as_str())
                            .unwrap_or(if tile.tilled { "TILLED" } else { "UNTILLED" }),
                        tile.moisture_pct
                    ),
                    x,
                    y + 5.0,
                    1.3,
                    TEXT,
                );
                let mut bx = x + w - 140.0;
                for (label, command) in [
                    (
                        "TILL",
                        legal("TillTile").then(|| ClientCommand::TillTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }),
                    ),
                    (
                        "WATER",
                        legal("WaterTile").then(|| ClientCommand::WaterTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }),
                    ),
                    (
                        "CLEAR",
                        legal("ClearTile").then(|| ClientCommand::ClearTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }),
                    ),
                    (
                        "HARVEST",
                        legal("HarvestCrop").then(|| ClientCommand::HarvestCrop {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }),
                    ),
                ] {
                    if let Some(command) = command {
                        if ui.button(
                            bx,
                            y,
                            33.0,
                            22.0,
                            &label[..label.len().min(4)],
                            ButtonStyle::default(),
                        ) {
                            out.push(WindowAction::Command(command));
                        }
                        bx += 35.0;
                    }
                }
                y += 25.0;
                if legal("PlantSeed") {
                    if let Some(seed) = model.farm.seeds.first() {
                        if ui.button(x, y, 64.0, 21.0, "PLANT", ButtonStyle::default()) {
                            out.push(WindowAction::Command(ClientCommand::PlantSeed {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: seed.container.clone(),
                                stack_id: seed.stack_id.clone(),
                                variant_id: seed.variant_id,
                            }));
                        }
                    }
                }
                if legal("Fertilize") {
                    if let Some(fertilizer) = model.farm.fertilizers.first() {
                        if ui.button(x + 68.0, y, 72.0, 21.0, "FERTILIZE", ButtonStyle::default()) {
                            out.push(WindowAction::Command(ClientCommand::Fertilize {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: fertilizer.container.clone(),
                                stack_id: fertilizer.stack_id.clone(),
                                variant_id: fertilizer.variant_id,
                            }));
                        }
                    }
                }
                y += 24.0;
                if y > rect[1] + h - 100.0 {
                    break;
                }
            }
        }
        if ui.button(x, y, w, 22.0, "TEND PLOT", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::TendPlot {
                parcel_id: parcel.parcel_id.clone(),
                stop: false,
            }));
        }
        if let Some(structure) = model.farm.structures.first() {
            if ui.button(
                x,
                y + 26.0,
                w,
                22.0,
                "PLACE FARM STRUCTURE",
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(ClientCommand::PlaceFarmStructure {
                    parcel_id: parcel.parcel_id.clone(),
                    structure_item_id: structure.item_id,
                    cell_x: model.farm.player_cell.0 as i32,
                    cell_y: model.farm.player_cell.1 as i32,
                }));
            }
            y += 26.0;
        }
        y += 28.0;
    }
    if let (Some(parcel), Some(ghost)) = (&model.build.parcel, &model.build.ghost) {
        for item in model.build.catalog.iter().take(4) {
            let enabled = ghost.valid && model.build.affordable(item);
            ui.text(
                &format!("{} · {:?}", item.label, item.costs),
                x,
                y + 5.0,
                1.4,
                if enabled { TEXT } else { DIM },
            );
            if enabled && ui.button(x + w - 64.0, y, 64.0, 22.0, "PLACE", ButtonStyle::default()) {
                out.push(WindowAction::Command(ClientCommand::BuildPlace {
                    catalog_id: item.catalog_id.clone(),
                    parcel_id: parcel.parcel_id.clone(),
                    cell_x: ghost.cell_x as i32,
                    cell_y: ghost.cell_y as i32,
                    rotation_quarters: ghost.rotation_quarters,
                    palette: None,
                }));
            }
            y += 25.0;
        }
    }
    for component in model.build.components.iter().take(3) {
        ui.text(&component.catalog_id, x, y + 5.0, 1.4, TEXT);
        if component.kind.contains("door")
            && ui.button(
                x + w - 136.0,
                y,
                64.0,
                22.0,
                "TOGGLE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::BuildToggleDoor {
                component_id: component.component_id.clone(),
            }));
        }
        if ui.button(
            x + w - 68.0,
            y,
            68.0,
            22.0,
            "REMOVE",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::BuildRemove {
                component_id: component.component_id.clone(),
            }));
        }
        y += 25.0;
    }
}

pub fn splice(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, _, w, h] = rect;
    let mut y = title(ui, rect, "BIOENGINEERING");
    if let Some((species, label, in_range)) = &model.splice.sample_target {
        ui.text(
            &format!("SPECIMEN · {label}"),
            x,
            y,
            1.6,
            if *in_range { TEXT } else { DIM },
        );
        if *in_range
            && ui.button(
                x + w - 92.0,
                y - 5.0,
                92.0,
                24.0,
                "GENE SAMPLE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::GeneSample {
                species: species.clone(),
            }));
        }
        y += 28.0;
    }
    for sample in model.splice.samples.iter().take(4) {
        ui.text(
            &format!("{} ×{}", sample.item, sample.available),
            x,
            y + 5.0,
            1.5,
            TEXT,
        );
        if ui.button(x + w - 64.0, y, 64.0, 23.0, "SCAN", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::ScanGenome {
                container: sample.container.clone(),
                stack_id: sample.stack_id.clone(),
                variant_id: sample.variant_id,
            }));
        }
        y += 27.0;
    }
    let Some(session) = &model.splice.session else {
        if let Some((species, _, _)) = &model.splice.sample_target {
            if ui.button(x, y, w, 25.0, "BEGIN SPLICE", ButtonStyle::default()) {
                out.push(WindowAction::Command(ClientCommand::SpliceBegin {
                    species: species.clone(),
                }));
            }
        } else {
            unavailable(ui, x, y, "SELECT A CREATURE OR ACQUIRE A SAMPLE");
        }
        return;
    };
    ui.text(
        &format!(
            "{} · {}",
            session.species_name,
            session.phase.to_ascii_uppercase()
        ),
        x,
        y,
        1.7,
        TEXT,
    );
    y += 25.0;
    for slot in &session.slots {
        if y + 24.0 > rect[1] + h {
            break;
        }
        ui.text(
            &format!(
                "{} {} · {}",
                slot.kind.to_ascii_uppercase(),
                slot.slot_index + 1,
                slot.label
            ),
            x,
            y + 5.0,
            1.4,
            if slot.filled { TEXT } else { DIM },
        );
        if slot.filled {
            if ui.button(x + w - 64.0, y, 64.0, 22.0, "CLEAR", ButtonStyle::default()) {
                out.push(WindowAction::Command(ClientCommand::SpliceClearSlot {
                    slot_index: slot.slot_index,
                }));
            }
        } else if let Some(sample) = model.splice.samples.first() {
            if ui.button(
                x + w - 64.0,
                y,
                64.0,
                22.0,
                "ASSIGN",
                ButtonStyle::default(),
            ) {
                out.push(WindowAction::Command(ClientCommand::SpliceAssignSlot {
                    slot_index: slot.slot_index,
                    container: sample.container.clone(),
                    stack_id: sample.stack_id.clone(),
                    variant_id: sample.variant_id,
                }));
            }
        }
        y += 26.0;
    }
    for line in session.lines.iter().take(5) {
        ui.text(
            &format!(
                "{} · {} / {} · {} PTS",
                line.label, line.value_milli, line.cap_milli, session.points_remaining
            ),
            x,
            y + 5.0,
            1.4,
            TEXT,
        );
        if session.phase == "slots" {
            for (index, (parent, allele, label)) in
                [(0, 0, "1A"), (0, 1, "1B"), (1, 0, "2A"), (1, 1, "2B")]
                    .into_iter()
                    .enumerate()
            {
                if ui.button(
                    x + w - 116.0 + index as f32 * 30.0,
                    y,
                    28.0,
                    22.0,
                    label,
                    ButtonStyle::default(),
                ) {
                    out.push(WindowAction::Command(ClientCommand::SpliceChooseAllele {
                        locus: line.locus,
                        from_parent: parent,
                        allele,
                    }));
                }
            }
        } else if line.can_raise
            && session.points_remaining > 0
            && ui.button(x + w - 54.0, y, 54.0, 22.0, "+1", ButtonStyle::default())
        {
            out.push(WindowAction::Command(
                ClientCommand::SpliceExperimentLocus {
                    locus: line.locus,
                    points: 1,
                },
            ));
        }
        y += 26.0;
    }
    if session.phase == "slots"
        && session.can_assemble
        && ui.button(x, y, w, 24.0, "ASSEMBLE", ButtonStyle::default())
    {
        out.push(WindowAction::Command(ClientCommand::SpliceAssemble {}));
    } else if session.phase == "assembled"
        && ui.button(x, y, w, 24.0, "MINT CULTIVAR", ButtonStyle::default())
    {
        out.push(WindowAction::Command(ClientCommand::SpliceMint {
            cultivar_name: None,
        }));
    }
    if ui.button(x, y + 30.0, w, 24.0, "CANCEL", ButtonStyle::default()) {
        out.push(WindowAction::Command(ClientCommand::SpliceCancel {}));
    }
}

pub fn group(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "GROUP / DUEL");
    if let Some(invite) = &model.group.group.pending_invite {
        ui.text(
            &format!("GROUP INVITE · {}", invite.inviter_name),
            x,
            y,
            1.7,
            TEXT,
        );
        y += 26.0;
        if ui.button(x, y, 96.0, 24.0, "ACCEPT", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::GroupAccept {}));
        }
        if ui.button(x + 102.0, y, 96.0, 24.0, "DECLINE", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::GroupDecline {}));
        }
        y += 32.0;
    }
    for member in &model.group.group.members {
        ui.text(
            &format!(
                "{}{} · HP {:.0}/{:.0}{}",
                if member.is_leader { "★ " } else { "" },
                member.name,
                member.vitals.health,
                member.max_vitals.health,
                if member.link_dead {
                    " · LINK DEAD"
                } else {
                    ""
                }
            ),
            x,
            y + 5.0,
            1.5,
            if member.life_state == "alive" {
                TEXT
            } else {
                DIM
            },
        );
        if model.group.is_leader()
            && member.actor_id != model.group.my_actor_id
            && ui.button(x + w - 64.0, y, 64.0, 22.0, "KICK", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::GroupKick {
                target_actor_id: member.actor_id.clone(),
            }));
        }
        y += 26.0;
    }
    if model.group.group.group.is_some() {
        let command = if model.group.is_leader() {
            ClientCommand::GroupDisband {}
        } else {
            ClientCommand::GroupLeave {}
        };
        if ui.button(
            x,
            y,
            w,
            24.0,
            if model.group.is_leader() {
                "DISBAND GROUP"
            } else {
                "LEAVE GROUP"
            },
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(command));
        }
        y += 32.0;
    } else if let Some((actor_id, label, true)) = &model.group.target {
        ui.text(&format!("SELECTED PLAYER · {label}"), x, y, 1.6, TEXT);
        y += 24.0;
        if ui.button(
            x,
            y,
            (w - 6.0) * 0.5,
            24.0,
            "GROUP INVITE",
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::GroupInvite {
                target_actor_id: actor_id.clone(),
            }));
        }
        if model.group.duel.active_duel.is_none()
            && ui.button(
                x + (w + 6.0) * 0.5,
                y,
                (w - 6.0) * 0.5,
                24.0,
                "DUEL",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::DuelChallenge {
                target_actor_id: actor_id.clone(),
            }));
        }
        y += 32.0;
    }
    if let Some(challenge) = &model.group.duel.incoming_challenge {
        ui.text(
            &format!("DUEL CHALLENGE · {}", challenge.other_name),
            x,
            y,
            1.6,
            TEXT,
        );
        y += 24.0;
        if ui.button(x, y, 96.0, 24.0, "ACCEPT", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::DuelAccept {}));
        }
        if ui.button(x + 102.0, y, 96.0, 24.0, "DECLINE", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::DuelDecline {}));
        }
        y += 32.0;
    }
    if let Some(duel) = &model.group.duel.active_duel {
        ui.text(
            &format!("DUEL ACTIVE · {}", duel.opponent_name),
            x,
            y,
            1.6,
            TEXT,
        );
        y += 24.0;
        if ui.button(x, y, w, 24.0, "YIELD", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::DuelYield {}));
        }
        y += 30.0;
    }
    if let Some((actor_id, label)) = &model.group.deathblow_target {
        if ui.button(
            x,
            y,
            w,
            24.0,
            &format!("DEATHBLOW {label}"),
            ButtonStyle::default(),
        ) {
            out.push(WindowAction::Command(ClientCommand::Deathblow {
                target_actor_id: actor_id.clone(),
            }));
        }
    }
}

pub fn trade(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, out: &mut Vec<WindowAction>) {
    let [x, _, w, _] = rect;
    let mut y = title(ui, rect, "PLAYER TRADE");
    let Some(session) = &model.trade.session else {
        if let Some((actor_id, label)) = &model.trade.propose_target {
            ui.text(&format!("TARGET {label}"), x, y, 1.8, TEXT);
            y += 26.0;
            if ui.button(x, y, w, 26.0, "PROPOSE TRADE", ButtonStyle::default()) {
                out.push(WindowAction::Command(ClientCommand::ProposeTrade {
                    partner_actor_id: actor_id.clone(),
                    offer: Vec::new(),
                    request: Vec::new(),
                }));
            }
        } else {
            unavailable(ui, x, y, "SELECT A PLAYER");
        }
        return;
    };
    ui.text(
        &format!(
            "{} · {}",
            model.trade.partner_label,
            session.stage.to_ascii_uppercase()
        ),
        x,
        y,
        1.8,
        TEXT,
    );
    y += 24.0;
    for row in model.trade.offerable.iter().take(5) {
        ui.text(
            &format!("{} ×{}", row.item, row.available),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if row.available > 0
            && ui.button(x + w - 70.0, y, 70.0, 24.0, "ADD", ButtonStyle::default())
        {
            out.push(WindowAction::Command(ClientCommand::AddTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: row.item_id,
                    variant_id: row.variant_id,
                    quantity: row.available as u32,
                },
            }));
        }
        y += 28.0;
    }
    for line in session.mine.items.iter().take(3) {
        ui.text(
            &format!("YOU: {} ×{}", line.name, line.quantity),
            x,
            y + 5.0,
            1.6,
            TEXT,
        );
        if !session.mine.locked
            && ui.button(
                x + w - 70.0,
                y,
                70.0,
                24.0,
                "REMOVE",
                ButtonStyle::default(),
            )
        {
            out.push(WindowAction::Command(ClientCommand::RemoveTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: line.item_id,
                    variant_id: line.variant_id,
                    quantity: line.quantity.max(0) as u32,
                },
            }));
        }
        y += 28.0;
    }
    for line in session.theirs.items.iter().take(3) {
        ui.text(
            &format!("THEM: {} ×{}", line.name, line.quantity),
            x,
            y,
            1.6,
            DIM,
        );
        y += 22.0;
    }
    ui.text(
        &format!(
            "CREDITS  YOU {} · THEM {}",
            session.mine.coin, session.theirs.coin
        ),
        x,
        y + 5.0,
        1.5,
        TEXT,
    );
    if !session.mine.locked {
        if ui.button(x + w - 142.0, y, 68.0, 24.0, "−100", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::SetTradeCoin {
                proposal_id: session.proposal_id,
                amount: session.mine.coin.saturating_sub(100).max(0) as u64,
            }));
        }
        if ui.button(x + w - 70.0, y, 70.0, 24.0, "+100", ButtonStyle::default()) {
            out.push(WindowAction::Command(ClientCommand::SetTradeCoin {
                proposal_id: session.proposal_id,
                amount: session.mine.coin.saturating_add(100) as u64,
            }));
        }
    }
    y += 30.0;
    let bw = (w - 12.0) / 3.0;
    if !session.mine.locked && ui.button(x, y, bw, 26.0, "ACCEPT", ButtonStyle::default()) {
        out.push(WindowAction::Command(ClientCommand::AcceptTrade {
            proposal_id: session.proposal_id,
        }));
    }
    if session.both_locked
        && !session.mine.confirmed
        && ui.button(x + bw + 6.0, y, bw, 26.0, "CONFIRM", ButtonStyle::default())
    {
        out.push(WindowAction::Command(ClientCommand::ConfirmTrade {
            proposal_id: session.proposal_id,
        }));
    }
    if ui.button(
        x + (bw + 6.0) * 2.0,
        y,
        bw,
        26.0,
        "DECLINE",
        ButtonStyle::default(),
    ) {
        out.push(WindowAction::Command(ClientCommand::DeclineTrade {
            proposal_id: session.proposal_id,
        }));
    }
}
