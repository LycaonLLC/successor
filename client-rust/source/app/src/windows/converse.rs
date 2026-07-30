//! CONVERSE — NPC dialogue window with response choices.
use super::{WindowAction, ACCENT, DIM, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug, Default)]
pub struct DialogueChoice {
    pub label: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Default)]
pub struct ConverseModel {
    pub speaker_name: String,
    pub speaker_role: String,
    pub prompt: String,
    pub choices: Vec<DialogueChoice>,
}

impl ConverseModel {
    pub fn sample() -> Self {
        Self {
            speaker_name: "COMMANDER VANCE".into(),
            speaker_role: "TRAINER".into(),
            prompt: "WELCOME TO THE DUSTGATE OUTPOST, RECRUIT. WE NEED TO GET YOU EQUIPPED AND OUT IN THE FIELD. HAVE YOU CHECKED IN WITH THE QUARTERMASTER YET?".into(),
            choices: vec![
                DialogueChoice { label: "YES, I HAVE THE GEAR.".into(), enabled: true },
                DialogueChoice { label: "NOT YET. WHERE IS THE QUARTERMASTER?".into(), enabled: true },
                DialogueChoice { label: "I DON'T NEED ANY GEAR.".into(), enabled: false },
            ],
        }
    }
}

fn wrap_text(text: &str, max_chars: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let max_chars = max_chars.max(1);
    for line in text.split('\n') {
        let mut current_line = String::new();
        for word in line.split_whitespace() {
            if current_line.is_empty() {
                current_line.push_str(word);
            } else if current_line.len() + 1 + word.len() <= max_chars {
                current_line.push(' ');
                current_line.push_str(word);
            } else {
                lines.push(current_line);
                current_line = word.to_string();
            }
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }
    lines
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &ConverseModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Draw speaker name and role
    ui.text(&model.speaker_name.to_uppercase(), x + 10.0, y + 10.0, 2.0, ACCENT);
    ui.text(&model.speaker_role.to_uppercase(), x + 10.0, y + 30.0, 1.5, DIM);

    // Separator line
    ui.rect(x + 10.0, y + 48.0, w - 20.0, 1.0, SLOT_EDGE);

    // Draw wrapped dialogue prompt
    let prompt_y = y + 60.0;
    let text_px = 1.8;
    let wrap_w = w - 40.0;
    let max_chars = (wrap_w / (6.0 * text_px)).floor() as usize;
    let wrapped_lines = wrap_text(&model.prompt, max_chars);

    let mut cur_y = prompt_y;
    for line in &wrapped_lines {
        if cur_y + text_px * 8.0 > y + h - 10.0 {
            break;
        }
        ui.text(&line.to_uppercase(), x + 20.0, cur_y, text_px, TEXT);
        cur_y += text_px * 8.0 + 4.0;
    }

    // Separator before choices
    cur_y += 10.0;
    if cur_y < y + h - 40.0 {
        ui.rect(x + 10.0, cur_y, w - 20.0, 1.0, SLOT_EDGE);
    }
    cur_y += 15.0;

    // Vertical list of response choices
    let button_h = 30.0;
    let button_gap = 8.0;
    let button_style = ButtonStyle::default();

    for (i, choice) in model.choices.iter().enumerate() {
        if cur_y + button_h > y + h - 10.0 {
            break;
        }
        let mut style = button_style;
        if !choice.enabled {
            style.fill = [20, 25, 30, 210];
            style.edge = [40, 45, 50, 255];
            style.text = [100, 105, 110, 255];
        }
        let label = format!("{}. {}", i + 1, choice.label.to_uppercase());
        if ui.button(x + 20.0, cur_y, w - 40.0, button_h, &label, style) {
            if choice.enabled {
                out.push(WindowAction::DialogueChoice(i));
            }
        }
        cur_y += button_h + button_gap;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::ui::UiBuilder;

    #[test]
    fn converse_choice_emits_dialogue_choice() {
        let icons = Icons::load();
        let model = ConverseModel {
            speaker_name: "TEST".into(),
            speaker_role: "TESTER".into(),
            prompt: "HELLO".into(),
            choices: vec![
                DialogueChoice { label: "CHOICE 1".into(), enabled: true },
            ],
        };
        let mut ui = UiBuilder::new(icons.meta);

        // Position coordinates calculated to hit the first button.
        let bx = 350.0;
        let by = 218.4;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 600.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 600.0], &model, &icons, &mut out);

        assert!(out.contains(&WindowAction::DialogueChoice(0)));
    }
}
