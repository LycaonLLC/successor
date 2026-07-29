# Naming Record: Dustgate Display Name

## 1. Brief

`Dustgate` is the legacy mechanical label only. This record proposes a replacement display name and performs no mechanical rename.

## 2. Screening method

Repository screening used these `tool.grep` calls, against the requested place, NPC, faction, and item-name surfaces:

- capitalized-identifier regex; path: `client/public/successor-slice`
- capitalized-identifier regex; path: `docs`
- capitalized-identifier regex; path: `crates/successor-sim`
- `(name|label|displayName)` label-field regex; path: `client/public/successor-slice`
- `(?i)(dustgate|ashvat|clone|verdance|warden|settlement|salvage)`; path: `client/public/successor-slice;docs;crates/successor-sim`
- quoted title-case string regex; path: `client/public/successor-slice;docs;crates/successor-sim`

This found the established nearby display names `Open Desert`, `Verdance Forest`, `Desert Wardens`, Dustgate, Knox Vale, GR0K, and the wildlife names Bellback, Pebblehorn, Snufflefin, Pocketclod, Mossmuff, and Dapplepod; none is a shortlist collision. Real-world/product screening used web searches for each finalist with `game OR product`: `"Leeward" game OR product`, `"Hushwall" game OR product`, `"Sill" game OR product`, `"Baffle" game OR product`, `"Rill" game OR product`, `"Tether" game OR product`, `"Vane" game OR product`, `"Knotworks" game OR product`, `"Lintel" game OR product`, `"Backwall" game OR product`, `"Dryline" game OR product`, and `"Hearthline" game OR product`. Results are recorded per candidate below, including the one without a notable named game/product result.

## 3. The shortlist

| Name | Pronunciation | Origin/rationale | Repo collision | Real-world collision | Verdict |
| --- | --- | --- | --- | --- | --- |
| Leeward | LEE-ward | A worn-down reference to the linear settlement on the sheltered side of the ancient windbreak. | None found | *Leeward: Episode 1* and Telescope Casual's Leeward furniture collection. | Reject: visible game and product uses. |
| Hushwall | HUSH-wall | Names the windbreak by the quiet it makes for the practical human structures in its lee. | None found | Hushoffice's hushWall office partition and a productivity app. | Reject: office-product association. |
| Sill | SILL | Treats the old construction as the foundation edge residents built their small works against. | None found | Sill Cats and Sill Sticks desktop-companion products. | Reject: active product family. |
| Baffle | BAF-ul | A trade word for a wind-deflecting structure, suitable for the old wall before it became a settlement. | None found | Baffle/Baffled games and industrial baffle products. | Reject: crowded generic term. |
| Rill | RILL | Refers to the narrow managed water run that would make the lee habitable on Ashvat. | None found | Rill Data, Rill Social, and other named software/products. | Reject: active technology-name use. |
| Tether | TETH-er | Comes from the salvage cables and hoist work that tie newer construction to irreproducible remnants. | None found | Tether/USDT is a prominent financial product, alongside game uses. | Reject: dominant financial association. |
| Vane | VAYN | A concise wind-reading name for residents who live by the protection and failure modes of the wall. | None found | *Vane* is a 2019 adventure game. | Reject: exact game title. |
| Knotworks | NOT-works | Recalls the patched joins where human maintenance meets older construction and clone-work infrastructure. | None found | Knot-tying games/kits and Knotwork drawing software. | Reject: craft/software overlap and long spoken form. |
| Lintel | LIN-tul | A practical survivor's name for the ancient structural span that shelters the settlement's newer, sparse works. | None found | Ordinary construction term; search found no notable exact game or branded product collision. | **Select.** |
| Backwall | BACK-wall | Marks the old windbreak as the settlement's literal back, with all maintained rooms laid out in its lee. | None found | Trade-show display systems and gaming uses call this a backwall. | Reject: exhibition-fixture association. |
| Dryline | DRY-line | Records the hard water boundary managed by a settlement on a dry world rather than a picturesque oasis. | None found | Meteorological term and several industrial/niche product uses. | Reject: broad technical/product use. |
| Hearthline | HARTH-line | Names the shared inhabited line under the low eaves, not a road, in the selected linear layout. | None found | Hearthline idle-builder/Roblox games and a fragrance/grooming brand. | Reject: exact settlement-game overlap. |

## 4. Selection

**Selected display name: Lintel** (LIN-tul). Residents can credibly inherit a structural term from the one older element that makes the site livable, then use it without explaining its origin. It is distinct from the repository's descriptive two-word biome names, named actor Knox Vale, and the playful wildlife vocabulary. At small UI size, seven familiar letters scan cleanly and do not look like a faction or protocol label. In speech it holds intact: people can say `Lintel`, `back to Lintel`, or simply `the Lint` without making the official name ornate.

## 5. Resident usage

- “Get the panels inside. Wind's turning. Back to Lintel.”
- “Clone works are open at Lintel, if the terminal still takes you.”
- “Meet me under the Lintel after second shade.”
- “The Lint's cistern is low. Don't wash tools there.”
- “No road out of Lintel. Take the terminal or walk.”

Natural shorthand: **the Lint**; a resident is a **Lintel local**, not a formal demonym.

## 6. Migration note

Canonical ids, fixture keys, asset paths, tests, and protocol values are unchanged in this lane. The display-name migration is a separate commit.
