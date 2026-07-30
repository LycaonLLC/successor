import test from "node:test";
import assert from "node:assert/strict";
import { buildPromotion } from "./promote-client-runtime.mjs";

const hash = "a".repeat(64);
const commit = "b".repeat(40);
const good = { launchPage: `https://cdn.example.test/releases/${hash}/index.html`, entryScript: "https://cdn.example.test/releases/hash/chunks/app.js", manifestSha256: hash, cdnOrigin: "https://cdn.example.test", storeOrigin: "https://store.example.test", releaseId: "asset-1" };

test("builds strict storefront pointer", () => {
  assert.deepEqual(buildPromotion(good, commit, "successor-alpha@a2d02071e180f9df"), { schema: "successor.client-runtime-pointer.v1", entry: good.launchPage, manifestSha256: hash, sourceCommit: commit, clientReleaseId: "successor-alpha@a2d02071e180f9df" });
});
test("rejects raw mismatch and unsafe entries", () => {
  for (const pointer of [{ ...good, entry: good.launchPage }, { ...good, launchPage: `https://evil.example/releases/${hash}/index.html` }, { ...good, launchPage: `${good.launchPage}?x=1` }, { ...good, launchPage: `https://cdn.example.test/releases/${hash}/app.js` }, { ...good, manifestSha256: "nope" }]) assert.throws(() => buildPromotion(pointer, commit, "client-1"));
});
test("rejects bad commit and release", () => {
  assert.throws(() => buildPromotion(good, commit, "successor-alpha@bad@extra"));
  assert.throws(() => buildPromotion(good, commit, "bad release!"));
});
