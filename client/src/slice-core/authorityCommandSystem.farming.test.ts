import { describe, expect, it } from "vitest";
import {
  createAuthorityCommandQueue,
  enqueueAuthorityClaimParcelCommand,
  enqueueAuthorityAbandonParcelCommand,
  enqueueAuthorityRenameParcelCommand,
  enqueueAuthorityPayUpkeepCommand,
  enqueueAuthorityTillTileCommand,
  enqueueAuthorityPlantSeedCommand,
  enqueueAuthorityClearTileCommand,
  enqueueAuthorityWaterTileCommand,
  enqueueAuthorityTendPlotCommand,
  enqueueAuthorityPlaceFarmStructureCommand,
  enqueueAuthorityRemoveFarmStructureCommand,
  enqueueAuthorityFertilizeCommand,
  enqueueAuthorityHarvestCropCommand,
} from "./authorityCommandSystem";

// Wire test: each farming enqueue emits a Rust-ClientCommand-compatible envelope
// (snake_case keys, wire tags 69-79). Exercises every enqueue export (§B wire).
describe("authorityCommandSystem farming verbs", () => {
  it("emits Rust-compatible farming command envelopes", () => {
    const q = createAuthorityCommandQueue(3, 9);
    expect(enqueueAuthorityClaimParcelCommand(q, 40, "planet-a", "open-desert", 10, 12, "homestead").command).toEqual({
      ClaimParcel: { planet_id: "planet-a", area_id: "open-desert", x: 10, y: 12, tier: "homestead" },
    });
    expect(enqueueAuthorityAbandonParcelCommand(q, 41, "parcel:planet-a:1").command).toEqual({
      AbandonParcel: { parcel_id: "parcel:planet-a:1" },
    });
    expect(enqueueAuthorityRenameParcelCommand(q, 42, "parcel:planet-a:1", "Dune Hollow").command).toEqual({
      RenameParcel: { parcel_id: "parcel:planet-a:1", name: "Dune Hollow" },
    });
    expect(enqueueAuthorityPayUpkeepCommand(q, 43, "parcel:planet-a:1").command).toEqual({
      PayUpkeep: { parcel_id: "parcel:planet-a:1" },
    });
    expect(enqueueAuthorityTillTileCommand(q, 44, "parcel:planet-a:1", 3, 4).command).toEqual({
      TillTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 },
    });
    expect(enqueueAuthorityPlantSeedCommand(q, 45, "parcel:planet-a:1", 3, 4, "player:seed-pouch", "7", 42).command).toEqual({
      PlantSeed: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4, container: "player:seed-pouch", stack_id: "7", variant_id: 42 },
    });
    expect(enqueueAuthorityClearTileCommand(q, 46, "parcel:planet-a:1", 3, 4).command).toEqual({
      ClearTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 },
    });
    expect(enqueueAuthorityWaterTileCommand(q, 47, "parcel:planet-a:1", 3, 4).command).toEqual({
      WaterTile: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 },
    });
    expect(enqueueAuthorityTendPlotCommand(q, 48, "parcel:planet-a:1").command).toEqual({
      TendPlot: { parcel_id: "parcel:planet-a:1", stop: false },
    });
    expect(enqueueAuthorityTendPlotCommand(q, 49, "parcel:planet-a:1", true).command).toEqual({
      TendPlot: { parcel_id: "parcel:planet-a:1", stop: true },
    });
    expect(enqueueAuthorityPlaceFarmStructureCommand(q, 50, "parcel:planet-a:1", 6301, 3, 4).command).toEqual({
      PlaceFarmStructure: { parcel_id: "parcel:planet-a:1", structure_item_id: 6301, cell_x: 3, cell_y: 4 },
    });
    expect(enqueueAuthorityRemoveFarmStructureCommand(q, 51, "parcel:planet-a:1", "parcel:planet-a:1:struct:1").command).toEqual({
      RemoveFarmStructure: { parcel_id: "parcel:planet-a:1", structure_id: "parcel:planet-a:1:struct:1" },
    });
    expect(enqueueAuthorityFertilizeCommand(q, 53, "parcel:planet-a:1", 3, 4, "player:field-pack", "9", 0).command).toEqual({
      Fertilize: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4, container: "player:field-pack", stack_id: "9", variant_id: 0 },
    });
    expect(enqueueAuthorityHarvestCropCommand(q, 54, "parcel:planet-a:1", 3, 4).command).toEqual({
      HarvestCrop: { parcel_id: "parcel:planet-a:1", cell_x: 3, cell_y: 4 },
    });
    // Envelopes carry the queue's session/player + monotonic command ids.
    const first = enqueueAuthorityTillTileCommand(q, 52, "parcel:planet-a:1", 5, 5);
    expect(first.session).toBe(3);
    expect(first.player).toBe(9);
  });
});
