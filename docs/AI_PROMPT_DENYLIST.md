# AI Prompt Denylist

This is the policy. The active term list lives at `tools/denylist/denylist.txt`.

## What the denylist catches

Distinctive terms from outside references whose mention in product artifacts suggests dirty context or weak creative direction. Examples of categories — never the items themselves in this document, which is itself a tracked file:

- Names of fictional characters from third-party works
- Names of fictional places, planets, regions, ships
- Names of fictional species, factions, organizations
- Names of fictional technologies, weapons, vehicles
- Distinctive lore terms unique to a third-party property
- Filenames associated with retail third-party assets
- Class and module names from third-party reference codebases

The list is maintained by the reference team. Implementation team members may not edit it.

## Where the denylist runs

1. **Local/staged-file check** — `bootstrap.sh` installs a local pre-commit
   hook that runs `tools/denylist/check.sh`; if the hook is absent, run
   `tools/denylist/check.sh --files <paths>` before committing risky prompts,
   specs, or generated manifests.
2. **CI gate** — `tools/denylist/check.sh` is the first job in the pipeline. Hits fail the build.
3. **Generation-time check** — the asset pipeline runs `tools/denylist/check.sh --prompt "$PROMPT"` before submitting any prompt to an external API. Hits abort the generation request.
4. **Manifest audit** — the provenance auditor re-runs the denylist against every recorded prompt, since the active list may have grown since generation.

## Adding terms

The reference team submits a PR adding a term with:

- The term itself
- The category (character, place, species, faction, technology, lore, filename, classname)
- The source (which reference inspection led to its inclusion)
- Notes on common false positives

False positives are accepted as a cost of the rule. The list errs strict.

## Removing terms

A term is removed after a documented review establishing that the term is generic, non-distinctive, or otherwise not useful as a context-hygiene signal. The removal goes through the reference reviewer.

## What the denylist does not catch

- Stylistic or aesthetic similarity. The denylist is a context-hygiene tripwire, not a substitute for creative direction in `PRODUCT_IDENTITY_BIBLE.md`.
- Sufficiently transformed names. If a prompt asks for a generic archetype that
  happens to resemble a protected reference, the denylist may not catch it.
  That is why prompt review and art direction exist.
- Music and audio similarity. (Handled by `ASSET_PROVENANCE_POLICY.md` provenance and review rules for conditioned inputs.)

## Exceptions

There are no per-file exceptions in tracked code or shipped artifacts. Exceptions exist only in `docs/` for documents that explain the policy itself (this file is the only one). Documentation about what we *don't* do may name what we don't do.
