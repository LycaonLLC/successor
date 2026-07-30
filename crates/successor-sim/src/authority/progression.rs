//! Professions, skill boxes, career goals, and actor capabilities.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthorityProfessionKind {
    Craftsman,
    Medic,
    Scout,
    Marksman,
    Brawler,
    // Bio-Engineer: hybrid elite off Craftsman + Medic (bioengineer-design.md §1).
    BioEngineer,
    // Commando: hybrid elite off Marksman + Brawler — the ELITE gun profession
    // (heavy weapons, demolitions, suppression, field-hardening). Regular guns are
    // Marksman; elite guns are Commando (combat-doctrine.md / states+commando).
    Commando,
}

impl AuthorityProfessionKind {
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Craftsman => "craftsman",
            Self::Medic => "medic",
            Self::Scout => "scout",
            Self::Marksman => "marksman",
            Self::Brawler => "brawler",
            Self::BioEngineer => "bioengineer",
            Self::Commando => "commando",
        }
    }

    pub(super) const fn all() -> [Self; 7] {
        [
            Self::Marksman,
            Self::Brawler,
            Self::Scout,
            Self::Craftsman,
            Self::Medic,
            Self::BioEngineer,
            Self::Commando,
        ]
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::Craftsman => "Craftsman",
            Self::Medic => "Medic",
            Self::Scout => "Scout",
            Self::Marksman => "Marksman",
            Self::Brawler => "Brawler",
            Self::BioEngineer => "Bio-Engineer",
            Self::Commando => "Commando",
        }
    }

    pub(super) fn from_id(value: &str) -> Option<Self> {
        match normalize_command_key(value).as_str() {
            "craftsman" | "surveyor" | "craft" => Some(Self::Craftsman),
            "medic" | "medical" => Some(Self::Medic),
            "scout" | "harvest" | "processing" => Some(Self::Scout),
            "marksman" | "combat" | "guard" | "agent" | "fighter" | "ranged" => {
                Some(Self::Marksman)
            }
            "brawler" | "melee" => Some(Self::Brawler),
            "bioengineer" | "bio-engineer" | "genecrafter" | "bio" => Some(Self::BioEngineer),
            "commando" | "cmd" | "elite-ranged" => Some(Self::Commando),
            _ => None,
        }
    }
}

// Ratified bare-start tunable: fresh real characters enter with this scalar
// credit balance (no Credit Chip inventory row to redeem first).
pub(super) const DEFAULT_ACTOR_CREDITS: u64 = 5_000;
const GENERIC_TRACK_SKILL_BONUS_PER_BOX: i32 = 50;
const MEDICINE_USE_TRACK_BONUS_MILLI_PER_BOX: i32 = 500;
const MEDICINE_USE_MASTER_EXTRA_BONUS_MILLI: i32 = 1_000;
const SKILL_POINT_COST_NOVICE: u16 = 16;
const SKILL_POINT_COST_TIER_I: u16 = 8;
const SKILL_POINT_COST_TIER_II: u16 = 6;
const SKILL_POINT_COST_TIER_III: u16 = 4;
const SKILL_POINT_COST_TIER_IV: u16 = 2;
const SKILL_POINT_COST_MASTER: u16 = 1;
pub(super) const DEFAULT_SKILL_POINT_CAP: u16 = 250;

const MEDICAL_EXPERIMENTATION_POINTS_PER_BONUS: i32 = 20;
const MARKSMAN_RIFLE_I_SPREAD_REDUCTION_MILLI: i32 = 500;
const MARKSMAN_RIFLE_II_SPREAD_REDUCTION_MILLI: i32 = 650;
const MARKSMAN_RIFLE_III_SPREAD_REDUCTION_MILLI: i32 = 780;
const MARKSMAN_RIFLE_IV_SPREAD_REDUCTION_MILLI: i32 = 880;
const MARKSMAN_MASTER_RIFLE_SPREAD_REDUCTION_MILLI: i32 = 920;

// ─────────────────────────────────────────────────────────────────────────────
// PROFESSION STAT TUNING SURFACE
//
// Every previously label-only track resolves through ONE table-driven mapping that
// reads the shared `profession_track_skill_bonus` ladder (GENERIC_TRACK_SKILL_BONUS_PER_BOX
// per box: novice 50 → all four tiers + master 300) and turns it into an atomic
// modifier. No bespoke per-box code — each family is `base + per_step * steps`, where
// `steps` = boxes-beyond-novice: 0 (novice only) … 5 (I, II, III, IV, master), via
// `track_steps_beyond_novice` / `profession_stat_curve` below.
//
// OWNER RETUNE: every value here is a plain const; bump a base/per-step and the whole
// curve + its unit test move together. The per-family unit tests assert the exact tier
// curve, so a retune that breaks an endpoint or monotonicity fails loudly.
// ─────────────────────────────────────────────────────────────────────────────

/// Boxes a full track climbs beyond novice: four tiers (I–IV) + master.
const PROFESSION_TRACK_MAX_STEPS_BEYOND_NOVICE: i32 = 5;

// ── Marksman · pistol (sidearm) ──────────────────────────────────────────────
// Snappy close small-arms. NOTE: no sidearm weapon class ships yet, so these two are the
// ready tuning surface; consumption lights up when a pistol-class weapon + a weapon-swap
// cooldown land (content wave). Spread reduction 0→800‰; swap-cooldown mult 1000→400‰.
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_PISTOL_SPREAD_REDUCTION_MILLI_BASE: i32 = 0;
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_PISTOL_SPREAD_REDUCTION_MILLI_PER_STEP: i32 = 160;
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_PISTOL_SWAP_SPEED_MULTIPLIER_MILLI_BASE: i32 = 1_000;
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_PISTOL_SWAP_SPEED_MULTIPLIER_MILLI_PER_STEP: i32 = -120;

// ── Marksman · tactics ───────────────────────────────────────────────────────
// Re-target latency reduction 0→700‰ (combat-queue re-arm — content-wave machinery).
// Ranged special (aimed shot) action-cost reduction 0→250‰ IS consumed
// (combat_roll AIMED_SHOT_ACTION_COST).
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_TACTICS_REQUEUE_LATENCY_REDUCTION_MILLI_BASE: i32 = 0;
#[allow(dead_code)] // ready tuning surface; consumed when the content machinery lands
const MARKSMAN_TACTICS_REQUEUE_LATENCY_REDUCTION_MILLI_PER_STEP: i32 = 140;
const MARKSMAN_TACTICS_SPECIAL_ACTION_COST_REDUCTION_MILLI_BASE: i32 = 0;
const MARKSMAN_TACTICS_SPECIAL_ACTION_COST_REDUCTION_MILLI_PER_STEP: i32 = 50;

// ── Marksman · fieldcraft ────────────────────────────────────────────────────
// Cover discipline pays while kneeling: spread multiplier ×1.0→×1.6 and kneeling
// damage-taken reduction 0→200‰ (−20%).
const MARKSMAN_FIELDCRAFT_KNEEL_SPREAD_MULT_MILLI_BASE: i32 = 1_000;
const MARKSMAN_FIELDCRAFT_KNEEL_SPREAD_MULT_MILLI_PER_STEP: i32 = 120;
const MARKSMAN_FIELDCRAFT_KNEEL_DAMAGE_TAKEN_REDUCTION_MILLI_BASE: i32 = 0;
const MARKSMAN_FIELDCRAFT_KNEEL_DAMAGE_TAKEN_REDUCTION_MILLI_PER_STEP: i32 = 40;

// ── Brawler · melee ──────────────────────────────────────────────────────────
// Vibrosword handling finally moves numbers: melee damage bonus 0→+300‰ (+30% at master)
// AND a variance FLOOR raised 0→400‰ (min roll ≥40% of the band) — skill shrinks luck.
const BRAWLER_MELEE_DAMAGE_BONUS_MILLI_BASE: i32 = 0;
const BRAWLER_MELEE_DAMAGE_BONUS_MILLI_PER_STEP: i32 = 60;
const BRAWLER_MELEE_VARIANCE_FLOOR_MILLI_BASE: i32 = 0;
const BRAWLER_MELEE_VARIANCE_FLOOR_MILLI_PER_STEP: i32 = 80;

// ── Brawler · guard — THE WALL ───────────────────────────────────────────────
// The lane-holder: parry (melee block) 0→350‰, ranged deflection 0→950‰ (the re-homed
// ranged-block, 190‰/guard-box × 5), braced damage-taken reduction 0→150‰ (−15%). The
// 95%-per-box saber-block TEST line stays debug-only (BRAWLER_RANGED_BLOCK_* +
// DebugGrantSkillBoxes / GAME_DEBUG_AUTHORITY_COMMANDS gating).
const BRAWLER_GUARD_PARRY_BLOCK_PERMILLE_BASE: i32 = 0;
const BRAWLER_GUARD_PARRY_BLOCK_PERMILLE_PER_STEP: i32 = 70;
const BRAWLER_GUARD_RANGED_BLOCK_PERMILLE_BASE: i32 = 0;
const BRAWLER_GUARD_RANGED_BLOCK_PERMILLE_PER_STEP: i32 = 190;
const BRAWLER_GUARD_BRACED_DAMAGE_TAKEN_REDUCTION_MILLI_BASE: i32 = 0;
const BRAWLER_GUARD_BRACED_DAMAGE_TAKEN_REDUCTION_MILLI_PER_STEP: i32 = 30;

