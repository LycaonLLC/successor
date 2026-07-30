# Performance Budget

This document defines the performance work that belongs to the supported 3D,
TUI, server, and Rust topology. A number is a release gate only after its
measurement command and representative fixture are checked in beside it.

## Current fixed contracts

- The default authority cadence is 30 Hz.
- The generated open-desert fixture is the standard end-to-end world.
- Network and authority measurements use the real TypeScript-to-Rust path.
- Graphical measurements use the Three.js client with its promoted GLBs,
  terrain, lights, shadows, effects, and UI enabled.
- TUI measurements run without DOM, WebGL, or GPU imports.

## Graphical client targets

| Concern | Initial target | Evidence needed |
| --- | --- | --- |
| Mid-range desktop frame rate | 60 fps at 1080p | Reproducible camera route with frame-time percentiles |
| Fallback desktop frame rate | 30 fps | Same route with reduced quality settings |
| Frame-time spikes | No repeated visible stalls during traversal or combat | Long-frame count and p95/p99 frame time |
| World entry | No unbounded synchronous GLB or texture work | Boot and first-playable timing |
| Population | Default fixture density remains playable | Actor count, draw calls, triangles, animation cost, and frame time |
| Effects | Combat and weather remain within the frame budget | A/B capture with effects enabled and disabled |
| Memory | Stable after repeated travel and window use | JS heap and GPU-resource trend, including disposal checks |

These are starting targets, not claims about current measurements. The first
performance pass should record a named host/GPU/browser, resolution, quality
settings, fixture hash, route, and build commit. That result becomes the
baseline for later regression thresholds.

The main risk areas are skinned PawnForge actors, Gaia rigs, shadows, trial-prop
promotion, particle bursts, post-processing, terrain streaming, item preview
renderers, and UI windows that create their own Three.js resources.

## Terminal client targets

The TUI has no graphical frame budget. Its useful measures are:

- command-to-render latency under a normal authority stream;
- bounded output and memory during long sessions;
- readable full-screen and plain-mode updates without runaway redraws;
- zero imports from the graphical client, DOM, Three.js, or GPU shims.

`pnpm tui:gate` owns end-to-end terminal behavior. The zero-GPU import check
owns the dependency boundary.

## Authority and network targets

The authority must complete a 30 Hz tick without sustained backlog. Measure
tick p50, p95, p99, and maximum against explicit entity and client counts.
Snapshot and receipt measurements must state whether AOI filtering, combat,
movement, persistence, and chat are active.

Existing measurement entry points include:

```bash
pnpm bench:aoi-1000
pnpm bench:game-ws
pnpm optimize:netcode
pnpm load:players:smoke
```

Their checked-in fixtures and thresholds remain authoritative for the metrics
they report. Do not copy a result from one fixture into a general product
claim.

## Asset promotion budget

Catalog size is not runtime cost. A GLB, material, shader, sound, or prop moves
from cataloged to integrated only after the default world or a focused journey
loads it successfully and its runtime cost is measured where material.

For promoted 3D assets, record:

- file and decoded texture size;
- triangle, material, texture, bone, and animation counts;
- clone/instance strategy and disposal behavior;
- measured effect on boot, frame time, and memory at expected multiplicity.

Large source libraries may remain in the repository, but the production bundle
must include only assets reachable from the runtime registries and fixture.

## Regression policy

A performance change is acceptable when it either stays within a measured gate
or carries a written, reproducible reason for changing that gate. Screenshots
and subjective smoothness are useful review evidence, but they do not replace
timings, counts, and fixture identity.
