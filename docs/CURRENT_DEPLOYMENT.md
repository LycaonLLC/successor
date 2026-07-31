# Successor Current Deployment

Status: public release ledger re-observed after the 2026-07-29 authority and
site promotions.

This file owns volatile production identity. Product and authority contracts
live in `CANONICAL_CONTEXT.md`, the implementation inventory lives in
`CURRENT_PROJECT_STATE.md`, proof procedures live in `VERIFICATION.md`, and
operator procedures live in `OPERATIONS.md`.

## Public surfaces

| Surface | Public address | Current identity |
| --- | --- | --- |
| Site, account, and browser launch | `https://www.successorgame.com/` | `site-5c30a98a-20260729` |
| Browser client pointer | `https://www.successorgame.com/client/release.json` | `successor-alpha@731b87bb5ce5ea4c` |
| Game and chat authority | `https://world.successorgame.com/` and `wss://world.successorgame.com` | `b9262b21a1c8f51d146a9006188d62794456f3fb` |
| Native download ledger | `https://www.successorgame.com/downloads/manifest.json` | `successor.downloads.v1`, zero builds |

The site and immutable browser assets are in S3 behind CloudFront. One
digest-pinned authority container runs on private EC2 behind the public ALB.
The host has no public SSH ingress. Operators reach it through SSM from Bunker;
Bunker is not the public game host.

The `client-rust/` graphical material-parity and PBR terrain work verified in
source on 2026-07-30 has not been published, promoted, allowlisted, linked from
the site, or added to the native download ledger. It does not change any
identity in this deployment ledger.

## Site

The authenticated S3 site pointer contains:

- release: `site-5c30a98a-20260729`
- source commit: `5c30a98a777406ec5b77eb38fe95881b0c6389e5`
- manifest SHA-256:
  `000f3dcd3e42d2e42d3fa5d25fb9fb2d9c77292634750c6b9ef1c8291f6df34d`
- release prefix: `site/releases/site-5c30a98a-20260729`
- inventory: 48 files, 35,575,618 bytes

This is the full-viewport browser shell. Once a launch succeeds, the game
iframe fills the viewport and the site chrome and document scroll disappear.
The parent-owned `Exit` button restores the chrome and ordinary cursor without
destroying the live iframe; `Full screen` returns to the same session. The
client itself does not request pointer lock.

The home page uses real terminal-client output and the original Successor
opening crawl. The crawl travels along its tilted plane, compresses distant
rows into subpixel detail, and is hidden by an opaque horizon rather than an
opacity fade.

The download page now says installed builds are not ready. It does not claim
that Linux, macOS, or terminal packages are available.

The source site suite passed 170 tests and its TypeScript/Vite production build.
After promotion, cache-busted public checks returned HTTP 200 for the download
page, found the new copy, and loaded a zero-build manifest.

`https://www.successorgame.com/current.json` is not used by the public pages.
It currently returns HTTP 403. Use the authenticated S3 `site/current.json`
pointer as the site ledger; do not infer a release from page timestamps.

## Browser client

The browser pointer is:

- source commit: `731b87bb5ce5ea4cc304cc5cae84b271dfe616f2`
- client release: `successor-alpha@731b87bb5ce5ea4c`
- manifest SHA-256:
  `dcb2d5f43c579c38c109a15b2e709fe08f773e6e1d25e7c457b336c28d46d1c7`
- immutable inventory: 448 files, 232,569,103 bytes

The production authority allowlist contains exactly that client release. The
browser build includes the full-screen handoff, keyboard-focus behavior,
clean character-exit protocol, face compositor, spatial/global chat UI,
world-travel continuity, and bounded positional audio used by this release.

The site source and repository documentation can be newer than this immutable
browser source. That does not change the pointer or make another client
production.

### Current launch regression

Public observation on 2026-07-29 found the site shell, immutable client files,
`/healthz`, `/readyz`, and `/game/status` all returning HTTP 200, with zero
connected game sessions. The hosted iframe nevertheless remained empty and
the child timed out waiting for an accepted launch.

The exact nonsecret instance contract explained the failure. Tickets named
server release
`planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld@a0d1d1450a75f340`,
while the promoted browser bundle requires the canonical bare identity ending
in `verdance-forest-overworld`. Client and shard identities matched. Strict
launch validation therefore rejected the envelope before rendering; this was
not an EC2, ALB, CloudFront, or bundle-availability failure.

Current source separates the canonical server protocol identity from the
broader stamped release id and pins that distinction in the operator contract.
That source correction is not itself a live repair: the existing host still
requires a controlled runtime correction/restart, and the direct-entry site
change requires a separately promoted site release.

## Authority and state

The running authority is:

- source and server release:
  `b9262b21a1c8f51d146a9006188d62794456f3fb`
- image:
  `595529182031.dkr.ecr.us-east-1.amazonaws.com/successor-staging-1/server@sha256:0e7d1055fba3787c35c9c367d0d3b07136f95d47decb919cb0c873bd1d994040`
- state generation:
  `7c5fb235514c1bb7e3c07fe9c3c647cb50b3fefa3a68e1424d27aa18a79584a2`
