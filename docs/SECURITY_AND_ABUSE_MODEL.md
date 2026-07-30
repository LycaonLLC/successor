# Security & Abuse Model

Status: future scale-out threat model. The standalone AWS public alpha is live;
its implemented architecture, release identity, and proof live in
`CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`,
and `VERIFICATION.md`. This document does not claim that every control below is
implemented in the alpha, and it does not make Postgres, Redis, or ComPress a
second gameplay authority.

Major revision 2026-05-10 from research consolidation. **Security promoted from Phase 7 dependency to Phase 2 / 5 / 7 gates.** Deferring security to live ops would bake abuse into transport, persistence, economy, and GM workflows long before live operations exist.

## Threat model

Browser-native MMOs cannot rely on native anti-cheat kernels. The robust design is server authority + schema-validated packets + economic ledgers + risk-based account security + cheap edge throttles + behavioral detection + replay-backed investigation, designed in from Phase 2.

Adversaries:

- **Cheaters:** speedhacks, teleports, packet replay, automation.
- **RMT operators / botters:** large-scale automation for resource gathering, gold-selling.
- **Duplicators:** state-race exploits to multiply items.
- **Economy manipulators:** market-corner, sell-undercut bots, scam patterns.
- **Griefers:** chat abuse, mob-trains, account harassment.
- **Account thieves:** credential stuffing, session hijack, password reset abuse.
- **Network attackers:** DDoS on edge, slow-loris on app server, packet replay, malformed-frame DoS.

## Phase gating (revised from v2)

| Phase | Security commitment |
|-------|---------------------|
| Phase 2 (vertical slice) | `PacketEnvelope` enforced in `successor-net`; passkey/WebAuthn auth live with TOTP fallback; per-IP and per-account connection caps; idempotency keys on every state-changing command |
| Phase 5 (crafting + economy) | Append-only `item_ownership_ledger` and `currency_ledger`; auction/mail/trade via escrow; `SERIALIZABLE` isolation around ownership transfer; emergency trade kill-switch tested in staging |
| Phase 7 (live ops) | Bot detection telemetry; GM evidence bundles via replay; SPC drift dashboards; full risk engine; chat moderation pipeline |

## Browser anti-cheat

There is no credible browser equivalent of BattlEye or Easy Anti-Cheat. The browser is an attacker-controlled environment. WebAssembly obfuscation, minification, integrity checks, and JavaScript anti-debugging raise cost; they do not create client trust.

The production stack is:

1. **Server-authoritative simulation.** The client sends intent, never truth. Movement packets contain inputs or desired actions, not final position. Harvest, combat, inventory, crafting, auction, and mail operations are committed only by the authoritative sim or transaction service.
2. **Strict packet schema validation.** Every frame has bounded length, protocol version, message type, monotonic sequence, session ID, and parse result that rejects unknown fields, NaN, impossible enum values, overflow, and duplicate command IDs. This belongs in `crates/successor-net`, not only in the TypeScript edge.
3. **Replay and idempotency.** All state-changing commands carry a client command UUID and a server-assigned tick. Replays are rejected or return the same result. Protects against retries, packet replay, reconnect storms, and dupes disguised as networking failures.
4. **Behavioral anomaly detection.** Track input entropy, path repetition, resource loop regularity, action timing, session duration, auction cadence, trade graph position, account linkage. Catches browser automation better than client-side tricks.
5. **Authenticated frames, scoped narrowly.** TLS, secure cookies, CSRF/origin checks, per-session sequence windows. HMAC-signed frames are useful only when the signing material is not fully exposed to arbitrary scripts. If the browser can sign, a bot can sign too. Treat signatures as replay/session-integrity controls, not anti-cheat magic.
6. **Progressive friction.** Turnstile/CAPTCHA only on suspicious velocity, new-device high-value trades, account creation bursts, password stuffing. CAPTCHA-on-everything is how a game teaches its players to hate it.

### `PacketEnvelope` (Phase 2 deliverable)

```text
version, session_id, connection_id, sequence, ack, tick_hint,
message_kind, command_id, body_len, body_hash, body
```

