# Successor In-Game UI

Status: active interaction and presentation contract for the graphical and
terminal clients.

## Shared semantics

The clients may arrange information differently, but these meanings stay
aligned:

- current actor, target, relation, life state, posture, and combat state;
- health, action, spirit, shield, cooldown, and queued action state;
- command names, eligibility, rejection reasons, and server receipts;
- inventory containers, equipment slots, quantities, variants, and item stats;
- chat channels, group state, interaction verbs, and world/system events.

Shared semantics belong in `client/`. Graphical DOM/Three.js code belongs in
`client-3d/`; terminal layout and prose belong in `client-tui/`.

## Graphical interaction model

The 3D client uses one visible cursor. Left click selects. Right click opens the
context radial. Double left click invokes the default action when eligible.
Keyboard movement remains available while non-modal windows are open unless a
text field owns the keystroke.

The target plate, world bracket, nameplate, interaction chip, radial menu, and
examine window all derive from the same target and relation state. A disabled
verb remains visibly disabled with a short reason; it does not fail silently.

The nearest/highest-priority interaction appears as a compact chip. `F` invokes
its default verb. Doors, trainers, corpses, caches, terminals, plots, extractors,
and placed structures use server-projected state to choose that verb.

## HUD

The default HUD keeps the world readable. Persistent elements are limited to:

- player vitals and status;
- target plate when a target exists;
- compact combat queue/feedback;
- chat;
- toolbar slots;
- radar and interaction chip where useful.

Use icons, bars, short labels, and hover detail. Avoid permanent paragraphs and
large decorative frames. State changes must work without color alone.

The toolbar starts from authoritative ability eligibility and persisted player
placement. Activating a slot sends the same command as the ability browser or
slash-command path.

## Windows

Current window families include inventory/paper doll, item and target examine,
loot, crafting, professions, survey, extraction, camp, trade, travel, datapad,
macros, splice workbench, group/social surfaces, and options.

Windows are draggable, closeable, and non-modal unless a confirmation or
quantity choice must block its own action. Opening a window does not pause world
simulation. Stale server state closes or disables the affected control instead
of preserving a local fiction.

Inventory uses 3D turntables for authored items and standardized procedural
containers for resources and ammunition. Equipment changes update the paper
doll and world pawn from streamed worn state. Drag/drop and quantity operations
send authority commands and wait for the resulting inventory patch.

## Combat feedback

Combat presentation follows streamed roll events. The graphical client may
stagger muzzle, tracer, impact, audio, and outcome beats for readability, but it
uses the shared cadence constant and does not resolve a hit locally.

Targeting, attack eligibility, range feedback, damage, dodge/miss text, downed
state, corpse interaction, revival, and cloning all follow authority state.
Effects should remain readable during movement and at normal zoom.

## World and weather UI

World labels and icons must survive terrain color, time-of-day grade, fog,
weather, and particles. Important interaction state takes priority over ambient
presentation. Map, radar, travel, waypoint, survey, and extraction views use
the same area ids and coordinates as the shared world projection.

## Terminal client

The TUI treats prose as the primary world view. Its full-screen layout carries
log, chat/input, vitals, weapon/queue, target, group, and radar information. In
plain mode it emits line-oriented output suitable for pipes, screen readers,
and limited terminals.

Typing sends chat; slash-prefixed input sends game or chat commands. Empty-line
WASD movement, stop, target, examine, interact, attack, inventory, craft, and
survey commands use the same eligibility and authority path as the graphical
client.

Terminal color and symbols are helpful but optional. Every important state must
remain legible without color, mouse input, Unicode width assumptions, DOM, or
GPU access.

## Accessibility and input ownership

- Text inputs own printable keys only while focused.
- Escape closes the top local surface before affecting the game window.
- Rebinding and settings must persist without changing server truth.
- Focus, selection, disabled, danger, and success states need shape/text cues in
  addition to color.
- Motion-heavy feedback should respect reduced-motion settings where practical.
- The desktop shell owns application/window chords; the game client owns game
  input once the page is focused.

## Verification

UI changes require the focused unit tests plus the appropriate journey suite.
Authority-facing changes must prove command receipt and projected state, not
only DOM text or a screenshot. Graphical changes should be checked through the
desktop build when they affect packaged runtime code or assets.
