# Asset Provenance Policy

Every shipped model, texture, matcap, icon, audio file, animation, and generated
world artifact must have an explainable source and a compatible license.

## Required record

For authored or generated content, record:

- stable asset id and runtime path;
- asset kind;
- authoring source path or deterministic build script;
- source license and redistribution status;
- source/input hashes where practical;
- generator, model, or tool version when generated;
- prompt and input assets when generative tooling was used;
- edits made after generation;
- reviewer and review date;
- runtime manifest, registry, or fixture references.

Provenance may live in a neighboring manifest, the PawnForge recipe, or the
content-pipeline manifest, but it must travel with a promoted asset. A filename
or Git commit is not a complete provenance record.

## Runtime roots

The audit scope includes:

- `client-3d/public/assets/`
- `client/public/successor-audio/`
- `client/public/successor-slice/`
- Bunker `~/dev/games/pawn-forge/pawnforgev2/` for source recipes

Purchased trial packs may stay as a cataloged selection library when their
license permits it. Promotion into the world requires a stable Successor id,
runtime mapping, provenance note, and visual verification.

## Generated media

Record prompts verbatim in private-safe manifests. Prompts and shipped metadata
must pass the project denylist and may not embed protected franchise names,
private reference-vault paths, credentials, or unrelated product namespaces.
Reference-conditioned work must list the inputs used.

Generated output is source only after review. Record material cleanup, topology
changes, retargeting, palette changes, audio editing, normalization, and other
human work that materially changed the result.

## GLB requirements

Promoted GLBs must identify their source `.blend` or deterministic builder and
carry the relevant checks:

- non-empty mesh and expected node/clip names;
- scale, ground plane, pivot, and bounds;
- material rule for the consuming render path;
- sockets or attachment metadata where applicable;
- collision or footprint metadata where applicable;
- successful runtime load and an in-camera visual proof.

PawnForge exports also keep the rig, palette/tint slots, attachment sockets,
animation manifest, and export recipe aligned.

## Audio requirements

Audio manifests record source, generator/provider and model where applicable,
prompt, duration, loudness treatment, loop status, and review status. A runtime
audio id must resolve to one manifest entry. Removed gameplay concepts do not
retain dedicated audio merely because the files are inexpensive.

## World generation

The open-desert source fixture and compiled bundle are generated artifacts with
deterministic inputs. Their generator and compiler are the provenance source.
Checked-in output must verify exactly against those tools.

## Rejection conditions

Do not ship an asset when its source or redistribution right is unclear, its
manifest points to a missing source, its runtime id is ambiguous, its generated
metadata exposes private paths, or its visual/audio proof does not match the
actual consuming client.
