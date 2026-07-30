# Risk Register

Updated 2026-07-13 for the consolidated 3D and TUI baseline.

## 1. Authority drift

**Signal:** a client, server helper, or fixture calculates movement, damage,
inventory, lifecycle, or resource results that disagree with Rust.

**Control:** keep gameplay mutations in `successor-sim`; test both clients
against the same command/state contracts; require authoritative receipts or
streamed state for end-to-end claims.

## 2. Parallel fixtures become parallel games

**Signal:** a feature needs a special world, command vocabulary, combat model,
or server mode that the generated open-desert world does not use.

**Control:** use small neutral builders for unit tests and the generated world
for integration. Add product behavior to the canonical topology instead of
maintaining a second runtime lane.

## 3. Cataloged content is mistaken for integrated content

**Signal:** asset counts, manifests, or UI previews are reported as playable
features even though no runtime registry or default-world path selects them.

**Control:** use the Integrated, Cataloged, and Source labels from
`CANONICAL_CONTEXT.md`. Promotion requires a runtime selection path and focused
proof.

## 4. 3D performance degrades as content is promoted

**Signal:** traversal or combat develops frame spikes, memory growth, shader
compilation stalls, excessive draw calls, or animation cost at fixture density.

**Control:** establish reproducible measurements from
`PERFORMANCE_BUDGET.md`; promote assets in measured groups; keep quality
fallbacks for shadows, particles, post-processing, and vegetation.

## 5. The TUI inherits graphical dependencies

**Signal:** the terminal package imports `client-3d`, DOM types, Three.js, or a
browser-only helper to share gameplay behavior.

**Control:** put renderer-neutral contracts in `client/`; keep the zero-GPU
check and TUI journeys mandatory when shared code changes.

## 6. Generated and packaged output goes stale

**Signal:** the desktop bundle, map bundle, command manifest, or ignored build
tree presents behavior or assets that source no longer contains.

**Control:** regenerate checked-in outputs from their source command, verify
byte-stable world output, clear obsolete ignored builds, and run
`pnpm desktop:build` after graphical or shared-client changes.

## 7. Repository size hides provenance and reachability

**Signal:** a large model, sound, proof image, or source pack cannot be tied to
a manifest, license, runtime registry, or deliberate source-library purpose.

**Control:** keep provenance beside promoted assets; distinguish source
libraries from runtime bundles; remove generated captures and caches from
source control; audit reachability before deleting newer creative work.

## 8. Documentation stops matching code

**Signal:** a current document names another client, fixture, port, authority,
combat path, or asset namespace.

**Control:** `CANONICAL_CONTEXT.md` owns topology,
`CURRENT_PROJECT_STATE.md` owns the dated inventory, and `VERIFICATION.md` owns
proof commands. The context gate blocks retired concepts in active paths.

## 9. Persistence migrations lose player state

**Signal:** roster, inventory, equipment, resource variants, or world state no
longer round-trips after a schema or content rename.

**Control:** preserve numeric identities where practical, isolate any necessary
read-time migration from current vocabulary, and run restart/persistence tests
before removing an old stored shape.

## 10. Verification consumes more effort than the game

**Signal:** bespoke harnesses and archived screenshots grow while the supported
clients lack a short reproducible path through the current systems.

**Control:** prefer focused unit tests, 3D/TUI journeys, generated-world checks,
and a small visual gate. Retire harnesses when their product lane is retired.
