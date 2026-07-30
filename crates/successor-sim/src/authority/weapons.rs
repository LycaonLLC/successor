//! Current Roll-combat weapon, ammunition, equipment, and damage support.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WeaponProfile {
    pub(super) id: AuthorityWeaponId,
    pub(super) default_ammo_type: AuthorityAmmoTypeId,
    pub(super) base_damage: i32,
    pub(super) base_spread_degrees_milli: i32,
    pub(super) recoil_per_shot_milli: i32,
    pub(super) recoil_max_milli: i32,
    pub(super) recoil_decay_milli_per_second: i32,
    pub(super) recoil_spread_degrees_milli: i32,
    pub(super) recoil_max_spread_degrees_milli: i32,
    pub(super) roll_stats: Option<WeaponRollStats>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct WeaponRollStats {
    pub(super) attack_speed_ms: u64,
    pub(super) damage_min: u32,
    pub(super) damage_max: u32,
    pub(super) point_blank_acc: i32,
    pub(super) ideal_acc: i32,
    pub(super) max_acc: i32,
    pub(super) point_blank_range: i32,
    pub(super) ideal_range: i32,
    pub(super) max_range: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct WeaponRollRangeBands {
    pub(super) point_blank_cells: i32,
    pub(super) ideal_cells: i32,
    pub(super) max_cells: i32,
}

impl WeaponRollStats {
    pub(super) const fn range_bands(self) -> WeaponRollRangeBands {
        WeaponRollRangeBands {
            point_blank_cells: self.point_blank_range,
            ideal_cells: self.ideal_range,
            max_cells: self.max_range,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AmmoProfile {
    pub(super) id: AuthorityAmmoTypeId,
    pub(super) damage_multiplier_per_100: i32,
    pub(super) sleep: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PersonalShieldBlockOutcome {
    pub(super) damage_after_shield: i32,
    pub(super) effect: AuthorityCombatEffectSnapshot,
}

pub(super) const ROLL_TUNABLE_WEAPON_IDS: &[AuthorityWeaponId] = &[
    AuthorityWeaponId::Slugthrower,
    AuthorityWeaponId::Vibrosword,
    AuthorityWeaponId::ScraplineMachete,
    AuthorityWeaponId::FieldSaber,
    AuthorityWeaponId::QuarryChopper,
    AuthorityWeaponId::WpnSmg,
    AuthorityWeaponId::WpnCarbine,
    AuthorityWeaponId::LightningCarbine,
];

pub(super) fn weapon_profile(id: Option<AuthorityWeaponId>) -> WeaponProfile {
    match id.unwrap_or(AuthorityWeaponId::Unarmed) {
        AuthorityWeaponId::Slugthrower => WeaponProfile {
            id: AuthorityWeaponId::Slugthrower,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 10,
            base_spread_degrees_milli: SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI,
            recoil_per_shot_milli: SLUGTHROWER_RECOIL_PER_SHOT_MILLI,
            recoil_max_milli: SLUGTHROWER_RECOIL_MAX_MILLI,
            recoil_decay_milli_per_second: SLUGTHROWER_RECOIL_DECAY_MILLI_PER_SECOND,
            recoil_spread_degrees_milli: SLUGTHROWER_RECOIL_SPREAD_DEGREES_MILLI,
            recoil_max_spread_degrees_milli: SLUGTHROWER_RECOIL_MAX_SPREAD_DEGREES_MILLI,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: SLUGTHROWER_ROLL_ATTACK_SPEED_MS,
                damage_min: SLUGTHROWER_ROLL_DAMAGE_MIN,
                damage_max: SLUGTHROWER_ROLL_DAMAGE_MAX,
                point_blank_acc: SLUGTHROWER_ROLL_POINT_BLANK_ACC,
                ideal_acc: SLUGTHROWER_ROLL_IDEAL_ACC,
                max_acc: SLUGTHROWER_ROLL_MAX_ACC,
                point_blank_range: SLUGTHROWER_ROLL_POINT_BLANK_RANGE_CELLS,
                ideal_range: SLUGTHROWER_ROLL_IDEAL_RANGE_CELLS,
                max_range: SLUGTHROWER_ROLL_MAX_RANGE_CELLS,
            }),
        },
        AuthorityWeaponId::Vibrosword => WeaponProfile {
            id: AuthorityWeaponId::Vibrosword,
            default_ammo_type: AuthorityAmmoTypeId::Melee,
            base_damage: 20,
            base_spread_degrees_milli: 0,
            recoil_per_shot_milli: 0,
            recoil_max_milli: 0,
            recoil_decay_milli_per_second: 0,
            recoil_spread_degrees_milli: 0,
            recoil_max_spread_degrees_milli: 0,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: VIBROSWORD_ROLL_ATTACK_SPEED_MS,
                damage_min: VIBROSWORD_ROLL_DAMAGE_MIN,
                damage_max: VIBROSWORD_ROLL_DAMAGE_MAX,
                point_blank_acc: VIBROSWORD_ROLL_POINT_BLANK_ACC,
                ideal_acc: VIBROSWORD_ROLL_IDEAL_ACC,
                max_acc: VIBROSWORD_ROLL_MAX_ACC,
                point_blank_range: VIBROSWORD_ROLL_POINT_BLANK_RANGE_CELLS,
                ideal_range: VIBROSWORD_ROLL_IDEAL_RANGE_CELLS,
                max_range: VIBROSWORD_ROLL_MAX_RANGE_CELLS,
            }),
        },
        AuthorityWeaponId::ScraplineMachete => WeaponProfile {
            id: AuthorityWeaponId::ScraplineMachete,
            default_ammo_type: AuthorityAmmoTypeId::Melee,
            base_damage: 8,
            base_spread_degrees_milli: 0,
            recoil_per_shot_milli: 0,
            recoil_max_milli: 0,
            recoil_decay_milli_per_second: 0,
            recoil_spread_degrees_milli: 0,
            recoil_max_spread_degrees_milli: 0,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1_250,
                damage_min: 4,
                damage_max: 8,
                point_blank_acc: 58,
                ideal_acc: 42,
                max_acc: 8,
                point_blank_range: 1,
                ideal_range: 2,
                max_range: 3,
            }),
        },
        AuthorityWeaponId::FieldSaber => WeaponProfile {
            id: AuthorityWeaponId::FieldSaber,
            default_ammo_type: AuthorityAmmoTypeId::Melee,
            base_damage: 8,
            base_spread_degrees_milli: 0,
            recoil_per_shot_milli: 0,
            recoil_max_milli: 0,
            recoil_decay_milli_per_second: 0,
            recoil_spread_degrees_milli: 0,
            recoil_max_spread_degrees_milli: 0,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1_150,
                damage_min: 5,
                damage_max: 9,
                point_blank_acc: 64,
                ideal_acc: 48,
                max_acc: 12,
                point_blank_range: 1,
                ideal_range: 2,
                max_range: 3,
            }),
        },
        AuthorityWeaponId::QuarryChopper => WeaponProfile {
            id: AuthorityWeaponId::QuarryChopper,
            default_ammo_type: AuthorityAmmoTypeId::Melee,
            base_damage: 10,
            base_spread_degrees_milli: 0,
            recoil_per_shot_milli: 0,
            recoil_max_milli: 0,
            recoil_decay_milli_per_second: 0,
            recoil_spread_degrees_milli: 0,
            recoil_max_spread_degrees_milli: 0,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1_500,
                damage_min: 6,
                damage_max: 11,
                point_blank_acc: 58,
                ideal_acc: 42,
                max_acc: 8,
                point_blank_range: 1,
                ideal_range: 2,
                max_range: 3,
            }),
        },
        AuthorityWeaponId::Unarmed => WeaponProfile {
            id: AuthorityWeaponId::Unarmed,
            default_ammo_type: AuthorityAmmoTypeId::Melee,
            base_damage: 2,
            base_spread_degrees_milli: 0,
            recoil_per_shot_milli: 0,
            recoil_max_milli: 0,
            recoil_decay_milli_per_second: 0,
            recoil_spread_degrees_milli: 0,
            recoil_max_spread_degrees_milli: 0,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1_500,
                damage_min: 1,
                damage_max: 3,
                point_blank_acc: 50,
                ideal_acc: 32,
                max_acc: 5,
                point_blank_range: 1,
                ideal_range: 1,
                max_range: 1,
            }),
        },
        AuthorityWeaponId::WpnPistol => WeaponProfile {
            id: AuthorityWeaponId::WpnPistol,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 8,
            base_spread_degrees_milli: 500,
            recoil_per_shot_milli: 900,
            recoil_max_milli: 5000,
            recoil_decay_milli_per_second: 3800,
            recoil_spread_degrees_milli: 400,
            recoil_max_spread_degrees_milli: 2800,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 500,
                damage_min: 6,
                damage_max: 10,
                point_blank_acc: 55,
                ideal_acc: 40,
                max_acc: 10,
                point_blank_range: 5,
                ideal_range: 14,
                max_range: 30,
            }),
        },
        AuthorityWeaponId::WpnSmg => WeaponProfile {
            id: AuthorityWeaponId::WpnSmg,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 8,
            base_spread_degrees_milli: 600,
            recoil_per_shot_milli: 800,
            recoil_max_milli: 6500,
            recoil_decay_milli_per_second: 4200,
            recoil_spread_degrees_milli: 380,
            recoil_max_spread_degrees_milli: 3200,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 350,
                damage_min: 5,
                damage_max: 9,
                point_blank_acc: 50,
                ideal_acc: 35,
                max_acc: 8,
                point_blank_range: 6,
                ideal_range: 16,
                max_range: 32,
            }),
        },
        // The Kiln is the deliberate late-rifle step below the master-gated Lightning carbine:
        // slower and harder-hitting than the STEN, with the longest stable carbine range.
        AuthorityWeaponId::WpnCarbine => WeaponProfile {
            id: AuthorityWeaponId::WpnCarbine,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 13,
            base_spread_degrees_milli: 220,
            recoil_per_shot_milli: 900,
            recoil_max_milli: 6000,
            recoil_decay_milli_per_second: 3600,
            recoil_spread_degrees_milli: 300,
            recoil_max_spread_degrees_milli: 2600,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 900,
                damage_min: 12,
                damage_max: 18,
                point_blank_acc: 66,
                ideal_acc: 52,
                max_acc: 24,
                point_blank_range: 10,
                ideal_range: 30,
                max_range: 64,
            }),
        },
        AuthorityWeaponId::LightningCarbine => WeaponProfile {
            id: AuthorityWeaponId::LightningCarbine,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 15,
            base_spread_degrees_milli: 160,
            recoil_per_shot_milli: 700,
            recoil_max_milli: 4_500,
            recoil_decay_milli_per_second: 4_400,
            recoil_spread_degrees_milli: 220,
            recoil_max_spread_degrees_milli: 2_000,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 650,
                damage_min: 13,
                damage_max: 19,
                point_blank_acc: 72,
                ideal_acc: 60,
                max_acc: 30,
                point_blank_range: 8,
                ideal_range: 26,
                max_range: 52,
            }),
        },
        AuthorityWeaponId::WpnAssault => WeaponProfile {
            id: AuthorityWeaponId::WpnAssault,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 11,
            base_spread_degrees_milli: 320,
            recoil_per_shot_milli: 1150,
            recoil_max_milli: 7000,
            recoil_decay_milli_per_second: 3400,
            recoil_spread_degrees_milli: 430,
            recoil_max_spread_degrees_milli: 3400,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1000,
                damage_min: 10,
                damage_max: 15,
                point_blank_acc: 62,
                ideal_acc: 47,
                max_acc: 17,
                point_blank_range: 9,
                ideal_range: 26,
                max_range: 58,
            }),
        },
        AuthorityWeaponId::WpnShotgun => WeaponProfile {
            id: AuthorityWeaponId::WpnShotgun,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 16,
            base_spread_degrees_milli: 2500,
            recoil_per_shot_milli: 2600,
            recoil_max_milli: 9000,
            recoil_decay_milli_per_second: 4000,
            recoil_spread_degrees_milli: 1200,
            recoil_max_spread_degrees_milli: 6000,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 900,
                damage_min: 14,
                damage_max: 22,
                point_blank_acc: 70,
                ideal_acc: 30,
                max_acc: 5,
                point_blank_range: 4,
                ideal_range: 10,
                max_range: 18,
            }),
        },
        AuthorityWeaponId::WpnSniper => WeaponProfile {
            id: AuthorityWeaponId::WpnSniper,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 26,
            base_spread_degrees_milli: 40,
            recoil_per_shot_milli: 3000,
            recoil_max_milli: 8000,
            recoil_decay_milli_per_second: 2000,
            recoil_spread_degrees_milli: 300,
            recoil_max_spread_degrees_milli: 2000,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 1600,
                damage_min: 28,
                damage_max: 40,
                point_blank_acc: 80,
                ideal_acc: 70,
                max_acc: 45,
                point_blank_range: 20,
                ideal_range: 60,
                max_range: 110,
            }),
        },
        AuthorityWeaponId::WpnHeavy => WeaponProfile {
            id: AuthorityWeaponId::WpnHeavy,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 12,
            base_spread_degrees_milli: 600,
            recoil_per_shot_milli: 1300,
            recoil_max_milli: 9000,
            recoil_decay_milli_per_second: 3000,
            recoil_spread_degrees_milli: 700,
            recoil_max_spread_degrees_milli: 5000,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 900,
                damage_min: 11,
                damage_max: 16,
                point_blank_acc: 55,
                ideal_acc: 40,
                max_acc: 12,
                point_blank_range: 10,
                ideal_range: 30,
                max_range: 64,
            }),
        },
        AuthorityWeaponId::WpnLauncher => WeaponProfile {
            id: AuthorityWeaponId::WpnLauncher,
            default_ammo_type: AuthorityAmmoTypeId::SlugIron,
            base_damage: 40,
            base_spread_degrees_milli: 200,
            recoil_per_shot_milli: 4000,
            recoil_max_milli: 9000,
            recoil_decay_milli_per_second: 1500,
            recoil_spread_degrees_milli: 500,
            recoil_max_spread_degrees_milli: 3000,
            roll_stats: Some(WeaponRollStats {
                attack_speed_ms: 2000,
                damage_min: 45,
                damage_max: 70,
                point_blank_acc: 65,
                ideal_acc: 55,
                max_acc: 35,
                point_blank_range: 12,
                ideal_range: 34,
                max_range: 70,
            }),
        },
    }
}

