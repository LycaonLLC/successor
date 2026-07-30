# Allowed Read-Only Loose Props

These runtime files may be imported only as separate furnishing or service
fixtures. Do not modify their source files and do not use them to derive the
new building shell, built-ins, door, or texture system.

All paths below are relative to
`client-3d/public/assets/world-items/`.

## Required service fixtures

- `bank_terminal_civic.glb`
- `trade_terminal.glb`
- `pa_terminal.glb`

Their matching `*_manifest.json` and `*.provenance.json` files may be read for
scale, front-axis, interaction clearance, and provenance only.

## Optional market and seating props

- `stall_vendor.glb`
- `chair_frontier_a.glb`
- `chair_frontier_b.glb`
- `crate_cargo_heavy.glb`
- `crate_planked.glb`
- `barrel_ribbed.glb`
- `barrel_scav.glb`
- `battery_pack_industrial.glb`
- `footlocker_frontier.glb`

## Optional service/roof props

- `aircon_rooftop.glb`
- `antenna_comms.glb`
- `tank_water_frontier.glb`

Use the matching manifest/provenance file when one exists. Before finalizing,
record each imported prop's exact relative path and SHA-256 in the rebuild
manifest. An optional prop with missing provenance or failed strict GLB
validation must be omitted rather than silently accepted.
