# Successor AWS public-alpha deployment

This directory contains the infrastructure and operator contracts used by the
current public alpha. Exact live values remain outside Git; do not infer them
from example tfvars or Terraform directory names. The historical resource
namespace and Terraform environment are still named `staging`, but the
deployed public surfaces are `www.successorgame.com` and
`world.successorgame.com`.

Current public release identity belongs in
`../../docs/CURRENT_DEPLOYMENT.md`. Provider credentials belong only in the
approved Bunker provider environment, never in this repository, Terraform
state inputs, command output, or another host.

## Shape

- `../docker/Dockerfile` builds the TypeScript server, client slice, and Rust
  `authority_bridge_server` in a multi-stage image. The runtime is Node 22 on
  Debian, UID 10001, and expects `linux/amd64`. Builds require BuildKit
  (default since Docker 23): the pnpm store and Cargo registry/target dirs are
  `RUN --mount=type=cache` volumes, so source-only rebuilds skip dependency
  fetches and crate recompiles; the finished bridge is copied out of the
  target cache to `/out/authority_bridge_server` for the runtime stage.
- `terraform/bootstrap` creates the versioned, encrypted private state bucket
  and Route53 hosted zone selected by operator tfvars. The committed
  `successor.compress.biz` default is historical scaffolding, not the current
  public domain and not a safe apply value. The deployed zone is
  `successorgame.com`; its name servers must be delegated explicitly.
  S3 native lock files (`use_lockfile = true`) require Terraform >= 1.10.
- `terraform/envs/staging` wires `modules/successor-shard`: two public and two
  private subnets, one NAT gateway, ALB + ACM DNS validation for WSS, one private
  x86 EC2 instance, SSM-only IAM, immutable ECR, one encrypted EBS state volume
  with `multi_attach_enabled = false`, private S3/CloudFront assets, versioned backup bucket, CloudWatch alarms/log group, DLM snapshots, and AWS Budget
  alerts.
- `systemd/` and `scripts/` make the Rust child the sole gameplay writer. The
  host checks the EBS mount and takes a non-blocking `flock`; backup/restore stop
  the service and never attempt automatic volume reattachment or replacement.

The ALB is the only public ingress. The instance has no SSH ingress and no
`key_name`; use SSM after the account's SSM prerequisites are verified. EC2 root
and the container root are read-only; `/var/lib/successor` is the explicit EBS
state mount and `/tmp` is an explicit tmpfs.

## Bootstrap (operator-run, no implicit values)

The bootstrap backend starts empty so a new environment can create its own
state bucket without pretending that the bucket already exists. Do not rerun
this bootstrap against the current alpha as routine maintenance. For a new
environment, use this two-phase sequence only with explicit approval and
operator-supplied current values:

```bash
cd ops/deploy/terraform/bootstrap
cp terraform.tfvars.example terraform.tfvars
terraform init -backend=false
terraform plan -out bootstrap-local.tfplan
terraform apply bootstrap-local.tfplan
# The local state now records the state bucket and public hosted zone.
cp backend.tf.example backend.tf
cp backend.hcl.example backend.hcl
# Replace the two REPLACE_WITH_* values in backend.hcl from the approved inputs.
terraform init -migrate-state -backend-config=backend.hcl
terraform output backend_config
terraform output name_servers
```

`terraform.tfvars`, `backend.tf`, `backend.hcl`, and local state are intentionally not
committed; `backend.tf` is ignored and must be generated only after the bucket exists. Delegate every emitted `name_servers` value at the Cloudflare parent.
Use the emitted bootstrap `hosted_zone_id` for staging `route53_zone_id`, and
copy the staging backend values into `../envs/staging/backend.hcl`. Configure
AWS credentials through the approved account boundary; never put access keys in
this repository.

## Client asset release (operator-run)

`publish-client-assets.mjs` is provider-free until `--apply`. It hashes every
file under the dist directory, writes a deterministic manifest, uploads
immutable objects, uploads the immutable manifest at
`manifests/<manifest-sha256>.json`, and uploads `current.json` last with
`no-store,no-cache,must-revalidate`. Every upload sets an explicit
Content-Type; modules, CSS, fonts, media, GLB, and `.spak` packs are covered.

