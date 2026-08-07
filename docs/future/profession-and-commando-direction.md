# Successor — Profession Stats & Commando: Creative Direction

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner commission 2026-07-08 ("creative director, absolute top best job — best stats for skillboxes,
verify what we have, build out, I'll review"). Author: **Main (Fable cockpit)**, grounded in
a historical grants-wiring audit (not retained) and
`client/src/slice-core/specs/progression.v1.json`.

> **Status: DESIGN FOR OWNER REVIEW.** Nothing here is implemented; waves are cut at the end.
> Every proposed effect maps to an ATOMIC PRIMITIVE (owner law: "small primitives, no
> hyperspecialized things"). One table-driven mapping per family — zero bespoke per-box code.

---

## 0. The truth about what exists (audit summary)

37 grant families across 5 professions: **13 WIRED · 7 PARTIAL (share a sibling's math) · 17 LABEL-ONLY (theater)**.

| Profession | Wired | Label-only theater |
|---|---|---|
| Marksman | rifle spread (0→92% reduction — excellent curve) | **pistol, tactics, fieldcraft — 3 whole tracks do nothing** |
| Brawler | movement, tempo (10→90 speed pts), ranged-block | **melee (!) and guard tracks do nothing** — Vibrosword Handling IV changes no number |
| Scout | traversal, sprint (+cost reduction), harvest yield | campcraft (both grants) — *being fixed TONIGHT by CampWeatherSim* |
| Craftsman | assembly (+7.5% max), experimentation (2→15 pts, 60→95%) | survey (range hardcoded 24c), tools |
| Medic | potency (→4x), cooldown (→4x), med-crafting | trauma (revive hardcoded) |

**Wiring BUGS found by the audit (fix regardless of design):**
1. Medical experimentation success is FIXED at 50% — `experimentation_bonus = 0` passed at
   `model.rs:2740` while craftsman's scales 60→95%. Medics deserve the same curve off
   `medical_crafting_bonus`.
2. `ranged-block` boxes exist in Rust but **not in progression.v1.json** (test-tuning artifact:
   one box = 95%). Needs spec entries + production tuning (see Brawler).

---

## 1. Design philosophy

1. **Atomic modifiers only.** Every box feeds one of a SMALL set of named primitives:
   `spread_reduction_milli` · `damage_bonus_milli` · `speed_points` (cooldown) ·
   `move_speed_milli` · `action_cost_milli` · `block_permille` · `damage_taken_milli` ·
   `yield_milli` · `range_cells` · `potency_milli` · `duration_milli` · `xp_rate_milli` ·
   **NEW: `splash` (radius+falloff damage), `debuff_action_cost` (suppression)** — the only two
   new primitives this whole design needs, both reused by 3+ consumers.
2. **The existing `profession_track_skill_bonus` ladder (50/tier, 300 full) is GOOD.** Every new
   effect reads it; no new progression bookkeeping.
3. **Consistency = the skill expression** (the no-luck philosophy): where a track improves a roll,
   prefer raising the FLOOR (variance shrink) over raising the ceiling.
4. **Every capstone does something a Roman numeral can't** — masters get one *qualitative* hook.

---

## 2. Per-profession build-out (box → primitive → curve)

### 2.1 Marksman — "all regular small arms" (owner ruling)

| Track | Primitive(s) | Curve (novice→master via track bonus) | Feel |
|---|---|---|---|
| rifle *(wired, keep)* | `spread_reduction_milli` (rifle class) | 0→920 | unchanged |
| **pistol** | `spread_reduction_milli` (pistol class) + **`swap_speed_milli`** (weapon-swap cooldown −0→−60%) | 0→800 spread; swap 1000→400 | sidearms = the SNAPPY option: fast draw, forgiving close spread |
| **tactics** | **`queue_swap_cost_milli`** (combat-queue re-target latency −0→−70%) + ranged special `action_cost_milli` −0→−25% | target switching becomes instant at IV | the PvP/PvE flow track — pairs with the new target plate |
| **fieldcraft** | kneeling `spread_reduction_milli` ×1.0→×1.6 multiplier + kneeling `damage_taken_milli` −0→−20% | positioning finally pays | cover discipline made real |
| **master** | **Squad Fire AURA**: grouped allies within 12c get +150 spread_reduction | qualitative capstone; ties into tonight's GroupsSimO frames | the "bring a master" reason |

### 2.2 Brawler — melee made real

| Track | Primitive(s) | Curve | Feel |
|---|---|---|---|
| **melee** | `damage_bonus_milli` (melee class) 0→+300 + **variance floor** (min-roll raised 0→40%) | Vibrosword Handling finally changes numbers | hits harder AND more consistent |
| **guard** | **THE WALL track — absorbs ranged-block** (the skills grid is 4 columns; a 5th track would be UI-invisible): `melee_block_permille` (parry) 0→350 + `ranged_block_permille` (the existing Rust boxes re-homed as guard grants) 0→950 production curve + braced `damage_taken_milli` −0→−15% | lane-holder / tank identity without new states |
| movement *(wired)* | keep | | |
| attack-speed *(wired)* | keep (novice +10 boofed earlier tonight) | | |
| *(ranged-block standalone track — REJECTED: UI grid clamps columns 0..3; folded into guard above; the 95%-per-box test artifact stays behind a debug flag)* | | | |

### 2.3 Scout — campcraft lands tonight

| Track | Primitive(s) | Curve |
|---|---|---|
| traversal / sprinting / harvesting *(wired)* | keep | |
| **campcraft** | camp `grace timer` +0→+15min (stacks on the 15min base), camp shelter `radius_cells` +0→+3, camp place `action_cost` −, **Field Rest**: health/action regen ×1.0→×1.75 while in OWN camp | CampWeatherSim's entity carries the hooks; this table fills them |
| **master** | camp becomes group-shared rest (party regen aura in camp) | the social capstone |

### 2.4 Craftsman

| Track | Primitive(s) | Curve |
|---|---|---|
| assembly / experimentation *(wired)* | keep | |
| **survey** | `survey_range_cells` 24→44 (+4/tier, +4 master) + **Heat Reading**: survey grid RESOLUTION step 12→8→6 (finer concentration map at higher tiers) | prospecting depth without new UI |
| **tools** | crafted-tool quality FLOOR +0→+150 milli (applies to multitool/tool-class recipes only) + starter-grant quality 500→650 at IV | toolmaker identity; feeds the tool-quality-matters loop |

### 2.5 Medic

| Track | Primitive(s) | Curve |
|---|---|---|
| potency / speed / med-crafting *(wired)* | keep; **FIX the 50% experimentation bug** (scale off med-crafting bonus like craftsman) | |
| **trauma** | revive `cast ticks` −0→−50%, revived-target vitals 25%→60% (replace `REVIVE_RESTORE_VITALS_PERCENT` hardcode), clone-sickness duration −0→−40% when treated by this medic | the battlefield-medic track |

---

## 3. COMMANDO — the advanced combat profession (the creative heart)

**Identity:** heavy weapons + demolitions + area control. earlier sandbox design's commando was a slow DoT-vending
machine; ours is the **big-button class with crisp server-tick windows** — telegraphed but FAST.

**Prereqs (literal shape, our trees):** `brawler-melee-iv` + `marksman-rifle-iv`, 58 SP
committed before novice — the "advanced" gate. *(Owner fork F-C1: earlier sandbox design demanded UNARMED; we have
no unarmed weapon class yet. Recommend brawler-melee-iv as the close-combat-mastery analog NOW,
and a true `unarmed` brawler extension (fists/knuckler items) as a later content wave that can be
re-pointed as the prereq without respec pain — see forks.)*

**Novice grant:** Heavy Weapons Cert + Rocket Launcher schematic (known-recipe) + Demo Charge schematic.

**The two new primitives (reused everywhere):**
- **`splash`**: radius damage with linear falloff (center 100% → edge 35%), resolves ON impact
  tick — one function, used by launcher, demo charges, and future grenades. Friendly-fire OFF v1.
- **`debuff_action_cost`**: suppression — actors in the zone pay +N% action costs for T ticks.
  No stuns, no new states; the action economy IS the crowd control (reactive, never lock-out).

**Weapons (new 31xx items, all craftable via W6 sessions, all experimentable):**
| Item | Class | Feel |
|---|---|---|
| RL-7 Rocket Launcher | splash, slow reload, 0.7s wind-up telegraph | the screen-shaker; experimentation lines: damage / splash radius / reload |
| Sweeper Flamer | 6c cone, 3-tick burn stack (max 3, simple decrement — no DoT zoo) | close-range area denial |
| HR-2 Heavy Repeater | sustained cone SUPPRESSION (debuff_action_cost 25%) + modest damage | the support heavy — pins a lane while the squad works |
| Demo Charge | placed, 3s fuse, big splash; damages STRUCTURES (future siege hook) | demolitions identity |

> **Asset reality check (SyntyProps landing, same night):** the arsenal already has verified READY
> models in the pack — `synty_flame_unit` (SM_Wep_Flamethrower_01, 2461 tris) = the Sweeper Flamer;
> `synty_scrap_rifle` (SM_Wep_Heavy_01) = the HR-2 Heavy Repeater body; `synty_mining_laser` fits a
> future utility-heavy variant. Only the RL-7 launcher + demo charge need authoring (pod-tent-lane
> hand-author or Gemini-with-reference). P4's asset cost is one-and-a-half models, not four.

**Tracks:**
| Track | Primitive(s) | Curve |
|---|---|---|
| heavy-weapons | heavy-class `spread/deviation` −0→−70% + `damage_bonus_milli` 0→+250 | make the rockets land where aimed |
| demolitions | demo `splash radius` +0→+2c + fuse −0→−1.5s + placement `action_cost` − | the utility ladder |
| suppression | `debuff_action_cost` potency 25→45% + cone width +0→+40% | area control scales |
| field-hardening | self `damage_taken_milli` −0→−20% while wielding heavy + knockback/stagger immunity at IV | stand in the open and DELIVER |
| **master** | **Danger Close**: own splash within 4c of self costs no self-penalty + squad within 8c gains suppression immunity | the "commando holds the door" fantasy |

**Snappy = numbers:** wind-ups 0.6–0.9s (visible telegraph, cancellable), impact resolution ON the
hit tick (never lingering), suppression ticks decay linearly. Worked TTK example at the §C bar goes
in the implementation blueprint (wave C1) — target: master commando vs 3-grunt cluster ≈ 6–8s via
rocket + repeater sweep, vs earlier sandbox design's 20s+ DoT wait.

**XP:** heavy-weapon kill XP (full-ledger rule applies) + demolition structure damage + suppression
assist ticks (small, capped) — the support path levels too.

---

## 4. Implementation waves

- **P1 — wiring bugs** (medical exp chance; ranged-block re-homed as guard-track grants + production tuning): tiny, tonight-able.
- **P2 — label-only fill-in** (tables in §2, one mapping fn per family reading track bonus): sim + spec text; per-profession commits.
- **P3 — splash + suppression primitives** (pure fns + tests at the extraction_math bar).
- **P4 — Commando**: profession tree + trainer persona + 4 weapons (items/recipes/FX) + tracks. FX lands via the CombatVisualFX patterns (impact honesty).
- **P5 — capstone hooks** (squad fire aura, camp rest aura, danger close) — all read GroupsSimO frames.

## 5. Owner forks (defaults recommended)

| Fork | Options | Default |
|---|---|---|
| F-C1 unarmed prereq | brawler-melee-iv analog now / build true unarmed class first | **analog now**, unarmed as content wave later |
| F-C2 friendly fire | splash hits allies? | **off** v1 (grouping is new; revisit for PvP) |
| F-C3 ranged-block tuning (as guard grants) | 190‰/guard-box ×5 = 950 / 250‰×4 / keep 95% test line behind debug flag | **190‰×5** + debug flag |
| F-C4 suppression stacking | multiple suppressors stack? | **no** — strongest wins (anti-degenerate) |
| F-C5 heavy ammo economy | rockets consume crafted ammo? | **yes** — crafted rocket ammo = economy sink + crafter demand |
