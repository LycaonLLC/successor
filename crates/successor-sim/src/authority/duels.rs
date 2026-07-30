//! Consensual 1v1 dueling: deterministic duel-pair state, the sandbox-flavored
//! challenge/accept/decline/yield command surface, the PvP damage SCOPE it
//! enforces, and every honorable end condition.
//!
//! This is a focused PvP-lite module. Its only shared-state hooks on
//! `SliceAuthorityState` are four fields — `duels`, `duel_challenges`,
//! `next_duel_id`, and the transient `pending_duel_outcomes` — plus:
//!   * a call to [`SliceAuthorityState::duels_on_actor_removed`] inside `remove_actor`,
//!   * a call to [`SliceAuthorityState::tick_duel_lifecycle`] in the per-tick lifecycle,
//!   * the hash contribution [`SliceAuthorityState::write_duels_stable_hash`],
//!   * the per-observer projection [`SliceAuthorityState::duel_view_for_observer`],
//!   * the combat gate [`SliceAuthorityState::actors_in_active_duel`] read by
//!     `can_actor_attack` and the loot-rights ledger.
//!
//! Everything else — the state machine, invariants, and end conditions — lives here.
//!
//! ## The PvP SCOPE (the reason this module exists)
//! Before dueling, `can_actor_attack` returned `true` for any human attacker, so
//! human-vs-human damage was WIDE OPEN. Dueling SCOPES that: human-vs-human
//! damage is now permitted ONLY inside an active duel pair. A non-duel attack on
//! another player is blocked — the targeted roll attack (`QueueCombatAction`)
//! gets an honest `target_unavailable` reject. NPC and faction combat are
//! unchanged.
//!
//! ## No loot, no rights over a duel opponent
//! Duel damage never enters the loot-rights damage ledger (`record_damage_stats`
//! skips it), so a duel down leaves `loot_rights_actor_id = None` and grants NO
//! kill XP — you cannot farm loot or XP off a duel. Duelists are ordinary
//! player-like revivable actors, so a duel down is non-lootable (players never
//! drop a corpse container) and auto-revive-eligible (the incap self-revive
//! timer brings them back). Honor, not spoils.
//!
//! ## End conditions
//! * **Yield** (`DuelYield`): the yielder concedes and LIVES; both sides get an outcome.
//! * **Third incap / deathblow**: first and second incapacitations remain in the
//!   downed/self-revive lifecycle. A third incap or legal explicit `Deathblow`
//!   uses the normal Rust death/respawn lifecycle and ends the duel.
//! * **Range leash**: partners drift to different areas or more than
//!   `DUEL_RANGE_LEASH_CELLS` apart — the duel dissolves.
//! * **Timeout**: `DUEL_TIMEOUT_TICKS` after it started with no resolution.
//! * **Disconnect**: a participant is removed (`remove_actor`) — the duel dissolves.
//!
//! Challenges expire after `DUEL_CHALLENGE_EXPIRY_TICKS`, mirroring group invites.

use super::*;

/// Ticks a duel challenge stays valid before it silently expires. 900 ticks == 30 s
/// at the fixed 30 Hz authority cadence — deliberately identical to
/// `GROUP_INVITE_EXPIRY_TICKS` (owner-ratified consent-window parity). Tunable.
pub(super) const DUEL_CHALLENGE_EXPIRY_TICKS: u64 = 900;

/// Range leash. If duel partners end a tick in different areas or more than this
/// many cells apart, the duel dissolves. 32 cells (owner-ratified). Tunable.
pub(super) const DUEL_RANGE_LEASH_CELLS: i32 = 32;

/// A duel with no resolution self-dissolves after this many ticks. 9000 ticks ==
/// 5 min at 30 Hz (owner-ratified; equals `CORPSE_BODY_WITH_LOOT_TICKS`). Tunable.
pub(super) const DUEL_TIMEOUT_TICKS: u64 = 9_000;

/// One active duel. Keyed in `SliceAuthorityState::duels` by `id`. Participant ids
/// are stored lexicographically sorted (`actor_a_id` < `actor_b_id`) so the pair —
/// and its stable hash — is canonical regardless of who challenged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct DuelAuthorityState {
    pub(super) id: u64,
    pub(super) actor_a_id: String,
    pub(super) actor_b_id: String,
    pub(super) started_tick: u64,
    pub(super) expires_tick: u64,
}

impl DuelAuthorityState {
    fn involves(&self, actor_id: &str) -> bool {
        self.actor_a_id == actor_id || self.actor_b_id == actor_id
    }

    fn opponent_of<'a>(&'a self, actor_id: &str) -> Option<&'a str> {
        if self.actor_a_id == actor_id {
            Some(&self.actor_b_id)
        } else if self.actor_b_id == actor_id {
            Some(&self.actor_a_id)
        } else {
            None
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum DuelEndReason {
    Yield,
    Deathblow,
    Down,
    RangeLeash,
    Timeout,
    Disconnect,
}

impl DuelEndReason {
    const fn code(self) -> &'static str {
        match self {
            Self::Yield => "yield",
            Self::Deathblow => "deathblow",
            Self::Down => "down",
            Self::RangeLeash => "range",
            Self::Timeout => "timeout",
            Self::Disconnect => "disconnect",
        }
    }
}

