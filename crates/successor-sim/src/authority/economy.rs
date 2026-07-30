use super::*;

pub(super) const PROFESSION_TRAINER_INTERACTION_RADIUS_MILLI_CELLS: i32 = 1_750;
const SKILL_BOX_TRAINING_ACTION_MS: u64 = 400;
const CAREER_RESPEC_ACTION_MS: u64 = 1_200;
const CAREER_RESPEC_BASE_CREDIT_COST: u64 = 500;
const CAREER_RESPEC_PER_BOX_CREDIT_COST: u64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TakeLootSourceKind {
    HumanoidCorpse,
    CreatureCorpse,
    Cache,
    PlayerCorpse,
}

#[derive(Debug, Clone)]
struct TakeLootSource {
    kind: TakeLootSourceKind,
    target_id: String,
    area_id: String,
    position: AuthorityPosition,
    cell: AuthorityCell,
    loot_rights_actor_id: Option<String>,
}

fn resource_survey_range_cells(actor: &ActorAuthorityState) -> i32 {
    // Craftsman survey track scales range 24 -> 44 cells (profession-stats-design.md §2.4).
    // Same wire payload shape; the number is the atomic modifier on the survey primitive.
    actor.professions.craftsman_survey_range_cells()
}

fn auto_train_skill_box_candidates(actor: &ActorAuthorityState) -> Vec<String> {
    career_goal_template_for_actor(actor)
        .map(|goal| {
            goal.target_skill_boxes()
                .into_iter()
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn career_respec_credit_cost(removed_box_count: usize) -> u64 {
    if removed_box_count == 0 {
        0
    } else {
        CAREER_RESPEC_BASE_CREDIT_COST.saturating_add(
            CAREER_RESPEC_PER_BOX_CREDIT_COST.saturating_mul(removed_box_count as u64),
        )
    }
}

fn field_supply_xp_track(
    profession: AuthorityProfessionKind,
    output_item_id: u32,
) -> &'static [&'static str] {
    match profession {
        AuthorityProfessionKind::Medic => &["medical-crafting"],
        AuthorityProfessionKind::Craftsman if matches!(output_item_id, AMMO_SLUG_IRON_ITEM_ID) => {
            &["assembly"]
        }
        _ => &[],
    }
}

fn auto_medical_experiment_allocation(
    actor: &ActorAuthorityState,
    _kind: MedicalSchematicKind,
) -> (u8, u8, u8) {
    let points = actor.professions.medical_experimentation_points();
    if points == 0 {
        return (0, 0, 0);
    }
    let mut potency = points.saturating_mul(2) / 3;
    if potency == 0 {
        potency = 1;
    }
    let quantity = points.saturating_sub(potency);
    (potency, quantity, 0)
}

fn exchange_container_footprint_distance_milli(
    position: AuthorityPosition,
    container: &ExchangeContainerAuthorityState,
) -> i32 {
    let dx = if position.x < container.left_milli {
        container.left_milli.saturating_sub(position.x)
    } else if position.x > container.right_milli {
        position.x.saturating_sub(container.right_milli)
    } else {
        0
    };
    let dy = if position.y < container.top_milli {
        container.top_milli.saturating_sub(position.y)
    } else if position.y > container.bottom_milli {
        position.y.saturating_sub(container.bottom_milli)
    } else {
        0
    };
    distance_milli_components(dx, dy)
}

fn parse_inventory_stack_id(value: &str) -> Option<u64> {
    let id = value.trim().parse::<u64>().ok()?;
    (id > 0).then_some(id)
}

impl SliceAuthorityState {
    pub(super) fn prune_empty_inventory_rows(&mut self) {
        self.runtime
            .durable
            .inventory
            .retain(|row| row.quantity > 0 || row.item_id == AMMO_SLUG_IRON_ITEM_ID);
    }
    /// Remove creator-clothing entries from the worn projection when an actor no
    /// longer owns any physical copy. Trade settlement calls this after both sides
    /// have moved their rows, so worn truth cannot outlive the last owned copy.
    pub(super) fn reconcile_actor_worn_clothing(&mut self, actor_id: &str) {
        let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
            return;
        };
        let worn_keys = actor
            .worn
            .iter()
            .filter_map(|piece| {
                creator_clothing_item_id(&piece.item).map(|item_id| (piece.item.clone(), item_id))
            })
            .collect::<Vec<_>>();
        if worn_keys.is_empty() {
            return;
        }
        let keep = worn_keys
            .iter()
            .filter(|(_, item_id)| {
                self.runtime.durable.inventory.iter().any(|row| {
                    row.item_id == *item_id
                        && row.quantity > 0
                        && actor_owns_inventory_container(actor_id, &row.container)
                })
            })
            .map(|(key, _)| key)
            .collect::<std::collections::BTreeSet<_>>();
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.worn.retain(|piece| {
                creator_clothing_item_id(&piece.item).is_none_or(|_| keep.contains(&piece.item))
            });
        }
    }

    pub(super) fn next_inventory_stack_id(&mut self, container: &str) -> u64 {
        let fallback_next = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| row.container == container)
            .map(|row| row.stack_id)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
            .max(1);
        let next = self
            .runtime
            .durable
            .inventory_stack_counters
            .entry(container.to_owned())
            .or_insert(fallback_next);
        if *next < fallback_next {
            *next = fallback_next;
        }
        let id = *next;
        *next = (*next).saturating_add(1).max(1);
        id
    }

    pub(super) fn resource_concentration_milli_for_area(
        &self,
        area_id: &str,
        seed: u32,
        cell: AuthorityCell,
    ) -> u16 {
        self.runtime
            .durable
            .world
            .areas
            .get(area_id)
            .map(|area| {
                resource_concentration_milli_in_area(seed, &area.id, area.width, area.height, cell)
            })
            .unwrap_or_else(|| resource_concentration_milli(seed, cell))
    }

    fn player_can_mutate_inventory_container(
        &self,
        actor: &ActorAuthorityState,
        container: &str,
    ) -> bool {
        if Self::loot_inventory_container_is_read_only(container) {
            return false;
        }
        if actor_owns_inventory_container(&actor.id, container) {
            return true;
        }
        container == EXCHANGE_CONTAINER && self.actor_within_exchange_interaction_range(actor)
    }

    pub(super) fn consume_inventory_row(
        &mut self,
        row_index: usize,
    ) -> Result<(), AuthorityRejectReason> {
        let row = self
            .runtime
            .durable
            .inventory
            .get_mut(row_index)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if row.available == 0 || row.quantity == 0 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        row.quantity = row.quantity.saturating_sub(1);
        row.available = row.available.saturating_sub(1);
        if row.reserved > row.quantity {
            row.reserved = row.quantity;
        }
        self.prune_empty_inventory_rows();
        Ok(())
    }

    pub(super) fn tracked_actor_ammo_available(&self, actor_id: &str, item_id: u32) -> Option<u32> {
        if self.actor_tracks_ammo_item(actor_id, item_id) {
            Some(
                self.actor_inventory_item_available(actor_id, item_id)
                    .unwrap_or(0),
            )
        } else {
            None
        }
    }

    pub(super) fn slugthrower_magazine_profile(&self, actor_id: &str) -> WeaponMagazineProfile {
        let variant_id = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| actor.equipped_weapon_variant_id)
            .unwrap_or(0);
        let reload_ms = slugthrower_reload_time_ms(SLUGTHROWER_RELOAD_MS, variant_id);
        WeaponMagazineProfile {
            magazine_size: SLUGTHROWER_MAGAZINE_SIZE,
            reload_ticks: ms_to_ticks_round(reload_ms, self.runtime.durable.world.tick_rate_hz)
                .max(1),
        }
    }

    pub(super) fn complete_actor_weapon_reload_if_due(
        &mut self,
        actor_id: &str,
        weapon_id: AuthorityWeaponId,
        ammo_type: AuthorityAmmoTypeId,
    ) -> Result<(), AuthorityRejectReason> {
        if is_melee_weapon_id(weapon_id) {
            return Ok(());
        }
        let profile = self.slugthrower_magazine_profile(actor_id);
        let current = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .slugthrower_magazine;
        if current.reload_until_tick == 0 || self.runtime.durable.tick < current.reload_until_tick {
            return Ok(());
        }
        let needed = profile.magazine_size.saturating_sub(current.loaded_rounds);
        let item_id = ammo_item_id_for_type(ammo_type);
        let tracked_reserve =
            item_id.and_then(|id| self.tracked_actor_ammo_available(actor_id, id));
        let moved = tracked_reserve
            .map(|reserve| reserve.min(needed))
            .unwrap_or(needed);
        if moved > 0 {
            if let Some(item_id) = item_id {
                if self.actor_tracks_ammo_item(actor_id, item_id) {
                    self.consume_actor_inventory_quantity(actor_id, item_id, moved)
                        .map_err(|_| AuthorityRejectReason::AmmoUnavailable)?;
                }
            }
        }
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.slugthrower_magazine.loaded_rounds = actor
                .slugthrower_magazine
                .loaded_rounds
                .saturating_add(moved)
                .min(profile.magazine_size);
            actor.slugthrower_magazine.reload_until_tick = 0;
        }
        Ok(())
    }

    pub(super) fn start_actor_weapon_reload(
        &mut self,
        actor_id: &str,
        weapon_id: AuthorityWeaponId,
        ammo_type: AuthorityAmmoTypeId,
    ) -> Result<(), AuthorityRejectReason> {
        if is_melee_weapon_id(weapon_id) {
            return Ok(());
        }
        self.complete_actor_weapon_reload_if_due(actor_id, weapon_id, ammo_type)?;
        let item_id = ammo_item_id_for_type(ammo_type);
        let reserve_available = item_id
            .and_then(|id| self.tracked_actor_ammo_available(actor_id, id))
            .unwrap_or(SLUGTHROWER_MAGAZINE_SIZE);
        let profile = self.slugthrower_magazine_profile(actor_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.slugthrower_magazine.reload_until_tick > self.runtime.durable.tick {
            actor.next_fire_tick = actor
                .next_fire_tick
                .max(actor.slugthrower_magazine.reload_until_tick);
            return Err(AuthorityRejectReason::FireCooldown);
        }
        if actor.slugthrower_magazine.loaded_rounds >= profile.magazine_size {
            return Err(AuthorityRejectReason::AmmoUnavailable);
        }
        if reserve_available == 0 {
            return Err(AuthorityRejectReason::AmmoUnavailable);
        }
        actor.slugthrower_magazine.reload_until_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(profile.reload_ticks.max(1));
        actor.next_fire_tick = actor
            .next_fire_tick
            .max(actor.slugthrower_magazine.reload_until_tick);
        Ok(())
    }

    fn actor_uses_unlimited_ammo_item(&self, actor_id: &str, item_id: u32) -> bool {
        ammo_item_name(item_id).is_some()
            && self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .is_some_and(actor_uses_unlimited_ammo)
    }

    fn remove_actor_inventory_item_rows(&mut self, actor_id: &str, item_id: u32) {
        self.runtime.durable.inventory.retain(|row| {
            row.item_id != item_id || !actor_owns_inventory_container(actor_id, &row.container)
        });
    }

    pub(super) fn actor_tracks_ammo_item(&self, actor_id: &str, item_id: u32) -> bool {
        if self.actor_uses_unlimited_ammo_item(actor_id, item_id) {
            return false;
        }
        if !self.runtime.durable.actors.contains_key(actor_id) {
            return false;
        }
        self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
        })
    }

    pub(super) fn actor_inventory_item_available(
        &self,
        actor_id: &str,
        item_id: u32,
    ) -> Option<u32> {
        if self.actor_uses_unlimited_ammo_item(actor_id, item_id) {
            return None;
        }
        let mut found = false;
        let available = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| {
                found = true;
                row.available
            })
            .sum();
        found.then_some(available)
    }

    pub(super) fn remove_unlimited_actor_ammo_inventory(&mut self) {
        let unlimited_actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| actor_uses_unlimited_ammo(actor))
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        if unlimited_actor_ids.is_empty() {
            return;
        }
        self.runtime.durable.inventory.retain(|row| {
            ammo_item_name(row.item_id).is_none()
                || !unlimited_actor_ids
                    .iter()
                    .any(|actor_id| actor_owns_inventory_container(actor_id, &row.container))
        });
        for actor_id in unlimited_actor_ids {
            if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                actor.slugthrower_magazine.reload_until_tick = 0;
            }
        }
    }

    pub(super) fn inventory_stack_cap_for_item(item_id: u32, fallback: u32) -> u32 {
        match item_id {
            AMMO_SLUG_IRON_ITEM_ID => AMMO_SLUG_STACK_CAP,
            item if (7301..=7335).contains(&item) => 1,
            STIMPAK_A_ITEM_ID => STIMPAK_A_STACK_CAP,
            FIELD_BANDAGE_ITEM_ID => FIELD_BANDAGE_STACK_CAP,
            RESUSCITATION_KIT_ITEM_ID => RESUSCITATION_KIT_STACK_CAP,
            PERSONAL_SHIELD_GENERATOR_ITEM_ID
            | CRAFTED_SLUGTHROWER_ITEM_ID
            | VIBROSWORD_WEAPON_ITEM_ID
            | PLASMA_SWORD_ITEM_ID
            | SCRAPLINE_MACHETE_ITEM_ID
            | FIELD_SABER_ITEM_ID
            | QUARRY_CHOPPER_ITEM_ID
            | STEN_MK2_ITEM_ID
            | KILN_ENERGY_CELL_ITEM_ID
            | LIGHTNING_CARBINE_ITEM_ID => PERSONAL_SHIELD_GENERATOR_STACK_CAP,
            BODY_ENHANCEMENT_PACK_A_ITEM_ID | SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID => {
                ENHANCEMENT_PACK_A_STACK_CAP
            }
            MINERAL_SURVEY_TOOL_ITEM_ID
            | CHEMICAL_SURVEY_TOOL_ITEM_ID
            | GAS_SURVEY_TOOL_ITEM_ID
            | WATER_SURVEY_TOOL_ITEM_ID => SURVEY_TOOL_STACK_CAP,
            METAL_EXTRACTOR_TOOL_ITEM_ID
            | CHEMICAL_EXTRACTOR_TOOL_ITEM_ID
            | GAS_EXTRACTOR_TOOL_ITEM_ID
            | WATER_EXTRACTOR_TOOL_ITEM_ID => METAL_EXTRACTOR_STACK_CAP,
            EXTRACTOR_BATTERY_ITEM_ID => EXTRACTOR_BATTERY_STACK_CAP,
            CREDIT_CHIP_ITEM_ID => CREDIT_CHIP_STACK_CAP,
            CULTURE_MEDIUM_ITEM_ID | MUTAGEN_ITEM_ID | STABILIZER_ITEM_ID | SERUM_ITEM_ID => {
                BIO_REAGENT_STACK_CAP
            }
            item if is_fertilizer_item(item) => FERTILIZER_STACK_CAP,
            item if is_crop_seed_item_id(item) => BIO_SEED_STACK_CAP,
            item if is_resource_item_id(item) => RESOURCE_STACK_CAP,
            _ => fallback.max(1),
        }
    }

    pub(super) fn equip_personal_shield_from_inventory_if_needed(
        &mut self,
        actor_id: &str,
    ) -> Result<bool, AuthorityRejectReason> {
        let actor_cell = {
            let actor = self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            if !actor_can_use_personal_shield(actor) {
                return Ok(false);
            }
            if actor.personal_shield.is_some() {
                return Ok(false);
            }
            actor.cell
        };
        if self.actor_inventory_available_quantity(actor_id, PERSONAL_SHIELD_GENERATOR_ITEM_ID) == 0
        {
            return Ok(false);
        }
        self.consume_actor_inventory_quantity(actor_id, PERSONAL_SHIELD_GENERATOR_ITEM_ID, 1)?;
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor.personal_shield = Some(PersonalShieldAuthorityState::fresh(
            self.runtime.durable.tick,
        ));
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{actor_id} equipped Personal Shield Generator"),
            cell: Some(CellSnapshot::new(actor_cell.x, actor_cell.y)),
        });
        Ok(true)
    }

    pub(super) fn auto_equip_personal_shields(&mut self) {
        let actor_ids: Vec<String> = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| actor_can_use_personal_shield(actor) && actor.personal_shield.is_none())
            .map(|actor| actor.id.clone())
            .collect();
        for actor_id in actor_ids {
            let _ = self.equip_personal_shield_from_inventory_if_needed(&actor_id);
        }
    }

    pub(super) fn economy_action_ticks(&self, action_ms: u64) -> u64 {
        ms_to_ticks_round(action_ms, self.runtime.durable.world.tick_rate_hz).max(1)
    }

    pub(super) fn ensure_actor_economy_action_ready(
        &self,
        actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if self.runtime.durable.tick < actor.next_economy_action_tick {
            return Err(AuthorityRejectReason::EconomyCooldown);
        }
        Ok(())
    }

    pub(super) fn ensure_actor_resource_survey_ready(
        &self,
        actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if self.runtime.durable.tick < actor.next_resource_survey_tick {
            return Err(AuthorityRejectReason::EconomyCooldown);
        }
        Ok(())
    }

    pub(super) fn set_actor_resource_survey_cooldown(
        &mut self,
        actor_id: &str,
        action_ms: u64,
    ) -> Result<u64, AuthorityRejectReason> {
        let ready_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(self.economy_action_ticks(action_ms));
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor.next_resource_survey_tick = actor.next_resource_survey_tick.max(ready_tick);
        Ok(actor.next_resource_survey_tick)
    }

    pub(super) fn set_actor_economy_action_cooldown(
        &mut self,
        actor_id: &str,
        action_ms: u64,
    ) -> Result<(), AuthorityRejectReason> {
        let ready_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(self.economy_action_ticks(action_ms));
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        actor.next_economy_action_tick = actor.next_economy_action_tick.max(ready_tick);
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn clear_actor_economy_action_cooldown(&mut self, actor_id: &str) {
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.next_economy_action_tick = self.runtime.durable.tick;
            actor.next_resource_survey_tick = self.runtime.durable.tick;
        }
    }

    pub(super) fn award_profession_xp(
        &mut self,
        actor_id: &str,
        profession: AuthorityProfessionKind,
        amount: u64,
    ) -> Result<u64, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        Ok(actor.professions.award_xp(profession, amount))
    }

    pub(super) fn award_profession_track_xp(
        &mut self,
        actor_id: &str,
        profession: AuthorityProfessionKind,
        track: &str,
        amount: u64,
    ) -> Result<u64, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let (total, _) = actor.professions.award_track_xp(profession, track, amount);
        Ok(total)
    }

    pub(super) fn award_profession_tracks_xp(
        &mut self,
        actor_id: &str,
        profession: AuthorityProfessionKind,
        tracks: &[&str],
        amount: u64,
    ) -> Result<u64, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        Ok(actor
            .professions
            .award_tracks_xp(profession, tracks, amount))
    }

    pub(super) fn apply_purchase_skill_box(
        &mut self,
        config: &SliceAuthorityConfig,
        skill_box_id: &str,
        trainer_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let definition = authority_skill_box_definition(skill_box_id)
            .ok_or(AuthorityRejectReason::UnknownSkillBox)?;
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
        self.require_profession_trainer_for_actor(&actor, trainer_actor_id, definition.profession)?;
        Self::validate_skill_box_training(&actor, &definition)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        self.train_skill_box_for_actor(&actor.id, &definition)?;
        self.set_actor_economy_action_cooldown(&actor.id, SKILL_BOX_TRAINING_ACTION_MS)?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} trained {} with {}",
                actor.id, definition.id, trainer_actor_id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_unlearn_skill_box(
        &mut self,
        config: &SliceAuthorityConfig,
        skill_box_id: &str,
        trainer_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let definition = authority_skill_box_definition(skill_box_id)
            .ok_or(AuthorityRejectReason::UnknownSkillBox)?;
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
        self.require_profession_trainer_for_actor(&actor, trainer_actor_id, definition.profession)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        let cell = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(&actor.id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            actor.professions.unlearn_skill_box(&definition.id)?;
            actor.capabilities = ActorCapabilityState::from_professions_and_grants(
                &actor.professions,
                &actor.capability_grants,
            );
            actor.cell
        };
        self.unequip_actor_weapon_if_uncertified(&actor.id)?;
        self.set_actor_economy_action_cooldown(&actor.id, SKILL_BOX_TRAINING_ACTION_MS)?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} unlearned {} with {} (refunded {} skill points and {} XP)",
                actor.id,
                definition.id,
                trainer_actor_id,
                definition.skill_point_cost,
                definition.xp_required
            ),
            cell: Some(CellSnapshot::new(cell.x, cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_set_career_goal(
        &mut self,
        config: &SliceAuthorityConfig,
        goal_id: &str,
        trainer_actor_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let goal = authority_career_goal_template(goal_id)
            .ok_or(AuthorityRejectReason::UnknownCareerGoal)?;
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
        let trainer = self
            .runtime
            .durable
            .actors
            .get(trainer_actor_id)
            .ok_or(AuthorityRejectReason::TrainerUnavailable)?;
        if trainer.life_state != AuthorityLifeState::Alive
            || trainer.area_id != actor.area_id
            || !is_profession_trainer_authority_actor(trainer)
            || position_distance_milli(actor.position, trainer.position)
                > PROFESSION_TRAINER_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::TrainerUnavailable);
        }
        self.ensure_actor_economy_action_ready(&actor.id)?;
        let (removed, cost, cell) = self.set_actor_career_goal_and_respec(&actor.id, goal)?;
        self.set_actor_economy_action_cooldown(&actor.id, CAREER_RESPEC_ACTION_MS)?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} set career goal {} with {} (dropped {} boxes, cost {} credits)",
                actor.id,
                goal.id,
                trainer_actor_id,
                removed.len(),
                cost
            ),
            cell: Some(CellSnapshot::new(cell.x, cell.y)),
        });
        Ok(())
    }

    fn validate_skill_box_training(
        actor: &ActorAuthorityState,
        definition: &AuthoritySkillBoxDefinition,
    ) -> Result<(), AuthorityRejectReason> {
        let is_novice_skill_box = definition.id.ends_with("-novice");
        if !is_novice_skill_box && !actor.professions.has(definition.profession) {
            return Err(AuthorityRejectReason::SkillPrerequisiteMissing);
        }
        if actor.professions.has_skill_box(&definition.id) {
            return Err(AuthorityRejectReason::SkillAlreadyLearned);
        }
        if definition
            .prerequisites
            .iter()
            .any(|prerequisite| !actor.professions.has_skill_box(prerequisite))
        {
            return Err(AuthorityRejectReason::SkillPrerequisiteMissing);
        }
        if actor.professions.xp_for_skill_box_definition(definition) < definition.xp_required {
            return Err(AuthorityRejectReason::InsufficientProfessionXp);
        }
        if actor
            .professions
            .skill_points_used()
            .saturating_add(definition.skill_point_cost)
            > actor.professions.skill_point_cap
        {
            return Err(AuthorityRejectReason::InsufficientSkillPoints);
        }
        Ok(())
    }

    pub(super) fn train_skill_box_for_actor(
        &mut self,
        actor_id: &str,
        definition: &AuthoritySkillBoxDefinition,
    ) -> Result<AuthorityCell, AuthorityRejectReason> {
        let (cell, grant_bioengineer_kit) = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            actor
                .professions
                .spend_xp_for_skill_box_definition(definition)?;
            let learned_skill_box = actor.professions.train_skill_box(definition);
            actor.capabilities = ActorCapabilityState::from_professions_and_grants(
                &actor.professions,
                &actor.capability_grants,
            );
            (
                actor.cell,
                learned_skill_box
                    && definition.profession == AuthorityProfessionKind::BioEngineer
                    && definition.id == "bioengineer-novice",
            )
        };
        if grant_bioengineer_kit {
            self.ensure_actor_bioengineer_novice_kit(actor_id);
        }
        Ok(cell)
    }

    fn set_actor_career_goal_and_respec(
        &mut self,
        actor_id: &str,
        goal: AuthorityCareerGoalTemplate,
    ) -> Result<(Vec<String>, u64, AuthorityCell), AuthorityRejectReason> {
        let (removed, cost, cell) = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            let mut planned_professions = actor.professions.clone();
            let removed = planned_professions.drop_skill_boxes_outside_goal(goal);
            let cost = career_respec_credit_cost(removed.len());
            if planned_professions.credits < cost {
                return Err(AuthorityRejectReason::InsufficientCredits);
            }
            planned_professions.credits = planned_professions.credits.saturating_sub(cost);
            actor.professions = planned_professions;
            actor.career_goal_id = Some(goal.id.to_owned());
            actor.capabilities = ActorCapabilityState::from_professions_and_grants(
                &actor.professions,
                &actor.capability_grants,
            );
            (removed, cost, actor.cell)
        };
        self.unequip_actor_weapon_if_uncertified(actor_id)?;
        Ok((removed, cost, cell))
    }

    fn auto_respec_actor_toward_career_goal(
        &mut self,
        actor_id: &str,
    ) -> Option<(String, String, usize, u64, AuthorityCell)> {
        let actor = self.runtime.durable.actors.get(actor_id)?.clone();
        let goal = career_goal_template_for_actor(&actor)?;
        let target = goal.target_skill_box_set();
        if actor
            .professions
            .skill_boxes
            .iter()
            .all(|skill_box_id| target.contains(skill_box_id))
        {
            return None;
        }
        let trainer_actor_id = self.same_area_profession_trainer_actor_id(&actor)?;
        if self.ensure_actor_economy_action_ready(&actor.id).is_err() {
            return None;
        }
        let Ok((removed, cost, cell)) = self.set_actor_career_goal_and_respec(&actor.id, goal)
        else {
            return None;
        };
        if self
            .set_actor_economy_action_cooldown(&actor.id, CAREER_RESPEC_ACTION_MS)
            .is_err()
        {
            return None;
        }
        Some((
            goal.id.to_owned(),
            trainer_actor_id,
            removed.len(),
            cost,
            cell,
        ))
    }

    pub(super) fn tick_auto_train_player_like_pawns(&mut self) {
        let interval = u64::from(self.runtime.durable.world.tick_rate_hz.max(1));
        if interval > 1 && self.runtime.durable.tick % interval != 0 {
            return;
        }
        let actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                is_player_like_role(&actor.role)
                    && !is_human_player_actor(actor)
                    && actor.life_state == AuthorityLifeState::Alive
                    && actor.sleep.remaining_ticks == 0
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            if let Some((goal_id, trainer_actor_id, removed_count, cost, cell)) =
                self.auto_respec_actor_toward_career_goal(&actor_id)
            {
                self.record_timeline_event(TimelineEventSnapshot {
                    tick: self.runtime.durable.tick,
                    label: format!(
                        "{} auto-respecced toward {} with {} (dropped {} boxes, cost {} credits)",
                        actor_id, goal_id, trainer_actor_id, removed_count, cost
                    ),
                    cell: Some(CellSnapshot::new(cell.x, cell.y)),
                });
                continue;
            }
            let Some((definition, trainer_actor_id, cell)) =
                self.next_auto_train_skill_box_for_actor(&actor_id)
            else {
                continue;
            };
            if self
                .train_skill_box_for_actor(&actor_id, &definition)
                .is_err()
            {
                continue;
            }
            self.record_timeline_event(TimelineEventSnapshot {
                tick: self.runtime.durable.tick,
                label: format!(
                    "{} auto-trained {} with {}",
                    actor_id, definition.id, trainer_actor_id
                ),
                cell: Some(CellSnapshot::new(cell.x, cell.y)),
            });
        }
    }

    fn next_auto_train_skill_box_for_actor(
        &self,
        actor_id: &str,
    ) -> Option<(AuthoritySkillBoxDefinition, String, AuthorityCell)> {
        let actor = self.runtime.durable.actors.get(actor_id)?;
        let trainer_actor_id = self.same_area_profession_trainer_actor_id(actor)?;
        for skill_box_id in auto_train_skill_box_candidates(actor) {
            let Some(definition) = authority_skill_box_definition(&skill_box_id) else {
                continue;
            };
            if Self::validate_skill_box_training(actor, &definition).is_ok() {
                return Some((definition, trainer_actor_id, actor.cell));
            }
        }
        None
    }

    fn same_area_profession_trainer_actor_id(&self, actor: &ActorAuthorityState) -> Option<String> {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|candidate| {
                candidate.life_state == AuthorityLifeState::Alive
                    && candidate.area_id == actor.area_id
                    && is_profession_trainer_authority_actor(candidate)
            })
            .map(|candidate| candidate.id.clone())
            .min()
    }

    pub(super) fn apply_set_profession_title(
        &mut self,
        config: &SliceAuthorityConfig,
        title_id: Option<&str>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        actor
            .professions
            .set_active_title_id(title_id)
            .map_err(|_| AuthorityRejectReason::UnknownProfessionTitle)?;
        let label = actor
            .professions
            .active_title()
            .map(|title| title.label)
            .unwrap_or_else(|| "none".to_owned());
        let actor_id = actor.id.clone();
        let cell = actor.cell;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} set profession title to {}", actor_id, label),
            cell: Some(CellSnapshot::new(cell.x, cell.y)),
        });
        Ok(())
    }

    pub(super) fn actor_has_inventory_item(&self, actor_id: &str, item_id: u32) -> bool {
        self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == item_id
                && row.available > 0
                && actor_owns_inventory_container(actor_id, &row.container)
        })
    }

    pub(super) fn require_actor_profession(
        actor: &ActorAuthorityState,
        profession: AuthorityProfessionKind,
    ) -> Result<(), AuthorityRejectReason> {
        if actor_has_profession(actor, profession) {
            Ok(())
        } else {
            Err(AuthorityRejectReason::TargetUnavailable)
        }
    }

    pub(super) fn require_actor_inventory_item(
        &self,
        actor_id: &str,
        item_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        if self.actor_has_inventory_item(actor_id, item_id) {
            Ok(())
        } else {
            Err(AuthorityRejectReason::IngredientUnavailable)
        }
    }

    pub(super) fn require_actor_survey_tool(
        &self,
        actor_id: &str,
        family: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let category = resource_category_for_family(family)
            .ok_or(AuthorityRejectReason::InvalidResourceFamily)?;
        if self.actor_inventory_available_quantity(actor_id, category.survey_tool_item_id()) > 0 {
            Ok(())
        } else {
            Err(AuthorityRejectReason::MissingSurveyTool)
        }
    }

    pub(super) fn add_actor_inventory_stack(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
        item_name: &str,
        quantity: u32,
        stack_cap: u32,
        container_suffix: &str,
    ) -> u32 {
        let cap = Self::inventory_stack_cap_for_item(item_id, stack_cap);
        let mut remaining = quantity;
        let mut added = 0_u32;
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.item_id == item_id
                && row.variant_id == variant_id
                && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            if remaining == 0 {
                break;
            }
            row.item = item_name.to_owned();
            let free = cap.saturating_sub(row.quantity);
            if free == 0 {
                continue;
            }
            let delta = free.min(remaining);
            row.quantity = row.quantity.saturating_add(delta);
            row.reserved = row.reserved.min(row.quantity);
            row.available = row.quantity.saturating_sub(row.reserved);
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        while remaining > 0 {
            let delta = cap.min(remaining);
            let container = format!("{actor_id}:{container_suffix}");
            let stack_id = self.next_inventory_stack_id(&container);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container,
                item: item_name.to_owned(),
                item_id,
                variant_id,
                quantity: delta,
                reserved: 0,
                available: delta,
            });
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        added
    }
    pub(super) fn add_actor_named_inventory_stack(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
        item_name: &str,
        quantity: u32,
        stack_cap: u32,
        container_suffix: &str,
    ) -> u32 {
        let cap = Self::inventory_stack_cap_for_item(item_id, stack_cap);
        let mut remaining = quantity;
        let mut added = 0_u32;
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.item_id == item_id
                && row.variant_id == variant_id
                && row.item == item_name
                && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            if remaining == 0 {
                break;
            }
            let free = cap.saturating_sub(row.quantity);
            if free == 0 {
                continue;
            }
            let delta = free.min(remaining);
            row.quantity = row.quantity.saturating_add(delta);
            row.reserved = row.reserved.min(row.quantity);
            row.available = row.quantity.saturating_sub(row.reserved);
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        while remaining > 0 {
            let delta = cap.min(remaining);
            let container = format!("{actor_id}:{container_suffix}");
            let stack_id = self.next_inventory_stack_id(&container);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container,
                item: item_name.to_owned(),
                item_id,
                variant_id,
                quantity: delta,
                reserved: 0,
                available: delta,
            });
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        added
    }

    pub(super) fn consume_actor_inventory_quantity(
        &mut self,
        actor_id: &str,
        item_id: u32,
        mut quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let available = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| row.available)
            .sum::<u32>();
        if available < quantity {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            if quantity == 0 {
                break;
            }
            let taken = row.available.min(quantity);
            row.quantity = row.quantity.saturating_sub(taken);
            row.available = row.available.saturating_sub(taken);
            row.reserved = row.reserved.min(row.quantity);
            quantity = quantity.saturating_sub(taken);
        }
        self.prune_empty_inventory_rows();
        Ok(())
    }

    /// Total available (unreserved) quantity of an item across the actor's containers.
    pub(super) fn actor_inventory_available_quantity(&self, actor_id: &str, item_id: u32) -> u32 {
        if self.actor_uses_unlimited_ammo_item(actor_id, item_id) {
            return 0;
        }
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| row.available)
            .sum()
    }

    fn loot_inventory_container_is_read_only(container: &str) -> bool {
        container.starts_with("corpse:") || container.starts_with("cache:")
    }

    fn corpse_loot_container(actor_id: &str) -> String {
        format!("corpse:{actor_id}")
    }

    fn loot_container_available_variant(
        &self,
        container: &str,
        item_id: u32,
        variant_id: u32,
    ) -> u32 {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.container == container && row.item_id == item_id && row.variant_id == variant_id
            })
            .map(|row| row.available)
            .sum()
    }

    fn loot_container_has_available_items(&self, container: &str) -> bool {
        self.runtime
            .durable
            .inventory
            .iter()
            .any(|row| row.container == container && row.available > 0)
    }

    pub(super) fn corpse_has_loot(&self, actor_id: &str) -> bool {
        let container = Self::corpse_loot_container(actor_id);
        self.loot_container_has_available_items(&container)
    }

    fn corpse_actor_is_lootable_item_source(
        &self,
        actor: &ActorAuthorityState,
        container: &str,
    ) -> bool {
        actor_is_lootable_corpse(
            actor,
            self.loot_container_has_available_items(container),
            self.runtime.durable.tick,
        )
    }

    fn take_loot_source_for_container(
        &self,
        container: &str,
    ) -> Result<TakeLootSource, AuthorityRejectReason> {
        if let Some(corpse) = self
            .runtime
            .durable
            .player_corpses
            .get(container.strip_prefix("corpse:").unwrap_or_default())
        {
            if corpse.expiry_tick <= self.runtime.durable.tick
                || !self.loot_container_has_available_items(container)
                || corpse.container != container
            {
                return Err(AuthorityRejectReason::LootNotLootable);
            }
            return Ok(TakeLootSource {
                kind: TakeLootSourceKind::PlayerCorpse,
                target_id: corpse.id.clone(),
                area_id: corpse.area_id.clone(),
                position: corpse.position,
                cell: corpse.cell,
                loot_rights_actor_id: None,
            });
        }
        if let Some(actor_id) = container
            .strip_prefix("corpse:")
            .filter(|actor_id| !actor_id.is_empty())
        {
            let target = self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .ok_or(AuthorityRejectReason::LootTargetUnknown)?;
            if !self.corpse_actor_is_lootable_item_source(target, container) {
                return Err(AuthorityRejectReason::LootNotLootable);
            }
            return Ok(TakeLootSource {
                kind: if is_harvestable_creature_actor(target) {
                    TakeLootSourceKind::CreatureCorpse
                } else {
                    TakeLootSourceKind::HumanoidCorpse
                },
                target_id: target.id.clone(),
                area_id: target.area_id.clone(),
                position: target.position,
                cell: target.cell,
                loot_rights_actor_id: target.loot_rights_actor_id.clone(),
            });
        }

        let cache = self
            .runtime
            .durable
            .loot_caches
            .values()
            .find(|candidate| candidate.container == container)
            .or_else(|| {
                container
                    .strip_prefix("cache:")
                    .filter(|prop_id| !prop_id.is_empty())
                    .and_then(|prop_id| self.runtime.durable.loot_caches.get(prop_id))
            });
        if let Some(cache) = cache {
            if cache.emptied {
                return Err(AuthorityRejectReason::LootNotLootable);
            }
            return Ok(TakeLootSource {
                kind: TakeLootSourceKind::Cache,
                target_id: cache.prop_id.clone(),
                area_id: cache.area_id.clone(),
                position: cache.position,
                cell: cache.cell,
                loot_rights_actor_id: None,
            });
        }

        Err(AuthorityRejectReason::LootTargetUnknown)
    }

    fn mark_loot_cache_emptied_if_empty(&mut self, prop_id: &str, container: &str) {
        if self.loot_container_has_available_items(container) {
            return;
        }
        if let Some(cache) = self.runtime.durable.loot_caches.get_mut(prop_id) {
            cache.emptied = true;
        }
    }

    fn clamp_exhausted_corpse_lifetime(tick: u64, actor: &mut ActorAuthorityState) {
        let linger_ticks = if is_harvestable_creature_actor(actor) {
            CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS
        } else {
            CORPSE_EXHAUSTED_CLAMP_TICKS
        };
        let clamp_tick = tick.saturating_add(linger_ticks);
        actor.body_vanish_tick = actor.body_vanish_tick.min(clamp_tick);
        // The hidden respawn countdown begins only when the body actually
        // vanishes and tick_respawn_lifecycle enters Respawning.
        actor.respawn_tick = 0;
    }

    fn mark_corpse_exhausted_if_ready(&mut self, actor_id: &str, resource_harvest_completed: bool) {
        let container = Self::corpse_loot_container(actor_id);
        let has_items = self.loot_container_has_available_items(&container);
        let tick = self.runtime.durable.tick;
        let all_gaia_claims_spent =
            self.runtime
                .durable
                .actors
                .get(actor_id)
                .is_some_and(|actor| {
                    !actor.gaia_harvest_entitled_actor_ids.is_empty()
                        && actor
                            .gaia_harvest_entitled_actor_ids
                            .iter()
                            .all(|id| actor.gaia_harvest_claimed_actor_ids.contains(id))
                });
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return;
        };
        if actor.life_state != AuthorityLifeState::Downed
            || actor.body_vanish_tick == 0
            || tick >= actor.body_vanish_tick
        {
            return;
        }
        let is_creature = is_harvestable_creature_actor(actor);
        if is_creature
            && resource_harvest_completed
            && all_gaia_claims_spent
            && actor.creature_corpse_harvested_tick.is_none()
        {
            actor.creature_corpse_harvested_tick = Some(tick);
        }
        let exhausted =
            !has_items && (!is_creature || actor.creature_corpse_harvested_tick.is_some());
        if !exhausted {
            return;
        }
        if actor.corpse_exhausted_tick.is_none() {
            actor.corpse_exhausted_tick = Some(tick);
        }
        Self::clamp_exhausted_corpse_lifetime(tick, actor);
    }

    /// Available quantity of a SPECIFIC (item_id, variant_id) the actor owns. Trades and
    /// the exchange validate/consume by the exact variant, so a player cannot offer a
    /// cheap variant they hold while crediting the counterparty a forged high-value one.
    pub(super) fn actor_inventory_available_variant(
        &self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
    ) -> u32 {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id
                    && row.variant_id == variant_id
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| row.available)
            .sum()
    }

    /// Consume a SPECIFIC (item_id, variant_id) from the actor. Errors without consuming
    /// if the actor lacks enough of that exact variant.
    pub(super) fn consume_actor_inventory_variant(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
        mut quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        if self.actor_inventory_available_variant(actor_id, item_id, variant_id) < quantity {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.item_id == item_id
                && row.variant_id == variant_id
                && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            if quantity == 0 {
                break;
            }
            let taken = row.available.min(quantity);
            row.quantity = row.quantity.saturating_sub(taken);
            row.available = row.available.saturating_sub(taken);
            row.reserved = row.reserved.min(row.quantity);
            quantity = quantity.saturating_sub(taken);
        }
        self.prune_empty_inventory_rows();
        Ok(())
    }

    /// Commodity crafting consumes clodpowder + iron and uses profession-owned
    /// tools. This is the first profession-role split: craftsman makes ammo, medic makes
    /// medical supplies, and scout processes harvested creature bone into powder.
    pub(super) fn craft_field_supply(
        &mut self,
        actor: &ActorAuthorityState,
        profession: AuthorityProfessionKind,
        _required_tool_item_id: u32,
        clodpowder_qty: u32,
        iron_qty: u32,
        output_item_id: u32,
        output_name: &str,
        output_qty: u32,
        action_ms: u64,
        xp: u64,
    ) -> Result<u32, AuthorityRejectReason> {
        Self::require_actor_profession(actor, profession)?;
        self.require_actor_field_multitool(&actor.id)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        if self.actor_inventory_available_quantity(&actor.id, RESOURCE_CLODPOWDER_ITEM_ID)
            < clodpowder_qty
            || self.actor_inventory_available_quantity(&actor.id, RESOURCE_MINERAL_ITEM_ID)
                < iron_qty
        {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        self.consume_actor_inventory_quantity(
            &actor.id,
            RESOURCE_CLODPOWDER_ITEM_ID,
            clodpowder_qty,
        )?;
        self.consume_actor_inventory_quantity(&actor.id, RESOURCE_MINERAL_ITEM_ID, iron_qty)?;
        let added = self.add_actor_inventory_stack(
            &actor.id,
            output_item_id,
            0,
            output_name,
            output_qty,
            RESOURCE_STACK_CAP,
            "field-supplies",
        );
        self.set_actor_economy_action_cooldown(&actor.id, action_ms)?;
        let xp_tracks = field_supply_xp_track(profession, output_item_id);
        let total_xp = if xp_tracks.is_empty() {
            self.award_profession_xp(&actor.id, profession, xp)?
        } else {
            self.award_profession_tracks_xp(&actor.id, profession, xp_tracks, xp)?
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} crafted {} x{added} (+{xp} {} XP, total {total_xp})",
                actor.id,
                output_name,
                profession.label()
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(added)
    }

    pub(super) fn craft_medical_quality_supply(
        &mut self,
        actor: &ActorAuthorityState,
        kind: MedicalSchematicKind,
        experiment_potency: u8,
        experiment_quantity: u8,
        experiment_reserved: u8,
    ) -> Result<u32, AuthorityRejectReason> {
        Self::require_actor_profession(actor, AuthorityProfessionKind::Medic)?;
        self.require_actor_field_multitool(&actor.id)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        if experiment_reserved > 0 {
            return Err(AuthorityRejectReason::InvalidExperimentation);
        }
        let total_experiment = experiment_potency.saturating_add(experiment_quantity);
        if total_experiment > actor.professions.medical_experimentation_points() {
            return Err(AuthorityRejectReason::InvalidExperimentation);
        }
        let (clodpowder_qty, iron_qty, action_ms, xp) = match kind {
            MedicalSchematicKind::StimpakA => (
                CRAFT_SUPPLY_STIMPAK_CLODPOWDER_QTY,
                CRAFT_SUPPLY_STIMPAK_IRON_QTY,
                CRAFT_SUPPLY_STIMPAK_BATCH_MS,
                110,
            ),
            MedicalSchematicKind::BodyEnhancementPackA
            | MedicalSchematicKind::SpiritEnhancementPackA => (
                CRAFT_SUPPLY_ENHANCEMENT_PACK_CLODPOWDER_QTY,
                CRAFT_SUPPLY_ENHANCEMENT_PACK_IRON_QTY,
                CRAFT_SUPPLY_ENHANCEMENT_PACK_BATCH_MS,
                120,
            ),
            // W6-only kinds are not legacy field-supply craftable (MEDIC WAVE).
            MedicalSchematicKind::AdvancedStimpak
            | MedicalSchematicKind::AntiDizzyStim
            | MedicalSchematicKind::AntiBlindStim => {
                return Err(AuthorityRejectReason::UnknownSchematic)
            }
        };
        let (clodpowder_variant_id, clodpowder) = self
            .best_actor_resource_variant_with_quantity(
                &actor.id,
                RESOURCE_CLODPOWDER_ITEM_ID,
                clodpowder_qty,
            )
            .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
        let (mineral_variant_id, mineral) = self
            .best_actor_resource_variant_with_quantity(
                &actor.id,
                RESOURCE_MINERAL_ITEM_ID,
                iron_qty,
            )
            .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
        let caps = medical_craft_caps(kind, clodpowder, mineral);
        let tool_quality_milli = self.actor_field_multitool_quality_milli(&actor.id);
        let roll_seed = string_hash32(&format!(
            "{}:{}:{}:{}",
            actor.id,
            kind.label(),
            self.runtime.durable.tick,
            actor.professions.medical_crafting_bonus()
        ));
        let assembly_milli = (ai_rand(roll_seed, self.runtime.durable.tick, 43) * 1_000.0) as u16;
        let base = medical_assembly_quality(
            kind,
            caps,
            tool_quality_milli,
            actor.professions.medical_crafting_bonus(),
            assembly_milli,
        );
        let crafted = experiment_medical_stats(
            caps,
            base,
            roll_seed,
            experiment_potency,
            experiment_quantity,
            actor.professions.medical_experimentation_bonus(),
        );
        self.consume_actor_inventory_variant(
            &actor.id,
            RESOURCE_CLODPOWDER_ITEM_ID,
            clodpowder_variant_id,
            clodpowder_qty,
        )?;
        self.consume_actor_inventory_variant(
            &actor.id,
            RESOURCE_MINERAL_ITEM_ID,
            mineral_variant_id,
            iron_qty,
        )?;
        let variant_id = encode_medical_variant(kind, crafted);
        let output_qty = u32::from(crafted.quantity.max(1));
        let added = self.add_actor_inventory_stack(
            &actor.id,
            kind.item_id(),
            variant_id,
            &format!(
                "{} P{}/Q{}",
                kind.label(),
                crafted.potency,
                crafted.quantity
            ),
            output_qty,
            RESOURCE_STACK_CAP,
            "field-supplies",
        );
        self.set_actor_economy_action_cooldown(&actor.id, action_ms)?;
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::Medic,
            "medical-crafting",
            xp,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} crafted {} x{added} potency {} (+{xp} Medic XP, total {total_xp})",
                actor.id,
                kind.label(),
                crafted.potency
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(added)
    }

    pub(super) fn craft_profession_tool(
        &mut self,
        actor: &ActorAuthorityState,
        output_item_id: u32,
        output_name: &str,
    ) -> Result<u32, AuthorityRejectReason> {
        Self::require_actor_profession(actor, AuthorityProfessionKind::Craftsman)?;
        self.require_actor_field_multitool(&actor.id)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        if self.actor_inventory_available_quantity(&actor.id, RESOURCE_MINERAL_ITEM_ID)
            < CRAFT_PROFESSION_TOOL_IRON_QTY
        {
            return Err(AuthorityRejectReason::IngredientUnavailable);
        }
        self.consume_actor_inventory_quantity(
            &actor.id,
            RESOURCE_MINERAL_ITEM_ID,
            CRAFT_PROFESSION_TOOL_IRON_QTY,
        )?;
        let added = self.add_actor_inventory_stack(
            &actor.id,
            output_item_id,
            0,
            output_name,
            1,
            1,
            "profession-tools",
        );
        self.set_actor_economy_action_cooldown(&actor.id, CRAFT_PROFESSION_TOOL_BATCH_MS)?;
        let total_xp = self.award_profession_track_xp(
            &actor.id,
            AuthorityProfessionKind::Craftsman,
            "tools",
            90,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} crafted {} from iron (+90 Craftsman XP, total {total_xp})",
                actor.id, output_name
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(added)
    }

    pub(super) fn process_creature_bone_to_powder(
        &mut self,
        actor: &ActorAuthorityState,
    ) -> Result<u32, AuthorityRejectReason> {
        Self::require_actor_profession(actor, AuthorityProfessionKind::Scout)?;
        self.require_actor_inventory_item(&actor.id, SCOUT_PROCESSING_TOOL_ITEM_ID)?;
        self.ensure_actor_economy_action_ready(&actor.id)?;
        let (bone_variant_id, _) = self
            .best_actor_resource_variant_with_quantity(
                &actor.id,
                RESOURCE_CREATURE_BONE_ITEM_ID,
                CRAFT_CLODPOWDER_BONE_QTY,
            )
            .ok_or(AuthorityRejectReason::IngredientUnavailable)?;
        self.consume_actor_inventory_variant(
            &actor.id,
            RESOURCE_CREATURE_BONE_ITEM_ID,
            bone_variant_id,
            CRAFT_CLODPOWDER_BONE_QTY,
        )?;
        let powder = clodpowder_resource_instance_from_bone_variant(bone_variant_id);
        let output_qty = scale_by_profession_milli(
            CRAFT_CLODPOWDER_OUTPUT_QTY,
            actor_profession_bonus_milli(actor, "scout"),
        );
        let added = self.add_actor_inventory_stack(
            &actor.id,
            powder.item_id,
            powder.variant_id,
            &powder.label,
            output_qty,
            RESOURCE_STACK_CAP,
            "resource-crate",
        );
        self.set_actor_economy_action_cooldown(&actor.id, CRAFT_CLODPOWDER_BATCH_MS)?;
        let total_xp = self.award_profession_tracks_xp(
            &actor.id,
            AuthorityProfessionKind::Scout,
            &["creature-harvesting", "sprinting", "traversal", "campcraft"],
            75,
        )?;
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} processed Creature Bone into {} x{added} (+75 Scout XP, total {total_xp})",
                actor.id, powder.short_label
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(added)
    }

    /// Map a field-supply schematic key to a profession recipe. Unknown keys reject.
    pub(super) fn craft_field_supply_by_schematic(
        &mut self,
        actor: &ActorAuthorityState,
        schematic: &str,
    ) -> Result<u32, AuthorityRejectReason> {
        match normalize_command_key(schematic).as_str() {
            // Iron Slugs pair forged slug bodies with pressed Clodpowder charge wafers;
            // the Slugthrower's capacitor and throw-coil launch them electromagnetically.
            "ammo_slug_iron" | "slug_iron" => self.craft_field_supply(
                actor,
                AuthorityProfessionKind::Craftsman,
                FIELD_MULTITOOL_ITEM_ID,
                CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY,
                CRAFT_SUPPLY_AMMO_IRON_QTY,
                AMMO_SLUG_IRON_ITEM_ID,
                "Iron Slug",
                CRAFT_SUPPLY_AMMO_OUTPUT_QTY,
                CRAFT_SUPPLY_AMMO_BATCH_MS,
                120,
            ),
            "field_bandage" | "bandage" => self.craft_field_supply(
                actor,
                AuthorityProfessionKind::Medic,
                FIELD_MULTITOOL_ITEM_ID,
                CRAFT_SUPPLY_BANDAGE_CLODPOWDER_QTY,
                CRAFT_SUPPLY_BANDAGE_IRON_QTY,
                FIELD_BANDAGE_ITEM_ID,
                "Field Bandage",
                CRAFT_SUPPLY_BANDAGE_OUTPUT_QTY,
                CRAFT_SUPPLY_BANDAGE_BATCH_MS,
                60,
            ),
            "stimpak" | "stimpak_a" => {
                let kind = MedicalSchematicKind::StimpakA;
                let (experiment_potency, experiment_quantity, experiment_reserved) =
                    auto_medical_experiment_allocation(actor, kind);
                self.craft_medical_quality_supply(
                    actor,
                    kind,
                    experiment_potency,
                    experiment_quantity,
                    experiment_reserved,
                )
            }
            "body_enhancement_pack"
            | "body_enhancement_pack_a"
            | "body_pack"
            | "body_buff_pack"
            | "medic_prep_pack" => {
                let kind = MedicalSchematicKind::BodyEnhancementPackA;
                let (experiment_potency, experiment_quantity, experiment_reserved) =
                    auto_medical_experiment_allocation(actor, kind);
                self.craft_medical_quality_supply(
                    actor,
                    kind,
                    experiment_potency,
                    experiment_quantity,
                    experiment_reserved,
                )
            }
            "spirit_enhancement_pack"
            | "spirit_enhancement_pack_a"
            | "spirit_pack"
            | "spirit_buff_pack"
            | "entertainer_session_pack" => {
                let kind = MedicalSchematicKind::SpiritEnhancementPackA;
                let (experiment_potency, experiment_quantity, experiment_reserved) =
                    auto_medical_experiment_allocation(actor, kind);
                self.craft_medical_quality_supply(
                    actor,
                    kind,
                    experiment_potency,
                    experiment_quantity,
                    experiment_reserved,
                )
            }
            "resuscitation_kit" | "res_kit" | "reskit" | "revive_kit" => self.craft_field_supply(
                actor,
                AuthorityProfessionKind::Medic,
                FIELD_MULTITOOL_ITEM_ID,
                CRAFT_SUPPLY_RESUSCITATION_KIT_CLODPOWDER_QTY,
                CRAFT_SUPPLY_RESUSCITATION_KIT_IRON_QTY,
                RESUSCITATION_KIT_ITEM_ID,
                "Resuscitation Kit",
                CRAFT_SUPPLY_RESUSCITATION_KIT_OUTPUT_QTY,
                CRAFT_SUPPLY_RESUSCITATION_KIT_BATCH_MS,
                120,
            ),
            "personal_shield_generator" | "personal_shield" | "shield_generator" | "psg" => self
                .craft_field_supply(
                    actor,
                    AuthorityProfessionKind::Craftsman,
                    FIELD_MULTITOOL_ITEM_ID,
                    CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_CLODPOWDER_QTY,
                    CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_IRON_QTY,
                    PERSONAL_SHIELD_GENERATOR_ITEM_ID,
                    "Personal Shield Generator",
                    CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_OUTPUT_QTY,
                    CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_BATCH_MS,
                    130,
                ),
            "clodpowder" | "process_creature_bone" | "creature_bone_to_clodpowder" => {
                self.process_creature_bone_to_powder(actor)
            }
            "camp_kit" | "scout_camp_kit" | "scout_camp" | "camp" => self.craft_camp_kit(actor),
            "munitions_tool" | "ammo_tool" | "medical_tool" | "medic_tool" | "field_multitool" => {
                Err(AuthorityRejectReason::UnknownSchematic)
            }
            "scout_tool" | "processing_tool" => self.craft_profession_tool(
                actor,
                SCOUT_PROCESSING_TOOL_ITEM_ID,
                "Scout Processing Kit",
            ),
            _ => Err(AuthorityRejectReason::UnknownSchematic),
        }
    }

    pub(super) fn exchange_slot_count(&self) -> usize {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| row.container == EXCHANGE_CONTAINER)
            .count()
    }

    pub(super) fn nearest_exchange_container_for_actor(
        &self,
        actor: &ActorAuthorityState,
    ) -> Option<&ExchangeContainerAuthorityState> {
        self.runtime
            .durable
            .world
            .exchange_containers
            .iter()
            .filter(|container| {
                container.area_id == actor.area_id
                    && actor_can_access_exchange_container(actor, container)
            })
            .min_by_key(|container| {
                (
                    position_distance_milli(actor.position, container.position),
                    container.prop_id.clone(),
                )
            })
    }

    pub(super) fn actor_within_exchange_interaction_range(
        &self,
        actor: &ActorAuthorityState,
    ) -> bool {
        self.nearest_exchange_container_for_actor(actor)
            .is_some_and(|container| {
                exchange_container_footprint_distance_milli(actor.position, container)
                    <= EXCHANGE_INTERACTION_RADIUS_MILLI_CELLS
            })
    }

    pub(super) fn exchange_inventory_capacity_variant(&self, item_id: u32, variant_id: u32) -> u32 {
        let cap = Self::inventory_stack_cap_for_item(item_id, RESOURCE_STACK_CAP);
        let existing_free = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.container == EXCHANGE_CONTAINER
                    && row.item_id == item_id
                    && row.variant_id == variant_id
            })
            .fold(0_u32, |total, row| {
                total.saturating_add(cap.saturating_sub(row.quantity))
            });
        let free_slots = EXCHANGE_CONTAINER_SLOTS.saturating_sub(self.exchange_slot_count());
        let slot_capacity = (free_slots as u64)
            .saturating_mul(u64::from(cap))
            .min(u64::from(u32::MAX)) as u32;
        existing_free.saturating_add(slot_capacity)
    }

    pub(super) fn add_exchange_inventory_stack(
        &mut self,
        item_id: u32,
        variant_id: u32,
        item_name: &str,
        quantity: u32,
    ) -> u32 {
        let cap = Self::inventory_stack_cap_for_item(item_id, RESOURCE_STACK_CAP);
        let mut remaining = quantity;
        let mut added = 0_u32;
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.container == EXCHANGE_CONTAINER
                && row.item_id == item_id
                && row.variant_id == variant_id
        }) {
            if remaining == 0 {
                break;
            }
            row.item = item_name.to_owned();
            let free = cap.saturating_sub(row.quantity);
            if free == 0 {
                continue;
            }
            let delta = free.min(remaining);
            row.quantity = row.quantity.saturating_add(delta);
            row.reserved = row.reserved.min(row.quantity);
            row.available = row.quantity.saturating_sub(row.reserved);
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        while remaining > 0 && self.exchange_slot_count() < EXCHANGE_CONTAINER_SLOTS {
            let delta = cap.min(remaining);
            let stack_id = self.next_inventory_stack_id(EXCHANGE_CONTAINER);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container: EXCHANGE_CONTAINER.to_owned(),
                item: item_name.to_owned(),
                item_id,
                variant_id,
                quantity: delta,
                reserved: 0,
                available: delta,
            });
            remaining = remaining.saturating_sub(delta);
            added = added.saturating_add(delta);
        }
        added
    }

    /// Store items from the player's inventory into the shared 50-slot district
    /// exchange. Atomic + slot-capped: a new distinct (item, variant) stack must fit
    /// the 50 slots, and the items only leave the player once the exchange add commits.
    pub(super) fn apply_store_to_exchange(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let actor = self
            .runtime
            .durable
            .actors
            .get(&actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if !self.actor_within_exchange_interaction_range(actor) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        let actor_cell = actor.cell;
        if quantity == 0
            || self.actor_inventory_available_variant(&actor_id, item_id, variant_id) < quantity
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if self.exchange_inventory_capacity_variant(item_id, variant_id) < quantity {
            return Err(AuthorityRejectReason::ContainerFull);
        }
        let name = self
            .runtime
            .durable
            .inventory
            .iter()
            .find(|row| {
                row.item_id == item_id
                    && row.variant_id == variant_id
                    && actor_owns_inventory_container(&actor_id, &row.container)
            })
            .map(|row| row.item.clone())
            .unwrap_or_default();
        self.consume_actor_inventory_variant(&actor_id, item_id, variant_id, quantity)?;
        let added = self.add_exchange_inventory_stack(item_id, variant_id, &name, quantity);
        debug_assert_eq!(added, quantity);
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{actor_id} stored {name} x{quantity} in {EXCHANGE_CONTAINER}"),
            cell: Some(CellSnapshot::new(actor_cell.x, actor_cell.y)),
        });
        Ok(())
    }

    /// Retrieve items from the shared exchange into the player's inventory. Emptied
    /// exchange stacks are dropped so their slot frees up.
    pub(super) fn apply_retrieve_from_exchange(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let actor = self
            .runtime
            .durable
            .actors
            .get(&actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if !self.actor_within_exchange_interaction_range(actor) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        let actor_cell = actor.cell;
        let available: u32 = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.container == EXCHANGE_CONTAINER
                    && row.item_id == item_id
                    && row.variant_id == variant_id
            })
            .map(|row| row.available)
            .sum();
        if quantity == 0 || available < quantity {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let name = self
            .runtime
            .durable
            .inventory
            .iter()
            .find(|row| {
                row.container == EXCHANGE_CONTAINER
                    && row.item_id == item_id
                    && row.variant_id == variant_id
            })
            .map(|row| row.item.clone())
            .unwrap_or_default();
        let mut remaining = quantity;
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.container == EXCHANGE_CONTAINER
                && row.item_id == item_id
                && row.variant_id == variant_id
        }) {
            if remaining == 0 {
                break;
            }
            let taken = row.available.min(remaining);
            row.quantity = row.quantity.saturating_sub(taken);
            row.available = row.available.saturating_sub(taken);
            row.reserved = row.reserved.min(row.quantity);
            remaining = remaining.saturating_sub(taken);
        }
        self.runtime
            .durable
            .inventory
            .retain(|row| !(row.container == EXCHANGE_CONTAINER && row.quantity == 0));
        self.add_actor_inventory_stack(
            &actor_id,
            item_id,
            variant_id,
            &name,
            quantity,
            RESOURCE_STACK_CAP,
            "field-pack",
        );
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{actor_id} retrieved {name} x{quantity} from {EXCHANGE_CONTAINER}"),
            cell: Some(CellSnapshot::new(actor_cell.x, actor_cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_discard_stack(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        stack_id: &str,
        item_id: u32,
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
        let stack_id =
            parse_inventory_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if !actor_owns_inventory_container(&actor.id, container) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let row_index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| {
                row.container == container
                    && row.stack_id == stack_id
                    && row.item_id == item_id
                    && row.variant_id == variant_id
            })
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let row = &self.runtime.durable.inventory[row_index];
        if banking::is_fixed_player_clothing_item_id(row.item_id) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if row.quantity == 0
            || row.available != row.quantity
            || row.reserved != 0
            || (actor.equipped_weapon_item_id != 0 && actor.equipped_weapon_item_id == row.item_id)
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let item_name = row.item.clone();
        self.runtime.durable.inventory.remove(row_index);
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} discarded {} variant {} stack {}",
                actor.id, item_name, variant_id, stack_id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_split_stack(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        stack_id: &str,
        item_id: u32,
        variant_id: u32,
        quantity: u32,
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
        let stack_id =
            parse_inventory_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if quantity == 0 || !self.player_can_mutate_inventory_container(&actor, container) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if container == EXCHANGE_CONTAINER && self.exchange_slot_count() >= EXCHANGE_CONTAINER_SLOTS
        {
            return Err(AuthorityRejectReason::ContainerFull);
        }
        let source_index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| row.container == container && row.stack_id == stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let (item_name, source_available) = {
            let source = &self.runtime.durable.inventory[source_index];
            if source.item_id != item_id || source.variant_id != variant_id {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
            (source.item.clone(), source.available)
        };
        if quantity >= source_available {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let split_stack_id = self.next_inventory_stack_id(container);
        {
            let source = &mut self.runtime.durable.inventory[source_index];
            source.quantity = source.quantity.saturating_sub(quantity);
            source.reserved = source.reserved.min(source.quantity);
            source.available = source.quantity.saturating_sub(source.reserved);
        }
        self.runtime.durable.inventory.insert(
            source_index + 1,
            InventoryStackSnapshot {
                stack_id: split_stack_id,
                container: container.to_owned(),
                item: item_name.clone(),
                item_id,
                variant_id,
                quantity,
                reserved: 0,
                available: quantity,
            },
        );
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} split {} x{} from stack {}",
                actor.id, item_name, quantity, stack_id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_merge_stacks(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        source_stack_id: &str,
        target_stack_id: &str,
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
        let source_stack_id = parse_inventory_stack_id(source_stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let target_stack_id = parse_inventory_stack_id(target_stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if source_stack_id == target_stack_id
            || !self.player_can_mutate_inventory_container(&actor, container)
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let source_index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| row.container == container && row.stack_id == source_stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let target_index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| row.container == container && row.stack_id == target_stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let (item_id, variant_id, item_name, source_available) = {
            let source = &self.runtime.durable.inventory[source_index];
            let target = &self.runtime.durable.inventory[target_index];
            if source.item_id != target.item_id || source.variant_id != target.variant_id {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
            (
                source.item_id,
                source.variant_id,
                source.item.clone(),
                source.available,
            )
        };
        let cap = Self::inventory_stack_cap_for_item(item_id, u32::MAX);
        let free = cap.saturating_sub(self.runtime.durable.inventory[target_index].quantity);
        let moved = source_available.min(free);
        if moved == 0 {
            return Ok(());
        }
        {
            let target = &mut self.runtime.durable.inventory[target_index];
            target.quantity = target.quantity.saturating_add(moved);
            target.reserved = target.reserved.min(target.quantity);
            target.available = target.quantity.saturating_sub(target.reserved);
        }
        {
            let source = &mut self.runtime.durable.inventory[source_index];
            source.quantity = source.quantity.saturating_sub(moved);
            source.reserved = source.reserved.min(source.quantity);
            source.available = source.quantity.saturating_sub(source.reserved);
        }
        if self.runtime.durable.inventory[source_index].quantity == 0 {
            self.runtime.durable.inventory.remove(source_index);
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} merged {} variant {} x{} from stack {} into {}",
                actor.id, item_name, variant_id, moved, source_stack_id, target_stack_id
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    /// Redeem one Credit Chip stack into the scalar credit balance. The chip is a
    /// PHYSICAL item already sitting in the player's own inventory (looted, traded,
    /// or crafted): its `quantity` IS its face value. Redemption banks that value
    /// and consumes the whole stack (owner ruling: "chip consumed"). A chip that is
    /// reserved (mid-trade escrow) is off-limits so redemption can never corrupt a
    /// pending swap. Read-only loot containers are refused by the mutate gate — you
    /// take the chip first, then redeem it from your pack.
    pub(super) fn apply_redeem_credit_chip(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        stack_id: &str,
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
        let stack_id =
            parse_inventory_stack_id(stack_id).ok_or(AuthorityRejectReason::ItemUnavailable)?;
        if !self.player_can_mutate_inventory_container(&actor, container) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let row_index = self
            .runtime
            .durable
            .inventory
            .iter()
            .position(|row| row.container == container && row.stack_id == stack_id)
            .ok_or(AuthorityRejectReason::ItemUnavailable)?;
        let value = {
            let row = &self.runtime.durable.inventory[row_index];
            // Only a Credit Chip redeems, and only a fully-unreserved one.
            if row.item_id != CREDIT_CHIP_ITEM_ID || row.reserved > 0 || row.quantity == 0 {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
            row.quantity
        };
        self.runtime.durable.inventory.remove(row_index);
        let (actor_id, cell, balance) = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(&config.player_actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            let balance = actor.professions.add_credits(u64::from(value));
            (actor.id.clone(), actor.cell, balance)
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{actor_id} redeemed a Credit Chip for {value} credits (balance {balance})"
            ),
            cell: Some(CellSnapshot::new(cell.x, cell.y)),
        });
        Ok(())
    }

    /// Can `actor_id` currently fund every line of `items` (summed per item)?
    pub(super) fn actor_can_fund(&self, actor_id: &str, items: &[TradeItemSpec]) -> bool {
        // Key by the (item_id, variant_id) PAIR: a trade line is only fundable if the
        // actor holds that exact variant, so the swap can never credit a forged variant.
        let mut required: BTreeMap<(u32, u32), u32> = BTreeMap::new();
        for item in items {
            if banking::is_fixed_player_clothing_item_id(item.item_id) {
                return false;
            }
            let entry = required.entry((item.item_id, item.variant_id)).or_insert(0);
            *entry = entry.saturating_add(item.quantity);
        }
        required.iter().all(|((item_id, variant_id), qty)| {
            self.actor_inventory_available_variant(actor_id, *item_id, *variant_id) >= *qty
        })
    }

    pub(super) fn actor_inventory_item_name(&self, actor_id: &str, item_id: u32) -> String {
        self.runtime
            .durable
            .inventory
            .iter()
            .find(|row| {
                row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
            })
            .map(|row| row.item.clone())
            .unwrap_or_default()
    }

    pub(super) fn actors_within_trade_interaction_range(
        proposer: &ActorAuthorityState,
        partner: &ActorAuthorityState,
    ) -> bool {
        proposer.area_id == partner.area_id
            && position_distance_milli(proposer.position, partner.position)
                <= TRADE_INTERACTION_RADIUS_MILLI_CELLS
    }

    /// Open a secure pawn<->pawn trade SESSION: seeds the proposer's side with
    /// `offer` and the partner's side with `request` (both freely mutable after via
    /// Add/Remove/SetCoin). Validates the proposer can fund the seeded offer now;
    /// every side is re-validated at CONFIRM. No items are reserved — a stale or
    /// aborted session moves nothing. Each actor may be in only one trade at a time.
    pub(super) fn apply_propose_trade(
        &mut self,
        config: &SliceAuthorityConfig,
        partner_actor_id: &str,
        offer: &[TradeItemSpec],
        request: &[TradeItemSpec],
    ) -> Result<(), AuthorityRejectReason> {
        let proposer = config.player_actor_id.clone();
        if proposer == partner_actor_id {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        let proposer_actor = self
            .runtime
            .durable
            .actors
            .get(&proposer)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if proposer_actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let partner = self
            .runtime
            .durable
            .actors
            .get(partner_actor_id)
            .ok_or(AuthorityRejectReason::TargetUnavailable)?;
        if partner.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if !Self::actors_within_trade_interaction_range(proposer_actor, partner) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if self.actor_in_open_trade(&proposer) || self.actor_in_open_trade(partner_actor_id) {
            return Err(AuthorityRejectReason::TradeSessionActive);
        }
        if offer
            .iter()
            .chain(request)
            .any(|item| banking::is_fixed_player_clothing_item_id(item.item_id))
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if !self.actor_can_fund(&proposer, offer) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let id = self.runtime.durable.next_trade_proposal_id;
        self.runtime.durable.next_trade_proposal_id = self
            .runtime
            .durable
            .next_trade_proposal_id
            .saturating_add(1);
        self.runtime.durable.trade_proposals.insert(
            id,
            TradeProposal {
                proposer,
                partner: partner_actor_id.to_owned(),
                offer: offer.to_vec(),
                request: request.to_vec(),
                proposer_coin: 0,
                partner_coin: 0,
                proposer_locked: false,
                partner_locked: false,
                proposer_confirmed: false,
                partner_confirmed: false,
                closed: None,
            },
        );
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("trade #{id} proposed to {partner_actor_id}"),
            cell: None,
        });
        self.publish_trade_session(id);
        Ok(())
    }

    /// ACCEPT = latch MY side's lock (literal, visible to both). Requires my side
    /// to be fundable NOW and both parties alive + in range; does NOT touch the
    /// counterparty's lock. A second accept while already locked is an idempotent
    /// re-affirm. Both sides locked opens the CONFIRM gate.
    pub(super) fn apply_accept_trade(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let side = self.require_open_trade_side(&actor_id, proposal_id)?;
        let (proposal, items, coin, already_locked) = {
            let proposal = self
                .runtime
                .durable
                .trade_proposals
                .get(&proposal_id)
                .ok_or(AuthorityRejectReason::NoTradeSession)?;
            (
                proposal.clone(),
                proposal.side_items(side).to_vec(),
                proposal.side_coin(side),
                proposal.side_locked(side),
            )
        };
        if !self.trade_partners_alive_in_range(&proposal) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if already_locked {
            // Idempotent re-affirm; republish so both windows re-sync.
            self.publish_trade_session(proposal_id);
            return Ok(());
        }
        if !self.actor_can_fund(&actor_id, &items) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if self.actor_credit_balance(&actor_id) < coin {
            return Err(AuthorityRejectReason::InsufficientCredits);
        }
        if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
            proposal.set_side_locked(side, true);
        }
        self.publish_trade_session(proposal_id);
        Ok(())
    }

    /// Add one item line to the sender's own side. Merges by (item_id, variant_id).
    /// The actor must own the WHOLE resulting side (summed) plus their pledged coin.
    /// Any offer change clears BOTH accept-locks (anti-abuse).
    pub(super) fn apply_add_trade_item(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
        item: &TradeItemSpec,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let side = self.require_open_trade_side(&actor_id, proposal_id)?;
        if item.quantity == 0 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let (mut items, coin) = {
            let proposal = self
                .runtime
                .durable
                .trade_proposals
                .get(&proposal_id)
                .ok_or(AuthorityRejectReason::NoTradeSession)?;
            (proposal.side_items(side).to_vec(), proposal.side_coin(side))
        };
        Self::merge_trade_line(&mut items, item);
        if !self.actor_can_fund(&actor_id, &items) || self.actor_credit_balance(&actor_id) < coin {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
            *proposal.side_items_mut(side) = items;
            proposal.clear_locks();
        }
        self.publish_trade_session(proposal_id);
        Ok(())
    }

    /// Remove a quantity of one item line from the sender's own side. Rejects if the
    /// exact line is not present with at least `quantity`. Clears BOTH accept-locks.
    pub(super) fn apply_remove_trade_item(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
        item: &TradeItemSpec,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let side = self.require_open_trade_side(&actor_id, proposal_id)?;
        if item.quantity == 0 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        {
            let proposal = self
                .runtime
                .durable
                .trade_proposals
                .get_mut(&proposal_id)
                .ok_or(AuthorityRejectReason::NoTradeSession)?;
            if !Self::remove_trade_line(proposal.side_items_mut(side), item) {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
            proposal.clear_locks();
        }
        self.publish_trade_session(proposal_id);
        Ok(())
    }

    /// Set the sender's scalar credit offer. The actor must currently have at
    /// least `amount` wallet credits. Clears BOTH accept-locks.
    pub(super) fn apply_set_trade_coin(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
        amount: u64,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let side = self.require_open_trade_side(&actor_id, proposal_id)?;
        if amount > self.actor_credit_balance(&actor_id) {
            return Err(AuthorityRejectReason::InsufficientCredits);
        }
        if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
            proposal.set_side_coin(side, amount);
            proposal.clear_locks();
        }
        self.publish_trade_session(proposal_id);
        Ok(())
    }

    /// Final OK. Valid only once BOTH sides are locked (else `trade_not_locked`). The
    /// first confirm latches; the deciding (second) confirm re-validates the ENTIRE
    /// trade against live inventory and, if still valid, executes the atomic
    /// all-or-nothing swap. A failed re-validation aborts the session cleanly with
    /// nothing moved — the anti-abuse net.
    pub(super) fn apply_confirm_trade(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor_id = config.player_actor_id.clone();
        let side = self.require_open_trade_side(&actor_id, proposal_id)?;
        let other = match side {
            TradeSide::Proposer => TradeSide::Partner,
            TradeSide::Partner => TradeSide::Proposer,
        };
        let (proposal, already_confirmed, other_confirmed, both_locked) = {
            let proposal = self
                .runtime
                .durable
                .trade_proposals
                .get(&proposal_id)
                .ok_or(AuthorityRejectReason::NoTradeSession)?;
            (
                proposal.clone(),
                proposal.side_confirmed(side),
                proposal.side_confirmed(other),
                proposal.both_locked(),
            )
        };
        if !both_locked {
            return Err(AuthorityRejectReason::TradeNotLocked);
        }
        if !self.trade_partners_alive_in_range(&proposal) {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if already_confirmed {
            self.publish_trade_session(proposal_id);
            return Ok(());
        }
        if !other_confirmed {
            // First confirm: latch and wait for the counterparty's OK. Nothing moves.
            if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
                proposal.set_side_confirmed(side, true);
            }
            self.publish_trade_session(proposal_id);
            return Ok(());
        }
        // Deciding confirm: re-validate the whole trade before moving anything.
        if !self.trade_side_fully_funded(&proposal, TradeSide::Proposer)
            || !self.trade_side_fully_funded(&proposal, TradeSide::Partner)
            || self.planned_trade_credit_balances(&proposal).is_none()
        {
            // Someone lost their items/coin between locking and confirming. Abort the
            // whole session cleanly; the terminal VM tells both windows why.
            self.close_trade_session(proposal_id, false, Some(TradeCloseReason::Declined));
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        self.execute_trade_swap(&proposal)?;
        if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
            proposal.set_side_confirmed(side, true);
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "trade #{proposal_id} completed: {} <-> {}",
                proposal.proposer, proposal.partner
            ),
            cell: None,
        });
        self.close_trade_session(proposal_id, true, None);
        Ok(())
    }

    /// Decline / cancel a trade. Either party may close it, at any phase; nothing is
    /// moved. The session is held one tick in a terminal `declined` state so both
    /// windows can render the outcome, then reaped.
    pub(super) fn apply_decline_trade(
        &mut self,
        config: &SliceAuthorityConfig,
        proposal_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = config.player_actor_id.clone();
        let (is_participant, is_open) = {
            let proposal = self
                .runtime
                .durable
                .trade_proposals
                .get(&proposal_id)
                .ok_or(AuthorityRejectReason::NoTradeSession)?;
            (proposal.side_of(&actor).is_some(), proposal.is_open())
        };
        if !is_participant {
            return Err(AuthorityRejectReason::WrongPlayer);
        }
        if !is_open {
            return Err(AuthorityRejectReason::NoTradeSession);
        }
        self.close_trade_session(proposal_id, false, Some(TradeCloseReason::Declined));
        Ok(())
    }

    /// Is `actor_id` a participant in any OPEN (not-yet-closed) trade session?
    fn actor_in_open_trade(&self, actor_id: &str) -> bool {
        self.runtime
            .durable
            .trade_proposals
            .values()
            .any(|proposal| proposal.is_open() && proposal.side_of(actor_id).is_some())
    }

    /// Resolve the acting actor's OPEN session + side, enforcing alive + participant +
    /// open. Every mutation/lock/confirm command routes through this.
    fn require_open_trade_side(
        &self,
        actor_id: &str,
        proposal_id: u32,
    ) -> Result<TradeSide, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let proposal = self
            .runtime
            .durable
            .trade_proposals
            .get(&proposal_id)
            .ok_or(AuthorityRejectReason::NoTradeSession)?;
        if !proposal.is_open() {
            return Err(AuthorityRejectReason::NoTradeSession);
        }
        proposal
            .side_of(actor_id)
            .ok_or(AuthorityRejectReason::WrongPlayer)
    }

    fn actor_credit_balance(&self, actor_id: &str) -> u64 {
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| actor.professions.credits)
            .unwrap_or_default()
    }

    fn trade_side_fully_funded(&self, proposal: &TradeProposal, side: TradeSide) -> bool {
        let actor = proposal.actor_of(side);
        self.actor_can_fund(actor, proposal.side_items(side))
            && self.actor_credit_balance(actor) >= proposal.side_coin(side)
    }

    fn trade_partners_alive_in_range(&self, proposal: &TradeProposal) -> bool {
        let (Some(proposer), Some(partner)) = (
            self.runtime.durable.actors.get(&proposal.proposer),
            self.runtime.durable.actors.get(&proposal.partner),
        ) else {
            return false;
        };
        proposer.life_state == AuthorityLifeState::Alive
            && partner.life_state == AuthorityLifeState::Alive
            && Self::actors_within_trade_interaction_range(proposer, partner)
    }

    fn planned_trade_credit_balances(&self, proposal: &TradeProposal) -> Option<(u64, u64)> {
        let proposer = self
            .runtime
            .durable
            .actors
            .get(&proposal.proposer)?
            .professions
            .credits;
        let partner = self
            .runtime
            .durable
            .actors
            .get(&proposal.partner)?
            .professions
            .credits;
        Some((
            proposer
                .checked_sub(proposal.proposer_coin)?
                .checked_add(proposal.partner_coin)?,
            partner
                .checked_sub(proposal.partner_coin)?
                .checked_add(proposal.proposer_coin)?,
        ))
    }

    /// Execute the atomic all-or-nothing swap for a fully-validated session:
    /// item lines and scalar wallet credits move together. Funding and both
    /// post-trade credit balances are precomputed before any inventory mutates.
    fn execute_trade_swap(
        &mut self,
        proposal: &TradeProposal,
    ) -> Result<(), AuthorityRejectReason> {
        if !self.trade_side_fully_funded(proposal, TradeSide::Proposer)
            || !self.trade_side_fully_funded(proposal, TradeSide::Partner)
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let (proposer_credits, partner_credits) = self
            .planned_trade_credit_balances(proposal)
            .ok_or(AuthorityRejectReason::InsufficientCredits)?;
        let offer_named: Vec<(TradeItemSpec, String)> = proposal
            .offer
            .iter()
            .map(|item| {
                (
                    item.clone(),
                    self.actor_inventory_item_name(&proposal.proposer, item.item_id),
                )
            })
            .collect();
        let request_named: Vec<(TradeItemSpec, String)> = proposal
            .request
            .iter()
            .map(|item| {
                (
                    item.clone(),
                    self.actor_inventory_item_name(&proposal.partner, item.item_id),
                )
            })
            .collect();
        for (item, name) in &offer_named {
            self.consume_actor_inventory_variant(
                &proposal.proposer,
                item.item_id,
                item.variant_id,
                item.quantity,
            )
            .map_err(|_| AuthorityRejectReason::ItemUnavailable)?;
            self.add_actor_inventory_stack(
                &proposal.partner,
                item.item_id,
                item.variant_id,
                name,
                item.quantity,
                RESOURCE_STACK_CAP,
                "field-pack",
            );
        }
        for (item, name) in &request_named {
            self.consume_actor_inventory_variant(
                &proposal.partner,
                item.item_id,
                item.variant_id,
                item.quantity,
            )
            .map_err(|_| AuthorityRejectReason::ItemUnavailable)?;
            self.add_actor_inventory_stack(
                &proposal.proposer,
                item.item_id,
                item.variant_id,
                name,
                item.quantity,
                RESOURCE_STACK_CAP,
                "field-pack",
            );
        }
        self.runtime
            .durable
            .actors
            .get_mut(&proposal.proposer)
            .expect("trade proposer was prevalidated")
            .professions
            .credits = proposer_credits;
        self.runtime
            .durable
            .actors
            .get_mut(&proposal.partner)
            .expect("trade partner was prevalidated")
            .professions
            .credits = partner_credits;
        self.reconcile_actor_worn_clothing(&proposal.proposer);
        self.reconcile_actor_worn_clothing(&proposal.partner);
        Ok(())
    }

    /// Mark a session terminal (held one tick, then reaped by the tick lifecycle) and
    /// republish so both windows render the outcome. `executed` = swap landed.
    pub(super) fn close_trade_session(
        &mut self,
        proposal_id: u32,
        executed: bool,
        reason: Option<TradeCloseReason>,
    ) {
        if let Some(proposal) = self.runtime.durable.trade_proposals.get_mut(&proposal_id) {
            if proposal.is_open() {
                proposal.closed = Some(TradeClose {
                    executed,
                    reason,
                    at_tick: self.runtime.durable.tick,
                });
            }
        }
        self.publish_trade_session(proposal_id);
    }

    /// Queue the session VM for BOTH participants so the server can push `tradeSession`
    /// to each side in the command path. Participants-only by construction.
    fn publish_trade_session(&mut self, proposal_id: u32) {
        let Some(proposal) = self
            .runtime
            .durable
            .trade_proposals
            .get(&proposal_id)
            .cloned()
        else {
            return;
        };
        let deliveries: Vec<AuthorityTradeSessionDelivery> =
            [TradeSide::Proposer, TradeSide::Partner]
                .into_iter()
                .map(|side| {
                    let actor_id = proposal.actor_of(side).to_owned();
                    let session = self.trade_session_vm(proposal_id, &proposal, &actor_id);
                    AuthorityTradeSessionDelivery { actor_id, session }
                })
                .collect();
        self.runtime
            .pending_trade_session_deliveries
            .extend(deliveries);
    }

    /// The observer's own trade session VM, if they are a participant in one (open or
    /// terminal). Visibility law: returns `None` for non-participants.
    pub(crate) fn trade_session_snapshot_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<AuthorityTradeSessionSnapshot> {
        self.trade_session_vm_for_actor(&config.player_actor_id)
    }

    fn trade_session_vm_for_actor(&self, actor_id: &str) -> Option<AuthorityTradeSessionSnapshot> {
        // Prefer the OPEN session; a just-closed terminal session may briefly coexist
        // with a freshly opened one until the tick lifecycle reaps it.
        let (id, proposal) = self
            .runtime
            .durable
            .trade_proposals
            .iter()
            .find(|(_, proposal)| proposal.is_open() && proposal.side_of(actor_id).is_some())
            .or_else(|| {
                self.runtime
                    .durable
                    .trade_proposals
                    .iter()
                    .find(|(_, proposal)| proposal.side_of(actor_id).is_some())
            })?;
        Some(self.trade_session_vm(*id, proposal, actor_id))
    }

    fn trade_session_vm(
        &self,
        proposal_id: u32,
        proposal: &TradeProposal,
        observer: &str,
    ) -> AuthorityTradeSessionSnapshot {
        let my_side = proposal.side_of(observer).unwrap_or(TradeSide::Proposer);
        let their_side = match my_side {
            TradeSide::Proposer => TradeSide::Partner,
            TradeSide::Partner => TradeSide::Proposer,
        };
        let (stage, close_reason) = match proposal.closed {
            Some(close) if close.executed => ("executed".to_owned(), None),
            Some(close) => (
                "declined".to_owned(),
                close.reason.map(|reason| reason.label().to_owned()),
            ),
            None if proposal.both_locked() => ("confirm".to_owned(), None),
            None => ("negotiating".to_owned(), None),
        };
        AuthorityTradeSessionSnapshot {
            proposal_id,
            partner_actor_id: proposal.actor_of(their_side).to_owned(),
            mine: self.trade_side_snapshot(proposal, my_side),
            theirs: self.trade_side_snapshot(proposal, their_side),
            both_locked: proposal.both_locked(),
            stage,
            close_reason,
            tick: self.runtime.durable.tick,
        }
    }

    fn trade_side_snapshot(
        &self,
        proposal: &TradeProposal,
        side: TradeSide,
    ) -> AuthorityTradeSideSnapshot {
        let actor_id = proposal.actor_of(side);
        let items = proposal
            .side_items(side)
            .iter()
            .map(|item| {
                let owned = self.actor_inventory_item_name(actor_id, item.item_id);
                let name = if owned.is_empty() {
                    inventory_item_name(item.item_id)
                        .map(str::to_owned)
                        .unwrap_or_default()
                } else {
                    owned
                };
                AuthorityTradeItemLineSnapshot {
                    item_id: item.item_id,
                    variant_id: item.variant_id,
                    name,
                    quantity: item.quantity,
                }
            })
            .collect();
        AuthorityTradeSideSnapshot {
            actor_id: actor_id.to_owned(),
            items,
            coin: proposal.side_coin(side),
            locked: proposal.side_locked(side),
            confirmed: proposal.side_confirmed(side),
        }
    }

    /// Merge one line into a side's offer, summing quantity for a matching
    /// (item_id, variant_id) pair.
    fn merge_trade_line(items: &mut Vec<TradeItemSpec>, add: &TradeItemSpec) {
        if let Some(line) = items
            .iter_mut()
            .find(|line| line.item_id == add.item_id && line.variant_id == add.variant_id)
        {
            line.quantity = line.quantity.saturating_add(add.quantity);
        } else {
            items.push(add.clone());
        }
    }

    /// Remove `rem.quantity` of a matching (item_id, variant_id) line. Returns false
    /// (no mutation) if the line is absent or holds less than requested.
    fn remove_trade_line(items: &mut Vec<TradeItemSpec>, rem: &TradeItemSpec) -> bool {
        let Some(index) = items
            .iter()
            .position(|line| line.item_id == rem.item_id && line.variant_id == rem.variant_id)
        else {
            return false;
        };
        if items[index].quantity < rem.quantity {
            return false;
        }
        items[index].quantity -= rem.quantity;
        if items[index].quantity == 0 {
            items.remove(index);
        }
        true
    }

    fn ensure_actor_starter_tool_item(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
        item_name: &str,
    ) {
        let already_available_to_player =
            self.runtime
                .durable
                .actors
                .get(actor_id)
                .is_some_and(|actor| {
                    is_human_player_actor(actor) && self.actor_has_starter_tool_item(actor, item_id)
                });
        if already_available_to_player {
            return;
        }
        self.ensure_actor_single_item(actor_id, item_id, variant_id, item_name, "field-pack");
    }

    pub(super) fn ensure_actor_crafting_tool(&mut self, actor_id: &str) {
        // Starter Field Multitool quality scales with the actor's craftsman tools track
        // (500 -> 650 by tools-IV); novice/untrained resolves to 500 (unchanged baseline).
        let starter_quality = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| {
                actor
                    .professions
                    .craftsman_tools_starter_grant_quality_milli()
            })
            .unwrap_or(STARTER_FIELD_MULTITOOL_QUALITY_MILLI);
        self.ensure_actor_starter_tool_item(
            actor_id,
            FIELD_MULTITOOL_ITEM_ID,
            starter_quality,
            "Field Multitool",
        );
    }

    pub(super) fn ensure_actor_survey_tool(&mut self, actor_id: &str) {
        // The Mineral Survey Tool is the bootstrap-granted entry into the
        // survey/sample loop (owner ruling: bootstrap = Field Multitool +
        // Mineral Survey Tool). Other category survey tools are crafted.
        self.ensure_actor_starter_tool_item(
            actor_id,
            MINERAL_SURVEY_TOOL_ITEM_ID,
            STARTER_FIELD_MULTITOOL_QUALITY_MILLI,
            "Mineral Survey Tool",
        );
    }

    pub(super) fn ensure_actor_craftsman_novice_tools(&mut self, actor_id: &str) {
        self.ensure_actor_crafting_tool(actor_id);
        self.ensure_actor_survey_tool(actor_id);
    }

    pub(super) fn ensure_npc_craftsman_field_tools_for_actor(&mut self, actor_id: &str) {
        let should_grant = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| {
                !is_human_player_actor(actor)
                    && actor_has_profession(actor, AuthorityProfessionKind::Craftsman)
            });
        if should_grant {
            self.ensure_actor_craftsman_novice_tools(actor_id);
        }
    }

    pub(super) fn ensure_npc_craftsman_field_tools_for_all(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            self.ensure_npc_craftsman_field_tools_for_actor(&actor_id);
        }
    }

    fn ensure_actor_single_item(
        &mut self,
        actor_id: &str,
        item_id: u32,
        variant_id: u32,
        item_name: &str,
        container_suffix: &str,
    ) {
        if self.runtime.durable.inventory.iter().any(|row| {
            row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            return;
        }
        self.add_actor_inventory_stack(
            actor_id,
            item_id,
            variant_id,
            item_name,
            1,
            1,
            container_suffix,
        );
    }

    pub(super) fn actor_crafting_tool_quality_milli(&self, actor_id: &str) -> u16 {
        self.actor_field_multitool_quality_milli(actor_id)
    }

    pub(super) fn best_actor_resource_variant_with_quantity(
        &self,
        actor_id: &str,
        item_id: u32,
        min_quantity: u32,
    ) -> Option<(u32, ResourceStats)> {
        self.runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id
                    && row.available >= min_quantity
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .filter_map(|row| {
                resource_stats_for_item_variant(row.item_id, row.variant_id)
                    .map(|stats| (row.variant_id, stats))
            })
            .max_by_key(|(variant_id, stats)| (stats.composite_quality(), *variant_id))
    }

    pub(super) fn add_or_restore_actor_inventory(
        &mut self,
        actor_id: &str,
        item_id: u32,
        quantity: u32,
    ) -> Result<bool, AuthorityRejectReason> {
        if self.actor_uses_unlimited_ammo_item(actor_id, item_id) {
            self.remove_actor_inventory_item_rows(actor_id, item_id);
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                actor.slugthrower_magazine.reload_until_tick = 0;
            }
            return Ok(false);
        }
        let item_name = inventory_item_name(item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        if let Some(row) = self.runtime.durable.inventory.iter_mut().find(|row| {
            row.item_id == item_id && actor_owns_inventory_container(actor_id, &row.container)
        }) {
            row.item = item_name.to_owned();
            let before = (row.quantity, row.reserved, row.available);
            row.quantity = row.quantity.max(quantity);
            row.reserved = row.reserved.min(row.quantity);
            row.available = row.quantity.saturating_sub(row.reserved);
            return Ok(before != (row.quantity, row.reserved, row.available));
        }
        let container = format!("{actor_id}:field-pack");
        let stack_id = self.next_inventory_stack_id(&container);
        self.runtime.durable.inventory.push(InventoryStackSnapshot {
            stack_id,
            container,
            item: item_name.to_owned(),
            item_id,
            variant_id: 0,
            quantity,
            reserved: 0,
            available: quantity,
        });
        Ok(true)
    }
    pub(super) fn restore_player_like_respawn_supplies(
        &mut self,
        actor_id: &str,
    ) -> Result<bool, AuthorityRejectReason> {
        let stimpak_changed = self.add_or_restore_actor_inventory(
            actor_id,
            STIMPAK_A_ITEM_ID,
            PLAYER_RESPAWN_STIMPAK_A_QUANTITY,
        )?;
        let bandage_changed = self.add_or_restore_actor_inventory(
            actor_id,
            FIELD_BANDAGE_ITEM_ID,
            PLAYER_RESPAWN_FIELD_BANDAGE_QUANTITY,
        )?;
        self.reconcile_actor_clothing(actor_id);
        Ok(stimpak_changed || bandage_changed)
    }
    pub(super) fn ensure_standard_player_deploy_loadout_for_actor(
        &mut self,
        actor_id: &str,
    ) -> Result<bool, AuthorityRejectReason> {
        let supplies_changed = self.restore_player_like_respawn_supplies(actor_id)?;
        let ammo_changed = self.add_or_restore_actor_inventory(
            actor_id,
            AMMO_SLUG_IRON_ITEM_ID,
            PLAYER_RESPAWN_SLUG_AMMO_QUANTITY,
        )?;
        Ok(supplies_changed || ammo_changed)
    }

    pub(super) fn apply_sample_resource(
        &mut self,
        config: &SliceAuthorityConfig,
        family: &str,
        stop: bool,
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
        if stop {
            self.stop_actor_resource_sample_loop(&actor.id);
            return Ok(());
        }
        if actor.pending_resource_sample.is_some()
            || actor
                .resource_sample_loop
                .as_ref()
                .is_some_and(|sample_loop| self.runtime.durable.tick < sample_loop.next_sample_tick)
        {
            return Err(AuthorityRejectReason::SampleCooldown);
        }
        let pending = self.start_resource_sample_for_actor_id(&actor.id, family, true)?;
        self.arm_resource_sample_loop_from_pending(&actor.id, &pending);
        Ok(())
    }

    /// Trained survey: use the matching category tool to map a deterministic
    /// grid around the actor without extracting. Basic point sampling is the
    /// universal, tool-free resource entry point; this richer map remains a
    /// Craftsman action.
    pub(super) fn apply_survey_resource(
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
        Self::require_actor_profession(&actor, AuthorityProfessionKind::Craftsman)?;
        self.require_actor_survey_tool(&actor.id, family)?;
        self.ensure_actor_resource_survey_ready(&actor.id)?;
        let resource =
            resource_instance_for_family_at_tick(&actor.area_id, family, self.runtime.durable.tick)
                .ok_or(AuthorityRejectReason::InvalidResourceFamily)?;
        let range_cells = resource_survey_range_cells(&actor);
        // Heat Reading: the survey track tightens sample spacing (resolution) 12 -> 6 cells,
        // so BOTH survey depth (range) and concentration-map fineness scale with tier. cols/
        // rows derive from range/step; the wire payload shape is unchanged.
        let step_cells = actor.professions.craftsman_survey_grid_step_cells().max(1);
        let half_span = (range_cells / step_cells).max(1);
        let center_offset = half_span.saturating_mul(step_cells);
        let cols = u16::try_from(half_span.saturating_mul(2).saturating_add(1)).unwrap_or(u16::MAX);
        let rows = cols;
        let mut concentration_milli = Vec::with_capacity(usize::from(cols) * usize::from(rows));
        let mut best = 0_u16;
        let mut best_cell = actor.cell;
        for row in 0..i32::from(rows) {
            let dy = row.saturating_mul(step_cells).saturating_sub(center_offset);
            for col in 0..i32::from(cols) {
                let dx = col.saturating_mul(step_cells).saturating_sub(center_offset);
                let cell = AuthorityCell::new(
                    actor.cell.x.saturating_add(dx),
                    actor.cell.y.saturating_add(dy),
                );
                let concentration = self.resource_concentration_milli_for_area(
                    &actor.area_id,
                    resource.concentration_seed,
                    cell,
                );
                if concentration > best {
                    best = concentration;
                    best_cell = cell;
                }
                concentration_milli.push(concentration);
            }
        }
        let here = self.resource_concentration_milli_for_area(
            &actor.area_id,
            resource.concentration_seed,
            actor.cell,
        );
        let cooldown_until_tick =
            self.set_actor_resource_survey_cooldown(&actor.id, RESOURCE_SURVEY_ACTION_MS)?;
        self.runtime.pending_survey_result = Some(AuthoritySurveyResultSnapshot {
            family: resource.family.clone(),
            area_id: actor.area_id.clone(),
            spawn_id: resource.spawn_id.clone(),
            spawn_name: resource.spawn_name.clone(),
            center_x: actor.cell.x,
            center_y: actor.cell.y,
            range_cells,
            step_cells,
            cols,
            rows,
            concentration_milli,
            cooldown_until_tick,
            tick: self.runtime.durable.tick,
        });
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} surveyed {}: {}% here, richest {}% at ({},{})",
                actor.id,
                resource.short_label,
                here / 10,
                best / 10,
                best_cell.x,
                best_cell.y
            ),
            cell: Some(CellSnapshot::new(actor.cell.x, actor.cell.y)),
        });
        Ok(())
    }

    pub(super) fn stop_actor_resource_sample_loop(&mut self, actor_id: &str) -> bool {
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return false;
        };
        let had_pending = actor.pending_resource_sample.take().is_some();
        let had_loop = actor.resource_sample_loop.take().is_some();
        had_pending || had_loop
    }

    fn arm_resource_sample_loop_from_pending(
        &mut self,
        actor_id: &str,
        pending: &PendingResourceSampleState,
    ) {
        let next_sample_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(RESOURCE_SAMPLE_AUTO_REPEAT_CADENCE_TICKS);
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.resource_sample_loop = Some(ResourceSampleLoopState {
                family: pending.family.clone(),
                area_id: pending.area_id.clone(),
                cell: pending.cell,
                next_sample_tick,
            });
        }
    }

    fn start_resource_sample_for_actor_id(
        &mut self,
        actor_id: &str,
        family: &str,
        enforce_economy_cooldown: bool,
    ) -> Result<PendingResourceSampleState, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        let resource =
            resource_instance_for_family_at_tick(&actor.area_id, family, self.runtime.durable.tick)
                .ok_or(AuthorityRejectReason::InvalidResourceFamily)?;
        if enforce_economy_cooldown {
            self.ensure_actor_economy_action_ready(&actor.id)?;
        }
        let sample_cooldown_ticks = self.economy_action_ticks(RESOURCE_SAMPLE_ACTION_MS);

        let actor_state = self
            .runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor_state.pending_resource_sample.is_some() {
            return Err(AuthorityRejectReason::SampleCooldown);
        }
        let resolve_tick = match actor_state.posture {
            AuthorityActorPosture::Standing => {
                actor_state.posture = AuthorityActorPosture::KneelingDown;
                actor_state.posture_until_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(POSTURE_KNEEL_DOWN_TICKS);
                actor_state
                    .posture_until_tick
                    .saturating_add(RESOURCE_SAMPLE_DURATION_TICKS)
            }
            AuthorityActorPosture::Kneeling => self
                .runtime
                .durable
                .tick
                .saturating_add(RESOURCE_SAMPLE_DURATION_TICKS),
            AuthorityActorPosture::KneelingDown | AuthorityActorPosture::StandingUp => {
                return Err(AuthorityRejectReason::PostureLocked);
            }
        };
        let cooldown_until_tick = resolve_tick.saturating_add(sample_cooldown_ticks);
        let pending = PendingResourceSampleState {
            family: resource.family,
            area_id: actor_state.area_id.clone(),
            cell: actor_state.cell,
            resolve_tick,
        };
        actor_state.pending_resource_sample = Some(pending.clone());
        actor_state.next_economy_action_tick = actor_state
            .next_economy_action_tick
            .max(cooldown_until_tick);
        Ok(pending)
    }

    pub(super) fn tick_pending_resource_samples(&mut self) {
        let due_actor_ids = self
            .runtime
            .durable
            .actors
            .iter()
            .filter_map(|(actor_id, actor)| {
                actor
                    .pending_resource_sample
                    .as_ref()
                    .filter(|sample| self.runtime.durable.tick >= sample.resolve_tick)
                    .map(|_| actor_id.clone())
            })
            .collect::<Vec<_>>();
        for actor_id in due_actor_ids {
            let Some(pending) = self
                .runtime
                .durable
                .actors
                .get_mut(&actor_id)
                .and_then(|actor| actor.pending_resource_sample.take())
            else {
                continue;
            };
            if self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .is_none_or(|actor| actor.life_state != AuthorityLifeState::Alive)
            {
                self.stop_actor_resource_sample_loop(&actor_id);
                continue;
            }
            let _ = self.resolve_pending_resource_sample(&actor_id, pending);
        }
    }

    pub(super) fn tick_resource_sample_loops(&mut self) {
        let due_actor_ids = self
            .runtime
            .durable
            .actors
            .iter()
            .filter_map(|(actor_id, actor)| {
                actor
                    .resource_sample_loop
                    .as_ref()
                    .filter(|sample_loop| self.runtime.durable.tick >= sample_loop.next_sample_tick)
                    .map(|_| actor_id.clone())
            })
            .collect::<Vec<_>>();
        for actor_id in due_actor_ids {
            if self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .is_some_and(|actor| actor.pending_resource_sample.is_some())
            {
                continue;
            }
            let Some(sample_loop) = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .and_then(|actor| actor.resource_sample_loop.clone())
            else {
                continue;
            };
            let should_stop = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .is_none_or(|actor| {
                    actor.life_state != AuthorityLifeState::Alive
                        || actor.sleep.remaining_ticks > 0
                        || actor.posture != AuthorityActorPosture::Kneeling
                        || actor.area_id != sample_loop.area_id
                        || actor.cell != sample_loop.cell
                });
            if should_stop {
                self.stop_actor_resource_sample_loop(&actor_id);
                continue;
            }
            match self.start_resource_sample_for_actor_id(&actor_id, &sample_loop.family, false) {
                Ok(pending) => self.arm_resource_sample_loop_from_pending(&actor_id, &pending),
                Err(_) => {
                    self.stop_actor_resource_sample_loop(&actor_id);
                }
            }
        }
    }

    fn resolve_pending_resource_sample(
        &mut self,
        actor_id: &str,
        pending: PendingResourceSampleState,
    ) -> Result<u32, AuthorityRejectReason> {
        if !self.runtime.durable.actors.contains_key(actor_id) {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        let resource = resource_instance_for_family_at_tick(
            &pending.area_id,
            &pending.family,
            self.runtime.durable.tick,
        )
        .ok_or(AuthorityRejectReason::InvalidResourceFamily)?;
        let concentration_milli = self.resource_concentration_milli_for_area(
            &pending.area_id,
            resource.concentration_seed,
            pending.cell,
        );
        let tool_milli = self.actor_crafting_tool_quality_milli(actor_id);
        let yield_quantity = resource_sample_yield(
            resource.stats.extraction_yield,
            concentration_milli,
            tool_milli,
        );
        let added = self.add_actor_inventory_stack(
            actor_id,
            resource.item_id,
            resource.variant_id,
            &resource.label,
            yield_quantity,
            RESOURCE_STACK_CAP,
            "resource-crate",
        );
        let craftsman_total_xp = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| actor_has_profession(actor, AuthorityProfessionKind::Craftsman))
            .then(|| {
                self.award_profession_track_xp(
                    actor_id,
                    AuthorityProfessionKind::Craftsman,
                    "survey",
                    45,
                )
            })
            .transpose()?;
        let xp_suffix = craftsman_total_xp
            .map(|total_xp| format!(", +45 Craftsman XP, total {total_xp}"))
            .unwrap_or_default();
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} hand-sampled {} {} at {}% concentration{}",
                actor_id,
                added,
                resource.short_label,
                concentration_milli / 10,
                xp_suffix
            ),
            cell: Some(CellSnapshot::new(pending.cell.x, pending.cell.y)),
        });
        Ok(added)
    }

    pub(super) fn apply_take_loot_item(
        &mut self,
        config: &SliceAuthorityConfig,
        container: &str,
        item_id: u32,
        variant_id: u32,
        quantity: i32,
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
        let source = self.take_loot_source_for_container(container)?;
        if source.area_id != actor.area_id
            || position_distance_milli(actor.position, source.position)
                > HARVEST_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::LootOutOfRange);
        }
        if source
            .loot_rights_actor_id
            .as_deref()
            .is_some_and(|rights_actor_id| rights_actor_id != actor.id)
        {
            return Err(AuthorityRejectReason::LootNoRights);
        }
        if quantity <= 0 {
            return Err(AuthorityRejectReason::LootInvalidQuantity);
        }
        let quantity =
            u32::try_from(quantity).map_err(|_| AuthorityRejectReason::LootInvalidQuantity)?;
        if self.loot_container_available_variant(container, item_id, variant_id) < quantity {
            return Err(AuthorityRejectReason::LootMissingStack);
        }
        let item_name = self
            .runtime
            .durable
            .inventory
            .iter()
            .find(|row| {
                row.container == container
                    && row.item_id == item_id
                    && row.variant_id == variant_id
                    && row.available > 0
            })
            .map(|row| row.item.clone())
            .or_else(|| inventory_item_name(item_id).map(str::to_owned))
            .unwrap_or_else(|| format!("item {item_id}"));

        let added = self.add_actor_inventory_stack(
            &actor.id,
            item_id,
            variant_id,
            &item_name,
            quantity,
            u32::MAX,
            "field-pack",
        );
        debug_assert_eq!(added, quantity);
        if added != quantity {
            return Err(AuthorityRejectReason::ContainerFull);
        }

        let mut remaining = quantity;
        for row in self.runtime.durable.inventory.iter_mut().filter(|row| {
            row.container == container && row.item_id == item_id && row.variant_id == variant_id
        }) {
            if remaining == 0 {
                break;
            }
            let taken = row.available.min(remaining);
            row.quantity = row.quantity.saturating_sub(taken);
            row.available = row.available.saturating_sub(taken);
            row.reserved = row.reserved.min(row.quantity);
            remaining = remaining.saturating_sub(taken);
        }
        self.runtime
            .durable
            .inventory
            .retain(|row| row.container != container || row.quantity > 0);

        match source.kind {
            TakeLootSourceKind::HumanoidCorpse => {
                self.mark_corpse_exhausted_if_ready(&source.target_id, false);
            }
            TakeLootSourceKind::CreatureCorpse => {
                self.mark_corpse_exhausted_if_ready(&source.target_id, false);
            }
            TakeLootSourceKind::PlayerCorpse => {
                self.cleanup_player_corpse_if_empty(&source.target_id);
            }
            TakeLootSourceKind::Cache => {
                self.mark_loot_cache_emptied_if_empty(&source.target_id, container);
            }
        }

        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} took {} x{} from {}",
                actor.id, item_name, quantity, container
            ),
            cell: Some(CellSnapshot::new(source.cell.x, source.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_harvest_corpse(
        &mut self,
        config: &SliceAuthorityConfig,
        target_actor_id: &str,
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
        let target = self
            .runtime
            .durable
            .actors
            .get(target_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if target.area_id != actor.area_id
            || position_distance_milli(actor.position, target.position)
                > HARVEST_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::TargetUnavailable);
        }
        if target.life_state != AuthorityLifeState::Downed || target.body_vanish_tick == 0 {
            return Err(AuthorityRejectReason::TargetNotHarvestable);
        }
        if !is_harvestable_creature_actor(&target) {
            return Err(AuthorityRejectReason::TargetNotHarvestable);
        }
        if target.corpse_exhausted_tick.is_some()
            || !target.gaia_harvest_entitled_actor_ids.contains(&actor.id)
            || target.gaia_harvest_claimed_actor_ids.contains(&actor.id)
        {
            return Err(AuthorityRejectReason::TargetNotHarvestable);
        }

        self.ensure_actor_economy_action_ready(&actor.id)?;
        let harvest_bonus_milli = u32::try_from(
            1_000_i32.saturating_add(
                actor
                    .professions
                    .scout_creature_harvesting_bonus()
                    .saturating_mul(2),
            ),
        )
        .unwrap_or(1_000);
        // Preflight every material before mutating inventory. Resource stacks are
        // unlimited in count, but an item with a zero effective cap must reject
        // the whole harvest rather than minting a partial claim.
        for material in CreatureMaterial::harvest_all() {
            let resource = creature_resource_instance(&target, material, self.runtime.durable.tick);
            if Self::inventory_stack_cap_for_item(resource.item_id, RESOURCE_STACK_CAP) == 0 {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
        }
        let mut harvested = Vec::with_capacity(3);
        for material in CreatureMaterial::harvest_all() {
            let resource = creature_resource_instance(&target, material, self.runtime.durable.tick);
            let concentration_seed = creature_harvest_concentration_seed(&target.area_id, material);
            let concentration_milli = self.resource_concentration_milli_for_area(
                &target.area_id,
                concentration_seed,
                target.cell,
            );
            let yield_quantity = creature_harvest_quantity_from_concentration(
                concentration_milli,
                harvest_bonus_milli,
            );
            let crate_suffix = match material {
                CreatureMaterial::Meat => "creature-food",
                CreatureMaterial::Hide | CreatureMaterial::Bone => "creature-structural",
            };
            let added = self.add_actor_inventory_stack(
                &actor.id,
                resource.item_id,
                resource.variant_id,
                &resource.label,
                yield_quantity,
                RESOURCE_STACK_CAP,
                crate_suffix,
            );
            if added < yield_quantity {
                return Err(AuthorityRejectReason::ItemUnavailable);
            }
            harvested.push((resource, added));
        }

        self.set_actor_economy_action_cooldown(&actor.id, HARVEST_CORPSE_ACTION_MS)?;
        let scout_xp_note = if actor.professions.has(AuthorityProfessionKind::Scout) {
            let total_xp = self.award_profession_tracks_xp(
                &actor.id,
                AuthorityProfessionKind::Scout,
                &["creature-harvesting", "sprinting", "traversal", "campcraft"],
                70,
            )?;
            format!(" (+70 Scout XP, total {total_xp})")
        } else {
            String::new()
        };
        if let Some(corpse) = self.runtime.durable.actors.get_mut(target_actor_id) {
            corpse
                .player_damage_ledger
                .retain(|entry| entry.source_actor_id != actor.id);
            corpse
                .gaia_harvest_claimed_actor_ids
                .insert(actor.id.clone());
        }
        self.mark_corpse_exhausted_if_ready(target_actor_id, true);
        let harvest_summary = harvested
            .iter()
            .map(|(resource, quantity)| format!("{} x{}", resource.short_label, quantity))
            .collect::<Vec<_>>()
            .join(", ");
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!(
                "{} harvested Hide, Meat, Bone ({harvest_summary}) from {}{scout_xp_note}",
                actor.id, target_actor_id,
            ),
            cell: Some(CellSnapshot::new(target.cell.x, target.cell.y)),
        });
        Ok(())
    }

    pub(super) fn apply_craft_item(
        &mut self,
        config: &SliceAuthorityConfig,
        schematic_id: &str,
        experiment_power: u8,
        experiment_handling: u8,
        experiment_reliability: u8,
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
        let normalized_schematic = normalize_command_key(schematic_id);
        if let Some(kind) = medical_schematic_kind(&normalized_schematic) {
            self.craft_medical_quality_supply(
                &actor,
                kind,
                experiment_power,
                experiment_handling,
                experiment_reliability,
            )?;
            return Ok(());
        }
        // Multi-step crafted gear moved to the CraftBegin -> slots -> assembly
        // session path. CraftItem remains the commodity one-shot surface.
        match normalized_schematic.as_str() {
            "slugthrower" | "metal_extractor" | "extractor_battery" | "field_multitool" => {
                Err(AuthorityRejectReason::UnknownSchematic)
            }
            other => {
                self.craft_field_supply_by_schematic(&actor, other)?;
                Ok(())
            }
        }
    }

    pub(super) fn nearest_ammo_stockpile(
        &self,
        actor: &ActorAuthorityState,
        item_id: u32,
    ) -> Option<AmmoStockpileAuthorityState> {
        self.nearest_allowed_ammo_stockpile(actor, item_id)
            .filter(|stockpile| {
                position_distance_milli(actor.position, stockpile.position)
                    <= AMMO_REFILL_RADIUS_MILLI_CELLS
            })
    }

    pub(super) fn nearest_allowed_ammo_stockpile(
        &self,
        actor: &ActorAuthorityState,
        item_id: u32,
    ) -> Option<AmmoStockpileAuthorityState> {
        self.runtime
            .durable
            .world
            .ammo_stockpiles
            .iter()
            .filter(|stockpile| stockpile.area_id == actor.area_id)
            .filter(|stockpile| stockpile.item_id == item_id)
            .filter(|stockpile| stockpile_allows_actor(stockpile, actor))
            .min_by_key(|stockpile| position_distance_milli(actor.position, stockpile.position))
            .cloned()
    }

    pub(super) fn refill_actor_ammo_from_stockpile(
        &mut self,
        actor_id: &str,
        item_id: u32,
    ) -> Result<bool, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        let stockpile = self
            .nearest_ammo_stockpile(&actor, item_id)
            .ok_or(AuthorityRejectReason::NotAtStockpile)?;
        let ammo_changed =
            self.add_or_restore_actor_inventory(actor_id, item_id, stockpile.quantity)?;
        let restored_field_pack = if is_player_like_role(&actor.role) {
            self.restore_player_like_respawn_supplies(actor_id)?
        } else {
            false
        };
        let changed = ammo_changed || restored_field_pack;
        if changed {
            self.record_timeline_event(TimelineEventSnapshot {
                tick: self.runtime.durable.tick,
                label: format!(
                    "{} refilled {}{} from {}",
                    actor.id,
                    ammo_item_name(item_id).unwrap_or("ammo"),
                    if restored_field_pack {
                        " and field pack"
                    } else {
                        ""
                    },
                    stockpile.prop_id
                ),
                cell: Some(CellSnapshot::new(stockpile.cell.x, stockpile.cell.y)),
            });
        }
        Ok(changed)
    }
}
