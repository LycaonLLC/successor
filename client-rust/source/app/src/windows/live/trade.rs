use crate::windows::chrome::{self};
use crate::windows::live::shared::*;
use crate::windows::{dim, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::{ClientCommand, TradeItemSpec};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TradeSideKind {
    Mine,
    Theirs,
}

#[derive(Clone, Debug)]
pub enum TradeEvent {
    AddItem { side: TradeSideKind, line: crate::windows::model::TradeItemLine },
    RemoveItem { side: TradeSideKind, item_id: u32, variant_id: u32 },
    SetCoin { side: TradeSideKind, amount: i64 },
    Accept { side: TradeSideKind },
    Confirm { side: TradeSideKind },
    Decline { side: TradeSideKind, reason: Option<String> },
}

/// Pure state machine reducer for secure trade double-lock session protocol.
/// Mirrors `client-3d/src/ui/trade/machine.ts` exactly.
pub fn reduce_trade_session(
    session: &crate::windows::model::TradeSession,
    event: &TradeEvent,
) -> crate::windows::model::TradeSession {
    if session.stage == "executed" || session.stage == "declined" {
        return session.clone();
    }

    fn invalidate_locks(
        mut s: crate::windows::model::TradeSession,
        side: TradeSideKind,
        items: Option<Vec<crate::windows::model::TradeItemLine>>,
        coin: Option<i64>,
    ) -> crate::windows::model::TradeSession {
        match side {
            TradeSideKind::Mine => {
                if let Some(i) = items {
                    s.mine.items = i;
                }
                if let Some(c) = coin {
                    s.mine.coin = c;
                }
            }
            TradeSideKind::Theirs => {
                if let Some(i) = items {
                    s.theirs.items = i;
                }
                if let Some(c) = coin {
                    s.theirs.coin = c;
                }
            }
        }
        s.mine.locked = false;
        s.mine.confirmed = false;
        s.theirs.locked = false;
        s.theirs.confirmed = false;
        s.both_locked = false;
        s.stage = "negotiating".to_string();
        s
    }

    match event {
        TradeEvent::AddItem { side, line } => {
            if line.quantity <= 0 {
                return session.clone();
            }
            let side_struct = match side {
                TradeSideKind::Mine => &session.mine,
                TradeSideKind::Theirs => &session.theirs,
            };
            let existing = side_struct
                .items
                .iter()
                .find(|i| i.item_id == line.item_id && i.variant_id == line.variant_id);
            if let Some(ex) = existing {
                if ex.quantity == line.quantity && ex.name == line.name {
                    return session.clone();
                }
            }
            let mut new_items = side_struct.items.clone();
            if let Some(pos) = new_items
                .iter()
                .position(|i| i.item_id == line.item_id && i.variant_id == line.variant_id)
            {
                new_items[pos] = line.clone();
            } else {
                new_items.push(line.clone());
            }
            invalidate_locks(session.clone(), *side, Some(new_items), None)
        }
        TradeEvent::RemoveItem {
            side,
            item_id,
            variant_id,
        } => {
            let side_struct = match side {
                TradeSideKind::Mine => &session.mine,
                TradeSideKind::Theirs => &session.theirs,
            };
            if !side_struct
                .items
                .iter()
                .any(|i| i.item_id == *item_id && i.variant_id == *variant_id)
            {
                return session.clone();
            }
            let new_items: Vec<_> = side_struct
                .items
                .iter()
                .filter(|i| !(i.item_id == *item_id && i.variant_id == *variant_id))
                .cloned()
                .collect();
            invalidate_locks(session.clone(), *side, Some(new_items), None)
        }
        TradeEvent::SetCoin { side, amount } => {
            if *amount < 0 {
                return session.clone();
            }
            let side_struct = match side {
                TradeSideKind::Mine => &session.mine,
                TradeSideKind::Theirs => &session.theirs,
            };
            if side_struct.coin == *amount {
                return session.clone();
            }
            invalidate_locks(session.clone(), *side, None, Some(*amount))
        }
        TradeEvent::Accept { side } => {
            let side_struct = match side {
                TradeSideKind::Mine => &session.mine,
                TradeSideKind::Theirs => &session.theirs,
            };
            if side_struct.locked {
                return session.clone();
            }
            let mut next = session.clone();
            match side {
                TradeSideKind::Mine => next.mine.locked = true,
                TradeSideKind::Theirs => next.theirs.locked = true,
            }
            let both = next.mine.locked && next.theirs.locked;
            next.both_locked = both;
            next.stage = if both {
                "confirm".to_string()
            } else {
                "negotiating".to_string()
            };
            next
        }
        TradeEvent::Confirm { side } => {
            if !session.both_locked {
                return session.clone();
            }
            let side_struct = match side {
                TradeSideKind::Mine => &session.mine,
                TradeSideKind::Theirs => &session.theirs,
            };
            if side_struct.confirmed {
                return session.clone();
            }
            let mut next = session.clone();
            match side {
                TradeSideKind::Mine => next.mine.confirmed = true,
                TradeSideKind::Theirs => next.theirs.confirmed = true,
            }
            if next.mine.confirmed && next.theirs.confirmed {
                next.stage = "executed".to_string();
            } else {
                next.stage = "confirm".to_string();
            }
            next
        }
        TradeEvent::Decline { side: _, reason } => {
            let mut next = session.clone();
            next.stage = "declined".to_string();
            next.close_reason = Some(reason.clone().unwrap_or_else(|| "declined".to_string()));
            next
        }
    }
}

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

    fn assert_session_eq(a: &TradeSession, b: &TradeSession) {
        assert_eq!(a.proposal_id, b.proposal_id);
        assert_eq!(a.partner_actor_id, b.partner_actor_id);
        assert_eq!(a.both_locked, b.both_locked);
        assert_eq!(a.stage, b.stage);
        assert_eq!(a.close_reason, b.close_reason);
        assert_eq!(a.mine.actor_id, b.mine.actor_id);
        assert_eq!(a.mine.coin, b.mine.coin);
        assert_eq!(a.mine.locked, b.mine.locked);
        assert_eq!(a.mine.confirmed, b.mine.confirmed);
        assert_eq!(a.mine.items.len(), b.mine.items.len());
        for (i, j) in a.mine.items.iter().zip(b.mine.items.iter()) {
            assert_eq!(i.item_id, j.item_id);
            assert_eq!(i.variant_id, j.variant_id);
            assert_eq!(i.name, j.name);
            assert_eq!(i.quantity, j.quantity);
        }
        assert_eq!(a.theirs.actor_id, b.theirs.actor_id);
        assert_eq!(a.theirs.coin, b.theirs.coin);
        assert_eq!(a.theirs.locked, b.theirs.locked);
        assert_eq!(a.theirs.confirmed, b.theirs.confirmed);
        assert_eq!(a.theirs.items.len(), b.theirs.items.len());
        for (i, j) in a.theirs.items.iter().zip(b.theirs.items.iter()) {
            assert_eq!(i.item_id, j.item_id);
            assert_eq!(i.variant_id, j.variant_id);
            assert_eq!(i.name, j.name);
            assert_eq!(i.quantity, j.quantity);
        }
    }

    #[test]
    fn test_trade_machine_offer_staging() {
        let open = fixture_open_session();
        let line = TradeItemLine {
            item_id: 101,
            variant_id: 1,
            name: "VIBROBLADE".to_string(),
            quantity: 2,
        };
        let added = reduce_trade_session(&open, &TradeEvent::AddItem {
            side: TradeSideKind::Mine,
            line: line.clone(),
        });
        assert_eq!(added.mine.items.len(), 1);
        assert_eq!(added.mine.items[0].name, "VIBROBLADE");

        // Identical re-add is no-op
        let readded = reduce_trade_session(&added, &TradeEvent::AddItem {
            side: TradeSideKind::Mine,
            line: line.clone(),
        });
        assert_session_eq(&readded, &added);
        // Remove line
        let removed = reduce_trade_session(&added, &TradeEvent::RemoveItem {
            side: TradeSideKind::Mine,
            item_id: 101,
            variant_id: 1,
        });
        assert!(removed.mine.items.is_empty());
    }

    #[test]
    fn test_trade_machine_anti_abuse_clears_seals() {
        let mut s = fixture_open_session();
        s.mine.locked = true;
        s.theirs.locked = true;
        s.both_locked = true;
        s.stage = "confirm".to_string();

        // Mutation by either side clears both seals and drops back to negotiating
        let mutated = reduce_trade_session(&s, &TradeEvent::SetCoin {
            side: TradeSideKind::Theirs,
            amount: 500,
        });
        assert!(!mutated.mine.locked);
        assert!(!mutated.theirs.locked);
        assert!(!mutated.both_locked);
        assert_eq!(mutated.stage, "negotiating");
    }

    #[test]
    fn test_trade_machine_dual_lock_and_confirm() {
        let open = fixture_open_session();
        let one_lock = reduce_trade_session(&open, &TradeEvent::Accept { side: TradeSideKind::Mine });
        assert!(one_lock.mine.locked);
        assert!(!one_lock.both_locked);
        assert_eq!(one_lock.stage, "negotiating");

        // Confirm before both locked is refused
        let invalid_confirm = reduce_trade_session(&one_lock, &TradeEvent::Confirm { side: TradeSideKind::Mine });
        assert_session_eq(&invalid_confirm, &one_lock);
        // Second seal opens confirm stage
        let both_lock = reduce_trade_session(&one_lock, &TradeEvent::Accept { side: TradeSideKind::Theirs });
        assert!(both_lock.both_locked);
        assert_eq!(both_lock.stage, "confirm");

        // Confirm by both executes
        let c1 = reduce_trade_session(&both_lock, &TradeEvent::Confirm { side: TradeSideKind::Mine });
        assert_eq!(c1.stage, "confirm");
        let c2 = reduce_trade_session(&c1, &TradeEvent::Confirm { side: TradeSideKind::Theirs });
        assert_eq!(c2.stage, "executed");
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
