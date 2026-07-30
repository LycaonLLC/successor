//! Stateful farming acceptance suite (§C.10 W1-W3 names + the full arc). Pure
//! growth math lives in growth.rs tests; parcel geometry in farm_model.rs tests.
//! These exercise the command path + lazy settle + the hash ceremony end to end.
#![cfg(test)]
use super::*;
use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};

const SEED_ITEM: u32 = CROP_ASHGRAIN_ITEM_ID; // Ashgrain seed band

fn farm_test_state() -> (SliceAuthorityConfig, SliceAuthorityState) {
    let snapshot = crate::authority_test_slice();
    let config = SliceAuthorityConfig::default(); // player_actor_id = "player", session/player 1
    let mut state = SliceAuthorityState::from_snapshot(&snapshot).unwrap();
    // Expand the overworld so every lot tier fits; isolate placement confounders so
    // claim gates are deterministic (tests add their own POI/road/overlap probes).
    if let Some(area) = state.areas.get_mut(crate::AUTHORITY_TEST_AREA_ID) {
        area.width = 1_025;
        area.height = 1_025;
    }
    state.blocked_cells.clear();
    state.clone_facilities.clear();
    state.transitions.clear();
    // DEV day-length for accelerated growth (F-Time override).
    state.set_farm_real_seconds_per_game_day(300); // dev day-length (F-Time §H)
    seed_credits(&mut state, "player", 100_000);
    (config, state)
}

fn seed_credits(state: &mut SliceAuthorityState, actor_id: &str, amount: u64) {
    state
        .runtime
        .durable
        .actors
        .get_mut(actor_id)
        .expect("credit recipient exists")
        .professions
        .credits = amount;
}

/// Intern a known fertile Ashgrain landrace and grant a plantable stack.
/// Returns (container, stack_id, genome_handle). Fail-closed plant requires a real handle.
fn seed_seeds(state: &mut SliceAuthorityState, actor_id: &str, qty: u32) -> (String, String, u32) {
    let handle = intern_loop_genome(state, "Homestead", 0);
    state.add_actor_inventory_stack(
        actor_id,
        SEED_ITEM,
        handle,
        "Ashgrain Seed",
        qty,
        BIO_SEED_STACK_CAP,
        "seed-pouch",
    );
    let row = state
        .runtime
        .durable
        .inventory
        .iter()
        .find(|r| r.item_id == SEED_ITEM && r.variant_id == handle)
        .expect("seed stack exists");
    (row.container.clone(), row.stack_id.to_string(), handle)
}

fn seed_sprinkler(state: &mut SliceAuthorityState, actor_id: &str) {
    state.add_actor_inventory_stack(
        actor_id,
        IRRIGATION_SPRINKLER_ITEM_ID,
        0,
        "Irrigation Sprinkler",
        1,
        FARM_STRUCTURE_STACK_CAP,
        "field-pack",
    );
}

fn envelope(id: u64, command: ClientCommand) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: SessionId(1),
        player: PlayerId(1),
        command_id: id,
        issued_at_tick: 0,
        command,
    }
}

fn claim(planet: &str, x: i32, y: i32, tier: &str) -> ClientCommand {
    ClientCommand::ClaimParcel {
        planet_id: planet.to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        x,
        y,
        tier: tier.to_owned(),
    }
}

fn move_to(state: &mut SliceAuthorityState, cell: AuthorityCell) {
    let actor = state
        .runtime
        .durable
        .actors
        .get_mut("player")
        .expect("player");
    actor.cell = cell;
    actor.position = AuthorityPosition::from_cell(cell);
}

// ── W1: CLAIM GATES ─────────────────────────────────────────────────────────
#[test]
fn parcel_claim_mints_a_parcel_and_spends_credits() {
    let (config, mut state) = farm_test_state();
    let before = state.actors["player"].professions.credits;
    let frame = state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.parcels.len(), 1);
    let after = state.actors["player"].professions.credits;
    assert_eq!(
        before - after,
        ParcelTier::Homestead.claim_price_credits(),
        "claim spends the tier's scalar credit price"
    );
}

#[test]
fn parcel_claim_global_limits_and_over_cap() {
    let (config, mut state) = farm_test_state();

    // 1. First and second claims succeed on same planet
    let frame1 = state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    assert_eq!(frame1.status, AuthorityCommandStatus::Accepted);

    let frame2 = state.apply_envelope(
        &config,
        envelope(2, claim("planet-a", 100, 100, "homestead")),
    );
    assert_eq!(frame2.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.parcels.len(), 2);

    // 2. Third rejects parcel_limit_reached
    let frame3 = state.apply_envelope(
        &config,
        envelope(3, claim("planet-a", 200, 200, "homestead")),
    );
    assert_eq!(frame3.status, AuthorityCommandStatus::Rejected);
    assert_eq!(frame3.reason_code.as_deref(), Some("parcel_limit_reached"));

    // Verify claims across planets count together:
    let (config, mut state) = farm_test_state();
    let frame1 = state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    assert_eq!(frame1.status, AuthorityCommandStatus::Accepted);

    let frame2 = state.apply_envelope(
        &config,
        envelope(2, claim("planet-b", 100, 100, "homestead")),
    );
    assert_eq!(frame2.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.parcels.len(), 2);

    let frame3 = state.apply_envelope(
        &config,
        envelope(3, claim("planet-b", 200, 200, "homestead")),
    );
    assert_eq!(frame3.status, AuthorityCommandStatus::Rejected);
    assert_eq!(frame3.reason_code.as_deref(), Some("parcel_limit_reached"));

    // 3. Abandon then claim succeeds
    let abandon = state.apply_envelope(
        &config,
        envelope(
            4,
            ClientCommand::AbandonParcel {
                parcel_id: "parcel:planet-a:1".to_owned(),
            },
        ),
    );
    assert_eq!(abandon.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.parcels.len(), 1);

    // Now claim succeeds:
    let frame4 = state.apply_envelope(
        &config,
        envelope(5, claim("planet-b", 200, 200, "homestead")),
    );
    assert_eq!(frame4.status, AuthorityCommandStatus::Accepted);
    assert_eq!(state.parcels.len(), 2);

    // 4. Preexisting over-cap state is not confiscated but new claim rejects
    // Let's manually inject a 3rd parcel for "player".
    let lot = derive_parcel_rects(ParcelTier::Homestead, 300, 300).0;
    let id = "parcel:planet-b:99".to_owned();
    let claimed_tick = state.tick;
    state.parcels.insert(
        id.clone(),
        ParcelAuthorityState {
            id,
            owner_character_id: "player".to_owned(),
            planet_id: "planet-b".to_owned(),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            name: "Homestead Claim".to_owned(),
            rect: lot,
            tier: ParcelTier::Homestead,
            build_zone: lot,
            farm_yard: lot,
            claimed_tick,
            upkeep_paid_through_tick: claimed_tick + 1000,
            rained_through_tick: 0,
            tiles: BTreeMap::new(),
            structures: BTreeMap::new(),
            build_components: BTreeMap::new(),
        },
    );
    assert_eq!(state.parcels.len(), 3);

    // Verify a new claim rejects:
    let frame5 = state.apply_envelope(
        &config,
        envelope(6, claim("planet-b", 400, 400, "homestead")),
    );
    assert_eq!(frame5.status, AuthorityCommandStatus::Rejected);
    assert_eq!(frame5.reason_code.as_deref(), Some("parcel_limit_reached"));

    // Check that all 3 preexisting parcels are still there:
    assert_eq!(state.parcels.len(), 3);
}

#[test]
fn parcel_claim_overlap_and_poi_buffer_rejected() {
    let (config, mut state) = farm_test_state();
    // First claim at (40,40) succeeds (Homestead -> [40,56)).
    assert_eq!(
        state
            .apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")))
            .status,
        AuthorityCommandStatus::Accepted
    );
    // Overlapping claim (different planet to isolate overlap from the 1/planet rule):
    // (48,48) is lattice-aligned -> [48,64) shares cells with [40,56) -> parcel_overlap.
    let overlap =
        state.apply_envelope(&config, envelope(2, claim("planet-b", 48, 48, "homestead")));
    assert_eq!(overlap.status, AuthorityCommandStatus::Rejected);
    assert_eq!(overlap.reason_code.as_deref(), Some("parcel_overlap"));
    // POI buffer: a clone facility near a fresh claim rejects (planet-b minted
    // nothing above, so the 1/planet rule does not pre-empt the buffer check).
    state.clone_facilities.push(CloneFacilityAuthorityState {
        id: "poi-1".to_owned(),
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        respawn_cell: AuthorityCell::new(201, 201),
        respawn_facing: "front".to_owned(),
        sickness_duration_ticks: 0,
    });
    let near_poi = state.apply_envelope(
        &config,
        envelope(3, claim("planet-b", 200, 200, "homestead")),
    );
    assert_eq!(near_poi.reason_code.as_deref(), Some("too_close_to_poi"));
}

#[test]
fn parcel_claim_direct_adjacency_allowed() {
    // Owner law: two claims may share an exact edge (the old forced setback GAP is
    // gone). The lattice makes it exact — a shared quantum CELL is overlap; a shared
    // EDGE is legal adjacency.
    let (config, mut state) = farm_test_state();
    assert_eq!(
        state
            .apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")))
            .status,
        AuthorityCommandStatus::Accepted
    );
    // (56,40): [56,72) shares only the x=56 border with [40,56) — not a shared cell.
    let adjacent =
        state.apply_envelope(&config, envelope(2, claim("planet-b", 56, 40, "homestead")));
    assert_eq!(
        adjacent.status,
        AuthorityCommandStatus::Accepted,
        "directly adjacent plots are legal ({:?})",
        adjacent.reason_code
    );
    assert_eq!(state.parcels.len(), 2);
    let xs: Vec<i32> = state.parcels.values().map(|p| p.rect.x).collect();
    assert!(
        xs.contains(&40) && xs.contains(&56),
        "lots at 40 and 56 share the x=56 border"
    );
}

