//! Live two-driver duel proof: drives the REAL AuthorityBridge over its JSON-line
//! wire (the exact protocol the TS server subprocess speaks) with two human
//! drivers plus a non-duel bystander, and proves the full arc:
//!   challenge -> accept -> exchange -> yield  (receipts + outcomes to BOTH sides)
//!   + a non-duel damage reject (honest target_unavailable).
//!
//! Run: cargo run -p successor-sim --example duel_two_driver_proof
//! Emits a JSON transcript to
//! `verification/ledgers/artifacts/manual-proofs/duel-two-driver-proof.json`.

use std::fs;
use std::path::Path;

use serde_json::{json, Value};
use successor_sim::AuthorityBridge;

const ALPHA: &str = "game-ws-alpha"; // driver A (challenger)
const BRAVO: &str = "game-ws-bravo"; // driver B (target)
const CHARLIE: &str = "game-ws-charlie"; // non-duel bystander
const AREA: &str = "open-desert-overworld";

fn dispatch(bridge: &mut AuthorityBridge, line: &str) -> Value {
    let out = bridge.dispatch_json(line).expect("bridge dispatch ok");
    serde_json::from_str(&out).expect("bridge output parses")
}

fn upsert(bridge: &mut AuthorityBridge, id: &str, x: i32, y: i32, rid: u64) -> Value {
    dispatch(
        bridge,
        &json!({
            "type": "upsertActor",
            "requestId": rid,
            "actor": {
                "id": id, "entity": format!("actor.{id}"), "label": id,
                "role": "player", "areaId": AREA, "x": x, "y": y, "direction": "Right"
            }
        })
        .to_string(),
    )
}

fn restock(bridge: &mut AuthorityBridge, id: &str, rid: u64) -> Value {
    dispatch(
        bridge,
        &json!({ "type": "restockActorLoadout", "requestId": rid, "actorId": id }).to_string(),
    )
}

fn cmd(
    bridge: &mut AuthorityBridge,
    session: u64,
    actor: &str,
    command_id: u64,
    command: Value,
    rid: u64,
) -> Value {
    dispatch(
        bridge,
        &json!({
            "requestId": rid,
            "config": { "session": session, "player": session as u32, "playerActorId": actor, "areaInterestRadiusCells": 96 },
            "envelope": { "session": session, "player": session as u32, "command_id": command_id, "issued_at_tick": 0, "command": command }
        })
        .to_string(),
    )
}

fn tick(bridge: &mut AuthorityBridge, rid: u64) -> Value {
    dispatch(
        bridge,
        &json!({
            "type": "tick", "requestId": rid,
            "config": { "session": 1, "player": 1, "playerActorId": ALPHA, "areaInterestRadiusCells": 96 }
        })
        .to_string(),
    )
}

fn status(v: &Value) -> &str {
    v.get("status").and_then(Value::as_str).unwrap_or("?")
}
fn reason(v: &Value) -> &str {
    v.get("reasonCode").and_then(Value::as_str).unwrap_or("")
}

