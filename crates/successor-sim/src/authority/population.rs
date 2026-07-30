use super::*;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PopulationAuthorityState {
    pub(super) templates: BTreeMap<String, PopulationTemplateState>,
    pub(super) spawn_zones: BTreeMap<String, PopulationSpawnZoneState>,
    pub(super) actor_sources: BTreeMap<String, PopulationActorSourceState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PopulationTemplateState {
    pub(super) id: String,
    pub(super) label_prefix: String,
    pub(super) labels: Vec<String>,
    pub(super) role: String,
    pub(super) faction_id: Option<String>,
    pub(super) social_group: Option<String>,
    pub(super) pvp_status: Option<String>,
    pub(super) player_organization_id: Option<String>,
    pub(super) player_organization_tag: Option<String>,
    pub(super) profession_ids: Vec<String>,
    pub(super) skill_box_ids: Vec<String>,
    pub(super) credits: Option<u64>,
    pub(super) capabilities: Vec<String>,
    pub(super) career_goal_id: Option<String>,
    pub(super) sprite: String,
    pub(super) pose_set: String,
    pub(super) direction: String,
    pub(super) scale: u32,
    pub(super) vitals: Option<AuthorityVitals>,
    pub(super) max_vitals: Option<AuthorityVitals>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PopulationSpawnZoneState {
    pub(super) id: String,
    pub(super) actor_id_prefix: String,
    pub(super) template_id: String,
    pub(super) area_id: String,
    pub(super) candidate_cells: Vec<AuthorityCell>,
    pub(super) initial_count: u16,
    pub(super) max_alive: u16,
    pub(super) spawn_every_ticks: u64,
    pub(super) batch_min: u16,
    pub(super) batch_max: u16,
    pub(super) seed: u32,
    pub(super) total_spawned: u32,
    pub(super) next_spawn_tick: u64,
    pub(super) activation_radius_milli: Option<i32>,
    pub(super) leash_radius_milli: i32,
    pub(super) leash_release_ticks: u64,
    /// Despawn threshold: a zone only releases its alive actors once no
    /// player has been within this radius for `linger_ticks`. Defaults to
    /// the leash radius (legacy behaviour); fixtures raise it (96 for rogue
    /// zones, 40 for the sparring zone) so a short leash-out keeps actors
    /// alive and they leash back to post off-screen.
    pub(super) deactivation_radius_milli: i32,
    /// Ticks a zone lingers active after the last player leaves the
    /// deactivation radius before releasing its alive actors. Defaults to
    /// `leash_release_ticks` (legacy behaviour).
    pub(super) linger_ticks: u64,
    pub(super) activation_check_every_ticks: u64,
    /// Set only after every initial encounter actor has entered a non-alive
    /// combat lifecycle. Never infer this from deactivation pruning.
    #[serde(default)]
    pub(super) cleared: bool,
    #[serde(default)]
    pub(super) defeated_slots: BTreeSet<u16>,
    pub(super) active: bool,
    pub(super) last_player_within_leash_tick: u64,
    pub(super) last_player_within_deactivation_tick: u64,
    pub(super) next_activation_check_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PopulationActorSourceState {
    pub(super) template_id: String,
    pub(super) spawn_zone_id: String,
}

impl PopulationAuthorityState {
    pub(super) fn from_snapshot(
        snapshot: &SliceSnapshot,
        areas: &BTreeMap<String, AreaAuthorityState>,
    ) -> Result<Self, SliceAuthorityBuildError> {
        let mut templates = BTreeMap::new();
        for template in &snapshot.population_templates {
            let id = template.id.trim();
            if id.is_empty() {
                return Err(SliceAuthorityBuildError::InvalidPopulationConfig(
                    "population template id cannot be empty".to_owned(),
                ));
            }
            if template.role.trim().is_empty() {
                return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                    "population template {id} role cannot be empty"
                )));
            }
            let career_goal_id = parse_authority_career_goal_id(template.career_goal_id.as_deref())
                .map_err(|career_goal_id| {
                    SliceAuthorityBuildError::UnknownPopulationCareerGoalId {
                        template_id: id.to_owned(),
                        career_goal_id,
                    }
                })?;
            let state = PopulationTemplateState {
                id: id.to_owned(),
                label_prefix: template.label_prefix.clone(),
                labels: template.labels.clone(),
                role: template.role.clone(),
                faction_id: template.faction_id.clone(),
                social_group: template.social_group.clone(),
                pvp_status: template.pvp_status.clone(),
                player_organization_id: template.player_organization_id.clone(),
                player_organization_tag: template.player_organization_tag.clone(),
                profession_ids: template.profession_ids.clone(),
                skill_box_ids: template.skill_box_ids.clone(),
                credits: template.credits,
                capabilities: template.capabilities.clone(),
                career_goal_id,
                sprite: template.sprite.clone(),
                pose_set: template.pose_set.clone(),
                direction: template.direction.clone(),
                scale: template.scale.unwrap_or(1).clamp(1, 6),
                vitals: template.vitals.map(authority_vitals_from_actor_snapshot),
                max_vitals: template
                    .max_vitals
                    .map(authority_vitals_from_actor_snapshot),
            };
            if templates.insert(state.id.clone(), state).is_some() {
                return Err(SliceAuthorityBuildError::DuplicatePopulationTemplate(
                    id.to_owned(),
                ));
            }
        }

        let mut spawn_zones = BTreeMap::new();
        for zone in &snapshot.spawn_zones {
            let id = zone.id.trim();
            if id.is_empty() {
                return Err(SliceAuthorityBuildError::InvalidPopulationConfig(
                    "spawn zone id cannot be empty".to_owned(),
                ));
            }
            if !templates.contains_key(&zone.template_id) {
                return Err(SliceAuthorityBuildError::UnknownPopulationTemplate {
                    spawn_zone_id: id.to_owned(),
                    template_id: zone.template_id.clone(),
                });
            }
            let area = areas.get(&zone.area_id).ok_or_else(|| {
                SliceAuthorityBuildError::UnknownSpawnZoneArea {
                    spawn_zone_id: id.to_owned(),
                    area_id: zone.area_id.clone(),
                }
            })?;
            let mut candidate_cells = Vec::new();
            for cell in &zone.candidate_cells {
                let cell = AuthorityCell::from_snapshot(cell, "spawnZone.candidateCells")?;
                if !area.contains(cell) {
                    return Err(SliceAuthorityBuildError::SpawnZoneCellOutOfBounds {
                        spawn_zone_id: id.to_owned(),
                        area_id: zone.area_id.clone(),
                        x: cell.x,
                        y: cell.y,
                    });
                }
                candidate_cells.push(cell);
            }
            if zone.max_alive > 0 && candidate_cells.is_empty() {
                return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                    "spawn zone {id} needs candidateCells when maxAlive is positive"
                )));
            }
            let batch_min = if zone.max_alive == 0 {
                0
            } else {
                zone.batch_min.max(1)
            };
            let batch_max = if zone.max_alive == 0 {
                0
            } else {
                zone.batch_max.max(batch_min)
            };
            let template_role = templates
                .get(&zone.template_id)
                .map(|template| template.role.as_str())
                .unwrap_or_default();
            let is_humanoid_encounter = is_skirmisher_role(template_role);
            let initial_count = if is_humanoid_encounter {
                2
            } else {
                zone.initial_count
            };
            let max_alive = if is_humanoid_encounter {
                2
            } else {
                zone.max_alive.max(initial_count)
            };
            let spawn_every_ticks = zone
                .spawn_every_seconds
                .saturating_mul(u64::from(snapshot.tick_rate_hz));
            let activation_radius_milli = match zone.activation {
                Some(activation) => Some(population_radius_cells_to_milli(
                    id,
                    "activation.radiusCells",
                    activation.radius_cells,
                )?),
                None => None,
            };
            let leash_radius_milli = match (zone.activation, activation_radius_milli) {
                (Some(activation), Some(radius)) => {
                    let leash_radius = activation
                        .leash_radius_cells
                        .map(|cells| {
                            population_radius_cells_to_milli(
                                id,
                                "activation.leashRadiusCells",
                                cells,
                            )
                        })
                        .transpose()?
                        .unwrap_or(radius.saturating_mul(2));
                    if leash_radius < radius {
                        return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                            "spawn zone {id} activation leashRadiusCells must be >= radiusCells"
                        )));
                    }
                    leash_radius
                }
                _ => 0,
            };
            let leash_release_ticks = zone
                .activation
                .and_then(|activation| activation.release_ticks)
                .unwrap_or_else(|| u64::from(snapshot.tick_rate_hz.max(1)).saturating_mul(8))
                .max(1);
            // Deactivation radius: the despawn threshold. Defaults to the
            // leash radius so legacy fixtures keep their old behaviour; a
            // fixture may raise it so brief leash-outs keep actors alive.
            let deactivation_radius_milli = match (zone.activation, activation_radius_milli) {
                (Some(activation), _) => activation
                    .deactivation_radius_cells
                    .map(|cells| {
                        population_radius_cells_to_milli(
                            id,
                            "activation.deactivationRadiusCells",
                            cells,
                        )
                    })
                    .transpose()?
                    .unwrap_or(leash_radius_milli),
                _ => 0,
            };
            if deactivation_radius_milli < leash_radius_milli {
                return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                    "spawn zone {id} activation deactivationRadiusCells must be >= leashRadiusCells"
                )));
            }
            // Linger: how long a zone stays active after the last player
            // leaves the deactivation radius. Defaults to release_ticks.
            let linger_ticks = zone
                .activation
                .and_then(|activation| activation.linger_ticks)
                .unwrap_or(leash_release_ticks)
                .max(1);
            let activation_check_every_ticks = zone
                .activation
                .map(|activation| activation.check_every_ticks_or_default())
                .unwrap_or(0)
                .max(u64::from(activation_radius_milli.is_some()));
            let active = activation_radius_milli.is_none();
            let state = PopulationSpawnZoneState {
                id: id.to_owned(),
                actor_id_prefix: zone.actor_id_prefix.clone(),
                template_id: zone.template_id.clone(),
                area_id: zone.area_id.clone(),
                candidate_cells,
                initial_count,
                max_alive,
                spawn_every_ticks,
                batch_min,
                batch_max,
                seed: zone.seed,
                total_spawned: 0,
                next_spawn_tick: if spawn_every_ticks == 0 {
                    0
                } else {
                    snapshot.tick.saturating_add(spawn_every_ticks)
                },
                activation_radius_milli,
                leash_radius_milli,
                leash_release_ticks,
                deactivation_radius_milli,
                linger_ticks,
                activation_check_every_ticks,
                cleared: false,
                defeated_slots: BTreeSet::new(),
                active,
                last_player_within_leash_tick: if active { snapshot.tick } else { 0 },
                last_player_within_deactivation_tick: if active { snapshot.tick } else { 0 },
                next_activation_check_tick: snapshot.tick,
            };
            if spawn_zones.insert(state.id.clone(), state).is_some() {
                return Err(SliceAuthorityBuildError::DuplicateSpawnZone(id.to_owned()));
            }
        }

        Ok(Self {
            templates,
            spawn_zones,
            actor_sources: BTreeMap::new(),
        })
    }
}

