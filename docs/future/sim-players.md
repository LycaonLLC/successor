# SimPlayers — synthetic long-horizon players for realistic gameplay soaks

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against `main` before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Status: DESIGN + working prototype landed in this lane. Prototype:
`tools/verification/simplayer/`; entry `pnpm sim:players -- --minutes 20 --population 4`.
Base tip validated: main `797ee63` (also green on `796fd25`).

## Mandate

> "fully testing and building out all infra required for testing under actually
> realistically simulated gameplay where we can essentially recreate actual live
> gameplay scenarios that would look to a human like regular gameplay. If we
> can't do stuff like that, our automated playsystems are just not developed
> enough."

The per-system journey harnesses (MUD 15 journeys, 3D 16 journeys) are the
FLOOR: they prove one mechanic each, deterministically, in isolation. This lane
is the next tier: **SimPlayers** — autonomous actors that run long, varied,
human-plausible sessions against a live shard, alone and together, so that the
shard's own counters/receipts see something indistinguishable from a populated
evening of play.

## What a SimPlayer is

```
SimPlayer  =  SP5 headless driver session (real-time tick)          [the hands]
           +  chat-hub socket (/chat/ws)                             [the voice]
           +  a behaviour brain: DAILY ARC / ACTIVITY LOOPS          [the intent]
           +  HUMAN PACING (seeded reaction latency, idle gaps)      [the tempo]
           +  a PERSONALITY SEED vector                              [the character]
```

It drives the **same** server-authoritative Rust sim the journey harnesses use
(`authority_bridge_server` + Colyseus shard, `GAME_SHARD_PERSISTENCE=0`,
`rustLive=true`). It never mocks anything: every action is a real `successor.driver.v1`
verb over the wire, every outcome is read back from the shard oracle / receipts.
It composes the **PlayFlows** primitives (`tools/successor/play-flows/`) rather
than reinventing them — `moveTo`, `surveyBest`, `sampleLoop`, `engageTarget`,
`trainSkill`, `issueAuthorityLine`, `query` — so a SimPlayer is literally
"PlayFlows-style behaviours, chained by a brain, at human tempo."

### The four layers

**1. DAILY ARC** (the session script). Login → orient → a goal loop of activities
weighted by personality → logout. Population logins/logouts are *staggered* so
the shard sees players trickle in and drift out, not a synchronised swarm.

**2. ACTIVITY LOOPS** (composable behaviours; `behaviors.mjs`). Each is a bounded,
narrated unit of play built from the driver primitives:

| loop | what it does | authority verbs |
|---|---|---|
| `patrolAndHunt` | leashed to a home ground: target nearest hostile in range → close → `basic_shot` (repeat-fire) → wait for the kill → step onto the corpse → loot/harvest | `/target /attack /loot /harvest-corpse` |
| `surveyMineCraft` | survey a family → sample iron near the workshop → kneel/stand → assemble+experiment+finalize a battery from the metals on hand | `/survey /sample /kneel /craft-*` |
| `trainerVisit` | walk to the Camp Trainer (distance-guarded) → purchase a skill box → request any missing Field Multitool and Mineral Survey Tool from the starter bundle | `/train-skill /request-starter-tool` |
| `campRest` | pitch a scout camp with a carried kit → rest a while | `/place-camp` |
| `traderRounds` | work the crowd near home, hawk wares on local/trade chat | (movement + chat) |
| `chatSmalltalk` | say a seeded, context-appropriate line | (chat hub) |
| `idle` | a human pause / look-around, occasionally a longer AFK step-away | (sleep only) |

**3. HUMAN PACING** (`personality.mjs` → pacing; `sim-player.mjs` → `pace()`).
Deliberate commands are preceded by a *reaction latency* in the owner's
**200–900 ms** band; loops are separated by *idle gaps* (a few seconds) with an
occasional longer *AFK* step-away; commands inside a loop are spaced by a *step
gap*. Typo-free but pause-y — the cadence a competent human keys at, never a
packet flood. All latencies are integer ms drawn from the seeded RNG, so pacing
is reproducible; only the shard's real-time execution jitters run to run. This
tempo is also why SimPlayers never trip the ingress token bucket (capacity 10,
refill 5/s per kind) — see invariants.

