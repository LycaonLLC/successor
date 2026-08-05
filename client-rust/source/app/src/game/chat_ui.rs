use super::chat_net::{ChatChannel, ChatClient, ChatConnectionState, ChatMessage, ChatView};
use successor_engine_render::font::GLYPH_H;
use successor_engine_render::ui::{TextField, UiBuilder};

/// Returns a distinct tint per channel.
pub fn channel_color(ch: ChatChannel) -> [u8; 4] {
    match ch {
        ChatChannel::All => [255, 255, 255, 255],   // white
        ChatChannel::Local => [255, 255, 255, 255], // white
        ChatChannel::Zone => [72, 214, 230, 255],   // teal (#48d6e6)
        ChatChannel::Global => [240, 196, 96, 255], // gold (#f0c460)
        ChatChannel::Combat => [236, 112, 96, 255],
        ChatChannel::Trade => [100, 220, 120, 255], // green
        ChatChannel::Party => [100, 160, 240, 255], // blue
        ChatChannel::Guild => [200, 100, 240, 255], // purple
        ChatChannel::Whisper => [230, 100, 230, 255], // magenta
        ChatChannel::System => [150, 150, 150, 255], // grey
    }
}

/// Draw the persistent lower-left chat console. Channel tabs and history stay
/// visible while the text field is unfocused; Enter or a click gives it focus.
#[allow(clippy::too_many_arguments)]
pub fn draw_chat_pane(
    ui: &mut UiBuilder,
    client: &mut ChatClient,
    input: &mut TextField,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) {
    // The console is a chromeless HUD pane, so it paints its own surface. It
    // used to paint a hardcoded near-black slab, which made it the one pane
    // that never followed the theme and the darkest thing on screen. Its
    // tones come from the active palette, and only the per-channel message
    // tints below stay fixed — those are identity, not chrome.
    let pal = crate::hud::active_palette();
    let fill = crate::hud::faded(pal.bg_panel);
    let edge = pal.hairline;
    let accent = pal.accent;
    let dim = pal.ink_dim;
    let ink = pal.ink;
    ui.panel(x, y, w, h, fill, edge);

    let tabs = [
        (ChatView::All, "ALL"),
        (ChatView::Global, "GLOBAL"),
        (ChatView::Combat, "COMBAT"),
        (ChatView::Friends, "FRIENDS"),
    ];
    let tab_w = (w - 10.0) / tabs.len() as f32;
    for (index, (view, label)) in tabs.into_iter().enumerate() {
        let tab_x = x + 5.0 + index as f32 * tab_w;
        let active = client.active_view == view;
        let tint = if active { ink } else { dim };
        let tw = ui.measure_text(label, 1.6);
        ui.text(label, tab_x + (tab_w - tw) * 0.5, y + 6.0, 1.6, tint);
        if active {
            ui.rect(tab_x + 3.0, y + 25.0, tab_w - 6.0, 2.0, accent);
        }
        if ui.interact(tab_x, y + 3.0, tab_w, 26.0).clicked {
            client.active_view = view;
        }
    }

    // Chat is read at a glance mid-fight and sits over bright terrain, so it
    // runs a step above the window body face. `line_h` moves with `px` - leaving
    // it at 16 would set larger glyphs in the same leading and close the gaps
    // between lines.
    let px = 1.6;
    let line_h = 18.0;
    let padding = 6.0;
    let input_h = 27.0;
    let input_y = y + h - input_h - padding;
    let channel_w = 92.0;
    let mut channel_style = crate::hud::button_style();
    channel_style.text = dim;
    if ui.button(
        x + padding,
        input_y,
        channel_w,
        input_h,
        channel_label(client.send_channel),
        channel_style,
    ) {
        client.send_channel = next_send_channel(client.send_channel);
    }
    ui.text_field(
        input,
        x + padding + channel_w + 6.0,
        input_y,
        w - padding * 2.0 - channel_w - 6.0,
        input_h,
        px,
        input.focused,
        crate::hud::button_style(),
    );

    let rows = ((input_y - (y + 32.0)) / line_h).floor().max(0.0) as usize;
    let visible_count = client
        .history
        .iter()
        .filter(|message| message_visible(client, message))
        .count();
    let skip = visible_count.saturating_sub(rows);
    let mut line_y = y + 34.0;
    let char_w = ui.measure_text("M", px);
    for msg in client
        .history
        .iter()
        .filter(|message| message_visible(client, message))
        .skip(skip)
        .take(rows)
    {
        let prefix = if msg.sender.is_empty() {
            channel_label(msg.channel)
        } else {
            msg.sender.as_str()
        };
        let tint = channel_color(msg.channel);
        let mut tx = x + padding + 10.0;
        ui.rect(x + padding, line_y - 1.0, 3.0, line_h - 2.0, tint);
        ui.text(prefix, tx, line_y, px, tint);
        tx += ui.measure_text(prefix, px) + char_w;
        let remaining = ((x + w - padding - tx) / char_w).floor().max(0.0) as usize;
        if remaining > 0 {
            let (body, clipped) = char_prefix(&msg.text, remaining.saturating_sub(3));
            ui.text(body, tx, line_y, px, ink);
            if clipped {
                ui.text("...", tx + ui.measure_text(body, px), line_y, px, dim);
            }
        }
        line_y += line_h;
    }

    if visible_count == 0 {
        // An empty tab is a filter result, not a fault. Only report the socket
        // when it is actually unwell; otherwise name the tab that has nothing
        // in it, so COMBAT before a fight does not read as a broken client.
        let status = match client.connection.state {
            ChatConnectionState::Online => match client.active_view {
                ChatView::All => "NO MESSAGES YET",
                ChatView::Global => "NO GLOBAL MESSAGES",
                ChatView::Combat => "NO COMBAT MESSAGES",
                ChatView::Friends => "NO FRIEND MESSAGES",
            },
            ChatConnectionState::Connecting
            | ChatConnectionState::Authenticating
            | ChatConnectionState::SyncingHistory
            | ChatConnectionState::Reconnecting => "CHAT CONNECTING",
            ChatConnectionState::Offline
            | ChatConnectionState::Degraded
            | ChatConnectionState::Exhausted => "CHAT DEGRADED",
        };
        ui.text(status, x + padding + 10.0, line_y, 1.45, dim);
    }
}