// ── Scout · campcraft ────────────────────────────────────────────────────────
// Camp abandonment grace +0→+900 s (+15 min, stacks on the 15-min base). Shelter radius
// +0→+3 cells. Field Rest: health/action regen ×1.0→×1.75 while in the scout's OWN camp.
const SCOUT_CAMPCRAFT_GRACE_BONUS_SECONDS_BASE: u64 = 0;
const SCOUT_CAMPCRAFT_GRACE_BONUS_SECONDS_PER_STEP: u64 = 180;
const SCOUT_CAMPCRAFT_SHELTER_RADIUS_BONUS_CELLS_MAX: i32 = 3;
const SCOUT_CAMPCRAFT_FIELD_REST_MULT_MILLI_BASE: i32 = 1_000;
const SCOUT_CAMPCRAFT_FIELD_REST_MULT_MILLI_PER_STEP: i32 = 150;

// ── Craftsman · survey ───────────────────────────────────────────────────────
// Survey range 24→44 cells (+4/box beyond novice). Heat Reading: grid sample spacing
// (resolution) tightens 12→8→6 cells with tier — a finer concentration map up top.
const CRAFTSMAN_SURVEY_RANGE_CELLS_BASE: i32 = 24;
const CRAFTSMAN_SURVEY_RANGE_CELLS_PER_STEP: i32 = 4;
const CRAFTSMAN_SURVEY_GRID_STEP_CELLS_COARSE: i32 = 12; // novice … survey-I
const CRAFTSMAN_SURVEY_GRID_STEP_CELLS_MID: i32 = 8; // survey-II … IV
const CRAFTSMAN_SURVEY_GRID_STEP_CELLS_FINE: i32 = 6; // master

// ── Craftsman · tools ────────────────────────────────────────────────────────
// Crafted-tool quality FLOOR +0→+150‰ (tool-class recipes only). Starter Field Multitool
// grant quality 500→650‰, reaching 650 by tools-IV (master holds at 650).
const CRAFTSMAN_TOOLS_QUALITY_FLOOR_BONUS_MILLI_BASE: i32 = 0;
const CRAFTSMAN_TOOLS_QUALITY_FLOOR_BONUS_MILLI_PER_STEP: i32 = 30;
const CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_BASE: i32 = 500;
const CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_MAX: i32 = 650;
const CRAFTSMAN_TOOLS_STARTER_GRANT_FULL_AT_STEPS: i32 = 4; // reaches max at tools-IV

// ── Medic · trauma ───────────────────────────────────────────────────────────
// Battlefield medic: revive cast reduction 0→500‰ (−50%), revived-target vitals 25→60 %
// (replaces the flat REVIVE_RESTORE_VITALS_PERCENT for medic revives), clone-sickness
// reduction 0→400‰ (−40%) when the reviving medic is trauma-trained.
const MEDIC_TRAUMA_REVIVE_CAST_REDUCTION_MILLI_BASE: i32 = 0;
const MEDIC_TRAUMA_REVIVE_CAST_REDUCTION_MILLI_PER_STEP: i32 = 100;
const MEDIC_TRAUMA_REVIVE_VITALS_PERCENT_BASE: i32 = 25;
const MEDIC_TRAUMA_REVIVE_VITALS_PERCENT_PER_STEP: i32 = 7;
const MEDIC_TRAUMA_CLONE_SICKNESS_REDUCTION_MILLI_BASE: i32 = 0;
const MEDIC_TRAUMA_CLONE_SICKNESS_REDUCTION_MILLI_PER_STEP: i32 = 80;

/// Boxes owned beyond novice for a track ladder value: 0 (novice only, or no track) …
/// 5 (all four tiers + master). The single conversion from the shared 50/box ladder to
/// the P2 curve domain.
pub(super) fn track_steps_beyond_novice(track_bonus: i32) -> i32 {
    ((track_bonus / GENERIC_TRACK_SKILL_BONUS_PER_BOX) - 1)
        .clamp(0, PROFESSION_TRACK_MAX_STEPS_BEYOND_NOVICE)
}

