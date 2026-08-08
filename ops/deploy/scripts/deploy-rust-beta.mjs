#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_BETA_POINTER = "https://www.successorgame.com/beta/release.json";
const DEFAULT_SITE_ORIGIN = "https://www.successorgame.com";
const DEFAULT_WORLD_ORIGIN = "https://world.successorgame.com";
const DEFAULT_ASSET_ORIGIN = "https://d2kf3ri6r74a0m.cloudfront.net";
const DEFAULT_ASSET_BUCKET = "successor-assets-5a537a77";
const DEFAULT_SITE_BUCKET = "successor-site-5a537a77";
const DEFAULT_INSTANCE_NAME = "successor-staging-1";
const DEFAULT_REGION = "us-east-1";
const ALLOWED_AWS_ENV = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
]);

export function parseArgs(argv, environment = process.env) {
  const args = {
    apply: false,
    dryRun: false,
    site: false,
    skipGates: false,
    awsEnv: "",
    instanceId: "",
    instanceName: DEFAULT_INSTANCE_NAME,
    region: DEFAULT_REGION,
    serverReleaseId: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--site") args.site = true;
    else if (arg === "--skip-gates") args.skipGates = true;
    else if (["--aws-env", "--instance-id", "--instance-name", "--region", "--server-release-id"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      const key = {
        "--aws-env": "awsEnv",
        "--instance-id": "instanceId",
        "--instance-name": "instanceName",
        "--region": "region",
        "--server-release-id": "serverReleaseId",
      }[arg];
      args[key] = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.apply === args.dryRun) throw new Error("choose exactly one of --dry-run or --apply");
  if (args.apply && !args.awsEnv && !environment.AWS_PROFILE && !environment.AWS_ACCESS_KEY_ID) {
    throw new Error("--apply requires --aws-env or existing AWS credentials in the environment");
  }
  if (args.instanceId && !/^i-[0-9a-f]{8,32}$/u.test(args.instanceId)) throw new Error("--instance-id is invalid");
  if (!/^[A-Za-z0-9._-]{2,128}$/u.test(args.instanceName)) throw new Error("--instance-name is invalid");
  if (!/^[a-z]{2}-[a-z]+-\d$/u.test(args.region)) throw new Error("--region is invalid");
  if (args.serverReleaseId && !isSafeReleaseValue(args.serverReleaseId)) throw new Error("--server-release-id is invalid");
  return args;
}

function expandHome(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function parseAwsEnv(source) {
  const env = {};
  for (const [lineIndex, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) throw new Error(`invalid AWS env line ${lineIndex + 1}`);
    const [, key, rawValue] = match;
    if (!ALLOWED_AWS_ENV.has(key)) throw new Error(`unsupported AWS env key ${key}`);
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value || /[\r\n\0]/u.test(value)) throw new Error(`invalid AWS env value for ${key}`);
    env[key] = value;
  }
  return env;
}

function isSafeReleaseValue(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9@._-]{1,255}$/u.test(value);
}

export function releaseIdentity(commit) {
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error("source commit must be a 40-character lowercase SHA");
  const prefix = commit.slice(0, 16);
  return {
    sourceCommit: commit,
    prefix,
    clientReleaseId: `successor-rust-beta@${prefix}`,
  };
}

export function buildRemoteAllowlistCommand(clientReleaseId) {
  if (!/^successor-rust-beta@[0-9a-f]{16}$/u.test(clientReleaseId)) throw new Error("unsafe beta release id");
  return [
    "set -e",
    `NEW=${clientReleaseId}`,
    "FILE=/etc/successor/runtime.env",
    'if sudo grep -q "^SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST=.*${NEW}" "$FILE"',
    'then echo "allowlist already contains ${NEW}"',
    'else sudo sed -i "/^SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST=/ s/\\$/,${NEW}/" "$FILE" && echo "appended ${NEW}"',
    "fi",
    'sudo grep ^SUCCESSOR_ALPHA_CLIENT_RELEASE_ALLOWLIST "$FILE"',
    "sudo systemctl restart successor.service",
    "sleep 10",
    "systemctl is-active successor.service",
  ].join("; ");
}

export function instanceIdFromDescribeResponse(value) {
  const ids = value?.Reservations?.flatMap((reservation) => reservation.Instances ?? []).map((instance) => instance.InstanceId) ?? [];
  if (ids.length !== 1 || !/^i-[0-9a-f]{8,32}$/u.test(ids[0])) {
    throw new Error(`expected exactly one running authority instance, found ${ids.length}`);
  }
  return ids[0];
}

function run(program, args, { env = process.env, capture = false } = {}) {
  const result = spawnSync(program, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `: ${(result.stderr || result.stdout || "").trim()}` : "";
    throw new Error(`${program} ${args.join(" ")} exited ${result.status}${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

async function fetchJson(url, label) {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return response.json();
}

async function waitForAuthority() {
  let last = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const [health, ready] = await Promise.all([
        fetch(`${DEFAULT_WORLD_ORIGIN}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(5_000) }),
        fetchJson(`${DEFAULT_WORLD_ORIGIN}/readyz`, "authority readiness"),
      ]);
      if (health.ok && ready.ready === true && Object.values(ready.checks ?? {}).every((value) => value === true)) return;
      last = `health=${health.status} ready=${String(ready.ready)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`authority did not recover: ${last}`);
}

async function assertCleanAndPushed(args) {
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], { capture: true });
  if (status) throw new Error("deployment requires a clean source tree");
  const commit = run("git", ["rev-parse", "HEAD"], { capture: true });
  const branch = run("git", ["branch", "--show-current"], { capture: true });
  if (!branch) throw new Error("deployment requires a named branch");
  const remote = run("git", ["ls-remote", "origin", `refs/heads/${branch}`], { capture: true }).split(/\s+/u)[0];
  if (remote !== commit) throw new Error(`origin/${branch} does not match HEAD`);
  return commit;
}

function deployPaths(prefix) {
  const root = join(ROOT, "tmp", `rust-beta-deploy-${prefix}`);
  return {
    root,
    betaPublish: join(root, "beta-publish"),
    betaPromotion: join(root, "beta-promotion"),
    sitePublish: join(root, "site-publish"),
    sitePromotion: join(root, "site-promotion"),
    ssmParameters: join(root, "ssm-parameters.json"),
  };
}

export function publisherArgs(paths, mode) {
  const args = [
    "ops/deploy/scripts/publish-client-assets.mjs",
    "--dist", "client-rust/out/web-release",
    "--object-store",
    "--cdn-origin", DEFAULT_ASSET_ORIGIN,
    "--store-origin", DEFAULT_SITE_ORIGIN,
    "--output-dir", paths.betaPublish,
  ];
  if (mode === "--apply") args.push("--bucket", `s3://${DEFAULT_ASSET_BUCKET}`);
  args.push(mode);
  return args;
}

