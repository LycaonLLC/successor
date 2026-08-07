#!/usr/bin/env python3
"""Perf, size, runtime, render, and terrain gates for the Successor Rust client.

In addition to Criterion and process-level runtime measurements, the GPU gates
track the material-parity and terrain-material scenes. Every check enforces the
absolute ceilings in ../budgets.json before applying baseline-relative slack.
"""


import argparse
import datetime
import json
import platform
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE_DIR = ROOT / "bench" / "baselines"
CRITERION_DIR = ROOT / "target" / "criterion"
BUDGETS_PATH = ROOT / "budgets.json"


def load_budgets() -> dict:
    return json.loads(BUDGETS_PATH.read_text()) if BUDGETS_PATH.is_file() else {}


def machine_id() -> str:
    os_name = platform.system().lower()
    arch = platform.machine().lower()
    cpu = ""
    if os_name == "darwin":
        cpu = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True,
        ).stdout.strip()
    elif os_name == "linux":
        try:
            for line in Path("/proc/cpuinfo").read_text().splitlines():
                if line.lower().startswith("model name"):
                    cpu = line.split(":", 1)[1].strip()
                    break
        except OSError:
            pass
    slug = re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", cpu.lower())).strip("-")
    return "-".join(p for p in (os_name, arch, slug) if p)


def rustc_version() -> str:
    return subprocess.run(
        ["rustc", "--version"], capture_output=True, text=True
    ).stdout.strip()


def baseline_path() -> Path:
    return BASELINE_DIR / f"{machine_id()}.json"


def collect_criterion() -> dict:
    """{bench_id: median_ns} from target/criterion/**/new/estimates.json."""
    if not CRITERION_DIR.is_dir():
        return {}
    out = {}
    for est in CRITERION_DIR.rglob("new/estimates.json"):
        rel = est.relative_to(CRITERION_DIR)
        if "report" in rel.parts:
            continue
        bench_dir = est.parent
        bid = None
        bj = bench_dir / "benchmark.json"
        if bj.is_file():
            bid = json.loads(bj.read_text()).get("full_id")
        if not bid:
            bid = "/".join(rel.parts[:-2])
        median = json.loads(est.read_text())["median"]["point_estimate"]
        out[bid] = float(median)
    return out


def read_sizes(native: str, wasm: str) -> dict:
    sizes = {}
    for key, p in (("native_stripped", native), ("wasm_stripped", wasm)):
        if p is None:
            continue
        path = Path(p)
        if not path.is_file():
            sys.exit(f"error: {path} not found — run the strip step first")
        sizes[key] = path.stat().st_size
    return sizes


def read_runtime(stats: str) -> dict:
    path = Path(stats)
    if not path.is_file():
        sys.exit(f"error: {path} not found — run `make runtime-check` producing it")
    j = json.loads(path.read_text())
    return {
        "frame_p50_ms": float(j["frame_p50_ms"]),
        "frame_p99_ms": float(j["frame_p99_ms"]),
        "peak_rss_bytes": int(j["peak_rss_bytes"]),
        "frame_allocs_steady": int(j["frame_allocs_steady"]),
    }


def read_render(stats: str) -> dict:
    path = Path(stats)
    if not path.is_file():
        sys.exit(f"error: {path} not found — run `make render-check` producing it")
    j = json.loads(path.read_text())
    return {"render_gpu_p99_ms": float(j["render_gpu_p99_ms"])}


def read_terrain(stats: str) -> dict:
    path = Path(stats)
    if not path.is_file():
        sys.exit(f"error: {path} not found — run `make terrain-check` producing it")
    j = json.loads(path.read_text())
    return {"render_gpu_p99_ms": float(j["render_gpu_p99_ms"])}

def load_baseline() -> dict:
    path = baseline_path()
    if not path.is_file():
        print(f"FAIL: no baseline for this machine ({machine_id()}).")
        print(f"  expected: {path.relative_to(ROOT)}")
        print("  create one with: make bench-baseline   (then check it in)")
        sys.exit(1)
    return json.loads(path.read_text())


def cmd_capture(args) -> None:
    benches = collect_criterion()
    path = baseline_path()
    prev = {}
    if path.is_file():
        prev = json.loads(path.read_text()).get("benches", {})

    def entry(bid: str, median: float) -> dict:
        e = {"median_ns": round(median, 2)}
        if "max_regress_pct" in prev.get(bid, {}):
            e["max_regress_pct"] = prev[bid]["max_regress_pct"]
        return e

    data = {
        "machine": machine_id(),
        "rustc": rustc_version(),
        "date": datetime.date.today().isoformat(),
        "benches": {k: entry(k, v) for k, v in sorted(benches.items())},
    }
    if args.native or args.wasm:
        data["sizes"] = read_sizes(args.native, args.wasm)
    if args.runtime:
        data["runtime"] = read_runtime(args.runtime)
    if args.render:
        data["render"] = read_render(args.render)
    if args.terrain:
        data["terrain"] = read_terrain(args.terrain)
    BASELINE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"baseline written: {path.relative_to(ROOT)} ({len(benches)} benches) — review and commit it.")


