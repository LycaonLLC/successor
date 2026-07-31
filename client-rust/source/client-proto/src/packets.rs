use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameHello {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "playerActorId")]
    pub player_actor_id: String,
    pub snapshot: GameShardSnapshot,
    #[serde(rename = "serverTime")]
    pub server_time: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameShardSnapshot {
    pub schema: String,
    #[serde(rename = "shardId")]
    pub shard_id: String,
    pub tick: u64,
    #[serde(rename = "playerActorId")]
    pub player_actor_id: String,
    pub actors: HashMap<String, GameActorSnapshot>,
    pub inventory: Vec<serde_json::Value>,
    pub reservations: Vec<serde_json::Value>,
    pub bank: Option<serde_json::Value>,
    #[serde(rename = "playerCorpses")]
    pub player_corpses: Vec<serde_json::Value>,
    #[serde(rename = "resourceSpawns")]
    pub resource_spawns: Vec<serde_json::Value>,
    #[serde(rename = "placedExtractors")]
    pub placed_extractors: Vec<serde_json::Value>,
    #[serde(rename = "placedCamps")]
    pub placed_camps: Vec<serde_json::Value>,
    #[serde(rename = "placedParcels")]
    pub placed_parcels: Vec<serde_json::Value>,
    pub building: Option<serde_json::Value>,
    #[serde(rename = "farmPlots")]
    pub farm_plots: Vec<serde_json::Value>,
    #[serde(rename = "craftSession")]
    pub craft_session: Option<serde_json::Value>,
    #[serde(rename = "draftedSchematics")]
    pub drafted_schematics: Vec<serde_json::Value>,
    pub groups: Option<serde_json::Value>,
    pub guilds: Option<serde_json::Value>,
    pub duels: Option<serde_json::Value>,
    #[serde(rename = "propStates")]
    pub prop_states: HashMap<String, serde_json::Value>,
    #[serde(rename = "worldClock")]
    pub world_clock: Option<serde_json::Value>,
    pub weather: Vec<serde_json::Value>,
    #[serde(rename = "abilityQueue")]
    pub ability_queue: Option<serde_json::Value>,
    #[serde(rename = "sourceStateHash")]
    pub source_state_hash: Option<String>,
    #[serde(rename = "sourceActorCount")]
    pub source_actor_count: Option<i64>,
    pub counters: Option<GameCounters>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameShardDelta {
    pub schema: String,
    #[serde(rename = "shardId")]
    pub shard_id: String,
    pub tick: u64,
    #[serde(rename = "playerActorId")]
    pub player_actor_id: String,
    pub actors: HashMap<String, GameActorSnapshot>,
    #[serde(rename = "actorPatches")]
    pub actor_patches: HashMap<String, GameActorPatch>,
    #[serde(rename = "actorRemovals")]
    pub actor_removals: Vec<String>,
    #[serde(rename = "compactActorMoves")]
    pub compact_actor_moves: Vec<GameCompactActorMove>,
    #[serde(rename = "actorRefs")]
    pub actor_refs: Vec<GameActorNetRef>,
    /// Compact full-actor tuples (situational server optimization). Kept as
    /// passthrough values; the movement fast path uses `compact_actor_moves`.
    #[serde(rename = "compactActors")]
    pub compact_actors: Vec<serde_json::Value>,
    #[serde(rename = "compactActorPatches")]
    pub compact_actor_patches: Vec<serde_json::Value>,
    pub inventory: Vec<serde_json::Value>,
    pub reservations: Vec<serde_json::Value>,
    pub bank: Option<serde_json::Value>,
    #[serde(rename = "playerCorpses")]
    pub player_corpses: Vec<serde_json::Value>,
    #[serde(rename = "resourceSpawns")]
    pub resource_spawns: Vec<serde_json::Value>,
    #[serde(rename = "placedExtractors")]
    pub placed_extractors: Vec<serde_json::Value>,
    #[serde(rename = "placedCamps")]
    pub placed_camps: Vec<serde_json::Value>,
    #[serde(rename = "placedParcels")]
    pub placed_parcels: Vec<serde_json::Value>,
    pub building: Option<serde_json::Value>,
    #[serde(rename = "farmPlots")]
    pub farm_plots: Vec<serde_json::Value>,
    #[serde(rename = "craftSession")]
    pub craft_session: Option<serde_json::Value>,
    #[serde(rename = "draftedSchematics")]
    pub drafted_schematics: Vec<serde_json::Value>,
    pub groups: Option<serde_json::Value>,
    pub guilds: Option<serde_json::Value>,
    pub duels: Option<serde_json::Value>,
    #[serde(rename = "propStates")]
    pub prop_states: HashMap<String, serde_json::Value>,
    #[serde(rename = "worldClock")]
    pub world_clock: Option<serde_json::Value>,
    pub weather: Vec<serde_json::Value>,
    #[serde(rename = "abilityQueue")]
    pub ability_queue: Option<serde_json::Value>,
    #[serde(rename = "dialogueDeliveries")]
    pub dialogue_deliveries: Vec<serde_json::Value>,
    #[serde(rename = "sourceStateHash")]
    pub source_state_hash: Option<String>,
    #[serde(rename = "sourceActorCount")]
    pub source_actor_count: Option<i64>,
    pub counters: Option<GameCounters>,
}

/// Per-shard cumulative counters (snapshot/delta `counters`).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameCounters {
    #[serde(rename = "acceptedCommands")]
    pub accepted_commands: u64,
    #[serde(rename = "rejectedCommands")]
    pub rejected_commands: u64,
    #[serde(rename = "shotsFired")]
    pub shots_fired: u64,
    pub hits: u64,
    pub deaths: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorSnapshot {
    pub id: String,
    pub label: String,
    #[serde(rename = "display_name")]
    pub display_name: String,
    #[serde(rename = "areaId")]
    pub area_id: String,
    pub x: f32,
    pub y: f32,
    pub direction: String,
    pub vitals: GameActorVitals,
    #[serde(rename = "maxVitals")]
    pub max_vitals: GameActorVitals,
    #[serde(rename = "lifeState")]
    pub life_state: String,
    #[serde(rename = "lifecycleSeq")]
    pub lifecycle_seq: i64,
    // Presentation fields consumed by the pawn renderer (Wave 3).
    pub sprite: Option<String>,
    pub role: Option<String>,
    pub posture: Option<String>,
    pub appearance: Option<GameActorAppearance>,
    #[serde(default)]
    pub worn: Vec<GameActorWorn>,
    pub weapon: Option<GameActorWeapon>,
    #[serde(default)]
    pub statuses: Vec<serde_json::Value>,
    #[serde(default)]
    pub professions: Vec<serde_json::Value>,
    #[serde(rename = "personalShield")]
    pub personal_shield: Option<serde_json::Value>,
    pub credits: Option<i64>,
    #[serde(rename = "factionId")]
    pub faction_id: Option<String>,
    #[serde(rename = "socialGroup")]
    pub social_group: Option<String>,
    #[serde(rename = "pvpStatus")]
    pub pvp_status: Option<String>,
    #[serde(rename = "engagementTargetId")]
    pub engagement_target_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorPatch {
    pub id: String,
    pub label: Option<String>,
    #[serde(rename = "display_name")]
    pub display_name: Option<String>,
    #[serde(rename = "areaId")]
    pub area_id: Option<String>,
    pub x: Option<f32>,
    pub y: Option<f32>,
    pub direction: Option<String>,
    pub vitals: Option<GameActorVitals>,
    #[serde(rename = "maxVitals")]
    pub max_vitals: Option<GameActorVitals>,
    #[serde(rename = "lifeState")]
    pub life_state: Option<String>,
    #[serde(rename = "lifecycleSeq")]
    pub lifecycle_seq: Option<i64>,
    pub sprite: Option<String>,
    pub role: Option<String>,
    pub posture: Option<String>,
    pub appearance: Option<GameActorAppearance>,
    pub worn: Option<Vec<GameActorWorn>>,
    pub weapon: Option<serde_json::Value>,
}

/// Character appearance (skin tone, hair, face) — permissive passthrough for
/// the face-kit fields beyond the two the body renderer needs directly.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorAppearance {
    #[serde(rename = "skinTone")]
    pub skin_tone: Option<String>,
    pub hair: Option<String>,
    pub face: Option<serde_json::Value>,
}

/// One worn equipment piece.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorWorn {
    pub slot: Option<String>,
    #[serde(rename = "itemId")]
    pub item_id: Option<String>,
    #[serde(default)]
    pub colors: Vec<String>,
}

