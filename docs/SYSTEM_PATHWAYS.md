# Successor System Pathways

Snapshot: 2026-07-15. This document describes the current authority-backed
path from character creation into combat, gathering, crafting, camping, and
travel. It is a pathway contract, not a claim that every balance or presentation
gate is finished.

Status terms used below:

- **Implemented** means the path has a real player command, authority rule, and
  current client entry point.
- **In flight** means wiring is present in the working tree, but the focused
  authority/client regression proof is not yet present. It does not count as
  implemented.
- **Gap** means the authority path exists but the player-facing route is still
  incomplete or unnecessarily obscure.
- **Hold** means source art or a concept exists, but it has deliberately not
  been promoted without a gameplay contract and verification.

## Design rule

A starting profession is not a class, permanent identity, protected slot, or
free skill allocation. Character creation spends the normal 16 skill points on
one novice box from the same 250-point budget used later. The selection grants
that box and no equipment.

Every new character starts with only the fixed bodysuit and boots. There is no
starter weapon or profession supply kit. The player can learn other professions
through an in-range trainer and unlearn individual boxes through that same
trainer. Unlearning refunds the named box's skill-point cost and restores its
exact spent XP to the applicable profession and track pools, preserving total
earned XP. Credits are not refunded. Dependent boxes block removal. Training
changes skills and budget; it never grants equipment. The first weapons, tools,
medicine, and materials come from loot, trade, trainers, or crafting.

## Golden first-session flow

```text
Create character
  -> choose one novice allocation (16 / 250 SP)
  -> receive a 5,000-credit wallet balance
  -> enter Dustgate with the fixed bodysuit and boots
  -> meet Knox Vale, GR0K, and the travel terminal
  -> move/fight/sample/harvest with universal baseline verbs
  -> obtain equipment from the world economy
  -> use profession training for efficiency and specialist depth
  -> turn world materials into equipment, supplies, or a Scout camp
  -> travel outward without changing the cardinal frame
```

The character record and Rust actor are created as one retry-safe first-entry
flow. A returning character restores authority inventory and receives nothing
again. Older characters that never entered the world must resolve one initial
allocation before entry; retrying the same selection is safe, while a different
second selection is rejected.

## Starting allocations

All five choices spend the same 16-point novice cost. None grants a weapon,
tool, medicine, ammunition, or other supply item.

| Allocation | Initial authority change | Immediate valid play |
| --- | --- | --- |
| Marksman | Learn the Marksman novice box. | Universal unarmed combat remains available; ranged combat starts after obtaining a certified weapon and ammunition. |
| Scout | Learn the Scout novice box. | Universal creature harvest remains available; Scout training adds specialist yield and XP. |
| Craftsman | Learn the Craftsman novice box. | Hand sampling remains available; extraction and tool surveying begin after obtaining the required equipment. |
| Medic | Learn the Medic novice box. | Universal baseline verbs remain available; field medicine begins after obtaining applicable supplies. |
| Brawler | Learn the Brawler novice box. | Universal unarmed combat is immediately available; melee weapons must still be obtained. |

Learning or relearning any novice box changes skills and budget only. The
Craftsman trainer can issue a missing Field Multitool or Mineral Survey Tool
through its normal recovery path; neither item comes from creation. Chemical,
gas, and water survey tools remain on their recipe paths. Unlearning returns the
box's 16 points without revoking owned items. Removing a weapon certification
unequips the newly uncertified weapon and clears its queued combat action;
re-equipping still requires the applicable learned certification.

## Universal baseline, specialist depth

The baseline verbs stop the professions from becoming circular prerequisites.
Professions make an activity richer; they do not own the first physical verb.

| System | Universal baseline | Profession/equipment depth |
| --- | --- | --- |
| Combat | Any live player can use the basic attack unarmed. Authority resolves Unarmed as model-free melee with no certification. | Aimed shot still requires an equipped weapon. Weapons, certifications, accuracy, damage, handling, ammunition, and profession tracks provide depth. Kill XP follows the equipped route only while Brawler or Marksman is learned. Scrapline Machete, Field Saber, and Quarry Chopper are primitive no-cert blades. Vibrosword requires `brawler-melee-iii`; Plasma Sword remains at Melee IV. |
| Resource gathering | **Hand sample** opens the resource-family picker. `SampleResource` then works at the player's position without a profession or tool and can repeat until stopped. | **Tool survey** opens the same picker, but Craftsman plus the matching survey tool is required to produce the richer concentration map. Craftsman plus the matching extractor rig enables placed extraction. |
| Creature gathering | Any live player in range can harvest an eligible downed creature into Hide, Meat, and Bone. | Scout training improves yield and enables Scout harvest XP, specialist bonuses, and later boxes. |
| Crafting entry | A carried local raw-resource stack exposes **OPEN CRAFTING**. A carried Field Multitool is another entry point. | Each recipe owns its skill-box, tool, material, schematic, and experimentation gates. Most recipes require a Field Multitool. |
| Basic construction | Camp Kit and Field Multitool are explicitly hands-craftable recipes. | Camp Kit requires Scout novice; Field Multitool requires Craftsman novice. Deeper recipes require the appropriate tool and skill box. |
| Travel | Any eligible player can interact with the in-world travel terminal and use the authority travel path. | Tickets, routes, restrictions, and future travel progression remain data/authority concerns, not map-camera tricks. |

