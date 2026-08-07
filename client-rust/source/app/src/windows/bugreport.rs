//! BUG REPORT — categories, bounded player text, redacted diagnostics, and
//! request-correlated results (ports of `ui/windows/defs/bugReportWindow.ts`,
//! `slice-core/bugReportSystem.ts` and `support/bugReportDiagnostics.ts`).
//!
//! Redaction contract: the diagnostics payload is built ONLY from the typed
//! [`DiagnosticsInput`] — free-text fields pass through [`redact_text`], and
//! game/chat tickets, bearer values and filesystem secrets have no field to
//! ride in. Reports correlate through `requestId`; only a matching
//! `successor.bug-report-result.v1` settles the pending state.

use super::{accent, dim, slot, slot_edge, text, WindowAction};
use crate::hud::Icons;
use serde_json::{json, Value};
use successor_engine_render::ui::{TextField, UiBuilder};

pub const BODY_MIN_CHARS: usize = 20;
pub const BODY_MAX_CHARS: usize = 4_000;

pub const CATEGORIES: [(&str, &str); 5] = [
    ("gameplay", "GAMEPLAY"),
    ("interface", "INTERFACE"),
    ("connection", "CONNECTION"),
    ("graphics_audio", "GRAPHICS/AUDIO"),
    ("other", "OTHER"),
];

#[derive(Clone, Debug, Default, PartialEq)]
pub enum BugStatus {
    #[default]
    Idle,
    /// Submitted; waiting for the correlated `bugReportResult`.
    Pending {
        request_id: String,
    },
    Accepted {
        report_id: String,
    },
    Denied {
        copy: String,
    },
}

/// Window state (owned by the host's window ui-state; mutated by draw).
#[derive(Default)]
pub struct BugReportModel {
    pub category: usize,
    pub body: TextField,
    pub status: BugStatus,
}

impl BugReportModel {
    pub fn new() -> Self {
        Self {
            category: 0,
            body: TextField::new(BODY_MAX_CHARS),
            status: BugStatus::Idle,
        }
    }
    pub fn sample() -> Self {
        Self::new()
    }
}

/// Player-facing denial copy (reference `reportErrorCopy`).
pub fn report_error_copy(reason_code: &str) -> &'static str {
    match reason_code {
        "rate_limited" => "QUEUE BUSY / TRY AGAIN IN A MINUTE",
        "invalid_report" => "REPORT NEEDS MORE DETAIL",
        _ => "NO LINK / YOUR REPORT IS KEPT, TRY AGAIN",
    }
}

/// Correlated result decode (port of `bugReportResultForRequest`): `None`
/// when the payload is not this request's result.
pub fn result_for_request(payload: &Value, expected_request_id: &str) -> Option<BugStatus> {
    if payload.get("schema").and_then(|v| v.as_str()) != Some("successor.bug-report-result.v1") {
        return None;
    }
    if payload.get("requestId").and_then(|v| v.as_str()) != Some(expected_request_id) {
        return None;
    }
    match payload.get("status").and_then(|v| v.as_str()) {
        Some("accepted") => {
            let report_id = payload.get("reportId").and_then(|v| v.as_str())?;
            let received_at = payload.get("receivedAt").and_then(|v| v.as_f64())?;
            if report_id.len() < 8 || !received_at.is_finite() {
                return None;
            }
            Some(BugStatus::Accepted {
                report_id: report_id.chars().take(128).collect(),
            })
        }
        Some("rejected") => {
            let reason = payload.get("reasonCode").and_then(|v| v.as_str())?;
            if !["invalid_report", "rate_limited", "unavailable"].contains(&reason) {
                return None;
            }
            Some(BugStatus::Denied {
                copy: report_error_copy(reason).to_string(),
            })
        }
        _ => None,
    }
}

// ── Redaction ───────────────────────────────────────────────────────────────

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '-')
}

