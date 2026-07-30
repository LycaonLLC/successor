use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum AuthorityClothingSlot {
    Top,
    Legs,
    Boots,
    Gloves,
    Head,
}

fn authority_clothing_slot(item_id: u32) -> Option<AuthorityClothingSlot> {
    match item_id {
        7_101 | 7_102 | 7_201 | 7_204 | 7_301..=7_308 => Some(AuthorityClothingSlot::Top),
        7_104 | 7_202 | 7_309..=7_318 => Some(AuthorityClothingSlot::Legs),
        7_319..=7_328 => Some(AuthorityClothingSlot::Boots),
        7_329..=7_335 => Some(AuthorityClothingSlot::Gloves),
        7_103 | 7_203 => Some(AuthorityClothingSlot::Head),
        _ => None,
    }
}

fn is_humanoid_loot_clothing_item_id(item_id: u32) -> bool {
    matches!(
        item_id,
        7_101 | 7_102 | 7_103 | 7_104 | 7_201 | 7_202 | 7_203 | 7_204
    )
}

fn is_usable_clothing_inventory_row(row: &InventoryStackSnapshot) -> bool {
    if row.quantity == 0 || row.available == 0 {
        return false;
    }
    !is_humanoid_loot_clothing_item_id(row.item_id)
        || row.variant_id == 0
        || super::loot_tables::rolled_loot_item_name(row.item_id, row.variant_id).is_some()
}
fn actor_owns_purge_inventory_container(actor_id: &str, container: &str) -> bool {
    actor_owns_inventory_container(actor_id, container) || container == format!("bank:{actor_id}")
}