Hand sampling awards Craftsman survey XP only after Craftsman is trained,
creature harvesting awards Scout XP only after Scout is trained, and kill-time
combat XP awards Brawler or Marksman XP only after the routed profession is
trained. The underlying sampling, harvesting, and basic-combat verbs remain
usable without those professions.

## Progression ledger contract

Track skill boxes require both general profession XP and the named track XP.
Their usable balance is the smaller of those two pools. The Skills ledger paints
that usable balance, treats a missing track as zero, and names the exact pool in
the hover instead of substituting general XP into unrelated bars. Each hover
also lists the exact XP and skill-point cost plus weapon certifications,
crafting schematics, and authority actions unlocked by that box.

Craft assembly pays only its assembly track. A real experimentation attempt pays
the experimentation track. A trained Craftsman's completed hand sample pays
only Craftsman Survey; a full heat-map survey is informational and currently
mints no XP. Applied medicine healing pays Medicine Use and Medicine Speed but
increments the shared Medic pool only once. Training spends the exact pools,
and both individual unlearn and bulk career respec restore every removed box's
exact spent XP. Credits spent on a skill-box purchase are not refunded.

Crafting shows authority-eligible recipes by default. **Show ineligible** is an
opt-in discovery view. Trainer conversation likewise omits XP-ineligible
purchase choices by default while the full Skills ledger remains available for
planning.

Credits are the sole monetary denomination across those paths. The actor wallet
is authority truth; a Credit Chip is only a physical redeemable voucher.

## Scout camp: complete in-world path

The basic Camp Kit deliberately avoids copper, coal, a survey tool, and a
multitool. Its canonical recipe is Scout novice plus 24 Bone and 36 Hide.

1. Start as Scout or buy `scout-novice` from Knox Vale.
2. Hunt a harvestable creature with any equipped weapon or bare hands.
3. Harvest the corpse; this base verb has no profession or tool requirement.
4. Repeat until carrying at least 24 Bone and 36 Hide.
5. Open either carried raw-resource stack and choose **OPEN CRAFTING**.
6. Begin Camp Kit, assign Bone and Hide, assemble, and finalize the prototype.
7. Use the finished Camp Kit from inventory while standing on a valid,
   unblocked world cell.

Placement consumes the kit and creates one authority-owned dynamic camp. The
3D client renders the real Scout tent/campfire presentation; it is not a menu
placeholder. The camp supplies weather shelter while the player physically
occupies its shelter footprint.

Only one camp may be active per player. It persists indefinitely while the
owner remains within six cells. Leaving that radius arms a ten-minute real-time
basic abandonment grace; Campcraft training can extend it. Returning
cancels/resets the deadline. The camp tears down only after the applicable
deadline has been exceeded. Manual pack-up requires the owner nearby and does
not refund the consumed kit.

## Start-zone anchors

### Knox Vale — implemented trainer and per-box unlearning

Knox is the in-world profession trainer in Dustgate. He teaches Marksman,
Scout, Craftsman, Medic, Brawler, and Bio-Engineer paths, handles skill-box
purchases, per-box unlearning, and career-goal respec, and can issue a missing
Field Multitool or Mineral Survey Tool through the Craftsman recovery path.
Authority and Skills-ledger coverage prove skill-point refund, retained XP,
dependent-box rejection, certification cleanup, and the rule that training
never grants equipment. He is the normal route into professions after creation;
debug grants are not part of the player pathway.

His **How do I get moving?** dialogue branch is the authored first-session
field guide. It explains ordinary skill-point spend, then routes the player
through universal hand sampling, trained tool surveying, creature
hunting/harvesting, the 24-Bone/36-Hide Scout camp, raw-resource crafting, and
world acquisition of the first equipment. This keeps guidance on Knox while
GR0K's eventual purpose remains genuinely open.

### GR0K — implemented shell, purpose intentionally open

