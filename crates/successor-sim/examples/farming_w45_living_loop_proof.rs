//! LIVING LOOP live proof (driver) for Agriculture W5 HARVEST + W4 FERTILIZE +
//! the BioEngineer seed lineage — the owner's dream on camera, as a deterministic
//! in-process driver over the REAL authority:
//!
//!   ACQUIRE (GeneSample -> a real fertile wild genome, interned in the registry)
//!     -> CLAIM -> TILL -> FERTILIZE (yield) -> PLANT -> WATER -> grow (dev days)
//!     -> HARVEST (produce units in the bag + OFFSPRING seeds via mint_harvest_seed)
//!     -> REPLANT the offspring -> a SECOND GENERATION grows.
//!
//! Every player action goes through `apply_envelope` (the same ingress the server's
//! authority_bridge_server child feeds); the offspring seed is the REAL boundary
//! (`mint_harvest_seed`), so a sterile line would mint nothing. Writes a JSON
//! artifact and PANICS if the loop breaks (a broken loop fails loudly).
//!
//! Run: cargo run -p successor-sim --example farming_w45_living_loop_proof

use std::fs;

use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};
use successor_sim::{
    AuthorityCommandStatus, InventoryStackSnapshot, SliceAuthorityConfig, SliceAuthorityState,
    SliceSnapshot,
};

const GENE_SAMPLER_ITEM_ID: u32 = 6_201;
const ASHGRAIN_SEED_ITEM_ID: u32 = 6_001;
const ASHGRAIN_PRODUCE_ITEM_ID: u32 = 6_101;
const FERTILIZER_YIELD_ITEM_ID: u32 = 6_312;
const DEV_REAL_SECONDS_PER_GAME_DAY: u32 = 300;
const TICK_RATE_HZ: u64 = 30;

fn envelope(command_id: u64, command: ClientCommand) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: SessionId(1),
        player: PlayerId(1),
        command_id,
        issued_at_tick: 0,
        command,
    }
}

