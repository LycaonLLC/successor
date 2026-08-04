//! Hosted character-workshop protocol and state fence.
//!
//! The browser parent remains the only account, roster, CSRF, create, and
//! ticket authority. This module accepts only the parent’s deliberately small
//! projection, turns screen intents into the three creator messages, and never
//! contains a credential, URL, or HTTP path.

use crate::screens::RosterEntry;
use serde_json::{json, Map, Value};

pub const CREATOR_READY_TYPE: &str = "successor.creator.ready.v1";
pub const CREATOR_CREATE_TYPE: &str = "successor.creator.create.v1";
pub const CREATOR_SELECT_TYPE: &str = "successor.creator.select.v1";
pub const CREATOR_STATE_TYPE: &str = "successor.creator.state.v1";
pub const CREATOR_CREATE_RESULT_TYPE: &str = "successor.creator.create-result.v1";

const MAX_ROSTER_ENTRIES: usize = 10;
const MAX_CHARACTER_ID: usize = 128;
const MAX_CHARACTER_NAME: usize = 16;
const MAX_ERROR_TEXT: usize = 128;
const CREATE_TIMEOUT_MS: u64 = 12_000;
const APPEARANCE_KEYS: &[&str] = &["body", "skinTone", "hair", "hairMat", "face"];
const FACE_KEYS: &[&str] = &[
    "eyes",
    "brows",
    "nose",
    "mouth",
    "eyeColor",
    "browColor",
    "lipColor",
];

/// The only body values accepted by the parent character store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreatorBody {
    Male,
    Female,
}

impl CreatorBody {
    pub const fn from_female(female: bool) -> Self {
        if female {
            Self::Female
        } else {
            Self::Male
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Male => "male",
            Self::Female => "female",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "male" => Some(Self::Male),
            "female" => Some(Self::Female),
            _ => None,
        }
    }
}

/// Minimal safe roster record retained by the Rust child. Account references,
/// tickets, and all unknown fields are discarded by the platform bridge before
/// this parser sees a message. `body` remains so the roster never silently
/// presents every parent-owned character as male.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorCharacter {
    pub id: String,
    pub name: String,
    pub initial_profession_id: Option<String>,
    pub world_entry_claimed: bool,
    pub body: CreatorBody,
}

impl CreatorCharacter {
    fn roster_entry(&self) -> RosterEntry {
        RosterEntry {
            id: self.id.clone(),
            name: self.name.clone(),
            female: self.body == CreatorBody::Female,
            lineage: String::new(),
            vocation: display_profession(self.initial_profession_id.as_deref()),
            location: String::new(),
            played: String::new(),
        }
    }
}

/// Bounded parent projection for the live workshop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorState {
    pub characters: Vec<CreatorCharacter>,
    pub selected_character_id: Option<String>,
}

/// A validated parent message. The platform only queues these two types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreatorInbound {
    State(CreatorState),
    CreateResult(CreatorCreateResult),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorCreateResult {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
}

/// The canonical appearance expressible by the Rust pregame screen. It exactly
/// matches the hosted parent’s `CharacterAppearance` contract: the visible
/// presentation maps body precisely, while fixed canonical values provide the
/// current skin/hair/face defaults without inventing another authority path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CanonicalAppearance {
    pub body: CreatorBody,
    pub skin_tone: &'static str,
    pub hair: Option<&'static str>,
    pub hair_mat: &'static str,
}

impl CanonicalAppearance {
    pub const fn creator_default(female: bool) -> Self {
        Self {
            body: CreatorBody::from_female(female),
            skin_tone: "#c78f62",
            hair: Some("hair_mop"),
            hair_mat: "hair_raven",
        }
    }
}

/// Exact child-to-parent create payload. It is serialized only immediately
/// before the platform posts it to the exact configured parent origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreatorCreateRequest {
    pub request_id: String,
    pub name: String,
    pub initial_profession_id: &'static str,
    pub appearance: CanonicalAppearance,
}