fn main() {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    let mut bridge = AuthorityBridge::from_snapshot_json(fixture).expect("current fixture loads");
    let mut transcript: Vec<Value> = Vec::new();
    let mut rid = 1_u64;
    let mut next = || {
        let r = rid;
        rid += 1;
        r
    };

    // --- Boot: three human drivers, adjacent; arm the duelists. ---
    upsert(&mut bridge, ALPHA, 513, 512, next());
    upsert(&mut bridge, BRAVO, 514, 512, next());
    upsert(&mut bridge, CHARLIE, 516, 512, next());
    restock(&mut bridge, ALPHA, next());
    restock(&mut bridge, BRAVO, next());

    // --- 1. CHALLENGE: A -> B. ---
    let challenge = cmd(
        &mut bridge,
        1,
        ALPHA,
        1,
        json!({ "DuelChallenge": { "target_actor_id": BRAVO } }),
        next(),
    );
    assert_eq!(status(&challenge), "accepted", "challenge accepted");
    let bravo_incoming = challenge
        .pointer("/duelViewsByActorId")
        .and_then(|v| v.get(BRAVO))
        .and_then(|v| v.get("incomingChallenge"))
        .and_then(|v| v.get("otherActorId"))
        .and_then(Value::as_str);
    assert_eq!(bravo_incoming, Some(ALPHA), "B sees A's incoming challenge");
    transcript.push(json!({ "step": "challenge", "driver": "A->B", "status": status(&challenge), "bravoIncomingChallengeFrom": bravo_incoming }));

    // --- 2. ACCEPT: B. Duel forms; both views show the active duel. ---
    let accept = cmd(
        &mut bridge,
        2,
        BRAVO,
        1,
        json!({ "DuelAccept": {} }),
        next(),
    );
    assert_eq!(status(&accept), "accepted", "accept accepted");
    let bravo_duel_opp = accept
        .pointer("/duelViewsByActorId")
        .and_then(|v| v.get(BRAVO))
        .and_then(|v| v.get("activeDuel"))
        .and_then(|v| v.get("opponentActorId"))
        .and_then(Value::as_str);
    assert_eq!(
        bravo_duel_opp_check(bravo_duel_opp),
        ALPHA,
        "B's active duel opponent is A"
    );
    transcript.push(json!({ "step": "accept", "driver": "B", "status": status(&accept), "bravoActiveDuelOpponent": bravo_duel_opp }));

    // --- 3. EXCHANGE: within the duel, A->B and B->A attacks are PERMITTED. ---
    let a_hits_b = cmd(
        &mut bridge,
        1,
        ALPHA,
        2,
        json!({ "QueueCombatAction": { "action_id": "basic_shot", "target_actor_id": BRAVO } }),
        next(),
    );
    assert_eq!(
        status(&a_hits_b),
        "accepted",
        "duel: A can attack B (gate open)"
    );
    let b_hits_a = cmd(
        &mut bridge,
        2,
        BRAVO,
        2,
        json!({ "QueueCombatAction": { "action_id": "basic_shot", "target_actor_id": ALPHA } }),
        next(),
    );
    assert_eq!(
        status(&b_hits_a),
        "accepted",
        "duel: B can attack A (both ways)"
    );

    // Tick to resolve the roll bursts; collect the real ranged_roll combat events.
    let mut combat_events = 0_u64;
    let mut damage_dealt = 0_i64;
    for _ in 0..80 {
        let t = tick(&mut bridge, next());
        if let Some(events) = t.get("combatEvents").and_then(Value::as_array) {
            for ev in events {
                combat_events += 1;
                damage_dealt += ev.get("damage").and_then(Value::as_i64).unwrap_or(0);
            }
        }
    }
    transcript.push(json!({
        "step": "exchange", "aAttacksB": status(&a_hits_b), "bAttacksA": status(&b_hits_a),
        "resolvedCombatEvents": combat_events, "totalDamageDealt": damage_dealt
    }));
    assert!(
        combat_events > 0,
        "the duel exchange resolved real combat events"
    );

    // --- 4. YIELD: A concedes. Both sides get an outcome; the yielder lives. ---
    let yielded = cmd(&mut bridge, 1, ALPHA, 3, json!({ "DuelYield": {} }), next());
    assert_eq!(status(&yielded), "accepted", "yield accepted");
    let outcomes = yielded
        .get("duelOutcomes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let a_outcome = outcomes
        .iter()
        .find(|o| o.get("actorId").and_then(Value::as_str) == Some(ALPHA));
    let b_outcome = outcomes
        .iter()
        .find(|o| o.get("actorId").and_then(Value::as_str) == Some(BRAVO));
    assert_eq!(
        a_outcome
            .and_then(|o| o.get("result"))
            .and_then(Value::as_str),
        Some("lost"),
        "A lost by yield"
    );
    assert_eq!(
        a_outcome
            .and_then(|o| o.get("reason"))
            .and_then(Value::as_str),
        Some("yield")
    );
    assert_eq!(
        b_outcome
            .and_then(|o| o.get("result"))
            .and_then(Value::as_str),
        Some("won"),
        "B won by yield"
    );
    transcript.push(
        json!({ "step": "yield", "driver": "A", "status": status(&yielded), "outcomes": outcomes }),
    );

    // --- 5. NON-DUEL DAMAGE REJECT: A (now duel-free) attacks bystander C -> honest reject. ---
    let non_duel = cmd(
        &mut bridge,
        1,
        ALPHA,
        4,
        json!({ "QueueCombatAction": { "action_id": "basic_shot", "target_actor_id": CHARLIE } }),
        next(),
    );
    assert_eq!(
        status(&non_duel),
        "rejected",
        "non-duel player attack is rejected"
    );
    assert_eq!(
        reason(&non_duel),
        "target_unavailable",
        "honest reject reason"
    );
    transcript.push(json!({ "step": "nonDuelReject", "driver": "A->C", "status": status(&non_duel), "reasonCode": reason(&non_duel) }));

    // --- Emit the transcript artifact. ---
    let report = json!({
        "schema": "successor.duel-two-driver-proof.v1",
        "drivers": { "challenger": ALPHA, "target": BRAVO, "bystander": CHARLIE },
        "transcript": transcript,
        "result": "PASS"
    });
    let out_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../verification/ledgers/artifacts/manual-proofs");
    let _ = fs::create_dir_all(&out_dir);
    let out_path = out_dir.join("duel-two-driver-proof.json");
    fs::write(
        &out_path,
        serde_json::to_string_pretty(&report).expect("report serializes"),
    )
    .expect("write proof artifact");
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("print report")
    );
    println!("[duel-two-driver] wrote {}", out_path.display());
    println!("[duel-two-driver] SCENARIO PASS");
}

fn bravo_duel_opp_check(opp: Option<&str>) -> &str {
    opp.unwrap_or("<none>")
}
