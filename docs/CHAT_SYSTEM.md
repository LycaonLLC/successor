# Successor Chat System

Status: current source and public-alpha contract.

Chat messages, bounded history, and presence live in the chat process. Friend
and ignore edges are durable character records in the local `CharacterStore`.
Chat remains an authoritative service, not replicated widget state.

## Implemented Now

- Server route: `GET /chat/ws`
- Server status: `GET /chat/status`
- Indexed in-process fan-out by zone, party, guild, user sessions, and friend
  watchers.
- Lower-allocation indexed fan-out for zone/party/guild channels.
- Route latency metrics in `GET /chat/status` under `routing`.
- Local fan-out benchmark: `pnpm -C server bench:chat`.
- Connection guardrails: `CHAT_MAX_SESSIONS`,
  `CHAT_MAX_SESSIONS_PER_USER`, and `CHAT_MAX_PACKET_BYTES`.
- Ticket sockets bind chat identity to the redeemed durable `characterId`.
  Browser-supplied identity is accepted only when the existing game dev-identity
  policy allows it.
- Friend and ignore contacts use the bounded `successor.social.v1` record kind
  on the owning character.
- Graphical client: `client-3d/src/ui/hud/chatPane.ts`
- Terminal client: `client-tui/src/game/chat.ts`
- World integration: both supported clients boot chat with the generated
  open-desert world; the graphical client emits short speech bubbles above the
  player for local lines.
- Spatial routing reads the bound actor's current authority area and position
  on every send. It does not trust the launch-time zone.
- Graphical chat exposes `ALL`, `GLOBAL`, `COMBAT`, and `FRIENDS` feeds plus a
  `LOCAL`/`ZONE`/`GLOBAL` send-channel selector.
- Browser probe: `window.__successorChat`
- Runtime UI contract: `docs/IN_GAME_UI.md`

## Channels

| Channel | Delivery |
| --- | --- |
| `local` | same-area characters within an inclusive 24-cell radius; no history replay |
| `zone` | characters in the sender's current authority area |
| `global` | all connected characters on the shard, across areas |
| `trade` | all connected players on the current chat server, with slow mode |
| `party` | sessions with the same `partyId` |
| `guild` | sessions with the same `guildId` |
| `whisper` | sender plus online target |
| `system` | server/client generated only |

## Commands

- `/local message`
- `/say message`
- `/zone message`
- `/global message`
- `/g message`
- `/trade message`
- `/party message`
- `/guild message`
- `/w characterId-or-name message`
- `/whisper characterId-or-name message`
- `/friend add characterId-or-name`
- `/friend remove characterId-or-name`
- `/friend list`
- `/friends`
- `/ignore add characterId-or-name`
- `/ignore remove characterId-or-name`
- `/status online`
- `/status away`
- `/status busy`
- `/help`

Plain text sends to the active tab, falling back to `local` when `all` or
`system` is selected.

Pressing Enter while the game has focus opens text mode. After a real submit,
the input is cleared and blurred so WASD/Space return to game control without a
manual click back onto the canvas.

When the server closes a ticket-based WebSocket with policy code `1008`, the
client treats it as terminal and stops reconnecting. That prevents stale launch
tickets after a server restart or deploy from producing a reconnect loop.

## Friends And Presence

Friend and ignore lists belong to a durable character, not its account
`ownerRef`. Edges are directed. Character A can list character B and receive B's
presence without B listing A.

If B ignores A, A keeps B on its friend list but sees ordinary `offline`
presence. The hub suppresses B's connect, disconnect, and status transitions
for A. A whisper from an ignored character receives the same offline response
as a genuinely unavailable target. Ignore state is never named in packets or
UI copy.

Social changes update every connected chat session for the owning character.
The graphical client renders the directed list in the chat pane's `FRIENDS`
tab. The shared client also exposes it as `window.__successorChat.friends`.
Deleting a character invalidates the matching hub cache, closes any remaining
chat sessions for that character, removes inbound and outbound watcher edges,
and refreshes affected live rosters. Reusing the durable id starts from the
new record rather than the deleted character's cached friends or ignores.

## Safety And Policy

The server validates every client packet with `zod` before routing.

Current single-process policy, used by local and public-alpha authorities:

- max body length: 320 characters
- message packet cap: 2048 bytes
- rate window: 8 messages per 4 seconds
- trade slow mode: 1.5 seconds
- zone slow mode: 450 ms
- URL blocking
- local blocked-term list
- Unicode NFKC normalization
- control-character stripping
- repeated-line blocking
- system channel is read-only
- unauthenticated `/chat/status` reports aggregate presence and watcher counts,
  not character identities

## Persistence and scale boundary

Chat messages, presence, and channel history remain in process. Friend and
ignore edges persist in the file-backed character store, so they survive a
desktop restart and the current alpha authority restart. They are not in
Postgres or Redis yet.

The hub is shaped for one hot process and 500+ sockets. Routing uses
indexes for zone, party, guild, user-session, and friend-watcher delivery. The
current public alpha still runs one hot authority process. The scale-out steps
are:

1. Move `successor.social.v1` rows into authenticated hosted character
   persistence or a relational social table.
2. Store online/session presence in Redis.
3. Mirror the current routing indexes in Redis, or keep each character and its
   watchers on one chat worker.
4. Keep message history bounded and transient unless a channel explicitly
   needs retention.
5. Add durable moderation evidence for reports and punitive actions.

Production sockets derive their character identity from the redeemed launch
ticket. Query-string identity is local-development scaffolding and is rejected
when the game dev-identity policy is disabled.

See `docs/adr/ADR-0011-compress-hosted-identity-and-game-runtime.md` and
`docs/COMPRESS_HOSTING_FOUNDATION.md`.

## Verification

The server tests cover:

- exact local delivery at 24 cells and suppression beyond 24 cells;
- same-area zone fan-out and cross-area suppression;
- shard-wide global delivery across areas;
- 500-recipient indexed zone fan-out with 500 other-zone sockets excluded;
- route latency and aggregate status fields;
- hub and per-character session limits;
- one-way friend presence;
- character-scoped persistence across a store and hub restart;
- ignore masking for snapshots, live updates, and whispers;
- immediate masking and unmasking across sibling sessions;
- deleted-character contact cleanup and same-ID reuse;
- full 64-character identity routing without prefix collisions;
- URL moderation, spam limits, and whisper routing.

The headed browser proof covers the real in-world `FRIENDS` tab, its bounded HUD
layout, and ordinary offline presentation. Focused DOM tests pin sorting and
empty-state behavior.

The local benchmark exercises in-process delivery to 500 same-zone sessions
while excluding 500 other-zone sessions. It prints p50, p95, max route time,
delivery throughput, and hub counters as JSON.