#[test]
fn parcel_claim_snaps_origin_to_lattice() {
    let (config, mut state) = farm_test_state();
    // Off-lattice request (43,45) rounds to the nearest node (40,48).
    let frame = state.apply_envelope(&config, envelope(1, claim("planet-a", 43, 45, "homestead")));
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let receipt = frame.parcel_claim.expect("claim receipt VM");
    assert_eq!((receipt.requested_x, receipt.requested_y), (43, 45));
    assert_eq!((receipt.snapped_x, receipt.snapped_y), (40, 48));
    assert!(
        receipt.snapped,
        "an off-lattice origin reports snapped=true"
    );
    assert_eq!(
        (receipt.rect.x, receipt.rect.y),
        (40, 48),
        "the lot is minted at the snapped origin"
    );
    // The parcel AOI reflects the snapped origin too (the FE reads rect from here).
    let parcel = state.parcels.values().next().unwrap();
    assert_eq!((parcel.rect.x, parcel.rect.y), (40, 48));
    // An already-aligned origin is idempotent (snapped=false).
    let frame2 = state.apply_envelope(&config, envelope(2, claim("planet-b", 80, 80, "homestead")));
    let r2 = frame2.parcel_claim.expect("receipt");
    assert!(!r2.snapped, "an aligned origin is not re-snapped");
    assert_eq!((r2.snapped_x, r2.snapped_y), (80, 80));
}

#[test]
fn parcel_claim_central_no_claim_zone_rejected() {
    let (config, mut state) = farm_test_state();
    // A central hub square [400,600) (lattice-aligned) — the §B exclusion.
    state.no_claim_zones.push(NoClaimZoneAuthorityState {
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        rect: lattice_align_outward(&AuthorityRect::new(400, 400, 200, 200)),
        label: "hub".to_owned(),
    });
    // Inside the zone -> no_claim_zone (distinct from POI/road).
    let inside = state.apply_envelope(
        &config,
        envelope(1, claim("planet-a", 496, 496, "homestead")),
    );
    assert_eq!(inside.reason_code.as_deref(), Some("no_claim_zone"));
    // Outside the zone -> accepted (the frontier is claimable).
    let outside = state.apply_envelope(
        &config,
        envelope(2, claim("planet-b", 100, 100, "homestead")),
    );
    assert_eq!(outside.status, AuthorityCommandStatus::Accepted);
}

#[test]
fn no_deadzone_audit_holds_empty_and_after_claims_and_zones() {
    let (config, mut state) = farm_test_state();
    // Add a second player actor so we don't hit the 2-parcel cap when making 3 claims.
    let mut player_b = state.actors.get("player").unwrap().clone();
    player_b.id = "player_b".to_owned();
    state.actors.insert("player_b".to_owned(), player_b);
    seed_credits(&mut state, "player_b", 100_000);

    // Empty world: every free lattice cell is coverable by a Homestead — no sliver.
    let empty = state.audit_no_deadzone(crate::AUTHORITY_TEST_AREA_ID);
    assert!(
        empty.passed,
        "empty world has no deadzone: {:?}",
        empty.trapped_cells
    );
    assert!(empty.free_cells > 0 && empty.trapped_total == 0);
    // Add a lattice-aligned central zone + several claims; the invariant must still
    // hold (the complement of quantum-aligned rects is a union of quantum cells).
    state.no_claim_zones.push(NoClaimZoneAuthorityState {
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        rect: lattice_align_outward(&AuthorityRect::new(400, 400, 200, 200)),
        label: "hub".to_owned(),
    });
    for (i, (px, py)) in [(80, 80), (120, 200), (700, 700)].into_iter().enumerate() {
        let mut cfg = config.clone();
        if i >= 2 {
            cfg.player_actor_id = "player_b".to_owned();
        }
        let planet = format!("planet-{i}");
        assert_eq!(
            state
                .apply_envelope(
                    &cfg,
                    envelope(i as u64 + 1, claim(&planet, px, py, "plantation"))
                )
                .status,
            AuthorityCommandStatus::Accepted
        );
    }
    let after = state.audit_no_deadzone(crate::AUTHORITY_TEST_AREA_ID);
    assert!(
        after.passed,
        "claims + zone leave no deadzone: {:?}",
        after.trapped_cells
    );
}

#[test]
fn no_deadzone_audit_holds_at_10k_with_central_2km_zone() {
    // The target starter desert: 10240x10240 with a central ~2km (halfExtent 1024)
    // no-claim square. Resize post-build so we never pay the O(area) clearance build;
    // the audit itself is O(quantum cells) = 1280^2 and runs in well under a second.
    // Proves the lattice + exclusion give ZERO deadzone at ship scale.
    let (_config, mut state) = farm_test_state();
    {
        let area = state
            .areas
            .get_mut(crate::AUTHORITY_TEST_AREA_ID)
            .expect("overworld");
        area.width = 10_240;
        area.height = 10_240;
    }
    state.no_claim_zones.push(NoClaimZoneAuthorityState {
        area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
        rect: lattice_align_outward(&AuthorityRect::new(5120 - 1024, 5120 - 1024, 2048, 2048)),
        label: "Dustgate hub (2km)".to_owned(),
    });
    let report = state.audit_no_deadzone(crate::AUTHORITY_TEST_AREA_ID);
    assert_eq!(report.area_quantum_w, 1280);
    assert_eq!(report.area_quantum_h, 1280);
    assert!(
        report.passed,
        "10k desert + 2km central zone has NO deadzone (trapped {})",
        report.trapped_total
    );
    // Free = the full lattice minus the central 256x256-quantum zone.
    let zone_q: u64 = (2048 / 8) * (2048 / 8);
    assert_eq!(report.free_cells, 1280u64 * 1280 - zone_q);
}

#[test]
fn parcel_claim_road_buffer_rejected() {
    let (config, mut state) = farm_test_state();
    state.transitions.insert(
        "road-1".to_owned(),
        TransitionAuthorityState {
            id: "road-1".to_owned(),
            from_area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            from_cell: AuthorityCell::new(301, 301),
            trigger_size: crate::CellSizeSnapshot { w: 1, h: 1 },
            to_area_id: crate::AUTHORITY_TEST_INTERIOR_ID.to_owned(),
            to_cell: AuthorityCell::new(1, 1),
            to_facing: "front".to_owned(),
        },
    );
    let near_road = state.apply_envelope(
        &config,
        envelope(1, claim("planet-a", 300, 300, "homestead")),
    );
    assert_eq!(near_road.reason_code.as_deref(), Some("too_close_to_road"));
}

#[test]
fn parcel_claim_outside_housing_region_rejected() {
    let (config, mut state) = farm_test_state();
    // The interior area is a non-housing region (kind "public_interior").
    let interior = state.apply_envelope(
        &config,
        envelope(
            1,
            ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: crate::AUTHORITY_TEST_INTERIOR_ID.to_owned(),
                x: 2,
                y: 2,
                tier: "homestead".to_owned(),
            },
        ),
    );
    assert_eq!(
        interior.reason_code.as_deref(),
        Some("not_in_housing_region")
    );
}

#[test]
fn parcel_claim_requires_credits() {
    let (config, mut state) = farm_test_state();
    // Drain the wallet below the Homestead price.
    state
        .runtime
        .durable
        .actors
        .get_mut("player")
        .expect("player exists")
        .professions
        .credits = 100;
    let poor = state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    assert_eq!(poor.reason_code.as_deref(), Some("insufficient_credits"));
    assert!(state.parcels.is_empty(), "a rejected claim mints nothing");
}