**4. PERSONALITY SEEDS** (`personality.mjs`). Each actor gets a deterministic
trait vector (integer milli 0..1000): `aggression, greed, chattiness, diligence,
caution, sociability, wanderlust`. An archetype preset centres the vector; the
per-actor RNG jitters it ±140 so two hunters are not clones. Traits bias the
weighted activity menu (a hunter mostly hunts, a trader mostly trades+chats) and
the pacing (diligent/aggressive → faster reactions; cautious → slower;
chatty/social → more chat, wider channels). A 10-player population therefore
*feels* varied from one base seed.

## Determinism discipline

The behaviour brain uses the sim's own seeded-hash pattern — **mulberry32** +
FNV-1a string hashing (`rng.mjs`, matching `client-tui/src/language/voice.ts`).
Every decision (which activity, which latency, which chat line, target
tiebreaks) is one integer draw from a per-actor stream keyed on
`(baseSeed, actorId, purpose)`. **No `Math.random`, no wall-clock in decisions,
no float accumulation.** Wall-clock is used only for what it must be — sleeping
the chosen latency, stamping transcript beats, and measuring soak elapsed to end
at N minutes. Given a seed, the *decision timeline* is reproducible; the shard's
real-time authority makes exact KPI non-identical run-to-run, which is correct
for a "realistic soak" (and why the oracle, not a golden hash, is the truth
source here — this tier sits ABOVE the deterministic journey gate, it does not
replace it).

## Multi-player choreography

A **population manager** (`population-runner.mjs`) spins N SimPlayers against one
claimed scratch shard and runs two things concurrently:

- **N solo arcs** — each SimPlayer's weighted activity loop, each iteration a
  task on a per-actor serial queue.
- **A choreography director** — at soak-fraction milestones it stages the
  cross-player beats, *claiming* participants between their solo activities via a
  race-free rendezvous (`choreograph()` parks each participant's serial queue
  behind a shared release gate, runs the interaction while it holds all of them,
  then releases). Because activities are bounded, a claim lands within one
  activity of its scheduled time.

Staged beats (scaled to `--minutes`):

| ~frac | beat | mechanic |
|---|---|---|
| 0.04 | crafter arc | Mora: `trainerVisit(craftsman-novice)` → `surveyMineCraft` |
| 0.06 | opening hunts | both hunters kick off `patrolAndHunt` |
| 0.20 | **group** | `formGroup(H0,H1)` — invite + accept, party on both sessions |
| 0.42 | **trade** | `tradeBetween(trader,H0)` — earlier sandbox design double-lock slash trade, oracle-verified swap |
| 0.55 | camp | crafter `campRest` |
| 0.70 | **duel** | H1 leaves party, then `duelBetween(H0,H1)` — challenge/accept, scoped exchange, honourable yield |

Solo arcs fill all other time; chat runs throughout and is *heard* cross-session
(the hub routes local/zone by websocket zone, so the whole population shares a
channel regardless of distance).

### Spatial layout (prototype)

