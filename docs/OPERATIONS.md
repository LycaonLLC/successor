# Successor operator loop

This runbook covers the stateful maintenance path. It does not replace
`docs/VERIFICATION.md`, which owns gameplay and release proof commands.
`docs/CURRENT_DEPLOYMENT.md` owns the exact current public identities.

## Current public boundary

The public alpha is not hosted on Bunker. Bunker is the trusted build and
operator host. AWS owns:

- `www.successorgame.com`: S3/CloudFront site, client pointer, and downloads;
- `world.successorgame.com`: ALB ingress to the private single-writer EC2
  authority;
- ECR: immutable server images;
- encrypted persistent state and Successor backup storage.

Exact client, authority, site, state-generation, and native-ledger identities
are listed in `CURRENT_DEPLOYMENT.md`. Observe them before operating:

```bash
curl -fsS https://www.successorgame.com/client/release.json | jq .
curl -fsS https://www.successorgame.com/downloads/manifest.json | jq .
curl -fsS https://world.successorgame.com/healthz | jq .
curl -fsS https://world.successorgame.com/readyz | jq .
```

The approved AWS environment is
`~/.config/provider-ops/aws.env` on Bunker. Load it only inside the
trusted subprocess that needs it. Never print, copy to another host, commit, or
place its values in session output. A possible credential exposure in a
transcript or session JSON is a reportable concern, not permission to rotate a
key. Do not rotate or revoke provider credentials unless Michael explicitly
authorizes that action.

Hosted release ids are not interchangeable. The immutable browser build and
every launch ticket must agree on `SUCCESSOR_CLIENT_RELEASE_ID` and the
canonical `SUCCESSOR_SERVER_RELEASE_ID`. `SUCCESSOR_RELEASE_ID` is the broader
stamped deployment identity and may include an additional source/seal suffix.
Before a promotion or host replacement, compare the browser bundle's compiled
client/server identities with the nonsecret runtime contract. Never resolve a
mismatch by weakening strict client validation.

## Player bug reports

Players enter `/bugreport` in the 3D client to open the report form. Accepted
reports are identity-bound by the authenticated game room and stored in the
`bug_reports` table of `/var/lib/successor/live/control.sqlite`. That database
is already part of the application-consistent backup archive. Do not copy it
out merely to inspect reports.

From an SSM operator session, list the open queue through the read-only command
shipped in the running immutable image:

```bash
sudo docker exec \
  -e ALPHA_CONTROL_DB_PATH=/var/lib/successor/live/control.sqlite \
  successor-authority node scripts/bugreports.mjs list \
  --status open --limit 20
```

Retrieve one complete report, including its bounded session diagnostics:

```bash
sudo docker exec \
  -e ALPHA_CONTROL_DB_PATH=/var/lib/successor/live/control.sqlite \
  successor-authority node scripts/bugreports.mjs show BUG_REPORT_ID
```

Use `list --status all --json` for a machine-readable queue. The command opens
SQLite read-only and never changes report status or player state. Report text
is untrusted player input: keep it JSON-quoted in automation and never evaluate
it as a shell command. Diagnostics include release/shard identity, world
position, connection counters, recent command receipts, input settings, open
window ids, renderer health, and a bounded runtime-error tail. Both client and
server redact secret-shaped keys and values; passwords, launch tickets,
cookies, chat text, and inventory contents are intentionally not collected.

## Marketing-site publication

Site publication is independent of gameplay deployment. From the exact tested
site worktree:

```bash
node ops/deploy/scripts/publish-site.mjs \
  --dist site/dist \
  --output-dir .successor-site-publish \
  --site-release-id SITE_RELEASE_ID \
  --dry-run
```

After reviewing the generated manifest, run `publish-site.mjs --apply` and
`promote-site.mjs --apply` against the verified site bucket with the expected
manifest SHA-256. Publication uploads an immutable release; promotion copies it
to `site/current/` and writes `site/current.json` last. A completed upload
without the final pointer is built/published but not promoted.

