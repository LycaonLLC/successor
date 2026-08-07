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
make native   # release desktop binaries -> out/bin/successor{,-control}
make web      # release wasm module      -> out/web/successor.wasm (+ shim)
make all      # native + web

make run                                      # build native, then launch it
./out/bin/successor --demo parity-basic --gl # windowed visual QA
./out/bin/successor --demo terrain --frames 5 --screenshot /tmp/shot.bmp

make serve      # build web, serve repo assets + out/web on http://127.0.0.1:18081
```

`make serve` runs `tools/dev-serve.mjs`, a loopback dev server that maps the
repository's authoritative asset directories straight from disk — `make web`
copies no assets. `make serve-dev` additionally injects a development launch
envelope (`dev-identity` tickets) so the page enters the world directly against
a loopback authority (`pnpm server:local:persistent`, port 28093).
`make connect-local PLAYER=name` does the native equivalent.
`--release <dir>` serves an assembled release directory instead, including its
`/objects/<sha256>` content-addressed namespace.

## Web release assembly and staged loading

`make web-release` (or `node tools/web-release.mjs ...`) assembles the
immutable release directory under `out/web-release/`:

- `index.html`, `successor.js` (release shim), `successor.wasm`,
  `release-manifest.json`, the content packs under `packs/`, and every
  standalone asset file (pawn-pack wardrobe trees stay standalone for
  on-demand streaming).
- The release manifest is `successor.rust-web-release.v2`: `files[]` carry
  `{path, bytes, sha256}`, `boot[]` lists the boot-closure asset ids, and
  `packIndex` maps packed asset id → `{pack, offset, bytes}`.
- Pack format (`tools/boot-closure.mjs` owns the boot set): `SPAK1\n` magic,
  u32le index length, JSON index (`successor.assetpack.v1`, entries with
  `{path, offset, bytes, sha256}`), then concatenated payloads. Packs are
  immutable once published; `boot.spak`, `audio-boot.spak`, `audio-rest.spak`,
  and `world-rest.spak` are emitted today.
- The shim fetches `boot.spak` (+ standalone boot ids) and the
  `bootPacks`-listed spawn-region packs before launch, then `audio-boot.spak`
  and the shared remainder packs in the background after the first world
  frame. Region packs, creature GLBs, and the pawn-pack wardrobe are **not**
  prefetched: they stream on demand through the async asset channel.
- Phase 5 streaming: `Platform::begin_asset`/`poll_asset` (FFI imports
  `js_asset_begin`/`js_asset_poll` on web, immediate resolution on native)
  back an `AssetStreamer` (`source/app/src/assets/stream.rs`, 64 in-flight
  slots, terminal-failure set, completion epoch). Consumers: pawn bodies
  (specials/creatures), weapon rigs + hand specs, equipment pieces, world
  props, and the item preview. `Pending` renders without the piece and
  retries on the completion epoch; `Missing` (terminal) maps to the typed
  fallback or explicit missing-asset marker — never a refetch loop.
- World props group into region packs (`packs/region/<areaId>/<rx>-<ry>.spak`,
  region = 128×128 cells) plus a `sparse.spak` for sub-256KiB mergers. A
  region watcher streams the player's 3×3 neighborhood; the travel hold keeps
  the transition up until the destination **spawn region** settles (30s
  deadline forces fail-closed marker placement), with the wider neighborhood
  streaming in right after release. Only the spawn region's packs are staged
  in `bootPacks`, keeping the stage-1 wire ≈24MB gzipped.
- Custom weapon attach specs resolve lazily: `warm_custom_specs` fills the
  item-id alias table in the background; an unmapped `weaponItemId` pends its
  rig until the table settles rather than mis-binding a legacy rig.
- Audio clips decode on first trigger; no synchronous fallback paths remain
  (the pack-aware sync fallback is only reachable when the async channel is
  absent, e.g. tests).
- `node tools/web-release.mjs --local-dev --out out/web-release-local ...`
  builds a loopback-only variant that keeps the development launch path for
  full release-path verification against a local authority. The published
  beta never uses it; the release shim otherwise strips URL/dev launches and
  requires hosted tickets.

The publisher (`ops/deploy/scripts/publish-client-assets.mjs --object-store`)
uploads this tree into the content-addressed object store: object key =
`objects/<sha256 of uncompressed content>`, gzip level 9 for compressible
types (including `.spak`), 16-wide upload pool, and the publish order
objects → release-scoped files → manifest → `current.json`. Re-publication of
an unchanged client is six small requests.

Headless entry points (no window, used by the gates):

```sh
./out/bin/successor --demo parity-basic --frames 600 --stats-json out/stats.json
```

## Agent control, screenshots, and input replay

The native client has a developer-only loopback control server. It is disabled
by default and never listens on a non-loopback address. Enable it explicitly
with `--control`, `--control-port N`, or `SUCCESSOR_CONTROL=1` (with optional
`SUCCESSOR_CONTROL_PORT=N`). Port `0` requests an ephemeral port; the client
prints `successor_control_server=127.0.0.1:<port>` after binding.

`make native` also builds `out/bin/successor-control`. It accepts one command
from argv, a script with `--file`, or commands from stdin while retaining one
connection for the whole stream:

```sh
./out/bin/successor \
  --endpoint ws://127.0.0.1:28093 --player-id agent-1 --actor-id agent-1 \
  --control-port 47778