impl CreatorCreateRequest {
    pub fn to_json(&self) -> String {
        serde_json::to_string(&json!({
            "type": CREATOR_CREATE_TYPE,
            "requestId": self.request_id.as_str(),
            "character": {
                "name": self.name.as_str(),
                "initialProfessionId": self.initial_profession_id,
                "appearance": {
                    "body": self.appearance.body.as_str(),
                    "skinTone": self.appearance.skin_tone,
                    "hair": self.appearance.hair,
                    "hairMat": self.appearance.hair_mat,
                    "face": Value::Null,
                },
            },
        }))
        .expect("fixed hosted creator payload serializes")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateStartError {
    Pending,
    InvalidName,
    UnsupportedProfession,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CreateEffect {
    Ignored,
    WaitingForRoster,
    Rejected(String),
    Created(String),
    TimedOut,
}

/// Result of replacing the server-owned roster projection.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StateEffect {
    pub created_character_id: Option<String>,
    pub selected_character_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PendingPhase {
    WaitingForResult,
    WaitingForRoster,
}

#[derive(Clone, Debug)]
struct PendingCreate {
    request_id: String,
    expected_name: String,
    before_ids: Vec<String>,
    started_ms: u64,
    phase: PendingPhase,
}

/// Small state machine for one hosted workshop frame. A create only completes
/// after its matching result *and* a refreshed state prove that exactly one new
/// stable id has appeared for the requested canonical name.
#[derive(Debug, Default)]
pub struct HostedCreatorFlow {
    roster: Vec<CreatorCharacter>,
    pending: Option<PendingCreate>,
    next_request: u64,
}

impl HostedCreatorFlow {
    pub fn roster_entries(&self) -> Vec<RosterEntry> {
        self.roster
            .iter()
            .map(CreatorCharacter::roster_entry)
            .collect()
    }

    pub fn apply_state(&mut self, state: CreatorState) -> StateEffect {
        self.roster = state.characters;
        let created_character_id = self
            .pending
            .as_ref()
            .filter(|pending| pending.phase == PendingPhase::WaitingForRoster)
            .and_then(|pending| self.created_character_id(pending));
        if created_character_id.is_some() {
            self.pending = None;
        }
        StateEffect {
            created_character_id,
            selected_character_id: state.selected_character_id,
        }
    }

    pub fn begin_create(
        &mut self,
        display_name: &str,
        screen_vocation: &str,
        female: bool,
        now_ms: u64,
    ) -> Result<CreatorCreateRequest, CreateStartError> {
        if self.pending.is_some() {
            return Err(CreateStartError::Pending);
        }
        let name = canonical_creator_name(display_name).ok_or(CreateStartError::InvalidName)?;
        let initial_profession_id =
            hosted_profession(screen_vocation).ok_or(CreateStartError::UnsupportedProfession)?;
        self.next_request = self.next_request.wrapping_add(1).max(1);
        let request_id = format!("r{}-{}", self.next_request, now_ms.max(1));
        self.pending = Some(PendingCreate {
            request_id: request_id.clone(),
            expected_name: name.clone(),
            before_ids: self
                .roster
                .iter()
                .map(|character| character.id.clone())
                .collect(),
            started_ms: now_ms,
            phase: PendingPhase::WaitingForResult,
        });
        Ok(CreatorCreateRequest {
            request_id,
            name,
            initial_profession_id,
            appearance: CanonicalAppearance::creator_default(female),
        })
    }

    pub fn handle_create_result(&mut self, result: CreatorCreateResult) -> CreateEffect {
        let Some(pending) = self.pending.as_ref() else {
            return CreateEffect::Ignored;
        };
        if pending.request_id != result.request_id {
            return CreateEffect::Ignored;
        }
        if !result.ok {
            self.pending = None;
            return CreateEffect::Rejected(
                result
                    .error
                    .unwrap_or_else(|| "CREATE REQUEST WAS REJECTED".to_string()),
            );
        }
        if let Some(pending) = self.pending.as_mut() {
            pending.phase = PendingPhase::WaitingForRoster;
        }
        let created_character_id = self
            .pending
            .as_ref()
            .and_then(|pending| self.created_character_id(pending));
        if let Some(character_id) = created_character_id {
            self.pending = None;
            CreateEffect::Created(character_id)
        } else {
            CreateEffect::WaitingForRoster
        }
    }

    pub fn expire(&mut self, now_ms: u64) -> CreateEffect {
        let timed_out = self
            .pending
            .as_ref()
            .is_some_and(|pending| now_ms.saturating_sub(pending.started_ms) >= CREATE_TIMEOUT_MS);
        if timed_out {
            self.pending = None;
            CreateEffect::TimedOut
        } else {
            CreateEffect::Ignored
        }
    }

    pub fn has_pending_create(&self) -> bool {
        self.pending.is_some()
    }

    /// Abort only the local wait when the browser bridge could not post the
    /// already-validated payload. Nothing has reached parent authority.
    pub fn cancel_pending(&mut self) {
        self.pending = None;
    }

    fn created_character_id(&self, pending: &PendingCreate) -> Option<String> {
        let mut matches = self.roster.iter().filter(|character| {
            !pending.before_ids.iter().any(|id| id == &character.id)
                && character.name == pending.expected_name
        });
        let candidate = matches.next()?;
        (matches.next().is_none()).then(|| candidate.id.clone())
    }
}

/// Parse a normalized queued platform message. This is deliberately strict a
/// second time: malformed messages are absent, never partially interpreted.
pub fn parse_inbound_message(bytes: &[u8]) -> Option<CreatorInbound> {
    let value = serde_json::from_slice::<Value>(bytes).ok()?;
    let object = value.as_object()?;
    match object.get("type")?.as_str()? {
        CREATOR_STATE_TYPE => parse_state(object).map(CreatorInbound::State),
        CREATOR_CREATE_RESULT_TYPE => parse_create_result(object).map(CreatorInbound::CreateResult),
        _ => None,
    }
}

fn parse_state(object: &Map<String, Value>) -> Option<CreatorState> {
    if !has_only_keys(object, &["type", "characters", "selectedCharacterId"]) {
        return None;
    }
    let values = object.get("characters")?.as_array()?;
    if values.len() > MAX_ROSTER_ENTRIES {
        return None;
    }
    let mut characters = Vec::with_capacity(values.len());
    for value in values {
        let character = parse_character(value)?;
        if characters
            .iter()
            .any(|existing: &CreatorCharacter| existing.id == character.id)
        {
            return None;
        }
        characters.push(character);
    }
    let selected_character_id = match object.get("selectedCharacterId") {
        None => None,
        Some(Value::String(id)) if is_character_id(id) => Some(id.clone()),
        Some(_) => return None,
    };
    if let Some(id) = selected_character_id.as_deref() {
        if !characters.iter().any(|character| character.id == id) {
            return None;
        }
    }
    Some(CreatorState {
        characters,
        selected_character_id,
    })
}

fn parse_character(value: &Value) -> Option<CreatorCharacter> {
    let object = value.as_object()?;
    if !has_only_keys(
        object,
        &[
            "id",
            "name",
            "initialProfessionId",
            "worldEntryClaimed",
            "appearance",
        ],
    ) {
        return None;
    }
    let id = object.get("id")?.as_str()?;
    let name = object.get("name")?.as_str()?;
    let initial_profession_id = match object.get("initialProfessionId")? {
        Value::Null => None,
        Value::String(value) if is_profession_id(value) => Some(value.clone()),
        _ => return None,
    };
    let world_entry_claimed = object.get("worldEntryClaimed")?.as_bool()?;
    let body = parse_appearance_body(object.get("appearance")?)?;
    if !is_character_id(id) || !is_creator_name(name) {
        return None;
    }
    Some(CreatorCharacter {
        id: id.to_string(),
        name: name.to_string(),
        initial_profession_id,
        world_entry_claimed,
        body,
    })
}

fn parse_appearance_body(value: &Value) -> Option<CreatorBody> {
    let appearance = value.as_object()?;
    if !has_only_keys(appearance, APPEARANCE_KEYS) {
        return None;
    }
    let body = CreatorBody::parse(appearance.get("body")?.as_str()?)?;
    if !is_safe_text(appearance.get("skinTone")?.as_str()?, 1, 64)
        || !is_safe_text(appearance.get("hairMat")?.as_str()?, 1, 64)
    {
        return None;
    }
    match appearance.get("hair")? {
        Value::Null => {}
        Value::String(hair) if is_safe_text(hair, 1, 64) => {}
        _ => return None,
    }
    match appearance.get("face")? {
        Value::Null => {}
        Value::Object(face) if has_only_keys(face, FACE_KEYS) => {
            for key in FACE_KEYS {
                if !is_safe_text(face.get(*key)?.as_str()?, 1, 64) {
                    return None;
                }
            }
        }
        _ => return None,
    }
    Some(body)
}

fn parse_create_result(object: &Map<String, Value>) -> Option<CreatorCreateResult> {
    if !has_only_keys(object, &["type", "requestId", "ok", "error"]) {
        return None;
    }
    let request_id = object.get("requestId")?.as_str()?;
    let ok = object.get("ok")?.as_bool()?;
    let error = match object.get("error") {
        None => None,
        Some(Value::String(value)) if !ok && is_safe_text(value, 1, MAX_ERROR_TEXT) => {
            Some(value.clone())
        }
        Some(_) => return None,
    };
    if !is_request_id(request_id) {
        return None;
    }
    Some(CreatorCreateResult {
        request_id: request_id.to_string(),
        ok,
        error,
    })
}

fn has_only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn is_character_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=MAX_CHARACTER_ID).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_request_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn is_profession_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes[0].is_ascii_lowercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || matches!(byte, b'_' | b'-'))
}