impl SliceAuthorityState {
    pub(super) fn seed_initial_population(&mut self) -> Result<(), SliceAuthorityBuildError> {
        let zone_ids = self
            .runtime
            .durable
            .population
            .spawn_zones
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for zone_id in zone_ids {
            let (initial_count, active) = self
                .runtime
                .durable
                .population
                .spawn_zones
                .get(&zone_id)
                .map(|zone| (zone.initial_count, zone.active))
                .unwrap_or((0, true));
            if !active {
                continue;
            }
            for _ in 0..initial_count {
                if !self.spawn_population_actor(&zone_id)? {
                    return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                        "spawn zone {zone_id} could not place initial population"
                    )));
                }
            }
        }
        Ok(())
    }

    fn mark_population_defeated_slots(&mut self) {
        let defeated: Vec<(String, u16)> = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.life_state != AuthorityLifeState::Alive
                    && self
                        .runtime
                        .durable
                        .population
                        .actor_sources
                        .contains_key(&actor.id)
                    && is_skirmisher_role(&actor.role)
            })
            .filter_map(|actor| {
                let zone_id = actor.spawn_zone_id.clone()?;
                let slot = actor.id.rsplit('-').next()?.parse::<u16>().ok()?;
                Some((zone_id, slot))
            })
            .collect();
        for (zone_id, slot) in defeated {
            if let Some(zone) = self
                .runtime
                .durable
                .population
                .spawn_zones
                .get_mut(&zone_id)
            {
                zone.defeated_slots.insert(slot);
                if zone.initial_count > 0
                    && zone.defeated_slots.len() >= usize::from(zone.initial_count)
                {
                    zone.cleared = true;
                }
            }
        }
    }

    pub(super) fn tick_population_activation(&mut self) {
        self.mark_population_defeated_slots();
        let due_zone_ids = self
            .runtime
            .durable
            .population
            .spawn_zones
            .values()
            .filter(|zone| {
                zone.activation_radius_milli.is_some()
                    && self.runtime.durable.tick >= zone.next_activation_check_tick
            })
            .map(|zone| zone.id.clone())
            .collect::<Vec<_>>();

        let mut zones_to_spawn = Vec::new();
        let mut zones_to_release = Vec::new();
        for zone_id in due_zone_ids {
            let Some(zone) = self
                .runtime
                .durable
                .population
                .spawn_zones
                .get(&zone_id)
                .cloned()
            else {
                continue;
            };
            let Some(activation_radius_milli) = zone.activation_radius_milli else {
                continue;
            };
            let player_within_activation =
                self.human_player_within_spawn_zone_radius(&zone, activation_radius_milli);
            let player_within_leash =
                self.human_player_within_spawn_zone_radius(&zone, zone.leash_radius_milli);
            let player_within_deactivation =
                self.human_player_within_spawn_zone_radius(&zone, zone.deactivation_radius_milli);

            let mut spawn_on_activate = false;
            let mut release_on_dormant = false;
            if let Some(zone) = self
                .runtime
                .durable
                .population
                .spawn_zones
                .get_mut(&zone_id)
            {
                zone.next_activation_check_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(zone.activation_check_every_ticks.max(1));
                if zone.active {
                    if player_within_leash {
                        zone.last_player_within_leash_tick = self.runtime.durable.tick;
                    }
                    // Hysteresis: the zone only goes dormant once no player
                    // has been within the (wider) deactivation radius for the
                    // full linger window. A brief leash-out therefore keeps
                    // actors alive — they leash back to post — and despawn
                    // only happens well off-screen (deactivation >> view).
                    if player_within_deactivation {
                        zone.last_player_within_deactivation_tick = self.runtime.durable.tick;
                    } else if self.runtime.durable.tick
                        >= zone
                            .last_player_within_deactivation_tick
                            .saturating_add(zone.linger_ticks)
                    {
                        zone.active = false;
                        release_on_dormant = true;
                    }
                } else if player_within_activation {
                    zone.active = true;
                    zone.last_player_within_leash_tick = self.runtime.durable.tick;
                    zone.last_player_within_deactivation_tick = self.runtime.durable.tick;
                    spawn_on_activate = true;
                }
            }
            if spawn_on_activate {
                zones_to_spawn.push(zone_id.clone());
            }
            if release_on_dormant {
                zones_to_release.push(zone_id);
            }
        }

        for zone_id in zones_to_release {
            self.release_population_zone_alive_actors(&zone_id);
        }
        for zone_id in zones_to_spawn {
            let spawn_count = self
                .runtime
                .durable
                .population
                .spawn_zones
                .get(&zone_id)
                .filter(|zone| !self.population_zone_permanently_cleared(zone))
                .map(|zone| zone.initial_count.max(1).min(zone.max_alive))
                .unwrap_or(0);
            for _ in 0..spawn_count {
                if !self.spawn_population_actor(&zone_id).unwrap_or(false) {
                    break;
                }
            }
        }
    }

    pub(super) fn tick_population_spawns(&mut self) {
        let due_zone_ids = self
            .runtime
            .durable
            .population
            .spawn_zones
            .values()
            .filter(|zone| {
                zone.active
                    && zone.spawn_every_ticks > 0
                    && zone.batch_max > 0
                    && !self.population_zone_permanently_cleared(zone)
                    && self.population_spawn_zone_alive_count(&zone.id) < zone.max_alive
                    && self.runtime.durable.tick >= zone.next_spawn_tick
            })
            .map(|zone| zone.id.clone())
            .collect::<Vec<_>>();

        for zone_id in due_zone_ids {
            let spawn_count = {
                let remaining = self.population_spawn_zone_alive_capacity_remaining(&zone_id);
                let Some(zone) = self
                    .runtime
                    .durable
                    .population
                    .spawn_zones
                    .get_mut(&zone_id)
                else {
                    continue;
                };
                zone.next_spawn_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(zone.spawn_every_ticks);
                let batch = deterministic_population_batch(
                    zone.seed,
                    self.runtime.durable.tick,
                    zone.total_spawned,
                    zone.batch_min,
                    zone.batch_max,
                );
                remaining.min(batch)
            };
            for _ in 0..spawn_count {
                if !self.spawn_population_actor(&zone_id).unwrap_or(false) {
                    break;
                }
            }
        }
    }

    pub(super) fn population_actor_has_alive_capacity(&self, actor: &ActorAuthorityState) -> bool {
        let Some(zone_id) = actor.spawn_zone_id.as_deref() else {
            return true;
        };
        self.population_spawn_zone_alive_capacity_remaining(zone_id) > 0
    }

    fn human_player_within_spawn_zone_radius(
        &self,
        zone: &PopulationSpawnZoneState,
        radius_milli: i32,
    ) -> bool {
        let Some(center) = population_spawn_zone_center(zone) else {
            return false;
        };
        self.runtime.durable.actors.values().any(|actor| {
            actor.area_id == zone.area_id
                && actor.life_state == AuthorityLifeState::Alive
                && is_human_player_actor(actor)
                && position_within_radius_milli(actor.position, center, radius_milli)
        })
    }

    fn release_population_zone_alive_actors(&mut self, zone_id: &str) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.spawn_zone_id.as_deref() == Some(zone_id)
                    && self
                        .runtime
                        .durable
                        .population
                        .actor_sources
                        .contains_key(&actor.id)
                    && actor.life_state == AuthorityLifeState::Alive
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            self.prune_population_actor(&actor_id);
        }
    }

    pub(super) fn prune_expired_population_actors(&mut self) {
        self.mark_population_defeated_slots();
        let actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.spawn_zone_id.is_some()
                    && self
                        .runtime
                        .durable
                        .population
                        .actor_sources
                        .contains_key(&actor.id)
                    && actor.life_state == AuthorityLifeState::Respawning
                    && actor.respawn_tick > 0
                    && self.runtime.durable.tick >= actor.respawn_tick
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();

        for actor_id in actor_ids {
            self.prune_population_actor(&actor_id);
        }
    }

    fn prune_population_actor(&mut self, actor_id: &str) {
        if self
            .runtime
            .durable
            .population
            .actor_sources
            .remove(actor_id)
            .is_none()
        {
            return;
        }

        self.runtime
            .current_removed_actor_ids
            .push(actor_id.to_owned());
        self.runtime.durable.actors.remove(actor_id);
        self.release_population_actor_inventory(actor_id);
    }

    fn release_population_actor_inventory(&mut self, actor_id: &str) {
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
        let corpse_container = format!("corpse:{actor_id}");
        self.runtime.durable.inventory.retain(|row| {
            !actor_owns_inventory_container(actor_id, &row.container)
                && row.container != corpse_container
        });
    }

    fn population_spawn_zone_alive_capacity_remaining(&self, zone_id: &str) -> u16 {
        let Some(zone) = self.runtime.durable.population.spawn_zones.get(zone_id) else {
            return u16::MAX;
        };
        zone.max_alive
            .saturating_sub(self.population_spawn_zone_alive_count(zone_id))
    }

    fn population_spawn_zone_alive_count(&self, zone_id: &str) -> u16 {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.spawn_zone_id.as_deref() == Some(zone_id)
                    && self
                        .runtime
                        .durable
                        .population
                        .actor_sources
                        .contains_key(&actor.id)
            })
            .count()
            .try_into()
            .unwrap_or(u16::MAX)
    }
    fn population_zone_permanently_cleared(&self, zone: &PopulationSpawnZoneState) -> bool {
        zone.cleared
            && self
                .runtime
                .durable
                .population
                .templates
                .get(&zone.template_id)
                .is_some_and(|template| is_skirmisher_role(&template.role))
    }

    fn spawn_population_actor(&mut self, zone_id: &str) -> Result<bool, SliceAuthorityBuildError> {
        let Some(zone) = self
            .runtime
            .durable
            .population
            .spawn_zones
            .get(zone_id)
            .cloned()
        else {
            return Ok(false);
        };
        if self.population_spawn_zone_alive_capacity_remaining(zone_id) == 0 {
            return Ok(false);
        }
        let Some(template) = self
            .runtime
            .durable
            .population
            .templates
            .get(&zone.template_id)
            .cloned()
        else {
            return Err(SliceAuthorityBuildError::UnknownPopulationTemplate {
                spawn_zone_id: zone.id,
                template_id: zone.template_id,
            });
        };

        let is_humanoid = is_skirmisher_role(&template.role);
        let ordinal = if is_humanoid && zone.total_spawned >= u32::from(zone.initial_count) {
            let Some(slot) = (1..=zone.initial_count).find(|slot| {
                !zone.defeated_slots.contains(slot)
                    && !self
                        .runtime
                        .durable
                        .actors
                        .contains_key(&format!("{}-{slot:02}", zone.actor_id_prefix))
            }) else {
                return Ok(false);
            };
            u32::from(slot)
        } else {
            zone.total_spawned.saturating_add(1)
        };
        let Some(cell) = self.population_spawn_cell(&zone, ordinal) else {
            return Ok(false);
        };
        let actor_id = format!("{}-{ordinal:02}", zone.actor_id_prefix);
        if self.runtime.durable.actors.contains_key(&actor_id) {
            return Err(SliceAuthorityBuildError::DuplicateActor(actor_id));
        }
        let effective_stats = derive_effective_actor_stats_for_role(&template.role);
        let max_vitals = template
            .max_vitals
            .or(template.vitals)
            .unwrap_or(effective_stats.max_vitals);
        let vitals = template
            .vitals
            .unwrap_or(effective_stats.spawn_vitals)
            .clamp_to_max(max_vitals);
        let mut professions = ActorProfessionState::from_profession_ids(&template.profession_ids)
            .map_err(|profession_id| {
            SliceAuthorityBuildError::UnknownPopulationProfessionId {
                template_id: template.id.clone(),
                profession_id,
            }
        })?;
        professions.set_credits(template.credits);
        professions
            .grant_skill_box_ids(&template.skill_box_ids)
            .map_err(
                |profession_id| SliceAuthorityBuildError::UnknownPopulationProfessionId {
                    template_id: template.id.clone(),
                    profession_id,
                },
            )?;
        let capabilities =
            ActorCapabilityState::from_professions_and_grants(&professions, &template.capabilities);
        let patrol_route = procedural_patrol_route(self, &zone, cell);
        let patrol_route_index = route_index_after_cell(&patrol_route, cell);
        let mut actor = ActorAuthorityState {
            id: actor_id.clone(),
            entity: format!("{}:{actor_id}", template.role),
            // display identity is owned by refresh_actor_presentation below (generated
            // personal/species name + descriptor); NEVER a prefix+ordinal label.
            label: String::new(),
            display_name: String::new(),
            descriptor: String::new(),
            link_dead: false,
            link_dead_expires_tick: 0,
            appearance: AuthorityActorAppearanceSnapshot::default(),
            worn: Vec::new(),
            equipped_clothing: Vec::new(),
            worn_colors: BTreeMap::new(),
            sprite: template.sprite.clone(),
            template_id: Some(template.id.clone()),
            spawn_zone_id: Some(zone.id.clone()),
            role: template.role.clone(),
            faction: ActorFactionState {
                faction_id: crate::faction::normalize_optional_key(template.faction_id.as_deref()),
                social_group: crate::faction::normalize_optional_key(
                    template.social_group.as_deref(),
                ),
                pvp_status: crate::faction::FactionPvpStatus::from_optional(
                    template.pvp_status.as_deref(),
                ),
            },
            player_organization_id: crate::faction::normalize_optional_key(
                template.player_organization_id.as_deref(),
            ),
            player_organization_tag: template
                .player_organization_tag
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned),
            area_id: zone.area_id.clone(),
            cell,
            position: AuthorityPosition::from_cell(cell),
            direction: template.direction.clone(),
            scale: template.scale,
            home_area_id: zone.area_id.clone(),
            home_cell: cell,
            home_direction: template.direction.clone(),
            home_route: Vec::new(),
            life_state: AuthorityLifeState::Alive,
            lifecycle_seq: 1,
            posture: AuthorityActorPosture::Standing,
            posture_until_tick: 0,
            vitals,
            max_vitals,
            effective_stats,
            professions,
            capabilities,
            capability_grants: template.capabilities.clone(),
            career_goal_id: template.career_goal_id.clone(),
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
            ai: ai_for_actor(&actor_id, &template.role),
            next_fire_tick: 0,
            weapon_recoil_heat_milli: 0,
            weapon_recoil_last_tick: self.runtime.durable.tick,
            equipped_weapon_id: default_equipped_weapon_id_for_role_and_professions(
                &template.role,
                &template.profession_ids,
            ),
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
            stats: ActorAuthorityStats::default(),
            route: patrol_route,
            route_index: patrol_route_index,
            next_route_tick: self
                .runtime
                .durable
                .tick
                .saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS),
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
        self.runtime.durable.population.actor_sources.insert(
            actor_id.clone(),
            PopulationActorSourceState {
                template_id: template.id,
                spawn_zone_id: zone.id.clone(),
            },
        );
        if let Some(zone) = self
            .runtime
            .durable
            .population
            .spawn_zones
            .get_mut(&zone.id)
        {
            zone.total_spawned = zone.total_spawned.saturating_add(1);
        }
        self.runtime.durable.actors.insert(actor_id.clone(), actor);
        self.ensure_npc_craftsman_field_tools_for_actor(&actor_id);
        Ok(true)
    }

    fn population_spawn_cell(
        &self,
        zone: &PopulationSpawnZoneState,
        ordinal: u32,
    ) -> Option<AuthorityCell> {
        let len = zone.candidate_cells.len();
        if len == 0 {
            return None;
        }
        let start = if ordinal <= u32::from(zone.initial_count) {
            usize::try_from(ordinal.saturating_sub(1)).unwrap_or(0) % len
        } else {
            deterministic_population_index(zone.seed, self.runtime.durable.tick, ordinal, len)
        };
        let mut first_unblocked = None;
        for offset in 0..len {
            let cell = zone.candidate_cells[(start + offset) % len];
            if self
                .runtime
                .durable
                .world
                .blocked_cells
                .contains(&CellKey::new(&zone.area_id, cell.x, cell.y))
            {
                continue;
            }
            first_unblocked.get_or_insert(cell);
            if self.population_spawn_cell_occupied(&zone.area_id, cell) {
                continue;
            }
            return Some(cell);
        }
        first_unblocked
    }

    fn population_spawn_cell_occupied(&self, area_id: &str, cell: AuthorityCell) -> bool {
        self.runtime.durable.actors.values().any(|actor| {
            actor.life_state != AuthorityLifeState::Respawning
                && actor.area_id == area_id
                && actor.cell == cell
        })
    }
}
fn procedural_patrol_route(
    state: &SliceAuthorityState,
    zone: &PopulationSpawnZoneState,
    home: AuthorityCell,
) -> Vec<AuthorityCell> {
    // Procedural actors stay inside their authored candidate-cell fence. Sort
    // and dedupe makes the walk stable across map/source ordering; the seed
    // rotates the start so a pair does not march in lockstep.
    let mut cells = zone
        .candidate_cells
        .iter()
        .copied()
        .filter(|cell| {
            !state
                .runtime
                .durable
                .world
                .blocked_cells
                .contains(&CellKey::new(&zone.area_id, cell.x, cell.y))
        })
        .collect::<Vec<_>>();
    cells.sort_by_key(|cell| (cell.y, cell.x));
    cells.dedup();
    if cells.len() < 2 {
        return Vec::new();
    }
    let offset = deterministic_population_index(
        zone.seed,
        state.runtime.durable.tick,
        zone.total_spawned.saturating_add(1),
        cells.len(),
    );
    cells.rotate_left(offset);
    if let Some(home_index) = cells.iter().position(|cell| *cell == home) {
        cells.rotate_left(home_index);
    }
    cells
}

