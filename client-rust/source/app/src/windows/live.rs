//! Authority-backed connected workflow windows.
//!
//! These views read only `WindowModel` and emit exact `ClientCommand` values;
//! unavailable context is rendered explicitly and never falls back to samples.
//!
//! Presentation is entirely the shared kit's. [`super::content`] resolves the
//! surface, draws the header and tab strip, and hands each function a [`Ctx`]
//! carrying the body rect and the active tab — so nothing here draws a title, a
//! tab, a frame, or a colour of its own. [`super::chrome`] paints every rule,
//! band, control, and meter at the density [`super::spec`] assigns the family.
//!
//! Two consequences worth knowing before editing:
//!   * **Lists are bounded by the rect, not by a magic count.** [`chrome::Rows`]
//!     stops emitting rows at the pane floor, so a frame dragged to its resize
//!     floor drops rows instead of drawing through the border.
//!   * **Only rasterized glyphs are used.** `hud::Icons` bakes ASCII 32..=126,
//!     so the `·`/`×`/`★`/`−` separators this file used to draw rendered as
//!     blank advances. Value columns replace them.

use std::cell::RefCell;

use super::chrome::{self, Rows};
use super::spec::{Density, Metrics};
use super::{Ctx, WindowAction, WindowModel, ACCENT, DIM, LABEL, VALUE};
use successor_engine_render::ui::{TextField, UiBuilder};
use successor_net::{ClientCommand, TradeItemSpec};

thread_local! {
    static GUILD_NAME: RefCell<TextField> = RefCell::new(TextField::new(32));
    static GUILD_TAG: RefCell<TextField> = RefCell::new(TextField::new(5));
    static MACRO_NAME: RefCell<TextField> = RefCell::new(TextField::new(48));
    static MACRO_BODY: RefCell<TextField> = RefCell::new(TextField::new(8 * 1024));
}

/// A surface body: the rect the dispatcher already inset below the header and
/// tab strip, plus a cursor that never runs past its floor.
struct Pane {
    x: f32,
    y: f32,
    w: f32,
    /// Content floor. Shrinks when a commit rail is reserved, so the list above
    /// can never draw under it.
    bottom: f32,
    metrics: Metrics,
}

impl Pane {
    fn open(ctx: Ctx) -> Self {
        let [x, y, w, h] = ctx.rect;
        Self {
            x,
            y,
            w: w.max(0.0),
            bottom: y + h.max(0.0),
            metrics: ctx.metrics(),
        }
    }

    /// Rect still free below the cursor.
    fn body(&self) -> [f32; 4] {
        [self.x, self.y, self.w, (self.bottom - self.y).max(0.0)]
    }

    /// A row list over the free body.
    fn rows(&self) -> Rows {
        Rows::new(self.body(), self.metrics)
    }

    /// Adopt a finished list's cursor so the next section continues below it.
    fn resume(&mut self, rows: &Rows) {
        self.y = rows.cursor().min(self.bottom);
    }

    /// Sparse section rule.
    fn section(&mut self, ui: &mut UiBuilder, label: &str) {
        self.y = chrome::section(ui, self.x, self.y, self.w, label, self.metrics);
    }

    /// One label/value line.
    fn field(&mut self, ui: &mut UiBuilder, label: &str, value: &str) {
        self.y = chrome::field(ui, self.x, self.y, self.w, label, value, self.metrics);
    }

    /// Two label/value pairs on one line — the readout strip a terminal opens
    /// with, at half the vertical cost of stacking them.
    fn field_pair(&mut self, ui: &mut UiBuilder, left: (&str, &str), right: (&str, &str)) {
        let half = ((self.w - 12.0) * 0.5).max(0.0);
        chrome::field(ui, self.x, self.y, half, left.0, left.1, self.metrics);
        self.y = chrome::field(
            ui,
            self.x + half + 12.0,
            self.y,
            half,
            right.0,
            right.1,
            self.metrics,
        );
    }

    /// Explicit empty state at the cursor.
    fn empty(&mut self, ui: &mut UiBuilder, note: &str) {
        chrome::empty(ui, self.x, self.y, note);
        self.y += self.metrics.row_h;
    }

    /// Gate denial at the cursor.
    fn denied(&mut self, ui: &mut UiBuilder, note: &str) {
        chrome::denied(ui, self.x, self.y, note);
        self.y += self.metrics.row_h;
    }

    /// Vertical space one action rail occupies.
    fn rail_h(&self) -> f32 {
        self.metrics.action_h + 3.0
    }

    /// Inline action rail at the cursor. `None` when it was not clicked or the
    /// pane has no room left for it.
    fn rail(&mut self, ui: &mut UiBuilder, labels: &[&str]) -> Option<usize> {
        let height = self.rail_h();
        if labels.is_empty() || self.y + height > self.bottom {
            return None;
        }
        let clicked = chrome::action_rail(ui, self.x, self.y, self.w, labels, self.metrics);
        self.y += height + 5.0;
        clicked
    }

    /// Reserve the commit rail against the pane floor, shrinking the body above
    /// it. `None` when the pane is too short to hold one without eating the
    /// content it commits.
    fn reserve_footer(&mut self) -> Option<f32> {
        let top = self.bottom - self.rail_h();
        if top <= self.y {
            return None;
        }
        self.bottom = top - 5.0;
        Some(top)
    }

    /// Draw a rail into the space [`Pane::reserve_footer`] set aside.
    fn footer(&self, ui: &mut UiBuilder, at: Option<f32>, labels: &[&str]) -> Option<usize> {
        let y = at?;
        if labels.is_empty() {
            return None;
        }
        chrome::action_rail(ui, self.x, y, self.w, labels, self.metrics)
    }
}

/// Stack quantity in the form the dense columns use. The UI font rasterizes
/// ASCII only, so the `×` this file used to draw was an invisible advance.
fn qty(count: impl core::fmt::Display) -> String {
    format!("x{count}")
}

/// Draw `text` as wrapped lines in `w`, stopping at `bottom`. Returns the `y`
/// below the last line. Breaks on spaces and slices the source in place, so a
/// long NPC delivery costs no allocation.
#[allow(clippy::too_many_arguments)]
fn prose(
    ui: &mut UiBuilder,
    text: &str,
    x: f32,
    y: f32,
    w: f32,
    bottom: f32,
    px: f32,
    rgba: [u8; 4],
) -> f32 {
    let line_h = px * 7.0 + 4.0;
    let mut cursor = y;
    let mut rest = text.trim();
    while !rest.is_empty() && cursor + line_h <= bottom {
        let mut end = rest.len();
        let mut wrap = None;
        let mut width = 0.0;
        for (offset, ch) in rest.char_indices() {
            width += ui.measure_text(&rest[offset..offset + ch.len_utf8()], px);
            if width > w {
                // Always take at least one character, or a narrow pane loops.
                end = offset.max(ch.len_utf8());
                break;
            }
            if ch == ' ' {
                wrap = Some(offset);
            }
        }
        // Prefer the last word boundary so words are never split mid-glyph.
        let (draw_end, skip) = match wrap {
            Some(space) if end < rest.len() => (space, space + 1),
            _ => (end, end),
        };
        ui.text(&rest[..draw_end], x, cursor, px, rgba);
        cursor += line_h;
        rest = rest[skip..].trim_start();
    }
    cursor
}

/// A heading-weight line for content that names itself — an examined object, a
/// prop label — on the surfaces whose viewer takes the header's place.
fn heading(pane: &mut Pane, ui: &mut UiBuilder, text: &str) {
    let px = pane.metrics.heading_px;
    chrome::text_clipped(ui, text, pane.x, pane.y, px, pane.w, ACCENT);
    pane.y += px * 7.0 + 5.0;
}

/// Standalone unavailable pane: a section rule over one dim line. Used where a
/// surface has no spec-backed body to draw at all.
pub fn unavailable_window(ui: &mut UiBuilder, rect: [f32; 4], caption: &str, note: &str) {
    let metrics = Density::List.metrics();
    let [x, y, w, _] = rect;
    let body = chrome::section(ui, x, y, w.max(0.0), caption, metrics);
    chrome::empty(ui, x, body, note);
}

