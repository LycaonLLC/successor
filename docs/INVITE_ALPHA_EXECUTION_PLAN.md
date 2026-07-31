# Successor Invite Alpha Execution Plan

Status: historical execution plan. The AWS public alpha is live as of
2026-07-28. `CURRENT_DEPLOYMENT.md` owns current release identity and
`OPERATIONS.md` owns the current operator loop. Future-tense phases below
explain how the boundary was designed; they are not a current work queue.

Historical approval: end-to-end execution was approved on 2026-07-23.

This plan turns the current Successor build into a durable, invite-only online
alpha that friends can register for through ComPress and play in a browser. It
prioritizes authority correctness, preservation of acknowledged player state,
fast iteration, recoverability, and honest maintenance windows.

This document cannot override `CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`,
or `VERIFICATION.md`. Update those canonical documents when implementation
changes their owned contracts.

## Decision

- Ship a browser-first invite alpha through the existing ComPress Successor
  plugin. Electron remains a local proof and later distribution surface.
- Use free invite entitlements, not paid subscription checkout.
- Host each live shard on one x86 AWS EC2 VM with one encrypted, non-Multi-Attach
  EBS data volume. Run an immutable OCI image under systemd behind ALB/ACM WSS.
- Keep account, invitation, entitlement, character selection, and ticket
  issuance in ComPress Postgres/Redis. Keep gameplay truth in exactly one Rust
  `successor-sim` authority child behind the TypeScript transport and lifecycle
  parent.
- Keep live authority and irreplaceable player state out of development and
  verification infrastructure. Use disposable infrastructure for clean-source
  verifier jobs, previews, load generators, and isolated restore rehearsals.
- Start a fresh alpha world before the first external invitation. Preserve
  player state through migrations and tested recovery from that point onward.
- Deploy stateful releases sequentially under maintenance. Never run two writers
  or percentage-canary two authorities against one state domain.
- Do not acknowledge a mutating command until its journal generation has been
  durably group-committed and fsynced.

100% uptime is impossible. The alpha target is zero loss of acknowledged
progress for process/instance crashes, tested recovery from off-volume backups,
and explicit maintenance rather than unsafe high-availability theater.

## Non-negotiable invariants

1. Exactly one Rust process owns gameplay truth for a shard.
2. Exactly one process owns the lifetime state-domain lock.
3. A successful mutating receipt means the durable journal commit completed.
4. Checkpoint, anchored journal, character mirror, craft-roll key, fixture/map
   identity, wire version, release identity, and save schema form one generation.
5. Restore, fixture, manifest, or save-schema mismatches fail startup closed.
6. Release/fixture/wire/save identities appear in health, logs, tickets, browser
   diagnostics, and backup records.
7. The browser is hostile input. It never asserts identity, ownership, movement,
   combat results, loot, crafting rolls, or inventory truth.
8. Public startup refuses development identity, permissive origins, or a public
   game listener that bypasses the TLS edge.
9. Alpha state is real after the first friend enters. No casual wipes.
10. A green automated matrix is necessary but not sufficient; human promotion,
    durability proof, live WSS proof, and isolated restore proof remain gates.

## Target topology

```text
friend browser
  |-- HTTPS: invite/register/profile/character --> ComPress
  |-- immutable assets --------------------------> S3/CloudFront
  `-- WSS + one-use ticket --> ALB/ACM --> private EC2 shard
                                            |-- TypeScript supervisor
                                            |    `-- exactly one Rust authority
                                            `-- encrypted EBS state volume

