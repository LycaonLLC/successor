//! Farm stored-state model — §A.1-A.3 (agriculture-design.md). A parcel is a
//! claimed rectangle entity, sibling of placed-extractor/camp/stockpile-zone:
//! owner-keyed, BTreeMap, deterministic, joins `write_stable_hash` (the ceremony).
//! Tiles are sparse (only tilled/cropped cells exist); crops cache the
//! `AgronomicProfile` at plant and accrue growth closed-form (T7 lazy doctrine).
//! State structs live here; parcel commands in land.rs, tile/crop commands +
//! settle in farming.rs, pure growth math in growth.rs.
use super::*;

// ── PARCEL GEOMETRY (§C.0, derived from house_h1 = 5x4 = 20 cells) ───────────────
/// No-build setback ring around every lot (griefing/road-access buffer, §F).
pub(super) const PARCEL_SETBACK_RING_CELLS: u32 = 1;
/// house_h1 footprint in cells (T1) — the build-unit the tiers are derived from.
pub(super) const HOUSE_H1_FOOTPRINT_CELLS: u32 = 20;
/// Buffer (in cells) a claim must keep from POIs (clone facilities) and roads
/// (area transition triggers). Griefing/infrastructure guard (§F7).
pub(super) const PARCEL_POI_BUFFER_CELLS: i32 = 3;

// ── GLOBAL CLAIM LATTICE (§A LAND WAVE) ─────────────────────────────────────────
// The lattice quantum (cells) is `crate::LATTICE_QUANTUM_CELLS` (public, FE-mirrored).
// Every parcel origin snaps to a multiple of it; every tier lot dim is an integer
// multiple (16/24/32 = 2/3/4 quantum), so ANY legal arrangement tiles the lattice
// perfectly — no sub-quantum sliver can ever exist.

/// Snap a world coordinate to the nearest lattice node (round half toward +INF).
/// Idempotent on aligned input; correct for negative coords via `div_euclid`.
/// The server snaps every claim origin through this; the receipt reports the result
/// (§B.1 LAND WAVE recommend-snap ruling).
pub(super) fn snap_to_lattice(v: i32) -> i32 {
    let q = crate::LATTICE_QUANTUM_CELLS;
    let half = q / 2;
    v.saturating_add(half).div_euclid(q).saturating_mul(q)
}

/// An axis-aligned grid rectangle in cells. `x,y` = min corner; `w,h` = extent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthorityRect {
    pub(super) x: i32,
    pub(super) y: i32,
    pub(super) w: u32,
    pub(super) h: u32,
}

impl AuthorityRect {
    pub(super) fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub(super) fn area_cells(&self) -> u32 {
        self.w.saturating_mul(self.h)
    }

    fn max_x(&self) -> i64 {
        i64::from(self.x) + i64::from(self.w)
    }

    fn max_y(&self) -> i64 {
        i64::from(self.y) + i64::from(self.h)
    }

    /// Half-open containment: cell in [x, x+w) x [y, y+h).
    pub(super) fn contains_cell(&self, cell: AuthorityCell) -> bool {
        i64::from(cell.x) >= i64::from(self.x)
            && i64::from(cell.x) < self.max_x()
            && i64::from(cell.y) >= i64::from(self.y)
            && i64::from(cell.y) < self.max_y()
    }

    /// Grow the rect by `margin` cells on every side (setback/buffer checks).
    pub(super) fn inflated(&self, margin: u32) -> AuthorityRect {
        let margin_i = i32::try_from(margin).unwrap_or(i32::MAX);
        AuthorityRect {
            x: self.x.saturating_sub(margin_i),
            y: self.y.saturating_sub(margin_i),
            w: self.w.saturating_add(margin.saturating_mul(2)),
            h: self.h.saturating_add(margin.saturating_mul(2)),
        }
    }

    /// Sub-rect inset by `margin` on every side (interior after the setback ring).
    pub(super) fn inset(&self, margin: u32) -> AuthorityRect {
        let margin_i = i32::try_from(margin).unwrap_or(i32::MAX);
        AuthorityRect {
            x: self.x.saturating_add(margin_i),
            y: self.y.saturating_add(margin_i),
            w: self.w.saturating_sub(margin.saturating_mul(2)),
            h: self.h.saturating_sub(margin.saturating_mul(2)),
        }
    }
}