pub fn bank(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if !model.bank.gate.available {
        pane.denied(ui, &model.bank.gate.note);
        return;
    }
    let Some(bank) = &model.bank.bank else {
        pane.empty(ui, "BANK STATE UNAVAILABLE");
        return;
    };
    pane.field_pair(
        ui,
        ("WALLET", &model.inventory.credits.to_string()),
        ("VAULT", &bank.credits.to_string()),
    );
    if let Some(index) = pane.rail(ui, &["DEPOSIT 100 CR", "WITHDRAW 100 CR"]) {
        let command = if index == 0 {
            ClientCommand::BankDepositCredits {
                amount: model.inventory.credits.clamp(0, 100) as u64,
            }
        } else {
            ClientCommand::BankWithdrawCredits {
                amount: bank.credits.clamp(0, 100) as u64,
            }
        };
        out.push(WindowAction::Command(command));
    }
    let backup = pane.reserve_footer();
    let mut rows = pane.rows();
    let mut any = false;
    if ctx.tab == 0 {
        for row in model.inventory.held().take(4) {
            any = true;
            let Some(mut list) = rows.next(ui) else { break };
            if row.available > 0 && list.action(ui, "STORE") {
                out.push(WindowAction::Command(ClientCommand::BankStoreItem {
                    source_stack_id: row.stack_id.clone(),
                    quantity: row.available as u32,
                }));
            }
            list.value(ui, &qty(row.available));
            list.label(ui, &row.item);
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NOTHING HELD");
        }
    } else {
        for row in bank.items.iter().take(4) {
            any = true;
            let Some(mut list) = rows.next(ui) else { break };
            if row.quantity > 0 && list.action(ui, "TAKE") {
                out.push(WindowAction::Command(ClientCommand::BankRetrieveItem {
                    bank_stack_id: row.stack_id.clone(),
                    quantity: row.quantity as u32,
                }));
            }
            list.value(ui, &qty(row.quantity));
            list.label(ui, &row.item);
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "VAULT EMPTY");
        }
    }
    if pane
        .footer(ui, backup, &["SAVE CLONE SKILL BACKUP"])
        .is_some()
    {
        out.push(WindowAction::Command(
            ClientCommand::CloneSaveSkillBackup {},
        ));
    }
}

/// District exchange holdings. Drawn as the datapad's DATA pane, so it opens on
/// a section rule and inherits the datapad's metrics rather than resolving a
/// surface of its own.
pub fn exchange(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    metrics: Metrics,
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    let w = w.max(0.0);
    let top = chrome::section(ui, x, y, w, "EXCHANGE", metrics);
    let mut rows = Rows::new([x, top, w, (y + h - top).max(0.0)], metrics);
    let mut any = false;
    for row in model.inventory.exchange().take(10) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.quantity > 0 && list.action(ui, "RETRIEVE") {
            out.push(WindowAction::Command(ClientCommand::RetrieveFromExchange {
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity as u32,
            }));
        }
        list.value(ui, &qty(row.quantity));
        list.label(ui, &row.item);
    }
    if !any {
        chrome::empty(ui, x, rows.cursor(), "EXCHANGE EMPTY");
    }
}

pub fn survey(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    // Camp placement belongs to the whole surface, not to either pane, so it
    // rides the commit rail and stays reachable from both tabs.
    let can_place = !model.survey.own_camp_placed;
    let can_pack = model
        .survey
        .camps
        .iter()
        .any(|camp| camp.vm.is_owner && camp.in_footprint);
    let camp_labels: &[&str] = match (can_place, can_pack) {
        (true, true) => &["PLACE CAMP", "PACK UP CAMP"],
        (true, false) => &["PLACE CAMP"],
        (false, true) => &["PACK UP CAMP"],
        (false, false) => &[],
    };
    let camp_rail = if camp_labels.is_empty() {
        None
    } else {
        pane.reserve_footer()
    };
    let mut rows = pane.rows();
    let mut any = false;
    if ctx.tab == 0 {
        for family in model.survey.families.iter().take(4) {
            any = true;
            let rich = model
                .survey
                .result_for(&family.family)
                .and_then(|result| result.richest());
            let height = pane.metrics.row_h + if rich.is_some() { 11.0 } else { 0.0 };
            let Some(mut row) = rows.next_tall(ui, height) else {
                break;
            };
            if row.action(ui, "PLACE") {
                out.push(WindowAction::Command(ClientCommand::PlaceExtractor {
                    family: family.family.clone(),
                }));
            }
            if row.action(ui, "SURVEY") {
                out.push(WindowAction::Command(ClientCommand::SurveyResource {
                    family: family.family.clone(),
                }));
            }
            if model.survey.sample_cooldown_ticks <= 0 && row.action(ui, "SAMPLE") {
                out.push(WindowAction::Command(ClientCommand::SampleResource {
                    family: family.family.clone(),
                    stop: false,
                }));
            }
            match rich {
                Some((rx, ry, concentration)) => row.label_caption(
                    ui,
                    &family.label,
                    &format!("RICH {rx:.0}, {ry:.0} AT {}%", concentration / 10),
                ),
                None => row.label(ui, &family.label),
            }
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO RESOURCE FAMILIES");
        }
    } else {
        for extractor in model.survey.extractors.iter().take(3) {
            any = true;
            let vm = &extractor.vm;
            let owner_verbs = extractor.in_reach && vm.is_owner;
            let sub_rail = if owner_verbs {
                pane.rail_h() + 4.0
            } else {
                0.0
            };
            if !rows.fits(pane.metrics.row_h + sub_rail) {
                break;
            }
            let Some(mut row) = rows.next(ui) else { break };
            row.value(ui, &format!("OUT {}", vm.collectable_units));
            row.value(ui, &vm.mode.to_ascii_uppercase());
            row.label_tinted(
                ui,
                &vm.family_label,
                if extractor.in_reach { LABEL } else { DIM },
            );
            if owner_verbs {
                let labels: &[&str] = if model.survey.batteries.is_empty() {
                    &["CRANK", "STOP", "COLLECT", "DESTROY"]
                } else {
                    &["CRANK", "STOP", "COLLECT", "DESTROY", "BATTERY"]
                };
                let indent = pane.metrics.gutter;
                let clicked = chrome::action_rail(
                    ui,
                    pane.x + indent,
                    rows.cursor(),
                    (pane.w - indent).max(0.0),
                    labels,
                    pane.metrics,
                );
                if let Some(index) = clicked {
                    let command = match index {
                        0 => Some(ClientCommand::CrankExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        1 => Some(ClientCommand::StopCrank {}),
                        2 => Some(ClientCommand::CollectExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        3 => Some(ClientCommand::DestroyExtractor {
                            extractor_id: vm.extractor_id.clone(),
                        }),
                        _ => model.survey.batteries.first().map(|battery| {
                            ClientCommand::InsertBattery {
                                extractor_id: vm.extractor_id.clone(),
                                container: battery.container.clone(),
                                stack_id: battery.stack_id.clone(),
                                variant_id: battery.variant_id,
                            }
                        }),
                    };
                    if let Some(command) = command {
                        out.push(WindowAction::Command(command));
                    }
                }
                rows.advance(sub_rail);
            }
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO EXTRACTORS PLACED");
        }
    }
    pane.resume(&rows);
    if let Some(index) = pane.footer(ui, camp_rail, camp_labels) {
        let command = if index == 0 && can_place {
            ClientCommand::PlaceCamp {}
        } else {
            ClientCommand::PackUpCamp {}
        };
        out.push(WindowAction::Command(command));
    }
}

pub fn craft(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let cancel = if model.craft.session.is_some() {
        pane.reserve_footer()
    } else {
        None
    };
    if let Some(session) = &model.craft.session {
        pane.field(ui, "PHASE", &session.phase.to_ascii_uppercase());
        if session.phase == "browse" {
            pane.section(ui, "SCHEMATICS");
            let mut rows = pane.rows();
            let mut any = false;
            for recipe in session.recipes.iter().take(7) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if recipe.unlocked && row.action(ui, "BEGIN") {
                    out.push(WindowAction::Command(ClientCommand::CraftBegin {
                        recipe_id: recipe.recipe_id.clone(),
                    }));
                }
                row.label_tinted(ui, &recipe.name, if recipe.unlocked { LABEL } else { DIM });
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO SCHEMATICS KNOWN");
            }
            pane.resume(&rows);
        }
        if let Some(screen) = &session.slot_screen {
            pane.section(ui, "COMPONENTS");
            let mut rows = pane.rows();
            let mut any = false;
            for slot in screen.slots.iter().take(6) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if slot.assigned.is_some() {
                    if row.quiet_action(ui, "CLEAR") {
                        out.push(WindowAction::Command(ClientCommand::CraftClearSlot {
                            slot_index: slot.slot_index,
                        }));
                    }
                } else if let Some(resource) = slot
                    .eligible
                    .iter()
                    .find(|resource| resource.recommended)
                    .or_else(|| slot.eligible.first())
                {
                    if row.action(ui, "ASSIGN") {
                        out.push(WindowAction::Command(ClientCommand::CraftAssignSlot {
                            slot_index: slot.slot_index,
                            container: resource.container.clone(),
                            stack_id: resource.stack_id.clone(),
                            variant_id: resource.variant_id,
                        }));
                    }
                }
                row.value(ui, &slot.resource_kind_label);
                row.label(ui, &slot.symbol);
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO COMPONENT SLOTS");
            }
            pane.resume(&rows);
            if screen.can_assemble && pane.rail(ui, &["ASSEMBLE"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::CraftAssemble {}));
            }
        }
        if let Some(assembled) = &session.assembled {
            pane.section(ui, "EXPERIMENT");
            let mut rows = pane.rows();
            for line in assembled.lines.iter().take(4) {
                let Some(mut row) = rows.next(ui) else { break };
                if line.can_raise
                    && assembled.experimentation_points_remaining > 0
                    && row.action(ui, "+1")
                {
                    out.push(WindowAction::Command(ClientCommand::CraftExperiment {
                        line_id: line.line_id,
                        points: 1,
                    }));
                }
                row.value(ui, &format!("{} / {}", line.value_milli, line.cap_milli));
                row.label(ui, &line.label);
            }
            pane.resume(&rows);
            if let Some(index) = pane.rail(ui, &["PROTOTYPE", "PRACTICE", "DRAFT"]) {
                let command = match index {
                    0 => ClientCommand::CraftFinalizePrototype {
                        custom_name: assembled.recipe_id.clone(),
                    },
                    1 => ClientCommand::CraftFinalizePractice {},
                    _ => ClientCommand::CraftDraftSchematic { max_uses: 100 },
                };
                out.push(WindowAction::Command(command));
            }
        }
    } else if let Some(trainer_actor_id) = &model.craft.trainer_actor_id {
        if pane.rail(ui, &["REQUEST STARTER TOOL"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
                trainer_actor_id: trainer_actor_id.clone(),
            }));
        }
    } else {
        pane.empty(ui, "NO ACTIVE CRAFT SESSION");
    }
    if model.craft.factory.available {
        if let Some(factory_id) = model.craft.factory.prop_id.as_ref() {
            pane.section(ui, "FACTORY");
            let mut rows = pane.rows();
            let mut any = false;
            for draft in model.craft.drafts.iter().take(5) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if draft.remaining_uses > 0 && row.action(ui, "MANUFACTURE") {
                    out.push(WindowAction::Command(ClientCommand::FactoryManufacture {
                        factory_id: factory_id.clone(),
                        schematic_id: draft.id.clone(),
                    }));
                }
                row.value(ui, &format!("{} USES", draft.remaining_uses));
                row.label(ui, &draft.recipe_id);
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO DRAFTED SCHEMATICS");
            }
            pane.resume(&rows);
        }
    } else if !model.craft.factory.note.is_empty() {
        pane.empty(ui, &model.craft.factory.note);
    }
    if pane.footer(ui, cancel, &["CANCEL SESSION"]).is_some() {
        out.push(WindowAction::Command(ClientCommand::CraftCancel {}));
    }
}

