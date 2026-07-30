import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const fixtureScript = path.join(repoRoot, "tools/successor/configure-open-desert-fixture.mjs");
const mappingPath = path.join(repoRoot, "client-3d/src/render/props-mapping.json");
const publicRoot = path.join(repoRoot, "client-3d/public");
const waveRoot = path.join(
  publicRoot,
  "assets/wave-props/everyday-wave-20260719/everyday-world-props",
);
const committedSlicePath = path.join(repoRoot, "client/public/successor-slice/open-desert-slice.json");
const committedBundlePath = path.join(repoRoot, "client/public/successor-slice/open-desert-map-bundle.json");
const committedBundleSourcePath = "client/public/successor-slice/open-desert-slice.json";

const OCCUPATION_PREFIX = "dustgate-occupation-";
const SUPPORTED_INTERACTIVE_KINDS = new Set([
  "bank_terminal",
  "trade_terminal",
  "pa_terminal",
  "clone_terminal",
  "clone_pod",
  "travel_terminal",
  "storage_chest",
  "factory",
]);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function occupationProps(slice) {
  return slice.props.filter((prop) => prop.id.startsWith(OCCUPATION_PREFIX));
}

function footprint(prop) {
  return {
    x0: prop.cell.x,
    y0: prop.cell.y,
    x1: prop.cell.x + prop.size.w,
    y1: prop.cell.y + prop.size.h,
  };
}

