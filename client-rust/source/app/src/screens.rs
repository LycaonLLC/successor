use crate::net::connect::JoinOptions;
use successor_engine_render::ui::{ButtonStyle, TextField, UiBuilder};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenAction {
    Connect(JoinOptions),
    SelectCharacter(usize),
    CreateCharacter(String),
    Back,
    Quit,
}

pub struct EntryLayout;
impl EntryLayout {
    pub const PANEL_W: f32 = 400.0;
    pub const PANEL_H: f32 = 300.0;
    pub const FIELD_H: f32 = 30.0;
    pub const BUTTON_H: f32 = 35.0;
    pub const PADDING: f32 = 40.0;

    pub const TITLE_Y: f32 = 20.0;
    pub const ENDPOINT_Y: f32 = 85.0;
    pub const PLAYER_Y: f32 = 145.0;
    pub const PLAY_Y: f32 = 200.0;
    pub const QUIT_Y: f32 = 245.0;

    pub fn panel_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let x = (w - Self::PANEL_W) * 0.5;
        let y = (h - Self::PANEL_H) * 0.5;
        (x, y, Self::PANEL_W, Self::PANEL_H)
    }

    pub fn endpoint_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::ENDPOINT_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::FIELD_H)
    }

    pub fn player_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::PLAYER_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::FIELD_H)
    }

    pub fn play_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::PLAY_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::BUTTON_H)
    }

    pub fn quit_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::QUIT_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::BUTTON_H)
    }
}

pub struct EntryScreen {
    pub endpoint: TextField,
    pub player: TextField,
}

impl EntryScreen {
    pub fn new() -> Self {
        let mut endpoint = TextField::new(128);
        endpoint.text = "ws://127.0.0.1:28093/".to_string();
        endpoint.caret = endpoint.text.len();

        let mut player = TextField::new(32);
        player.text = "dev-1".to_string();
        player.caret = player.text.len();

        Self { endpoint, player }
    }

    pub fn draw(&mut self, ui: &mut UiBuilder, w: f32, h: f32) -> Option<ScreenAction> {
        let (px, py, pw, ph) = EntryLayout::panel_rect(w, h);
        ui.panel(px, py, pw, ph, [20, 28, 38, 240], [80, 100, 122, 255]);

        let title = "SUCCESSOR";
        let title_size = 3.0;
        let tw = UiBuilder::text_width(title, title_size);
        let tx = px + (EntryLayout::PANEL_W - tw) * 0.5;
        let ty = py + EntryLayout::TITLE_Y;
        ui.text(title, tx, ty, title_size, [240, 196, 96, 255]);

        let label_color = [150, 170, 190, 255];
        ui.text("ENDPOINT", px + EntryLayout::PADDING, py + EntryLayout::ENDPOINT_Y - 15.0, 1.5, label_color);
        let (ex, ey, ew, eh) = EntryLayout::endpoint_rect(w, h);
        let ep_focused = self.endpoint.focused;
        ui.text_field(&mut self.endpoint, ex, ey, ew, eh, 2.0, ep_focused);

        ui.text("PLAYER ID", px + EntryLayout::PADDING, py + EntryLayout::PLAYER_Y - 15.0, 1.5, label_color);
        let (rx, ry, rw, rh) = EntryLayout::player_rect(w, h);
        let pl_focused = self.player.focused;
        ui.text_field(&mut self.player, rx, ry, rw, rh, 2.0, pl_focused);

        let (play_x, play_y, play_w, play_h) = EntryLayout::play_rect(w, h);
        if ui.button(play_x, play_y, play_w, play_h, "PLAY", ButtonStyle::default()) {
            return Some(ScreenAction::Connect(JoinOptions {
                endpoint: self.endpoint.text.clone(),
                player_id: self.player.text.clone(),
                actor_id: self.player.text.clone(),
                ticket: None,
                release: None,
            }));
        }

        let (quit_x, quit_y, quit_w, quit_h) = EntryLayout::quit_rect(w, h);
        if ui.button(quit_x, quit_y, quit_w, quit_h, "QUIT", ButtonStyle::default()) {
            return Some(ScreenAction::Quit);
        }

        None
    }
}