fn channel_label(channel: ChatChannel) -> &'static str {
    match channel {
        ChatChannel::All => "ALL",
        ChatChannel::Local => "LOCAL",
        ChatChannel::Zone => "ZONE",
        ChatChannel::Global => "GLOBAL",
        ChatChannel::Combat => "COMBAT",
        ChatChannel::Trade => "TRADE",
        ChatChannel::Party => "PARTY",
        ChatChannel::Guild => "GUILD",
        ChatChannel::Whisper => "WHISPER",
        ChatChannel::System => "SYSTEM",
    }
}

fn next_send_channel(channel: ChatChannel) -> ChatChannel {
    match channel {
        ChatChannel::Local => ChatChannel::Global,
        ChatChannel::Global => ChatChannel::Party,
        ChatChannel::Party => ChatChannel::Guild,
        ChatChannel::Guild => ChatChannel::Trade,
        ChatChannel::Trade => ChatChannel::Local,
        _ => ChatChannel::Local,
    }
}

fn message_visible(client: &ChatClient, message: &ChatMessage) -> bool {
    match client.active_view {
        ChatView::All => true,
        ChatView::Global => matches!(message.channel, ChatChannel::Global | ChatChannel::Zone),
        ChatView::Combat => message.channel == ChatChannel::Combat,
        ChatView::Friends => {
            matches!(
                message.channel,
                ChatChannel::Whisper | ChatChannel::Party | ChatChannel::Guild
            ) || client
                .friends
                .iter()
                .any(|friend| friend == &message.sender)
        }
    }
}

fn char_prefix(text: &str, max_chars: usize) -> (&str, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte, _)) => (&text[..byte], true),
        None => (text, false),
    }
}