/// The single monotone evaluator every P2 family uses: `base + per_step * steps`.
/// Monotone in the track bonus by construction (steps is monotone; per_step is fixed).
pub(super) fn profession_stat_curve(track_bonus: i32, base: i32, per_step: i32) -> i32 {
    base.saturating_add(per_step.saturating_mul(track_steps_beyond_novice(track_bonus)))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AuthoritySkillBoxDefinition {
    pub(super) id: String,
    pub(super) profession: AuthorityProfessionKind,
    pub(super) title: Option<String>,
    pub(super) xp_required: u64,
    pub(super) skill_point_cost: u16,
    pub(super) credit_cost: u64,
    pub(super) prerequisites: Vec<String>,
}

pub(super) const BRAWLER_RANGED_BLOCK_SKILL_BOXES: [&str; 4] = [
    "brawler-ranged-block-i",
    "brawler-ranged-block-ii",
    "brawler-ranged-block-iii",
    "brawler-ranged-block-iv",
];
// OWNER TEST TUNING 2026-07-08: one saber-block box grants the full 95% test
// block lane. Revert to progression later as a two-number diff.
pub(super) const BRAWLER_RANGED_BLOCK_CHANCE_MILLI_PER_BOX: u32 = 950;
pub(super) const BRAWLER_RANGED_BLOCK_CHANCE_MILLI_CAP: u32 = 950;

pub(super) fn brawler_ranged_block_chance_milli_from_skill_boxes(
    skill_boxes: &BTreeSet<String>,
) -> u32 {
    BRAWLER_RANGED_BLOCK_SKILL_BOXES
        .iter()
        .filter(|skill_box_id| skill_boxes.contains(**skill_box_id))
        .count()
        .try_into()
        .map(|count: u32| count.saturating_mul(BRAWLER_RANGED_BLOCK_CHANCE_MILLI_PER_BOX))
        .unwrap_or(BRAWLER_RANGED_BLOCK_CHANCE_MILLI_CAP)
        .min(BRAWLER_RANGED_BLOCK_CHANCE_MILLI_CAP)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorProfessionState {
    pub(super) learned: BTreeSet<AuthorityProfessionKind>,
    pub(super) xp: BTreeMap<AuthorityProfessionKind, u64>,
    pub(super) track_xp: BTreeMap<String, u64>,
    pub(super) skill_boxes: BTreeSet<String>,
    pub(super) active_title_id: Option<String>,
    pub(super) credits: u64,
    pub(super) skill_point_cap: u16,
}

impl ActorProfessionState {
    pub(super) fn empty() -> Self {
        Self {
            learned: BTreeSet::new(),
            xp: BTreeMap::new(),
            track_xp: BTreeMap::new(),
            skill_boxes: BTreeSet::new(),
            active_title_id: None,
            credits: DEFAULT_ACTOR_CREDITS,
            skill_point_cap: DEFAULT_SKILL_POINT_CAP,
        }
    }

    pub(super) fn from_profession_ids(profession_ids: &[String]) -> Result<Self, String> {
        let mut state = Self::empty();
        state.grant_ids(profession_ids)?;
        Ok(state)
    }

    fn grant_ids(&mut self, profession_ids: &[String]) -> Result<(), String> {
        for profession_id in profession_ids {
            let trimmed = profession_id.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Some(profession) = AuthorityProfessionKind::from_id(trimmed) else {
                return Err(trimmed.to_owned());
            };
            self.learned.insert(profession);
            let novice_id = format!("{}-novice", profession.id());
            self.skill_boxes.insert(novice_id.clone());
            self.default_active_title_from_profession_grant(&novice_id);
        }
        Ok(())
    }

    pub(super) fn set_credits(&mut self, credits: Option<u64>) {
        if let Some(credits) = credits {
            self.credits = credits;
        }
    }

    /// Add to the scalar credit balance (Credit Chip redemption). Saturating so a
    /// stacked-to-cap chip can never wrap the balance.
    pub(super) fn add_credits(&mut self, amount: u64) -> u64 {
        self.credits = self.credits.saturating_add(amount);
        self.credits
    }

    pub(super) fn grant_skill_box_ids(&mut self, skill_box_ids: &[String]) -> Result<(), String> {
        for skill_box_id in skill_box_ids {
            let trimmed = skill_box_id.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Some(definition) = authority_skill_box_definition(trimmed) else {
                return Err(trimmed.to_owned());
            };
            self.learned.insert(definition.profession);
            self.default_active_title_from_skill_box(&definition.id);
            self.skill_boxes.insert(definition.id);
        }
        Ok(())
    }

    pub(super) fn train_skill_box(&mut self, definition: &AuthoritySkillBoxDefinition) -> bool {
        let learned_before = self.learned.contains(&definition.profession);
        self.learned.insert(definition.profession);
        if !learned_before && definition.id.ends_with("-novice") {
            self.default_active_title_from_profession_grant(&definition.id);
        } else {
            self.default_active_title_from_skill_box(&definition.id);
        }
        self.skill_boxes.insert(definition.id.clone())
    }

    pub(super) fn has(&self, profession: AuthorityProfessionKind) -> bool {
        self.learned.contains(&profession)
    }

    pub(super) fn has_skill_box(&self, skill_box_id: &str) -> bool {
        authority_skill_box_definition(skill_box_id)
            .is_some_and(|definition| self.skill_boxes.contains(&definition.id))
    }

    pub(super) fn active_title(&self) -> Option<AuthorityProfessionTitleSnapshot> {
        let title_id = self.active_title_id.as_deref()?;
        self.title_for_skill_box(title_id)
    }

    pub(super) fn set_active_title_id(
        &mut self,
        title_id: Option<&str>,
    ) -> Result<(), AuthorityTitleError> {
        let Some(title_id) = title_id else {
            self.active_title_id = None;
            return Ok(());
        };
        let normalized = normalize_skill_box_id(title_id);
        if normalized.is_empty() {
            self.active_title_id = None;
            return Ok(());
        }
        if self.title_for_skill_box(&normalized).is_none() {
            return Err(AuthorityTitleError::Unavailable);
        }
        self.active_title_id = Some(normalized);
        Ok(())
    }

    fn default_active_title_from_skill_box(&mut self, skill_box_id: &str) {
        if self.active_title_id.is_some() {
            return;
        }
        let Some(definition) = authority_skill_box_definition(skill_box_id) else {
            return;
        };
        if definition.title.is_some() {
            self.active_title_id = Some(definition.id);
        }
    }

    fn default_active_title_from_profession_grant(&mut self, skill_box_id: &str) {
        let Some(definition) = authority_skill_box_definition(skill_box_id) else {
            return;
        };
        if definition.title.is_none() || !self.should_use_profession_grant_title(&definition) {
            return;
        }
        self.active_title_id = Some(definition.id);
    }

    fn should_use_profession_grant_title(&self, candidate: &AuthoritySkillBoxDefinition) -> bool {
        match self
            .active_title_id
            .as_deref()
            .and_then(authority_skill_box_definition)
        {
            None => true,
            Some(current) => {
                current.profession == AuthorityProfessionKind::Marksman
                    && candidate.profession != AuthorityProfessionKind::Marksman
            }
        }
    }

    fn title_for_skill_box(&self, skill_box_id: &str) -> Option<AuthorityProfessionTitleSnapshot> {
        let definition = authority_skill_box_definition(skill_box_id)?;
        let label = definition.title?;
        if !self.skill_boxes.contains(&definition.id) {
            return None;
        }
        Some(AuthorityProfessionTitleSnapshot {
            id: definition.id.clone(),
            skill_box_id: definition.id,
            label,
        })
    }

    pub(super) fn skill_points_used(&self) -> u16 {
        self.skill_boxes.iter().fold(0_u16, |sum, skill_box_id| {
            sum.saturating_add(
                authority_skill_box_definition(skill_box_id)
                    .map(|definition| definition.skill_point_cost)
                    .unwrap_or(0),
            )
        })
    }

    pub(super) fn skill_points_for_profession(&self, profession: AuthorityProfessionKind) -> u16 {
        self.skill_boxes.iter().fold(0_u16, |sum, skill_box_id| {
            let Some(definition) = authority_skill_box_definition(skill_box_id) else {
                return sum;
            };
            if definition.profession == profession {
                sum.saturating_add(definition.skill_point_cost)
            } else {
                sum
            }
        })
    }

    pub(super) fn skill_boxes_for_profession(
        &self,
        profession: AuthorityProfessionKind,
    ) -> Vec<String> {
        self.skill_boxes
            .iter()
            .filter_map(|skill_box_id| {
                let definition = authority_skill_box_definition(skill_box_id)?;
                (definition.profession == profession).then_some(definition.id)
            })
            .collect()
    }

    pub(super) fn award_xp(&mut self, profession: AuthorityProfessionKind, amount: u64) -> u64 {
        let entry = self.xp.entry(profession).or_insert(0);
        *entry = entry.saturating_add(amount);
        *entry
    }

    pub(super) fn award_track_xp(
        &mut self,
        profession: AuthorityProfessionKind,
        track: &str,
        amount: u64,
    ) -> (u64, u64) {
        let total = self.award_xp(profession, amount);
        let key = authority_profession_track_xp_key(profession, track);
        let track_entry = self.track_xp.entry(key).or_insert(0);
        *track_entry = track_entry.saturating_add(amount);
        (total, *track_entry)
    }

    pub(super) fn award_tracks_xp(
        &mut self,
        profession: AuthorityProfessionKind,
        tracks: &[&str],
        amount: u64,
    ) -> u64 {
        let total = self.award_xp(profession, amount);
        for track in tracks {
            let key = authority_profession_track_xp_key(profession, track);
            let track_entry = self.track_xp.entry(key).or_insert(0);
            *track_entry = track_entry.saturating_add(amount);
        }
        total
    }

    pub(super) fn track_xp_amount(&self, profession: AuthorityProfessionKind, track: &str) -> u64 {
        self.track_xp
            .get(&authority_profession_track_xp_key(profession, track))
            .copied()
            .unwrap_or(0)
    }

    pub(super) fn track_xp_for_profession(
        &self,
        profession: AuthorityProfessionKind,
    ) -> BTreeMap<String, u64> {
        authority_skill_box_tracks(profession)
            .iter()
            .filter_map(|track| {
                let xp = self.track_xp_amount(profession, track);
                (xp > 0).then(|| ((*track).to_owned(), xp))
            })
            .collect()
    }

    pub(super) fn xp_for_skill_box_definition(
        &self,
        definition: &AuthoritySkillBoxDefinition,
    ) -> u64 {
        let profession_xp = self.xp.get(&definition.profession).copied().unwrap_or(0);
        if let Some(track) = authority_skill_box_progress_track(definition) {
            profession_xp.min(self.track_xp_amount(definition.profession, track))
        } else {
            profession_xp
        }
    }

    pub(super) fn spend_xp_for_skill_box_definition(
        &mut self,
        definition: &AuthoritySkillBoxDefinition,
    ) -> Result<(), AuthorityRejectReason> {
        let cost = definition.xp_required;
        if cost == 0 {
            return Ok(());
        }
        let profession_entry = self.xp.entry(definition.profession).or_insert(0);
        if *profession_entry < cost {
            return Err(AuthorityRejectReason::InsufficientProfessionXp);
        }
        if let Some(track) = authority_skill_box_progress_track(definition) {
            let key = authority_profession_track_xp_key(definition.profession, track);
            let track_entry = self.track_xp.entry(key).or_insert(0);
            if *track_entry < cost {
                return Err(AuthorityRejectReason::InsufficientProfessionXp);
            }
            *track_entry = track_entry.saturating_sub(cost);
        }
        *profession_entry = profession_entry.saturating_sub(cost);
        Ok(())
    }

    /// Refund the exact XP cost of a skill box after its ownership has been
    /// removed. Tracked boxes restore both the general profession pool and the
    /// matching track pool; untracked boxes restore only the general pool.
    /// Saturating arithmetic keeps legacy/corrupt near-cap state from wrapping.
    fn refund_xp_for_skill_box_definition(&mut self, definition: &AuthoritySkillBoxDefinition) {
        let cost = definition.xp_required;
        if cost == 0 {
            return;
        }
        let profession_entry = self.xp.entry(definition.profession).or_insert(0);
        *profession_entry = profession_entry.saturating_add(cost);
        if let Some(track) = authority_skill_box_progress_track(definition) {
            let key = authority_profession_track_xp_key(definition.profession, track);
            let track_entry = self.track_xp.entry(key).or_insert(0);
            *track_entry = track_entry.saturating_add(cost);
        }
    }

    pub(super) fn drop_skill_boxes_outside_goal(
        &mut self,
        goal: AuthorityCareerGoalTemplate,
    ) -> Vec<String> {
        let target = goal.target_skill_box_set();
        let remove = self
            .skill_boxes
            .iter()
            .filter(|skill_box_id| !target.contains(*skill_box_id))
            .cloned()
            .collect::<BTreeSet<_>>();
        self.remove_skill_boxes(remove)
    }

    fn remove_skill_boxes(&mut self, mut remove: BTreeSet<String>) -> Vec<String> {
        loop {
            let before = remove.len();
            for learned_skill_box_id in &self.skill_boxes {
                if remove.contains(learned_skill_box_id) {
                    continue;
                }
                let Some(definition) = authority_skill_box_definition(learned_skill_box_id) else {
                    remove.insert(learned_skill_box_id.clone());
                    continue;
                };
                if definition
                    .prerequisites
                    .iter()
                    .any(|prerequisite| remove.contains(prerequisite))
                {
                    remove.insert(definition.id);
                }
            }
            if remove.len() == before {
                break;
            }
        }
        let removed = remove.into_iter().collect::<Vec<_>>();
        for skill_box_id in &removed {
            if self.skill_boxes.remove(skill_box_id) {
                if let Some(definition) = authority_skill_box_definition(skill_box_id) {
                    self.refund_xp_for_skill_box_definition(&definition);
                }
            }
        }
        self.rebuild_profession_membership_from_skill_boxes();
        removed
    }

    pub(super) fn unlearn_skill_box(
        &mut self,
        skill_box_id: &str,
    ) -> Result<(), AuthorityRejectReason> {
        if !self.skill_boxes.contains(skill_box_id) {
            return Err(AuthorityRejectReason::SkillNotLearned);
        }
        if self.skill_boxes.iter().any(|learned_skill_box_id| {
            learned_skill_box_id != skill_box_id
                && authority_skill_box_definition(learned_skill_box_id).is_some_and(|definition| {
                    definition
                        .prerequisites
                        .iter()
                        .any(|prerequisite| prerequisite == skill_box_id)
                })
        }) {
            return Err(AuthorityRejectReason::SkillRequiredByLearnedBox);
        }
        let removed = self.skill_boxes.remove(skill_box_id);
        if !removed {
            return Err(AuthorityRejectReason::SkillNotLearned);
        }
        if let Some(definition) = authority_skill_box_definition(skill_box_id) {
            self.refund_xp_for_skill_box_definition(&definition);
        }
        self.rebuild_profession_membership_from_skill_boxes();
        Ok(())
    }

    fn rebuild_profession_membership_from_skill_boxes(&mut self) {
        self.learned.clear();
        for skill_box_id in &self.skill_boxes {
            if let Some(definition) = authority_skill_box_definition(skill_box_id) {
                self.learned.insert(definition.profession);
            }
        }
        if self
            .active_title_id
            .as_deref()
            .is_some_and(|title_id| self.title_for_skill_box(title_id).is_some())
        {
            return;
        }
        self.active_title_id = self.skill_boxes.iter().find_map(|skill_box_id| {
            authority_skill_box_definition(skill_box_id)
                .filter(|definition| definition.title.is_some())
                .map(|definition| definition.id)
        });
    }

    pub(super) fn medicine_use_bonus(&self) -> i32 {
        self.medicine_track_multiplier_milli("medicine-use")
            .saturating_sub(1_000)
    }

    pub(super) fn medicine_use_speed_milli(&self) -> i32 {
        self.medicine_track_multiplier_milli("medicine-speed")
    }

    pub(super) fn medical_crafting_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Medic, "medical-crafting")
    }

    pub(super) fn medical_experimentation_bonus(&self) -> i32 {
        self.medical_crafting_bonus()
    }

    pub(super) fn medical_experimentation_points(&self) -> u8 {
        u8::try_from(
            (self.medical_experimentation_bonus() / MEDICAL_EXPERIMENTATION_POINTS_PER_BONUS)
                .max(0),
        )
        .unwrap_or(u8::MAX)
    }

    pub(super) fn craftsman_assembly_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "assembly")
    }

    pub(super) fn craftsman_experimentation_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "experimentation")
    }

    pub(super) fn craftsman_experimentation_points(&self) -> u8 {
        u8::try_from(
            (self.craftsman_experimentation_bonus() / MEDICAL_EXPERIMENTATION_POINTS_PER_BONUS)
                .max(0),
        )
        .unwrap_or(u8::MAX)
    }

    // ---- W6 profession-generic craft dispatch (MEDIC WAVE) ----
    // A W6 recipe declares its crafting profession; assembly/experimentation
    // then read that profession's track so a MEDIC crafts medicine off the medic
    // curve (P12-fixed `medical_crafting_bonus`) and a CRAFTSMAN crafts gear off
    // the craftsman curve — one dispatch, no bespoke per-recipe code.
    pub(super) fn craft_assembly_bonus(&self, profession: AuthorityProfessionKind) -> i32 {
        match profession {
            AuthorityProfessionKind::Medic => self.medical_crafting_bonus(),
            _ => self.craftsman_assembly_bonus(),
        }
    }

    pub(super) fn craft_experimentation_bonus(&self, profession: AuthorityProfessionKind) -> i32 {
        match profession {
            AuthorityProfessionKind::Medic => self.medical_experimentation_bonus(),
            _ => self.craftsman_experimentation_bonus(),
        }
    }

    pub(super) fn craft_experimentation_points(&self, profession: AuthorityProfessionKind) -> u8 {
        match profession {
            AuthorityProfessionKind::Medic => self.medical_experimentation_points(),
            _ => self.craftsman_experimentation_points(),
        }
    }

    // ---- Bio-Engineer track readers (bioengineer-design.md §1.3, §3.4). ----
    /// Splicing track box-depth 0..=5 (novice=0, splicing-i..iv=1..4, master=5).
    /// Drives gain-per-point and base experimentation points.
    pub(super) fn bioengineer_splicing_tier(&self) -> u8 {
        self.bioengineer_track_tier("splicing")
    }

    /// Sequencing track box-depth 0..=5. Drives the genome-scanner reveal tier
    /// and wild-flora sample yield.
    pub(super) fn bioengineer_sequencing_tier(&self) -> u8 {
        self.bioengineer_track_tier("sequencing")
    }

    fn bioengineer_track_tier(&self, track: &str) -> u8 {
        let bonus = self.profession_track_skill_bonus(AuthorityProfessionKind::BioEngineer, track);
        // profession_track_skill_bonus = 50 * (novice + track_boxes + master); the
        // novice base contributes the leading +1, so subtract it for the depth.
        u8::try_from((bonus / GENERIC_TRACK_SKILL_BONUS_PER_BOX - 1).max(0))
            .unwrap_or(0)
            .min(5)
    }

    /// Splicing skill bonus feeding deterministic assembly quality (0 at novice,
    /// ~300 at master). bioengineer-design.md §3.4 step 2.
    pub(super) fn bioengineer_splice_skill_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::BioEngineer, "splicing")
    }

    pub(super) fn bioengineer_is_master(&self) -> bool {
        self.skill_boxes.contains("bioengineer-master")
    }

    pub(super) fn scout_traversal_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "traversal")
    }

    pub(super) fn scout_sprinting_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "sprinting")
    }

    pub(super) fn scout_creature_harvesting_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "creature-harvesting")
    }

    pub(super) fn marksman_rifle_spread_reduction_milli(&self) -> i32 {
        match self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "rifle") {
            bonus if bonus >= GENERIC_TRACK_SKILL_BONUS_PER_BOX * 6 => {
                MARKSMAN_MASTER_RIFLE_SPREAD_REDUCTION_MILLI
            }
            bonus if bonus >= GENERIC_TRACK_SKILL_BONUS_PER_BOX * 5 => {
                MARKSMAN_RIFLE_IV_SPREAD_REDUCTION_MILLI
            }
            bonus if bonus >= GENERIC_TRACK_SKILL_BONUS_PER_BOX * 4 => {
                MARKSMAN_RIFLE_III_SPREAD_REDUCTION_MILLI
            }
            bonus if bonus >= GENERIC_TRACK_SKILL_BONUS_PER_BOX * 3 => {
                MARKSMAN_RIFLE_II_SPREAD_REDUCTION_MILLI
            }
            bonus if bonus >= GENERIC_TRACK_SKILL_BONUS_PER_BOX * 2 => {
                MARKSMAN_RIFLE_I_SPREAD_REDUCTION_MILLI
            }
            _ => 0,
        }
    }

    pub(super) fn brawler_movement_speed_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "movement-speed")
    }

    pub(super) fn brawler_attack_speed_bonus(&self) -> i32 {
        self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "attack-speed")
    }

    pub(super) fn brawler_melee_speed_points(&self) -> i32 {
        let speed_box_count = self
            .brawler_attack_speed_bonus()
            .saturating_sub(GENERIC_TRACK_SKILL_BONUS_PER_BOX)
            / GENERIC_TRACK_SKILL_BONUS_PER_BOX;
        BRAWLER_NOVICE_MELEE_SPEED_POINTS
            .saturating_add(speed_box_count.saturating_mul(BRAWLER_MELEE_SPEED_POINTS_PER_BOX))
            .clamp(0, BRAWLER_MELEE_SPEED_POINTS_CAP)
    }

    pub(super) fn brawler_ranged_block_chance_milli(&self) -> u32 {
        // Production: the guard track (THE WALL), 190‰/box × 5 → 950 cap. Debug: the
        // one-box-full 95% saber-block TEST line, reachable only via DebugGrantSkillBoxes
        // (GAME_DEBUG_AUTHORITY_COMMANDS). Strongest of the two wins.
        let guard = u32::try_from(self.brawler_guard_ranged_block_permille().max(0))
            .unwrap_or(0)
            .min(BRAWLER_RANGED_BLOCK_CHANCE_MILLI_CAP);
        let debug_line = brawler_ranged_block_chance_milli_from_skill_boxes(&self.skill_boxes);
        guard.max(debug_line)
    }

    // Table-driven profession-track mappings. Each reads the shared
    // `profession_track_skill_bonus` ladder and evaluates one monotone curve.

    /// True when this actor holds `<profession>-master` (capstone auras key off this).
    pub(super) fn is_master(&self, profession: AuthorityProfessionKind) -> bool {
        self.skill_boxes
            .contains(&format!("{}-master", profession.id()))
    }

    // Marksman · pistol (sidearm) — tuning surface; consumption awaits a pistol weapon
    // class + weapon-swap cooldown (content wave).
    #[allow(dead_code)] // tuning surface; awaits its content-wave consumption hook
    pub(super) fn marksman_pistol_spread_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "pistol"),
            MARKSMAN_PISTOL_SPREAD_REDUCTION_MILLI_BASE,
            MARKSMAN_PISTOL_SPREAD_REDUCTION_MILLI_PER_STEP,
        )
    }

    #[allow(dead_code)] // tuning surface; awaits its content-wave consumption hook
    pub(super) fn marksman_pistol_swap_speed_multiplier_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "pistol"),
            MARKSMAN_PISTOL_SWAP_SPEED_MULTIPLIER_MILLI_BASE,
            MARKSMAN_PISTOL_SWAP_SPEED_MULTIPLIER_MILLI_PER_STEP,
        )
    }

    // Marksman · tactics — re-target latency is a content-wave hook; the special-action
    // (aimed shot) cost reduction is consumed in combat_roll.
    #[allow(dead_code)] // tuning surface; awaits its content-wave consumption hook
    pub(super) fn marksman_tactics_requeue_latency_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "tactics"),
            MARKSMAN_TACTICS_REQUEUE_LATENCY_REDUCTION_MILLI_BASE,
            MARKSMAN_TACTICS_REQUEUE_LATENCY_REDUCTION_MILLI_PER_STEP,
        )
    }

    pub(super) fn marksman_tactics_special_action_cost_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "tactics"),
            MARKSMAN_TACTICS_SPECIAL_ACTION_COST_REDUCTION_MILLI_BASE,
            MARKSMAN_TACTICS_SPECIAL_ACTION_COST_REDUCTION_MILLI_PER_STEP,
        )
    }

    // Marksman · fieldcraft — kneeling cover discipline.
    pub(super) fn marksman_fieldcraft_kneel_spread_mult_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "fieldcraft"),
            MARKSMAN_FIELDCRAFT_KNEEL_SPREAD_MULT_MILLI_BASE,
            MARKSMAN_FIELDCRAFT_KNEEL_SPREAD_MULT_MILLI_PER_STEP,
        )
    }

    pub(super) fn marksman_fieldcraft_kneel_damage_taken_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Marksman, "fieldcraft"),
            MARKSMAN_FIELDCRAFT_KNEEL_DAMAGE_TAKEN_REDUCTION_MILLI_BASE,
            MARKSMAN_FIELDCRAFT_KNEEL_DAMAGE_TAKEN_REDUCTION_MILLI_PER_STEP,
        )
    }

    // Brawler · melee — damage bonus + variance floor.
    pub(super) fn brawler_melee_damage_bonus_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "melee"),
            BRAWLER_MELEE_DAMAGE_BONUS_MILLI_BASE,
            BRAWLER_MELEE_DAMAGE_BONUS_MILLI_PER_STEP,
        )
    }

    pub(super) fn brawler_melee_variance_floor_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "melee"),
            BRAWLER_MELEE_VARIANCE_FLOOR_MILLI_BASE,
            BRAWLER_MELEE_VARIANCE_FLOOR_MILLI_PER_STEP,
        )
        .clamp(0, 1_000)
    }

    // Brawler · guard — THE WALL: parry, ranged deflection (production), braced.
    pub(super) fn brawler_guard_parry_block_permille(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "guard"),
            BRAWLER_GUARD_PARRY_BLOCK_PERMILLE_BASE,
            BRAWLER_GUARD_PARRY_BLOCK_PERMILLE_PER_STEP,
        )
    }

    pub(super) fn brawler_guard_ranged_block_permille(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "guard"),
            BRAWLER_GUARD_RANGED_BLOCK_PERMILLE_BASE,
            BRAWLER_GUARD_RANGED_BLOCK_PERMILLE_PER_STEP,
        )
        .clamp(0, BRAWLER_RANGED_BLOCK_CHANCE_MILLI_CAP as i32)
    }

    pub(super) fn brawler_guard_braced_damage_taken_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Brawler, "guard"),
            BRAWLER_GUARD_BRACED_DAMAGE_TAKEN_REDUCTION_MILLI_BASE,
            BRAWLER_GUARD_BRACED_DAMAGE_TAKEN_REDUCTION_MILLI_PER_STEP,
        )
    }

    // Scout · campcraft — grace, shelter radius, Field Rest.
    pub(super) fn scout_campcraft_grace_bonus_seconds(&self) -> u64 {
        let steps = track_steps_beyond_novice(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "campcraft"),
        );
        SCOUT_CAMPCRAFT_GRACE_BONUS_SECONDS_BASE.saturating_add(
            SCOUT_CAMPCRAFT_GRACE_BONUS_SECONDS_PER_STEP
                .saturating_mul(u64::try_from(steps).unwrap_or(0)),
        )
    }

    pub(super) fn scout_campcraft_shelter_radius_bonus_cells(&self) -> i32 {
        // Rounded ramp 0 → MAX over the five steps: [0,1,1,2,2,3] for MAX = 3.
        let steps = track_steps_beyond_novice(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "campcraft"),
        );
        (SCOUT_CAMPCRAFT_SHELTER_RADIUS_BONUS_CELLS_MAX.saturating_mul(steps)
            + PROFESSION_TRACK_MAX_STEPS_BEYOND_NOVICE / 2)
            / PROFESSION_TRACK_MAX_STEPS_BEYOND_NOVICE
    }

    pub(super) fn scout_campcraft_field_rest_mult_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Scout, "campcraft"),
            SCOUT_CAMPCRAFT_FIELD_REST_MULT_MILLI_BASE,
            SCOUT_CAMPCRAFT_FIELD_REST_MULT_MILLI_PER_STEP,
        )
    }

    // Craftsman · survey — range + Heat Reading resolution.
    pub(super) fn craftsman_survey_range_cells(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "survey"),
            CRAFTSMAN_SURVEY_RANGE_CELLS_BASE,
            CRAFTSMAN_SURVEY_RANGE_CELLS_PER_STEP,
        )
    }

    pub(super) fn craftsman_survey_grid_step_cells(&self) -> i32 {
        match track_steps_beyond_novice(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "survey"),
        ) {
            0 | 1 => CRAFTSMAN_SURVEY_GRID_STEP_CELLS_COARSE, // novice, survey-I
            2..=4 => CRAFTSMAN_SURVEY_GRID_STEP_CELLS_MID,    // survey-II..IV
            _ => CRAFTSMAN_SURVEY_GRID_STEP_CELLS_FINE,       // master
        }
    }

    // Craftsman · tools — crafted-tool quality floor + starter-grant quality.
    pub(super) fn craftsman_tools_quality_floor_bonus_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "tools"),
            CRAFTSMAN_TOOLS_QUALITY_FLOOR_BONUS_MILLI_BASE,
            CRAFTSMAN_TOOLS_QUALITY_FLOOR_BONUS_MILLI_PER_STEP,
        )
    }

    pub(super) fn craftsman_tools_starter_grant_quality_milli(&self) -> u32 {
        let steps = track_steps_beyond_novice(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Craftsman, "tools"),
        )
        .min(CRAFTSMAN_TOOLS_STARTER_GRANT_FULL_AT_STEPS);
        let span = CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_MAX
            .saturating_sub(CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_BASE);
        let bonus = (span.saturating_mul(steps) + CRAFTSMAN_TOOLS_STARTER_GRANT_FULL_AT_STEPS / 2)
            / CRAFTSMAN_TOOLS_STARTER_GRANT_FULL_AT_STEPS.max(1);
        u32::try_from(CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_BASE.saturating_add(bonus))
            .unwrap_or(u32::try_from(CRAFTSMAN_TOOLS_STARTER_GRANT_QUALITY_MILLI_BASE).unwrap_or(0))
    }

    // Medic · trauma — revive cast, revived vitals, clone-sickness.
    pub(super) fn medic_trauma_revive_cast_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Medic, "trauma"),
            MEDIC_TRAUMA_REVIVE_CAST_REDUCTION_MILLI_BASE,
            MEDIC_TRAUMA_REVIVE_CAST_REDUCTION_MILLI_PER_STEP,
        )
    }

    pub(super) fn medic_trauma_revive_vitals_percent(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Medic, "trauma"),
            MEDIC_TRAUMA_REVIVE_VITALS_PERCENT_BASE,
            MEDIC_TRAUMA_REVIVE_VITALS_PERCENT_PER_STEP,
        )
        .clamp(0, 100)
    }

    pub(super) fn medic_trauma_clone_sickness_reduction_milli(&self) -> i32 {
        profession_stat_curve(
            self.profession_track_skill_bonus(AuthorityProfessionKind::Medic, "trauma"),
            MEDIC_TRAUMA_CLONE_SICKNESS_REDUCTION_MILLI_BASE,
            MEDIC_TRAUMA_CLONE_SICKNESS_REDUCTION_MILLI_PER_STEP,
        )
    }

    fn profession_track_skill_bonus(
        &self,
        profession: AuthorityProfessionKind,
        track: &str,
    ) -> i32 {
        let novice_id = format!("{}-novice", profession.id());
        if !self.skill_boxes.contains(&novice_id) {
            return 0;
        }
        let mut bonus = GENERIC_TRACK_SKILL_BONUS_PER_BOX;
        for tier in ["i", "ii", "iii", "iv"] {
            if self
                .skill_boxes
                .contains(&format!("{}-{track}-{tier}", profession.id()))
            {
                bonus += GENERIC_TRACK_SKILL_BONUS_PER_BOX;
            }
        }
        if self
            .skill_boxes
            .contains(&format!("{}-master", profession.id()))
        {
            bonus += GENERIC_TRACK_SKILL_BONUS_PER_BOX;
        }
        bonus
    }

    fn medicine_track_multiplier_milli(&self, track: &str) -> i32 {
        let novice_id = format!("{}-novice", AuthorityProfessionKind::Medic.id());
        if !self.skill_boxes.contains(&novice_id) {
            return 0;
        }
        let mut multiplier: i32 = 1_000;
        for tier in ["i", "ii", "iii", "iv"] {
            if self.skill_boxes.contains(&format!("medic-{track}-{tier}")) {
                multiplier = multiplier.saturating_add(MEDICINE_USE_TRACK_BONUS_MILLI_PER_BOX);
            }
        }
        if self.skill_boxes.contains("medic-master") {
            multiplier = multiplier.saturating_add(MEDICINE_USE_MASTER_EXTRA_BONUS_MILLI);
        }
        multiplier
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AuthorityTitleError {
    Unavailable,
}

pub(super) fn authority_skill_box_definition(
    skill_box_id: &str,
) -> Option<AuthoritySkillBoxDefinition> {
    let id = normalize_skill_box_id(skill_box_id);
    let (profession, suffix) = skill_box_profession_suffix(&id)?;
    if suffix == "novice" {
        // Bio-Engineer is a hybrid elite: its novice box is gated on boxes from
        // BOTH parent professions (bioengineer-design.md §1.2). Every other novice
        // is a free profession entry (empty prerequisites).
        let prerequisites = if profession == AuthorityProfessionKind::BioEngineer {
            vec![
                "craftsman-experimentation-ii".to_owned(),
                "medic-medical-crafting-ii".to_owned(),
            ]
        } else if profession == AuthorityProfessionKind::Commando {
            // Commando is a hybrid elite: elite guns demand marksman rifle mastery
            // AND brawler melee mastery (both parents deep).
            vec![
                "marksman-rifle-iv".to_owned(),
                "brawler-melee-iv".to_owned(),
            ]
        } else {
            Vec::new()
        };
        return Some(AuthoritySkillBoxDefinition {
            id,
            profession,
            title: Some(format!("Novice {}", profession.label())),
            xp_required: 0,
            skill_point_cost: SKILL_POINT_COST_NOVICE,
            credit_cost: 0,
            prerequisites,
        });
    }
    if suffix == "master" {
        return Some(AuthoritySkillBoxDefinition {
            id,
            profession,
            title: Some(format!("Master {}", profession.label())),
            xp_required: 1_800,
            skill_point_cost: SKILL_POINT_COST_MASTER,
            credit_cost: 0,
            prerequisites: authority_skill_box_tracks(profession)
                .iter()
                .map(|track| format!("{}-{track}-iv", profession.id()))
                .collect(),
        });
    }
    let (track, tier) = suffix.rsplit_once('-')?;
    let brawler_ranged_block_track =
        profession == AuthorityProfessionKind::Brawler && track == "ranged-block";
    if !brawler_ranged_block_track && !authority_skill_box_tracks(profession).contains(&track) {
        return None;
    }
    let (rank, xp_required, skill_point_cost, credit_cost) =
        authority_skill_box_tier_requirements(tier)?;
    let prerequisites = if rank == 1 {
        vec![format!("{}-novice", profession.id())]
    } else {
        vec![format!(
            "{}-{track}-{}",
            profession.id(),
            authority_skill_box_tier_slug(rank.saturating_sub(1))?
        )]
    };
    Some(AuthoritySkillBoxDefinition {
        id,
        profession,
        title: None,
        xp_required,
        skill_point_cost,
        credit_cost,
        prerequisites,
    })
}

fn normalize_skill_box_id(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn skill_box_profession_suffix(id: &str) -> Option<(AuthorityProfessionKind, &str)> {
    for profession in AuthorityProfessionKind::all() {
        let prefix = format!("{}-", profession.id());
        if let Some(suffix) = id.strip_prefix(&prefix) {
            return Some((profession, suffix));
        }
    }
    None
}

fn authority_skill_box_tracks(profession: AuthorityProfessionKind) -> &'static [&'static str] {
    match profession {
        AuthorityProfessionKind::Marksman => &["rifle", "pistol", "tactics", "fieldcraft"],
        AuthorityProfessionKind::Scout => {
            &["traversal", "sprinting", "creature-harvesting", "campcraft"]
        }
        AuthorityProfessionKind::Craftsman => &["survey", "tools", "assembly", "experimentation"],
        AuthorityProfessionKind::Medic => &[
            "medicine-use",
            "trauma",
            "medicine-speed",
            "medical-crafting",
        ],
        AuthorityProfessionKind::Brawler => &["melee", "guard", "movement-speed", "attack-speed"],
        // Bio-Engineer 4 tracks (bioengineer-design.md §1.3), 8/6/4/2 curve.
        AuthorityProfessionKind::BioEngineer => {
            &["sequencing", "splicing", "cultivation", "genelock"]
        }
        // Commando 4 tracks: heavy-weapons (elite gun handling), demolitions
        // (launchers/splash), suppression, field-hardening. 8/6/4/2 curve.
        AuthorityProfessionKind::Commando => &[
            "heavy-weapons",
            "demolitions",
            "suppression",
            "field-hardening",
        ],
    }
}

fn authority_skill_box_tier_requirements(tier: &str) -> Option<(u8, u64, u16, u64)> {
    match tier {
        "i" => Some((1, 100, SKILL_POINT_COST_TIER_I, 0)),
        "ii" => Some((2, 300, SKILL_POINT_COST_TIER_II, 0)),
        "iii" => Some((3, 650, SKILL_POINT_COST_TIER_III, 0)),
        "iv" => Some((4, 1_100, SKILL_POINT_COST_TIER_IV, 0)),
        _ => None,
    }
}

pub(super) fn authority_skill_box_progress_track(
    definition: &AuthoritySkillBoxDefinition,
) -> Option<&str> {
    let (_, suffix) = skill_box_profession_suffix(&definition.id)?;
    if suffix == "novice" || suffix == "master" {
        return None;
    }
    suffix.rsplit_once('-').map(|(track, _)| track)
}

fn authority_profession_track_xp_key(profession: AuthorityProfessionKind, track: &str) -> String {
    format!("{}:{}", profession.id(), normalize_command_key(track))
}

fn authority_skill_box_tier_slug(rank: u8) -> Option<&'static str> {
    match rank {
        1 => Some("i"),
        2 => Some("ii"),
        3 => Some("iii"),
        4 => Some("iv"),
        _ => None,
    }
}

