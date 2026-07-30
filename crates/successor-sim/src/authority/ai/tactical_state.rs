use super::*;

impl SliceAuthorityState {
    pub(in crate::authority) fn actor_faction_id<'a>(
        &self,
        actor: &'a ActorAuthorityState,
    ) -> Option<&'a str> {
        actor
            .faction
            .faction_id
            .as_deref()
            .filter(|faction_id| self.runtime.durable.world.factions.contains(faction_id))
    }

    pub(in crate::authority) fn faction_relationship(
        &self,
        left: &ActorAuthorityState,
        right: &ActorAuthorityState,
    ) -> FactionRelationship {
        self.runtime
            .durable
            .world
            .factions
            .relationship(&left.faction, &right.faction)
    }

    pub(in crate::authority) fn can_actor_attack(
        &self,
        attacker: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        if attacker.id == target.id {
            return false;
        }
        if same_player_organization(attacker, target) {
            return false;
        }
        // DEF-10: non-combat civilians (trainers, vendors, shopkeepers, ...) are
        // never a valid target for AI or queued Roll combat.
        if is_noncombat_civilian_actor(target) {
            return false;
        }
        // Consent-scoped PvP: human-vs-human damage is permitted ONLY inside an
        // active duel pair. This SCOPES the previously-open human PvP (a human
        // attacker used to be able to hit any actor). NPC and faction combat are
        // unchanged, and a human may still freely engage non-human actors below.
        if is_human_player_actor(attacker) && is_human_player_actor(target) {
            return self.actors_in_active_duel(&attacker.id, &target.id);
        }
        // A hostile procedural humanoid is an explicit combat attitude, not a
        // faction-table hint. Faction data may be intentionally neutral (for
        // authored encounters and old snapshots), but retaliation must still
        // be legal after that actor is provoked.
        if !is_human_player_actor(attacker)
            && is_human_player_actor(target)
            && matches!(
                attacker.ai.as_ref(),
                Some(AuthorityAiState::Skirmisher(ai))
                    if ai.attitude == NpcAiAttitude::Hostile
            )
        {
            return true;
        }
        // First-wave Gaia danger: engaged wildlife may strike the focused living
        // human player even though Gaia faction relations are otherwise neutral.
        if is_passive_creature_actor(attacker)
            && is_human_player_actor(target)
            && matches!(
                attacker.ai.as_ref(),
                Some(AuthorityAiState::PassiveCreature(ai))
                    if ai.mode == PassiveCreatureMode::Engage
                        && ai.threat_actor_id.as_deref() == Some(target.id.as_str())
            )
        {
            return true;
        }
        if self.runtime.durable.world.factions.len() == 0 {
            return true;
        }
        if is_human_player_actor(attacker) {
            return true;
        }
        match self.faction_relationship(attacker, target) {
            FactionRelationship::Same
            | FactionRelationship::Ally
            | FactionRelationship::Neutral => false,
            FactionRelationship::Enemy => true,
        }
    }

    pub(in crate::authority) fn build_skirmisher_tactical_state(&self) -> SkirmisherTacticalState {
        let mut groups = BTreeMap::<(String, String), Vec<ActorAuthorityState>>::new();
        for actor in self.runtime.durable.actors.values() {
            if actor.life_state != AuthorityLifeState::Alive
                || actor.sleep.remaining_ticks > 0
                || !actor_requires_skirmisher_tactical_apparatus(actor)
            {
                continue;
            }
            let Some(faction) = self.actor_faction_id(actor) else {
                continue;
            };
            groups
                .entry((actor.area_id.clone(), faction.to_owned()))
                .or_default()
                .push(actor.clone());
        }

        let mut by_actor = BTreeMap::new();
        let mut squads_debug = Vec::new();
        for ((area_id, faction), mut members) in groups.clone() {
            members.sort_by(|left, right| left.id.cmp(&right.id));
            let Some(squad_anchor) = members.first() else {
                continue;
            };
            let enemies = self
                .runtime
                .durable
                .actors
                .values()
                .filter(|enemy| enemy.id != squad_anchor.id)
                .filter(|enemy| enemy.area_id == area_id)
                .filter(|enemy| enemy.life_state == AuthorityLifeState::Alive)
                .filter(|enemy| enemy.sleep.remaining_ticks == 0)
                .filter(|enemy| self.can_actor_attack(squad_anchor, enemy))
                .filter(|enemy| actor_counts_as_squad_combat_threat(enemy))
                .cloned()
                .collect::<Vec<_>>();
            let center = average_actor_position(&members);
            let enemy_center = (!enemies.is_empty()).then(|| average_actor_position(&enemies));
            let (direction_x_milli, direction_y_milli) = enemy_center
                .and_then(|enemy| {
                    normalize_components_milli(enemy.x - center.x, enemy.y - center.y)
                })
                .unwrap_or_else(|| direction_vector_from_name(&members[0].direction));
            let lateral_x_milli = -direction_y_milli;
            let lateral_y_milli = direction_x_milli;
            let member_count_i32 = i32::try_from(members.len()).unwrap_or(i32::MAX / 4);
            let enemy_width =
                projected_actor_width_milli(&enemies, center, lateral_x_milli, lateral_y_milli);
            let member_width =
                projected_actor_width_milli(&members, center, lateral_x_milli, lateral_y_milli);
            let front_width_milli = enemy_width
                .max(member_width)
                .max(member_count_i32.saturating_mul(SKIRMISHER_LANE_WIDTH_MILLI_CELLS))
                .max(SKIRMISHER_LANE_WIDTH_MILLI_CELLS);
            let no_mans_land = enemy_center.map(|enemy| AuthorityPosition {
                x: center.x.saturating_add((enemy.x - center.x) / 2),
                y: center.y.saturating_add((enemy.y - center.y) / 2),
            });
            let strength_milli = members
                .iter()
                .map(skirmisher_actor_strength_milli)
                .sum::<i32>();
            let enemy_strength_milli = enemies
                .iter()
                .map(skirmisher_enemy_pressure_strength_milli)
                .sum::<i32>();
            let confidence = skirmisher_confidence(strength_milli, enemy_strength_milli);
            let order = skirmisher_order_for_confidence(confidence);
            let squad_id = format!("{}:{}", area_id, faction);
            let mut lanes = BTreeMap::new();
            let lane_count = members.len().max(1);
            for (index, member) in members.iter().enumerate() {
                let lane_center = lane_center_offset_milli(index, lane_count, front_width_milli);
                lanes.insert(
                    member.id.clone(),
                    SkirmisherLaneAssignment {
                        lane_index: index,
                        lane_count,
                        center_offset_milli: lane_center,
                        min_offset_milli: lane_center - SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
                        max_offset_milli: lane_center + SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
                    },
                );
            }
            let tactics = SkirmisherSquadTactics {
                squad_id: squad_id.clone(),
                area_id: area_id.clone(),
                faction: faction.clone(),
                members: members.iter().map(|actor| actor.id.clone()).collect(),
                enemy_count: enemies.len(),
                center,
                enemy_center,
                direction_x_milli,
                direction_y_milli,
                lateral_x_milli,
                lateral_y_milli,
                front_width_milli,
                no_mans_land,
                confidence,
                order,
                strength_milli,
                enemy_strength_milli,
                lanes: lanes.clone(),
            };
            squads_debug.push(authority_ai_squad_debug_snapshot(
                AuthorityAiSquadDebugSnapshotRequest {
                    squad_id: squad_id.clone(),
                    area_id: area_id.clone(),
                    faction: faction.clone(),
                    order: order.label().to_owned(),
                    confidence: confidence.label().to_owned(),
                    member_count: members.len(),
                    enemy_count: enemies.len(),
                    center: authority_ai_debug_position_from_position(center),
                    enemy_center: enemy_center.map(authority_ai_debug_position_from_position),
                    direction_x_milli,
                    direction_y_milli,
                    front_width_milli,
                    no_mans_land: no_mans_land.map(authority_ai_debug_position_from_position),
                    strength_milli,
                    enemy_strength_milli,
                },
            ));
            for member in members {
                by_actor.insert(
                    member.id.clone(),
                    SkirmisherActorTacticalContext {
                        squad: tactics.clone(),
                        lane: lanes.get(&member.id).cloned(),
                    },
                );
            }
        }

        SkirmisherTacticalState {
            by_actor,
            reservations: self.skirmisher_reservations(),
            squads_debug,
        }
    }

    pub(in crate::authority) fn skirmisher_reservations(&self) -> SkirmisherReservations {
        let mut claims = Vec::new();
        for actor in self.runtime.durable.actors.values() {
            if actor.life_state != AuthorityLifeState::Alive || !actor_uses_combat_tactics(actor) {
                continue;
            }
            claims.push(SkirmisherPositionClaim {
                actor_id: actor.id.clone(),
                area_id: actor.area_id.clone(),
                position: actor.position,
            });
            let planned_position = match actor.ai.as_ref() {
                Some(AuthorityAiState::Skirmisher(ai)) => ai.cover.or(ai.target),
                _ => None,
            };
            if let Some(position) = planned_position {
                claims.push(SkirmisherPositionClaim {
                    actor_id: actor.id.clone(),
                    area_id: actor.area_id.clone(),
                    position,
                });
            }
        }
        SkirmisherReservations { claims }
    }

    pub(in crate::authority) fn combat_situation_for_actor(
        &self,
        actor: &ActorAuthorityState,
        ai: Option<&SkirmisherAiState>,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        target: Option<&ActorAuthorityState>,
    ) -> CombatSituationSnapshot {
        let friendly_strength_milli = context
            .map(|ctx| ctx.squad.strength_milli)
            .unwrap_or_else(|| skirmisher_actor_strength_milli(actor));
        let enemy_strength_milli = context
            .map(|ctx| ctx.squad.enemy_strength_milli)
            .unwrap_or_else(|| target.map_or(0, skirmisher_enemy_pressure_strength_milli));
        let health_percent_milli = i64::from(actor.vitals.health.max(0)).saturating_mul(1_000)
            / i64::from(actor.max_vitals.health.max(1));
        let incoming_fire = actor.suppression.pressure_milli > 0;
        let recently_damaged = actor.stats.last_damage_taken_tick.is_some_and(|tick| {
            self.runtime.durable.tick.saturating_sub(tick)
                <= u64::from(self.runtime.durable.world.tick_rate_hz.max(1)).saturating_mul(3)
        });
        let has_current_shot =
            target.is_some_and(|target| self.skirmisher_can_fire_at(actor, target, profile));
        let protected_by_cover = target.is_some_and(|target| {
            self.actor_position_protected_from_threat(actor, actor.position, target.position)
                || ai.and_then(|ai| ai.cover).is_some_and(|cover| {
                    self.actor_position_protected_from_threat(actor, cover, target.position)
                })
        });
        let squad_order = context
            .map(|ctx| combat_squad_order_hint(ctx.squad.order))
            .unwrap_or(CombatSquadOrderHint::None);
        let distance_to_squad_center_milli = context
            .map(|ctx| position_distance_milli(actor.position, ctx.squad.center))
            .unwrap_or(0);
        let squad_cohesion_radius_milli = context
            .map(|ctx| {
                ctx.squad
                    .front_width_milli
                    .max(SKIRMISHER_LANE_WIDTH_MILLI_CELLS.saturating_mul(2))
            })
            .unwrap_or_else(|| SKIRMISHER_LANE_WIDTH_MILLI_CELLS.saturating_mul(2));
        let (nearby_friendly_count, nearby_hostile_count) =
            self.combat_situation_nearby_counts(actor, 12_000);
        let stalled_ticks = ai
            .and_then(|ai| {
                ai.target
                    .filter(|target| {
                        position_distance_milli(actor.position, *target)
                            > SKIRMISHER_COVER_REACHED_MILLI_CELLS
                    })
                    .map(|_| {
                        if ai.last_move_tick == 0 {
                            0
                        } else {
                            self.runtime.durable.tick.saturating_sub(ai.last_move_tick)
                        }
                    })
            })
            .unwrap_or(0);

        assess_combat_situation(CombatSituationRequest {
            friendly_strength_milli,
            enemy_strength_milli,
            health_percent_milli: health_percent_milli.clamp(0, 1_000) as i32,
            suppression_pressure_milli: actor.suppression.pressure_milli,
            cover_pressure_milli: profile.cover_pressure_milli,
            incoming_fire,
            recently_damaged,
            has_current_shot,
            protected_by_cover,
            squad_order,
            distance_to_squad_center_milli,
            squad_cohesion_radius_milli,
            nearby_friendly_count,
            nearby_hostile_count,
            stalled_ticks,
        })
    }

    pub(in crate::authority) fn combat_situation_nearby_counts(
        &self,
        actor: &ActorAuthorityState,
        radius_milli: i32,
    ) -> (usize, usize) {
        let mut nearby_friendly_count = 0;
        let mut nearby_hostile_count = 0;
        for candidate in self.runtime.durable.actors.values() {
            if candidate.id == actor.id
                || candidate.area_id != actor.area_id
                || candidate.life_state != AuthorityLifeState::Alive
                || candidate.sleep.remaining_ticks > 0
                || position_distance_milli(actor.position, candidate.position) > radius_milli
            {
                continue;
            }
            if self.can_actor_attack(actor, candidate)
                && skirmisher_enemy_applies_ranged_pressure(candidate)
            {
                nearby_hostile_count += 1;
            } else if actor_uses_combat_tactics(candidate)
                && matches!(
                    self.faction_relationship(actor, candidate),
                    FactionRelationship::Same | FactionRelationship::Ally
                )
            {
                nearby_friendly_count += 1;
            }
        }
        (nearby_friendly_count, nearby_hostile_count)
    }

    pub(in crate::authority) fn update_combat_position_claims(
        &self,
        actor_id: &str,
        claim: Option<AuthorityPosition>,
        reservations: &mut SkirmisherReservations,
    ) {
        reservations
            .claims
            .retain(|existing| existing.actor_id != actor_id);
        if let Some(actor) = self.runtime.durable.actors.get(actor_id) {
            reservations.claims.push(SkirmisherPositionClaim {
                actor_id: actor.id.clone(),
                area_id: actor.area_id.clone(),
                position: actor.position,
            });
            if let Some(position) = claim {
                reservations.claims.push(SkirmisherPositionClaim {
                    actor_id: actor.id.clone(),
                    area_id: actor.area_id.clone(),
                    position,
                });
            }
        }
    }
}

fn same_player_organization(left: &ActorAuthorityState, right: &ActorAuthorityState) -> bool {
    matches!(
        (
            left.player_organization_id.as_deref(),
            right.player_organization_id.as_deref(),
        ),
        (Some(left_org), Some(right_org)) if left_org == right_org
    )
}