/// Redact bearer values and ticket/token query parameters from free text and
/// cap its length (port of the reference `safeText` patterns).
pub fn redact_text(value: &str, max: usize) -> String {
    let bytes: Vec<char> = value.chars().take(max).collect();
    let lower_chars: Vec<char> = bytes.iter().map(|c| c.to_ascii_lowercase()).collect();
    let mut out = String::with_capacity(bytes.len() + 32);
    let mut i = 0usize;
    const SECRET_KEYS: [&str; 6] = [
        "chatticket",
        "gameticket",
        "csrftoken",
        "csrf",
        "ticket",
        "token",
    ];
    while i < bytes.len() {
        // `Bearer <16+ token chars>` → `Bearer [redacted]`.
        if lower_chars[i..].starts_with(&['b', 'e', 'a', 'r', 'e', 'r', ' ']) {
            let start = i + 7;
            let mut end = start;
            while end < bytes.len() && is_token_char(bytes[end]) {
                end += 1;
            }
            if end - start >= 16 {
                out.extend(&bytes[i..i + 7]);
                out.push_str("[redacted]");
                i = end;
                continue;
            }
        }
        // `?key=value` / `&key=value` for secret-bearing keys.
        if bytes[i] == '?' || bytes[i] == '&' {
            let key_start = i + 1;
            if let Some(eq_at) = SECRET_KEYS.iter().find_map(|key| {
                let end = key_start + key.len();
                (end < lower_chars.len()
                    && lower_chars[key_start..end].iter().collect::<String>() == **key
                    && lower_chars[end] == '=')
                    .then_some(end)
            }) {
                let mut end = eq_at + 1;
                while end < bytes.len() && bytes[end] != '&' && !bytes[end].is_whitespace() {
                    end += 1;
                }
                out.extend(&bytes[i..=eq_at]);
                out.push_str("[redacted]");
                i = end;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// Typed diagnostics input — this is the ONLY door into the payload. There is
/// deliberately no field a ticket, bearer token or chat body could ride in.
#[derive(Clone, Debug, Default)]
pub struct DiagnosticsInput {
    pub client_release_id: String,
    pub server_release_id: String,
    pub shard_id: String,
    pub source_state_hash: String,
    pub area_id: String,
    pub position: Option<(f32, f32)>,
    pub life_state: String,
    pub selected_actor_id: Option<String>,
    pub weapon_id: Option<String>,
    pub connected: bool,
    pub authority_tick: u64,
    pub accepted_commands: u64,
    pub rejected_commands: u64,
    /// Recent receipts: (command_id, accepted, reason_code).
    pub recent_receipts: Vec<(u64, bool, String)>,
    /// Recent client errors (already short strings; redacted again anyway).
    pub recent_errors: Vec<String>,
    pub open_windows: Vec<String>,
    pub viewport: (u32, u32),
    pub fps: f32,
    pub uptime_ms: u64,
}

/// Build the redacted diagnostics payload
/// (`successor.bug-report-diagnostics.v1`).
pub fn collect_diagnostics(input: &DiagnosticsInput) -> Value {
    let receipts: Vec<Value> = input
        .recent_receipts
        .iter()
        .rev()
        .take(16)
        .map(|(id, accepted, reason)| {
            json!({
                "commandId": id,
                "accepted": accepted,
                "reasonCode": if reason.is_empty() { Value::Null } else { Value::String(redact_text(reason, 128)) },
            })
        })
        .collect();
    let errors: Vec<Value> = input
        .recent_errors
        .iter()
        .rev()
        .take(4)
        .map(|e| Value::String(redact_text(e, 500)))
        .collect();
    json!({
        "schema": "successor.bug-report-diagnostics.v1",
        "clientUptimeMs": input.uptime_ms,
        "client": {
            "clientReleaseId": redact_text(&input.client_release_id, 128),
            "serverReleaseId": redact_text(&input.server_release_id, 128),
            "shardId": redact_text(&input.shard_id, 128),
        },
        "viewport": { "width": input.viewport.0, "height": input.viewport.1 },
        "world": {
            "areaId": redact_text(&input.area_id, 64),
            "position": input.position.map(|(x, y)| json!({"x": x, "y": y})).unwrap_or(Value::Null),
            "lifeState": redact_text(&input.life_state, 32),
            "selectedActorId": input.selected_actor_id.as_deref().map(|s| Value::String(redact_text(s, 64))).unwrap_or(Value::Null),
            "weaponId": input.weapon_id.as_deref().map(|s| Value::String(redact_text(s, 64))).unwrap_or(Value::Null),
        },
        "authority": {
            "connected": input.connected,
            "tick": input.authority_tick,
            "sourceStateHash": redact_text(&input.source_state_hash, 128),
            "acceptedCommands": input.accepted_commands,
            "rejectedCommands": input.rejected_commands,
        },
        "recentReceipts": receipts,
        "runtimeErrors": errors,
        "ui": { "openWindows": input.open_windows.iter().map(|w| Value::String(redact_text(w, 48))).collect::<Vec<_>>() },
        "renderer": { "fps": input.fps },
    })
}

// ── Window ──────────────────────────────────────────────────────────────────

pub fn draw(
    ui: &mut UiBuilder,
    ctx: super::Ctx,
    model: &mut BugReportModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = ctx.rect;
    if let Some((col, row)) = icons.cell("bug-report") {
        ui.icon(col, row, x + w - 28.0, y - 2.0, 22.0, 22.0, accent());
    }

    // Received panel replaces the form after acceptance.
    if let BugStatus::Accepted { report_id } = &model.status {
        let cy = y + 40.0;
        ui.text("REPORT RECEIVED", x, cy, 2.0, accent());
        ui.text(
            "YOUR SESSION LOG AND NOTES ARE TOGETHER IN THE QUEUE.",
            x,
            cy + 20.0,
            1.4,
            dim(),
        );
        ui.rect(x, cy + 36.0, w, 18.0, slot());
        ui.text(report_id, x + 6.0, cy + 40.0, 1.5, text());
        if ui.button(
            x,
            cy + 64.0,
            140.0,
            24.0,
            "ANOTHER REPORT",
            crate::hud::button_style(),
        ) {
            out.push(WindowAction::BugReportReset);
        }
        return;
    }

    let mut cy = y + 24.0;
    ui.text(
        "TELL US WHAT BROKE, WHAT YOU EXPECTED, AND WHAT",
        x,
        cy,
        1.4,
        dim(),
    );
    ui.text("YOU DID JUST BEFORE IT HAPPENED.", x, cy + 11.0, 1.4, dim());
    cy += 28.0;

    // AREA selector.
    ui.text("AREA", x, cy, 1.4, dim());
    cy += 12.0;
    let btn_w = (w - 12.0) / 3.0;
    for (i, (_, label)) in CATEGORIES.iter().enumerate() {
        let col = i % 3;
        let row = i / 3;
        let bx = x + col as f32 * (btn_w + 6.0);
        let by = cy + row as f32 * 26.0;
        let mut style = crate::hud::button_style();
        if i == model.category {
            style.fill = style.active;
            style.edge = accent();
        }
        if ui.button(bx, by, btn_w, 20.0, label, style) {
            model.category = i;
        }
    }
    cy += 2.0 * 26.0 + 8.0;

    // Body field + live count.
    ui.text("WHAT HAPPENED?", x, cy, 1.4, dim());
    cy += 12.0;
    let field_h = (h - (cy - y) - 78.0).max(40.0);
    let pending = matches!(model.status, BugStatus::Pending { .. });
    ui.text_field(
        &mut model.body,
        x,
        cy,
        w,
        field_h,
        1.6,
        !pending,
        crate::hud::button_style(),
    );
    cy += field_h + 6.0;
    let len = model.body.text.trim().chars().count();
    ui.text(
        &format!("{len} / {BODY_MAX_CHARS}"),
        x,
        cy,
        1.3,
        if len < BODY_MIN_CHARS { dim() } else { text() },
    );

    // Diagnostics disclosure (exact reference promise).
    ui.text(
        "SESSION LOG ATTACHED: BUILD AND SHARD IDS, LOCATION,",
        x,
        cy + 12.0,
        1.2,
        dim(),
    );
    ui.text(
        "CLIENT ERRORS, RECEIPTS, OPEN WINDOWS. NEVER PASSWORDS,",
        x,
        cy + 22.0,
        1.2,
        dim(),
    );
    ui.text(
        "TICKETS, COOKIES, CHAT, OR INVENTORY.",
        x,
        cy + 32.0,
        1.2,
        dim(),
    );

    // Status line.
    match &model.status {
        BugStatus::Pending { .. } => {
            ui.text("PACKING SESSION LOG...", x, cy + 44.0, 1.4, accent());
        }
        BugStatus::Denied { copy } => {
            ui.text(copy, x, cy + 44.0, 1.4, crate::hud::active_palette().danger);
        }
        _ => {}
    }

    // Submit.
    let can_send = len >= BODY_MIN_CHARS && !pending;
    let mut style = crate::hud::button_style();
    if !can_send {
        style.text = dim();
        style.edge = slot_edge();
    }
    let label = if pending { "SENDING..." } else { "SEND REPORT" };
    if ui.button(x, y + h - 24.0, w, 22.0, label, style) && can_send {
        out.push(WindowAction::SubmitBugReport {
            category: CATEGORIES[model.category].0.to_string(),
            body: crate::hud::sanitize_text(&model.body.text, BODY_MAX_CHARS),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(rect: [f32; 4]) -> crate::windows::Ctx {
        crate::windows::Ctx {
            spec: crate::windows::spec::surface("bug-report").expect("report surface"),
            rect,
            tab: 0,
        }
    }

    #[test]
    fn redacts_bearer_and_ticket_params() {
        let s = "auth Bearer abcdefghijklmnop0123 tail";
        assert_eq!(redact_text(s, 500), "auth Bearer [redacted] tail");
        let q = "wss://x/y?gameTicket=SECRET123&keep=1&chatTicket=ALSO";
        let r = redact_text(q, 500);
        assert!(!r.contains("SECRET123"), "{r}");
        assert!(!r.contains("ALSO"), "{r}");
        assert!(r.contains("gameTicket=[redacted]"), "{r}");
        assert!(r.contains("keep=1"), "{r}");
        // Short bearer-ish strings survive (not a token).
        assert_eq!(redact_text("Bearer short", 64), "Bearer short");
    }

    #[test]
    fn diagnostics_never_carry_secrets() {
        let input = DiagnosticsInput {
            client_release_id: "client-1".into(),
            server_release_id: "server-1".into(),
            shard_id: "shard-9".into(),
            source_state_hash: "abc123".into(),
            area_id: "open-desert".into(),
            recent_errors: vec![
                "socket wss://host/game?ticket=TOPSECRET failed".into(),
                "reject Bearer aaaaaaaaaaaaaaaaaaaaaa".into(),
            ],
            ..Default::default()
        };
        let payload = serde_json::to_string(&collect_diagnostics(&input)).unwrap();
        assert!(!payload.contains("TOPSECRET"));
        assert!(!payload.contains("aaaaaaaaaaaaaaaaaaaaaa"));
        assert!(payload.contains("[redacted]"));
        assert!(payload.contains("successor.bug-report-diagnostics.v1"));
    }

    #[test]
    fn result_correlation_is_exact() {
        let accepted = serde_json::json!({
            "schema": "successor.bug-report-result.v1",
            "requestId": "req-1",
            "status": "accepted",
            "reportId": "REPORT-12345",
            "receivedAt": 172000.0,
        });
        assert_eq!(
            result_for_request(&accepted, "req-1"),
            Some(BugStatus::Accepted {
                report_id: "REPORT-12345".into()
            })
        );
        assert_eq!(
            result_for_request(&accepted, "req-2"),
            None,
            "foreign request ignored"
        );
        let rejected = serde_json::json!({
            "schema": "successor.bug-report-result.v1",
            "requestId": "req-1",
            "status": "rejected",
            "reasonCode": "rate_limited",
        });
        assert!(matches!(
            result_for_request(&rejected, "req-1"),
            Some(BugStatus::Denied { .. })
        ));
        let short_id = serde_json::json!({
            "schema": "successor.bug-report-result.v1",
            "requestId": "req-1",
            "status": "accepted",
            "reportId": "short",
            "receivedAt": 1.0,
        });
        assert_eq!(result_for_request(&short_id, "req-1"), None);
    }

    #[test]
    fn submit_gates_on_min_length_and_pending() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = BugReportModel::new();
        let rect = [10.0, 10.0, 320.0, 400.0];
        // Too-short body: click SEND → no action.
        for c in "short".chars() {
            model.body.insert(c);
        }
        let (bx, by) = (10.0 + 160.0, 10.0 + 400.0 - 13.0);
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        assert!(out.is_empty());
        // Long enough → SubmitBugReport with the reference category id.
        for c in " and then the terminal ate my report".chars() {
            model.body.insert(c);
        }
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        assert!(matches!(
            out.as_slice(),
            [WindowAction::SubmitBugReport { category, .. }] if category == "gameplay"
        ));
        // Pending swallows further submits.
        model.status = BugStatus::Pending {
            request_id: "r".into(),
        };
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, ctx(rect), &mut model, &icons, &mut out);
        assert!(out.is_empty());
    }
}
