//! CRAFT — crafting bench with recipe list and detailed requirements.

use super::{WindowAction, TEXT, DIM, ACCENT, SLOT, SLOT_EDGE};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle};

#[derive(Clone, Debug, Default)]
pub struct CraftIngredient {
    pub name: String,
    pub required_qty: u32,
    pub carried_qty: u32,
}

#[derive(Clone, Debug, Default)]
pub struct CraftRecipe {
    pub id: String,
    pub name: String,
    pub category: String, // "WEAPON", "TOOL", "COMPONENT", "SUPPLY"
    pub output_item_id: u32,
    pub output_item_name: String,
    pub ingredients: Vec<CraftIngredient>,
}

#[derive(Clone, Debug, Default)]
pub struct CraftModel {
    pub recipes: Vec<CraftRecipe>,
    pub selected_recipe_id: Option<String>,
}

impl CraftModel {
    pub fn sample() -> Self {
        let recipes = vec![
            CraftRecipe {
                id: "extractor_battery".to_string(),
                name: "Extractor Battery".to_string(),
                category: "COMPONENT".to_string(),
                output_item_id: 3201,
                output_item_name: "Extractor Battery".to_string(),
                ingredients: vec![
                    CraftIngredient {
                        name: "Copper".to_string(),
                        required_qty: 24,
                        carried_qty: 12,
                    },
                    CraftIngredient {
                        name: "Iron".to_string(),
                        required_qty: 12,
                        carried_qty: 12,
                    },
                    CraftIngredient {
                        name: "Fuel".to_string(),
                        required_qty: 12,
                        carried_qty: 15,
                    },
                ],
            },
            CraftRecipe {
                id: "field_multitool".to_string(),
                name: "Field Multitool".to_string(),
                category: "TOOL".to_string(),
                output_item_id: 3001,
                output_item_name: "Field Multitool".to_string(),
                ingredients: vec![
                    CraftIngredient {
                        name: "Copper".to_string(),
                        required_qty: 6,
                        carried_qty: 12,
                    },
                    CraftIngredient {
                        name: "Iron".to_string(),
                        required_qty: 6,
                        carried_qty: 12,
                    },
                ],
            },
            CraftRecipe {
                id: "metal_extractor".to_string(),
                name: "Personal Mineral Sampler".to_string(),
                category: "TOOL".to_string(),
                output_item_id: 3006,
                output_item_name: "Personal Mineral Sampler".to_string(),
                ingredients: vec![
                    CraftIngredient {
                        name: "Iron".to_string(),
                        required_qty: 80,
                        carried_qty: 12,
                    },
                    CraftIngredient {
                        name: "Copper".to_string(),
                        required_qty: 36,
                        carried_qty: 12,
                    },
                ],
            },
            CraftRecipe {
                id: "scattergun_pattern".to_string(),
                name: "Scattergun".to_string(),
                category: "WEAPON".to_string(),
                output_item_id: 1005,
                output_item_name: "Scattergun".to_string(),
                ingredients: vec![
                    CraftIngredient {
                        name: "Iron".to_string(),
                        required_qty: 20,
                        carried_qty: 12,
                    },
                    CraftIngredient {
                        name: "Copper".to_string(),
                        required_qty: 10,
                        carried_qty: 12,
                    },
                ],
            },
        ];
        Self {
            recipes,
            selected_recipe_id: Some("extractor_battery".to_string()),
        }
    }
}

fn is_craftable(recipe: &CraftRecipe) -> bool {
    recipe.ingredients.iter().all(|ing| ing.carried_qty >= ing.required_qty)
}

