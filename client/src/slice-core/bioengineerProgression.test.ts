import { describe, expect, it } from "vitest";
import {
  professionDefinitions,
  skillNodeDefinitions,
  type SkillNodeState,
} from "./progressionSystem";

// The exact filter the skills window (client-3d ui/windows/defs/skillsWindow.ts)
// applies per profession before laying nodes on the row/column grid. If this
// selects all 18 bio-engineer nodes, the window renders the whole tree.
function renderableNodes(profession: string): SkillNodeState[] {
  return skillNodeDefinitions.filter(
    (node) =>
      node.profession === profession &&
      typeof node.row === "number" &&
      typeof node.column === "number",
  );
}

describe("bio-engineer progression tree (B2)", () => {
  it("registers the Bio-Engineer profession (progression spec parsed + valid on load)", () => {
    // Importing progressionSystem executes parseProgressionSpecs at module load;
    // reaching this assertion means the spec (now carrying bioengineer) is valid.
    expect(professionDefinitions.bioengineer).toBe("Bio-Engineer");
  });

  it("renders all 18 bio-engineer nodes in the skills-window grid", () => {
    const nodes = renderableNodes("bioengineer");
    expect(nodes).toHaveLength(18); // novice + 4 tracks x 4 tiers + master
    for (const node of nodes) {
      expect(typeof node.row).toBe("number");
      expect(typeof node.column).toBe("number");
      expect(node.grants.length).toBeGreaterThan(0);
    }
  });

  it("gates the hybrid novice on both Craftsman + Medic parent boxes (design §1.2)", () => {
    const novice = skillNodeDefinitions.find((node) => node.id === "bioengineer-novice");
    expect(novice).toBeDefined();
    expect(novice?.skillPointCost).toBe(16);
    expect(new Set(novice?.prerequisites)).toEqual(
      new Set(["craftsman-experimentation-ii", "medic-medical-crafting-ii"]),
    );
    expect(novice?.grants).toContain("Gene Sampler");
    expect(novice?.grants).toContain("Starter Seed Packet");
  });

  it("lays out four tracks on the canonical 8/6/4/2 curve at columns 0-3 (design §1.3)", () => {
    const columns: Record<string, number> = {
      sequencing: 0,
      splicing: 1,
      cultivation: 2,
      genelock: 3,
    };
    const skillPointCurve = [8, 6, 4, 2];
    const xpCurve = [100, 300, 650, 1100];
    for (const track of Object.keys(columns)) {
      const tierNodes = skillNodeDefinitions
        .filter((node) => node.profession === "bioengineer" && node.track === track)
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
      .filter((node) => node.profession === "bioengineer")
      .reduce((sum, node) => sum + (node.skillPointCost ?? 0), 0);
    expect(total).toBe(97);
  });

  it("caps with a master gated on all four track-IV boxes (design §1.3)", () => {
    const master = skillNodeDefinitions.find((node) => node.id === "bioengineer-master");
    expect(master?.skillPointCost).toBe(1);
    expect(master?.xpCost).toBe(1800);
    expect(new Set(master?.prerequisites)).toEqual(
      new Set([
        "bioengineer-sequencing-iv",
        "bioengineer-splicing-iv",
        "bioengineer-cultivation-iv",
        "bioengineer-genelock-iv",
      ]),
    );
  });
});