// ── PARCEL TIER (§C.0 / F6) — 3 tiers by house class, 1/planet/char regardless ──
/// A rectangle in LATTICE (quantum) units — the exact tiling space. Every legal
/// parcel and every lattice-aligned exclusion maps to one of these (integer quantum
/// origin + extent), so overlap is an exact integer-range test and no sub-quantum
/// sliver can exist. Half-open [qx, qx+qw) x [qy, qy+qh).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct LatticeRect {
    pub(super) qx: i32,
    pub(super) qy: i32,
    pub(super) qw: i32,
    pub(super) qh: i32,
}

impl LatticeRect {
    /// The lattice cells a cell-space rect covers: min floored to the quantum, max
    /// ceiled. For a lattice-ALIGNED rect (every legal lot) this is exact; for an
    /// arbitrary rect (a raw buffer box) it snaps OUTWARD so the covered region is
    /// whole quantum cells — no partial-cell exclusion sliver ever borders a zone.
    pub(super) fn covering(rect: &AuthorityRect) -> Self {
        let q = i64::from(crate::LATTICE_QUANTUM_CELLS);
        let min_x = i64::from(rect.x).div_euclid(q);
        let min_y = i64::from(rect.y).div_euclid(q);
        let max_x = (i64::from(rect.x) + i64::from(rect.w) + q - 1).div_euclid(q);
        let max_y = (i64::from(rect.y) + i64::from(rect.h) + q - 1).div_euclid(q);
        Self {
            qx: min_x as i32,
            qy: min_y as i32,
            qw: (max_x - min_x).max(0) as i32,
            qh: (max_y - min_y).max(0) as i32,
        }
    }

    /// Do two lattice rects share any quantum cell? (Exact, adjacency-safe: rects
    /// that merely touch edges do NOT intersect — that is what enables adjacency.)
    pub(super) fn intersects(&self, other: &LatticeRect) -> bool {
        self.qx < other.qx + other.qw
            && other.qx < self.qx + self.qw
            && self.qy < other.qy + other.qh
            && other.qy < self.qy + self.qh
    }

    /// Does this lattice rect contain quantum cell (qx, qy)?
    pub(super) fn contains_q(&self, qx: i32, qy: i32) -> bool {
        qx >= self.qx && qx < self.qx + self.qw && qy >= self.qy && qy < self.qy + self.qh
    }
}

/// Snap a cell-space rect OUTWARD to whole lattice cells (min floored, max ceiled).
/// The result is lattice-aligned — every exclusion zone runs through this so its
/// border always falls on a lattice line and no sub-quantum sliver can be created.
pub(super) fn lattice_align_outward(rect: &AuthorityRect) -> AuthorityRect {
    let q = crate::LATTICE_QUANTUM_CELLS;
    let lat = LatticeRect::covering(rect);
    AuthorityRect::new(
        lat.qx.saturating_mul(q),
        lat.qy.saturating_mul(q),
        u32::try_from(lat.qw.saturating_mul(q)).unwrap_or(0),
        u32::try_from(lat.qh.saturating_mul(q)).unwrap_or(0),
    )
}

/// Source of a no-claim zone — drives the reject code + the FE render tier (§6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum NoClaimZoneSource {
    Central, // owner-configured hub / no-claim square (§B)
    Poi,     // clone-facility buffer
    Road,    // area-transition buffer
}

impl NoClaimZoneSource {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Central => "central",
            Self::Poi => "poi",
            Self::Road => "road",
        }
    }

    pub(super) fn reject_reason(self) -> AuthorityRejectReason {
        match self {
            Self::Central => AuthorityRejectReason::NoClaimZone,
            Self::Poi => AuthorityRejectReason::TooCloseToPoi,
            Self::Road => AuthorityRejectReason::TooCloseToRoad,
        }
    }
}

/// A resolved no-claim zone (lattice-aligned) for an area — the unified exclusion
/// used by BOTH claim validation and the no-deadzone audit (one source of truth,
/// so the audit can never disagree with what the claim path rejects).
#[derive(Debug, Clone)]
pub(super) struct NoClaimZone {
    pub(super) rect: AuthorityRect,
    pub(super) source: NoClaimZoneSource,
}

/// Owner-configured central no-claim square (§B), parsed from the slice + stored in
/// authority state. The stored `rect` is already lattice-aligned (snapped outward at
/// build). The resolved zone's source is always Central.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NoClaimZoneAuthorityState {
    pub(super) area_id: String,
    pub(super) rect: AuthorityRect,
    #[serde(default)]
    pub(super) label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ParcelTier {
    Homestead,  // h1: 16x16
    Farmstead,  // h2: 24x24
    Plantation, // h3: 32x32
}

