use crate::windows::live::shared::*;
use crate::windows::chrome::{self};
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

pub fn travel(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if !model.travel.gate.available {
        pane.denied(ui, &model.travel.gate.note);
        return;
    }
    let terminal_prop_id = model
        .travel
        .gate
        .prop_id
        .as_ref()
        .expect("open travel gate has a prop id");

    if let Some((origin_planet, origin_city)) = &model.travel.origin {
        pane.field_pair(
            ui,
            (
                "ORIGIN",
                &format!("{origin_planet} / {origin_city}").to_ascii_uppercase(),
            ),
            ("WALLET", &format!("{} CR", model.travel.wallet_credits)),
        );
    } else {
        pane.field(ui, "WALLET", &format!("{} CR", model.travel.wallet_credits));
    }

    let mut rows = pane.rows();
    let mut any = false;
    if ctx.tab == 0 {
        for planet in &model.travel.planets {
            for city in &planet.cities {
                any = true;
                let is_origin = model
                    .travel
                    .origin
                    .as_ref()
                    .is_some_and(|origin| origin.0 == planet.id && origin.1 == city.id);
                let Some(mut row) = rows.next(ui) else { break };
                if !is_origin && row.action(ui, "BUY TICKET") {
                    out.push(WindowAction::Command(ClientCommand::PurchaseTravelTicket {
                        terminal_prop_id: terminal_prop_id.clone(),
                        to_planet_id: planet.id.clone(),
                        to_city_id: city.id.clone(),
                    }));
                }
                if is_origin {
                    row.value(ui, "HERE");
                } else {
                    row.value(ui, &format!("{} CR", city.price));
                }
                row.value(ui, &planet.label);
                row.label_tinted(ui, &city.label, if is_origin { dim() } else { label() });
            }
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO DESTINATIONS");
        }
    } else {
        for ticket in &model.travel.tickets {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            let travel = ticket
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("travelTicket"));
            let ticket_id = travel
                .and_then(|value| value.get("ticketId"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            if row.action(ui, "USE") {
                out.push(WindowAction::Command(ClientCommand::UseTravelTicket {
                    container: Some(ticket.container.clone()),
                    stack_id: Some(ticket.stack_id.clone()),
                    ticket_id,
                    item_id: ticket.item_key.clone(),
                    item_numeric_id: Some(ticket.item_id),
                    variant_id: Some(ticket.variant_id),
                }));
            }
            row.label(
                ui,
                &ticket
                    .ticket_destination()
                    .unwrap_or_else(|| ticket.item.to_ascii_uppercase()),
            );
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO TICKETS HELD");
        }
    }
    pane.resume(&rows);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{Gate, InventoryRow, TravelCity, TravelPlanet};
    use crate::windows::spec;

    fn test_ctx(rect: [f32; 4], tab: usize) -> Ctx {
        Ctx {
            spec: spec::surface("travel").expect("travel spec"),
            rect,
            tab,
        }
    }

    #[test]
    fn test_travel_gate_closed() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0], 0);
        let mut model = WindowModel::default();
        model.travel.gate = Gate::closed("TERMINAL OUT OF RANGE");
        let mut out = Vec::new();
        travel(&mut ui, ctx, &model, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn test_travel_buy_ticket_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0], 0);
        let mut model = WindowModel::default();
        model.travel.gate = Gate::open("travel_term_1");
        model.travel.origin = Some(("tatooine".into(), "anchorhead".into()));
        model.travel.planets = vec![TravelPlanet {
            id: "corellia".into(),
            label: "Corellia".into(),
            cities: vec![TravelCity {
                id: "coronet".into(),
                label: "Coronet".into(),
                terminal_prop_id: "term_coronet".into(),
                price: 150,
            }],
        }];

        // Action button is placed on the row.
        let row_y = ctx.rect[1] + 24.0;
        let action_x = ctx.rect[0] + ctx.rect[2] - 30.0;

        // Frame 1: Press
        ui.set_input(action_x, row_y, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        travel(&mut ui, ctx, &model, &mut out);

        // Frame 2: Release
        ui.set_input(action_x, row_y, false);
        ui.begin(1280, 720);
        out.clear();
        travel(&mut ui, ctx, &model, &mut out);

        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::PurchaseTravelTicket { to_planet_id, to_city_id, .. })
                if to_planet_id == "corellia" && to_city_id == "coronet"
        ));
    }

    #[test]
    fn test_travel_use_ticket_dispatch() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let ctx = test_ctx([0.0, 0.0, 400.0, 300.0], 1); // tab 1: tickets
        let mut model = WindowModel::default();
        model.travel.gate = Gate::open("travel_term_1");
        model.travel.tickets = vec![InventoryRow {
            container: "player:pack".into(),
            stack_id: "ticket_1".into(),
            item: "Corellia Ticket".into(),
            item_id: 9001,
            variant_id: 1,
            quantity: 1,
            metadata: Some(serde_json::json!({
                "travelTicket": {
                    "ticketId": "t_100",
                    "toPlanetId": "corellia",
                    "toCityId": "coronet"
                }
            })),
            ..Default::default()
        }];
        let row_y = ctx.rect[1] + 24.0;
        let action_x = ctx.rect[0] + ctx.rect[2] - 30.0;

        // Frame 1: Press
        ui.set_input(action_x, row_y, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        travel(&mut ui, ctx, &model, &mut out);

        // Frame 2: Release
        ui.set_input(action_x, row_y, false);
        ui.begin(1280, 720);
        out.clear();
        travel(&mut ui, ctx, &model, &mut out);

        assert_eq!(out.len(), 1);
        assert!(matches!(
            &out[0],
            WindowAction::Command(ClientCommand::UseTravelTicket { ticket_id, .. })
                if ticket_id.as_deref() == Some("t_100")
        ));
    }
}
