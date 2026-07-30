# Successor Audio Mix

The runtime audio source of truth is `manifest.json`; `manifest.provenance.json`
contains the same 114 clip records with source and review metadata. Every
manifest path must resolve to one MP3 in this directory, and every MP3 here must
be referenced by the manifest.

## Runtime buses

| Bus | Clips | Role |
|---|---:|---|
| `ambient_bed` | 3 | Settlement and weather loops |
| `ambient_spot` | 22 | Positional wildlife, campfire, and thunder |
| `foley` | 36 | Footsteps, movement, handling, and recovery |
| `gear` | 5 | Inventory, medicine, and survey equipment |
| `impacts` | 13 | Hits, deflections, ricochets, and downed cues |
| `music` | 10 | Menu, day/night, and combat rotations |
| `ui` | 10 | Panels, toolbar, notifications, chat, and denial |
| `weapons` | 13 | Roll-combat weapon presentation |
| `world` | 2 | Doors and area transitions |

## Mix rules

- Clip gain belongs in each manifest record; bus gain belongs in the manifest's
  `buses` object.
- Loop repairs and authored loop windows stay in provenance metadata.
- The open-desert runtime uses settlement ambience, distinct day/night music,
  sparse positional desert wildlife, rain, and thunder.
- Combat tracks are selected from the current open-desert rotation and duck the
  non-combat soundscape.
- New or replaced audio must update both manifests and pass the one-file-per-path
  inventory check before commit.

The retained source files were not re-encoded during the 2D cleanup. Fourteen
reusable wildlife clips were re-identified from the retired setting to neutral
open-desert IDs without changing their audio bytes.
