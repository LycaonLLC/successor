use super::swept_circle::{
    circle_intersects_aabb, resolve_circle_move_milli, CircleAabb, CirclePoint,
    CIRCLE_COLLISION_RADIUS_MILLI,
};
use super::*;

impl SliceAuthorityState {
    pub(super) fn ai_position_blocked(&self, area_id: &str, position: AuthorityPosition) -> bool {
        self.position_blocked(area_id, position)
    }

    pub(super) fn position_blocked(&self, area_id: &str, position: AuthorityPosition) -> bool {
        let cell = position.cell();
        self.runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(area_id, cell.x, cell.y))
            || self.circle_position_blocked(area_id, position)
    }

    pub(super) fn clamped_unblocked_player_position(
        &self,
        area_id: &str,
        current: AuthorityPosition,
        requested: AuthorityPosition,
        area: &AreaAuthorityState,
    ) -> AuthorityPosition {
        let mut blockers = self.circle_blockers_for_area(area_id);
        self.push_blocked_cell_circle_blockers(area_id, &mut blockers);
        self.clamped_unblocked_player_position_with_blockers(current, requested, area, &blockers)
    }

    fn clamped_unblocked_player_position_with_blockers(
        &self,
        current: AuthorityPosition,
        requested: AuthorityPosition,
        area: &AreaAuthorityState,
        blockers: &[CircleAabb],
    ) -> AuthorityPosition {
        let target = requested.clamp_to_area(area);
        if target == current {
            return target;
        }
        let delta_x = (i64::from(target.x) - i64::from(current.x))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let delta_y = (i64::from(target.y) - i64::from(current.y))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let current_center = ground_center_from_anchor(current);
        let resolved_center = resolve_circle_move_milli(
            CirclePoint {
                x: current_center.x,
                y: current_center.y,
            },
            delta_x,
            delta_y,
            CIRCLE_COLLISION_RADIUS_MILLI,
            blockers,
        );
        anchor_from_ground_center(AuthorityPosition {
            x: resolved_center.x,
            y: resolved_center.y,
        })
        .clamp_to_area(area)
    }

    pub(super) fn tick_player_move_intents(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .iter()
            .filter_map(|(actor_id, actor)| actor.move_intent.map(|_| actor_id.clone()))
            .collect::<Vec<_>>();
        let mut blockers_by_area = BTreeMap::new();
        for actor_id in &actor_ids {
            let Some(area_id) = self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .map(|actor| actor.area_id.clone())
            else {
                continue;
            };
            blockers_by_area.entry(area_id.clone()).or_insert_with(|| {
                let mut blockers = self.circle_blockers_for_area(&area_id);
                self.push_blocked_cell_circle_blockers(&area_id, &mut blockers);
                blockers
            });
        }
        for actor_id in actor_ids {
            let blockers = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .and_then(|actor| blockers_by_area.get(&actor.area_id))
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            self.tick_player_move_intent(&actor_id, blockers);
        }
    }

    fn tick_player_move_intent(&mut self, actor_id: &str, blockers: &[CircleAabb]) {
        let Some(intent) = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .and_then(|actor| actor.move_intent)
        else {
            return;
        };
        if self.runtime.durable.tick > intent.expires_tick {
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                actor.move_intent = None;
            }
            return;
        }
        if intent.dx == 0 && intent.dy == 0 {
            return;
        }
        let Some(actor_snapshot) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return;
        };
        if actor_snapshot.life_state != AuthorityLifeState::Alive
            || actor_snapshot.sleep.remaining_ticks > 0
            || actor_snapshot.posture != AuthorityActorPosture::Standing
        {
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                actor.move_intent = None;
            }
            return;
        }
        let Some(area) = self
            .runtime
            .durable
            .world
            .areas
            .get(&actor_snapshot.area_id)
        else {
            return;
        };
        let duration_ticks = 1;
        let sprint_cost_milli = actor_sprint_action_cost_milli(
            &actor_snapshot,
            duration_ticks,
            self.runtime.durable.world.tick_rate_hz,
        );
        let sprint_available_milli = actor_snapshot
            .vitals
            .action
            .max(0)
            .saturating_mul(1_000)
            .saturating_sub(actor_snapshot.sprint_action_drain_milli.max(0));
        let sprinting = intent.sprint
            && is_player_like_role(&actor_snapshot.role)
            && !actor_snapshot.sprint_recovery_locked
            && sprint_available_milli >= sprint_cost_milli;
        let sprint_exhausted = intent.sprint
            && is_player_like_role(&actor_snapshot.role)
            && !actor_snapshot.sprint_recovery_locked
            && sprint_available_milli < sprint_cost_milli;
        let movement_multiplier_milli = if sprinting {
            scaled_milli(
                movement_speed_multiplier_milli_for_actor(&actor_snapshot),
                scaled_milli(
                    SPRINT_SPEED_MULTIPLIER_MILLI,
                    sprint_speed_multiplier_milli_for_actor(&actor_snapshot),
                ),
            )
        } else {
            movement_speed_multiplier_milli_for_actor(&actor_snapshot)
        };
        let distance_milli = movement_distance_milli(
            duration_ticks,
            self.runtime.durable.world.tick_rate_hz,
            movement_multiplier_milli,
        );
        let requested_position =
            actor_snapshot
                .position
                .offset(intent.dx, intent.dy, distance_milli);
        let target_position = self.clamped_unblocked_player_position_with_blockers(
            actor_snapshot.position,
            requested_position,
            area,
            blockers,
        );
        let moved_milli = position_distance_milli(actor_snapshot.position, target_position);
        let target = target_position.cell();
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return;
        };
        actor.direction = intent
            .facing
            .map(|direction| cardinal_direction_delta(direction).2)
            .unwrap_or_else(|| direction_for_delta(intent.dx, intent.dy))
            .to_owned();
        if moved_milli == 0 {
            return;
        }
        actor.position = target_position;
        actor.cell = target;
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        actor.stats.record_distance(
            self.runtime.durable.tick,
            self.runtime.durable.world.tick_rate_hz,
            moved_milli,
        );
        actor.last_moved_tick = Some(self.runtime.durable.tick);
        if sprint_exhausted {
            actor.vitals.action = 0;
            actor.sprint_action_drain_milli = 0;
            actor.sprint_recovery_locked = true;
            actor.sprint_recovery_regen_carry = 0;
            actor.passive_regen_milli.action = 0;
        }
        if sprinting {
            let sprint_action_cost = actor_sprint_action_cost_milli(
                actor,
                duration_ticks,
                self.runtime.durable.world.tick_rate_hz,
            );
            apply_sprint_action_cost(
                actor,
                duration_ticks,
                self.runtime.durable.world.tick_rate_hz,
            );
            if actor.vitals.action <= 0 {
                actor.sprint_recovery_locked = true;
                actor.sprint_recovery_regen_carry = 0;
                actor.passive_regen_milli.action = 0;
            }
            actor.sprint_regen_block_until_tick = actor.sprint_regen_block_until_tick.max(
                self.runtime
                    .durable
                    .tick
                    .saturating_add(u64::from(duration_ticks.max(1)))
                    .saturating_add(SPRINT_REGEN_BLOCK_GRACE_TICKS),
            );
            actor.mobility.record_sprint(
                self.runtime.durable.tick,
                duration_ticks,
                moved_milli,
                sprint_action_cost,
                false,
                "player_intent",
            );
        }
        actor.next_move_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(u64::from(duration_ticks));
    }

    pub(super) fn circle_position_blocked(
        &self,
        area_id: &str,
        position: AuthorityPosition,
    ) -> bool {
        let center = ground_center_from_anchor(position);
        let center = CirclePoint {
            x: center.x,
            y: center.y,
        };
        self.circle_blockers_for_area(area_id)
            .into_iter()
            .any(|blocker| circle_intersects_aabb(center, CIRCLE_COLLISION_RADIUS_MILLI, blocker))
    }

    pub(super) fn circle_blockers_for_area(&self, area_id: &str) -> Vec<CircleAabb> {
        let mut blockers = self
            .runtime
            .durable
            .world
            .fine_collision_bounds
            .iter()
            .filter(|bounds| bounds.area_id == area_id)
            .map(|bounds| CircleAabb::new(bounds.left, bounds.top, bounds.right, bounds.bottom))
            .collect::<Vec<_>>();
        blockers.extend(
            self.runtime
                .durable
                .door_collision_bounds
                .iter()
                .filter(|bounds| bounds.area_id == area_id && !bounds.open)
                .map(|bounds| {
                    CircleAabb::new(bounds.left, bounds.top, bounds.right, bounds.bottom)
                }),
        );
        blockers.extend(self.build_circle_blockers_for_area(area_id));
        blockers
    }

    pub(super) fn push_blocked_cell_circle_blockers(
        &self,
        area_id: &str,
        blockers: &mut Vec<CircleAabb>,
    ) {
        blockers.extend(
            self.runtime
                .durable
                .world
                .blocked_cells
                .iter()
                .filter(|cell| cell.area_id == area_id)
                .map(|cell| {
                    let hit_box = cell_hit_box(cell.x, cell.y);
                    CircleAabb::new(hit_box.left, hit_box.top, hit_box.right, hit_box.bottom)
                }),
        );
    }

    pub(super) fn move_passive_creature_toward_position(
        &mut self,
        actor_id: &str,
        target: AuthorityPosition,
        max_step_milli: i32,
        mode: PassiveCreatureMode,
        seed: u32,
    ) -> bool {
        if max_step_milli <= 0 {
            return false;
        }
        let Some(actor) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return false;
        };
        let dx = target.x - actor.position.x;
        let dy = target.y - actor.position.y;
        let distance = distance_milli_components(dx, dy);
        if distance <= 1 {
            return false;
        }
        let amount = max_step_milli.min(distance);
        let mut vx = f64::from(dx) / f64::from(distance);
        let mut vy = f64::from(dy) / f64::from(distance);
        if mode == PassiveCreatureMode::Flee
            || mode == PassiveCreatureMode::Engage
            || (mode == PassiveCreatureMode::Roam
                && (self.runtime.durable.tick + u64::from(seed)) % 7 == 0)
        {
            let separation = self.passive_creature_separation_vector(&actor);
            let separation_weight = if mode == PassiveCreatureMode::Flee {
                0.35
            } else if mode == PassiveCreatureMode::Engage {
                0.15
            } else {
                0.55
            };
            vx += separation.0 * separation_weight;
            vy += separation.1 * separation_weight;
        }
        if mode == PassiveCreatureMode::Roam {
            let wiggle = ((self.runtime.durable.tick as f64 + f64::from(seed)) * 0.7).sin() * 0.24;
            vx += -f64::from(dy) / f64::from(distance) * wiggle;
            vy += f64::from(dx) / f64::from(distance) * wiggle;
        }
        let length = vx.hypot(vy).max(0.001);
        let candidate = AuthorityPosition {
            x: actor.position.x + (vx / length * f64::from(amount)).round() as i32,
            y: actor.position.y + (vy / length * f64::from(amount)).round() as i32,
        };
        self.move_ai_actor_to_position(actor_id, &actor, candidate)
    }

    pub(super) fn passive_creature_separation_vector(
        &self,
        actor: &ActorAuthorityState,
    ) -> (f64, f64) {
        let mut x = 0.0;
        let mut y = 0.0;
        for other in self.runtime.durable.actors.values() {
            if other.id == actor.id
                || other.area_id != actor.area_id
                || other.life_state != AuthorityLifeState::Alive
                || !matches!(other.ai, Some(AuthorityAiState::PassiveCreature(_)))
            {
                continue;
            }
            let dx = actor.position.x - other.position.x;
            let dy = actor.position.y - other.position.y;
            let distance = distance_milli_components(dx, dy);
            if distance <= 1 || distance > PASSIVE_CREATURE_SEPARATION_RADIUS_MILLI_CELLS {
                continue;
            }
            let force = f64::from(PASSIVE_CREATURE_SEPARATION_RADIUS_MILLI_CELLS - distance)
                / f64::from(PASSIVE_CREATURE_SEPARATION_RADIUS_MILLI_CELLS);
            x += f64::from(dx) / f64::from(distance) * force;
            y += f64::from(dy) / f64::from(distance) * force;
        }
        let length = x.hypot(y);
        if length > 0.0 {
            (x / length, y / length)
        } else {
            (0.0, 0.0)
        }
    }

    pub(super) fn move_ai_actor_toward_position(
        &mut self,
        actor_id: &str,
        target: AuthorityPosition,
        max_step_milli: i32,
    ) -> bool {
        self.move_ai_actor_toward_position_with_options(actor_id, target, max_step_milli, false)
    }

    pub(super) fn move_ai_actor_toward_position_with_options(
        &mut self,
        actor_id: &str,
        target: AuthorityPosition,
        max_step_milli: i32,
        allow_micro_reversal: bool,
    ) -> bool {
        let Some(actor) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return false;
        };
        let Some(candidate) = direct_step_toward(
            nav_position_from_authority_position(actor.position),
            nav_position_from_authority_position(target),
            max_step_milli,
        )
        .map(authority_position_from_nav_position) else {
            return false;
        };
        self.move_ai_actor_to_position_with_options(
            actor_id,
            &actor,
            candidate,
            allow_micro_reversal,
        )
    }

    pub(super) fn move_ai_actor_toward_position_pathing(
        &mut self,
        actor_id: &str,
        target: AuthorityPosition,
        max_step_milli: i32,
    ) -> bool {
        let Some(actor) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return false;
        };
        let dx = target.x - actor.position.x;
        let dy = target.y - actor.position.y;
        let distance = distance_milli_components(dx, dy);
        let tactical_deadband_actor = is_skirmisher_role(&actor.role);
        if nav_move_precheck(NavMovePrecheckRequest {
            dx_milli: dx,
            dy_milli: dy,
            distance_milli: distance,
            max_step_milli,
            tactical_deadband_actor,
            min_tactical_reposition_milli: SKIRMISHER_MIN_TACTICAL_REPOSITION_MILLI_CELLS,
            micro_correction_deadband_milli: SKIRMISHER_MICRO_CORRECTION_DEADBAND_MILLI_CELLS,
            micro_correction_axis_lock_milli: SKIRMISHER_MICRO_CORRECTION_AXIS_LOCK_MILLI_CELLS,
        }) != NavMovePrecheck::Allowed
        {
            return false;
        }
        let allow_path_reversal =
            tactical_path_reversal_allowed(false, distance, SKIRMISHER_COVER_REACHED_MILLI_CELLS);
        let Some(direct_candidate) = direct_step_toward(
            nav_position_from_authority_position(actor.position),
            nav_position_from_authority_position(target),
            max_step_milli,
        )
        .map(authority_position_from_nav_position) else {
            return false;
        };
        if self.ai_actor_direct_corridor_clear(&actor, actor.position, target)
            && !self.ai_position_blocked(&actor.area_id, direct_candidate)
            && self.move_ai_actor_to_position_with_options(
                actor_id,
                &actor,
                direct_candidate,
                allow_path_reversal,
            )
        {
            return true;
        }
        let (waypoint, waypoint_allows_micro_reversal) = if let Some(waypoint) =
            self.ai_path_next_position(&actor, target)
        {
            (waypoint, false)
        } else if let Some(avoidance) = self.ai_avoidance_position(&actor, target, max_step_milli) {
            (avoidance, false)
        } else {
            (target, false)
        };
        if tactical_deadband_actor
            && position_distance_milli(actor.position, waypoint)
                <= SKIRMISHER_MIN_TACTICAL_REPOSITION_MILLI_CELLS
        {
            return self
                .ai_unstuck_position(&actor, target, max_step_milli)
                .is_some_and(|unstuck| {
                    self.move_ai_actor_to_position_with_options(actor_id, &actor, unstuck, false)
                });
        }
        if self.move_ai_actor_toward_position_with_options(
            actor_id,
            waypoint,
            max_step_milli,
            waypoint_allows_micro_reversal,
        ) {
            return true;
        }
        self.ai_avoidance_position(&actor, target, max_step_milli)
            .is_some_and(|avoidance| {
                self.move_ai_actor_to_position_with_options(actor_id, &actor, avoidance, false)
            })
            || self
                .ai_unstuck_position(&actor, target, max_step_milli)
                .is_some_and(|unstuck| {
                    self.move_ai_actor_to_position_with_options(actor_id, &actor, unstuck, false)
                })
    }

    pub(super) fn ai_path_next_position(
        &self,
        actor: &ActorAuthorityState,
        target: AuthorityPosition,
    ) -> Option<AuthorityPosition> {
        let target = self.clamped_ai_position(&actor.area_id, target);
        let target_cell = target.cell();
        let path = if actor.cell == target_cell {
            Vec::new()
        } else {
            self.find_ai_cell_path(actor, target_cell)?
        };
        nav_next_position_from_path(
            actor.cell,
            target_cell,
            target,
            &path,
            AuthorityPosition::from_cell,
        )
    }

    pub(super) fn find_ai_cell_path(
        &self,
        actor: &ActorAuthorityState,
        goal: AuthorityCell,
    ) -> Option<Vec<AuthorityCell>> {
        self.runtime
            .current_path_queries
            .set(self.runtime.current_path_queries.get().saturating_add(1));
        let area_id = actor.area_id.as_str();
        let start = actor.cell;
        let area = self.runtime.durable.world.areas.get(area_id)?;
        let to_nav = |cell: AuthorityCell| NavCell::new(cell.x, cell.y);
        let from_nav = |cell: NavCell| AuthorityCell::new(cell.x, cell.y);
        let contains = |cell: NavCell| area.contains(from_nav(cell));
        let blocked = |cell: NavCell| self.ai_cell_blocked(actor, from_nav(cell));
        let transition_clear = |from: NavCell, to: NavCell| {
            self.ai_cell_transition_clear(actor, from_nav(from), from_nav(to))
        };

        let result = find_cell_path(NavPathRequest {
            start: to_nav(start),
            goal: to_nav(goal),
            max_expansions: SKIRMISHER_PATH_MAX_EXPANSIONS,
            contains: &contains,
            blocked: &blocked,
            transition_clear: &transition_clear,
        });

        self.runtime.current_path_expansions.set(
            self.runtime
                .current_path_expansions
                .get()
                .saturating_add(u64::try_from(result.expansions).unwrap_or(u64::MAX)),
        );
        let path = result.path?;
        Some(path.into_iter().map(from_nav).collect())
    }

    pub(super) fn ai_cell_blocked(&self, actor: &ActorAuthorityState, cell: AuthorityCell) -> bool {
        self.ai_clearance_cell_blocked(&actor.area_id, cell)
            || self.door_clearance_cell_blocked(&actor.area_id, cell)
    }

    pub(super) fn ai_cell_transition_clear(
        &self,
        actor: &ActorAuthorityState,
        from: AuthorityCell,
        to: AuthorityCell,
    ) -> bool {
        let from_position = if from == actor.cell {
            actor.position
        } else {
            AuthorityPosition::from_cell(from)
        };
        self.ai_actor_direct_corridor_clear(actor, from_position, AuthorityPosition::from_cell(to))
    }

    pub(super) fn move_ai_actor_to_position(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        candidate: AuthorityPosition,
    ) -> bool {
        self.move_ai_actor_to_position_with_options(actor_id, actor, candidate, false)
    }

    pub(super) fn move_ai_actor_to_position_with_options(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        candidate: AuthorityPosition,
        allow_micro_reversal: bool,
    ) -> bool {
        let target = self.clamped_ai_position(&actor.area_id, candidate);
        let next = self.resolve_ai_circle_move(&actor.area_id, actor.position, target);
        let move_dx = next.x - actor.position.x;
        let move_dy = next.y - actor.position.y;
        if position_distance_milli(next, actor.position) <= 1
            || self.ai_tactical_clearance_move_blocked(actor, next)
            || self.ai_squadmate_separation_conflicts(actor, next)
        {
            return self.move_ai_actor_with_axis_slide(
                actor_id,
                actor,
                target,
                allow_micro_reversal,
            );
        }
        if actor_uses_combat_tactics(actor)
            && !allow_micro_reversal
            && skirmisher_micro_reversal_blocked(actor, self.runtime.durable.tick, move_dx, move_dy)
        {
            return false;
        }
        self.commit_ai_actor_move(actor_id, actor, next, move_dx, move_dy)
    }

    pub(super) fn move_ai_actor_with_axis_slide(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        blocked_target: AuthorityPosition,
        allow_micro_reversal: bool,
    ) -> bool {
        let Some(candidate) = select_axis_slide_candidate(
            tactical_point_from_authority_position(actor.position),
            tactical_point_from_authority_position(blocked_target),
            authority_position_from_tactical_point,
            |candidate| {
                if position_distance_milli(candidate, actor.position) <= 1
                    || self.ai_position_blocked(&actor.area_id, candidate)
                    || self.ai_tactical_clearance_move_blocked(actor, candidate)
                    || self.ai_actor_body_blocked(actor, candidate)
                    || self.ai_squadmate_separation_conflicts(actor, candidate)
                {
                    return false;
                }
                let move_dx = candidate.x - actor.position.x;
                let move_dy = candidate.y - actor.position.y;
                !(actor_uses_combat_tactics(actor)
                    && !allow_micro_reversal
                    && skirmisher_micro_reversal_blocked(
                        actor,
                        self.runtime.durable.tick,
                        move_dx,
                        move_dy,
                    ))
            },
        ) else {
            return false;
        };
        let move_dx = candidate.x - actor.position.x;
        let move_dy = candidate.y - actor.position.y;
        self.commit_ai_actor_move(actor_id, actor, candidate, move_dx, move_dy)
    }

    pub(super) fn commit_ai_actor_move(
        &mut self,
        actor_id: &str,
        _actor: &ActorAuthorityState,
        next: AuthorityPosition,
        move_dx: i32,
        move_dy: i32,
    ) -> bool {
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return false;
        };
        if actor.last_shot_tick != Some(self.runtime.durable.tick) {
            actor.direction = direction_for_milli_delta(move_dx, move_dy).to_owned();
        }
        actor.position = next;
        actor.cell = next.cell();
        actor.stats.record_distance(
            self.runtime.durable.tick,
            self.runtime.durable.world.tick_rate_hz,
            distance_milli_components(move_dx, move_dy),
        );
        actor.last_moved_tick = Some(self.runtime.durable.tick);
        if let Some(ai) = actor.ai.as_mut().and_then(combat_micro_state_mut) {
            record_skirmisher_move(ai, self.runtime.durable.tick, move_dx, move_dy);
        }
        true
    }

    pub(super) fn face_combat_actors_toward_engagement_targets(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.life_state == AuthorityLifeState::Alive && actor_uses_combat_tactics(actor)
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            self.face_ai_actor_toward_engagement_target(&actor_id);
        }
    }

    pub(super) fn face_ai_actor_toward_engagement_target(&mut self, actor_id: &str) -> bool {
        let Some(actor_snapshot) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return false;
        };
        let target_position = ai_engagement_target_id(&actor_snapshot)
            .and_then(|target_actor_id| self.runtime.durable.actors.get(target_actor_id))
            .filter(|target| {
                target.area_id == actor_snapshot.area_id
                    && target.life_state == AuthorityLifeState::Alive
                    && target.sleep.remaining_ticks == 0
            })
            .map(|target| target.position)
            .or_else(|| {
                self.nearest_skirmisher_target(
                    &actor_snapshot,
                    skirmisher_profile_for_ai_state(&actor_snapshot),
                )
                .map(|target| target.position)
            });
        let Some(target_position) = target_position else {
            return false;
        };
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return false;
        };
        actor.direction = direction_for_milli_delta(
            target_position.x - actor.position.x,
            target_position.y - actor.position.y,
        )
        .to_owned();
        true
    }

    pub(super) fn ai_tactical_clearance_move_blocked(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        actor_uses_combat_tactics(actor)
            && self.ai_position_clearance_blocked(&actor.area_id, position)
    }

    /// Same-squad AI SEPARATION STEERING (owner ruling 2026-07-04: actors
    /// never BLOCK movement — this is AI-only steering: a squadmate-crowded
    /// step makes the pawn slide/avoid to a nearby point instead). Players,
    /// corpses, and non-squad actors never register. Hysteresis: overlapping
    /// pawns may always take steps that INCREASE their separation.
    pub(super) fn ai_squadmate_separation_conflicts(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        let social_group = actor.faction.social_group.as_deref();
        let faction_id = actor.faction.faction_id.as_deref();
        if social_group.is_none() && faction_id.is_none() {
            return false;
        }
        for other in self.runtime.durable.actors.values() {
            if other.id == actor.id
                || other.area_id != actor.area_id
                || other.life_state != AuthorityLifeState::Alive
                || !same_respawn_squad(social_group, faction_id, other)
            {
                continue;
            }
            let next_distance = position_distance_milli(position, other.position);
            if next_distance >= AI_ACTOR_BODY_SEPARATION_MILLI_CELLS {
                continue;
            }
            let current_distance = position_distance_milli(actor.position, other.position);
            if current_distance < AI_ACTOR_BODY_SEPARATION_MILLI_CELLS
                && next_distance
                    >= current_distance.saturating_add(AI_ACTOR_BODY_SEPARATION_RELEASE_MILLI_CELLS)
            {
                continue;
            }
            return true;
        }
        false
    }

    pub(super) fn ai_avoidance_position(
        &self,
        actor: &ActorAuthorityState,
        target: AuthorityPosition,
        max_step_milli: i32,
    ) -> Option<AuthorityPosition> {
        select_avoidance_candidate(
            tactical_point_from_authority_position(actor.position),
            tactical_point_from_authority_position(target),
            max_step_milli,
            AI_AVOIDANCE_STEP_MIN_MILLI_CELLS,
            MILLI_CELLS_PER_CELL,
            authority_position_from_tactical_point,
            |candidate| self.clamped_ai_position(&actor.area_id, candidate),
            |candidate| {
                position_distance_milli(candidate, actor.position) > 1
                    && !self.ai_position_blocked(&actor.area_id, candidate)
                    && !self.ai_position_clearance_blocked(&actor.area_id, candidate)
                    && !self.ai_actor_body_blocked(actor, candidate)
                    && !self.ai_squadmate_separation_conflicts(actor, candidate)
                    && fallback_micro_reversal_allowed(actor, self.runtime.durable.tick, candidate)
            },
        )
    }

    pub(super) fn ai_unstuck_position(
        &self,
        actor: &ActorAuthorityState,
        target: AuthorityPosition,
        max_step_milli: i32,
    ) -> Option<AuthorityPosition> {
        select_unstuck_candidate(
            tactical_point_from_authority_position(actor.position),
            max_step_milli,
            AI_AVOIDANCE_STEP_MIN_MILLI_CELLS,
            MILLI_CELLS_PER_CELL,
            authority_position_from_tactical_point,
            |candidate| self.clamped_ai_position(&actor.area_id, candidate),
            |candidate| {
                position_distance_milli(candidate, actor.position) > 1
                    && !self.ai_position_blocked(&actor.area_id, candidate)
                    && !self.ai_position_clearance_blocked(&actor.area_id, candidate)
                    && !self.ai_actor_body_blocked(actor, candidate)
                    && !self.ai_squadmate_separation_conflicts(actor, candidate)
                    && fallback_micro_reversal_allowed(actor, self.runtime.durable.tick, candidate)
            },
            |candidate| {
                (
                    position_distance_milli(candidate, target),
                    position_distance_milli(candidate, actor.position),
                    candidate.x,
                    candidate.y,
                )
            },
        )
    }

    pub(super) fn ai_actor_direct_corridor_clear(
        &self,
        actor: &ActorAuthorityState,
        start: AuthorityPosition,
        end: AuthorityPosition,
    ) -> bool {
        corridor_clear(
            nav_position_from_authority_position(start),
            nav_position_from_authority_position(end),
            AI_AVOIDANCE_STEP_MIN_MILLI_CELLS.max(1),
            256,
            |candidate, is_terminal| {
                let candidate = if is_terminal {
                    end
                } else {
                    self.clamped_ai_position(
                        &actor.area_id,
                        authority_position_from_nav_position(candidate),
                    )
                };
                self.ai_position_blocked(&actor.area_id, candidate)
                    || self.ai_position_clearance_blocked(&actor.area_id, candidate)
                    || self.ai_actor_body_blocked(actor, candidate)
            },
        )
    }

    pub(super) fn ai_clearance_cell_blocked(&self, area_id: &str, cell: AuthorityCell) -> bool {
        self.runtime
            .durable
            .world
            .ai_clearance_blocked_cells
            .contains(&CellKey::new(area_id, cell.x, cell.y))
    }

    pub(super) fn door_clearance_cell_blocked(&self, area_id: &str, cell: AuthorityCell) -> bool {
        let key = CellKey::new(area_id, cell.x, cell.y);
        self.runtime
            .door_clearance_blocked_cells_by_prop
            .values()
            .any(|cells| cells.contains(&key))
    }

    pub fn set_door_open(&mut self, prop_id: &str, door_open: bool) -> bool {
        let Some(index) = self
            .runtime
            .durable
            .door_collision_bounds
            .iter()
            .position(|door| door.prop_id == prop_id)
        else {
            return false;
        };
        self.runtime.durable.door_collision_bounds[index].open = door_open;
        self.runtime
            .door_clearance_blocked_cells_by_prop
            .remove(prop_id);
        if !door_open {
            let cells = door_clearance_blocked_cells_for_bound(
                &self.runtime.durable.world.areas,
                &self.runtime.durable.door_collision_bounds[index],
            );
            if !cells.is_empty() {
                self.runtime
                    .door_clearance_blocked_cells_by_prop
                    .insert(prop_id.to_owned(), cells);
            }
        }
        true
    }

    pub(super) fn ai_position_clearance_blocked(
        &self,
        area_id: &str,
        position: AuthorityPosition,
    ) -> bool {
        let cell = position.cell();
        self.ai_clearance_cell_blocked(area_id, cell)
            || self.door_clearance_cell_blocked(area_id, cell)
    }

    pub(super) fn resolve_ai_circle_move(
        &self,
        area_id: &str,
        current: AuthorityPosition,
        target: AuthorityPosition,
    ) -> AuthorityPosition {
        let Some(area) = self.runtime.durable.world.areas.get(area_id) else {
            return current;
        };
        let target = target.clamp_to_area(area);
        let delta_x = (i64::from(target.x) - i64::from(current.x))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let delta_y = (i64::from(target.y) - i64::from(current.y))
            .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
        let mut blockers = self.circle_blockers_for_area(area_id);
        self.push_blocked_cell_circle_blockers(area_id, &mut blockers);
        let current_center = ground_center_from_anchor(current);
        let resolved_center = resolve_circle_move_milli(
            CirclePoint {
                x: current_center.x,
                y: current_center.y,
            },
            delta_x,
            delta_y,
            CIRCLE_COLLISION_RADIUS_MILLI,
            &blockers,
        );
        anchor_from_ground_center(AuthorityPosition {
            x: resolved_center.x,
            y: resolved_center.y,
        })
        .clamp_to_area(area)
    }

    pub(super) fn ai_actor_body_blocked(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        let body = actor_hit_box_for_position(position, actor.scale, is_creature_body_actor(actor));
        self.runtime
            .durable
            .world
            .blocked_cells
            .iter()
            .filter(|cell| cell.area_id == actor.area_id)
            .any(|cell| body.intersects(cell_hit_box(cell.x, cell.y)))
            || self
                .runtime
                .durable
                .world
                .fine_collision_bounds
                .iter()
                .filter(|bounds| bounds.area_id == actor.area_id)
                .any(|bounds| body.intersects(bounds.hit_box()))
            || self
                .runtime
                .durable
                .door_collision_bounds
                .iter()
                .filter(|bounds| bounds.area_id == actor.area_id && !bounds.open)
                .any(|bounds| body.intersects(bounds.hit_box()))
    }
}