Hunters + trader spawn as a cluster (~632,540) that overlaps rogue-zones 051+045
within a 60-cell **home leash** — hunters work a ground instead of chasing mobs
across the map (the leash is what keeps rendezvous cheap and navigation
stall-free). The crafter spawns at the Dustgate camp (513,514) next to the
trainer + resource veins. A materialized soak slice adds one authored body per
SimPlayer (faction `desert_wardens`, hostile to rogues) plus two
loot-bearing rogue stragglers in the cluster so at least one real `/loot` fires
(spawn-zone template rogues carry no drops — loot-table drops are the LootTables
lane's job).

## Observable acceptance oracles

The shard is the single truth source. Three artifacts per run
(`verification/ledgers/artifacts/simplayer/<runId>/`):

**1. Transcripts** — `soak-transcript.txt` (merged, time-ordered) + one per
player. Human-review-able beats: `Vale spots Kira Dray … closes in / opens fire
/ drops Kira Dray / loots 3x Stimpak`, `Vale invites Crane to group up`,
`Crane accepts — party formed`, `Pip opens a trade … goods change hands`,
`the duel ends with honor`. This is the "does it read like live play" gate.

**2. Per-session KPI** — `kpi.json`. Headline counters are driver-observed
(accepted receipts by kind): samples, crafts, trades, camps, loots, trainings,
duel challenge/accept/yield, group invite/accept, chat lines. Combat/economy is
**authoritative**, reconciled every 15 s from the oracle actor stats:
`kills / npcKills / playerKills / deaths / damageDone / shotsFired /
distanceMovedCells` and the shard's own `longArc` profile, plus credits
delta from inventory. A `loottables_telemetry` block exposes per-hunter and
pooled **kills/hour** (npcKills, mob-only) for the month-scale AFK loot
calibration lane.

**Farm profile** (`--profile farm`): a lean supply-bounded rate probe — 2
hunters, pure back-to-back patrol-and-hunt, minimal pacing, no social/craft/idle
downtime, against an injected dense respawning ground (maxAlive 12, ~20 s
respawn). It intentionally fails the 10-check acceptance (hunting only) — its
output is the kills/hour number. Measured anchors fed to LootTables: **~60 kph**
pooled engaged-human play (respawn-capped ground + travel/group/duel/rest/chat
downtime) and **~120 kph** pooled dense-cluster macro-uptime (maxAlive 12, deaths
included as respawn downtime). The realistic ~60 kph anchored the landed
legendary-drop constant (1/100k); the ~120 kph confirms the dense-cluster band.

**3. Invariant monitors** — `invariants.json`. Machine gates on top of the human
transcript:

| invariant | signal | default threshold (FORK) |
|---|---|---|
| no reject-storm | `ingress_budget_exhausted` count; non-benign rejects in any 30 s window | 0 budget rejects; ≤12 / 30 s |
| no stuck-loop | `moveTo` max-pulses failures; longest gap with zero accepted commands | ≤3 arrival-misses; <120 s no-progress |
| no rubber-band | max client-predicted vs oracle-authoritative position divergence, sustained-sample count | ≤6 cells; ≤3 sustained samples |

Benign rejects (`loot_no_rights`, `target_unavailable`, `out_of_range`,
`trade_not_locked`, `no_pending_invite`) are excluded from the storm signal —
they are honest, expected outcomes of contested/again-later play.

## Fork points (recommendations → adopted defaults)

- **F1 — Frozen-tick determinism vs real-time.** The scenario gate freezes the
  driver tick (`--tick-ms 86400000`) for byte-identical replays. SimPlayers run
  the **real-time** 16 ms driver tick so movement/facing predict like a real
  client. *Adopted: real-time; determinism lives in the seeded brain, the shard
  oracle is the KPI truth. Rationale: this tier tests "populated evening", not
  replay parity — that is the journey gate's job below it.*
- **F2 — Hostile supply.** Rely purely on respawning spawn-zones vs seed
  guaranteed hostiles. *Adopted: both — hunters sit in a multi-zone overlap for
  sustained respawns, plus two loot-bearing overlay stragglers for a guaranteed
  first loot.*
- **F3 — Crafter reagents.** Mine both metals live vs provision the scarce one.
  Iron and copper veins are not co-located; a two-vein mining trek wanders the
  crafter off its leash. *Adopted: sample iron live, provision copper as starting
  reagent stock (the same class of setup as the trader's coin). The arc still
  proves survey→sample→craft; loot-table/vein co-location is out of scope here.*
- **F4 — Loot vs harvest.** Humanoid corpses `/loot` cache rows; creature
  corpses `/harvest-corpse`. *Adopted: both, chosen by target kind; both count as
  a "loot" KPI.*
- **F5 — Duel resolution oracle.** *Adopted: verify the duel via challenge/accept
  RECEIPTS + combat events + post-duel health, NOT the duel-outcome envelope.*
  This was designed to be safe across the DEF-5/6/7 wire-gap window (the yield
  outcome was dropped by the TS layer until BioECoreFix); it now opportunistically
  records the forwarded outcome where present but never depends on it. A harness
  that *required* the outcome would have certified the exact bug DEF-7 was.
- **F6 — Population scaling.** `--population 4` is the acceptance roster (2
  hunters, 1 crafter-farmer, 1 trader-socialite). Larger N fills with extra
  hunters in the cluster; the group/duel use the first two hunters, the trade the
  trader + first hunter. *Adopted; choreography degrades gracefully below 4.*

## Coordination

- **Port law observed.** One scratch shard on a claimed port (28188 for the soak,
  28189 for iteration), checked units + probed free + announced on IRC; owner
  28093/28094 and every sibling's range left untouched; `PERSISTENCE=0`; unit
  torn down and asserted inactive after the run.
- **LootTables.** kills/hour telemetry shape agreed on IRC; `loottables_telemetry`
  ships per-hunter + pooled mob-only rates for the AFK calibration anchor.
- **Landing.** New directory + one `package.json` script line — near-zero conflict
  surface; lands late in the queue on main's live tip with a re-run there.