pub fn clone_terminal(
    ui: &mut UiBuilder,
    ctx: Ctx,
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let mut pane = Pane::open(ctx);
    let clone = &model.clone;
    if !clone.gate.available {
        pane.denied(ui, &clone.gate.note);
        return;
    }
    let commit = pane.reserve_footer();
    pane.field(
        ui,
        "BACKUP",
        if clone.backup_present {
            "READY"
        } else {
            "NONE"
        },
    );
    pane.field_pair(
        ui,
        ("SKILLS", &clone.backup_skill_count.to_string()),
        ("COST", &clone.backup_cost.to_string()),
    );
    let labels: &[&str] = if clone.dead {
        &["SAVE SKILL BACKUP", "RESPAWN FROM CLONE"]
    } else {
        &["SAVE SKILL BACKUP"]
    };
    if let Some(index) = pane.footer(ui, commit, labels) {
        let command = if index == 0 {
            ClientCommand::CloneSaveSkillBackup {}
        } else {
            ClientCommand::CloneRespawn {
                facility_id: clone.gate.prop_id.clone(),
            }
        };
        out.push(WindowAction::Command(command));
    }
}

/// NPC viewer rect. Anchored at the content origin — the CONVERSE spec declares
/// `header: false` and no tabs, so the body rect and the frame content rect
/// coincide and `connected_scene` places the live viewport from the same call.
pub fn converse_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, _, _] = rect;
    [x, y, 82.0, 136.0]
}