impl SliceAuthorityState {
    pub fn upsert_actor(
        &mut self,
        input: AuthorityActorUpsert,
    ) -> Result<AuthorityActorSnapshot, SliceAuthorityActorError> {
        if input.id.is_empty() {
            return Err(SliceAuthorityActorError::EmptyActorId);
        }
        let position = AuthorityPosition::from_world(input.x, input.y)
            .ok_or_else(|| SliceAuthorityActorError::InvalidPosition(input.id.clone()))?;
        let cell = position.cell();
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(&input.area_id)
            .ok_or_else(|| SliceAuthorityActorError::UnknownArea(input.area_id.clone()))?;
        if !area.contains(cell) {
            return Err(SliceAuthorityActorError::OutOfBounds {
                area_id: input.area_id,
                x: cell.x,
                y: cell.y,
            });
        }
        if self
            .runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(&input.area_id, cell.x, cell.y))
        {
            return Err(SliceAuthorityActorError::BlockedCell {
                area_id: input.area_id.clone(),
                x: cell.x,
                y: cell.y,
            });
        }
        let bare_start = input.bare_start;
        let returning = input.returning;
        let actor_role = input.role;
        let default_equipped_weapon_id = if bare_start || returning {
            None
        } else {
            default_equipped_weapon_id_for_role_and_professions(&actor_role, &input.profession_ids)
        };
        let effective_stats = derive_effective_actor_stats_for_role(&actor_role);
        let next_route_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS);
        let stats = self
            .runtime
            .durable
            .actors
            .get(&input.id)
            .map(|actor| actor.stats.clone())
            .unwrap_or_default();
        let mut professions = ActorProfessionState::from_profession_ids(&input.profession_ids)
            .map_err(
                |profession_id| SliceAuthorityActorError::UnknownProfessionId {
                    actor_id: input.id.clone(),
                    profession_id,
                },
            )?;
        professions.set_credits(input.credits);
        professions
            .grant_skill_box_ids(&input.skill_box_ids)
            .map_err(
                |profession_id| SliceAuthorityActorError::UnknownProfessionId {
                    actor_id: input.id.clone(),
                    profession_id,
                },
            )?;
        professions
            .restore_progression_seed(
                &input.profession_xp,
                &input.profession_track_xp,
                input.skill_point_cap,
            )
            .map_err(
                |profession_id| SliceAuthorityActorError::UnknownProfessionId {
                    actor_id: input.id.clone(),
                    profession_id,
                },
            )?;
        if let Some(active_title_id) = input.active_title_id.as_deref() {
            professions
                .set_active_title_id(Some(active_title_id))
                .map_err(|_| SliceAuthorityActorError::UnavailableActiveTitleId {
                    actor_id: input.id.clone(),
                    active_title_id: active_title_id.to_owned(),
                })?;
        }
        let capabilities =
            ActorCapabilityState::from_professions_and_grants(&professions, &input.capabilities);
        let career_goal_id = parse_authority_career_goal_id(input.career_goal_id.as_deref())
            .map_err(
                |career_goal_id| SliceAuthorityActorError::UnknownCareerGoalId {
                    actor_id: input.id.clone(),
                    career_goal_id,
                },
            )?;
        let fixed_start_worn = vec![
            AuthorityActorWornPiece {
                item: "under_bodysuit".to_owned(),
                colors: vec!["#89cff0".to_owned()],
            },
            AuthorityActorWornPiece {
                item: "boots_canvas_ankle".to_owned(),
                colors: vec!["#303030".to_owned(), "#808080".to_owned()],
            },
        ];
        let effective_worn = if bare_start {
            fixed_start_worn
        } else {
            input.worn.clone()
        };
        let mut worn_colors = if bare_start {
            BTreeMap::new()
        } else {
            input.worn_colors
        };
        for piece in &effective_worn {
            worn_colors
                .entry(piece.item.clone())
                .or_insert_with(|| piece.colors.clone());
        }
        let prior_equipped_clothing = self
            .runtime
            .durable
            .actors
            .get(&input.id)
            .map(|actor| actor.equipped_clothing.clone())
            .unwrap_or_default();
        let mut actor = ActorAuthorityState {
            id: input.id.clone(),
            entity: input.entity,
            label: input.label.clone().unwrap_or_else(|| input.id.clone()),
            display_name: input
                .display_name
                .unwrap_or_else(|| input.label.unwrap_or_else(|| input.id.clone())),
            worn_colors: worn_colors.clone(),
            descriptor: String::new(),
            link_dead: input.link_dead,
            link_dead_expires_tick: 0,
            appearance: input.appearance.unwrap_or_default(),
            worn: effective_worn.clone(),
            equipped_clothing: prior_equipped_clothing,
            sprite: input
                .sprite
                .unwrap_or_else(|| "adventurer-premium-male".to_owned()),
            template_id: input.template_id,
            spawn_zone_id: input.spawn_zone_id,
            role: actor_role.clone(),
            faction: ActorFactionState {
                faction_id: crate::faction::normalize_optional_key(input.faction_id.as_deref()),
                social_group: crate::faction::normalize_optional_key(input.social_group.as_deref()),
                pvp_status: crate::faction::FactionPvpStatus::from_optional(
                    input.pvp_status.as_deref(),
                ),
            },
            player_organization_id: crate::faction::normalize_optional_key(
                input.player_organization_id.as_deref(),
            ),
            player_organization_tag: input
                .player_organization_tag
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            area_id: input.area_id.clone(),
            cell,
            position,
            direction: input.direction.clone(),
            scale: input.scale.clamp(1, 6),
            home_area_id: input.area_id,
            home_cell: cell,
            home_direction: input.direction,
            home_route: Vec::new(),
            life_state: AuthorityLifeState::Alive,
            lifecycle_seq: 1,
            posture: AuthorityActorPosture::Standing,
            posture_until_tick: 0,
            vitals: input.vitals,
            max_vitals: input.max_vitals,
            effective_stats,
            professions,
            capabilities,
            capability_grants: input.capabilities.clone(),
            career_goal_id,
            passive_regen_milli: AuthorityVitals::zero(),
            weather_damage_accumulated_milli: 0,
            bleed_stacks: Vec::new(),
            consumable_effects: Vec::new(),
            service_buffs: Vec::new(),
            personal_shield: None,
            sprint_action_drain_milli: 0,
            sprint_recovery_locked: false,
            sprint_recovery_regen_carry: 0,
            sprint_regen_block_until_tick: 0,
            mobility: ActorMobilityTelemetry::default(),
            downed_action_drain_milli: 0,
            downed_spirit_drain_milli: 0,
            incap_expires_tick: 0,
            incap_count: 0,
            incap_window_start_tick: 0,
            incap_grace_until_tick: 0,
            sleep: SleepAuthorityState::default(),
            suppression: SuppressionAuthorityState::default(),
            ai: ai_for_actor(&input.id, &actor_role),
            next_fire_tick: 0,
            weapon_recoil_heat_milli: 0,
            weapon_recoil_last_tick: self.runtime.durable.tick,
            equipped_weapon_id: default_equipped_weapon_id,
            equipped_weapon_item_id: 0,
            equipped_weapon_variant_id: 0,
            slugthrower_magazine: slugthrower_full_magazine_state(),
            combat_queue: AbilityQueue::default(),
            combat_until_tick: 0,
            engagement_target_id: None,
            peace_requested: false,
            next_move_tick: 0,
            move_intent: None,
            next_economy_action_tick: 0,
            next_resource_survey_tick: 0,
            pending_resource_sample: None,
            resource_sample_loop: None,
            cranking_extractor_id: None,
            craft_session: None,
            known_recipe_ids: BTreeSet::new(),
            splice_session: None,
            scanned_genomes: BTreeSet::new(),
            next_starter_tool_request_tick: 0,
            shots_fired: 0,
            last_shot_tick: None,
            last_moved_tick: None,
            stats,
            route: Vec::new(),
            route_index: 0,
            next_route_tick,
            player_damage_ledger: Vec::new(),
            loot_rights_actor_id: None,
            gaia_harvest_entitled_actor_ids: BTreeSet::new(),
            gaia_harvest_claimed_actor_ids: BTreeSet::new(),
            body_vanish_tick: 0,
            respawn_tick: 0,
            corpse_exhausted_tick: None,
            creature_corpse_harvested_tick: None,
            clone_sickness_ticks: 0,
            respawn_return: Vec::new(),
        };
        refresh_actor_presentation(&mut actor, self.runtime.durable.tick);
        self.runtime.durable.actors.insert(input.id.clone(), actor);
        if returning {
            // Returning characters already own durable inventory in Rust. This
            // path intentionally performs zero inventory or reservation writes.
        } else if bare_start {
            if let Some(actor) = self.runtime.durable.actors.get_mut(&input.id) {
                actor.equipped_clothing.clear();
            }
            self.strip_bare_start_actor_inventory(&input.id);
            self.ensure_creator_clothing_inventory(&input.id, &input.worn);
        } else {
            self.ensure_npc_craftsman_field_tools_for_actor(&input.id);
            if self
                .runtime
                .durable
                .actors
                .get(&input.id)
                .is_some_and(is_human_player_actor)
            {
                self.ensure_standard_player_deploy_loadout_for_actor(&input.id)
                    .expect("standard deploy loadout item ids are valid");
            }
        }
        self.reconcile_actor_clothing(&input.id);
        self.ensure_initial_skill_backup(&input.id);
        self.sync_guild_member_name(&input.id);
        self.sync_guild_actor_fields();
        Ok(self
            .actor_snapshot(&input.id)
            .expect("upserted authority actor exists"))
    }

    fn strip_bare_start_actor_inventory(&mut self, actor_id: &str) {
        let mut removed_reservations = Vec::new();
        self.runtime.durable.reservations.retain(|reservation| {
            let remove = reservation.actor == actor_id
                || actor_owns_inventory_container(actor_id, &reservation.from);
            if remove {
                removed_reservations.push(reservation.clone());
            }
            !remove
        });
        for reservation in removed_reservations {
            if let Some(row) = self
                .runtime
                .durable
                .inventory
                .iter_mut()
                .find(|row| row.container == reservation.from && row.item == reservation.item)
            {
                row.reserved = row.reserved.saturating_sub(reservation.quantity);
                row.available = row.quantity.saturating_sub(row.reserved);
            }
        }
        self.runtime
            .durable
            .inventory
            .retain(|row| !actor_owns_inventory_container(actor_id, &row.container));
    }
    fn ensure_creator_clothing_inventory(
        &mut self,
        actor_id: &str,
        _worn: &[AuthorityActorWornPiece],
    ) {
        let container = format!("{actor_id}:field-pack");
        for (item, item_id) in [
            ("under_bodysuit", 9_900_001_u32),
            ("boots_canvas_ankle", 7_319_u32),
        ] {
            let stack_id = self.next_inventory_stack_id(&container);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container: container.clone(),
                item: item.to_owned(),
                item_id,
                variant_id: 0,
                quantity: 1,
                reserved: 0,
                available: 1,
            });
        }
    }
    pub(super) fn ensure_fixed_player_starter_clothing(&mut self, actor_id: &str) {
        let container = format!("{actor_id}:field-pack");
        for (item, item_id, colors) in [
            ("under_bodysuit", 9_900_001_u32, vec!["#89cff0".to_owned()]),
            (
                "boots_canvas_ankle",
                7_319_u32,
                vec!["#303030".to_owned(), "#808080".to_owned()],
            ),
        ] {
            let owned = self.runtime.durable.inventory.iter().any(|row| {
                row.container == container && row.item_id == item_id && row.quantity > 0
            });
            if !owned {
                let stack_id = self.next_inventory_stack_id(&container);
                self.runtime.durable.inventory.push(InventoryStackSnapshot {
                    stack_id,
                    container: container.clone(),
                    item: item.to_owned(),
                    item_id,
                    variant_id: 0,
                    quantity: 1,
                    reserved: 0,
                    available: 1,
                });
            }
            if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
                if !actor.worn.iter().any(|piece| piece.item == item) {
                    actor.worn.push(AuthorityActorWornPiece {
                        item: item.to_owned(),
                        colors: colors.clone(),
                    });
                }
                actor.worn_colors.insert(item.to_owned(), colors);
            }
        }
    }

    #[allow(dead_code)]
    pub(super) fn apply_set_equipped_clothing(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: u32,
        equipped: bool,
    ) -> Result<(), AuthorityRejectReason> {
        self.apply_set_equipped_clothing_exact(config, item_id, equipped, None, None, None)
    }

    pub(super) fn apply_set_equipped_clothing_exact(
        &mut self,
        config: &SliceAuthorityConfig,
        item_id: u32,
        equipped: bool,
        container: Option<&str>,
        stack_id: Option<&str>,
        variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        let key = Self::authority_clothing_item_key_for_row(item_id)
            .ok_or(AuthorityRejectReason::UnknownItem)?;
        let slot = authority_clothing_slot(item_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let exact_stack_id = match stack_id {
            Some(value) => {
                let parsed = value.trim().parse::<u64>().ok().filter(|stack| *stack > 0);
                if parsed.is_none() {
                    return Err(AuthorityRejectReason::ItemUnavailable);
                }
                parsed
            }
            None => None,
        };
        let is_loot = is_humanoid_loot_clothing_item_id(item_id);
        if is_loot && (exact_stack_id.is_none() || variant_id.is_none()) {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        // Fixed bare-start clothing is authority-owned. Legacy identity-less
        // SetEquippedClothing must not unequip or rebind it; only exact stack
        // identity may mutate those rows.
        if banking::is_fixed_player_clothing_item_id(item_id)
            && (exact_stack_id.is_none() || variant_id.is_none())
        {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let mut candidates = self
            .runtime
            .durable
            .inventory
            .iter()
            .filter(|row| {
                row.item_id == item_id
                    && actor_owns_inventory_container(&config.player_actor_id, &row.container)
                    && is_usable_clothing_inventory_row(row)
                    && container
                        .is_none_or(|expected| !expected.is_empty() && row.container == expected)
                    && exact_stack_id.is_none_or(|stack| row.stack_id == stack)
                    && variant_id.is_none_or(|variant| row.variant_id == variant)
            })
            .collect::<Vec<_>>();
        if candidates.len() > 1 && !equipped {
            if let Some(selected) = actor.equipped_clothing.iter().find(|selected| {
                selected.item_id == item_id
                    && candidates.iter().any(|row| {
                        row.container == selected.container
                            && row.stack_id == selected.stack_id
                            && row.variant_id == selected.variant_id
                    })
            }) {
                candidates.retain(|row| {
                    row.container == selected.container
                        && row.stack_id == selected.stack_id
                        && row.variant_id == selected.variant_id
                });
            }
        }
        if candidates.len() != 1 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        let row = candidates[0];
        let selected = AuthorityEquippedClothingInstance {
            container: row.container.clone(),
            stack_id: row.stack_id,
            item_id: row.item_id,
            variant_id: row.variant_id,
        };
        self.reconcile_actor_clothing(&config.player_actor_id);
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if equipped {
            if let Some(slot) = slot {
                actor
                    .equipped_clothing
                    .retain(|other| authority_clothing_slot(other.item_id) != Some(slot));
            }
            actor.equipped_clothing.retain(|other| {
                !(other.container == selected.container
                    && other.stack_id == selected.stack_id
                    && other.item_id == selected.item_id
                    && other.variant_id == selected.variant_id)
            });
            actor.equipped_clothing.push(selected);
        } else {
            actor.equipped_clothing.retain(|other| {
                !(other.container == selected.container
                    && other.stack_id == selected.stack_id
                    && other.item_id == selected.item_id
                    && other.variant_id == selected.variant_id)
            });
            actor.worn.retain(|piece| {
                Self::authority_clothing_item_key_for_worn_piece(piece) != Some(key)
            });
        }
        self.reconcile_actor_clothing(&config.player_actor_id);
        Ok(())
    }

    pub(super) fn reconcile_all_actor_clothing(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            self.reconcile_actor_clothing(&actor_id);
        }
    }
    pub(super) fn reconcile_actor_clothing(&mut self, actor_id: &str) {
        let Some(actor_snapshot) = self.runtime.durable.actors.get(actor_id).cloned() else {
            return;
        };
        let had_identity = !actor_snapshot.equipped_clothing.is_empty();
        let mut selected = Vec::new();
        for identity in &actor_snapshot.equipped_clothing {
            let candidates = self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|row| {
                    row.stack_id == identity.stack_id
                        && row.item_id == identity.item_id
                        && row.variant_id == identity.variant_id
                        && actor_owns_inventory_container(actor_id, &row.container)
                        && is_usable_clothing_inventory_row(row)
                        && (identity.container.is_empty() || row.container == identity.container)
                })
                .collect::<Vec<_>>();
            if candidates.len() == 1 {
                let row = candidates[0];
                selected.push(AuthorityEquippedClothingInstance {
                    container: row.container.clone(),
                    stack_id: row.stack_id,
                    item_id: row.item_id,
                    variant_id: row.variant_id,
                });
            }
        }
        if !had_identity {
            for piece in &actor_snapshot.worn {
                let Some(key) = Self::authority_clothing_item_key_for_worn_piece(piece) else {
                    continue;
                };
                let candidates = self
                    .runtime
                    .durable
                    .inventory
                    .iter()
                    .filter(|row| {
                        Self::authority_clothing_item_key_for_row(row.item_id) == Some(key)
                            && actor_owns_inventory_container(actor_id, &row.container)
                            && is_usable_clothing_inventory_row(row)
                    })
                    .collect::<Vec<_>>();
                if candidates.len() == 1 {
                    let row = candidates[0];
                    selected.push(AuthorityEquippedClothingInstance {
                        container: row.container.clone(),
                        stack_id: row.stack_id,
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                    });
                }
            }
        }
        let mut seen = BTreeSet::new();
        selected.retain(|entry| {
            seen.insert((
                entry.container.clone(),
                entry.stack_id,
                entry.item_id,
                entry.variant_id,
            ))
        });
        let selected_keys = selected
            .iter()
            .filter_map(|entry| Self::authority_clothing_item_key_for_row(entry.item_id))
            .collect::<BTreeSet<_>>();
        let mut worn = actor_snapshot
            .worn
            .iter()
            .filter(|piece| {
                Self::authority_clothing_item_key_for_worn_piece(piece)
                    .is_none_or(|key| selected_keys.contains(key))
            })
            .cloned()
            .collect::<Vec<_>>();
        for selected in &selected {
            let Some(key) = Self::authority_clothing_item_key_for_row(selected.item_id) else {
                continue;
            };
            if worn.iter().any(|piece| piece.item == key) {
                continue;
            }
            let colors = actor_snapshot
                .worn_colors
                .get(key)
                .cloned()
                .unwrap_or_default();
            worn.push(AuthorityActorWornPiece {
                item: key.to_owned(),
                colors,
            });
        }
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.equipped_clothing = selected;
            actor.worn = worn;
        }
    }

    fn authority_clothing_item_key_for_row(item_id: u32) -> Option<&'static str> {
        if item_id == banking::STARTER_BODYSUIT_ITEM_ID {
            Some("under_bodysuit")
        } else {
            authority_clothing_item_key(item_id)
        }
    }

    fn authority_clothing_item_key_for_worn_piece(
        piece: &AuthorityActorWornPiece,
    ) -> Option<&'static str> {
        if piece.item == "under_bodysuit" {
            Some("under_bodysuit")
        } else {
            authority_clothing_item_id_for_key(&piece.item)
                .and_then(Self::authority_clothing_item_key_for_row)
        }
    }

    #[allow(dead_code)]
    pub(crate) fn inventory_clothing_state(
        &self,
        container: &str,
        item_id: u32,
    ) -> (bool, Vec<String>) {
        let Some(row) =
            self.runtime.durable.inventory.iter().find(|row| {
                row.container == container && row.item_id == item_id && row.quantity > 0
            })
        else {
            return (false, Vec::new());
        };
        self.inventory_clothing_state_exact(container, item_id, row.stack_id, row.variant_id)
    }

    pub(crate) fn inventory_clothing_state_exact(
        &self,
        container: &str,
        item_id: u32,
        stack_id: u64,
        variant_id: u32,
    ) -> (bool, Vec<String>) {
        let Some(actor_id) = container.split_once(':').map(|(id, _)| id) else {
            return (false, Vec::new());
        };
        let Some(key) = Self::authority_clothing_item_key_for_row(item_id) else {
            return (false, Vec::new());
        };
        let Some(row) = self.runtime.durable.inventory.iter().find(|row| {
            row.container == container
                && row.stack_id == stack_id
                && row.item_id == item_id
                && row.variant_id == variant_id
                && row.quantity > 0
        }) else {
            return (false, Vec::new());
        };
        let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
            return (false, Vec::new());
        };
        let selected_exact = actor.equipped_clothing.iter().any(|selected| {
            selected.container == row.container
                && selected.stack_id == row.stack_id
                && selected.item_id == row.item_id
                && selected.variant_id == row.variant_id
        });
        let selected_legacy_identity = !selected_exact
            && is_usable_clothing_inventory_row(row)
            && actor.equipped_clothing.iter().any(|selected| {
                selected.container.is_empty()
                    && selected.stack_id == row.stack_id
                    && selected.item_id == row.item_id
                    && selected.variant_id == row.variant_id
            })
            && self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|candidate| {
                    candidate.stack_id == row.stack_id
                        && candidate.item_id == row.item_id
                        && candidate.variant_id == row.variant_id
                        && actor_owns_inventory_container(actor_id, &candidate.container)
                        && is_usable_clothing_inventory_row(candidate)
                })
                .take(2)
                .count()
                == 1;
        let selected_legacy_worn = !selected_exact
            && is_usable_clothing_inventory_row(row)
            && actor.equipped_clothing.is_empty()
            && actor
                .worn
                .iter()
                .any(|piece| Self::authority_clothing_item_key_for_worn_piece(piece) == Some(key))
            && self
                .runtime
                .durable
                .inventory
                .iter()
                .filter(|candidate| {
                    Self::authority_clothing_item_key_for_row(candidate.item_id) == Some(key)
                        && actor_owns_inventory_container(actor_id, &candidate.container)
                        && is_usable_clothing_inventory_row(candidate)
                })
                .take(2)
                .count()
                == 1;
        let selected = selected_exact || selected_legacy_identity || selected_legacy_worn;
        let colors = actor
            .worn_colors
            .get(key)
            .cloned()
            .or_else(|| {
                actor
                    .worn
                    .iter()
                    .find(|piece| piece.item == key)
                    .map(|piece| piece.colors.clone())
            })
            .unwrap_or_default();
        (selected, colors)
    }

    /// Applies a validated, one-shot verification fixture after actor creation.
    /// This remains an authority operation: rows live in the actor's own pack
    /// and equipped state is checked through the normal weapon transition.
    pub fn apply_verification_fixture_loadout(
        &mut self,
        actor_id: &str,
        items: &[AuthorityFixtureLoadoutItem],
    ) -> Result<(), AuthorityRejectReason> {
        if items.is_empty() {
            return Err(AuthorityRejectReason::UnknownItem);
        }
        self.strip_bare_start_actor_inventory(actor_id);
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.equipped_clothing.clear();
        }
        self.set_actor_equipped_weapon_impl(actor_id, None, None, false)?;
        for item in items {
            let item_name =
                inventory_item_name(item.item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
            let container = format!("{actor_id}:field-pack");
            let stack_id = self.next_inventory_stack_id(&container);
            self.runtime.durable.inventory.push(InventoryStackSnapshot {
                stack_id,
                container,
                item: item_name.to_owned(),
                item_id: item.item_id,
                variant_id: item.variant_id,
                quantity: item.quantity,
                reserved: 0,
                available: item.quantity,
            });
        }
        if let Some(item) = items.iter().find(|item| item.equipped) {
            let weapon_id = weapon_id_for_inventory_item(item.item_id)
                .ok_or(AuthorityRejectReason::UnknownItem)?;
            self.set_actor_equipped_weapon_impl(
                actor_id,
                Some(weapon_id),
                Some(item.item_id),
                true,
            )?;
        }
        self.reconcile_actor_clothing(actor_id);
        Ok(())
    }

    pub fn remove_actor(&mut self, actor_id: &str) -> bool {
        let removed = self.runtime.durable.actors.remove(actor_id).is_some();
        if removed {
            self.runtime
                .durable
                .population
                .actor_sources
                .remove(actor_id);
            // Disconnect rule: an actor ceasing to exist leaves its group (succession /
            // disband) and voids invites naming it. Death does NOT reach here.
            self.groups_on_actor_removed(actor_id);
            // Disconnect end condition: the actor's active duel dissolves and any
            // challenge naming it is voided. Death does NOT reach here.
            self.duels_on_actor_removed(actor_id);
        }
        removed
    }

    /// Removes an actor using the normal disconnect lifecycle. When requested,
    /// also removes every inventory row and reservation owned by that actor.
    ///
    /// The default disconnect path deliberately preserves these rows so a
    /// returning character can re-enter with its durable Rust gameplay state.
    pub fn remove_actor_and_purge_inventory(
        &mut self,
        actor_id: &str,
        purge_inventory: bool,
    ) -> bool {
        let removed = self.remove_actor(actor_id);
        if purge_inventory {
            self.runtime.durable.reservations.retain(|reservation| {
                reservation.actor != actor_id
                    && !actor_owns_purge_inventory_container(actor_id, &reservation.from)
            });
            self.runtime
                .durable
                .inventory
                .retain(|row| !actor_owns_purge_inventory_container(actor_id, &row.container));
        }
        removed
    }

    pub fn set_actor_link_dead(
        &mut self,
        actor_id: &str,
        link_dead: bool,
        deadline_tick: Option<u64>,
    ) -> Result<AuthorityActorSnapshot, AuthorityRejectReason> {
        let starter_loadout_slugthrower_without_ammo =
            {
                let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
                    return Err(AuthorityRejectReason::UnknownActor);
                };
                actor.link_dead = link_dead;
                actor.link_dead_expires_tick = if link_dead {
                    deadline_tick.unwrap_or_else(|| {
                        self.runtime
                            .durable
                            .tick
                            .saturating_add(link_dead_hold_ticks(
                                self.runtime.durable.world.tick_rate_hz,
                            ))
                    })
                } else {
                    0
                };
                !link_dead
                    && is_human_player_actor(actor)
                    && actor.equipped_weapon_item_id == CRAFTED_SLUGTHROWER_ITEM_ID
                    && actor.equipped_weapon_variant_id == 0
            } && !self.runtime.durable.inventory.iter().any(|row| {
                row.item_id == AMMO_SLUG_IRON_ITEM_ID
                    && actor_owns_inventory_container(actor_id, &row.container)
            });
        if starter_loadout_slugthrower_without_ammo {
            self.add_or_restore_actor_inventory(
                actor_id,
                AMMO_SLUG_IRON_ITEM_ID,
                PLAYER_RESPAWN_SLUG_AMMO_QUANTITY,
            )?;
        }
        self.actor_snapshot(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)
    }

    /// Relocates an already-live actor without rebuilding its durable state.
    ///
    /// This is the trusted server-side counterpart for ticketed world travel.
    /// An actor upsert is intentionally not used here: upserts reconstruct
    /// transient actor state and are not a safe way to move an existing
    /// character that owns skills, equipment, recipes, or other progression.
    pub fn relocate_actor(
        &mut self,
        actor_id: &str,
        area_id: &str,
        x: i32,
        y: i32,
        direction: &str,
    ) -> Result<AuthorityActorSnapshot, AuthorityRejectReason> {
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(area_id)
            .ok_or(AuthorityRejectReason::UnknownArea)?;
        let cell = AuthorityCell::new(x, y);
        if !area.contains(cell) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        if self
            .runtime
            .durable
            .world
            .blocked_cells
            .contains(&CellKey::new(area_id, x, y))
        {
            return Err(AuthorityRejectReason::BlockedCell);
        }

        let cranked_extractor_id = {
            let actor = self
                .runtime
                .durable
                .actors
                .get_mut(actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            actor.area_id = area_id.to_owned();
            actor.cell = cell;
            actor.position = AuthorityPosition::from_cell(cell);
            actor.direction = direction.to_owned();
            actor.route.clear();
            actor.route_index = 0;
            actor.next_move_tick = self.runtime.durable.tick;
            actor.move_intent = None;
            actor.pending_resource_sample = None;
            actor.resource_sample_loop = None;
            actor.cranking_extractor_id.take()
        };
        if let Some(extractor_id) = cranked_extractor_id {
            self.release_manual_extractor_if_unheld(&extractor_id);
        }

        self.actor_snapshot(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)
    }

    pub fn restore_player_like_loadout_for_actor(
        &mut self,
        actor_id: &str,
    ) -> Result<AuthorityActorSnapshot, AuthorityRejectReason> {
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            Self::set_actor_life_state(actor, AuthorityLifeState::Alive);
            actor.vitals = actor.max_vitals;
            Self::clear_actor_transient_respawn_state(actor);
            actor.body_vanish_tick = 0;
            actor.respawn_tick = 0;
        } else {
            return Err(AuthorityRejectReason::UnknownActor);
        }
        self.ensure_standard_player_deploy_loadout_for_actor(actor_id)?;
        self.ensure_fixed_player_starter_clothing(actor_id);
        self.reconcile_actor_clothing(actor_id);
        self.actor_snapshot(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clothing_test_state() -> (SliceAuthorityState, SliceAuthorityConfig) {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice())
            .expect("demo slice builds");
        let config = SliceAuthorityConfig::default();
        let container = format!("{}:field-pack", config.player_actor_id);
        for item_id in [7_301, 7_302, 7_309] {
            let item = creator_clothing_item_key(item_id).expect("creator clothing key");
            let stack_id = state.next_inventory_stack_id(&container);
            state.inventory.push(InventoryStackSnapshot {
                stack_id,
                container: container.clone(),
                item: item.to_owned(),
                item_id,
                variant_id: 0,
                quantity: 1,
                reserved: 0,
                available: 1,
            });
        }
        let actor = state
            .actors
            .get_mut(&config.player_actor_id)
            .expect("demo player");
        actor.worn.clear();
        actor.worn_colors.insert(
            "top_rigged_tank".to_owned(),
            vec!["red".to_owned(), "gold".to_owned()],
        );
        actor.worn_colors.insert(
            "top_frayed_tunic".to_owned(),
            vec!["blue".to_owned(), "silver".to_owned()],
        );
        actor.worn_colors.insert(
            "legs_wrapped_workpants".to_owned(),
            vec!["black".to_owned()],
        );
        (state, config)
    }

    fn push_clothing_row(
        state: &mut SliceAuthorityState,
        container: &str,
        item_id: u32,
        variant_id: u32,
        item: &str,
    ) -> u64 {
        let stack_id = state.next_inventory_stack_id(container);
        state
            .runtime
            .durable
            .inventory
            .push(InventoryStackSnapshot {
                stack_id,
                container: container.to_owned(),
                item: item.to_owned(),
                item_id,
                variant_id,
                quantity: 1,
                reserved: 0,
                available: 1,
            });
        stack_id
    }

    #[test]
    fn creator_clothing_slots_are_exclusive_only_within_slot() {
        let (mut state, config) = clothing_test_state();
        state
            .apply_set_equipped_clothing(&config, 7_301, true)
            .expect("top equips");
        state
            .apply_set_equipped_clothing(&config, 7_302, true)
            .expect("same-slot top swaps");
        state
            .apply_set_equipped_clothing(&config, 7_309, true)
            .expect("different-slot legs coexists");
        let worn = &state.actors[&config.player_actor_id].worn;
        assert_eq!(
            worn.iter()
                .map(|piece| piece.item.as_str())
                .collect::<Vec<_>>(),
            vec!["top_frayed_tunic", "legs_wrapped_workpants"]
        );
        assert_eq!(
            worn.iter()
                .find(|piece| piece.item == "top_frayed_tunic")
                .unwrap()
                .colors,
            vec!["blue", "silver"]
        );
        assert_eq!(
            worn.iter()
                .find(|piece| piece.item == "legs_wrapped_workpants")
                .unwrap()
                .colors,
            vec!["black"]
        );
        state
            .apply_set_equipped_clothing(&config, 7_302, false)
            .expect("top unequips");
        assert_eq!(state.actors[&config.player_actor_id].worn.len(), 1);
        assert_eq!(
            state.actors[&config.player_actor_id].worn[0].item,
            "legs_wrapped_workpants"
        );
        assert_eq!(
            state.actors[&config.player_actor_id]
                .worn_colors
                .get("top_frayed_tunic"),
            Some(&vec!["blue".to_owned(), "silver".to_owned()])
        );
    }

    #[test]
    fn exact_clothing_identity_distinguishes_stacks_variants_and_top_sources() {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice())
            .expect("demo slice builds");
        let config = SliceAuthorityConfig::default();
        let actor_id = config.player_actor_id.clone();
        let container = format!("{actor_id}:field-pack");
        let marked_variant = 62_000_244;
        let marked_stack = push_clothing_row(
            &mut state,
            &container,
            7_101,
            marked_variant,
            "Marked Plate Vest",
        );
        let variant_zero_stack = push_clothing_row(&mut state, &container, 7_101, 0, "Plate Vest");
        let creator_stack =
            push_clothing_row(&mut state, &container, 7_303, 0, "top_plated_rig_vest");
        {
            let actor = state.actors.get_mut(&actor_id).expect("demo player");
            actor.worn.clear();
            actor.equipped_clothing.clear();
            actor
                .worn_colors
                .insert("top_plated_rig_vest".to_owned(), vec!["#112233".to_owned()]);
        }

        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_101,
                true,
                None,
                Some(&marked_stack.to_string()),
                Some(marked_variant),
            )
            .expect("marked loot stack equips");
        let marked_worn = state.actors[&actor_id].worn.clone();
        let marked_hash = state.stable_state_hash_hex();
        assert_eq!(
            state.inventory_clothing_state_exact(&container, 7_101, marked_stack, marked_variant,),
            (true, vec!["#112233".to_owned()])
        );
        assert_eq!(
            state.inventory_clothing_state_exact(&container, 7_101, variant_zero_stack, 0,),
            (false, vec!["#112233".to_owned()])
        );

        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_101,
                true,
                None,
                Some(&variant_zero_stack.to_string()),
                Some(0),
            )
            .expect("variant-zero loot stack equips");
        assert_eq!(state.actors[&actor_id].worn, marked_worn);
        assert_eq!(
            state.actors[&actor_id].equipped_clothing,
            vec![AuthorityEquippedClothingInstance {
                container: container.clone(),
                stack_id: variant_zero_stack,
                item_id: 7_101,
                variant_id: 0,
            }]
        );
        assert_ne!(
            state.stable_state_hash_hex(),
            marked_hash,
            "physical clothing identity changes the stable hash even when presentation is equal"
        );
        let variant_zero_hash = state.stable_state_hash_hex();
        let checkpoint = state.export_checkpoint();
        let mut restored = state.clone();
        restored
            .restore_checkpoint(checkpoint)
            .expect("exact clothing state restores");
        assert_eq!(restored.stable_state_hash_hex(), variant_zero_hash);
        assert_eq!(
            restored.actors[&actor_id].equipped_clothing,
            state.actors[&actor_id].equipped_clothing
        );

        for malformed_stack_id in ["", "0", "not-a-stack"] {
            assert_eq!(
                state.apply_set_equipped_clothing_exact(
                    &config,
                    7_101,
                    true,
                    None,
                    Some(malformed_stack_id),
                    Some(0),
                ),
                Err(AuthorityRejectReason::ItemUnavailable)
            );
            assert_eq!(state.stable_state_hash_hex(), variant_zero_hash);
        }

        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_101,
                false,
                None,
                Some(&marked_stack.to_string()),
                Some(marked_variant),
            )
            .expect("unequipping a different exact stack is a safe no-op");
        assert!(
            state
                .inventory_clothing_state_exact(&container, 7_101, variant_zero_stack, 0,)
                .0
        );
        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_101,
                false,
                None,
                Some(&variant_zero_stack.to_string()),
                Some(0),
            )
            .expect("selected exact stack unequips");
        assert!(state.actors[&actor_id].equipped_clothing.is_empty());
        assert!(state.actors[&actor_id].worn.is_empty());

        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_303,
                true,
                None,
                Some(&creator_stack.to_string()),
                Some(0),
            )
            .expect("creator top equips by exact identity");
        assert_eq!(state.actors[&actor_id].equipped_clothing[0].item_id, 7_303);
        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_101,
                true,
                None,
                Some(&marked_stack.to_string()),
                Some(marked_variant),
            )
            .expect("loot top replaces creator top in the shared slot");
        assert_eq!(
            state.actors[&actor_id].equipped_clothing,
            vec![AuthorityEquippedClothingInstance {
                container: container.clone(),
                stack_id: marked_stack,
                item_id: 7_101,
                variant_id: marked_variant,
            }]
        );
        assert_eq!(state.actors[&actor_id].worn, marked_worn);
    }

    #[test]
    fn fixed_starter_clothing_round_trips_by_exact_stack() {
        for (item_id, item_key) in [(9_900_001, "under_bodysuit"), (7_319, "boots_canvas_ankle")] {
            let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice())
                .expect("demo slice builds");
            let config = SliceAuthorityConfig::default();
            let actor_id = config.player_actor_id.clone();
            state.ensure_fixed_player_starter_clothing(&actor_id);
            state.reconcile_actor_clothing(&actor_id);
            let row = state
                .inventory
                .iter()
                .find(|row| {
                    row.container == format!("{actor_id}:field-pack") && row.item_id == item_id
                })
                .cloned()
                .expect("fixed starter clothing row");
            let before = state
                .actor_snapshot(&actor_id)
                .expect("starter actor snapshot");
            assert!(before.worn.iter().any(|piece| piece.item == item_key));

            let stack_id = row.stack_id.to_string();
            state
                .apply_set_equipped_clothing_exact(
                    &config,
                    item_id,
                    false,
                    Some(&row.container),
                    Some(&stack_id),
                    Some(row.variant_id),
                )
                .expect("exact starter stack unequips");
            let removed = state
                .actor_snapshot(&actor_id)
                .expect("unequipped actor snapshot");
            assert!(!removed.worn.iter().any(|piece| piece.item == item_key));
            assert!(!state.actors[&actor_id]
                .equipped_clothing
                .iter()
                .any(|entry| entry.item_id == item_id));
            assert!(
                !state
                    .inventory_clothing_state_exact(
                        &row.container,
                        item_id,
                        row.stack_id,
                        row.variant_id
                    )
                    .0
            );

            for (container, requested_stack) in [
                (row.container.as_str(), row.stack_id + 10_000),
                ("other:field-pack", row.stack_id),
                (actor_id.as_str(), row.stack_id),
            ] {
                let requested_stack = requested_stack.to_string();
                assert_eq!(
                    state.apply_set_equipped_clothing_exact(
                        &config,
                        item_id,
                        true,
                        Some(container),
                        Some(&requested_stack),
                        Some(row.variant_id),
                    ),
                    Err(AuthorityRejectReason::ItemUnavailable),
                    "invalid starter stack/owner/container must reject"
                );
            }

            state
                .apply_set_equipped_clothing_exact(
                    &config,
                    item_id,
                    true,
                    Some(&row.container),
                    Some(&stack_id),
                    Some(row.variant_id),
                )
                .expect("same exact starter stack re-equips");
            let restored = state
                .actor_snapshot(&actor_id)
                .expect("re-equipped actor snapshot");
            assert!(restored.worn.iter().any(|piece| piece.item == item_key));
            assert!(state.actors[&actor_id]
                .equipped_clothing
                .iter()
                .any(|entry| {
                    entry.container == row.container
                        && entry.stack_id == row.stack_id
                        && entry.item_id == item_id
                        && entry.variant_id == row.variant_id
                }));
            assert!(
                state
                    .inventory_clothing_state_exact(
                        &row.container,
                        item_id,
                        row.stack_id,
                        row.variant_id
                    )
                    .0
            );
        }
    }

    #[test]
    fn exact_clothing_identity_includes_container_and_legacy_empty_requires_unique_row() {
        let mut state = SliceAuthorityState::from_snapshot(&crate::authority_test_slice())
            .expect("demo slice builds");
        let config = SliceAuthorityConfig::default();
        let actor_id = config.player_actor_id.clone();
        let container_a = format!("{actor_id}:closet-a");
        let container_b = format!("{actor_id}:closet-b");
        let variant_id = 60_000_105;
        let stack_a = push_clothing_row(
            &mut state,
            &container_a,
            7_201,
            variant_id,
            "Frayed Tunic A",
        );
        let stack_b = push_clothing_row(
            &mut state,
            &container_b,
            7_201,
            variant_id,
            "Frayed Tunic B",
        );
        assert_eq!(stack_a, stack_b, "stack counters are container-scoped");
        {
            let actor = state.actors.get_mut(&actor_id).expect("demo player");
            actor.worn.clear();
            actor.equipped_clothing.clear();
        }

        assert_eq!(
            state.apply_set_equipped_clothing_exact(
                &config,
                7_201,
                true,
                None,
                Some(&stack_a.to_string()),
                Some(variant_id),
            ),
            Err(AuthorityRejectReason::ItemUnavailable),
            "container-less exact selection rejects an ambiguous physical identity"
        );
        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_201,
                true,
                Some(&container_a),
                Some(&stack_a.to_string()),
                Some(variant_id),
            )
            .expect("first container row equips");
        let container_a_hash = state.stable_state_hash_hex();
        assert!(
            state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0
        );
        assert!(
            !state
                .inventory_clothing_state_exact(&container_b, 7_201, stack_b, variant_id)
                .0
        );

        state
            .apply_set_equipped_clothing_exact(
                &config,
                7_201,
                true,
                Some(&container_b),
                Some(&stack_b.to_string()),
                Some(variant_id),
            )
            .expect("second container row equips");
        assert_ne!(
            state.stable_state_hash_hex(),
            container_a_hash,
            "container participates in the exact identity hash"
        );
        assert!(
            !state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0
        );
        assert!(
            state
                .inventory_clothing_state_exact(&container_b, 7_201, stack_b, variant_id)
                .0
        );

        state.actors.get_mut(&actor_id).unwrap().equipped_clothing =
            vec![AuthorityEquippedClothingInstance {
                container: String::new(),
                stack_id: stack_a,
                item_id: 7_201,
                variant_id,
            }];
        assert!(
            !state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0
        );
        assert!(
            !state
                .inventory_clothing_state_exact(&container_b, 7_201, stack_b, variant_id)
                .0
        );
        {
            let unavailable = state
                .inventory
                .iter_mut()
                .find(|row| row.container == container_b)
                .unwrap();
            unavailable.reserved = 1;
            unavailable.available = 0;
        }
        assert!(
            state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0
        );
        assert!(
            !state
                .inventory_clothing_state_exact(&container_b, 7_201, stack_b, variant_id)
                .0,
            "legacy identity projection must not mark an unavailable duplicate equipped"
        );
        {
            let available = state
                .inventory
                .iter_mut()
                .find(|row| row.container == container_b)
                .unwrap();
            available.reserved = 0;
            available.available = 1;
        }
        state.reconcile_actor_clothing(&actor_id);
        assert!(
            state.actors[&actor_id].equipped_clothing.is_empty(),
            "legacy empty container does not guess between duplicate rows"
        );

        state.inventory.retain(|row| row.container != container_b);
        state.actors.get_mut(&actor_id).unwrap().equipped_clothing =
            vec![AuthorityEquippedClothingInstance {
                container: String::new(),
                stack_id: stack_a,
                item_id: 7_201,
                variant_id,
            }];
        assert!(
            state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0,
            "bridge projection resolves a unique legacy empty-container identity without mutating import state"
        );
        state.reconcile_actor_clothing(&actor_id);
        assert_eq!(
            state.actors[&actor_id].equipped_clothing,
            vec![AuthorityEquippedClothingInstance {
                container: container_a.clone(),
                stack_id: stack_a,
                item_id: 7_201,
                variant_id,
            }],
            "legacy empty container resolves only after one owned row remains"
        );
        state
            .actors
            .get_mut(&actor_id)
            .unwrap()
            .equipped_clothing
            .clear();
        {
            let unavailable = state
                .inventory
                .iter_mut()
                .find(|row| row.container == container_a)
                .unwrap();
            unavailable.reserved = 1;
            unavailable.available = 0;
        }
        assert!(
            !state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0,
            "legacy worn-only projection must not mark an unavailable row equipped"
        );
        {
            let available = state
                .inventory
                .iter_mut()
                .find(|row| row.container == container_a)
                .unwrap();
            available.reserved = 0;
            available.available = 1;
        }
        assert!(
            state
                .inventory_clothing_state_exact(&container_a, 7_201, stack_a, variant_id)
                .0,
            "bridge projection preserves a unique legacy worn-only row without mutating import state"
        );
    }

    #[test]
    fn creator_clothing_equip_rejects_dead_and_asleep_actors() {
        let (mut state, config) = clothing_test_state();
        state
            .actors
            .get_mut(&config.player_actor_id)
            .unwrap()
            .life_state = AuthorityLifeState::Downed;
        assert_eq!(
            state.apply_set_equipped_clothing(&config, 7_301, true),
            Err(AuthorityRejectReason::ActorNotAlive)
        );
        let actor = state.actors.get_mut(&config.player_actor_id).unwrap();
        actor.life_state = AuthorityLifeState::Alive;
        actor.sleep.remaining_ticks = 1;
        assert_eq!(
            state.apply_set_equipped_clothing(&config, 7_301, true),
            Err(AuthorityRejectReason::ActorAsleep)
        );
    }
}
