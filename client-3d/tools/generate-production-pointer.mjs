#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..");
export const DEFAULT_DIST_DIR = path.join(packageDir, "dist");
export const DEFAULT_STOREFRONT_ORIGIN = "https://www.successorgame.com";

function fail(message) { throw new Error(`production pointer: ${message}`); }

function assetOrigin(value = process.env.SUCCESSOR_PUBLIC_ASSET_ORIGIN) {
  const raw = value?.trim() || "http://127.0.0.1:5179";
  let parsed;
  try { parsed = new URL(raw); } catch { fail(`SUCCESSOR_PUBLIC_ASSET_ORIGIN must be an absolute URL: ${raw}`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") fail("asset origin must use http or https");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) fail("asset origin must not contain credentials, query, or hash");
  if (parsed.pathname !== "/") fail("asset origin must be an origin root ending in /");
  if (process.env.NODE_ENV === "production" && parsed.protocol !== "https:") fail("production asset origin must use https");
  return parsed.toString();
}

function storefrontOrigin(
  value = process.env.SUCCESSOR_STOREFRONT_ORIGIN,
  packageMode = process.env.SUCCESSOR_PACKAGE_MODE,
) {
  const raw = value?.trim() || (packageMode === "hosted-release" ? "" : DEFAULT_STOREFRONT_ORIGIN);
  if (!raw) fail("SUCCESSOR_STOREFRONT_ORIGIN is required");
  let parsed;
  try { parsed = new URL(raw); } catch { fail(`SUCCESSOR_STOREFRONT_ORIGIN must be an absolute URL: ${raw}`); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    fail("SUCCESSOR_STOREFRONT_ORIGIN must be one exact https origin");
  }
  return parsed.origin;
}

function findAssets(index) {
  const scripts = [...index.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["'][^>]*>/giu)].map((m) => m[1]);
  const styles = [...index.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)["'][^>]*>/giu)].map((m) => m[1]);
  if (scripts.length !== 1 || !scripts[0]) fail("index.html must contain exactly one module entry script");
  if (!styles.length || styles.some((style) => !style)) fail("index.html must contain stylesheet targets");
  return { entryScript: scripts[0], styles };
}

function relativeTarget(distDir, target) {
  const parsed = new URL(target, "http://pointer.invalid");
  if (parsed.origin !== "http://pointer.invalid" || !parsed.pathname.startsWith("/")) fail(`invalid build asset URL: ${target}`);
  const absolute = path.resolve(distDir, parsed.pathname.slice(1));
  const rel = path.relative(distDir, absolute);
  if (rel.startsWith("..") || path.isAbsolute(rel)) fail(`build asset escapes dist: ${target}`);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`missing pointer target: ${target}`);
  return parsed.pathname.slice(1);
}

export function writeProductionPointer({
  distDir = DEFAULT_DIST_DIR,
  publicAssetOrigin,
  configuredStorefrontOrigin,
  packageMode,
} = {}) {
  const dist = path.resolve(distDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "production-asset-manifest.json"), "utf8"));
  if (typeof manifest.releaseId !== "string" || typeof manifest.contentHash !== "string") fail("production manifest identity is missing");
  const assets = findAssets(fs.readFileSync(path.join(dist, "index.html"), "utf8"));
  const base = assetOrigin(publicAssetOrigin);
  const entryRelative = relativeTarget(dist, assets.entryScript);
  const styleRelative = assets.styles.map((style) => relativeTarget(dist, style));
  const pointer = {
    releaseId: manifest.releaseId,
    launchPage: new URL("index.html", base).toString(),
    entryScript: new URL(entryRelative, base).toString(),
    styles: styleRelative.map((style) => new URL(style, base).toString()),
    assetBaseUrl: base,
    storeOrigin: storefrontOrigin(configuredStorefrontOrigin, packageMode),
  };
  fs.writeFileSync(path.join(dist, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  return pointer;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(writeProductionPointer({
  publicAssetOrigin: process.env.SUCCESSOR_PUBLIC_ASSET_ORIGIN,
  configuredStorefrontOrigin: process.env.SUCCESSOR_STOREFRONT_ORIGIN,
  packageMode: process.env.SUCCESSOR_PACKAGE_MODE,
}), null, 2));