function betaPromotionArgs(paths, identity, serverReleaseId, mode) {
  return [
    "ops/deploy/scripts/promote-client-runtime.mjs",
    "--pointer", join(paths.betaPublish, "current.json"),
    "--source-commit", identity.sourceCommit,
    "--client-release-id", identity.clientReleaseId,
    "--channel", "beta",
    "--server-release-id", serverReleaseId,
    "--destination", "site/current/beta/release.json",
    "--site-bucket", DEFAULT_SITE_BUCKET,
    "--output-dir", paths.betaPromotion,
    mode,
  ];
}

async function discoverInstanceId(args, env) {
  if (args.instanceId) return args.instanceId;
  const response = JSON.parse(run("aws", [
    "ec2", "describe-instances",
    "--region", args.region,
    "--filters",
    `Name=tag:Name,Values=${args.instanceName}`,
    "Name=instance-state-name,Values=running",
    "--output", "json",
  ], { env, capture: true }));
  return instanceIdFromDescribeResponse(response);
}

async function verifyPromotion(identity, manifestSha256, siteIdentity) {
  let last = "no response";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const pointer = await fetchJson(`${DEFAULT_BETA_POINTER}?verify=${Date.now()}`, "public beta pointer");
      if (
        pointer.sourceCommit === identity.sourceCommit
        && pointer.clientReleaseId === identity.clientReleaseId
        && pointer.manifestSha256 === manifestSha256
      ) {
        const entry = await fetch(pointer.entry, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
        if (!entry.ok) throw new Error(`immutable beta entry returned HTTP ${entry.status}`);
        if (siteIdentity) {
          const betaPage = await fetch(`${DEFAULT_SITE_ORIGIN}/beta/?verify=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
          if (!betaPage.ok) throw new Error(`public beta shell returned HTTP ${betaPage.status}`);
        }
        return;
      }
      last = "pointer still names the previous release";
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
  }
  throw new Error(`public beta verification timed out: ${last}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceCommit = await assertCleanAndPushed(args);
  const identity = releaseIdentity(sourceCommit);
  const paths = deployPaths(identity.prefix);
  await mkdir(paths.root, { recursive: true });

  const awsEnv = args.awsEnv
    ? { ...process.env, ...parseAwsEnv(await readFile(resolve(expandHome(args.awsEnv)), "utf8")) }
    : process.env;
  if (args.apply) run("aws", ["sts", "get-caller-identity", "--output", "json"], { env: awsEnv });
  const livePointer = await fetchJson(DEFAULT_BETA_POINTER, "live beta pointer");
  const serverReleaseId = args.serverReleaseId || livePointer.serverReleaseId;
  if (!isSafeReleaseValue(serverReleaseId)) throw new Error("live beta pointer has no safe server release id");

  if (!args.skipGates) {
    for (const target of ["verify", "check-allocs", "runtime-check", "render-check", "terrain-check", "nostd"]) {
      run("make", ["-C", "client-rust", target]);
    }
    if (args.site) run("pnpm", ["site:test"]);
  }
  if (args.site) run("pnpm", ["site:build"]);

  run("make", [
    "-C", "client-rust", "web-release",
    `SOURCE_COMMIT=${identity.sourceCommit}`,
    `CLIENT_RELEASE_ID=${identity.clientReleaseId}`,
    `SERVER_RELEASE_ID=${serverReleaseId}`,
    `STOREFRONT_ORIGIN=${DEFAULT_SITE_ORIGIN}`,
    `GAME_ORIGIN=wss://world.successorgame.com`,
    `CHAT_ORIGIN=wss://world.successorgame.com`,
  ]);
  run("node", publisherArgs(paths, "--dry-run"));
  run("node", betaPromotionArgs(paths, identity, serverReleaseId, "--dry-run"));

  let siteIdentity = null;
  if (args.site) {
    const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const siteReleaseId = `site-${identity.sourceCommit.slice(0, 7)}-${date}`;
    run("node", [
      "ops/deploy/scripts/publish-site.mjs",
      "--dist", "site/dist",
      "--output-dir", paths.sitePublish,
      "--site-release-id", siteReleaseId,
      "--dry-run",
    ]);
    const siteManifest = JSON.parse(await readFile(join(paths.sitePublish, "site-manifest.json"), "utf8"));
    siteIdentity = { siteReleaseId, manifestSha256: siteManifest.manifest_sha256 };
    run("node", [
      "ops/deploy/scripts/promote-site.mjs",
      "--manifest", join(paths.sitePublish, "site-manifest.json"),
      "--bucket", `s3://${DEFAULT_SITE_BUCKET}`,
      "--dist", "site/dist",
      "--expected-manifest-sha256", siteIdentity.manifestSha256,
      "--output-dir", paths.sitePromotion,
      "--dry-run",
    ]);
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ mode: "dry-run", ...identity, serverReleaseId, site: siteIdentity, evidenceDir: paths.root }, null, 2));
    return;
  }

  // AWS identity was verified before running gates and builds.
  run("node", publisherArgs(paths, "--apply"), { env: awsEnv });
  const publishedPointer = JSON.parse(await readFile(join(paths.betaPublish, "current.json"), "utf8"));

  if (args.site) {
    run("node", [
      "ops/deploy/scripts/publish-site.mjs",
      "--dist", "site/dist",
      "--output-dir", paths.sitePublish,
      "--site-release-id", siteIdentity.siteReleaseId,
      "--bucket", `s3://${DEFAULT_SITE_BUCKET}`,
      "--apply",
    ], { env: awsEnv });
  }

  const status = await fetchJson(`${DEFAULT_WORLD_ORIGIN}/game/status`, "authority status");
  if (status.sessionCount !== 0) throw new Error(`refusing authority restart with ${status.sessionCount} live session(s)`);
  const instanceId = await discoverInstanceId(args, awsEnv);
  await writeFile(paths.ssmParameters, `${JSON.stringify({ command: [buildRemoteAllowlistCommand(identity.clientReleaseId)] })}\n`, { mode: 0o600 });
  run("aws", [
    "ssm", "start-session",
    "--target", instanceId,
    "--region", args.region,
    "--document-name", "AWS-StartInteractiveCommand",
    "--parameters", `file://${paths.ssmParameters}`,
  ], { env: awsEnv });
  await waitForAuthority();

  if (args.site) {
    run("node", [
      "ops/deploy/scripts/promote-site.mjs",
      "--manifest", join(paths.sitePublish, "site-manifest.json"),
      "--bucket", `s3://${DEFAULT_SITE_BUCKET}`,
      "--dist", "site/dist",
      "--expected-manifest-sha256", siteIdentity.manifestSha256,
      "--output-dir", paths.sitePromotion,
      "--apply",
    ], { env: awsEnv });
    const authenticatedSitePointer = JSON.parse(run("aws", [
      "s3", "cp", `s3://${DEFAULT_SITE_BUCKET}/site/current.json`, "-", "--no-progress",
    ], { env: awsEnv, capture: true }));
    if (
      authenticatedSitePointer.site_release_id !== siteIdentity.siteReleaseId
      || authenticatedSitePointer.manifest_sha256 !== siteIdentity.manifestSha256
    ) {
      throw new Error("authenticated site pointer does not match the promoted release");
    }
  }
  run("node", betaPromotionArgs(paths, identity, serverReleaseId, "--apply"), { env: awsEnv });
  await verifyPromotion(identity, publishedPointer.manifestSha256, siteIdentity);

  console.log(JSON.stringify({
    mode: "apply",
    ...identity,
    serverReleaseId,
    manifestSha256: publishedPointer.manifestSha256,
    instanceId,
    site: siteIdentity,
    evidenceDir: paths.root,
  }, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`deploy-rust-beta: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