GR0K is a named start-zone actor using the promoted humanoid droid body and
shared humanoid idle animation contract. He can be targeted, named, examined,
and treated as an authority-protected social camp actor. Direct combat commands
reject him as a protected civilian; this is not merely a client-side PvP hint.
His identity reads as a humanoid droid rather than leaking an implementation
role. He intentionally has no trainer, merchant, quest, or combat purpose yet.
His eventual role should connect systems only after that role is designed; the
current implementation does not fake a quest with no outcome.

### Travel terminal — implemented replacement

The Dustgate and Lowbough terminals use the promoted Grok wedge terminal. Its
named screen module receives the animated strip/pulse treatment, while the
existing travel interaction and authority command remain the gameplay owner.
The same asset key is also reused by the current land-registry presentation.

## Player report pathway

`/bugreport` is a support command, not chat. It fronts a transient report
window with category, a 20-to-4,000-character description, explicit diagnostic
disclosure, keyboard submission, and draft-preserving failure states.

The client assigns a UUID and sends
`successor.bug-report-submission.v1` over the active authenticated Colyseus
room. The room validates a strict 48 KiB envelope, applies an account-scoped
five-per-minute limit, ignores all client identity claims, and binds account,
owner, character, launch, shard, and immutable client/server releases from the
admitted session. The control store redacts diagnostics again and persists an
idempotent row in the checksum-pinned `alpha-control-bug-reports-v2` ledger.
The acceptance receipt returns the stable report id to the player.

Attached diagnostics are deliberately operational rather than personal: area,
position, ticks, vitals, selected interaction, connection and prediction
counters, recent command identities and receipts, input bindings, open window
ids, renderer health, and a bounded runtime-error tail. They exclude
credentials, tickets, cookies, passwords, chat text, and inventory contents.
Operators retrieve the ledger read-only through the command documented in
`OPERATIONS.md`; it is included in the existing control-database backup
boundary.

## Cardinal contract

There is one coordinate rule from authority through every player-facing view:

| World delta | Meaning | Screen direction |
| --- | --- | --- |
| `-Y` | North | Up |
| `+Y` | South | Down |
| `+X` | East | Right |
| `-X` | West | Left |

W/Up, S/Down, D/Right, and A/Left send those raw world deltas. The 3D camera
may pitch but does not rotate the cardinals. Radar, tactical map, orbital map,
survey map, bearings, and the TUI preserve the same north-up basis. Framing may
change; orientation may not. The cross-surface cardinal contract test is the
regression boundary for future map, camera, radar, and movement edits.

## Current gaps and intentional holds

### Player-path gaps

- **Hosted ticket issuer mismatch:** local character creation owns the
  profession picker, and first world entry requires `initialProfessionId`.
  The current canonical ComPress character-create route accepts `{name}` and
  its first-time ticket payload omits that field. The game therefore fails
  closed with `initial profession selection required` instead of inventing a
  default. Existing stored ticket characters remain compatible. The owning
  ComPress route and ticket issuer must add the picker payload atomically before
  hosted first-time provisioning is release-ready.

### Presentation/provenance gates

- The Grok terminal and GR0K are wired into runtime and their isolated
  Successor in-camera/post-stack material, animation, and examine proof passed
  in `verification/ledgers/artifacts/client3d/client3d-gate-20260714211601-5c84fefd/client3d-gate-report.json`.
  Their public provenance is sanitized and records proprietary Successor
  runtime-distribution rights. It grants no standalone or open-content reuse.
- The Scrapline Machete is wired as an authority weapon, and its byte-identical
  source/runtime provenance is recorded. Its former starter-era journey proved
  stow, draw, first swing, and kill presentation in
  `verification/ledgers/artifacts/client3d/client3d-gate-20260714204314-6f9b6f2d/client3d-gate-report.json`.
  Creation no longer grants it. Its proprietary runtime-distribution rights
  likewise grant no standalone reuse.
- The Kiln Energy Cell Carbine and Lightning Carbine are integrated runtime
  weapons with source/runtime provenance. Lightning passed its 3,500-triangle
  gate and headed progression, firing, reload, and stow proof on July 15.

### Source holds

- The astromech stays prop-grade source until static, hover, or rigged movement
  is chosen and supplied with the required sockets/animation contract.
- Cloudsheep remains a reviewed two-state creature source until one species id,
  behavior, bounds/selection, wool-state transition, and in-camera proof exist.
- The reviewed July asset wave is a source library, not a bulk runtime import.
  Promote one stable gameplay id and one verified consumer path at a time.

### Focused journey evidence

