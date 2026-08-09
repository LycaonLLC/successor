# Dedicated ComPress Site Foundation

Status: future ComPress scale-out plan. It is not the implementation behind the
current AWS public alpha and is not a resume handoff. The live alpha uses the
standalone same-origin account/control plane and one-use ticket boundary
recorded in `CURRENT_DEPLOYMENT.md`. `CANONICAL_CONTEXT.md` owns supported
topology.

This is the practical build order for making Successor a dedicated
ComPress-powered site without letting local prototype shortcuts become
production contracts.

Authoritative ADR: `docs/adr/ADR-0011-compress-hosted-identity-and-game-runtime.md`.

## Canonical Shape

Successor launches from its own Successor-branded site, while ComPress
supplies the backend account/session/plugin foundation. The public player layer
is Successor-owned, not a public
ComSpace dependency.

Realtime game traffic is authenticated by a short-lived session ticket and
handled by Successor's authoritative runtime.

Identity chain:

```text
ComPress user
  -> dedicated Successor site/store session
  -> Successor profile/player identity
  -> Successor character slot
  -> selected character session
  -> Successor runtime pawn
```

## Repository Management

ComPress is not vendored or forked into Successor. Its owning repository
controls `plugins/successor`, account models, and ticket routes. Successor
consumes that capability only through the versioned HTTP and Redis ticket
boundary; game authority and game persistence stay in this repository.

Cross-repository work uses separate commits in each owning repository. The
bridge verifier accepts `COMPRESS_MAIN_ROOT` as the explicit ComPress checkout
location. Bind cross-repository proof to exact revisions; do not infer authority
from checkout names, branch names, or worktree layout.

## Ownership Map

| Concern | Owner | Notes |
| --- | --- | --- |
| Login, registration, refresh cookies, CSRF | ComPress core | Reuse existing account system, branded for the Successor site. |
| Dedicated domain/site routing | ComPress platform/runtime | Public destination is Successor-owned, not `compress.biz`. |
| Site/plugin availability | ComPress core + plugin catalog | Game route is gated like other optional capabilities. |
| Public player handle/profile | Successor plugin | Do not expose email or raw user ID as handle. |
| Character slots | Successor plugin | Default cap is 5 active playable characters per account. |
| Character names | Successor plugin | Globally unique, case-insensitive, letters only. |
| Session ticket minting | ComPress `successor` plugin route | Short TTL, one-use, stored server-side. |
| Websocket redemption | Successor runtime | Runtime derives identity from ticket. |
| Presence | Redis/Valkey | TTL state, not persistent Postgres churn. |
| Friends, blocks, mutes | Successor plugin Postgres adapter | Durable and queryable for moderation. |
| Chat fan-out | Successor runtime | ComPress authenticates; Successor routes realtime packets. |
| Movement/combat/crafting | Successor Rust sim | Authoritative game state. |
| Moderation evidence/audit | Successor plugin + Successor receipts | Admin surface can live in ComPress, but evidence stays game-specific. |

## Milestone 0: Canon

Done when:

- ADR-0011 exists and states the dedicated-site direction.
- `docs/CANONICAL_CONTEXT.md` and `docs/CURRENT_PROJECT_STATE.md` identify the
  dedicated ComPress-powered site boundary without making it a second game runtime.
- `docs/CHAT_SYSTEM.md` records the implemented standalone ticket boundary and
  separates it from future provider-backed scale-out.
- No foundation doc tells players to join public ComSpace or enter through
  `compress.biz`.

## Milestone 1: Dedicated Site Boot

Goal: boot the current Successor slice from a dedicated ComPress-powered
site.

Build:

- `plugins/successor` in the ComPress repo.
- Local dedicated-site host/tenant configuration for Successor.
- Storefront route contribution for `/play`.
- Frontend route that mounts the current Successor client bundle or a packaged
  build artifact.
- `GET /api/v1/storefront/successor/bootstrap`.

Verification:

- Unauthenticated visitor sees Successor-branded login/setup state, not the
  playable socket.
- Authenticated customer can load `/play`.
- Plugin disabled means route/API returns the existing ComPress gate behavior.
- No normal player path redirects to `compress.biz` or public ComSpace setup.

## Milestone 2: Account-Backed Successor Identity

Goal: no more browser-chosen player identity.

Build:

- Ensure or create a Successor profile inside the Successor plugin.
- Auto-create the profile from safe account fields when possible.
- Show a short setup screen only for required terms, missing fields, or handle
  conflicts.