#[test]
fn parcel_rename_and_abandon_owner_only_and_free_slot() {
    let (config, mut state) = farm_test_state();
    state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    let parcel_id = state.parcels.keys().next().unwrap().clone();
    // Rename (owner).
    state
        .apply_envelope(
            &config,
            envelope(
                2,
                ClientCommand::RenameParcel {
                    parcel_id: parcel_id.clone(),
                    name: "Test Parcel".to_owned(),
                },
            ),
        )
        .status
        .eq(&AuthorityCommandStatus::Accepted)
        .then_some(())
        .expect("owner rename accepted");
    assert_eq!(state.parcels[&parcel_id].name, "Test Parcel");
    // Non-owner rename rejected.
    let other = SliceAuthorityConfig {
        player_actor_id: "desert-warden-agent-guard-01".to_owned(),
        ..SliceAuthorityConfig::default()
    };
    if state.actors.contains_key("desert-warden-agent-guard-01") {
        let bad = state.apply_envelope(
            &other,
            envelope(
                3,
                ClientCommand::RenameParcel {
                    parcel_id: parcel_id.clone(),
                    name: "Hijack".to_owned(),
                },
            ),
        );
        assert_eq!(bad.reason_code.as_deref(), Some("not_parcel_owner"));
    }
    // Abandon frees the 1/planet slot.
    assert_eq!(
        state
            .apply_envelope(
                &config,
                envelope(
                    4,
                    ClientCommand::AbandonParcel {
                        parcel_id: parcel_id.clone()
                    }
                )
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    assert!(state.parcels.is_empty());
    assert_eq!(
        state
            .apply_envelope(&config, envelope(5, claim("planet-a", 40, 40, "homestead")))
            .status,
        AuthorityCommandStatus::Accepted,
        "slot freed => can reclaim on the same planet"
    );
}

// ── W2: TILE LIFECYCLE ────────────────────────────────────────────────────────
fn claim_and_stand(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
) -> (String, AuthorityCell) {
    state.apply_envelope(config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    let parcel_id = state.runtime.durable.parcels.keys().next().unwrap().clone();
    let yard = state.runtime.durable.parcels[&parcel_id].farm_yard;
    let cell = AuthorityCell::new(yard.x + 1, yard.y + 1);
    move_to(state, cell);
    (parcel_id, cell)
}

#[test]
fn tile_lifecycle_till_plant_clear_and_gates() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 3);

    // Till outside the yard -> rejected.
    let outside = AuthorityCell::new(
        state.parcels[&parcel_id].rect.x,
        state.parcels[&parcel_id].rect.y,
    );
    move_to(&mut state, outside);
    assert_eq!(
        state
            .apply_till_tile(&config, &parcel_id, outside.x, outside.y)
            .unwrap_err()
            .code(),
        "outside_farm_yard"
    );
    move_to(&mut state, cell);

    // Plant before till -> tile_not_tilled.
    assert_eq!(
        state
            .apply_plant_seed(
                &config,
                &parcel_id,
                cell.x,
                cell.y,
                &container,
                &stack_id,
                seed_handle
            )
            .unwrap_err()
            .code(),
        "tile_not_tilled"
    );
    // Till.
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    // Double till -> tile_already_tilled.
    assert_eq!(
        state
            .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap_err()
            .code(),
        "tile_already_tilled"
    );
    // Plant (consumes 1 seed).
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    assert!(state.parcels[&parcel_id].tiles[&tile_cell_key(cell)]
        .crop
        .is_some());
    // Plant on occupied -> tile_occupied.
    assert_eq!(
        state
            .apply_plant_seed(
                &config,
                &parcel_id,
                cell.x,
                cell.y,
                &container,
                &stack_id,
                seed_handle
            )
            .unwrap_err()
            .code(),
        "tile_occupied"
    );
    // Clear removes the crop, keeps soil tilled (dry).
    state
        .apply_clear_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    let tile = &state.parcels[&parcel_id].tiles[&tile_cell_key(cell)];
    assert!(tile.tilled && tile.crop.is_none());
    // On the now-empty tilled tile, planting with an unowned stack -> seed_not_owned.
    assert_eq!(
        state
            .apply_plant_seed(&config, &parcel_id, cell.x, cell.y, "nope", "999", 7)
            .unwrap_err()
            .code(),
        "seed_not_owned"
    );
}

// ── W3: GROWTH ARC (acceptance) ───────────────────────────────────────────────
#[test]
fn full_growth_arc_matures_to_harvestable_state() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let maturity =
        maturity_milli_days(&state.parcels[&parcel_id].tiles[&key].crop.unwrap().profile);
    let growth_days = maturity / u64::from(MILLI); // stub 6_001 => 4
    let plant_tick = state.tick;
    let tpd = state.farm_ticks_per_game_day();
    // Water at plant, then water each game-day: watered-day growth advances +1000/day.
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    for day in 1..=growth_days {
        state.tick = plant_tick + day * tpd;
        state
            .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
    }
    // Stored state: matured, no progress lost.
    let crop = state.parcels[&parcel_id].tiles[&key].crop.unwrap();
    assert_eq!(crop.accumulated_growth_days_milli, maturity);
    assert!(is_mature(crop.accumulated_growth_days_milli, &crop.profile));
    // Oracle: the farmPlot channel shows the crop harvestable (mature, no ETA).
    let plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("owner plot");
    let tile_vm = plot
        .tiles
        .iter()
        .find(|t| t.cell_x == cell.x && t.cell_y == cell.y)
        .unwrap();
    let crop_vm = tile_vm.crop.as_ref().unwrap();
    assert!(crop_vm.mature, "oracle shows harvestable");
    assert_eq!(crop_vm.stage, (NUM_VISUAL_STAGES - 1) as u8);
    assert_eq!(crop_vm.time_to_mature_game_days, None);
    assert_eq!(crop_vm.health, "vigorous");
}

#[test]
fn water_revives_dormant_crop_from_saved_progress() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    // Keep upkeep paid throughout so ONLY dormancy (drought) pauses growth — upkeep
    // lapse is a separate pause tested by upkeep_lapse_pauses_growth_and_payment_resumes.
    state
        .parcels
        .get_mut(&parcel_id)
        .unwrap()
        .upkeep_paid_through_tick = u64::MAX;
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let tpd = state.farm_ticks_per_game_day();
    let plant_tick = state.tick;
    // Water once, grow one day, then neglect a long time (offline).
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state.tick = plant_tick + tpd;
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    let progress = state.parcels[&parcel_id].tiles[&key]
        .crop
        .unwrap()
        .accumulated_growth_days_milli;
    assert!(progress > 0);
    // 100 game-days offline -> settle. The last watering funds one more growth day
    // before the crop dries and goes dormant; progress is never LOST (>=), only paused.
    state.tick = plant_tick + 100 * tpd;
    state.settle_tile(&parcel_id, &key);
    let dormant_crop = state.parcels[&parcel_id].tiles[&key].crop.unwrap();
    assert!(is_dormant(
        dormant_crop.drought_days,
        dormant_crop.profile.hardiness_milli
    ));
    assert!(
        dormant_crop.accumulated_growth_days_milli >= progress,
        "dormancy never loses progress"
    );
    let saved = dormant_crop.accumulated_growth_days_milli;
    // Water revives: drought resets, next day resumes growth from the SAVED progress.
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    assert_eq!(
        state.parcels[&parcel_id].tiles[&key]
            .crop
            .unwrap()
            .drought_days,
        0
    );
    state.tick = plant_tick + 101 * tpd;
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    // Authority truth: a watered day advances by full MILLI in-season, else the
    // genome off_season_penalty_milli. Recovery still resumes from SAVED progress.
    let profile = state.parcels[&parcel_id].tiles[&key].crop.unwrap().profile;
    let settled_day = game_day_index_for_tick(plant_tick + 100 * tpd, tpd);
    let day_growth = if in_season(
        profile.season_affinity,
        month_index_for_game_day(settled_day),
    ) {
        u64::from(MILLI)
    } else {
        u64::from(profile.off_season_penalty_milli)
    };
    assert_eq!(
        state.parcels[&parcel_id].tiles[&key]
            .crop
            .unwrap()
            .accumulated_growth_days_milli,
        saved + day_growth,
        "revived crop resumes from saved progress by one watered day"
    );
    assert!(day_growth > 0, "watered recovery day must advance growth");
}

#[test]
fn long_offline_settle_is_bounded_and_dormant() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let tpd = state.farm_ticks_per_game_day();
    // 50_000 game-days offline (far beyond the loop cap) must settle without hanging.
    state.tick += 50_000 * tpd;
    state.settle_tile(&parcel_id, &key);
    let crop = state.parcels[&parcel_id].tiles[&key].crop.unwrap();
    assert!(
        is_dormant(crop.drought_days, crop.profile.hardiness_milli),
        "long offline => dormant, recoverable"
    );
    // last_settle jumped to the last whole-day boundary (full catch-up, idempotent next time).
    let hash_a = state.stable_state_hash_hex();
    state.settle_tile(&parcel_id, &key);
    assert_eq!(
        state.stable_state_hash_hex(),
        hash_a,
        "re-settle at same tick is a no-op"
    );
}

#[test]
fn tend_plot_durable_intent_waters_then_breaks_on_stand() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    // Dry the tile.
    state
        .parcels
        .get_mut(&parcel_id)
        .unwrap()
        .tiles
        .get_mut(&key)
        .unwrap()
        .moisture_milli = 0;
    // Arm tending: first pass waters the dry tile immediately.
    state.apply_tend_plot(&config, &parcel_id, false).unwrap();
    assert!(state.plot_tending.contains_key("player"));
    assert_eq!(
        state.parcels[&parcel_id].tiles[&key].moisture_milli, MOISTURE_FULL_MILLI,
        "tend waters dry tiles"
    );
    // Force the kneel transition to settle so the cadence sees a kneeling tender.
    if let Some(actor) = state.actors.get_mut("player") {
        actor.posture = AuthorityActorPosture::Kneeling;
    }
    // Dry again + advance to the cadence -> the loop re-waters.
    state
        .parcels
        .get_mut(&parcel_id)
        .unwrap()
        .tiles
        .get_mut(&key)
        .unwrap()
        .moisture_milli = 0;
    state.tick += TEND_PLOT_CADENCE_TICKS;
    state.tick_plot_tending();
    assert_eq!(
        state.parcels[&parcel_id].tiles[&key].moisture_milli, MOISTURE_FULL_MILLI,
        "cadence re-waters"
    );
    // Stand up -> the loop self-clears next cadence.
    if let Some(actor) = state.actors.get_mut("player") {
        actor.posture = AuthorityActorPosture::Standing;
    }
    state.tick += TEND_PLOT_CADENCE_TICKS;
    state.tick_plot_tending();
    assert!(
        !state.plot_tending.contains_key("player"),
        "tending breaks on stand"
    );
}

#[test]
fn sprinkler_keeps_crop_growing_offline() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    seed_sprinkler(&mut state, "player");
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    // Place a sprinkler on the crop cell (covers it, radius 1).
    state
        .apply_place_farm_structure(
            &config,
            &parcel_id,
            IRRIGATION_SPRINKLER_ITEM_ID,
            cell.x,
            cell.y,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let maturity =
        maturity_milli_days(&state.parcels[&parcel_id].tiles[&key].crop.unwrap().profile);
    let tpd = state.farm_ticks_per_game_day();
    // NEVER water. Jump the full growth span offline; the sprinkler holds it watered.
    state.tick += (maturity / u64::from(MILLI) + 1) * tpd;
    state.settle_tile(&parcel_id, &key);
    let crop = state.parcels[&parcel_id].tiles[&key].crop.unwrap();
    assert_eq!(
        crop.accumulated_growth_days_milli, maturity,
        "sprinklered crop matures offline"
    );
    assert_eq!(crop.drought_days, 0, "never dry under a sprinkler");
}

// ── HASH CEREMONY + DETERMINISM (§0 ceremony, §C.10) ──────────────────────────
#[test]
fn parcel_and_tile_state_participate_in_stable_hash() {
    let (config, mut state) = farm_test_state();
    // Empty-parcel world hashes identically to the pre-farming era (empty-gated).
    let baseline = farm_test_state().1.stable_state_hash_hex();
    assert_eq!(state.stable_state_hash_hex(), baseline);
    // Claim changes the hash (parcels join it).
    state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    let after_claim = state.stable_state_hash_hex();
    assert_ne!(
        after_claim, baseline,
        "parcel state participates in the hash"
    );
    // Till + plant change it again (tiles + crops join it).
    let parcel_id = state.parcels.keys().next().unwrap().clone();
    let yard = state.parcels[&parcel_id].farm_yard;
    let cell = AuthorityCell::new(yard.x + 1, yard.y + 1);
    move_to(&mut state, cell);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    let after_till = state.stable_state_hash_hex();
    assert_ne!(
        after_till, after_claim,
        "tile state participates in the hash"
    );
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    assert_ne!(
        state.stable_state_hash_hex(),
        after_till,
        "crop state participates in the hash"
    );
}