impl ParcelTier {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Homestead => 1,
            Self::Farmstead => 2,
            Self::Plantation => 3,
        }
    }

    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Homestead => "homestead",
            Self::Farmstead => "farmstead",
            Self::Plantation => "plantation",
        }
    }

    pub(super) fn from_id(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "homestead" | "h1" | "1" => Some(Self::Homestead),
            "farmstead" | "h2" | "2" => Some(Self::Farmstead),
            "plantation" | "h3" | "3" => Some(Self::Plantation),
            _ => None,
        }
    }

    /// Square lot side in cells (16 / 24 / 32).
    pub(super) const fn lot_dim(self) -> u32 {
        match self {
            Self::Homestead => 16,
            Self::Farmstead => 24,
            Self::Plantation => 32,
        }
    }

    /// House-class count the build zone must hold (1 / 2 / 4 house_h1).
    pub(super) const fn house_count(self) -> u32 {
        match self {
            Self::Homestead => 1,
            Self::Farmstead => 2,
            Self::Plantation => 4,
        }
    }

    /// Rows of the interior reserved for the build zone (top strip). Chosen so the
    /// build zone comfortably holds `house_count` house_h1 (20 cells each) and the
    /// remaining interior farm yard matches the §C.0 targets (144 / 288 / 480).
    const fn build_zone_rows(self) -> u32 {
        match self {
            Self::Homestead => 4,   // 14x4=56 >= 20; yard 14x10=140 (~144)
            Self::Farmstead => 9,   // 22x9=198 >= 40; yard 22x13=286 (~288)
            Self::Plantation => 14, // 30x14=420 >= 80; yard 30x16=480 (exact)
        }
    }
}

/// Derive the (lot, build_zone, farm_yard) rects for a claim of `tier` anchored at
/// `(x,y)`. The lot is a `lot_dim` square; a 1-cell setback ring gives the interior;
/// the interior splits into a build-zone top strip + a farm-yard remainder
/// (non-overlapping, tiling the interior). Deterministic; the §C.0 invariants hold.
pub(super) fn derive_parcel_rects(
    tier: ParcelTier,
    x: i32,
    y: i32,
) -> (AuthorityRect, AuthorityRect, AuthorityRect) {
    let lot = AuthorityRect::new(x, y, tier.lot_dim(), tier.lot_dim());
    let interior = lot.inset(PARCEL_SETBACK_RING_CELLS);
    let build_rows = tier.build_zone_rows().min(interior.h);
    let build_zone = AuthorityRect::new(interior.x, interior.y, interior.w, build_rows);
    let farm_yard = AuthorityRect::new(
        interior.x,
        interior
            .y
            .saturating_add(i32::try_from(build_rows).unwrap_or(i32::MAX)),
        interior.w,
        interior.h.saturating_sub(build_rows),
    );
    debug_assert!(
        build_zone.area_cells() >= tier.house_count() * HOUSE_H1_FOOTPRINT_CELLS,
        "build zone must hold the tier's house_h1 count"
    );
    (lot, build_zone, farm_yard)
}

