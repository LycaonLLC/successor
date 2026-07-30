//! DATAPAD — Tabbed info terminal for missions, map markers, and logs.
use super::{WindowAction, ACCENT, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug, Default)]
pub struct DatapadEntry {
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Default)]
pub struct DatapadModel {
    pub selected_tab: String,
    pub missions: Vec<DatapadEntry>,
    pub map_entries: Vec<DatapadEntry>,
    pub log_entries: Vec<DatapadEntry>,
}

impl DatapadModel {
    pub fn sample() -> Self {
        Self {
            selected_tab: "MISSIONS".into(),
            missions: vec![
                DatapadEntry {
                    title: "COLLECT SCRAP METAL".into(),
                    body: "RECOVER 10 UNITS OF SCRAP METAL FROM THE ABANDONED WASTELAND IN SECTOR 4.".into(),
                },
                DatapadEntry {
                    title: "CONTACT SPY".into(),
                    body: "MEET AGENT KESTREL AT THE OUTPOST BAR AND RETRIEVE THE ENCRYPTED DATAPACK.".into(),
                },
            ],
            map_entries: vec![
                DatapadEntry {
                    title: "DUSTGATE OUTPOST".into(),
                    body: "SECTOR 4 - GRID E5. SAFE ZONE WITH TRADERS, BANK, AND RECLAMATION STATION.".into(),
                },
                DatapadEntry {
                    title: "SCRAP YARD".into(),
                    body: "SECTOR 2 - GRID B3. WARNING: FREQUENT PIRATE PATROLS AND HIGH RADIATION.".into(),
                },
            ],
            log_entries: vec![
                DatapadEntry {
                    title: "SYSTEM BOOT".into(),
                    body: "LOGICAL DRIVE CHECK OK. SECURE COMS READY. ENCRYPTED LINK SECURED.".into(),
                },
                DatapadEntry {
                    title: "SIGNAL INTERCEPT".into(),
                    body: "UNIDENTIFIED TRANSMISSION DETECTED IN SECTOR 3. SOURCE UNKNOWN.".into(),
                },
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
    model: &DatapadModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    let tab_w = 120.0;
    let content_x = x + tab_w + 10.0;
    let content_w = w - tab_w - 20.0;

    // Draw tab buttons on the left
    let tabs = ["MISSIONS", "MAP", "LOG"];
    let button_style = ButtonStyle::default();
    let mut tab_y = y + 10.0;
    let tab_h = 30.0;
    let tab_gap = 6.0;

    for tab in &tabs {
        if tab_y + tab_h > y + h - 10.0 {
            break;
        }

        let mut style = button_style;
        if model.selected_tab.to_uppercase() == *tab {
            style.fill = [70, 92, 120, 240];
        }

        if ui.button(x + 10.0, tab_y, tab_w, tab_h, tab, style) {
            out.push(WindowAction::Button(format!("datapad:tab:{}", tab.to_lowercase())));
        }
        tab_y += tab_h + tab_gap;
    }

    // Separator line between left tabs and right content
    ui.rect(x + tab_w + 4.0, y + 10.0, 1.0, h - 20.0, SLOT_EDGE);

    // Right content pane showing selected section's entries
    let entries = match model.selected_tab.to_uppercase().as_str() {
        "MISSIONS" => &model.missions,
        "MAP" => &model.map_entries,
        "LOG" => &model.log_entries,
        _ => &model.missions,
    };

    let mut cur_y = y + 10.0;
    let text_px = 1.6;
    let title_px = 1.8;

    for entry in entries {
        if cur_y + title_px * 8.0 > y + h - 10.0 {
            break;
        }

        // Draw entry title
        ui.text(&entry.title.to_uppercase(), content_x, cur_y, title_px, ACCENT);
        cur_y += title_px * 8.0 + 4.0;

        // Draw entry body (wrapped)
        let max_chars = (content_w / (6.0 * text_px)).floor() as usize;
        let wrapped_body = wrap_text(&entry.body, max_chars);
        for line in &wrapped_body {
            if cur_y + text_px * 8.0 > y + h - 10.0 {
                break;
            }
            ui.text(&line.to_uppercase(), content_x, cur_y, text_px, TEXT);
            cur_y += text_px * 8.0 + 3.0;
        }

        cur_y += 12.0;

        // Draw entry separator line if we have space left
        if cur_y < y + h - 20.0 {
            ui.rect(content_x, cur_y - 6.0, content_w, 1.0, SLOT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::ui::UiBuilder;

    #[test]
    fn datapad_tab_click_emits_button_action() {
        let icons = Icons::load();
        let model = DatapadModel {
            selected_tab: "MISSIONS".into(),
            missions: vec![],
            map_entries: vec![],
            log_entries: vec![],
        };
        let mut ui = UiBuilder::new(icons.meta);

        // Position coordinates calculated to hit the "MAP" tab (second tab).
        let bx = 170.0;
        let by = 161.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);

        assert!(out.contains(&WindowAction::Button("datapad:tab:map".into())));
    }
}