/// Equipped weapon presentation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorWeapon {
    #[serde(rename = "weaponId")]
    pub weapon_id: Option<String>,
    #[serde(rename = "reloadRemainingTicks")]
    pub reload_remaining_ticks: Option<i64>,
}

/// Compact per-tick move delta: `[netId, qx, qy, direction]` (positions are
/// milli-cell quantized / 100; direction 0..3). netId resolves via `actorRefs`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct GameCompactActorMove(pub u32, pub i64, pub i64, pub u8);

/// `actorRefs` entry mapping a net id to an actor id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GameActorNetRef(pub u32, pub String);

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameActorVitals {
    pub health: f32,
    pub action: f32,
    pub spirit: f32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GameCommandReceipt {
    #[serde(rename = "commandId")]
    pub command_id: u64,
    pub accepted: bool,
    pub tick: u64,
    #[serde(rename = "reasonCode")]
    pub reason_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GameCompactReceipt(pub u64, pub u8, pub u64, pub Option<String>);

impl<'de> Deserialize<'de> for GameCompactReceipt {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct CompactReceiptVisitor;
        impl<'de> serde::de::Visitor<'de> for CompactReceiptVisitor {
            type Value = GameCompactReceipt;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("a tuple of 3 or 4 elements")
            }

            fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let command_id = seq
                    .next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
                let accepted = seq
                    .next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(1, &self))?;
                let tick = seq
                    .next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(2, &self))?;
                let reason_code = seq.next_element()?;

                Ok(GameCompactReceipt(command_id, accepted, tick, reason_code))
            }
        }

        deserializer.deserialize_seq(CompactReceiptVisitor)
    }
}

