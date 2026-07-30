//! W2 TILES+PLANT and W3 GROWTH+WATER (§A.2-A.3, §B.2-B.3, §C.1-C.4). Tiles are a
//! sparse substrate on the parcel (only tilled/cropped cells exist); crops cache
//! the AgronomicProfile at plant and accrue growth CLOSED-FORM, lazily settled on
//! access (T7 doctrine — the extractor's `materialized_*` pattern). The hot path
//! reads only the cached profile: zero genome-registry access.
//!
//! SEED->SOIL BOUNDARY (§A.4): `project_agronomic_for_seed` is the ONE call into
//! the contract. It resolves the genome handle against BioECore's CropGenomeRegistry
//! and projects it (`project_agronomic`). Unknown / unregistered handles FAIL CLOSED
//! with `GenomeUnavailable` — no debug default profile, no phantom crop traits.
//! The cached profile shape remains byte-identical §0.3.
use super::*;

impl SliceAuthorityState {
    // ── SEED->SOIL BOUNDARY (§A.4) ──────────────────────────────────────────────
    /// Resolve the AgronomicProfile for a planted seed. Fail-closed: the handle must
    /// already be interned under the seed species. No debug/default profile path.
    pub(super) fn project_agronomic_for_seed(
        &self,
        seed_item_id: u32,
        variant_id: u32,
    ) -> Result<AgronomicProfile, AuthorityRejectReason> {
        self.runtime
            .durable
            .crop_genomes
            .resolve(seed_item_id, variant_id)
            .map(project_agronomic)
            .ok_or(AuthorityRejectReason::GenomeUnavailable)
    }

    // ── W2: TILL / PLANT / CLEAR ────────────────────────────────────────────────
    pub(super) fn apply_till_tile(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let now = self.runtime.durable.tick;
        let parcel = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        let key = tile_cell_key(cell);
        if parcel.tiles.get(&key).is_some_and(|tile| tile.tilled) {
            return Err(AuthorityRejectReason::TileAlreadyTilled);
        }
        parcel.tiles.insert(
            key,
            TileAuthorityState {
                cell,
                tilled: true,
                moisture_milli: 0,
                fertilizer: None,
                crop: None,
                last_settle_tick: now,
            },
        );
        Ok(())
    }

    pub(super) fn apply_plant_seed(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let key = tile_cell_key(cell);
        // Tile must be tilled + empty.
        {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            match parcel.tiles.get(&key) {
                Some(tile) if !tile.tilled => return Err(AuthorityRejectReason::TileNotTilled),
                Some(tile) if tile.crop.is_some() => {
                    return Err(AuthorityRejectReason::TileOccupied)
                }
                Some(_) => {}
                None => return Err(AuthorityRejectReason::TileNotTilled),
            }
        }
        // Cold-path: peek the seed's species, project its cached profile, then
        // (multi-tile, §C.7) require every footprint cell tilled+empty BEFORE
        // consuming, so a rejected plant never eats the seed.
        let actor_id = config.player_actor_id.clone();
        let seed_row = self.find_actor_seed_row(&actor_id, container, stack_id, variant_id)?;
        let seed_item_id = self.runtime.durable.inventory[seed_row].item_id;
        // Fail closed before consume: unknown/unregistered genome never plants.
        let profile = self.project_agronomic_for_seed(seed_item_id, variant_id)?;
        if footprint_dims(profile.tile_footprint) != (1, 1) {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            if !footprint_all_tilled_empty(parcel, cell, profile.tile_footprint) {
                return Err(AuthorityRejectReason::TileNotTilled);
            }
        }
        self.consume_inventory_row(seed_row)
            .map_err(|_| AuthorityRejectReason::SeedNotOwned)?;
        let now = self.runtime.durable.tick;
        let parcel = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        if let Some(tile) = parcel.tiles.get_mut(&key) {
            tile.crop = Some(CropAuthorityState {
                seed_item_id,
                seed_variant_id: variant_id,
                planted_tick: now,
                profile,
                accumulated_growth_days_milli: 0,
                drought_days: 0,
                tending_quality_milli: TENDING_START_MILLI,
                harvests_remaining: harvests_for_profile(&profile),
            });
            tile.last_settle_tick = now;
        }
        Ok(())
    }

    pub(super) fn apply_clear_tile(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let now = self.runtime.durable.tick;
        let parcel = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        let key = tile_cell_key(cell);
        match parcel.tiles.get_mut(&key) {
            Some(tile) if tile.tilled => {
                // Scythe: remove any crop, keep the soil tilled + dry (§B.2 -> TilledDry).
                tile.crop = None;
                tile.last_settle_tick = now;
                Ok(())
            }
            _ => Err(AuthorityRejectReason::TileNotTilled),
        }
    }

