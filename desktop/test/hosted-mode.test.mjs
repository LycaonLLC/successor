import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_MODE_HOSTED,
  DESKTOP_MODE_OFFLINE,
  resolveDesktopMode,
  resolveHostedConfig,
  shouldStartLocalShard,
} from "../src/hosted-mode.mjs";

function envOf(values) {
  return (name) => values[name];
}

test("desktop mode defaults to hosted and only offline is accepted as the explicit legacy flag", () => {
  assert.equal(resolveDesktopMode(envOf({})), DESKTOP_MODE_HOSTED);
  assert.equal(resolveDesktopMode(envOf({ MODE: "" })), DESKTOP_MODE_HOSTED);
  assert.equal(resolveDesktopMode(envOf({ MODE: "hosted" })), DESKTOP_MODE_HOSTED);
  assert.equal(resolveDesktopMode(envOf({ MODE: "offline" })), DESKTOP_MODE_OFFLINE);
  assert.throws(() => resolveDesktopMode(envOf({ MODE: "solo" })), /must be "hosted" or "offline"/);
  assert.throws(() => resolveDesktopMode(envOf({ MODE: "OFFLINE" })), /must be "hosted" or "offline"/);
});

test("only the explicit offline mode may start the bundled local shard", () => {
  assert.equal(shouldStartLocalShard(DESKTOP_MODE_HOSTED), false);
  assert.equal(shouldStartLocalShard(DESKTOP_MODE_OFFLINE), true);
});

test("hosted config defaults to the production origin with the fixed approval page", () => {
  const config = resolveHostedConfig(envOf({}));
  assert.equal(config.apiOrigin, "https://www.successorgame.com");
  assert.equal(config.connectUrl, "https://www.successorgame.com/connect");
  assert.equal(config.clientId, "successor-desktop");
  assert.deepEqual([...config.scopes], ["character:list", "play-ticket"]);
  assert.equal(config.releaseId, "successor-alpha");
});

test("hosted config refuses plain http except loopback harnesses", () => {
  assert.equal(resolveHostedConfig(envOf({ API_ORIGIN: "http://127.0.0.1:8443" })).apiOrigin, "http://127.0.0.1:8443");
  assert.equal(resolveHostedConfig(envOf({ API_ORIGIN: "http://localhost:9000" })).apiOrigin, "http://localhost:9000");
  assert.throws(() => resolveHostedConfig(envOf({ API_ORIGIN: "http://successorgame.com" })), /must use https/);
  assert.throws(() => resolveHostedConfig(envOf({ API_ORIGIN: "not a url" })), /absolute http\(s\) origin/);
  assert.throws(() => resolveHostedConfig(envOf({ API_ORIGIN: "https://www.successorgame.com/alpha-api" })), /bare origin/);
  assert.throws(() => resolveHostedConfig(envOf({ API_ORIGIN: "https://user:pw@www.successorgame.com" })), /bare origin/);
});

test("hosted config honors a release id override", () => {
  const config = resolveHostedConfig(envOf({ RELEASE_ID: "successor-alpha-rc9" }));
  assert.equal(config.releaseId, "successor-alpha-rc9");
});

test("hosted config uses the release identity baked into a packaged client", () => {
  const packaged = "successor-alpha@731b87bb5ce5ea4c";
  assert.equal(resolveHostedConfig(envOf({}), packaged).releaseId, packaged);
  assert.equal(resolveHostedConfig(envOf({ RELEASE_ID: "successor-alpha-override" }), packaged).releaseId, "successor-alpha-override");
  assert.throws(() => resolveHostedConfig(envOf({}), "successor alpha"), /release id is invalid/u);
});