Two storage layouts exist:

- **Path layout (stable `client-3d` releases).** Immutable tree at
  `releases/<manifest-sha256>/<relative-path>` preserving dist layout. Pass
  `--baseline-manifest <url-or-file>` pointing at the currently live manifest:
  files whose sha256 matches the baseline at the same path are copied
  server-side from the previous release prefix (`s3api copy-object`,
  zero transfer) instead of re-uploaded. A code-only release uploads only its
  changed files.
- **Content-addressed object store (`--object-store`, Rust beta releases).**
  Streamed payloads (paths under `assets/`, `successor-audio/`,
  `successor-slice/`, `render/`, `packs/`) upload exactly once ever as
  `objects/<sha256-of-uncompressed-content>`, gzipped at level 9 with
  `Content-Encoding: gzip` for text/GLB/wasm/pack types (content identity
  stays the uncompressed hash; browsers decode transparently). Entry files
  (`index.html`, `successor.js`, `successor.wasm`, `release-manifest.json`)
  remain release-scoped under `releases/<manifest-sha256>/`. Objects already
  present in the bucket are skipped (listing `objects/` once up front), so an
  incremental beta publish uploads only newly minted content. The object store
  is append-only: objects are never garbage-collected by the publisher.

Uploads run 16-wide; ordering is objects, then release-scoped files, then the
manifest, and `current.json` strictly last.

```bash
node ops/deploy/scripts/publish-client-assets.mjs \
  --dist client-3d/dist \
  --output-dir .successor-client-publish \
  --cdn-origin https://REPLACE_WITH_ASSET_CDN_ORIGIN \
  --store-origin https://REPLACE_WITH_COMPRESS_SUCCESSOR_STORE_ORIGIN \
  --dry-run
# Rust beta dists add --object-store. Repeat stable publishes add
# --baseline-manifest <current manifest URL>. Review the printed operations
# and manifest, then use --apply with the approved bucket.
```

`asset_cdn_origin` and `asset_manifest_url` Terraform outputs provide the CDN
origin and the `SUCCESSOR_CLIENT_MANIFEST_URL` value. The pointer URL is
`<asset_cdn_origin>/current.json`; include that exact URL and the CDN origin in
the ComPress Successor CSP. S3 and CloudFront CORS allow only the exact
`client_store_origin`, GET/HEAD, and no credentials.

Runtime identity is secret-safe: the historical `staging` variables carry only
the approved SSM SecureString parameter names
`/successor/staging/runtime-secret` and
`/successor/staging/runtime-bearer`. The deployed site URL is
`https://www.successorgame.com`, and the public client origin is the immutable
CloudFront client origin selected by Terraform. The instance fetches values with
`ssm get-parameter --with-decryption` during bootstrap, fails closed on empty
values, and writes them only to the mode-0600 runtime environment file. Secret
values never enter Terraform variables, state, user-data, or logs.

## Staging plan (no provider writes)

```bash
cd ops/deploy/terraform/envs/staging
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars
# Replace every REPLACE_WITH_* value from the v8 seal. `alarm_email` and `budget_alert_emails` may remain empty for a no-email dry run; alarms/resources remain defined without external subscriptions.
terraform init -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out staging.tfplan
```

`plan` must be reviewed for cost and account before any apply. In particular,
NAT Gateway, ALB, CloudFront, EBS, DLM, and data transfer are paid resources.
There is deliberately no ASG, automatic failover, automatic volume
reattachment, Multi-Attach, SSH path, or second gameplay authority.

## Container proof

From the repository root on an x86 Linux builder:

```bash
docker build --platform=linux/amd64 -f ops/docker/Dockerfile -t successor:invite-alpha .
docker image inspect successor:invite-alpha --format '{{.Architecture}}'
docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev \
  --mount type=tmpfs,dst=/var/lib/successor \
  -e GAME_SHARD_PERSISTENCE=0 successor:invite-alpha
```

For a deployment, tag and push once, then record and deploy the immutable
`@sha256:` digest. `scripts/deploy.sh` rejects mutable tags and non-amd64
images. Node runs as PID 1 and receives SIGTERM; the existing server shutdown barrier closes
Colyseus and the Rust child before exit.

## Host operations

