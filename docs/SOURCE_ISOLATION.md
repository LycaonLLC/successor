# Context Hygiene

This is the engineering rule for using external reference material without letting agent context turn into a pile of copied names, files, and assumptions.

## Workspace Rule

- External reference material stays outside this repository in the local
  reference vault.
- Keep raw reference dumps out of this repo. Product artifacts should be specs, manifests, generated outputs, review packets, and tooling.
- `tools/denylist/check.sh` fails tracked paths containing `reference/` and scans text artifacts for distinctive third-party terms.
- Reference access is logged with `just log-reference-access "subsystem: what was inspected"`.

## Spec Lane

The spec lane may inspect reference material and writes `spec/<subsystem>/` artifacts.

High-signal outputs:

- formulas and constants
- tables and field layouts
- state transitions
- event shapes
- RNG contract and draw order
- fixtures and expected distributions
- source-path citations for audit
- conflicts and uncertainty fields

Do not put raw source text, comments, class names, branded terms, lore, dialogue, asset filenames, or code-shaped pseudocode into specs. Specs should describe behavior in the project's own vocabulary.

## Implementation Lane

The implementation lane reads specs and writes product code.

- Treat specs without fixtures or expected distributions as not ready.
- Cite the spec ID in implementation commits when practical.
- If behavior is unclear, file a spec question instead of looking at the reference tree.
- Do not LLM-translate, paraphrase, or mechanically rewrite reference code into Rust, Python, TypeScript, shader code, asset scripts, or oracle runners.

## AI And Assets

- Prompts pass the denylist before storage or batch generation.
- Reference-conditioned generation inputs are allowed when recorded in the generated asset manifest. Keep the original reference files outside the product repo unless they are deliberately promoted as product assets.
- Generated assets need manifests with prompt, tool/version, seed or request ID, output hash, source URLs when applicable, and review status.
- `tools/provenance-audit/audit.py` is the CI hook for manifest coverage.

## Done Condition

A subsystem is implementation-ready only when the spec has schemas, fixtures, uncertainty notes, evidence notes, and a reviewer. Product code is judged against those artifacts, not against raw reference files.