fn population_radius_cells_to_milli(
    zone_id: &str,
    field: &str,
    cells: u32,
) -> Result<i32, SliceAuthorityBuildError> {
    if cells == 0 {
        return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
            "spawn zone {zone_id} {field} must be positive"
        )));
    }
    let milli = cells.saturating_mul(u32::try_from(MILLI_CELLS_PER_CELL).unwrap_or(1));
    i32::try_from(milli).map_err(|_| {
        SliceAuthorityBuildError::InvalidPopulationConfig(format!(
            "spawn zone {zone_id} {field} is too large"
        ))
    })
}

fn population_spawn_zone_center(zone: &PopulationSpawnZoneState) -> Option<AuthorityPosition> {
    if zone.candidate_cells.is_empty() {
        return None;
    }
    let mut x_sum = 0_i64;
    let mut y_sum = 0_i64;
    for cell in &zone.candidate_cells {
        x_sum = x_sum.saturating_add(
            i64::from(cell.x).saturating_mul(i64::from(MILLI_CELLS_PER_CELL))
                + i64::from(MILLI_CELLS_PER_CELL / 2),
        );
        y_sum = y_sum.saturating_add(
            i64::from(cell.y).saturating_mul(i64::from(MILLI_CELLS_PER_CELL))
                + i64::from(MILLI_CELLS_PER_CELL / 2),
        );
    }
    let len = i64::try_from(zone.candidate_cells.len()).ok()?.max(1);
    Some(AuthorityPosition {
        x: i32::try_from(x_sum / len).ok()?,
        y: i32::try_from(y_sum / len).ok()?,
    })
}

