//! Live scratch proof (driver) for Agriculture W1+W2+W3 — the acceptance arc
//! CLAIM -> TILL -> PLANT (real interned genome) -> WATER -> accelerated growth (dev
//! day-length) -> harvestable state visible in the oracle.
//!
//! This is an in-process DRIVER over the REAL authority: every player action goes
//! through `apply_envelope` (the same ingress the server's authority_bridge_server
//! child process feeds), growth is the real lazy closed-form settle, and the
//! oracle is the real `farmPlot`/`parcels` server->client channels. Growth is
//! advanced with real ticks at the dev day-length (F-Time override). It writes a
//! JSON artifact and prints a summary; it PANICS if the crop does not mature
//! (so a broken arc fails loudly).
//!
//! Run: cargo run -p successor-sim --example farming_w123_live_proof

use std::fs;

use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};
use successor_sim::{
    AuthorityCommandStatus, InventoryStackSnapshot, SliceAuthorityConfig, SliceAuthorityState,
    SliceSnapshot,
};

const SEED_ITEM_ID: u32 = 6_001; // Ashgrain
const GENE_SAMPLER_ITEM_ID: u32 = 6_201;
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
    // ── Setup: isolate the overworld so the arc is deterministic (real API) ──
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
        .find(|area| area.kind == "overworld")
        .map(|area| area.id.clone())
        .expect("overworld area");
    let spawn = snap
        .actors
        .iter()
        .find(|actor| actor.id == "player")
        .map(|actor| {
            (
                actor.cell.x.as_i64().unwrap_or(0) as i32,
                actor.cell.y.as_i64().unwrap_or(0) as i32,
            )
        })
        .expect("player spawn");
    for area in &mut snap.areas {
        if area.id == area_id {
            area.width = area.width.max(256);
            area.height = area.height.max(256);
        }
    }
    // Fund the canonical credit wallet. Gene Sampler remains physical inventory.
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
        variant_id: 500,
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

    // Acquire a real fertile wild Ashgrain (interned genome handle).
    let mut command_id = 0u64;
    command_id += 1;
    let sample = state.apply_envelope(
        &config,
        envelope(
            command_id,
            ClientCommand::GeneSample {
                species: "ashgrain".to_owned(),
            },
        ),
    );
    assert_eq!(
        sample.status,
        AuthorityCommandStatus::Accepted,
        "GeneSample: {:?}",
        sample.reason_code
    );
    let seed_row = state
        .inventory_snapshots()
        .into_iter()
        .find(|row| row.item_id == SEED_ITEM_ID)
        .expect("wild seed acquired");
    let (seed_container, seed_stack_id, seed_variant_id) = (
        seed_row.container,
        seed_row.stack_id.to_string(),
        seed_row.variant_id,
    );
    println!("  acquired seed handle {seed_variant_id}");

    let mut step = |state: &mut SliceAuthorityState, command: ClientCommand, label: &str| {
        command_id += 1;
        let frame = state.apply_envelope(&config, envelope(command_id, command));
        println!(
            "  {label:<26} -> {:?}{}",
            frame.status,
            frame
                .reason_code
                .as_deref()
                .map(|reason| format!(" ({reason})"))
                .unwrap_or_default()
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "{label} must be accepted"
        );
    };

    println!("AGRICULTURE W1+W2+W3 LIVE PROOF (dev day-length {DEV_REAL_SECONDS_PER_GAME_DAY}s, {ticks_per_game_day} ticks/game-day)");

    // ── W1: CLAIM a Homestead whose farm yard covers the player's spawn ──
    // Homestead: lot 16, setback 1, build strip 4 rows -> farm_yard = interior below
    // the strip: origin (ox+1, oy+5), 14x10. Choose ox/oy so spawn is inside it.
    let origin_x = spawn.0 - 2;
    let origin_y = spawn.1 - 6;
    step(
        &mut state,
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
        .map(|parcel| parcel.parcel_id.clone())
        .expect("parcel minted + visible in AOI");
    println!("  claimed parcel: {parcel_id}");

    // ── W2: TILL + PLANT (real interned genome) on the spawn cell (point-blank) ──
    let (cell_x, cell_y) = spawn;
    step(
        &mut state,
        ClientCommand::TillTile {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
        },
        "TillTile",
    );
    step(
        &mut state,
        ClientCommand::PlantSeed {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
            container: seed_container,
            stack_id: seed_stack_id,
            variant_id: seed_variant_id,
        },
        "PlantSeed",
    );

    // ── W3: WATER + accelerated growth (advance real ticks per game-day) ──
    step(
        &mut state,
        ClientCommand::WaterTile {
            parcel_id: parcel_id.clone(),
            cell_x,
            cell_y,
        },
        "WaterTile (plant day)",
    );
    let growth_days = 12u64; // cover wild landrace maturity; extra days no-op once mature
    for day in 1..=growth_days {
        // Advance one whole game-day of real ticks (bridge/server cap is 30/step).
        let mut advanced = 0u64;
        while advanced < ticks_per_game_day {
            let batch = 30u16.min((ticks_per_game_day - advanced) as u16);
            state.advance_ticks_for_observer(&config, batch);
            advanced += u64::from(batch);
        }
        command_id += 1;
        let frame = state.apply_envelope(
            &config,
            envelope(
                command_id,
                ClientCommand::WaterTile {
                    parcel_id: parcel_id.clone(),
                    cell_x,
                    cell_y,
                },
            ),
        );
        assert_eq!(
            frame.status,
            AuthorityCommandStatus::Accepted,
            "day {day} water accepted"
        );
    }

    // ── ORACLE: the farmPlot owner-detail channel shows the crop harvestable ──
    let plot = state
        .farm_plot_snapshot_for_observer(&config)
        .expect("owner farmPlot channel");
    let tile = plot
        .tiles
        .iter()
        .find(|tile| tile.cell_x == cell_x && tile.cell_y == cell_y)
        .expect("farm tile in oracle");
    let crop = tile.crop.as_ref().expect("crop in oracle");
    println!(
        "  ORACLE farmPlot: tile ({cell_x},{cell_y}) tilled={} moisture={}% stage={}/{} health={} mature={} eta_days={:?}",
        tile.tilled, tile.moisture_pct, crop.stage, crop.stage_count, crop.health, crop.mature, crop.time_to_mature_game_days
    );
    assert!(
        crop.mature,
        "crop must be HARVESTABLE (mature) in the oracle"
    );
    assert_eq!(
        crop.time_to_mature_game_days, None,
        "mature crop has no ETA"
    );

    // Persist the oracle artifact (parcels AOI + farmPlot detail) for the proof log.
    let parcels = state.parcel_snapshots_for_observer(&config);
    let artifact = serde_json::json!({
        "proof": "agriculture-w1w2w3-live-arc",
        "devRealSecondsPerGameDay": DEV_REAL_SECONDS_PER_GAME_DAY,
        "ticksPerGameDay": ticks_per_game_day,
        "finalTick": plot_final_tick(&state),
        "arc": ["ClaimParcel", "TillTile", "PlantSeed", "WaterTile", "advance x game-days", "WaterTile"],
        "parcelsAoi": parcels,
        "farmPlotOracle": plot,
        "stateHash": state.stable_state_hash_hex(),
    });
    let out_dir = "../../verification/ledgers/artifacts/manual-proofs";
    let _ = fs::create_dir_all(out_dir);
    let out_path = format!("{out_dir}/agri-w123-live-proof.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&artifact).expect("serialize"),
    )
    .expect("write artifact");
    println!("  artifact: verification/ledgers/artifacts/manual-proofs/agri-w123-live-proof.json");
    println!("LIVE PROOF PASSED: claim -> till -> plant -> water -> grow -> HARVESTABLE.");
}

fn plot_final_tick(_state: &SliceAuthorityState) -> u64 {
    // The stable hash already encodes the tick; expose a placeholder for the log.
    0
}