#[test]
fn settle_is_idempotent_and_deterministic() {
    // Two identical states run the same script => identical final hash (determinism).
    let run = || {
        let (config, mut state) = farm_test_state();
        state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
        let parcel_id = state.parcels.keys().next().unwrap().clone();
        let yard = state.parcels[&parcel_id].farm_yard;
        let cell = AuthorityCell::new(yard.x + 1, yard.y + 1);
        move_to(&mut state, cell);
        let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
        state
            .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
        state
            .apply_plant_seed(
                &config,
                &parcel_id,
                cell.x,
                cell.y,
                &container,
                &stack_id,
                seed_handle,
            )
            .unwrap();
        let tpd = state.farm_ticks_per_game_day();
        let plant_tick = state.tick;
        state
            .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
        state.tick = plant_tick + 2 * tpd;
        state
            .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
        (state, parcel_id, cell)
    };
    let (state_a, parcel_a, cell_a) = run();
    let (state_b, _, _) = run();
    assert_eq!(
        state_a.stable_state_hash_hex(),
        state_b.stable_state_hash_hex(),
        "deterministic"
    );
    // Idempotence: re-settle at the same tick changes nothing.
    let mut state_a = state_a;
    let hash = state_a.stable_state_hash_hex();
    state_a.settle_tile(&parcel_a, &tile_cell_key(cell_a));
    assert_eq!(
        state_a.stable_state_hash_hex(),
        hash,
        "settle at same tick is a no-op"
    );
}

// ── UPKEEP (§F5: light sink; lapse pauses growth, never confiscates) ──────────
#[test]
fn upkeep_lapse_pauses_growth_and_payment_resumes() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let (container, stack_id, seed_handle) = seed_seeds(&mut state, "player", 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            seed_handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let tpd = state.farm_ticks_per_game_day();
    // Force the deed lapsed as of now (paid_through in the past).
    let plant_tick = state.tick;
    state
        .parcels
        .get_mut(&parcel_id)
        .unwrap()
        .upkeep_paid_through_tick = 0; // fully lapsed
                                       // Keep it watered via a sprinkler so ONLY upkeep-lapse can pause growth.
    seed_sprinkler(&mut state, "player");
    state
        .apply_place_farm_structure(
            &config,
            &parcel_id,
            IRRIGATION_SPRINKLER_ITEM_ID,
            cell.x,
            cell.y,
        )
        .unwrap();
    state.tick = plant_tick + 3 * tpd;
    state.settle_tile(&parcel_id, &key);
    assert_eq!(
        state.parcels[&parcel_id].tiles[&key]
            .crop
            .unwrap()
            .accumulated_growth_days_milli,
        0,
        "lapsed upkeep FREEZES growth (never dies)"
    );
    // Pay upkeep -> deed current -> growth resumes on the next settled days.
    assert_eq!(
        state
            .apply_envelope(
                &config,
                envelope(
                    99,
                    ClientCommand::PayUpkeep {
                        parcel_id: parcel_id.clone()
                    }
                )
            )
            .status,
        AuthorityCommandStatus::Accepted
    );
    let paid_tick = state.tick;
    state.tick = paid_tick + 2 * tpd;
    state.settle_tile(&parcel_id, &key);
    assert!(
        state.parcels[&parcel_id].tiles[&key]
            .crop
            .unwrap()
            .accumulated_growth_days_milli
            > 0,
        "paid deed resumes growth"
    );
}

// ── MULTI-TILE FOOTPRINT SEAM (§C.7; full giant-crop support deferred) ────────
#[test]
fn multi_tile_crop_requires_full_footprint_tilled() {
    // Footprint validation seam: a >1 footprint needs every covered cell tilled+empty.
    // (The stub genome is 1x1; real footprint>1 genomes arrive with BioECore's
    // registry, so full giant-crop planting lands then. This proves the check.)
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let farm_yard = state.parcels[&parcel_id].farm_yard;
    // A 2x2 footprint anchored at `cell` needs (cell)..(cell+1,+1) all tilled.
    let footprint = 0x22u8; // packed 2x2 (§C.7)
    assert!(
        !footprint_all_tilled_empty(&state.parcels[&parcel_id], cell, footprint),
        "untilled => not ready"
    );
    // Till only the anchor.
    let _ = config;
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    assert!(
        !footprint_all_tilled_empty(&state.parcels[&parcel_id], cell, footprint),
        "partial footprint => not ready"
    );
    // Till the whole 2x2 (staying inside the yard).
    for dy in 0..2 {
        for dx in 0..2 {
            let c = AuthorityCell::new(cell.x + dx, cell.y + dy);
            if farm_yard.contains_cell(c) {
                move_to(&mut state, c);
                let _ = state.apply_till_tile(&config, &parcel_id, c.x, c.y);
            }
        }
    }
    assert!(
        footprint_all_tilled_empty(&state.parcels[&parcel_id], cell, footprint),
        "full footprint tilled+empty"
    );
}

// ══════════════════════════════════════════════════════════════════════════════
// W4 FERTILIZE + W5 HARVEST + the LIVING LOOP (plant -> grow -> harvest -> replant)
// ══════════════════════════════════════════════════════════════════════════════

/// A controlled, in-season (First Cycle=month 0), fast, fertile Ashgrain genome with
/// lineage — interned so `mint_harvest_seed` returns true-breeding offspring (the
/// wild/stub paths would either roll a season or be sterile-uninterned).
fn intern_loop_genome(state: &mut SliceAuthorityState, cultivar: &str, generation: u16) -> u32 {
    let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
    loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800); // growth_days = 2 + 10*(1000-800)/1000 = 4
    loci[LOCUS_SEASON] = Locus::homozygous(100); // band 0 => bit0 (month 0 in-season); penalty high
    loci[LOCUS_QUALITY] = Locus::homozygous(700); // quality_potential 700
    loci[LOCUS_YIELD] = Locus::homozygous(500); // yield_base = 4 + 36*500/1000 = 22
    loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(0); // water_need 1000 (thirsty; water daily)
    loci[LOCUS_VIGOR] = Locus::homozygous(1_000); // high vigor => a fat offspring stack
    loci[LOCUS_REGROWTH] = Locus::homozygous(0); // single-harvest
    state.runtime.durable.crop_genomes.intern(Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage {
            breeder_id: "player".to_owned(),
            cultivar_name: cultivar.to_owned(),
            generation,
            parents: [11, 12],
        },
    })
}

fn grant_seed_handle(state: &mut SliceAuthorityState, handle: u32, qty: u32) -> (String, String) {
    state.add_actor_inventory_stack(
        "player",
        CROP_ASHGRAIN_ITEM_ID,
        handle,
        "Ashgrain Seed",
        qty,
        BIO_SEED_STACK_CAP,
        "seed-pouch",
    );
    let row = state
        .runtime
        .durable
        .inventory
        .iter()
        .find(|r| r.item_id == CROP_ASHGRAIN_ITEM_ID && r.variant_id == handle)
        .expect("seed stack exists");
    (row.container.clone(), row.stack_id.to_string())
}

/// Grow a planted crop to maturity by watering each dev game-day. Returns the
/// tick at maturity. Panics if the crop is not mature after growth_days+2 days.
fn grow_to_mature(
    state: &mut SliceAuthorityState,
    config: &SliceAuthorityConfig,
    parcel_id: &str,
    cell: AuthorityCell,
) {
    let key = tile_cell_key(cell);
    let profile = state.runtime.durable.parcels[parcel_id].tiles[&key]
        .crop
        .unwrap()
        .profile;
    let growth_days = maturity_milli_days(&profile) / u64::from(MILLI);
    let tpd = state.farm_ticks_per_game_day();
    let plant_tick = state.runtime.durable.tick;
    state
        .apply_water_tile(config, parcel_id, cell.x, cell.y)
        .unwrap();
    for day in 1..=(growth_days + 2) {
        state.runtime.durable.tick = plant_tick + day * tpd;
        state
            .apply_water_tile(config, parcel_id, cell.x, cell.y)
            .unwrap();
    }
    let crop = state.runtime.durable.parcels[parcel_id].tiles[&key]
        .crop
        .unwrap();
    assert!(
        is_mature(crop.accumulated_growth_days_milli, &crop.profile),
        "grow_to_mature: crop must mature"
    );
}

#[test]
fn artifact_plant_seed_projects_exact_tile_genome_species_inventory_and_water() {
    let (config, mut state) = farm_test_state();
    assert_eq!(
        state
            .apply_envelope(&config, envelope(1, claim("ashvat", 800, 800, "homestead")))
            .status,
        AuthorityCommandStatus::Accepted,
    );
    let parcel_id = "parcel:ashvat:1".to_owned();
    let cell = AuthorityCell::new(804, 808);
    assert!(
        state.parcels[&parcel_id].farm_yard.contains_cell(cell),
        "artifact cell belongs to the claimed farm yard"
    );
    move_to(&mut state, cell);

    let genome_handle = intern_loop_genome(&mut state, "Ashvat", 0);
    assert_eq!(
        genome_handle, 1,
        "artifact seed variant is the first interned genome handle"
    );
    state.add_actor_inventory_stack(
        "player",
        CROP_ASHGRAIN_ITEM_ID,
        genome_handle,
        "Ashgrain Seed",
        2,
        BIO_SEED_STACK_CAP,
        "field-pack",
    );
    let seed_row = state
        .inventory
        .iter()
        .find(|row| {
            row.container == "player:field-pack"
                && row.item_id == CROP_ASHGRAIN_ITEM_ID
                && row.variant_id == genome_handle
        })
        .expect("artifact-shaped seed stack exists");
    let (container, stack_id) = (seed_row.container.clone(), seed_row.stack_id.to_string());
    let inventory_before =
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, genome_handle);
    let projected = state
        .project_agronomic_for_seed(CROP_ASHGRAIN_ITEM_ID, genome_handle)
        .expect("known genome projects");

    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &container,
            &stack_id,
            genome_handle,
        )
        .unwrap();

    let crop = state.parcels[&parcel_id].tiles[&tile_cell_key(cell)]
        .crop
        .expect("crop is stored at the requested cell");
    assert_eq!(crop.seed_item_id, CROP_ASHGRAIN_ITEM_ID);
    assert_eq!(
        crop.seed_variant_id, genome_handle,
        "stored crop retains the supplied genome handle"
    );
    assert_eq!(
        crop.profile, projected,
        "planting caches the supplied genome's agronomic profile"
    );
    assert_eq!(
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, genome_handle),
        inventory_before - 1,
        "only the selected seed stack is debited"
    );

    let plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("owner farm plot");
    let tile = plot
        .tiles
        .iter()
        .find(|tile| tile.cell_x == 804 && tile.cell_y == 808)
        .expect("oracle projects the exact artifact cell");
    let crop_vm = tile
        .crop
        .as_ref()
        .expect("oracle projects the planted crop");
    assert_eq!(crop_vm.seed_item_id, 6001);
    assert_eq!(crop_vm.seed_variant_id, 1);
    assert_eq!(
        crop_vm.species, "ashgrain",
        "farm projection emits the canonical species key"
    );

    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    let watered_plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("owner farm plot after water");
    let watered = watered_plot
        .tiles
        .iter()
        .find(|tile| tile.cell_x == 804 && tile.cell_y == 808)
        .expect("water predicate sees the planted cell");
    assert!(
        watered.moisture_pct > 0,
        "water predicate remains compatible with the projected planted tile"
    );
    assert_eq!(
        watered.crop.as_ref().map(|crop| (
            crop.seed_item_id,
            crop.seed_variant_id,
            crop.species.as_str()
        )),
        Some((6001, 1, "ashgrain"))
    );
}