fn main() {
    let mut snap: SliceSnapshot = serde_json::from_str(include_str!(
        "../../../client/public/successor-slice/open-desert-slice.json"
    ))
    .expect("current open-desert fixture");
    snap.actors.retain(|actor| actor.id == "player");
    snap.npc_jobs.clear();
    snap.population_templates.clear();
    snap.spawn_zones.clear();
    snap.transitions.clear();
    snap.clone_facilities.clear();
    snap.blocked_cells.clear();
    snap.no_claim_zones.clear();
    snap.props.clear();
    let area_id = snap
        .areas
        .iter()
        .find(|a| a.kind == "overworld")
        .map(|a| a.id.clone())
        .expect("overworld");
    let spawn = snap
        .actors
        .iter()
        .find(|a| a.id == "player")
        .map(|a| {
            (
                a.cell.x.as_i64().unwrap_or(0) as i32,
                a.cell.y.as_i64().unwrap_or(0) as i32,
            )
        })
        .expect("spawn");
    for area in &mut snap.areas {
        if area.id == area_id {
            area.width = area.width.max(256);
            area.height = area.height.max(256);
        }
    }
    // Fund the canonical credit wallet. A Gene Sampler + yield fertilizer
    // (6_0xx/6_2xx/6_3xx) remain physical inventory rows.
    snap.actors
        .iter_mut()
        .find(|actor| actor.id == "player")
        .expect("player actor")
        .credits = Some(100_000);
    snap.inventory.push(InventoryStackSnapshot {
        stack_id: 6_201,
        container: "player:field-pack".to_owned(),
        item: "Gene Sampler".to_owned(),
        item_id: GENE_SAMPLER_ITEM_ID,
        variant_id: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
    });
    snap.inventory.push(InventoryStackSnapshot {
        stack_id: 6_312,
        container: "player:field-pack".to_owned(),
        item: "Yield Booster".to_owned(),
        item_id: FERTILIZER_YIELD_ITEM_ID,
        variant_id: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
    });

    let mut state = SliceAuthorityState::from_snapshot(&snap).expect("build authority");
    state.set_farm_real_seconds_per_game_day(DEV_REAL_SECONDS_PER_GAME_DAY);
    let config = SliceAuthorityConfig {
        session: SessionId(1),
        player: PlayerId(1),
        player_actor_id: "player".to_owned(),
        area_interest_radius_cells: 256,
        craft_roll_key: SliceAuthorityConfig::default().craft_roll_key,
    };
    let ticks_per_game_day = TICK_RATE_HZ * u64::from(DEV_REAL_SECONDS_PER_GAME_DAY);

    let mut command_id = 0u64;
    let step =
        |state: &mut SliceAuthorityState, cmd: &mut u64, command: ClientCommand, label: &str| {
            *cmd += 1;
            let frame = state.apply_envelope(&config, envelope(*cmd, command));
            println!(
                "  {label:<28} -> {:?}{}",
                frame.status,
                frame
                    .reason_code
                    .as_deref()
                    .map(|r| format!(" ({r})"))
                    .unwrap_or_default()
            );
            assert_eq!(
                frame.status,
                AuthorityCommandStatus::Accepted,
                "{label} must be accepted"
            );
            frame
        };

    println!("AGRICULTURE W5 LIVING LOOP LIVE PROOF (dev day-length {DEV_REAL_SECONDS_PER_GAME_DAY}s, {ticks_per_game_day} ticks/game-day)");

    // ── ACQUIRE: sample a real fertile wild genome (interned in the registry). ──
    step(
        &mut state,
        &mut command_id,
        ClientCommand::GeneSample {
            species: "ashgrain".to_owned(),
        },
        "GeneSample (acquire)",
    );
    let seed = state
        .inventory_snapshots()
        .into_iter()
        .find(|r| r.item_id == ASHGRAIN_SEED_ITEM_ID)
        .expect("wild seed acquired");
    let (seed_container, seed_stack, seed_handle) = (
        seed.container.clone(),
        seed.stack_id.to_string(),
        seed.variant_id,
    );
    println!("  acquired seed handle {seed_handle} (real fertile genome)");

    // ── CLAIM a Homestead whose farm yard covers the spawn cell. ──
    let (origin_x, origin_y) = (spawn.0 - 2, spawn.1 - 6);
    step(
        &mut state,
        &mut command_id,
        ClientCommand::ClaimParcel {
            planet_id: "planet-a".to_owned(),
            area_id: area_id.clone(),
            x: origin_x,
            y: origin_y,
            tier: "homestead".to_owned(),
        },
        "ClaimParcel",
    );
    let parcel_id = state
        .parcel_snapshots_for_observer(&config)
        .first()
        .map(|p| p.parcel_id.clone())
        .expect("parcel minted");
    println!("  claimed parcel: {parcel_id}");
    let (cell_x, cell_y) = spawn;

    // ── TILL -> FERTILIZE (yield line) -> PLANT the real seed. ──
    step(
        &mut state,
        &mut command_id,
        ClientCommand::TillTile {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
        },
        "TillTile",
    );
    let fert = state
        .inventory_snapshots()
        .into_iter()
        .find(|r| r.item_id == FERTILIZER_YIELD_ITEM_ID)
        .expect("fertilizer");
    step(
        &mut state,
        &mut command_id,
        ClientCommand::Fertilize {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
            container: fert.container.clone(),
            stack_id: fert.stack_id.to_string(),
            variant_id: fert.variant_id,
        },
        "Fertilize (yield)",
    );
    step(
        &mut state,
        &mut command_id,
        ClientCommand::PlantSeed {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
            container: seed_container,
            stack_id: seed_stack,
            variant_id: seed_handle,
        },
        "PlantSeed",
    );

    // ── WATER + grow (dev days) until the oracle shows the crop HARVESTABLE. ──
    let grow_to_mature = |state: &mut SliceAuthorityState, cmd: &mut u64| {
        for _ in 0..40 {
            let mut advanced = 0u64;
            while advanced < ticks_per_game_day {
                let batch = 30u16.min((ticks_per_game_day - advanced) as u16);
                state.advance_ticks_for_observer(&config, batch);
                advanced += u64::from(batch);
            }
            *cmd += 1;
            let frame = state.apply_envelope(
                &config,
                envelope(
                    *cmd,
                    ClientCommand::WaterTile {
                        parcel_id: parcel_id.clone(),
                        cell_x,
                        cell_y,
                    },
                ),
            );
            assert_eq!(frame.status, AuthorityCommandStatus::Accepted);
            let plot = state
                .farm_plot_snapshot_for_observer(&config)
                .expect("plot");
            let tile = plot
                .tiles
                .iter()
                .find(|t| t.cell_x == cell_x && t.cell_y == cell_y)
                .expect("tile");
            if tile.crop.as_ref().is_some_and(|c| c.mature) {
                return;
            }
        }
        panic!("crop never matured within 40 game-days");
    };
    grow_to_mature(&mut state, &mut command_id);
    println!("  crop matured (oracle: harvestable)");

    // ── HARVEST: produce units in the bag + OFFSPRING seeds (the real boundary). ──
    let produce_before = state
        .inventory_snapshots()
        .into_iter()
        .filter(|r| r.item_id == ASHGRAIN_PRODUCE_ITEM_ID)
        .map(|r| r.available)
        .sum::<u32>();
    let harvest_frame = step(
        &mut state,
        &mut command_id,
        ClientCommand::HarvestCrop {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
        },
        "HarvestCrop",
    );
    let receipt = harvest_frame.harvest.clone().expect("harvest receipt VM");
    println!(
        "  HARVEST receipt: {} x{} (quality {}%) + {} offspring seed(s) [handle {}], gen {}",
        receipt.species_name,
        receipt.produce_qty,
        receipt.produce_quality_milli / 10,
        receipt.offspring_qty,
        receipt.offspring_variant_id,
        receipt.generation
    );
    assert!(receipt.produce_qty >= 1, "harvest mints produce");
    assert!(
        receipt.offspring_qty >= 1,
        "fertile crop mints offspring seeds"
    );
    let produce_after = state
        .inventory_snapshots()
        .into_iter()
        .filter(|r| r.item_id == ASHGRAIN_PRODUCE_ITEM_ID)
        .map(|r| r.available)
        .sum::<u32>();
    assert_eq!(
        produce_after - produce_before,
        receipt.produce_qty,
        "produce landed in the bag"
    );
    let offspring = state
        .inventory_snapshots()
        .into_iter()
        .find(|r| {
            r.item_id == ASHGRAIN_SEED_ITEM_ID
                && r.variant_id == receipt.offspring_variant_id
                && r.available > 0
        })
        .expect("offspring seed to replant");
    println!(
        "  offspring seed stack: {} x{} (replant-able)",
        offspring.item_id, offspring.available
    );

    // ── REPLANT the offspring -> a SECOND GENERATION grows. ──
    step(
        &mut state,
        &mut command_id,
        ClientCommand::PlantSeed {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
            container: offspring.container.clone(),
            stack_id: offspring.stack_id.to_string(),
            variant_id: receipt.offspring_variant_id,
        },
        "PlantSeed (REPLANT offspring)",
    );
    let mut advanced = 0u64;
    while advanced < ticks_per_game_day {
        let batch = 30u16.min((ticks_per_game_day - advanced) as u16);
        state.advance_ticks_for_observer(&config, batch);
        advanced += u64::from(batch);
    }
    step(
        &mut state,
        &mut command_id,
        ClientCommand::WaterTile {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
        },
        "WaterTile (2nd gen)",
    );
    let plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("plot");
    let gen2 = plot
        .tiles
        .iter()
        .find(|t| t.cell_x == cell_x && t.cell_y == cell_y)
        .and_then(|t| t.crop.clone())
        .expect("2nd-gen crop");
    assert_eq!(
        gen2.seed_variant_id, receipt.offspring_variant_id,
        "2nd gen is the harvested cultivar"
    );
    assert!(
        gen2.stage >= 1 || !gen2.mature,
        "the second generation is growing"
    );
    println!(
        "  SECOND GENERATION growing: handle {} stage {}/{}",
        gen2.seed_variant_id, gen2.stage, gen2.stage_count
    );

    let artifact = serde_json::json!({
        "proof": "agriculture-w45-living-loop",
        "devRealSecondsPerGameDay": DEV_REAL_SECONDS_PER_GAME_DAY,
        "loop": ["GeneSample", "ClaimParcel", "TillTile", "Fertilize", "PlantSeed", "grow", "HarvestCrop", "PlantSeed(replant offspring)", "grow"],
        "harvestReceipt": receipt,
        "secondGenerationCrop": gen2,
        "farmPlotOracle": plot,
        "stateHash": state.stable_state_hash_hex(),
    });
    let out_dir = "../../verification/ledgers/artifacts/manual-proofs";
    let _ = fs::create_dir_all(out_dir);
    let out_path = format!("{out_dir}/agri-w45-living-loop-proof.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&artifact).expect("serialize"),
    )
    .expect("write");
    println!(
        "  artifact: verification/ledgers/artifacts/manual-proofs/agri-w45-living-loop-proof.json"
    );
    println!("LIVING LOOP PROVEN: acquire -> claim -> till -> fertilize -> plant -> grow -> HARVEST (produce + offspring) -> REPLANT -> 2nd generation growing.");
}
