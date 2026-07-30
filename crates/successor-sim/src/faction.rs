use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::{ActorSnapshot, FactionSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FactionPvpStatus {
    None,
    Covert,
    Overt,
}

impl FactionPvpStatus {
    pub fn from_optional(value: Option<&str>) -> Self {
        match value
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "covert" => Self::Covert,
            "overt" => Self::Overt,
            _ => Self::None,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Covert => "covert",
            Self::Overt => "overt",
        }
    }

    pub const fn code(self) -> u32 {
        match self {
            Self::None => 0,
            Self::Covert => 1,
            Self::Overt => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActorFactionState {
    pub faction_id: Option<String>,
    pub social_group: Option<String>,
    pub pvp_status: FactionPvpStatus,
}

impl ActorFactionState {
    pub fn from_actor_snapshot(actor: &ActorSnapshot) -> Self {
        Self {
            faction_id: normalize_optional_key(actor.faction_id.as_deref()),
            social_group: normalize_optional_key(actor.social_group.as_deref()),
            pvp_status: FactionPvpStatus::from_optional(actor.pvp_status.as_deref()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactionRelationship {
    Same,
    Ally,
    Enemy,
    Neutral,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactionRule {
    pub id: String,
    pub label: String,
    pub player_allowed: bool,
    pub enemies: BTreeSet<String>,
    pub allies: BTreeSet<String>,
    pub adjust_factor_milli: i32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FactionTable {
    rules: BTreeMap<String, FactionRule>,
}

impl FactionTable {
    pub fn from_snapshots(snapshots: &[FactionSnapshot]) -> Self {
        let mut table = Self::default();
        for snapshot in snapshots {
            let Some(id) = normalize_optional_key(Some(&snapshot.id)) else {
                continue;
            };
            let rule = FactionRule {
                id: id.clone(),
                label: if snapshot.label.trim().is_empty() {
                    id.clone()
                } else {
                    snapshot.label.trim().to_owned()
                },
                player_allowed: snapshot.player_allowed,
                enemies: normalize_key_set(&snapshot.enemies),
                allies: normalize_key_set(&snapshot.allies),
                adjust_factor_milli: snapshot.adjust_factor_milli.max(0),
            };
            table.rules.insert(id, rule);
        }
        table
    }

    pub fn contains(&self, faction_id: &str) -> bool {
        self.rules.contains_key(faction_id)
    }

    pub fn relationship(
        &self,
        left: &ActorFactionState,
        right: &ActorFactionState,
    ) -> FactionRelationship {
        if left.social_group.is_some() && left.social_group == right.social_group {
            return FactionRelationship::Ally;
        }

        let Some(left_id) = left.faction_id.as_deref() else {
            return FactionRelationship::Neutral;
        };
        let Some(right_id) = right.faction_id.as_deref() else {
            return FactionRelationship::Neutral;
        };
        if left_id == right_id {
            return FactionRelationship::Same;
        }
        if self.is_enemy(left_id, right_id) || self.is_enemy(right_id, left_id) {
            return FactionRelationship::Enemy;
        }
        if self.is_ally(left_id, right_id) || self.is_ally(right_id, left_id) {
            return FactionRelationship::Ally;
        }
        FactionRelationship::Neutral
    }

    pub fn is_enemy(&self, faction_id: &str, candidate_id: &str) -> bool {
        self.rules
            .get(faction_id)
            .is_some_and(|rule| rule.enemies.contains(candidate_id))
    }

    pub fn is_ally(&self, faction_id: &str, candidate_id: &str) -> bool {
        self.rules
            .get(faction_id)
            .is_some_and(|rule| rule.allies.contains(candidate_id))
    }

    pub fn rules(&self) -> impl Iterator<Item = &FactionRule> {
        self.rules.values()
    }

    pub fn len(&self) -> usize {
        self.rules.len()
    }
}

fn normalize_key_set(values: &[String]) -> BTreeSet<String> {
    values
        .iter()
        .filter_map(|value| normalize_optional_key(Some(value)))
        .collect()
}

pub fn normalize_optional_key(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase().replace('-', "_"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str, enemies: &[&str], allies: &[&str]) -> FactionSnapshot {
        FactionSnapshot {
            id: id.to_owned(),
            label: id.to_owned(),
            player_allowed: true,
            enemies: enemies.iter().map(|value| value.to_string()).collect(),
            allies: allies.iter().map(|value| value.to_string()).collect(),
            adjust_factor_milli: 1_000,
        }
    }

    #[test]
    fn table_resolves_enemy_ally_and_same_relationships() {
        let table = FactionTable::from_snapshots(&[
            rule("red-crew", &["blue_crew"], &["red_aux"]),
            rule("blue_crew", &["red_crew"], &[]),
            rule("red_aux", &[], &["red_crew"]),
        ]);
        let red = ActorFactionState {
            faction_id: Some("red_crew".to_owned()),
            social_group: None,
            pvp_status: FactionPvpStatus::None,
        };
        let blue = ActorFactionState {
            faction_id: Some("blue_crew".to_owned()),
            social_group: None,
            pvp_status: FactionPvpStatus::None,
        };
        let red_aux = ActorFactionState {
            faction_id: Some("red_aux".to_owned()),
            social_group: None,
            pvp_status: FactionPvpStatus::None,
        };

        assert_eq!(table.relationship(&red, &red), FactionRelationship::Same);
        assert_eq!(table.relationship(&red, &blue), FactionRelationship::Enemy);
        assert_eq!(
            table.relationship(&red, &red_aux),
            FactionRelationship::Ally
        );
    }

    #[test]
    fn shared_social_group_is_ally_without_faction_match() {
        let table = FactionTable::default();
        let left = ActorFactionState {
            faction_id: Some("red".to_owned()),
            social_group: Some("squad".to_owned()),
            pvp_status: FactionPvpStatus::None,
        };
        let right = ActorFactionState {
            faction_id: Some("blue".to_owned()),
            social_group: Some("squad".to_owned()),
            pvp_status: FactionPvpStatus::None,
        };

        assert_eq!(table.relationship(&left, &right), FactionRelationship::Ally);
    }
}
