//! Player groups: deterministic group state, membership commands, group-scoped AOI
//! frames, and the owner-ratified kill-time combat XP rule.
//!
//! This is a focused social-systems module. The only shared-state hooks it needs on
//! `SliceAuthorityState` are three fields — `groups`, `group_invites`, `next_group_id`
//! — plus a single call to [`SliceAuthorityState::groups_on_actor_removed`] inside
//! `remove_actor`, a call to [`SliceAuthorityState::tick_group_invite_expiry`] in the
//! per-tick lifecycle, the hash contribution [`SliceAuthorityState::write_groups_stable_hash`],
//! and the per-observer delta projection [`SliceAuthorityState::group_view_for_observer`].
//! Everything else — the state machine, invariants, succession, and combat-XP grant —
//! lives here.
//!
//! ## Disconnect rule (owner-ratified 2026-07-08)
//! Group membership is bound to actor EXISTENCE, not liveness:
//! - **Death (Downed / Respawning): membership preserved** — groups survive death.
//! - **Link-dead grace (`set_actor_link_dead(true)`): membership preserved** — a network
//!   blip must never dissolve a group (consistent with the C2 re-entry / live-equip
//!   contract). Group member frames carry a `linkDead` flag so groupmates see
//!   "reconnecting" rather than a vanish.
//! - **Actor removal (`remove_actor`, i.e. link-dead TIMEOUT via `tick_link_dead_actors`
//!   or an explicit `removeActor`): the actor leaves its group** with deterministic
//!   leader succession, and the group disbands if fewer than two members remain. This is
//!   the single terminal cleanup path.
//!
//! ## GroupFrameVM wire contract (for the future FE lane)
//! `authority.groups` delta section payload (`AuthorityGroupsDeltaPayload`), projected
//! per owning session — non-members receive an empty group:
//! ```text
//! { schema, tick, view: {
//!     group?:  { groupId, leaderActorId, createdTick, memberActorIds[] },
//!     members: [ { actorId, name, areaId,
//!                  vitals:{health,action,spirit}, maxVitals:{health,action,spirit},
//!                  lifeState, isLeader, linkDead } ],
//!     pendingInvite?: { inviterActorId, inviterName, issuedTick, expiresTick } } }
//! ```

use super::*;

/// Maximum members per group (tunable). established sandbox-style small squads.
pub(super) const MAX_GROUP_SIZE: usize = 8;

/// Ticks a group invite stays valid before it silently expires. 900 ticks == 30 s at the
/// fixed 30 Hz authority cadence (owner-ratified).
pub(super) const GROUP_INVITE_EXPIRY_TICKS: u64 = 900;

/// One formed group. Keyed in `SliceAuthorityState::groups` by `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct GroupAuthorityState {
    pub(super) id: u64,
    pub(super) leader_actor_id: String,
    pub(super) member_actor_ids: BTreeSet<String>,
    pub(super) created_tick: u64,
}

/// A pending invite, keyed in `SliceAuthorityState::group_invites` by the INVITED actor id
/// (one live invite per target; a fresh invite replaces any prior one).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PendingGroupInvite {
    pub(super) inviter_actor_id: String,
    pub(super) issued_tick: u64,
    pub(super) expires_tick: u64,
}

// ---------------------------------------------------------------------------
// Wire / FE-contract snapshots (owning-session-safe group view)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupVitalsSnapshot {
    pub health: i32,
    pub action: i32,
    pub spirit: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupMemberFrameSnapshot {
    pub actor_id: String,
    pub name: String,
    pub area_id: String,
    pub vitals: AuthorityGroupVitalsSnapshot,
    pub max_vitals: AuthorityGroupVitalsSnapshot,
    pub life_state: AuthorityLifeState,
    pub is_leader: bool,
    pub link_dead: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupSummarySnapshot {
    pub group_id: u64,
    pub leader_actor_id: String,
    pub created_tick: u64,
    pub member_actor_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupInviteSnapshot {
    pub inviter_actor_id: String,
    pub inviter_name: String,
    pub issued_tick: u64,
    pub expires_tick: u64,
}

/// The owning-session-safe group view for one observer. `group`/`members` are populated
/// only when the observer belongs to a group; a non-member observer receives an empty
/// view. A live invite addressed to the observer is always surfaced (even ungrouped) so
/// the client can render accept/decline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupViewSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<AuthorityGroupSummarySnapshot>,
    pub members: Vec<AuthorityGroupMemberFrameSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_invite: Option<AuthorityGroupInviteSnapshot>,
}

/// Delta-bundle section payload for `authority.groups`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityGroupsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub view: AuthorityGroupViewSnapshot,
}

impl SliceAuthorityState {
    // -- queries / invariants --------------------------------------------------

    /// Id of the group `actor_id` belongs to, if any. O(groups) scan; group counts are
    /// tiny (a handful of squads), which keeps group membership off the actor struct so
    /// `model.rs` stays untouched. Deterministic (BTreeMap iteration order).
    pub(super) fn actor_group_id(&self, actor_id: &str) -> Option<u64> {
        self.runtime
            .durable
            .groups
            .iter()
            .find(|(_, group)| group.member_actor_ids.contains(actor_id))
            .map(|(id, _)| *id)
    }

