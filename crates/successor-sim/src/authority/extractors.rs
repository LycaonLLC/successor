use super::extraction_math::{
    account_extractor_tick, compose_extractor_bottleneck, extractor_extraction_milli_per_sec,
    EXTRACTOR_TICK_INTERVAL_TICKS, HOPPER_CAP_MILLI,
};
use super::*;

impl SliceAuthorityState {
    pub fn placed_extractor_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityPlacedExtractorSnapshot> {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id);
        self.runtime
            .durable
            .placed_extractors
            .values()
            .filter(|extractor| match observer {
                Some(actor) => {
                    self.extractor_in_interest(actor, extractor, config.area_interest_radius_cells)
                }
                None => true,
            })
            .map(|extractor| self.placed_extractor_snapshot_from_state(extractor, observer))
            .collect()
    }

    pub(super) fn apply_place_extractor(
        &mut self,
        config: &SliceAuthorityConfig,
        family: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if actor.posture != AuthorityActorPosture::Standing {
            return Err(AuthorityRejectReason::PostureLocked);
        }
        // Point sampling is universal, but deploying a persistent extractor is
        // trained Craftsman work and still consumes the matching category tool.
        Self::require_actor_profession(&actor, AuthorityProfessionKind::Craftsman)?;
        if self
            .runtime
            .durable
            .placed_extractors
            .values()
            .any(|extractor| extractor.owner_actor_id == actor.id)
        {
            return Err(AuthorityRejectReason::ExtractorAlreadyPlaced);
        }
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(&actor.area_id)
            .ok_or(AuthorityRejectReason::UnknownArea)?;
        if !area.contains(actor.cell) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        if self
            .runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(&actor.area_id, actor.cell.x, actor.cell.y))
        {
            return Err(AuthorityRejectReason::BlockedCell);
        }
        let biome = extractor_biome_for_area(area);
        let resource =
            resource_instance_for_family_at_tick(&actor.area_id, family, self.runtime.durable.tick)
                .ok_or(AuthorityRejectReason::InvalidResourceFamily)?;
        let _concentration = self.resource_concentration_milli_for_area(
            &actor.area_id,
            resource.concentration_seed,
            actor.cell,
        );
        let tool_variant_id = self.consume_best_actor_extractor_tool(&actor.id, family)?;
        let seq = self.runtime.durable.next_extractor_id.max(1);
        self.runtime.durable.next_extractor_id = seq.saturating_add(1).max(1);
        let extractor_id = format!("extractor:{}:{seq}", actor.id);
        self.runtime.durable.placed_extractors.insert(
            extractor_id.clone(),
            PlacedExtractorState {
                extractor_id,
                owner_actor_id: actor.id.clone(),
                area_id: actor.area_id.clone(),
                cell: actor.cell,
                position: actor.position,
                family: resource.family,
                resource_item_id: resource.item_id,
                resource_variant_id: resource.variant_id,
                tool_variant_id,
                hopper_milli: 0,
                placed_at_tick: self.runtime.durable.tick,
                mode: ExtractorMode::Idle,
                next_extractor_tick: self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS),
                biome,
                battery_remaining_seconds: 0,
                battery_variant_id: 0,
                extraction_started_tick: 0,
                battery_inserted_tick: 0,
            },
        );
        Ok(())
    }

    pub(super) fn apply_crank_extractor(
        &mut self,
        config: &SliceAuthorityConfig,
        extractor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if actor.pending_resource_sample.is_some() {
            return Err(AuthorityRejectReason::PostureLocked);
        }
        self.materialize_autonomous_extractor(extractor_id);
        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?
            .clone();
        self.require_extractor_owner_and_range(&actor, &extractor)?;
        if extractor.hopper_milli >= HOPPER_CAP_MILLI {
            return Err(AuthorityRejectReason::ExtractorHopperFull);
        }
        if extractor.mode == ExtractorMode::Battery {
            return Err(AuthorityRejectReason::ExtractorBusy);
        }
        if let Some(current) = actor.cranking_extractor_id.as_deref() {
            if current != extractor_id {
                return Err(AuthorityRejectReason::ExtractorBusy);
            }
        }

        let actor_state = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        match actor_state.posture {
            AuthorityActorPosture::Standing => {
                actor_state.posture = AuthorityActorPosture::KneelingDown;
                actor_state.posture_until_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(POSTURE_KNEEL_DOWN_TICKS);
            }
            AuthorityActorPosture::Kneeling => {}
            AuthorityActorPosture::KneelingDown | AuthorityActorPosture::StandingUp => {
                return Err(AuthorityRejectReason::PostureLocked);
            }
        }
        actor_state.cranking_extractor_id = Some(extractor_id.to_owned());

        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get_mut(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?;
        extractor.mode = ExtractorMode::Manual;
        if extractor.next_extractor_tick <= self.runtime.durable.tick {
            extractor.next_extractor_tick = self
                .runtime
                .durable
                .tick
                .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
        }
        Ok(())
    }

    pub(super) fn apply_stop_crank(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Result<(), AuthorityRejectReason> {
        if !self
            .runtime
            .durable
            .actors
            .contains_key(&config.player_actor_id)
        {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        self.stop_actor_extractor_crank(&config.player_actor_id);
        Ok(())
    }

    pub(super) fn apply_insert_battery(
        &mut self,
        config: &SliceAuthorityConfig,
        extractor_id: &str,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        self.materialize_autonomous_extractor(extractor_id);
        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?
            .clone();
        self.require_extractor_owner_and_range(&actor, &extractor)?;
        if extractor.hopper_milli >= HOPPER_CAP_MILLI {
            return Err(AuthorityRejectReason::ExtractorHopperFull);
        }
        if extractor.mode == ExtractorMode::Manual {
            return Err(AuthorityRejectReason::ExtractorBusy);
        }
        if extractor.battery_remaining_seconds > 0 && extractor.battery_variant_id > 0 {
            return Err(AuthorityRejectReason::ExtractorBatteryPresent);
        }
        let runtime_seconds = decode_battery_runtime_seconds(variant_id)
            .filter(|seconds| *seconds > 0)
            .ok_or(AuthorityRejectReason::MissingBattery)?;
        self.consume_actor_battery_stack(&actor.id, container, stack_id, variant_id)?;
        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get_mut(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?;
        extractor.battery_remaining_seconds = runtime_seconds;
        extractor.battery_variant_id = variant_id;
        extractor.mode = ExtractorMode::Battery;
        extractor.next_extractor_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
        extractor.extraction_started_tick = self.runtime.durable.tick;
        extractor.battery_inserted_tick = self.runtime.durable.tick;
        Ok(())
    }

    pub(super) fn apply_collect_extractor(
        &mut self,
        config: &SliceAuthorityConfig,
        extractor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        self.materialize_autonomous_extractor(extractor_id);
        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?
            .clone();
        self.require_extractor_owner_and_range(&actor, &extractor)?;
        let quantity = u32::try_from(extractor.hopper_milli / 1_000).unwrap_or(u32::MAX);
        if quantity == 0 {
            return Err(AuthorityRejectReason::ExtractorHopperEmpty);
        }
        let item_name = resource_instance_for_family_at_tick(
            &extractor.area_id,
            &extractor.family,
            self.runtime.durable.tick,
        )
        .filter(|resource| resource.item_id == extractor.resource_item_id)
        .map(|resource| resource.label)
        .or_else(|| inventory_item_name(extractor.resource_item_id).map(str::to_owned))
        .ok_or(AuthorityRejectReason::UnknownItem)?;
        self.add_actor_inventory_stack(
            &actor.id,
            extractor.resource_item_id,
            extractor.resource_variant_id,
            &item_name,
            quantity,
            RESOURCE_STACK_CAP,
            "resource-crate",
        );
        if let Some(extractor) = self.runtime.durable.placed_extractors.get_mut(extractor_id) {
            extractor.hopper_milli = 0;
            if extractor.mode != ExtractorMode::Manual {
                extractor.mode = extractor_power_mode_after_manual_stop(extractor);
            }
        }
        Ok(())
    }

    pub(super) fn apply_destroy_extractor(
        &mut self,
        config: &SliceAuthorityConfig,
        extractor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        self.materialize_autonomous_extractor(extractor_id);
        let extractor = self
            .runtime
            .durable
            .placed_extractors
            .get(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?
            .clone();
        self.require_extractor_owner_and_range(&actor, &extractor)?;
        // Pack-up is legal only when the rig is not mid-crank. Battery/idle
        // modes may strike immediately (hopper contents are forfeited).
        if extractor.mode == ExtractorMode::Manual {
            return Err(AuthorityRejectReason::ExtractorBusy);
        }
        let removed = self
            .runtime
            .durable
            .placed_extractors
            .remove(extractor_id)
            .ok_or(AuthorityRejectReason::NoPlacedExtractor)?;
        self.clear_all_cranks_for_extractor(&removed.extractor_id);
        let extractor_item_id = resource_category_for_family(&removed.family)
            .map(ResourceCategory::extractor_tool_item_id)
            .unwrap_or(METAL_EXTRACTOR_TOOL_ITEM_ID);
        let item_name =
            inventory_item_name(extractor_item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        self.add_actor_inventory_stack(
            &actor.id,
            extractor_item_id,
            removed.tool_variant_id,
            item_name,
            1,
            METAL_EXTRACTOR_STACK_CAP,
            "field-pack",
        );
        if removed.battery_remaining_seconds > 0 && removed.battery_variant_id > 0 {
            let battery_name = inventory_item_name(EXTRACTOR_BATTERY_ITEM_ID)
                .ok_or(AuthorityRejectReason::UnknownItem)?;
            self.add_actor_inventory_stack(
                &actor.id,
                EXTRACTOR_BATTERY_ITEM_ID,
                encode_battery_variant(removed.battery_remaining_seconds),
                battery_name,
                1,
                EXTRACTOR_BATTERY_STACK_CAP,
                "field-pack",
            );
        }
        Ok(())
    }

    pub(super) fn stop_actor_extractor_crank(&mut self, actor_id: &str) {
        let extractor_id = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .and_then(|actor| actor.cranking_extractor_id.take());
        if let Some(extractor_id) = extractor_id {
            self.release_manual_extractor_if_unheld(&extractor_id);
        }
    }

    pub(super) fn clear_all_cranks_for_extractor(&mut self, extractor_id: &str) {
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.cranking_extractor_id.as_deref() == Some(extractor_id) {
                actor.cranking_extractor_id = None;
            }
        }
        if let Some(extractor) = self.runtime.durable.placed_extractors.get_mut(extractor_id) {
            if extractor.mode == ExtractorMode::Manual {
                extractor.mode = extractor_power_mode_after_manual_stop(extractor);
            }
        }
    }

    pub(super) fn tick_placed_extractors(&mut self) {
        let due_ids = self
            .runtime
            .durable
            .placed_extractors
            .iter()
            .filter(|(_, extractor)| {
                extractor.mode == ExtractorMode::Manual
                    && self.runtime.durable.tick >= extractor.next_extractor_tick
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for extractor_id in due_ids {
            let Some(extractor) = self
                .runtime
                .durable
                .placed_extractors
                .get(&extractor_id)
                .cloned()
            else {
                continue;
            };
            self.tick_manual_extractor(extractor);
        }
    }

    fn tick_manual_extractor(&mut self, extractor: PlacedExtractorState) {
        if extractor.hopper_milli >= HOPPER_CAP_MILLI {
            self.clear_all_cranks_for_extractor(&extractor.extractor_id);
            if let Some(live) = self
                .runtime
                .durable
                .placed_extractors
                .get_mut(&extractor.extractor_id)
            {
                live.mode = extractor_power_mode_after_manual_stop(live);
                live.next_extractor_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
            }
            return;
        }
        let Some(actor) = self
            .runtime
            .durable
            .actors
            .get(&extractor.owner_actor_id)
            .cloned()
        else {
            self.clear_all_cranks_for_extractor(&extractor.extractor_id);
            return;
        };
        if actor.cranking_extractor_id.as_deref() != Some(extractor.extractor_id.as_str())
            || actor.life_state != AuthorityLifeState::Alive
            || actor.sleep.remaining_ticks > 0
            || !self.actor_within_extractor_interaction_range(&actor, &extractor)
        {
            self.clear_all_cranks_for_extractor(&extractor.extractor_id);
            return;
        }
        if actor.posture == AuthorityActorPosture::KneelingDown {
            if let Some(live) = self
                .runtime
                .durable
                .placed_extractors
                .get_mut(&extractor.extractor_id)
            {
                live.next_extractor_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
            }
            return;
        }
        if actor.posture != AuthorityActorPosture::Kneeling {
            self.clear_all_cranks_for_extractor(&extractor.extractor_id);
            return;
        }
        let Some(resource) = resource_instance_for_family_at_tick(
            &extractor.area_id,
            &extractor.family,
            self.runtime.durable.tick,
        ) else {
            self.clear_all_cranks_for_extractor(&extractor.extractor_id);
            return;
        };
        let concentration_milli = self.resource_concentration_milli_for_area(
            &extractor.area_id,
            resource.concentration_seed,
            extractor.cell,
        );
        let rate_milli = extractor_extraction_milli_per_sec(
            extractor_tool_rate_milli(extractor.tool_variant_id),
            concentration_milli,
        );
        let accounting = account_extractor_tick(extractor.hopper_milli, rate_milli, None);
        let hopper_full = if let Some(live) = self
            .runtime
            .durable
            .placed_extractors
            .get_mut(&extractor.extractor_id)
        {
            live.hopper_milli = accounting.hopper_milli;
            live.next_extractor_tick = self
                .runtime
                .durable
                .tick
                .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
            if live.hopper_milli >= HOPPER_CAP_MILLI {
                live.mode = extractor_power_mode_after_manual_stop(live);
                true
            } else {
                false
            }
        } else {
            false
        };
        if hopper_full {
            if let Some(actor) = self
                .runtime
                .durable
                .actors
                .get_mut(&extractor.owner_actor_id)
            {
                if actor.cranking_extractor_id.as_deref() == Some(extractor.extractor_id.as_str()) {
                    actor.cranking_extractor_id = None;
                }
            }
        }
    }

    pub(super) fn materialized_placed_extractor_state(
        &self,
        extractor: &PlacedExtractorState,
    ) -> PlacedExtractorState {
        let mut effective = extractor.clone();
        self.apply_lazy_battery_extraction(&mut effective);
        effective
    }

    fn materialize_autonomous_extractor(&mut self, extractor_id: &str) {
        let Some(current) = self
            .runtime
            .durable
            .placed_extractors
            .get(extractor_id)
            .cloned()
        else {
            return;
        };
        let effective = self.materialized_placed_extractor_state(&current);
        if let Some(live) = self.runtime.durable.placed_extractors.get_mut(extractor_id) {
            *live = effective;
        }
    }

    fn apply_lazy_battery_extraction(&self, extractor: &mut PlacedExtractorState) {
        if extractor.mode != ExtractorMode::Battery {
            return;
        }
        if extractor.hopper_milli >= HOPPER_CAP_MILLI || extractor.battery_remaining_seconds == 0 {
            extractor.mode = ExtractorMode::Idle;
            if extractor.battery_remaining_seconds == 0 {
                extractor.battery_variant_id = 0;
            }
            return;
        }

        let start_tick = if extractor.extraction_started_tick == 0 {
            extractor.placed_at_tick
        } else {
            extractor.extraction_started_tick
        };
        let elapsed_work_seconds =
            self.runtime.durable.tick.saturating_sub(start_tick) / EXTRACTOR_TICK_INTERVAL_TICKS;
        if elapsed_work_seconds == 0 {
            return;
        }

        let mut remaining_elapsed = elapsed_work_seconds;
        let mut processed_seconds = 0_u64;
        let mut work_tick = start_tick.saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
        while remaining_elapsed > 0
            && extractor.hopper_milli < HOPPER_CAP_MILLI
            && extractor.battery_remaining_seconds > 0
        {
            let Some(resource) = resource_instance_for_family_at_tick(
                &extractor.area_id,
                &extractor.family,
                work_tick,
            ) else {
                extractor.mode = ExtractorMode::Idle;
                break;
            };
            let concentration_milli = self.resource_concentration_milli_for_area(
                &extractor.area_id,
                resource.concentration_seed,
                extractor.cell,
            );
            let rate_milli = extractor_extraction_milli_per_sec(
                extractor_tool_rate_milli(extractor.tool_variant_id),
                concentration_milli,
            );
            let segment_seconds =
                work_seconds_until_resource_epoch_boundary(work_tick).min(remaining_elapsed);
            if segment_seconds == 0 {
                break;
            }
            if rate_milli == 0 {
                extractor.mode = ExtractorMode::Idle;
                break;
            }

            let segment_battery_seconds = extractor
                .battery_remaining_seconds
                .min(u32::try_from(segment_seconds).unwrap_or(u32::MAX));
            let outcome = compose_extractor_bottleneck(
                extractor.hopper_milli,
                rate_milli,
                segment_battery_seconds,
            );
            if outcome.work_seconds == 0 {
                break;
            }
            extractor.hopper_milli = outcome.hopper_milli;
            extractor.battery_remaining_seconds = extractor
                .battery_remaining_seconds
                .saturating_sub(outcome.battery_drained_seconds);
            let advanced = u64::from(outcome.work_seconds);
            processed_seconds = processed_seconds.saturating_add(advanced);
            remaining_elapsed = remaining_elapsed.saturating_sub(advanced);
            work_tick =
                work_tick.saturating_add(advanced.saturating_mul(EXTRACTOR_TICK_INTERVAL_TICKS));

            if extractor.hopper_milli >= HOPPER_CAP_MILLI
                || extractor.battery_remaining_seconds == 0
            {
                break;
            }
        }

        if processed_seconds > 0 {
            extractor.extraction_started_tick = start_tick
                .saturating_add(processed_seconds.saturating_mul(EXTRACTOR_TICK_INTERVAL_TICKS));
            extractor.next_extractor_tick = extractor
                .extraction_started_tick
                .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS);
        }
        if extractor.hopper_milli >= HOPPER_CAP_MILLI || extractor.battery_remaining_seconds == 0 {
            extractor.mode = ExtractorMode::Idle;
            if extractor.battery_remaining_seconds == 0 {
                extractor.battery_variant_id = 0;
            }
        }
    }

    pub(super) fn release_manual_extractor_if_unheld(&mut self, extractor_id: &str) {
        let held = self
            .runtime
            .durable
            .actors
            .values()
            .any(|actor| actor.cranking_extractor_id.as_deref() == Some(extractor_id));
        if held {
            return;
        }
        if let Some(extractor) = self.runtime.durable.placed_extractors.get_mut(extractor_id) {
            if extractor.mode == ExtractorMode::Manual {
                extractor.mode = extractor_power_mode_after_manual_stop(extractor);
            }
        }
    }

    fn consume_best_actor_extractor_tool(
        &mut self,
        actor_id: &str,
        family: &str,
    ) -> Result<u32, AuthorityRejectReason> {
        let extractor_item_id = resource_category_for_family(family)
            .ok_or(AuthorityRejectReason::InvalidResourceFamily)?
            .extractor_tool_item_id();
        let Some((row_index, variant_id)) = self
            .runtime
            .durable
            .inventory
            .iter()
            .enumerate()
            .filter(|(_, row)| {
                row.item_id == extractor_item_id
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .max_by_key(|(_, row)| row.variant_id)
            .map(|(index, row)| (index, row.variant_id))
        else {
            return Err(AuthorityRejectReason::ItemUnavailable);
        };
        self.consume_inventory_row(row_index)?;
        Ok(variant_id)
    }

    fn consume_actor_battery_stack(
        &mut self,
        actor_id: &str,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let stack_id = parse_extractor_inventory_stack_id(stack_id)
            .ok_or(AuthorityRejectReason::MissingBattery)?;
        let Some(row_index) = self.runtime.durable.inventory.iter().position(|row| {
            row.container == container
                && row.stack_id == stack_id
                && row.item_id == EXTRACTOR_BATTERY_ITEM_ID
                && row.variant_id == variant_id
                && row.available > 0
                && actor_owns_inventory_container(actor_id, &row.container)
        }) else {
            return Err(AuthorityRejectReason::MissingBattery);
        };
        self.consume_inventory_row(row_index)
            .map_err(|_| AuthorityRejectReason::MissingBattery)
    }

    fn require_extractor_owner_and_range(
        &self,
        actor: &ActorAuthorityState,
        extractor: &PlacedExtractorState,
    ) -> Result<(), AuthorityRejectReason> {
        if extractor.owner_actor_id != actor.id {
            return Err(AuthorityRejectReason::NotExtractorOwner);
        }
        if !self.actor_within_extractor_interaction_range(actor, extractor) {
            return Err(AuthorityRejectReason::NotAtExtractor);
        }
        Ok(())
    }

    fn actor_within_extractor_interaction_range(
        &self,
        actor: &ActorAuthorityState,
        extractor: &PlacedExtractorState,
    ) -> bool {
        actor.area_id == extractor.area_id
            && position_distance_milli(actor.position, extractor.position)
                <= POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS
    }

    fn extractor_in_interest(
        &self,
        observer: &ActorAuthorityState,
        extractor: &PlacedExtractorState,
        radius_cells: i32,
    ) -> bool {
        if observer.area_id != extractor.area_id {
            return false;
        }
        if extractor.owner_actor_id == observer.id {
            return true;
        }
        let radius_milli = radius_cells.max(0).saturating_mul(MILLI_CELLS_PER_CELL);
        position_distance_milli(observer.position, extractor.position) <= radius_milli
    }

    fn placed_extractor_snapshot_from_state(
        &self,
        extractor: &PlacedExtractorState,
        observer: Option<&ActorAuthorityState>,
    ) -> AuthorityPlacedExtractorSnapshot {
        let extractor = self.materialized_placed_extractor_state(extractor);
        AuthorityPlacedExtractorSnapshot {
            extractor_id: extractor.extractor_id.clone(),
            owner_actor_id: extractor.owner_actor_id.clone(),
            area_id: extractor.area_id.clone(),
            cell_x: extractor.cell.x,
            cell_y: extractor.cell.y,
            mode: extractor.mode,
            biome: extractor.biome,
            hopper_pct: percent_u8(extractor.hopper_milli, HOPPER_CAP_MILLI),
            collectable_units: u32::try_from(extractor.hopper_milli / 1_000).unwrap_or(u32::MAX),
            battery_pct: extractor_battery_percent(&extractor),
            is_owner: observer.is_some_and(|actor| actor.id == extractor.owner_actor_id),
            family_label: extractor.family.clone(),
        }
    }
}

fn extractor_biome_for_area(area: &AreaAuthorityState) -> ExtractorBiome {
    let kind = area.kind.to_ascii_lowercase();
    if kind.contains("forest") || kind.contains("wood") || kind.contains("verdance") {
        ExtractorBiome::Forest
    } else {
        ExtractorBiome::Desert
    }
}

fn extractor_power_mode_after_manual_stop(extractor: &PlacedExtractorState) -> ExtractorMode {
    if extractor.battery_remaining_seconds > 0 && extractor.battery_variant_id > 0 {
        ExtractorMode::Battery
    } else {
        ExtractorMode::Idle
    }
}

fn work_seconds_until_resource_epoch_boundary(work_tick: u64) -> u64 {
    let epoch_end_tick = resource_spawn_epoch(work_tick)
        .saturating_add(1)
        .saturating_mul(RESOURCE_SPAWN_EPOCH_TICKS.max(1));
    epoch_end_tick
        .saturating_sub(work_tick)
        .max(1)
        .saturating_add(EXTRACTOR_TICK_INTERVAL_TICKS.saturating_sub(1))
        / EXTRACTOR_TICK_INTERVAL_TICKS
}

fn extractor_tool_rate_milli(variant_id: u32) -> u16 {
    if variant_id == 0 {
        500
    } else {
        u16::try_from(variant_id.min(1_000)).unwrap_or(1_000)
    }
}

fn percent_u8(numerator: u64, denominator: u64) -> u8 {
    if denominator == 0 {
        return 0;
    }
    let pct = numerator.saturating_mul(100) / denominator;
    u8::try_from(pct.min(100)).unwrap_or(100)
}

fn extractor_battery_percent(extractor: &PlacedExtractorState) -> u8 {
    if extractor.battery_remaining_seconds == 0 || extractor.battery_variant_id == 0 {
        return 0;
    }
    let Some(capacity_seconds) = decode_battery_runtime_seconds(extractor.battery_variant_id)
    else {
        return 0;
    };
    if capacity_seconds == 0 {
        return 0;
    }
    percent_u8(
        u64::from(extractor.battery_remaining_seconds.min(capacity_seconds)),
        u64::from(capacity_seconds),
    )
}

fn parse_extractor_inventory_stack_id(value: &str) -> Option<u64> {
    let id = value.trim().parse::<u64>().ok()?;
    (id > 0).then_some(id)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractorMode {
    Idle,
    Manual,
    Battery,
}

impl ExtractorMode {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Idle => 1,
            Self::Manual => 2,
            Self::Battery => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractorBiome {
    Desert,
    Forest,
}

impl ExtractorBiome {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Desert => 1,
            Self::Forest => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlacedExtractorState {
    pub(super) extractor_id: String,
    pub(super) owner_actor_id: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) position: AuthorityPosition,
    pub(super) family: String,
    pub(super) resource_item_id: u32,
    pub(super) resource_variant_id: u32,
    pub(super) tool_variant_id: u32,
    pub(super) hopper_milli: u64,
    pub(super) placed_at_tick: u64,
    pub(super) mode: ExtractorMode,
    pub(super) next_extractor_tick: u64,
    pub(super) biome: ExtractorBiome,
    pub(super) battery_remaining_seconds: u32,
    pub(super) battery_variant_id: u32,
    #[serde(default)]
    pub(super) extraction_started_tick: u64,
    #[serde(default)]
    pub(super) battery_inserted_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlacedExtractorSnapshot {
    pub extractor_id: String,
    pub owner_actor_id: String,
    pub area_id: String,
    pub cell_x: i32,
    pub cell_y: i32,
    pub mode: ExtractorMode,
    pub biome: ExtractorBiome,
    pub hopper_pct: u8,
    pub collectable_units: u32,
    pub battery_pct: u8,
    pub is_owner: bool,
    pub family_label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityPlacedExtractorsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
}
