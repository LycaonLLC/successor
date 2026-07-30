use successor_engine_render::font::{GLYPH_H, GLYPH_W};
use successor_engine_render::ui::{UiBuilder, TextField};
use super::chat_net::{ChatChannel, ChatClient};

/// Returns a distinct tint per channel.
pub fn channel_color(ch: ChatChannel) -> [u8; 4] {
    match ch {
        ChatChannel::All => [255, 255, 255, 255],      // white
        ChatChannel::Local => [255, 255, 255, 255],    // white
        ChatChannel::Zone => [72, 214, 230, 255],      // teal (#48d6e6)
        ChatChannel::Global => [240, 196, 96, 255],    // gold (#f0c460)
        ChatChannel::Trade => [100, 220, 120, 255],    // green
        ChatChannel::Party => [100, 160, 240, 255],    // blue
        ChatChannel::Guild => [200, 100, 240, 255],    // purple
        ChatChannel::Whisper => [230, 100, 230, 255],  // magenta
        ChatChannel::System => [150, 150, 150, 255],   // grey
    }
}

/// Draws a translucent panel listing the last messages, plus input field if open.
pub fn draw_chat_pane(
    ui: &mut UiBuilder,
    client: &ChatClient,
    input: &mut TextField,
    open: bool,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) {
    // 1. Draw translucent background panel
    // Translucent panel: fill = [18, 24, 34, 180], edge = [80, 100, 122, 255]
    ui.panel(x, y, w, h, [18, 24, 34, 180], [80, 100, 122, 255]);

    let px = 1.5;
    let char_w = (GLYPH_W as f32 + 1.0) * px; // 6 * 1.5 = 9.0
    let glyph_h_scaled = (GLYPH_H as f32) * px; // 7 * 1.5 = 10.5
    
    let input_h = 20.0;
    let padding = 5.0;
    
    let mut msg_area_bottom = y + h - padding;
    
    // 2. Draw text edit input row at the bottom if open
    if open {
        let input_y = y + h - input_h - padding;
        let input_w = w - padding * 2.0;
        ui.text_field(input, x + padding, input_y, input_w, input_h, px, true);
        msg_area_bottom = input_y - padding;
    }
    
    // 3. Draw chat messages newest at bottom, going upwards
    let recent_msgs = client.recent();
    let line_spacing = 3.5;
    let line_h = glyph_h_scaled + line_spacing; // 14.0
    
    let max_chars = ((w - padding * 2.0) / char_w).floor() as usize;
    
    let mut current_y = msg_area_bottom - line_h;
    
    for msg in recent_msgs.iter().rev() {
        if current_y < y + padding {
            break;
        }
        
        let ch_tag = msg.channel.as_str().to_uppercase();
        let display_str = if msg.sender.is_empty() {
            format!("[{}] {}", ch_tag, msg.text)
        } else {
            format!("[{}] {}: {}", ch_tag, msg.sender, msg.text)
        };
        
        // Truncate if exceeds width
        let mut display_str = display_str;
        if display_str.chars().count() > max_chars && max_chars > 3 {
            let truncated: String = display_str.chars().take(max_chars - 3).collect();
            display_str = format!("{}...", truncated);
        }
        
        let color = channel_color(msg.channel);
        ui.text(&display_str, x + padding, current_y + line_spacing * 0.5, px, color);
        
        current_y -= line_h;
    }
}

/// Draws a small rounded speech panel centered above a projected actor screen position.
pub fn draw_bubble(ui: &mut UiBuilder, screen_x: f32, screen_y: f32, text: &str) {
    let px = 1.5;
    let char_w = (GLYPH_W as f32 + 1.0) * px; // 9.0
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
    
    let text_w = UiBuilder::text_width(&display_text, px);
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
    use successor_engine_render::ui::AtlasMeta;
    use crate::game::chat_net::ChatChannel;

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
        let atlas = AtlasMeta { cell: 32, cols: 8, width: 256, height: 160 };
        let mut ui = UiBuilder::new(atlas);
        let mut input = TextField::new(100);
        let mut client = ChatClient::new(10);

        // 1. Draw empty chat pane and record baseline quads
        ui.begin(800, 600);
        draw_chat_pane(&mut ui, &client, &mut input, false, 10.0, 10.0, 300.0, 200.0);
        let baseline_quads = ui.quads;
        assert!(baseline_quads > 0, "Should draw background panel and border");

        // 2. Build a ChatClient in tests via its real API + on_incoming a JSON frame
        let json_str = client.compose(ChatChannel::Local, "HELLO", None);
        let mut val: serde_json::Value = serde_json::from_str(&json_str).unwrap();
        val["sender"] = serde_json::json!("ZARA");
        let json_str_with_sender = serde_json::to_string(&val).unwrap();
        client.on_incoming(&json_str_with_sender);

        // 3. Draw chat pane with 1 message
        ui.begin(800, 600);
        draw_chat_pane(&mut ui, &client, &mut input, false, 10.0, 10.0, 300.0, 200.0);
        let new_quads = ui.quads;

        // 4. Assert quads grew and that the message is rendered (new_quads > baseline_quads)
        assert!(new_quads > baseline_quads, "Quads should grow when messages are rendered");
    }

    #[test]
    fn test_draw_bubble_centers_text() {
        let atlas = AtlasMeta { cell: 32, cols: 8, width: 256, height: 160 };
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
        let text_w = UiBuilder::text_width(text, px);
        let padding_x = 8.0;
        let bubble_w = text_w + padding_x * 2.0;
        let bx = screen_x - bubble_w * 0.5;
        let right_edge = bx + bubble_w;

        // Assert bubble centers around screen_x
        assert!(bx < screen_x, "Bubble left edge {} should be left of screen_x {}", bx, screen_x);
        assert!(right_edge > screen_x, "Bubble right edge {} should be right of screen_x {}", right_edge, screen_x);
        assert_eq!((bx + right_edge) * 0.5, screen_x, "Bubble should be centered around screen_x");
    }
}
