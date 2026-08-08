# Native Rust first-entry handoff — 2026-08-07

Status: continuation handoff for `integration/rust-ui-runtime-20260803`.
This document is scoped to native callsign login, roster, character creation,
and ticketed world entry. Architecture, current implementation, deployment,
and proof commands remain owned by `CANONICAL_CONTEXT.md`,
`CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`, and `VERIFICATION.md`.

## Resume point

- Branch: `integration/rust-ui-runtime-20260803`
- Runtime baseline before this handoff-only change:
  `d4bf5882` (`4b659e80` is the last runtime source change; `baa6bc4b` and
  `d4bf5882` are deployment records).
- The branch is not merged to `main`.
- Do not restart from `dev/rust-client`, `hosted-direct-launch`, or an archived
  ref. Their useful work is already reachable from this branch.
- Stable browser remains `successor-alpha@bd1396cdc9c12496`.
- Opt-in Rust WebGL2 beta is
  `successor-rust-beta@4b659e80f9ea2f65`, manifest
  `f83a1a1054d112cd0be0e5285ccf70253768c1db8e6f4e4c86679fe3c8ef0490`.
- Production authority image is
  `sha256:47abcfe6c86b090553093dc3375d164571f719d0952c8e0cb871182d8394ecb5`.

Read, in order:

1. `docs/CANONICAL_CONTEXT.md`
2. `docs/CURRENT_PROJECT_STATE.md`
3. `docs/CURRENT_DEPLOYMENT.md`
4. `docs/VERIFICATION.md`
5. this document

## User-visible target

Running the shipped native binary with no development flags must open the real
Successor entry flow:

1. callsign + masked password;
2. authenticated character roster;
3. existing-character selection or the current two-stage creator;
4. one-use play-ticket minting;
5. `LaunchEnvelope` validation and entry into the existing connected runtime.

Acceptance is end-to-end behavior, not a new demo mode:

- `make -C client-rust native`, then
  `(cd client-rust && ./out/bin/successor)`, opens the account screen without
  `--launch-context`.
- Invalid credentials return to the entry screen with bounded status copy.
- A valid account loads only its authoritative character rows.
- Selecting a character mints fresh game/chat tickets and reaches the hosted
  world through `connected::run_launch`.
- Creation posts the exact current character contract, refreshes the roster,
  selects the returned stable id, then can enter the world.
- Passwords are masked, never persisted, never logged, never included in bug
  reports or control snapshots, and cleared after the login attempt completes.
- Raw endpoint/player identity remains available only in a `dev-tools` build
  with `--dev-identity`. It is not an authentication fallback.
- The stable browser client and current `/beta/` web launch remain unchanged.

Account registration is not part of this continuation. New accounts can still
be created on the same-origin website; the native target is login, roster,
creation, and play.

## What already exists

### Pregame presentation is not lost

Commit `4ddb4d89d3f9eb180a600a32da40ea71da05ecf1` added the Successor-owned
pregame port and is an ancestor of this branch. The retained implementation is:

- `client-rust/source/app/src/screens.rs`
  - `EntryScreen`: fixed 330x200 entry composition and connecting modal;
  - `CharacterScreen`: roster, profile, identity, status, and stable-id
    selection;
  - `LoadingScreen`: transition presentation;
  - `ScreenAction`: host-facing intents.
- `client-rust/source/app/src/hosted_creator.rs`
  - bounded roster projection;
  - canonical name/profession/body mapping;
  - default current appearance payload;
  - pending-create/result/roster fence.
- `client-rust/source/app/assets/ui/`
  - `PT_Sans-Web-Bold.ttf`, license, icon atlas, icon metadata;
  - nine generated UI textures under `generated/`.

The UI is exercised by `--demo pregame` in a `dev-tools` build. That host is
explicitly presentation-only: it simulates connect, roster, create, and loading
transitions.

### Ticketed connected runtime already works

- `client-rust/source/app/src/net/session.rs` strictly parses
  `successor.launch-context.v1`, rejects expired/invalid envelopes, and consumes
  game/chat tickets once.
- `client-rust/source/app/src/main.rs::connected::run_launch` already passes the
  returned client release to game and chat authentication.
- Commit `4de6eca385ce87ddd7d83591415dcd98d4d2eb77` fixed the game matchmake body to
  the strict hosted shape `{gameTicket, release}`.
- The native websocket/TLS runtime has already reached
  `wss://world.successorgame.com` on port 443. The missing boundary is account
  acquisition, not world transport.

### Existing HTTP and asset infrastructure

- `client-rust/source/platform/src/native/http.rs` already implements native
  TLS GET and JSON POST for assets/matchmake.
