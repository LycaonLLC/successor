"""Path resolution shared by the Dustgate redesign study scripts.

Importable without Blender so the pure-Python layout/QA passes can use it too.
"""

from __future__ import annotations

import os

STUDY_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(STUDY_DIR, "..", "..", "..", ".."))
PROOF_ROOT = os.path.join(
    REPO_ROOT, "verification", "ledgers", "artifacts", "dustgate-opus5-20260729"
)


def proof(*parts: str) -> str:
    """Absolute path inside the ignored proof root, creating parent dirs."""
    path = os.path.join(PROOF_ROOT, *parts)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    return path
