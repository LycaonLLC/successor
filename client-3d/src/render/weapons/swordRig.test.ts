import { Bone, BoxGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { PawnPack, SlugthrowerAttachSpec } from "../../assets/pawnRigTypes";
import { SwordRig } from "./swordRig";

describe("SwordRig catalog melee models", () => {
  it("welds the selected melee GLB with its own attach transform and scale", () => {
    const hand = new Bone();
    hand.name = "hand_r";
    const scene = new Group();
    const frame = new Mesh(new BoxGeometry(0.05, 0.62, 0.04), new MeshBasicMaterial());
    frame.name = "scrapline_machete";
    scene.add(frame);
    const mountQuat = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.42);
    const spec: SlugthrowerAttachSpec = {
      mountPos: new Vector3(-0.01, 0.072, 0.016),
      mountQuat,
      sockets: {
        grip: new Vector3(),
        foregrip: new Vector3(0, 0.06, 0),
        muzzle: new Vector3(0, 0.5435, 0),
        stock: new Vector3(0, -0.0765, 0),
      },
      nodes: { frame: "scrapline_machete" },
      silhouetteClass: "melee",
    };
    const pack = {} as PawnPack;

    const rig = new SwordRig(pack, hand, null, spec, scene, 1.25, "melee:scrapline_machete");
    const root = hand.children[0]!;
    expect(root.name).toBe("melee:scrapline_machete");
    expect(root.position.toArray()).toEqual(spec.mountPos.toArray());
    expect(root.quaternion.toArray()).toEqual(spec.mountQuat.toArray());
    expect(root.scale.toArray()).toEqual([1.25, 1.25, 1.25]);
    expect(root.getObjectByName("scrapline_machete")).toBeDefined();

    rig.dispose();
    expect(hand.children).toEqual([]);
  });
});