def warn_rustc(base: dict) -> None:
    cur = rustc_version()
    if base.get("rustc") and base["rustc"] != cur:
        print("WARN: rustc differs from baseline — deltas may be toolchain-caused")
        print(f"  baseline: {base['rustc']}\n  current:  {cur}")


def check_perf(base: dict, budgets: dict) -> bool:
    current = collect_criterion()
    if not current:
        sys.exit("error: no criterion estimates — run `make bench` first")
    default_limit = float(budgets.get("regression", {}).get("perf_max_regress_pct", 10.0))
    ok = True
    for bid, entry in sorted(base.get("benches", {}).items()):
        limit = float(entry.get("max_regress_pct", default_limit))
        old = entry["median_ns"]
        if bid not in current:
            print(f"FAIL {bid}: in baseline but not in this run (renamed/removed? re-baseline deliberately)")
            ok = False
            continue
        new = current[bid]
        delta = (new - old) / old * 100.0
        if delta > limit:
            print(f"FAIL {bid}: {old:.0f}ns -> {new:.0f}ns ({delta:+.1f}% > +{limit:.0f}%)")
            ok = False
        elif delta < -limit:
            print(f"note {bid}: {delta:+.1f}% faster — consider `make bench-baseline`")
        else:
            print(f"ok   {bid}: {delta:+.1f}%")
    for bid in sorted(set(current) - set(base.get("benches", {}))):
        print(f"WARN {bid}: not in baseline — `make bench-baseline` to track it")
    return ok


def check_size(base: dict, budgets: dict, native: str, wasm: str) -> bool:
    current = read_sizes(native, wasm)
    reg = budgets.get("regression", {})
    slack_bytes = int(reg.get("size_max_growth_bytes", 2048))
    slack_pct = float(reg.get("size_max_growth_pct", 1.0))
    ceilings = budgets.get("sizes", {})
    ceiling_key = {"native_stripped": "native_stripped_max_bytes",
                   "wasm_stripped": "wasm_stripped_max_bytes"}
    ok = True
    for key, new in current.items():
        # Absolute ceiling (hard budget).
        cap = ceilings.get(ceiling_key[key])
        if cap is not None and new > cap:
            print(f"FAIL size/{key}: {new}B > ceiling {cap}B (budgets.json)")
            ok = False
        # Baseline-relative regression.
        old = base.get("sizes", {}).get(key)
        if old is None:
            print(f"WARN size/{key}: not in baseline — re-baseline to track it")
            continue
        slack = max(slack_bytes, old * slack_pct / 100.0)
        delta = new - old
        if delta > slack:
            print(f"FAIL size/{key}: {old}B -> {new}B (+{delta}B > +{slack:.0f}B slack)")
            print("  attribute with: cargo bloat --release -p successor-client")
            ok = False
        else:
            print(f"ok   size/{key}: {old}B -> {new}B ({delta:+d}B)")
    return ok


def check_runtime(base: dict, budgets: dict, stats: str) -> bool:
    current = read_runtime(stats)
    reg = budgets.get("regression", {})
    rt = budgets.get("runtime", {})
    ok = True

    # Hard ceilings.
    alloc_cap = rt.get("frame_allocs_steady_max", 0)
    if current["frame_allocs_steady"] > alloc_cap:
        print(f"FAIL runtime/frame-allocs: {current['frame_allocs_steady']} > ceiling {alloc_cap}")
        ok = False
    else:
        print(f"ok   runtime/frame-allocs: {current['frame_allocs_steady']}")

    rss_cap = rt.get("peak_rss_max_bytes")
    if rss_cap is not None and current["peak_rss_bytes"] > rss_cap:
        print(f"FAIL runtime/peak-rss: {current['peak_rss_bytes']}B > ceiling {rss_cap}B")
        ok = False
    else:
        print(f"ok   runtime/peak-rss: {current['peak_rss_bytes']}B")

    p99_cap = rt.get("frame_p99_max_ms", {}).get(machine_id())
    if p99_cap is not None and current["frame_p99_ms"] > p99_cap:
        print(f"FAIL runtime/frame-p99: {current['frame_p99_ms']:.3f}ms > ceiling {p99_cap}ms")
        ok = False
    else:
        print(f"ok   runtime/frame-p99: {current['frame_p99_ms']:.3f}ms")

    # Baseline-relative regressions.
    b = base.get("runtime")
    if b:
        rss_pct = float(reg.get("rss_max_regress_pct", 5.0))
        perf_pct = float(reg.get("perf_max_regress_pct", 10.0))
        for key, pct in (("peak_rss_bytes", rss_pct), ("frame_p99_ms", perf_pct)):
            old = b.get(key)
            if not old:
                continue
            delta = (current[key] - old) / old * 100.0
            if delta > pct:
                print(f"FAIL runtime/{key}: {old} -> {current[key]} ({delta:+.1f}% > +{pct:.0f}%)")
                ok = False
            else:
                print(f"ok   runtime/{key}: {delta:+.1f}%")
    return ok


