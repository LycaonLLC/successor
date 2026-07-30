# Multiplayer Situation Catalog

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against `main` before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner: MultiplayerQAO (multiplayer QA lane, successor creative-wave).
Harness: SP6 scenario runner (`tools/verification/scenario/`), multi-actor `actors{alpha,beta,...}`, driven headlessly by `client/dist/headless/cli.js` against a transient per-scenario shard. Position/state truth is asserted via the **ORACLE** (`/game/debug/oracle`) and command **receipts**, never `/where` for cross-actor truth (DEF-1 own-actor query staleness; closed by SP1Verbs eb8e22b, oracle stays the cross-actor source of truth).

Priority is QA-risk first: cases that can dupe items, leave ghost state, hand out unfair rewards, or emit dishonest rejects (P0/P1) rank above social polish (P2).

## How these run

- Each scenario is a `successor.scenario.v1` file under `tools/verification/scenario/scenarios/multiplayer-*.scenario.json`, auto-discovered by `pnpm play:gate`.
- Fixtures are registry entries in `tools/verification/scenario/fixture-registry.v1.json` (`open-desert-multiplayer-*`). Proof props/actors are `sliceOverlay` on a materialized per-run slice copy — never the shared `open-desert-slice.json` (fixture law).
- Determinism anchor: every scenario asserts `stableHash sourceStateHash:"fixture"` (deterministic start). Final snapshot digests are reproducible for movement/economy but vary for combat (finding F5); the gate contract is "green ×2", not identical combat digests.

## Priority-ordered situation catalog

