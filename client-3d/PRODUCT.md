# Successor — 3D Client

**Register:** product.

**Product:** Successor 3D client — an isometric MMO client. Three.js owns the
headed world presentation and a PS2-era post pass, while deterministic Rust
authority owns simulation and outcomes. The DOM UI floats above the world.

**Audience:** players in combat flow. They are mid-fight or seconds away from one:
target acquisition, ammo state, and health must read instantly; management surfaces
(inventory, skills, options) must never take the world away from them.

**Scene:** dark room, evening session, fast target acquisition. Dark theme is FORCED —
there is no light mode; every chrome surface derives from the near-black `--sc3d-*`
theme palettes (signal / phosphor / amber / oxide).

**Core interaction model:** single-cursor input mode (no pointer lock, Alt toggle, or crosshair combat mode) with the cursor always visible from boot. Windows, dock, and HUD are visible from boot.

- **Interaction & Click Grammar:** Left-click on an actor targets it (bracket only). Right-click on an actor targets and opens the context radial menu (Attack default on attackables, Examine secondary; Examine default + disabled Attack on non-attackables). Double-left runs the default action. Left-click on empty ground clears selection and walks the pawn there (brass ground marker; any movement key takes back control). Right-click-hold on empty ground locks facing to strafe. X (or the HUD RUN button) toggles persistent run; when winded, the pawn walks until Action refills, then run resumes on its own.
- **Firing:** Only executable via double-click, the toolbar Attack ability, or radial Attack. Free-fire and Space-bar firing are removed. WASD still moves — play continues while managing window overlays.
- **Crafting — FIELD BENCH (binding):** the craft window is a compact five-stage bench rail (SCHEMATIC · LOAD · ASSEMBLE · TUNE · FINISH) floating over the live world — it never takes the world away. Material slots read as tactile wells with registered SVG purpose vectors (unknown vocabulary fails closed to a generic vector, never letters). Property rails show the exact authority current value and material cap (pin + caret) plus the exact hold/slip odds from the server's per-line risk fields; line milli is normalized goodness, so direction language is the neutral "toward cap · better" — never invented rolls or per-stat direction guesses. Each stage has one obvious primary action. Assembly and completion land as a calm settle line / short toast (no grade-stamp theater; reduced motion bypasses the beats). FINISH exits: PROTOTYPE with an optional 1–48-char custom name (empty keeps the schematic name), PRACTICE (+5% base XP, materials spent, no item), or a limited-use DRAFT SCHEMATIC (uses ≤1000).

**Copy principle (owner directive, binding):** icon-first, visual-first,
reading-second. Chrome text is minimal short nouns; explanations live in hover
tooltips. Disabled states show a glyph; the reason appears on hover. Chrome and item
descriptions use the current Successor vocabulary; plain-noun item names pass through.