ComPress: account/invite/entitlement/ticket truth in existing Postgres/Redis.
AWS: gameplay runtime, private shard state, snapshots, logs, metrics, alarms.
Disposable infrastructure: verifiers, previews, load, and restore rehearsals only.
```

## Alpha player contract

The first complete player path is:

1. Operator creates a one-use invitation.
2. Friend redeems it while registering or signing into ComPress.
3. Redemption atomically grants `successor.access` and character slots.
4. Friend creates/selects a character with profession and appearance.
5. ComPress mints an opaque, random, short-lived, one-use ticket bound to the
   account, profile, character, shard, first-entry nonce, and release contract.
6. Browser loads the exact compatible immutable client release.
7. The shard atomically consumes the ticket and safely commits first entry.
8. Two players can meet at Knox, travel, hunt, camp, harvest/loot, bank/trade,
   disconnect/reconnect, and survive a server restart with state intact.
9. A bug report includes non-secret source/client/server/fixture/wire identities.

Invite redemption and first entry must be idempotent. Expiry, replay, wrong
character, wrong shard, wrong release, interrupted first entry, and duplicate
browser submission must fail safely. Ordinary character deletion is disabled
after first entry until an authority-aware retirement protocol exists.

## Execution graph and exit gates

### Phase 0 — Preserve and seal

1. Create encrypted off-site backups for the repository and source-assets library.
2. Restore-test both into isolated locations.
3. Freeze broad work in any shared dirty checkout and use isolated checkouts.
4. Reconcile the v8 fixture/map, Synty eviction, authored code, generated files,
   labs, proof output, and scratch material into deliberate slices.
5. Repair command manifest coverage for `BuildPlace`, `BuildRemove`, and
   `BuildToggleDoor`.
6. Repair `verify:successor-context`.
7. Create a clean detached v8 release candidate.
8. Generate stable source/fixture/map/wire/asset identities twice.
9. Run the complete existing source-aware verification matrix.
10. Record the first clean v8 seal.

Exit: off-box restore proof, clean candidate commit, stable identities, command
and context gates green, and a fresh full matrix green.

### Phase 1 — Identity and ComPress control plane

- Hashed one-use invitations with expiry, revoke, cohort, grant set, and atomic
  retry-safe redemption.
- Free Successor access and slot grants.
- Profile and character create/select.
- Canonical open-desert names and starting zone.
- Required profession and approved appearance contract.
- Ticket v2 with atomic consume and replay protection.
- Idempotent first-entry state machine.
- Minimal operator controls: create/revoke invites, open/close admissions, view
  release/state/backup identity and active sessions.
- Production-mode bridge with every development fallback disabled.

Exit: invite through first entry and reconnect passes end to end, including the
complete invite/ticket abuse matrix.

### Phase 2 — Hosted durability

- Extract desktop lock, state-domain, restore preflight, child lifecycle, and
  final-save behavior into one shared headless supervisor.
- Acquire the lifetime lock before reading state or spawning Rust.
- Validate the immutable generation manifest and restore/replay fail closed.
- Group-commit accepted mutating ticks and fsync before releasing receipts.
- Make command IDs idempotent across retries/reconnects.
- Add checkpoint, backup, drain, shutdown, and final-fsync barriers.
- Report ready only after replay, identity validation, writable persistence,
  lock acquisition, and exactly one healthy Rust child.

Exit: process, parent, container, and host power-cut matrix shows no acknowledged
loss or duplicate reward; disk-full, corrupt state, mismatch, migration
interruption, and attempted second writer all fail safely.

### Phase 3 — AWS staging and alpha

Terraform owns VPC/security groups, ECR, private immutable asset storage/CDN,
ALB/ACM, EC2, encrypted EBS, KMS/IAM, snapshot/archive storage, CloudWatch,
alarms, and budgets. No public remote shell; use the provider session path for break-glass access. Only ALB may
reach the private listener. Build once and promote the same image digest from
synthetic staging to alpha.

Keep synthetic staging and real alpha on separate volumes. Start measurement
with a non-burstable x86 2 vCPU/8 GiB class, then choose exact region/SKU/EBS
settings from tester geography and representative load.

Exit: immutable staging deploy, residential TLS/WSS proof, private game port,
hard-restart persistence, and a snapshot restored to an isolated playable
shard without copied secrets or public remote-shell access.

### Phase 4 — Browser alpha

Fable 5 owns the human-visible implementation and visual QA for invite,
registration, character creation/selection, `/play`, maintenance, compatibility,
reconnect, ticket failure, known issues, and `/bug` surfaces.

Generate a production reachability manifest and exclude labs, catalogs, unused
source exports, and unrelated `wave-props`. Publish content-addressed immutable
assets. Keep the small release pointer mutable. Measure cold/warm bytes, time to
character selection, time to playable, failed requests, and retries over a real
residential connection. Stop incompatible client/server combinations with a
clear reload message.

Exit: headed browser proves invite-to-game, all failure states are legible, the
CDN serves only required payload, and release diagnostics accompany feedback.

### Phase 5 — Release loop

Inner loop: isolated checkout, package-local proof, `verify:fast` against the
sealed baseline, surface-specific gate, real runtime smoke, and visual proof
for player-visible changes.

Outer loop: clean detached seal, full existing verification farm, immutable
server/client artifacts, same digest to staging, protocol/durability/WSS/load/
restore gates, two-human session, human promotion, sequential alpha deployment,
and post-deploy soak. Extend the shipped source-aware classifier; do not build a
second CI system. Unknown code paths run conservatively broad proof.

Exit: one repeatable change-to-production path with state-aware rollback and an
auditable seal record.

### Phase 6 — Product cohorts

- Owner plus 1–2 friends.
- Up to 8 accounts.
- Up to 24 accounts.
- Keep an initial hard concurrent-session cap of 32.

Expand only with zero acknowledged loss/dupes, current restore proof, measured
WAN/load headroom, clear onboarding/death/corpse behavior, acceptable movement/
sprint/travel feel, and evidence that players voluntarily want another session.

### Phase 7 — Long-term operations

Maintain runbooks for invite/revoke, admissions, normal/failed deploy, rollback,
process/host crash, volume restore, corrupt journal/checkpoint, disk pressure,
suspected duping, player support, and emergency maintenance. Exercise recurring
backup restores. Keep K3s work disposable and alpha state outside the cluster.

## Stateful deploy protocol

1. Build/seal a clean candidate.
2. Restore current alpha state into isolated staging and rehearse migration.
3. Publish maintenance; stop ticket minting and admissions.
4. Drain sessions; stop mutations; final checkpoint and journal fsync.
5. Record the generation and take application-consistent S1 snapshot.
6. Stop old authority and release its lock.
7. Start the new digest privately and validate release/fixture/wire/save/state
   identity, replay, lock, writable persistence, and exactly one Rust child.
8. Run a two-client WSS smoke.
9. Reattach/re-enable edge, reopen admissions, and soak.

Never percentage-canary two state writers. Client-only rollback may repoint to a
compatible prior immutable release. A server rollback is allowed only when the
current state schema remains compatible. After incompatible writes, prefer a
forward fix; emergency S1 restore explicitly loses post-cutover progress.

## Required proof surfaces

- Source: clean seal and stable generated hashes.
- Contracts: commands, context, wire, fixture, and ComPress bridge.
- Authority: determinism, replay, combat/economy/inventory invariants.
- Identity: invite/ticket abuse and safe first entry.
- Durability: crash matrix with zero acknowledged loss or duplicate mutation.
- Security: TLS, strict origins, private listener, no public dev identity.
- Browser: headed invite-to-play over a real network.
- Assets: measured cold/warm waterfall without unreachable payload.
- Capacity: chat/combat/harvest/inventory/trade/save/reconnect/WAN load, not only
  movement/query clients.
- Deployment: same image digest from staging to alpha.
- Recovery: isolated restored playable shard.
- Product: two humans complete the durable core loop and choose to return.
- Promotion: explicit human release decision.

## Disposable verification infrastructure

Allowed: clean-source verifier jobs, disposable synthetic shards,
compatibility matrices, load-client fleets, asset/GPU validation, isolated
copied-state restore rehearsals, scheduled validators, and private previews.

Set resource requests and limits, enforce TTL cleanup, and isolate workloads.
Never mount alpha player data or make live admission depend on development or
verification infrastructure.

Reconsider Kubernetes for live authority only when several independently
schedulable shards/services exist and fencing, PVC behavior, drain/shutdown,
backup/restore, and—if same-shard HA is desired—a replicated durable log with
explicit leader epochs are proven.

## Deferred until the invite alpha is stable

Public registration, billing, broad Electron distribution/updater, same-shard
HA, multi-region gameplay, EKS/GKE/K3s authority, WebTransport, new areas,
auction/mail/factory expansion, broad bot/ML/GM tooling, percentage canaries,
microservice decomposition, and replacement of the existing verification farm.
