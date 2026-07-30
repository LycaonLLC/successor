import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name) => readFile(path.join(root, name), "utf8");

describe("operator deployment contracts", () => {
  it("keeps maintenance sequential and rollback state-aware", async () => {
    const maintenance = await read("ops/deploy/scripts/maintenance-deploy.sh");
    const rollback = await read("ops/deploy/scripts/rollback.sh");
    assert.match(maintenance, /SUCCESSOR_MAINTENANCE_ACK/);
    assert.match(maintenance, /SUCCESSOR_RELEASE_SEAL_SHA256/);
    assert.match(maintenance, /successor-deploy\.sh/);
    assert.match(rollback, /TARGET_GENERATION/);
    assert.match(rollback, /TARGET_COMPATIBILITY/);
    assert.match(rollback, /TARGET_DIGEST/);
    assert.match(rollback, /incompatible state generation/);
    assert.match(rollback, /successor-restore\.sh/);
  });

  it("requires retention policy and binds post-session evidence", async () => {
    const backup = await read("ops/deploy/scripts/backup.sh");
    const retention = await read("ops/deploy/scripts/validate-retention.sh");
    const review = await read("ops/deploy/scripts/post-session-review.sh");
    assert.match(backup, /successor-validate-retention\.sh/);
    assert.match(backup, /RETENTION_MAX_AGE_DAYS/);
    assert.match(backup, /was_active/);
    assert.match(backup, /systemctl start successor\.service/);
    assert.match(backup, /graceful checkpoint barrier missing/);
    assert.match(retention, /RETENTION_ENABLED/);
    assert.match(retention, /keep_recent/);
    assert.match(review, /successor\.post-session-review\.v1/);
    assert.match(review, /SUCCESSOR_RELEASE_SEAL_SHA256/);
    assert.match(review, /SUCCESSOR_SESSION_ID/);
    assert.match(review, /METRICS/);
    assert.match(review, /JOURNAL/);
  });

  it("refuses standalone service without bound control and manifest evidence", async () => {
    const preflight = await read("ops/deploy/scripts/preflight.sh");
    const service = await read("ops/deploy/systemd/successor.service");
    assert.match(preflight, /ALPHA_CONTROL_DB_PATH/);
    assert.match(preflight, /GAME_SHARD_MANIFEST_PATH/);
    assert.match(preflight, /schema_migrations/);
    assert.match(preflight, /controlSchemaHead/);
    assert.match(service, /ExecStartPre=.*successor-preflight\.sh/);
    assert.match(service, /GAME_SHARD_PERSISTENCE=1/);
  });

  it("threads the fenced standalone production contract without secret values", async () => {
    const userData = await read("ops/deploy/user-data.sh.tftpl");
    const staging = await read("ops/deploy/terraform/envs/staging/main.tf");
    const variables = await read("ops/deploy/terraform/modules/successor-shard/variables.tf");
    const iam = await read("ops/deploy/terraform/modules/successor-shard/main.tf");
    const example = await read("ops/deploy/terraform/envs/staging/terraform.tfvars.example");
    assert.match(userData, /control_secret_parameter_name/);
    assert.match(userData, /SUCCESSOR_CONTROL_PLANE_MODE=standalone/);
    assert.match(userData, /SUCCESSOR_ALPHA_ORIGIN=https:\/\/www\.successorgame\.com/);
    assert.match(userData, /SUCCESSOR_ALPHA_CLIENT_ORIGIN=%s/);
    assert.match(userData, /wss:\/\/world\.successorgame\.com\/chat\/ws/);
    assert.match(userData, /SUCCESSOR_ALPHA_REGISTRATION_CAP=64/);
    assert.match(userData, /SUCCESSOR_ALPHA_TRUSTED_PROXY_HOPS=2/);
    assert.match(userData, /2026-07-24/);
    assert.match(userData, /GAME_CHARACTER_STORE_PATH=\/var\/lib\/successor\/live\/characters\.json/);
    assert.match(userData, /GAME_SHARD_STATE_DIR=\/var\/lib\/successor\/live\\n/);
    assert.match(userData, /GAME_SHARD_MANIFEST_PATH=\/var\/lib\/successor\/live\/state\/state-generation\.manifest\.json/);
    assert.match(userData, /ALPHA_CONTROL_DB_PATH=\/var\/lib\/successor\/live\/control\.sqlite/);
    const runtimeEnv = userData.split("\n").find((line) => line.startsWith("printf 'SUCCESSOR_IMAGE_REF="));
    assert.ok(runtimeEnv);
    assert.equal(runtimeEnv.match(/%s/g)?.length, 16);
    assert.match(runtimeEnv, /' '\$\{container_image\}' "\$runtime_secret" "\$runtime_bearer" "\$control_secret" '\$\{client_cdn_origin\}' '\$\{site_url\}' '\$\{shard_id\}' '\$\{shard_id\}' '\$\{client_release_id\}' '\$\{client_release_allowlist\}' '\$\{server_release_id\}' '\$\{release_id\}' '\$\{shard_id\}' '\$\{shard_id\}' '\$\{shard_id\}' '\$\{aws_region\}' >\/etc\/successor\/runtime\.env$/);
    assert.match(staging, /server_release_id\s*=\s*"planetfall-v5-[^"]+-overworld"/);
    assert.match(staging, /release_id\s*=\s*"\$\{local\.server_release_id\}@[a-f0-9]{16}"/);
    assert.doesNotMatch(userData, /control_secret_value|runtime_secret_value/);
    assert.match(staging, /control_secret_parameter_name/);
    assert.match(variables, /alpha-control-secret/);
    assert.match(iam, /var\.control_secret_parameter_name/);
    const albSecurityGroup = iam.slice(iam.indexOf('resource "aws_security_group" "alb"'), iam.indexOf("\nresource ", iam.indexOf('resource "aws_security_group" "alb"') + 1));
    assert.match(albSecurityGroup, /lifecycle\s*\{\s*create_before_destroy\s*=\s*true/);
    assert.doesNotMatch(albSecurityGroup, /prefix_list_ids/);
    assert.match(albSecurityGroup, /from_port\s*=\s*443[\s\S]*?cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/);
    assert.match(albSecurityGroup, /from_port\s*=\s*80[\s\S]*?cidr_blocks\s*=\s*\["0\.0\.0\.0\/0"\]/);
    assert.match(example, /control_secret_parameter_name = "\/successor\/staging\/alpha-control-secret"/);
  });

  it("installs runtime and retention env into maintenance units", async () => {
    const backup = await read("ops/deploy/systemd/successor-backup.service");
    const metrics = await read("ops/deploy/systemd/successor-metrics.service");
    const cleanup = await read("ops/deploy/systemd/successor-cleanup.service");
    for (const unit of [backup, metrics, cleanup]) {
      assert.match(unit, /EnvironmentFile=-\/etc\/successor\/runtime\.env/);
      assert.match(unit, /EnvironmentFile=-\/etc\/successor\/backup-retention\.env/);
    }
  });
});
