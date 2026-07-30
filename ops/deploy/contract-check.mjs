import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const deployRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(deployRoot, "../..");
const dockerfile = await readFile(join(repoRoot, "ops/docker/Dockerfile"), "utf8");
const monitoring = await readFile(join(deployRoot, "terraform/modules/successor-shard/monitoring.tf"), "utf8");
const lifecycle = await readFile(join(deployRoot, "terraform/modules/successor-shard/lifecycle.tf"), "utf8");
const terraform = await readFile(join(deployRoot, "terraform/modules/successor-shard/main.tf"), "utf8");
const userData = await readFile(join(deployRoot, "user-data.sh.tftpl"), "utf8");
const authority = await readFile(join(deployRoot, "scripts/run-authority.sh"), "utf8");
const backup = await readFile(join(deployRoot, "scripts/backup.sh"), "utf8");
const restore = await readFile(join(deployRoot, "scripts/restore.sh"), "utf8");
const deploy = await readFile(join(deployRoot, "scripts/deploy.sh"), "utf8");
const cleanup = await readFile(join(deployRoot, "scripts/cleanup-generations.sh"), "utf8");
const metrics = await readFile(join(deployRoot, "scripts/metrics.sh"), "utf8");
const bootstrapBackend = await readFile(join(deployRoot, "terraform/bootstrap/backend.tf.example"), "utf8");
const bootstrapBackendExample = await readFile(join(deployRoot, "terraform/bootstrap/backend.hcl.example"), "utf8");
const bootstrap = await readFile(join(deployRoot, "terraform/bootstrap/main.tf"), "utf8");
const bootstrapOutputs = await readFile(join(deployRoot, "terraform/bootstrap/outputs.tf"), "utf8");
const readme = await readFile(join(deployRoot, "README.md"), "utf8");
const service = await readFile(join(deployRoot, "systemd/successor.service"), "utf8");
const releaseSeal = await readFile(join(repoRoot, "tools/release/seal.mjs"), "utf8");
const stagingPromotion = await readFile(join(repoRoot, "tools/release/promote-staging.mjs"), "utf8");

for (const relative of [
  "ops/docker/Dockerfile",
  "ops/deploy/user-data.sh.tftpl",
  "ops/deploy/systemd/successor.service",
  "ops/deploy/scripts/preflight.sh",
  "ops/deploy/scripts/run-authority.sh",
  "ops/deploy/scripts/backup.sh",
  "ops/deploy/scripts/restore.sh",
  "ops/deploy/scripts/publish-client-assets.mjs",
  "ops/deploy/terraform/bootstrap/main.tf",
  "tools/release/seal.mjs",
  "tools/release/promote-staging.mjs",
  "ops/deploy/terraform/envs/staging/main.tf",
  "ops/deploy/terraform/modules/successor-shard/main.tf",
]) await access(join(repoRoot, relative));