Lives in `crates/successor-net`. Decoder fuzzing is required. Fixed maximum body
sizes apply per message type. Validation runs before messages reach the sim.
Clients may smooth presentation locally; server state is the only persisted
truth. Protocol replay tests feed captured frames through the production
decoder and assert deterministic rejection or acceptance.

## Economy exploits

Player-driven economy changes the security problem from "can someone cheat movement?" to "can someone mint value?" The item and currency model must be **ledger-first**.

| Threat | Defense pattern |
|--------|-----------------|
| Item / currency dupes | Append-only ledger for currency and item ownership; immutable item instance IDs; atomic transfer transactions; idempotency keys on every state-changing op; `SERIALIZABLE` isolation or explicit row locks around inventory / auction / mail / escrow; invariant checks after commit; emergency trade kill-switch |
| Reconnect / race dupes | On disconnect, leave authoritative transaction state server-side. Never let a client "resume" by resubmitting inventory truth. Use command IDs; return the original result for duplicate command IDs |
| Auction-house abuse | Escrow: listing transfers item ownership to `auction_escrow`; purchase atomically transfers currency + item; cancellation atomically returns item. No client-supplied item count. Price normalization without overflow. Listing/cancel rate limits. Audit row for every state transition |
| Undercut bots | Listing/cancel velocity limits, small nonrefundable listing fee, minimum listing duration for high-volume categories, per-account and per-device throttles, anomaly scores for millisecond-perfect repricing |
| Market-corner attacks | Track concentration by item class, region, account cluster, beneficial owner. Dashboards first. Listing caps / cooldowns / anti-manipulation review only when concentration + behavior signals indicate abusive coordination |
| Gold-selling rings | Trade graph analysis, account-linking, mule detection, laundering-path detection, new-account transfer caps, delayed settlement for risky transfers, review queues |
| Mailbox abuse | Mail attachments via escrow + claim tokens. Expire mail with deterministic return paths. Reject attachment mutation after send. Flag high-value fan-out, new-account high-value receives, repeated failed claim attempts |
| Crafting material inflation | Faucet/sink dashboards by resource class, zone, account cluster. Alert on impossible yield distributions, path repetition, resource scarcity drift |

The historical lesson: New World disabled wealth transfer multiple times after dupe exploits; Diablo IV disabled trading in 2023. Designing the kill-switch and forensic ledger **before** trade exists is the only path that doesn't require emergency live-ops surgery.

## Account security