// ── STORED STATE (joins write_stable_hash, land.rs::write_parcels_stable_hash) ──
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ParcelAuthorityState {
    pub(super) id: String,
    /// DURABLE owner (survives sessions), resolved via owner_character_id_for_actor.
    pub(super) owner_character_id: String,
    pub(super) planet_id: String,
    pub(super) area_id: String,
    pub(super) name: String,
    pub(super) rect: AuthorityRect,
    pub(super) tier: ParcelTier,
    pub(super) build_zone: AuthorityRect,
    pub(super) farm_yard: AuthorityRect,
    pub(super) claimed_tick: u64,
    /// §F5: lapse PAUSES the farm (weeds), never confiscates. 0 = no upkeep due yet.
    pub(super) upkeep_paid_through_tick: u64,
    /// Set on rain onset over the area (§C.2 lazy moisture read at settle). [rain read W3; weather source W4]
    pub(super) rained_through_tick: u64,
    /// ONLY tilled/planted cells; untilled cells are absent (sparse). Key = "x:y".
    pub(super) tiles: BTreeMap<String, TileAuthorityState>,
    /// Placed farm structures (sprinkler W3; greenhouse/planter W4). Key = structure id.
    pub(super) structures: BTreeMap<String, FarmStructureState>,
    #[serde(default)]
    pub(super) build_components: BTreeMap<String, BuildComponentState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TileAuthorityState {
    pub(super) cell: AuthorityCell,
    pub(super) tilled: bool,
    pub(super) moisture_milli: u16,
    /// Applied soil amendment (W4 Fertilize; one kind per tile, §B.2/§C.4). None
    /// until fertilized; consumed with the crop at final harvest / clear.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) fertilizer: Option<FertilizerApplied>,
    pub(super) crop: Option<CropAuthorityState>,
    /// Last tick moisture+growth were advanced (lazy settle anchor, §C.1).
    pub(super) last_settle_tick: u64,
}

/// Cached-agronomic-profile crop (§A.3) — exactly PlacedExtractorState's shape:
/// store constants (seed_*, profile) + an accrual clock, derive the rest
/// closed-form. The hot path reads ONLY `profile`; zero genome-registry access.
/// (blight [W4-weather], fertilizer rides on the TILE; harvests_remaining [W5].)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CropAuthorityState {
    pub(super) seed_item_id: u32,
    /// Genome HANDLE (§A.4) — display/lineage; the profile is what growth reads.
    pub(super) seed_variant_id: u32,
    pub(super) planted_tick: u64,
    /// CACHED at PlantSeed via the seed->soil boundary; the ONLY thing growth reads.
    pub(super) profile: AgronomicProfile,
    pub(super) accumulated_growth_days_milli: u64,
    /// Consecutive dry game-days toward dormancy (reset on water/rain, §C.1).
    pub(super) drought_days: u16,
    /// Running tending score -> produce/seed quality (§C.4).
    pub(super) tending_quality_milli: u16,
    /// Remaining harvests before the crop clears (§W5 regrowth). Set at PlantSeed:
    /// 1 for single-harvest (regrowth_days==0), else 1 + perennial re-fruit cycles.
    /// HarvestCrop decrements it; 0 => clear the crop to tilled-empty.
    #[serde(default = "default_harvests_remaining")]
    pub(super) harvests_remaining: u16,
}

/// Serde default for crops persisted before W5 (single-harvest).
fn default_harvests_remaining() -> u16 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FarmStructureState {
    pub(super) structure_id: String,
    pub(super) item_id: u32,
    pub(super) cell: AuthorityCell,
    pub(super) position: AuthorityPosition,
    /// Sprinkler auto-water Chebyshev radius in cells (0 for non-watering structures).
    pub(super) coverage_radius_cells: u32,
    pub(super) placed_at_tick: u64,
}

// ── FERTILIZER (W4, §B.2/§C.4) — one applied amendment per tile, three lines ────
/// The three Stardew-style fertilizer lines (§C.4). Speed shortens time-to-mature,
/// quality lifts realized produce quality, yield multiplies harvested quantity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum FertilizerKind {
    Speed,
    Quality,
    Yield,
}

impl FertilizerKind {
    /// Stable code for the hash + wire (never renumbered).
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::Speed => 1,
            Self::Quality => 2,
            Self::Yield => 3,
        }
    }

    /// FarmTileVM string (§E.4 `fertilizer` field).
    pub(super) const fn id(self) -> &'static str {
        match self {
            Self::Speed => "speed",
            Self::Quality => "quality",
            Self::Yield => "yield",
        }
    }

    pub(super) fn from_item_id(item_id: u32) -> Option<Self> {
        match item_id {
            FERTILIZER_SPEED_ITEM_ID => Some(Self::Speed),
            FERTILIZER_QUALITY_ITEM_ID => Some(Self::Quality),
            FERTILIZER_YIELD_ITEM_ID => Some(Self::Yield),
            _ => None,
        }
    }

    /// The per-day/harvest effect (§C.4 adopted defaults). One line each: a Speed
    /// tile only speeds growth, a Quality tile only lifts tending, a Yield tile
    /// only multiplies harvest quantity (one kind per tile, so lines never stack).
    pub(super) const fn effect(self) -> FertilizerEffect {
        match self {
            Self::Speed => FertilizerEffect {
                growth_bonus_milli: FERTILIZER_SPEED_GROWTH_BONUS_MILLI,
                tending_bonus_milli: 0,
                yield_bonus_milli: 0,
            },
            Self::Quality => FertilizerEffect {
                growth_bonus_milli: 0,
                tending_bonus_milli: FERTILIZER_QUALITY_TENDING_BONUS_MILLI,
                yield_bonus_milli: 0,
            },
            Self::Yield => FertilizerEffect {
                growth_bonus_milli: 0,
                tending_bonus_milli: 0,
                yield_bonus_milli: FERTILIZER_YIELD_BONUS_MILLI,
            },
        }
    }
}