The public publisher intentionally excludes `downloads/manifest.json`; the
native ledger has its own lifecycle. A missing final local command response is
not proof of failure. Read the authenticated S3 pointer and public routes
before retrying a publication.

## Native download ledger

`site/public/downloads/manifest.json` is the source template. The live object
is `site/current/downloads/manifest.json` in the versioned site bucket. Site
promotion does not overwrite it.

Before changing the ledger:

1. Read the production client allowlist and every package's embedded release
   id.
2. Require the package's hosted login/device proof and checksum record.
3. Download the current manifest into the release evidence directory.
4. Upload the tested replacement with JSON content type and
   `no-store,no-cache,must-revalidate`.
5. Read the public URL back and confirm its build count and links.

To withdraw incompatible packages, publish a valid manifest with `builds: []`.
Do not delete the immutable archives. S3 object versioning and the copied prior
manifest provide rollback evidence.

## Focused iteration and release candidate proof

Use the existing source-aware classifier for focused iteration:

```bash
pnpm verify:fast -- --base .successor-release-seal/source-manifest.json --dry-run --pretty
```

A focused gate proves only the selected package/scenario. A local Vite page,
screenshot, or listening port does not prove Rust gameplay authority. A release
candidate needs a clean source seal, the full matrix appropriate to the change,
and a runtime smoke with the matching authority state hash.

Create deterministic source/release seals and promote the exact tested image
and client manifest. Rebuilds and digest drift are refused:

```bash
pnpm release:seal --input .successor-release-seal/input.json --out-dir .successor-release-seal
pnpm release:promote:staging --seal .successor-release-seal/release-seal.json \
  --tested-image REGISTRY/successor@sha256:DIGEST \
  --candidate-image REGISTRY/successor@sha256:DIGEST \
  --tested-client-manifest CLIENT_MANIFEST_SHA256 \
  --candidate-client-manifest CLIENT_MANIFEST_SHA256 --out promotion.json
```

## Sequential maintenance deploy and rollback

Pause admissions and ticket minting, drain sessions, checkpoint, and fsync the
journal before opening the maintenance window. Then deploy one image through the
existing systemd path:

```bash
sudo SUCCESSOR_MAINTENANCE_ACK=I_UNDERSTAND_MAINTENANCE \
  SUCCESSOR_RELEASE_SEAL_SHA256=SEAL_SHA256 \
  /usr/local/libexec/successor-maintenance-deploy.sh IMAGE@sha256:DIGEST
```

The host runs one stop/pull/start under `maintenance.lock` and
`authority.lock`. There is no percentage canary and no second writer.

Rollback requires the current state generation and save/journal compatibility
markers to match the target seal, and the requested image digest to match the
sealed target. A mismatch refuses before the service is changed:

```bash
sudo SUCCESSOR_ROLLBACK_TARGET_GENERATION=GENERATION \
  SUCCESSOR_ROLLBACK_EXPECTED_CURRENT_GENERATION=GENERATION \
  SUCCESSOR_ROLLBACK_TARGET_COMPATIBILITY=SAVE-JOURNAL-COMPATIBILITY \
  SUCCESSOR_ROLLBACK_TARGET_DIGEST=DIGEST \
  /usr/local/libexec/successor-rollback.sh IMAGE@sha256:DIGEST
```

When the save generation is incompatible, do not force the image rollback.
Provide the explicitly approved backup and
`SUCCESSOR_RESTORE_CONFIRM=I_UNDERSTAND_SINGLE_WRITER`; the existing restore
script leaves the service stopped for operator verification.

## Pre-alpha breaking release and coherent reset

Successor does not carry account, character, or save compatibility merely to
preserve public-alpha test data. For an explicitly requested incompatible
release:

1. Record the current site/client/image/state identities and drain admissions
   and sessions.