**Passkey/WebAuthn primary; TOTP fallback** (reverse the original sketch's priority).

NIST SP 800-63 Rev. 4 is the current digital identity guidance, and FIDO passkeys are mainstream enough for consumer deployment in 2026. Passkeys are phishing-resistant because the private key remains with the user's device.

Recommended account stack:

- **Primary auth:** passkeys/WebAuthn + email verification. Passwords may exist for compatibility, but passwordless is the default onboarding path.
- **Fallback auth:** TOTP + recovery codes. Avoid SMS except as a low-trust recovery signal.
- **Risk engine:** device fingerprint, ASN/IP reputation, impossible travel, new-device login, session age, account value, recent password reset, trade velocity.
- **Credential stuffing controls:** per-IP / per-account / per-device throttles; breached-password screening; bot challenges only when risk rises; login telemetry.
- **Session defense:** HttpOnly + Secure + SameSite cookies; refresh-token rotation; server-side revocation; session binding to coarse device profile; **step-up auth** for email change, password reset, GM privileges, high-value trades, currency withdrawal.
- **Password reset abuse:** rate-limit by account + IP; do not reveal whether an email exists; require step-up before changing recovery factors; log every reset attempt; delay high-value transfers after reset.
- **Device fingerprinting:** risk signal, not proof. Pragmatic early choice: Clerk or WorkOS as auth providers; Keycloak or SuperTokens for self-hosting if there's a compelling reason.

## DDoS posture

Cloudflare Tunnel is fine for development and small alpha tests. It is **not** a complete MMO DDoS strategy. Cloudflare's documentation states the initial HTTP 101 WebSocket upgrade is subject to WAF, custom rules, and rate limiting, but after the WebSocket is established the WAF does not inspect subsequent messages. App-layer validation and connection governance must live inside the server.

Layered design:

- **Edge:** Cloudflare WAF, managed DDoS, Turnstile on suspicious account creation/login velocity, upgrade-rate limits on `/ws`, origin allowlists, TLS, Bot Management when paid enterprise controls are warranted.
- **App server:** WebSocket origin validation, authenticated upgrade token, per-IP and per-account connection caps, heartbeat timeouts, max frame size, max messages/sec by message class, slow-consumer detection, disconnect penalties for repeated malformed frames. **Do not let unauthenticated sockets idle.**
- **Sim shard:** admission control per zone, command budgets per account, queue overflow behavior, snapshot backpressure, "shed snapshots before commands" policy. Preserve sim integrity under load even if clients receive degraded updates.
- **WebTransport later:** Per ADR-0002, WebTransport over HTTP/3 changes failure modes; it does not eliminate abuse. State-changing commands stay ordered, authenticated, replay-resistant. Disable 0-RTT for state-changing operations or treat 0-RTT as replayable.

## Bot detection

At 10k CCU, the correct posture is **score → slow → review → ban**, not "ML instantly nukes accounts." False positives in an MMO are social explosives.

Telemetry:

- **Input stream:** timing jitter, key/mouse rhythm, reaction time, camera movement entropy, repeated action chains.
- **World behavior:** path loops, node-to-node efficiency, harvest uptime, combat targeting regularity, rest patterns, daily schedule regularity.
- **Economy behavior:** auction repricing cadence, cancel/list ratio, mail fan-out, trade graph centrality, currency source/sink imbalance.
- **Account graph:** device clusters, IP/ASN clusters, shared recovery factors, mule chains, party/guild affiliation, repeated asset sinks.
- **Report signal:** reporter trust, victim count, repeated zone complaints, replay-backed report packets.

Stack at 10k CCU:

- **Ingestion:** NATS JetStream or Redpanda/Kafka for gameplay events.
- **Storage:** ClickHouse for high-volume telemetry, Postgres for account/economy truth, Redis only for ephemeral counters and rate-limit state.
- **Features:** hourly + daily aggregation jobs, plus hot counters for velocity gates.
- **Models:** start with rules + unsupervised anomaly detection; add XGBoost/LightGBM after labeled GM outcomes exist. No deep learning until simple models saturate.
- **Actions:** friction → delayed settlement → shadow price throttles → review queue → temporary trade holds → ban waves with evidence bundles.

## GM tools

The deterministic replay infrastructure is the project's gift to security. Build GM tools around it.

Minimum architecture:

1. **Evidence bundle per case:** account IDs, character IDs, device/IP summaries, relevant packets, last N seconds of replay state, item/currency ledger rows, chat snippets, reports, model scores, prior actions.
2. **Replay viewer:** scrub tick-by-tick; show player inputs, server validation decisions, inventory/economy mutations, state hashes.
3. **Case workflow:** triage, investigator notes, evidence tags, recommended action, **second approval** for punitive or high-value actions, appeal state.
4. **Two-person control:** bans over a threshold, currency confiscation, GM item creation, rollback, account-linking sanctions require dual approval.
5. **Audit logs:** append-only GM action log with actor, reason code, target, evidence bundle ID, before/after state, timestamp.
6. **Ban evasion detection:** account graph + device fingerprint + IP/ASN + behavior similarity + social cluster + transfer links.
7. **Emergency tools:** pause auction house, freeze suspicious item class, freeze account cluster, disable mail attachments, disable new listings, start forensic snapshots.

GM tools are **not** a web admin page that can silently edit inventories. That road leads to fraud, mistakes, and unhappy forum threads.

## Chat moderation

Hybrid stack:

1. **Local first:** profanity/blocklist, spam repetition, URL filtering, Unicode confusable handling, per-channel slow mode.
2. **Classifier second:** OpenAI Moderation (free for API users, supports text/image via `omni-moderation-latest`). Perspective API is sunsetting; do not adopt.
3. **Human review:** only severe / repeated / appealed cases route to GMs.
4. **Player controls:** mute, block, report, guild moderation roles, parental settings if minors are allowed.
5. **Abuse response:** warn → timeout → channel mute → account mute → suspension. Tied to evidence and appealability.

For a small-to-medium MMO, OpenAI Moderation + local rules is the cheapest effective start. AWS Comprehend toxicity or Hive are alternatives when procurement / data residency / media moderation requirements change.

## Persistence layer security

For a future hosted account and market layer, Postgres is the durable authority
for non-gameplay commerce and account records. Rust checkpoints remain the
gameplay authority, and Redis is **not** authoritative state. The tables below
are planned scale-out schema, not the current single-host public alpha:

- Tables: `accounts`, `characters`, `items`, `item_ownership_ledger`, `currency_ledger`, `auction_listings`, `mail_messages`, `trade_sessions`, `idempotency_keys`, `gm_actions`, `security_events`.
- Every state-changing API writes an idempotency row keyed by account + command ID + endpoint + request hash.
- High-value economy operations run under `SERIALIZABLE` with retry handling, or explicit row locks (`SELECT ... FOR UPDATE` or `FOR NO KEY UPDATE`) around affected account/item rows during transfer.
- Append-only ledgers with compensating transactions rather than destructive edits.
- Periodic invariant jobs: no item has two owners; no ledger creates currency without source; no auction escrow item exists in character inventory; no mail attachment outside escrow; no negative balances.
- Parameterized queries only. Separate DB roles for auth, gameplay, GM read, GM write, analytics.
- Redis ACLs, TLS, no public exposure, least-privilege users, key namespaces, expirations.

Hosted-economy migration tests must simulate simultaneous auction purchase/cancel, mail send/claim/delete, and trade accept/disconnect/reconnect. Current in-game trade tests must also prove participant-only replay after reconnect, no replay to strangers, and no TypeScript-side settlement. Tests must fail if a dupe is possible.

## Voice / video chat (optional, deferred)

Player voice/video stays out of first playable. If added later, prefer a managed provider (Vivox, Dolby.io, Agora, LiveKit Cloud) unless the team is prepared to run TURN/SFU + moderation pipelines.

Posture:
- Push-to-talk default.
- Report flow captures only a short rolling buffer after user action and policy notice.
- No blanket recording unless retention obligations are reviewed.
- Voice moderation classifier for severe abuse + human review.
- Per-channel mute, block, group leader moderation, GM emergency channel mute.

NPC voice assets are a content provenance problem. Player voice is a safety + privacy + evidence problem. Different beasts.

## Pre-launch security-audit checklist

- [ ] Auth threat model reviewed.
- [ ] WebSocket origin, auth, rate limits, max frame size, heartbeat tested.
- [ ] Auction/mail/trade dupe test suite passes under concurrency.
- [ ] Postgres transaction retries and row locks tested.
- [ ] Redis has ACL/TLS and no authoritative economy state.
- [ ] Bot telemetry dashboards live.
- [ ] GM audit log immutable.
- [ ] Two-person punitive workflows tested.
- [ ] Emergency economy kill-switches tested in staging.
- [ ] Chat moderation and report flow tested.
- [ ] Backups and point-in-time restore tested.
- [ ] Abuse data retention policy approved.
- [ ] `PacketEnvelope` schema versioned and decoder fuzz target green.
- [ ] `pnpm security:audit` passes with no high-severity production advisory.
- [ ] Dependency updates resolved through `pnpm-workspace.yaml` maturity,
      exotic-source, and lifecycle-script guardrails.
- [ ] Any new `allowBuilds` entry has reviewed lifecycle-script rationale.

## Out of scope (for first playable)

- Sophisticated anti-cheat suites (BattlEye, EAC) are platform-incompatible with browser; rely on server authority + behavioral detection.
- Commerce / billing / refunds / currency: deferred until product identity and live-ops phase. If real-money purchases are added before launch, fraud and chargeback controls become P0 and this document gets a major addendum.

## Server-edge dependencies needed before production edge

- `@fastify/rate-limit`
- `@fastify/helmet`
- `@fastify/cookie`
- `@fastify/csrf-protection` (where HTTP forms exist)
- Auth provider SDK (Clerk / WorkOS / Auth0) or self-hosted (Keycloak / SuperTokens)
- Turnstile server verification
- OpenTelemetry tracing
- Prometheus metrics
- Sentry or equivalent error reporting
- Redis-backed rate-limit store

Current local server dependencies are still lean: Fastify, websocket support,
Drizzle/Postgres/Redis clients, Zod, and Pino. Do not treat the list above as
already installed or wired.