pub struct CharacterLayout;
impl CharacterLayout {
    pub const PANEL_W: f32 = 450.0;
    pub const PANEL_H: f32 = 400.0;
    pub const PADDING: f32 = 30.0;
    pub const ROW_H: f32 = 30.0;
    pub const ROW_SPACING: f32 = 5.0;
    pub const FIELD_H: f32 = 30.0;
    pub const BUTTON_H: f32 = 35.0;

    pub const ROSTER_Y: f32 = 60.0;
    pub const NAME_LABEL_Y: f32 = 250.0;
    pub const NAME_FIELD_Y: f32 = 270.0;
    pub const CREATE_Y: f32 = 310.0;
    pub const BACK_Y: f32 = 350.0;

    pub fn panel_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let x = (w - Self::PANEL_W) * 0.5;
        let y = (h - Self::PANEL_H) * 0.5;
        (x, y, Self::PANEL_W, Self::PANEL_H)
    }

    pub fn roster_row_rect(w: f32, h: f32, idx: usize) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        let rx = px + Self::PADDING;
        let ry = py + Self::ROSTER_Y + idx as f32 * (Self::ROW_H + Self::ROW_SPACING);
        let rw = Self::PANEL_W - Self::PADDING * 2.0;
        (rx, ry, rw, Self::ROW_H)
    }

    pub fn name_field_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::NAME_FIELD_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::FIELD_H)
    }

    pub fn create_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::CREATE_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::BUTTON_H)
    }

    pub fn back_rect(w: f32, h: f32) -> (f32, f32, f32, f32) {
        let (px, py, _, _) = Self::panel_rect(w, h);
        (px + Self::PADDING, py + Self::BACK_Y, Self::PANEL_W - Self::PADDING * 2.0, Self::BUTTON_H)
    }
}

pub struct CharacterScreen {
    pub roster: Vec<String>,
    pub name_input: TextField,
}

impl CharacterScreen {
    pub fn new(roster: Vec<String>) -> Self {
        let name_input = TextField::new(32);
        Self { roster, name_input }
    }