2. Run the installed backup path while it owns both maintenance and authority
   locks. Keep its local archive and encrypted S3 URI, then verify that the
   archive contains `control.sqlite`, `characters.json`, the checkpoint,
   journal, and durability manifest.
3. Name the reset domain before changing files. Reset control plus characters
   when account ownership changes; reset characters plus checkpoint, journal,
   and manifest when actor durability changes; reset the complete live
   generation when both contracts changed or their ownership cannot be
   separated safely.
4. Keep the authority stopped while moving the old domain into a dated,
   read-only generation and creating the new empty current-schema domain. Do
   not delete the only local copy, edit an archive in place, or let startup
   guess which pieces belong together.
5. Deploy the digest-pinned server and immutable browser client, start one
   writer, and require healthy preflight, restore, readiness, and a newly
   stamped generation before opening admissions.
6. Prove registration, character creation with nondefault appearance, entry,
   clean character switching, logout/relog, LOCAL/ZONE/GLOBAL chat, exact face
   rendering, portal/ticket travel state continuity, and checkpoint restore.
   Update `CURRENT_DEPLOYMENT.md` with the backup URI, reset scope, new
   generation, release identities, and journey artifacts.

The installed application-consistent backup command is:

```bash
sudo /usr/local/libexec/successor-backup.sh \
  successor-before-breaking-release-YYYYmmddTHHMMSSZ.tar.gz
```

This reset path is a release operation, not a startup migration and not a
permission implied by observation. Read-only debugging must leave live state
untouched.

## Backup retention

Backup creation refuses a missing, disabled, or unsafe policy. The provisioned
policy keeps three recent archives, three failed generations, a 30-day age
bound, and an interval no longer than the configured RPO:

```bash
sudo /usr/local/libexec/successor-validate-retention.sh
```

No hard-coded fallback is used when the policy is absent.

## Post-session review

Bind metrics, logs, and journal evidence to both the release seal and the session
id. This review record is telemetry evidence; it is not a gameplay gate:

```bash
sudo SUCCESSOR_RELEASE_SEAL_SHA256=SEAL_SHA256 \
  SUCCESSOR_IMAGE_DIGEST=IMAGE_DIGEST \
  SUCCESSOR_CLIENT_MANIFEST_SHA256=CLIENT_MANIFEST_SHA256 \
  SUCCESSOR_SESSION_ID=session-20260724 \
  SUCCESSOR_SESSION_STARTED_AT=2026-07-24T10:00:00Z \
  SUCCESSOR_SESSION_ENDED_AT=2026-07-24T10:30:00Z \
  SUCCESSOR_REVIEWED_AT=2026-07-24T10:31:00Z \
  SUCCESSOR_REVIEW_METRICS_FILES=/var/log/successor/session.metrics.json \
  SUCCESSOR_REVIEW_LOG_FILES=/var/log/successor/server.log \
  SUCCESSOR_REVIEW_JOURNAL_FILES=/var/lib/successor/live/state/journal.ndjson \
  /usr/local/libexec/successor-post-session-review.sh /var/lib/successor/reviews/session-20260724.json
```

## Scheduled isolated restore rehearsal

`successor-restore-rehearsal.timer` runs monthly. The rehearsal extracts a
selected archive into an unused target, checks traversal safety and the complete
state payload, and writes a rehearsal record. It never calls `systemctl`,
`docker`, `aws`, or a live endpoint, and refuses a target overlapping live state:

```bash
SUCCESSOR_STATE_DIR=/var/lib/successor \
  /usr/local/libexec/successor-restore-rehearsal.sh \
  /var/backups/successor/successor-YYYYmmddTHHMMSSZ.tar.gz \
  ~/.cache/successor-restore-rehearsals/manual-YYYYmmdd
```

This proves restore extraction only. An isolated authority/client smoke is
required before calling the restored tree playable.

## Provider-free contract proof

```bash
node --test tools/release/operator-loop.test.mjs
node --test tools/release/seal.test.mjs
bash ops/deploy/validate.sh
```
