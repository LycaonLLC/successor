#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const display = process.env.DISPLAY;
if (!display) throw new Error("packaged desktop smoke requires an isolated xvfb DISPLAY");
const packageRoot = path.join(root, "desktop", "release");
const entries = await fs.readdir(packageRoot).catch(() => []);
const recordName = entries.find((name) => name.endsWith(".json"));
if (!recordName) throw new Error("packaged desktop artifact record is missing; run the desktop packaging build first");
const record = JSON.parse(await fs.readFile(path.join(packageRoot, recordName), "utf8"));
if (record.requirements?.publishable !== false || !String(record.requirements?.distribution ?? "").includes("Not publishable")) throw new Error("packaged smoke must remain explicitly non-live and non-publishable");
console.log(JSON.stringify({ schema: "successor.desktop-packaged-fake-runtime-smoke.v1", status: "pass", display, package: recordName, nonLive: true, proof: "packaging/runtime smoke only; no hosted login, publication, or shared-world claim" }));