impl Serialize for GameCompactReceipt {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeTuple;
        if let Some(reason) = &self.3 {
            let mut tup = serializer.serialize_tuple(4)?;
            tup.serialize_element(&self.0)?;
            tup.serialize_element(&self.1)?;
            tup.serialize_element(&self.2)?;
            tup.serialize_element(reason)?;
            tup.end()
        } else {
            let mut tup = serializer.serialize_tuple(3)?;
            tup.serialize_element(&self.0)?;
            tup.serialize_element(&self.1)?;
            tup.serialize_element(&self.2)?;
            tup.end()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GamePlayerPositionAck(pub f32, pub f32);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum GameServerPacket {
    #[serde(rename = "game.hello")]
    Hello(GameHello),

    #[serde(rename = "game.snapshot")]
    Snapshot {
        snapshot: GameShardSnapshot,
        receipts: Vec<GameCommandReceipt>,
        events: Vec<serde_json::Value>,
        #[serde(default)]
        #[serde(rename = "compactEvents")]
        compact_events: Option<Vec<serde_json::Value>>,
    },

    #[serde(rename = "game.delta")]
    Delta {
        delta: GameShardDelta,
        receipts: Vec<GameCommandReceipt>,
        events: Vec<serde_json::Value>,
        #[serde(default)]
        #[serde(rename = "compactEvents")]
        compact_events: Option<Vec<serde_json::Value>>,
    },

    #[serde(rename = "game.receipts")]
    Receipts {
        receipts: Vec<GameCommandReceipt>,
        events: Vec<serde_json::Value>,
        #[serde(default)]
        #[serde(rename = "compactEvents")]
        compact_events: Option<Vec<serde_json::Value>>,
    },

    #[serde(rename = "game.acks")]
    Acks {
        acks: Vec<GameCompactReceipt>,
        #[serde(default)]
        #[serde(rename = "playerActor")]
        player_actor: Option<GameActorSnapshot>,
        #[serde(default)]
        #[serde(rename = "playerPosition")]
        player_position: Option<GamePlayerPositionAck>,
        #[serde(default)]
        events: Option<Vec<serde_json::Value>>,
        #[serde(default)]
        #[serde(rename = "compactEvents")]
        compact_events: Option<Vec<serde_json::Value>>,
    },

    #[serde(rename = "game.error")]
    Error { code: String, message: String },

    #[serde(rename = "pong")]
    Pong {
        #[serde(default)]
        #[serde(rename = "requestId")]
        request_id: Option<String>,
        at: f64,
    },
}

// Client->server message name constants
pub const MSG_GAME_READY: &str = "game.ready";
pub const MSG_GAME_COMMAND: &str = "game.command";
pub const MSG_GAME_VIEW: &str = "game.view";
pub const MSG_EXIT_WORLD: &str = "exit_world";
pub const MSG_PING: &str = "ping";

#[cfg(test)]
mod actor_tests {
    use super::*;

    #[test]
    fn decodes_full_actor_snapshot() {
        let json = r##"{
            "id":"npc-1","label":"Raider","display_name":"Raider",
            "areaId":"open-desert-overworld","x":512.0,"y":505.0,"direction":"front",
            "vitals":{"health":80,"action":40,"spirit":10},
            "maxVitals":{"health":100,"action":100,"spirit":100},
            "lifeState":"alive","lifecycleSeq":3,
            "sprite":null,"role":"player","posture":"stand",
            "appearance":{"skinTone":"#cc9978","hair":"hair_short"},
            "worn":[{"slot":"chest","itemId":"jacket_1","colors":["#334455"]}],
            "weapon":{"weaponId":"slugthrower","reloadRemainingTicks":0},
            "factionId":"raiders","pvpStatus":"overt","credits":250
        }"##;
        let a: GameActorSnapshot = serde_json::from_str(json).expect("decode");
        assert_eq!(a.role.as_deref(), Some("player"));
        assert_eq!(
            a.appearance.as_ref().unwrap().skin_tone.as_deref(),
            Some("#cc9978")
        );
        assert_eq!(
            a.appearance.as_ref().unwrap().hair.as_deref(),
            Some("hair_short")
        );
        assert_eq!(a.worn.len(), 1);
        assert_eq!(a.worn[0].item_id.as_deref(), Some("jacket_1"));
        assert_eq!(
            a.weapon.as_ref().unwrap().weapon_id.as_deref(),
            Some("slugthrower")
        );
        assert_eq!(a.max_vitals.health, 100.0);
        assert_eq!(a.credits, Some(250));
        assert_eq!(a.pvp_status.as_deref(), Some("overt"));
    }

    #[test]
    fn decodes_minimal_actor_permissively() {
        // A sparse actor (only core fields) still decodes with defaults.
        let a: GameActorSnapshot =
            serde_json::from_str(r#"{"id":"x","x":1.0,"y":2.0}"#).expect("decode");
        assert_eq!(a.id, "x");
        assert!(a.appearance.is_none());
        assert!(a.worn.is_empty());
    }

    #[test]
    fn decodes_compact_move_and_refs_in_delta() {
        let json = r#"{
            "schema":"successor.authoritative-shard-delta.v1","shardId":"s","tick":10,
            "playerActorId":"p","compactActorMoves":[[7,51200,50300,2]],
            "actorRefs":[[7,"npc-1"]]
        }"#;
        let d: GameShardDelta = serde_json::from_str(json).expect("decode");
        assert_eq!(d.compact_actor_moves.len(), 1);
        let m = d.compact_actor_moves[0];
        assert_eq!((m.0, m.1, m.2, m.3), (7, 51200, 50300, 2));
        assert_eq!(d.actor_refs[0].0, 7);
        assert_eq!(d.actor_refs[0].1, "npc-1");
    }
}

#[cfg(test)]
mod section_tests {
    use super::*;

    #[test]
    fn decodes_snapshot_sections() {
        let json = r#"{
            "schema":"successor.authoritative-shard-snapshot.v1","shardId":"s","tick":5,
            "playerActorId":"p","actors":{},
            "inventory":[{"itemId":1001,"quantity":3}],
            "bank":{"credits":500},
            "propStates":{"door-1":{"open":true}},
            "worldClock":{"dayFraction":0.5},
            "weather":[{"kind":"clear"}],
            "sourceStateHash":"abc","sourceActorCount":42,
            "counters":{"acceptedCommands":10,"rejectedCommands":1,"shotsFired":4,"hits":2,"deaths":0}
        }"#;
        let s: GameShardSnapshot = serde_json::from_str(json).expect("decode snapshot");
        assert_eq!(s.inventory.len(), 1);
        assert!(s.bank.is_some());
        assert_eq!(s.prop_states.len(), 1);
        assert!(s.world_clock.is_some());
        assert_eq!(s.weather.len(), 1);
        assert_eq!(s.source_actor_count, Some(42));
        let c = s.counters.unwrap();
        assert_eq!(c.accepted_commands, 10);
        assert_eq!(c.shots_fired, 4);
    }
}
