# Successor — Product Contract

**Register:** product.

**Product:** Successor — a persistent social survival MMO. One deterministic
Rust authority owns the world; two clients present it. Long travel, dangerous
encounters, practical settlements, equipment, resource discovery, crafting,
trade, farming, and recovery after defeat. People live at a scavenged human
scale inside a landscape shaped by ancient work they cannot reproduce.

**Audience:** players who want a world that keeps mattering between sessions —
distance, routes, materials, professions, and other people are the content.
They tolerate friction when it is honest; they do not tolerate outcomes the
server did not produce.

**Player promise:**

- The world is continuous enough for distance, routes, and landmarks to matter.
- Combat is readable and server-authoritative, with room to choose, flee,
  recover, and prepare.
- Resources differ by origin; crafted objects remember the materials and
  decisions that made them.
- Equipment, professions, farms, trade, groups, and settlements create reasons
  for players to depend on one another.
- Defeat changes the situation without ending the character's story.
- Every supported client exposes the same world and the same authority.

**Supported clients:** the graphical client (`client-3d/`, isometric Three.js
presentation) and the terminal client (`client-tui/`, full-screen and plain
terminal presentation). Both submit the same commands and render the same
authoritative state. There is no third visual client.

**Authority boundary:** gameplay truth — movement, combat, life state,
inventory, resources, crafting, professions, farming, trade, NPC behavior —
resolves in the deterministic Rust simulation under `crates/successor-sim/`.
Clients and the TypeScript server transport, project, and present; they may
predict or animate, but they never make gameplay results true.

**World and content standard:** the default world establishes the range —
exposed travel, sparse human footholds, wildlife ecologies, rogue danger,
extractable resources, and structures large enough to orient a journey. New
areas extend those systemic relationships instead of becoming disconnected
theme parks. A model, sound, recipe, item, or system joins the player promise
only when the supported runtime selects it and a focused proof covers the
path; source and catalog work is preserved without being called finished play.

**Tone:** practical, dry, worn, strange, social, occasionally funny. Things
are named for use, superstition, or local habit; settlements feel occupied
rather than staged. No generic military futurism, no pristine space-opera
surfaces, no decorative technobabble, no copy that explains a system before
the world demonstrates it. Developer vocabulary never reaches player-facing
text.

**Ownership:**

- This file owns repository-wide product intent.
- `docs/PRODUCT_IDENTITY_BIBLE.md` owns the deeper product identity —
  premise, system identity, world identity.
- `docs/CANONICAL_CONTEXT.md` owns architecture, topology, and current
  supported behavior.
- `client-3d/PRODUCT.md` and `client-3d/DESIGN.md` own the graphical client's
  interaction model and design constitution.
- Exact fixtures, hashes, versions, and proof commands are implementation
  state, documented where the architecture and verification docs own them —
  never here.