#[test]
fn full_loop_harvest_mints_produce_and_offspring_then_replants() {
    // THE LIVING LOOP: claim -> till -> plant (real fertile genome) -> water ->
    // grow -> HARVEST (produce + true-breeding offspring seeds) -> REPLANT the
    // offspring -> a second generation grows. The owner's dream, as an oracle.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let handle = intern_loop_genome(&mut state, "Kestrel", 2);
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 3);

    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    grow_to_mature(&mut state, &config, &parcel_id, cell);

    let produce_id = produce_item_id_for_species(CROP_ASHGRAIN_ITEM_ID);
    let produce_before = state.actor_inventory_available_quantity("player", produce_id);
    let seeds_before = state.actor_inventory_available_quantity("player", CROP_ASHGRAIN_ITEM_ID);

    // HARVEST through the real ingress so we exercise + assert the receipt VM.
    let frame = state.apply_envelope(
        &config,
        envelope(
            50,
            ClientCommand::HarvestCrop {
                parcel_id: parcel_id.clone(),
                cell_x: cell.x,
                cell_y: cell.y,
            },
        ),
    );
    assert_eq!(
        frame.status,
        AuthorityCommandStatus::Accepted,
        "harvest accepted: {:?}",
        frame.reason_code
    );
    let receipt = frame.harvest.expect("harvest emits a receipt VM");
    assert_eq!(receipt.cultivar_name, "Kestrel");
    assert_eq!(
        receipt.generation, 2,
        "receipt carries the parent lineage generation"
    );
    assert_eq!(receipt.produce_item_id, produce_id);
    assert!(receipt.produce_qty >= 1, "harvest mints produce");
    assert!(
        receipt.offspring_qty >= 1,
        "fertile crop mints offspring seeds"
    );
    assert_eq!(
        receipt.offspring_variant_id, handle,
        "true-breeding: offspring shares the parent handle"
    );
    assert!(!receipt.regrew, "single-harvest crop clears the tile");

    // Produce landed in the bag (6_1xx), quality-encoded to match tending.
    let produce_after = state.actor_inventory_available_quantity("player", produce_id);
    assert_eq!(
        produce_after - produce_before,
        receipt.produce_qty,
        "produce units are in inventory"
    );
    let produce_row = state
        .inventory
        .iter()
        .find(|r| r.item_id == produce_id)
        .expect("produce stack");
    assert_eq!(
        decode_produce_quality_milli(produce_row.variant_id),
        Some(receipt.produce_quality_milli),
        "produce variant encodes the harvested quality"
    );

    // Offspring seeds landed on the SAME handle (stackable, replant-able).
    let seeds_after = state.actor_inventory_available_quantity("player", CROP_ASHGRAIN_ITEM_ID);
    assert_eq!(
        seeds_after - seeds_before,
        receipt.offspring_qty,
        "offspring seeds are in the pouch"
    );
    assert!(
        state
            .crop_genomes
            .resolve(CROP_ASHGRAIN_ITEM_ID, handle)
            .is_some(),
        "offspring genome is replant-able"
    );

    // Tile returned to tilled-empty (§W5).
    let key = tile_cell_key(cell);
    let tile = &state.parcels[&parcel_id].tiles[&key];
    assert!(
        tile.tilled && tile.crop.is_none(),
        "tile is bare-tilled after final harvest"
    );

    // ── REPLANT the offspring -> a SECOND GENERATION grows. ──
    let (r_container, r_stack) = {
        let row = state
            .inventory
            .iter()
            .find(|r| {
                r.item_id == CROP_ASHGRAIN_ITEM_ID && r.variant_id == handle && r.available > 0
            })
            .expect("offspring seed to replant");
        (row.container.clone(), row.stack_id.to_string())
    };
    state
        .apply_plant_seed(
            &config,
            &parcel_id,
            cell.x,
            cell.y,
            &r_container,
            &r_stack,
            handle,
        )
        .unwrap();
    let tpd = state.farm_ticks_per_game_day();
    let replant_tick = state.tick;
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state.tick = replant_tick + tpd;
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    let gen2 = state.parcels[&parcel_id].tiles[&key]
        .crop
        .expect("2nd-gen crop planted");
    assert_eq!(
        gen2.seed_variant_id, handle,
        "2nd gen is the same true-breeding cultivar"
    );
    assert!(
        gen2.accumulated_growth_days_milli > 0,
        "the second generation is GROWING"
    );
}

#[test]
fn harvest_before_mature_is_rejected() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let handle = intern_loop_genome(&mut state, "Sprout", 0);
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    // Immature (no growth) -> crop_not_mature.
    assert_eq!(
        state
            .apply_harvest_crop(&config, &parcel_id, cell.x, cell.y)
            .unwrap_err()
            .code(),
        "crop_not_mature"
    );
    // Harvest on a tilled-but-empty tile -> tile_empty.
    state
        .apply_clear_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    assert_eq!(
        state
            .apply_harvest_crop(&config, &parcel_id, cell.x, cell.y)
            .unwrap_err()
            .code(),
        "tile_empty"
    );
}

#[test]
fn harvest_sterile_crop_yields_produce_but_no_seeds() {
    // The terminator economy live: a gene-locked (sterile) genome grows + yields
    // produce, but mint_harvest_seed returns None -> zero offspring.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
    loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800);
    loci[LOCUS_SEASON] = Locus::homozygous(100);
    let sterile = state.crop_genomes.intern(Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci,
        fertile: false,
        gene_lock: Some("rival-breeder".to_owned()),
        lineage: Lineage::wild("Locked".to_owned()),
    });
    let (container, stack_id) = grant_seed_handle(&mut state, sterile, 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, sterile,
        )
        .unwrap();
    grow_to_mature(&mut state, &config, &parcel_id, cell);
    let produce_id = produce_item_id_for_species(CROP_ASHGRAIN_ITEM_ID);
    let seeds_before = state.actor_inventory_available_quantity("player", CROP_ASHGRAIN_ITEM_ID);
    let frame = state.apply_envelope(
        &config,
        envelope(
            60,
            ClientCommand::HarvestCrop {
                parcel_id: parcel_id.clone(),
                cell_x: cell.x,
                cell_y: cell.y,
            },
        ),
    );
    let receipt = frame.harvest.expect("harvest receipt");
    assert!(
        receipt.produce_qty >= 1,
        "sterile crop still yields produce"
    );
    assert_eq!(
        receipt.offspring_qty, 0,
        "sterile crop mints NO seeds (terminator)"
    );
    assert!(state.actor_inventory_available_quantity("player", produce_id) >= 1);
    assert_eq!(
        state.actor_inventory_available_quantity("player", CROP_ASHGRAIN_ITEM_ID),
        seeds_before,
        "no offspring seeds added"
    );
}

#[test]
fn fertilize_speed_accelerates_growth() {
    // §C.4 speed line: +50% per watered day. Two watered in-season days on a
    // speed-fertilized tile == 3000 milli-days (vs 2000 unfertilized).
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let handle = intern_loop_genome(&mut state, "Swift", 0);
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 1);
    state.add_actor_inventory_stack(
        "player",
        FERTILIZER_SPEED_ITEM_ID,
        0,
        "Growth Tonic",
        3,
        FERTILIZER_STACK_CAP,
        "field-pack",
    );
    let (fc, fs) = {
        let row = state
            .inventory
            .iter()
            .find(|r| r.item_id == FERTILIZER_SPEED_ITEM_ID)
            .unwrap();
        (row.container.clone(), row.stack_id.to_string())
    };
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    state
        .apply_fertilize(&config, &parcel_id, cell.x, cell.y, &fc, &fs, 0)
        .unwrap();
    let key = tile_cell_key(cell);
    let tpd = state.farm_ticks_per_game_day();
    let plant_tick = state.tick;
    state
        .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    for day in 1..=2 {
        state.tick = plant_tick + day * tpd;
        state
            .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
    }
    let crop = state.parcels[&parcel_id].tiles[&key].crop.unwrap();
    assert_eq!(
        crop.accumulated_growth_days_milli, 3_000,
        "speed fert => +50%/day (2 days = 3000, not 2000)"
    );
}

