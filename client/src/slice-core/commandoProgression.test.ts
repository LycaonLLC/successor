import { describe, expect, it } from "vitest";
import {
  professionDefinitions,
  skillNodeDefinitions,
  type SkillNodeState,
} from "./progressionSystem";

// Mirrors the skills-window per-profession filter (client-3d skillsWindow.ts):
// nodes with a row+column render on the grid.
function renderableNodes(profession: string): SkillNodeState[] {
  return skillNodeDefinitions.filter(
    (node) =>
      node.profession === profession &&
      typeof node.row === "number" &&
      typeof node.column === "number",
  );
}

describe("commando progression tree (C3)", () => {
  it("registers the Commando profession (progression spec parsed + valid on load)", () => {
    expect(professionDefinitions.commando).toBe("Commando");
  });

  it("renders all 18 commando nodes in the skills-window grid", () => {
    const nodes = renderableNodes("commando");
    expect(nodes).toHaveLength(18); // novice + 4 tracks x 4 tiers + master
    for (const node of nodes) {
      expect(typeof node.row).toBe("number");
      expect(typeof node.column).toBe("number");
      expect(node.grants.length).toBeGreaterThan(0);
    }
  });

  it("gates the hybrid novice on both Marksman + Brawler parent boxes (elite guns)", () => {
    const novice = skillNodeDefinitions.find((node) => node.id === "commando-novice");
    expect(novice).toBeDefined();
    expect(novice?.skillPointCost).toBe(16);
    expect(new Set(novice?.prerequisites)).toEqual(
      new Set(["marksman-rifle-iv", "brawler-melee-iv"]),
    );
  });

  it("lays out four tracks on the canonical 8/6/4/2 curve at columns 0-3", () => {
    const columns: Record<string, number> = {
      "heavy-weapons": 0,
      demolitions: 1,
      suppression: 2,
      "field-hardening": 3,
    };
    const skillPointCurve = [8, 6, 4, 2];
    const xpCurve = [100, 300, 650, 1100];
    for (const track of Object.keys(columns)) {
      const tierNodes = skillNodeDefinitions
        .filter((node) => node.profession === "commando" && node.track === track)
        .sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
      expect(tierNodes).toHaveLength(4);
      tierNodes.forEach((node, tier) => {
        expect(node.column).toBe(columns[track]);
        expect(node.skillPointCost).toBe(skillPointCurve[tier]);
        expect(node.xpCost).toBe(xpCurve[tier]);
      });
    }
  });

  it("totals 97 skill points across the tree (canon full-profession cost)", () => {
    const total = skillNodeDefinitions
      .filter((node) => node.profession === "commando")
      .reduce((sum, node) => sum + (node.skillPointCost ?? 0), 0);
    expect(total).toBe(97);
  });

  it("caps with a master gated on all four track-IV boxes", () => {
    const master = skillNodeDefinitions.find((node) => node.id === "commando-master");
    expect(master?.skillPointCost).toBe(1);
    expect(master?.xpCost).toBe(1800);
    expect(new Set(master?.prerequisites)).toEqual(
      new Set([
        "commando-heavy-weapons-iv",
        "commando-demolitions-iv",
        "commando-suppression-iv",
        "commando-field-hardening-iv",
      ]),
    );
  });
});
