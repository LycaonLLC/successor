# Contributing to Successor

This project uses source isolation. Read `docs/SOURCE_ISOLATION.md` first. Product code is built from specs and fixtures, not from raw reference files.

## Roles

For any subsystem you touch, you are one of:

- **Spec lane:** may inspect the reference vault. Writes specifications. Does not write product code on the same subsystem.
- **Implementation lane:** writes product code from specifications. Does not access the reference vault for the subsystem they implement.

You can work in the spec lane on subsystem A and implementation lane on subsystem B, but never both on the same subsystem.

## Workflow

### Spec lane

1. Inspect reference material under the external reference vault.
2. Log the inspection: `just log-reference-access "subsystem: what was inspected"`.
3. Author specification documents under `spec/<subsystem>/` conforming to `spec/_schema/spec_document.schema.json`.
4. Include `formulas`, `state_machines`, or `tables` plus `fixtures` (test vectors).
5. Cite reference paths under `reference_paths`. **Do not embed reference content.**
6. Review by another spec-lane contributor; approval required before implementation can start.

### Implementation lane

1. Read the spec documents under `spec/<subsystem>/`. Do not access the vault.
2. Implement the subsystem as a Rust crate under `crates/successor-<subsystem>/`.
3. Write tests covering replay hash, property tests, and distribution equivalence per `docs/VERIFICATION.md`.
4. Run `just mutate` to compute mutation score; record in the spec.
5. Review by another implementation-lane contributor; cite the spec ID in the commit message.

## Pre-commit

The pre-commit hook runs `tools/denylist/check.sh`. If it fails, fix the cause — do not bypass.

## CI

Required to pass:
- `tools/denylist/check.sh`
- `cargo test --workspace --release`
- `cargo build -p successor-wasm --target wasm32-unknown-unknown --release`
- `pnpm security:audit`
- `pnpm -r build`
- `pnpm test`
- `python3 tools/provenance-audit/audit.py`

## Asset contributions

Any AI-generated asset (model, texture, SFX, music, voice, animation) requires:

- A `<asset>.manifest.json` file conforming to
  `content-pipeline/generated_asset_manifest.schema.json` for
  `content-pipeline/` assets, or a runtime manifest/provenance file beside the
  promoted asset under `client-3d/public/assets/` or
  `client/public/successor-audio/`.
- The prompt logged verbatim, with the denylist version recorded.
- Art-director approval (`review.art_director` and `review.approved_at`).

Manifests without these fields fail CI.

## Out of scope for contributions

- Editing `tools/denylist/denylist.txt` outside the spec lane.
- Lifting, paraphrasing, or LLM-translating reference code into the product repo.
- Conditioning AI generation on reference assets (img2img, audio2audio, motion-matching against reference clips).
- Adding new direct dependencies without recording source, version, and reason in the appropriate package manifest or provenance record.

## Questions

If a question turns on source-boundary behavior, stop and write a spec question. Do not answer it by inspecting raw reference files from the implementation lane.