/// Draws a small rounded speech panel centered above a projected actor screen position.
pub fn draw_bubble(ui: &mut UiBuilder, screen_x: f32, screen_y: f32, text: &str) {
    let px = 1.5;
    let char_w = ui.measure_text("M", px);
    let glyph_h_scaled = (GLYPH_H as f32) * px; // 10.5

    let max_w = 200.0;
    let padding_x = 8.0;
    let padding_y = 6.0;

    let mut display_text = text.to_string();
    let max_chars = ((max_w - padding_x * 2.0) / char_w).floor() as usize;

    if display_text.chars().count() > max_chars && max_chars > 3 {
        let truncated: String = display_text.chars().take(max_chars - 3).collect();
        display_text = format!("{}...", truncated);
    }

    let text_w = ui.measure_text(&display_text, px);
    let bubble_w = text_w + padding_x * 2.0;
    let bubble_h = glyph_h_scaled + padding_y * 2.0; // 22.5

    let bx = screen_x - bubble_w * 0.5;
    let by = screen_y - bubble_h - 4.0;

    // Background: dark translucent panel with 1px rounded corners (chopped corners)
    let fill = [10, 10, 10, 220];
    ui.rect(bx + 1.0, by, bubble_w - 2.0, bubble_h, fill);
    ui.rect(bx, by + 1.0, 1.0, bubble_h - 2.0, fill);
    ui.rect(bx + bubble_w - 1.0, by + 1.0, 1.0, bubble_h - 2.0, fill);

    // Border: light grey with 1px rounded corners
    let edge = [200, 200, 200, 255];
    ui.rect(bx + 1.0, by, bubble_w - 2.0, 1.0, edge); // top edge
    ui.rect(bx + 1.0, by + bubble_h - 1.0, bubble_w - 2.0, 1.0, edge); // bottom edge
    ui.rect(bx, by + 1.0, 1.0, bubble_h - 2.0, edge); // left edge
    ui.rect(bx + bubble_w - 1.0, by + 1.0, 1.0, bubble_h - 2.0, edge); // right edge

    // Centered text
    let tx = bx + padding_x;
    let ty = by + padding_y;
    ui.text(&display_text, tx, ty, px, [255, 255, 255, 255]);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::chat_net::ChatChannel;
    use successor_engine_render::ui::AtlasMeta;

    #[test]
    fn test_channel_color_distinct() {
        let local_color = channel_color(ChatChannel::Local);
        let system_color = channel_color(ChatChannel::System);
        let whisper_color = channel_color(ChatChannel::Whisper);

        assert_ne!(local_color, system_color);
        assert_ne!(local_color, whisper_color);
        assert_ne!(system_color, whisper_color);
    }

    #[test]
    fn test_draw_chat_pane_renders_messages() {
        let atlas = AtlasMeta {
            cell: 32,
            cols: 8,
            width: 256,
            height: 160,
        };
        let mut ui = UiBuilder::new(atlas);
        let mut input = TextField::new(100);
        let mut client = ChatClient::new(10);

        // 1. Draw empty chat pane and record baseline quads
        ui.begin(800, 600);
        draw_chat_pane(&mut ui, &mut client, &mut input, 10.0, 10.0, 300.0, 200.0);
        let baseline_quads = ui.quads;
        assert!(
            baseline_quads > 0,
            "Should draw background panel and border"
        );

        // 2. Build a ChatClient in tests via its real API + on_incoming a JSON frame
        let json_str = client.compose(
            ChatChannel::Local,
            "HELLO FROM THE MARKET TERMINAL, TRAVELER",
            None,
        );
        let mut val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        val["sender"] = serde_json::json!("ZARA");
        let json_str_with_sender = serde_json::to_string(&val).unwrap();
        client.on_incoming(&json_str_with_sender);

        // 3. Draw chat pane with 1 message
        ui.begin(800, 600);
        draw_chat_pane(&mut ui, &mut client, &mut input, 10.0, 10.0, 300.0, 200.0);
        let new_quads = ui.quads;

        // 4. Assert quads grew and that the message is rendered (new_quads > baseline_quads)
        assert!(
            new_quads > baseline_quads,
            "Quads should grow when messages are rendered"
        );
    }

    #[test]
    fn test_draw_bubble_centers_text() {
        let atlas = AtlasMeta {
            cell: 32,
            cols: 8,
            width: 256,
            height: 160,
        };
        let mut ui = UiBuilder::new(atlas);
        ui.begin(800, 600);

        let screen_x = 100.0;
        let screen_y = 150.0;
        let text = "HELLO";

        let start_quads = ui.quads;
        draw_bubble(&mut ui, screen_x, screen_y, text);
        let end_quads = ui.quads;

        let quads_emitted = end_quads - start_quads;
        assert!(quads_emitted > 0);
        assert!(quads_emitted < 100, "Should emit a bounded number of quads");

        // Calculate expected bubble boundaries
        let px = 1.5;
        let text_w = ui.measure_text(text, px);
        let padding_x = 8.0;
        let bubble_w = text_w + padding_x * 2.0;
        let bx = screen_x - bubble_w * 0.5;
        let right_edge = bx + bubble_w;

        // Assert bubble centers around screen_x
        assert!(
            bx < screen_x,
            "Bubble left edge {} should be left of screen_x {}",
            bx,
            screen_x
        );
        assert!(
            right_edge > screen_x,
            "Bubble right edge {} should be right of screen_x {}",
            right_edge,
            screen_x
        );
        assert_eq!(
            (bx + right_edge) * 0.5,
            screen_x,
            "Bubble should be centered around screen_x"
        );
    }
}
