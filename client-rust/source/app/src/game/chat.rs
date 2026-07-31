//! Client-side chat UI: a line editor (Enter opens, types, Enter submits) plus
//! a bounded ring of recent lines rendered as `TextOverlay`s.
//!
//! Scope note: this is the chat PRESENTATION and input. The LOCAL chat network
//! path is a separate Colyseus chat room (a second connection using the
//! `client/src/chat/chatClient.ts` vocabulary and a chat ticket) — that
//! transport is a tracked PARITY follow-up, since it needs the chat-room
//! protocol and a live authority to verify. `submit()` returns the entered text
//! so a future chat-room sender can transmit it.

use successor_engine_core::math::Vec2;
use successor_engine_render::components::TextOverlay;

pub struct ChatState {
    pub open: bool,
    input: String,
    lines: Vec<String>,
    cap: usize,
}

impl ChatState {
    pub fn new(cap: usize) -> Self {
        Self {
            open: false,
            input: String::new(),
            lines: Vec::with_capacity(cap),
            cap,
        }
    }

    /// Enter toggles the editor open, or submits a non-empty line when open.
    /// Returns `Some(text)` when a line is submitted.
    pub fn on_enter(&mut self) -> Option<String> {
        if !self.open {
            self.open = true;
            return None;
        }
        let text = self.input.trim().to_string();
        self.input.clear();
        self.open = false;
        if text.is_empty() {
            None
        } else {
            self.push_local(&text);
            Some(text)
        }
    }

    pub fn on_char(&mut self, c: char) {
        if self.open && !c.is_control() && self.input.len() < 200 {
            self.input.push(c);
        }
    }

    pub fn on_backspace(&mut self) {
        if self.open {
            self.input.pop();
        }
    }

    pub fn escape(&mut self) {
        self.open = false;
        self.input.clear();
    }

    fn push_local(&mut self, text: &str) {
        self.push_line(&format!("you: {text}"));
    }

    /// Record an incoming chat line (e.g. LOCAL bubble text from another actor).
    pub fn push_incoming(&mut self, who: &str, text: &str) {
        self.push_line(&format!("{who}: {text}"));
    }

    fn push_line(&mut self, line: &str) {
        if self.lines.len() == self.cap {
            self.lines.remove(0);
        }
        self.lines.push(line.to_string());
    }

    pub fn lines(&self) -> &[String] {
        &self.lines
    }

    /// Build overlays for the recent lines plus the active input line.
    pub fn overlays(&self, out: &mut Vec<TextOverlay>) {
        let base_y = 0.80;
        for (i, line) in self.lines.iter().enumerate() {
            out.push(TextOverlay::new(
                line,
                Vec2 {
                    x: 0.02,
                    y: base_y + i as f32 * 0.03,
                },
                [200, 210, 220, 255],
            ));
        }
        if self.open {
            let s = format!("> {}", self.input);
            out.push(TextOverlay::new(
                &s,
                Vec2 { x: 0.02, y: 0.96 },
                [255, 240, 120, 255],
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enter_opens_then_submits() {
        let mut c = ChatState::new(8);
        assert_eq!(c.on_enter(), None, "first Enter opens");
        assert!(c.open);
        for ch in "hello".chars() {
            c.on_char(ch);
        }
        assert_eq!(c.on_enter().as_deref(), Some("hello"));
        assert!(!c.open);
        assert_eq!(c.lines().last().map(String::as_str), Some("you: hello"));
    }

    #[test]
    fn incoming_ring_is_bounded() {
        let mut c = ChatState::new(2);
        c.push_incoming("a", "1");
        c.push_incoming("b", "2");
        c.push_incoming("c", "3");
        assert_eq!(c.lines().len(), 2);
        assert_eq!(c.lines()[0], "b: 2");
        assert_eq!(c.lines()[1], "c: 3");
    }

    #[test]
    fn typing_only_when_open() {
        let mut c = ChatState::new(4);
        c.on_char('x'); // closed -> ignored
        c.on_enter(); // open
        c.on_char('y');
        assert_eq!(c.on_enter().as_deref(), Some("y"));
    }
}