/// A pending challenge, keyed in `SliceAuthorityState::duel_challenges` by the
/// CHALLENGED actor id (one live challenge per target; a fresh challenge replaces
/// any prior one — mirrors the group-invite convention).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PendingDuelChallenge {
    pub(super) challenger_actor_id: String,
    pub(super) issued_tick: u64,
    pub(super) expires_tick: u64,
}

// ---------------------------------------------------------------------------
// Wire / FE-contract snapshots
// ---------------------------------------------------------------------------

/// The active duel from one observer's point of view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDuelSummarySnapshot {
    pub duel_id: u64,
    pub opponent_actor_id: String,
    pub opponent_name: String,
    pub started_tick: u64,
    pub expires_tick: u64,
}

/// A pending challenge from one observer's point of view. `other_actor_id` is the
/// challenger for an incoming challenge, or the target for an outgoing one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDuelChallengeSnapshot {
    pub other_actor_id: String,
    pub other_name: String,
    pub issued_tick: u64,
    pub expires_tick: u64,
}

/// Owning-session-safe duel view for one observer. A non-participant with no
/// challenge receives an empty view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDuelViewSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_duel: Option<AuthorityDuelSummarySnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub incoming_challenge: Option<AuthorityDuelChallengeSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outgoing_challenge: Option<AuthorityDuelChallengeSnapshot>,
}

impl AuthorityDuelViewSnapshot {
    fn is_empty(&self) -> bool {
        self.active_duel.is_none()
            && self.incoming_challenge.is_none()
            && self.outgoing_challenge.is_none()
    }
}

/// A one-shot per-participant duel-end receipt. Transient — drained into the
/// command frame / tick output the same tick the duel ends, then gone. `result`
/// is from THIS participant's point of view (`won` / `lost` / `dissolved`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDuelOutcomeSnapshot {
    pub actor_id: String,
    pub duel_id: u64,
    pub opponent_actor_id: String,
    pub opponent_name: String,
    pub result: String,
    pub reason: String,
    pub tick: u64,
}

impl SliceAuthorityState {
    // -- queries / invariants --------------------------------------------------

    /// Id of the active duel `actor_id` is in, if any. O(duels) scan; duel counts
    /// are tiny, which keeps duel membership off the actor struct. Deterministic
    /// (BTreeMap iteration order).
    pub(super) fn actor_active_duel_id(&self, actor_id: &str) -> Option<u64> {
        self.runtime
            .durable
            .duels
            .iter()
            .find(|(_, duel)| duel.involves(actor_id))
            .map(|(id, _)| *id)
    }

    /// True iff `left` and `right` are the two participants of one active duel.
    /// Read by `can_actor_attack` (the PvP scope) and the loot-rights ledger.
    pub(in crate::authority) fn actors_in_active_duel(&self, left: &str, right: &str) -> bool {
        self.runtime
            .durable
            .duels
            .values()
            .any(|duel| duel.involves(left) && duel.involves(right) && left != right)
    }