#[test]
fn fertilize_yield_boosts_harvest_quantity_and_rejects_second_amendment() {
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let handle = intern_loop_genome(&mut state, "Bounty", 0);
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 1);
    state.add_actor_inventory_stack(
        "player",
        FERTILIZER_YIELD_ITEM_ID,
        0,
        "Yield Booster",
        2,
        FERTILIZER_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        FERTILIZER_SPEED_ITEM_ID,
        0,
        "Growth Tonic",
        1,
        FERTILIZER_STACK_CAP,
        "field-pack",
    );
    let yrow = {
        let r = state
            .inventory
            .iter()
            .find(|r| r.item_id == FERTILIZER_YIELD_ITEM_ID)
            .unwrap();
        (r.container.clone(), r.stack_id.to_string())
    };
    let srow = {
        let r = state
            .inventory
            .iter()
            .find(|r| r.item_id == FERTILIZER_SPEED_ITEM_ID)
            .unwrap();
        (r.container.clone(), r.stack_id.to_string())
    };
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    state
        .apply_fertilize(&config, &parcel_id, cell.x, cell.y, &yrow.0, &yrow.1, 0)
        .unwrap();
    // One kind per tile: a second amendment is rejected.
    assert_eq!(
        state
            .apply_fertilize(&config, &parcel_id, cell.x, cell.y, &srow.0, &srow.1, 0)
            .unwrap_err()
            .code(),
        "tile_already_fertilized"
    );
    grow_to_mature(&mut state, &config, &parcel_id, cell);
    let frame = state.apply_envelope(
        &config,
        envelope(
            70,
            ClientCommand::HarvestCrop {
                parcel_id: parcel_id.clone(),
                cell_x: cell.x,
                cell_y: cell.y,
            },
        ),
    );
    let receipt = frame.harvest.expect("receipt");
    // yield_base 22 * (1000+500)/1000 = 33.
    assert_eq!(
        receipt.produce_qty, 33,
        "yield fert multiplies harvest quantity (+50%)"
    );
}

#[test]
fn harvest_regrowth_perennial_resets_then_final_clears() {
    // A perennial (regrowth_days > 0) re-fruits PERENNIAL_HARVEST_TOTAL times,
    // keeping the crop + resetting progress, then the final harvest clears the tile.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
    loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800); // 4-day
    loci[LOCUS_SEASON] = Locus::homozygous(100);
    loci[LOCUS_REGROWTH] = Locus::homozygous(1_000); // perennial (regrowth_days > 0)
    let handle = state.crop_genomes.intern(Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage::wild("Perennial".to_owned()),
    });
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 1);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    let key = tile_cell_key(cell);
    let total = state.parcels[&parcel_id].tiles[&key]
        .crop
        .unwrap()
        .harvests_remaining;
    assert!(total > 1, "perennial plants with multiple harvests");
    let mut cmd = 80u64;
    for h in 0..total {
        grow_to_mature(&mut state, &config, &parcel_id, cell);
        cmd += 1;
        let frame = state.apply_envelope(
            &config,
            envelope(
                cmd,
                ClientCommand::HarvestCrop {
                    parcel_id: parcel_id.clone(),
                    cell_x: cell.x,
                    cell_y: cell.y,
                },
            ),
        );
        let receipt = frame.harvest.expect("receipt");
        let last = h == total - 1;
        assert_eq!(
            receipt.regrew, !last,
            "harvest {h}: regrew iff not the final one"
        );
        if last {
            assert!(
                state.parcels[&parcel_id].tiles[&key].crop.is_none(),
                "final harvest clears the crop"
            );
        } else {
            assert!(
                state.parcels[&parcel_id].tiles[&key].crop.is_some(),
                "perennial keeps growing"
            );
        }
    }
}

#[test]
fn unknown_seed_genome_fail_closed_does_not_plant_or_consume() {
    // No debug fallback: an unregistered handle is genome_unavailable and the
    // seed stack is left untouched (validate-before-consume).
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let unknown_handle = 42u32;
    assert!(
        state
            .crop_genomes
            .resolve(CROP_ASHGRAIN_ITEM_ID, unknown_handle)
            .is_none(),
        "fixture starts with no handle 42"
    );
    state.add_actor_inventory_stack(
        "player",
        CROP_ASHGRAIN_ITEM_ID,
        unknown_handle,
        "Ashgrain Seed",
        2,
        BIO_SEED_STACK_CAP,
        "seed-pouch",
    );
    let (container, stack_id) = {
        let row = state
            .inventory
            .iter()
            .find(|r| r.item_id == CROP_ASHGRAIN_ITEM_ID && r.variant_id == unknown_handle)
            .expect("unknown stack");
        (row.container.clone(), row.stack_id.to_string())
    };
    let before =
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, unknown_handle);
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    assert_eq!(
        state
            .project_agronomic_for_seed(CROP_ASHGRAIN_ITEM_ID, unknown_handle)
            .unwrap_err()
            .code(),
        "genome_unavailable"
    );
    assert_eq!(
        state
            .apply_plant_seed(
                &config,
                &parcel_id,
                cell.x,
                cell.y,
                &container,
                &stack_id,
                unknown_handle,
            )
            .unwrap_err()
            .code(),
        "genome_unavailable"
    );
    assert_eq!(
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, unknown_handle),
        before,
        "fail-closed plant must not consume the seed"
    );
    assert!(
        state.parcels[&parcel_id].tiles[&tile_cell_key(cell)]
            .crop
            .is_none(),
        "no phantom crop from unknown genome"
    );
}

#[test]
fn yield_trait_expression_changes_authority_harvest_qty() {
    // LOCUS_YIELD is material: higher expressed yield_base mints more produce.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell_low) = claim_and_stand(&mut state, &config);
    let yard = state.parcels[&parcel_id].farm_yard;
    let cell_high = AuthorityCell::new(yard.x + 2, yard.y + 1);
    move_to(&mut state, cell_high);
    state
        .apply_till_tile(&config, &parcel_id, cell_high.x, cell_high.y)
        .unwrap();
    move_to(&mut state, cell_low);
    state
        .apply_till_tile(&config, &parcel_id, cell_low.x, cell_low.y)
        .unwrap();

    let mk = |state: &mut SliceAuthorityState, name: &str, yield_milli: u16| {
        let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
        loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800);
        loci[LOCUS_SEASON] = Locus::homozygous(100);
        loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(0);
        loci[LOCUS_QUALITY] = Locus::homozygous(700);
        loci[LOCUS_VIGOR] = Locus::homozygous(500);
        loci[LOCUS_REGROWTH] = Locus::homozygous(0);
        loci[LOCUS_YIELD] = Locus::homozygous(yield_milli);
        state.crop_genomes.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage {
                breeder_id: "player".to_owned(),
                cultivar_name: name.to_owned(),
                generation: 1,
                parents: [0, 0],
            },
        })
    };
    let low = mk(&mut state, "Lean", 200); // yield_base 11
    let high = mk(&mut state, "Bountiful", 900); // yield_base 36
    assert_eq!(
        project_agronomic(state.crop_genomes.get(low).unwrap()).yield_base,
        11
    );
    assert_eq!(
        project_agronomic(state.crop_genomes.get(high).unwrap()).yield_base,
        36
    );

    for (cell, handle) in [(cell_low, low), (cell_high, high)] {
        let (c, s) = grant_seed_handle(&mut state, handle, 1);
        move_to(&mut state, cell);
        state
            .apply_plant_seed(&config, &parcel_id, cell.x, cell.y, &c, &s, handle)
            .unwrap();
    }
    grow_to_mature(&mut state, &config, &parcel_id, cell_low);
    grow_to_mature(&mut state, &config, &parcel_id, cell_high);

    let harvest = |state: &mut SliceAuthorityState, cmd: u64, cell: AuthorityCell| {
        let frame = state.apply_envelope(
            &config,
            envelope(
                cmd,
                ClientCommand::HarvestCrop {
                    parcel_id: parcel_id.clone(),
                    cell_x: cell.x,
                    cell_y: cell.y,
                },
            ),
        );
        assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
        frame.harvest.expect("receipt")
    };
    let low_r = harvest(&mut state, 200, cell_low);
    let high_r = harvest(&mut state, 201, cell_high);
    assert_eq!(low_r.produce_qty, 11, "low LOCUS_YIELD harvest qty");
    assert_eq!(high_r.produce_qty, 36, "high LOCUS_YIELD harvest qty");
    assert!(high_r.produce_qty > low_r.produce_qty);
    let produce_id = produce_item_id_for_species(CROP_ASHGRAIN_ITEM_ID);
    assert_eq!(
        state.actor_inventory_available_quantity("player", produce_id),
        low_r.produce_qty + high_r.produce_qty
    );
}

#[test]
fn hardiness_trait_extends_drought_resilience_before_dormancy() {
    // LOCUS_HARDINESS -> wither_grace_days: hardy crop stays non-dormant longer.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell_soft) = claim_and_stand(&mut state, &config);
    let yard = state.parcels[&parcel_id].farm_yard;
    let cell_hard = AuthorityCell::new(yard.x + 2, yard.y + 1);
    for cell in [cell_soft, cell_hard] {
        move_to(&mut state, cell);
        state
            .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
    }

    let mk = |state: &mut SliceAuthorityState, name: &str, hard: u16| {
        let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
        loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800);
        loci[LOCUS_SEASON] = Locus::homozygous(100);
        loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(0);
        loci[LOCUS_HARDINESS] = Locus::homozygous(hard);
        loci[LOCUS_REGROWTH] = Locus::homozygous(0);
        state.crop_genomes.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage::wild(name.to_owned()),
        })
    };
    let soft = mk(&mut state, "Soft", 0); // grace 2
    let hardy = mk(&mut state, "Hardy", 1_000); // grace 8
    assert_eq!(wither_grace_days(0), 2);
    assert_eq!(wither_grace_days(1_000), 8);

    for (cell, handle) in [(cell_soft, soft), (cell_hard, hardy)] {
        let (c, s) = grant_seed_handle(&mut state, handle, 1);
        move_to(&mut state, cell);
        state
            .apply_plant_seed(&config, &parcel_id, cell.x, cell.y, &c, &s, handle)
            .unwrap();
        state
            .apply_water_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
    }
    // Keep upkeep paid so only drought (not lapse) drives dormancy.
    state
        .parcels
        .get_mut(&parcel_id)
        .unwrap()
        .upkeep_paid_through_tick = u64::MAX;
    let tpd = state.farm_ticks_per_game_day();
    let start = state.tick;
    // Advance 5 dry game-days without watering; settle each tile into storage.
    state.tick = start + 5 * tpd;
    for cell in [cell_soft, cell_hard] {
        state.settle_tile(&parcel_id, &tile_cell_key(cell));
    }
    let soft_crop = state.parcels[&parcel_id].tiles[&tile_cell_key(cell_soft)]
        .crop
        .unwrap();
    let hard_crop = state.parcels[&parcel_id].tiles[&tile_cell_key(cell_hard)]
        .crop
        .unwrap();
    assert!(
        is_dormant(soft_crop.drought_days, soft_crop.profile.hardiness_milli),
        "soft crop dormant after 5 dry days (grace 2), drought={}",
        soft_crop.drought_days
    );
    assert!(
        !is_dormant(hard_crop.drought_days, hard_crop.profile.hardiness_milli),
        "hardy crop still resilient after 5 dry days (grace 8), drought={}",
        hard_crop.drought_days
    );
}