pub(super) fn ammo_profile(
    weapon: WeaponProfile,
    ammo_type: Option<AuthorityAmmoTypeId>,
) -> AmmoProfile {
    let normalized = match (weapon.id, ammo_type.unwrap_or(weapon.default_ammo_type)) {
        (
            AuthorityWeaponId::Vibrosword
            | AuthorityWeaponId::ScraplineMachete
            | AuthorityWeaponId::FieldSaber
            | AuthorityWeaponId::QuarryChopper
            | AuthorityWeaponId::Unarmed,
            _,
        ) => AuthorityAmmoTypeId::Melee,
        (
            AuthorityWeaponId::Slugthrower
            | AuthorityWeaponId::WpnPistol
            | AuthorityWeaponId::WpnSmg
            | AuthorityWeaponId::WpnCarbine
            | AuthorityWeaponId::LightningCarbine
            | AuthorityWeaponId::WpnAssault
            | AuthorityWeaponId::WpnShotgun
            | AuthorityWeaponId::WpnSniper
            | AuthorityWeaponId::WpnHeavy
            | AuthorityWeaponId::WpnLauncher,
            AuthorityAmmoTypeId::SlugShard,
        ) => AuthorityAmmoTypeId::SlugShard,
        (
            AuthorityWeaponId::Slugthrower
            | AuthorityWeaponId::WpnPistol
            | AuthorityWeaponId::WpnSmg
            | AuthorityWeaponId::WpnCarbine
            | AuthorityWeaponId::LightningCarbine
            | AuthorityWeaponId::WpnAssault
            | AuthorityWeaponId::WpnShotgun
            | AuthorityWeaponId::WpnSniper
            | AuthorityWeaponId::WpnHeavy
            | AuthorityWeaponId::WpnLauncher,
            AuthorityAmmoTypeId::SlugSpike,
        ) => AuthorityAmmoTypeId::SlugSpike,
        (
            AuthorityWeaponId::Slugthrower
            | AuthorityWeaponId::WpnPistol
            | AuthorityWeaponId::WpnSmg
            | AuthorityWeaponId::WpnCarbine
            | AuthorityWeaponId::LightningCarbine
            | AuthorityWeaponId::WpnAssault
            | AuthorityWeaponId::WpnShotgun
            | AuthorityWeaponId::WpnSniper
            | AuthorityWeaponId::WpnHeavy
            | AuthorityWeaponId::WpnLauncher,
            _,
        ) => AuthorityAmmoTypeId::SlugIron,
    };

    match normalized {
        AuthorityAmmoTypeId::SlugIron => AmmoProfile {
            id: normalized,
            damage_multiplier_per_100: 100,
            sleep: false,
        },
        AuthorityAmmoTypeId::SlugShard => AmmoProfile {
            id: normalized,
            damage_multiplier_per_100: 116,
            sleep: false,
        },
        AuthorityAmmoTypeId::SlugSpike => AmmoProfile {
            id: normalized,
            damage_multiplier_per_100: 90,
            sleep: false,
        },
        AuthorityAmmoTypeId::Melee => AmmoProfile {
            id: normalized,
            damage_multiplier_per_100: 120,
            sleep: false,
        },
    }
}

