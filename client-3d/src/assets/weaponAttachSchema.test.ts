// weaponAttachSchema.test.ts — the authored attach packets are the contract the
// Three runtime AND the native port both read. These assert the data itself, so
// a placeholder re-appearing (or a socket going missing) fails here rather than
// on someone's screen.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Euler, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

const PACK = join(__dirname, "../../public/assets/pawn-pack");
const CUSTOM = join(PACK, "weapons/custom");

interface StowSocket {
  space?: string;
  pos?: number[];
  rot_deg?: number[];
  arc_lift?: number;
}
interface AttachJson {
  weapon?: string;
  silhouette_class?: string;
  sockets?: Record<string, number[]>;
  stow_socket?: StowSocket;
  hold?: {
    resting_yaw_deg?: number;
    support_arm?: {
      min_elbow_bend_deg?: number;
      shoulder_advance_max_m?: number;
      elbow_pole_deg?: number;
    };
  };
  mount_hand_r_local?: { pos: number[]; quat: number[] };
}

function read(file: string): AttachJson {
  return JSON.parse(readFileSync(file, "utf8")) as AttachJson;
}

const attachFiles = [
  join(PACK, "slugthrower_attach.json"),
  join(PACK, "vibrosword_attach.json"),
  ...readdirSync(CUSTOM).filter((f) => f.endsWith("_attach.json")).map((f) => join(CUSTOM, f)),
];

/** The placeholder every packet used to carry, copied from the rifle contract. */
const PLACEHOLDER_POS = [0.16, 0, -0.14];
const PLACEHOLDER_ROT = [85, -45, 0];

