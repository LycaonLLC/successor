# Design language — Sinter-Frame Civic

Fresh art direction for the settlement market building. No inherited reference
image or brief was used; the only outside context read was the allowed terminal
manifests, which name the settlement *Dustgate* and establish a palette of
basalt, ceramic, brass, steel, teal glass and amber/cyan glow. The building is
authored to *host* those fixtures without copying their material system.

## 1. Tectonic premise

An inhabited desert planet has cheap local silica/basalt sand and expensive
imported industry. So the settlement builds in two clearly different ways, and
the building shows the seam:

- **Below 2.15 m — sintered basalt mass.** Solar-sintered from local sand into
  thick monolithic walls. Heavy, slightly battered (2 deg), warm dark grey, with
  casting lift-lines every ~0.72 m. It is thermal mass, sand-blast armour and
  ballast. It is made *on site*, so it is imprecise.
- **Above 2.15 m — imported ceramic-composite panel on a steel frame.** Thin,
  pale, precise, bolted, machine-made. It is the expensive part, so it is kept
  out of the abrasion zone.
- **The datum.** A continuous shadow reveal plus a brass drip flashing at
  2.15–2.30 m runs around the entire building, including the rear. This single
  horizontal line ties the whole composition and is the primary material
  transition. Everything else is subordinate to it.

Brass = anything a hand or the weather touches: flashing, door pulls, rails,
hoods, the entry medallion. Steel = structure and machinery. Ceramic = skin.
Sinter = ground.

## 2. Massing — four volumes, not one shed

1. **The Hall** (centre/south): tallest, eave 4.60, with a raised **clerestory
   monitor** to 5.85 running east–west. North face of the monitor is glazed
   (no direct sun); south face carries a **brise-soleil louver bank**.
2. **The Service Bar** (north/rear): a lower flat volume, eave 3.55, parapet
   3.85, roofed as an outdoor **plant deck** with condensers, cistern, mast and
   an access ladder. Reads unmistakably as back-of-house from outside.
3. **The Trainer Bay** (south-east): its own lower volume, eave 3.75, parapet
   4.00, with a deep-set brass-hooded window. Gives the trainer program an
   exterior identity instead of being an unmarked corner of the box.
4. **The Loggia** (south centre): *carved out of* the mass, not applied as a
   canopy. The two flanking base masses stay at Z=4.16 while the entry wall sets
   back to Z=2.92, giving a 1.24 m deep shaded threshold under a 3.15 m soffit.

The resulting silhouette steps 3.55 / 3.75 / 4.60 / 5.85 and is legible from the
pitched orthographic camera as four distinct roof planes, not one rectangle.

## 3. Entry sequence

Approach (south) -> deep shade of the loggia -> brass threshold and dust grate ->
2.0 m sliding door on an exposed steel track -> vestibule -> the hall opens up
under the clerestory. The door axis lands on the trade terminal, so the primary
interior axis is established from outside the building.

Above the opening: a brass-faced lintel, the exposed **door track, hangers and
counterweight**, and a single **geometric medallion** (concentric rings with
three notches). No lettering anywhere on the building.

## 4. Facade hierarchy (south)

base fillet 0–0.35 | sintered wall 0.35–2.15 with non-uniform pilaster
buttresses | reveal + brass flashing 2.15–2.30 | ceramic panel field 2.30–4.30
with a louvered service band only where BOH sits behind | eave drip 4.30–4.60.

Pilaster spacing is driven by plan (entry jambs, bulkhead line, trainer bay
wall), so it is deliberately irregular and cannot read as a stamped panel grid.

## 5. Interior zoning

- **Vestibule** (south centre): dust grate, threshold, sightline north.
- **Vendor / display** (west): authored market table, tiered display shelving,
  overhead rack, produce crates. This is the "market" of the market building.
- **Service row** (north, at Z=-1.9): bank, trade and association terminals each
  stand free in a **recessed alcove** in the interior bulkhead, under its own
  brass-framed geometric sign. Nothing is placed in front of them.
- **Queue / circulation** (centre): open hall with a brass queue rail defining
  the approach lane, clear of every terminal's 0.8 m front clearance.
- **Trainer bay** (south-east): consultation desk, trainer chair, visitor chair,
  kit locker, wall map board. Interaction cell kept fully walkable.
- **Back-of-house** (behind the bulkhead): storage shelving, collection counter,
  rear service door, plant nook with switchgear and cistern riser.

## 6. Wear logic — caused, never uniform

Wear is vertex-colour driven and each term has a stated cause:

- **Sand abrasion**: strongest 0–1.2 m on the windward (south/west) faces,
  lightening the sinter toward exposed aggregate. Absent on the lee faces.
- **Dust deposition**: on up-facing surfaces and in the lee of the prevailing
  south-west wind; heaviest on ledges, the flashing top and the plant deck.
- **Contact grime**: door jamb and pull at hand height, threshold, counter
  fronts, queue rail, chair backs, trainer desk edge — only where hands and feet
  actually go.
- **Water staining**: below the roof scuppers, the flashing drip and the cistern
  overflow, running *down* only.
- **Edge response**: baked ambient occlusion plus edge lightening on the sinter
  arrises, where a soft cast material chips.

## 7. Texture policy

Textures carry **micro** detail only — grain, pitting, mill marks, patina. Every
**macro** feature (panel joints, seams, reveals, bolts, louvers, buttresses) is
real geometry. This is the direct answer to "must not read as a texture stamp".
All maps are tileable at a single texel density of 409.6 px/m.

## 8. Colour

Ground sinter: warm dark grey-brown. Ceramic: pale bone with a faint warm cast.
Steel: cool dark graphite. Brass: desaturated gold, green-grey in the recesses.
Roof: chalky galvanised. Light: warm amber interior, cyan only as a service/
machine accent so it reads as equipment, matching the terminals' own accents.