- It currently returns only a successful response body. It does not expose
  response status/headers, accept arbitrary request headers, retain cookies,
  decode every HTTP body framing mode, or set I/O timeouts. It is insufficient
  for account sessions as-is.
- `client-rust/tools/boot-closure.mjs` derives the runtime asset closure from
  canonical manifests.
- `client-rust/tools/web-release.mjs` materializes a self-contained immutable
  Rust runtime with its manifest, packs, and standalone streamed assets.

## Exhaustive search result

The missing account wiring was checked across all local heads, remote refs, and
archive refs in the Successor repository:

- No Rust callsign/password frontend exists in another Successor ref.
- `hosted-direct-launch` does not contain a hidden native account client.
- Password text under `client-rust/source/app/src` appears only in the bug-report
  hygiene warning; there is no dormant login transport to merge.
- The current `EntryScreen` fields are deliberately development `endpoint` and
  `player` fields even though their geometry came from the login capture.
- Ordinary native launch in `main.rs` still exits with
  `ordinary launch requires --launch-context <json-or-file>`.

The external `~/dev/swgrewrite` checkout at
`720252fd0104cfd0ef7ec819c18c3ee9357d3cd8` is an oracle/capture harness, not a
second Rust game client. Its relevant records are:

- `oracle/manifests/original-client-login-create-world.scenario.json`
- `oracle/manifests/original-client-login-existing-world.scenario.json`
- `oracle/manifests/original-client-ui-matrix.json`
- `oracle/manifests/oracle-baseline.json`

Those raw references are intentionally not copied into this repository or its
handoff bundle. `docs/adr/ADR-0001-source-isolation-and-spec-handoff.md` requires
external references to remain outside product source. The implementation and
Successor-owned generated UI assets above are the build inputs.

## Exact hosted account contract

The browser implementation is the executable reference:

- request client: `site/src/api/client.ts`
- types: `site/src/api/types.ts`
- server routes and schemas: `server/src/alpha/http.ts`
- full local account-to-world recipe:
  `tools/verification/standalone/live-runtime.mjs`

Use same-origin production base `https://www.successorgame.com/alpha-api`.
Cookie mutations require JSON plus the origin/session/CSRF boundary used by the
browser:

```text
Origin: https://www.successorgame.com
Sec-Fetch-Site: same-origin
Content-Type: application/json
Cookie: __Host-successor_session=<opaque>
X-CSRF-Token: <opaque>
```

Never print either opaque value.

### Login and roster

1. `GET /alpha-api/csrf`
   - response: `{csrfToken, authenticated}`;
   - captures the `__Host-successor_session` pre-auth cookie.
2. `POST /alpha-api/login`
   - body: `{callsign, password}`;
   - sends the pre-auth cookie and CSRF token;
   - captures the rotated authenticated session cookie;
   - 401 `invalid_credentials` is the expected bounded rejection.
3. `GET /alpha-api/characters`
   - sends the authenticated cookie;
   - response is `{characters: Character[]}` from `site/src/api/types.ts`.

Project rows to `RosterEntry` by stable `id`; never derive identity from the
display name. `CreatorCharacter::roster_entry` already owns the safe body and
profession projection pattern.

### Character creation

`POST /alpha-api/characters` is strict:

```json
{
  "name": "Mara Voss",
  "initialProfessionId": "scout",
  "appearance": {
    "body": "female",
    "skinTone": "#c78f62",
    "hair": "hair_mop",
    "hairMat": "hair_raven",
    "face": null
  }
}
```

`HostedCreatorFlow::begin_create` already validates the visible name, maps the
screen vocation to the canonical profession id, and creates this current
default appearance. Reuse that logic, but do not POST its outer hosted
`successor.creator.create.v1` message envelope: the HTTP route accepts only the
nested strict character object.

Current authority limits are five slots and 16 characters in a name.
`CharacterScreen::ROSTER_CAP` is eight and its raw text fields are wider because
they reproduce the presentation. The native host must use server limits and the
existing canonical-name validator rather than treating screen capacity as
authority.

Lineage, build, and tutorial controls are presentation state today. Do not add
new server fields or a second character schema while wiring this flow.

### Ticket and world entry

`POST /alpha-api/play-ticket` with authenticated cookie + CSRF:

```json
{
  "characterId": "<server-owned-id>",
  "clientReleaseId": "<accepted exact release id>"
}
```

The response contains `gameTicket`, `chatTicket`, `characterId`, `expiresAt`,
`endpoints`, and `release`. The server response omits `schema`; the browser adds
`"schema":"successor.launch-context.v1"` before handing it to the client.
Native must do the same, then call `LaunchEnvelope::from_json` and
`connected::run_launch`.

