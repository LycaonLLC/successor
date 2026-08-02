# Successor Current Deployment

Status: re-observed and beta-promoted on 2026-08-02 UTC after immutable Rust
WebGL2 publication, exact-release authority admission, authority replacement,
site promotion, and public launch-path verification.

This file owns volatile production identity. Product and authority contracts
live in `CANONICAL_CONTEXT.md`, implementation inventory lives in
`CURRENT_PROJECT_STATE.md`, proof procedures live in `VERIFICATION.md`, and
operator procedures live in `OPERATIONS.md`.

## Public surfaces

| Surface | Public address | Current identity |
| --- | --- | --- |
| Site, account, stable launch, and beta launch | `https://www.successorgame.com/` | `site-c5e239c-20260802` |
| Stable browser pointer | `https://www.successorgame.com/client/release.json` | `successor-alpha@cdab7dccacc1d75c` |
| Beta browser pointer | `https://www.successorgame.com/beta/release.json` | `successor-rust-beta@a9654cb69b264eca` |
| Game and chat authority | `https://world.successorgame.com/` and `wss://world.successorgame.com` | image digest `40530c134312…` |
| Native download ledger | `https://www.successorgame.com/downloads/manifest.json` | release `successor-alpha@cdab7dccacc1d75c`, version `0.0.4`, four builds |
| Public source | `https://github.com/LycaonLLC/successor` | deployment source `a9654cb69b264eca47326e3e0af613acfe67b226` |

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
`a9654cb69b264eca47326e3e0af613acfe67b226`, client
`successor-rust-beta@a9654cb69b264eca`, and immutable publication inventory
SHA-256 `e792517634842ad2e6b3a4f3700ebf27b32990be57d9ee59cb227a8d91c2b322`.
The previous dry runs and the unpromoted `1a4d38f…` candidate are not release
identities.

## Site

The authenticated S3 pointer contains:

- release: `site-c5e239c-20260802`
- source commit: `c5e239c3af74ac93121a6e8492308c1769cc1f8a`
- manifest SHA-256:
  `8a4a36b2ee3f0f368425d49efb187b8fc6ebd76b4359491e471d301ba5455610`
- release prefix: `site/releases/site-c5e239c-20260802`
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

- source commit: `a9654cb69b264eca47326e3e0af613acfe67b226`
- client release: `successor-rust-beta@a9654cb69b264eca`
- manifest SHA-256:
  `e792517634842ad2e6b3a4f3700ebf27b32990be57d9ee59cb227a8d91c2b322`
- release-builder manifest SHA-256:
  `d1fd3e6c300fde5f075bd237f4a6db555fff64f73bd2444aad2767fb48c807e5`
- immutable entry:
  `https://d2kf3ri6r74a0m.cloudfront.net/releases/e792517634842ad2e6b3a4f3700ebf27b32990be57d9ee59cb227a8d91c2b322/index.html`

The public `/beta/` route loaded this exact iframe, minted a ticket for a
freshly created Scout, and received HTTP 200 from
`/matchmake/joinOrCreate/game` with the beta release presented. The same
journey first exposed and then verified fixes for the site's canonical server
identity bound and the Rust client's strict matchmaking body. The stable
pointer remained `successor-alpha@cdab7dccacc1d75c`.

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
