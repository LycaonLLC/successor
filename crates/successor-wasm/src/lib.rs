//! WASM entry point. Exposes the deterministic sim to JavaScript.

#![forbid(unsafe_code)]

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub fn authority_command_replay_json() -> String {
    let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
    successor_sim::current_authority_replay_json(fixture)
        .expect("bundled authority replay fixture serializes")
}

#[wasm_bindgen]
pub fn authority_command_replay_json_from_slice_json(slice_json: &str) -> Result<String, JsValue> {
    successor_sim::current_authority_replay_json(slice_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[wasm_bindgen]
pub fn authority_bridge_script_json_from_slice_json(
    slice_json: &str,
    script_json: &str,
) -> Result<String, JsValue> {
    successor_sim::authority_bridge_script_json(slice_json, script_json)
        .map_err(|error| JsValue::from_str(&error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_replay_export_matches_sim_fixture() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let expected = successor_sim::current_authority_replay_json(fixture).unwrap();

        assert_eq!(authority_command_replay_json(), expected);
        assert_eq!(
            authority_command_replay_json_from_slice_json(fixture).unwrap(),
            expected
        );

        let parsed: serde_json::Value = serde_json::from_str(&expected).unwrap();
        assert_eq!(parsed["schema"], "successor.authority-command-replay.v1");
        assert_eq!(parsed["replay"]["accepted"], 4);
        assert_eq!(parsed["replay"]["rejected"], 22);
        assert_eq!(parsed["replay"]["nativeRepeatMatches"], true);
        assert_eq!(parsed["replay"]["combatEvents"], 0);
        assert_eq!(parsed["replay"]["hits"], 0);
    }

    #[test]
    fn authority_bridge_script_export_accepts_server_protocol_shape() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let script = r#"{
          "config": {
            "session": 1,
            "player": 1,
            "playerActorId": "player",
            "areaInterestRadiusCells": 64
          },
          "commands": [
            {
              "session": 1,
              "player": 1,
              "command_id": 1,
              "issued_at_tick": 24,
              "command": { "Move": { "dx": 1, "dy": 0, "duration_ticks": 1, "sprint": false } }
            }
          ]
        }"#;

        let output = authority_bridge_script_json_from_slice_json(fixture, script).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert_eq!(
            parsed["schema"],
            "successor.rust-authority-bridge-script.v1"
        );
        assert_eq!(parsed["steps"][0]["status"], "accepted");
        assert!(parsed["steps"][0].get("projectiles").is_none());
    }
}