Do not omit `clientReleaseId`: production would otherwise mint the server's
default stable-browser identity for a different client. The currently
allowlisted Rust identity is `successor-rust-beta@4b659e80f9ea2f65`, which is
valid only for the content-identical `4b659e80` runtime used for the current
smoke. Any account-client code change requires a newly built/published release
identity and an explicit authority allowlist update before live testing. Never
hardcode an old release id into a changed binary.

## Recommended implementation cut

1. Replace the production meaning of `EntryScreen`'s endpoint/player fields with
   callsign/password and replace its dev-specific `Connect(JoinOptions)` intent
   with an account-login intent. Raw dev joins already bypass this screen.
2. Mask password rendering without copying the password into status or debug
   strings. Clear the field after the worker returns.
3. Generalize native HTTP into one bounded request/response primitive that
   exposes method, status, headers, and body. Preserve existing asset and
   matchmake callsites. Support the response framing actually exercised by the
   local standalone server and production edge; do not add speculative retry
   behavior.
4. Put account I/O on one background worker and return typed results over a
   channel. Do not block the render/input frame on DNS, TLS, password verify, or
   ticket minting.
5. Turn the current `run_pregame` presentation host into a reusable controller
   or extract its render/input loop. The production controller owns only:
   login pending/error, roster, create pending/error, ticket pending/error, and
   the final validated envelope.
6. Feed creation through the existing canonical mapping and pending roster
   fence. Refresh `/characters` after a successful create and select the new
   server id.
7. On ticket success, leave the pregame window cleanly and enter the existing
   `connected::run_launch`; do not fork a second game loop.

Before changing exported screen actions or fields, use LSP references. Migrate
every caller and test; do not leave a dev alias beside the account contract.

## Verification required before calling it done

Focused contracts:

- HTTP parser covers status, `Set-Cookie`, content length/chunked body framing,
  request headers, and bounded error bodies.
- Account result types reject malformed/unbounded server data.
- Password never appears in `Debug`, errors, control JSON, screenshots, or a
  persisted settings file.
- Entry, roster, create, cancel/back, retry, and stable-id selection transitions
  have behavior tests.
- `LaunchEnvelope` receives the exact play-ticket response plus added schema and
  still clears both tickets after consumption.

Runtime proof:

1. Start the documented standalone authority with a disposable account.
2. Build the production-capability native binary, not only `successor-dev`.
3. Exercise wrong password, valid login, empty roster, creation, roster refresh,
   selection, play-ticket, `game.hello`, and `chat.hello`.
4. Restart with the same account and prove the created character persists.
5. Only after a new release id is published and allowlisted, repeat the signed-in
   path against production. The 2026-08-07 Rust beta promotion has not yet had a
   signed-in public-account launch.

Minimum repository gates for this slice:

```sh
make -C client-rust test-unit
make -C client-rust native
pnpm verify:successor-context
pnpm check:commands
pnpm denylist
```

The smoke test is the native binary reaching the real roster and world; a unit
suite alone is not delivery proof.

## Asset and bundle inventory

Normal continuation is a clone/fetch of the integration branch followed by
`git lfs pull`. All 2,933 tracked LFS paths are part of the branch contract.
The handoff prepared alongside this document contains:

- a Git bundle for the integration ref;
- a materialized tracked-source archive (LFS payloads, not pointer text;
  ignored `client-rust/target` and other build caches excluded);
- the untracked `.site-captures/` evidence as a separate optional archive;
- SHA-256 checksums and a machine-readable manifest.

The `.site-captures/` tree is runtime/site evidence, not a build dependency. It
is kept separate so the repository does not gain 106 MB of raw BMP evidence.
The product media selected from it already lives under `site/public/media/` and
is tracked through LFS.

For a fresh normal checkout:

```sh
git switch integration/rust-ui-runtime-20260803
git lfs pull
pnpm install --frozen-lockfile
make -C client-rust native
(cd client-rust && ./out/bin/successor)
```

If an asset is missing, fix the LFS checkout or the canonical manifest. Do not
add path fallbacks, placeholder geometry, or a second asset root.

## Do not mix into this continuation

- Do not replace or move the stable browser pointer while proving native login.
- Do not reuse a stable-browser release identity for the native client.
- Do not implement credential persistence, password reset, native registration,
  or retry policy as incidental scope.
- Do not copy raw oracle material into product source.
- Do not treat `.site-captures/` as runtime content.
- Do not report the signed-in production path as verified until it is exercised.
- The reconnect loop noted in the older August 4 handoff remains separate work;
  account entry must not be hidden behind reconnect changes.
