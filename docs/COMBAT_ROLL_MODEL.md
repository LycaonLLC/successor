# Combat Roll Model

Status: active combat contract for the generated world.

## Authority

Players submit `QueueCombatAction` with an action id and authoritative target
id. Rust validates target state, relation, range, line/cover rules, equipment,
resources, cooldown, and queue capacity before resolving the action. Clients do
not submit hit positions or damage.

The current player-facing ranged action is the weapon-neutral Attack verb,
resolved as `basic_shot` for the equipped Slugthrower path. The queue is per
actor, has a small fixed capacity, and drains on authority ticks. Melee weapons
use the same command and queue vocabulary with their own profiles.

## Ranged burst

A Slugthrower attack resolves as a six-pellet burst. Each pellet makes its own
deterministic accuracy and defense roll and emits a `ranged_roll` event with a
hit, miss, or dodge outcome. Damage, mitigation, resource cost, engagement,
cooldown, and life-state changes are all authority results.

Exact damage, range bands, cadence, accuracy, and defense constants live in
`crates/successor-sim/src/authority/combat_roll.rs` and its content tables.
Tests, rather than copied values in prose, own balance regression proof.

## Client presentation

The streamed roll event is the source for graphical tracers, muzzle movement,
impacts, particles, sound, and outcome text. Cosmetic bolts do not collide and
cannot cause damage. The shared `ROLL_BURST_STAGGER_MS` cadence keeps visual and
audio beats aligned.

The terminal client narrates the same outcomes and queue state. A result must
remain understandable without particles, positional audio, or color.

## Targeting and action entry

In the 3D client:

- left click selects an actor;
- right click selects and opens the context radial;
- double left click invokes the eligible default action;
- the toolbar, ability browser, radial, and slash command converge on the same
  authority command;
- clicking empty ground does not attack.

The server remains responsible for whether an attack is legal when it arrives.
Local affordances and disabled reasons are guidance, not permission.

## NPC behavior

Rogue troopers use deterministic perception, movement, cover, target, and
combat rules. They acquire legal targets and enqueue through the same roll
resolver. Gaia wildlife is attackable, roams while calm, and flees when harmed
or suppressed; it does not use a separate combat model.

Population and lifecycle tuning comes from the generated open-desert fixture.
Unit tests may use neutral authority builders but do not define another product
world.

## Combat, death, and recovery

Attacking, taking damage, and retaliation update authoritative engagement and
combat state. The 3D client uses that state for weapon draw/stow, facing,
nameplates, HUD, and effects.

Downing, bleeding, death, corpse eligibility, revival, cloning, sickness, and
loot/harvest state are authority-owned. `CloneRespawn` selects a valid projected
facility or the nearest valid facility when omitted. Both clients show the same
life state and remaining authority time.

## Verification

Focused Rust tests own roll math and life-state invariants. Shared-client tests
own event reduction and command construction. The 3D and TUI journeys prove
presentation and command transport through the real server bridge. See
`VERIFICATION.md` for current commands.