function overlaps(a, b) {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function clearanceRects(slice) {
  const player = slice.actors.find((actor) => actor.id === "player");
  const grok = slice.actors.find((actor) => actor.id === "grok");
  const knox = slice.actors.find((actor) => actor.id === "camp-trainer");
  const byId = Object.fromEntries(slice.props.map((prop) => [prop.id, prop]));
  const rects = [];
  const addProp = (id, pad = 1) => {
    const prop = byId[id];
    assert.ok(prop, `missing clearance prop ${id}`);
    rects.push({
      id,
      rect: {
        x0: prop.cell.x - pad,
        y0: prop.cell.y - pad,
        x1: prop.cell.x + prop.size.w + pad,
        y1: prop.cell.y + prop.size.h + pad,
      },
    });
  };
  const addActor = (id, actor, pad = 1) => {
    assert.ok(actor, `missing actor ${id}`);
    rects.push({
      id,
      rect: {
        x0: actor.cell.x - pad,
        y0: actor.cell.y - pad,
        x1: actor.cell.x + 1 + pad,
        y1: actor.cell.y + 1 + pad,
      },
    });
  };
  addActor("player-spawn", player, 2);
  addActor("grok", grok, 1);
  addActor("knox", knox, 1);
  for (const id of [
    "dustgate-bank-terminal",
    "dustgate-trade-terminal",
    "dustgate-pa-terminal",
    "dustgate-clone-terminal",
    "dustgate-clone-pod",
    "travel-terminal-dustgate",
  ]) {
    addProp(id, id === "travel-terminal-dustgate" ? 2 : 1);
  }
  for (const id of [
    "dustgate-commerce-facility",
    "dustgate-cloning-facility",
    "open-desert-shelter-house",
  ]) {
    addProp(id, 1);
  }
  const commerce = byId["dustgate-commerce-facility"];
  const facility = byId["dustgate-cloning-facility"];
  rects.push({
    id: "commerce-door-mouth",
    rect: {
      x0: commerce.cell.x + 4,
      y0: commerce.cell.y + commerce.size.h,
      x1: commerce.cell.x + 8,
      y1: commerce.cell.y + commerce.size.h + 3,
    },
  });
  rects.push({
    id: "clone-door-mouth",
    rect: {
      x0: facility.cell.x + 3,
      y0: facility.cell.y + facility.size.h,
      x1: facility.cell.x + 7,
      y1: facility.cell.y + facility.size.h + 3,
    },
  });
  rects.push({
    id: "plaza-lane",
    rect: {
      x0: 511,
      y0: 500,
      x1: 514,
      y1: 515,
    },
  });
  return rects;
}

/** Resolve a props-mapping absolute public path under client-3d/public. */
function resolveMappedPublicGlb(glbPath) {
  assert.equal(glbPath.startsWith("/"), true, `mapped glb must be absolute public path: ${glbPath}`);
  const abs = path.resolve(publicRoot, glbPath.slice(1));
  assert.equal(abs.startsWith(`${publicRoot}${path.sep}`), true, `mapped glb escaped public root: ${glbPath}`);
  return abs;
}

/**
 * Map-bundle source.path records the slice path passed to the compiler. Temp
 * regeneration outside the repo writes an absolute out path there; world content
 * (hash/stateHash/areas) stays deterministic. Normalize only that provenance
 * field before byte compare.
 */
function normalizeMapBundleText(bundleText, sourcePath = committedBundleSourcePath) {
  const bundle = JSON.parse(bundleText);
  assert.equal(typeof bundle?.source?.path, "string");
  bundle.source.path = sourcePath;
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

describe("dustgate occupation pack", () => {
  const slice = loadJson(committedSlicePath);
  const mapping = loadJson(mappingPath);
  const pack = occupationProps(slice);

  test("places a stable 10-16 prop occupation set with fixed ids", () => {
    assert.ok(pack.length >= 10 && pack.length <= 16, `expected 10-16 occupation props, got ${pack.length}`);
    const ids = pack.map((prop) => prop.id).sort();
    assert.equal(new Set(ids).size, ids.length, "occupation ids must be unique");
    assert.deepEqual(
      ids,
      [
        "dustgate-occupation-brick-stack",
        "dustgate-occupation-bucket",
        "dustgate-occupation-burlap-sack",
        "dustgate-occupation-cement-bag",
        "dustgate-occupation-crate-open",
        "dustgate-occupation-lumber",
        "dustgate-occupation-pallet",
        "dustgate-occupation-paper-bags",
        "dustgate-occupation-price-sign",
        "dustgate-occupation-sawhorses",
        "dustgate-occupation-street-lamp",
        "dustgate-occupation-vendor-awning",
        "dustgate-occupation-wheelbarrow",
        "dustgate-occupation-wicker-display",
        "dustgate-occupation-workbench",
      ],
    );
  });

  test("maps every occupation assetKey to an already-public everyday GLB", () => {
    for (const prop of pack) {
      const entry = mapping.entries[prop.assetKey];
      assert.ok(entry, `missing props-mapping entry for ${prop.assetKey}`);
      if (prop.id === "dustgate-occupation-workbench") {
        assert.equal(entry.interactable, true, `${prop.assetKey} factory mapping must be interactable`);
      } else {
        assert.equal(entry.interactable, undefined, `${prop.assetKey} must not gain interactable mapping`);
      }
      assert.ok(
        typeof entry.glb === "string" && entry.glb.startsWith("/assets/wave-props/"),
        `${prop.assetKey} must use absolute wave-props path`,
      );
      const abs = resolveMappedPublicGlb(entry.glb);
      assert.ok(fs.existsSync(abs), `missing runtime GLB for ${prop.assetKey}: ${entry.glb} -> ${abs}`);
      assert.match(path.basename(entry.glb), /^successor_everyday_.*\.glb$/);
      assert.equal(
        abs.startsWith(`${waveRoot}${path.sep}`) || abs === waveRoot,
        true,
        `${prop.assetKey} must resolve under everyday-world-props (${abs})`,
      );
    }
  });

  test("keeps occupation props inside Dustgate placement bounds with factory workbench only interactive", () => {
    for (const prop of pack) {
      assert.equal(prop.areaId, "open-desert-overworld");
      const isFactory = prop.id === "dustgate-occupation-workbench";
      assert.equal(prop.kind, isFactory ? "factory" : "prop");
      assert.equal(prop.interactive, isFactory);
      assert.equal(prop.solid, false);
      assert.equal(prop.collisionBounds, undefined);
      assert.ok(prop.cell.x >= 490 && prop.cell.x + prop.size.w <= 520, `${prop.id} x bounds`);
      assert.ok(prop.cell.y >= 500 && prop.cell.y + prop.size.h <= 520, `${prop.id} y bounds`);
      assert.ok(prop.size.w >= 1 && prop.size.h >= 1);
    }
    assert.ok(pack.every((prop) => Math.hypot(prop.cell.x - 512, prop.cell.y - 512) <= 22));
  });

  test("avoids clearance overlap with doors, terminals, actors, and self", () => {
    const zones = clearanceRects(slice);
    for (const prop of pack) {
      const rect = footprint(prop);
      for (const zone of zones) {
        assert.equal(overlaps(rect, zone.rect), false, `${prop.id} overlaps ${zone.id}`);
      }
    }
    for (let i = 0; i < pack.length; i += 1) {
      for (let j = i + 1; j < pack.length; j += 1) {
        assert.equal(
          overlaps(footprint(pack[i]), footprint(pack[j])),
          false,
          `${pack[i].id} overlaps ${pack[j].id}`,
        );
      }
    }
  });

  test("introduces no unsupported interaction verbs on occupation props", () => {
    for (const prop of pack) {
      const isFactory = prop.id === "dustgate-occupation-workbench";
      assert.equal(prop.interactive, isFactory);
      assert.equal(prop.kind, isFactory ? "factory" : "prop");
      assert.equal(prop.container, undefined);
      assert.equal(prop.takeOnly, undefined);
      assert.equal(prop.door, undefined);
      assert.equal(prop.enterable, undefined);
    }
    for (const prop of slice.props) {
      if (!prop.interactive) continue;
      assert.ok(
        SUPPORTED_INTERACTIVE_KINDS.has(prop.kind),
        `unsupported interactive kind ${prop.kind} on ${prop.id}`,
      );
    }
  });

  test("byte-stable regeneration of slice and map bundle", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dustgate-occupation-"));
    const outSlice = path.join(tmp, "open-desert-slice.json");
    const outBundle = path.join(tmp, "open-desert-map-bundle.json");
    const result = spawnSync(process.execPath, [fixtureScript, `--out=${outSlice}`, `--map-bundle=${outBundle}`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const committedSlice = fs.readFileSync(committedSlicePath);
    const generatedSlice = fs.readFileSync(outSlice);
    assert.equal(Buffer.compare(generatedSlice, committedSlice), 0, "slice regeneration drifted");

    const committedBundleText = fs.readFileSync(committedBundlePath, "utf8");
    const generatedBundleText = fs.readFileSync(outBundle, "utf8");
    const committedNormalized = normalizeMapBundleText(committedBundleText);
    const generatedNormalized = normalizeMapBundleText(generatedBundleText);
    assert.equal(
      generatedNormalized,
      committedNormalized,
      "map bundle regeneration drifted after normalizing source.path provenance",
    );
  });
});
