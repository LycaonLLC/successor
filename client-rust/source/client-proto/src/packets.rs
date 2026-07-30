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
    #[serde(rename = "lifeState")]
    pub life_state: String,
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
    #[serde(rename = "lifeState")]
    pub life_state: Option<String>,
}

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
                let command_id = seq.next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(0, &self))?;
                let accepted = seq.next_element()?
                    .ok_or_else(|| serde::de::Error::invalid_length(1, &self))?;
                let tick = seq.next_element()?
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
    Error {
        code: String,
        message: String,
    },
    
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
