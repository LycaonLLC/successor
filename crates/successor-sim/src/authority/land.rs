//! W1 PARCELS — the mini-mayor land claim (§A.1, §B.1, §C.0, §F). A parcel is a
//! claimed rectangle entity keyed on the DURABLE owner character; max 2 globally.
//! Claim spends wallet credits (the land sink, §F/§G); lapse pauses the farm, never
//! confiscates (§F5). Gating: housing region (area kind), no overlap (+ setback
//! ring), POI buffer (clone facilities), road buffer (area transitions).
//!
//! The authoritative claim validation lives HERE (region/overlap/buffers/funds/
//! global character cap). The Land Registry TERMINAL is the FE/shard entry surface that
//! opens the claim UI and emits ClaimParcel (mirrors the travel terminal) —
//! terminal-proximity is a shard gate, not a Rust gate, since props are shard
//! state; documented so the seam is explicit.
use super::*;

const MAX_PARCELS_PER_CHARACTER: usize = 2;

impl SliceAuthorityState {
    /// ticks per game-day for the farm cadence (F-Time knob).
    pub(super) fn farm_ticks_per_game_day(&self) -> u64 {
        ticks_per_game_day(
            self.runtime.durable.world.tick_rate_hz,
            self.runtime.durable.world.farm_real_seconds_per_game_day,
        )
    }

    /// Set the F-Time knob (realSecondsPerGameDay): production default ~3600,
    /// DEV-OVERRIDABLE to 300 for fast QA/live proofs. Deterministic sim input
    /// (like tick_rate_hz), NOT hashed. Public API for the shard/fixture/driver.
    pub fn set_farm_real_seconds_per_game_day(&mut self, seconds: u32) {
        self.runtime.durable.world.farm_real_seconds_per_game_day = seconds.max(1);
    }

    /// DURABLE owner identity for a parcel. Single-shard model: the actor id IS
    /// the durable character identity (persisted across restart by the versioned
    /// export/import). When a real character/actor split lands, resolve the bound
    /// character id here — this is the ONE seam. Verified: no `character_id` on
    /// ActorAuthorityState today, so adding a dead Option field is not warranted.
    pub(super) fn owner_character_id_for_actor(actor: &ActorAuthorityState) -> String {
        actor.id.clone()
    }

