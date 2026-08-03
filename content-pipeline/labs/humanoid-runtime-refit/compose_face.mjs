// compose_face.mjs — bake one face texture with the canonical face kit.
//
// The kit (client-3d/src/assets/faceKit/face-kit.js) is the single pixel
// authority for Successor faces. Its browser entry points need a DOM, but
// `composeFacePixels` is explicitly pure and Node-safe once it is handed
// decoded RGBA atlases, so this bridge stays inside the canonical compositor
// instead of reimplementing any of it.
//
// Node has no PNG codec, so the Python driver decodes the five atlases to raw
// RGBA and re-encodes the result. This script only moves bytes through the kit.
//
//   node compose_face.mjs <job.json>
//
// job.json:
//   { "assets": { "eyes": {"path":..., "width":..,"height":..}, ... },
//     "config": <FaceConfig>, "size": 256, "transparent": false,
//     "out": "<raw rgba path>" }

import { readFileSync, writeFileSync } from "node:fs";
import { composeFacePixels } from "../../../client-3d/src/assets/faceKit/face-kit.js";

const job = JSON.parse(readFileSync(process.argv[2], "utf8"));

const assets = Object.fromEntries(Object.entries(job.assets).map(([key, spec]) => {
  const bytes = readFileSync(spec.path);
  const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length !== spec.width * spec.height * 4) {
    throw new Error(`${key}: expected ${spec.width * spec.height * 4} RGBA bytes, got ${data.length}`);
  }
  return [key, { width: spec.width, height: spec.height, data }];
}));

const result = composeFacePixels(assets, job.config, {
  size: job.size,
  transparent: Boolean(job.transparent),
});

writeFileSync(job.out, Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength));
process.stdout.write(`${result.width}x${result.height}\n`);