fn ingredient_bar(ui: &mut UiBuilder, x: f32, y: f32, w: f32, carried: u32, required: u32, label: &str) {
    let frac = if required > 0 { carried as f32 / required as f32 } else { 1.0 };
    ui.rect(x, y, w, 18.0, SLOT);
    if frac > 0.0 {
        let fill_color = if carried >= required {
            [70, 140, 80, 235] // green
        } else {
            [160, 60, 60, 235] // red
        };
        ui.rect(x, y, w * frac.clamp(0.0, 1.0), 18.0, fill_color);
    }
    ui.border(x, y, w, 18.0, 1.0, SLOT_EDGE);
    let bar_text = format!("{} {}/{}", label.to_uppercase(), carried, required);
    ui.text(&bar_text, x + 6.0, y + 3.0, 1.6, TEXT);
}

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &CraftModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, h] = rect;

    // Split layout
    let list_w = (w * 0.45).clamp(180.0, 320.0);
    let detail_w = w - list_w - 8.0;

    // ── Recipe List ──────────────────────────────────────────────────────
    ui.text("KNOWN RECIPES", x, y + 2.0, 2.0, DIM);

    for (i, recipe) in model.recipes.iter().enumerate() {
        let ry = y + 24.0 + i as f32 * 46.0;
        if ry + 40.0 > y + h {
            break; // Clip list to vertical bounds
        }
        let resp = ui.interact(x, ry, list_w, 40.0);
        let selected = model.selected_recipe_id.as_ref() == Some(&recipe.id);
        let craftable = is_craftable(recipe);

        let fill = if selected {
            [46, 62, 86, 235]
        } else if resp.hovered {
            [36, 48, 64, 230]
        } else {
            SLOT
        };
        ui.rect(x, ry, list_w, 40.0, fill);
        let border_col = if selected { ACCENT } else { SLOT_EDGE };
        ui.border(x, ry, list_w, 40.0, if selected { 1.5 } else { 1.0 }, border_col);

        // Name
        let name_col = if craftable { ACCENT } else { TEXT };
        ui.text(&recipe.name, x + 6.0, ry + 4.0, 1.6, name_col);

        // Ingredients summary
        let mut summary = String::new();
        for (idx, ing) in recipe.ingredients.iter().enumerate() {
            if idx > 0 {
                summary.push_str(" ");
            }
            summary.push_str(&format!("{}: {}/{}", ing.name.chars().next().unwrap_or('?'), ing.carried_qty, ing.required_qty));
        }
        ui.text(&summary, x + 6.0, ry + 22.0, 1.4, if craftable { ACCENT } else { DIM });

        if resp.clicked {
            out.push(WindowAction::Button(format!("select:{}", recipe.id)));
        }
    }

    // ── Selected Recipe Detail Panel ─────────────────────────────────────
    let dx = x + list_w + 8.0;
    ui.rect(dx, y, detail_w, h, [10, 14, 20, 210]);
    ui.border(dx, y, detail_w, h, 1.0, SLOT_EDGE);

    let selected_recipe = model.selected_recipe_id.as_ref()
        .and_then(|id| model.recipes.iter().find(|r| &r.id == id));

    if let Some(recipe) = selected_recipe {
        // Output icon preview slot
        let slot_size = 36.0;
        let slot_x = dx + 8.0;
        let slot_y = y + 8.0;
        ui.rect(slot_x, slot_y, slot_size, slot_size, SLOT);
        ui.border(slot_x, slot_y, slot_size, slot_size, 1.0, SLOT_EDGE);

        // Choose icon based on category
        let icon_key = match recipe.category.as_str() {
            "WEAPON" => "item-weapon",
            "TOOL" => "item-tool",
            "COMPONENT" => "item-gear",
            _ => "item-item",
        };

        if let Some((col, row)) = icons.cell(icon_key) {
            ui.icon(col, row, slot_x + 4.0, slot_y + 4.0, slot_size - 8.0, slot_size - 8.0, TEXT);
        }

        // Title and Category next to icon
        ui.text(&recipe.name, dx + 52.0, y + 8.0, 2.0, ACCENT);
        ui.text(&format!("CATEGORY: {}", recipe.category), dx + 52.0, y + 26.0, 1.4, DIM);

        // Divider
        ui.rect(dx + 8.0, y + 52.0, detail_w - 16.0, 1.0, SLOT_EDGE);

        // Ingredients section header
        ui.text("REQUIRED INGREDIENTS", dx + 8.0, y + 60.0, 1.6, DIM);

        // Draw ingredient bars
        for (i, ing) in recipe.ingredients.iter().enumerate() {
            let iy = y + 80.0 + i as f32 * 24.0;
            if iy + 18.0 > y + h - 46.0 {
                break; // Clip if it overflows detail panel
            }
            ingredient_bar(ui, dx + 8.0, iy, detail_w - 16.0, ing.carried_qty, ing.required_qty, &ing.name);
        }

        // Craft Button at the bottom
        let craftable = is_craftable(recipe);
        let mut style = ButtonStyle::default();
        if craftable {
            style.fill = [70, 140, 80, 235]; // green
            style.hover = [90, 170, 100, 240];
            style.text = TEXT;
            style.edge = ACCENT;
        } else {
            style.fill = [40, 40, 40, 235]; // dark gray
            style.hover = [40, 40, 40, 235]; // no hover
            style.text = DIM;
            style.edge = SLOT_EDGE;
        }

        if ui.button(dx + 8.0, y + h - 38.0, detail_w - 16.0, 30.0, "CRAFT", style) {
            if craftable {
                out.push(WindowAction::Craft(recipe.id.clone()));
            }
        }
    } else {
        // No recipe selected state
        ui.text("SELECT A RECIPE", dx + 12.0, y + 12.0, 1.8, DIM);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_recipe_emits_select_action() {
        let icons = Icons::load();
        let model = CraftModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Second recipe card center: x=150.0, y=190.0
        ui.set_input(150.0, 190.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);

        ui.set_input(150.0, 190.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::Button("select:field_multitool".to_string())]);
    }

    #[test]
    fn craft_button_emits_craft_action_when_satisfied() {
        let icons = Icons::load();
        let mut model = CraftModel::sample();
        model.selected_recipe_id = Some("field_multitool".to_string());
        let mut ui = UiBuilder::new(icons.meta);

        // CRAFT button center: x=539.0, y=477.0
        ui.set_input(539.0, 477.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);

        ui.set_input(539.0, 477.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::Craft("field_multitool".to_string())]);
    }
}