fn is_creator_name(value: &str) -> bool {
    let bytes = value.as_bytes();
    if !(3..=MAX_CHARACTER_NAME).contains(&bytes.len()) {
        return false;
    }
    let mut previous_hyphen = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if byte.is_ascii_alphabetic() {
            previous_hyphen = false;
        } else if byte == b'-' && index > 0 && !previous_hyphen && index + 1 < bytes.len() {
            previous_hyphen = true;
        } else {
            return false;
        }
    }
    !previous_hyphen
}

fn is_safe_text(value: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&value.len()) && value.bytes().all(|byte| (b' '..=b'~').contains(&byte))
}

fn canonical_creator_name(display_name: &str) -> Option<String> {
    let mut canonical = String::with_capacity(display_name.len());
    for part in display_name.split_whitespace() {
        if !canonical.is_empty() {
            canonical.push('-');
        }
        canonical.push_str(part);
    }
    is_creator_name(&canonical).then_some(canonical)
}

fn hosted_profession(screen_vocation: &str) -> Option<&'static str> {
    match screen_vocation {
        "TECHNICIAN" => Some("craftsman"),
        "SCOUT" => Some("scout"),
        "MEDIC" => Some("medic"),
        "MARKSMAN" => Some("marksman"),
        _ => None,
    }
}