    // ── W4: FERTILIZE (§B.2/§C.4 — one soil amendment per tilled tile) ───────────
    pub(super) fn apply_fertilize(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let key = tile_cell_key(cell);
        // Tile must be tilled; one kind per tile (reject a second amendment).
        {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            match parcel.tiles.get(&key) {
                Some(tile) if !tile.tilled => return Err(AuthorityRejectReason::TileNotTilled),
                Some(tile) if tile.fertilizer.is_some() => {
                    return Err(AuthorityRejectReason::TileAlreadyFertilized)
                }
                Some(_) => {}
                None => return Err(AuthorityRejectReason::TileNotTilled),
            }
        }
        // Resolve + consume one fertilizer item (exact container/stack/variant).
        let actor_id = config.player_actor_id.clone();
        let fert_row =
            self.find_actor_fertilizer_row(&actor_id, container, stack_id, variant_id)?;
        let item_id = self.runtime.durable.inventory[fert_row].item_id;
        let kind =
            FertilizerKind::from_item_id(item_id).ok_or(AuthorityRejectReason::UnknownItem)?;
        self.consume_inventory_row(fert_row)
            .map_err(|_| AuthorityRejectReason::ItemUnavailable)?;
        // Settle to now first so the boost applies to FUTURE days only (§C.4 anytime).
        self.settle_tile(parcel_id, &key);
        if let Some(tile) = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .and_then(|parcel| parcel.tiles.get_mut(&key))
        {
            tile.fertilizer = Some(FertilizerApplied { kind, variant_id });
        }
        Ok(())
    }

    // ── W5: HARVEST (§B.2/§C.4/§A.4 — the living loop\'s missing link) ────────────
    /// Harvest a MATURE crop: mint produce (6_1xx, quality-encoded) into the bag,
    /// mint offspring seeds via the REAL `mint_harvest_seed` (sterile => none, the
    /// terminator economy live, lineage carried on the genome), and either regrow
    /// (perennial) or clear the tile to bare-tilled. Emits a receipt + prose.
    pub(super) fn apply_harvest_crop(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let key = tile_cell_key(cell);
        // Tile must carry a crop (tilled-but-empty => TileEmpty; untilled => TileNotTilled).
        {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            match parcel.tiles.get(&key) {
                Some(tile) if tile.crop.is_some() => {}
                Some(tile) if tile.tilled => return Err(AuthorityRejectReason::TileEmpty),
                _ => return Err(AuthorityRejectReason::TileNotTilled),
            }
        }
        // Settle to now so maturity + tending reflect the present, THEN read.
        self.settle_tile(parcel_id, &key);
        let (
            seed_item_id,
            seed_variant_id,
            profile,
            tending,
            yield_bonus,
            harvests_remaining,
            mature,
        ) = {
            let tile = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .and_then(|parcel| parcel.tiles.get(&key))
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            let crop = tile.crop.as_ref().ok_or(AuthorityRejectReason::TileEmpty)?;
            let yield_bonus = tile_fertilizer_effect(tile.fertilizer.as_ref()).yield_bonus_milli;
            (
                crop.seed_item_id,
                crop.seed_variant_id,
                crop.profile,
                crop.tending_quality_milli,
                yield_bonus,
                crop.harvests_remaining,
                is_mature(crop.accumulated_growth_days_milli, &crop.profile),
            )
        };
        if !mature {
            return Err(AuthorityRejectReason::CropNotMature);
        }
        // ── PRODUCE (§C.4): qty scaled by fertilizer-yield; quality capped by the
        // genome potential, realized by tending. ──
        let produce_qty = u32::try_from(
            u64::from(profile.yield_base)
                .saturating_mul(u64::from(MILLI).saturating_add(u64::from(yield_bonus)))
                / u64::from(MILLI),
        )
        .unwrap_or(u32::MAX)
        .max(1);
        let produce_quality = produce_quality_milli(profile.quality_potential_milli, tending);
        let produce_item_id = produce_item_id_for_species(seed_item_id);
        let produce_variant = encode_produce_variant(produce_quality);
        let produce_name = inventory_item_name(produce_item_id).unwrap_or("Produce");
        let actor_id = config.player_actor_id.clone();
        self.add_actor_inventory_stack(
            &actor_id,
            produce_item_id,
            produce_variant,
            produce_name,
            produce_qty,
            PRODUCE_STACK_CAP,
            "harvest-bag",
        );
        // ── OFFSPRING SEEDS (§A.4): the REAL mint_harvest_seed. Sterile / gene-locked
        // parents propagate nothing; fertile parents yield a true-breeding child. ──
        let offspring =
            self.runtime
                .durable
                .crop_genomes
                .mint_harvest_seed(seed_variant_id, tending, 0);
        let (offspring_variant_id, offspring_qty) = match offspring {
            Some(harvest_seed) => {
                let seed_name = inventory_item_name(seed_item_id).unwrap_or("Seed");
                self.add_actor_inventory_stack(
                    &actor_id,
                    seed_item_id,
                    harvest_seed.seed_variant_id,
                    seed_name,
                    harvest_seed.qty,
                    BIO_SEED_STACK_CAP,
                    "seed-pouch",
                );
                (harvest_seed.seed_variant_id, harvest_seed.qty)
            }
            None => (seed_variant_id, 0),
        };
        // Lineage for the receipt/prose (display-only; genome side-table).
        let (species_name, cultivar_name, generation) = self
            .runtime
            .durable
            .crop_genomes
            .get(seed_variant_id)
            .map(|genome| {
                (
                    crop_species_by_item_id(genome.species_id)
                        .map(|species| species.name.to_owned())
                        .unwrap_or_else(|| format!("species-{seed_item_id}")),
                    genome.lineage.cultivar_name.clone(),
                    genome.lineage.generation,
                )
            })
            .unwrap_or_else(|| (format!("species-{seed_item_id}"), String::new(), 0));
        // ── REGROW (perennial) or CLEAR to bare-tilled (§W5). ──
        let now = self.runtime.durable.tick;
        let regrew = profile.regrowth_days > 0 && harvests_remaining > 1;
        if let Some(tile) = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .and_then(|parcel| parcel.tiles.get_mut(&key))
        {
            if regrew {
                if let Some(crop) = tile.crop.as_mut() {
                    crop.harvests_remaining = crop.harvests_remaining.saturating_sub(1);
                    // Re-fruit takes `regrowth_days` game-days: reset progress to
                    // maturity minus the regrowth window (never below 0).
                    let maturity = maturity_milli_days(&crop.profile);
                    let regrow_milli =
                        u64::from(crop.profile.regrowth_days).saturating_mul(u64::from(MILLI));
                    crop.accumulated_growth_days_milli = maturity.saturating_sub(regrow_milli);
                    crop.drought_days = 0;
                }
            } else {
                // Final harvest: bare-tilled again (crop + its amendment consumed).
                tile.crop = None;
                tile.fertilizer = None;
                tile.last_settle_tick = now;
            }
        }
        // ── RECEIPT + PROSE ──
        self.runtime.pending_harvest = Some(AuthorityHarvestSnapshot {
            parcel_id: parcel_id.to_owned(),
            cell_x,
            cell_y,
            species_name: species_name.clone(),
            cultivar_name,
            produce_item_id,
            produce_variant_id: produce_variant,
            produce_quality_milli: produce_quality,
            produce_qty,
            offspring_item_id: seed_item_id,
            offspring_variant_id,
            offspring_qty,
            generation,
            regrew,
            tick: now,
        });
        let seed_note = if offspring_qty > 0 {
            format!(" + {offspring_qty} seed(s)")
        } else {
            " (sterile — no seeds)".to_owned()
        };
        self.record_timeline_event(TimelineEventSnapshot {
            tick: now,
            label: format!(
                "{actor_id} harvested {produce_qty} {species_name} (quality {}%){seed_note}",
                produce_quality / 10
            ),
            cell: Some(CellSnapshot::new(cell_x, cell_y)),
        });
        Ok(())
    }