- **Camp:**
  `verification/ledgers/artifacts/client3d/client3d-gate-20260714210202-5ce5e873/client3d-gate-report.json`
  passed with zero console errors. The journey starts with exactly 24 Bone and
  36 Hide rather than a debug-granted kit, crafts through the normal UI, places
  on a measured clear footprint, arms and clears the abandonment countdown,
  and packs the camp. It does not replace the broader hunt-to-material-total or
  full ten-minute teardown acceptance path.
- **Universal unarmed:**
  `verification/ledgers/artifacts/client3d/client3d-gate-20260714210208-a51d6d2c/client3d-gate-report.json`
  passed with zero console errors for an ordinary Scout with no Brawler grant,
  no equipped authority weapon, and no rendered weapon roots; the visible
  `swing_h1` produced an authoritative one-damage hit.
- **Scrapline weapon (historical starter-era proof):**
  `verification/ledgers/artifacts/client3d/client3d-gate-20260714204314-6f9b6f2d/client3d-gate-report.json`
  passed with zero console errors across stow, draw, first swing, and kill.
- **GR0K and wedge terminal:**
  `verification/ledgers/artifacts/client3d/client3d-gate-20260714211601-5c84fefd/client3d-gate-report.json`
  passed with zero console errors. It records GR0K rendered idle and examinable,
  plus two distinct post-stack terminal-screen frames proving the green screen
  is visible and animated.
- **Carbine progression:**
  headed run `weapon-carbine-progression-final-20260715` proved item 3121
  certification denial and acceptance, mount, firing, magazine consumption,
  reload completion, and stow with zero console errors. The synchronized reload
  grid is recorded in the Lightning Carbine provenance file.

## Next coherence gates

The next pass should be accepted only when these player journeys work without a
debug command:

1. Fresh characters of every starting allocation enter with exactly one novice
   box, 16 used skill points, item 9,900,001, and item 7,319. They have no
   weapon or profession kit. Unlearning and relearning return/spend the same
   points without changing inventory or leaving uncertified equipment usable.
2. A non-Craftsman selects a resource family and successfully hand-samples from
   the 3D UI without already owning a survey tool or previous family context.
3. A non-Scout trains Scout at Knox, harvests enough creatures, opens crafting
   from a raw-resource stack, makes a Camp Kit by hand, places it, leaves for
   more than ten minutes, and observes authority teardown.
4. A non-Craftsman trains Craftsman later, obtains no equipment from the skill
   purchase, and uses Knox's recovery path for only the missing Field Multitool
   or Mineral Survey Tool. Chemical, gas, and water survey tools stay on the
   recipe path.
5. An unequipped player fights unarmed; a player who obtains and equips a
   Scrapline Machete renders that weapon rather than a Vibrosword.
6. Moving one measured segment north, south, east, and west produces the same
   up, down, right, and left relationship in world view, radar, both datapad
   framings, survey view, and TUI.
7. GR0K and both terminal presentations pass an in-camera visual check without
   assigning GR0K functionality that the authority does not provide.

The runtime journeys behind those gates should assert state, not only copy or a
button click:

- **Creation/unlearn:** compare exact item ids and quantities before entry,
  after entry, after unlearn, and after relearn; require only the fixed bodysuit
  and boots at creation; compare used SP and retained XP; assert dependent-box
  rejection; assert both per-box unlearn and bulk respec clear a newly
  uncertified equipped weapon and its queued attack.
- **Universal resources:** assert the picker submits a concrete family rather
  than `$last`; accept a no-tool sample and a no-tool creature harvest; verify
  material deltas; verify neither action awards its profession XP until that
  novice box is trained.
- **Combat:** accept an unarmed basic attack, reject an unarmed aimed shot,
  project `unarmed` in the combat event without a held model, and route its
  combat XP to Brawler rather than Marksman.
- **Camp:** assert raw-resource **OPEN CRAFTING**, exact 24 Bone/36 Hide
  consumption, one kit produced then consumed, one placed-camp snapshot, no
  collapse at the exact grace deadline, and collapse on the first later tick.
- **Cardinals:** record the authority delta and projected screen delta for all
  four directions in the same journey, across world view, radar, map framings,
  survey, and TUI; assert signs and zero drift on the orthogonal axis.
- **Start-zone art:** assert GR0K resolves the special humanoid body without
  human wardrobe/equipment, and assert the terminal finds its exact screen node
  and advances the animated texture before taking the in-camera proof.

Rust authority remains the source of truth for inventory, skills, combat,
resources, crafting, camp lifecycle, and travel. Client labels and local
predicates may explain those rules, but must not become a second gameplay
implementation.
