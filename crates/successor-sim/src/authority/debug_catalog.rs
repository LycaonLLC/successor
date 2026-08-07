//! Everything the debug character builder can hand a player.
//!
//! Both entries are derived by ASKING THE RUNTIME rather than by keeping a
//! parallel list. Items are discovered by probing the id space against
//! [`inventory_item_name`], and skill boxes by expanding every profession
//! through [`authority_skill_box_tracks`] and resolving each id through
//! [`authority_skill_box_definition`]. A hand-maintained table would drift the
//! first time someone adds an item and forgets this file; a probe cannot.

use super::inventory::inventory_item_name;
use super::progression::{
    authority_skill_box_definition, authority_skill_box_tracks, AuthorityProfessionKind,
};

/// Ceiling for the item id probe. The runtime's ids are banded well under this
/// (consumables ~1_000, tools ~3_000, weapons ~31_000_000 are variant-encoded
/// rather than distinct ids), and the scan is a few thousand map lookups run
/// once by a codegen binary, never at runtime.
const ITEM_ID_PROBE_CEILING: u32 = 40_000;

/// Every profession the authority knows. Kept adjacent to the enum it mirrors
/// so a new profession fails the catalog test rather than silently vanishing
/// from the builder menu.
pub const ALL_PROFESSIONS: [AuthorityProfessionKind; 7] = [
    AuthorityProfessionKind::Craftsman,
    AuthorityProfessionKind::Medic,
    AuthorityProfessionKind::Scout,
    AuthorityProfessionKind::Marksman,
    AuthorityProfessionKind::Brawler,
    AuthorityProfessionKind::BioEngineer,
    AuthorityProfessionKind::Commando,
];

/// One grantable item.
pub struct DebugCatalogItem {
    pub id: u32,
    pub name: String,
}

/// One grantable skill box.
pub struct DebugCatalogSkillBox {
    pub id: String,
    pub title: String,
    pub profession: String,
    pub tier: String,
}

/// Every item id the runtime will name, in ascending id order.
pub fn debug_catalog_items() -> Vec<DebugCatalogItem> {
    let mut items = Vec::new();
    for id in 0..=ITEM_ID_PROBE_CEILING {
        if let Some(name) = inventory_item_name(id) {
            items.push(DebugCatalogItem {
                id,
                name: name.to_owned(),
            });
        }
    }
    items
}

/// Every skill box: per profession, novice, each track at tiers i..iv, master.
pub fn debug_catalog_skill_boxes() -> Vec<DebugCatalogSkillBox> {
    const TIERS: [&str; 4] = ["i", "ii", "iii", "iv"];
    let mut boxes = Vec::new();
    for profession in ALL_PROFESSIONS {
        let mut ids = vec![format!("{}-novice", profession.id())];
        for track in authority_skill_box_tracks(profession) {
            for tier in TIERS {
                ids.push(format!("{}-{track}-{tier}", profession.id()));
            }
        }
        ids.push(format!("{}-master", profession.id()));
        for id in ids {
            let Some(definition) = authority_skill_box_definition(&id) else {
                continue;
            };
            let tier = id
                .rsplit('-')
                .next()
                .unwrap_or("")
                .to_owned();
            boxes.push(DebugCatalogSkillBox {
                title: definition.title.clone().unwrap_or_else(|| id.clone()),
                profession: profession.id().to_owned(),
                tier,
                id,
            });
        }
    }
    boxes
}
