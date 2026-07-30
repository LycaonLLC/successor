//! Enemy proximity-bark content corpus.
//!
//! Content corpus plus deterministic bark sampling/one-shot claim helpers.
//! Authority owns proximity policy and delivery timing; these helpers keep
//! radius, chance, and line choice stable for an encounter identity.
//! Array order is part of the contract — never reorder or renumber existing
//! lines, append only.
//!
//! Archetype taxonomy mirrors the live hostile-humanoid reads in
//! `authority/helpers.rs` (`derive_actor_descriptor` precedence):
//! role `skirmisher_brawler` -> `rogue_brawler`; social group
//! `open_desert_rogues` -> `rogue_drifter`; faction `rogue_troopers` ->
//! `rogue_trooper`. Wildlife (gaia) never barks and has no entry here.
//!
//! Voice contract: dusty frontier, mature and terse, speakable in one breath,
//! short enough for a chat bubble. No narration, no stage direction, no
//! modern idiom, no borrowed setting vocabulary.
use serde::{Deserialize, Serialize};

/// Provoked-only open-desert loner (`social_group == "open_desert_rogues"`).
pub const BARK_ARCHETYPE_ROGUE_DRIFTER: &str = "rogue_drifter";
/// Organized deserter-militia patrol (`faction_id == "rogue_troopers"`).
pub const BARK_ARCHETYPE_ROGUE_TROOPER: &str = "rogue_trooper";
/// Close-in bruiser (`role == "skirmisher_brawler"`).
pub const BARK_ARCHETYPE_ROGUE_BRAWLER: &str = "rogue_brawler";

/// Every bark archetype, in stable declaration order.
pub const BARK_ARCHETYPE_IDS: &[&str] = &[
    BARK_ARCHETYPE_ROGUE_DRIFTER,
    BARK_ARCHETYPE_ROGUE_TROOPER,
    BARK_ARCHETYPE_ROGUE_BRAWLER,
];

/// Someone unfamiliar is near; not yet a threat read.
pub const BARK_MOOD_SUSPICION: &str = "suspicion";
/// The intruder is on held ground; explicit back-off demand.
pub const BARK_MOOD_TERRITORIAL_WARNING: &str = "territorial_warning";
/// The enemy reads weakness or valuables and presses for a shakedown.
pub const BARK_MOOD_OPPORTUNISTIC_THREAT: &str = "opportunistic_threat";
/// Idle muttering about salvage, supply, and the scavenging life.
pub const BARK_MOOD_SCAVENGER_BANTER: &str = "scavenger_banter";
/// Worn-down grumbling on a long watch or a long walk.
pub const BARK_MOOD_PATROL_FATIGUE: &str = "patrol_fatigue";
/// Combat opens; the alarm or engagement shout.
pub const BARK_MOOD_ALARM_ENGAGEMENT: &str = "alarm_engagement";

/// Every bark mood, in stable declaration order.
pub const BARK_MOOD_IDS: &[&str] = &[
    BARK_MOOD_SUSPICION,
    BARK_MOOD_TERRITORIAL_WARNING,
    BARK_MOOD_OPPORTUNISTIC_THREAT,
    BARK_MOOD_SCAVENGER_BANTER,
    BARK_MOOD_PATROL_FATIGUE,
    BARK_MOOD_ALARM_ENGAGEMENT,
];

/// Deterministic pool lookup. Returns `None` for unknown IDs; every known
/// archetype/mood pair has a non-empty pool (enforced by tests).
pub fn bark_lines(archetype_id: &str, mood_id: &str) -> Option<&'static [&'static str]> {
    let pools: &[(&str, &'static [&'static str])] = match archetype_id {
        BARK_ARCHETYPE_ROGUE_DRIFTER => ROGUE_DRIFTER_POOLS,
        BARK_ARCHETYPE_ROGUE_TROOPER => ROGUE_TROOPER_POOLS,
        BARK_ARCHETYPE_ROGUE_BRAWLER => ROGUE_BRAWLER_POOLS,
        _ => return None,
    };
    pools
        .iter()
        .find(|(mood, _)| *mood == mood_id)
        .map(|(_, lines)| *lines)
}

