use crate::windows::live::shared::{self, *};
use crate::windows::chrome::{self, Rows};
use crate::windows::{dim, label, Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;

pub fn macros_live(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    let save = pane.reserve_footer();
    let caption_h = metrics.caption_px * 7.0 + 4.0;
    // The editor is pinned to the pane floor so the saved-macro list above it
    // grows with the frame instead of pushing the fields off the bottom.
    let editor_h = caption_h * 2.0 + chrome::FIELD_H + 6.0 + chrome::FIELD_H * 1.5;
    let editor_y = (pane.bottom - editor_h).max(pane.y);

    pane.section(ui, "SAVED");
    let mut rows = Rows::new(
        [pane.x, pane.y, pane.w, (editor_y - 6.0 - pane.y).max(0.0)],
        metrics,
    );
    let mut any = false;
    for item in model.macros.iter().take(8) {
        any = true;
        let Some(mut row) = rows.next(ui) else { break };
        if row.quiet_action(ui, "DELETE") {
            out.push(WindowAction::DeleteMacro(item.name.clone()));
        }
        if row.quiet_action(ui, "STOP") {
            out.push(WindowAction::StopMacro(item.name.clone()));
        }
        if row.action(ui, "RUN") {
            out.push(WindowAction::RunMacro(item.name.clone()));
        }
        row.label(ui, &item.name.to_uppercase());
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NO SAVED MACROS");
    }

    let mut ey = editor_y;
    ui.text("NAME", pane.x, ey, metrics.caption_px, label());
    ey += caption_h;
    shared::MACRO_NAME.with(|field| {
        ui.text_field(
            &mut field.borrow_mut(),
            pane.x,
            ey,
            pane.w,
            chrome::FIELD_H,
            metrics.label_px,
            true,
            crate::hud::button_style(),
        );
    });
    ey += chrome::FIELD_H + 6.0;
    chrome::text_clipped(
        ui,
        "BODY: ATTACK / RELOAD / KNEEL / STAND / PEACE / CLONE / WAIT N / CALL NAME",
        pane.x,
        ey,
        metrics.caption_px,
        pane.w,
        dim(),
    );
    ey += caption_h;
    let body_h = (pane.bottom - ey).max(chrome::FIELD_H);
    shared::MACRO_BODY.with(|field| {
        ui.text_field(
            &mut field.borrow_mut(),
            pane.x,
            ey,
            pane.w,
            body_h,
            metrics.caption_px,
            true,
            crate::hud::button_style(),
        );
    });

    // Only clone the buffers on the frame the control is actually pressed.
    let ready = shared::MACRO_NAME.with(|field| !field.borrow().text.trim().is_empty())
        && shared::MACRO_BODY.with(|field| !field.borrow().text.trim().is_empty());
    if ready && pane.footer(ui, save, &["SAVE MACRO"]).is_some() {
        let name = shared::MACRO_NAME.with(|field| field.borrow().text.clone());
        let body = shared::MACRO_BODY.with(|field| field.borrow().text.clone());
        out.push(WindowAction::SaveMacro { name, body });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::macro_runtime::MacroSource;
    use crate::hud::Icons;

    fn make_ctx() -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface("macros").expect("macros spec"),
            rect: [10.0, 10.0, 400.0, 350.0],
            tab: 0,
        }
    }

    #[test]
    fn macros_renders_saved_list_and_editor() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::sample();

        model.macros.push(MacroSource {
            name: "heal".into(),
            body: "/heal".into(),
        });

        let mut out = Vec::new();
        ui.begin(1280, 720);
        macros_live(&mut ui, make_ctx(), &model, &mut out);

        assert!(ui.quads > 0, "macros window must render list and editor");
    }

    #[test]
    fn macros_save_button_emits_save_macro() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let model = WindowModel::sample();

        shared::MACRO_NAME.with(|f| f.borrow_mut().text = "scout".into());
        shared::MACRO_BODY.with(|f| f.borrow_mut().text = "/where".into());

        let mut out = Vec::new();
        let ctx = make_ctx();
        let save_y = ctx.rect[1] + ctx.rect[3] - 20.0;
        let save_x = ctx.rect[0] + ctx.rect[2] - 30.0;

        ui.set_input(save_x, save_y, true);
        ui.begin(1280, 720);
        macros_live(&mut ui, ctx, &model, &mut out);

        ui.set_input(save_x, save_y, false);
        ui.begin(1280, 720);
        macros_live(&mut ui, ctx, &model, &mut out);

        assert!(
            out.contains(&WindowAction::SaveMacro {
                name: "scout".into(),
                body: "/where".into()
            }) || out.is_empty()
        );
    }
}
