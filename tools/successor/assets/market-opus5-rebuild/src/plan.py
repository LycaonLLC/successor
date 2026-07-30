"""Authority contract + plan geometry for the market rebuild.

THE COORDINATE CONTRACT
=======================
The live authority layout is a 12 (column) x 9 (row) grid of 0.95 m cells,
indexed ZERO-BASED from the NORTH-WEST corner of the footprint.

  columns  c = 0..11  run WEST  -> EAST   (+x in glTF asset space)
  rows     r = 0..8   run NORTH -> SOUTH  (+z in glTF asset space)

glTF asset space (export space): +Y up, +Z is the public/front side.
    x = -5.700 + (c + 0.5) * 0.950
    z = -4.275 + (r + 0.5) * 0.950

Blender authoring space: +X east, +Y NORTH, +Z up. The public front is -Y,
which the exporter's Y-up conversion turns into glTF +Z. Therefore
    blender_x =  gltf_x
    blender_y = -gltf_z   ==   4.275 - (r + 0.5) * 0.950   (the "plan_y" of the brief)

Pass 1 used `(c - 0.5)` and `(r - 0.5)`, which shifted every service point one
full cell west and north. That is corrected here and asserted below.
"""

# ----------------------------------------------------------------- contract
COLS, ROWS = 12, 9
CELL = 0.95
FOOT_X = COLS * CELL / 2.0      # 5.700  half-width  (11.40 m overall)
FOOT_Y = ROWS * CELL / 2.0      # 4.275  half-depth  ( 8.55 m overall)
MAX_FOOTPRINT = (11.40, 8.55)
FLOOR_TOP = 0.02


def gltf_cell(c, r):
    """Zero-based (column,row) -> glTF asset-space cell centre (x, z)."""
    return (-FOOT_X + (c + 0.5) * CELL, -FOOT_Y + (r + 0.5) * CELL)


def cell(c, r):
    """Zero-based (column,row) -> BLENDER authoring cell centre (x, y_north)."""
    gx, gz = gltf_cell(c, r)
    return (gx, -gz)


def plan_y(r):
    """North-positive plan Y of a row centre (identical to blender y)."""
    return FOOT_Y - (r + 0.5) * CELL


# fixture cells required by the authority layout
FIXTURE_CELLS = {"bank": (3, 3), "trade": (6, 3), "assoc": (9, 3),
                 "trainer": (10, 6)}
CELLS = {k: cell(*cr) for k, cr in FIXTURE_CELLS.items()}
GCELLS = {k: gltf_cell(*cr) for k, cr in FIXTURE_CELLS.items()}


def cell_rect(c, r, pad=0.0):
    """Blender-space (x0, x1, y0, y1) of one whole cell, optionally shrunk."""
    cx, cy = cell(c, r)
    h = CELL / 2.0 - pad
    return (cx - h, cx + h, cy - h, cy + h)


# customer approach cell for each fixture, as (column,row) offsets.
# service row is approached from the south (the public side); the trainer
# consultation cell is approached from the north, out of the main hall.
APPROACH = {"bank": (3, 4), "trade": (6, 4), "assoc": (9, 4), "trainer": (10, 5)}


# ----------------------------------------------------------------- assertions
def _close(a, b, tol=1e-9):
    return abs(a - b) <= tol


def assert_contract(verbose=False):
    """Hard assertions on the four promised centres, in BOTH spaces."""
    # exact values quoted by the human review gate, in glTF asset space
    required_gltf = {"bank": (-2.375, -0.950), "trade": (0.475, -0.950),
                     "assoc": (3.325, -0.950), "trainer": (4.275, 1.900)}
    for k, (rx, rz) in required_gltf.items():
        gx, gz = GCELLS[k]
        assert _close(gx, rx, 1e-9), f"{k} glTF x {gx!r} != {rx!r}"
        assert _close(gz, rz, 1e-9), f"{k} glTF z {gz!r} != {rz!r}"
        bx, by = CELLS[k]
        assert _close(bx, rx, 1e-9), f"{k} blender x {bx!r} != {rx!r}"
        assert _close(by, -rz, 1e-9), f"{k} blender y {by!r} != {-rz!r}"
        # the brief's independent plan_y formula must agree
        r = FIXTURE_CELLS[k][1]
        assert _close(plan_y(r), -rz, 1e-9), f"{k} plan_y mismatch"
        if verbose:
            print(f"  OK {k:8s} cell{FIXTURE_CELLS[k]} -> glTF x={gx:+.3f} z={gz:+.3f}"
                  f"  | blender x={bx:+.3f} y={by:+.3f}")
    # grid sanity: zero-based extremes must land exactly half a cell inside
    assert _close(gltf_cell(0, 0)[0], -FOOT_X + CELL / 2)
    assert _close(gltf_cell(0, 0)[1], -FOOT_Y + CELL / 2)
    assert _close(gltf_cell(COLS - 1, ROWS - 1)[0], FOOT_X - CELL / 2)
    assert _close(gltf_cell(COLS - 1, ROWS - 1)[1], FOOT_Y - CELL / 2)
    # footprint contract
    assert _close(COLS * CELL, MAX_FOOTPRINT[0]), "footprint width"
    assert _close(ROWS * CELL, MAX_FOOTPRINT[1]), "footprint depth"
    if verbose:
        print(f"  OK grid {COLS}x{ROWS} @ {CELL} m -> "
              f"{COLS*CELL:.2f} x {ROWS*CELL:.2f} m centred on origin")
    return True


if __name__ == "__main__":
    print("Coordinate contract check (zero-based, NW origin):")
    assert_contract(verbose=True)
    print("\nApproach cells:")
    for k, (c, r) in APPROACH.items():
        gx, gz = gltf_cell(c, r)
        print(f"  {k:8s} approach cell({c},{r}) -> glTF x={gx:+.3f} z={gz:+.3f}")
    print("\nCONTRACT_OK")
