# ComPress bridge plugin surface

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

**Lane:** AccountsBridge. **Status:** DESIGN-POINT — surface only, no code until Main READY.
**Date:** 2026-07-09. **Parent:** historical accounts architecture brief, not retained. **Forks locked (owner):** F-Home=dedicated Successor store/site on ComPressMain · F-Gate=login-gate · F-Engine=stripe_billing(test) · F-Slots=5/10.
**Hard law:** DEV/LOCAL ComPress docker stack ONLY (`compressmain-db-1` pg 5435 / `compressmain-redis-1` 6381 / mailpit 8025). ZERO prod mutation. Prod cutover = W3 behind §8.1 pre-cutover check.

## Grounding (verified this pass)
- ComPress revision `9534ce63` was the studied source; a large per-store-RLS refactor was in flight, and production was at migration **0096**. Reverify all of this against current ComPress instructions.
- Historical plugin ownership rule, to be reverified against current ComPress
  instructions: **core owns models+migrations; plugins own
  services/routes/types/settings**; `ComPressPlugin`
  (name/version/category/firstParty/entitlement/capabilities/contributions/register);
  `registerStorefrontPluginRoutes`/`registerAdminPluginRoutes`
  (capability-gated); loader scans `plugins/*/src/index.ts`.
- Reuse (studied in the W1 design pass): `packages/core/src/services/entitlement.ts` (`grantEntitlement`/`hasEntitlement`), `models/entitlements.ts`, `models/product-plans.ts` (`entitlementBundle`), `plugins/subscriptions` (state machine + grace clamp), `plugins/stripe-gateway` (webhook bridge), `middleware/atlas-preview.ts` + `services/magic-link.ts` (server-minted opaque-token shape), `middleware/tenant.ts` (host→store), `db/store-context.ts` (RLS scoping).
- Game side today: `server/src/auth/tickets.ts` (HTTP GET redeem, returns `{player}` only), `colyseusRoom.ts` ticket path (W1 wired ownerRef but ticket payload is still minimal).

