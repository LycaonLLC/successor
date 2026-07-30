import { describe, expect, it } from "vitest";
import { clientCommandEnvelopeSchema } from "./protocol";

// Wire test: the protocol Zod round-trips every farming ClientCommand (the server
// ingress boundary), and rejects malformed farming payloads (§B protocol layer).
function envelope(command: unknown) {
  return { session: 1, player: 1, command_id: 1, issued_at_tick: 0, command };
}

describe("protocol farming commands", () => {
  const valid: unknown[] = [
    { ClaimParcel: { planet_id: "planet-a", area_id: "open-desert", x: 10, y: 12, tier: "homestead" } },
    { AbandonParcel: { parcel_id: "parcel:planet-a:1" } },
    { RenameParcel: { parcel_id: "parcel:planet-a:1", name: "Test Parcel" } },
    { PayUpkeep: { parcel_id: "parcel:planet-a:1" } },
    { TillTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 } },
    { PlantSeed: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4, container: "player:seed-pouch", stack_id: "7", variant_id: 42 } },
    { ClearTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 } },
    { WaterTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 } },
    { TendPlot: { parcel_id: "parcel:planet-a:1", stop: false } },
    { TendPlot: { parcel_id: "parcel:planet-a:1" } }, // stop optional
    { PlaceFarmStructure: { parcel_id: "parcel:planet-a:1", structure_item_id: 6301, cell_x: 3, cell_y: 4 } },
    { RemoveFarmStructure: { parcel_id: "parcel:planet-a:1", structure_id: "parcel:planet-a:1:struct:1" } },
    { Fertilize: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4, container: "player:field-pack", stack_id: "9", variant_id: 0 } },
    { HarvestCrop: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 } },
  ];

  it("accepts every well-formed farming command", () => {
    for (const command of valid) {
      const parsed = clientCommandEnvelopeSchema.safeParse(envelope(command));
      expect(parsed.success, `expected ${Object.keys(command as object)[0]} to parse`).toBe(true);
    }
  });

  it("rejects malformed farming payloads", () => {
    // Missing required field.
    expect(clientCommandEnvelopeSchema.safeParse(envelope({ TillTile: { parcel_id: "p" } })).success).toBe(false);
    // Wrong type (variant_id must be a nonnegative int).
    expect(
      clientCommandEnvelopeSchema.safeParse(
        envelope({ PlantSeed: { parcel_id: "p", cell_x: 1, cell_y: 1, container: "c", stack_id: "1", variant_id: -1 } }),
      ).success,
    ).toBe(false);
    // Unknown extra key (strict).
    expect(clientCommandEnvelopeSchema.safeParse(envelope({ AbandonParcel: { parcel_id: "p", extra: 1 } })).success).toBe(false);
    // HarvestCrop is tile-addressed: a stray container key is rejected (strict).
    expect(clientCommandEnvelopeSchema.safeParse(envelope({ HarvestCrop: { parcel_id: "p", cell_x: 1, cell_y: 1, container: "c" } })).success).toBe(false);
    // Fertilize requires its container arm.
    expect(clientCommandEnvelopeSchema.safeParse(envelope({ Fertilize: { parcel_id: "p", cell_x: 1, cell_y: 1 } })).success).toBe(false);
  });
});