assert.match(bootstrapBackend, /backend \"s3\" \{\s*\}/);
assert.match(bootstrapBackendExample, /successor\/bootstrap\/terraform.tfstate/);
assert.match(bootstrap, /aws_route53_zone/);
assert.match(bootstrapOutputs, /name_servers/);
assert.match(terraform, /count\s*=\s*length\(var.budget_alert_emails\)/);
assert.match(monitoring, /count\s*=\s*try\(trimspace\(var.alarm_email\), ""\)/);
assert.match(dockerfile, /FROM --platform=\$TARGETPLATFORM rust:1\.85-bookworm/);
assert.doesNotMatch(dockerfile, /FROM --platform=\$BUILDPLATFORM/);
assert.match(dockerfile, /COPY --from=rust-build/);
assert.match(dockerfile, /COPY client\/public\/successor-slice/);
assert.match(dockerfile, /COPY tools\/denylist\/denylist\.txt/);
assert.match(dockerfile, /pnpm --dir server build/);
assert.match(dockerfile, /cp -a server\/dist \/out\/server\/dist/);
assert.match(dockerfile, /GAME_RUST_AUTHORITY_BRIDGE_BIN=\/app\/bin\/authority_bridge_server/);
assert.match(dockerfile, /GAME_SHARD_STATE_DIR=\/var\/lib\/successor\/state/);
assert.match(dockerfile, /GAME_SLICE_PATH=\/app\/client\/public\/successor-slice\/open-desert-slice\.json/);
assert.match(dockerfile, /rust:1\.85-bookworm@sha256:/);
assert.match(dockerfile, /node:22-bookworm-slim@sha256:/);
assert.match(dockerfile, /ARG TARGETARCH/);
assert.match(dockerfile, /test \"\$TARGETARCH\" = \"amd64\"/);
assert.match(dockerfile, /node:22-bookworm-slim/);
assert.match(dockerfile, /USER successor/);
assert.match(dockerfile, /ENTRYPOINT \["node"\]/);
assert.match(dockerfile, /VOLUME \["\/var\/lib\/successor", "\/tmp"\]/);
assert.match(terraform, /ssm:GetParameter/);
assert.match(terraform, /parameter\$\{var.runtime_secret_parameter_name\}/);
assert.match(terraform, /parameter\$\{var.runtime_bearer_parameter_name\}/);
assert.doesNotMatch(terraform, /runtime_secret_value|runtime_bearer_value/);
assert.match(terraform, /multi_attach_enabled\s*=\s*false/);
assert.match(terraform, /prevent_destroy\s*=\s*true/);
assert.match(terraform, /path\s*=\s*\"\/readyz\"/);
assert.match(terraform, /aws_sns_topic/);
assert.match(terraform, /aws:ResourceTag\/Backup/);
assert.match(terraform, /ec2:ResourceTag\/Shard/);
assert.match(lifecycle, /tagPrefixList = \["release-"\]/);
assert.doesNotMatch(terraform, /StateInitialized\s*=\s*"false"/);
assert.doesNotMatch(terraform, /aws_autoscaling_group|aws_launch_template/);
assert.match(terraform, /http_tokens\s*=\s*"required"/);
assert.doesNotMatch(terraform, /from_port\s*=\s*22/);
assert.match(terraform, /resource\s+"aws_lb_listener"\s+"https"/);
assert.match(terraform, /resource\s+"aws_cloudfront_distribution"\s+"assets"/);
assert.match(terraform, /user_data_base64\s*=\s*base64gzip\(local.user_data\)/);
assert.match(terraform, /client_cdn_origin\s*=\s*"https:\/\/\$\{aws_cloudfront_distribution\.assets\.domain_name\}"/);
assert.match(terraform, /allowed_origins = \[var.client_store_origin\]/);
assert.match(terraform, /access_control_allow_credentials = false/);
assert.doesNotMatch(terraform, /allowed_origins = \["\*"\]/);
assert.match(terraform, /resource\s+"aws_dlm_lifecycle_policy"\s+"state"/);
assert.match(terraform, /resource\s+"aws_budgets_budget"\s+"monthly"/);
assert.match(userData, /aws ssm get-parameter --name/);
assert.equal((userData.match(/--with-decryption/g) || []).length, 3);
assert.match(userData, /SUCCESSOR_RUNTIME_SECRET=%s/);
assert.match(userData, /SUCCESSOR_RUNTIME_BEARER_TOKEN=%s/);
assert.match(userData, /SUCCESSOR_SITE_URL=%s/);
assert.match(userData, /chmod 0600 \/etc\/successor\/runtime\.env/);
assert.doesNotMatch(userData, /runtime_secret_value|runtime_bearer_value/);
assert.match(userData, /SUCCESSOR_IMAGE_REF=/);
assert.match(userData, /EXPECTED_VOLUME_ID=/);
assert.match(userData, /INITIALIZE_EMPTY_VOLUME/);
assert.match(userData, /GAME_CHARACTER_STORE_PATH=\/var\/lib\/successor\/live\/characters\.json/);
assert.match(userData, /GAME_SHARD_STATE_DIR=\/var\/lib\/successor\/live\\n/);
assert.match(userData, /GAME_SHARD_MANIFEST_PATH=\/var\/lib\/successor\/live\/state\/state-generation\.manifest\.json/);
const blkidFlow = userData.indexOf("if ! blkid \"$STATE_DEVICE\"");
const initializedGuard = userData.indexOf("state volume was previously initialized");
assert(blkidFlow >= 0 && initializedGuard > blkidFlow, "initialized tag must guard only the unrecognized-volume format path");
assert(userData.indexOf("mountpoint -q \"$STATE_DIR\"") > initializedGuard, "recognized initialized volume must reach mount");
assert.match(userData, /aws s3 cp 's3:\/\/\$\{backup_bucket_name\}\/bootstrap\/\$\{bootstrap_revision\}\//);
assert.doesNotMatch(userData, /_b64/);
assert.match(userData, /SUCCESSOR_BACKUP_S3_URI=/);
assert.match(userData, /bounded wait/);
assert.match(authority, /registry=\$\{IMAGE_REF/);
assert.match(authority, /aws ecr get-login-password --region/);
assert.match(authority, /docker login --username AWS --password-stdin/);
assert.match(authority, /docker pull \"\$IMAGE_REF\"/);
assert.match(authority, /docker run --pull=never/);
assert.match(authority, /--publish 28093:28093/);
assert.match(authority, /docker logout \"\$registry\"/);
assert(authority.indexOf("flock -n 9") < authority.indexOf("aws ecr get-login-password"), "ECR login must occur under authority lock");
assert.match(backup, /aws s3 cp/);
assert.match(backup, /BackupSuccess/);
assert.match(backup, /authority\.lock/);
assert.match(restore, /mv \"\$STATE_DIR\/live\" \"\$old\"/);
assert.match(restore, /mv \"\$tmp\" \"\$STATE_DIR\/live\"/);
assert.match(restore, /expanded_kb/);
assert.match(restore, /readyz/);
assert.match(restore, /previous-/);
assert.match(restore, /rollback_generation/);
for (const script of [backup, restore, cleanup]) assert.match(script, /maintenance\.lock/);
assert.match(cleanup, /previous-.*failed-/s);
assert.match(deploy, /fail\s*\(/);
assert.match(deploy, /SUCCESSOR_IMAGE_REF=/);
assert.match(deploy, /runtime_env_tmp/);
assert.match(deploy, /sed .*SUCCESSOR_IMAGE_REF/);
assert.match(cleanup, /SUCCESSOR_CLEANUP_RESTART/);
assert.match(cleanup, /was_active/);
assert.match(cleanup, /was_masked/);
assert.match(cleanup, /restart=0[\s\S]*was_active/);
assert.match(restore, /replacement service failed to start/);
assert.doesNotMatch(restore, /rm -rf \"\$old\"/);
assert.match(restore, /available_kb/);
assert.match(releaseSeal, /successor\.release-source-seal\.v1/);
assert.match(releaseSeal, /successor\.release-seal\.v1/);
assert.match(stagingPromotion, /IMAGE_DIGEST_MISMATCH/);
assert.match(stagingPromotion, /REBUILD_FORBIDDEN/);
assert.match(metrics, /put-metric-data/);
assert.match(service, /ConditionPathIsMountPoint=\/var\/lib\/successor/);
assert.match(service, /ProtectSystem=strict/);
assert.match(service, /ExecStart=\/usr\/local\/libexec\/successor-run\.sh/);
console.log("successor invite-alpha deployment contracts: PASS");
