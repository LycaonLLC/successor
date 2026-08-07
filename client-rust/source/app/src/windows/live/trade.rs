//! The session is server-authoritative: `TradeSession` arrives over the wire
//! and this file never advances a stage on its own. What the pane owes the
//! player is that a sealed offer cannot be mutated from here - every control
//! that would change the offer disappears the moment `mine.locked` is set, so a
//! stale frame cannot emit a mutation the server has already sealed against.

use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{dim, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::{ClientCommand, TradeItemSpec};

pub fn trade(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let Some(session) = &model.trade.session else {
        if let Some((actor_id, label)) = &model.trade.propose_target {
            pane.field(ui, "TARGET", label);
            if pane.rail(ui, &["PROPOSE TRADE"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::ProposeTrade {
                    partner_actor_id: actor_id.clone(),
                    offer: Vec::new(),
                    request: Vec::new(),
                }));
            }
        } else {
            pane.empty(ui, "SELECT A PLAYER");
        }
        return;
    };
    const ACCEPT: u8 = 0;
    const CONFIRM: u8 = 1;
    const DECLINE: u8 = 2;
    let mut labels: [&str; 3] = [""; 3];
    let mut kinds: [u8; 3] = [0; 3];
    let mut count = 0usize;
    if !session.mine.locked {
        labels[count] = "SEAL OFFER";
        kinds[count] = ACCEPT;
        count += 1;
    }
    if session.both_locked && !session.mine.confirmed {
        labels[count] = "CONFIRM SWAP";
        kinds[count] = CONFIRM;
        count += 1;
    }
    labels[count] = "DECLINE";
    kinds[count] = DECLINE;
    count += 1;
    let commit = pane.reserve_footer();

    pane.field_pair(
        ui,
        ("PARTNER", &model.trade.partner_label),
        ("STAGE", &session.stage.to_ascii_uppercase()),
    );
    pane.field_pair(
        ui,
        (
            "YOUR SEAL",
            if session.mine.locked {
                "SEALED"
            } else {
                "UNSEALED"
            },
        ),
        (
            "THEIR SEAL",
            if session.theirs.locked {
                "SEALED"
            } else {
                "UNSEALED"
            },
        ),
    );

    pane.section(ui, "YOU OFFER");
    let mut rows = pane.rows();
    let mut any = false;
    for line in &session.mine.items {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if !session.mine.locked && list.quiet_action(ui, "REMOVE") {
            out.push(WindowAction::Command(ClientCommand::RemoveTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: line.item_id,
                    variant_id: line.variant_id,
                    quantity: line.quantity.max(0) as u32,
                },
            }));
        }
        list.value(ui, &qty(line.quantity));
        list.label(ui, &line.name);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING OFFERED");
    }
    pane.resume(&rows);

    pane.section(ui, "THEY OFFER");
    let mut rows = pane.rows();
    let mut any = false;
    for line in &session.theirs.items {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        list.value(ui, &qty(line.quantity));
        list.label_tinted(ui, &line.name, dim());
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING OFFERED");
    }
    pane.resume(&rows);

    pane.field_pair(
        ui,
        ("YOUR CREDITS", &format!("{} CR", session.mine.coin)),
        ("THEIR CREDITS", &format!("{} CR", session.theirs.coin)),
    );
    if !session.mine.locked {
        if let Some(index) = pane.rail(ui, &["+100 CR", "+1,000 CR", "CLEAR CR"]) {
            let amount = match index {
                0 => session.mine.coin.saturating_add(100) as u64,
                1 => session.mine.coin.saturating_add(1000) as u64,
                _ => 0,
            };
            out.push(WindowAction::Command(ClientCommand::SetTradeCoin {
                proposal_id: session.proposal_id,
                amount,
            }));
        }
    }

    pane.section(ui, "YOUR INVENTORY");
    let mut rows = pane.rows();
    let mut any = false;
    for row in &model.trade.offerable {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.available > 0 && !session.mine.locked && list.action(ui, "ADD") {
            out.push(WindowAction::Command(ClientCommand::AddTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: row.item_id,
                    variant_id: row.variant_id,
                    quantity: 1,
                },
            }));
        }
        list.value(ui, &qty(row.available));
        list.label(ui, &row.item);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING TO OFFER");
    }
    pane.resume(&rows);

    if let Some(index) = pane.footer(ui, commit, &labels[..count]) {
        let command = match kinds[index] {
            ACCEPT => ClientCommand::AcceptTrade {
                proposal_id: session.proposal_id,
            },
            CONFIRM => ClientCommand::ConfirmTrade {
                proposal_id: session.proposal_id,
            },
            _ => ClientCommand::DeclineTrade {
                proposal_id: session.proposal_id,
            },
        };
        out.push(WindowAction::Command(command));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{TradeItemLine, TradeSession, TradeSide};

    fn test_ctx(rect: [f32; 4]) -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface("trade").expect("trade surface"),
            rect,
            tab: 0,
        }
    }

    const RECT: [f32; 4] = [100.0, 100.0, 400.0, 600.0];

    fn fixture_open_session() -> TradeSession {
        TradeSession {
            proposal_id: 42,
            partner_actor_id: "partner_1".to_string(),
            mine: TradeSide {
                actor_id: "me".to_string(),
                items: vec![],
                coin: 0,
                locked: false,
                confirmed: false,
            },
            theirs: TradeSide {
                actor_id: "partner_1".to_string(),
                items: vec![],
                coin: 0,
                locked: false,
                confirmed: false,
            },
            both_locked: false,
            stage: "negotiating".to_string(),
            close_reason: None,
            tick: 100,
        }
    }

    /// Every command the pane will emit anywhere in its rect. Sweeping beats
    /// hand-computed hit points: row layout shifts with the theme's metrics, so
    /// a fixed coordinate silently stops covering the control it was aimed at
    /// and the test keeps passing.
    fn commands_under_sweep(model: &WindowModel) -> Vec<ClientCommand> {
        let icons = Icons::load();
        let mut found = Vec::new();
        let mut y = RECT[1] + 4.0;
        while y < RECT[1] + RECT[3] {
            let mut x = RECT[0] + 4.0;
            while x < RECT[0] + RECT[2] {
                let mut ui = UiBuilder::new(icons.meta);
                let mut out = Vec::new();
                ui.set_input(x, y, true);
                ui.begin(1280, 900);
                trade(&mut ui, test_ctx(RECT), model, &mut out);
                ui.set_input(x, y, false);
                ui.begin(1280, 900);
                out.clear();
                trade(&mut ui, test_ctx(RECT), model, &mut out);
                for action in out {
                    let WindowAction::Command(command) = action else {
                        continue;
                    };
                    if !found.contains(&command) {
                        found.push(command);
                    }
                }
                x += 12.0;
            }
            y += 6.0;
        }
        found
    }

    fn fixture_live_model(locked: bool) -> WindowModel {
        let mut model = WindowModel::default();
        let mut session = fixture_open_session();
        session.mine.locked = locked;
        session.mine.items = vec![TradeItemLine {
            item_id: 101,
            variant_id: 1,
            name: "VIBROBLADE".to_string(),
            quantity: 1,
        }];
        session.theirs.items = vec![TradeItemLine {
            item_id: 202,
            variant_id: 2,
            name: "SPICE".to_string(),
            quantity: 4,
        }];
        model.trade.offerable = vec![crate::windows::model::InventoryRow {
            item_id: 303,
            variant_id: 3,
            item: "MEDPAC".to_string(),
            available: 2,
            ..Default::default()
        }];
        model.trade.partner_label = "SOLO TRADER".to_string();
        model.trade.session = Some(session);
        model
    }

    #[test]
    fn an_open_offer_exposes_every_negotiation_control() {
        let found = commands_under_sweep(&fixture_live_model(false));

        assert!(
            found.iter().any(|c| matches!(c, ClientCommand::AddTradeItem { item, .. } if item.item_id == 303)),
            "inventory rows must offer ADD; got {found:?}"
        );
        assert!(
            found.iter().any(|c| matches!(c, ClientCommand::RemoveTradeItem { item, .. } if item.item_id == 101)),
            "own offer rows must offer REMOVE; got {found:?}"
        );
        assert!(
            found.iter().any(|c| matches!(c, ClientCommand::SetTradeCoin { .. })),
            "credit rail must be reachable; got {found:?}"
        );
        assert!(
            found.contains(&ClientCommand::AcceptTrade { proposal_id: 42 }),
            "commit rail must offer SEAL; got {found:?}"
        );
    }

    #[test]
    fn sealing_withdraws_every_control_that_would_change_the_offer() {
        let found = commands_under_sweep(&fixture_live_model(true));

        for command in &found {
            assert!(
                !matches!(
                    command,
                    ClientCommand::AddTradeItem { .. }
                        | ClientCommand::RemoveTradeItem { .. }
                        | ClientCommand::SetTradeCoin { .. }
                        | ClientCommand::AcceptTrade { .. }
                ),
                "a sealed offer must not be mutable from the pane; reached {command:?}"
            );
        }
        assert!(
            found.contains(&ClientCommand::DeclineTrade { proposal_id: 42 }),
            "declining must survive the seal; got {found:?}"
        );
    }

    #[test]
    fn a_dual_seal_opens_the_confirm_rail() {
        let mut model = fixture_live_model(true);
        let session = model.trade.session.as_mut().expect("session");
        session.theirs.locked = true;
        session.both_locked = true;
        session.stage = "confirm".to_string();

        let found = commands_under_sweep(&model);

        assert!(
            found.contains(&ClientCommand::ConfirmTrade { proposal_id: 42 }),
            "both seals set must expose CONFIRM SWAP; got {found:?}"
        );
    }

    #[test]
    fn a_live_session_paints_both_offer_columns() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut out = Vec::new();
        ui.begin(1280, 900);
        trade(&mut ui, test_ctx(RECT), &fixture_live_model(false), &mut out);

        assert!(ui.quads > 0, "a live trade session must paint its columns");
    }

    #[test]
    fn test_trade_ui_no_session_propose() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.trade.propose_target = Some(("partner_99".to_string(), "SOLO TRADER".to_string()));

        let ctx = test_ctx(RECT);
        let bx = RECT[0] + 10.0;
        let by = RECT[1] + 30.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        trade(&mut ui, ctx, &model, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        trade(&mut ui, ctx, &model, &mut out);

        assert!(out.contains(&WindowAction::Command(ClientCommand::ProposeTrade {
            partner_actor_id: "partner_99".to_string(),
            offer: vec![],
            request: vec![],
        })));
    }
}
