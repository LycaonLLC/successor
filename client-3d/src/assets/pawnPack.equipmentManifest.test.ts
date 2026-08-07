import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPawnEquipmentManifestJson, toPawnEquipmentItem } from "./pawnPack";

/**
 * Equipment-manifest contract for server-owned rigid accessories: an entry
 * may carry `authorityItemId` (positive integer server item id — the row that
 * OWNS it) and `rigidAnchorBone` (non-empty live-skeleton bone the
 * ORIGIN-authored GLB root snaps to). The load path rejects malformed shapes
 * (fetchOptionalEquipmentManifest throws on guard failure), so a bad manifest
 * fails loudly instead of silently rendering nothing.
 */

// Vitest runs with cwd = client-3d.
const publicRoot = path.resolve(process.cwd(), "public");
const equipmentBase = "/assets/pawn-pack/equipment";
const manifestPath = path.join(publicRoot, "assets", "pawn-pack", "equipment", "manifest.json");

function manifestWithItem(overrides: Record<string, unknown>): unknown {
  return {
    items: [{
      id: "hat_field_cap",
      name: "Field Cap",
      layer: "Under",
      group: "Headwear — baseline",
      slot: "cranium",
      glb: "../../items/custom/accessories/field_cap.glb",
      ...overrides,
    }],
  };
}

describe("equipment manifest rigid-accessory contract", () => {
  it("accepts the optional authorityItemId + rigidAnchorBone pair", () => {
    expect(isPawnEquipmentManifestJson(manifestWithItem({ authorityItemId: 7203, rigidAnchorBone: "head" }))).toBe(true);
    // Both fields stay optional — classic skinned entries are untouched.
    expect(isPawnEquipmentManifestJson(manifestWithItem({}))).toBe(true);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ glbFemale: "Female/Under/Hat_Warm.glb" }))).toBe(true);
  });

  it("rejects malformed authorityItemId (string, fraction, non-positive)", () => {
    expect(isPawnEquipmentManifestJson(manifestWithItem({ authorityItemId: "7203" }))).toBe(false);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ authorityItemId: 7203.5 }))).toBe(false);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ authorityItemId: 0 }))).toBe(false);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ authorityItemId: -7203 }))).toBe(false);
  });

  it("rejects malformed rigidAnchorBone (empty, non-string)", () => {
    expect(isPawnEquipmentManifestJson(manifestWithItem({ rigidAnchorBone: "" }))).toBe(false);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ rigidAnchorBone: 12 }))).toBe(false);
  });

  it("rejects malformed female variant paths", () => {
    expect(isPawnEquipmentManifestJson(manifestWithItem({ glbFemale: 12 }))).toBe(false);
  });

  it("accepts optional string coverage arrays but rejects malformed entries", () => {
    expect(isPawnEquipmentManifestJson(manifestWithItem({ hideBodyZones: ["torso", "not_a_zone"] }))).toBe(true);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ hideBodyZones: "torso" }))).toBe(false);
    expect(isPawnEquipmentManifestJson(manifestWithItem({ hideBodyZones: ["torso", 3] }))).toBe(false);
  });
});

describe("toPawnEquipmentItem (load-path mapping)", () => {
  it("carries authorityItemId and rigidAnchorBone into the runtime item", () => {
    // Dropping either field would silently demote the rigid accessory to the
    // SkinnedMesh route, which attaches nothing for a rigid GLB.
    const item = toPawnEquipmentItem({
      id: "hat_field_cap",
      name: "Field Cap",
      layer: "Under",
      group: "Headwear — baseline",
      slot: "cranium",
      glb: "../../items/custom/accessories/field_cap.glb",
      authorityItemId: 7203,
      rigidAnchorBone: "head",
    });
    const femaleVariant = toPawnEquipmentItem({
      id: "under_tank",
      name: "Tank",
      layer: "Under",
      group: "Torso",
      slot: "under_tank",
      glb: "Under/Tank.glb",
      glbFemale: "Female/Under/Tank.glb",
    });
    expect(femaleVariant.glbFemale).toBe("Female/Under/Tank.glb");
    expect(item.authorityItemId).toBe(7203);
    expect(item.rigidAnchorBone).toBe("head");
    expect(item.requires).toEqual([]);
    // Classic entries stay classic: no phantom rigid fields.
    const classic = toPawnEquipmentItem({
      id: "hat_warm", name: "Warm Hat", layer: "Under", group: "Headwear — baseline", slot: "cranium", glb: "Under/Hat_Warm.glb",
    });
    expect(classic.authorityItemId).toBeUndefined();
    expect(classic.rigidAnchorBone).toBeUndefined();
  });

  it("keeps only canonical coverage zones and reports unknown declarations", () => {
    const manifest = manifestWithItem({ hideBodyZones: ["torso", "not_a_zone", "left_hand"] });
    if (!isPawnEquipmentManifestJson(manifest)) throw new Error("coverage manifest guard rejected string array");
    const reported: string[] = [];
    const item = toPawnEquipmentItem(
      manifest.items[0]!,
      (itemId, zone) => reported.push(`${itemId}:${zone}`),
    );
    expect(item.hideBodyZones).toEqual(["torso", "left_hand"]);
    expect(reported).toEqual(["hat_field_cap:not_a_zone"]);
  });
});

describe("shipped equipment manifest — 7203 Field Cap entry", () => {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));

  it("passes the runtime load-path guard", () => {
    expect(isPawnEquipmentManifestJson(parsed)).toBe(true);
  });

  it("declares hat_field_cap as the authority-owned rigid head accessory", () => {
    if (!isPawnEquipmentManifestJson(parsed)) throw new Error("guard rejected the shipped manifest");
    const entry = parsed.items.find((item) => item.id === "hat_field_cap");
    expect(entry).toMatchObject({
      slot: "cranium",
      authorityItemId: 7203,
      rigidAnchorBone: "head",
    });
    // The relative GLB path resolves to the custom (non-Synty) cap asset.
    const resolved = path.posix.normalize(`${equipmentBase}/${entry!.glb}`);
    expect(resolved).toBe("/assets/items/custom/accessories/field_cap.glb");
    expect(resolved).not.toContain("synty");
    expect(existsSync(path.join(publicRoot, resolved.slice(1)))).toBe(true);
    // Exactly one manifest entry claims item 7203 — no aliases.
    expect(parsed.items.filter((item) => item.authorityItemId === 7203)).toHaveLength(1);
  });
});