pub(super) fn melee_attack_interval_ms(base_speed_ms: u64, melee_speed_points: i32) -> u64 {
    let remaining_percent = 100_i32
        .saturating_sub(melee_speed_points.clamp(0, BRAWLER_MELEE_SPEED_POINTS_CAP))
        .clamp(10, 100);
    base_speed_ms
        .saturating_mul(u64::try_from(remaining_percent).expect("melee speed percent is positive"))
        .saturating_div(100)
        .max(MELEE_MIN_ATTACK_INTERVAL_MS)
}

fn resolve_actor_equipped_weapon(
    actor: &ActorAuthorityState,
    requested_weapon_id: Option<AuthorityWeaponId>,
) -> Result<AuthorityWeaponId, AuthorityRejectReason> {
    let equipped_weapon_id = actor
        .equipped_weapon_id
        .ok_or(AuthorityRejectReason::NoWeaponEquipped)?;
    if requested_weapon_id.is_some_and(|requested| requested != equipped_weapon_id) {
        return Err(AuthorityRejectReason::NoWeaponEquipped);
    }
    Ok(equipped_weapon_id)
}

impl SliceAuthorityState {
    pub(super) fn apply_reload(
        &mut self,
        config: &SliceAuthorityConfig,
        weapon_id: Option<AuthorityWeaponId>,
        ammo_type: Option<AuthorityAmmoTypeId>,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(&config.player_actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        let equipped_weapon_id = resolve_actor_equipped_weapon(&actor, weapon_id)?;
        let weapon = weapon_profile(Some(equipped_weapon_id));
        let ammo = ammo_profile(weapon, ammo_type);
        self.start_actor_weapon_reload(&config.player_actor_id, weapon.id, ammo.id)
    }

    pub(super) fn apply_set_equipped_weapon(
        &mut self,
        config: &SliceAuthorityConfig,
        weapon_id: Option<AuthorityWeaponId>,
        weapon_item_id: Option<u32>,
        weapon_variant_id: Option<u32>,
    ) -> Result<(), AuthorityRejectReason> {
        self.set_equipped_weapon_impl(config, weapon_id, weapon_item_id, weapon_variant_id, true)
    }
    pub(super) fn set_equipped_weapon_impl(
        &mut self,
        config: &SliceAuthorityConfig,
        weapon_id: Option<AuthorityWeaponId>,
        weapon_item_id: Option<u32>,
        weapon_variant_id: Option<u32>,
        enforce_cert: bool,
    ) -> Result<(), AuthorityRejectReason> {
        self.set_actor_equipped_weapon_variant_impl(
            &config.player_actor_id,
            weapon_id,
            weapon_item_id,
            weapon_variant_id,
            enforce_cert,
        )
    }

    pub(super) fn set_actor_equipped_weapon_impl(
        &mut self,
        actor_id: &str,
        weapon_id: Option<AuthorityWeaponId>,
        weapon_item_id: Option<u32>,
        enforce_cert: bool,
    ) -> Result<(), AuthorityRejectReason> {
        self.set_actor_equipped_weapon_variant_impl(
            actor_id,
            weapon_id,
            weapon_item_id,
            None,
            enforce_cert,
        )
    }

    pub(super) fn unequip_actor_weapon_if_uncertified(
        &mut self,
        actor_id: &str,
    ) -> Result<bool, AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        let uncertified = actor.equipped_weapon_id.is_some_and(|weapon_id| {
            weapon_cert_requirement_for_variant(
                weapon_id,
                actor.equipped_weapon_item_id,
                actor.equipped_weapon_variant_id,
            )
            .is_some_and(|required_cert| !actor.professions.has_skill_box(required_cert))
        });
        if uncertified {
            self.set_actor_equipped_weapon_impl(actor_id, None, None, false)?;
        }
        Ok(uncertified)
    }

