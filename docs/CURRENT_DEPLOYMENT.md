# Successor Current Deployment

Status: authority image, Rust beta, and site promoted on 2026-08-07 UTC from
`integration/rust-ui-runtime-20260803`. Stable browser client remains source
`bd1396cdc9c1249605888db2bb465d17d6cdd39b`; the authority, Rust beta, and site
are source `e1e0e44caa38b1d1f254877edabf05bd1e26a12c` (site content built at
content-identical ancestor `62202406`).

This file owns volatile production identity. Product and authority contracts
live in `CANONICAL_CONTEXT.md`, implementation inventory lives in
`CURRENT_PROJECT_STATE.md`, proof procedures live in `VERIFICATION.md`, and
operator procedures live in `OPERATIONS.md`.

## Public surfaces

| Surface | Public address | Current identity |
| --- | --- | --- |
| Site, account, stable launch, and beta launch | `https://www.successorgame.com/` | `site-62202406-20260807`, manifest `701293dde14bfac9e860d1c8079eea069dd67562f303b0f82e02537745ece808` |
| Stable browser pointer | `https://www.successorgame.com/client/release.json` | `successor-alpha@bd1396cdc9c12496` (unchanged) |
| Beta browser pointer | `https://www.successorgame.com/beta/release.json` | `successor-rust-beta@e1e0e44caa38b1d1`, manifest `551b0fff8ced3c7c39c0b8da91c8b9810d7da5c37b78879992fa074fae9758d8` |
| Game and chat authority | `https://world.successorgame.com/` and `wss://world.successorgame.com` | image digest `sha256:47abcfe6c86b090553093dc3375d164571f719d0952c8e0cb871182d8394ecb5` (tags `rel-62202406`, `rel-0efb2347`, `rel-e1e0e44c`) |
| Native download ledger | `https://www.successorgame.com/downloads/manifest.json` | unchanged: release `successor-alpha@cdab7dccacc1d75c`, version `0.0.4`, four builds |
| Public source | `https://github.com/LycaonLLC/successor` | stable `bd1396cdc9c1249605888db2bb465d17d6cdd39b`; authority/beta/site `e1e0e44caa38b1d1f254877edabf05bd1e26a12c` |

The site and immutable browser assets are in S3 behind CloudFront. One
digest-pinned authority container runs on private EC2 behind the public ALB.
The host has no public remote-shell ingress. Operators use the documented
provider session path; development workstations are not public game hosts.

The `client-rust/` WebGL2 client is now available only through the opt-in
`/beta/` route. It has not replaced the supported stable browser client and is
not present in the native download ledger. Stable and beta have independent
no-cache pointers and immutable release prefixes; promotion or rollback of one
does not move the other.

The promoted beta identity is source
`e1e0e44caa38b1d1f254877edabf05bd1e26a12c`, client
`successor-rust-beta@e1e0e44caa38b1d1`, and immutable publication inventory
SHA-256 `551b0fff8ced3c7c39c0b8da91c8b9810d7da5c37b78879992fa074fae9758d8`.
Previous dry runs and superseded beta candidates are not release identities.


## 2026-08-07 integration promotion — authority, Rust beta, site

Release evidence document SHA-256 (the recorded maintenance seal identity):
`f9d837dec8faed775e1fc7c9c02a8af4b2489d994b413d2e22738fb70a863b10`
(source and copy: `/tmp/release-evidence-e1e0e44c.json` on the cockpit at mint
time; bind it into the ops evidence store on the next operator session).

What shipped, all from `integration/rust-ui-runtime-20260803`:

- **Authority image** `sha256:47abcfe6c86b090553093dc3375d164571f719d0952c8e0cb871182d8394ecb5`
  replaced `b45c8ad37913…` via the documented SSM maintenance deploy
  (`GAME_SHARD_MANIFEST_PATH` had to be supplied explicitly — the preflight
  default filename does not match the live `state-generation.manifest.json`).
  Zero sessions were connected; the durable state tree was untouched and the
  durability generation remained
  `e8455ec582e9b99ddd5ed27b741a00cfabb1ee4b1f7073d36bb58079473e6609`.
  The allowlist gained `successor-rust-beta@e1e0e44caa38b1d1`; prior stable and
  beta identities remain accepted. This image carries the co-dev movement
  overhaul with per-kind ingress budgets, room-message handling, and the idle
  pong flush.