def check_render(base: dict, budgets: dict, stats: str) -> bool:
    current = read_render(stats)
    value = current["render_gpu_p99_ms"]
    cap = budgets.get("render", {}).get("gpu_p99_max_ms", {}).get(machine_id())
    ok = True
    if cap is not None and value > cap:
        print(f"FAIL render/gpu-p99: {value:.3f}ms > ceiling {cap}ms")
        ok = False
    else:
        print(f"ok   render/gpu-p99: {value:.3f}ms")

    old = base.get("render", {}).get("render_gpu_p99_ms")
    if old:
        limit = float(budgets.get("regression", {}).get("perf_max_regress_pct", 10.0))
        delta = (value - old) / old * 100.0
        if delta > limit:
            print(f"FAIL render/gpu-p99: {old}ms -> {value}ms ({delta:+.1f}% > +{limit:.0f}%)")
            ok = False
        else:
            print(f"ok   render/gpu-p99 regression: {delta:+.1f}%")
    else:
        print("WARN render/gpu-p99: not in baseline — re-baseline to track it")
    return ok

def check_terrain(base: dict, budgets: dict, stats: str) -> bool:
    current = read_terrain(stats)
    value = current["render_gpu_p99_ms"]
    cap = budgets.get("terrain", {}).get("gpu_p99_max_ms", {}).get(machine_id())
    ok = True
    if cap is not None and value > cap:
        print(f"FAIL terrain/gpu-p99: {value:.3f}ms > ceiling {cap}ms")
        ok = False
    else:
        print(f"ok   terrain/gpu-p99: {value:.3f}ms")

    old = base.get("terrain", {}).get("render_gpu_p99_ms")
    if old:
        limit = float(budgets.get("regression", {}).get("perf_max_regress_pct", 10.0))
        delta = (value - old) / old * 100.0
        if delta > limit:
            print(f"FAIL terrain/gpu-p99: {old}ms -> {value}ms ({delta:+.1f}% > +{limit:.0f}%)")
            ok = False
        else:
            print(f"ok   terrain/gpu-p99 regression: {delta:+.1f}%")
    else:
        print("WARN terrain/gpu-p99: not in baseline — re-baseline to track it")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    cap = sub.add_parser("capture")
    cap.add_argument("--native")
    cap.add_argument("--wasm")
    cap.add_argument("--runtime")
    cap.add_argument("--render")
    cap.add_argument("--terrain")
    chk = sub.add_parser("check")
    chk.add_argument("--perf", action="store_true")
    chk.add_argument("--size", action="store_true")
    chk.add_argument("--runtime")
    chk.add_argument("--render")
    chk.add_argument("--terrain")
    chk.add_argument("--native")
    chk.add_argument("--wasm")
    sub.add_parser("machine-id")
    args = ap.parse_args()

    if args.cmd == "machine-id":
        print(machine_id())
        return
    if args.cmd == "capture":
        cmd_capture(args)
        return

    if not (args.perf or args.size or args.runtime or args.render or args.terrain):
        ap.error("check: pass --perf, --size, --runtime, --render, and/or --terrain")
    if args.size and not (args.native and args.wasm):
        ap.error("check --size: --native and --wasm paths required")
    budgets = load_budgets()
    base = load_baseline()
    warn_rustc(base)
    ok = True
    if args.perf:
        ok &= check_perf(base, budgets)
    if args.size:
        ok &= check_size(base, budgets, args.native, args.wasm)
    if args.runtime:
        ok &= check_runtime(base, budgets, args.runtime)
    if args.render:
        ok &= check_render(base, budgets, args.render)
    if args.terrain:
        ok &= check_terrain(base, budgets, args.terrain)
    if not ok:
        sys.exit(1)
    print("PASS")


if __name__ == "__main__":
    main()