/// The active FertilizerEffect for a tile's applied amendment (NONE when bare).
pub(super) fn tile_fertilizer_effect(fertilizer: Option<&FertilizerApplied>) -> FertilizerEffect {
    fertilizer.map_or(FertilizerEffect::NONE, |applied| applied.kind.effect())
}

/// One applied fertilizer on a tile (§C.4). `variant_id` carries the amendment's
/// provenance/potency (the crafted-fertilizer variant; 0 for a plain grant) — it
/// is stored + hashed + snapshot-visible like the crop's `seed_variant_id`, while
/// the growth/harvest effect keys on `kind` (adopted-default bonuses, §C.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FertilizerApplied {
    pub(super) kind: FertilizerKind,
    pub(super) variant_id: u32,
}

/// Decode a packed `tile_footprint` (§C.7: high nibble = W, low nibble = H;
/// `0x22` = 2x2, `0x01`/`1` = 1x1). Each dim floors at 1.
pub(super) fn footprint_dims(tile_footprint: u8) -> (i32, i32) {
    let w = i32::from(tile_footprint >> 4).max(1);
    let h = i32::from(tile_footprint & 0x0F).max(1);
    (w, h)
}

/// Every cell of a WxH crop footprint anchored at `anchor` is tilled + crop-free
/// (§C.7 giant-crop plant precondition). The seam is here; full multi-tile
/// anchor/OccupiedBy resolution lands with footprint>1 genomes from the registry.
pub(super) fn footprint_all_tilled_empty(
    parcel: &ParcelAuthorityState,
    anchor: AuthorityCell,
    tile_footprint: u8,
) -> bool {
    let (w, h) = footprint_dims(tile_footprint);
    for dy in 0..h {
        for dx in 0..w {
            let cell = AuthorityCell::new(anchor.x + dx, anchor.y + dy);
            match parcel.tiles.get(&tile_cell_key(cell)) {
                Some(tile) if tile.tilled && tile.crop.is_none() => {}
                _ => return false,
            }
        }
    }
    true
}

/// Canonical per-parcel tile map key. Lexicographic order is deterministic (all
/// the hash needs); the tile carries its own cell coords for snapshots.
pub(super) fn tile_cell_key(cell: AuthorityCell) -> String {
    format!("{}:{}", cell.x, cell.y)
}

// ── AOI SNAPSHOTS (§E.4 view-model contracts) ───────────────────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityRectSnapshot {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl From<&AuthorityRect> for AuthorityRectSnapshot {
    fn from(rect: &AuthorityRect) -> Self {
        Self {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
        }
    }
}

/// parcels AOI section (nearby render + boundary + owner flag + coarse crop count).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityParcelSnapshot {
    pub parcel_id: String,
    /// Raw owner actor id for shard-side per-session isOwner recompute; the
    /// shard strips it before send (camp/extractor precedent). World-visible
    /// ownership itself is fine (land registry shows claims).
    pub owner_actor_id: String,
    pub planet_id: String,
    pub area_id: String,
    pub name: String,
    pub rect: AuthorityRectSnapshot,
    pub tier: String,
    pub build_zone: AuthorityRectSnapshot,
    pub farm_yard: AuthorityRectSnapshot,
    pub is_owner: bool,
    pub upkeep_due_in_game_days: Option<i64>,
    pub tilled_tiles: u32,
    pub planted_tiles: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityParcelsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub parcels: Vec<AuthorityParcelSnapshot>,
}

/// farmPlot owner-detail crop VM (§E.4 FarmCropVM).
/// Authoritative no-claim zone for the client's INVALID read (§6 contract). The
/// unified lattice-aligned exclusion set (central + poi + road) for the observer's
/// area; the FE renders these as the un-claimable regions and validates its ghost.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityNoClaimZoneSnapshot {
    pub area_id: String,
    pub rect: AuthorityRectSnapshot,
    /// "central" | "poi" | "road".
    pub source: String,
}

