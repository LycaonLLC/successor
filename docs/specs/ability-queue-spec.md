# Successor Ability / Command Queue Spec

Owner target 2026-07-08. Author: AbilityQueueSpec. Scope: **SPEC ONLY** for adoption #3 phase 1; no product code changes.

Clean-room provenance: this behavior contract was informed by external command-queue implementations, then rewritten for Successor's deterministic fixed tick. No external code, comments, or tables are copied here.

Local anchors studied: `crates/successor-sim/src/authority/{commands,combat_roll,tick_lifecycle,snapshots,model}.rs`, `server/src/game/{protocol,shard,rustAuthorityBridge}.ts`, `client/src/slice-core/{weaponFireSystem,authorityCommandSystem}.ts`, and `client-3d/src/{boot/input,ui/hud/toolbarActions}.ts`.

---

## 0. Evidence that fixes the shape

- Core3 command transport is queue-shaped, not fire-and-forget: spam clear at 5 commands in 1s (`CommandQueueEnqueue.cpp:34-62`), queue priority lookup before enqueue (`:43-62`), depth cap for AI and global queues (`CommandQueue.cpp:446-452`), 50ms task cadence (`CommandQueue.h:25-33`, `CommandQueue.cpp:490-495`).
- Core3's drain is timered around next action time, auto-attack delay, posture/attack delay, and priority selection (`CommandQueue.cpp:77-128,183-229,300-330`). Successor keeps the ordering idea, but replaces wall-clock timers with authority ticks.
- Core3 validates command definition/ability/admin/command execution/failure callback in that order (`ObjectControllerImplementation.cpp:71-180`). Successor should keep one deterministic validation order and return explicit receipt `reasonCode`s.
- Today, Successor has a narrow roll-combat queue: cap 2 (`combat_roll.rs:3,93-124`), drain at weapon speed (`:358-400`), enqueue validates target/range/LOS and writes queue state (`:1090-1157`), Peace clears auto entries (`:1160-1179`), and queue state already joins the stable hash (`snapshots.rs:332-337`).
- Today, `QueueCombatAction` and `Peace` are the wire commands (`commands.rs:207-216`, `protocol.ts:184-192`), while `weaponFireSystem.ts:44-68` resends `QueueCombatAction` every 250ms while held. This spec moves that repeat loop to the server.
- The fixed tick order already has posture, move intent, then combat queue drain (`tick_lifecycle.rs:29-31`). C3 should extend that slot, not add wall-clock tasks.

---

## A. Queue model

### A.1 Stored actor state

Each actor gets one deterministic `AbilityQueue` state:

- `next_ready_tick: u64` — earliest tick any combat action may execute.
- `entries: Vec<AbilityQueueEntry>` — ordered explicit one-shot entries.
- `repeat_intent: Option<CombatRepeatIntent>` — the owner/auto-repeat slot; it does not block explicit one-shots.
- `pending_posture: Option<PostureQueueEntry>` — at most one queued posture transition.
- `sequence: u32` — actor-local monotonic queue id for cancel/debug; wraps only through replay-tested `wrapping_add`.

Hash order is actor iteration order already used by `stable_state_hash_hex`; inside the queue, write `next_ready_tick`, `sequence`, `pending_posture`, `repeat_intent`, then `entries` in queue order.

### A.2 Priority classes

Priority is a drain/processing contract, not a thread or timer:

1. **Utility** — `Peace`, `CancelAbilityQueue`, and future queue-management commands. These execute at tick-boundary validation time, mutate/clear queue state, emit a receipt, and are not retained as queue entries.
2. **Posture** — `SetPosture` style transitions. One pending posture entry per actor; a new posture intent replaces the old pending posture intent.
3. **Combat action** — weapon/ability actions such as `basic_shot`, `aimed_shot`, and melee attacks. Explicit specials append; owner/auto repeat lives in `repeat_intent` and materializes only when no explicit combat entry is ready.

Drain order per actor on tick `T`: utility effects already applied, then posture if legal/ready, then the first explicit combat entry if `T >= next_ready_tick`; if no explicit entry exists, drain `repeat_intent` if legal and ready.

### A.3 Depth caps

- Player-like actors: max **15 retained queue items**. Count explicit combat entries + pending posture + repeat intent if present. Utility commands do not count.
- AI actors: max **5 retained queue items** by the same count.
- Replacement paths (`repeat_intent` replacement, pending posture replacement) do not test the cap because they do not increase depth.
- Append paths reject before mutation when the new retained count would exceed the actor's cap. Receipt reason: `queue_full`.

### A.4 Replace vs append