const CAREER_GOAL_RIFLE_UTILITY: &str = "rifle_utility";
const CAREER_GOAL_RANGED_SPECIALIST: &str = "ranged_specialist";
const CAREER_GOAL_MELEE_SPECIALIST: &str = "melee_specialist";
const CAREER_GOAL_RIFLE_QUARTERMASTER: &str = "rifle_quartermaster";

const FULL_MARKSMAN_SKILL_BOXES: &[&str] = &[
    "marksman-novice",
    "marksman-rifle-i",
    "marksman-rifle-ii",
    "marksman-rifle-iii",
    "marksman-rifle-iv",
    "marksman-pistol-i",
    "marksman-pistol-ii",
    "marksman-pistol-iii",
    "marksman-pistol-iv",
    "marksman-tactics-i",
    "marksman-tactics-ii",
    "marksman-tactics-iii",
    "marksman-tactics-iv",
    "marksman-fieldcraft-i",
    "marksman-fieldcraft-ii",
    "marksman-fieldcraft-iii",
    "marksman-fieldcraft-iv",
    "marksman-master",
];

const FULL_BRAWLER_SKILL_BOXES: &[&str] = &[
    "brawler-novice",
    "brawler-melee-i",
    "brawler-melee-ii",
    "brawler-melee-iii",
    "brawler-melee-iv",
    "brawler-guard-i",
    "brawler-guard-ii",
    "brawler-guard-iii",
    "brawler-guard-iv",
    "brawler-movement-speed-i",
    "brawler-movement-speed-ii",
    "brawler-movement-speed-iii",
    "brawler-movement-speed-iv",
    "brawler-attack-speed-i",
    "brawler-attack-speed-ii",
    "brawler-attack-speed-iii",
    "brawler-attack-speed-iv",
    "brawler-master",
];

