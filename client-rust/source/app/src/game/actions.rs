//! Public gameplay action path.
//!
//! UI, keyboard and pointer handlers describe intent with `GameplayAction`; this
//! module is the only place that turns an accepted intent into an authority
//! command.  It deliberately has no projection mutation or local prediction.

use successor_net::ClientCommand;

use super::command_queue::CommandQueue;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameplayAction {
    Attack {
        action_id: String,
        target_actor_id: String,
    },
    Peace,
    CancelAbilityQueue {
        queue_entry_id: Option<String>,
    },
    Reload {
        weapon_id: Option<String>,
        ammo_type: Option<String>,
    },
    UseConsumable {
        item_id: String,
    },
    EquipWeapon {
        weapon_id: Option<String>,
    },
    SetPosture {
        posture: String,
    },
    Revive {
        target_actor_id: String,
    },
    Stabilize {
        target_actor_id: String,
    },
    CloneRespawn {
        facility_id: Option<String>,
    },
    EnterTransition {
        transition_id: String,
    },
    ToggleDoor {
        prop_id: String,
    },
    Interact {
        verb: String,
        target_id: String,
    },
    Move {
        dx: i32,
        dy: i32,
        facing: Option<successor_net::CardinalDirection>,
        sprint: bool,
    },
    Stop,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DisabledVerb {
    pub id: &'static str,
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VerbContext {
    pub has_target: bool,
    pub target_alive: bool,
    pub in_combat: bool,
    pub can_act: bool,
    pub in_range: bool,
    pub has_weapon: bool,
    pub can_reload: bool,
    pub can_revive: bool,
    pub can_transition: bool,
}

/// The same registry drives radial menus, action browser and keyboard verbs.
/// Disabled entries are retained so the UI can present the server-derived
/// reason rather than silently dropping a click.
pub fn verbs(ctx: VerbContext) -> Vec<Result<&'static str, DisabledVerb>> {
    let mut out = Vec::with_capacity(8);
    out.push(
        if ctx.can_act && ctx.has_target && ctx.target_alive && ctx.in_range && ctx.has_weapon {
            Ok("attack")
        } else {
            Err(DisabledVerb {
                id: "attack",
                reason: gate_reason(ctx, "attack"),
            })
        },
    );
    out.push(if ctx.can_act {
        Ok("peace")
    } else {
        Err(DisabledVerb {
            id: "peace",
            reason: "actor cannot act".into(),
        })
    });
    out.push(if ctx.can_act && ctx.has_weapon && ctx.can_reload {
        Ok("reload")
    } else {
        Err(DisabledVerb {
            id: "reload",
            reason: if !ctx.has_weapon {
                "no weapon equipped".into()
            } else {
                "reload unavailable".into()
            },
        })
    });
    out.push(
        if ctx.can_act && ctx.has_target && ctx.in_range && ctx.can_revive {
            Ok("revive")
        } else {
            Err(DisabledVerb {
                id: "revive",
                reason: "revive unavailable at target".into(),
            })
        },
    );
    out.push(if ctx.can_act && ctx.can_transition {
        Ok("transition")
    } else {
        Err(DisabledVerb {
            id: "transition",
            reason: "transition unavailable".into(),
        })
    });
    out
}

fn gate_reason(ctx: VerbContext, _verb: &str) -> String {
    if !ctx.can_act {
        return "actor cannot act".into();
    }
    if !ctx.has_target {
        return "no target selected".into();
    }
    if !ctx.in_range {
        return "target out of range".into();
    }
    if !ctx.target_alive {
        return "target is not alive".into();
    }
    if !ctx.has_weapon {
        return "no weapon equipped".into();
    }
    "unavailable".into()
}

/// Convert an accepted public action to the exact shared wire command.
pub fn command_for(action: GameplayAction) -> Option<ClientCommand> {
    Some(match action {
        GameplayAction::Attack {
            action_id,
            target_actor_id,
        } => ClientCommand::QueueCombatAction {
            action_id,
            target_actor_id,
        },
        GameplayAction::Peace => ClientCommand::Peace {},
        GameplayAction::CancelAbilityQueue { queue_entry_id } => {
            ClientCommand::CancelAbilityQueue {
                queue_entry_id,
                scope: None,
            }
        }
        GameplayAction::Reload {
            weapon_id,
            ammo_type,
        } => ClientCommand::ReloadWeapon {
            weapon_id: weapon_id.and_then(|v| serde_json::from_str(&format!("\"{}\"", v)).ok()),
            ammo_type: ammo_type.and_then(|v| serde_json::from_str(&format!("\"{}\"", v)).ok()),
        },
        GameplayAction::UseConsumable { item_id } => ClientCommand::UseConsumable {
            item_id,
            item_numeric_id: None,
            variant_id: None,
        },

        GameplayAction::EquipWeapon { weapon_id } => ClientCommand::SetEquippedWeapon {
            weapon_id: weapon_id.and_then(|v| serde_json::from_str(&format!("\"{}\"", v)).ok()),
            weapon_item_id: None,
            weapon_variant_id: None,
        },
        GameplayAction::SetPosture { posture } => ClientCommand::SetPosture { posture },
        GameplayAction::Revive { target_actor_id }
        | GameplayAction::Stabilize { target_actor_id } => {
            ClientCommand::ReviveActor { target_actor_id }
        }
        GameplayAction::CloneRespawn { facility_id } => ClientCommand::CloneRespawn { facility_id },
        GameplayAction::EnterTransition { transition_id } => {
            ClientCommand::EnterTransition { transition_id }
        }
        GameplayAction::ToggleDoor { prop_id } => ClientCommand::ToggleDoor { prop_id },
        GameplayAction::Interact { verb, target_id } => {
            // Public verbs share the authority action queue; terminal/door/
            // transition verbs are normalized below.
            return interaction_command(&verb, target_id);
        }
        GameplayAction::Move {
            dx,
            dy,
            facing,
            sprint,
        } => ClientCommand::SetMoveIntent {
            dx,
            dy,
            facing,
            sprint,
        },
        GameplayAction::Stop => ClientCommand::SetMoveIntent {
            dx: 0,
            dy: 0,
            facing: None,
            sprint: false,
        },
    })
}

/// Enqueue an accepted action; callers only receive the id and never mutate
/// authority-owned state locally. Receipts settle this id through the queue.
pub fn enqueue_action(
    queue: &mut CommandQueue,
    action: GameplayAction,
    issued_at_tick: u64,
) -> Option<u64> {
    command_for(action).map(|command| queue.enqueue(command, issued_at_tick))
}

fn interaction_command(verb: &str, target_id: String) -> Option<ClientCommand> {
    match verb {
        "transition" => Some(ClientCommand::EnterTransition {
            transition_id: target_id,
        }),
        "door" => Some(ClientCommand::ToggleDoor { prop_id: target_id }),
        "revive" | "stabilize" => Some(ClientCommand::ReviveActor {
            target_actor_id: target_id,
        }),
        _ => Some(ClientCommand::QueueCombatAction {
            action_id: verb.to_owned(),
            target_actor_id: target_id,
        }),
    }
}

/// Queue result used by windows and HUD. Rejections are retained by the host
/// for presentation; no authority-owned value is changed here.
#[derive(Clone, Debug, PartialEq)]
pub enum DispatchOutcome {
    Queued(u64),
    Local(crate::windows::WindowLocalAction),
    Rejected(String),
}

pub fn enqueue_window_action(
    queue: &mut CommandQueue,
    action: crate::windows::WindowAction,
    issued_at_tick: u64,
) -> DispatchOutcome {
    match action.resolve() {
        crate::windows::WindowActionResult::Command(command) => {
            DispatchOutcome::Queued(queue.enqueue(command, issued_at_tick))
        }
        crate::windows::WindowActionResult::Local(local) => DispatchOutcome::Local(local),
        crate::windows::WindowActionResult::Rejected(reason) => DispatchOutcome::Rejected(reason),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_verbs_keep_reason() {
        let v = verbs(VerbContext::default());
        assert!(matches!(&v[0], Err(e) if e.reason == "actor cannot act"));
    }
    #[test]
    fn attack_maps_without_projection_mutation() {
        assert!(matches!(
            command_for(GameplayAction::Attack {
                action_id: "fire".into(),
                target_actor_id: "a".into()
            }),
            Some(ClientCommand::QueueCombatAction { .. })
        ));
    }
}