fn position_within_radius_milli(
    position: AuthorityPosition,
    center: AuthorityPosition,
    radius_milli: i32,
) -> bool {
    if radius_milli <= 0 {
        return false;
    }
    let dx = i128::from(position.x) - i128::from(center.x);
    let dy = i128::from(position.y) - i128::from(center.y);
    let radius = i128::from(radius_milli);
    dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)) <= radius.saturating_mul(radius)
}

impl PopulationAuthorityState {
    pub(super) fn write_stable_hash(&self, w: &mut StateWriter) {
        w.write_u32(
            u32::try_from(self.templates.len()).expect("population template count fits u32"),
        );
        for template in self.templates.values() {
            write_string(w, &template.id);
            write_string(w, &template.label_prefix);
            write_string(w, &template.role);
            write_optional_string(w, template.faction_id.as_deref());
            write_optional_string(w, template.social_group.as_deref());
            write_optional_string(w, template.pvp_status.as_deref());
            write_optional_string(w, template.player_organization_id.as_deref());
            write_optional_string(w, template.player_organization_tag.as_deref());
            write_string(w, &template.sprite);
            write_string(w, &template.pose_set);
            write_string(w, &template.direction);
            w.write_u32(template.scale)
                .write_u32(u32::try_from(template.labels.len()).expect("label count fits u32"));
            for label in &template.labels {
                write_string(w, label);
            }
        }
        w.write_u32(u32::try_from(self.spawn_zones.len()).expect("spawn zone count fits u32"));
        for zone in self.spawn_zones.values() {
            write_string(w, &zone.id);
            write_string(w, &zone.actor_id_prefix);
            write_string(w, &zone.template_id);
            write_string(w, &zone.area_id);
            w.write_u32(u32::from(zone.initial_count))
                .write_u32(u32::from(zone.max_alive))
                .write_tick(zone.spawn_every_ticks)
                .write_u32(u32::from(zone.batch_min))
                .write_u32(u32::from(zone.batch_max))
                .write_u32(zone.seed)
                .write_u32(zone.total_spawned)
                .write_tick(zone.next_spawn_tick)
                .write_u32(
                    u32::try_from(zone.candidate_cells.len())
                        .expect("candidate cell count fits u32"),
                );
            for cell in &zone.candidate_cells {
                w.write_i64(i64::from(cell.x)).write_i64(i64::from(cell.y));
            }
            if zone.cleared || !zone.defeated_slots.is_empty() {
                write_string(w, "$population-zone-defeat-v1");
                w.write_bool(zone.cleared).write_u32(
                    u32::try_from(zone.defeated_slots.len()).expect("defeated slot count fits u32"),
                );
                for slot in &zone.defeated_slots {
                    w.write_u32(u32::from(*slot));
                }
            }
        }
        let activation_zones = self
            .spawn_zones
            .values()
            .filter(|zone| zone.activation_radius_milli.is_some())
            .collect::<Vec<_>>();
        if !activation_zones.is_empty() {
            write_string(w, "$population-zone-activation-v1");
            w.write_u32(
                u32::try_from(activation_zones.len()).expect("activation zone count fits u32"),
            );
            for zone in activation_zones {
                write_string(w, &zone.id);
                w.write_i64(i64::from(zone.activation_radius_milli.unwrap_or(0)))
                    .write_i64(i64::from(zone.leash_radius_milli))
                    .write_tick(zone.leash_release_ticks)
                    .write_i64(i64::from(zone.deactivation_radius_milli))
                    .write_tick(zone.linger_ticks)
                    .write_tick(zone.activation_check_every_ticks)
                    .write_u32(u32::from(zone.active))
                    .write_tick(zone.last_player_within_leash_tick)
                    .write_tick(zone.last_player_within_deactivation_tick)
                    .write_tick(zone.next_activation_check_tick);
            }
        }
        w.write_u32(
            u32::try_from(self.actor_sources.len()).expect("population source count fits u32"),
        );
        for (actor_id, source) in &self.actor_sources {
            write_string(w, actor_id);
            write_string(w, &source.template_id);
            write_string(w, &source.spawn_zone_id);
        }
    }
}

pub(super) fn deterministic_population_batch(
    seed: u32,
    tick: u64,
    total_spawned: u32,
    batch_min: u16,
    batch_max: u16,
) -> u16 {
    if batch_max <= batch_min {
        return batch_min;
    }
    let span = u32::from(batch_max - batch_min) + 1;
    batch_min + u16::try_from(mix_population_seed(seed, tick, total_spawned) % span).unwrap_or(0)
}

pub(super) fn deterministic_population_index(
    seed: u32,
    tick: u64,
    ordinal: u32,
    len: usize,
) -> usize {
    if len == 0 {
        return 0;
    }
    usize::try_from(mix_population_seed(seed, tick, ordinal)).unwrap_or(0) % len
}

pub(super) fn mix_population_seed(seed: u32, tick: u64, ordinal: u32) -> u32 {
    let mut value = u64::from(seed)
        ^ tick.rotate_left(17)
        ^ (u64::from(ordinal).wrapping_mul(0x9e37_79b9_7f4a_7c15));
    value ^= value >> 33;
    value = value.wrapping_mul(0xff51_afd7_ed55_8ccd);
    value ^= value >> 33;
    value = value.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    value ^= value >> 33;
    value as u32
}
