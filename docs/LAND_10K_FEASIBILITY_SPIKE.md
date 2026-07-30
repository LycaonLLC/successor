# 10K World Feasibility Spike — LAND WAVE Part C

**Author:** ParcelLattice (world-systems). **Status:** DESIGN-POINT (spike only — NO scale
build this lane). **Question:** the desert starter is 1024² cells today; the owner wants
≥10,240² (×100 area, 1 cell ≈ 1 m → ~10 km). Can we ship 10k, and what's the honest cost?

**Verdict (one line):** the SIM + lattice + AOI are 10k-ready with a ~1 s boot cost;
the **client map-bundle whole-load is the gating rework** (chunk streaming). **Recommended:
land the lattice now (done) → chunked/streamed map-bundle → then ship 10k** (interim 4k is
loadable today if a stepping stone is wanted).

---

## How this was measured (reproducible)

- `cargo run -p successor-sim --release --example land_scale_probe` — times the real
  `SliceAuthorityState::from_snapshot` as the area grows (isolates the O(area) build).
- `cargo run -p successor-sim --example land_no_deadzone_audit` — audits the shipped slice
  (O(quantum-cells) scan); the 10k audit is a unit test
  (`no_deadzone_audit_holds_at_10k_with_central_2km_zone`) and runs in < 1 s.
- Slice/bundle byte + structure counts: `node` over the shipped JSON in
  `client/public/successor-slice/`.
- Machine: RTX-5090 box, release build, warm cache. Absolute ms scale with hardware; the
  **O(·) shape and the byte counts are the durable facts.**

## The cost table

| Subsystem | 1024² today | Structure | 10,240² projection | Scale-safe? |
|---|---|---|---|---|
| **Sim state memory** | areas `{id,kind,w,h}` (~40 B each); `blocked_cells` 0 (collision OFF); `ai_clearance` 0; resource field closed-form lazy (0 B) | **O(entities + sparse obstacles)** — NOT O(area) | ~0 added persistent bytes (only w/h change) | ✅ SAFE |
| **from_snapshot build** (AI clearance + door clearance) | 2.1 M cells (2 areas) → **18.9 ms**; steady **~9.8 ms / million cells** | **O(width×height)** — scans EVERY cell, allocs a `CellKey` (String) per cell even when `blocked_cells` is empty | 104.86 M cells (1 area) → **~1.0 s**; 2 areas → **~2 s** (release; ~5–10× in debug) | ⚠️ WASTEFUL — 1 s boot; rework recommended, not a hard blocker |
| **Wire / AOI** | `areaInterestRadiusCells 192`; shard spatially buckets actors; Rust snapshot filters are O(entities) linear scans | **population-bound, not world-bound** — world size does NOT inflate per-snapshot cost | unchanged per-snapshot (bounded by AOI population) | ✅ SAFE (add a spatial index only at very high population) |
| **Pathing / nav** | corridor/A* probes bounded by AOI range; obstacle set sparse | queries **range-bound**; obstacle EXTRACTION is the O(area) build above | queries unchanged; extraction = the 1 s build | ⚠️ same build landmine |
| **Sim slice JSON** (`open-desert-slice.json`) | **117 KB** — `spawnZones` 58 KB, `props` 6 KB, `actors` 0.9 KB; area = just `{w,h}` | **content-bound** — NOT O(area) | ~same KB (only w/h numbers change; more spawn zones = linear content authoring) | ✅ SAFE |
| **Client map-bundle** (`open-desert-map-bundle.json`) | **4.9 MB** — `areas.chunks` 2.4 MB (8192 chunks @ ~293 B), `indexes.chunkIdsByArea` 260 KB; `grid.chunkSizeCells 16`; tiles PROCEDURAL (chunk stores counts + propIds, not per-tile) | **O(chunk count) = O(area / 256)** | 409,600 chunks/area → **~120 MB/area, ~240–265 MB whole bundle**; chunk-id index ~25 MB | ❌ BLOCKER as whole-load |
| **3D client load** | `loadRuntimeAssetBundle` fetches the WHOLE bundle up-front (`Promise.all` → `fetchJson(mapBundlePath)`); render bakes per-chunk (LRU 192, `bakeRowsPerFrame`) | **DATA = load-whole; RENDER = already streamed/LRU-baked** | ~240 MB fetched at boot = untenable | ❌ needs chunk streaming (loader rework; render path already supports on-demand chunks) |
| **No-deadzone audit** | O(quantum cells) = 128² = 16 k slots, < 1 ms | O(area / quantum²) | 1280² = 1.6 M slots, **< 1 s** (unit-tested at 10k) | ✅ SAFE |