printf '%s\n' \
  'key down w' \
  'wait 750' \
  'key up w' \
  'screenshot /tmp/agent-view.bmp' \
  | ./out/bin/successor-control --port 47778
```

Requests are UTF-8 lines and responses are one JSON object per line. The CLI's
`wait <milliseconds>` is local script timing; server commands are:

```text
key <down|up|tap> <key>
mouse move <abs|rel> <x> <y>
mouse <down|up> <left|right|middle>
text <text>
scroll <x> <y>
screenshot <path.bmp>
record start <path.input>
record stop
status
quit
```

While a control connection is active, or a remote key/button remains held,
remote state replaces local GLFW input. A screenshot is read from the rendered
frame before swap and acknowledged only after the BMP is written. This makes
the JSON response a completion boundary an agent can trust.

Start a frame-indexed recording with `--record-input PATH` or the `record
start` command. The current-only file begins with `successor.input.v1`; each
following row is `frame<TAB>N<TAB>command`. Native and remote key transitions,
pointer moves/buttons, text, and scroll are captured. Replay with
`--replay-input PATH`; replay owns input for the run, rejects malformed or
out-of-order files, and rejects live input mutation while still allowing
`status`, `screenshot`, and `quit`.

The server, recorder, replay loader, and screenshot writer are native
developer tooling. They are not compiled into the web backend, do not bypass
the Colyseus command path, and do not become gameplay authority.

## Graphics mastering

Press Backquote (`` ` ``) in the native connected client or the windowed
`parity-basic` demo to toggle the developer graphics-mastering overlay. Its
Lighting, Post / AA, and Color / Palette pages edit the active Low, Medium, or
High preset live. Controls cover sun direction/color/intensity, ambient and
material AO/emissive response, shadow resolution/range/bias/penumbra, bloom
threshold/intensity/radius, exposure, FXAA thresholds, lift/gamma/gain,
temperature/tint, saturation/contrast, and final-output palette quantization
with ordered dithering.

`SAVE` atomically replaces `assets/render/settings.json`; `RELOAD` validates
and reapplies that file; `RESET PRESET` restores the selected built-in preset.
Startup validates the current-only `successor.render-settings.v1` document and
falls back to compiled defaults if the asset is missing or invalid. Browser
builds embed and apply the checked-in settings but do not expose native file
writes. Preset shader topology (HDR/GI/filter tier) is selected at startup;
uniform and shadow-target controls apply immediately.

The overlay uses ordinary platform input, including remote `key tap
backquote`, so the loopback controller, screenshot completion boundary, and
`successor.input.v1` replay can verify the same UI a developer uses.



## Gates (mandatory for changes under `client-rust/`)

```sh
make verify         # unit tests + perf gate + stripped-size gate  -> "VERIFY: PASS"
make check-allocs   # steady-state frame loop must report frame-allocs 0
make runtime-check  # frame p50/p99, peak RSS, allocs vs baseline + ceilings
make render-check   # material-parity GPU p99
make terrain-check  # biome probes, non-repetition, and terrain GPU p99
make nostd          # engine crates still build for thumbv7em-none-eabihf
```

Authoritative budgets live in `budgets.json`; regression thresholds are checked
against a **per-machine baseline** in `bench/baselines/<machine-id>.json`.

The fidelity-first absolute caps are 6 MiB stripped native, 4 MiB stripped
WebAssembly, 8.33 ms runtime/terrain p99, 16.67 ms generic render p99, zero
steady-state frame allocations, and 512 MiB peak RSS. Baseline headroom is
`max(512 KiB, 25%)` for size and 100% for performance; absolute caps still
bound the result. This deliberately leaves room for full multi-surface PBR
terrain, displacement, and living detail instead of optimizing presentation
features away.

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