/// Content-side taxonomy mapping from actor traits to a bark archetype,
/// mirroring the `derive_actor_descriptor` precedence in
/// `authority/helpers.rs`. Pure and deterministic; callers pass the actor's
/// raw trait reads. Non-hostile or unknown trait combinations get `None`
/// (no bark).
pub fn bark_archetype_for(
    role: &str,
    faction_id: Option<&str>,
    social_group: Option<&str>,
) -> Option<&'static str> {
    if role == "skirmisher_brawler" {
        return Some(BARK_ARCHETYPE_ROGUE_BRAWLER);
    }
    if social_group == Some("open_desert_rogues") {
        return Some(BARK_ARCHETYPE_ROGUE_DRIFTER);
    }
    if faction_id == Some("rogue_troopers") {
        return Some(BARK_ARCHETYPE_ROGUE_TROOPER);
    }
    None
}

/// Deterministic proximity-bark sample. Radius, chance, and line are sampled
/// once from the encounter identity and remain stable for every player.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BarkSample {
    pub trigger_radius_milli: u32,
    pub chance_milli: u16,
    pub line_index: usize,
}

/// Persisted global one-shot claims. A claimed encounter cannot bark again,
/// including after a chance miss or a player disconnect/reconnect.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BarkClaims(std::collections::BTreeSet<String>);

impl BarkClaims {
    pub fn try_claim_encounter(&mut self, encounter_id: &str) -> bool {
        self.0.insert(encounter_id.to_owned())
    }

    pub fn contains_encounter(&self, encounter_id: &str) -> bool {
        self.0.contains(encounter_id)
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = &String> {
        self.0.iter()
    }
}

pub fn sample_bark(seed: u64, encounter_id: &str, _tick: u64) -> BarkSample {
    let mut h = seed;
    for byte in encounter_id.bytes() {
        h = h
            .wrapping_mul(1_099_511_628_211)
            .wrapping_add(u64::from(byte) + 1);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    BarkSample {
        trigger_radius_milli: 6_000 + (h as u32 % 7_001),
        chance_milli: 250 + ((h >> 19) as u16 % 501),
        line_index: (h >> 37) as usize,
    }
}

pub fn bark_roll_eligible(sample: BarkSample, roll_seed: u64) -> bool {
    let roll = (roll_seed ^ roll_seed.rotate_left(23)) as u32 % 1_000;
    roll < u32::from(sample.chance_milli)
}

/// Selects an encounter-stable mood from the sampled bark index.
pub fn bark_mood_for_sample(sample: BarkSample) -> &'static str {
    BARK_MOOD_IDS[sample.line_index % BARK_MOOD_IDS.len()]
}

/// Resolve one encounter approach. Claim is consumed before chance evaluation,
/// so a miss is terminal and cannot reroll on re-entry.
pub fn resolve_bark(
    claims: &mut BarkClaims,
    seed: u64,
    encounter_id: &str,
    tick: u64,
    archetype_id: &str,
    mood_id: &str,
) -> Option<&'static str> {
    if !claims.try_claim_encounter(encounter_id) {
        return None;
    }
    let sample = sample_bark(seed, encounter_id, tick);
    if !bark_roll_eligible(sample, seed) {
        return None;
    }
    let lines = bark_lines(archetype_id, mood_id)?;
    lines.get(sample.line_index % lines.len()).copied()
}

// ---------------------------------------------------------------------------
// Rogue drifter — provoked-only loner. Wary, transactional, wants distance,
// but plainly dangerous once the line is crossed.
// ---------------------------------------------------------------------------

const ROGUE_DRIFTER_POOLS: &[(&str, &[&str])] = &[
    (BARK_MOOD_SUSPICION, ROGUE_DRIFTER_SUSPICION),
    (BARK_MOOD_TERRITORIAL_WARNING, ROGUE_DRIFTER_TERRITORIAL),
    (BARK_MOOD_OPPORTUNISTIC_THREAT, ROGUE_DRIFTER_OPPORTUNIST),
    (BARK_MOOD_SCAVENGER_BANTER, ROGUE_DRIFTER_BANTER),
    (BARK_MOOD_PATROL_FATIGUE, ROGUE_DRIFTER_FATIGUE),
    (BARK_MOOD_ALARM_ENGAGEMENT, ROGUE_DRIFTER_ALARM),
];