    // ── W3: WATER / TEND ────────────────────────────────────────────────────────
    pub(super) fn apply_water_tile(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), AuthorityRejectReason> {
        let cell = AuthorityCell::new(cell_x, cell_y);
        self.require_farm_tile_access(config, parcel_id, cell)?;
        let key = tile_cell_key(cell);
        {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            if !parcel.tiles.get(&key).is_some_and(|tile| tile.tilled) {
                return Err(AuthorityRejectReason::TileNotTilled);
            }
        }
        // Settle up to now with the pre-water moisture, THEN refill + reset drought
        // (revives a dormant crop from the SAME progress; F-Wither).
        self.settle_tile(parcel_id, &key);
        if let Some(tile) = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .and_then(|parcel| parcel.tiles.get_mut(&key))
        {
            tile.moisture_milli = MOISTURE_FULL_MILLI;
            if let Some(crop) = tile.crop.as_mut() {
                crop.drought_days = 0;
            }
        }
        Ok(())
    }

    /// TendPlot durable intent (§B.2) — the charm escape-valve. While armed (kneeling
    /// and in the parcel area) it waters dry tiles and settles the plot on a cadence,
    /// breaking on move/stand/area-change/death or an explicit `stop`. This entry
    /// point arms or clears the loop; `tick_plot_tending` (tick_lifecycle.rs) runs it.
    pub(super) fn apply_tend_plot(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        stop: bool,
    ) -> Result<(), AuthorityRejectReason> {
        if stop {
            self.runtime
                .durable
                .plot_tending
                .remove(&config.player_actor_id);
            return Ok(());
        }
        // Owner + in-parcel-area gate (the loop only runs while these hold).
        let _owner = self.require_parcel_owner(config, parcel_id)?;
        let (area_id, alive) = {
            let actor = self
                .runtime
                .durable
                .actors
                .get(&config.player_actor_id)
                .ok_or(AuthorityRejectReason::UnknownActor)?;
            (
                actor.area_id.clone(),
                actor.life_state == AuthorityLifeState::Alive,
            )
        };
        if !alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let parcel_area = self
            .runtime
            .durable
            .parcels
            .get(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?
            .area_id
            .clone();
        if area_id != parcel_area {
            return Err(AuthorityRejectReason::OutsideFarmYard);
        }
        // Kneel to tend (mirrors sampling/cranking posture), then arm the loop.
        let next_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(TEND_PLOT_CADENCE_TICKS);
        if let Some(actor) = self.runtime.durable.actors.get_mut(&config.player_actor_id) {
            if actor.posture == AuthorityActorPosture::Standing {
                actor.posture = AuthorityActorPosture::KneelingDown;
                actor.posture_until_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(POSTURE_KNEEL_DOWN_TICKS);
            }
        }
        self.runtime.durable.plot_tending.insert(
            config.player_actor_id.clone(),
            PlotTendingState {
                parcel_id: parcel_id.to_owned(),
                next_tend_tick: next_tick,
            },
        );
        // Immediate first pass so a single action visibly tends the plot.
        self.tend_plot_pass(parcel_id);
        Ok(())
    }

    /// One tending pass: settle every tile + water any dry ones (bulk "tend my farm"
    /// without per-tile clicking). Shared by the command's first pass and the loop.
    pub(super) fn tend_plot_pass(&mut self, parcel_id: &str) {
        let keys: Vec<String> = match self.runtime.durable.parcels.get(parcel_id) {
            Some(parcel) => parcel.tiles.keys().cloned().collect(),
            None => return,
        };
        for key in keys {
            self.settle_tile(parcel_id, &key);
            if let Some(tile) = self
                .runtime
                .durable
                .parcels
                .get_mut(parcel_id)
                .and_then(|parcel| parcel.tiles.get_mut(&key))
            {
                if tile.tilled && tile.moisture_milli == 0 {
                    tile.moisture_milli = MOISTURE_FULL_MILLI;
                    if let Some(crop) = tile.crop.as_mut() {
                        crop.drought_days = 0;
                    }
                }
            }
        }
    }

    // ── W3: STRUCTURES (sprinkler place/remove; §B.3) ───────────────────────────
    pub(super) fn apply_place_farm_structure(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        structure_item_id: u32,
        cell_x: i32,
        cell_y: i32,
    ) -> Result<(), AuthorityRejectReason> {
        // W3 ships the sprinkler only; greenhouse (6_302)/planter (6_303) land W4.
        if structure_item_id != IRRIGATION_SPRINKLER_ITEM_ID {
            return Err(AuthorityRejectReason::UnknownItem);
        }
        let cell = AuthorityCell::new(cell_x, cell_y);
        let _owner = self.require_parcel_owner(config, parcel_id)?;
        let now = self.runtime.durable.tick;
        // Footprint must be inside the parcel and not already occupied by a structure.
        {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            if !parcel.rect.contains_cell(cell) {
                return Err(AuthorityRejectReason::OutsideFarmYard);
            }
            if parcel.structures.values().any(|s| s.cell == cell) {
                return Err(AuthorityRejectReason::StructureFootprintBlocked);
            }
        }
        let actor_id = config.player_actor_id.clone();
        if self.actor_inventory_available_quantity(&actor_id, structure_item_id) < 1 {
            return Err(AuthorityRejectReason::ItemUnavailable);
        }
        self.consume_actor_inventory_quantity(&actor_id, structure_item_id, 1)?;
        let position = AuthorityPosition::from_cell(cell);
        let parcel = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        let seq = parcel.structures.len() as u64 + 1;
        let structure_id = format!("{parcel_id}:struct:{seq}");
        parcel.structures.insert(
            structure_id.clone(),
            FarmStructureState {
                structure_id,
                item_id: structure_item_id,
                cell,
                position,
                coverage_radius_cells: SPRINKLER_COVERAGE_RADIUS_CELLS,
                placed_at_tick: now,
            },
        );
        Ok(())
    }

    pub(super) fn apply_remove_farm_structure(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        structure_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let _owner = self.require_parcel_owner(config, parcel_id)?;
        let actor_id = config.player_actor_id.clone();
        let removed = {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get_mut(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            parcel
                .structures
                .remove(structure_id)
                .ok_or(AuthorityRejectReason::NoFarmStructure)?
        };
        if let Some(item_name) = inventory_item_name(removed.item_id) {
            self.add_actor_inventory_stack(
                &actor_id,
                removed.item_id,
                0,
                item_name,
                1,
                FARM_STRUCTURE_STACK_CAP,
                "field-pack",
            );
        }
        Ok(())
    }

    // ── ACCESS GATE (owner + inside farm_yard + point-blank adjacency; §B.2) ────
    fn require_farm_tile_access(
        &self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        cell: AuthorityCell,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        let parcel = self
            .runtime
            .durable
            .parcels
            .get(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        if Self::owner_character_id_for_actor(actor) != parcel.owner_character_id {
            return Err(AuthorityRejectReason::NotParcelOwner);
        }
        if !parcel.farm_yard.contains_cell(cell) {
            return Err(AuthorityRejectReason::OutsideFarmYard);
        }
        // Point-blank: you farm the tile you stand next to.
        if actor.area_id != parcel.area_id
            || position_distance_milli(actor.position, AuthorityPosition::from_cell(cell))
                > POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS
        {
            return Err(AuthorityRejectReason::OutsideFarmYard);
        }
        Ok(())
    }

    // ── LAZY SETTLE (§C.1) ───────────────────────────────────────────────────────
    /// Advance one stored tile's moisture + growth to `self.tick`, closed-form,
    /// across each whole game-day boundary. Called on water/plant/clear/tend and
    /// (via `materialize_tile_view`) at owner-HUD snapshot encode. Idempotent
    /// (now <= last_settle => no-op) and deterministic.
    pub(super) fn settle_tile(&mut self, parcel_id: &str, tile_key: &str) {
        let now = self.runtime.durable.tick;
        let tpd = self.farm_ticks_per_game_day();
        let (rained_through, upkeep_paid_through) =
            match self.runtime.durable.parcels.get(parcel_id) {
                Some(parcel) => (parcel.rained_through_tick, parcel.upkeep_paid_through_tick),
                None => return,
            };
        let sprinkler = match self.runtime.durable.parcels.get(parcel_id) {
            Some(parcel) => parcel
                .tiles
                .get(tile_key)
                .map(|tile| sprinkler_covers(parcel, tile.cell))
                .unwrap_or(false),
            None => return,
        };
        let Some(tile) = self
            .runtime
            .durable
            .parcels
            .get_mut(parcel_id)
            .and_then(|parcel| parcel.tiles.get_mut(tile_key))
        else {
            return;
        };
        let Some(crop) = tile.crop.as_mut() else {
            // No crop: only moisture ages (soil dries) across whole days.
            let (moisture, new_last) = advance_bare_soil_moisture(
                tile.moisture_milli,
                tile.last_settle_tick,
                now,
                tpd,
                rained_through,
                sprinkler,
            );
            tile.moisture_milli = moisture;
            tile.last_settle_tick = new_last;
            return;
        };
        let fert = tile_fertilizer_effect(tile.fertilizer.as_ref());
        let accrual = CropGrowthAccrual {
            accumulated_growth_days_milli: crop.accumulated_growth_days_milli,
            drought_days: crop.drought_days,
            tending_quality_milli: crop.tending_quality_milli,
        };
        let (accrual, moisture, new_last) = advance_crop_across_days(
            accrual,
            tile.moisture_milli,
            &crop.profile,
            fert,
            tile.last_settle_tick,
            now,
            tpd,
            rained_through,
            upkeep_paid_through,
            sprinkler,
        );
        crop.accumulated_growth_days_milli = accrual.accumulated_growth_days_milli;
        crop.drought_days = accrual.drought_days;
        crop.tending_quality_milli = accrual.tending_quality_milli;
        tile.moisture_milli = moisture;
        tile.last_settle_tick = new_last;
    }

    // ── farmPlot AOI (owner-detail channel; §B.4) ───────────────────────────────
    /// The owner's open-HUD plot detail for the parcel they own in the observer's
    /// current area (1/planet/char => at most one). Tiles are MATERIALIZED (settled
    /// on a clone) for display — never mutating stored state (extractor pattern).
    pub fn farm_plot_snapshot_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<AuthorityFarmPlotSnapshot> {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id)?;
        let owner = Self::owner_character_id_for_actor(observer);
        let parcel = self.runtime.durable.parcels.values().find(|parcel| {
            parcel.owner_character_id == owner && parcel.area_id == observer.area_id
        })?;
        let now = self.runtime.durable.tick;
        let tpd = self.farm_ticks_per_game_day();
        let tiles = parcel
            .tiles
            .values()
            .map(|tile| self.materialize_farm_tile(parcel, tile, now, tpd))
            .collect();
        Some(AuthorityFarmPlotSnapshot {
            parcel_id: parcel.id.clone(),
            owner_actor_id: parcel.owner_character_id.clone(),
            area_id: parcel.area_id.clone(),
            tiles,
        })
    }

    /// DEF-9 client delivery: world-visible farm-plot detail for EVERY parcel in
    /// the observer's AOI (crops are physical objects everyone renders). Tiles are
    /// MATERIALIZED on a clone (never mutating stored state; extractor pattern).
    /// legal_verbs are emitted raw here; the shard blanks them for non-owners
    /// (owner id carried for that decision), so a passer-by sees the crop but no
    /// actions on it.
    pub fn farm_plot_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityFarmPlotSnapshot> {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id);
        let now = self.runtime.durable.tick;
        let tpd = self.farm_ticks_per_game_day();
        self.runtime
            .durable
            .parcels
            .values()
            .filter(|parcel| match observer {
                Some(actor) => {
                    self.parcel_in_interest(actor, parcel, config.area_interest_radius_cells)
                }
                None => true,
            })
            .map(|parcel| {
                let tiles = parcel
                    .tiles
                    .values()
                    .map(|tile| self.materialize_farm_tile(parcel, tile, now, tpd))
                    .collect();
                AuthorityFarmPlotSnapshot {
                    parcel_id: parcel.id.clone(),
                    owner_actor_id: parcel.owner_character_id.clone(),
                    area_id: parcel.area_id.clone(),
                    tiles,
                }
            })
            .collect()
    }

    fn materialize_farm_tile(
        &self,
        parcel: &ParcelAuthorityState,
        tile: &TileAuthorityState,
        now: u64,
        tpd: u64,
    ) -> AuthorityFarmTileSnapshot {
        let sprinkler = sprinkler_covers(parcel, tile.cell);
        let (moisture_milli, crop_snapshot) = match tile.crop.as_ref() {
            Some(crop) => {
                let accrual = CropGrowthAccrual {
                    accumulated_growth_days_milli: crop.accumulated_growth_days_milli,
                    drought_days: crop.drought_days,
                    tending_quality_milli: crop.tending_quality_milli,
                };
                let fert = tile_fertilizer_effect(tile.fertilizer.as_ref());
                let (settled, moisture, _last) = advance_crop_across_days(
                    accrual,
                    tile.moisture_milli,
                    &crop.profile,
                    fert,
                    tile.last_settle_tick,
                    now,
                    tpd,
                    parcel.rained_through_tick,
                    parcel.upkeep_paid_through_tick,
                    sprinkler,
                );
                (moisture, Some(farm_crop_snapshot(crop, &settled, tpd)))
            }
            None => {
                let (moisture, _last) = advance_bare_soil_moisture(
                    tile.moisture_milli,
                    tile.last_settle_tick,
                    now,
                    tpd,
                    parcel.rained_through_tick,
                    sprinkler,
                );
                (moisture, None)
            }
        };
        let fertilizer = tile
            .fertilizer
            .map_or("none", |applied| applied.kind.id())
            .to_owned();
        let mature = crop_snapshot.as_ref().is_some_and(|crop| crop.mature);
        AuthorityFarmTileSnapshot {
            cell_x: tile.cell.x,
            cell_y: tile.cell.y,
            tilled: tile.tilled,
            moisture_pct: milli_to_pct(moisture_milli),
            fertilizer,
            legal_verbs: legal_tile_verbs(
                tile.tilled,
                crop_snapshot.is_some(),
                mature,
                tile.fertilizer.is_some(),
            ),
            crop: crop_snapshot,
        }
    }

    /// Locate a seed stack (exact container/stack/variant, seed band, owned, > 0)
    /// WITHOUT consuming it, so PlantSeed can validate the footprint precondition
    /// before spending the seed. Returns the inventory row index.
    fn find_actor_seed_row(
        &self,
        actor_id: &str,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<usize, AuthorityRejectReason> {
        let stack_id_num = stack_id
            .trim()
            .parse::<u64>()
            .map_err(|_| AuthorityRejectReason::SeedNotOwned)?;
        self.runtime
            .durable
            .inventory
            .iter()
            .position(|row| {
                row.container == container
                    && row.stack_id == stack_id_num
                    && row.variant_id == variant_id
                    && is_seed_item(row.item_id)
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .ok_or(AuthorityRejectReason::SeedNotOwned)
    }

    /// Locate a fertilizer stack (exact container/stack/variant, fertilizer band,
    /// owned, > 0) WITHOUT consuming it, so Fertilize can validate the tile before
    /// spending. Returns the inventory row index. Mirrors find_actor_seed_row.
    fn find_actor_fertilizer_row(
        &self,
        actor_id: &str,
        container: &str,
        stack_id: &str,
        variant_id: u32,
    ) -> Result<usize, AuthorityRejectReason> {
        let stack_id_num = stack_id
            .trim()
            .parse::<u64>()
            .map_err(|_| AuthorityRejectReason::ItemUnavailable)?;
        self.runtime
            .durable
            .inventory
            .iter()
            .position(|row| {
                row.container == container
                    && row.stack_id == stack_id_num
                    && row.variant_id == variant_id
                    && is_fertilizer_item(row.item_id)
                    && row.available > 0
                    && actor_owns_inventory_container(actor_id, &row.container)
            })
            .ok_or(AuthorityRejectReason::ItemUnavailable)
    }
}

/// Total harvests a freshly planted crop yields before the tile clears (§W5
/// regrowth). Single-harvest (regrowth_days == 0) => 1; a perennial re-fruits
/// PERENNIAL_HARVEST_TOTAL times (adopted default) before it must be replanted.
const PERENNIAL_HARVEST_TOTAL: u16 = 4;
pub(super) fn harvests_for_profile(profile: &AgronomicProfile) -> u16 {
    if profile.regrowth_days > 0 {
        PERENNIAL_HARVEST_TOTAL
    } else {
        1
    }
}

/// A sprinkler covers a cell within its Chebyshev radius (offline-safe watering).
fn sprinkler_covers(parcel: &ParcelAuthorityState, cell: AuthorityCell) -> bool {
    parcel.structures.values().any(|s| {
        s.item_id == IRRIGATION_SPRINKLER_ITEM_ID
            && (s.cell.x - cell.x).unsigned_abs() <= s.coverage_radius_cells
            && (s.cell.y - cell.y).unsigned_abs() <= s.coverage_radius_cells
    })
}

/// Bare tilled soil (no crop) only ages moisture across whole days.
fn advance_bare_soil_moisture(
    moisture_milli: u16,
    last_settle_tick: u64,
    now: u64,
    tpd: u64,
    rained_through_tick: u64,
    sprinkler: bool,
) -> (u16, u64) {
    let tpd = tpd.max(1);
    let last_day = game_day_index_for_tick(last_settle_tick, tpd);
    let current_day = game_day_index_for_tick(now, tpd);
    if current_day <= last_day {
        return (moisture_milli, last_settle_tick);
    }
    let mut moisture = moisture_milli;
    let mut d = last_day;
    let mut iters = 0u64;
    while d < current_day && iters < MAX_SETTLE_GAME_DAYS_PER_CALL {
        let day_start = d.saturating_mul(tpd);
        let rain = rained_through_tick > day_start;
        moisture = if sprinkler || rain {
            MOISTURE_FULL_MILLI
        } else {
            // bare soil dries at the base rate (no crop water_need to key off).
            moisture.saturating_sub(MOISTURE_DECAY_BASE_PER_GAME_DAY as u16)
        };
        if !sprinkler && rained_through_tick <= (d + 1).saturating_mul(tpd) && moisture == 0 {
            break; // dry fixed point
        }
        d += 1;
        iters += 1;
    }
    (moisture, current_day.saturating_mul(tpd))
}

/// The §C.1 day loop, bounded + deterministic (native == wasm32). Advances across
/// each whole game-day boundary in (last_settle_tick, now]; per day reads season
/// (calendar), rain (parcel window), sprinkler, and upkeep (lapse => frozen pause,
/// §F5). Early-breaks at a season-independent dormant-dry or frozen fixed point so
/// long-offline catch-up is O(runway+grace), not O(days-elapsed).
#[allow(clippy::too_many_arguments)]
pub(super) fn advance_crop_across_days(
    accrual: CropGrowthAccrual,
    moisture_milli: u16,
    profile: &AgronomicProfile,
    fert: FertilizerEffect,
    last_settle_tick: u64,
    now: u64,
    tpd: u64,
    rained_through_tick: u64,
    upkeep_paid_through_tick: u64,
    sprinkler: bool,
) -> (CropGrowthAccrual, u16, u64) {
    let tpd = tpd.max(1);
    let last_day = game_day_index_for_tick(last_settle_tick, tpd);
    let current_day = game_day_index_for_tick(now, tpd);
    if current_day <= last_day {
        return (accrual, moisture_milli, last_settle_tick); // idempotent no-op (§C.9 #1)
    }
    let mut a = accrual;
    let mut moisture = moisture_milli;
    let mut d = last_day;
    let mut iters = 0u64;
    while d < current_day && iters < MAX_SETTLE_GAME_DAYS_PER_CALL {
        let day_start = d.saturating_mul(tpd);
        // §F5 upkeep lapse: an unpaid deed FREEZES growth (pause + weeds), never
        // dies. paid_through is fixed during settle, so the lapsed tail is a fixed
        // point — break and jump last_settle (frozen days change nothing).
        if upkeep_paid_through_tick <= day_start {
            break;
        }
        let month = month_index_for_game_day(d);
        let in_season_today = in_season(profile.season_affinity, month);
        let rain = rained_through_tick > day_start;
        settle_one_game_day(
            &mut a,
            &mut moisture,
            profile,
            fert,
            sprinkler,
            rain,
            in_season_today,
        );
        d += 1;
        iters += 1;
        // Dormant-dry fixed point (season-INDEPENDENT: a dry day never grows and
        // its drought/tending effect ignores season). No sprinkler, no future rain,
        // bone dry, dormant, tending floored => all remaining days are identical.
        if !sprinkler
            && rained_through_tick <= d.saturating_mul(tpd)
            && moisture == 0
            && is_dormant(a.drought_days, profile.hardiness_milli)
            && a.tending_quality_milli == 0
        {
            break;
        }
    }
    (a, moisture, current_day.saturating_mul(tpd))
}

fn farm_crop_snapshot(
    crop: &CropAuthorityState,
    settled: &CropGrowthAccrual,
    tpd: u64,
) -> AuthorityFarmCropSnapshot {
    let maturity = maturity_milli_days(&crop.profile);
    let stage = stage_for_progress(settled.accumulated_growth_days_milli, maturity);
    let mature = is_mature(settled.accumulated_growth_days_milli, &crop.profile);
    let dormant = is_dormant(settled.drought_days, crop.profile.hardiness_milli);
    let health = if dormant {
        "dormant"
    } else if settled.drought_days > 0 {
        "wilting"
    } else {
        "vigorous"
    };
    let time_to_mature_game_days = if mature {
        None
    } else {
        // Remaining ideal (in-season, watered) whole game-days to maturity.
        let remaining_milli = maturity.saturating_sub(settled.accumulated_growth_days_milli);
        Some(remaining_milli.div_ceil(u64::from(MILLI)))
    };
    let _ = tpd;
    let species = crop_species_by_item_id(crop.seed_item_id)
        .map(|definition| definition.key.to_owned())
        .unwrap_or_else(|| format!("species-{}", crop.seed_item_id));
    AuthorityFarmCropSnapshot {
        seed_item_id: crop.seed_item_id,
        seed_variant_id: crop.seed_variant_id,
        species,
        stage,
        stage_count: NUM_VISUAL_STAGES as u8,
        health: health.to_owned(),
        blight: "none".to_owned(),
        time_to_mature_game_days,
        quality_so_far_milli: produce_quality_milli(
            crop.profile.quality_potential_milli,
            settled.tending_quality_milli,
        ),
        footprint_w: u8::try_from(footprint_dims(crop.profile.tile_footprint).0).unwrap_or(1),
        footprint_h: u8::try_from(footprint_dims(crop.profile.tile_footprint).1).unwrap_or(1),
        mature,
    }
}

fn legal_tile_verbs(tilled: bool, has_crop: bool, mature: bool, fertilized: bool) -> Vec<String> {
    if !tilled {
        return vec!["till".to_owned()];
    }
    let mut verbs = Vec::new();
    if has_crop && mature {
        verbs.push("harvest".to_owned()); // W5: only a mature crop is harvestable
    }
    if !has_crop {
        verbs.push("plant".to_owned());
    }
    verbs.push("water".to_owned());
    if !fertilized {
        verbs.push("fertilize".to_owned()); // W4: one kind per tile
    }
    verbs.push("clear".to_owned());
    verbs
}

fn milli_to_pct(milli: u16) -> u8 {
    u8::try_from((u32::from(milli) * 100 / MILLI).min(100)).unwrap_or(100)
}

impl SliceAuthorityState {
    /// TendPlot durable-intent joins the hash ONLY when non-empty (empty-gated,
    /// groups precedent) so a world with no active tenders hashes byte-identically
    /// to the pre-farming era. Sorted BTreeMap iteration; deterministic.
    pub(super) fn write_plot_tending_stable_hash(&self, w: &mut StateWriter) {
        if self.runtime.durable.plot_tending.is_empty() {
            return;
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.plot_tending.len())
                .expect("plot tending count fits u32"),
        );
        for (actor_id, tending) in &self.runtime.durable.plot_tending {
            write_string(w, actor_id);
            write_string(w, &tending.parcel_id);
            w.write_tick(tending.next_tend_tick);
        }
    }
}

impl SliceAuthorityState {
    /// TendPlot durable-intent cadence (tick_lifecycle). While armed + valid, waters
    /// dry tiles + settles the plot every TEND_PLOT_CADENCE_TICKS; self-clears when
    /// the tender moves/stands/leaves-area/dies or loses ownership (§B.2 break rules).
    pub(super) fn tick_plot_tending(&mut self) {
        if self.runtime.durable.plot_tending.is_empty() {
            return;
        }
        let now = self.runtime.durable.tick;
        for actor_id in self
            .runtime
            .durable
            .plot_tending
            .keys()
            .cloned()
            .collect::<Vec<_>>()
        {
            let Some(tending) = self.runtime.durable.plot_tending.get(&actor_id) else {
                continue;
            };
            let parcel_id = tending.parcel_id.clone();
            let due = now >= tending.next_tend_tick;
            if !self.plot_tending_still_valid(&actor_id, &parcel_id) {
                self.runtime.durable.plot_tending.remove(&actor_id);
                continue;
            }
            if !due {
                continue;
            }
            self.tend_plot_pass(&parcel_id);
            if let Some(tending) = self.runtime.durable.plot_tending.get_mut(&actor_id) {
                tending.next_tend_tick = now.saturating_add(TEND_PLOT_CADENCE_TICKS);
            }
        }
    }

    /// The tender must be alive, kneeling (moving requires standing => break on move),
    /// still the parcel owner, and in the parcel's area.
    fn plot_tending_still_valid(&self, actor_id: &str, parcel_id: &str) -> bool {
        let Some(actor) = self.runtime.durable.actors.get(actor_id) else {
            return false;
        };
        if actor.life_state != AuthorityLifeState::Alive {
            return false;
        }
        if !matches!(
            actor.posture,
            AuthorityActorPosture::Kneeling | AuthorityActorPosture::KneelingDown
        ) {
            return false;
        }
        let Some(parcel) = self.runtime.durable.parcels.get(parcel_id) else {
            return false;
        };
        Self::owner_character_id_for_actor(actor) == parcel.owner_character_id
            && actor.area_id == parcel.area_id
    }
}