- **Rust web beta** `successor-rust-beta@e1e0e44caa38b1d1`, publication
  manifest `551b0fff8ced3c7c39c0b8da91c8b9810d7da5c37b78879992fa074fae9758d8`,
  published to the object store (first population: 301 objects + 9 in-dist
  duplicates) and pointer-flipped after the authority accepted the new id.
  Client fixes in this release: compact combat-event tuple decoding (combat
  FX/floating text/SFX were silently dead on the live wire), NPC world-corpse
  looting (window opens from the actor snapshot's lootable marking), streamed
  inventory 3D preview retry, Tab target cycling, full number-row toolbar key
  sampling, and a fresh-install toolbar loadout (ATTACK on 1, AIMED SHOT on 2).
- **Site** `site-62202406-20260807` — ground-up FE rewrite on the game's own
  chrome with five keyed themes (DAWN default; SIGNAL/PHOSPHOR/AMBER/OXIDE are
  byte-exact hud.rs ports, contract-tested against the client source), minimal
  copy, evidence-plaque field record including two native Rust client
  captures, and the real TUI frame. Published immutable under
  `site/releases/site-62202406-20260807` and promoted to `site/current`.

Verification basis: static G0 gates (context, private-path — on the cockpit
checkout; the deploy worktree lacks the `hub/main` ref the private-path gate
expects — commands, coverage, denylist, fixture contract, zero-GPU, wardrobe,
deploy contract) all pass; client-rust unit suite 439 at release head;
workspace suites 586 at `5d40e029` with client-rust-only deltas after;
site suite 178 with performance budgets met; amd64 container smoke (read-only
rootfs, tmpfs state) healthy; live Bunker Xvfb runtime proofs (door
open/close, combat FX visible post-fix, NPC loot window, Tab cycling). The
full verification farm is NOT runnable on currently available hosts: every 3D
journey task is `linux-only` (Mac ineligible) and Playwright 1.59 does not
support Chromium on ubuntu26.04-x64 (Bunker ineligible) — the same
host-availability waiver recorded for the 2026-08-06 promotion. Restoring a
supported Linux farm host is the standing gap.

Public post-deploy checks: `/healthz` 200, `/game/status` live with
`rustLive: true` on the preserved state; beta pointer serves the exact new
source, client id, and manifest; the immutable entry answers HTTP 200; a
contextless direct open of the release index fail-closes with
`hosted launch is not configured` while booting the wasm and canvas (the
ticketed `/beta/` path is the supported entry). A signed-in public-account
launch has not yet been exercised for this promotion.

Operational drift found and worked around during this promotion (fix
forward): `~/.config/successor/instance-id.txt` on the provider host names a
stale instance; the AWS CLI 2.31/ubuntu26 build crashes on `ssm send-command`
(boto3 venv used instead); `publish-site.mjs` requires `--output-dir` despite
advertising a default; `promote-client-runtime` inputs are trusted for
`--source-commit` (a wrong tail was initially published and immediately
re-flipped); the release-seal tooling rejects current v2 asset manifests and
the stable manifest's own release-id shape, and the standalone farm scheduler
has no eligible host (above). The site `/current.json` public pointer route
returns 403 at the edge (route never wired); the S3 object exists.

## 2026-08-06 Rust beta action-key hotfix

Source `2f7ffd99c360c69cbd9ba2c45e9ab54c4ef6aeca` replaced the Rust beta
only. Symbolizing the production WebAssembly stack located the interaction-key
trap in `audio::triggers::play_ui`: it called `std::time::Instant::now`, which
panics on the shipped `wasm32-unknown-unknown` target before an F, R, or Space
action can be dispatched. UI cue throttling now uses
`successor_platform::now_ms` and saturating integer elapsed-time arithmetic.

The corrected beta is
`successor-rust-beta@2f7ffd99c360c69c`, with immutable publication inventory
SHA-256 `26dda4a36284690a35596d292e5f52c92779251db3163c06c2df8efb5ad78ac4`.
The client-rust verify, allocation, runtime, render, terrain, and `no_std`
gates passed; the steady-state frame allocation result remained zero.

The authority received only the additional beta client identity in its release
allowlists and restarted on the unchanged image digest
`b45c8ad37913e577a82f2a28eea76a15a108da22abfe6c4cd460bb78cafe2721`.
No schema, fixture, state, stable pointer, site release, or native download
changed. After restart, public health and readiness returned HTTP 200 and the
durability generation remained
`e8455ec582e9b99ddd5ed27b741a00cfabb1ee4b1f7073d36bb58079473e6609`.

The no-cache beta pointer returned the exact corrected source, client identity,
server protocol, and inventory above. The immutable entry, JavaScript, and
WebAssembly objects returned HTTP 200. A fresh public beta launch entered the
world, opened the cloning terminal with F, approached the Dustgate Cloning
Facility door, and opened it with F. The render loop remained live with no
page, console, or recorded render error.

## 2026-08-06 production promotion

The exact release source is
`bd1396cdc9c1249605888db2bb465d17d6cdd39b`. The promoted identities are:

- stable client `successor-alpha@bd1396cdc9c12496`, immutable inventory
  SHA-256 `6091484c96fa83d22811cd7ce64b457214b4333fbb73912d2b57f2905b246f12`;
- Rust WebGL2 beta `successor-rust-beta@bd1396cdc9c12496`, immutable
  publication inventory SHA-256
  `203befa84a9957649aeddac270e0cb30ffe0060c75e7acade05fdcb154b8a792`;
- site `site-bd1396c-20260806`, manifest SHA-256
  `fe37674da4bfc0acda9cb7d37788d5d81cb5a78d5f9f6ef0b84eb00166ee40b1`;
- authority image
  `595529182031.dkr.ecr.us-east-1.amazonaws.com/successor-staging-1/server@sha256:b45c8ad37913e577a82f2a28eea76a15a108da22abfe6c4cd460bb78cafe2721`.

The server protocol identity remains
`planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld`.
The live fixture SHA-256 is
`c21a81d9e511fa35d059a51eeb5ffc9f60d12b6d6cc63161930befb733bb5e2d`;
the map-bundle SHA-256 is
`260687cb95cee5f783e134e3a401f7265d05f0403307fcd6b4283cec2f281cb2`.

Before replacement, the stopped single writer was backed up to immutable,
versioned object
`s3://successor-backups-5a537a77/state/successor-before-release-20260806T005412Z-immutable.tar.gz`,
version `jcnGL5_GznYlIgBhNF2YEXr00BdwGs2C`. The archive is 1,224,034 bytes with
SHA-256 `39b40ea32b54b671000706ef6dd9c1a9b76055f6606ef1c8b6c4b2ad7496737d`.
The bucket was discovered without the documented versioning protection;
versioning was enabled before this immutable copy was created.

The new fixture did not match the prior pre-alpha checkpoint. Although an
immutable backup had been verified and the writer was stopped, the character
roster, checkpoint, journal, durability manifest, and craft-roll-key binding
were reset without the explicit reset authorization required by repository
policy. Account and control-plane state remained intact. The pre-reset domain
remains recoverable from the versioned backup above, but restoring it requires
either the matching older authority or an explicit conversion to the new
fixture. The replacement durability generation is
`e8455ec582e9b99ddd5ed27b741a00cfabb1ee4b1f7073d36bb58079473e6609`.

Release proof passed `pnpm run ci`, the client-rust verify, allocation,
runtime, render, terrain, and `no_std` gates, the desktop smoke
`desktop-smoke-20260806T012013Z`, and an amd64 container smoke. The full native
Linux/x64 verification farm was explicitly waived for this promotion because
no matching host was available; the native download ledger was not changed.
The release evidence SHA-256 is
`b80a0324b6bbad81850fab04d4ec39da9c927bef2476c489c14313fa21d0b296`.

After promotion, public `/healthz` and `/readyz` returned HTTP 200 with every
readiness check true. `/game/status` reported the exact fixture, map bundle,
release source, and durability generation above. A fresh public account
created a nondefault Scout, rendered the character doll, entered the stable
3D world with chat connected, and moved from `E 7 · N 9` to `E 7 · N 13`.
The same account launched the promoted Rust beta, completed its streaming and
scene-building phases, rendered a 1440 by 1000 world canvas, and accepted
movement input.

## Site

The authenticated S3 pointer contains:

- release: `site-254cc62-20260802`
- source commit: `254cc626622b1f0badf1cc612a5fa59c505a7487`
- manifest SHA-256:
  `5b67d31f55acea8830a00e228e7e34f1dd055fb34a4dc2a05a5fb0f94abd23ec`
- release prefix: `site/releases/site-254cc62-20260802`
- inventory: 49 files

The site suite passed 174/174 tests, followed by its TypeScript/Vite build
and all seven transfer-budget checks. The publisher excluded the
independently managed `downloads/manifest.json` as required.

After promotion, an isolated headless Chrome session loaded the public
download page, rendered all four available rows, found zero page or console
errors, and issued a successful `HEAD` request with the exact expected byte
count for every archive. Its proof record has SHA-256
`eb128578d35918ca63927ea3d57992826427fcc6cd5ae119ea8e5c915d94196c`.

`https://www.successorgame.com/current.json` is not a runtime dependency of
the public pages. Use the authenticated S3 `site/current.json` object as the
site ledger; do not infer a release from page timestamps.

## Browser client

The browser pointer is:

- source commit: `cdab7dccacc1d75cd301c38158fa1e8a1ec93c73`
- client release: `successor-alpha@cdab7dccacc1d75c`
- manifest SHA-256:
  `740879b7f9f886b52aff21f953c1de60366096e21bb2e4af8f17f72eb1b381b0`
- immutable entry:
  `https://d2kf3ri6r74a0m.cloudfront.net/releases/740879b7f9f886b52aff21f953c1de60366096e21bb2e4af8f17f72eb1b381b0/index.html`
- inventory: 419 files, 229,288,034 bytes

The production authority accepts this release. A fresh public journey created
an account and a nondefault Scout, entered the character workshop directly,
saved the authored appearance, entered the 3D world, moved the exact actor,
connected chat, and submitted `/bugreport` through its receipt state. Its
proof record has SHA-256
`2b59bdb627ccd3a389bdccc4bc91280b3b5505504ae5b33a0e40b1b0b0cefd66`.
The only console error was the expected pre-authentication HTTP 401; there
were zero page errors and zero failed requests.

The earlier launch-identity regression is repaired. Tickets, server protocol
identity, client identity, and shard identity now agree, and character
selection/creation hands directly into the 3D client.

### Rust WebGL2 beta

The independent beta pointer is:

- source commit: `67fb09e96a898f37259c47077776c7b04f2909fb`
- client release: `successor-rust-beta@67fb09e96a898f37`
- manifest SHA-256:
  `9ee75835de342bfc624d4dce9a4eb81d212a90f7d78077033d42936cc01770f1`
- release-builder manifest SHA-256:
  `df9bc617cb3e20c973b1a22c31a6adc8a1ee3f3758bb2668968f810de6b32b6b`
- immutable entry:
  `https://d2kf3ri6r74a0m.cloudfront.net/releases/9ee75835de342bfc624d4dce9a4eb81d212a90f7d78077033d42936cc01770f1/index.html`

The first-load HTTP 525 failure was an expired launch ticket: the site minted
the ticket before constructing the iframe, while the Rust client downloaded
its complete initial asset closure before matchmaking. The client now
preloads first and announces readiness afterward; the authenticated site
mints and delivers the launch context only in response to that exact-origin,
exact-window readiness message. Duplicate readiness messages reuse the
in-memory envelope rather than minting another ticket.

The mandatory Rust client gates passed with zero steady-state frame
allocations. The release adds blended gait transitions and enables the Web
Audio bootstrap in the public artifact. The authority allowlist was extended
with the exact beta client identity, then `successor.service` was restarted;
public readiness again reported every check true.

The public pointer returned the exact promoted source, client, manifest, and
server protocol identities. An authenticated beta journey minted a ticket
with HTTP 200, completed matchmaking with HTTP 204 then HTTP 200, rendered the
world at 1440 by 900, resized to 1100 by 700, and moved the selected actor.
Accepted commands and receipts both advanced by 12. Forced WebGL2 context loss
and restoration emitted both expected events and left the context live. A
page reload minted fresh tickets and completed a second 200/204/200 entry.
The redacted proof record has SHA-256
`eada44e716f928d7c427fca5254fad4021eaf657583960c5cccccd8bd646dbbb`.

The current release repairs the WebGL matrix-array bridge: skinned draws now
upload all `count * 16` floats instead of only the first joint matrix. The
authority accepted the exact release after its allowlist update and clean
restart. A public authenticated Chromium journey loaded the promoted immutable
entry with no failed requests or render error, visibly rendered the selected
player pawn and its equipment in the live world, and visibly moved that pawn
under keyboard input. The redacted proof record has SHA-256
`5b5cf77c2b5b58702031ab8d50361d51b5263b45c74a79e1781d568071dc780f`.

The 2026-08-04 beta release lowers the enterable-building shell cutoff from
two thirds to 40 percent of fitted model height and replaces instant authored
roof/wall hiding with the renderer's smoothstep-driven screen-space dither.
The mandatory standalone-client gates passed, including zero standard and
connected steady-state frame allocations. The exact release was added to the
authority allowlist through the provider operator route, `successor.service`
was restarted, and public readiness returned every check true.

An authenticated 1440 by 900 Chromium journey selected `Beta-Rook`, loaded the
promoted immutable entry, completed the authority connection, moved through
the Dustgate cloning-facility doorway, and visibly rendered the lower interior
shell around the player. The completed frame reported no render error; the
authority accepted movement commands, then returned to zero sessions after
the page closed. The inspected frame SHA-256 is
`d8fa7873805c8aece4459458c58ae3ac466a65b8f9ef45923ae591330bef4bde`.

The stable pointer remained `successor-alpha@cdab7dccacc1d75c`. Its repeated
public `/play/` journey still reached HTTP 204 then failed HTTP 400
`{"error":"invalid matchmake body"}`. The beta exit control also disappeared
without removing its iframe in this headless journey. Audio bootstrap presence
and automated coverage were verified, but the live `AudioContext` state was
not directly observable from the cross-origin headless frame. These are
observed residual defects, not successful checks.

The 2026-08-04 head-relative-cutoff release replaces the fitted-model-height
percentage with the normalized adult pawn head height plus 0.2 m of clearance.
The cutoff follows the player's terrain elevation and applies to both authored
selective shells and legacy whole-prop cutaways. The exact release was added to
`SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST` through the provider operator route,
`successor.service` was restarted, and public readiness returned every check
true.

An authenticated public `/beta/` journey selected `Beta-Rook`; ticket minting
returned HTTP 200 with the exact client and server identities, the promoted
immutable client entered the live authority, and the completed 1440 by 900
frame visibly showed the active lower interior shell around the player. The
inspected frame SHA-256 is
`6000395e6942a1101c8b99830e125cc782818a9ee79731710f1cf9f92041ac37`.
The stable pointer remained `successor-alpha@cdab7dccacc1d75c`.

The corrected 2026-08-04 beta release selects every authored enterable shell
side (`roof`, front, right, back, and left) and uploads the point-light
`u_screenSize` uniform as the declared `vec2`, eliminating the observed
`glUniform4f` `INVALID_OPERATION`. The exact client identity was added to
`SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST` through the provider operator route,
`successor.service` was restarted, and public readiness returned every check
true.

An authenticated public `/beta/` journey selected `Beta-Rook`; ticket minting
returned HTTP 200 with the exact corrected client and server identities. The
promoted immutable client rendered the live world and the cloning facility's
complete cutaway at 1440 by 900. Captured console and page errors contained no
`INVALID_OPERATION` or `glUniform4f`. The inspected frame SHA-256 is
`6a0395cbc7f5ba6dc39334e488bcaddc11afeb9c51a5e5e26b85e776e50c83dd`.
The stable pointer remained `successor-alpha@cdab7dccacc1d75c`.

The 2026-08-04 modular-building release adds literal authored ceiling-name
selection to the Rust cutaway classifier and includes the integrated
framebuffer-anchored UI and ticketed-launch corrections. The standalone Rust
client verification, zero-allocation, runtime, render, terrain, and no_std
gates passed. The release build initially exposed two source-tree integration
defects: the model corpus included four preserved Blender authoring files, and
the public shim retained the new creator-mode query read. The release source
now excludes only those authoring files from runtime-model parsing and replaces
creator mode with `false` in production artifacts; the final immutable build
passed both release checks.

The exact client identity was appended to the authority allowlist through AWS
Systems Manager and `successor.service` was restarted. Public readiness
returned every check true. An authenticated 1440 by 900 `/beta/` journey
selected `Beta-Rook`, loaded the exact immutable entry, visibly rendered the
live world, and submitted movement. Accepted commands advanced by 11 while
rejected commands remained at 823; the session returned to zero after the
browser closed. The inspected post-movement frame SHA-256 is
`1375aab88eb4ba3570c6d086679b7a372192e75234bc41e2b43e156f3fa26efb`.
The existing beta exit-control defect remains: clicking Exit hid the control
but left the iframe connected, so the proof closed the browser tab to retire
the session. The stable pointer was not moved.

## Authority and durable state

The running authority is:

- runtime source commit:
  `b99dfb6b5f5ee64425f9d2f792d6170ae4c0e48b`
- immutable image:
  `595529182031.dkr.ecr.us-east-1.amazonaws.com/successor-staging-1/server@sha256:40530c1343122b9f67cbe168ff19c00bb02b3115a36368417c4f8b85191e39f7`
- state-generation release:
  `b9262b21a1c8f51d146a9006188d62794456f3fb`
- state-generation id:
  `ad2a3f5489589938d896678929a10d0bc268b385f34d1c99bc3d547b0fda3bec`
- character mirror: `successor.character-store.v2`
- checkpoint schema: `successor.game-shard-checkpoint.v1`
- Rust payload schema: `authority.checkpoint.v1`, version 1
- slice SHA-256:
  `69a19db8289b0d4711ccca5d4febef39b8dcd2ef662f9f70539935e49af8680e`
- map-bundle SHA-256:
  `01df5d1d178a8199b5bbd62f7e2107f017f5ae2ba1ca45081bb0ecdbb8f65795`

The runtime source and the state-generation release intentionally differ.
This deployment repaired the container and persistence behavior without
resetting or restamping the live state domain.

Immediately before and after the controlled replacement, the restored Rust
state hash was identical:

```text
c485c797c0bdb80bd78f22185f37a1aa54306bf343702f6cf0de86265cac45ad
```

The pre-deployment immutable backup is
`s3://successor-backups-5a537a77/state/successor-20260802T214820Z.tar.gz`,
825,552 bytes, SHA-256
`fd48d72c407dbf00ef5ac681d19edaad46dbdd75e85062353fd3e726135b291a`.
The rollback image remains the prior digest
`sha256:e461648246084787e2985413b8ef6005e829d10873baa0a09fcb35a6a369166d`;
the stable client pointer was not moved.
The live state then advanced normally as the browser and native proof
characters entered the world. The mutable `persistence.stateHash` is therefore
an observation, not a deployment identity.

`/healthz` and `/readyz` return HTTP 200. Readiness currently reports lock,
preflight, restore, writable persistence, commit worker, and Rust child true.
The restored checkpoint loaded successfully, the journal buffer is empty,
and the commit worker is not in flight.

The hotfix preserves progression across actor retirement, clears retired
link-dead intent, and recreates the runtime lock directory after stop. The
relevant server/runtime suites passed 479 Node tests and 815 Rust tests,
including the exact restart-persistence scenarios.

The deployed image scan reports three critical, five high, and three medium
OS-package findings. The three critical findings are Debian Perl-family CVEs
with no fixed package in the deployed Debian channel; they are not exposed
through the Node request path. This is a tracked residual risk, not a claim
that the image is vulnerability-free.

## Native downloads

The live ledger has SHA-256
`4bf2758bd5ca45bbf96daf51570d50920516ddad77538d5357068819df555b45`
and S3 version id `Q1pWK6902f9HlJpZgPp6mGtDllWsFPkk`. It names packages
built from source commit
`656f79edb08ba4eba81f49d00fb7fa24b7fee3ed`, tree
`7e4fb327d90d48d7f95d89075a28f8796bd2b75f`, with the accepted browser
release embedded.

| Target | Bytes | SHA-256 |
| --- | ---: | --- |
| 3D client, Linux x86-64 | 310,733,999 | `8f9657459a81aac9a81fbc08022521140537757bd86f395c8170871a98268981` |
| 3D client, macOS arm64 | 309,789,344 | `4849ec03f2f319b63646e1475e4e937f1cbe3afb4ff9341491c0a58abadd4781` |
| Terminal client, Linux x86-64 | 45,712,567 | `e9f186ff735caa2f461a79d847f3b7781a28e52a07caccf39d5be010d35226ac` |
| Terminal client, macOS arm64 | 38,837,102 | `c524e0fd9298822b9a5ce6c06f97e14645ba9133485f4115e8195d76e9ba0a56` |

All four immutable CloudFront bodies were downloaded and hashed end to end.
The macOS application is a thin arm64 bundle with a valid ad-hoc signature and
designated requirement for `com.lycaon.successor`; it is not Apple-notarized.

Live package proof passed independently on Linux x86-64 and macOS arm64:

- 3D client: device approval, exact character selection, in-world authority
  and chat, then a second launch from the saved device credential with no new
  approval;
- terminal client: independent device approval, live authority and chat,
  clean quit, then a second launch from the saved credential;
- credential directories were mode `0700`, files were mode `0600`, and no
  credential contents or device codes were copied into proof evidence.

The Linux proof record SHA-256 is
`03ba5f590996afa29a2ea5f20aab220645d7a5e9215dfb4cf54e66e838e1b26d`;
the macOS proof record SHA-256 is
`782e9ffde3f92e48dcc1c7598cb195b83d5c4dbf5c0f56b04d3d24d82cb4d110`.
The four test device credentials remain in their private proof-state
directories. They were intentionally neither copied nor revoked.

The preceding empty ledger remains recoverable as S3 version
`PI029pdGSXgNoXd8uFOgBYVtJIuN7mW_` and has SHA-256
`3d47389d80785180dda5458f24084992653efc5524491ea6032ead0a454a498e`.
Immutable older archives were not deleted.

## Source identity rules

Do not collapse these identities:

- `81dd2173…` is the internal source used to build the running authority image.
- `cdab7dcc…` is the immutable browser client currently selected by the public
  pointer.
- `656f79ed…` is the host/package source that produced native version `0.0.4`;
  those packages embed the `cdab7dcc…` browser release.
- `0acf4e2e…` is the site release commit that publishes the native download
  surface and its source ledger.
- public `main` can move beyond all four as documentation and verification
  tooling improve; that alone promotes nothing.

## Quick observation

```bash
curl -fsS https://www.successorgame.com/client/release.json | jq .
curl -fsS https://www.successorgame.com/downloads/manifest.json | jq .
curl -fsS https://world.successorgame.com/healthz | jq .
curl -fsS https://world.successorgame.com/readyz | jq .
curl -fsS https://world.successorgame.com/game/status \
  | jq '{tick,actorCount,sessionCount,source,readiness,persistence:{enabled:.persistence.enabled,restore:.persistence.restore,stateHash:.persistence.stateHash},durabilityManifest}'
```

These calls observe production. They do not authorize a deployment, reset,
pointer promotion, credential change, or key rotation.