const ROGUE_DRIFTER_SUSPICION: &[&str] = &[
    "You lost, or looking?",
    "Keep your hands where the sun hits them.",
    "Heard your boots a ridge back.",
    "Warden? You smell like camp soap.",
    "Don't like company. Don't like it at all.",
    "Eyes front, stranger. Mine are.",
    "That's close enough to count your teeth.",
    "New face. Faces cost around here.",
    "You following me, or the water?",
    "Something's off about you. Stay off.",
    "State your business or lose it.",
];

const ROGUE_DRIFTER_TERRITORIAL: &[&str] = &[
    "This stretch is claimed. By me.",
    "Turn around. The sand's the same both ways.",
    "One more step and we settle it.",
    "My shade, my well, my rules.",
    "Walk wide. I won't ask twice.",
    "You're on my dirt, friend.",
    "Past that rock is my problem. Don't be.",
    "I dug in here first. Move along.",
    "Nothing here for you but a bad afternoon.",
    "The line's where I say it is. You're on it.",
    "Back up slow and keep your shadow with you.",
];

const ROGUE_DRIFTER_OPPORTUNIST: &[&str] = &[
    "That pack looks heavy. I could lighten it.",
    "Nice rifle. Shame if it changed hands.",
    "You limping? Limping's expensive out here.",
    "Alone, are you? So was the last one.",
    "Credits or canteen. Your pick.",
    "Those boots would outlast you.",
    "I'd drop the bag before I have to take it.",
    "You carry like a bank. Banks get opened.",
    "Half of what you've got buys your morning.",
    "Wounded and rich. Bad combination.",
    "Pay the sand tax and keep walking.",
];

const ROGUE_DRIFTER_BANTER: &[&str] = &[
    "Found half a rig yesterday. Wrong half.",
    "Copper's up. Everything else is dust.",
    "Two days of digging for one bent coupler.",
    "The wrecks out east are picked to bone.",
    "Traded a scope for water. Fair, mostly.",
    "Good wire's worth more than good friends.",
    "Somebody stripped my cache. Somebody will pay.",
    "One clean battery. That's all I ask.",
    "The dunes give back what they take. Eventually.",
    "This coupler's slag. Whole trip for slag.",
    "You can eat pride. Just once.",
];

const ROGUE_DRIFTER_FATIGUE: &[&str] = &[
    "Sun's been up too long. Same as me.",
    "My knees remember every dune.",
    "Walked this flat a hundred times. Still hate it.",
    "Water's low. Temper's lower.",
    "Sleep's for people with walls.",
    "The wind never says anything new.",
    "One more ridge, then I sit. I mean it.",
    "Boots wore through. So did the week.",
    "Cold nights, long days. That's the whole deal.",
    "I dream about shade. Just shade.",
    "Even the flies gave up on this stretch.",
];

const ROGUE_DRIFTER_ALARM: &[&str] = &[
    "You picked wrong!",
    "Should've walked wide!",
    "Now it's settled my way!",
    "I warned you fair!",
    "Come on then!",
    "Your mistake, stranger!",
    "I've buried better than you!",
    "The sand takes you next!",
    "No more talking!",
    "You brought this!",
    "Last thing you'll waste!",
];

// ---------------------------------------------------------------------------
// Rogue trooper — deserter militia holding ground. Clipped unit-speak,
// drilled habits gone sour, resentful of the war that left them here.
// ---------------------------------------------------------------------------

const ROGUE_TROOPER_POOLS: &[(&str, &[&str])] = &[
    (BARK_MOOD_SUSPICION, ROGUE_TROOPER_SUSPICION),
    (BARK_MOOD_TERRITORIAL_WARNING, ROGUE_TROOPER_TERRITORIAL),
    (BARK_MOOD_OPPORTUNISTIC_THREAT, ROGUE_TROOPER_OPPORTUNIST),
    (BARK_MOOD_SCAVENGER_BANTER, ROGUE_TROOPER_BANTER),
    (BARK_MOOD_PATROL_FATIGUE, ROGUE_TROOPER_FATIGUE),
    (BARK_MOOD_ALARM_ENGAGEMENT, ROGUE_TROOPER_ALARM),
];

