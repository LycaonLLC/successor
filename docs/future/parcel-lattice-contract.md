# Parcel Lattice — Geometry Truth Contract (v1)

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

Owner of truth: **ParcelLattice** (LAND WAVE). Consumers: **ClaimUX** (ghost/borders/flows),
farm FE (`/farm claim`), journeys. Mirror these constants client-side; never re-derive.
Server is authoritative — the ghost is a preview, the **receipt + reject codes are truth**.

Status: STABLE (safe to build on). Any change bumps the version and pings ClaimUX via irc.

---

## 1. The lattice

- `LATTICE_QUANTUM_CELLS = 8`. Every parcel origin is a multiple of 8 (per axis).
- Tier lot dims (SQUARE): `homestead 16` (2 quantum), `farmstead 24` (3q), `plantation 32` (4q).
  Every dim is an integer multiple of the quantum, so **any legal arrangement tiles the lattice
  perfectly** — no partial-cell slivers can exist.
- **Origin = MIN corner** (smallest x, smallest y). A lot occupies the half-open box
  `[x, x+dim) × [y, y+dim)` in cells. Lattice cell `k` spans world cells `[8k, 8k+8)`.

## 2. Origin snap (server-authoritative)

```
snap(v) = round_half_up(v / 8) * 8      // per axis, ties toward +∞
        = ((v + 4) .div_euclid(8)) * 8   // correct for negatives too
```

- **ROUND to nearest** lattice node (NOT floor). Idempotent: an already-aligned origin is unchanged.
- The client SHOULD mirror `snap()` for the live ghost so the preview lands exactly where the
  server will place it. The server snaps regardless (safety net) and reports the result.
- Examples: `snap(803)=800`, `snap(804)=808`, `snap(797)=800`, `snap(-5)=-8`, `snap(800)=800`.

### "Claim where I stand" helper (farm FE / journeys)
To claim so the **standing cell lands inside the farm yard** after snap, request the origin
`(px - 8, py - 10)` for a homestead (centers the 14×10 yard on the player). Proof: the ±4 snap
error keeps the player at yard-relative `(7±4, 5±4) ⊂ [0,14)×[0,10)` — always inside. For other
tiers, request `origin = playerCell - (floor(yardW/2)+1, floor(buildRows)+floor(yardH/2))`; or just
read the minted parcel's `farmYard` from the AOI and act on a cell inside it (fully snap-robust).

## 3. Adjacency + the internal no-build ring

- **Directly adjacent plots are legal** — two lots may share an exact edge (e.g. homesteads at
  x=[0,16) and x=[16,32)). The old forced 1-cell setback GAP between claims is **removed**.
- Each lot still has a **1-cell internal no-build ring**: `build_zone` + `farm_yard` are the lot
  inset by 1. So between two adjacent lots' *buildable* zones there is a 2-cell walk corridor
  (1 from each). Borders touch; builds never do.
- `build_zone` (top strip) + `farm_yard` (remainder) tile the interior with no gap/overlap.

## 4. Claim validation order (server)

1. actor alive, area is a housing region, tier valid
2. **snap** origin → `(snapX, snapY)`; derive `(lot, buildZone, farmYard)` at the snapped origin
3. `out_of_bounds` if the snapped lot leaves the area
4. `parcel_already_owned_on_planet` (1 / planet / char)
5. `parcel_overlap` — **exact lattice-cell** overlap vs existing lots (adjacency OK, no inflation)
6. exclusion (unified, §6): `too_close_to_poi` | `too_close_to_road` | `no_claim_zone`
7. `insufficient_credits` (credits sink); then MINT at the snapped origin

Full reject set: `wrong_session, wrong_player, duplicate_command, unknown_actor,
ingress_budget_exhausted, actor_not_alive, unknown_area, not_in_housing_region, out_of_bounds,
parcel_already_owned_on_planet, parcel_overlap, too_close_to_poi, too_close_to_road,
no_claim_zone, insufficient_credits, target_unavailable`.

## 5. Claim receipt (requested → snapped)

Emitted on the command frame + bridge step output as `parcelClaim` (camelCase JSON), and the
minted parcel also appears in the `placedParcels` AOI with its snapped `rect`:

