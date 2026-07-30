# ADR-0011: Dedicated ComPress-Powered Site + Separate Game Runtime

**Status:** accepted
**Date:** 2026-05-13
**Updated:** 2026-07-28 to distinguish the live standalone alpha

Implementation note: `www.successorgame.com` and the AWS game authority are
live, but the current public alpha uses Successor's standalone same-origin
account/control store and one-use ticket implementation. It is not evidence
that the ComPress plugin, Postgres, or Redis portions of this long-term
decision have shipped. Current deployment truth belongs in
`docs/CURRENT_DEPLOYMENT.md`.

## Context

Successor lives on its own public site at `www.successorgame.com`, rather than
being nested into `compress.biz` or the public ComSpace product. ComPress
remains the accepted future backend direction: it already
has account auth, registration, recovery, refresh cookies, CSRF, site/store
sessions, plugin gates, Postgres, Redis, admin surfaces, and deployment
patterns that Successor should not re-invent.

The earlier local runtime accepted query-string `playerId` and `displayName`.
The current public alpha instead binds game and chat identity through one-use
launch tickets; query-string identity remains local-development scaffolding
and is rejected when dev identity is disabled.

ComSpace and earlier prototype identity ideas are useful reference material, not
the product direction. The ComSpace code may be mined for profile, handle,
membership, and game-identity patterns, but public Successor players should
not be forced through a separate ComSpace setup flow.

## Decision

Successor will launch as a **dedicated ComPress-powered site** while the
realtime simulation remains a **separate authoritative game runtime** once it
outgrows the local prototype.

The public identity/social layer is Successor-owned. "Successor profile" is the
working name for the game-local profile/player layer. It can be implemented by copying,
refactoring, or extracting useful ComSpace internals, but the canonical public
contract belongs to the Successor site and plugin.

ComPress core owns:

- user accounts, login, registration, refresh cookies, CSRF, password reset,
  and email verification;
- dedicated site/domain routing, site/store session resolution, and plugin
  availability gates;
- platform/admin auth, audit primitives, deployment hooks, Postgres, Redis, and
  operational surfaces;
- durable account/security tables that should stay shared platform
  infrastructure.

The Successor ComPress plugin owns:

- Successor profile/player identity, public handles, account-to-profile binding,
  character slots, character name reservations, and selected-character
  bootstrap;
- game bootstrap routes, account-backed profile setup, entitlement checks,
  moderation summaries, and session-ticket minting;
- durable social rows for friends, blocks, mutes, reports, and retained chat
  evidence when needed.

The Successor runtime owns:

- authoritative zone shards, movement, combat, inventory gameplay, crafting,
  world interactions, and replay receipts;
- realtime chat fan-out and presence behavior, authenticated through
  ComPress-issued session tickets;
- websocket protocol, AOI snapshots, shard handoff, and simulation telemetry;
- game-specific persistence that must be replayable or ledgered.

The browser does not choose its public game identity. The browser receives a
short-lived session ticket from the dedicated Successor site and presents that
ticket to the Successor runtime. The runtime derives user ID, Successor profile ID,
selected character ID, character name, guild projection, entitlement tier,
moderation flags, and initial zone from the redeemed ticket.

## Contract

### Dedicated site

The public site is Successor-branded and domain-owned by the game:

- current public domain: `www.successorgame.com`;
- local development may use a ComPress dev host or local route, but the product
  surface is not `compress.biz`;
- `/` can be the game site shell or launcher;
- `/play` mounts the actual playable client once the viewer is authenticated or
  has completed the minimum setup.

Players should not need to understand ComPress or ComSpace. They create or use
an account on the Successor site, then enter the game.

### ComPress plugin

Add a first-party `successor` ComPress plugin when integration begins.

Required traits:

- depends on `customer-accounts`;
- registers storefront API routes under
  `/api/v1/storefront/successor/*`;
- registers admin/live-ops routes under `/api/v1/admin/successor/*` only
  after the first authenticated player slice exists;
- exposes plugin contribution metadata so the dedicated `/play` route can be
  gated by the existing plugin runtime;
- may reuse ComSpace implementation patterns internally, but must not require
  public `comspace` routes or a separate ComSpace profile flow for normal game
  entry.

Minimum storefront API:

- `GET /api/v1/storefront/successor/bootstrap`
  - returns game availability, account status, required profile setup,
    Successor profile identity projection, character slots, and public asset/runtime
    config;
- `GET /api/v1/storefront/successor/profile`
  - returns the current viewer's Successor profile identity projection;
- `PUT /api/v1/storefront/successor/profile`
  - updates the player's public handle/profile fields with normal validation;
- `GET /api/v1/storefront/successor/characters`
  - returns the viewer's character slots;
- `POST /api/v1/storefront/successor/characters`
  - creates a character under the default slot cap and global name rules;
- `POST /api/v1/storefront/successor/session-ticket`
  - requires an authenticated customer identity;
  - requires an owned selected `characterId` once character select exists;
  - requires verified email if the site policy requires it;
  - ensures a Successor profile exists, asking for setup only when required
    fields or conflicts block safe auto-creation;
  - stores a one-use, short-TTL ticket in Redis;
  - returns only the opaque ticket plus websocket URL and expiry.

### Low-friction onboarding

No extra hoops:

1. User lands on the dedicated Successor site.
2. User registers or logs in with the normal ComPress account system, branded
   for the Successor site.
3. First play auto-creates the Successor player identity when possible.
4. `/play` shows character creation or character select before runtime entry.
5. A short setup screen appears only for unavoidable choices such as handle
   conflict, missing required terms, age/policy gates, or no playable character.
6. The user enters `/play` without being redirected to `compress.biz` or a
   separate ComSpace profile builder.

### Realtime auth

The public websocket handshake uses a ticket, not query-string identity:

1. Browser loads the dedicated Successor site and restores auth via refresh cookie.
2. Browser calls `GET /api/v1/storefront/successor/bootstrap`.
3. Browser selects a character.
4. Browser calls `POST /api/v1/storefront/successor/session-ticket` with
   the selected `characterId`.
5. ComPress validates site/store, plugin state, user, email policy, Successor
   profile, character ownership/status, entitlement, and moderation state.
6. ComPress writes a Redis ticket with a short TTL and one-use semantics.
7. Browser opens `wss://<host>/game/ws?ticket=<opaque>`.
8. Successor runtime redeems the ticket through shared Redis or a ComPress
   internal validation route.
9. Successor runtime attaches the authoritative selected character identity to the
   socket.

Ticket payload is server-side only. The opaque browser token must not encode
email, raw ComPress user IDs, permissions, or long-lived claims.

### Data placement

Use ComPress Postgres for:

- users, site/store memberships, auth recovery, email verification, plugin
  installation, platform audit, and shared admin/operator permissions;
- billing or entitlement rows if Successor later uses existing ComPress
  commerce primitives.

Use Successor plugin Postgres tables for:

- Successor profiles and public handles;
- account-to-profile bindings, character slots, character name reservations,
  and guild membership projections;
- friends, blocks, mutes, reports, social notes, and retained chat evidence;
- moderation actions that need to be visible from Successor live-ops tools.

Provisional table names can be `successor_profiles`, `successor_characters`,
`successor_character_name_reservations`, `successor_friend_edges`, `successor_blocks`,
`successor_mutes`, and `successor_reports`. These rows may reference ComPress
`users.id` internally, but raw account IDs and emails are not public player
identifiers.

Use Redis/Valkey for:

- session tickets;
- online presence and socket routing;
- rate-limit counters;
- cross-instance chat/pubsub fan-out;
- ephemeral shard routing caches.

Use Successor simulation persistence for:

- replayable game-state events;
- character state, inventory, item ledgers, economy ledgers, combat receipts,
  and shard snapshots.

Postgres rows can reference Successor objects, but gameplay truth is not edited
directly through generic ComPress admin CRUD.

## Non-Negotiables

- Public Successor sockets must never trust `playerId`, `displayName`, `zoneId`,
  `characterId`, `partyId`, `guildId`, or `guildTag` supplied by the browser.
- ComPress `users.email` and raw account identifiers are not public player
  handles.
- Character names are globally unique gameplay identities, not account names.
- Default account capacity is 5 playable characters.
- The public player/social layer is Successor-owned Successor profile, not a requirement to
  join ComSpace on `compress.biz`.
- Movement, combat, inventory, and crafting mutations remain server
  authoritative.
- The normal ComPress API process does not run long-lived Rust shard simulation
  loops in production.
- Site/plugin gates must be checked before the game route returns a playable
  bootstrap.
- Every cross-boundary call must carry `siteId` or `storeId`, `userId`,
  `characterId`, `runtimeTargetId` or equivalent runtime identity, and a
  request/correlation ID for audit.

## Foundation Gates

Before expanding gameplay beyond the authenticated game/chat foundation:

1. The dedicated ComPress-powered site route exists locally and can mount the
   current Successor client.
2. Bootstrap returns authenticated account state plus Successor profile/setup
   state.
3. Bootstrap exposes character slots or create-character requirement.
4. `/play` requires character selection before runtime entry.
5. The browser obtains a character-bound session ticket through an authenticated
   Successor storefront route.
6. Successor chat rejects unauthenticated sockets and derives identity from the
   redeemed ticket.
7. A Successor profile and selected character are created or reused for the
   player without a public ComSpace detour.
8. Friend/presence data has a clear durable adapter boundary instead of being
   hardwired to memory.
9. A two-browser smoke proves login -> character select -> ticket -> websocket
   -> chat as character name.
10. Docs state which system owns each table and each runtime responsibility.

## Consequences

- Local Successor development can keep query-param identities behind an explicit
  dev-only mode, but production code paths must use ticket auth.
- The public product becomes clearer: Successor has its own site, brand, and
  player identity, while ComPress remains the platform underneath.
- ComPress integration is still foundation work before large social, economy,
  or moderation systems grow.
- The Successor runtime can be deployed as a sidecar/container behind the dedicated
  site Caddy path without becoming a generic ComPress request handler.
- ComSpace is no longer the durable player identity layer. It is a reference
  implementation or possible source extraction target only.

## Related

- ADR-0002: WebSocket Now, WebTransport Later
- ADR-0013: 3D Isometric Client and GLB Assets
- ADR-0005: Zone Shard + AOI from Day One
- `docs/CHARACTER_SYSTEM.md`
- `docs/CHAT_SYSTEM.md`
- `docs/COMPRESS_HOSTING_FOUNDATION.md`