    // ── CLAIM (§B.1) ────────────────────────────────────────────────────────────
    pub(super) fn apply_claim_parcel(
        &mut self,
        config: &SliceAuthorityConfig,
        planet_id: &str,
        area_id: &str,
        x: i32,
        y: i32,
        tier_id: &str,
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
        let tier = ParcelTier::from_id(tier_id).ok_or(AuthorityRejectReason::TargetUnavailable)?;
        let area = self
            .runtime
            .durable
            .world
            .areas
            .get(area_id)
            .ok_or(AuthorityRejectReason::UnknownArea)?;
        if !Self::is_housing_region(area) {
            return Err(AuthorityRejectReason::NotInHousingRegion);
        }
        // ── LATTICE SNAP (§A): quantize the requested origin to the global lattice.
        // The server snaps regardless of what the client sent; the receipt reports
        // requested->snapped so the FE confirms where the claim actually landed.
        let snapped_x = snap_to_lattice(x);
        let snapped_y = snap_to_lattice(y);
        let (lot, build_zone, farm_yard) = derive_parcel_rects(tier, snapped_x, snapped_y);
        if !Self::area_contains_rect(area, &lot) {
            return Err(AuthorityRejectReason::OutOfBounds);
        }
        let owner_character_id = Self::owner_character_id_for_actor(&actor);
        // Owner law: at most two parcels per durable character across all planets.
        // Imported holdings above the cap remain intact, but no new claim is legal
        // until abandonment brings the owner below the cap.
        let owned_parcel_count = self
            .runtime
            .durable
            .parcels
            .values()
            .filter(|parcel| parcel.owner_character_id == owner_character_id)
            .count();
        if owned_parcel_count >= MAX_PARCELS_PER_CHARACTER {
            return Err(AuthorityRejectReason::ParcelLimitReached);
        }
        // Overlap: EXACT lattice-cell test (§A). Two lots may share an edge (DIRECT
        // ADJACENCY, owner law) — only a shared quantum cell is a conflict. The old
        // forced setback GAP is gone; the internal no-build ring (build_zone/farm_yard
        // inset) still gives a walk corridor between adjacent builds.
        let claimed_lat = LatticeRect::covering(&lot);
        if self.runtime.durable.parcels.values().any(|p| {
            p.area_id == area_id && LatticeRect::covering(&p.rect).intersects(&claimed_lat)
        }) {
            return Err(AuthorityRejectReason::ParcelOverlap);
        }
        // Exclusion: unified lattice-aligned no-claim zones (central config + POI +
        // road buffers, §B/§F7) — the SAME predicate the no-deadzone audit uses.
        if let Some(source) = self.first_no_claim_zone_hit(area_id, &lot) {
            return Err(source.reject_reason());
        }
        // One coherent economy: parcels spend the same scalar wallet credits
        // used by banking, guilds, training respec, and player trade.
        let price = tier.claim_price_credits();
        if actor.professions.credits < price {
            return Err(AuthorityRejectReason::InsufficientCredits);
        }
        self.runtime
            .durable
            .actors
            .get_mut(&actor.id)
            .expect("parcel claimant remains registered")
            .professions
            .credits -= price;
        // Mint the parcel. First upkeep period is prepaid by the claim (§F5).
        let seq = self.runtime.durable.next_parcel_id.max(1);
        self.runtime.durable.next_parcel_id = seq.saturating_add(1).max(1);
        let id = format!("parcel:{planet_id}:{seq}");
        let upkeep_paid_through_tick = self.runtime.durable.tick.saturating_add(
            PARCEL_UPKEEP_PERIOD_GAME_DAYS.saturating_mul(self.farm_ticks_per_game_day()),
        );
        self.runtime.durable.parcels.insert(
            id.clone(),
            ParcelAuthorityState {
                id: id.clone(),
                owner_character_id,
                planet_id: planet_id.to_owned(),
                area_id: area_id.to_owned(),
                name: format!("{} Claim", tier_label(tier)),
                rect: lot,
                tier,
                build_zone,
                farm_yard,
                claimed_tick: self.runtime.durable.tick,
                upkeep_paid_through_tick,
                rained_through_tick: 0,
                tiles: BTreeMap::new(),
                structures: BTreeMap::new(),
                build_components: BTreeMap::new(),
            },
        );
        // Receipt (§5): requested -> snapped, so the FE/journeys confirm the snap.
        self.runtime.pending_parcel_claim = Some(AuthorityParcelClaimSnapshot {
            parcel_id: id.clone(),
            requested_x: x,
            requested_y: y,
            snapped_x,
            snapped_y,
            snapped: x != snapped_x || y != snapped_y,
            tier: tier.id().to_owned(),
            rect: (&lot).into(),
            build_zone: (&build_zone).into(),
            farm_yard: (&farm_yard).into(),
            tick: self.runtime.durable.tick,
        });
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} staked a {} claim ({id})", actor.id, tier.id()),
            cell: Some(CellSnapshot::new(lot.x, lot.y)),
        });
        Ok(())
    }

    // ── RENAME (§B.1, owner-only cosmetic) ──────────────────────────────────────
    pub(super) fn apply_rename_parcel(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
        name: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let owner = self.require_parcel_owner(config, parcel_id)?;
        let trimmed = name.trim();
        let label = if trimmed.is_empty() {
            format!("{owner}'s Farm")
        } else {
            trimmed.chars().take(64).collect::<String>()
        };
        if let Some(parcel) = self.runtime.durable.parcels.get_mut(parcel_id) {
            parcel.name = label;
        }
        Ok(())
    }

    // ── PAY UPKEEP (§B.1, §F5 — light credit sink; lapse pauses, never confiscates) ─
    pub(super) fn apply_pay_upkeep(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let _owner = self.require_parcel_owner(config, parcel_id)?;
        let (tier, paid_through) = {
            let parcel = self
                .runtime
                .durable
                .parcels
                .get(parcel_id)
                .ok_or(AuthorityRejectReason::UnknownParcel)?;
            (parcel.tier, parcel.upkeep_paid_through_tick)
        };
        // Only chargeable once you are within the current period's lead-in window:
        // you cannot pre-pay years ahead. Paid-up-and-not-yet-in-window => UpkeepNotDue.
        let period_ticks =
            PARCEL_UPKEEP_PERIOD_GAME_DAYS.saturating_mul(self.farm_ticks_per_game_day());
        if paid_through > self.runtime.durable.tick.saturating_add(period_ticks) {
            return Err(AuthorityRejectReason::UpkeepNotDue);
        }
        let actor_id = config.player_actor_id.clone();
        let cost = tier.upkeep_cost_credits();
        let actor_credits = self
            .runtime
            .durable
            .actors
            .get(&actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .professions
            .credits;
        if actor_credits < cost {
            return Err(AuthorityRejectReason::InsufficientCredits);
        }
        self.runtime
            .durable
            .actors
            .get_mut(&actor_id)
            .expect("parcel owner remains registered")
            .professions
            .credits -= cost;
        // Extend from max(now, paid_through) so a lapsed deed resumes from now
        // (no retroactive back-pay) and a current deed stacks a full period.
        let base = paid_through.max(self.runtime.durable.tick);
        if let Some(parcel) = self.runtime.durable.parcels.get_mut(parcel_id) {
            parcel.upkeep_paid_through_tick = base.saturating_add(period_ticks);
        }
        Ok(())
    }

    // ── ABANDON (§B.1, owner-only; returns placed structures, crops lost) ───────
    pub(super) fn apply_abandon_parcel(
        &mut self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        let _owner = self.require_parcel_owner(config, parcel_id)?;
        let Some(parcel) = self.runtime.durable.parcels.remove(parcel_id) else {
            return Err(AuthorityRejectReason::UnknownParcel);
        };
        // Return placed STRUCTURE items to the owner (you chose to leave; crops are
        // lost with the land). This may free one of the two global claim slots.
        let actor_id = config.player_actor_id.clone();
        for structure in parcel.structures.values() {
            if let Some(item_name) = inventory_item_name(structure.item_id) {
                self.add_actor_inventory_stack(
                    &actor_id,
                    structure.item_id,
                    0,
                    item_name,
                    1,
                    FARM_STRUCTURE_STACK_CAP,
                    "field-pack",
                );
            }
        }
        self.record_timeline_event(TimelineEventSnapshot {
            tick: self.runtime.durable.tick,
            label: format!("{} abandoned their claim ({parcel_id})", actor_id),
            cell: Some(CellSnapshot::new(parcel.rect.x, parcel.rect.y)),
        });
        Ok(())
    }

    /// Owner gate for parcel-scoped commands. Returns the resolved owner char id.
    pub(super) fn require_parcel_owner(
        &self,
        config: &SliceAuthorityConfig,
        parcel_id: &str,
    ) -> Result<String, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let parcel = self
            .runtime
            .durable
            .parcels
            .get(parcel_id)
            .ok_or(AuthorityRejectReason::UnknownParcel)?;
        let owner_character_id = Self::owner_character_id_for_actor(actor);
        if parcel.owner_character_id != owner_character_id {
            return Err(AuthorityRejectReason::NotParcelOwner);
        }
        Ok(owner_character_id)
    }

    // ── GATING HELPERS ──────────────────────────────────────────────────────────
    /// A housing region is any outdoor world area. Indoor/arena/instance kinds are
    /// non-claimable. Seam: owner-designated sub-regions plug in here later (§F7).
    fn is_housing_region(area: &AreaAuthorityState) -> bool {
        let kind = area.kind.to_ascii_lowercase();
        !(kind.contains("arena")
            || kind.contains("interior")
            || kind.contains("instance")
            || kind.contains("dungeon")
            || kind.contains("building"))
    }

    fn area_contains_rect(area: &AreaAuthorityState, rect: &AuthorityRect) -> bool {
        rect.x >= 0
            && rect.y >= 0
            && i64::from(rect.x) + i64::from(rect.w) <= i64::from(area.width)
            && i64::from(rect.y) + i64::from(rect.h) <= i64::from(area.height)
    }

    // ── UNIFIED LATTICE-ALIGNED EXCLUSION (§B/§F7) ──────────────────────────────
    /// The no-claim zones for an area — central config zones (stored) + POI buffers
    /// (clone facilities) + road buffers (area transitions), each snapped OUTWARD to
    /// whole lattice cells. Derived on demand so there is ONE source of exclusion
    /// truth for BOTH claim validation and the no-deadzone audit (they can never
    /// disagree). POI/road come from live state, so a runtime-placed facility excludes.
    pub(super) fn no_claim_zones_for_area(&self, area_id: &str) -> Vec<NoClaimZone> {
        let buffer = u32::try_from(PARCEL_POI_BUFFER_CELLS).unwrap_or(0);
        let mut zones = Vec::new();
        for zone in self
            .runtime
            .durable
            .world
            .no_claim_zones
            .iter()
            .filter(|z| z.area_id == area_id)
        {
            zones.push(NoClaimZone {
                rect: zone.rect,
                source: NoClaimZoneSource::Central,
            });
        }
        for facility in self
            .runtime
            .durable
            .world
            .clone_facilities
            .iter()
            .filter(|f| f.area_id == area_id)
        {
            let raw = AuthorityRect::new(facility.respawn_cell.x, facility.respawn_cell.y, 1, 1)
                .inflated(buffer);
            zones.push(NoClaimZone {
                rect: lattice_align_outward(&raw),
                source: NoClaimZoneSource::Poi,
            });
        }
        for transition in self
            .runtime
            .durable
            .world
            .transitions
            .values()
            .filter(|t| t.from_area_id == area_id)
        {
            let raw = AuthorityRect::new(transition.from_cell.x, transition.from_cell.y, 1, 1)
                .inflated(buffer);
            zones.push(NoClaimZone {
                rect: lattice_align_outward(&raw),
                source: NoClaimZoneSource::Road,
            });
        }
        zones
    }

    /// The first no-claim zone whose lattice rect intersects `lot`, if any (returns
    /// the source so the claim path can report the right reject code).
    fn first_no_claim_zone_hit(
        &self,
        area_id: &str,
        lot: &AuthorityRect,
    ) -> Option<NoClaimZoneSource> {
        let lot_lat = LatticeRect::covering(lot);
        self.no_claim_zones_for_area(area_id)
            .into_iter()
            .find(|zone| LatticeRect::covering(&zone.rect).intersects(&lot_lat))
            .map(|zone| zone.source)
    }

    /// The unified no-claim zones (§6) for the observer's area — the client's
    /// INVALID read for the claim ghost. Static map data; the shard forwards it.
    pub fn no_claim_zone_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityNoClaimZoneSnapshot> {
        let area_id = match self.runtime.durable.actors.get(&config.player_actor_id) {
            Some(actor) => actor.area_id.clone(),
            None => return Vec::new(),
        };
        self.no_claim_zones_for_area(&area_id)
            .into_iter()
            .map(|zone| AuthorityNoClaimZoneSnapshot {
                area_id: area_id.clone(),
                rect: (&zone.rect).into(),
                source: zone.source.id().to_owned(),
            })
            .collect()
    }

    // ── NO-DEADZONE AUDIT (§A invariant proof) ──────────────────────────────────
    /// Scan every lattice slot in an area and prove that every FREE (in-bounds AND
    /// unexcluded AND unclaimed) quantum cell is coverable by at least one legal
    /// smallest-tier (Homestead = 2x2 quantum) claim. `trapped_cells` empty => the
    /// invariant holds: any unclaimed lattice region >= the smallest tier is
    /// claimable, so NO deadzone sliver can exist. O(quantum cells).
    pub fn audit_no_deadzone(&self, area_id: &str) -> NoDeadzoneAuditReport {
        let q = crate::LATTICE_QUANTUM_CELLS;
        let Some(area) = self.runtime.durable.world.areas.get(area_id) else {
            return NoDeadzoneAuditReport {
                area_id: area_id.to_owned(),
                quantum_cells: q,
                area_quantum_w: 0,
                area_quantum_h: 0,
                free_cells: 0,
                coverable_cells: 0,
                trapped_cells: Vec::new(),
                trapped_total: 0,
                passed: true,
            };
        };
        // Whole lattice cells that fit in-bounds (a sub-quantum edge remainder holds
        // no lattice-aligned lot and is not part of the claim space).
        let qw = (i64::from(area.width) / i64::from(q)) as i32;
        let qh = (i64::from(area.height) / i64::from(q)) as i32;
        if qw < 1 || qh < 1 {
            return NoDeadzoneAuditReport {
                area_id: area_id.to_owned(),
                quantum_cells: q,
                area_quantum_w: qw.max(0),
                area_quantum_h: qh.max(0),
                free_cells: 0,
                coverable_cells: 0,
                trapped_cells: Vec::new(),
                trapped_total: 0,
                passed: true,
            };
        }
        let zones: Vec<LatticeRect> = self
            .no_claim_zones_for_area(area_id)
            .iter()
            .map(|z| LatticeRect::covering(&z.rect))
            .collect();
        let claims: Vec<LatticeRect> = self
            .runtime
            .durable
            .parcels
            .values()
            .filter(|p| p.area_id == area_id)
            .map(|p| LatticeRect::covering(&p.rect))
            .collect();
        let w = qw as usize;
        let h = qh as usize;
        let at = |qx: i32, qy: i32| (qy as usize) * w + (qx as usize);
        let mut free = vec![false; w * h];
        for qy in 0..qh {
            for qx in 0..qw {
                let excluded = zones.iter().any(|z| z.contains_q(qx, qy));
                let claimed = claims.iter().any(|c| c.contains_q(qx, qy));
                free[at(qx, qy)] = !excluded && !claimed;
            }
        }
        // A free cell is coverable iff it lies in at least one all-free 2x2 block
        // (a legal Homestead footprint). No coverable => trapped => sliver.
        let mut coverable = vec![false; w * h];
        for qy in 0..(qh - 1) {
            for qx in 0..(qw - 1) {
                if free[at(qx, qy)]
                    && free[at(qx + 1, qy)]
                    && free[at(qx, qy + 1)]
                    && free[at(qx + 1, qy + 1)]
                {
                    coverable[at(qx, qy)] = true;
                    coverable[at(qx + 1, qy)] = true;
                    coverable[at(qx, qy + 1)] = true;
                    coverable[at(qx + 1, qy + 1)] = true;
                }
            }
        }
        let mut free_cells = 0u64;
        let mut coverable_cells = 0u64;
        let mut trapped_total = 0u64;
        let mut trapped_cells = Vec::new();
        for qy in 0..qh {
            for qx in 0..qw {
                if free[at(qx, qy)] {
                    free_cells += 1;
                    if coverable[at(qx, qy)] {
                        coverable_cells += 1;
                    } else {
                        trapped_total += 1;
                        if trapped_cells.len() < 64 {
                            trapped_cells.push(AuthorityRectSnapshot {
                                x: qx.saturating_mul(q),
                                y: qy.saturating_mul(q),
                                w: q as u32,
                                h: q as u32,
                            });
                        }
                    }
                }
            }
        }
        NoDeadzoneAuditReport {
            area_id: area_id.to_owned(),
            quantum_cells: q,
            area_quantum_w: qw,
            area_quantum_h: qh,
            free_cells,
            coverable_cells,
            trapped_cells,
            trapped_total,
            passed: trapped_total == 0,
        }
    }

    // ── AOI (parcels section, §B.4) ─────────────────────────────────────────────
    pub fn parcel_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityParcelSnapshot> {
        let observer = self.runtime.durable.actors.get(&config.player_actor_id);
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
            .map(|parcel| self.parcel_snapshot_from_state(parcel, observer))
            .collect()
    }

    pub(super) fn parcel_in_interest(
        &self,
        observer: &ActorAuthorityState,
        parcel: &ParcelAuthorityState,
        radius_cells: i32,
    ) -> bool {
        if observer.area_id != parcel.area_id {
            return false;
        }
        let owner = Self::owner_character_id_for_actor(observer) == parcel.owner_character_id;
        owner
            || parcel
                .rect
                .inflated(radius_cells.max(0) as u32)
                .contains_cell(observer.cell)
    }

    fn parcel_snapshot_from_state(
        &self,
        parcel: &ParcelAuthorityState,
        observer: Option<&ActorAuthorityState>,
    ) -> AuthorityParcelSnapshot {
        let is_owner = observer.is_some_and(|actor| {
            Self::owner_character_id_for_actor(actor) == parcel.owner_character_id
        });
        let tilled_tiles =
            u32::try_from(parcel.tiles.values().filter(|t| t.tilled).count()).unwrap_or(u32::MAX);
        let planted_tiles =
            u32::try_from(parcel.tiles.values().filter(|t| t.crop.is_some()).count())
                .unwrap_or(u32::MAX);
        AuthorityParcelSnapshot {
            parcel_id: parcel.id.clone(),
            owner_actor_id: parcel.owner_character_id.clone(),
            planet_id: parcel.planet_id.clone(),
            area_id: parcel.area_id.clone(),
            name: parcel.name.clone(),
            rect: (&parcel.rect).into(),
            tier: parcel.tier.id().to_owned(),
            build_zone: (&parcel.build_zone).into(),
            farm_yard: (&parcel.farm_yard).into(),
            is_owner,
            // Raw to the shard; the shard redacts upkeep for non-owners (DEF-9,
            // camp-countdown precedent). The delta bundle is skip-serialized so
            // this only reaches a client via the shard's per-session redaction.
            upkeep_due_in_game_days: Some(self.parcel_upkeep_due_in_game_days(parcel)),
            tilled_tiles,
            planted_tiles,
        }
    }

    fn parcel_upkeep_due_in_game_days(&self, parcel: &ParcelAuthorityState) -> i64 {
        let tpd = self.farm_ticks_per_game_day().max(1);
        let remaining_ticks =
            i128::from(parcel.upkeep_paid_through_tick) - i128::from(self.runtime.durable.tick);
        (remaining_ticks / i128::from(tpd)) as i64
    }

    // ── HASH CEREMONY (§0 ceremony; empty-gated like groups to avoid churn) ─────
    /// Parcels contribute to the stable hash ONLY when non-empty (or a claim seq
    /// has advanced), so a world that has never claimed land hashes byte-identically
    /// to the pre-parcel era — no existing digest churns. Nested tiles/crops/
    /// structures hash in sorted (BTreeMap) order. Deterministic; native == wasm32.
    pub(super) fn write_parcels_stable_hash(&self, w: &mut StateWriter) {
        if self.runtime.durable.parcels.is_empty() && self.runtime.durable.next_parcel_id <= 1 {
            return;
        }
        w.write_u64(self.runtime.durable.next_parcel_id);
        w.write_u32(
            u32::try_from(self.runtime.durable.parcels.len()).expect("parcel count fits u32"),
        );
        for (id, parcel) in &self.runtime.durable.parcels {
            write_string(w, id);
            write_string(w, &parcel.owner_character_id);
            write_string(w, &parcel.planet_id);
            write_string(w, &parcel.area_id);
            write_string(w, &parcel.name);
            write_rect_stable_hash(w, &parcel.rect);
            w.write_u32(parcel.tier.code());
            write_rect_stable_hash(w, &parcel.build_zone);
            write_rect_stable_hash(w, &parcel.farm_yard);
            w.write_tick(parcel.claimed_tick)
                .write_tick(parcel.upkeep_paid_through_tick)
                .write_tick(parcel.rained_through_tick);
            w.write_u32(u32::try_from(parcel.tiles.len()).expect("tile count fits u32"));
            for (key, tile) in &parcel.tiles {
                write_string(w, key);
                write_tile_stable_hash(w, tile);
            }
            w.write_u32(u32::try_from(parcel.structures.len()).expect("structure count fits u32"));
            for (structure_id, structure) in &parcel.structures {
                write_string(w, structure_id);
                w.write_u32(structure.item_id)
                    .write_i64(i64::from(structure.cell.x))
                    .write_i64(i64::from(structure.cell.y))
                    .write_i64(i64::from(structure.position.x))
                    .write_i64(i64::from(structure.position.y))
                    .write_u32(structure.coverage_radius_cells)
                    .write_tick(structure.placed_at_tick);
            }
        }
    }
}