const ROGUE_TROOPER_SUSPICION: &[&str] = &[
    "Contact, unverified. Hold your line.",
    "Name and business. Quick.",
    "Movement on the flat. Eyes up.",
    "You're not on any roster I know.",
    "Stop there. Let me look at you.",
    "Civilians don't drift this far. Usually.",
    "Two hands, empty, where I can see them.",
    "Something moved behind that rise.",
    "You tracking us, or just unlucky?",
    "Hold. Nobody crosses without a look.",
    "That kit's warden issue. Explain it.",
];

const ROGUE_TROOPER_TERRITORIAL: &[&str] = &[
    "This ground is held. Turn back.",
    "You're inside our perimeter. Fix that.",
    "No passage. Not today, not for you.",
    "Step back across the wash. Now.",
    "This post doesn't take visitors.",
    "You've got ten steps of goodwill left.",
    "Our ground, our rounds. Walk away.",
    "The line is marked. You're past it.",
    "Withdraw or be withdrawn.",
    "Wrong side of the wire, stranger.",
    "Last marker was your last warning.",
];

const ROGUE_TROOPER_OPPORTUNIST: &[&str] = &[
    "Supplies get requisitioned out here.",
    "That gear outranks you. Hand it over.",
    "One traveler, no escort. Poor planning.",
    "We take a toll. You're carrying it.",
    "Drop the pack. Consider it taxed.",
    "Your ammunition serves the unit now.",
    "Walk away lighter or don't walk away.",
    "Nobody's coming for you. We checked.",
    "Good rifle. Bad position.",
    "Surrender the kit. Keep the breathing.",
    "You're outnumbered and outheld. Pay up.",
];

const ROGUE_TROOPER_BANTER: &[&str] = &[
    "Quartermaster's dead. We're all quartermasters.",
    "Stripped a convoy last week. Mostly bolts.",
    "Ration count's a joke. A short one.",
    "Found warden crates. Empty, of course.",
    "This rifle's older than the war it lost.",
    "Fuel's currency. Everything else is opinion.",
    "Patched my plate with a road sign.",
    "Requisition means take. Always did.",
    "Half our rounds are reloads. The loud half.",
    "Salvage detail again. Lucky us.",
    "The depot's a memory with a fence.",
];

const ROGUE_TROOPER_FATIGUE: &[&str] = &[
    "Third loop today. Nothing but heat.",
    "Wake me if the horizon does anything.",
    "My watch ended an hour ago. Officially.",
    "Sand in the action. Sand in everything.",
    "Nobody's attacked a rock post in years.",
    "Feet report: mutiny pending.",
    "Long watch, short rations. Standard.",
    "I've memorized every stone on this loop.",
    "The flag's more tired than I am.",
    "Quiet again. Quiet's still a lie.",
    "Count the dunes. Lose count. Repeat.",
];

const ROGUE_TROOPER_ALARM: &[&str] = &[
    "Contact! Weapons free!",
    "Hostile on the line! Engage!",
    "Take cover and return fire!",
    "They want the post? Bury them at it!",
    "Push them off the ridge!",
    "Hold formation! Pick your shots!",
    "Flank left! Move, move!",
    "Targets marked! Drop them!",
    "No retreat orders! Fight!",
    "Suppress and advance!",
    "They shot first. We shoot last!",
];

// ---------------------------------------------------------------------------
// Rogue brawler — close-in bruiser. Blunt, physical, short words, spoiling
// for a reason.
// ---------------------------------------------------------------------------

const ROGUE_BRAWLER_POOLS: &[(&str, &[&str])] = &[
    (BARK_MOOD_SUSPICION, ROGUE_BRAWLER_SUSPICION),
    (BARK_MOOD_TERRITORIAL_WARNING, ROGUE_BRAWLER_TERRITORIAL),
    (BARK_MOOD_OPPORTUNISTIC_THREAT, ROGUE_BRAWLER_OPPORTUNIST),
    (BARK_MOOD_SCAVENGER_BANTER, ROGUE_BRAWLER_BANTER),
    (BARK_MOOD_PATROL_FATIGUE, ROGUE_BRAWLER_FATIGUE),
    (BARK_MOOD_ALARM_ENGAGEMENT, ROGUE_BRAWLER_ALARM),
];