## OPEN DECISIONS FOR MAIN (ruling before build)
1. **Dev DB isolation.** The shared `compressmain` mirror is the enterprise-refactor test mirror (rebuilt by `pnpm parity:refresh`), so mutating it (my migration + a Successor store) risks colliding with in-flight refactor work AND gets wiped on the next refresh. **RECOMMEND: a dedicated ephemeral successor dev DB** (own compose project / DB name, mirrors the bazaar's isolation model) so W2 never touches the refactor mirror; fall back to the shared mirror only if you want it in the parity lineage now. **(D1)**
2. **Migration + cutover ledger.** Core migration adds `successor_profiles`/`successor_characters`/reservations. Prod is 0096; the cutover ledger (`docs/cutover/CUTOVER.md`) is a PROD artifact. **RECOMMEND: author the migration as the next number but DO NOT append it to the cutover ledger in W2** (dev-apply only); the ledger row + FORCE-RLS wiring is W3's ceremony. **(D2)**
3. **Source revision.** **RECOMMEND: use the exact studied ComPress revision `9534ce63` in an isolated checkout.** Preserve changes only in the requested destination. **(D3)**
4. **Redemption transport.** **RECOMMEND: keep the game's existing HTTP redeem** (extend `tickets.ts`) against the successor plugin's `GET …/session-ticket/:ticket` (reads+consumes the Redis ticket, returns the payload). Shared-Redis is a W3 hardening option. **(D4)**

## 1. DATA MODEL (core migration — dev-apply only in W2)
`successor_profiles( id, store_id, user_id → users.id, public_handle (unique, ci), created_at, updated_at )` — 1:1 with user per store; the game-facing `ownerRef` = `profile.id` (never raw user id/email, per ADR-0011).
`successor_characters( id, profile_id → successor_profiles.id, store_id, canonical_name (globally unique, ci), display_name, slot_index, status, created_at, updated_at, last_played_at )` — the roster authority (W1's runtime store becomes sim-state keyed by characterId; this is the roster). Unique `(profile_id, slot_index)`; unique active/reserved `canonical_name`.
`successor_character_name_reservations( canonical_name, character_id, reserved_until, reason )`.
**Entitlements: reuse core `entitlements`** — no new table. Two refs: `feature:successor.access` (login gate) and `feature:successor.tier.premium` (slot/feature tier), granted via the plan's `entitlementBundle`.

## 2. THE `successor` PLUGIN (`plugins/successor/`)
`ComPressPlugin` — `firstParty:true`, `category:'storefront'`, `entitlement:{mode:'included'}`, depends on `customer-accounts`. Storefront routes under `/api/v1/storefront/successor/*` (capability-gated via `registerStorefrontPluginRoutes`):
- `GET  …/bootstrap` → `{ authenticated, profile{id,publicHandle}, characters[], limits{maxCharacters}, entitlement{access,tier}, requiresCharacterSelection }` (CHARACTER_SYSTEM shape).
- `GET/PUT …/profile` → ensure/read/update the Successor profile (auto-create from safe account fields).
- `GET/POST …/characters` → list/create (slot cap from tier entitlement via `characterSlotCap`; global name uniqueness + reservation).
- `POST …/session-ticket {characterId}` → verify `request.user` owns the character + `hasEntitlement(userId,'feature','successor.access')` → mint one-use Redis ticket (magic-link shape: opaque token, hash stored, ~60s TTL, `consumedAt`) carrying `{userId, profileId, characterId, characterName, entitlement{access,tier,characterSlots,activeUntil}, moderation, zoneId}` → return `{ticket, wsUrl, expiresAt}`.
- `GET  …/session-ticket/:ticket` → **redeem** (atomic consume) → returns the server-side payload (this is what the game calls; opaque token only crosses the browser).
Entitlement summary computed with `hasEntitlement` (login gate) + highest `successor.tier.*`.

## 3. STORE + SUBSCRIPTION PRODUCT (local platform, dev)
- One `stores` row = the dedicated **Successor** site (local host e.g. `successor.localhost`); enable `customer-accounts` + `successor`.
- One recurring **product + product_plan** (`billingModel:'recurring'`, `intervalUnit:'month'`, `amount:499`, `billingEngine:'stripe_billing'`, **test mode**) whose `entitlementBundle = [{kind:'feature',ref:'successor.access'},{kind:'feature',ref:'successor.tier.premium',metadata:{characterSlots:10}}]`.
- Stripe test webhook → `stripe-gateway` bridge → `subscriptions` lifecycle → `entitlement-hooks` grants `activeUntil=currentPeriodEnd` (grace = the §3d clamp, inherited).

## 4. GAME-SIDE (successor repo at the exact requested source revision)
- Extend `server/src/auth/tickets.ts` response schema: add `profileId, characterId, characterName, entitlement{access,tier,characterSlots,activeUntil}, moderation`.
- `colyseusRoom.identityFromOptions` ticket path becomes REAL: resolve `characterId` → load sim-state, set `ownerRef=profileId`, spawn/appearance/worn from the character record; carry the entitlement onto the session.
- **Login gate:** reject the join (`1008`) if `!entitlement.access`. `GAME_ALLOW_DEV_IDENTITY` stays ON locally (W1) so dev/harness paths still bypass; the ticket path enforces the gate.
- **Slot cap by tier:** `characterSlotCap(entitlement)` (the W1 seam) now fed the redeemed tier → base 5 / premium 10.

## 5. E2E PROOF (the acceptance gate)
Local ComPress user → buys the sub (Stripe **test**) → `subscription.created` → `entitlement` grants `successor.access`+tier → `POST session-ticket` mints → game `GET …/:ticket` redeems → Colyseus join derives `ownerRef=profileId` → `/game/characters` lists that profile's roster → slot cap reads premium=10. Plus negatives: unentitled user's ticket mint refused / join gated; lapsed sub (test-clock or manual clamp) → grace to period end → re-gate. Evidence captured (curl/log transcript + screenshots where a surface exists).

## 6. NON-GOALS (W2)
No prod mutation, no cutover-ledger row, no push, no real Stripe live, no bazaar-fork changes (marketplace identity federation is a later refinement per the parent doc §8.3). W3 owns prod cutover + the §8.1 legacy-subscriber check.
