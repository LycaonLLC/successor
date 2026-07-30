//! LIVE LAND-LATTICE PROOF — drives the REAL AuthorityBridge over its JSON-line wire
//! (the exact protocol the TS server subprocess speaks) against the SHIPPED open-desert
//! slice (central no-claim zone live). Proves, end to end through the authority, that an
//! off-lattice claim OUTSIDE the hub is Accepted with a requested->SNAPPED receipt + a
//! lattice-aligned AOI rect + exposed noClaimZones; a claim INSIDE the central zone is
//! Rejected `no_claim_zone`; and a DIRECTLY ADJACENT claim (shared edge) is Accepted.
//! Emits `verification/ledgers/artifacts/manual-proofs/land-lattice-bridge-proof.json`;
//! panics on any miss.
//!
//! Run: cargo run -p successor-sim --example land_live_bridge_proof
use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use successor_sim::AuthorityBridge;

const DRIVER: &str = "land-driver";
const AREA: &str = "open-desert-overworld";

fn dispatch(bridge: &mut AuthorityBridge, line: &str) -> Value {
    let out = bridge.dispatch_json(line).expect("bridge dispatch ok");
    serde_json::from_str(&out).expect("bridge output parses")
}

fn upsert(bridge: &mut AuthorityBridge, id: &str, x: i32, y: i32, rid: u64) -> Value {
    dispatch(
        bridge,
        &json!({
            "type": "upsertActor", "requestId": rid,
            "actor": { "id": id, "entity": format!("actor.{id}"), "label": id,
                "role": "player", "areaId": AREA, "x": x, "y": y, "direction": "Right",
                "credits": 2_000 }
        })
        .to_string(),
    )
}

fn cmd(
    bridge: &mut AuthorityBridge,
    actor: &str,
    command_id: u64,
    command: Value,
    rid: u64,
) -> Value {
    dispatch(
        bridge,
        &json!({
            "requestId": rid,
            "config": { "session": 1, "player": 1, "playerActorId": actor, "areaInterestRadiusCells": 256 },
            "envelope": { "session": 1, "player": 1, "command_id": command_id, "issued_at_tick": 0, "command": command }
        })
        .to_string(),
    )
}

fn claim(planet: &str, x: i32, y: i32) -> Value {
    json!({ "ClaimParcel": { "planet_id": planet, "area_id": AREA, "x": x, "y": y, "tier": "homestead" } })
}

fn status(v: &Value) -> &str {
    v.get("status").and_then(Value::as_str).unwrap_or("?")
}
fn reason(v: &Value) -> &str {
    v.get("reasonCode").and_then(Value::as_str).unwrap_or("")
}

fn main() {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    let mut bridge = AuthorityBridge::from_snapshot_json(fixture).expect("open-desert slice loads");
    let mut rid = 1_u64;
    let mut next = || {
        let r = rid;
        rid += 1;
        r
    };
    let mut transcript: Vec<Value> = Vec::new();

    // Boot a funded driver on the FRONTIER (outside the central hub zone).
    upsert(&mut bridge, DRIVER, 700, 700, next());

    // ── 1. OFF-LATTICE claim OUTSIDE the hub -> Accepted + SNAP receipt. ──
    let a = cmd(&mut bridge, DRIVER, 1, claim("planet-a", 803, 802), next());
    assert_eq!(
        status(&a),
        "accepted",
        "frontier claim accepted ({})",
        reason(&a)
    );
    let receipt = a.get("parcelClaim").cloned().unwrap_or(Value::Null);
    assert_eq!(receipt.get("requestedX").and_then(Value::as_i64), Some(803));
    assert_eq!(receipt.get("requestedY").and_then(Value::as_i64), Some(802));
    assert_eq!(
        receipt.get("snappedX").and_then(Value::as_i64),
        Some(800),
        "803 snaps to 800"
    );
    assert_eq!(
        receipt.get("snappedY").and_then(Value::as_i64),
        Some(800),
        "802 snaps to 800"
    );
    assert_eq!(
        receipt.get("snapped").and_then(Value::as_bool),
        Some(true),
        "off-lattice => snapped"
    );
    // The AOI parcel rect the FE reads reflects the snapped origin (lattice-aligned).
    let parcel = a
        .get("placedParcels")
        .and_then(Value::as_array)
        .and_then(|ps| {
            ps.iter()
                .find(|p| p.pointer("/rect/x").and_then(Value::as_i64) == Some(800))
        })
        .cloned()
        .expect("claimed parcel visible in AOI at the snapped origin");
    let (rx, ry) = (
        parcel.pointer("/rect/x").and_then(Value::as_i64).unwrap(),
        parcel.pointer("/rect/y").and_then(Value::as_i64).unwrap(),
    );
    assert!(
        rx % 8 == 0 && ry % 8 == 0,
        "AOI rect is lattice-aligned ({rx},{ry})"
    );
    // noClaimZones exposed to the client (the INVALID read) — the central hub present.
    let zones = a
        .get("noClaimZones")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let central = zones
        .iter()
        .find(|z| z.get("source").and_then(Value::as_str) == Some("central"))
        .expect("central no-claim zone exposed to the client");
    assert_eq!(
        central.pointer("/rect/x").and_then(Value::as_i64),
        Some(448),
        "central zone lattice-aligned [448,576)"
    );
    transcript.push(json!({ "step": "frontier-claim-snap", "status": status(&a), "receipt": receipt, "aoiRect": parcel.get("rect"), "noClaimZones": zones }));

    // ── 2. Claim INSIDE the central no-claim zone -> Rejected no_claim_zone. ──
    let b = cmd(&mut bridge, DRIVER, 3, claim("planet-b", 500, 500), next());
    assert_eq!(status(&b), "rejected", "hub claim rejected");
    assert_eq!(
        reason(&b),
        "no_claim_zone",
        "the central hub is a first-class exclusion"
    );
    transcript.push(
        json!({ "step": "hub-claim-rejected", "status": status(&b), "reasonCode": reason(&b) }),
    );

    // ── 3. DIRECTLY ADJACENT claim (shares the x=816 edge with parcel A) -> Accepted. ──
    let c = cmd(&mut bridge, DRIVER, 4, claim("planet-c", 816, 800), next());
    assert_eq!(
        status(&c),
        "accepted",
        "adjacent claim accepted ({})",
        reason(&c)
    );
    let adj = c
        .get("placedParcels")
        .and_then(Value::as_array)
        .map(|ps| {
            ps.iter()
                .any(|p| p.pointer("/rect/x").and_then(Value::as_i64) == Some(816))
        })
        .unwrap_or(false);
    assert!(
        adj,
        "the adjacent lot at x=816 is minted next to A's [800,816)"
    );
    transcript.push(json!({ "step": "adjacent-claim-allowed", "status": status(&c) }));

    let report = json!({
        "schema": "successor.land-lattice-bridge-proof.v1",
        "slice": "open-desert-slice.json",
        "latticeQuantumCells": successor_sim::LATTICE_QUANTUM_CELLS,
        "transcript": transcript,
        "result": "PASS"
    });
    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../verification/ledgers/artifacts/manual-proofs");
    let _ = fs::create_dir_all(&out_dir);
    let out_path = out_dir.join("land-lattice-bridge-proof.json");
    fs::write(&out_path, serde_json::to_string_pretty(&report).unwrap()).expect("write proof");
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    println!("[land-lattice-bridge] wrote {}", out_path.display());
    println!("[land-lattice-bridge] SCENARIO PASS");
}