const FULL_SCOUT_SKILL_BOXES: &[&str] = &[
    "scout-novice",
    "scout-creature-harvesting-i",
    "scout-creature-harvesting-ii",
    "scout-creature-harvesting-iii",
    "scout-creature-harvesting-iv",
    "scout-sprinting-i",
    "scout-sprinting-ii",
    "scout-sprinting-iii",
    "scout-sprinting-iv",
    "scout-traversal-i",
    "scout-traversal-ii",
    "scout-traversal-iii",
    "scout-traversal-iv",
    "scout-campcraft-i",
    "scout-campcraft-ii",
    "scout-campcraft-iii",
    "scout-campcraft-iv",
    "scout-master",
];

const FULL_CRAFTSMAN_SKILL_BOXES: &[&str] = &[
    "craftsman-novice",
    "craftsman-survey-i",
    "craftsman-survey-ii",
    "craftsman-survey-iii",
    "craftsman-survey-iv",
    "craftsman-tools-i",
    "craftsman-tools-ii",
    "craftsman-tools-iii",
    "craftsman-tools-iv",
    "craftsman-experimentation-i",
    "craftsman-experimentation-ii",
    "craftsman-experimentation-iii",
    "craftsman-experimentation-iv",
    "craftsman-assembly-i",
    "craftsman-assembly-ii",
    "craftsman-assembly-iii",
    "craftsman-assembly-iv",
    "craftsman-master",
];