fn fallback_micro_reversal_allowed(
    actor: &ActorAuthorityState,
    tick: u64,
    candidate: AuthorityPosition,
) -> bool {
    !actor_uses_combat_tactics(actor)
        || !skirmisher_micro_reversal_blocked(
            actor,
            tick,
            candidate.x - actor.position.x,
            candidate.y - actor.position.y,
        )
}

#[cfg(test)]
mod tests {
    use successor_movement::CIRCLE_TRACE_SKIN_MILLI;
    use super::*;
    use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};

    fn door_collision_snapshot() -> crate::SliceSnapshot {
        crate::SliceSnapshot {
            schema: "successor.slice.v1".to_owned(),
            tick: 24,
            tick_rate_hz: 30,
            combat_model: None,
            combat_tuning: None,
            grid: crate::GridSpec { cell_size_px: 60 },
            zone: crate::ZoneSpec {
                id: 1,
                name: "Door Test".to_owned(),
                width: 10,
                height: 10,
                level: 0,
            },
            areas: vec![crate::AreaSpec {
                id: "arena".to_owned(),
                name: "Arena".to_owned(),
                kind: "overworld".to_owned(),
                width: 10,
                height: 10,
                level: 0,
            }],
            state_hash: "door-test".to_owned(),
            camera: crate::CameraSpec {
                follow_actor: "player".to_owned(),
                zoom: 72,
            },
            factions: Vec::new(),
            player_organizations: Vec::new(),
            population_templates: Vec::new(),
            spawn_zones: Vec::new(),
            actors: vec![
                crate::ActorSnapshot {
                    id: "player".to_owned(),
                    entity: "actor:player".to_owned(),
                    template_id: None,
                    area_id: "arena".to_owned(),
                    label: "Player".to_owned(),
                    role: "player".to_owned(),
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
                    pose_set: "walk".to_owned(),
                    direction: "back".to_owned(),
                    cell: crate::CellSnapshot::new(5, 6),
                    route: Vec::new(),
                    scale: None,
                    vitals: None,
                    max_vitals: None,
                    initial_respawn_delay_ms: None,
                },
                crate::ActorSnapshot {
                    id: "npc".to_owned(),
                    entity: "actor:npc".to_owned(),
                    template_id: None,
                    area_id: "arena".to_owned(),
                    label: "Npc".to_owned(),
                    role: "agent_player".to_owned(),
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
                    pose_set: "walk".to_owned(),
                    direction: "back".to_owned(),
                    cell: crate::CellSnapshot::new(3, 6),
                    route: Vec::new(),
                    scale: None,
                    vitals: None,
                    max_vitals: None,
                    initial_respawn_delay_ms: None,
                },
            ],
            props: vec![crate::PropSnapshot {
                id: "test-door".to_owned(),
                entity: "prop:test-door".to_owned(),
                area_id: "arena".to_owned(),
                label: "Test Door".to_owned(),
                kind: "door".to_owned(),
                cell: crate::CellSnapshot::new(0, 4),
                size: crate::CellSizeSnapshot { w: 10, h: 1 },
                interactive: true,
                cover: None,
                collision_bounds: Vec::new(),
                door: Some(crate::DoorSnapshot {
                    blocker: crate::CollisionBoundsSnapshot {
                        x_milli: 0,
                        y_milli: 0,
                        w_milli: 10_000,
                        h_milli: 1_000,
                    },
                }),
                container: None,
            }],
            blocked_cells: Vec::new(),
            no_claim_zones: Vec::new(),
            transitions: Vec::new(),
            clone_facilities: Vec::new(),
            inventory: Vec::new(),
            reservations: Vec::new(),
            npc_jobs: Vec::new(),
            events: Vec::new(),
        }
    }

    #[test]
    fn closed_door_blocks_player_sweep_and_open_door_passes() {
        let snapshot = door_collision_snapshot();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let area = state.areas.get("arena").unwrap().clone();
        let current = AuthorityPosition { x: 5_000, y: 6_000 };
        let requested = AuthorityPosition { x: 5_000, y: 2_000 };

        let closed = state.clamped_unblocked_player_position("arena", current, requested, &area);
        assert_eq!(closed.x, 5_000);
        assert_eq!(closed.y, 4_802);

        assert!(state.set_door_open("test-door", true));
        let open = state.clamped_unblocked_player_position("arena", current, requested, &area);
        assert_eq!(open, requested);
    }

    #[test]
    fn npc_path_query_fails_gracefully_when_door_is_closed_and_passes_when_open() {
        let snapshot = door_collision_snapshot();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let actor = state.actors.get("npc").unwrap().clone();
        let goal = AuthorityCell::new(3, 2);

        assert!(state.find_ai_cell_path(&actor, goal).is_none());
        assert!(state.set_door_open("test-door", true));
        assert!(state.find_ai_cell_path(&actor, goal).is_some());
    }

    #[test]
    fn swept_collision_moves_are_deterministic_across_identical_runs() {
        let snapshot = door_collision_snapshot();
        let config = SliceAuthorityConfig {
            session: SessionId(1),
            player: PlayerId(1),
            player_actor_id: "player".to_owned(),
            area_interest_radius_cells: 64,
            craft_roll_key: SliceAuthorityConfig::default().craft_roll_key,
        };
        let command = ClientCommandEnvelope {
            session: config.session,
            player: config.player,
            command_id: 1,
            issued_at_tick: 24,
            command: ClientCommand::Move {
                dx: 0,
                dy: -1,
                duration_ticks: 30,
                facing: None,
                sprint: true,
            },
        };
        let mut left = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let mut right = SliceAuthorityState::from_snapshot(&snapshot).unwrap();

        let left_result = left.apply_command(&config, &command);
        let right_result = right.apply_command(&config, &command);

        assert_eq!(left_result, right_result);
        assert_eq!(left.stable_state_hash_hex(), right.stable_state_hash_hex());
        assert_eq!(
            left.actors.get("player").unwrap().position,
            right.actors.get("player").unwrap().position
        );
    }
    #[test]
    fn player_wall_sweep_stops_ground_center_at_radius_plus_skin_and_preserves_slide() {
        let snapshot = door_collision_snapshot();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        state.door_collision_bounds.clear();
        state
            .fine_collision_bounds
            .push(FineCollisionBoundsAuthorityState {
                prop_id: "world-wall".to_owned(),
                area_id: "arena".to_owned(),
                left: 5_000,
                right: 6_000,
                top: 1_000,
                bottom: 9_000,
            });
        let area = state.areas.get("arena").unwrap().clone();

        let horizontal = state.clamped_unblocked_player_position(
            "arena",
            AuthorityPosition { x: 2_000, y: 3_000 },
            AuthorityPosition { x: 8_000, y: 3_000 },
            &area,
        );
        assert_eq!(horizontal, AuthorityPosition { x: 4_198, y: 3_000 });
        assert_eq!(
            ground_center_from_anchor(horizontal),
            AuthorityPosition { x: 4_698, y: 3_500 }
        );
        assert!(!state.circle_position_blocked("arena", horizontal));

        let diagonal = state.clamped_unblocked_player_position(
            "arena",
            AuthorityPosition { x: 2_000, y: 2_000 },
            AuthorityPosition { x: 8_000, y: 8_000 },
            &area,
        );
        assert_eq!(diagonal, AuthorityPosition { x: 4_199, y: 8_000 });
        let mut actor = state.actors.get("player").unwrap().clone();
        actor.position = diagonal;
        assert_eq!(
            actor_center_position(&actor),
            ground_center_from_anchor(diagonal)
        );
    }

    #[test]
    fn rust_translates_post_rotation_prop_local_bounds_once() {
        let mut snapshot = door_collision_snapshot();
        let mut prop = snapshot.props[0].clone();
        prop.id = "post-rotation-sidecar".to_owned();
        prop.cell = crate::CellSnapshot::new(2, 3);
        prop.size = crate::CellSizeSnapshot { w: 2, h: 1 };
        prop.collision_bounds = vec![crate::CollisionBoundsSnapshot {
            x_milli: 250,
            y_milli: 100,
            w_milli: 1_500,
            h_milli: 250,
        }];
        prop.door = None;
        snapshot.props.push(prop);

        let state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let bounds = state
            .fine_collision_bounds
            .iter()
            .find(|bounds| bounds.prop_id == "post-rotation-sidecar")
            .unwrap();
        assert_eq!(
            (bounds.left, bounds.top, bounds.right, bounds.bottom),
            (2_250, 3_100, 3_750, 3_350)
        );
    }

    #[test]
    fn current_clone_facility_structural_proxies_and_door_block_canonical_centers() {
        let fixture =
            include_str!("../../../../client/public/successor-slice/open-desert-slice.json");
        let raw: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let snapshot: crate::SliceSnapshot = serde_json::from_str(fixture).unwrap();
        let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        let prop_id = "dustgate-cloning-facility";
        let area_id = "open-desert-overworld";
        let area = state.areas.get(area_id).unwrap().clone();
        let primitive_ids = raw["props"]
            .as_array()
            .unwrap()
            .iter()
            .find(|prop| prop["id"] == prop_id)
            .unwrap()["collisionBounds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|bounds| bounds["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        let facility_bounds = state
            .fine_collision_bounds
            .iter()
            .filter(|bounds| bounds.prop_id == prop_id)
            .cloned()
            .collect::<Vec<_>>();

        assert_eq!(primitive_ids.len(), 9);
        assert_eq!(facility_bounds.len(), primitive_ids.len());
        state.door_collision_bounds.clear();
        for (primitive_id, bounds) in primitive_ids.iter().zip(facility_bounds) {
            state.fine_collision_bounds = vec![bounds.clone()];
            let width = bounds.right - bounds.left;
            let height = bounds.bottom - bounds.top;
            let (current_center, requested_center, expected_center) = if width >= height {
                let x = bounds.left + width / 2;
                (
                    AuthorityPosition {
                        x,
                        y: bounds.top - 2_000,
                    },
                    AuthorityPosition {
                        x,
                        y: bounds.bottom + 2_000,
                    },
                    AuthorityPosition {
                        x,
                        y: bounds.top - CIRCLE_COLLISION_RADIUS_MILLI - CIRCLE_TRACE_SKIN_MILLI,
                    },
                )
            } else {
                let y = bounds.top + height / 2;
                (
                    AuthorityPosition {
                        x: bounds.left - 2_000,
                        y,
                    },
                    AuthorityPosition {
                        x: bounds.right + 2_000,
                        y,
                    },
                    AuthorityPosition {
                        x: bounds.left - CIRCLE_COLLISION_RADIUS_MILLI - CIRCLE_TRACE_SKIN_MILLI,
                        y,
                    },
                )
            };
            let current = anchor_from_ground_center(current_center);
            let requested = anchor_from_ground_center(requested_center);
            let resolved =
                state.clamped_unblocked_player_position(area_id, current, requested, &area);

            assert_eq!(
                ground_center_from_anchor(resolved),
                expected_center,
                "{primitive_id}"
            );
            assert_eq!(
                state.clamped_unblocked_player_position(area_id, current, requested, &area),
                resolved,
                "{primitive_id} deterministic replay"
            );
            assert!(
                !state.circle_position_blocked(area_id, resolved),
                "{primitive_id} resolved clear"
            );
        }

        let mut door_state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
        door_state.fine_collision_bounds.clear();
        let door = door_state
            .door_collision_bounds
            .iter()
            .find(|bounds| bounds.prop_id == prop_id)
            .cloned()
            .unwrap();
        let center_x = door.left + (door.right - door.left) / 2;
        let outside = anchor_from_ground_center(AuthorityPosition {
            x: center_x,
            y: door.bottom + 2_000,
        });
        let inside = anchor_from_ground_center(AuthorityPosition {
            x: center_x,
            y: door.top - 2_000,
        });
        let closed = door_state.clamped_unblocked_player_position(area_id, outside, inside, &area);
        assert_eq!(
            ground_center_from_anchor(closed),
            AuthorityPosition {
                x: center_x,
                y: door.bottom + CIRCLE_COLLISION_RADIUS_MILLI + CIRCLE_TRACE_SKIN_MILLI,
            }
        );
        assert!(door_state.set_door_open(prop_id, true));
        assert_eq!(
            door_state.clamped_unblocked_player_position(area_id, outside, inside, &area),
            inside
        );
    }
}