/// Claim receipt (requested -> snapped) — the command-result VM reporting where a
/// claim actually landed after lattice snap (§5 contract). Mirrors the harvest
/// receipt: transient, drained onto the command frame + bridge step output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityParcelClaimSnapshot {
    pub parcel_id: String,
    pub requested_x: i32,
    pub requested_y: i32,
    pub snapped_x: i32,
    pub snapped_y: i32,
    /// requested != snapped (the origin moved to land on the lattice).
    pub snapped: bool,
    pub tier: String,
    pub rect: AuthorityRectSnapshot,
    pub build_zone: AuthorityRectSnapshot,
    pub farm_yard: AuthorityRectSnapshot,
    pub tick: u64,
}

/// No-deadzone audit report (§A invariant proof). Scans every lattice slot in an
/// area and proves every FREE (in-bounds AND unexcluded AND unclaimed) quantum cell
/// is coverable by at least one legal smallest-tier (Homestead = 2x2 quantum) claim.
/// `trapped_cells` empty => the invariant holds: no sliver, everything claimable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoDeadzoneAuditReport {
    pub area_id: String,
    pub quantum_cells: i32,
    pub area_quantum_w: i32,
    pub area_quantum_h: i32,
    pub free_cells: u64,
    pub coverable_cells: u64,
    /// Free-but-uncoverable quantum cells (cell-space MIN corner; capped sample).
    pub trapped_cells: Vec<AuthorityRectSnapshot>,
    pub trapped_total: u64,
    pub passed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFarmCropSnapshot {
    pub seed_item_id: u32,
    pub seed_variant_id: u32,
    pub species: String,
    pub stage: u8,
    pub stage_count: u8,
    /// "vigorous" | "wilting" | "dormant".
    pub health: String,
    /// "none" | "infected" (always "none" in W3; W4 rolls blight).
    pub blight: String,
    pub time_to_mature_game_days: Option<u64>,
    pub quality_so_far_milli: u16,
    pub footprint_w: u8,
    pub footprint_h: u8,
    pub mature: bool,
}

/// farmPlot owner-detail tile VM (§E.4 FarmTileVM).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFarmTileSnapshot {
    pub cell_x: i32,
    pub cell_y: i32,
    pub tilled: bool,
    pub moisture_pct: u8,
    /// "none" | "speed" | "quality" | "yield" (§E.4 FarmTileVM).
    pub fertilizer: String,
    pub crop: Option<AuthorityFarmCropSnapshot>,
    pub legal_verbs: Vec<String>,
}

/// farmPlot owner-detail channel (per-tile detail for the owner's open HUD).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFarmPlotSnapshot {
    pub parcel_id: String,
    /// Raw owner actor id (shard strips it) so the shard can blank legal_verbs
    /// for non-owners; crop render state stays world-visible.
    pub owner_actor_id: String,
    /// Area the plot lives in — the shard groups farm plots by area for
    /// per-session delivery (placed-entity precedent).
    pub area_id: String,
    pub tiles: Vec<AuthorityFarmTileSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFarmPlotDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub farm_plot: Option<AuthorityFarmPlotSnapshot>,
}

/// W5 harvest receipt (command-result VM; §W5 "receipts + prose"). Carries what
/// the harvest minted so the FE/journeys can render the beat and assert the loop:
/// produce units + quality, offspring seed handle + count (0 when sterile), and
/// whether the crop regrew (perennial) or the tile returned to tilled-empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityHarvestSnapshot {
    pub parcel_id: String,
    pub cell_x: i32,
    pub cell_y: i32,
    pub species_name: String,
    pub cultivar_name: String,
    /// Produce item id (6_1xx) + quality-encoded variant + units minted.
    pub produce_item_id: u32,
    pub produce_variant_id: u32,
    pub produce_quality_milli: u16,
    pub produce_qty: u32,
    /// Offspring seed handle + count from mint_harvest_seed; qty 0 => sterile line.
    pub offspring_item_id: u32,
    pub offspring_variant_id: u32,
    pub offspring_qty: u32,
    /// Parent lineage (display), so the receipt reads "F<generation> of <cultivar>".
    pub generation: u16,
    /// true => perennial regrew (crop kept, progress reset); false => tile cleared.
    pub regrew: bool,
    pub tick: u64,
}