`user-data.sh.tftpl` installs Docker and SSM, formats only a blank EBS device,
mounts it at `/var/lib/successor`, installs the systemd/scripts bundle, and
starts exactly one service. `backup.sh` stops the authority before producing a
stable tar archive. `restore.sh` requires
`SUCCESSOR_RESTORE_CONFIRM=I_UNDERSTAND_SINGLE_WRITER`, rejects traversal names,
and leaves the service stopped for operator verification. A failed preflight is
safer than guessing at a device or writing a second checkpoint.

The weekly `successor-cleanup.timer` stops the service under the same maintenance
lock, retains the newest known-good rollback plus three recent failures, and
starts the service again. For an SSM operator session, verify the shard is
healthy, then run:

```bash
sudo SUCCESSOR_CLEANUP_RESTART=1 /usr/local/libexec/successor-cleanup-generations.sh
```

The command never deletes `live`; it requires the state mount and shared lock.

The contract check is local and provider-free:

```bash
bash ops/deploy/validate.sh
```

## Operator loop (provider-free contract)

The release path has one inner loop and one stateful maintenance path. The
source-aware classifier is the existing `verify:fast --base` selection; a Vite
page or a client screenshot is not gameplay proof. Seal source, fixture, save,
wire, client-manifest, image, and verification identities before a deploy:

```bash
pnpm verify:fast -- --base .successor-release-seal/source-manifest.json --dry-run --pretty
pnpm release:seal --input .successor-release-seal/input.json --out-dir .successor-release-seal
pnpm release:promote:staging --seal .successor-release-seal/release-seal.json \
  --tested-image REGISTRY/successor@sha256:DIGEST \
  --candidate-image REGISTRY/successor@sha256:DIGEST \
  --tested-client-manifest CLIENT_MANIFEST_SHA256 \
  --candidate-client-manifest CLIENT_MANIFEST_SHA256 --out promotion.json
```

The tested image and client manifest must be byte-for-byte the same values as
the seal. A rebuild or digest drift is refused. Once the human maintenance
window is open, admissions and ticket minting are paused, sessions drain, and
the existing `successor-deploy.sh` runs one stop/pull/start under its lock:

```bash
sudo SUCCESSOR_MAINTENANCE_ACK=I_UNDERSTAND_MAINTENANCE \
  SUCCESSOR_RELEASE_SEAL_SHA256=SEAL_SHA256 \
  /usr/local/libexec/successor-maintenance-deploy.sh IMAGE@sha256:DIGEST
```

A server rollback first compares the live generation and compatibility marker
with the target seal. `successor-rollback.sh` refuses generation or digest
mismatch. If the save generation is incompatible, provide the explicitly
approved backup and the single-writer restore confirmation; the existing
`successor-restore.sh` leaves the service stopped for operator verification.
Do not run two authorities against one state tree.

Backups refuse to run without `/etc/successor/backup-retention.env`; validate it
without cloud access:

```bash
sudo /usr/local/libexec/successor-validate-retention.sh
```

The retention policy keeps three recent archives and three failed generations,
with a 30-day age bound and an interval no longer than the configured RPO.
Missing, disabled, or unsafe policy is a failure, not an invitation to use a
hard-coded fallback.

After each operator session, bind the metrics, logs, and journal files to the
release seal and session id. The review is evidence, not a claim that the
session was a complete gameplay gate:

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

The monthly `successor-restore-rehearsal.timer` extracts one selected backup to
an isolated target. It never calls `systemctl`, `docker`, `aws`, or a live
endpoint, and refuses a target overlapping `/var/lib/successor`:

```bash
SUCCESSOR_STATE_DIR=/var/lib/successor \
  /usr/local/libexec/successor-restore-rehearsal.sh \
  /var/backups/successor/successor-YYYYmmddTHHMMSSZ.tar.gz \
  ~/.cache/successor-restore-rehearsals/manual-YYYYmmdd
```

The rehearsal proves archive traversal safety and a complete state payload. A
separate authority/client smoke is required before calling the restored tree
playable. The local contract and isolated rehearsal use no provider writes:

```bash
node --test tools/release/operator-loop.test.mjs
node --test tools/release/seal.test.mjs
bash ops/deploy/validate.sh
```
