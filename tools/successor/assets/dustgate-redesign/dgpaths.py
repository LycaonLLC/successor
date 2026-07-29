"""Path resolution shared by the Dustgate redesign study scripts.

Importable without Blender so the pure-Python layout/QA passes can use it too.
"""

from __future__ import annotations

import os

STUDY_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(STUDY_DIR, "..", "..", "..", ".."))
ARTIFACT_ROOT = os.path.join(REPO_ROOT, "verification", "ledgers", "artifacts")

# First direction/massing study (lead milestone).
PROOF_ROOT = os.path.join(ARTIFACT_ROOT, "dustgate-opus5-20260729")
# Production pass: standalone building units, textures, LODs, proof.
PRODUCTION_ROOT = os.path.join(ARTIFACT_ROOT, "dustgate-opus5-production-20260729")


def _under(root: str, parts: tuple[str, ...]) -> str:
    path = os.path.join(root, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path


def proof(*parts: str) -> str:
    """Absolute path inside the first-study proof root, creating parent dirs."""
    return _under(PROOF_ROOT, parts)


def prod(*parts: str) -> str:
    """Absolute path inside the production proof root, creating parent dirs."""
    return _under(PRODUCTION_ROOT, parts)