fn display_profession(value: Option<&str>) -> String {
    match value {
        Some("craftsman") => "TECHNICIAN".to_string(),
        Some("scout") => "SCOUT".to_string(),
        Some("medic") => "MEDIC".to_string(),
        Some("marksman") => "MARKSMAN".to_string(),
        Some("brawler") => "BRAWLER".to_string(),
        Some(value) => value.to_ascii_uppercase(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(id: &str, name: &str, body: CreatorBody) -> CreatorCharacter {
        CreatorCharacter {
            id: id.to_string(),
            name: name.to_string(),
            initial_profession_id: Some("scout".to_string()),
            world_entry_claimed: false,
            body,
        }
    }

    #[test]
    fn parser_accepts_only_the_safe_roster_projection_with_body() {
        let accepted = parse_inbound_message(
            br##"{"type":"successor.creator.state.v1","characters":[{"id":"char-1","name":"Mara-Voss","initialProfessionId":"scout","worldEntryClaimed":false,"appearance":{"body":"female","skinTone":"#c78f62","hair":"hair_mop","hairMat":"hair_raven","face":null}}]}"##,
        );
        assert!(matches!(
            accepted,
            Some(CreatorInbound::State(CreatorState { characters, .. }))
                if characters[0].body == CreatorBody::Female
        ));

        let rejected = parse_inbound_message(
            br##"{"type":"successor.creator.state.v1","characters":[{"id":"char-1","name":"Mara-Voss","initialProfessionId":"scout","worldEntryClaimed":false,"appearance":{"body":"female","skinTone":"#c78f62","hair":"hair_mop","hairMat":"hair_raven","face":null},"ticket":"secret"}]}"##,
        );
        assert!(rejected.is_none());
    }

    #[test]
    fn create_maps_visible_fields_to_canonical_parent_payload() {
        let mut flow = HostedCreatorFlow::default();
        let request = flow
            .begin_create("Mara Voss", "TECHNICIAN", true, 42)
            .unwrap();
        let payload = serde_json::from_str::<Value>(&request.to_json()).unwrap();
        assert_eq!(payload["type"], CREATOR_CREATE_TYPE);
        assert_eq!(payload["character"]["name"], "Mara-Voss");
        assert_eq!(payload["character"]["initialProfessionId"], "craftsman");
        assert_eq!(
            payload["character"]["appearance"],
            json!({
                "body": "female",
                "skinTone": "#c78f62",
                "hair": "hair_mop",
                "hairMat": "hair_raven",
                "face": null,
            })
        );
    }

    #[test]
    fn create_waits_for_matching_result_and_refreshed_stable_id() {
        let mut flow = HostedCreatorFlow::default();
        flow.apply_state(CreatorState {
            characters: vec![character("char-old", "Atlas", CreatorBody::Male)],
            selected_character_id: None,
        });
        let request = flow
            .begin_create("Mara Voss", "TECHNICIAN", true, 42)
            .unwrap();
        assert_eq!(
            flow.handle_create_result(CreatorCreateResult {
                request_id: request.request_id,
                ok: true,
                error: None,
            }),
            CreateEffect::WaitingForRoster
        );
        assert!(flow.has_pending_create());

        let update = flow.apply_state(CreatorState {
            characters: vec![
                character("char-old", "Atlas", CreatorBody::Male),
                character("char-new", "Mara-Voss", CreatorBody::Female),
            ],
            selected_character_id: None,
        });
        assert_eq!(update.created_character_id.as_deref(), Some("char-new"));
        assert!(!flow.has_pending_create());
    }

    #[test]
    fn create_rejection_is_matched_and_bounded() {
        let mut flow = HostedCreatorFlow::default();
        let request = flow.begin_create("Mara", "SCOUT", false, 1).unwrap();
        assert_eq!(
            flow.handle_create_result(CreatorCreateResult {
                request_id: "other".to_string(),
                ok: false,
                error: Some("name_taken".to_string()),
            }),
            CreateEffect::Ignored
        );
        assert_eq!(
            flow.handle_create_result(CreatorCreateResult {
                request_id: request.request_id,
                ok: false,
                error: Some("name_taken".to_string()),
            }),
            CreateEffect::Rejected("name_taken".to_string())
        );
        assert!(!flow.has_pending_create());
    }
}