#[test]
fn yield_fertilizer_multiplies_genetic_yield_base() {
    // Additive x trait: yield fert multiplies the genome yield_base.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell_a) = claim_and_stand(&mut state, &config);
    let yard = state.parcels[&parcel_id].farm_yard;
    let cell_b = AuthorityCell::new(yard.x + 2, yard.y + 1);
    for cell in [cell_a, cell_b] {
        move_to(&mut state, cell);
        state
            .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
            .unwrap();
    }
    let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
    loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800);
    loci[LOCUS_SEASON] = Locus::homozygous(100);
    loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(0);
    loci[LOCUS_YIELD] = Locus::homozygous(500); // yield_base 22
    loci[LOCUS_REGROWTH] = Locus::homozygous(0);
    let handle = state.crop_genomes.intern(Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage::wild("Base22".to_owned()),
    });
    state.add_actor_inventory_stack(
        "player",
        FERTILIZER_YIELD_ITEM_ID,
        0,
        "Yield Booster",
        1,
        FERTILIZER_STACK_CAP,
        "field-pack",
    );
    let fert = {
        let r = state
            .inventory
            .iter()
            .find(|r| r.item_id == FERTILIZER_YIELD_ITEM_ID)
            .unwrap();
        (r.container.clone(), r.stack_id.to_string())
    };
    for cell in [cell_a, cell_b] {
        let (c, s) = grant_seed_handle(&mut state, handle, 1);
        move_to(&mut state, cell);
        state
            .apply_plant_seed(&config, &parcel_id, cell.x, cell.y, &c, &s, handle)
            .unwrap();
    }
    state
        .apply_fertilize(&config, &parcel_id, cell_b.x, cell_b.y, &fert.0, &fert.1, 0)
        .unwrap();
    grow_to_mature(&mut state, &config, &parcel_id, cell_a);
    grow_to_mature(&mut state, &config, &parcel_id, cell_b);
    let plain = state
        .apply_envelope(
            &config,
            envelope(
                400,
                ClientCommand::HarvestCrop {
                    parcel_id: parcel_id.clone(),
                    cell_x: cell_a.x,
                    cell_y: cell_a.y,
                },
            ),
        )
        .harvest
        .unwrap();
    let boosted = state
        .apply_envelope(
            &config,
            envelope(
                401,
                ClientCommand::HarvestCrop {
                    parcel_id: parcel_id.clone(),
                    cell_x: cell_b.x,
                    cell_y: cell_b.y,
                },
            ),
        )
        .harvest
        .unwrap();
    assert_eq!(plain.produce_qty, 22);
    assert_eq!(boosted.produce_qty, 33); // 22 * 1.5
}

#[test]
fn splice_minted_seed_plants_harvests_and_projects_both_clients() {
    // Completed splice child -> plantable persistent seed -> harvest expresses yield.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);

    let mut parent_loci = |y1: u16, y2: u16, name: &str| {
        let mut loci = [Locus::homozygous(600); GENOME_LOCUS_COUNT];
        loci[LOCUS_GROWTH_RATE] = Locus::homozygous(800);
        loci[LOCUS_SEASON] = Locus::homozygous(100);
        loci[LOCUS_WATER_ECONOMY] = Locus::homozygous(0);
        loci[LOCUS_QUALITY] = Locus::homozygous(700);
        loci[LOCUS_VIGOR] = Locus::homozygous(800);
        loci[LOCUS_REGROWTH] = Locus::homozygous(0);
        loci[LOCUS_HARDINESS] = Locus::homozygous(500);
        loci[LOCUS_YIELD] = Locus::new(y1, y2);
        loci[LOCUS_MUTATION_POTENTIAL] = Locus::homozygous(800);
        state.crop_genomes.intern(Genome {
            species_id: CROP_ASHGRAIN_ITEM_ID,
            loci,
            fertile: true,
            gene_lock: None,
            lineage: Lineage {
                breeder_id: "player".to_owned(),
                cultivar_name: name.to_owned(),
                generation: 0,
                parents: [0, 0],
            },
        })
    };
    let parent_a = parent_loci(200, 220, "LeanA");
    let parent_b = parent_loci(900, 920, "BountifulB");
    let parent_a_g = state.crop_genomes.get(parent_a).unwrap().clone();
    let parent_b_g = state.crop_genomes.get(parent_b).unwrap().clone();

    let mut choices = BTreeMap::new();
    choices.insert(LOCUS_YIELD as u8, (Some(1u8), Some(1u8)));
    let ctx = SpliceContext {
        splice_skill_bonus: 50,
        splicing_tier: 5,
        is_master: true,
        splicer_tool_q: 1_000,
        reagent_potency: [1_000, 1_000, 1_000, 1_000],
    };
    let (child_alleles, lines, assembly_q, points, gain) =
        splice_assemble_core(&parent_a_g, &parent_b_g, &choices, &ctx);
    assert!(points >= 1, "master context yields experiment points");
    let mut session = SpliceSessionState::new(CROP_ASHGRAIN_ITEM_ID);
    session.phase = SpliceSessionPhase::Assembled;
    session.parent_handles = [parent_a, parent_b];
    session.child_generation = 1;
    session.child_alleles = child_alleles;
    session.lines = lines;
    session.assembly_quality_milli = assembly_q;
    session.points_total = points;
    session.points_remaining = points;
    session.gain_per_point = gain;
    if let Some(line) = session
        .lines
        .iter_mut()
        .find(|l| l.locus == LOCUS_YIELD as u8)
    {
        let spend = session.points_remaining;
        line.value_milli = splice_experiment_value(line.base_milli, line.cap_milli, spend, gain);
        session.points_remaining = 0;
    }
    let lifted = splice_mint_alleles(&session);
    let mut loci = [Locus::homozygous(0); GENOME_LOCUS_COUNT];
    for (i, locus) in lifted.into_iter().enumerate() {
        loci[i] = locus;
    }
    let child_genome = Genome {
        species_id: CROP_ASHGRAIN_ITEM_ID,
        loci,
        fertile: true,
        gene_lock: None,
        lineage: Lineage {
            breeder_id: "player".to_owned(),
            cultivar_name: "CrossYield".to_owned(),
            generation: 1,
            parents: [parent_a, parent_b],
        },
    };
    let child_profile = project_agronomic(&child_genome);
    assert!(
        child_profile.yield_base > 11,
        "spliced child must beat lean yield_base, got {}",
        child_profile.yield_base
    );
    let child_handle = state.crop_genomes.intern(child_genome);
    state.add_actor_inventory_stack(
        "player",
        CROP_ASHGRAIN_ITEM_ID,
        child_handle,
        "Ashgrain Seed",
        2,
        BIO_SEED_STACK_CAP,
        "field-pack",
    );
    let seeds_before =
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, child_handle);

    // Restart: registry + inventory + hash survive export/import.
    let hash_before = state.stable_state_hash_hex();
    let exported = state.export_checkpoint();
    let mut restored = state.clone();
    restored.restore_checkpoint(exported).unwrap();
    let mut state = restored;
    assert_eq!(state.stable_state_hash_hex(), hash_before);
    assert!(state
        .crop_genomes
        .resolve(CROP_ASHGRAIN_ITEM_ID, child_handle)
        .is_some());

    let (c, s) = {
        let row = state
            .inventory
            .iter()
            .find(|r| {
                r.item_id == CROP_ASHGRAIN_ITEM_ID
                    && r.variant_id == child_handle
                    && r.available > 0
            })
            .expect("spliced seed");
        (row.container.clone(), row.stack_id.to_string())
    };
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(&config, &parcel_id, cell.x, cell.y, &c, &s, child_handle)
        .unwrap();
    assert_eq!(
        state.actor_inventory_available_variant("player", CROP_ASHGRAIN_ITEM_ID, child_handle),
        seeds_before - 1
    );
    let crop = state.parcels[&parcel_id].tiles[&tile_cell_key(cell)]
        .crop
        .expect("planted");
    assert_eq!(crop.seed_variant_id, child_handle);
    assert_eq!(crop.profile.yield_base, child_profile.yield_base);

    grow_to_mature(&mut state, &config, &parcel_id, cell);
    let owner_plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("owner plot");
    let owner_crop = owner_plot
        .tiles
        .iter()
        .find(|t| t.cell_x == cell.x && t.cell_y == cell.y)
        .and_then(|t| t.crop.as_ref())
        .expect("owner crop");
    assert!(owner_crop.mature);
    assert_eq!(owner_crop.seed_variant_id, child_handle);
    assert_eq!(owner_crop.species, "ashgrain");

    // Both-client generic projection: owner multi-observer path + a second actor
    // colocated on the crop cell must see the same species/handle/mature identity.
    let owner_multi = state.farm_plot_snapshots_for_observer(&config);
    assert!(
        owner_multi.iter().any(|plot| {
            plot.parcel_id == parcel_id
                && plot.tiles.iter().any(|t| {
                    t.cell_x == cell.x
                        && t.cell_y == cell.y
                        && t.crop.as_ref().is_some_and(|c| {
                            c.seed_variant_id == child_handle && c.species == "ashgrain" && c.mature
                        })
                })
        }),
        "owner multi-observer path projects the splice crop"
    );
    if let Some(other) = state
        .actors
        .keys()
        .find(|id| id.as_str() != "player")
        .cloned()
    {
        let parcel_area_id = state.parcels[&parcel_id].area_id.clone();
        if let Some(actor) = state.actors.get_mut(&other) {
            actor.cell = cell;
            actor.position = AuthorityPosition::from_cell(cell);
            actor.area_id = parcel_area_id;
        }
        let other_config = SliceAuthorityConfig {
            player_actor_id: other,
            ..config.clone()
        };
        let plots = state.farm_plot_snapshots_for_observer(&other_config);
        assert!(
            plots.iter().any(|plot| {
                plot.parcel_id == parcel_id
                    && plot.tiles.iter().any(|t| {
                        t.cell_x == cell.x
                            && t.cell_y == cell.y
                            && t.crop.as_ref().is_some_and(|c| {
                                c.seed_variant_id == child_handle
                                    && c.species == "ashgrain"
                                    && c.mature
                            })
                    })
            }),
            "second client projects the same splice crop"
        );
    }

    let hash_pre = state.stable_state_hash_hex();
    let frame = state.apply_envelope(
        &config,
        envelope(
            300,
            ClientCommand::HarvestCrop {
                parcel_id: parcel_id.clone(),
                cell_x: cell.x,
                cell_y: cell.y,
            },
        ),
    );
    assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
    let receipt = frame.harvest.expect("receipt");
    assert_eq!(receipt.cultivar_name, "CrossYield");
    assert_eq!(receipt.generation, 1);
    assert_eq!(receipt.produce_qty, child_profile.yield_base);
    assert!(receipt.offspring_qty >= 1);
    assert_eq!(receipt.offspring_variant_id, child_handle);
    assert_ne!(state.stable_state_hash_hex(), hash_pre);

    let post = state.stable_state_hash_hex();
    let checkpoint = state.export_checkpoint();
    let mut again = state.clone();
    again.restore_checkpoint(checkpoint).unwrap();
    assert_eq!(again.stable_state_hash_hex(), post);
    assert_eq!(
        project_agronomic(
            again
                .crop_genomes
                .resolve(CROP_ASHGRAIN_ITEM_ID, child_handle)
                .unwrap()
        )
        .yield_base,
        child_profile.yield_base
    );
}