    pub(super) fn set_actor_equipped_weapon_variant_impl(
        &mut self,
        actor_id: &str,
        weapon_id: Option<AuthorityWeaponId>,
        weapon_item_id: Option<u32>,
        weapon_variant_id: Option<u32>,
        enforce_cert: bool,
    ) -> Result<(), AuthorityRejectReason> {
        let actor = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?
            .clone();
        if actor.life_state != AuthorityLifeState::Alive {
            return Err(AuthorityRejectReason::ActorNotAlive);
        }
        if actor.sleep.remaining_ticks > 0 {
            return Err(AuthorityRejectReason::ActorAsleep);
        }
        if weapon_id.is_none() && actor.equipped_weapon_item_id == 0 {
            self.materialize_pre_itemized_equipped_weapon_inventory_item(&actor);
        }
        let (equipped_weapon_id, equipped_weapon_item_id, equipped_weapon_variant_id) =
            match weapon_item_id.filter(|item_id| *item_id != 0) {
                Some(item_id) => {
                    let item_weapon_id = weapon_id_for_inventory_item(item_id)
                        .ok_or(AuthorityRejectReason::UnknownItem)?;
                    if weapon_id.is_some_and(|requested| requested != item_weapon_id) {
                        return Err(AuthorityRejectReason::NoWeaponEquipped);
                    }
                    let resolved_variant = weapon_variant_id
                        .or_else(|| {
                            self.runtime
                                .durable
                                .inventory
                                .iter()
                                .filter(|row| {
                                    row.item_id == item_id
                                        && row.quantity > 0
                                        && actor_owns_inventory_container(actor_id, &row.container)
                                })
                                .map(|row| row.variant_id)
                                .min()
                        })
                        .ok_or(AuthorityRejectReason::ItemUnavailable)?;
                    if self.actor_inventory_available_variant(actor_id, item_id, resolved_variant)
                        == 0
                    {
                        return Err(AuthorityRejectReason::ItemUnavailable);
                    }
                    (Some(item_weapon_id), item_id, resolved_variant)
                }
                None => (weapon_id, 0, 0),
            };
        if enforce_cert {
            if let Some(weapon_id) = equipped_weapon_id {
                if let Some(required_cert) = weapon_cert_requirement_for_variant(
                    weapon_id,
                    equipped_weapon_item_id,
                    equipped_weapon_variant_id,
                ) {
                    if !actor.professions.has_skill_box(required_cert) {
                        return Err(AuthorityRejectReason::WeaponNotCertified);
                    }
                }
            }
        }
        let actor = self
            .runtime
            .durable
            .actors
            .get_mut(actor_id)
            .ok_or(AuthorityRejectReason::UnknownActor)?;
        if actor.equipped_weapon_id != equipped_weapon_id {
            actor.combat_queue = AbilityQueue::default();
        }
        actor.equipped_weapon_id = equipped_weapon_id;
        actor.equipped_weapon_item_id = equipped_weapon_item_id;
        actor.equipped_weapon_variant_id = equipped_weapon_variant_id;
        if equipped_weapon_id.is_none() {
            actor.next_fire_tick = 0;
        }
        actor.weapon_recoil_heat_milli = 0;
        actor.weapon_recoil_last_tick = self.runtime.durable.tick;
        Ok(())
    }