const FULL_MEDIC_SKILL_BOXES: &[&str] = &[
    "medic-novice",
    "medic-trauma-i",
    "medic-trauma-ii",
    "medic-trauma-iii",
    "medic-trauma-iv",
    "medic-medicine-use-i",
    "medic-medicine-use-ii",
    "medic-medicine-use-iii",
    "medic-medicine-use-iv",
    "medic-medicine-speed-i",
    "medic-medicine-speed-ii",
    "medic-medicine-speed-iii",
    "medic-medicine-speed-iv",
    "medic-medical-crafting-i",
    "medic-medical-crafting-ii",
    "medic-medical-crafting-iii",
    "medic-medical-crafting-iv",
    "medic-master",
];

const MARKSMAN_RIFLE_PACKAGE_SKILL_BOXES: &[&str] = &[
    "marksman-novice",
    "marksman-rifle-i",
    "marksman-rifle-ii",
    "marksman-rifle-iii",
    "marksman-rifle-iv",
];

const MARKSMAN_FIELDCRAFT_PACKAGE_SKILL_BOXES: &[&str] = &[
    "marksman-fieldcraft-i",
    "marksman-fieldcraft-ii",
    "marksman-fieldcraft-iii",
    "marksman-fieldcraft-iv",
];

const MEDIC_USE_SPEED_PACKAGE_SKILL_BOXES: &[&str] = &[
    "medic-novice",
    "medic-medicine-use-i",
    "medic-medicine-use-ii",
    "medic-medicine-use-iii",
    "medic-medicine-use-iv",
    "medic-medicine-speed-i",
    "medic-medicine-speed-ii",
    "medic-medicine-speed-iii",
    "medic-medicine-speed-iv",
];