- character mirror: `successor.character-store.v2`
- checkpoint schema: `successor.game-shard-checkpoint.v1`
- Rust payload schema: `authority.checkpoint.v1`, version 1
- slice SHA-256:
  `69a19db8289b0d4711ccca5d4febef39b8dcd2ef662f9f70539935e49af8680e`
- map-bundle SHA-256:
  `01df5d1d178a8199b5bbd62f7e2107f017f5ae2ba1ca45081bb0ecdbb8f65795`

The image reports OCI revision `b9262b21...`; ECR size is 96,086,103 bytes.
The authority release used these seals:

- source seal:
  `f8e914f6d9238fbd33b08aae3ac6eb9bd898392fb6d7860c58d5ffa42f66769d`
- release seal:
  `ec5e356b84dd494b239c690e3492bb302c2f208a23c74955d3727253e817f32a`
- verification matrix:
  `edd8af85bd248003ab20b88995d3de058570a0fe6a4acfb330942bf31b6df87f`
- artifact identity:
  `7588c50b16ed8c94ac50c9c62ee37598aa61756f42fe364e936a3d0191532600`
- promotion record:
  `39dfb9a76a0a6553c0d881b86b29fcd0effdc34bf5d7cfd91d67cf639318ec26`

`/healthz` and `/readyz` return HTTP 200. Readiness reports lock, preflight,
restore, writable persistence, commit worker, and Rust child true. Lifecycle
journal rows flush synchronously, so an ordinary connect or clean disconnect
does not leave readiness false.

The current generation began as an intentionally empty public-alpha domain.
The preceding generation remains read-only on the authority host. Immediately
before the reset, the complete state domain was backed up to:

```text
s3://successor-backups-5a537a77/state/successor-before-lifecycle-readiness-fix-b9262b21-20260729T061038Z.tar.gz
```

The archive is 25,679 bytes, has SHA-256
`bbdf669eb12e01588beebe00a4113c5810fc2a54054e508bb477c4580d8213bc`,
uses S3 AES-256 encryption, and was inspected for the control database,
character store, checkpoint, journal, and durability manifest.

The public state currently contains four disposable smoke accounts and six
smoke characters from two release journeys. They are not retained user data
and do not create a compatibility obligation.

## Public player proof

The final authenticated journey passed 25 checks. Its canonical proof digest
is:

```text
7df2b5fbd681bda99d0eadf664d1b631517f4b9bdd8961aa4bb7daaecd405cc6
```

The proof and operator inspection are under:

```text
~/dev/releases/successor-alpha-b9262b21-20260729
```

The journey established:

- registration, nondefault character creation, world entry, clean character
  switching, logout, and relog;
- no character-store actor can claim the authored fixture actor `player`;
- exact face styles/colors and fixed worn pieces survive entry and relog;
- `LOCAL` reaches the same area through 24 cells and is suppressed beyond it;
- `ZONE` reaches the sender's current area but not another area;
- `GLOBAL` reaches connected characters across areas;
- two travel tickets can coexist, one can be consumed to move the existing
  Rust actor from Ashvat/Open Desert to Verdance/Lowbough, and the other stays
  in the field pack;
- position, Scout novice box, 16 spent skill points, 250-point cap, inventory,
  worn state, and appearance survive travel, clean logout, and relog;
- the durable Rust checkpoint and character-store projection agree after the
  transition;
- final readiness, including the commit worker, remains true.

The standalone release matrix passed 13/13 at
`standalone-rc-b9262b21a1c8`. The exact amd64 image also passed a local smoke
before publication. `pnpm run ci`, server lint/build/tests, the 172-test shard
suite, `pnpm hygiene:rust`, clippy with warnings denied, `cargo machete`, and
the `successor-sim` suite passed on the release source.

## Native downloads

No native build is public now. The live manifest has `builds: []` and SHA-256:

```text
3d47389d80785180dda5458f24084992653efc5524491ea6032ead0a454a498e
```

Its current S3 version id is
`PI029pdGSXgNoXd8uFOgBYVtJIuN7mW_`. The previous `0.0.2` manifest advertised
graphical desktop packages built from `08d8d40d...`. Those packages no longer
match the production client allowlist, so their links were withdrawn instead
of leaving broken downloads on the site. The immutable archives were not
deleted.

The withdrawn manifest is recoverable through S3 object versioning and was
also copied to:

```text
~/dev/releases/successor-site-5c30a98a-20260729/native-manifest-withdrawn-previous.json
```

Its SHA-256 is
`7bac68f7b04daef986fb03da2b400347c0981da639ca43e2d353455247c40a2f`.
A new graphical or terminal package must carry an accepted client release and
complete its hosted device/login proof before it is added to the ledger.

## Quick observation

```bash
curl -fsS https://www.successorgame.com/client/release.json | jq .
curl -fsS https://www.successorgame.com/downloads/manifest.json | jq .
curl -fsS https://world.successorgame.com/healthz | jq .
curl -fsS https://world.successorgame.com/readyz | jq .
curl -fsS https://world.successorgame.com/game/status \
  | jq '{source,readiness,persistence:{enabled:.persistence.enabled,restore:.persistence.restore},durabilityManifest}'
```

These calls observe production. They do not authorize a deployment, reset,
pointer promotion, credential change, or key rotation.
