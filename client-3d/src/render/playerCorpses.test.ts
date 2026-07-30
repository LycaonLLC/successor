import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicMaterial, OrthographicCamera, Scene, Vector3, type Object3D } from "three";
import type { PlayState, ServerAuthorityPlayerCorpseState } from "@successor/client/src/slice-core/gameState";
import { OWN_CORPSE_STRAP_COLOR, OWN_CORPSE_TAG_COLOR, PlayerCorpsesRenderer } from "./playerCorpses";

function corpse(id: string, patch: Partial<ServerAuthorityPlayerCorpseState> = {}): ServerAuthorityPlayerCorpseState {
  return {
    id,
    ownerLabel: "Ashen Vek",
    areaId: "desert",
    cellX: 4,
    cellY: 5,
    x: 4,
    y: 5,
    expiryTick: 144_000,
    hasItems: true,
    creditsPresent: true,
    creditsCount: 230,
    isOwner: false,
    container: `corpse:${id}`,
    ...patch,
  };
}

function stateWith(corpses: ServerAuthorityPlayerCorpseState[]): PlayState {
  return {
    activeAreaId: "desert",
    serverAuthority: { playerCorpses: corpses },
  } as unknown as PlayState;
}

/** Top-down ortho camera centered on a world point — deterministic ray picks. */
function cameraOver(x: number, z: number): OrthographicCamera {
  const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
  camera.position.set(x, 20, z);
  camera.lookAt(new Vector3(x, 0, z));
  camera.updateMatrixWorld(true);
  return camera;
}

describe("player corpse bag renderer", () => {
  it("spawns one bag group per streamed AOI corpse row", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([corpse("player-corpse:1"), corpse("player-corpse:2", { x: 9, y: 9 })]));
    expect(renderer.liveCorpseIds().sort()).toEqual(["player-corpse:1", "player-corpse:2"]);
    const group = scene.getObjectByName("player-corpses")!;
    expect(group.children).toHaveLength(2);
    expect(scene.getObjectByName("player-corpse:player-corpse:1")!.position.x).toBeCloseTo(4.5);
    renderer.dispose();
  });

  it("despawns stale rows the frame they leave the stream", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([corpse("player-corpse:1"), corpse("player-corpse:2", { x: 9, y: 9 })]));
    renderer.update(stateWith([corpse("player-corpse:2", { x: 9, y: 9 })]));
    expect(renderer.liveCorpseIds()).toEqual(["player-corpse:2"]);
    expect(scene.getObjectByName("player-corpse:player-corpse:1")).toBeUndefined();
    renderer.dispose();
  });

  it("skips rows from other areas and follows position updates", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([corpse("player-corpse:3", { areaId: "elsewhere" })]));
    expect(renderer.liveCorpseIds()).toEqual([]);
    renderer.update(stateWith([corpse("player-corpse:4")]));
    renderer.update(stateWith([corpse("player-corpse:4", { x: 7, y: 8 })]));
    const root = scene.getObjectByName("player-corpse:player-corpse:4")!;
    expect(root.position.x).toBeCloseTo(7.5);
    expect(root.position.z).toBeCloseTo(8.5);
    renderer.dispose();
  });

  it("picks the bag under the cursor and reports honest loot facts", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([corpse("player-corpse:5", { creditsPresent: true, isOwner: true })]));
    scene.updateMatrixWorld(true);
    const pick = renderer.pickAtScreenPoint(cameraOver(4.5, 5.5), 200, 150, 400, 300);
    expect(pick).not.toBeNull();
    expect(pick!.corpseId).toBe("player-corpse:5");
    expect(pick!.ownerLabel).toBe("Ashen Vek");
    expect(pick!.isOwner).toBe(true);
    expect(pick!.creditsPresent).toBe(true);
    // Off-bag ray misses.
    expect(renderer.pickAtScreenPoint(cameraOver(20, 20), 200, 150, 400, 300)).toBeNull();
    renderer.dispose();
  });
});

function accentColors(root: Object3D): { tag: number; straps: number[] } {
  const tag = root.getObjectByName("tag") as Mesh;
  const straps = root.children.filter((child) => child.name === "strap") as Mesh[];
  return {
    tag: (tag.material as MeshBasicMaterial).color.getHex(),
    straps: straps.map((strap) => (strap.material as MeshBasicMaterial).color.getHex()),
  };
}

describe("own corpse bag accent", () => {
  it("gives the owner's bag amber straps and tag; other bags stay graphite", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([
      corpse("player-corpse:mine", { isOwner: true }),
      corpse("player-corpse:other", { x: 9, y: 9 }),
    ]));
    const mine = accentColors(scene.getObjectByName("player-corpse:player-corpse:mine")!);
    const other = accentColors(scene.getObjectByName("player-corpse:player-corpse:other")!);
    expect(mine.tag).toBe(OWN_CORPSE_TAG_COLOR);
    expect(mine.straps).toEqual([OWN_CORPSE_STRAP_COLOR, OWN_CORPSE_STRAP_COLOR]);
    expect(other.tag).toBe(0xb08d57);
    expect(other.straps).toEqual([0x17191b, 0x17191b]);
    renderer.dispose();
  });

  it("re-accents an existing bag in place when the streamed ownership flag changes", () => {
    const scene = new Scene();
    const renderer = new PlayerCorpsesRenderer(scene);
    renderer.update(stateWith([corpse("player-corpse:1")]));
    expect(accentColors(scene.getObjectByName("player-corpse:player-corpse:1")!).tag).toBe(0xb08d57);
    renderer.update(stateWith([corpse("player-corpse:1", { isOwner: true })]));
    expect(accentColors(scene.getObjectByName("player-corpse:player-corpse:1")!).tag).toBe(OWN_CORPSE_TAG_COLOR);
    renderer.dispose();
  });
});
