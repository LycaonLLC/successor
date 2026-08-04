#!/usr/bin/env python3
"""Every string literal the native client draws must be renderable.

`hud::Icons` bakes ASCII 32..=126. A literal outside that range does not fail
anywhere: the built-in 5x7 path skips the glyph and advances the cursor, and the
rasterized path substitutes the font's .notdef box. Both ship a defect that only
a screenshot catches, and one round of that cost 16 wrong separators across
four surfaces (em dashes and middots reading as `?` in-game).

Player-authored text - chat, names, macro bodies - is NOT covered by this gate.
It arrives at runtime, must render as best it can, and never passes through a
source literal.

Exits non-zero and lists every offending literal.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / "client-rust" / "source"
# The renderer itself names the characters it bakes, and the font loader carries
# real Unicode in its coverage tables.
EXEMPT = {"engine-render/src/text.rs", "engine-render/src/font.rs"}
LITERAL = re.compile(r'"([^"\\]*)"')
# Diagnostics never reach the renderer: assertion messages, logs, and panics are
# read in a terminal, which has the whole font.
DIAGNOSTIC = re.compile(
    r"\b(assert|assert_eq|assert_ne|debug_assert|debug_assert_eq|debug_assert_ne"
    r"|panic|unreachable|todo|unimplemented|expect|println|eprintln|print|eprint"
    r"|write|writeln|format_args|log|trace|debug|info|warn|error)!?\s*\("
)
TEST_ATTR = re.compile(r"#\[(cfg\(test\)|test)\]")


def scannable(path: pathlib.Path) -> list[tuple[int, str]]:
    """Source lines outside `#[cfg(test)]` modules, with diagnostics dropped."""
    lines = path.read_text(encoding="utf-8").splitlines()
    out: list[tuple[int, str]] = []
    depth: int | None = None
    brace = 0
    for number, line in enumerate(lines, 1):
        if depth is None and TEST_ATTR.search(line):
            depth = 0
            brace = 0
        if depth is not None:
            brace += line.count("{") - line.count("}")
            if brace <= 0 and "{" in line:
                depth = None
            continue
        stripped = line.lstrip()
        if stripped.startswith("//") or DIAGNOSTIC.search(line):
            continue
        out.append((number, line))
    return out



def offenders() -> list[tuple[pathlib.Path, int, str, str]]:
    found: list[tuple[pathlib.Path, int, str, str]] = []
    for path in sorted(SOURCE.rglob("*.rs")):
        if str(path.relative_to(SOURCE)).replace("\\", "/") in EXEMPT:
            continue
        for number, line in scannable(path):
            for match in LITERAL.finditer(line):
                bad = {c for c in match.group(1) if ord(c) > 126}
                if bad:
                    found.append((path, number, "".join(sorted(bad)), line.strip()))
    return found


def main() -> int:
    found = offenders()
    if not found:
        print("drawable glyphs: PASS (no literal outside ASCII 32..=126)")
        return 0
    print(f"drawable glyphs: FAIL ({len(found)} literals will not rasterize)")
    for path, number, bad, line in found:
        print(f"  {path.relative_to(ROOT)}:{number}  {bad!r}  {line[:88]}")
    print("\nUse ASCII. The separator this codebase draws is ' - '.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