// ── FARM ITEM IDS + LAND ECONOMICS (6_3xx placeables; credit sink §F/§G) ────────
/// Auto-water radius sprinkler (offline autonomy; §C.2). The only farm structure
/// placeable in W3; greenhouse (6_302)/planter (6_303) land with W4.
/// Seed band (§0.5): 6_0xx, one item_id per species (Bio-Engineer owns names/
/// content; Agriculture only validates the band at plant time).
pub(super) const SEED_ITEM_ID_MIN: u32 = 6_000;
pub(super) const SEED_ITEM_ID_MAX: u32 = 6_099;
pub(super) fn is_seed_item(item_id: u32) -> bool {
    (SEED_ITEM_ID_MIN..=SEED_ITEM_ID_MAX).contains(&item_id)
}
pub(super) const IRRIGATION_SPRINKLER_ITEM_ID: u32 = 6_301;
pub(super) const FARM_STRUCTURE_STACK_CAP: u32 = 10;
// ── PRODUCE (6_1xx, Agriculture owns; one id per species) + FERTILIZER (6_3xx) ──
/// Produce band base (§0.5). produce_item_id(species) = PRODUCE_ID_BASE + species
/// offset within 6_0xx (Ashgrain seed 6_001 -> produce 6_101). `variant_id` is
/// quality-encoded (encode_produce_variant, model.rs) so quality bands never merge.
pub(super) const PRODUCE_ID_BASE: u32 = 6_100;
pub(super) const PRODUCE_STACK_CAP: u32 = 10_000;
/// Fertilizer consumables (§B.2/§C.4 lines). One kind per tile; consumed on apply.
pub(super) const FERTILIZER_SPEED_ITEM_ID: u32 = 6_310; // Growth Tonic
pub(super) const FERTILIZER_QUALITY_ITEM_ID: u32 = 6_311; // Quality Compost
pub(super) const FERTILIZER_YIELD_ITEM_ID: u32 = 6_312; // Yield Booster
pub(super) const FERTILIZER_STACK_CAP: u32 = 100;
/// Adopted-default fertilizer bonuses (§C.4; owner-tunable). Speed adds to the
/// per-watered-day growth increment (+50%), quality adds to per-good-day tending
/// realization (+40 milli, ~+67% over the base 60), yield multiplies harvest qty
/// (+50%). One kind per tile, so the lines never stack.
pub(super) const FERTILIZER_SPEED_GROWTH_BONUS_MILLI: u16 = 500;
pub(super) const FERTILIZER_QUALITY_TENDING_BONUS_MILLI: u16 = 40;
pub(super) const FERTILIZER_YIELD_BONUS_MILLI: u16 = 500;

/// Produce item id for a crop species seed id (Ashgrain seed 6_001 -> 6_101).
/// Only crop-band seeds map; anything else falls back to the base (defensive).
pub(super) fn produce_item_id_for_species(seed_item_id: u32) -> u32 {
    PRODUCE_ID_BASE.saturating_add(seed_item_id % 100)
}
pub(super) fn is_fertilizer_item(item_id: u32) -> bool {
    FertilizerKind::from_item_id(item_id).is_some()
}
/// Basic sprinkler auto-water radius (Chebyshev cells) -> 3x3 coverage. Tiered
/// coverage (Quality/Deep) is a future refinement; W3 ships the basic radius.
pub(super) const SPRINKLER_COVERAGE_RADIUS_CELLS: u32 = 1;
/// Upkeep cadence (§F5): a light periodic credit sink, ~one season (30 game-days).
pub(super) const PARCEL_UPKEEP_PERIOD_GAME_DAYS: u64 = 30;
/// TendPlot durable-intent cadence (ticks). The auto-tend loop waters dry tiles
/// and settles the plot every cadence while armed (§B.2 charm escape-valve).
pub(super) const TEND_PLOT_CADENCE_TICKS: u64 = 90;

/// TendPlot durable-intent state (SliceAuthorityState.plot_tending, keyed by actor
/// id). Mirrors the SampleResource loop precedent; breaks at cadence on move/stand/
/// area/death (checked in tick_plot_tending) or explicit stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlotTendingState {
    pub(super) parcel_id: String,
    pub(super) next_tend_tick: u64,
}

