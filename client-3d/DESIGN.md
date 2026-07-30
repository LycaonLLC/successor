# Successor 3D — Design Constitution

Binding rules for the DOM and Three.js surfaces in `client-3d`. See
`../docs/PRODUCT_IDENTITY_BIBLE.md` for product tone and audience.

## The journey lens (owner directive 2026-07-02, binding on EVERYTHING)

Never just "does the thing work". Every feature — every window, verb, HUD pane,
world interaction — must answer, in its spec and its review:

1. **Before** — what does the player do immediately before this? How did they
   find it?
2. **During** — what happens, moment to moment? How does the whole flow look
   and feel?
3. **After** — what happens next? What changed in the world, and how does the
   player see that it changed?
4. **Action count** — how many clicks/keys start-to-finish? Can one go away?
5. **Intuition** — would a player who read nothing get it? What about the game
   NATURALLY teaches it (placement, motion, an NPC doing it visibly, a glyph)?

Corollaries: no dev copy ever reaches a player (server reasonCodes get
player-language mappings); systems teach themselves diegetically — the world
demonstrates its mechanics before any text explains them.

## Window chrome — hairline HUD-glass

- 1px hairline border (`--sc3d-hairline`).
- Translucent near-black glass backing: `--sc3d-glass` =
  `color-mix(in srgb, var(--sc3d-bg-panel) 72%, transparent)` +
  `backdrop-filter: blur(3px)`. The world stays readable through windows.
- Slim 22px title strip: icon + short-noun title + ✕. Title strip is the drag handle.
- Focused window: accent underline on the title strip + full-opacity hairline.
  Unfocused: hairline at 60%.
- Esc or ✕ **fully closes** (removed from the open set); bounds persist for the
  next open. (The Alt-hide visibility layer is retired with the mode system.)

## Dock — right-edge vertical rail

- Fixed right edge, centered vertically. One 36×36 button per dock-visible window.
- Geometric line icons only (see Icons). Hotkey glyph under each icon (9px,
  `--sc3d-ink-dim`). Tooltip = window title on hover.
- Open-state signifier: 2px accent underline bar + ONE 200ms glow pulse on open;
  the bar persists while open. `prefers-reduced-motion: reduce` → bar only, no pulse.
- Theme-cycle swatch lives at the rail bottom.
- The dock is UI: always visible with the rest of the shell (the crosshair-era
  hide behavior is retired).

## Icons

- **No pixel-art icons in the 3D client chrome.** Existing icon-card fallbacks
  inside inventory slot wells stay until those items receive models; they are
  content placeholders, not chrome.
- Chrome icons are hand-authored inline SVG: 24×24 viewBox,
  `stroke="currentColor" stroke-width="1.5" fill="none"`, mono-weight geometric line
  work. Module: `src/ui/icons.ts`.
- PURPOSE icons — component types and fill-slot purposes (resource families,
  craft slot symbols, item kinds, window/system glyphs) — are the generated
  solid-silhouette vector set: `fill="currentColor"` filled glyphs, traced from
  the icon-forge winner sheet (owner mandate 2026-07-08; provenance in
  `src/ui/purposeIconSvgs.gen.ts`). Solid silhouettes hold legibility at the
  12-22px purpose slots where hairlines wash out. Semantic maps + fallback
  contract: `src/ui/iconRegistry.ts` (unknown key → the surface keeps its
  UI_ICONS glyph or text). Registry owns resolution; surface adoption beyond
  the flagship trio (window titles, craft fill slots, inventory kind chips)
  belongs to the FE-polish phase-2 sweep.

## Input modality (owner ruling 2026-07-04 — the One Cursor Era)

- There is ONE input mode: a free cursor, always visible, no pointer lock, no
  Alt toggle, no crosshair combat mode. The dual cursor-mode era is retired.
- The cursor is an identity asset: regular-pointer SHAPE wearing the targeting
  clicker's STYLE (tl corner-tick bracket at the hotspot, theme-accent rim,
  near-black glass fill). Two states baked per theme accent into
  `--sc3d-cursor-default` / `--sc3d-cursor-interact` (uiTheme applies them;
  art lives in `src/overlay/cursor`). Identity cursors own pointing and
  acting; native cursors survive ONLY for manipulation feedback: grab /
  grabbing (window drag), resize grips, not-allowed (blocked verbs), text
  I-beam.