| Prio | Situation | Status | Scenario | Fixture | Core proof |
|------|-----------|--------|----------|---------|------------|
| P0 | Mutual AOI visibility (A sees B present / move / life-state / kneel) | **IMPLEMENTED** | `multiplayer-mutual-visibility` | `open-desert-multiplayer-visibility` | A↔B via `/nearby`; B's move observed by A (`/nearby` x-delta) + oracle; B kneel via oracle posture; fight-visibility covered by loot/assist |
| P0 | Trade round-trip with wallet credits | **IMPLEMENTED** | `multiplayer-trade-roundtrip` | `open-desert-multiplayer-trade` | Open the item table, use `SetTradeCoin` (`/trade credits <id> <n>`) for either side's scalar-wallet offer, then double-lock and countersign; oracle verifies item and credit debits atomically |
| P0 | Loot-rights contention (2 attackers → ledger winner, loser honest reject) | **IMPLEMENTED** | `multiplayer-loot-contention` | `open-desert-multiplayer-loot-contention` | alpha damage lead → `lootRightsActorId=mp-loot-alpha`; beta honest `loot_no_rights`; alpha loots |
| P0 | Combat assist (two-on-one; XP vs current rule) | **IMPLEMENTED** | `multiplayer-assist-kill` | `open-desert-multiplayer-assist` | both `QueueCombatAction` accepted + each a `combat` event `damage>0`; BOTH damagers get full kill-ledger marksman XP (finding F1, fixed as DEF-2) |
| P1 | Chat ranges | **IMPLEMENTED** (zone) | `multiplayer-chat-range` | `open-desert-multiplayer-chat-range` | local/zone same-zone delivery, cross-zone exclusion, whisper sender+target only |
| P1 | AOI exit hygiene (B leaves A's radar → honest removal, no ghost) | **IMPLEMENTED** | `multiplayer-aoi-exit-hygiene` | `open-desert-multiplayer-aoi` | B rides discrete sprint moves past warm boundary; A `/nearby` `excludesObject{id:B}`; oracle keeps global truth (B alive off-radar) |
| P1 | Death + revive between players | **PENDING** | — | — | `ReviveActor` (`/revive <id>`) landed. Needs B downed (PvP overt, or scripted-down fixture) then `/revive`; combat-driven ⇒ generous timeouts. Oracle: downed target → accepted ReviveActor → revived vitals. |
| P1 | Exchange terminal contention | **PENDING** | — | — | `StoreToExchange`/`RetrieveFromExchange` landed (positional, driver-reachable). Needs a fixture with both actors within `EXCHANGE_INTERACTION_RADIUS` of an exchange-terminal prop; assert one atomic winner per exact variant, loser honest reject, no duped `EXCHANGE_CONTAINER` rows. |
| P1 | Ingress-budget fairness across two sessions | **PENDING** | — | — | `/budget` query + `ingress_budget_exhausted` receipt reason landed (IngressBudgets lane owns the buckets). Burst both sessions; assert per-session-fair rejects — one spammer must not starve the other's ordinary commands. |
| P2 | Extractor ownership boundary (non-owner collect reject) | **IMPLEMENTED** | `multiplayer-extractor-ownership` | `open-desert-multiplayer-extractor` | alpha places (device from fixture inv); beta `collect`+`crank` → `not_extractor_owner`; alpha destroys |

Implemented 7 of 10 (all P0 + both remaining P1 visibility/AOI + the P2 boundary). Pending 3 (death+revive, exchange contention, ingress-budget) — all feasible on landed primitives; the Core-proof column is the implementation recipe.

Runnable set, all green under `pnpm play:gate` (2 consecutive full-gate runs, 13 scenarios each): mutual-visibility, trade-roundtrip, loot-contention, assist-kill, chat-range, aoi-exit-hygiene, extractor-ownership. Deterministic final digests (identical across runs): mutual-visibility, trade-roundtrip, extractor-ownership, aoi-exit-hygiene, chat-range. Combat scenarios (loot, assist) pass green ×2 with fixture-hash determinism; their final digests vary by design (F5).

## Flip points (assertions to tighten when a dependency lands)

- **Assist XP → full all-damagers: LANDED (DEF-2).** GroupsSimO fixed the projection layer (shard preserve-on-omit + Rust from_actor any-progress emit); live groups-live-20260708122809 showed both = 175 XP, corroborated here.  now asserts BOTH  AND  . No open flip.
- **Chat range → spatial cell radius.** Current chat hub knows only zone IDs (finding F3). When chat consumes shard/AOI positions, replace the far zone client in `multiplayer-chat-range` with near/far cell positions in the SAME area and assert cell-radius delivery. Owner design ruling required.
- **Trade alias parsing regression guard.** `/trade <partner> offer=<sel>:<qty> request=<sel>:<qty>` (SP1Verbs 2bf1540) now covers the round-trip via the normal player verb path; keep the exact-variant oracle checks so alias-parsing or atomic-accept regressions are caught.
- **/where displacement re-tightening.** DEF-1 closed (eb8e22b); scenarios keep oracle asserts for cross-actor position (better), but own-actor displacement may re-adopt `/where` queryDelta where oracle was only a workaround.

## Findings (highest-value first)

### F1 — Kill-time XP paid only ONE of two concurrent human damagers — FIXED as DEF-2 (reported: Main, GroupsSimO)
Under GroupsSimO's kill-time XP cutover (3e3721e), a live 2-session ungrouped two-on-one credits only the primary damager. Evidence (oracle dump, assist fixture, rogue 300hp): `mp-assist-alpha` (role=player, 128 damaging hits) → `professions=[marksman xp:304 trackXp.rifle:304]`, auto-leveled to `marksman-rifle-i`; `mp-assist-beta` (role=player, 126 damaging hits on the SAME rogue) → `professions=undefined` (zero XP, no profession). Both pass `is_human_player_actor` and both should ledger via `record_damage_stats`. The unit test `kill_xp_pays_every_human_damager_full_ledger_total_by_weapon_track` claims all-damagers, but live `award_kill_combat_xp_to_damagers` credits only one. The same `player_damage_ledger` backs LOOT RIGHTS, so a 2nd concurrent attacker may also be invisible to loot rights (loot-contention passes only because `lootRights=alpha` is the trivially-recorded damager). RESOLUTION: GroupsSimO root-caused it to the PROJECTION layer (not authority) — the shard clobbered professions to undefined on Rust-omit and Rust from_actor emitted learned-only; both fixed at HEAD (shard preserve-on-omit + from_actor any-progress emit; mirror invariant test b0836a6). Live proof groups-live-20260708122809: both damagers = 175 marksman rifle XP.  now asserts BOTH damagers get full kill XP (the flip landed).

### F2 — Chat parity gap: FIXED during this wave
Original: headless driver only joined the Colyseus `game` room, never `/chat/ws`; no `/say` verb — scripted/agent players were mute. Addressed in-wave: the SP6 runner gained `chatConnect`/`chatSend`/`await:{kind:chat}`/`chatEnvelopeCount` steps (connect to `/chat/ws`), so `multiplayer-chat-range` runs end-to-end. Player-surface `/say` verb still routed to SP1Verbs.

### F3 — Chat is zone-scoped, not spatially ranged (DESIGN FORK for the owner)
The chat hub routes local/zone by **zone**, not cell radius; whispers to sender+target only. No established sandbox-style spatial `/say`. `multiplayer-chat-range` gates the current zone behavior + documents the flip. `server/src/game/routes.ts` `/game/debug/spatial-speech` (x,y bark surface) is machinery a future spatial `/say` could reuse — it is NOT player chat. MUD-soul question for the owner.

### F4 — `/trade` slash arg parsing gap: FIXED (SP1Verbs 2bf1540)
Original: `/trade` could not carry item specs because verb-registry repeated
values split JSON on commas. Item lines now accept quote/brace-aware
`item:quantity` selectors. Scalar credits are deliberately not item selectors:
each participant stages their own wallet amount with
`/trade credits <proposal-id> <amount>`. Any item or credit change clears both
locks before the dual countersign.

### F5 — SP6 final-snapshot digests non-deterministic across runs (reported: SP6PlayGate)
Every scenario's `finalSnapshotDigest` varies run-to-run — confirmed on movement-smoke, loot-journey, combat-receipt-journey. Cause: `DriverSession` flushes commands on a 16 ms wall-clock `setInterval`, so command arrival tick varies vs the fixed server tick. SP6PlayGate owns the fix (tick-aligned scheduling); the determinism anchor is `stableHash sourceStateHash:"fixture"`. combat-receipt-journey was also intermittently flaky (later stabilized).

## Harness lessons baked into these scenarios

- **Character store validation**: character `name` must match `/^[A-Za-z]{3,16}$/` and the `id` must be lowercase (`normalizeActorId` lowercases the joined `characterId`); an invalid name is silently dropped → `MatchMakeError: invalid characterId`.
- **Combat players join-spawn without an overlay** so deploy-loadout equips a weapon; the rogue is a `sliceOverlay` actor. Combat is sited in the camp-safe zone so unrelated population stays dormant; `/target <id>` is gated behind `/nearby includesObject{rogue}`.
- **AOI math**: viewport 160×120 + margin 64 ⇒ visible half-extent 144, warm 154; exit needs `dx>154`. `SetMoveIntent` is wall-clock-rate-limited (~0.65 cell/s) and slows under concurrency; discrete `/move` is tick-based (30-tick sprint ≈ 6.5 cells; `MAX_MOVE_DURATION_TICKS=30`) and load-independent — aoi uses discrete sprint moves.
- **Array-membership matchers** `includesObject`/`excludesObject` make AOI presence/removal robust to ambient NPCs (assert B specifically, not `actors[0]`/emptiness).
- **Deterministic ids**: first trade proposal on a fresh shard is `proposal_id=1`; first placed extractor is `extractor:<owner>:1`.