describe("weapon attach packets", () => {
  it("every weapon authors a concrete stow socket", () => {
    // The native port reads stow_socket directly; a class fallback is invisible
    // to it, so "missing" is a real interop break, not a cosmetic gap.
    for (const file of attachFiles) {
      const doc = read(file);
      const stow = doc.stow_socket;
      expect(stow, `${file} has no stow_socket`).toBeDefined();
      expect(stow!.space).toBe("spine_03_local");
      expect(stow!.pos, `${file} stow pos`).toHaveLength(3);
      expect(stow!.rot_deg, `${file} stow rot_deg`).toHaveLength(3);
      expect(typeof stow!.arc_lift).toBe("number");
    }
  });

  it("no melee model still carries the rifle placeholder carry", () => {
    for (const file of attachFiles) {
      const doc = read(file);
      if (doc.silhouette_class !== "melee") continue;
      expect(
        doc.stow_socket!.pos!.every((v, i) => v === PLACEHOLDER_POS[i])
        && doc.stow_socket!.rot_deg!.every((v, i) => v === PLACEHOLDER_ROT[i]),
        `${file} still holds the placeholder rifle stow socket`,
      ).toBe(false);
    }
  });

  it("keeps the legacy Slugthrower and Vibrosword carries at their accepted values", () => {
    const slug = read(join(PACK, "slugthrower_attach.json")).stow_socket!;
    expect(slug.pos).toEqual([0.16, 0, -0.14]);
    expect(slug.rot_deg).toEqual([85, -45, 0]);

    const vibro = read(join(PACK, "vibrosword_attach.json")).stow_socket!;
    expect(vibro.pos).toEqual([-0.04, 0.25, -0.135]);
    expect(vibro.rot_deg).toEqual([91, 9, -93]);
  });

  it("carries the three melee_early models blade-down, not across the neck", () => {
    // This family's blade axis is local +Y. The shipped defect was a carry
    // that left that axis horizontal (measured +9.8 deg, tip out past the
    // shoulder at neck height); the accepted Vibrosword rakes down at -80.
    const D2R = Math.PI / 180;
    for (const id of ["scrapline_machete", "field_saber", "quarry_chopper"]) {
      const stow = read(join(CUSTOM, `${id}_attach.json`)).stow_socket!;
      const [rx, ry, rz] = stow.rot_deg as [number, number, number];
      const quat = new Quaternion().setFromEuler(new Euler(rx * D2R, ry * D2R, rz * D2R, "XYZ"));
      const blade = new Vector3(0, 1, 0).applyQuaternion(quat);
      expect(blade.y, `${id} blade must rake downward in spine-local space`).toBeLessThan(-0.85);

      // Flat against the back: the thickness axis (+Z) must point roughly
      // along the back normal, not sideways, or the blade carries edge-on.
      const face = new Vector3(0, 0, 1).applyQuaternion(quat);
      expect(Math.abs(face.z), `${id} must lie flat on the back`).toBeGreaterThan(0.9);
    }
  });

  it("gives the plasma hilt its own weld instead of the vibrosword's blade-origin offset", () => {
    const doc = read(join(CUSTOM, "plasma_hilt_attach.json"));
    expect(doc.weapon).toBe("plasma_sword");
    // The hilt's grip midpoint is near its own origin; the Vibrosword's is
    // 0.1525 m up the blade. The two mounts must therefore NOT be equal.
    const vibro = read(join(PACK, "vibrosword_attach.json"));
    expect(doc.mount_hand_r_local!.pos).not.toEqual(vibro.mount_hand_r_local!.pos);
    // Same family frame, so the rotation IS shared verbatim.
    expect(doc.mount_hand_r_local!.quat).toEqual(vibro.mount_hand_r_local!.quat);
    expect(doc.sockets!.emitter).toEqual([0, 0, 0.09]);
  });

  it("authors a support-wrist contact for every gun whose shroud is not the legacy radius", () => {
    for (const id of [
      "wpn_shotgun_coilgate_scatter", "wpn_heavy_bastion_lmg", "wpn_launcher_flare_net",
      "wpn_rifle_slagrail_vanguard", "lightning_carbine", "wpn_smg_sten_mk2", "wpn_pistol_badge_bolt",
    ]) {
      const sockets = read(join(CUSTOM, `${id}_attach.json`)).sockets!;
      const contact = sockets.foregrip_contact;
      expect(contact, `${id} needs an authored support contact`).toHaveLength(3);
      // Support hand rides UNDER the bore, never on or above it.
      expect(contact![1]).toBeLessThan(0);
    }
  });

  it("authors a resting yaw only where a long tail needed one", () => {
    for (const id of ["lightning_carbine", "wpn_heavy_bastion_lmg"]) {
      const hold = read(join(CUSTOM, `${id}_attach.json`)).hold;
      expect(hold?.resting_yaw_deg, `${id} needs an authored resting yaw`).toBeGreaterThan(10);
    }
    // The passing models must NOT have been retuned.
    for (const id of ["wpn_carbine_kiln", "wpn_smg_sten_mk2"]) {
      expect(read(join(CUSTOM, `${id}_attach.json`)).hold).toBeUndefined();
    }
    expect(read(join(PACK, "slugthrower_attach.json")).hold).toBeUndefined();
  });

  it("authors a support-arm hold only on the two guns whose contact is past the arm", () => {
    // Support arm reach on this skeleton is upperarm 0.325 + lowerarm 0.259 =
    // 0.584 m. These two models put their support contact 0.586-0.658 m from
    // the shoulder, so the solver ran out of arm and locked it straight.
    for (const id of ["wpn_shotgun_coilgate_scatter", "wpn_launcher_flare_net"]) {
      const arm = read(join(CUSTOM, `${id}_attach.json`)).hold?.support_arm;
      expect(arm, `${id} needs an authored support-arm hold`).toBeDefined();
      // Both halves or the block is ignored by both runtimes.
      expect(arm!.min_elbow_bend_deg).toBeGreaterThan(0);
      expect(arm!.min_elbow_bend_deg).toBeLessThanOrEqual(80);
      expect(typeof arm!.elbow_pole_deg).toBe("number");
      // The girdle assist is a scapula, not a dislocation.
      expect(arm!.shoulder_advance_max_m!).toBeGreaterThan(0);
      expect(arm!.shoulder_advance_max_m!).toBeLessThanOrEqual(0.12);
    }
    // Every model that already posed correctly keeps the legacy unposed solve.
    for (const file of attachFiles) {
      if (/wpn_shotgun_coilgate_scatter|wpn_launcher_flare_net/.test(file)) continue;
      expect(read(file).hold?.support_arm, `${file} must not have been retuned`).toBeUndefined();
    }
  });
});