```jsonc
parcelClaim: {
  parcelId: string,
  requestedX: i32, requestedY: i32,   // what the client asked for
  snappedX:  i32, snappedY:  i32,     // where it actually landed
  snapped:   bool,                    // requested != snapped
  tier: "homestead"|"farmstead"|"plantation",
  rect:      { x, y, w, h },          // the lot (snapped)
  buildZone: { x, y, w, h },
  farmYard:  { x, y, w, h },
  tick: u64
}
```
FE: show "claim snapped to (snappedX, snappedY)" when `snapped` is true.

## 6. Exclusion zones (the INVALID read)

A claim is INVALID where its lattice rect intersects any **no-claim zone**. Zones are SQUARE and
**lattice-aligned** (min floored, max ceiled to the quantum — no sub-quantum sliver ever borders a
zone). Three sources, each with its own reject code:

| source    | derived from                    | reject code         |
|-----------|---------------------------------|---------------------|
| `central` | per-area config (§7)            | `no_claim_zone`     |
| `poi`     | clone facilities + buffer (3c)  | `too_close_to_poi`  |
| `road`    | area transitions + buffer (3c)  | `too_close_to_road` |

**How the client learns them (authoritative, no re-derive):**
- Central zones ship in the **slice** `noClaimZones` config (see §7) — static, loaded once.
- The **unified** set (central + poi + road, lattice-aligned rects) is exposed to the client as
  `noClaimZones` in the bridge import-state / step output, per the observer's area:
  ```jsonc
  noClaimZones: [ { areaId, rect: {x,y,w,h}, source: "central"|"poi"|"road" } ]
  ```
  Render `central` as the big frontier boundary; `poi`/`road` as smaller infrastructure buffers.
- FE ghost validity = `inBounds(lot) && !overlapsAnyParcel(lot) && !overlapsAnyNoClaimZone(lot)`.
  The 3 predicates mirror the server; the server's reject is the final word.

## 7. Central no-claim zone config (per area, in the slice)

```jsonc
// slice.noClaimZones[]  (config; the server snaps rect to the lattice)
{ areaId: "open-desert-overworld", centerX: 512, centerY: 512, halfExtentCells: 64, label: "Dustgate hub" }
```
- Square: `[centerX-half, centerX+half) × [centerY-half, centerY+half)`, snapped to the lattice.
- **Starter desert (current 1024²): center (512,512), halfExtent 64 → [448,576).** Protects the hub
  cluster (spawn/clone-vat/trainer/terminals/registry all ~500–524); the frontier around it is
  claimable. `no_deadzone` audit proves zero trapped cells around it.
- **10k target (when the desert ships ≥10240²): halfExtent 1024 → a 2048-cell (~2km) square**
  centered on the hub. Same config field, scaled to the world. Owner sets it per world size.
- Per-area: the starter desert gets one; future maps add their own (or none).

## 8. In-lot structure grid (house / extractor / farm equipment)

- The **in-lot grid is 1 cell** (fine), distinct from the coarse 8-cell PARCEL lattice.
- `PlaceFarmStructure { parcelId, structureItemId, cellX, cellY }` already carries the snapped
  **cell** — FE quantizes the click to an integer cell, server validates `cell ∈ lot` and
  `!occupied`. This is the working in-lot snap-place path (option a). No wire change needed.
- `PlaceExtractor { family }` and `PlaceCamp {}` remain **at-feet** (no coords) this wave — they
  are not lot-scoped placements. FE preview quantizes to the feet cell (option c). If the owner
  later wants a full in-lot extractor ghost, that's a follow-up wire add (optional snapped coords).
- Houses: build_zone is reserved for them; when a place-house command lands it will use the same
  1-cell in-lot grid + build_zone containment.

## 9. AbandonParcel (for honest confirm copy)

`AbandonParcel { parcelId }` (owner-only): **returns each placed STRUCTURE item to the owner's
inventory (1 each); CROPS ARE LOST with the land; frees the 1/planet/char slot.** Reject codes:
`unknown_parcel, not_parcel_owner` (+ session/actor guards). Confirm copy should warn crops are lost.

## 10. Migration cut

**Clean cutover — zero live parcels exist** (verified: no `parcel:` rows in server/.local-state,
server/data, or characters.json). All parcels are runtime-minted; from this wave every claim is
lattice-snapped. A legacy off-lattice parcel imported from an old checkpoint (none exist) is
**grandfathered** — its stored rect is preserved on import; it just cannot be re-created off-lattice.
No forced migration, no data touched.

---
_Questions → irc ParcelLattice. This doc is the single source; the sim implements exactly this._