const SCOUT_MOBILITY_PACKAGE_SKILL_BOXES: &[&str] = &[
    "scout-novice",
    "scout-traversal-i",
    "scout-traversal-ii",
    "scout-traversal-iii",
    "scout-traversal-iv",
    "scout-sprinting-i",
    "scout-sprinting-ii",
    "scout-sprinting-iii",
    "scout-sprinting-iv",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AuthorityCareerGoalTemplate {
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) skill_box_groups: &'static [&'static [&'static str]],
    pub(super) primary_weapon_id: AuthorityWeaponId,
}

impl AuthorityCareerGoalTemplate {
    pub(super) fn target_skill_boxes(self) -> Vec<&'static str> {
        let mut skill_boxes = Vec::new();
        for group in self.skill_box_groups {
            for skill_box_id in *group {
                if !skill_boxes.contains(skill_box_id) {
                    skill_boxes.push(*skill_box_id);
                }
            }
        }
        skill_boxes
    }

    pub(super) fn target_skill_box_set(self) -> BTreeSet<String> {
        self.target_skill_boxes()
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    pub(super) fn target_skill_points(self) -> u16 {
        self.target_skill_boxes()
            .into_iter()
            .fold(0_u16, |sum, skill_box_id| {
                sum.saturating_add(
                    authority_skill_box_definition(skill_box_id)
                        .map(|definition| definition.skill_point_cost)
                        .unwrap_or(0),
                )
            })
    }
}

const RIFLE_UTILITY_GROUPS: &[&[&str]] = &[
    MARKSMAN_RIFLE_PACKAGE_SKILL_BOXES,
    FULL_MEDIC_SKILL_BOXES,
    FULL_SCOUT_SKILL_BOXES,
    MARKSMAN_FIELDCRAFT_PACKAGE_SKILL_BOXES,
];
const RANGED_SPECIALIST_GROUPS: &[&[&str]] = &[
    FULL_MARKSMAN_SKILL_BOXES,
    FULL_SCOUT_SKILL_BOXES,
    MEDIC_USE_SPEED_PACKAGE_SKILL_BOXES,
];
const MELEE_SPECIALIST_GROUPS: &[&[&str]] = &[
    FULL_BRAWLER_SKILL_BOXES,
    SCOUT_MOBILITY_PACKAGE_SKILL_BOXES,
    FULL_MEDIC_SKILL_BOXES,
];
const RIFLE_QUARTERMASTER_GROUPS: &[&[&str]] = &[
    FULL_CRAFTSMAN_SKILL_BOXES,
    FULL_MEDIC_SKILL_BOXES,
    MARKSMAN_RIFLE_PACKAGE_SKILL_BOXES,
    MARKSMAN_FIELDCRAFT_PACKAGE_SKILL_BOXES,
];

pub(super) fn parse_authority_career_goal_id(
    value: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let normalized = normalize_command_key(value);
    if normalized.is_empty() {
        return Ok(None);
    }
    authority_career_goal_template(&normalized)
        .map(|template| Some(template.id.to_owned()))
        .ok_or(normalized)
}

pub(super) fn authority_career_goal_template(goal_id: &str) -> Option<AuthorityCareerGoalTemplate> {
    match normalize_command_key(goal_id).as_str() {
        CAREER_GOAL_RIFLE_UTILITY => Some(AuthorityCareerGoalTemplate {
            id: CAREER_GOAL_RIFLE_UTILITY,
            label: "Rifle Utility",
            skill_box_groups: RIFLE_UTILITY_GROUPS,
            primary_weapon_id: AuthorityWeaponId::Slugthrower,
        }),
        CAREER_GOAL_RANGED_SPECIALIST => Some(AuthorityCareerGoalTemplate {
            id: CAREER_GOAL_RANGED_SPECIALIST,
            label: "Ranged Specialist",
            skill_box_groups: RANGED_SPECIALIST_GROUPS,
            primary_weapon_id: AuthorityWeaponId::Slugthrower,
        }),
        CAREER_GOAL_MELEE_SPECIALIST => Some(AuthorityCareerGoalTemplate {
            id: CAREER_GOAL_MELEE_SPECIALIST,
            label: "Melee Specialist",
            skill_box_groups: MELEE_SPECIALIST_GROUPS,
            primary_weapon_id: AuthorityWeaponId::Vibrosword,
        }),
        CAREER_GOAL_RIFLE_QUARTERMASTER => Some(AuthorityCareerGoalTemplate {
            id: CAREER_GOAL_RIFLE_QUARTERMASTER,
            label: "Rifle Quartermaster",
            skill_box_groups: RIFLE_QUARTERMASTER_GROUPS,
            primary_weapon_id: AuthorityWeaponId::Slugthrower,
        }),
        _ => None,
    }
}

pub(super) fn career_goal_template_for_actor(
    actor: &ActorAuthorityState,
) -> Option<AuthorityCareerGoalTemplate> {
    if let Some(goal_id) = actor.career_goal_id.as_deref() {
        return authority_career_goal_template(goal_id);
    }
    let template_key = actor
        .template_id
        .as_deref()
        .map(normalize_command_key)
        .unwrap_or_default();
    let group_key = actor
        .faction
        .social_group
        .as_deref()
        .map(normalize_command_key)
        .unwrap_or_default();
    if template_key.contains("brawler") || group_key.contains("brawler") {
        return authority_career_goal_template(CAREER_GOAL_MELEE_SPECIALIST);
    }
    if template_key.contains("craftsman") || group_key.contains("craftsman") {
        return authority_career_goal_template(CAREER_GOAL_RIFLE_QUARTERMASTER);
    }
    if template_key.contains("medic") || group_key.contains("medic") {
        return authority_career_goal_template(CAREER_GOAL_RIFLE_UTILITY);
    }
    if template_key.contains("scout") || group_key.contains("scout") {
        return authority_career_goal_template(CAREER_GOAL_RANGED_SPECIALIST);
    }
    if template_key.contains("marksman") || group_key.contains("guard") {
        return authority_career_goal_template(CAREER_GOAL_RANGED_SPECIALIST);
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCareerGoalSnapshot {
    pub id: String,
    pub label: String,
    pub target_skill_points: u16,
    pub owned_target_skill_boxes: u16,
    pub target_skill_boxes: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_skill_boxes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_skill_box_id: Option<String>,
    pub primary_weapon_id: String,
}

impl AuthorityCareerGoalSnapshot {
    pub(super) fn from_actor(actor: &ActorAuthorityState) -> Option<Self> {
        let goal = career_goal_template_for_actor(actor)?;
        let target_skill_boxes = goal.target_skill_boxes();
        let target_set = target_skill_boxes
            .iter()
            .map(|skill_box_id| (*skill_box_id).to_owned())
            .collect::<BTreeSet<_>>();
        let owned_target_skill_boxes = target_skill_boxes
            .iter()
            .filter(|skill_box_id| actor.professions.has_skill_box(skill_box_id))
            .count();
        let extra_skill_boxes = actor
            .professions
            .skill_boxes
            .iter()
            .filter(|skill_box_id| !target_set.contains(*skill_box_id))
            .cloned()
            .collect();
        let next_skill_box_id = target_skill_boxes
            .iter()
            .find(|skill_box_id| !actor.professions.has_skill_box(skill_box_id))
            .map(|skill_box_id| (*skill_box_id).to_owned());
        Some(Self {
            id: goal.id.to_owned(),
            label: goal.label.to_owned(),
            target_skill_points: goal.target_skill_points(),
            owned_target_skill_boxes: u16::try_from(owned_target_skill_boxes).unwrap_or(u16::MAX),
            target_skill_boxes: u16::try_from(target_skill_boxes.len()).unwrap_or(u16::MAX),
            extra_skill_boxes,
            next_skill_box_id,
            primary_weapon_id: authority_weapon_id_label(goal.primary_weapon_id).to_owned(),
        })
    }
}

pub(super) const AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC: &str = "combat:ranged_basic";
pub(super) const AUTHORITY_CAPABILITY_COMBAT_MELEE_BASIC: &str = "combat:melee_basic";
pub(super) const AUTHORITY_CAPABILITY_CRAFT_AMMO: &str = "craft:ammo";
pub(super) const AUTHORITY_CAPABILITY_CRAFT_MEDICINE: &str = "craft:medicine";
pub(super) const AUTHORITY_CAPABILITY_REVIVE_BASIC: &str = "medical:revive_basic";
pub(super) const AUTHORITY_CAPABILITY_CRAFT_PROFESSION_TOOL: &str = "craft:profession_tool";
pub(super) const AUTHORITY_CAPABILITY_CRAFT_SCOUT_PROCESSING: &str = "craft:scout_processing";
pub(super) const AUTHORITY_CAPABILITY_GATHER_IRON: &str = "gather:iron";
pub(super) const AUTHORITY_CAPABILITY_HARVEST_AMMO: &str = "harvest:ammo";
pub(super) const AUTHORITY_CAPABILITY_HARVEST_CREATURE: &str = "harvest:creature";
pub(super) const AUTHORITY_CAPABILITY_HAUL_EXCHANGE: &str = "haul:exchange";
pub(super) const AUTHORITY_CAPABILITY_SELF_PRESERVE: &str = "self-preserve";
pub(super) const AUTHORITY_CAPABILITY_TRAIN_PROFESSION: &str = "train:profession";
pub(super) const AUTHORITY_CAPABILITY_SAMPLE_FLORA: &str = "sample:flora";
pub(super) const AUTHORITY_CAPABILITY_SPLICE_GENOME: &str = "splice:genome";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ActorCapabilityState {
    pub(super) granted: BTreeSet<String>,
}

impl ActorCapabilityState {
    pub(super) fn from_professions(professions: &ActorProfessionState) -> Self {
        let granted = BTreeSet::from([
            AUTHORITY_CAPABILITY_HAUL_EXCHANGE.to_owned(),
            AUTHORITY_CAPABILITY_SELF_PRESERVE.to_owned(),
        ]);
        let mut state = Self { granted };
        for profession in AuthorityProfessionKind::all() {
            if professions.has(profession) {
                state.grant_profession_capabilities(profession);
            }
        }
        state
    }

    pub(super) fn from_professions_and_grants(
        professions: &ActorProfessionState,
        capabilities: &[String],
    ) -> Self {
        let mut state = Self::from_professions(professions);
        for capability in capabilities {
            let trimmed = capability.trim();
            if !trimmed.is_empty() {
                state.granted.insert(trimmed.to_owned());
            }
        }
        state
    }

    pub(super) fn has(&self, capability: &str) -> bool {
        self.granted.contains(capability)
    }

    pub(super) fn grant_profession_capabilities(&mut self, profession: AuthorityProfessionKind) {
        match profession {
            AuthorityProfessionKind::Marksman => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_HARVEST_AMMO.to_owned());
            }
            AuthorityProfessionKind::Brawler => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_COMBAT_MELEE_BASIC.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_HARVEST_CREATURE.to_owned());
            }
            AuthorityProfessionKind::Craftsman => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_CRAFT_AMMO.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_CRAFT_PROFESSION_TOOL.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_GATHER_IRON.to_owned());
            }
            AuthorityProfessionKind::Medic => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_CRAFT_MEDICINE.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_REVIVE_BASIC.to_owned());
            }
            AuthorityProfessionKind::Scout => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_CRAFT_SCOUT_PROCESSING.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_HARVEST_CREATURE.to_owned());
            }
            AuthorityProfessionKind::BioEngineer => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_SAMPLE_FLORA.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_SPLICE_GENOME.to_owned());
            }
            AuthorityProfessionKind::Commando => {
                self.granted
                    .insert(AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC.to_owned());
                self.granted
                    .insert(AUTHORITY_CAPABILITY_HARVEST_AMMO.to_owned());
            }
        }
    }

    #[cfg(test)]
    pub(super) fn grant(&mut self, capability: &str) {
        self.granted.insert(capability.to_owned());
    }
}

#[cfg(test)]
pub(super) fn authority_capability_unlock_catalog() -> BTreeMap<String, Vec<String>> {
    let baseline = ActorCapabilityState::from_professions(&ActorProfessionState::empty()).granted;
    AuthorityProfessionKind::all()
        .into_iter()
        .map(|profession| {
            let mut professions = ActorProfessionState::empty();
            professions.learned.insert(profession);
            professions
                .skill_boxes
                .insert(format!("{}-novice", profession.id()));
            let capability_ids = ActorCapabilityState::from_professions(&professions)
                .granted
                .difference(&baseline)
                .cloned()
                .collect::<Vec<_>>();
            (format!("{}-novice", profession.id()), capability_ids)
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityProfessionSnapshot {
    pub id: String,
    pub label: String,
    pub xp: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub track_xp: BTreeMap<String, u64>,
    pub skill_points: u16,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skill_boxes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityProfessionTitleSnapshot {
    pub id: String,
    pub label: String,
    pub skill_box_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorCapabilitySnapshot {
    pub id: String,
}