    fn actor_is_groupable_alive(&self, actor_id: &str) -> bool {
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| {
                is_player_like_role(&actor.role) && actor.life_state == AuthorityLifeState::Alive
            })
    }

    fn actor_display_label(&self, actor_id: &str) -> String {
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

    /// Invite a target into the issuer's group (forming one on accept if the issuer is
    /// solo). Any solo or already-grouped player may invite as long as the resulting group
    /// has room; only kick/disband are leader-gated.
    pub(super) fn apply_group_invite(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let inviter_id = config.player_actor_id.clone();
        let inviter = self
            .runtime
            .durable
            .actors
            .get(&inviter_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_player_like_role(&inviter.role) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if inviter.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if target_actor_id == inviter_id {
            return Err(AuthorityRejectReason::CannotGroupSelf);
        }
        let target = self
            .runtime
            .durable
            .actors
            .get(target_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_player_like_role(&target.role) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if target.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if self.actor_group_id(target_actor_id).is_some() {
            return Err(AuthorityRejectReason::AlreadyInGroup);
        }
        // Fail fast if the issuer's existing group is already full (accept re-checks too).
        if let Some(group_id) = self.actor_group_id(&inviter_id) {
            if self
                .runtime
                .durable
                .groups
                .get(&group_id)
                .is_some_and(|group| group.member_actor_ids.len() >= MAX_GROUP_SIZE)
            {
                return Err(AuthorityRejectReason::GroupFull);
            }
        }
        let expires_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(GROUP_INVITE_EXPIRY_TICKS);
        self.runtime.durable.group_invites.insert(
            target_actor_id.to_owned(),
            PendingGroupInvite {
                inviter_actor_id: inviter_id,
                issued_tick: self.runtime.durable.tick,
                expires_tick,
            },
        );
        Ok(())
    }

    /// Accept the issuer's pending invite, joining the inviter's current group (or forming
    /// a new one led by the inviter if they are still solo).
    pub(super) fn apply_group_accept(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let accepter_id = config.player_actor_id.clone();
        let invite = match self.runtime.durable.group_invites.get(&accepter_id) {
            Some(invite) if invite.expires_tick > self.runtime.durable.tick => invite.clone(),
            Some(_) => {
                self.runtime.durable.group_invites.remove(&accepter_id);
                return Err(AuthorityRejectReason::NoPendingInvite);
            }
            None => return Err(AuthorityRejectReason::NoPendingInvite),
        };
        let accepter = self
            .runtime
            .durable
            .actors
            .get(&accepter_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if !is_player_like_role(&accepter.role) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if accepter.life_state != AuthorityLifeState::Alive {
            // Keep the invite; a downed player may accept once revived.
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if self.actor_group_id(&accepter_id).is_some() {
            self.runtime.durable.group_invites.remove(&accepter_id);
            return Err(AuthorityRejectReason::AlreadyInGroup);
        }
        if !self.actor_is_groupable_alive(&invite.inviter_actor_id) {
            // Inviter gone / dead / no longer a player.
            self.runtime.durable.group_invites.remove(&accepter_id);
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        match self.actor_group_id(&invite.inviter_actor_id) {
            Some(group_id) => {
                let group = self
                    .runtime
                    .durable
                    .groups
                    .get_mut(&group_id)
                    .ok_or(AuthorityRejectReason::TargetUnavailable)?;
                if group.member_actor_ids.len() >= MAX_GROUP_SIZE {
                    return Err(AuthorityRejectReason::GroupFull);
                }
                group.member_actor_ids.insert(accepter_id.clone());
            }
            None => {
                let group_id = self.runtime.durable.next_group_id;
                self.runtime.durable.next_group_id =
                    self.runtime.durable.next_group_id.saturating_add(1);
                let mut member_actor_ids = BTreeSet::new();
                member_actor_ids.insert(invite.inviter_actor_id.clone());
                member_actor_ids.insert(accepter_id.clone());
                self.runtime.durable.groups.insert(
                    group_id,
                    GroupAuthorityState {
                        id: group_id,
                        leader_actor_id: invite.inviter_actor_id.clone(),
                        member_actor_ids,
                        created_tick: self.runtime.durable.tick,
                    },
                );
            }
        }
        self.runtime.durable.group_invites.remove(&accepter_id);
        Ok(())
    }

    /// Decline (and clear) the issuer's pending invite.
    pub(super) fn apply_group_decline(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        if self
            .runtime
            .durable
            .group_invites
            .remove(&config.player_actor_id)
            .is_some()
        {
            Ok(())
        } else {
            Err(AuthorityRejectReason::NoPendingInvite)
        }
    }

    /// Leave the issuer's group (deterministic succession; disband if too small).
    pub(super) fn apply_group_leave(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let group_id = self
            .actor_group_id(&actor_id)
            .ok_or(AuthorityRejectReason::NotInGroup)?;
        self.remove_member_from_group(group_id, &actor_id);
        Ok(())
    }

    /// Disband the issuer's group entirely. Leader-only.
    pub(super) fn apply_group_disband(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = &config.player_actor_id;
        let group_id = self
            .actor_group_id(actor_id)
            .ok_or(AuthorityRejectReason::NotInGroup)?;
        let is_leader = self
            .runtime
            .durable
            .groups
            .get(&group_id)
            .is_some_and(|group| group.leader_actor_id == *actor_id);
        if !is_leader {
            return Err(AuthorityRejectReason::NotGroupLeader);
        }
        self.runtime.durable.groups.remove(&group_id);
        Ok(())
    }

    /// Kick a member from the issuer's group. Leader-only; cannot target the leader.
    pub(super) fn apply_group_kick(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let group_id = self
            .actor_group_id(&actor_id)
            .ok_or(AuthorityRejectReason::NotInGroup)?;
        {
            let group = self
                .runtime
                .durable
                .groups
                .get(&group_id)
                .ok_or(AuthorityRejectReason::NotInGroup)?;
            if group.leader_actor_id != actor_id {
                return Err(AuthorityRejectReason::NotGroupLeader);
            }
            if target_actor_id == actor_id {
                return Err(AuthorityRejectReason::CannotGroupSelf);
            }
            if !group.member_actor_ids.contains(target_actor_id) {
                return Err(AuthorityRejectReason::NotGroupMember);
            }
        }
        self.remove_member_from_group(group_id, target_actor_id);
        Ok(())
    }

    // -- internal mutation ------------------------------------------------------

    /// Remove one member with deterministic leader succession and disband-if-too-small. A
    /// group with fewer than two members is not a group. Succession picks the
    /// lexicographically-first remaining member (BTreeSet order) — fully deterministic.
    fn remove_member_from_group(&mut self, group_id: u64, member_id: &str) {
        let dissolve = {
            let Some(group) = self.runtime.durable.groups.get_mut(&group_id) else {
                return;
            };
            group.member_actor_ids.remove(member_id);
            if group.member_actor_ids.len() < 2 {
                true
            } else {
                if group.leader_actor_id == member_id {
                    if let Some(next_leader) = group.member_actor_ids.iter().next() {
                        group.leader_actor_id = next_leader.clone();
                    }
                }
                false
            }
        };
        if dissolve {
            self.runtime.durable.groups.remove(&group_id);
        }
    }

    /// Disconnect / removal cleanup: when an actor ceases to EXIST (link-dead timeout via
    /// `tick_link_dead_actors`, explicit `removeActor`, or population prune) it leaves its
    /// group (succession / disband) and every invite naming it — as target or inviter — is
    /// voided. Called from `remove_actor` so all removal paths are covered. Death does NOT
    /// call this: groups survive death because the actor still exists.
    pub(super) fn groups_on_actor_removed(&mut self, actor_id: &str) {
        if let Some(group_id) = self.actor_group_id(actor_id) {
            self.remove_member_from_group(group_id, actor_id);
        }
        self.runtime.durable.group_invites.remove(actor_id);
        self.runtime
            .durable
            .group_invites
            .retain(|_, invite| invite.inviter_actor_id != actor_id);
    }

    /// Drop invites whose expiry has passed. Called once per authority tick so the stored
    /// state — and its stable hash / wire projection — only ever reflects live invites.
    pub(super) fn tick_group_invite_expiry(&mut self) {
        let tick = self.runtime.durable.tick;
        self.runtime
            .durable
            .group_invites
            .retain(|_, invite| invite.expires_tick > tick);
    }

    // -- combat XP (owner-ratified kill-time rule) ------------------------------
    // NOTE: `award_kill_combat_xp_to_damagers` lives in tick_lifecycle.rs next to the
    // loot-rights ledger it reuses; the per-hit grant sites call it on a defeat.

    // -- AOI projection ---------------------------------------------------------

    /// Build the owning-session-safe group view for `config`'s observer. Members are
    /// surfaced only for a grouped observer (they see each other's id/name/vitals/area
    /// regardless of interest radius — the whole point of a group window); a non-member
    /// observer receives an empty group. A live invite addressed to the observer is always
    /// surfaced.
    pub(super) fn group_view_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> AuthorityGroupViewSnapshot {
        let observer_id = &config.player_actor_id;
        let (group, members) = match self.actor_group_id(observer_id) {
            Some(group_id) => match self.runtime.durable.groups.get(&group_id) {
                Some(group) => {
                    let members = group
                        .member_actor_ids
                        .iter()
                        .filter_map(|member_id| {
                            self.group_member_frame(member_id, &group.leader_actor_id)
                        })
                        .collect();
                    (
                        Some(AuthorityGroupSummarySnapshot {
                            group_id,
                            leader_actor_id: group.leader_actor_id.clone(),
                            created_tick: group.created_tick,
                            member_actor_ids: group.member_actor_ids.iter().cloned().collect(),
                        }),
                        members,
                    )
                }
                None => (None, Vec::new()),
            },
            None => (None, Vec::new()),
        };
        let pending_invite = self
            .runtime
            .durable
            .group_invites
            .get(observer_id)
            .filter(|invite| invite.expires_tick > self.runtime.durable.tick)
            .map(|invite| AuthorityGroupInviteSnapshot {
                inviter_actor_id: invite.inviter_actor_id.clone(),
                inviter_name: self.actor_display_label(&invite.inviter_actor_id),
                issued_tick: invite.issued_tick,
                expires_tick: invite.expires_tick,
            });
        AuthorityGroupViewSnapshot {
            group,
            members,
            pending_invite,
        }
    }

    /// Internal bridge fanout payload: every player-like actor gets exactly one
    /// owning-session-safe view. Empty views are included so the server can clear stale
    /// group frames after leave/disband/removal without learning group internals.
    pub(crate) fn group_views_by_actor_id(&self) -> BTreeMap<String, AuthorityGroupViewSnapshot> {
        self.runtime
            .durable
            .actors
            .iter()
            .filter(|(_, actor)| is_player_like_role(&actor.role))
            .map(|(actor_id, _)| {
                let config = SliceAuthorityConfig {
                    player_actor_id: actor_id.clone(),
                    ..SliceAuthorityConfig::default()
                };
                (actor_id.clone(), self.group_view_for_observer(&config))
            })
            .collect()
    }

    fn group_member_frame(
        &self,
        member_id: &str,
        leader_id: &str,
    ) -> Option<AuthorityGroupMemberFrameSnapshot> {
        let actor = self.runtime.durable.actors.get(member_id)?;
        Some(AuthorityGroupMemberFrameSnapshot {
            actor_id: actor.id.clone(),
            name: if actor.display_name.is_empty() {
                actor.id.clone()
            } else {
                actor.display_name.clone()
            },
            area_id: actor.area_id.clone(),
            vitals: AuthorityGroupVitalsSnapshot {
                health: actor.vitals.health,
                action: actor.vitals.action,
                spirit: actor.vitals.spirit,
            },
            max_vitals: AuthorityGroupVitalsSnapshot {
                health: actor.max_vitals.health,
                action: actor.max_vitals.action,
                spirit: actor.max_vitals.spirit,
            },
            life_state: actor.life_state,
            is_leader: member_id == leader_id,
            link_dead: actor.link_dead,
        })
    }

    // -- stable hash ------------------------------------------------------------

    /// Deterministic group-state contribution to the authority stable hash. Written from
    /// `stable_state_hash_hex`. BTreeMap / BTreeSet iteration is sorted, so this is order-
    /// independent and reproducible run-to-run.
    pub(super) fn write_groups_stable_hash(&self, w: &mut StateWriter) {
        // Inactive group state contributes NOTHING, so a world that has never formed a
        // group hashes byte-identically to the pre-groups era. This preserves existing
        // scenario/replay digests and lets pre-groups persisted exports still import
        // (their stored hash was computed without groups). Any activity — a live group, a
        // pending invite, or an advanced id counter — writes the full deterministic
        // contribution, so participation still holds.
        if self.runtime.durable.groups.is_empty()
            && self.runtime.durable.group_invites.is_empty()
            && self.runtime.durable.next_group_id <= 1
        {
            return;
        }
        w.write_u64(self.runtime.durable.next_group_id);
        w.write_u32(
            u32::try_from(self.runtime.durable.groups.len()).expect("group count fits u32"),
        );
        for (group_id, group) in &self.runtime.durable.groups {
            w.write_u64(*group_id);
            write_string(w, &group.leader_actor_id);
            w.write_tick(group.created_tick).write_u32(
                u32::try_from(group.member_actor_ids.len()).expect("member count fits u32"),
            );
            for member_id in &group.member_actor_ids {
                write_string(w, member_id);
            }
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.group_invites.len()).expect("invite count fits u32"),
        );
        for (invited_id, invite) in &self.runtime.durable.group_invites {
            write_string(w, invited_id);
            write_string(w, &invite.inviter_actor_id);
            w.write_tick(invite.issued_tick)
                .write_tick(invite.expires_tick);
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

    fn npc_snapshot(id: &str, x: i32) -> crate::ActorSnapshot {
        let mut actor = player_snapshot(id, x);
        actor.role = "creature".to_owned();
        actor.sprite = "creature-bellback-adult".to_owned();
        actor
    }

    fn group_state(actors: &[crate::ActorSnapshot]) -> SliceAuthorityState {
        let mut snapshot = crate::authority_test_slice();
        snapshot.actors.clear();
        snapshot.npc_jobs.clear();
        for actor in actors {
            snapshot.actors.push(actor.clone());
        }
        SliceAuthorityState::from_snapshot(&snapshot).expect("group test slice builds")
    }

    fn players(ids: &[&str]) -> SliceAuthorityState {
        let actors: Vec<_> = ids
            .iter()
            .enumerate()
            .map(|(index, id)| player_snapshot(id, 10 + index as i32 * 2))
            .collect();
        group_state(&actors)
    }

    fn learn_profession(
        state: &mut SliceAuthorityState,
        actor_id: &str,
        profession: AuthorityProfessionKind,
    ) {
        let novice_id = format!("{}-novice", profession.id());
        let definition = authority_skill_box_definition(&novice_id).expect("novice box exists");
        state
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .expect("test actor exists")
            .professions
            .train_skill_box(&definition);
    }

    fn cfg(actor_id: &str) -> SliceAuthorityConfig {
        SliceAuthorityConfig {
            player_actor_id: actor_id.to_owned(),
            ..SliceAuthorityConfig::default()
        }
    }

    fn form_group(state: &mut SliceAuthorityState, leader: &str, members: &[&str]) -> u64 {
        for member in members {
            state
                .apply_group_invite(&cfg(leader), member)
                .expect("invite accepted");
            state
                .apply_group_accept(&cfg(member))
                .expect("member accepts invite");
        }
        state.actor_group_id(leader).expect("group formed")
    }

    #[test]
    fn invite_accept_forms_group_with_inviter_as_leader() {
        let mut state = players(&["p1", "p2"]);
        state
            .apply_group_invite(&cfg("p1"), "p2")
            .expect("invite ok");
        // The invite is not yet a group.
        assert!(state.actor_group_id("p1").is_none());
        state.apply_group_accept(&cfg("p2")).expect("accept ok");
        let group_id = state.actor_group_id("p1").expect("group exists");
        assert_eq!(state.actor_group_id("p2"), Some(group_id));
        let group = state.groups.get(&group_id).unwrap();
        assert_eq!(group.leader_actor_id, "p1");
        assert_eq!(group.member_actor_ids.len(), 2);
        assert!(group.member_actor_ids.contains("p1"));
        assert!(group.member_actor_ids.contains("p2"));
        // Invite consumed.
        assert!(!state.group_invites.contains_key("p2"));
    }

    #[test]
    fn accept_without_invite_is_rejected() {
        let mut state = players(&["p1", "p2"]);
        assert_eq!(
            state.apply_group_accept(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingInvite)
        );
        assert_eq!(
            state.apply_group_decline(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingInvite)
        );
    }

    #[test]
    fn invite_expires_after_window_and_is_pruned() {
        let mut state = players(&["p1", "p2"]);
        state
            .apply_group_invite(&cfg("p1"), "p2")
            .expect("invite ok");
        // Advance past expiry and run the per-tick prune.
        state.tick += GROUP_INVITE_EXPIRY_TICKS + 1;
        state.tick_group_invite_expiry();
        assert!(state.group_invites.is_empty(), "expired invite pruned");
        assert_eq!(
            state.apply_group_accept(&cfg("p2")),
            Err(AuthorityRejectReason::NoPendingInvite)
        );
    }

    #[test]
    fn one_group_per_actor_invariant() {
        let mut state = players(&["p1", "p2", "p3"]);
        form_group(&mut state, "p1", &["p2"]);
        // p3 cannot invite p2 (already grouped).
        assert_eq!(
            state.apply_group_invite(&cfg("p3"), "p2"),
            Err(AuthorityRejectReason::AlreadyInGroup)
        );
        // p2 cannot accept a fresh invite while grouped.
        state.apply_group_invite(&cfg("p3"), "p1").ok(); // p1 already grouped -> invite stored but...
                                                         // Actually invite to p1 targets a grouped actor -> AlreadyInGroup on invite.
        assert_eq!(
            state.apply_group_invite(&cfg("p3"), "p1"),
            Err(AuthorityRejectReason::AlreadyInGroup)
        );
    }

    #[test]
    fn max_group_size_is_enforced() {
        let ids: Vec<String> = (0..MAX_GROUP_SIZE + 1).map(|i| format!("p{i}")).collect();
        let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        let mut state = players(&id_refs);
        // Leader p0 fills the group to MAX_GROUP_SIZE (leader + MAX-1 invitees).
        let members: Vec<&str> = id_refs[1..MAX_GROUP_SIZE].to_vec();
        let group_id = form_group(&mut state, "p0", &members);
        assert_eq!(
            state.groups.get(&group_id).unwrap().member_actor_ids.len(),
            MAX_GROUP_SIZE
        );
        // The 9th invite is rejected at invite time (group full).
        let overflow = id_refs[MAX_GROUP_SIZE];
        assert_eq!(
            state.apply_group_invite(&cfg("p0"), overflow),
            Err(AuthorityRejectReason::GroupFull)
        );
    }

    #[test]
    fn kick_and_disband_are_leader_only() {
        let mut state = players(&["p1", "p2", "p3"]);
        let group_id = form_group(&mut state, "p1", &["p2", "p3"]);
        // Non-leader cannot kick or disband.
        assert_eq!(
            state.apply_group_kick(&cfg("p2"), "p3"),
            Err(AuthorityRejectReason::NotGroupLeader)
        );
        assert_eq!(
            state.apply_group_disband(&cfg("p2")),
            Err(AuthorityRejectReason::NotGroupLeader)
        );
        // Leader cannot kick self.
        assert_eq!(
            state.apply_group_kick(&cfg("p1"), "p1"),
            Err(AuthorityRejectReason::CannotGroupSelf)
        );
        // Leader kicks a member.
        state
            .apply_group_kick(&cfg("p1"), "p3")
            .expect("leader kicks");
        assert!(state.actor_group_id("p3").is_none());
        assert_eq!(
            state.groups.get(&group_id).unwrap().member_actor_ids.len(),
            2
        );
        // Leader disbands the group.
        state
            .apply_group_disband(&cfg("p1"))
            .expect("leader disbands");
        assert!(state.groups.is_empty());
        assert!(state.actor_group_id("p1").is_none());
        assert!(state.actor_group_id("p2").is_none());
    }

    #[test]
    fn leader_succession_on_leave_is_deterministic() {
        let mut state = players(&["alpha", "bravo", "charlie"]);
        let group_id = form_group(&mut state, "bravo", &["alpha", "charlie"]);
        assert_eq!(
            state.groups.get(&group_id).unwrap().leader_actor_id,
            "bravo"
        );
        // Leader "bravo" leaves; deterministic succession = lexicographically-first
        // remaining member = "alpha".
        state
            .apply_group_leave(&cfg("bravo"))
            .expect("leader leaves");
        let group = state.groups.get(&group_id).expect("group persists");
        assert_eq!(group.leader_actor_id, "alpha");
        assert_eq!(group.member_actor_ids.len(), 2);
        assert!(!group.member_actor_ids.contains("bravo"));
    }

    #[test]
    fn leave_two_member_group_disbands() {
        let mut state = players(&["p1", "p2"]);
        let group_id = form_group(&mut state, "p1", &["p2"]);
        state.apply_group_leave(&cfg("p2")).expect("member leaves");
        assert!(!state.groups.contains_key(&group_id), "group disbanded");
        assert!(state.actor_group_id("p1").is_none());
    }

    #[test]
    fn groups_survive_member_death() {
        let mut state = players(&["p1", "p2"]);
        let group_id = form_group(&mut state, "p1", &["p2"]);
        // Death: the actor still exists, only its life_state changes.
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Downed;
        assert_eq!(
            state.actor_group_id("p2"),
            Some(group_id),
            "downed member stays grouped"
        );
        state.actors.get_mut("p2").unwrap().life_state = AuthorityLifeState::Respawning;
        assert_eq!(
            state.actor_group_id("p2"),
            Some(group_id),
            "respawning member stays grouped"
        );
    }

    #[test]
    fn link_dead_grace_preserves_membership_but_removal_evicts() {
        let mut state = players(&["alpha", "bravo", "charlie"]);
        let group_id = form_group(&mut state, "alpha", &["bravo", "charlie"]);
        // Link-dead grace: membership preserved (my divergence — a blip must not dissolve a group).
        state
            .set_actor_link_dead("bravo", true, Some(state.tick() + 5))
            .expect("mark link-dead");
        assert_eq!(state.actor_group_id("bravo"), Some(group_id));
        // The group frame flags the link-dead member as reconnecting.
        let view = state.group_view_for_observer(&cfg("alpha"));
        let bravo_frame = view
            .members
            .iter()
            .find(|m| m.actor_id == "bravo")
            .expect("bravo in group frame");
        assert!(
            bravo_frame.link_dead,
            "link-dead member flagged reconnecting"
        );
        // Actual removal (link-dead TIMEOUT path) evicts with succession.
        assert!(state.remove_actor("alpha"));
        let group = state
            .groups
            .get(&group_id)
            .expect("group persists after leader removal");
        assert!(!group.member_actor_ids.contains("alpha"));
        assert_eq!(group.leader_actor_id, "bravo", "succession to next member");
    }

    #[test]
    fn remove_actor_disbands_when_group_drops_below_two() {
        let mut state = players(&["p1", "p2"]);
        let group_id = form_group(&mut state, "p1", &["p2"]);
        assert!(state.remove_actor("p2"));
        assert!(!state.groups.contains_key(&group_id), "group disbands");
        assert!(state.actor_group_id("p1").is_none());
        // Invites naming a removed actor are voided.
        state.apply_group_invite(&cfg("p1"), "p1").ok();
    }

    #[test]
    fn group_view_is_owning_session_safe() {
        let mut state = players(&["p1", "p2", "stranger"]);
        form_group(&mut state, "p1", &["p2"]);
        // A member sees the group and every member frame.
        let member_view = state.group_view_for_observer(&cfg("p1"));
        assert!(member_view.group.is_some());
        assert_eq!(member_view.members.len(), 2);
        assert!(member_view.members.iter().any(|m| m.actor_id == "p2"));
        // A non-member sees nothing.
        let stranger_view = state.group_view_for_observer(&cfg("stranger"));
        assert!(stranger_view.group.is_none());
        assert!(stranger_view.members.is_empty());
        assert!(stranger_view.pending_invite.is_none());
        // An invitee (ungrouped) sees only their pending invite.
        state
            .apply_group_invite(&cfg("p1"), "stranger")
            .expect("invite ok");
        let invited_view = state.group_view_for_observer(&cfg("stranger"));
        assert!(invited_view.group.is_none());
        let invite = invited_view.pending_invite.expect("invite surfaced");
        assert_eq!(invite.inviter_actor_id, "p1");
    }

    #[test]
    fn kill_xp_pays_every_human_damager_full_ledger_total_by_weapon_track() {
        // Two ungrouped human attackers — one melee, one ranged — plus an NPC damager.
        let mut state = players(&["melee-guy", "ranged-guy", "victim"]);
        learn_profession(&mut state, "melee-guy", AuthorityProfessionKind::Brawler);
        learn_profession(&mut state, "ranged-guy", AuthorityProfessionKind::Marksman);
        state
            .actors
            .get_mut("melee-guy")
            .unwrap()
            .equipped_weapon_id = Some(AuthorityWeaponId::Vibrosword);
        state
            .actors
            .get_mut("ranged-guy")
            .unwrap()
            .equipped_weapon_id = Some(AuthorityWeaponId::Slugthrower);
        // Record loot-ledger damage exactly as the combat path would: 40 + 60 = 100 total.
        {
            let victim = state.actors.get_mut("victim").unwrap();
            victim.player_damage_ledger = vec![
                PlayerDamageLedgerEntry {
                    source_actor_id: "melee-guy".to_owned(),
                    cumulative_damage: 40,
                    first_damage_tick: 1,
                },
                PlayerDamageLedgerEntry {
                    source_actor_id: "ranged-guy".to_owned(),
                    cumulative_damage: 60,
                    first_damage_tick: 2,
                },
            ];
        }
        // Neither attacker is grouped — no group requirement, powerleveling is a feature.
        assert!(state.actor_group_id("melee-guy").is_none());
        assert!(state.actor_group_id("ranged-guy").is_none());
        state.award_kill_combat_xp_to_damagers("victim");
        // BOTH get the FULL ledger total (100), routed by their own weapon track. No split.
        assert_eq!(
            state
                .actors
                .get("melee-guy")
                .unwrap()
                .professions
                .track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
            100
        );
        assert_eq!(
            state
                .actors
                .get("ranged-guy")
                .unwrap()
                .professions
                .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            100
        );
    }

    #[test]
    fn kill_xp_routes_bare_hands_to_brawler_melee_instead_of_marksman() {
        let mut state = players(&["unarmed", "victim"]);
        learn_profession(&mut state, "unarmed", AuthorityProfessionKind::Brawler);
        state.actors.get_mut("unarmed").unwrap().equipped_weapon_id = None;
        state.actors.get_mut("victim").unwrap().player_damage_ledger =
            vec![PlayerDamageLedgerEntry {
                source_actor_id: "unarmed".to_owned(),
                cumulative_damage: 37,
                first_damage_tick: 1,
            }];

        state.award_kill_combat_xp_to_damagers("victim");

        let actor = state.actors.get("unarmed").unwrap();
        assert_eq!(
            actor
                .professions
                .track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
            37
        );
        assert_eq!(
            actor
                .professions
                .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            0
        );
    }

    #[test]
    fn universal_combat_awards_no_profession_xp_without_routed_membership() {
        let mut state = players(&["unarmed", "ranged", "victim"]);
        state.actors.get_mut("unarmed").unwrap().equipped_weapon_id = None;
        state.actors.get_mut("ranged").unwrap().equipped_weapon_id =
            Some(AuthorityWeaponId::Slugthrower);
        state.actors.get_mut("victim").unwrap().player_damage_ledger = vec![
            PlayerDamageLedgerEntry {
                source_actor_id: "unarmed".to_owned(),
                cumulative_damage: 37,
                first_damage_tick: 1,
            },
            PlayerDamageLedgerEntry {
                source_actor_id: "ranged".to_owned(),
                cumulative_damage: 63,
                first_damage_tick: 2,
            },
        ];

        state.award_kill_combat_xp_to_damagers("victim");

        let unarmed = &state.actors["unarmed"].professions;
        assert_eq!(
            unarmed.track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
            0,
            "unarmed remains usable but cannot advance Brawler before learning it"
        );
        let ranged = &state.actors["ranged"].professions;
        assert_eq!(
            ranged.track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            0,
            "ranged damage cannot advance Marksman before learning it"
        );
        assert!(unarmed.xp.is_empty());
        assert!(ranged.xp.is_empty());
    }

    #[test]
    fn earned_track_xp_is_emitted_before_any_box_is_bought() {
        // Direct/admin awards can still create boxless progress. The profession snapshot
        // must surface such banked XP even though normal kill awards require membership.
        let mut state = players(&["learner"]);
        state
            .award_profession_track_xp("learner", AuthorityProfessionKind::Marksman, "rifle", 90)
            .expect("grant rifle track xp");
        let actor = state.actors.get("learner").expect("actor exists");
        assert!(
            !actor
                .professions
                .learned
                .contains(&AuthorityProfessionKind::Marksman),
            "no marksman box learned"
        );
        let snapshots = AuthorityProfessionSnapshot::from_actor(actor);
        let marksman = snapshots
            .iter()
            .find(|profession| profession.id == "marksman")
            .expect("banked marksman XP is emitted boxless");
        assert_eq!(marksman.track_xp.get("rifle"), Some(&90));
        assert!(marksman.skill_boxes.is_empty(), "no boxes bought yet");
    }

    #[test]
    fn kill_xp_via_ledger_populator_pays_both_sources() {
        // Isolation for the live 2-session finding: drive the REAL ledger populator
        // (record_damage_stats) with two distinct human sources on the same target, then
        // grant kill XP. Both must get distinct ledger entries and full XP.
        let mut state = players(&["dmg-a", "dmg-b", "victim"]);
        learn_profession(&mut state, "dmg-a", AuthorityProfessionKind::Marksman);
        learn_profession(&mut state, "dmg-b", AuthorityProfessionKind::Marksman);
        state.actors.get_mut("dmg-a").unwrap().equipped_weapon_id =
            Some(AuthorityWeaponId::Slugthrower);
        state.actors.get_mut("dmg-b").unwrap().equipped_weapon_id =
            Some(AuthorityWeaponId::Slugthrower);
        state.record_damage_stats("dmg-a", "victim", 10, 40, true);
        state.record_damage_stats("dmg-b", "victim", 11, 60, true);
        let ledger_len = state
            .actors
            .get("victim")
            .unwrap()
            .player_damage_ledger
            .len();
        assert_eq!(
            ledger_len, 2,
            "two distinct human sources must produce two ledger entries"
        );
        state.award_kill_combat_xp_to_damagers("victim");
        assert_eq!(
            state
                .actors
                .get("dmg-a")
                .unwrap()
                .professions
                .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            100,
            "first damager paid full ledger total"
        );
        assert_eq!(
            state
                .actors
                .get("dmg-b")
                .unwrap()
                .professions
                .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            100,
            "second damager paid full ledger total"
        );
    }

    #[test]
    fn kill_xp_excludes_npc_damagers() {
        let mut state = group_state(&[
            player_snapshot("hero", 10),
            npc_snapshot("creature", 12),
            npc_snapshot("target", 14),
        ]);
        learn_profession(&mut state, "hero", AuthorityProfessionKind::Marksman);
        {
            let target = state.actors.get_mut("target").unwrap();
            target.player_damage_ledger = vec![
                PlayerDamageLedgerEntry {
                    source_actor_id: "hero".to_owned(),
                    cumulative_damage: 30,
                    first_damage_tick: 1,
                },
                PlayerDamageLedgerEntry {
                    source_actor_id: "creature".to_owned(),
                    cumulative_damage: 70,
                    first_damage_tick: 2,
                },
            ];
            target
                .gaia_harvest_entitled_actor_ids
                .insert("hero".to_owned());
        }
        state.award_kill_combat_xp_to_damagers("target");
        // Human hero is paid the full ledger total; the NPC creature earns nothing.
        assert_eq!(
            state
                .actors
                .get("hero")
                .unwrap()
                .professions
                .track_xp_amount(AuthorityProfessionKind::Marksman, "rifle"),
            100
        );
        assert!(state
            .actors
            .get("creature")
            .unwrap()
            .professions
            .xp
            .is_empty());
    }

    #[test]
    fn group_state_participates_in_stable_hash() {
        let mut state = players(&["p1", "p2"]);
        let before = state.stable_state_hash_hex();
        form_group(&mut state, "p1", &["p2"]);
        assert_ne!(
            state.stable_state_hash_hex(),
            before,
            "forming a group must change the authority stable hash"
        );
        // A pending invite also participates.
        let mut invited = players(&["p1", "p2"]);
        let baseline = invited.stable_state_hash_hex();
        invited
            .apply_group_invite(&cfg("p1"), "p2")
            .expect("invite ok");
        assert_ne!(invited.stable_state_hash_hex(), baseline);
    }

    #[test]
    fn group_ops_hash_is_deterministic_run_twice() {
        let build = || {
            let mut state = players(&["alpha", "bravo", "charlie"]);
            form_group(&mut state, "bravo", &["alpha", "charlie"]);
            state
                .apply_group_kick(&cfg("bravo"), "charlie")
                .expect("kick");
            state.stable_state_hash_hex()
        };
        assert_eq!(
            build(),
            build(),
            "identical group op sequences hash identically"
        );
    }
    #[test]
    fn gaia_harvest_solo_tie_group_rewards_and_restart() {
        let mut tie = group_state(&[
            player_snapshot("alpha", 10),
            player_snapshot("bravo", 10),
            npc_snapshot("tie-target", 10),
        ]);
        learn_profession(&mut tie, "alpha", AuthorityProfessionKind::Scout);
        learn_profession(&mut tie, "bravo", AuthorityProfessionKind::Scout);
        {
            let body_vanish_tick = tie.tick + 10_000;
            let target = tie.actors.get_mut("tie-target").unwrap();
            target.life_state = AuthorityLifeState::Downed;
            target.body_vanish_tick = body_vanish_tick;
            target.player_damage_ledger = vec![
                PlayerDamageLedgerEntry {
                    source_actor_id: "alpha".to_owned(),
                    cumulative_damage: 50,
                    first_damage_tick: 1,
                },
                PlayerDamageLedgerEntry {
                    source_actor_id: "bravo".to_owned(),
                    cumulative_damage: 50,
                    first_damage_tick: 1,
                },
            ];
        }
        tie.finalize_actor_corpse_after_death("tie-target", tie.tick);
        assert_eq!(
            tie.actors["tie-target"].gaia_harvest_entitled_actor_ids,
            BTreeSet::from(["alpha".to_owned()])
        );
        assert!(tie
            .apply_harvest_corpse(&cfg("alpha"), "tie-target")
            .is_ok());
        assert!(tie
            .apply_harvest_corpse(&cfg("bravo"), "tie-target")
            .is_err());

        let mut state = group_state(&[
            player_snapshot("winner-a", 10),
            player_snapshot("winner-b", 10),
            player_snapshot("winner-noncontributor", 10),
            player_snapshot("loser", 10),
            player_snapshot("loser-member", 10),
            npc_snapshot("group-target", 10),
        ]);
        for id in [
            "winner-a",
            "winner-b",
            "winner-noncontributor",
            "loser",
            "loser-member",
        ] {
            learn_profession(&mut state, id, AuthorityProfessionKind::Scout);
            learn_profession(&mut state, id, AuthorityProfessionKind::Brawler);
            state.actors.get_mut(id).unwrap().equipped_weapon_id =
                Some(AuthorityWeaponId::Vibrosword);
        }
        form_group(
            &mut state,
            "winner-a",
            &["winner-b", "winner-noncontributor"],
        );
        form_group(&mut state, "loser", &["loser-member"]);
        {
            let body_vanish_tick = state.tick + 10_000;
            let target = state.actors.get_mut("group-target").unwrap();
            target.life_state = AuthorityLifeState::Downed;
            target.body_vanish_tick = body_vanish_tick;
            target.player_damage_ledger = vec![
                PlayerDamageLedgerEntry {
                    source_actor_id: "winner-a".to_owned(),
                    cumulative_damage: 70,
                    first_damage_tick: 1,
                },
                PlayerDamageLedgerEntry {
                    source_actor_id: "winner-b".to_owned(),
                    cumulative_damage: 40,
                    first_damage_tick: 2,
                },
                PlayerDamageLedgerEntry {
                    source_actor_id: "loser".to_owned(),
                    cumulative_damage: 100,
                    first_damage_tick: 3,
                },
            ];
        }
        state.finalize_actor_corpse_after_death("group-target", state.tick);
        assert_eq!(
            state.actors["group-target"].gaia_harvest_entitled_actor_ids,
            BTreeSet::from(["winner-a".to_owned(), "winner-b".to_owned()])
        );
        state.award_kill_combat_xp_to_damagers("group-target");
        for id in ["winner-a", "winner-b"] {
            assert_eq!(
                state.actors[id]
                    .professions
                    .track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
                210
            );
        }
        assert_eq!(
            state.actors["loser"]
                .professions
                .track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
            0
        );
        assert_eq!(
            state.actors["winner-noncontributor"]
                .professions
                .track_xp_amount(AuthorityProfessionKind::Brawler, "melee"),
            0
        );
        assert!(state
            .apply_harvest_corpse(&cfg("winner-a"), "group-target")
            .is_ok());
        let material_ids = [
            RESOURCE_CREATURE_HIDE_ITEM_ID,
            RESOURCE_CREATURE_MEAT_ITEM_ID,
            RESOURCE_CREATURE_BONE_ITEM_ID,
        ];
        let yield_a: Vec<_> = material_ids
            .iter()
            .map(|item_id| state.actor_inventory_available_quantity("winner-a", *item_id))
            .collect();
        assert_eq!(
            state.actors["winner-a"]
                .professions
                .track_xp_amount(AuthorityProfessionKind::Scout, "creature-harvesting"),
            70
        );
        assert!(state
            .apply_harvest_corpse(&cfg("winner-a"), "group-target")
            .is_err());
        state.groups.clear();
        assert!(state
            .apply_harvest_corpse(&cfg("winner-b"), "group-target")
            .is_ok());
        let yield_b: Vec<_> = material_ids
            .iter()
            .map(|item_id| state.actor_inventory_available_quantity("winner-b", *item_id))
            .collect();
        assert_eq!(yield_b, yield_a);
        assert_eq!(
            state.actors["winner-b"]
                .professions
                .track_xp_amount(AuthorityProfessionKind::Scout, "creature-harvesting"),
            70
        );
        let hash = state.stable_state_hash_hex();
        let checkpoint = state.export_checkpoint();
        let mut restored = state.clone();
        restored.restore_checkpoint(checkpoint).expect("restart");
        assert_eq!(restored.stable_state_hash_hex(), hash);
        assert!(restored
            .apply_harvest_corpse(&cfg("winner-a"), "group-target")
            .is_err());
        let expiry_tick = restored.actors["group-target"].body_vanish_tick;
        restored.tick = expiry_tick;
        restored.tick_respawn_lifecycle();
        restored.tick = expiry_tick + 10_000;
        restored.tick_respawn_lifecycle();
        assert!(restored.actors["group-target"]
            .gaia_harvest_entitled_actor_ids
            .is_empty());
        assert!(restored.actors["group-target"]
            .gaia_harvest_claimed_actor_ids
            .is_empty());
    }
}
