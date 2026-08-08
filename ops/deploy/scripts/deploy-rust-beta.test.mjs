import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteAllowlistCommand,
  instanceIdFromDescribeResponse,
  parseArgs,
  parseAwsEnv,
  publisherArgs,
  releaseIdentity,
} from "./deploy-rust-beta.mjs";

test("requires one explicit mode and keeps production-safe defaults", () => {
  const args = parseArgs(["--dry-run"], {});
  assert.equal(args.dryRun, true);
  assert.equal(args.apply, false);
  assert.equal(args.site, false);
  assert.equal(args.skipGates, false);
  assert.equal(args.instanceName, "successor-staging-1");
  assert.equal(args.region, "us-east-1");
  assert.throws(() => parseArgs([], {}), /choose exactly one/);
  assert.throws(() => parseArgs(["--apply", "--dry-run"], {}), /choose exactly one/);
});

test("parses the complete apply shape without evaluating credential files", () => {
  const args = parseArgs([
    "--apply",
    "--site",
    "--aws-env", "~/successor-access/aws.env",
    "--instance-id", "i-0123456789abcdef0",
    "--region", "us-west-2",
    "--server-release-id", "planetfall-v5",
    "--skip-gates",
  ], {});
  assert.equal(args.apply, true);
  assert.equal(args.site, true);
  assert.equal(args.awsEnv, "~/successor-access/aws.env");
  assert.equal(args.instanceId, "i-0123456789abcdef0");
  assert.equal(args.region, "us-west-2");
  assert.equal(args.serverReleaseId, "planetfall-v5");
  assert.equal(args.skipGates, true);
  assert.throws(() => parseArgs(["--apply"], {}), /requires --aws-env/);
});

test("loads only inert AWS credential assignments", () => {
  assert.deepEqual(parseAwsEnv([
    "# generated access",
    "AWS_ACCESS_KEY_ID=AKIAEXAMPLE",
    "AWS_SECRET_ACCESS_KEY='secret-value'",
    "AWS_REGION=us-east-1",
    "",
  ].join("\n")), {
    AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
    AWS_SECRET_ACCESS_KEY: "secret-value",
    AWS_REGION: "us-east-1",
  });
  assert.throws(() => parseAwsEnv("export AWS_ACCESS_KEY_ID=bad"), /invalid AWS env line/);
  assert.throws(() => parseAwsEnv("PATH=/tmp/bin"), /unsupported AWS env key/);
  assert.throws(() => parseAwsEnv("AWS_ACCESS_KEY_ID=$(echo bad)\nNOT_A_LINE"), /invalid AWS env line/);
});

test("derives the beta identity from the exact source commit", () => {
  const commit = "2d9f1e14467efcf526712ee54aa4840911d433aa";
  assert.deepEqual(releaseIdentity(commit), {
    sourceCommit: commit,
    prefix: "2d9f1e14467efcf5",
    clientReleaseId: "successor-rust-beta@2d9f1e14467efcf5",
  });
  assert.throws(() => releaseIdentity("2d9f1e1"), /40-character/);
});

test("builds one idempotent allowlist-and-restart command from a safe id", () => {
  const releaseId = "successor-rust-beta@2d9f1e14467efcf5";
  const command = buildRemoteAllowlistCommand(releaseId);
  assert.match(command, new RegExp(releaseId));
  assert.match(command, /grep -q/);
  assert.match(command, /sed -i/);
  assert.match(command, /systemctl restart successor\.service/);
  assert.match(command, /systemctl is-active successor\.service/);
  assert.throws(
    () => buildRemoteAllowlistCommand("successor-rust-beta@ok; sudo reboot"),
    /unsafe beta release id/,
  );
});

test("keeps dry-run publication offline and adds the real bucket only for apply", () => {
  const paths = { betaPublish: "tmp/beta-publish" };
  const dryRun = publisherArgs(paths, "--dry-run");
  assert.equal(dryRun.includes("--bucket"), false);
  assert.equal(dryRun.at(-1), "--dry-run");
  const apply = publisherArgs(paths, "--apply");
  assert.deepEqual(
    apply.slice(apply.indexOf("--bucket"), apply.indexOf("--bucket") + 2),
    ["--bucket", "s3://successor-assets-5a537a77"],
  );
  assert.equal(apply.at(-1), "--apply");
});

test("accepts exactly one running authority instance", () => {
  assert.equal(instanceIdFromDescribeResponse({
    Reservations: [{ Instances: [{ InstanceId: "i-0123456789abcdef0" }] }],
  }), "i-0123456789abcdef0");
  assert.throws(() => instanceIdFromDescribeResponse({ Reservations: [] }), /found 0/);
  assert.throws(() => instanceIdFromDescribeResponse({
    Reservations: [{ Instances: [
      { InstanceId: "i-0123456789abcdef0" },
      { InstanceId: "i-0fedcba9876543210" },
    ] }],
  }), /found 2/);
});