## Findings in prose

1. **The sim is not the problem.** Persistent sim memory is O(entities + sparse obstacles),
   not O(area): an area is `{id, kind, width, height, level}`; the resource field is
   closed-form lazy (the extractor `materialized_*` doctrine); `blocked_cells`/`ai_clearance`
   are sparse `BTreeSet`s (empty on the collision-OFF desert). Growing the world to 10k adds
   **~0 persistent bytes.**
2. **The one sim landmine is the AI-clearance BUILD** (`build_ai_clearance_blocked_cells`,
   `build_door_clearance_blocked_cells_by_prop`): both loop `for y in 0..h { for x in 0..w }`
   over the **whole area** and allocate a `CellKey` (with a `String` area id) per cell, even
   when there are zero obstacles. Measured **~9.8 ms/million cells (release)** → **~1 s** to
   build one 10k area, and it's **pure waste** when collision is sparse/off (the clearance set
   comes out empty). Fix: derive clearance only AROUND obstacles (dilate `blocked_cells` +
   fine-collision bounds by the clearance radius) — O(obstacles × radius²), and early-out for
   areas with no obstacles. This is a boot-time cost, so it's a strong recommendation, **not a
   hard blocker** (~1 s once per load is tolerable; the desert ships collision-OFF).
3. **AOI already makes the wire population-bound.** `areaInterestRadiusCells 192` bounds
   interest; the shard buckets actors spatially for combat-event routing; the Rust AOI filters
   (`parcel_in_interest`, `camp_in_interest`, `extractor_in_interest`) are O(total-entities)
   linear scans that world SIZE does not touch. Snapshot cost tracks POPULATION, not area.
   (At very high concurrent population, add a spatial index to the Rust filters — a
   population-bound optimization, orthogonal to world size.)
4. **The sim slice ships fine at 10k.** `open-desert-slice.json` is content-bound (spawn
   zones/props/actors); the area is just `{w,h}`. A 10k sim slice is ~the same size.
5. **The client map-bundle is the real blocker.** It's already 16-cell **chunked** and tiles
   are **procedural** (chunks carry metadata, not per-tile arrays), so it's O(chunk count) =
   O(area/256): **~4.9 MB @ 1024² → ~240–265 MB @ 10k**. The 3D client currently **loads the
   whole bundle up-front** (`loadRuntimeAssetBundle` → `Promise.all` fetch of `mapBundlePath`);
   only the RENDER streams (per-chunk LRU bake, cache 192). 240 MB at boot is untenable.

## Recommended path

**Phase, gated on the map-bundle rework — do NOT ship 10k as a whole-load.**

1. **NOW (this lane, landed):** the global lattice + exclusion + no-deadzone audit + snap.
   These are world-size-agnostic and 10k-proven (the audit passes at 10,240² with the 2 km
   central zone in < 1 s). This unblocks the land economy at ANY world size.
2. **GATE for 10k — chunked/streamed map-bundle** (client + a chunk-range fetch):
   - Split the bundle into per-chunk (or per-region) payloads addressable by `chunkX,chunkY`.
   - Stream chunk metadata by AOI (the render path already bakes chunks on demand + LRU-evicts
     192, so the plumbing exists — this is a LOADER change, not a renderer rewrite).
   - Keep a small always-loaded index (area dims, spawn/POI anchors) so boot is O(1) in area.
3. **RECOMMENDED — O(obstacle) clearance rework** (sim boot cost): dilate obstacles instead of
   scanning the map; early-out empty areas. Turns the ~1–2 s 10k boot into ~O(obstacles).
4. **THEN ship 10k.** With (2) done, the sim (1) + (3) carry 10k comfortably.
5. **Interim stepping stone (optional): 4,096².** Map-bundle ≈ **~42 MB** whole-load
   (borderline but loadable today); sim clearance build ≈ **~0.16 s**. A 4k desert is
   shippable NOW without the streaming rework and lets the land economy breathe while (2) is
   built. 10k stays the target once streaming lands.

## What this spike did NOT do

No scale build. The world ships at 1024² today; the lattice + exclusion are live on it. The
numbers above are measurements + O(·) projections to inform the owner's ship-10k / phase-4k /
rework-first decision. The reproducible probes ship with the crate (`land_scale_probe`,
`land_no_deadzone_audit`).