impl ParcelTier {
    /// One-time wallet-credit land price (the claim sink, §F/§G). Prime land is dear.
    pub(super) const fn claim_price_credits(self) -> u64 {
        match self {
            Self::Homestead => 500,
            Self::Farmstead => 1_500,
            Self::Plantation => 4_000,
        }
    }
    /// Light per-period credit upkeep (§F5: lapse pauses + weeds, NEVER confiscates).
    pub(super) const fn upkeep_cost_credits(self) -> u64 {
        match self {
            Self::Homestead => 50,
            Self::Farmstead => 150,
            Self::Plantation => 400,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_dims_derived_from_house_h1_hold_invariants() {
        for (tier, lot_cells) in [
            (ParcelTier::Homestead, 256),
            (ParcelTier::Farmstead, 576),
            (ParcelTier::Plantation, 1_024),
        ] {
            let (lot, build_zone, farm_yard) = derive_parcel_rects(tier, 100, 100);
            assert_eq!(lot.area_cells(), lot_cells, "{} lot", tier.id());
            // build_zone must hold the tier's house_h1 count (Plantation >= 4x).
            assert!(
                build_zone.area_cells() >= tier.house_count() * HOUSE_H1_FOOTPRINT_CELLS,
                "{} build_zone {} must hold {}x house_h1",
                tier.id(),
                build_zone.area_cells(),
                tier.house_count()
            );
            // build_zone + farm_yard tile the interior (no overlap, no gap).
            let interior_cells = (tier.lot_dim() - 2 * PARCEL_SETBACK_RING_CELLS).pow(2);
            assert_eq!(
                build_zone.area_cells() + farm_yard.area_cells(),
                interior_cells,
                "{} zones tile the interior",
                tier.id()
            );
        }
        // Plantation is the owner's "4x house_h1" tier explicitly.
        let (_, plantation_build, plantation_yard) =
            derive_parcel_rects(ParcelTier::Plantation, 0, 0);
        assert!(plantation_build.area_cells() >= 4 * HOUSE_H1_FOOTPRINT_CELLS);
        assert_eq!(
            plantation_yard.area_cells(),
            480,
            "Plantation yard matches §C.0"
        );
    }

    #[test]
    fn rect_containment_and_inflation() {
        let a = AuthorityRect::new(10, 10, 4, 4); // [10,14) x [10,14)
        assert!(a.contains_cell(AuthorityCell::new(10, 10)));
        assert!(a.contains_cell(AuthorityCell::new(13, 13)));
        assert!(!a.contains_cell(AuthorityCell::new(14, 10)));
        assert!(!a.contains_cell(AuthorityCell::new(9, 10)));
        // inflate grows the box by 1 on every side (the POI/road buffer primitive).
        let buffered = a.inflated(1); // [9,15) x [9,15)
        assert!(buffered.contains_cell(AuthorityCell::new(9, 9)));
        assert!(buffered.contains_cell(AuthorityCell::new(14, 14)));
        assert!(!buffered.contains_cell(AuthorityCell::new(15, 15)));
    }

    #[test]
    fn lattice_snap_covering_and_alignment() {
        // Round-to-nearest snap (half toward +INF), correct for negatives.
        assert_eq!(snap_to_lattice(803), 800);
        assert_eq!(snap_to_lattice(804), 808);
        assert_eq!(snap_to_lattice(797), 800);
        assert_eq!(snap_to_lattice(800), 800);
        assert_eq!(snap_to_lattice(-5), -8);
        assert_eq!(snap_to_lattice(-3), 0);
        // A lattice-aligned homestead maps to an exact 2x2 quantum block.
        let lat = LatticeRect::covering(&AuthorityRect::new(80, 80, 16, 16));
        assert_eq!((lat.qx, lat.qy, lat.qw, lat.qh), (10, 10, 2, 2));
        // Adjacency vs overlap in quantum space.
        let a = LatticeRect::covering(&AuthorityRect::new(80, 80, 16, 16)); // q[10,12)
        let edge = LatticeRect::covering(&AuthorityRect::new(96, 80, 16, 16)); // q[12,14)
        assert!(
            !a.intersects(&edge),
            "edge-adjacent lots share no quantum cell"
        );
        let over = LatticeRect::covering(&AuthorityRect::new(88, 80, 16, 16)); // q[11,13)
        assert!(a.intersects(&over), "overlapping lots share a quantum cell");
        // Outward alignment snaps an arbitrary buffer box to whole quantum cells.
        let aligned = lattice_align_outward(&AuthorityRect::new(3, 3, 7, 7)); // [3,10) -> [0,16)
        assert_eq!((aligned.x, aligned.y, aligned.w, aligned.h), (0, 0, 16, 16));
    }
}
