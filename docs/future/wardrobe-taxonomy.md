# Successor Wardrobe Taxonomy — creator wave (2026-07-08)

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner program: character creation gains the ratified apoc clothing sets
(tops / bottoms / footwear / gloves) + the fixed Synty hairs, with a
material taxonomy + consistent re-palette system as the substrate for
future craft-dyeing. Source of ratification:
`source-assets/characters/synty-fit/SUCCESSOR_WARDROBE_RATIFIED.md`.
Sci-fi sets stay OUT (gated later). No armor, no weapons in the creator.

The original swatch sheet and wardrobe montage were generated workbench
artifacts and were not preserved.
Machine registry (promotion input): `client-3d/public/assets/pawn-pack/equipment/wardrobe_palette.json` (lands with the FE wave)

## Inventory (ratified inclusions honored exactly)

- Tops: **8** (apoc_outl 02,04,05,06,07,08,09,10 — TORS-only per rulings)
- Bottoms: **10** (apoc_outl 01-10)
- Footwear: **10** (apoc_outl 01-10)
- Gloves: **7** (apoc_outl 01-07 — gloves are always separate items)
- Hair: **24** fixed Synty refits (cranium-attach, tuned set) + 3 legacy pack hairs kept (mop/afro2/crop2)
- `tops_apoc_outl_01` = ARMS-ITEM (harness+arm slots, sleeve surgery closed) — ratified for IMPORT but **not a creator slot**; taxonomy row included, promotion deferred to the harness lane.
- Excluded, per rulings: apoc_outl 03/11/12/13 tops (removed), fant_kngt_* (removed), all scifi_* (gated), labs 05/07/08/09 (broken or unruled).

## Material classes → palette families

Every atlas color slot was classified from slot-isolation renders
(vision pass) + the recovered atlas hexes. Classes:

| Class | What it covers | Dye family | Swatches |
|---|---|---|---|
| WORKCLOTH | worn cloth, canvas, denim, knit, webbing | `workcloth` | 12 (rust→teal) |
| LEATHER | hides, plates, straps, boot uppers | `leather` | 10 (tan→indigo) |
| RUBBER | molded guards, pads, shoulder rolls | `rubber` | 6 (black→navy) |
| METAL | buckles, chains, plates, hardware | — | FIXED, never dyed |
| HAIR | all hair meshes (single tint via `hair_mat`) | `hair` | 15 (9 natural + 6 bold; 7 ids pre-existing) |

Families are muted-apoc-first with a few bolds at the end, so future
craft-dyes get one coherent space: a `Leather Dye — Oxblood` applies to
ANY leather zone on any piece; same for cloth and rubber dyes.

**workcloth** — `rust #804040` `clay #7a5038` `sand #a08858` `bone #b0a890` `olive #687048` `sage #5f7358` `slate #506078` `denim #406090` `graphite #3a3a3e` `oxblood #6e3a34` `mustard #a08030` `teal #3f7472`

**leather** — `tan #b08040` `saddle #806040` `umber #5f4630` `oxblood #6b3b30` `char #34302c` `ash #7a7468` `olive_tan #6f6844` `mahogany #7e4a38` `forest #4c5f46` `indigo #46506e`

**rubber** — `black #303030` `gunmetal #4a4a4e` `olive #4f5244` `brick #71453c` `sand #8a7f66` `navy #3c4456`

**hair** — `raven #1d1b22` `ink #232134` `umber #3a2a1a` `chestnut #5a3a22` `auburn #6e3a24` `honey #9a7440` `ash_blonde #b3a077` `steel #7c8088` `silver #b9bcc4` `crimson #7a2330` `moss #4f6842` `teal #2f5f5c` `violet #544060` `rose #9c6670` `bleach #d8d2c0`

## Re-palette model

- Each piece exposes **1-3 dye ZONES** (primary / secondary / tertiary),
  keyed to material zones (jacket body + trim; boots upper + cuff…).
  Distribution across the 35 creator pieces: 1 zone(s): 3, 2 zone(s): 21, 3 zone(s): 11.
