//! Authenticated launch/session lifecycle shared by native and WebGL shells.
//! This module is transport-neutral: platform sockets execute the requests and
//! feed events back into these state machines.

use super::release::ReconnectPolicy;
use successor_client_proto::packets::GameHello;

#[derive(Debug, PartialEq, Eq)]
pub struct LaunchEnvelope {
    pub schema: String,
    pub game_ticket: String,
    pub chat_ticket: String,
    pub game_endpoint: String,
    pub chat_endpoint: String,
    pub client_release: String,
    pub server_release: String,
    pub shard: Option<String>,
    pub character_id: String,
    pub expires_at_ms: u64,
    pub dev_spawn: Option<DevSpawn>,
    game_consumed: bool,
    chat_consumed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevSpawn {
    pub area: String,
    pub x: String,
    pub y: String,
    pub facing: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    Invalid(String),
    Expired,
    Replayed,
}

impl LaunchEnvelope {
    /// Strictly validate and consume a standalone launch payload. Tickets are
    /// held only until `authenticate_*` takes them, then removed immediately.
    pub fn from_json(value: &serde_json::Value, now_ms: u64) -> Result<Self, LaunchError> {
        let obj = value
            .as_object()
            .ok_or_else(|| LaunchError::Invalid("launch must be an object".into()))?;
        let get = |k: &str| {
            obj.get(k)
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        };
        if obj.get("schema").and_then(|v| v.as_str()) != Some("successor.launch-context.v1") {
            return Err(LaunchError::Invalid("unsupported launch schema".into()));
        }
        let game_ticket =
            get("gameTicket").ok_or_else(|| LaunchError::Invalid("missing game ticket".into()))?;
        let chat_ticket =
            get("chatTicket").ok_or_else(|| LaunchError::Invalid("missing chat ticket".into()))?;
        if game_ticket == chat_ticket {
            return Err(LaunchError::Invalid("tickets must be distinct".into()));
        }
        let endpoints = obj
            .get("endpoints")
            .and_then(|v| v.as_object())
            .ok_or_else(|| LaunchError::Invalid("missing endpoints".into()))?;
        let endpoint = |key: &str| -> Result<String, LaunchError> {
            let s = endpoints
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| LaunchError::Invalid(format!("missing {key} endpoint")))?;
            if !(s.starts_with("wss://") || s.starts_with("ws://")) {
                return Err(LaunchError::Invalid(format!("invalid {key} endpoint")));
            }
            Ok(s.to_owned())
        };
        let release = obj
            .get("release")
            .and_then(|v| v.as_object())
            .ok_or_else(|| LaunchError::Invalid("missing release".into()))?;
        let client_release = release
            .get("client")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| LaunchError::Invalid("missing client release".into()))?
            .to_owned();
        let server_release = release
            .get("server")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| LaunchError::Invalid("missing server release".into()))?
            .to_owned();
        let character_id =
            get("characterId").ok_or_else(|| LaunchError::Invalid("missing character".into()))?;
        let expires_at_ms = obj
            .get("expiresAt")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| LaunchError::Invalid("invalid expiry".into()))?;
        if expires_at_ms <= now_ms {
            return Err(LaunchError::Expired);
        }
        let dev_spawn = match obj.get("devSpawn") {
            None => None,
            Some(_) if game_ticket != "dev-identity" => {
                return Err(LaunchError::Invalid(
                    "dev spawn requires development identity".into(),
                ));
            }
            Some(value) => {
                let spawn = value
                    .as_object()
                    .ok_or_else(|| LaunchError::Invalid("dev spawn must be an object".into()))?;
                let field = |key: &str| {
                    spawn
                        .get(key)
                        .and_then(|value| value.as_str())
                        .filter(|value| !value.is_empty())
                        .map(str::to_owned)
                        .ok_or_else(|| LaunchError::Invalid(format!("invalid dev spawn {key}")))
                };
                Some(DevSpawn {
                    area: field("area")?,
                    x: field("x")?,
                    y: field("y")?,
                    facing: field("facing")?,
                })
            }
        };
        Ok(Self {
            schema: "successor.launch-context.v1".into(),
            game_ticket,
            chat_ticket,
            game_endpoint: endpoint("game")?,
            chat_endpoint: endpoint("chat")?,
            client_release,
            server_release,
            shard: release
                .get("shard")
                .and_then(|v| v.as_str())
                .map(str::to_owned),
            character_id,
            dev_spawn,
            expires_at_ms,
            game_consumed: false,
            chat_consumed: false,
        })
    }
    pub fn consume_game_ticket(&mut self) -> Result<String, LaunchError> {
        if self.game_consumed {
            return Err(LaunchError::Replayed);
        }
        self.game_consumed = true;
        Ok(std::mem::take(&mut self.game_ticket))
    }
    pub fn consume_chat_ticket(&mut self) -> Result<String, LaunchError> {
        if self.chat_consumed {
            return Err(LaunchError::Replayed);
        }
        self.chat_consumed = true;
        Ok(std::mem::take(&mut self.chat_ticket))
    }
    pub fn tickets_cleared(&self) -> bool {
        self.game_ticket.is_empty() && self.chat_ticket.is_empty()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameConnection {
    Offline,
    Matchmaking,
    Authenticating,
    AwaitingSnapshot,
    Connected,
    Reconnecting,
    Exhausted,
    IntentionalExit,
    Fatal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameFailure {
    Ticket(String),
    Matchmake(String),
    Authentication(String),
    Protocol(String),
    SourceMismatch,
    SnapshotMissing,
    ReconnectExhausted,
}

pub struct GameLifecycle {
    pub state: GameConnection,
    pub reconnect: ReconnectPolicy,
    pub source_hash: Option<String>,
    pub shard: Option<String>,
    pub tick: u64,
    intentional_exit: bool,
}
impl Default for GameLifecycle {
    fn default() -> Self {
        Self {
            state: GameConnection::Offline,
            reconnect: ReconnectPolicy::default(),
            source_hash: None,
            shard: None,
            tick: 0,
            intentional_exit: false,
        }
    }
}
impl GameLifecycle {
    pub fn begin_matchmake(&mut self) {
        self.intentional_exit = false;
        self.state = GameConnection::Matchmaking;
    }
    pub fn authenticated(&mut self) {
        self.state = GameConnection::Authenticating;
    }
    pub fn validate_hello(
        &mut self,
        hello: &GameHello,
        expected_source: Option<&str>,
        expected_shard: Option<&str>,
    ) -> Result<(), GameFailure> {
        if hello.session_id.is_empty() || hello.player_actor_id.is_empty() {
            return Err(GameFailure::SnapshotMissing);
        }
        let snap = &hello.snapshot;
        if snap.schema.is_empty() || !snap.actors.contains_key(&hello.player_actor_id) {
            return Err(GameFailure::SnapshotMissing);
        }
        if snap.source_state_hash.is_none() || snap.source_actor_count.is_none() {
            return Err(GameFailure::SourceMismatch);
        }
        if expected_source.is_some_and(|s| snap.source_state_hash.as_deref() != Some(s))
            || expected_shard.is_some_and(|s| snap.shard_id != s)
        {
            return Err(GameFailure::SourceMismatch);
        }
        self.source_hash = snap.source_state_hash.clone();
        self.shard = Some(snap.shard_id.clone());
        self.tick = snap.tick;
        self.reconnect.reset();
        self.state = GameConnection::Connected;
        Ok(())
    }
    pub fn socket_lost(&mut self) -> Option<u32> {
        if self.intentional_exit {
            self.state = GameConnection::IntentionalExit;
            return None;
        }
        self.state = GameConnection::Reconnecting;
        let d = self.reconnect.record_failure();
        if d.is_none() {
            self.state = GameConnection::Exhausted;
        }
        d
    }
    pub fn intentional_exit(&mut self) {
        self.intentional_exit = true;
        self.state = GameConnection::IntentionalExit;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RosterAction {
    Create,
    Delete,
    Select,
    Enter,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterSummary {
    pub id: String,
    pub name: String,
    pub profession: String,
    pub online: bool,
    pub deletable: bool,
}
#[derive(Debug, Clone, Default)]
pub struct RosterState {
    pub characters: Vec<CharacterSummary>,
    pub selected: Option<String>,
    pub slot_limit: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RosterError {
    InvalidName,
    InvalidProfession,
    NoSlots,
    NotFound,
    OnlineCharacter,
    RequestFailed(String),
}
impl RosterState {
    pub fn replace(&mut self, characters: Vec<CharacterSummary>, slot_limit: u32) {
        self.characters = characters;
        self.slot_limit = slot_limit;
        self.selected = None;
    }
    pub fn select(&mut self, id: &str) -> Result<&CharacterSummary, RosterError> {
        let index = self
            .characters
            .iter()
            .position(|c| c.id == id)
            .ok_or(RosterError::NotFound)?;
        self.selected = Some(id.to_owned());
        Ok(&self.characters[index])
    }
    pub fn validate_create(&self, name: &str, profession: &str) -> Result<(), RosterError> {
        let name = name.trim();
        if !(2..=24).contains(&name.chars().count())
            || !name
                .chars()
                .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
        {
            return Err(RosterError::InvalidName);
        }
        if profession.trim().is_empty() {
            return Err(RosterError::InvalidProfession);
        }
        if self.characters.len() as u32 >= self.slot_limit {
            return Err(RosterError::NoSlots);
        }
        Ok(())
    }
    pub fn validate_delete(&self, id: &str, legacy: bool) -> Result<(), RosterError> {
        let c = self
            .characters
            .iter()
            .find(|c| c.id == id)
            .ok_or(RosterError::NotFound)?;
        if !legacy || !c.deletable {
            return Err(RosterError::RequestFailed("deletion unavailable".into()));
        }
        if c.online {
            return Err(RosterError::OnlineCharacter);
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryState {
    Entry,
    LoadingRoster,
    CharacterSelect,
    Creating,
    Deleting,
    Entering,
    Fatal(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_client_proto::packets::{GameActorSnapshot, GameShardSnapshot};

    fn launch_json() -> serde_json::Value {
        serde_json::json!({
            "schema": "successor.launch-context.v1",
            "gameTicket": "game-ticket",
            "chatTicket": "chat-ticket",
            "endpoints": {
                "game": "wss://world.example/game",
                "chat": "wss://chat.example/chat"
            },
            "release": {
                "client": "client-sha",
                "server": "server-sha",
                "shard": "open-desert"
            },
            "characterId": "player",
            "expiresAt": 2000
        })
    }

    fn hello() -> GameHello {
        let mut snapshot = GameShardSnapshot {
            schema: "successor.authoritative-shard-snapshot.v1".into(),
            shard_id: "open-desert".into(),
            tick: 42,
            player_actor_id: "player".into(),
            source_state_hash: Some("source-hash".into()),
            source_actor_count: Some(1),
            ..GameShardSnapshot::default()
        };
        snapshot
            .actors
            .insert("player".into(), GameActorSnapshot::default());
        GameHello {

            session_id: "session".into(),
            player_actor_id: "player".into(),
            snapshot,
            server_time: "now".into(),
        }
    }
    #[test]
    fn development_spawn_is_explicitly_gated_by_dev_identity() {
        let mut dev = launch_json();
        dev["gameTicket"] = serde_json::json!("dev-identity");
        dev["devSpawn"] = serde_json::json!({
            "area": "open-desert-overworld",
            "x": "700",
            "y": "700",
            "facing": "right"
        });
        let launch = LaunchEnvelope::from_json(&dev, 1000).unwrap();
        assert_eq!(
            launch.dev_spawn,
            Some(DevSpawn {
                area: "open-desert-overworld".into(),
                x: "700".into(),
                y: "700".into(),
                facing: "right".into(),
            })
        );

        let mut hosted = launch_json();
        hosted["devSpawn"] = dev["devSpawn"].clone();
        assert!(matches!(
            LaunchEnvelope::from_json(&hosted, 1000),
            Err(LaunchError::Invalid(_))
        ));
    }

    #[test]
    fn launch_rejects_expired_wrong_schema_wrong_purpose_and_replay() {
        let mut expired = launch_json();
        expired["expiresAt"] = serde_json::json!(1000);
        assert_eq!(
            LaunchEnvelope::from_json(&expired, 1000),
            Err(LaunchError::Expired)
        );

        let mut schema = launch_json();
        schema["schema"] = serde_json::json!("successor.launch-context.v0");
        assert!(matches!(
            LaunchEnvelope::from_json(&schema, 1),
            Err(LaunchError::Invalid(_))
        ));

        let mut same_ticket = launch_json();
        same_ticket["chatTicket"] = same_ticket["gameTicket"].clone();
        assert!(matches!(
            LaunchEnvelope::from_json(&same_ticket, 1),
            Err(LaunchError::Invalid(_))
        ));

        let mut launch = LaunchEnvelope::from_json(&launch_json(), 1).unwrap();
        assert_eq!(launch.consume_game_ticket().unwrap(), "game-ticket");
        assert_eq!(launch.consume_game_ticket(), Err(LaunchError::Replayed));
        assert_eq!(launch.consume_chat_ticket().unwrap(), "chat-ticket");
        assert_eq!(launch.consume_chat_ticket(), Err(LaunchError::Replayed));
        assert!(launch.tickets_cleared());
    }

    #[test]
    fn hello_fails_closed_on_source_shard_or_snapshot_mismatch() {
        let mut lifecycle = GameLifecycle::default();
        assert_eq!(
            lifecycle.validate_hello(&hello(), Some("wrong"), Some("open-desert")),
            Err(GameFailure::SourceMismatch)
        );
        assert_ne!(lifecycle.state, GameConnection::Connected);

        assert_eq!(
            lifecycle.validate_hello(&hello(), Some("source-hash"), Some("wrong-shard")),
            Err(GameFailure::SourceMismatch)
        );
        let mut missing = hello();
        missing.snapshot.actors.clear();
        assert_eq!(
            lifecycle.validate_hello(&missing, None, None),
            Err(GameFailure::SnapshotMissing)
        );
    }

    #[test]
    fn socket_loss_exhausts_bounded_reconnect_and_exit_does_not_retry() {
        let mut lifecycle = GameLifecycle {
            reconnect: ReconnectPolicy::new(2, 1, 2),
            ..GameLifecycle::default()
        };
        assert_eq!(lifecycle.socket_lost(), Some(1));
        assert_eq!(lifecycle.socket_lost(), Some(2));
        assert_eq!(lifecycle.socket_lost(), None);
        assert_eq!(lifecycle.state, GameConnection::Exhausted);

        lifecycle.intentional_exit();
        assert_eq!(lifecycle.socket_lost(), None);
        assert_eq!(lifecycle.state, GameConnection::IntentionalExit);
    }
}
