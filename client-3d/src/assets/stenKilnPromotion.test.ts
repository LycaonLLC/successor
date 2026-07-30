import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import itemModels from "../ui/inventory/itemModels.json";
import { weaponModelAssetKey } from "./weaponModelRegistry";

type WeaponManifest = {
  items: Array<{ id: string; glb: string; attach: string; class: string; track: string; tier_hint: string }>;
};

type Attach = {
  weapon: string;
  nodes: { frame: string; mag?: string };
  measured_runtime: { module_count: number };
};

const publicRoot = resolve(process.cwd(), "public");
const weaponsRoot = resolve(publicRoot, "assets/pawn-pack/weapons");
const manifest = JSON.parse(readFileSync(resolve(weaponsRoot, "weapons_manifest.json"), "utf8")) as WeaponManifest;

const REMOVED_ITEM_IDS = [3110, 3113, 3114, 3115, 3116, 3117] as const;

function weapon(id: string): WeaponManifest["items"][number] {
  const entry = manifest.items.find((item) => item.id === id);
  if (!entry) throw new Error(`missing weapon manifest entry ${id}`);
  return entry;
}

/** Count meshes in a GLB by reading its embedded JSON chunk (glTF 2.0 binary container). */
function glbMeshCount(glbPath: string): number {
  const buffer = readFileSync(glbPath);
  expect(buffer.readUInt32LE(0)).toBe(0x46546c67); // "glTF" magic
  const jsonChunkLength = buffer.readUInt32LE(12);
  expect(buffer.readUInt32LE(16)).toBe(0x4e4f534a); // "JSON" chunk type
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonChunkLength).toString("utf8")) as {
    meshes?: unknown[];
  };
  return gltf.meshes?.length ?? 0;
}

describe("approved-weapon cutover: STEN Mk II + Kiln Energy Cell", () => {
  it("keeps only 3111/3112 from the old 3110-3117 ranged item band and maps them to the custom GLBs", () => {
    expect(itemModels["3111"]).toBe("/assets/pawn-pack/weapons/custom/wpn_smg_sten_mk2.glb");
    expect(itemModels["3112"]).toBe("/assets/pawn-pack/weapons/custom/wpn_carbine_kiln.glb");
    expect(itemModels["3101"]).toBe("/assets/pawn-pack/weapons/custom/wpn_smg_sten_mk2.glb");
    expect(itemModels["3121"]).toBe("/assets/pawn-pack/weapons/custom/lightning_carbine.glb");
    for (const id of REMOVED_ITEM_IDS) {
      expect(itemModels).not.toHaveProperty(String(id));
    }
  });

  it("resolves only the approved item ids through the weapon registry; removed ids fall back to nothing", () => {
    expect(weaponModelAssetKey(3111, "slugthrower")).toBe("wpn_smg");
    expect(weaponModelAssetKey(3112, "slugthrower")).toBe("wpn_carbine");
    expect(weaponModelAssetKey(3101, "slugthrower")).toBe("wpn_smg");
    expect(weaponModelAssetKey(3121, "lightning-carbine")).toBe("lightning_carbine");
    for (const id of REMOVED_ITEM_IDS) {
      expect(weaponModelAssetKey(id, "slugthrower")).toBeNull();
    }
    // Abstract NPC weapon-class string routing stays intact.
    expect(weaponModelAssetKey(0, "wpn-smg")).toBe("wpn_smg");
    expect(weaponModelAssetKey(0, "slugthrower")).toBeNull();
  });

  it("ships both approved weapons as complete multi-mesh custom GLB packets", () => {
    for (const id of ["wpn_smg", "wpn_carbine"]) {
      const entry = weapon(id);
      expect(entry.glb.startsWith("custom/")).toBe(true);
      expect(entry.attach.startsWith("custom/")).toBe(true);
      const glbPath = resolve(weaponsRoot, entry.glb);
      const attachPath = resolve(weaponsRoot, entry.attach);
      expect(existsSync(glbPath)).toBe(true);
      expect(existsSync(attachPath)).toBe(true);
      const attach = JSON.parse(readFileSync(attachPath, "utf8")) as Attach;
      expect(attach.weapon).toBe(id);
      expect(attach.nodes.frame).toBe("Module_receiver");
      expect(attach.measured_runtime.module_count).toBe(8);
      expect(glbMeshCount(glbPath)).toBeGreaterThan(1);
    }
  });
  it("orders the promoted Marksman weapons as STEN B, Kiln A, then Lightning S", () => {
    expect(weapon("wpn_smg")).toMatchObject({
      class: "smg",
      track: "marksman",
      tier_hint: "B",
    });
    expect(weapon("wpn_carbine")).toMatchObject({
      class: "rifle",
      track: "marksman",
      tier_hint: "A",
    });
    expect(weapon("lightning_carbine")).toMatchObject({
      class: "rifle",
      track: "marksman",
      tier_hint: "S",
    });
  });
  it("ships the refined Lightning Carbine below its triangle gate with source and runtime provenance", () => {
    const entry = weapon("lightning_carbine");
    expect(entry).toMatchObject({
      glb: "custom/lightning_carbine.glb",
      attach: "custom/lightning_carbine_attach.json",
    });
    const glb = readFileSync(resolve(weaponsRoot, entry.glb));
    expect(createHash("sha256").update(glb).digest("hex"))
      .toBe("c1c17593f9ed5d58b87f815b434282880d7ba8688bea9ac37742f80921713989");
    const attach = JSON.parse(
      readFileSync(resolve(weaponsRoot, entry.attach), "utf8"),
    ) as {
      attach: string;
      scale_to_pawn: number;
      silhouette_class: string;
      nodes: { frame: string; mag: string };
      provenance: { triangles: number; deterministic: boolean };
    };
    expect(attach).toMatchObject({
      attach: "two_hand",
      scale_to_pawn: 1,
      silhouette_class: "rifle",
      nodes: { frame: "Module_receiver", mag: "Module_power_cell" },
      provenance: { triangles: 3446, deterministic: true },
    });
    expect(attach.provenance.triangles).toBeLessThanOrEqual(3500);
    const provenance = JSON.parse(
      readFileSync(resolve(weaponsRoot, "custom/lightning_carbine.provenance.json"), "utf8"),
    ) as {
      validation: {
        gltf_errors: number;
        triangle_budget_pass: boolean;
        frozen_socket_contract_pass: boolean;
        headed_runtime_pass: boolean;
        headed_runtime_run_id: string;
        headed_visual_reload_pass: boolean;
        client_render_synchronized_capture: boolean;
        headed_visual_proof_grid: string;
        headed_visual_reload_runs: { eject: string; drop: string; reseat: string };
      };
      review: { status: string };
    };
    expect(provenance.validation).toEqual(expect.objectContaining({
      gltf_errors: 0,
      triangle_budget_pass: true,
      frozen_socket_contract_pass: true,
      headed_runtime_pass: true,
      headed_runtime_run_id: "weapon-carbine-progression-final-20260715",
      headed_visual_reload_pass: true,
      client_render_synchronized_capture: true,
      headed_visual_proof_grid: "verification/ledgers/artifacts/client3d/weapon-carbine-reload-visual-reseat-final-20260715/proofs/h3d-carbine-progression-06-lightning-reload-grid.jpg",
      headed_visual_reload_runs: {
        eject: "weapon-carbine-reload-visual-eject-20260715",
        drop: "weapon-carbine-reload-visual-drop-20260715",
        reseat: "weapon-carbine-reload-visual-reseat-final-20260715",
      },
    }));
    expect(provenance.review.status).toBe("source-and-headed-runtime-visual-pass");
  });

});