    fn materialize_pre_itemized_equipped_weapon_inventory_item(
        &mut self,
        actor: &ActorAuthorityState,
    ) {
        let Some(item_id) = actor
            .equipped_weapon_id
            .and_then(canonical_inventory_item_for_weapon_id)
        else {
            return;
        };
        if self.runtime.durable.inventory.iter().any(|row| {
            actor_owns_inventory_container(&actor.id, &row.container)
                && row.item_id == item_id
                && row.quantity > 0
        }) {
            return;
        }
        let container = format!("{}:field-pack", actor.id);
        let stack_id = self.next_inventory_stack_id(&container);
        self.runtime.durable.inventory.push(InventoryStackSnapshot {
            stack_id,
            container,
            item: inventory_item_name(item_id)
                .expect("canonical weapon inventory item has a display name")
                .to_owned(),
            item_id,
            variant_id: 0,
            quantity: 1,
            reserved: 0,
            available: 1,
        });
    }

    pub(super) fn crafted_melee_weapon_base_speed_ms(
        &self,
        actor: &ActorAuthorityState,
        weapon_id: AuthorityWeaponId,
    ) -> Option<u64> {
        if !is_melee_weapon_id(weapon_id) {
            return None;
        }
        decode_melee_weapon_speed_variant_ms(actor.equipped_weapon_variant_id)
    }

