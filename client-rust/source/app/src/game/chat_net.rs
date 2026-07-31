#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatChannel {
    All,
    Local,
    Zone,
    Global,
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
            "trade" => Some(ChatChannel::Trade),
            "party" => Some(ChatChannel::Party),
            "guild" => Some(ChatChannel::Guild),
            "whisper" => Some(ChatChannel::Whisper),
            "system" => Some(ChatChannel::System),
            _ => None,
        }
    }
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

pub struct ChatClient {
    pub history: Vec<ChatMessage>,
    pub cap: usize,
}

impl ChatClient {
    pub fn new(cap: usize) -> Self {
        Self {
            history: Vec::with_capacity(cap),
            cap,
        }
    }

    pub fn on_incoming(&mut self, json: &str) -> Option<ChatMessage> {
        if let Some(msg) = decode_incoming(json) {
            if self.cap > 0 {
                while self.history.len() >= self.cap {
                    self.history.remove(0);
                }
                self.history.push(msg.clone());
            }
            Some(msg)
        } else {
            None
        }
    }

    pub fn compose(&self, channel: ChatChannel, text: &str, whisper_to: Option<String>) -> String {
        let msg = ChatMessage {
            channel,
            sender: String::new(),
            text: text.to_string(),
            whisper_to,
        };
        encode_outgoing(&msg)
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
