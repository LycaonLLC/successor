//! Secure player-trade state and invariants.

use super::*;

/// Which side of a trade session an actor sits on. `offer`/`*_coin`/`*_locked`
/// name the PROPOSER side; `request`/... name the PARTNER side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TradeSide {
    Proposer,
    Partner,
}

/// Why a trade session closed. `Declined` = a party cancelled; the others are
/// clean environmental aborts (walked out of range, died, link-dead logout).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum TradeCloseReason {
    Declined,
    Range,
    Death,
    Link,
}

impl TradeCloseReason {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Declined => 1,
            Self::Range => 2,
            Self::Death => 3,
            Self::Link => 4,
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Declined => "declined",
            Self::Range => "range",
            Self::Death => "death",
            Self::Link => "link",
        }
    }
}

/// Terminal marker on a trade session. A closed session is held for exactly one
/// tick (so both windows can render TRADE COMPLETE vs DECLINED) then reaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TradeClose {
    /// `true` = the atomic swap landed; `false` = closed without executing.
    pub(super) executed: bool,
    /// Present only for non-execute closes (declined/range/death/link).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<TradeCloseReason>,
    pub(super) at_tick: u64,
}

/// A pawn<->pawn secure trade SESSION (literal double-lock). The proposer
/// offers `offer` + `proposer_coin` wallet credits; the partner offers `request` +
/// `partner_coin`. Each side ACCEPT-locks independently; ANY offer mutation by
/// EITHER side clears BOTH locks (anti-abuse). When both are locked AND both
/// confirm, the swap re-validates and executes atomically. Nothing is reserved
/// or consumed until that final execute, so a stale/aborted session moves zero
/// items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct TradeProposal {
    pub(super) proposer: String,
    pub(super) partner: String,
    pub(super) offer: Vec<TradeItemSpec>,
    pub(super) request: Vec<TradeItemSpec>,
    #[serde(default)]
    pub(super) proposer_coin: u64,
    #[serde(default)]
    pub(super) partner_coin: u64,
    #[serde(default)]
    pub(super) proposer_locked: bool,
    #[serde(default)]
    pub(super) partner_locked: bool,
    #[serde(default)]
    pub(super) proposer_confirmed: bool,
    #[serde(default)]
    pub(super) partner_confirmed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) closed: Option<TradeClose>,
}

impl TradeProposal {
    pub(super) fn side_of(&self, actor_id: &str) -> Option<TradeSide> {
        if actor_id == self.proposer {
            Some(TradeSide::Proposer)
        } else if actor_id == self.partner {
            Some(TradeSide::Partner)
        } else {
            None
        }
    }

    pub(super) fn is_open(&self) -> bool {
        self.closed.is_none()
    }

    pub(super) fn both_locked(&self) -> bool {
        self.proposer_locked && self.partner_locked
    }

    /// The anti-abuse primitive: any offer change drops BOTH accept-locks and,
    /// with them, BOTH final confirms (a confirm is only reachable when locked).
    pub(super) fn clear_locks(&mut self) {
        self.proposer_locked = false;
        self.partner_locked = false;
        self.proposer_confirmed = false;
        self.partner_confirmed = false;
    }

    pub(super) fn side_items(&self, side: TradeSide) -> &[TradeItemSpec] {
        match side {
            TradeSide::Proposer => &self.offer,
            TradeSide::Partner => &self.request,
        }
    }

    pub(super) fn side_items_mut(&mut self, side: TradeSide) -> &mut Vec<TradeItemSpec> {
        match side {
            TradeSide::Proposer => &mut self.offer,
            TradeSide::Partner => &mut self.request,
        }
    }

    pub(super) fn side_coin(&self, side: TradeSide) -> u64 {
        match side {
            TradeSide::Proposer => self.proposer_coin,
            TradeSide::Partner => self.partner_coin,
        }
    }

    pub(super) fn set_side_coin(&mut self, side: TradeSide, amount: u64) {
        match side {
            TradeSide::Proposer => self.proposer_coin = amount,
            TradeSide::Partner => self.partner_coin = amount,
        }
    }

    pub(super) fn side_locked(&self, side: TradeSide) -> bool {
        match side {
            TradeSide::Proposer => self.proposer_locked,
            TradeSide::Partner => self.partner_locked,
        }
    }

    pub(super) fn set_side_locked(&mut self, side: TradeSide, value: bool) {
        match side {
            TradeSide::Proposer => self.proposer_locked = value,
            TradeSide::Partner => self.partner_locked = value,
        }
    }

    pub(super) fn side_confirmed(&self, side: TradeSide) -> bool {
        match side {
            TradeSide::Proposer => self.proposer_confirmed,
            TradeSide::Partner => self.partner_confirmed,
        }
    }

    pub(super) fn set_side_confirmed(&mut self, side: TradeSide, value: bool) {
        match side {
            TradeSide::Proposer => self.proposer_confirmed = value,
            TradeSide::Partner => self.partner_confirmed = value,
        }
    }

    pub(super) fn actor_of(&self, side: TradeSide) -> &str {
        match side {
            TradeSide::Proposer => &self.proposer,
            TradeSide::Partner => &self.partner,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityTradeItemLineSnapshot {
    pub item_id: u32,
    pub variant_id: u32,
    pub name: String,
    pub quantity: u32,
}

/// One side of a trade session VM (the observer's own side or the counterparty's).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityTradeSideSnapshot {
    pub actor_id: String,
    pub items: Vec<AuthorityTradeItemLineSnapshot>,
    /// Scalar wallet credits offered by this side.
    pub coin: u64,
    /// ACCEPT-lock latched.
    pub locked: bool,
    /// Final OK given (only reachable once both sides locked).
    pub confirmed: bool,
}

/// A trade session as one participant sees it. PERSPECTIVE-RELATIVE: `mine` is
/// always the observer's own side, `theirs` the counterparty's, so the window
/// never needs to know proposer vs partner. Streamed to BOTH participants only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityTradeSessionSnapshot {
    pub proposal_id: u32,
    pub partner_actor_id: String,
    pub mine: AuthorityTradeSideSnapshot,
    pub theirs: AuthorityTradeSideSnapshot,
    pub both_locked: bool,
    /// "negotiating" | "confirm" | "executed" | "declined".
    pub stage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_reason: Option<String>,
    pub tick: u64,
}

/// One participant's copy of a trade session VM, tagged with the actor it must
/// be delivered to. A single trade command emits one delivery per participant
/// so the server can push `tradeSession` to BOTH sides in the command path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityTradeSessionDelivery {
    pub actor_id: String,
    pub session: AuthorityTradeSessionSnapshot,
}
