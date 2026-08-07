"""Materialise the pinned bodies the refit reads: references and approved input.

Every catalogued garment was authored on the bodies that shipped at the branch
base commit. The refit needs those exact meshes to build its old -> new
deformation field, but the promotion overwrites two of the three paths in place,
so the references are checked out of git into a scratch directory instead of
being duplicated into the tree. `refined()` resolves the promotion's INPUT the
same way, so a worktree without the lab-only `humanoid-lab/` asset root still
rebuilds the bodies from source. Hashes are pinned throughout, so a wrong or
drifted checkout fails loudly rather than silently producing a bad fit.

    python3 reference_bodies.py
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import refit_config as CFG  # noqa: E402

BASE_COMMIT = "37da18de"

REFERENCES = {
    "male": ("client-3d/public/assets/pawn-pack/pawn_male.glb",
             "6eaac9062bcfbc5efdf40c64f9e3236402a0d81832f1e0e8f4ce9a0a4dacac42"),
    "male_bare": ("client-3d/public/assets/pawn-pack/pawn_male_bare.glb",
                  "5c182b3f7dcbb33a61965f633e66e820342f6d0f46746e30bce591a5b3182bca"),
    "female": ("client-3d/public/assets/pawn-pack/pawn_female.glb",
               "16d8c879aabc58b5ee176edcfc0b0dc43fc695e7d59f4a2ef6d6a15890e7d000"),
}

REFERENCE_DIR = os.path.join(CFG.BUILD_DIR, "reference")


def path_for(key: str) -> str:
    return os.path.join(REFERENCE_DIR, f"{key}.glb")


def _checkout(commit: str, tracked: str, destination: str, expected: str) -> None:
    """Write `commit:tracked` to `destination`, refusing a drifted blob."""
    if os.path.exists(destination) and hashlib.sha256(
            open(destination, "rb").read()).hexdigest() == expected:
        return
    payload = subprocess.run(["git", "show", f"{commit}:{tracked}"],
                             cwd=CFG.REPO, check=True, stdout=subprocess.PIPE).stdout
    digest = hashlib.sha256(payload).hexdigest()
    if digest != expected:
        raise SystemExit(f"{commit}:{tracked} is {digest}, expected {expected}")
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    with open(destination, "wb") as handle:
        handle.write(payload)


def refined() -> dict[str, str]:
    """The final approved bodies, hash-verified.

    These are handed to the lab as files rather than produced by it (`source/`,
    with a sidecar each), so there is nothing to materialise -- only to refuse.
    A missing or drifted body is fatal: promoting a body whose bytes nobody
    pinned is exactly the failure this check exists to prevent.
    """
    out = {}
    for body_id, path in CFG.REFINED.items():
        expected = CFG.REFINED_SHA[body_id]
        relative = os.path.relpath(path, CFG.REPO)
        if not os.path.exists(path):
            raise SystemExit(f"{body_id}: approved body {relative} is missing")
        digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
        if digest != expected:
            raise SystemExit(f"{body_id}: {relative} is {digest}, expected {expected}")
        out[body_id] = path
    return out


def promotion_inputs() -> dict[str, str]:
    """Return the final reviewed body artifacts without another shape pass.

    The Bunker refinement already owns both bodies' posterior and transition
    decisions. Reapplying the older female-only reduction here would silently
    deform the accepted female a second time.
    """
    return refined()


def materialise() -> dict[str, str]:
    os.makedirs(REFERENCE_DIR, exist_ok=True)
    out = {}
    for key, (tracked, expected) in REFERENCES.items():
        _checkout(BASE_COMMIT, tracked, path_for(key), expected)
        out[key] = path_for(key)
    return out


def _show(tracked: str) -> bytes:
    return subprocess.run(["git", "show", f"{BASE_COMMIT}:{tracked}"],
                          cwd=CFG.REPO, check=True, stdout=subprocess.PIPE).stdout


def stage_apparel(destination_dir: str, manifest: dict) -> dict[str, str]:
    """Check every catalogued apparel GLB out of the branch base commit.

    The refit writes over the catalogue in place, so the authored geometry has
    to come from git. Without this a second run would refit a refit and the
    garments would drift a little further from the body every time.
    """
    os.makedirs(destination_dir, exist_ok=True)
    out = {}
    for item in manifest["items"]:
        target = os.path.join(destination_dir, f"{item['id']}.glb")
        if not os.path.exists(target):
            live = os.path.normpath(os.path.join(
                CFG.EQUIPMENT, item["glb"]))
            tracked = os.path.relpath(live, CFG.REPO).replace(os.sep, "/")
            with open(target, "wb") as handle:
                handle.write(_show(tracked))
        out[item["id"]] = target
    return out


if __name__ == "__main__":
    for key, path in (materialise() | {f"refined_{k}": v
                                       for k, v in refined().items()}).items():
        print(f"[reference] {key}: {os.path.relpath(path, CFG.REPO)} ({os.path.getsize(path)} B)")