    fn actor_is_duelable_alive(&self, actor_id: &str) -> bool {
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| {
                is_human_player_actor(actor) && actor.life_state == AuthorityLifeState::Alive
            })
    }

    fn duel_actor_label(&self, actor_id: &str) -> String {
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| {
                if actor.display_name.is_empty() {
                    actor.id.clone()
                } else {
                    actor.display_name.clone()
                }
            })
            .unwrap_or_else(|| actor_id.to_owned())
    }

    // -- commands ---------------------------------------------------------------

    /// Challenge a specific player to a consensual 1v1 duel. Only humans duel;
    /// neither side may already be in an active duel. A fresh challenge replaces
    /// any prior pending challenge to the same target.
    pub(super) fn apply_duel_challenge(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let challenger_id = config.player_actor_id.clone();
        let challenger = self
            .runtime
            .durable
            .actors
            .get(&challenger_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_human_player_actor(challenger) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if challenger.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if target_actor_id == challenger_id {
            return Err(AuthorityRejectReason::CannotDuelSelf);
        }
        let target = self
            .runtime
            .durable
            .actors
            .get(target_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_human_player_actor(target) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if target.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if self.actor_active_duel_id(&challenger_id).is_some()
            || self.actor_active_duel_id(target_actor_id).is_some()
        {
            return Err(AuthorityRejectReason::AlreadyDueling);
        }
        let expires_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(DUEL_CHALLENGE_EXPIRY_TICKS);
        self.runtime.durable.duel_challenges.insert(
            target_actor_id.to_owned(),
            PendingDuelChallenge {
                challenger_actor_id: challenger_id,
                issued_tick: self.runtime.durable.tick,
                expires_tick,
            },
        );
        Ok(())
    }

    /// Accept the pending challenge addressed to the issuer, forming the duel.
    pub(super) fn apply_duel_accept(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let accepter_id = config.player_actor_id.clone();
        let challenge = match self.runtime.durable.duel_challenges.get(&accepter_id) {
            Some(challenge) if challenge.expires_tick > self.runtime.durable.tick => {
                challenge.clone()
            }
            Some(_) => {
                self.runtime.durable.duel_challenges.remove(&accepter_id);
                return Err(AuthorityRejectReason::NoPendingDuelChallenge);
            }
            None => return Err(AuthorityRejectReason::NoPendingDuelChallenge),
        };
        let accepter = self
            .runtime
            .durable
            .actors
            .get(&accepter_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_human_player_actor(accepter) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if accepter.life_state != AuthorityLifeState::Alive {
            // Keep the challenge; a downed player may accept once revived.
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if self.actor_active_duel_id(&accepter_id).is_some() {
            self.runtime.durable.duel_challenges.remove(&accepter_id);
            return Err(AuthorityRejectReason::AlreadyDueling);
        }
        if !self.actor_is_duelable_alive(&challenge.challenger_actor_id) {
            // Challenger gone / dead / no longer a human player.
            self.runtime.durable.duel_challenges.remove(&accepter_id);
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if self
            .actor_active_duel_id(&challenge.challenger_actor_id)
            .is_some()
        {
            // Challenger got pulled into another duel first.
            self.runtime.durable.duel_challenges.remove(&accepter_id);
            return Err(AuthorityRejectReason::AlreadyDueling);
        }
        self.create_duel(&challenge.challenger_actor_id, &accepter_id);
        Ok(())
    }

    /// Decline (and clear) the pending challenge addressed to the issuer.
    pub(super) fn apply_duel_decline(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        if self
            .runtime
            .durable
            .duel_challenges
            .remove(&config.player_actor_id)
            .is_some()
        {
            Ok(())
        } else {
            Err(AuthorityRejectReason::NoPendingDuelChallenge)
        }
    }

    /// Yield the issuer's active duel: the yielder concedes and lives; the
    /// opponent wins. Both participants get an outcome.
    pub(super) fn apply_duel_yield(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let yielder_id = config.player_actor_id.clone();
        let duel_id = self
            .actor_active_duel_id(&yielder_id)
            .ok_or(AuthorityRejectReason::NotInDuel)?;
        let winner = self
            .runtime
            .durable
            .duels
            .get(&duel_id)
            .and_then(|duel| duel.opponent_of(&yielder_id))
            .map(str::to_owned);
        self.end_duel(duel_id, winner.as_deref(), DuelEndReason::Yield);
        Ok(())
    }

    /// Explicitly finish a downed opponent in the issuer's active duel.
    /// This is the only player-controlled deathblow path; AI targeting never
    /// calls it and ordinary combat cannot damage a downed actor.
    pub(super) fn apply_deathblow(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let attacker_id = config.player_actor_id.clone();
        let duel_id = self
            .actor_active_duel_id(&attacker_id)
            .ok_or(AuthorityRejectReason::NotInDuel)?;
        if target_actor_id == attacker_id {
            return Err(AuthorityRejectReason::CannotDuelSelf);
        }
        let (attacker, target) = match (
            self.runtime.durable.actors.get(&attacker_id),
            self.runtime.durable.actors.get(target_actor_id),
        ) {
            (Some(attacker), Some(target)) => (attacker, target),
            (_, None) => return Err(AuthorityRejectReason::UnknownActor),
            (None, _) => return Err(AuthorityRejectReason::UnknownActor),
        };
        if attacker.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let duel = self
            .runtime
            .durable
            .duels
            .get(&duel_id)
            .ok_or(AuthorityRejectReason::NotInDuel)?;
        if duel.opponent_of(&attacker_id) != Some(target_actor_id) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if target.life_state != AuthorityLifeState::Downed
            || target.incap_expires_tick <= self.runtime.durable.tick
        {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if attacker.area_id != target.area_id {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if position_distance_milli(attacker.position, target.position)
            > POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::OutOfRange);
        }
        let Some(target) = self.runtime.durable.actors.get_mut(target_actor_id) else {
            return Err(AuthorityRejectReason::UnknownActor);
        };
        Self::kill_actor_for_respawn(
            self.runtime.durable.tick,
            self.runtime.durable.world.tick_rate_hz,
            target,
        );
        self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(1);
        self.end_duel(duel_id, Some(&attacker_id), DuelEndReason::Deathblow);
        Ok(())
    }

    // -- internal mutation ------------------------------------------------------

    /// Form a duel between two actors, storing participant ids canonically sorted.
    /// Consumes any pending challenge naming either participant so no stale
    /// challenge lingers against a now-busy duelist.
    fn create_duel(&mut self, first: &str, second: &str) {
        let (actor_a_id, actor_b_id) = if first <= second {
            (first.to_owned(), second.to_owned())
        } else {
            (second.to_owned(), first.to_owned())
        };
        let id = self.runtime.durable.next_duel_id;
        self.runtime.durable.next_duel_id = self.runtime.durable.next_duel_id.saturating_add(1);
        let started_tick = self.runtime.durable.tick;
        let expires_tick = started_tick.saturating_add(DUEL_TIMEOUT_TICKS);
        self.runtime.durable.duels.insert(
            id,
            DuelAuthorityState {
                id,
                actor_a_id: actor_a_id.clone(),
                actor_b_id: actor_b_id.clone(),
                started_tick,
                expires_tick,
            },
        );
        self.runtime
            .durable
            .duel_challenges
            .retain(|target, challenge| {
                target != &actor_a_id
                    && target != &actor_b_id
                    && challenge.challenger_actor_id != actor_a_id
                    && challenge.challenger_actor_id != actor_b_id
            });
    }

    /// Remove a duel and push a one-shot outcome to each participant still present.
    /// `winner` is the winning actor id (`None` == dissolved / draw).
    fn end_duel(&mut self, duel_id: u64, winner: Option<&str>, reason: DuelEndReason) {
        let Some(duel) = self.runtime.durable.duels.remove(&duel_id) else {
            return;
        };
        let tick = self.runtime.durable.tick;
        for (participant, opponent) in [
            (&duel.actor_a_id, &duel.actor_b_id),
            (&duel.actor_b_id, &duel.actor_a_id),
        ] {
            if !self.runtime.durable.actors.contains_key(participant) {
                continue;
            }
            let result = match winner {
                Some(w) if w == participant => "won",
                Some(_) => "lost",
                None => "dissolved",
            };
            let opponent_name = self.duel_actor_label(opponent);
            self.runtime
                .pending_duel_outcomes
                .push(AuthorityDuelOutcomeSnapshot {
                    actor_id: participant.clone(),
                    duel_id,
                    opponent_actor_id: opponent.clone(),
                    opponent_name,
                    result: result.to_owned(),
                    reason: reason.code().to_owned(),
                    tick,
                });
        }
    }

    /// Disconnect / removal cleanup: when an actor ceases to EXIST it leaves its
    /// active duel (dissolved) and every challenge naming it — as target or
    /// challenger — is voided. Called from `remove_actor`. Death does NOT reach
    /// here (a downed duelist still exists; the down end is handled per-tick).
    pub(super) fn duels_on_actor_removed(&mut self, actor_id: &str) {
        if let Some(duel_id) = self.actor_active_duel_id(actor_id) {
            self.end_duel(duel_id, None, DuelEndReason::Disconnect);
        }
        self.runtime.durable.duel_challenges.remove(actor_id);
        self.runtime
            .durable
            .duel_challenges
            .retain(|_, challenge| challenge.challenger_actor_id != actor_id);
    }

    /// Per-tick duel maintenance: prune expired challenges, count participant
    /// incapacitations, then resolve terminal death/range/timeout conditions.
    /// Called once per authority tick, AFTER combat resolution, so a same-tick
    /// down is caught.
    pub(super) fn tick_duel_lifecycle(&mut self) {
        let tick = self.runtime.durable.tick;
        self.runtime
            .durable
            .duel_challenges
            .retain(|_, challenge| challenge.expires_tick > tick);
        if self.runtime.durable.duels.is_empty() {
            return;
        }
        let leash_milli = DUEL_RANGE_LEASH_CELLS.saturating_mul(MILLI_CELLS_PER_CELL);
        let mut ends: Vec<(u64, Option<String>, DuelEndReason)> = Vec::new();
        for (id, duel) in &self.runtime.durable.duels {
            match (
                self.runtime.durable.actors.get(&duel.actor_a_id),
                self.runtime.durable.actors.get(&duel.actor_b_id),
            ) {
                (Some(a), Some(b)) => {
                    let a_dead = a.life_state == AuthorityLifeState::Respawning;
                    let b_dead = b.life_state == AuthorityLifeState::Respawning;
                    if a_dead || b_dead {
                        let winner = if a_dead && b_dead {
                            None
                        } else if a_dead {
                            Some(duel.actor_b_id.clone())
                        } else {
                            Some(duel.actor_a_id.clone())
                        };
                        ends.push((*id, winner, DuelEndReason::Down));
                    } else if a.area_id != b.area_id
                        || position_distance_milli(a.position, b.position) > leash_milli
                    {
                        ends.push((*id, None, DuelEndReason::RangeLeash));
                    } else if tick >= duel.expires_tick {
                        ends.push((*id, None, DuelEndReason::Timeout));
                    }
                }
                _ => ends.push((*id, None, DuelEndReason::Disconnect)),
            }
        }
        for (id, winner, reason) in ends {
            self.end_duel(id, winner.as_deref(), reason);
        }
    }

    /// Drain the one-shot duel outcomes accumulated since the last drain.
    pub(crate) fn take_duel_outcomes(&mut self) -> Vec<AuthorityDuelOutcomeSnapshot> {
        std::mem::take(&mut self.runtime.pending_duel_outcomes)
    }

    // -- AOI projection ---------------------------------------------------------

    /// Owning-session-safe duel view for `config`'s observer.
    pub(super) fn duel_view_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> AuthorityDuelViewSnapshot {
        let observer_id = &config.player_actor_id;
        let active_duel = self.actor_active_duel_id(observer_id).and_then(|duel_id| {
            let duel = self.runtime.durable.duels.get(&duel_id)?;
            let opponent = duel.opponent_of(observer_id)?;
            Some(AuthorityDuelSummarySnapshot {
                duel_id,
                opponent_actor_id: opponent.to_owned(),
                opponent_name: self.duel_actor_label(opponent),
                started_tick: duel.started_tick,
                expires_tick: duel.expires_tick,
            })
        });
        let incoming_challenge = self
            .runtime
            .durable
            .duel_challenges
            .get(observer_id)
            .filter(|challenge| challenge.expires_tick > self.runtime.durable.tick)
            .map(|challenge| AuthorityDuelChallengeSnapshot {
                other_actor_id: challenge.challenger_actor_id.clone(),
                other_name: self.duel_actor_label(&challenge.challenger_actor_id),
                issued_tick: challenge.issued_tick,
                expires_tick: challenge.expires_tick,
            });
        let outgoing_challenge = self
            .runtime
            .durable
            .duel_challenges
            .iter()
            .find(|(_, challenge)| {
                challenge.challenger_actor_id == *observer_id
                    && challenge.expires_tick > self.runtime.durable.tick
            })
            .map(|(target, challenge)| AuthorityDuelChallengeSnapshot {
                other_actor_id: target.clone(),
                other_name: self.duel_actor_label(target),
                issued_tick: challenge.issued_tick,
                expires_tick: challenge.expires_tick,
            });
        AuthorityDuelViewSnapshot {
            active_duel,
            incoming_challenge,
            outgoing_challenge,
        }
    }

    /// Internal bridge fanout: every human player-like actor that is in a duel or
    /// named by a live challenge gets its owning-session-safe view. Actors with an
    /// empty view are omitted (keeps the map small and the wire quiet).
    pub(crate) fn duel_views_by_actor_id(&self) -> BTreeMap<String, AuthorityDuelViewSnapshot> {
        self.runtime
            .durable
            .actors
            .iter()
            .filter(|(_, actor)| is_player_like_role(&actor.role))
            .filter_map(|(actor_id, _)| {
                let config = SliceAuthorityConfig {
                    player_actor_id: actor_id.clone(),
                    ..SliceAuthorityConfig::default()
                };
                let view = self.duel_view_for_observer(&config);
                (!view.is_empty()).then(|| (actor_id.clone(), view))
            })
            .collect()
    }

    // -- stable hash ------------------------------------------------------------

    /// Deterministic duel-state contribution to the authority stable hash. An
    /// inactive world (no duels, no challenges, id counter untouched) contributes
    /// NOTHING, so pre-dueling scenario/replay digests and persisted exports are
    /// byte-identical to before. Any activity writes the full contribution.
    pub(super) fn write_duels_stable_hash(&self, w: &mut StateWriter) {
        if self.runtime.durable.duels.is_empty()
            && self.runtime.durable.duel_challenges.is_empty()
            && self.runtime.durable.next_duel_id <= 1
        {
            return;
        }
        w.write_u64(self.runtime.durable.next_duel_id);
        w.write_u32(u32::try_from(self.runtime.durable.duels.len()).expect("duel count fits u32"));
        for (duel_id, duel) in &self.runtime.durable.duels {
            w.write_u64(*duel_id);
            write_string(w, &duel.actor_a_id);
            write_string(w, &duel.actor_b_id);
            w.write_tick(duel.started_tick)
                .write_tick(duel.expires_tick);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.duel_challenges.len())
                .expect("challenge count fits u32"),
        );
        for (target_id, challenge) in &self.runtime.durable.duel_challenges {
            write_string(w, target_id);
            write_string(w, &challenge.challenger_actor_id);
            w.write_tick(challenge.issued_tick)
                .write_tick(challenge.expires_tick);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player_snapshot(id: &str, x: i32) -> crate::ActorSnapshot {
        crate::ActorSnapshot {
            id: id.to_owned(),
            entity: format!("test:{id}"),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            label: id.to_owned(),
            role: "player".to_owned(),
            template_id: None,
            profession_ids: Vec::new(),
            skill_box_ids: Vec::new(),
            credits: None,
            capabilities: Vec::new(),
            career_goal_id: None,
            faction_id: None,
            social_group: None,
            pvp_status: None,
            player_organization_id: None,
            player_organization_tag: None,
            sprite: "adventurer-premium-male".to_owned(),
            pose_set: "idle".to_owned(),
            direction: "front".to_owned(),
            cell: crate::CellSnapshot::new(x, 10),
            route: Vec::new(),
            scale: None,
            vitals: None,
            max_vitals: None,
            initial_respawn_delay_ms: None,
        }
    }

    fn duel_state(actors: &[crate::ActorSnapshot]) -> SliceAuthorityState {
        let mut snapshot = crate::authority_test_slice();
        snapshot.actors.clear();
        snapshot.npc_jobs.clear();
        for actor in actors {
            snapshot.actors.push(actor.clone());
        }
        SliceAuthorityState::from_snapshot(&snapshot).expect("duel test slice builds")
    }

    fn players(ids: &[&str]) -> SliceAuthorityState {
        let actors: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| player_snapshot(id, 10 + index as i32 * 2))
            .collect();
        duel_state(&actors)
    }

    fn cfg(actor_id: &str) -> SliceAuthorityConfig {
        SliceAuthorityConfig {
            player_actor_id: actor_id.to_owned(),
            ..SliceAuthorityConfig::default()
        }
    }

    fn form_duel(state: &mut SliceAuthorityState, challenger: &str, target: &str) -> u64 {
        state
            .apply_duel_challenge(&cfg(challenger), target)
            .expect("challenge accepted");
        state
            .apply_duel_accept(&cfg(target))
            .expect("target accepts");
        state.take_duel_outcomes();
        state.actor_active_duel_id(challenger).expect("duel formed")
    }

    #[test]
    fn no_self_duel() {
        let mut state = players(&["p1", "p2"]);
        assert_eq!(
            state.apply_duel_challenge(&cfg("p1"), "p1"),
            Err(AuthorityRejectReason::CannotDuelSelf)
        );
    }

    #[test]
    fn challenge_accept_forms_duel_with_sorted_participants() {
        let mut state = players(&["zeta", "alpha"]);
        state
            .apply_duel_challenge(&cfg("zeta"), "alpha")
            .expect("challenge ok");
        // Not yet a duel — just a pending challenge.
        assert!(state.actor_active_duel_id("zeta").is_none());
        state.apply_duel_accept(&cfg("alpha")).expect("accept ok");
        let duel_id = state.actor_active_duel_id("zeta").expect("duel exists");
        assert_eq!(state.actor_active_duel_id("alpha"), Some(duel_id));
        let duel = state.duels.get(&duel_id).unwrap();
        // Participants stored canonically sorted regardless of who challenged.
        assert_eq!(duel.actor_a_id, "alpha");
        assert_eq!(duel.actor_b_id, "zeta");
        assert!(state.actors_in_active_duel("zeta", "alpha"));
        assert!(state.actors_in_active_duel("alpha", "zeta"));
        // Challenge consumed.
        assert!(!state.duel_challenges.contains_key("alpha"));
    }

    #[test]
    fn accept_or_decline_without_challenge_is_rejected() {
        let mut state = players(&["p1", "p2"]);
        assert_eq!(
            state.apply_duel_accept(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingDuelChallenge)
        );
        assert_eq!(
            state.apply_duel_decline(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingDuelChallenge)
        );
    }

    #[test]
    fn challenge_expires_after_window_and_is_pruned() {
        let mut state = players(&["p1", "p2"]);
        state
            .apply_duel_challenge(&cfg("p1"), "p2")
            .expect("challenge ok");
        state.tick += DUEL_CHALLENGE_EXPIRY_TICKS + 1;
        state.tick_duel_lifecycle();
        assert!(state.duel_challenges.is_empty(), "expired challenge pruned");
        assert_eq!(
            state.apply_duel_accept(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingDuelChallenge)
        );
    }

    #[test]
    fn one_active_duel_per_actor_invariant() {
        let mut state = players(&["p1", "p2", "p3"]);
        form_duel(&mut state, "p1", "p2");
        // Cannot challenge someone already dueling (target side).
        assert_eq!(
            state.apply_duel_challenge(&cfg("p3"), "p2"),
            Err(AuthorityRejectReason::AlreadyDueling)
        );
        // Cannot challenge while you are already dueling (challenger side).
        assert_eq!(
            state.apply_duel_challenge(&cfg("p1"), "p3"),
            Err(AuthorityRejectReason::AlreadyDueling)
        );
        // Forming a duel voids the challenger's dangling outgoing challenge, so a
        // late accept finds nothing pending.
        let mut state = players(&["p1", "p2", "p3"]);
        state
            .apply_duel_challenge(&cfg("p1"), "p3")
            .expect("challenge stored");
        assert!(state.duel_challenges.contains_key("p3"));
        form_duel(&mut state, "p1", "p2"); // p1 now dueling p2
        assert!(
            !state.duel_challenges.contains_key("p3"),
            "entering a duel voids the challenger's outgoing challenge"
        );
        assert_eq!(
            state.apply_duel_accept(&cfg("p3")),
            Err(AuthorityRejectReason::NoPendingDuelChallenge)
        );
    }

    #[test]
    fn accept_rejected_when_accepter_or_challenger_already_dueling() {
        // Defensive branch: accepter already in a duel with a lingering challenge.
        let mut state = players(&["p1", "p2", "p3", "p4"]);
        form_duel(&mut state, "p3", "p4");
        let issued_tick = state.tick;
        state.duel_challenges.insert(
            "p3".to_owned(),
            PendingDuelChallenge {
                challenger_actor_id: "p1".to_owned(),
                issued_tick,
                expires_tick: issued_tick + DUEL_CHALLENGE_EXPIRY_TICKS,
            },
        );
        assert_eq!(
            state.apply_duel_accept(&cfg("p3")),
            Err(AuthorityRejectReason::AlreadyDueling)
        );
        // Defensive branch: challenger already in a duel when the accept lands.
        let mut state = players(&["p1", "p2", "p3", "p4"]);
        form_duel(&mut state, "p1", "p4");
        let issued_tick = state.tick;
        state.duel_challenges.insert(
            "p2".to_owned(),
            PendingDuelChallenge {
                challenger_actor_id: "p1".to_owned(),
                issued_tick,
                expires_tick: issued_tick + DUEL_CHALLENGE_EXPIRY_TICKS,
            },
        );
        assert_eq!(
            state.apply_duel_accept(&cfg("p2")),
            Err(AuthorityRejectReason::AlreadyDueling)
        );
    }

    #[test]
    fn yield_ends_duel_yielder_lives_both_get_outcome() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        state.apply_duel_yield(&cfg("p1")).expect("p1 yields");
        assert!(!state.duels.contains_key(&duel_id), "duel ended");
        assert!(state.actor_active_duel_id("p1").is_none());
        assert!(state.actor_active_duel_id("p2").is_none());
        // The yielder lives.
        assert_eq!(
            state.actors.get("p1").unwrap().life_state,
            AuthorityLifeState::Alive
        );
        // Both get an outcome; p1 lost by yield, p2 won by yield.
        let outcomes = state.take_duel_outcomes();
        assert_eq!(outcomes.len(), 2);
        let p1 = outcomes.iter().find(|o| o.actor_id == "p1").unwrap();
        assert_eq!((p1.result.as_str(), p1.reason.as_str()), ("lost", "yield"));
        assert_eq!(p1.opponent_actor_id, "p2");
        let p2 = outcomes.iter().find(|o| o.actor_id == "p2").unwrap();
        assert_eq!((p2.result.as_str(), p2.reason.as_str()), ("won", "yield"));
    }

    #[test]
    fn yield_without_active_duel_is_rejected() {
        let mut state = players(&["p1", "p2"]);
        assert_eq!(
            state.apply_duel_yield(&cfg("p1")),
            Err(AuthorityRejectReason::NotInDuel)
        );
    }

    #[test]
    fn down_keeps_duel_active() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Downed;
        state.tick_duel_lifecycle();
        assert!(
            state.duels.contains_key(&duel_id),
            "first down keeps duel active"
        );
        assert!(state.take_duel_outcomes().is_empty());
    }

    #[test]
    fn simultaneous_down_keeps_duel_active() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        state.actors.get_mut("p1").unwrap().life_state = AuthorityLifeState::Downed;
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Downed;
        state.tick_duel_lifecycle();
        assert!(state.duels.contains_key(&duel_id));
        assert!(state.take_duel_outcomes().is_empty());
    }

    #[test]
    fn canonical_incap_sequence_keeps_duel_until_third_down() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        for expected_count in [1_u8, 2_u8] {
            let expires = {
                let tick = state.tick;
                let tick_rate_hz = state.tick_rate_hz;
                let actor = state.actors.get_mut("p2").unwrap();
                actor.vitals.health = -1;
                assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
                    tick,
                    tick_rate_hz,
                    actor
                ));
                assert_eq!(actor.incap_count, expected_count);
                actor.incap_expires_tick
            };
            state.tick = expires;
            state.tick_incap_self_revives();
            state.tick_duel_lifecycle();
            assert!(state.duels.contains_key(&duel_id));
            assert_eq!(
                state.actors.get("p2").unwrap().life_state,
                AuthorityLifeState::Alive
            );
        }
        {
            let tick = state.tick;
            let tick_rate_hz = state.tick_rate_hz;
            let actor = state.actors.get_mut("p2").unwrap();
            actor.vitals.health = -1;
            assert!(SliceAuthorityState::down_player_like_actor_or_kill(
                tick,
                tick_rate_hz,
                actor
            ));
            assert_eq!(actor.life_state, AuthorityLifeState::Respawning);
        }
        state.tick_duel_lifecycle();
        assert!(!state.duels.contains_key(&duel_id));
        let outcomes = state.take_duel_outcomes();
        assert!(outcomes
            .iter()
            .any(|o| o.actor_id == "p1" && o.result == "won"));
        assert!(outcomes
            .iter()
            .any(|o| o.actor_id == "p2" && o.result == "lost"));
    }

    #[test]
    fn explicit_deathblow_uses_normal_respawn_lifecycle_and_ends_duel() {
        let mut state = players(&["p1", "p2", "p3"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        {
            let tick = state.tick;
            let tick_rate_hz = state.tick_rate_hz;
            let target = state.actors.get_mut("p2").unwrap();
            target.vitals.health = -1;
            assert!(!SliceAuthorityState::down_player_like_actor_or_kill(
                tick,
                tick_rate_hz,
                target
            ));
            assert_eq!(target.life_state, AuthorityLifeState::Downed);
        }
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p1"),
            Err(AuthorityRejectReason::CannotDuelSelf)
        );
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Alive;
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p2"),
            Err(AuthorityRejectReason::TargetUnavailable)
        );
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Downed;
        state.actors.get_mut("p2").unwrap().incap_expires_tick = state.tick;
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p2"),
            Err(AuthorityRejectReason::TargetUnavailable)
        );
        state.actors.get_mut("p2").unwrap().incap_expires_tick = state.tick + 100;
        state.actors.get_mut("p2").unwrap().position.x +=
            POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS + 1;
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p2"),
            Err(AuthorityRejectReason::OutOfRange)
        );
        state.actors.get_mut("p2").unwrap().position.x = state.actors.get("p1").unwrap().position.x;
        state.actors.get_mut("p2").unwrap().area_id = "other".to_owned();
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p2"),
            Err(AuthorityRejectReason::TargetUnavailable)
        );
        state.actors.get_mut("p2").unwrap().area_id = crate::AUTHORITY_TEST_AREA_ID.to_owned();
        assert_eq!(
            state.apply_deathblow(&cfg("p1"), "p3"),
            Err(AuthorityRejectReason::TargetUnavailable)
        );
        state
            .apply_deathblow(&cfg("p1"), "p2")
            .expect("legal deathblow");
        assert_eq!(
            state.actors.get("p2").unwrap().life_state,
            AuthorityLifeState::Respawning
        );
        assert!(!state.duels.contains_key(&duel_id));
        assert!(state
            .take_duel_outcomes()
            .iter()
            .any(|o| o.reason == "deathblow"));
    }

    #[test]
    fn range_leash_dissolves_duel() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        let far = (DUEL_RANGE_LEASH_CELLS + 5).saturating_mul(MILLI_CELLS_PER_CELL);
        state.actors.get_mut("p2").unwrap().position.x = state
            .actors
            .get("p1")
            .unwrap()
            .position
            .x
            .saturating_add(far);
        state.tick_duel_lifecycle();
        assert!(!state.duels.contains_key(&duel_id));
        assert!(state
            .take_duel_outcomes()
            .iter()
            .all(|o| o.reason == "range"));
    }

    #[test]
    fn timeout_dissolves_duel() {
        let mut state = players(&["p1", "p2"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        state.tick += DUEL_TIMEOUT_TICKS + 1;
        state.tick_duel_lifecycle();
        assert!(!state.duels.contains_key(&duel_id), "duel timed out");
        let outcomes = state.take_duel_outcomes();
        assert!(outcomes
            .iter()
            .all(|o| o.result == "dissolved" && o.reason == "timeout"));
    }

    #[test]
    fn disconnect_dissolves_duel_and_voids_challenges() {
        let mut state = players(&["p1", "p2", "p3"]);
        let duel_id = form_duel(&mut state, "p1", "p2");
        // p1 also has an outgoing challenge to p3.
        state.apply_duel_challenge(&cfg("p2"), "p3").ok(); // p2 is dueling, rejected — set up via p3->free instead
        state.duel_challenges.clear();
        state.apply_duel_challenge(&cfg("p3"), "p3").ok();
        // Remove p2 (the disconnect path).
        assert!(state.remove_actor("p2"));
        assert!(
            !state.duels.contains_key(&duel_id),
            "duel dissolved on disconnect"
        );
        assert!(state.actor_active_duel_id("p1").is_none());
        // p1 (still present) got a dissolved/disconnect outcome; the removed p2 did not.
        let outcomes = state.take_duel_outcomes();
        assert!(outcomes
            .iter()
            .any(|o| o.actor_id == "p1" && o.reason == "disconnect"));
        assert!(outcomes.iter().all(|o| o.actor_id != "p2"));
    }

    #[test]
    fn duel_view_is_owning_session_safe() {
        let mut state = players(&["p1", "p2", "stranger"]);
        form_duel(&mut state, "p1", "p2");
        let p1_view = state.duel_view_for_observer(&cfg("p1"));
        let active = p1_view.active_duel.expect("p1 sees the duel");
        assert_eq!(active.opponent_actor_id, "p2");
        // A non-participant sees nothing.
        let stranger_view = state.duel_view_for_observer(&cfg("stranger"));
        assert!(stranger_view.active_duel.is_none());
        assert!(stranger_view.incoming_challenge.is_none());
        assert!(stranger_view.outgoing_challenge.is_none());
        // An outstanding challenge surfaces on both ends.
        state.apply_duel_challenge(&cfg("stranger"), "p1").ok(); // p1 dueling -> rejected; use a free pair
        let mut state = players(&["a", "b"]);
        state
            .apply_duel_challenge(&cfg("a"), "b")
            .expect("challenge");
        let out = state
            .duel_view_for_observer(&cfg("a"))
            .outgoing_challenge
            .expect("a sees outgoing");
        assert_eq!(out.other_actor_id, "b");
        let inc = state
            .duel_view_for_observer(&cfg("b"))
            .incoming_challenge
            .expect("b sees incoming");
        assert_eq!(inc.other_actor_id, "a");
    }

    #[test]
    fn duel_state_participates_in_stable_hash_and_is_deterministic() {
        let mut state = players(&["p1", "p2"]);
        let before = state.stable_state_hash_hex();
        form_duel(&mut state, "p1", "p2");
        assert_ne!(
            state.stable_state_hash_hex(),
            before,
            "forming a duel must change the authority stable hash"
        );
        // A pending challenge also participates.
        let mut challenged = players(&["p1", "p2"]);
        let baseline = challenged.stable_state_hash_hex();
        challenged
            .apply_duel_challenge(&cfg("p1"), "p2")
            .expect("challenge");
        assert_ne!(challenged.stable_state_hash_hex(), baseline);
        // Identical op sequences hash identically.
        let build = || {
            let mut state = players(&["alpha", "bravo"]);
            form_duel(&mut state, "alpha", "bravo");
            state.stable_state_hash_hex()
        };
        assert_eq!(build(), build());
    }

    #[test]
    fn empty_duel_state_contributes_nothing_to_hash() {
        // A world that has never dueled must hash byte-identically to the
        // pre-dueling era (preserves existing scenario/replay digests).
        let state = players(&["p1", "p2"]);
        let mut with = StateWriter::new();
        state.write_duels_stable_hash(&mut with);
        assert!(
            with.finalize_hex() == StateWriter::new().finalize_hex(),
            "inactive duel state must contribute nothing"
        );
    }
}