#[test]
fn harvest_and_fertilizer_participate_in_stable_hash() {
    // Ceremony: fertilizer + the harvest mutation are stored state -> they move the hash.
    let (config, mut state) = farm_test_state();
    let (parcel_id, cell) = claim_and_stand(&mut state, &config);
    let handle = intern_loop_genome(&mut state, "HashCrop", 0);
    let (container, stack_id) = grant_seed_handle(&mut state, handle, 2);
    state.add_actor_inventory_stack(
        "player",
        FERTILIZER_QUALITY_ITEM_ID,
        0,
        "Quality Compost",
        1,
        FERTILIZER_STACK_CAP,
        "field-pack",
    );
    let frow = {
        let r = state
            .inventory
            .iter()
            .find(|r| r.item_id == FERTILIZER_QUALITY_ITEM_ID)
            .unwrap();
        (r.container.clone(), r.stack_id.to_string())
    };
    state
        .apply_till_tile(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    state
        .apply_plant_seed(
            &config, &parcel_id, cell.x, cell.y, &container, &stack_id, handle,
        )
        .unwrap();
    let before_fert = state.stable_state_hash_hex();
    state
        .apply_fertilize(&config, &parcel_id, cell.x, cell.y, &frow.0, &frow.1, 0)
        .unwrap();
    assert_ne!(
        state.stable_state_hash_hex(),
        before_fert,
        "fertilizer state participates in the hash"
    );
    grow_to_mature(&mut state, &config, &parcel_id, cell);
    let before_harvest = state.stable_state_hash_hex();
    state
        .apply_harvest_crop(&config, &parcel_id, cell.x, cell.y)
        .unwrap();
    assert_ne!(
        state.stable_state_hash_hex(),
        before_harvest,
        "harvest mutation participates in the hash"
    );
}

#[test]
fn building_authority_2x2_enclosure_door_refund_and_historical_roundtrip() {
    let (config, mut state) = farm_test_state();
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CREATURE_STRUCTURAL_ITEM_ID,
        0,
        "Structural",
        100,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    state.add_actor_inventory_stack(
        "player",
        RESOURCE_CHEMICAL_ITEM_ID,
        0,
        "Mechanical",
        10,
        RESOURCE_STACK_CAP,
        "field-pack",
    );
    let claim_frame =
        state.apply_envelope(&config, envelope(1, claim("planet-a", 40, 40, "homestead")));
    assert_eq!(claim_frame.status, AuthorityCommandStatus::Accepted);
    let parcel_id = state
        .parcels
        .keys()
        .next()
        .cloned()
        .expect("claimed parcel");
    let structural_before =
        state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_STRUCTURAL_ITEM_ID);
    for row in &mut state.inventory {
        if row.item_id == RESOURCE_CREATURE_STRUCTURAL_ITEM_ID
            && actor_owns_inventory_container("player", &row.container)
        {
            row.quantity = 1;
            row.available = 1;
            row.reserved = 0;
        }
    }
    let insufficient_before =
        state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_STRUCTURAL_ITEM_ID);
    assert_eq!(
        state.apply_build_place(&config, "floor_1x1", &parcel_id, 42, 42, 0, None),
        Err(AuthorityRejectReason::IngredientUnavailable)
    );
    assert_eq!(
        state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_STRUCTURAL_ITEM_ID),
        insufficient_before
    );
    for row in &mut state.inventory {
        if row.item_id == RESOURCE_CREATURE_STRUCTURAL_ITEM_ID
            && actor_owns_inventory_container("player", &row.container)
        {
            row.quantity = structural_before;
            row.available = structural_before;
        }
    }

    {
        let mut place = |catalog: &str, x: i32, y: i32, rotation: u8| {
            state
                .apply_build_place(&config, catalog, &parcel_id, x, y, rotation, None)
                .unwrap_or_else(|reason| {
                    panic!("place {catalog} at {x},{y} r{rotation}: {reason:?}")
                });
        };
        for (x, y) in [(42, 42), (43, 42), (42, 43), (43, 43)] {
            place("floor_1x1", x, y, 0);
            place("roof_1x1", x, y, 0);
        }
        for (x, y, rotation) in [
            (42, 42, 0),
            (43, 42, 0),
            (43, 42, 1),
            (43, 43, 1),
            (43, 43, 2),
            (42, 43, 2),
            (42, 42, 3),
            (42, 43, 3),
        ] {
            if x == 42 && y == 43 && rotation == 2 {
                place("door_slide_1m", x, y, rotation);
            } else {
                place("wall_1m", x, y, rotation);
            }
        }
    }
    assert_eq!(
        state.apply_build_place(&config, "floor_1x1", &parcel_id, 42, 42, 0, None),
        Err(AuthorityRejectReason::StructureFootprintBlocked)
    );
    let delta = state.build_delta_for_observer(&config);
    assert_eq!(
        delta
            .components
            .iter()
            .filter(|c| c.kind == "floor")
            .count(),
        4
    );
    assert_eq!(
        delta.components.iter().filter(|c| c.kind == "roof").count(),
        4
    );
    assert_eq!(
        delta.components.iter().filter(|c| c.kind == "wall").count(),
        7
    );
    assert_eq!(
        delta.components.iter().filter(|c| c.kind == "door").count(),
        1
    );
    let interior = delta
        .interiors
        .iter()
        .find(|region| region.parcel_id == parcel_id)
        .expect("2x2 interior");
    assert!(interior.enclosed && interior.roofed);

    let door_id = delta
        .components
        .iter()
        .find(|component| component.kind == "door")
        .unwrap()
        .component_id
        .clone();
    let blockers_closed = state
        .build_circle_blockers_for_area(crate::AUTHORITY_TEST_AREA_ID)
        .len();
    state.apply_build_toggle_door(&config, &door_id).unwrap();
    let blockers_open = state
        .build_circle_blockers_for_area(crate::AUTHORITY_TEST_AREA_ID)
        .len();
    assert_eq!(
        blockers_closed,
        blockers_open + 1,
        "closed door blocks its edge"
    );
    state.fine_collision_bounds.clear();
    state.door_collision_bounds.clear();
    let area = state
        .areas
        .get(crate::AUTHORITY_TEST_AREA_ID)
        .unwrap()
        .clone();
    let outside = state.clamped_unblocked_player_position(
        crate::AUTHORITY_TEST_AREA_ID,
        AuthorityPosition {
            x: 42_000,
            y: 43_000,
        },
        AuthorityPosition {
            x: 42_000,
            y: 45_000,
        },
        &area,
    );
    assert_eq!(
        outside,
        (AuthorityPosition {
            x: 42_000,
            y: 45_000
        }),
        "open door passes"
    );

    let other_actor = state
        .actors
        .keys()
        .find(|actor_id| actor_id.as_str() != "player")
        .unwrap()
        .clone();
    let other_config = SliceAuthorityConfig {
        player_actor_id: other_actor,
        ..config.clone()
    };
    assert_eq!(
        state.apply_build_remove(&other_config, &door_id),
        Err(AuthorityRejectReason::NotParcelOwner)
    );
    let wall_id = delta
        .components
        .iter()
        .find(|component| component.kind == "wall")
        .unwrap()
        .component_id
        .clone();
    let before_structural =
        state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_STRUCTURAL_ITEM_ID);
    state.apply_build_remove(&config, &wall_id).unwrap();
    let after_structural =
        state.actor_inventory_available_quantity("player", RESOURCE_CREATURE_STRUCTURAL_ITEM_ID);
    assert!(
        after_structural > before_structural,
        "wall removal refunds salvage"
    );
    assert!(
        !state
            .build_delta_for_observer(&config)
            .interiors
            .iter()
            .find(|region| region.parcel_id == parcel_id)
            .unwrap()
            .enclosed
    );

    let exported = state.export_checkpoint();
    let mut restored = state.clone();
    restored.restore_checkpoint(exported).unwrap();
    assert_eq!(
        restored.build_delta_for_observer(&config).components,
        state.build_delta_for_observer(&config).components
    );
}