pub fn converse(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let metrics = ctx.metrics();
    let [x, y, w, h] = ctx.rect;
    let Some(npc) = &model.converse.npc else {
        chrome::empty(ui, x, y, "NO DIALOGUE TARGET");
        return;
    };
    let preview = converse_preview_rect(ctx.rect);
    chrome::region(ui, preview);
    let name_w = ui.measure_text(&npc.name, metrics.label_px);
    let caption_y = preview[1] + preview[3] + 6.0;
    chrome::text_clipped(
        ui,
        &npc.name,
        x + ((preview[2] - name_w) * 0.5).max(0.0),
        caption_y,
        metrics.label_px,
        preview[2],
        LABEL,
    );
    let role_w = ui.measure_text("TRAINER", metrics.caption_px);
    ui.text(
        "TRAINER",
        x + ((preview[2] - role_w) * 0.5).max(0.0),
        caption_y + metrics.label_px * 7.0 + 4.0,
        metrics.caption_px,
        DIM,
    );

    // Prose and replies share the column beside the portrait, so the viewer
    // keeps its full height at every frame size.
    let column_x = x + preview[2] + 10.0;
    let column_w = (w - preview[2] - 10.0).max(0.0);
    let prose_h = (h * 0.28).clamp(metrics.row_h * 2.0, 120.0);
    chrome::region(ui, [column_x, y, column_w, prose_h]);
    let (body, tint) = match model.converse.deliveries.last() {
        Some(delivery) => (delivery.body.as_str(), LABEL),
        None => ("State your business.", DIM),
    };
    prose(
        ui,
        body,
        column_x + metrics.gutter,
        y + 6.0,
        (column_w - metrics.gutter * 2.0).max(0.0),
        y + prose_h - 4.0,
        metrics.label_px,
        tint,
    );

    let replies_y = y + prose_h + 8.0;
    let mut rows = Rows::new(
        [column_x, replies_y, column_w, (y + h - replies_y).max(0.0)],
        metrics,
    );
    let mut number = 1usize;
    for (goal_id, label) in model.converse.career_goals.iter().take(3) {
        let active = model.converse.career_goal_id.as_deref() == Some(goal_id.as_str());
        let Some(row) = rows.next_selected(ui, active) else {
            return;
        };
        let text = if active {
            format!("{number}. ACTIVE CAREER GOAL")
        } else {
            format!("{number}. {label}")
        };
        row.label(ui, &text);
        if row.clicked(ui) && !active {
            out.push(WindowAction::Command(ClientCommand::SetCareerGoal {
                goal_id: goal_id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
    }
    for skill in model.converse.teachable.iter().take(3) {
        let Some(row) = rows.next(ui) else { return };
        row.label(ui, &format!("{number}. LEARN {}", skill.label));
        if row.clicked(ui) {
            out.push(WindowAction::Command(ClientCommand::PurchaseSkillBox {
                skill_box_id: skill.id.clone(),
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
        number += 1;
    }
    if let Some(row) = rows.next(ui) {
        row.label(ui, &format!("{number}. REQUEST STARTER TOOL"));
        if row.clicked(ui) {
            out.push(WindowAction::Command(ClientCommand::RequestStarterTool {
                trainer_actor_id: npc.actor_id.clone(),
            }));
        }
    }
}

pub fn travel(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if !model.travel.gate.available {
        pane.denied(ui, &model.travel.gate.note);
        return;
    }
    let terminal_prop_id = model
        .travel
        .gate
        .prop_id
        .as_ref()
        .expect("open travel gate has a prop id");
    let mut rows = pane.rows();
    let mut any = false;
    if ctx.tab == 0 {
        for planet in &model.travel.planets {
            for city in &planet.cities {
                any = true;
                let is_origin = model
                    .travel
                    .origin
                    .as_ref()
                    .is_some_and(|origin| origin.0 == planet.id && origin.1 == city.id);
                let Some(mut row) = rows.next(ui) else { break };
                if !is_origin && row.action(ui, "BUY TICKET") {
                    out.push(WindowAction::Command(ClientCommand::PurchaseTravelTicket {
                        terminal_prop_id: terminal_prop_id.clone(),
                        to_planet_id: planet.id.clone(),
                        to_city_id: city.id.clone(),
                    }));
                }
                if is_origin {
                    row.value(ui, "HERE");
                } else {
                    row.value(ui, &format!("{} CR", city.price));
                }
                row.value(ui, &planet.label);
                row.label_tinted(ui, &city.label, if is_origin { DIM } else { LABEL });
            }
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO DESTINATIONS");
        }
    } else {
        for ticket in &model.travel.tickets {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            let travel = ticket
                .metadata
                .as_ref()
                .and_then(|meta| meta.get("travelTicket"));
            let ticket_id = travel
                .and_then(|value| value.get("ticketId"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            if row.action(ui, "USE") {
                out.push(WindowAction::Command(ClientCommand::UseTravelTicket {
                    container: Some(ticket.container.clone()),
                    stack_id: Some(ticket.stack_id.clone()),
                    ticket_id,
                    item_id: ticket.item_key.clone(),
                    item_numeric_id: Some(ticket.item_id),
                    variant_id: Some(ticket.variant_id),
                }));
            }
            row.label(
                ui,
                &ticket
                    .ticket_destination()
                    .unwrap_or_else(|| ticket.item.to_ascii_uppercase()),
            );
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO TICKETS HELD");
        }
    }
    pane.resume(&rows);
}

/// Actor viewer rect. The EXAMINE spec declares `header: false` and no tabs, so
/// this is anchored at the content origin and the attributes reflow beneath it.
pub fn examine_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    let preview_h = (h * 0.54).max(170.0);
    let preview_w = (preview_h * 0.60).min(w);
    [x + (w - preview_w) * 0.5, y, preview_w, preview_h]
}

/// Item viewer rect, same contract as [`examine_preview_rect`].
pub fn examine_item_preview_rect(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = rect;
    [x, y, w, w.min((h * 0.62).max(190.0))]
}

pub fn examine(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    if let Some(actor) = &model.examine.actor {
        let preview = examine_preview_rect(ctx.rect);
        chrome::region(ui, preview);
        pane.y = preview[1] + preview[3] + 8.0;
        let revive = if actor.life_state == "alive" {
            None
        } else {
            pane.reserve_footer()
        };
        heading(&mut pane, ui, &actor.name);
        pane.field(ui, "TYPE", &actor.descriptor.to_ascii_uppercase());
        pane.field(ui, "STATE", &actor.life_state.to_ascii_uppercase());

        let ratio = if actor.health_max > 0.0 {
            (actor.health / actor.health_max).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let reading = format!("{:.0}/{:.0}", actor.health, actor.health_max);
        let label_w = ui.measure_text("HEALTH", metrics.caption_px) + 10.0;
        let reading_w = ui.measure_text(&reading, metrics.caption_px);
        ui.text("HEALTH", pane.x, pane.y + 1.0, metrics.caption_px, LABEL);
        let track_w = (pane.w - label_w - reading_w - 8.0).max(0.0);
        if track_w > 0.0 {
            chrome::meter(
                ui,
                pane.x + label_w,
                pane.y + 2.0,
                track_w,
                6.0,
                ratio,
                ACCENT,
            );
        }
        ui.text(
            &reading,
            pane.x + pane.w - reading_w,
            pane.y,
            metrics.caption_px,
            VALUE,
        );
        pane.y += metrics.row_h - 4.0;

        pane.field(
            ui,
            "FACTION",
            &actor
                .faction_id
                .as_deref()
                .unwrap_or("UNKNOWN")
                .to_ascii_uppercase(),
        );
        if pane.footer(ui, revive, &["REVIVE / STABILIZE"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::ReviveActor {
                target_actor_id: actor.actor_id.clone(),
            }));
        }
        return;
    }
    if let Some(item) = &model.examine.item {
        let preview = examine_item_preview_rect(ctx.rect);
        chrome::region(ui, preview);
        pane.y = preview[1] + preview[3] + 8.0;
        heading(&mut pane, ui, &item.item);
        pane.field(ui, "CLASS", item.kind().label());
        pane.field_pair(
            ui,
            ("QTY", &item.quantity.to_string()),
            ("VARIANT", &item.variant_id.to_string()),
        );
        match (item.potency, item.purity) {
            (Some(potency), Some(purity)) => pane.field_pair(
                ui,
                ("POTENCY", &potency.to_string()),
                ("PURITY", &purity.to_string()),
            ),
            (Some(potency), None) => pane.field(ui, "POTENCY", &potency.to_string()),
            (None, Some(purity)) => pane.field(ui, "PURITY", &purity.to_string()),
            (None, None) => {}
        }
        return;
    }
    if let Some((_, label)) = &model.examine.prop {
        heading(&mut pane, ui, label);
    } else {
        pane.empty(ui, "NOTHING SELECTED");
    }
}

pub fn loot(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let Some(loot) = &model.loot else {
        pane.empty(ui, "NO LOOT TARGET");
        return;
    };
    pane.section(ui, &loot.label);
    if !loot.in_reach {
        pane.denied(ui, "OUT OF RANGE");
        return;
    }
    if !loot.rights_mine {
        pane.denied(ui, "NO LOOT RIGHTS");
        return;
    }
    // The commit rail carries whichever bulk verbs this container offers; each
    // is optional, so labels and commands are paired by index.
    const TAKE_ALL: u8 = 0;
    const TAKE_CREDITS: u8 = 1;
    const HARVEST: u8 = 2;
    let mut labels: [&str; 3] = [""; 3];
    let mut kinds: [u8; 3] = [0; 3];
    let mut count = 0usize;
    if !loot.rows.is_empty() {
        labels[count] = "LOOT ALL";
        kinds[count] = TAKE_ALL;
        count += 1;
    }
    if loot.credits_present {
        labels[count] = "TAKE CREDITS";
        kinds[count] = TAKE_CREDITS;
        count += 1;
    }
    if loot.harvest_actor_id.is_some() {
        labels[count] = "HARVEST CORPSE";
        kinds[count] = HARVEST;
        count += 1;
    }
    let commit = if count == 0 {
        None
    } else {
        pane.reserve_footer()
    };
    let mut rows = pane.rows();
    let mut any = false;
    for row in loot.rows.iter().take(7) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.quantity > 0 && list.action(ui, "TAKE") {
            out.push(WindowAction::Command(ClientCommand::TakeLootItem {
                container: loot.container.clone(),
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity.min(i32::MAX as i64) as i32,
            }));
        }
        list.value(ui, &qty(row.quantity));
        list.label(ui, &row.item);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "CONTAINER EMPTY");
    }
    if let Some(index) = pane.footer(ui, commit, &labels[..count]) {
        match kinds[index] {
            TAKE_ALL => {
                for row in &loot.rows {
                    if row.quantity > 0 {
                        out.push(WindowAction::Command(ClientCommand::TakeLootItem {
                            container: loot.container.clone(),
                            item_id: row.item_id,
                            variant_id: row.variant_id,
                            quantity: row.quantity.min(i32::MAX as i64) as i32,
                        }));
                    }
                }
                if loot.credits_present {
                    out.push(WindowAction::Command(ClientCommand::CorpseTakeCredits {
                        corpse_id: loot.target_id.clone(),
                    }));
                }
            }
            TAKE_CREDITS => out.push(WindowAction::Command(ClientCommand::CorpseTakeCredits {
                corpse_id: loot.target_id.clone(),
            })),
            _ => {
                if let Some(target_actor_id) = &loot.harvest_actor_id {
                    out.push(WindowAction::Command(ClientCommand::HarvestCorpse {
                        target_actor_id: target_actor_id.clone(),
                    }));
                }
            }
        }
    }
}

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
        if row.action(ui, "RUN") {
            out.push(WindowAction::RunMacro(item.name.clone()));
        }
        row.label(ui, &item.name.to_uppercase());
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NO SAVED MACROS");
    }

    let mut ey = editor_y;
    ui.text("NAME", pane.x, ey, metrics.caption_px, LABEL);
    ey += caption_h;
    MACRO_NAME.with(|field| {
        ui.text_field(
            &mut field.borrow_mut(),
            pane.x,
            ey,
            pane.w,
            chrome::FIELD_H,
            metrics.label_px,
            true,
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
        DIM,
    );
    ey += caption_h;
    let body_h = (pane.bottom - ey).max(chrome::FIELD_H);
    MACRO_BODY.with(|field| {
        ui.text_field(
            &mut field.borrow_mut(),
            pane.x,
            ey,
            pane.w,
            body_h,
            metrics.caption_px,
            true,
        );
    });

    // Only clone the buffers on the frame the control is actually pressed.
    let ready = MACRO_NAME.with(|field| !field.borrow().text.trim().is_empty())
        && MACRO_BODY.with(|field| !field.borrow().text.trim().is_empty());
    if ready && pane.footer(ui, save, &["SAVE MACRO"]).is_some() {
        let name = MACRO_NAME.with(|field| field.borrow().text.clone());
        let body = MACRO_BODY.with(|field| field.borrow().text.clone());
        out.push(WindowAction::SaveMacro { name, body });
    }
}

pub fn datapad(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    match ctx.tab {
        0 => {
            let mark = pane.reserve_footer();
            pane.field(
                ui,
                "POSITION",
                &format!(
                    "{} {}, {}",
                    model.character.area_id.to_ascii_uppercase(),
                    model.farm.player_cell.0,
                    model.farm.player_cell.1
                ),
            );
            pane.section(ui, "WAYPOINTS");
            let mut rows = pane.rows();
            let mut any = false;
            for waypoint in model
                .waypoints
                .iter()
                .filter(|waypoint| waypoint.area_id == model.character.area_id)
                .take(8)
            {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                if row.quiet_action(ui, "DELETE") {
                    out.push(WindowAction::DeleteWaypoint(waypoint.id));
                }
                if row.action(ui, if waypoint.active { "HIDE" } else { "SHOW" }) {
                    out.push(WindowAction::SetWaypointActive {
                        id: waypoint.id,
                        active: !waypoint.active,
                    });
                }
                row.value(ui, &format!("{:.1}, {:.1}", waypoint.x, waypoint.y));
                row.label_tinted(
                    ui,
                    &waypoint.name,
                    if waypoint.active { LABEL } else { DIM },
                );
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO WAYPOINTS IN THIS AREA");
            }
            if pane.footer(ui, mark, &["MARK HERE"]).is_some() {
                out.push(WindowAction::CreateWaypoint {
                    x: model.farm.player_cell.0 as f32,
                    y: model.farm.player_cell.1 as f32,
                    name: None,
                });
            }
        }
        1 => {
            let mut rows = pane.rows();
            let mut any = false;
            for draft in model.craft.drafts.iter().take(10) {
                any = true;
                let Some(mut row) = rows.next(ui) else { break };
                row.value(ui, &format!("OUT {}", draft.output_item_id));
                row.value(ui, &draft.recipe_id);
                row.label(ui, &draft.id);
            }
            if !any {
                chrome::empty(ui, pane.x, rows.cursor(), "NO DRAFTED SCHEMATICS");
            }
            pane.resume(&rows);
        }
        _ => exchange(ui, pane.body(), pane.metrics, model, out),
    }
}

pub fn guild(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    let leave = if model.pa.view.guild.is_some() {
        pane.reserve_footer()
    } else {
        None
    };
    if !model.pa.view.pending_invites.is_empty() {
        pane.section(ui, "INVITATIONS");
        let mut rows = pane.rows();
        for invite in &model.pa.view.pending_invites {
            let Some(mut row) = rows.next(ui) else { break };
            if row.quiet_action(ui, "DECLINE") {
                out.push(WindowAction::Command(ClientCommand::GuildDeclineInvite {
                    invite_id: invite.invite_id.clone(),
                }));
            }
            if row.action(ui, "ACCEPT") {
                out.push(WindowAction::Command(ClientCommand::GuildAcceptInvite {
                    invite_id: invite.invite_id.clone(),
                }));
            }
            row.value(ui, &invite.guild_tag);
            row.label(ui, &invite.guild_name);
        }
        pane.resume(&rows);
    }

    let Some(guild) = &model.pa.view.guild else {
        if !model.pa.gate.available {
            pane.denied(ui, &model.pa.gate.note);
            return;
        }
        let fee = crate::windows::model::GUILD_CHARTER_FEE_CREDITS;
        let affordable = model.pa.wallet_credits >= fee;
        pane.section(ui, "FOUND AN ASSOCIATION");
        pane.field(ui, "CHARTER FEE", &format!("{fee} CR"));
        if !affordable {
            pane.denied(ui, "INSUFFICIENT CREDITS");
        }
        let tag_w = 68.0f32.min(pane.w * 0.3);
        let name_w = (pane.w - tag_w - 8.0).max(0.0);
        GUILD_NAME.with(|field| {
            ui.text_field(
                &mut field.borrow_mut(),
                pane.x,
                pane.y,
                name_w,
                chrome::FIELD_H,
                metrics.label_px,
                true,
            );
        });
        GUILD_TAG.with(|field| {
            ui.text_field(
                &mut field.borrow_mut(),
                pane.x + name_w + 8.0,
                pane.y,
                tag_w,
                chrome::FIELD_H,
                metrics.label_px,
                true,
            );
        });
        let caption_y = pane.y + chrome::FIELD_H + 3.0;
        ui.text("NAME", pane.x, caption_y, metrics.caption_px, DIM);
        ui.text(
            "TAG",
            pane.x + name_w + 8.0,
            caption_y,
            metrics.caption_px,
            DIM,
        );
        pane.y = caption_y + metrics.caption_px * 7.0 + 6.0;

        let named = GUILD_NAME.with(|field| !field.borrow().text.trim().is_empty())
            && GUILD_TAG.with(|field| !field.borrow().text.trim().is_empty());
        if named && affordable && pane.rail(ui, &["CREATE ASSOCIATION"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::GuildCreate {
                name: GUILD_NAME.with(|field| field.borrow().text.trim().to_string()),
                tag: GUILD_TAG.with(|field| field.borrow().text.trim().to_string()),
                terminal_prop_id: model.pa.gate.prop_id.clone().unwrap_or_default(),
            }));
        }
        return;
    };

    pane.field_pair(
        ui,
        ("CHARTER", &guild.name),
        ("MEMBERS", &guild.member_count.to_string()),
    );
    pane.field(ui, "TAG", &guild.tag);
    if model.pa.has_permission("invite") {
        if let Some((actor_id, label)) = &model.pa.target {
            chrome::text_clipped(ui, label, pane.x, pane.y, metrics.caption_px, pane.w, DIM);
            pane.y += metrics.caption_px * 7.0 + 3.0;
            if pane.rail(ui, &["INVITE SELECTED"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::GuildInvite {
                    target_actor_id: actor_id.clone(),
                }));
            }
        }
    }

    pane.section(ui, "ROSTER");
    let mut rows = pane.rows();
    let mut any = false;
    for member in model.pa.view.roster.iter().take(6) {
        any = true;
        let Some(mut row) = rows.next(ui) else { break };
        if member.actor_id != model.pa.my_actor_id {
            if model.pa.has_permission("kick") && row.quiet_action(ui, "KICK") {
                out.push(WindowAction::Command(ClientCommand::GuildKick {
                    target_actor_id: member.actor_id.clone(),
                }));
            }
            if model.pa.is_leader() && row.action(ui, "LEAD") {
                out.push(WindowAction::Command(
                    ClientCommand::GuildTransferLeadership {
                        target_actor_id: member.actor_id.clone(),
                    },
                ));
            }
            if model.pa.has_permission("roles") {
                if row.action(ui, "PERMS") {
                    out.push(WindowAction::Command(ClientCommand::GuildSetPermissions {
                        target_actor_id: member.actor_id.clone(),
                        permissions: u8::MAX,
                    }));
                }
                // The control reads as a destination; the payload stays the
                // exact lowercase role string the authority expects.
                let (label, role) = if member.role == "officer" {
                    ("MEMBER", "member")
                } else {
                    ("OFFICER", "officer")
                };
                if row.action(ui, label) {
                    out.push(WindowAction::Command(ClientCommand::GuildSetRole {
                        target_actor_id: member.actor_id.clone(),
                        role: role.into(),
                    }));
                }
            }
        }
        row.value(ui, &member.role.to_ascii_uppercase());
        if !member.online {
            row.value(ui, "OFFLINE");
        }
        row.label_tinted(ui, &member.name, if member.online { LABEL } else { DIM });
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "ROSTER EMPTY");
    }
    pane.resume(&rows);

    if model.pa.has_permission("war") {
        pane.section(ui, "WARS");
        let mut rows = pane.rows();
        let mut any = false;
        for war in &guild.wars {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            let incoming = war.state == "incoming";
            if row.action(ui, if incoming { "ACCEPT" } else { "RESCIND" }) {
                let command = if incoming {
                    ClientCommand::GuildAcceptWar {
                        opposing_guild_id: war.opposing_guild_id.clone(),
                    }
                } else {
                    ClientCommand::GuildRescindWar {
                        opposing_guild_id: war.opposing_guild_id.clone(),
                    }
                };
                out.push(WindowAction::Command(command));
            }
            row.value(ui, &war.opposing_tag);
            row.label(ui, &war.opposing_name);
        }
        for candidate in model
            .pa
            .view
            .directory
            .iter()
            .filter(|entry| entry.id != guild.id)
            .take(2)
        {
            any = true;
            let Some(mut row) = rows.next(ui) else { break };
            if row.quiet_action(ui, "DECLARE") {
                out.push(WindowAction::Command(ClientCommand::GuildDeclareWar {
                    opposing_guild_id: candidate.id.clone(),
                }));
            }
            row.value(ui, &candidate.tag);
            row.label_tinted(ui, &candidate.name, DIM);
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NO WARS DECLARED");
        }
        pane.resume(&rows);
    }

    let leader = model.pa.is_leader();
    let labels: &[&str] = if leader {
        &["DISBAND ASSOCIATION"]
    } else {
        &["LEAVE ASSOCIATION"]
    };
    if pane.footer(ui, leave, labels).is_some() {
        let command = if leader {
            ClientCommand::GuildDisband {}
        } else {
            ClientCommand::GuildLeave {}
        };
        out.push(WindowAction::Command(command));
    }
}

pub fn agriculture(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let metrics = pane.metrics;
    if model.farm.parcels.is_empty() {
        pane.field(
            ui,
            "UNCLAIMED",
            &format!("{}, {}", model.farm.player_cell.0, model.farm.player_cell.1),
        );
        if pane.rail(ui, &["CLAIM PARCEL"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::ClaimParcel {
                planet_id: model.farm.planet_id.clone(),
                area_id: model.farm.area_id.clone(),
                x: model.farm.player_cell.0 as i32,
                y: model.farm.player_cell.1 as i32,
                tier: "homestead".into(),
            }));
        }
        return;
    }
    if ctx.tab == 0 {
        for parcel in model
            .farm
            .parcels
            .iter()
            .filter(|parcel| parcel.is_owner)
            .take(2)
        {
            pane.section(ui, &parcel.name);
            pane.field(ui, "TIER", &parcel.tier.to_ascii_uppercase());
            if let Some(index) = pane.rail(ui, &["UPKEEP", "RENAME", "ABANDON"]) {
                let command = match index {
                    0 => ClientCommand::PayUpkeep {
                        parcel_id: parcel.parcel_id.clone(),
                    },
                    1 => ClientCommand::RenameParcel {
                        parcel_id: parcel.parcel_id.clone(),
                        name: format!("{} Homestead", parcel.name),
                    },
                    _ => ClientCommand::AbandonParcel {
                        parcel_id: parcel.parcel_id.clone(),
                    },
                };
                out.push(WindowAction::Command(command));
            }
            if let Some(plot) = model.farm.plot_for(&parcel.parcel_id) {
                let mut rows = pane.rows();
                for tile in plot.tiles.iter().take(5) {
                    let legal = |verb: &str| {
                        tile.legal_verbs
                            .iter()
                            .any(|candidate| candidate.eq_ignore_ascii_case(verb))
                    };
                    let seed = legal("PlantSeed")
                        .then(|| model.farm.seeds.first())
                        .flatten();
                    let fertilizer = legal("Fertilize")
                        .then(|| model.farm.fertilizers.first())
                        .flatten();
                    let sow_labels: &[&str] = match (seed.is_some(), fertilizer.is_some()) {
                        (true, true) => &["PLANT", "FERTILIZE"],
                        (true, false) => &["PLANT"],
                        (false, true) => &["FERTILIZE"],
                        (false, false) => &[],
                    };
                    let sow_h = if sow_labels.is_empty() {
                        0.0
                    } else {
                        pane.rail_h() + 4.0
                    };
                    if !rows.fits(metrics.row_h + sow_h) {
                        break;
                    }
                    let Some(mut row) = rows.next(ui) else { break };
                    if legal("HarvestCrop") && row.action(ui, "HARVEST") {
                        out.push(WindowAction::Command(ClientCommand::HarvestCrop {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("ClearTile") && row.quiet_action(ui, "CLEAR") {
                        out.push(WindowAction::Command(ClientCommand::ClearTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("WaterTile") && row.action(ui, "WATER") {
                        out.push(WindowAction::Command(ClientCommand::WaterTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    if legal("TillTile") && row.action(ui, "TILL") {
                        out.push(WindowAction::Command(ClientCommand::TillTile {
                            parcel_id: parcel.parcel_id.clone(),
                            cell_x: tile.cell_x as i32,
                            cell_y: tile.cell_y as i32,
                        }));
                    }
                    row.value(ui, &format!("{:.0}% WET", tile.moisture_pct));
                    row.value(
                        ui,
                        tile.crop
                            .as_ref()
                            .map(|crop| crop.species.as_str())
                            .unwrap_or(if tile.tilled { "TILLED" } else { "UNTILLED" }),
                    );
                    row.label(ui, &format!("{}, {}", tile.cell_x, tile.cell_y));
                    if sow_labels.is_empty() {
                        continue;
                    }
                    let indent = metrics.gutter;
                    let clicked = chrome::action_rail(
                        ui,
                        pane.x + indent,
                        rows.cursor(),
                        (pane.w - indent).max(0.0),
                        sow_labels,
                        metrics,
                    );
                    if let Some(index) = clicked {
                        let command = if index == 0 && seed.is_some() {
                            seed.map(|seed| ClientCommand::PlantSeed {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: seed.container.clone(),
                                stack_id: seed.stack_id.clone(),
                                variant_id: seed.variant_id,
                            })
                        } else {
                            fertilizer.map(|fertilizer| ClientCommand::Fertilize {
                                parcel_id: parcel.parcel_id.clone(),
                                cell_x: tile.cell_x as i32,
                                cell_y: tile.cell_y as i32,
                                container: fertilizer.container.clone(),
                                stack_id: fertilizer.stack_id.clone(),
                                variant_id: fertilizer.variant_id,
                            })
                        };
                        if let Some(command) = command {
                            out.push(WindowAction::Command(command));
                        }
                    }
                    rows.advance(sow_h);
                }
                pane.resume(&rows);
            }
            let structure = model.farm.structures.first();
            let labels: &[&str] = if structure.is_some() {
                &["TEND PLOT", "PLACE STRUCTURE"]
            } else {
                &["TEND PLOT"]
            };
            if let Some(index) = pane.rail(ui, labels) {
                let command = if index == 0 {
                    Some(ClientCommand::TendPlot {
                        parcel_id: parcel.parcel_id.clone(),
                        stop: false,
                    })
                } else {
                    structure.map(|structure| ClientCommand::PlaceFarmStructure {
                        parcel_id: parcel.parcel_id.clone(),
                        structure_item_id: structure.item_id,
                        cell_x: model.farm.player_cell.0 as i32,
                        cell_y: model.farm.player_cell.1 as i32,
                    })
                };
                if let Some(command) = command {
                    out.push(WindowAction::Command(command));
                }
            }
        }
        return;
    }

    let mut targeted = false;
    if let (Some(parcel), Some(ghost)) = (&model.build.parcel, &model.build.ghost) {
        targeted = true;
        pane.section(ui, "CATALOG");
        let mut rows = pane.rows();
        for item in model.build.catalog.iter().take(4) {
            let Some(mut row) = rows.next(ui) else { break };
            let enabled = ghost.valid && model.build.affordable(item);
            if enabled && row.action(ui, "PLACE") {
                out.push(WindowAction::Command(ClientCommand::BuildPlace {
                    catalog_id: item.catalog_id.clone(),
                    parcel_id: parcel.parcel_id.clone(),
                    cell_x: ghost.cell_x as i32,
                    cell_y: ghost.cell_y as i32,
                    rotation_quarters: ghost.rotation_quarters,
                    palette: None,
                }));
            }
            let mut costs = String::new();
            for (material, units) in &item.costs {
                if !costs.is_empty() {
                    costs.push_str(", ");
                }
                costs.push_str(&units.to_string());
                costs.push(' ');
                costs.push_str(&material.to_ascii_uppercase());
            }
            row.value(ui, &costs);
            row.label_tinted(ui, &item.label, if enabled { LABEL } else { DIM });
        }
        pane.resume(&rows);
    }
    pane.section(ui, "PLACED");
    let mut rows = pane.rows();
    let mut placed = false;
    for component in model.build.components.iter().take(3) {
        placed = true;
        let Some(mut row) = rows.next(ui) else { break };
        if row.quiet_action(ui, "REMOVE") {
            out.push(WindowAction::Command(ClientCommand::BuildRemove {
                component_id: component.component_id.clone(),
            }));
        }
        if component.kind.contains("door") && row.action(ui, "TOGGLE") {
            out.push(WindowAction::Command(ClientCommand::BuildToggleDoor {
                component_id: component.component_id.clone(),
            }));
        }
        row.label(ui, &component.catalog_id);
    }
    if !placed {
        chrome::empty(
            ui,
            pane.x,
            rows.cursor(),
            if targeted {
                "NOTHING PLACED YET"
            } else {
                "NO PLACEMENT TARGET"
            },
        );
    }
    pane.resume(&rows);
}

pub fn splice(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let cancel = if model.splice.session.is_some() {
        pane.reserve_footer()
    } else {
        None
    };
    if let Some((species, label, in_range)) = &model.splice.sample_target {
        pane.field(ui, "SPECIMEN", label);
        if *in_range {
            if pane.rail(ui, &["GENE SAMPLE"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::GeneSample {
                    species: species.clone(),
                }));
            }
        } else {
            pane.denied(ui, "OUT OF RANGE");
        }
    }
    if !model.splice.samples.is_empty() {
        pane.section(ui, "SAMPLES");
        let mut rows = pane.rows();
        for sample in model.splice.samples.iter().take(4) {
            let Some(mut row) = rows.next(ui) else { break };
            if row.action(ui, "SCAN") {
                out.push(WindowAction::Command(ClientCommand::ScanGenome {
                    container: sample.container.clone(),
                    stack_id: sample.stack_id.clone(),
                    variant_id: sample.variant_id,
                }));
            }
            row.value(ui, &qty(sample.available));
            row.label(ui, &sample.item);
        }
        pane.resume(&rows);
    }
    let Some(session) = &model.splice.session else {
        if let Some((species, _, _)) = &model.splice.sample_target {
            if pane.rail(ui, &["BEGIN SPLICE"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::SpliceBegin {
                    species: species.clone(),
                }));
            }
        } else {
            pane.empty(ui, "SELECT A CREATURE OR ACQUIRE A SAMPLE");
        }
        return;
    };
    pane.field_pair(
        ui,
        ("SPECIES", &session.species_name),
        ("PHASE", &session.phase.to_ascii_uppercase()),
    );
    if !session.slots.is_empty() {
        pane.section(ui, "SEQUENCE SLOTS");
        let mut rows = pane.rows();
        for slot in &session.slots {
            let Some(mut row) = rows.next(ui) else { break };
            if slot.filled {
                if row.quiet_action(ui, "CLEAR") {
                    out.push(WindowAction::Command(ClientCommand::SpliceClearSlot {
                        slot_index: slot.slot_index,
                    }));
                }
            } else if let Some(sample) = model.splice.samples.first() {
                if row.action(ui, "ASSIGN") {
                    out.push(WindowAction::Command(ClientCommand::SpliceAssignSlot {
                        slot_index: slot.slot_index,
                        container: sample.container.clone(),
                        stack_id: sample.stack_id.clone(),
                        variant_id: sample.variant_id,
                    }));
                }
            }
            row.value(
                ui,
                &format!("{} {}", slot.kind.to_ascii_uppercase(), slot.slot_index + 1),
            );
            row.label_tinted(ui, &slot.label, if slot.filled { LABEL } else { DIM });
        }
        pane.resume(&rows);
    }
    if !session.lines.is_empty() {
        pane.section(ui, "LOCI");
        let choosing = session.phase == "slots";
        let mut rows = pane.rows();
        for line in session.lines.iter().take(5) {
            let Some(mut row) = rows.next(ui) else { break };
            if choosing {
                // Right-to-left placement puts the pairs back in 1A 1B 2A 2B
                // reading order.
                for (parent, allele, label) in
                    [(1, 1, "2B"), (1, 0, "2A"), (0, 1, "1B"), (0, 0, "1A")]
                {
                    if row.action(ui, label) {
                        out.push(WindowAction::Command(ClientCommand::SpliceChooseAllele {
                            locus: line.locus,
                            from_parent: parent,
                            allele,
                        }));
                    }
                }
            } else if line.can_raise && session.points_remaining > 0 && row.action(ui, "+1") {
                out.push(WindowAction::Command(
                    ClientCommand::SpliceExperimentLocus {
                        locus: line.locus,
                        points: 1,
                    },
                ));
            }
            row.value(ui, &format!("{} / {}", line.value_milli, line.cap_milli));
            row.label(ui, &line.label);
        }
        pane.resume(&rows);
        pane.field(ui, "POINTS LEFT", &session.points_remaining.to_string());
    }
    let commit: Option<&str> = if session.phase == "slots" && session.can_assemble {
        Some("ASSEMBLE")
    } else if session.phase == "assembled" {
        Some("MINT CULTIVAR")
    } else {
        None
    };
    if let Some(label) = commit {
        if pane.rail(ui, &[label]).is_some() {
            let command = if label == "ASSEMBLE" {
                ClientCommand::SpliceAssemble {}
            } else {
                ClientCommand::SpliceMint {
                    cultivar_name: None,
                }
            };
            out.push(WindowAction::Command(command));
        }
    }
    if pane.footer(ui, cancel, &["CANCEL"]).is_some() {
        out.push(WindowAction::Command(ClientCommand::SpliceCancel {}));
    }
}

pub fn group(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if model.group.group.pending_invite.is_none()
        && model.group.group.members.is_empty()
        && model.group.group.group.is_none()
        && model.group.target.is_none()
        && model.group.duel.incoming_challenge.is_none()
        && model.group.duel.active_duel.is_none()
        && model.group.deathblow_target.is_none()
    {
        pane.empty(ui, "NO GROUP / SELECT A PLAYER");
        return;
    }
    if let Some(invite) = &model.group.group.pending_invite {
        pane.section(ui, "GROUP INVITE");
        pane.field(ui, "FROM", &invite.inviter_name);
        if let Some(index) = pane.rail(ui, &["ACCEPT", "DECLINE"]) {
            let command = if index == 0 {
                ClientCommand::GroupAccept {}
            } else {
                ClientCommand::GroupDecline {}
            };
            out.push(WindowAction::Command(command));
        }
    }
    if !model.group.group.members.is_empty() {
        pane.section(ui, "ROSTER");
        let mut rows = pane.rows();
        for member in &model.group.group.members {
            let Some(mut row) = rows.next(ui) else { break };
            if model.group.is_leader()
                && member.actor_id != model.group.my_actor_id
                && row.quiet_action(ui, "KICK")
            {
                out.push(WindowAction::Command(ClientCommand::GroupKick {
                    target_actor_id: member.actor_id.clone(),
                }));
            }
            row.value(
                ui,
                &format!(
                    "HP {:.0}/{:.0}",
                    member.vitals.health, member.max_vitals.health
                ),
            );
            if member.link_dead {
                row.value(ui, "LINK DEAD");
            }
            if member.is_leader {
                row.value(ui, "LEADER");
            }
            row.label_tinted(
                ui,
                &member.name,
                if member.life_state == "alive" {
                    LABEL
                } else {
                    DIM
                },
            );
        }
        pane.resume(&rows);
    }
    if model.group.group.group.is_some() {
        let leader = model.group.is_leader();
        let labels: &[&str] = if leader {
            &["DISBAND GROUP"]
        } else {
            &["LEAVE GROUP"]
        };
        if pane.rail(ui, labels).is_some() {
            let command = if leader {
                ClientCommand::GroupDisband {}
            } else {
                ClientCommand::GroupLeave {}
            };
            out.push(WindowAction::Command(command));
        }
    } else if let Some((actor_id, label, true)) = &model.group.target {
        pane.section(ui, "SELECTED PLAYER");
        pane.field(ui, "TARGET", label);
        let labels: &[&str] = if model.group.duel.active_duel.is_none() {
            &["GROUP INVITE", "DUEL"]
        } else {
            &["GROUP INVITE"]
        };
        if let Some(index) = pane.rail(ui, labels) {
            let command = if index == 0 {
                ClientCommand::GroupInvite {
                    target_actor_id: actor_id.clone(),
                }
            } else {
                ClientCommand::DuelChallenge {
                    target_actor_id: actor_id.clone(),
                }
            };
            out.push(WindowAction::Command(command));
        }
    } else if let Some((_, label, false)) = &model.group.target {
        pane.section(ui, "SELECTED PLAYER");
        pane.field(ui, "TARGET", label);
        pane.denied(ui, super::DENY_RANGE);
    }
    if let Some(challenge) = &model.group.duel.incoming_challenge {
        pane.section(ui, "DUEL CHALLENGE");
        pane.field(ui, "FROM", &challenge.other_name);
        if let Some(index) = pane.rail(ui, &["ACCEPT", "DECLINE"]) {
            let command = if index == 0 {
                ClientCommand::DuelAccept {}
            } else {
                ClientCommand::DuelDecline {}
            };
            out.push(WindowAction::Command(command));
        }
    }
    if let Some(duel) = &model.group.duel.active_duel {
        pane.section(ui, "DUEL ACTIVE");
        pane.field(ui, "OPPONENT", &duel.opponent_name);
        if pane.rail(ui, &["YIELD"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::DuelYield {}));
        }
    }
    if let Some((actor_id, label)) = &model.group.deathblow_target {
        pane.field(ui, "DOWNED", label);
        if pane.rail(ui, &["DEATHBLOW"]).is_some() {
            out.push(WindowAction::Command(ClientCommand::Deathblow {
                target_actor_id: actor_id.clone(),
            }));
        }
    }
}

pub fn trade(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    let Some(session) = &model.trade.session else {
        if let Some((actor_id, label)) = &model.trade.propose_target {
            pane.field(ui, "TARGET", label);
            if pane.rail(ui, &["PROPOSE TRADE"]).is_some() {
                out.push(WindowAction::Command(ClientCommand::ProposeTrade {
                    partner_actor_id: actor_id.clone(),
                    offer: Vec::new(),
                    request: Vec::new(),
                }));
            }
        } else {
            pane.empty(ui, "SELECT A PLAYER");
        }
        return;
    };
    // Commit verbs are gated by stage, so the rail is built from whatever is
    // legal right now and each label keeps its command by index.
    const ACCEPT: u8 = 0;
    const CONFIRM: u8 = 1;
    const DECLINE: u8 = 2;
    let mut labels: [&str; 3] = [""; 3];
    let mut kinds: [u8; 3] = [0; 3];
    let mut count = 0usize;
    if !session.mine.locked {
        labels[count] = "ACCEPT";
        kinds[count] = ACCEPT;
        count += 1;
    }
    if session.both_locked && !session.mine.confirmed {
        labels[count] = "CONFIRM";
        kinds[count] = CONFIRM;
        count += 1;
    }
    labels[count] = "DECLINE";
    kinds[count] = DECLINE;
    count += 1;
    let commit = pane.reserve_footer();

    pane.field_pair(
        ui,
        ("PARTNER", &model.trade.partner_label),
        ("STAGE", &session.stage.to_ascii_uppercase()),
    );
    pane.section(ui, "YOUR INVENTORY");
    let mut rows = pane.rows();
    let mut any = false;
    for row in model.trade.offerable.iter().take(5) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.available > 0 && list.action(ui, "ADD") {
            out.push(WindowAction::Command(ClientCommand::AddTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: row.item_id,
                    variant_id: row.variant_id,
                    quantity: row.available as u32,
                },
            }));
        }
        list.value(ui, &qty(row.available));
        list.label(ui, &row.item);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING TO OFFER");
    }
    pane.resume(&rows);

    pane.section(ui, "YOU OFFER");
    let mut rows = pane.rows();
    let mut any = false;
    for line in session.mine.items.iter().take(3) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if !session.mine.locked && list.quiet_action(ui, "REMOVE") {
            out.push(WindowAction::Command(ClientCommand::RemoveTradeItem {
                proposal_id: session.proposal_id,
                item: TradeItemSpec {
                    item_id: line.item_id,
                    variant_id: line.variant_id,
                    quantity: line.quantity.max(0) as u32,
                },
            }));
        }
        list.value(ui, &qty(line.quantity));
        list.label(ui, &line.name);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING OFFERED");
    }
    pane.resume(&rows);

    pane.section(ui, "THEY OFFER");
    let mut rows = pane.rows();
    let mut any = false;
    for line in session.theirs.items.iter().take(3) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        list.value(ui, &qty(line.quantity));
        list.label_tinted(ui, &line.name, DIM);
    }
    if !any {
        chrome::empty(ui, pane.x, rows.cursor(), "NOTHING OFFERED");
    }
    pane.resume(&rows);

    pane.field_pair(
        ui,
        ("YOUR CREDITS", &session.mine.coin.to_string()),
        ("THEIR CREDITS", &session.theirs.coin.to_string()),
    );
    if !session.mine.locked {
        if let Some(index) = pane.rail(ui, &["-100 CR", "+100 CR"]) {
            let amount = if index == 0 {
                session.mine.coin.saturating_sub(100).max(0) as u64
            } else {
                session.mine.coin.saturating_add(100) as u64
            };
            out.push(WindowAction::Command(ClientCommand::SetTradeCoin {
                proposal_id: session.proposal_id,
                amount,
            }));
        }
    }
    if let Some(index) = pane.footer(ui, commit, &labels[..count]) {
        let command = match kinds[index] {
            ACCEPT => ClientCommand::AcceptTrade {
                proposal_id: session.proposal_id,
            },
            CONFIRM => ClientCommand::ConfirmTrade {
                proposal_id: session.proposal_id,
            },
            _ => ClientCommand::DeclineTrade {
                proposal_id: session.proposal_id,
            },
        };
        out.push(WindowAction::Command(command));
    }
}