    pub(super) fn melee_weapon_base_attack_speed_ms_for_actor(
        &self,
        actor: &ActorAuthorityState,
        weapon: WeaponProfile,
    ) -> u64 {
        self.crafted_melee_weapon_base_speed_ms(actor, weapon.id)
            .or_else(|| weapon.roll_stats.map(|stats| stats.attack_speed_ms))
            .expect("current weapons define Roll attack speed")
    }

    pub(super) fn melee_attack_interval_ms_for_actor(
        &self,
        actor: &ActorAuthorityState,
        weapon: WeaponProfile,
    ) -> u64 {
        melee_attack_interval_ms(
            self.melee_weapon_base_attack_speed_ms_for_actor(actor, weapon),
            actor.professions.brawler_melee_speed_points(),
        )
    }

    pub(super) fn melee_attack_interval_ticks_for_actor(
        &self,
        actor: &ActorAuthorityState,
        weapon: WeaponProfile,
    ) -> u64 {
        ms_to_ticks_round(
            self.melee_attack_interval_ms_for_actor(actor, weapon),
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1)
    }

    pub(super) fn apply_suppression_to_actor(
        &mut self,
        actor_id: &str,
        amount_milli: i32,
        source: AuthorityPosition,
    ) {
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return;
        };
        if actor.life_state != AuthorityLifeState::Alive {
            return;
        }
        let before = actor.suppression.pressure_milli;
        let threshold = suppression_threshold_milli_for_actor(actor);
        let skirmisher_cover_pressure = match actor.ai.as_ref() {
            Some(AuthorityAiState::Skirmisher(_)) => {
                Some(skirmisher_profile_for_ai_state(actor).cover_pressure_milli)
            }
            _ => None,
        };
        actor.suppression.pressure_milli = actor
            .suppression
            .pressure_milli
            .saturating_add(amount_milli)
            .clamp(0, SUPPRESSION_MAX_PRESSURE_MILLI);
        actor.suppression.source = Some(source);
        if amount_milli > 0 && actor_can_use_personal_shield(actor) {
            if let Some(shield) = actor.personal_shield.as_mut() {
                shield.last_damage_tick = self.runtime.durable.tick;
            }
        }
        let pressure_after = actor.suppression.pressure_milli;
        let crossed_panic_threshold = before < threshold && pressure_after >= threshold;
        let crossed_skirmisher_cover = skirmisher_cover_pressure.is_some_and(|cover_pressure| {
            before < cover_pressure && pressure_after >= cover_pressure
        });
        let spirit_drain = suppression_spirit_drain_for_actor(amount_milli, actor);
        apply_vital_damage(&mut actor.vitals.spirit, spirit_drain);
        let panic_ticks = suppression_panic_ticks_for_actor(actor, threshold);
        if crossed_panic_threshold || crossed_skirmisher_cover {
            match actor.ai.as_mut() {
                Some(AuthorityAiState::PassiveCreature(ai)) if crossed_panic_threshold => {
                    if ai.mode == PassiveCreatureMode::Engage {
                        // Engaged Gaia danger holds the chase; suppression only
                        // refreshes the spatial threat cue used for escape paths.
                        ai.threat = Some(source);
                        if ai.next_update_tick > self.runtime.durable.tick {
                            ai.next_update_tick = self.runtime.durable.tick;
                        }
                    } else {
                        ai.mode = PassiveCreatureMode::Flee;
                        ai.threat = Some(source);
                        ai.threat_actor_id = None;
                        ai.chase_until_tick = 0;
                        ai.panic_until_tick = ai
                            .panic_until_tick
                            .max(self.runtime.durable.tick.saturating_add(panic_ticks));
                        ai.target = None;
                        ai.next_decision_tick = self.runtime.durable.tick;
                        ai.next_update_tick = self.runtime.durable.tick;
                        ai.last_update_tick = self.runtime.durable.tick;
                    }
                }
                Some(AuthorityAiState::Skirmisher(ai)) if crossed_skirmisher_cover => {
                    if ai.cover.is_some() {
                        ai.mode = SkirmisherMode::HoldCover;
                    } else {
                        ai.mode = SkirmisherMode::SeekCover;
                        ai.target = None;
                    }
                    ai.next_decision_tick = self.runtime.durable.tick;
                    ai.next_update_tick = self.runtime.durable.tick;
                    ai.last_update_tick = self
                        .runtime
                        .durable
                        .tick
                        .saturating_sub(AI_UPDATE_CADENCE_TICKS);
                }
                _ => {}
            }
        }
    }

    pub(super) fn try_block_with_personal_shield(
        target: &mut ActorAuthorityState,
        tick: u64,
        tick_rate_hz: u32,
        incoming_damage: i32,
    ) -> Option<PersonalShieldBlockOutcome> {
        if !actor_can_use_personal_shield(target) {
            return None;
        }
        let shield = target.personal_shield.as_mut()?;
        if shield.charge_milli < PERSONAL_SHIELD_MIN_BLOCK_CHARGE_COST_MILLI {
            shield.last_damage_tick = tick;
            if shield.charge_milli == 0 && shield.durability_milli == 0 {
                target.personal_shield = None;
            }
            return None;
        }
        let available_hit_points = shield.charge_milli / PERSONAL_SHIELD_HIT_POINT_MILLI;
        let requested_hit_points = u32::try_from(incoming_damage.max(0))
            .unwrap_or(u32::MAX)
            .max(1);
        let spent_hit_points = requested_hit_points.min(available_hit_points);
        let absorbed_damage = if incoming_damage > 0 {
            i32::try_from(spent_hit_points).unwrap_or(i32::MAX)
        } else {
            0
        };
        let damage_after_shield = incoming_damage.saturating_sub(absorbed_damage).max(0);
        shield.charge_milli = shield
            .charge_milli
            .saturating_sub(spent_hit_points.saturating_mul(PERSONAL_SHIELD_HIT_POINT_MILLI));
        shield.durability_charges =
            personal_shield_durability_charges_from_milli(shield.durability_milli);
        shield.last_damage_tick = tick;
        shield.last_block_tick = tick;
        let remaining_hit_points = personal_shield_hit_points_from_charge(shield.charge_milli);
        let recharge_delay_ticks =
            ms_to_ticks_round(PERSONAL_SHIELD_RECHARGE_DELAY_MS, tick_rate_hz).max(1);
        if shield.charge_milli == 0 && shield.durability_milli == 0 {
            target.personal_shield = None;
        }
        Some(PersonalShieldBlockOutcome {
            damage_after_shield,
            effect: AuthorityCombatEffectSnapshot {
                kind: "shield".to_owned(),
                stacks: u8::try_from(remaining_hit_points).unwrap_or(u8::MAX),
                threshold: u8::try_from(PERSONAL_SHIELD_MAX_HIT_POINTS).unwrap_or(u8::MAX),
                remaining_ticks: u16::try_from(recharge_delay_ticks).unwrap_or(u16::MAX),
            },
        })
    }

    pub(super) fn record_personal_shield_damage_seen(target: &mut ActorAuthorityState, tick: u64) {
        if !actor_can_use_personal_shield(target) {
            return;
        }
        if let Some(shield) = target.personal_shield.as_mut() {
            shield.last_damage_tick = tick;
            if shield.charge_milli == 0 && shield.durability_milli == 0 {
                target.personal_shield = None;
            }
        }
    }

    pub(super) fn record_combat_event_stats(&mut self, event: &AuthorityCombatEventSnapshot) {
        self.record_damage_stats(
            &event.shooter_actor_id,
            &event.target_actor_id,
            event.tick,
            event.damage,
            true,
        );
        let target_player_like = self
            .runtime
            .durable
            .actors
            .get(&event.target_actor_id)
            .is_some_and(|actor| is_player_like_role(&actor.role));
        let defeated = event.lifecycle == AuthorityCombatLifecycleKind::Killed
            || (target_player_like && event.lifecycle == AuthorityCombatLifecycleKind::Downed);
        if !defeated {
            return;
        }
        if let Some(shooter) = self.runtime.durable.actors.get_mut(&event.shooter_actor_id) {
            shooter.stats.record_kill(
                event.tick,
                self.runtime.durable.world.tick_rate_hz,
                target_player_like,
            );
        }
        if let Some(target) = self.runtime.durable.actors.get_mut(&event.target_actor_id) {
            target.stats.record_death(
                event.tick,
                self.runtime.durable.world.tick_rate_hz,
                ActorDeathStats {
                    tick: event.tick,
                    killer_actor_id: event.shooter_actor_id.clone(),
                    cause: event.lifecycle_cause.clone(),
                    weapon_id: event.weapon_id,
                    ammo_type: event.ammo_type,
                },
            );
        }
        if event.lifecycle == AuthorityCombatLifecycleKind::Killed {
            self.finalize_actor_corpse_after_death(&event.target_actor_id, event.tick);
        }
    }

    pub(super) fn record_damage_stats(
        &mut self,
        source_actor_id: &str,
        target_actor_id: &str,
        tick: u64,
        damage: i32,
        count_hit: bool,
    ) {
        let source_is_human_player = self
            .runtime
            .durable
            .actors
            .get(source_actor_id)
            .is_some_and(is_human_player_actor);
        // Duel damage never accrues loot rights or kill XP: an honorable end
        // yields no spoils. Since human-vs-human damage is duel-scoped, this is
        // the whole of player-vs-player loot suppression.
        let duel_damage =
            source_is_human_player && self.actors_in_active_duel(source_actor_id, target_actor_id);
        if let Some(source) = self.runtime.durable.actors.get_mut(source_actor_id) {
            if count_hit {
                source
                    .stats
                    .record_hit_dealt(tick, self.runtime.durable.world.tick_rate_hz);
            }
            source
                .stats
                .record_damage_dealt(tick, self.runtime.durable.world.tick_rate_hz, damage);
        }
        let player_damage = if source_is_human_player && damage > 0 && !duel_damage {
            Some(u32::try_from(damage).unwrap_or(u32::MAX))
        } else {
            None
        };
        if let Some(target) = self.runtime.durable.actors.get_mut(target_actor_id) {
            if count_hit {
                target
                    .stats
                    .record_hit_taken(tick, self.runtime.durable.world.tick_rate_hz);
            }
            target
                .stats
                .record_damage_taken(tick, self.runtime.durable.world.tick_rate_hz, damage);
            if let Some(player_damage) = player_damage {
                Self::record_player_damage_for_loot_rights(
                    target,
                    source_actor_id,
                    tick,
                    player_damage,
                );
            }
        }
    }
}