- Click grammar: LMB actor = target (bracket only). RMB actor = target +
  context radial (Attack default on attackables; Examine default otherwise).
  Double-LMB = default action. LMB ground = clear selection; RMB-hold ground =
  facing lock. ATTACK IS NEVER ON SINGLE CLICK — only double-click, the
  toolbar Attack ability, or the radial.
- F-verb (interact): TAP F fires the selected world verb (door/extractor/
  trainer/terminal/exchange) or opens the LOOT window on a corpse/cache; HOLD F
  ≥1s over a lootable take-alls it — the client loop of one TakeLootItem per
  stack (no new command), a phosphor radial charging on the `[F]` chip — and the
  LOOT window also carries a TAKE ALL button (owner ruling 2026-07-08).
  Creature corpses use HARVEST. Credit Chips (physical currency, quantity =
  value) redeem from the pack via the inventory REDEEM verb (radial / double-
  click / hotbar) into the scalar credit balance.
- Windows, dock, and HUD are visible from boot; window hotkeys always work
  (one keypress to loot after a fight, no mode switch in between).
- HUD panes (player status top-left, target status adjacent, chat bottom-left)
  are fixed-position HUD — not dock windows, not draggable.

## Typography & motion

- One mono/sans family as today (`ui-monospace` stack for chrome; `--sc-fixed-font-stencil`
  reserved for stamps/mastheads). Fixed rem scale; tabular numerals for counts.
- Transitions 150–250ms, `ease-out` exponential curves. Every animation has a
  `prefers-reduced-motion` alternative.
- Semantic z-scale (tokens below): window base < focused window < dock <
  context-radial < examine-drag ghost.

## Copy

- Icon-first, visual-first, reading-second. Chrome text = minimal short nouns.
- Explanations, disabled-state reasons, and help live in hover tooltips (ⓘ pattern).
- Developer-facing runtime strings are prohibited in player copy. Item names pass through
  when plain nouns; item descriptions come from `src/ui/inventory/itemCopy.ts`
  (new plain one-liners, ≤60 chars, dry tone).

## Theme tokens (`--sc3d-*`, installed by `src/ui/uiTheme.ts`)

Four themes: `signal` (default, cold cyan) / `phosphor` (CRT green) / `amber`
(Pip-Boy amber) / `oxide` (rust red). Zero hardcoded colors in UI styles.

| Token | Role |
| --- | --- |
| `--sc3d-bg-panel` | Near-black panel backdrop, hue-tinted per theme |
| `--sc3d-bg-cell` | One step lighter — gauge tracks, cells, wells |
| `--sc3d-ink` | Primary text |
| `--sc3d-ink-dim` | Secondary text / labels |
| `--sc3d-hairline` | Hairline borders & separators |
| `--sc3d-accent` | Signature accent — focus, reticle, open-state |
| `--sc3d-accent-soft` | Muted accent for soft fills |
| `--sc3d-accent-glow` | rgba accent for box-shadow glows |
| `--sc3d-danger` | Danger / death / error chrome |
| `--sc3d-glass` | Translucent window backing (bg-panel 72% + transparent) |
| `--sc3d-z-hud` | HUD plates (both modes) |
| `--sc3d-z-window` | Windows layer base (per-window z assigned within band) |
| `--sc3d-z-dock` | Dock rail |
| `--sc3d-z-radial` | Context radial menu |
| `--sc3d-z-ghost` | Examine/drag ghost — topmost |

Semantic gameplay colors (health/action/spirit fills, brass pips, downed vignette,
nameplate relation tints) stay on the fixed `--sc-fixed-*` palette (`src/ui/theme.ts`) and
never re-theme.

## Component vocabulary (built by the window-system program)

- **glass window** — WindowManager chrome: glass panel, 22px title strip, drag,
  14px corner resize grip, min-size + viewport clamp, persisted bounds.
- **dock rail / dock icon** — right-edge rail button with hotkey glyph + open bar.
- **title strip** — window drag handle: icon, short-noun title, ✕.
- **context radial** — right-click action menu (single reusable instance).
- **HUD plate** — fixed glass pane (player status, target status, chat).
- **slot tile** — inventory grid cell: model well, category chip, count, title band.
- **ledger** — right-column detail block (name, meta, description, action row).