fn tier_label(tier: ParcelTier) -> &'static str {
    match tier {
        ParcelTier::Homestead => "Homestead",
        ParcelTier::Farmstead => "Farmstead",
        ParcelTier::Plantation => "Plantation",
    }
}

fn write_rect_stable_hash(w: &mut StateWriter, rect: &AuthorityRect) {
    w.write_i64(i64::from(rect.x))
        .write_i64(i64::from(rect.y))
        .write_u32(rect.w)
        .write_u32(rect.h);
}

fn write_tile_stable_hash(w: &mut StateWriter, tile: &TileAuthorityState) {
    w.write_i64(i64::from(tile.cell.x))
        .write_i64(i64::from(tile.cell.y))
        .write_bool(tile.tilled)
        .write_u32(u32::from(tile.moisture_milli))
        .write_tick(tile.last_settle_tick);
    // W4 fertilizer (stored soil amendment) joins the hash; absent => one bool.
    match tile.fertilizer.as_ref() {
        Some(fertilizer) => {
            w.write_bool(true)
                .write_u32(fertilizer.kind.code())
                .write_u32(fertilizer.variant_id);
        }
        None => {
            w.write_bool(false);
        }
    }
    w.write_bool(tile.crop.is_some());
    if let Some(crop) = tile.crop.as_ref() {
        w.write_u32(crop.seed_item_id)
            .write_u32(crop.seed_variant_id)
            .write_tick(crop.planted_tick);
        write_agronomic_profile_stable_hash(w, &crop.profile);
        w.write_u64(crop.accumulated_growth_days_milli)
            .write_u32(u32::from(crop.drought_days))
            .write_u32(u32::from(crop.tending_quality_milli))
            .write_u32(u32::from(crop.harvests_remaining)); // W5 regrowth counter
    }
}

/// The cached AgronomicProfile is part of stored crop state and joins the crop's
/// hash (§A.4). Field order pinned to the §0.3 contract.
fn write_agronomic_profile_stable_hash(w: &mut StateWriter, profile: &AgronomicProfile) {
    w.write_u32(u32::from(profile.growth_days_base))
        .write_u32(u32::from(profile.water_need_milli))
        .write_u32(profile.yield_base)
        .write_u32(u32::from(profile.hardiness_milli))
        .write_u32(u32::from(profile.season_affinity))
        .write_u32(u32::from(profile.off_season_penalty_milli))
        .write_u32(u32::from(profile.storm_resistance_milli))
        .write_u32(u32::from(profile.blight_resistance_milli))
        .write_u32(u32::from(profile.regrowth_days))
        .write_u32(u32::from(profile.tile_footprint))
        .write_u32(u32::from(profile.quality_potential_milli));
}