- A zone = a set of the piece's atlas color slots (`<piece>_cN` materials
  from the refit pipeline). Slots outside every zone are **FIXED** and keep
  their authored atlas color (hardware, soles, linings) — that fixed
  contrast is what keeps re-palettes grounded instead of toy-like.
- Zone **default** = the authored atlas hex (as-found look). Player color
  = one of the zone family's swatches. Validation: `color ∈ family.swatches ∪ {default}`.
- Runtime: matcap × per-slot flat color (the pack's world-material path);
  dyed slots resolve to the zone color, fixed slots to the baked color.
- Hair: single tint — `hair_mat` preset recolors the whole mesh (incl.
  accessory bits: headbands/goggles tint with the hair; accepted, 1 slot).

## Piece table

Zone syntax: `KEY(family): slots @default [area%]`. FIXED lists slot: what | read.

### Tops — slot `under_torso`

| Piece | Name | Source (refit) | What it is | Dye zones | Fixed |
|---|---|---|---|---|---|
| `top_rigged_tank` | Rigged Canvas Tank | `tops_apoc_outl_02` | torn tank + single-shoulder pad rig + chest straps | `body`(workcloth): c3 @#b08040 [56%]<br>`straps`(workcloth): c5 @#406090 [20%] | `c0` buckles/adjusters · metal @#808080<br>`c2` shoulder pad · rubber @#606060<br>`c4` shoulder strap · canvas @#505050 |
| `top_frayed_tunic` | Frayed Work Tunic | `tops_apoc_outl_04` | sleeveless frayed tunic with neck chain | `body`(workcloth): c1 @#806040 [75%] | `c0` collar chain · metal @#808080 |
| `top_plated_rig_vest` | Plated Chest-Rig Vest | `tops_apoc_outl_05` | chest rig vest, leather plates over dark base | `plates`(leather): c5 @#b08040 [32%]<br>`vest`(workcloth): c1 @#303030 [27%]<br>`collar`(workcloth): c3 @#908060 [26%] | `c2` side bands · rubber @#406090<br>`c4` brackets · metal @#808080 |
| `top_padded_leather_vest` | Padded Leather Vest | `tops_apoc_outl_06` | survivalist vest with shoulder rolls + wraps | `body`(leather): c0 @#806040 [62%]<br>`padding`(rubber): c1 @#303020 [20%] | `c5` cloth wraps · worn cloth @#505060<br>`c3` waist belt · webbing @#406090<br>`c4` tape patches · cloth @#908070 |
| `top_spiked_leather_vest` | Spiked Leather Vest | `tops_apoc_outl_07` | armored vest with shoulder spikes + patch pocket | `panels`(leather): c1 @#b08040 [57%]<br>`sides`(workcloth): c0 @#806040 [39%] | `c2` spikes/buckles · metal @#505060<br>`c3` strap bases · leather trim @#606060<br>`c4` chest pocket · canvas @#908070 |
| `top_reinforced_crop_vest` | Reinforced Crop Vest | `tops_apoc_outl_08` | crop vest, stiffened plates, tattered hem | `plates`(workcloth): c3 @#908070 [36%]<br>`shoulders`(workcloth): c0 @#303030 [29%]<br>`hem`(workcloth): c4 @#606060 [28%] | `c5` center grate + lining · metal @#808080 |
| `top_scrap_plate_tunic` | Scrap-Plate Tunic | `tops_apoc_outl_09` | makeshift tunic with scrap chest plate | `body`(workcloth): c0 @#b08040 [60%]<br>`scraps`(workcloth): c4 @#908060 [13%]<br>`trim`(leather): c2 @#806040 [12%] | `c3` chest plate · metal @#303030<br>`c5` repair patches · leather @#606060 |
| `top_laced_corset_vest` | Laced Corset Vest | `tops_apoc_outl_10` | corset vest over sleeveless tunic, side laces | `tunic`(workcloth): c1 @#b08040 [50%]<br>`wrap`(workcloth): c2 @#406090 [23%]<br>`corset`(leather): c0 @#303030 [21%] | `c4` side/back laces · cord @#908070<br>`c5` back band · rubber @#505060 |

### Bottoms — slot `under_legs`

| Piece | Name | Source (refit) | What it is | Dye zones | Fixed |
|---|---|---|---|---|---|
| `legs_wrapped_workpants` | Wrapped Workpants | `bottoms_apoc_outl_01` | wrap-pants + waist wrap + asymmetric shin guard | `pants`(workcloth): c0 @#804040 [42%]<br>`wrap`(workcloth): c1 @#505060 [20%]<br>`guard`(leather): c5 @#706050 [10%] | `c2` left shin wrap · cloth @#505050<br>`c3` boots/soles · rubber @#303030<br>`c4` thigh straps · cloth @#406090 |
| `legs_reinforced_denim_pants` | Reinforced Denim Pants | `bottoms_apoc_outl_02` | denim workpants + shin/knee guards + belt | `pants`(workcloth): c0 @#804040 [66%]<br>`guards`(rubber): c1 @#505050 [19%] | `c2` leg straps · canvas @#606060<br>`c3` waistband/cuffs · knit @#406090<br>`c4` buckles · metal @#808080<br>`c5` tear lining · cloth @#505060 |
| `legs_plated_trousers` | Plated Combat Trousers | `bottoms_apoc_outl_03` | combat pants + pelvis plate + shin shells | `pants`(workcloth): c0 @#804040 [51%]<br>`shells`(rubber): c2 @#808080 [27%] | `c1` pelvis plate · metal @#505060<br>`c3` kneepads/straps · leather @#505050<br>`c4` side pocket · canvas @#407050<br>`c5` waist trim · knit @#606060 |
| `legs_layered_shorts` | Layered Combat Shorts | `bottoms_apoc_outl_04` | shorts + tiered leg wraps + crotch plate | `shorts`(workcloth): c2 @#505060 [44%]<br>`wraps`(workcloth): c1+c3 @#908070 [35%]<br>`bands`(workcloth): c4 @#804040 [13%] | `c0` waistband · knit @#808080<br>`c5` crotch plate · rubber @#606060 |
| `legs_strapped_trousers` | Strapped Utility Trousers | `bottoms_apoc_outl_05` | strapped trousers + knee guards + thigh holster + apron | `pants`(workcloth): c1 @#804040 [50%]<br>`guards`(rubber): c3 @#406090 [23%]<br>`straps`(workcloth): c2 @#303030 [12%] | `c0` front apron · canvas @#808080<br>`c4` thigh holster · leather @#505060<br>`c5` hip pouch · canvas @#505050 |
| `legs_skirted_workpants` | Skirted Workpants | `bottoms_apoc_outl_06` | pants under tattered overskirt + leg guards | `pants`(workcloth): c1 @#804040 [40%]<br>`skirt`(workcloth): c2 @#505060 [31%]<br>`belt`(leather): c3 @#406090 [9%] | `c0` leg guards/hip plates · metal @#505050<br>`c4` buckle · metal @#606060<br>`c5` knee inserts · metal @#808080 |
| `legs_gaitered_cargo_pants` | Gaitered Cargo Pants | `bottoms_apoc_outl_07` | cargo pants + gaiters + side pouches | `pants`(workcloth): c0 @#804040 [58%]<br>`gaiters`(workcloth): c4 @#908060 [8%] | `c5` side pouches · canvas @#505050<br>`c1` boots + straps · rubber/leather @#303030<br>`c2` belt · leather @#406090<br>`c3` thigh patch · cloth @#505060 |
| `legs_padded_canvas_trousers` | Padded Canvas Trousers | `bottoms_apoc_outl_08` | padded trousers + tattered waist wrap | `pants`(workcloth): c0 @#804040 [58%]<br>`wrap`(workcloth): c2 @#505060 [21%] | `c1` boots + shin guards · rubber @#303030<br>`c3` patches/straps · canvas @#a09070<br>`c4` boot buckles · metal @#706050<br>`c5` belt · leather @#706040 |
| `legs_sashed_patrol_pants` | Sashed Patrol Pants | `bottoms_apoc_outl_09` | patrol pants + waist sash + thigh holster | `pants`(workcloth): c0 @#804040 [64%]<br>`sash`(workcloth): c3 @#605040 [15%]<br>`straps`(workcloth): c1 @#406090 [10%] | `c2` buckles/hardware · metal @#808080<br>`c4` boot cuffs/guards · rubber @#303030<br>`c5` pouches/holster · leather @#407050 |
| `legs_layered_wrap_skirt` | Layered Wrap Skirt | `bottoms_apoc_outl_10` | frayed double-layer skirt + straps + leg guards | `skirt`(workcloth): c0 @#804040 [36%]<br>`straps`(workcloth): c1 @#406090 [31%]<br>`guards`(rubber): c5 @#505060 [15%] | `c2` apron + boots · canvas @#808080<br>`c3` trim/linings · cloth @#303030<br>`c4` buckles/studs · metal @#605090 |

### Footwear — slot `under_feet` (new)

| Piece | Name | Source (refit) | What it is | Dye zones | Fixed |
|---|---|---|---|---|---|
| `boots_canvas_ankle` | Canvas Ankle Boots | `footwear_apoc_outl_01` | canvas ankle boots | `body`(workcloth): c1 @#303030 [49%]<br>`panels`(workcloth): c0 @#808080 [30%] | `c3` sole edge · rubber @#505050 |
| `boots_layered_sneakers` | Layered Street Sneakers | `footwear_apoc_outl_02` | layered low-top sneakers | `panels`(leather): c1 @#505050 [27%]<br>`vamp`(workcloth): c3 @#808080 [10%] | `c0` outsole · rubber @#505040<br>`c2` heel counter · rubber @#303030<br>`c4` overlay · canvas @#606060 |
| `boots_split_toe` | Split-Toe Boots | `footwear_apoc_outl_03` | split-toe boots, thick soles | `upper`(leather): c0 @#908070 [51%]<br>`vamp`(workcloth): c3 @#808080 [16%] | `c1` sole · rubber @#505040<br>`c4` collar lining · cloth @#606060<br>`c5` toe trim · rubber @#706080 |
| `boots_trail_shoes` | Rugged Trail Shoes | `footwear_apoc_outl_04` | tactical trail shoes | `body`(workcloth): c5 @#808080 [21%]<br>`tongue`(workcloth): c0 @#303030 [29%] | `c1` ankle collar · knit @#406090<br>`c2` toe cap · leather @#606060<br>`c3` heel counter · rubber @#706050<br>`c4` outsole · rubber @#505040 |
| `boots_double_strap` | Double-Strap Boots | `footwear_apoc_outl_05` | low double-strap utility boots | `straps`(workcloth): c2 @#303030 [33%]<br>`cuff`(leather): c3 @#406090 [14%] | `c0` sole + toe guard · rubber @#808080<br>`c1` trim dots · metal @#606060 |
| `boots_rubberized_canvas` | Rubberized Canvas Boots | `footwear_apoc_outl_06` | ankle canvas boots, thick rubber soles | `body`(workcloth): c0 @#303030 [46%]<br>`collar`(workcloth): c3 @#706050 [10%] | `c1` outsole · rubber @#505040<br>`c2` heel counter · rubber @#606060<br>`c4` collar lining · cloth @#808080 |
| `boots_toe_capped` | Toe-Capped Work Boots | `footwear_apoc_outl_07` | blocky slip-on work boots, toe plates | `upper`(leather): c0 @#303030 [62%] | `c1` platform sole · rubber @#505040<br>`c2` toe cap · metal @#808080 |
| `boots_combat_sneakers` | Combat Sneakers | `footwear_apoc_outl_08` | combat ankle sneakers | `upper`(leather): c2 @#303030 [38%]<br>`laces`(workcloth): c0 @#808080 [13%] | `c1` sole unit · rubber @#505040<br>`c3` side panels · leather @#505050 |
| `boots_cuffed_runners` | Cuffed Runners | `footwear_apoc_outl_09` | ankle-cuff runners | `cuff`(workcloth): c0 @#303030 [46%]<br>`vamp`(leather): c3 @#808080 [12%] | `c1` upper trim · cloth @#706050<br>`c2` sole + heel · rubber @#505040 |
| `boots_reinforced_street` | Reinforced Street Boots | `footwear_apoc_outl_10` | chunky-sole street boots | `body`(workcloth): c0 @#303030 [35%]<br>`collar`(workcloth): c2 @#808080 [27%] | `c1` heel + sole trim · rubber @#505040<br>`c3` outsole · rubber @#406090<br>`c4` eyelet stay · leather @#606060 |

### Gloves — slot `under_hands` (new)

| Piece | Name | Source (refit) | What it is | Dye zones | Fixed |
|---|---|---|---|---|---|
| `gloves_knuckled_half` | Knuckled Half-Gloves | `gloves_apoc_outl_01` | half-finger combat gloves, knuckle plate, long cuff | `cuff`(workcloth): c1 @#406090 [43%]<br>`knuckle`(rubber): c2 @#808080 [41%] | `c3` palm · leather @#a07040<br>`c4` hand back · leather @#706080<br>`c5` finger sleeves · leather @#9080b0 |
| `gloves_guarded_leather` | Guarded Leather Gloves | `gloves_apoc_outl_02` | leather gloves with knuckle guard | `body`(leather): c0 @#a07040 [81%]<br>`knuckle`(rubber): c3 @#406090 [5%] | `c1` finger tips · leather @#303030<br>`c2` wrist trim · metal @#606060 |
| `gloves_plain_work` | Plain Work Gloves | `gloves_apoc_outl_03` | plain fabric work gloves | `body`(workcloth): c1 @#a07040 [94%] | `c2` wrist cuff · knit @#606060<br>`c3` finger tips · leather @#706080<br>`c4` stitching · cloth @#9080b0 |
| `gloves_reinforced_knit` | Reinforced Knit Gloves | `gloves_apoc_outl_04` | knit gloves + knuckle guard + palm patch | `body`(workcloth): c1 @#808080 [46%]<br>`cuff`(workcloth): c2 @#406090 [24%]<br>`knuckle`(rubber): c4 @#a07040 [12%] | `c3` palm patch · leather @#505050<br>`c5` finger grips · rubber @#606060 |
| `gloves_light_utility` | Light Utility Gloves | `gloves_apoc_outl_05` | light utility gloves | `body`(workcloth): c0 @#605090 [84%]<br>`cuff`(workcloth): c1 @#908070 [12%] | `c2` hand back · cloth @#9050c0<br>`c3` thumb · cloth @#706080<br>`c4` piping · rubber @#9080b0 |
| `gloves_tipped_work` | Tipped Work Gloves | `gloves_apoc_outl_06` | cloth gloves, knit cuffs, leather tips | `body`(workcloth): c0 @#a07040 [81%]<br>`cuff`(workcloth): c1 @#303030 [14%] | `c2` finger tips · leather @#606060 |
| `gloves_plated_handwraps` | Plated Hand-Wraps | `gloves_apoc_outl_07` | fingerless wraps, metal knuckles, long knit cuff | `cuff`(workcloth): c0 @#505050 [67%]<br>`wrap`(workcloth): c1 @#a07040 [12%] | `c2` knuckle plates · metal @#808080<br>`c3` wrist strap · leather @#406090 |

### Arms-item (ratified, deferred — not a creator slot)

| Piece | Name | Source | What | Zones | Fixed |
|---|---|---|---|---|---|
| `arms_wrapped_guards` | Wrapped Arm Guards | `tops_apoc_outl_01` | ARMS-ITEM (harness+arm slots): cloth arm wraps + guards, both arms — NOT in creator | `wraps`(leather): c5 @#806040<br>`wrists`(workcloth): c0 @#406090 | `c4` forearm sleeves · canvas @#808080 |

### Hair — appearance property (style + color), never inventory

Per the HairInventoryFix contract: hair = `{ hair: styleId|null, hairMat: colorId }`
on appearance; GLBs live in the pack manifest as slot `cranium`, group `Hair`,
layer `Under`, id `^hair_[a-z0-9_]+$`. All 24 refits keep hand+finger-free
head/neck weights from the tuned lab exports.

| Style id | Name | Source refit | Accessory note |
|---|---|---|---|
| `hair_mop` / `hair_afro2` / `hair_crop2` | Mop / Afro / Crop | legacy pack | kept, ids stable |
| `hair_banded_mohawk` | Banded Mohawk | `sk_apoc_outl_01_02hair_hu01` | headband |
| `hair_spiked_topknot` | Spiked Topknot | `sk_apoc_outl_02_02hair_hu01` | — |
| `hair_twin_pigtails` | Twin Pigtails | `sk_apoc_outl_03_02hair_hu01` | hair ties |
| `hair_swept_spikes` | Swept Spikes | `sk_apoc_outl_04_02hair_hu01` | — |
| `hair_short_ponytail` | Short Ponytail | `sk_apoc_outl_05_02hair_hu01` | hairband |
| `hair_spiked_mohawk` | Spiked Mohawk | `sk_apoc_outl_06_02hair_hu01` | — |
| `hair_flared_wings` | Flared Wings | `sk_apoc_outl_07_02hair_hu01` | — |
| `hair_low_tufts` | Low Tufts | `sk_apoc_outl_08_02hair_hu01` | — |
| `hair_swept_bob` | Swept Bob | `sk_apoc_outl_09_02hair_hu01` | hair rings |
| `hair_braided_crown` | Braided Crown | `sk_apoc_outl_10_02hair_hu01` | headband |
| `hair_ridge_mohawk` | Ridge Mohawk | `sk_scfi_civl_01_02hair_hu01` | ridge rod |
| `hair_side_ponytail` | Side Ponytail | `sk_scfi_civl_02_02hair_hu01` | goggles |
| `hair_split_mohawk` | Split Mohawk | `sk_scfi_civl_03_02hair_hu01` | — |
| `hair_fauxhawk` | Fauxhawk | `sk_scfi_civl_09_02hair_hu01` | — |
| `hair_slicked_crop` | Slicked Crop | `sk_scfi_sold_01_02hair_hu01` | — |
| `hair_side_sweep` | Side Sweep | `sk_scfi_sold_02_02hair_hu01` | — |
| `hair_flared_shag` | Flared Shag | `sk_scfi_sold_03_02hair_hu01` | — |
| `hair_cropped_buzz` | Cropped Buzz | `sk_scfi_sold_04_02hair_hu01` | — |
| `hair_messy_crop` | Messy Crop | `sk_scfi_sold_05_02hair_hu01` | — |
| `hair_textured_crop` | Textured Crop | `sk_scfi_sold_06_02hair_hu01` | — |
| `hair_shoulder_shag` | Shoulder Shag | `sk_scfi_sold_07_02hair_hu01` | headband |
| `hair_messy_side_part` | Messy Side-Part | `sk_scfi_sold_08_02hair_hu01` | hair tie |
| `hair_flat_top` | Flat Top | `sk_scfi_sold_09_02hair_hu01` | — |
| `hair_top_patch` | Top Patch | `sk_scfi_sold_10_02hair_hu01` | — |

Hair colors: the 15-swatch `hair` family above ships as `hair_*` material
presets in `ClothingMaterials/clothing_materials.json` (7 existing ids kept,
8 added: auburn, honey, steel, moss, teal, violet, rose, bleach).

## Creator + pipeline contract (Phase 2)

- Creator slots: HAIR (style + color) · TOP · BOTTOM · SHOES · GLOVES, each
  clothing slot with per-zone color pickers (1-3 rows). No armor, no weapons.
- Worn set persists on the character record as appearance-adjacent state:
  `worn: [{ item, colors: [#hex per zone] }]`; wire carries it in actor
  appearance so remote pawns render true clothes + colors.
- Starting kit (tunable grant table, coordinated with Main): worn clothes +
  slugthrower + Coil Slug ammo + training credits. Ranged weapons stay hard to get;
  the slugthrower is the owner's interim call.
- Promotion: refit GLBs → `pawn-pack/equipment/Under/`, materials renamed
  `<successor_id>_cN`, manifest entries carry `palette.zones`; runtime
  resolves dyed slots → zone color, fixed slots → baked atlas color.

## Named seam (Main ruling, 2026-07-08)

Worn-set-as-appearance is the ratified creator-wave shape. When clothes
become tradeable/lootable economy items later, the worn-set→itemization
bridge (worn entries become item references) is a NAMED design follow-up —
planned seam, not a retrofit surprise. The zone/palette model carries over
unchanged; only the identity of a worn entry upgrades (id → item ref).

## Non-goals (this wave)

- Craft-dyeing mechanics (this taxonomy is its substrate).
- Sci-fi sets, armor/weapon creator slots, onboarding economy design.

## Landed status (2026-07-09, creator wave)

- Phase 2 SHIPPED: 59 GLBs promoted (35 clothing + 24 hair, animation-
  stripped + pruned, 50-bone contract enforced — bottoms helper bones baked
  into pelvis/thigh), manifest palette zones, wardrobe_palette.json, 8 new
  hair presets, generated registries (tools/codegen/wardrobe.mjs →
  server+client-3d wardrobe.gen.ts, pnpm check:wardrobe), worn set through
  character store → session identity → shard actor → compact wire → pawn
  renderer (matcap × zone color), creator UI (hair stepper + 4 slot steppers
  + 1-3 zone color rows), boot-time worn gear seeding, character DELETE
  (two-step armed confirm + store/route), probe surfaces (charselect
  draftWorn/draftHair; world authorityPlayer.worn).
- Phase 3 PROVEN: creation journey (3d:gate `creation`) — real UI picks →
  server-validated create → spawn wearing exact picks (probe-asserted colors)
  → relog persistence → delete valve; full 3d:gate 22/22 pass (splice =
  pre-existing honest skip; group/trade/duel re-run green after an infra
  vite SIGKILL unrelated to this wave); tui:gate 19×2 green (TUI has no
  /game/characters consumer — prose untouched); montage:
  proofs/wardrobe/wardrobe-telegram-montage.png (creator UI + 4 palette
  pawns incl. remote-pawn worn rendering + swatch sheet).
- Hair interplay: helmet-vs-hair single-cranium rule preserved (hair rides
  when no cranium gear; eviction/restore via the existing merge). The 24 new
  styles create end-to-end AFTER the HairInventoryFix substrate lands
  (pattern validation + manifest-driven render — its lane rebases on this
  wave); until then the creator previews all 27 styles and legacy 3 create.

## Named follow-ups (not this wave)

- Probe-store hygiene (Main ruling): harness/demo stacks must run with a
  disposable GAME_CHARACTER_STORE_PATH so probes can't touch the owner's
  store. client3d gate + palette-montage already do (per-run store files);
  the TUI fixture stack + any long-lived demo unit get the same one-env-line
  treatment in the harness lane.
- Slot cap: charselect MAX_SLOTS=5 hardcode reads limits.maxCharacters from
  GET /game/characters when AccountsBridge lands its entitlement-driven cap.
- Worn-set → itemization bridge (see Named seam above).
- apoc_outl_01 arms-item promotion (harness+arm multi-slot) — harness lane.

## Provenance / regeneration

- Slot truth: headless dumps of `synty-fit/labs/{tops,bottoms,footwear,gloves,hair_sidekick}.blend`
  (per-slot hex + face/area shares, tops segment rulings applied).
- Zone semantics: per-slot magenta isolation renders (front+back), vision-classified.
- Generators (durable): `source-assets/characters/synty-fit/tools/wardrobe_taxonomy/`
  — `taxonomy.py` (design source of truth), `dump_lab_materials*.py`,
  `render_sweep.py`, `export_pass.py`, `export_bottoms_fix.py` (50-bone helper
  bake), `make_swatch_sheet.py`, `make_doc.py`, `wardrobe_taxonomy.json`.
