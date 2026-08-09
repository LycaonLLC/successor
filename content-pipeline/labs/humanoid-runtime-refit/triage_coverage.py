"""Split the catalogue's zero-mask items into "exposes skin" and "misfits".

An item with no `hideBodyZones` is not automatically a defect. A tank top, a
vest, shorts, a mohawk and an open-face helmet all correctly declare nothing:
they leave that skin on show. What IS a defect is an item that almost encloses a
zone -- it clearly means to cover it and misses by a few percent, which is
exactly where poke-through lives.

The line is drawn on the measurement, not the name: `NEAR_MISS_FLOOR` of a zone
enclosed means "intended to cover"; below it, the garment simply does not.

    blender --background --python triage_coverage.py
"""

from __future__ import annotations

import json
import os
import sys

LAB_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, LAB_DIR)

import body_zone_coverage as COV  # noqa: E402
import refit_config as CFG  # noqa: E402

GENERATOR = "successor content-pipeline/labs/humanoid-runtime-refit/triage_coverage.py"

#: A zone this enclosed is one the garment means to cover. Below it the garment
#: is a strap, a crop, an open helmet or hair -- exposure by design.
NEAR_MISS_FLOOR = 0.90


def main() -> None:
    with open(os.path.join(CFG.REPORT_DIR, "body_zone_coverage.json"),
              encoding="utf-8") as handle:
        report = json.load(handle)
    buckets: dict[str, list] = {"masked": [], "unattached": [],
                                "exposes_by_design": [], "near_miss": []}
    for item_id, item in report["items"].items():
        if item["hide_body_zones"]:
            buckets["masked"].append({"id": item_id,
                                      "zones": item["hide_body_zones"]})
            continue
        if not item["attached"]:
            buckets["unattached"].append({"id": item_id, "reason": item["reason"]})
            continue
        near = {}
        for body_id, zones in item["measurement"].items():
            for zone, values in zones.items():
                if values["covered_fraction"] >= NEAR_MISS_FLOOR:
                    entry = near.setdefault(zone, {})
                    entry[body_id] = [values["covered_fraction"],
                                      values["exposed_cm2"], values["worst_pose"]]
        record = {"id": item_id, "group": item["group"], "layer": item["layer"]}
        if near:
            record["near_zones"] = near
            buckets["near_miss"].append(record)
        else:
            record["best_zone_coverage"] = round(max(
                values["covered_fraction"]
                for zones in item["measurement"].values()
                for values in zones.values()), 5)
            buckets["exposes_by_design"].append(record)
    out = {"generator": GENERATOR, "near_miss_floor": NEAR_MISS_FLOOR,
           "counts": {key: len(value) for key, value in buckets.items()},
           **buckets}
    destination = os.path.join(CFG.REPORT_DIR, "coverage_triage.json")
    with open(destination, "w", encoding="utf-8") as handle:
        json.dump(out, handle, indent=2)
        handle.write("\n")
    print(f"[triage] {out['counts']}")
    for record in buckets["near_miss"]:
        zones = ", ".join(f"{zone} {min(v[0] for v in bodies.values()):.4f}"
                          for zone, bodies in record["near_zones"].items())
        print(f"[triage] near-miss {record['id']:32s} {record['group']:20s} {zones}")
    print(f"[triage] -> {os.path.relpath(destination, CFG.REPO)}")


if __name__ == "__main__":
    main()
