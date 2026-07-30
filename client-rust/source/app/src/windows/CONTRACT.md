# Window content contract (Wave 6)

Each game window is a **self-contained content module** at
`client-rust/source/app/src/windows/<name>.rs`. It draws INSIDE a
`WindowManager` content rect using the engine immediate-mode UI. Live authority
binding is Wave 11 — for now each module defines its own typed view struct + a
`sample()` builder used for demo/screenshot verification.

## Module shape (MANDATORY)

```rust
//! <TITLE> — one-line port note.
use super::{WindowAction, TEXT, DIM, ACCENT, SLOT, SLOT_EDGE};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle};

/// View model this window reads (add fields you need; keep it plain data).
#[derive(Clone, Debug, Default)]
pub struct FooModel { /* ... */ }

impl FooModel {
    pub fn sample() -> Self { /* representative demo state */ }
}

/// Draw content into `rect = [x, y, w, h]` (px, top-left origin). Push emitted
/// intents into `out`. MUST NOT panic on empty/default model.
pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &FooModel, icons: &Icons, out: &mut Vec<WindowAction>) { /* ... */ }

#[cfg(test)]
mod tests { /* at least one interaction test using set_input/begin twice */ }
```

## Rules
- DO create only your `windows/<name>.rs` files. DO NOT edit `mod.rs`,
  `model.rs`, `lib.rs`, or `main.rs` — the parent wires dispatch + demo after you
  land (prevents shared-file conflicts).
- Reuse shared color consts from `super::` (`TEXT`, `DIM`, `ACCENT`, `SLOT`,
  `SLOT_EDGE`) — do not invent a second palette.
- Add any new `WindowAction` variants you need by messaging the parent (do NOT
  edit the enum yourself); prefer the existing generic `WindowAction::Button(String)`
  / `Toggle(String)` for one-off intents to avoid enum edits.
- Icons: `icons.cell("<icon-id>")` → `Option<(u32,u32)>`; draw with
  `ui.icon(col, row, x, y, w, h, tint)`. Icon ids are the `client-3d/src/ui/icons.ts`
  keys (e.g. `loot`, `bank`, `trade`, `craft`, `survey`, `converse`, `travel`,
  `datapad`, `clone`, `splice`, `macro`, `actions`, `bug-report`, `item-*`).
- Keep it deterministic + no per-frame heap beyond the UI buffer (fine to
  allocate Strings for labels via `format!`).
- Run ONLY `cargo test -q -p successor-client <yourfilter>` — do NOT run the full
  gate suite, formatters, or bench.

## UiBuilder API you will use
- `ui.rect(x,y,w,h, [u8;4])`, `ui.border(x,y,w,h,thick, rgba)`,
  `ui.panel(x,y,w,h, fill, edge)`
- `ui.text(&str, x, y, px_size, rgba) -> f32` (returns end x); `UiBuilder::text_width(s, px)`
- `ui.icon(col,row, x,y,w,h, rgba)`
- `ui.button(x,y,w,h, label, ButtonStyle) -> bool` (clicked this frame)
- `ui.icon_button(col,row, x,y,size, ButtonStyle) -> bool`
- `ui.interact(x,y,w,h) -> Response { hovered, pressed, released, clicked, held }`
- `ui.mouse() -> (f32,f32)`
- `TextField` (line editor): `ui.text_field(&mut TextField, x,y,w,h, px, show_caret) -> Response`
- `ButtonStyle::default()`; fields `fill/hover/active/edge/text: [u8;4]`.
- Font is UPPERCASE 5×7 (lowercase folds to uppercase); keep labels short.

## Interaction-test pattern (click needs a press frame then a release frame)
```rust
ui.set_input(bx, by, true);  ui.begin(1280, 720);
let mut out = Vec::new(); draw(&mut ui, rect, &model, &icons, &mut out); // press
ui.set_input(bx, by, false); ui.begin(1280, 720);
out.clear(); draw(&mut ui, rect, &model, &icons, &mut out);             // release => clicked
assert!(out.contains(&WindowAction::...));
```
`Icons::load()` works in tests (atlas is embedded).
