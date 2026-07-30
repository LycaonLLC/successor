import { afterEach, describe, expect, it, vi } from "vitest";
import { Bone, BoxGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { SlugthrowerRig } from "./slugthrowerRig";
import type { PawnPack, SlugthrowerAttachSpec } from "../../assets/pawnRigTypes";

function spec(): SlugthrowerAttachSpec {
  return {
    mountPos: new Vector3(),
    mountQuat: new Quaternion(),
    sockets: {
      grip: new Vector3(0, -0.091, -0.218),
      foregrip: new Vector3(0, 0, 0.07),
      muzzle: new Vector3(0, 0, 0.142),
      stock: new Vector3(0, 0.0015, -0.5885),
    },
    nodes: { frame: "Module_receiver", mag: "Module_power_cell" },
    scale: 1,
  };
}

describe("SlugthrowerRig accepted multi-module scenes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every module mesh while retaining frame and reload-node contracts", () => {
    vi.stubGlobal("window", {});
    const weaponScene = new Group();
    const receiver = new Group();
    receiver.name = "Module_receiver";
    receiver.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.3), new MeshBasicMaterial()));
    const barrel = new Mesh(new BoxGeometry(0.03, 0.03, 0.2), new MeshBasicMaterial());
    barrel.name = "Module_barrel";
    const powerCell = new Mesh(new BoxGeometry(0.04, 0.04, 0.12), new MeshBasicMaterial());
    powerCell.name = "Module_power_cell";
    weaponScene.add(receiver, barrel, powerCell);

    const handR = new Bone();
    const rig = new SlugthrowerRig(
      {} as PawnPack,
      handR,
      null,
      null,
      null,
      null,
      spec(),
      weaponScene,
      1,
    );

    const weaponRoot = handR.children[0];
    expect(weaponRoot).toBeDefined();
    const names: string[] = [];
    weaponRoot?.traverse((object) => {
      if (object instanceof Mesh || object.name.startsWith("Module_")) names.push(object.name);
    });
    expect(names).toEqual(expect.arrayContaining(["Module_receiver", "Module_barrel", "Module_power_cell"]));
    expect(names.filter((name) => name.startsWith("Module_")).length).toBe(3);
    handR.updateMatrixWorld(true);
    expect(rig.getMuzzleWorld(new Vector3()).z).toBeCloseTo(0.142, 6);
    rig.dispose();
  });

  it("preserves the authored cell seat and drops a recursive clone in transformed-root space", () => {
    vi.stubGlobal("window", {});
    const worldRoot = new Group();
    worldRoot.position.set(4, 2, -3);
    worldRoot.rotation.set(0.1, 0.4, -0.2);
    const handR = new Bone();
    worldRoot.add(handR);

    const weaponScene = new Group();
    const receiver = new Group();
    receiver.name = "Module_receiver";
    receiver.add(new Mesh(new BoxGeometry(0.2, 0.2, 0.3), new MeshBasicMaterial()));
    const barrel = new Mesh(new BoxGeometry(0.03, 0.03, 0.2), new MeshBasicMaterial());
    barrel.name = "Module_barrel";
    const powerCell = new Group();
    powerCell.name = "Module_power_cell";
    powerCell.position.set(-0.0218, 0, -0.0785);
    const cellVisual = new Mesh(new BoxGeometry(0.04, 0.04, 0.12), new MeshBasicMaterial());
    cellVisual.name = "Cell_visual";
    powerCell.add(cellVisual);
    weaponScene.add(receiver, barrel, powerCell);

    const rig = new SlugthrowerRig(
      {} as PawnPack,
      handR,
      null,
      null,
      null,
      null,
      spec(),
      weaponScene,
      1,
    );
    const weaponRoot = handR.getObjectByName("weapon");
    const liveCell = weaponRoot?.getObjectByName("Module_power_cell");
    expect(liveCell?.position.toArray()).toEqual([-0.0218, 0, -0.0785]);

    rig.update(1, { elapsedS: 0.24, totalS: 1 }, "off");
    expect(liveCell?.position.x).toBeLessThan(-0.0218);
    worldRoot.updateMatrixWorld(true);
    const pulledWorld = liveCell?.getWorldPosition(new Vector3()).clone();

    rig.update(0, { elapsedS: 0.35, totalS: 1 }, "off");
    worldRoot.updateMatrixWorld(true);
    const fallenCell = worldRoot.children.find((child) => child.name === "Module_power_cell");
    expect(fallenCell).toBeDefined();
    expect(fallenCell?.getObjectByName("Cell_visual")).toBeDefined();
    expect(fallenCell?.visible).toBe(true);
    expect(liveCell?.visible).toBe(false);
    expect(fallenCell?.getWorldPosition(new Vector3()).distanceTo(pulledWorld ?? new Vector3())).toBeLessThan(1e-5);

    rig.update(1, { elapsedS: 0.95, totalS: 1 }, "off");
    expect(liveCell?.visible).toBe(true);
    expect(liveCell?.position.toArray()).toEqual([-0.0218, 0, -0.0785]);
    rig.dispose();
  });
});