const ROGUE_BRAWLER_SUSPICION: &[&str] = &[
    "Who's this, then?",
    "You looking at me? Look longer.",
    "I can hear you breathing from here.",
    "Come closer. Or don't. Both work.",
    "Something's creeping. Creep louder.",
    "That walk of yours. Too quiet.",
    "New meat drifts in, huh.",
    "I don't like being watched. I like watching.",
    "Step into the light, whoever you are.",
    "Twitchy hands. I notice hands.",
    "Speak up or move along.",
];

const ROGUE_BRAWLER_TERRITORIAL: &[&str] = &[
    "This patch is mine. All of it.",
    "Closer means broken. Your choice.",
    "I don't share shade.",
    "Turn around while your legs still work.",
    "You crossed my mark. Uncross it.",
    "One warning. This is it.",
    "Big desert. Wrong corner.",
    "Walk it back, friend. Slow is fine.",
    "My ground. My knuckles. Your call.",
    "Nothing past me but pain.",
    "The exit's behind you. Use it.",
];

const ROGUE_BRAWLER_OPPORTUNIST: &[&str] = &[
    "Shiny kit. Soft carrier.",
    "I'll trade you. Your gear for your teeth.",
    "You're one bad step from broke.",
    "Hand it over and keep your posture.",
    "That bag's coming with me either way.",
    "Small fists, big pack. Bad odds.",
    "Empty your pockets. Save us the mess.",
    "I break things. You're carrying things.",
    "Tired legs, full bag. Easy work.",
    "Give it up standing or give it up flat.",
    "The strong collect. Today that's me.",
];

const ROGUE_BRAWLER_BANTER: &[&str] = &[
    "Cracked a locker clean open this morning.",
    "Best tool I own is my right hand.",
    "Wrenches, plates, buckles. All sellable.",
    "Pried a door off a wreck. Good door.",
    "Somebody buried a stash out here. I feel it.",
    "Scrap pays better than honest ever did.",
    "Found boots my size. Rare day.",
    "A crowbar is a career out here.",
    "The heavy stuff's mine. Carrying rights.",
    "Half this junk still swings fine.",
    "Locks are just slow doors.",
];

const ROGUE_BRAWLER_FATIGUE: &[&str] = &[
    "My shoulders hate this route.",
    "Walk, glare, repeat. Some life.",
    "Haven't hit anything in two days. Itchy.",
    "This heat softens everything but the ground.",
    "I nap standing. Learned that here.",
    "Long day. Short fuse.",
    "Even my calluses have calluses.",
    "Somebody start something. I'm bored.",
    "The dust gets in your teeth and stays.",
    "Circles. All we walk is circles.",
    "My back quit an hour before I did.",
];

