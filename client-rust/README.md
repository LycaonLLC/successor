# Successor Rust client (`client-rust/`)

In-development native + web Rust client. Standalone Cargo workspace,
deliberately **outside** the root Rust workspace and the pnpm workspace — root
repo gates do not cover it; the gates below are mandatory for any change here.

Not a supported player surface yet: do not publish it, link it from the site,
or add it to the download ledger until parity is proven and a product promotion
happens (see the repo `AGENTS.md`).

## Prerequisites

### Rust toolchain (automatic)

`rust-toolchain.toml` pins stable with `rustfmt` + `clippy` and the two
cross-compile targets (`wasm32-unknown-unknown`, `thumbv7em-none-eabihf`).
Install [`rustup`](https://rustup.rs); it provisions the toolchain and targets
on the first `cargo`/`make` invocation. No manual `rustup target add` needed.

### System packages

| Need | Why | Provides |
|------|-----|----------|
| C toolchain (`gcc`/`cc`) | build scripts + final link | `cc` |
| `pkg-config` | locate `glfw3` at build time | `pkg-config` |
| GLFW 3 | native desktop window + input (`glfw3.pc`) | `libglfw`, `glfw3.pc` |
| OpenGL loader | native GL backend (`-lGL`) | `libGL` |
| OpenSSL | native TLS for the WebSocket transport (`native-tls`) | `libssl` |
| Python 3 | perf/size/runtime gate scripts (`bench/compare.py`) | `python3` |
| WABT **or** LLVM | `wasm-strip` / `llvm-strip` for the wasm size gate | `wasm-strip` |

MP3 decode (native) and the web GL/WebSocket/fetch surface are pure Rust / the
JS shim — no extra system packages.

#### Arch Linux (verified on this machine)

```sh
sudo pacman -S --needed rustup base-devel pkg-config glfw mesa openssl python wabt
```

`base-devel` covers `gcc`/`pkg-config`; `mesa` provides `libGL`; `glfw` ships
`glfw3.pc`; `wabt` provides `wasm-strip`.

#### Debian / Ubuntu

```sh
sudo apt install build-essential pkg-config libglfw3-dev libgl1-mesa-dev \
                 libssl-dev python3 wabt
```

#### Fedora

```sh
sudo dnf install gcc pkgconf-pkg-config glfw-devel mesa-libGL-devel \
                 openssl-devel python3 wabt
```

Verify the two package deps that are easy to miss:

```sh
pkg-config --modversion glfw3   # expect 3.x
command -v wasm-strip llvm-strip  # at least one must resolve
```

## Build & run

Everything is driven by the `Makefile`; artifacts land in `out/`.

```sh
make native   # release desktop binary -> out/bin/successor
make web      # release wasm module    -> out/web/successor.wasm (+ shim)
make all      # native + web

make run                                  # build native, then launch it
./out/bin/successor --demo parity-basic --gl   # windowed visual QA
./out/bin/successor --demo terrain --frames 5 --screenshot /tmp/shot.png
make serve    # build web, serve out/web on http://localhost:8080
```

Headless entry points (no window, used by the gates):

```sh
./out/bin/successor --demo parity-basic --frames 600 --stats-json out/stats.json
```

## Gates (mandatory for changes under `client-rust/`)

```sh
make verify         # unit tests + perf gate + stripped-size gate  -> "VERIFY: PASS"
make check-allocs   # steady-state frame loop must report frame-allocs 0
make runtime-check  # frame p50/p99, peak RSS, allocs vs baseline + ceilings
make nostd          # engine crates still build for thumbv7em-none-eabihf
```

Authoritative budgets live in `budgets.json`; regression thresholds are checked
against a **per-machine baseline** in `bench/baselines/<machine-id>.json`.

### First run on a new machine

`make verify` / `runtime-check` fail with `no baseline for this machine` until
one exists. Capture it once, then review/commit the resulting file like code:

```sh
make bench-baseline   # writes bench/baselines/<machine-id>.json
```

An intentional perf/size regression ships an updated baseline in the same change
with a written justification (see `AGENTS.md`).

## Troubleshooting

- **`The system library 'glfw3' required by crate 'successor-platform' was not
  found`** or link error `-lglfw` — GLFW dev package missing; install `glfw`
  (see above) and confirm `pkg-config --modversion glfw3`.
- **`rust-lld: error: ... undefined symbol: glClear` (wasm build)** — the raw
  `extern "C"` GL/JS import blocks need `#[link(wasm_import_module = "env")]`;
  the checked-in web modules already declare it. If you add a new JS import
  block under `source/platform/src/web/`, annotate it the same way so rust-lld
  emits it as an `env` import instead of an undefined symbol.
- **`FAIL: no baseline for this machine`** — run `make bench-baseline` (above).
- **`wasm-strip: command not found`** during `make size-check`/`verify` —
  install `wabt` (or `llvm` for `llvm-strip`).