- `basic_shot` from owner attack input arms/replaces `repeat_intent` with `{ability_id,target_actor_id,source:"owner",armed_at_tick}`. Re-arming the same target is accepted and only refreshes `armed_at_tick`; it never appends spam entries.
- `aimed_shot` and future specials append explicit combat entries unless marked repeat-capable by ability data. They execute once.
- A new explicit combat entry does not remove `repeat_intent`; specials interleave ahead of repeat, then repeat resumes at the next cadence.
- `SetPosture` replaces `pending_posture`. If the actor is already in or moving toward the requested posture, reject `posture_locked` rather than enqueueing a no-op.
- `Peace` clears combat entries and `repeat_intent`, sets the existing `peace_requested` suppression flag, and leaves posture alone.
- `CancelAbilityQueue` clears by scope: `owner_repeat`, `combat`, `posture`, `all`, or a specific queue id. Unknown id returns `queue_entry_unknown`; clearing an empty matching scope is accepted idempotently.

### A.5 Queue clears

Clear all retained queue state on actor death/non-Alive transition, respawn restore, owner session exit that releases control, or actor removal.

Clear combat-only state on `Peace`, `CancelAbilityQueue{scope:"combat"|"owner_repeat"}`, target becoming invalid, weapon unequip/no weapon, ammo permanently unavailable, or a posture lock that makes the head combat entry illegal.

Clear only illegal entries on posture locks: e.g. kneeling rejects/clears melee entries with `melee_while_kneeling`; ranged entries may continue if the weapon/ability permits kneeling.

---

## B. Fixed-tick timing

### B.1 Ingress to tick boundary

Network ingress performs only non-simulation admission: packet schema, session/player identity, duplicate command id, debug-command disable, weapon de-roster check, and future C1 token buckets (`shard.ts:2043-2085,3701-3786`). Passing envelopes are buffered for the next authority tick; they do **not** advance Rust one tick per command.

At authority tick `T`, the sim processes buffered envelopes in deterministic order: `(session id, command id)` after transport has assigned them to the tick. Same-actor same-tick order is command id order, so `Attack; Peace` clears and `Peace; Attack` re-arms.

### B.2 Validation order at tick boundary

For each admitted envelope:

1. envelope/session/player/duplicate checks already mirrored in Rust stay first (`wrong_session`, `wrong_player`, `duplicate_command`, `unknown_actor`);
2. command kind/model compatibility (`wrong_combat_model`);
3. actor state (`actor_not_alive`, `actor_asleep`, `posture_locked`);
4. command/ability id and permission (`target_unavailable` for unknown ability until a dedicated ability registry reason exists);
5. equipment/resource prerequisites (`no_weapon_equipped`, `insufficient_action`, `ammo_unavailable` if impossible now and not a reload wait);
6. target relation/area/life/attackability (`target_unavailable`);
7. range/LOS for combat queueing (`out_of_range`, `los_blocked`);
8. queue replacement or depth append (`queue_full` only after the action is otherwise valid).

Accepted queue commands mutate only the queue state. Roll resolution and combat
events happen later in the tick drain.

### B.3 Drain cadence in ticks

No wall-clock timers. Convert action speed with the existing tick helper shape: `action_speed_ticks = ms_to_ticks_round(action_speed_ms * ability_speed_multiplier, tick_rate_hz).max(1)`.

When a combat action resolves at tick `T`, set `next_ready_tick = T + action_speed_ticks`. If `next_ready_tick == 0` on first enqueue, initialize it to `T`, so the first attack can drain at the same boundary when the actor is otherwise ready.

If reload/fire cooldown says "not ready yet" but the action remains legal, do not pop the entry; set `next_ready_tick = max(next_ready_tick, readiness_tick)` and try again then. Cooldown is backpressure, not a reject.

Execution-time revalidation repeats mutable checks (actor alive, posture, weapon, target alive/area/LOS/range, action resource). Permanent failure pops/clears and emits a queue-failure combat/receipt event; temporary cooldown waits as above.

### B.4 Engagement and auto-repeat

A combat enqueue against a target sets/refreshes `engagement_target_id`, clears `peace_requested`, and bumps the existing roll-combat `combat_until_tick` duration. Melee uses the same engagement target and cadence; melee-specific posture/range failures use existing `melee_while_kneeling` / `out_of_range` reasons.

`repeat_intent` is the server-owned replacement for the client top-up loop:

- held fire: client sends one `QueueCombatAction{basic_shot,target}` on trigger down/target acquire;
- server repeats at weapon speed while `repeat_intent` remains valid;
- explicit specials drain before repeat, then repeat resumes;
- release/target loss sends `CancelAbilityQueue{scope:"owner_repeat"}`; explicit stand-down sends `Peace`;
- auto-return-fire may arm `repeat_intent{source:"auto"}` only when no owner repeat exists, the actor is in combat, and `peace_requested` is false.

Server-generated repeats do not consume ingress budget and do not add commands to the replay input; they are deterministic consequences of hashed queue state.

---

## C. Ingress budgets and queue caps

C1 token buckets and ability queue caps compose as two gates:

1. **Ingress budget gate** outside the sim: per session and command kind. Failure returns `ingress_budget_exhausted`, records a transport rejection, and does not enter the deterministic command stream.
2. **Queue/state gate** inside the sim at tick boundary. Failure returns the specific authority `reasonCode` and is part of replay because the command reached the sim.

Budget tokens are consumed only for envelopes admitted to the tick buffer. Queue replacement still consumes ingress budget; otherwise a client could bypass C1 by spamming target replacements.

Required reason codes:

| Failure | reasonCode |
|---|---|
| C1 token bucket empty | `ingress_budget_exhausted` |
| queue append over cap | `queue_full` |
| cancel id not present | `queue_entry_unknown` |
| wrong command/combat model | `wrong_combat_model` |
| actor unavailable/dead/asleep | `unknown_actor` / `actor_not_alive` / `actor_asleep` |
| posture transition or illegal posture | `posture_locked` / `melee_while_kneeling` |
| invalid target or attack relation | `target_unavailable` |
| range or line of sight | `out_of_range` / `los_blocked` |
| weapon/action prerequisites | `no_weapon_equipped` / `insufficient_action` / `ammo_unavailable` |

---

## D. Replay and stable hash

- The replay input remains the admitted client command stream. Do not serialize server-generated repeat attacks as commands.
- `AbilityQueue` state joins `stable_state_hash_hex`: queue order, next ready tick, repeat source, target id, ability id, enqueued tick, pending posture, and queue ids.
- Use only tick math, actor ids, command ids, and deterministic ability data. No wall-clock, JS receipt timing, HashMap order, or session-local mutable budget state in the hash.
- Rejected commands that fail after entering the sim must leave the hash unchanged unless their accepted utility effect is the clear itself.
- Add relational replay tests: same initial state + same admitted command stream yields identical hash; one queue mutation changes hash; Peace/cancel restore the empty-queue hash.

---

## E. Migration contract

Phase C3 should keep today's wire commands first:

- `QueueCombatAction{action_id:"basic_shot",target_actor_id}` maps to owner `repeat_intent` for that target.
- `QueueCombatAction{action_id:"aimed_shot",target_actor_id}` maps to one explicit combat entry.
- `Peace{}` maps to utility clear of combat entries + repeat intent, sets `peace_requested`, and does not end the existing in-combat timer by itself.
- Add neutral `CancelAbilityQueue` for input-release/cancel UX. If C3 defers the new command, release may use `Peace`, but that is a gameplay change because it suppresses auto-return-fire; prefer the cancel command.

Client changes:

- `weaponFireSystem.ts` removes `ROLL_QUEUE_RETRY_MS` and the 250ms top-up loop. It sends one queue command on trigger down/target acquire and one cancel on trigger up/target loss.
- Toolbar/radial/double-click Attack can intentionally arm repeat-until-Peace for established sandbox-style auto attack.
- Client UI maps queue receipts to player copy; server `reasonCode`s stay snake_case protocol values.

Server/Rust changes:

- Replace the current cap-2 `CombatActionQueue` with `AbilityQueue`, keeping existing roll attack resolution and hash participation.
- Move command application to tick-boundary buffering once A1's tick-safe envelope lands; until then, do not add any new per-command tick advancement path.
- Keep snapshots compact: expose queue state only if needed for UI/debug; hash participation is mandatory even if not streamed.

---

## F. FE view-model contract (Main-owned implementation)

Contract only; Main owns the FE. Queue visibility is **player-only**: the server may send `abilityQueue` only on the owning session channel for the local actor. AOI/world actor snapshots must never expose other actors' queues.

Static ability definitions add `icon_id: string`; the session view maps it to `iconId` so the FE can render ability icons without guessing.

Wire shape:

```ts
interface AbilityQueueView { actorId: string; nextReadyTick: number; entries: AbilityQueueEntryVM[]; repeatIntent?: AbilityQueueEntryVM; }
interface AbilityQueueEntryVM { id: string; abilityId: string; iconId: string; class: "combat"|"posture"|"utility"; targetActorId?: string; lifecycle: "enqueued"|"pending"|"fired"|"dismissed"; enqueuedAtTick: number; readyTick?: number; firedAtTick?: number; dismissedAtTick?: number; reasonCode?: string; fireSeq?: number; }
interface AbilityQueueEvent { id: string; lifecycle: "enqueued"|"pending"|"fired"|"dismissed"; tick: number; reasonCode?: string; fireSeq?: number; abilityId?: string; iconId?: string; }
// abilityId/iconId ride fired/dismissed events so a one-shot that enqueues,
// fires, and drains between view snapshots can still materialize its FE beat.
```

Lifecycle timing: `enqueued` is emitted on the tick an intent is accepted into queue state; `pending` means accepted but waiting on cadence/cooldown/posture; `fired` is the **FIRED** transition, a distinct event on the exact execution tick (the FE green-flash trigger); `dismissed` is emitted when an entry drains, is cleared, or is rejected/invalidated, always carrying `reasonCode` when dismissal is not a normal drain.

Stable ids: explicit entries keep one id from enqueue through dismissal. A repeat intent keeps one id while armed; every server repeat emits `fired` with incrementing `fireSeq`, then returns to `pending` until cleared.

Clear button command: the FE maps to the single wire command `CancelAbilityQueue{queue_entry_id?: string, scope?: "owner_repeat"|"combat"|"posture"|"all"}` (§A.4 scopes; there is no separate `ClearCombatQueue`). Empty-scope clears are accepted idempotently; unknown `queue_entry_id` rejects `queue_entry_unknown`; wrong model/actor/life reject `wrong_combat_model`, `unknown_actor`, or `actor_not_alive`.

---

## G. Test matrix for C3

Rust unit/replay:

- player cap 15 and AI cap 5, with replacement not increasing depth;
- `basic_shot` repeat sends one client command and drains multiple attacks at weapon-speed ticks;
- explicit `aimed_shot` interleaves before repeat and repeat resumes;
- Peace clears combat/repeat and suppresses auto-return-fire without ending in-combat immediately;
- cancel owner repeat is idempotent; unknown queue id rejects `queue_entry_unknown`;
- death/respawn and weapon unequip clear queue state;
- posture lock rejects or clears illegal melee while preserving legal ranged entries;
- cooldown/reload waits without popping; permanent ammo unavailable clears;
- queue state participates in stable hash and replay determinism.

Server/client targeted:

- protocol/vitest covers `QueueCombatAction`, `Peace`, `CancelAbilityQueue`, and new reason codes;
- server ingress budget test proves budget reject happens before Rust submit and does not mutate replay state;
- `weaponFireSystem` hold test proves one queue command per hold, no 250ms retry, cancel on release;
- toolbar/radial Attack and Peace still enqueue the intended authority commands.

Required gates for implementation: `cargo test -p successor-sim`, targeted server vitest for protocol/shard receipts, targeted client tests for weapon fire and authority command queue. No skipped tests; no golden/hash update without the relational replay proof above.

---

## H. Staged implementation queue

Replay class legend: **[stored]** joins `stable_state_hash_hex`; **[TS]** server protocol/bridge; **[client]** client input/UI; **[gate]** must be proven before the next stage.

### C3.0 — Contracts only `[TS][client]`

Add/ratify neutral protocol shape for `CancelAbilityQueue` and receipt copy maps without changing queue behavior. Gate: protocol/client command tests only.

### C3.1 — Rust queue state `[stored]`

Introduce `AbilityQueue`, queue ids, caps, repeat intent, pending posture, and hash writing. Keep current `QueueCombatAction` behavior behind a compatibility adapter until C3.2. Gate: hash participation + empty/reject no-op tests.

### C3.2 — Tick-boundary enqueue and drain `[stored][gate]`

Move `QueueCombatAction`/`Peace` mutation to the fixed tick boundary, validate in §B.2 order, drain explicit entries then repeat intent at `next_ready_tick`. Gate: deterministic replay tests and `cargo test -p successor-sim` targeted queue subset.

### C3.3 — Client repeat removal `[client][TS]`

Remove the 250ms roll top-up loop, send one queue intent per hold, and send cancel on release/target loss. Gate: client hold test + server receipt test proving one command produces repeated authoritative attacks.

### C3.4 — C1 composition hardening `[TS][gate]`

Once ingress token buckets land, assert budget rejects occur before Rust submit and queue caps still reject inside the sim. Gate: shard vitest for `ingress_budget_exhausted` vs `queue_full`.

Ship criteria: all stages above green, no skipped tests, no wall-clock queue timers, and no replay/hash ceremony bypass.
