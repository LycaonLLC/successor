#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatChannel {
    All,
    Local,
    Zone,
    Global,
    Combat,
    Trade,
    Party,
    Guild,
    Whisper,
    System,
}

impl ChatChannel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChatChannel::All => "all",
            ChatChannel::Local => "local",
            ChatChannel::Zone => "zone",
            ChatChannel::Global => "global",
            ChatChannel::Combat => "combat",
            ChatChannel::Trade => "trade",
            ChatChannel::Party => "party",
            ChatChannel::Guild => "guild",
            ChatChannel::Whisper => "whisper",
            ChatChannel::System => "system",
        }
    }

    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "all" => Some(ChatChannel::All),
            "local" => Some(ChatChannel::Local),
            "zone" => Some(ChatChannel::Zone),
            "global" => Some(ChatChannel::Global),
            "combat" => Some(ChatChannel::Combat),
            "trade" => Some(ChatChannel::Trade),
            "party" => Some(ChatChannel::Party),
            "guild" => Some(ChatChannel::Guild),
            "whisper" => Some(ChatChannel::Whisper),
            "system" => Some(ChatChannel::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ChatView {
    #[default]
    All,
    Global,
    Combat,
    Friends,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatMessage {
    pub channel: ChatChannel,
    pub sender: String,
    pub text: String,
    pub whisper_to: Option<String>,
}

pub fn encode_outgoing(msg: &ChatMessage) -> String {
    let frame = serde_json::json!({
        "type": "chat.send",
        "requestId": "0",
        "channel": msg.channel.as_str(),
        "body": msg.text,
        "targetId": msg.whisper_to,
    });
    serde_json::to_string(&frame).unwrap_or_default()
}

pub fn decode_incoming(json: &str) -> Option<ChatMessage> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;

    // Check type
    let packet_type = v.get("type").and_then(|t| t.as_str())?;

    if packet_type == "chat.send" {
        let channel_str = v.get("channel").and_then(|c| c.as_str())?;
        let channel = ChatChannel::from_str(channel_str)?;
        let text = v.get("body").and_then(|b| b.as_str())?.to_string();
        let whisper_to = v
            .get("targetId")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());

        return Some(ChatMessage {
            channel,
            sender: String::new(),
            text,
            whisper_to,
        });
    }

    if packet_type == "chat.message" {
        let message = v.get("message")?;
        let channel_str = message.get("channel").and_then(|c| c.as_str())?;
        let channel = ChatChannel::from_str(channel_str)?;

        let text = message
            .get("body")
            .or_else(|| message.get("text"))
            .and_then(|b| b.as_str())?
            .to_string();

        let sender = if let Some(sender_val) = message.get("sender") {
            if let Some(display_name) = sender_val.get("displayName").and_then(|d| d.as_str()) {
                display_name.to_string()
            } else if let Some(sender_str) = sender_val.as_str() {
                sender_str.to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };

        let whisper_to = message
            .get("targetId")
            .or_else(|| message.get("target_id"))
            .or_else(|| message.get("whisper_to"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());

        return Some(ChatMessage {
            channel,
            sender,
            text,
            whisper_to,
        });
    }

    // Direct ChatMessage object
    if let Some(channel_str) = v.get("channel").and_then(|c| c.as_str()) {
        if let Some(channel) = ChatChannel::from_str(channel_str) {
            let text = v
                .get("body")
                .or_else(|| v.get("text"))
                .and_then(|b| b.as_str())?
                .to_string();

            let sender = if let Some(sender_val) = v.get("sender") {
                if let Some(display_name) = sender_val.get("displayName").and_then(|d| d.as_str()) {
                    display_name.to_string()
                } else if let Some(sender_str) = sender_val.as_str() {
                    sender_str.to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            let whisper_to = v
                .get("targetId")
                .or_else(|| v.get("target_id"))
                .or_else(|| v.get("whisper_to"))
                .and_then(|t| t.as_str())
                .map(|s| s.to_string());

            return Some(ChatMessage {
                channel,
                sender,
                text,
                whisper_to,
            });
        }
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatConnectionState {
    Offline,
    Connecting,
    Authenticating,
    SyncingHistory,
    Online,
    Reconnecting,
    Degraded,
    Exhausted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocialRequest {
    FriendAdd(String),
    FriendRemove(String),
    IgnoreAdd(String),
    IgnoreRemove(String),
    Presence(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatCommand {
    Send(ChatChannel, String, Option<String>),
    Social(SocialRequest),
    Invalid(String),
}

/// Separate chat transport state. Gameplay remains usable when this state is
/// degraded; authentication failures are terminal to chat only.
pub struct ChatConnection {
    pub state: ChatConnectionState,
    pub endpoint: String,
    pub history_cursor: Option<String>,
    pub reconnect_attempt: u32,
    pub max_reconnect_attempts: u32,
    pub pending_requests: Vec<String>,
    /// Last server error is retained for the HUD, but never includes secrets.
    pub last_error: Option<String>,
}

impl ChatConnection {
    pub fn new(endpoint: String) -> Self {
        Self {
            state: ChatConnectionState::Offline,
            endpoint,
            history_cursor: None,
            reconnect_attempt: 0,
            max_reconnect_attempts: 5,
            pending_requests: Vec::new(),
            last_error: None,
        }
    }
    pub fn begin(&mut self) {
        self.state = ChatConnectionState::Connecting;
        self.last_error = None;
    }
    /// Takes the one-use ticket and builds the first authenticated frame.
    /// The ticket is never retained in the connection after this call.
    pub fn authenticate(
        &mut self,
        ticket: &mut Option<String>,
        client_release: &str,
    ) -> Option<String> {
        let value = ticket.take()?;
        if client_release.is_empty() {
            return None;
        }
        self.state = ChatConnectionState::Authenticating;
        Some(
            serde_json::json!({
                "type":"chat.authenticate",
                "chatTicket":value,
                "release":client_release,
            })
            .to_string(),
        )
    }
    pub fn authenticated(&mut self) {
        self.state = ChatConnectionState::SyncingHistory;
        self.reconnect_attempt = 0;
    }
    pub fn history_loaded(&mut self, cursor: Option<String>) {
        self.history_cursor = cursor;
        self.state = ChatConnectionState::Online;
    }
    pub fn failed(&mut self, message: &str) {
        self.last_error = Some(bounded_text(message));
        self.state = ChatConnectionState::Degraded;
    }
    pub fn lost(&mut self) -> bool {
        if self.reconnect_attempt >= self.max_reconnect_attempts {
            self.state = ChatConnectionState::Exhausted;
            return false;
        }
        self.reconnect_attempt += 1;
        self.state = ChatConnectionState::Reconnecting;
        true
    }
    pub fn request_id(&mut self, prefix: &str) -> String {
        let id = format!(
            "{prefix}-{}",
            self.pending_requests.len() as u32 + self.reconnect_attempt + 1
        );
        self.pending_requests.push(id.clone());
        id
    }
    pub fn complete_request(&mut self, id: &str) {
        self.pending_requests.retain(|v| v != id);
    }
}

fn bounded_text(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(200)
        .collect()
}

pub fn parse_input(channel: ChatChannel, input: &str) -> ChatCommand {
    let text = bounded_text(input.trim());
    if text.is_empty() {
        return ChatCommand::Invalid("empty message".into());
    }
    if !text.starts_with('/') {
        return ChatCommand::Send(channel, text, None);
    }
    let mut p = text.splitn(3, ' ');
    match p.next().unwrap_or_default() {
        "/w" | "/whisper" => match (p.next(), p.next()) {
            (Some(target), Some(body)) if !target.is_empty() => ChatCommand::Send(
                ChatChannel::Whisper,
                bounded_text(body),
                Some(target.to_owned()),
            ),
            _ => ChatCommand::Invalid("usage: /whisper <player> <message>".into()),
        },
        "/friend" => match (p.next(), p.next()) {
            (Some("add"), Some(id)) => ChatCommand::Social(SocialRequest::FriendAdd(id.to_owned())),
            (Some("add"), None) => ChatCommand::Invalid("missing player".into()),
            (Some("remove"), Some(id)) => {
                ChatCommand::Social(SocialRequest::FriendRemove(id.to_owned()))
            }
            (Some(id), _) => ChatCommand::Social(SocialRequest::FriendAdd(id.to_owned())),
            _ => ChatCommand::Invalid("missing player".into()),
        },
        "/unfriend" => p
            .next()
            .map(|id| ChatCommand::Social(SocialRequest::FriendRemove(id.to_owned())))
            .unwrap_or_else(|| ChatCommand::Invalid("missing player".into())),
        "/ignore" => match (p.next(), p.next()) {
            (Some("add"), Some(id)) => ChatCommand::Social(SocialRequest::IgnoreAdd(id.to_owned())),
            (Some("remove"), Some(id)) => {
                ChatCommand::Social(SocialRequest::IgnoreRemove(id.to_owned()))
            }
            (Some(id), _) => ChatCommand::Social(SocialRequest::IgnoreAdd(id.to_owned())),
            _ => ChatCommand::Invalid("missing player".into()),
        },
        "/unignore" => p
            .next()
            .map(|id| ChatCommand::Social(SocialRequest::IgnoreRemove(id.to_owned())))
            .unwrap_or_else(|| ChatCommand::Invalid("missing player".into())),
        "/status" => p
            .next()
            .map(|s| ChatCommand::Social(SocialRequest::Presence(s.to_owned())))
            .unwrap_or_else(|| ChatCommand::Invalid("missing status".into())),
        _ => ChatCommand::Invalid("unknown chat command".into()),
    }
}
pub struct ChatClient {
    pub history: Vec<ChatMessage>,
    pub cap: usize,
    pub connection: ChatConnection,
    pub friends: Vec<String>,
    pub ignored: Vec<String>,
    pub active_view: ChatView,
    pub send_channel: ChatChannel,
    pub last_error: Option<String>,
    pub presence: Option<String>,
}

impl ChatClient {
    pub fn new(cap: usize) -> Self {
        Self {
            history: Vec::with_capacity(cap),
            cap,
            connection: ChatConnection::new(String::new()),
            friends: Vec::new(),
            ignored: Vec::new(),
            active_view: ChatView::All,
            send_channel: ChatChannel::Local,
            last_error: None,
            presence: None,
        }
    }
    pub fn with_endpoint(cap: usize, endpoint: String) -> Self {
        let mut c = Self::new(cap);
        c.connection = ChatConnection::new(endpoint);
        c
    }
    pub fn apply_social(&mut self, request: SocialRequest) {
        let (list, add, id) = match request {
            SocialRequest::FriendAdd(id) => (&mut self.friends, true, id),
            SocialRequest::FriendRemove(id) => (&mut self.friends, false, id),
            SocialRequest::IgnoreAdd(id) => (&mut self.ignored, true, id),
            SocialRequest::IgnoreRemove(id) => (&mut self.ignored, false, id),
            SocialRequest::Presence(status) => {
                self.presence = Some(status);
                return;
            }
        };
        if add {
            if !list.iter().any(|x| x == &id) && list.len() < 128 {
                list.push(id);
            }
        } else {
            list.retain(|x| x != &id);
        }
    }
    pub fn history_request(&mut self, limit: usize) -> String {
        let request_id = self.connection.request_id("history");
        serde_json::json!({"type":"chat.history","requestId":request_id,"limit":limit.min(100),"before":self.connection.history_cursor}).to_string()
    }
    pub fn ping(&mut self) -> String {
        let request_id = self.connection.request_id("ping");
        serde_json::json!({"type":"ping","requestId":request_id}).to_string()
    }
    pub fn submit_input(&mut self, input: &str) -> ChatCommand {
        parse_input(self.send_channel, input)
    }
    /// Encode a parsed line using the server's chat-room vocabulary.
    pub fn command_frame(&mut self, command: ChatCommand) -> Option<String> {
        let request_id = self.connection.request_id("chat");
        let frame = match command {
            ChatCommand::Send(channel, body, target) => serde_json::json!({
                "type":"chat.send","requestId":request_id,"channel":channel.as_str(),
                "body":bounded_text(&body),"targetId":target
            }),
            ChatCommand::Social(SocialRequest::FriendAdd(id)) => {
                serde_json::json!({"type":"friend.add","requestId":request_id,"friendId":bounded_text(&id)})
            }
            ChatCommand::Social(SocialRequest::FriendRemove(id)) => {
                serde_json::json!({"type":"friend.remove","requestId":request_id,"friendId":bounded_text(&id)})
            }
            ChatCommand::Social(SocialRequest::IgnoreAdd(id)) => {
                serde_json::json!({"type":"ignore.add","requestId":request_id,"targetId":bounded_text(&id)})
            }
            ChatCommand::Social(SocialRequest::IgnoreRemove(id)) => {
                serde_json::json!({"type":"ignore.remove","requestId":request_id,"targetId":bounded_text(&id)})
            }
            ChatCommand::Social(SocialRequest::Presence(status)) => {
                serde_json::json!({"type":"presence.set","requestId":request_id,"status":bounded_text(&status)})
            }
            ChatCommand::Invalid(error) => {
                self.connection.complete_request(&request_id);
                self.last_error = Some(bounded_text(&error));
                return None;
            }
        };
        serde_json::to_string(&frame).ok()
    }
    pub fn on_incoming(&mut self, json: &str) -> Option<ChatMessage> {
        let value: serde_json::Value = serde_json::from_str(json).ok()?;
        if let Some(id) = value.get("requestId").and_then(|v| v.as_str()) {
            self.connection.complete_request(id);
        }
        match value.get("type").and_then(|v| v.as_str()) {
            Some("chat.hello") => {
                self.connection.authenticated();
                let msg = ChatMessage {
                    channel: ChatChannel::System,
                    sender: String::new(),
                    text: "Connected to chat.".into(),
                    whisper_to: None,
                };
                self.record(&msg);
                Some(msg)
            }
            Some("chat.history") => {
                if let Some(messages) = value.get("messages").and_then(|v| v.as_array()) {
                    for message in messages {
                        if let Ok(raw) = serde_json::to_string(
                            &serde_json::json!({"type":"chat.message","message":message}),
                        ) {
                            let _ = self.on_incoming(&raw);
                        }
                    }
                }
                self.connection.history_loaded(None);
                None
            }
            Some("chat.error") => {
                self.last_error = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .map(bounded_text);
                self.connection
                    .failed(self.last_error.as_deref().unwrap_or("chat error"));
                None
            }
            Some("friends.snapshot") => {
                self.friends = value
                    .get("friends")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.get("id").and_then(|v| v.as_str()).map(str::to_owned))
                            .take(128)
                            .collect()
                    })
                    .unwrap_or_default();
                None
            }
            Some("friend.event") => {
                if let Some(id) = value.pointer("/friend/id").and_then(|v| v.as_str()) {
                    let added = value.get("action").and_then(|v| v.as_str()) == Some("added");
                    self.apply_social(if added {
                        SocialRequest::FriendAdd(id.into())
                    } else {
                        SocialRequest::FriendRemove(id.into())
                    });
                }
                None
            }
            Some("presence.update") => None,
            Some("pong") => None,
            _ => {
                let msg = decode_incoming(json)?;
                if self.cap > 0 {
                    while self.history.len() >= self.cap {
                        self.history.remove(0);
                    }
                    self.history.push(msg.clone());
                }
                Some(msg)
            }
        }
    }
    fn record(&mut self, msg: &ChatMessage) {
        if self.cap == 0 {
            return;
        }
        while self.history.len() >= self.cap {
            self.history.remove(0);
        }
        self.history.push(msg.clone());
    }
    pub fn recent_channel(&self, channel: ChatChannel) -> impl Iterator<Item = &ChatMessage> {
        self.history
            .iter()
            .filter(move |m| m.channel == channel || channel == ChatChannel::All)
    }
    pub fn compose(&self, channel: ChatChannel, text: &str, whisper_to: Option<String>) -> String {
        encode_outgoing(&ChatMessage {
            channel,
            sender: String::new(),
            text: bounded_text(text),
            whisper_to,
        })
    }
    pub fn recent(&self) -> &[ChatMessage] {
        &self.history
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_round_trip() {
        let channels = [
            ChatChannel::All,
            ChatChannel::Local,
            ChatChannel::Zone,
            ChatChannel::Global,
            ChatChannel::Trade,
            ChatChannel::Party,
            ChatChannel::Guild,
            ChatChannel::Whisper,
            ChatChannel::System,
        ];
        for ch in channels {
            let s = ch.as_str();
            let parsed = ChatChannel::from_str(s).expect("from_str failed");
            assert_eq!(parsed, ch);
        }
    }

    #[test]
    fn compose_decode_round_trip() {
        let client = ChatClient::new(10);
        let channels = [
            ChatChannel::Local,
            ChatChannel::Zone,
            ChatChannel::Global,
            ChatChannel::Trade,
            ChatChannel::Party,
            ChatChannel::Guild,
            ChatChannel::Whisper,
        ];

        for ch in channels {
            let text = "Hello, world!";
            let whisper = if ch == ChatChannel::Whisper {
                Some("recipient123".to_string())
            } else {
                None
            };

            let json = client.compose(ch, text, whisper.clone());
            let decoded = decode_incoming(&json).expect("Failed to decode outgoing frame");
            assert_eq!(decoded.channel, ch);
            assert_eq!(decoded.text, text);
            assert_eq!(decoded.whisper_to, whisper);
        }
    }

    #[test]
    fn history_bounds_cap() {
        let mut client = ChatClient::new(3);

        // Pushing server-like chat message packets
        let packets = [
            r#"{"type":"chat.message","message":{"channel":"local","sender":{"id":"1","displayName":"Alice"},"body":"Msg 1"}}"#,
            r#"{"type":"chat.message","message":{"channel":"local","sender":{"id":"2","displayName":"Bob"},"body":"Msg 2"}}"#,
            r#"{"type":"chat.message","message":{"channel":"local","sender":{"id":"3","displayName":"Charlie"},"body":"Msg 3"}}"#,
            r#"{"type":"chat.message","message":{"channel":"local","sender":{"id":"4","displayName":"David"},"body":"Msg 4"}}"#,
        ];

        for p in packets {
            client.on_incoming(p).expect("Should parse valid message");
        }

        let recent = client.recent();
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].text, "Msg 2");
        assert_eq!(recent[0].sender, "Bob");
        assert_eq!(recent[1].text, "Msg 3");
        assert_eq!(recent[1].sender, "Charlie");
        assert_eq!(recent[2].text, "Msg 4");
        assert_eq!(recent[2].sender, "David");
    }

    #[test]
    fn decode_defensive_malformed() {
        assert!(decode_incoming("").is_none());
        assert!(decode_incoming("{").is_none());
        assert!(decode_incoming(r#"{"type":"chat.message"}"#).is_none());
        assert!(decode_incoming(r#"{"type":"chat.message","message":{}}"#).is_none());
        assert!(decode_incoming(r#"{"type":"chat.send","channel":"local"}"#).is_none());
    }
}