- Add provisional Successor plugin tables such as `successor_profiles`.
- Return the Successor profile projection in bootstrap.

Verification:

- Same account gets the same Successor profile across reloads.
- Two accounts cannot claim the same public handle.
- Raw email and raw `users.id` are not rendered as in-game names.
- First play does not require a separate ComSpace profile builder.

## Milestone 3: Session Ticket Auth

Goal: websocket identity comes from the dedicated Successor site and selected
character.

Build:

- `POST /api/v1/storefront/successor/session-ticket`.
- Require `characterId` once character select exists.
- Redis ticket record:
  - opaque random token hash;
  - `siteId` or `storeId`;
  - `userId`;
  - `gobSpaceProfileId`;
  - `characterId`;
  - character name;
  - guild ID/tag projection;
  - entitlement/moderation summary;
  - expiry;
  - consumed-at marker.
- Successor runtime ticket redemption path.
- Dev-only query-param identity remains behind an explicit local flag.

Verification:

- Socket without ticket is rejected.
- Ticket without an owned selected character is rejected.
- Reused ticket is rejected.
- Expired ticket is rejected.
- Ticket for one user cannot impersonate another user.
- Successful connection emits chat under the selected character name.

## Milestone 3.5: Character Select

Goal: `/play` selects a character before entering the runtime.

Build:

- `GET /api/v1/storefront/successor/characters`.
- `POST /api/v1/storefront/successor/characters`.
- Character select UI between account login and runtime iframe.
- Default 5 character slots per account.
- Name validation: globally unique, letters only, no spaces, no numbers.
- Session-ticket request carries the selected `characterId`.

Verification:

- New account with no characters sees create-character first.
- Account with characters sees select-character first.
- Sixth active character is rejected under the default cap.
- Duplicate names are rejected case-insensitively.
- `Michael`, `Warden`, and `Mira` are valid; `Michael Kelly`, `Mira123`,
  and `Moss_Wick` are invalid.
- Refreshing `/play` does not auto-enter the game without a selected character.

## Milestone 4: Durable Social Adapter

Goal: chat/friends stop depending on memory-only state.

Build:

- Adapter interface for friends, blocks, mutes, reports, and message retention.
- Postgres implementation for durable Successor social rows.
- Redis implementation for online presence and fan-out.
- Local memory adapter retained for isolated tests only.

Verification:

- Friend survives server restart.
- Offline/online presence expires automatically when heartbeat stops.
- Blocked users cannot whisper each other.
- Report/moderation action has an audit row plus message evidence.

## Milestone 5: Runtime Sidecar

Goal: deployable game runtime without stuffing the sim into the ComPress API.

Build:

- `successor-game` service beside ComPress `api`, `frontend`, `redis`, and `db`.
- Caddy path for `/game/*`, with `/game/ws` as the initial websocket endpoint.
- Shared Redis or internal ComPress validation route for ticket redemption.
- Health/status endpoint with shard count, socket count, and build version.

Verification:

- Caddy forwards websocket upgrade traffic correctly.
- ComPress API can mint tickets while Successor runtime redeems them.
- Runtime restart does not log players in as the wrong identity.
- Local two-browser smoke proves account -> ticket -> socket -> chat.

## Hard Rules For New Work

- New browser code may read identity from dedicated-site bootstrap, not from URL
  params.
- New server code must accept an actor context with `siteId` or `storeId`,
  `userId`, and `characterId` for player-affecting actions.
- Any new durable table must state whether it belongs to ComPress core, the
  Successor plugin/profile layer, or the Successor runtime.
- Any gameplay mutation must be replayable or produce a receipt before it is
  exposed through the dedicated site.
- Any moderation-relevant action must include enough evidence for an admin to
  answer: who, what, when, where, and which runtime emitted it.

## First Implementation Slice

The next slice should be deliberately narrow:

1. ComPress plugin skeleton.
2. Dedicated Successor site route and `/play` page.
3. Authenticated bootstrap endpoint.
4. Successor profile ensure path.
5. Character list/create/select endpoint and UI.
6. Session ticket endpoint bound to selected character.
7. Successor chat accepts ticket auth.
8. Browser chat dock uses selected character identity.
9. Two-player smoke verifies account-backed character chat and friend presence.

This creates the foundation before the game starts accumulating combat,
inventory, housing, player stores, or guild systems.

Related character contract: `docs/CHARACTER_SYSTEM.md`.
