# Step 2 — architectural alternatives, compared bluntly

Five schemes were blocked out at flat-grey blockout fidelity and rendered from
the locked gameplay ortho camera plus a 3/4 eye view at 640 px / 32 samples.
Evidence: `proofs/alts/`. Command in `REPORT.md`.

| scheme | tris | verdict |
|---|---|---|
| A control — stacked stepped box | 228 | **reject.** Reproduces the rejected pass-1 language on purpose, as a baseline. Reads as one large roof box with parapet bands and a barcode louvre row. No focal element, no plan identity. |
| B vault hall | 1056 | **partially adopt.** The barrel shell is genuinely distinctive and instantly readable in elevation — the only curve in an orthogonal settlement. But 6 expressed ribs re-create the barcode from the top-down camera, and the shell floats over the mass because it only spans part of the plan. |
| C fold & towers | 496 | **partially adopt.** The asymmetric butterfly fold reads as two clearly different roof planes from the pitched ortho, which A never achieves. The unequal windcatcher towers plus cistern drum give a real skyline and honest service logic. Weakness: the roof plane is still a big plain field and the entrance is a flat slot under a thin canopy. Also broke the footprint (y=-5.62 vs -4.275 limit). |
| D colonnade ring | 444 | **reject.** A ring of near-identical piers is exactly the "reusable system without hierarchy" trap: 14 piers + a slat band read as repetition from every angle, and the inner volume is still just a box. |
| **E synthesis (chosen)** | 968 | **adopt.** Takes C's asymmetric butterfly fold + valley gutter + unequal towers + cistern drum as the massing and service logic; takes B's curvature but spends it on *exactly one* focal element — a curved vaulted entry hood that breaks the south eave — so the curve becomes identity instead of repetition. Adds a plan-stepped south facade (three different setbacks: loggia / hood / trainer bay) and a partial three-bay west loggia that is deliberately *not* a ring. |

## Why E wins

1. **Plan-readable silhouette.** Fold line, two unequal towers, drum, and arched
   hood are four different shapes at four different heights. A and D read as one
   rectangle; B reads as stripes.
2. **Unmistakable entrance.** The arch is the only curve on the building and it
   breaks the roofline, so the entry is the tallest event on the south face at
   human eye level and in plan. It is a market arrival, not a garage slot.
3. **Non-repeating hierarchy.** One curve, one fold, three unequal verticals,
   three unequal south setbacks, three unequal loggia bays.
4. **Honest service logic.** Butterfly valley -> east downpipe -> cistern drum ->
   rear plant. Water is scarce here, so collecting it is the visible parti.

## Defects in E carried into the full build as work items

- roof planes are still large plain fields -> need equipment curbs, walkway pad,
  crickets, standing seams at a *coarse* pitch, and drain furniture;
- the two towers are too similar in profile -> differentiate section and head;
- the loggia is cramped and its slats read as a repeated band;
- brass hood face reads as a thin outline -> must become a deep, modelled reveal;
- **footprint violation**: E measured y=[-4.41, 4.12] against the ±4.275 limit.
  Pass 1 also violated this (x=[-5.99, 5.775] vs ±5.70). The full build clamps
  every authored vertex inside 11.40 x 8.55 m and asserts it.