    pub fn draw(&mut self, ui: &mut UiBuilder, w: f32, h: f32) -> Option<ScreenAction> {
        let (px, py, pw, ph) = CharacterLayout::panel_rect(w, h);
        ui.panel(px, py, pw, ph, [20, 28, 38, 240], [80, 100, 122, 255]);

        let title = "SELECT CHAR";
        let title_size = 2.5;
        let tw = UiBuilder::text_width(title, title_size);
        let tx = px + (CharacterLayout::PANEL_W - tw) * 0.5;
        let ty = py + 15.0;
        ui.text(title, tx, ty, title_size, [240, 196, 96, 255]);

        let label_color = [150, 170, 190, 255];
        ui.text("CHARACTER ROSTER", px + CharacterLayout::PADDING, py + CharacterLayout::ROSTER_Y - 15.0, 1.5, label_color);

        for (i, name) in self.roster.iter().enumerate() {
            let (rx, ry, rw, rh) = CharacterLayout::roster_row_rect(w, h, i);
            if ui.button(rx, ry, rw, rh, name, ButtonStyle::default()) {
                return Some(ScreenAction::SelectCharacter(i));
            }
        }

        ui.text("NEW CHARACTER NAME", px + CharacterLayout::PADDING, py + CharacterLayout::NAME_LABEL_Y - 15.0, 1.5, label_color);
        let (nx, ny, nw, nh) = CharacterLayout::name_field_rect(w, h);
        let name_focused = self.name_input.focused;
        ui.text_field(&mut self.name_input, nx, ny, nw, nh, 2.0, name_focused);

        let (cx, cy, cw, ch) = CharacterLayout::create_rect(w, h);
        if ui.button(cx, cy, cw, ch, "CREATE", ButtonStyle::default()) {
            return Some(ScreenAction::CreateCharacter(self.name_input.text.clone()));
        }

        let (bx, by, bw, bh) = CharacterLayout::back_rect(w, h);
        if ui.button(bx, by, bw, bh, "BACK", ButtonStyle::default()) {
            return Some(ScreenAction::Back);
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::ui::AtlasMeta;

    const ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };

    #[test]
    fn test_entry_screen_new() {
        let screen = EntryScreen::new();
        assert_eq!(screen.endpoint.text, "ws://127.0.0.1:28093/");
        assert_eq!(screen.player.text, "dev-1");
    }

    #[test]
    fn test_entry_screen_play_click() {
        let mut screen = EntryScreen::new();
        let mut ui = UiBuilder::new(ATLAS);
        let w = 1280.0;
        let h = 720.0;

        let (bx, by, bw, bh) = EntryLayout::play_rect(w, h);
        let click_x = bx + bw * 0.5;
        let click_y = by + bh * 0.5;

        // Frame 1: Mouse down
        ui.set_input(click_x, click_y, true);
        ui.begin(w as u32, h as u32);
        let res1 = screen.draw(&mut ui, w, h);
        assert!(res1.is_none());

        // Frame 2: Mouse up (click)
        ui.set_input(click_x, click_y, false);
        ui.begin(w as u32, h as u32);
        let res2 = screen.draw(&mut ui, w, h);

        match res2 {
            Some(ScreenAction::Connect(opts)) => {
                assert_eq!(opts.endpoint, "ws://127.0.0.1:28093/");
                assert_eq!(opts.player_id, "dev-1");
                assert_eq!(opts.actor_id, "dev-1");
                assert!(opts.ticket.is_none());
                assert!(opts.release.is_none());
            }
            other => panic!("Expected Some(ScreenAction::Connect), got {:?}", other),
        }
    }

    #[test]
    fn test_entry_screen_quit_click() {
        let mut screen = EntryScreen::new();
        let mut ui = UiBuilder::new(ATLAS);
        let w = 1280.0;
        let h = 720.0;

        let (bx, by, bw, bh) = EntryLayout::quit_rect(w, h);
        let click_x = bx + bw * 0.5;
        let click_y = by + bh * 0.5;

        // Frame 1: Mouse down
        ui.set_input(click_x, click_y, true);
        ui.begin(w as u32, h as u32);
        let res1 = screen.draw(&mut ui, w, h);
        assert!(res1.is_none());

        // Frame 2: Mouse up
        ui.set_input(click_x, click_y, false);
        ui.begin(w as u32, h as u32);
        let res2 = screen.draw(&mut ui, w, h);
        assert_eq!(res2, Some(ScreenAction::Quit));
    }

    #[test]
    fn test_character_screen_select() {
        let mut screen = CharacterScreen::new(vec!["ALICE".to_string(), "BOB".to_string()]);
        let mut ui = UiBuilder::new(ATLAS);
        let w = 1280.0;
        let h = 720.0;

        // Target index 1 ("BOB")
        let (bx, by, bw, bh) = CharacterLayout::roster_row_rect(w, h, 1);
        let click_x = bx + bw * 0.5;
        let click_y = by + bh * 0.5;

        // Frame 1: Mouse down
        ui.set_input(click_x, click_y, true);
        ui.begin(w as u32, h as u32);
        let res1 = screen.draw(&mut ui, w, h);
        assert!(res1.is_none());

        // Frame 2: Mouse up
        ui.set_input(click_x, click_y, false);
        ui.begin(w as u32, h as u32);
        let res2 = screen.draw(&mut ui, w, h);
        assert_eq!(res2, Some(ScreenAction::SelectCharacter(1)));
    }

    #[test]
    fn test_character_screen_create() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.name_input.text = "CHARLIE".to_string();
        screen.name_input.caret = screen.name_input.text.len();

        let mut ui = UiBuilder::new(ATLAS);
        let w = 1280.0;
        let h = 720.0;

        let (bx, by, bw, bh) = CharacterLayout::create_rect(w, h);
        let click_x = bx + bw * 0.5;
        let click_y = by + bh * 0.5;

        // Frame 1: Mouse down
        ui.set_input(click_x, click_y, true);
        ui.begin(w as u32, h as u32);
        let res1 = screen.draw(&mut ui, w, h);
        assert!(res1.is_none());

        // Frame 2: Mouse up
        ui.set_input(click_x, click_y, false);
        ui.begin(w as u32, h as u32);
        let res2 = screen.draw(&mut ui, w, h);
        assert_eq!(res2, Some(ScreenAction::CreateCharacter("CHARLIE".to_string())));
    }
}