const ROGUE_BRAWLER_ALARM: &[&str] = &[
    "Finally! Come here!",
    "I've been waiting all day for this!",
    "Knuckles first!",
    "You swung at the wrong camp!",
    "Now we do it my way!",
    "Get in close! I'll finish it!",
    "Wrong camp, wrong day!",
    "I'll fold you in half!",
    "Stand still! This won't take long!",
    "All that gear won't stop a fist!",
    "Drop the gun and see what happens!",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// Bubble-fit bounds: speakable in one breath, short enough for a chat
    /// bubble. Chars, not bytes — the corpus is ASCII (asserted below).
    const MIN_LINE_CHARS: usize = 8;
    const MAX_LINE_CHARS: usize = 64;
    const MIN_POOL_LINES: usize = 8;
    const MIN_TOTAL_LINES: usize = 180;

    fn every_pool() -> Vec<(&'static str, &'static str, &'static [&'static str])> {
        let mut pools = Vec::new();
        for archetype in BARK_ARCHETYPE_IDS {
            for mood in BARK_MOOD_IDS {
                let lines = bark_lines(archetype, mood)
                    .unwrap_or_else(|| panic!("missing pool {archetype}/{mood}"));
                pools.push((*archetype, *mood, lines));
            }
        }
        pools
    }

    fn is_snake_case_id(id: &str) -> bool {
        !id.is_empty()
            && !id.starts_with('_')
            && !id.ends_with('_')
            && id.chars().all(|c| c.is_ascii_lowercase() || c == '_')
    }

    #[test]
    fn ids_are_stable_snake_case_and_unique() {
        for ids in [BARK_ARCHETYPE_IDS, BARK_MOOD_IDS] {
            let unique: BTreeSet<_> = ids.iter().collect();
            assert_eq!(unique.len(), ids.len(), "duplicate id in {ids:?}");
            for id in ids {
                assert!(is_snake_case_id(id), "id {id:?} is not snake_case");
            }
        }
        assert_eq!(BARK_ARCHETYPE_IDS.len(), 3);
        assert_eq!(BARK_MOOD_IDS.len(), 6);
    }

    #[test]
    fn unknown_ids_return_none() {
        assert!(bark_lines("rogue_drifter", "nonexistent_mood").is_none());
        assert!(bark_lines("nonexistent_archetype", "suspicion").is_none());
        assert!(bark_lines("", "").is_none());
    }

    #[test]
    fn every_archetype_mood_pool_is_populated() {
        for (archetype, mood, lines) in every_pool() {
            assert!(
                lines.len() >= MIN_POOL_LINES,
                "pool {archetype}/{mood} has {} lines; needs at least {MIN_POOL_LINES} for variety",
                lines.len()
            );
        }
    }

    #[test]
    fn corpus_meets_size_and_uniqueness_floor() {
        let mut seen = BTreeSet::new();
        let mut total = 0usize;
        for (archetype, mood, lines) in every_pool() {
            for line in lines {
                total += 1;
                let normalized: String = line
                    .to_ascii_lowercase()
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || *c == ' ')
                    .collect::<String>()
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ");
                assert!(
                    seen.insert(normalized.clone()),
                    "duplicate line {line:?} (normalized {normalized:?}) in {archetype}/{mood}"
                );
            }
        }
        assert!(
            total >= MIN_TOTAL_LINES,
            "corpus has {total} lines; needs at least {MIN_TOTAL_LINES}"
        );
    }

    #[test]
    fn lines_fit_bubbles_and_stay_speakable_ascii() {
        for (archetype, mood, lines) in every_pool() {
            for line in lines {
                assert_eq!(
                    *line,
                    line.trim(),
                    "line {line:?} in {archetype}/{mood} has stray whitespace"
                );
                let chars = line.chars().count();
                assert!(
                    (MIN_LINE_CHARS..=MAX_LINE_CHARS).contains(&chars),
                    "line {line:?} in {archetype}/{mood} is {chars} chars; bounds {MIN_LINE_CHARS}..={MAX_LINE_CHARS}"
                );
                assert!(
                    line.chars().all(|c| c.is_ascii_graphic() || c == ' '),
                    "line {line:?} in {archetype}/{mood} has non-ASCII or control chars"
                );
                assert!(
                    !line.contains('\n') && !line.contains('\t'),
                    "line {line:?} in {archetype}/{mood} has layout characters"
                );
            }
        }
    }

    #[test]
    fn lines_carry_no_placeholders_narration_or_banned_vocabulary() {
        // Local copy hygiene plus the repository-wide project denylist.
        // Substring match on lowercased text.
        const LOCAL_BANNED: &[&str] = &[
            "todo",
            "tbd",
            "lorem",
            "placeholder",
            "xxx",
            "fixme",
            "<",
            ">",
            "{",
            "}",
            "[",
            "]",
            "*",
            "_", // markup/narration markers — barks are spoken text only
            "fuck",
            "shit",
            "bitch",
            "asshole",
            "damn it", // profanity spam guard
            "lol",
            "yeet",
            "sus ",
            "based",
            "vibe",
            "cringe", // modern meme guard
        ];
        let project_banned = include_str!("../../../tools/denylist/denylist.txt")
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('#'));
        for (archetype, mood, lines) in every_pool() {
            for line in lines {
                let lower = line.to_ascii_lowercase();
                for banned in LOCAL_BANNED.iter().copied().chain(project_banned.clone()) {
                    let banned = banned.to_ascii_lowercase();
                    assert!(
                        !lower.contains(&banned),
                        "line {line:?} in {archetype}/{mood} contains banned token {banned:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn sampled_bark_is_stable_bounded_and_one_shot() {
        let first = sample_bark(7, "encounter-a", 99);
        assert_eq!(first, sample_bark(7, "encounter-a", 100));
        assert_eq!(first, sample_bark(7, "encounter-a", 99));
        assert!((6_000..=13_000).contains(&first.trigger_radius_milli));
        assert!((250..=750).contains(&first.chance_milli));
        for (index, expected) in BARK_MOOD_IDS.iter().enumerate() {
            assert_eq!(
                bark_mood_for_sample(BarkSample {
                    line_index: index,
                    ..first
                }),
                *expected
            );
        }
        let mut claims = BarkClaims::default();
        assert!(claims.try_claim_encounter("encounter-a"));
        assert!(!claims.try_claim_encounter("encounter-a"));
        assert!(claims.contains_encounter("encounter-a"));
        assert!(claims.try_claim_encounter("encounter-b"));
    }

    #[test]
    fn bark_roll_uses_sampled_chance() {
        let low = BarkSample {
            trigger_radius_milli: 6_000,
            chance_milli: 0,
            line_index: 0,
        };
        assert!(!bark_roll_eligible(low, 0));
        let high = BarkSample {
            chance_milli: 1_000,
            ..low
        };
        assert!(bark_roll_eligible(high, u64::MAX));
    }

    #[test]
    fn archetype_mapping_follows_descriptor_precedence() {
        // Role read wins, then social group, then faction — mirrors
        // derive_actor_descriptor in authority/helpers.rs.
        assert_eq!(
            bark_archetype_for(
                "skirmisher_brawler",
                Some("rogue_troopers"),
                Some("open_desert_rogues")
            ),
            Some(BARK_ARCHETYPE_ROGUE_BRAWLER)
        );
        assert_eq!(
            bark_archetype_for(
                "skirmisher",
                Some("rogue_troopers"),
                Some("open_desert_rogues")
            ),
            Some(BARK_ARCHETYPE_ROGUE_DRIFTER)
        );
        assert_eq!(
            bark_archetype_for("skirmisher", Some("rogue_troopers"), None),
            Some(BARK_ARCHETYPE_ROGUE_TROOPER)
        );
        assert_eq!(
            bark_archetype_for("player", Some("desert_wardens"), None),
            None
        );
        assert_eq!(
            bark_archetype_for("creature", Some("gaia"), Some("gaia")),
            None
        );
        assert_eq!(bark_archetype_for("skirmisher", None, None), None);
    }

    #[test]
    fn pool_lookup_is_deterministic_and_order_stable() {
        // Spot-check first lines: array order is a published contract
        // (AI selection indexes by deterministic seed).
        assert_eq!(
            bark_lines(BARK_ARCHETYPE_ROGUE_DRIFTER, BARK_MOOD_SUSPICION).unwrap()[0],
            "You lost, or looking?"
        );
        assert_eq!(
            bark_lines(BARK_ARCHETYPE_ROGUE_TROOPER, BARK_MOOD_ALARM_ENGAGEMENT).unwrap()[0],
            "Contact! Weapons free!"
        );
        assert_eq!(
            bark_lines(BARK_ARCHETYPE_ROGUE_BRAWLER, BARK_MOOD_SCAVENGER_BANTER).unwrap()[0],
            "Cracked a locker clean open this morning."
        );
        // Same call, same slice identity.
        let first = bark_lines(BARK_ARCHETYPE_ROGUE_DRIFTER, BARK_MOOD_PATROL_FATIGUE).unwrap();
        let second = bark_lines(BARK_ARCHETYPE_ROGUE_DRIFTER, BARK_MOOD_PATROL_FATIGUE).unwrap();
        assert!(std::ptr::eq(first.as_ptr(), second.as_ptr()));
        assert_eq!(first.len(), second.len());
    }
}
