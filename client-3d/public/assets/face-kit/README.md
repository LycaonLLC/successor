# Polygon Forge Face Kit

A standalone browser facial-texture compositor extracted from the Polygon Forge prototype. It keeps the part that worked—the painted face system—and deliberately excludes the body mesh, rig, animation, hair, clothing, and old creator UI.

The runtime is one dependency-free ES module. It can produce either a complete square skin texture or a transparent facial-feature decal. Each feature is selected independently, so an eye style does not force a matching brow, nose, or mouth.

## What is included

- 8 isolated eye pairs, 8 brow pairs, 8 noses, and 8 mouths: **4,096 base combinations** before color and transform variation
- Per-style semantic iris masks measured against the eye artwork
- Iris recoloring that preserves pupils, highlights, outlines, and sclera
- Independent eye/brow spacing, width, height, tilt, and vertical position
- Independent nose and mouth transforms
- Skin, iris, brow, and lip colors
- Mirrored or unmirrored face-paint strokes stored as UV data
- Full-skin and transparent-decal PNG output
- Optional Three.js texture helpers with no bundled Three.js version
- Raw atlases, the original combined reference sheet, atlas metadata, TypeScript declarations, and a runnable demo

## Run the demo

From this folder:

```bash
npm run demo
```

Then open `http://localhost:4173/demo/`. Any static server works; no build step is required.

## Smallest useful integration

```js
import {
  loadFaceAssets,
  renderFaceTexture,
} from "./polygon-forge-face-kit/src/face-kit.js";

const assets = await loadFaceAssets(
  new URL("./polygon-forge-face-kit/assets/", import.meta.url),
);

const canvas = renderFaceTexture(assets, {
  skinColor: "#915b42",
  eyeColor: "#7eb7c7",
  browColor: "#171313",
  lipColor: "#74443f",
  styles: {
    eyes: "youth",
    brows: "feral",
    nose: "stoic",
    mouth: "veteran",
  },
  eyes: {
    spacing: 1.04,
    scaleX: 1.08,
    scaleY: .94,
    irisScale: .88,
  },
}, { size: 256 });

document.body.append(canvas);
```

Unspecified fields are filled from `DEFAULT_FACE_CONFIG`, and every numeric transform is clamped to a safe range.

## Three.js

```js
import * as THREE from "three";
import {
  makeThreeTexture,
  updateThreeTexture,
} from "./polygon-forge-face-kit/src/face-kit.js";

const map = makeThreeTexture(THREE, canvas, { pixelated: true });
const material = new THREE.MeshBasicMaterial({ map, transparent: true });

// Reuse the same CanvasTexture after an editor change.
updateThreeTexture(map, assets, nextFaceConfig, { size: 256 });
```

The compositor is mesh-agnostic. You can use its square output in three common ways:

1. Put it on a small face card that sits a few millimeters above a head.
2. Reserve a square UV island for the front of a head and copy the pixels into your character atlas.
3. Render with `{ transparent: true }` and layer the decal over an existing skin material.

For a low-poly PS1/PS2 pipeline, a face card is usually the fastest to iterate. A dedicated head UV island gives the most integrated result once the canonical head is settled.

## Configuration shape

```js
{
  skinColor: "#bd7f5d",
  eyeColor: "#7eb7c7",
  browColor: "#35241e",
  lipColor: "#74443f",

  styles: {
    eyes: "stoic",
    brows: "stoic",
    nose: "stoic",
    mouth: "stoic",
  },

  eyes: {
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    spacing: 1,
    irisScale: 1,
  },
  brows: {
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    spacing: 1,
  },
  nose:  { offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  mouth: { offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },

  paint: [],
}
```

Style IDs are:

| ID | Original art direction |
|---|---|
| `stoic` | PS2 natural |
| `rogue` | Western toon |
| `youth` | Anime hero |
| `ghost` | Chibi adventure |
| `sharp` | Graphic novel |
| `feral` | Arcade fighter |
| `regal` | Painterly noble |
| `veteran` | Wasteland veteran |

The IDs are historical labels only. Mixing parts is the intended workflow.

## Face paint

Paint uses conventional UV coordinates: `(0, 0)` is bottom-left and `(1, 1)` is top-right. A stroke is serializable:

```js
{
  id: "scar-01",
  tool: "brush",          // or "erase"
  color: "#7d3432",
  size: 5,                // calibrated to a 128px reference texture
  opacity: .9,
  mirror: false,
  points: [
    { u: .34, v: .62 },
    { u: .37, v: .56 },
  ],
}
```

When `mirror` is true, the runtime mirrors each point around `u = .5`. Optional `mirrorU` and `mirrorV` fields can override the automatically mirrored point.

## Pure pixel use

`composeFacePixels()` does not access the DOM. Supply decoded RGBA atlas objects and it returns `{ width, height, data, config }`, where `data` is a `Uint8ClampedArray`. That makes the core usable in a Web Worker, Node image pipeline, Electron, or an engine bridge.

## Atlas contract

All part atlases are 4 columns by 2 rows in the order stored in `FACE_STYLE_ORDER`. The semantic mask uses:

- red: the complete iris island, including pupil/highlight protection
- green: only the pigment that should receive the chosen iris color
- blue: reserved

The precise per-eye centers used to resize and recolor irises are exported as `FACE_SEMANTIC_LAYOUT` and also described in `metadata/atlas-layout.json`.

## Files

```text
src/face-kit.js             runtime and public API
src/face-kit.d.ts           TypeScript declarations
assets/face-eyes-v3.png     isolated eye artwork
assets/face-brows-v3.png    isolated brow artwork
assets/face-noses-v3.png    isolated nose artwork
assets/face-mouths-v3.png   isolated mouth artwork
assets/face-iris-mask-v3.png semantic iris mask
assets/face-feature-sheet-v2.png original combined reference
demo/                       no-build interactive demo
examples/                   rendered QA output
metadata/atlas-layout.json  machine-readable atlas notes
```

## Intentional omissions

This export contains no attempt to preserve the prototype body or clothing stack. It is designed to plug into a future canonical head/body pipeline without bringing those decisions along with it.
