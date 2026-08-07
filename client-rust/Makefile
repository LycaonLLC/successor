# Successor Rust client — build orchestration and regression gates.
# Outputs land in out/bin and out/web. Mirrors ~/code/sandbox/voxel_engine/Makefile.

CARGO ?= cargo
WASM_TARGET := wasm32-unknown-unknown
NO_STD_TARGET := thumbv7em-none-eabihf
PYTHON ?= python3
WASM_STRIP := $(shell command -v wasm-strip || command -v llvm-strip || echo /opt/homebrew/opt/llvm/bin/llvm-strip)
STATS_JSON := out/stats.json
RENDER_STATS_JSON := out/material-parity-gpu.json
TERRAIN_STATS_JSON := out/terrain-material-gpu.json
NATIVE_BIN := out/bin/successor
DEV_BIN := target/release/successor
DEV_NATIVE_BIN := out/bin/successor-dev
CONTROL_BIN := out/bin/successor-control

DEV_FEATURES := --features dev-tools

WASM_OUT := out/web/successor.wasm
NATIVE_STRIPPED := /tmp/successor-port/successor
WASM_STRIPPED := /tmp/successor-port/successor.wasm
WEB_RELEASE_OUT ?= out/web-release
SOURCE_COMMIT ?=
CLIENT_RELEASE_ID ?=
SERVER_RELEASE_ID ?=
STOREFRONT_ORIGIN ?= https://www.successorgame.com
GAME_ORIGIN ?= wss://world.successorgame.com
CHAT_ORIGIN ?= wss://world.successorgame.com

.PHONY: all native dev web web-release run serve serve-dev connect-local strip-port size-check bench bench-check \
        bench-baseline check-allocs connected-check-allocs runtime-check render-check terrain-check model-check test-unit nostd verify clean

all: native web

native:
	$(CARGO) build --release -p successor-client --bin successor
	$(CARGO) build --release -p successor-client --bin successor-control $(DEV_FEATURES)
	mkdir -p out/bin
	cp target/release/successor $(NATIVE_BIN)
	cp target/release/successor-control $(CONTROL_BIN)

# Developer-capability client. `native` deliberately ships without `dev-tools`,
# so the shipped binary refuses demo modes, `--endpoint` identity, and the
# loopback control server. Agent control journeys and the observation harnesses
# drive this binary instead.
dev:
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	$(CARGO) build --release -p successor-client --bin successor-control $(DEV_FEATURES)
	mkdir -p out/bin
	cp target/release/successor $(DEV_NATIVE_BIN)
	cp target/release/successor-control $(CONTROL_BIN)


web:
	$(CARGO) build --release --target $(WASM_TARGET) -p successor-client --lib
	mkdir -p out/web
	cp target/$(WASM_TARGET)/release/successor_client.wasm $(WASM_OUT)
	cp web/index.html web/successor.js out/web/
# Assets are served from repo sources by tools/dev-serve.mjs; nothing else is
# copied here. `make serve` (or `make serve-dev`) wires URLs to repo paths.

web-release:
	$(CARGO) build --release --target $(WASM_TARGET) -p successor-client --lib
	node tools/web-release.mjs \
		--source-commit "$(SOURCE_COMMIT)" \
		--client-release-id "$(CLIENT_RELEASE_ID)" \
		--server-release-id "$(SERVER_RELEASE_ID)" \
		--storefront-origin "$(STOREFRONT_ORIGIN)" \
		--game-origin "$(GAME_ORIGIN)" \
		--chat-origin "$(CHAT_ORIGIN)" \
		--out "$(WEB_RELEASE_OUT)"

run: native
	./$(NATIVE_BIN) $(ARGS)

# Loopback dev server: serves out/web and maps asset URLs to repo sources.
# Injects a dev-identity launch context for the local authority on :28093.
serve: web
	node tools/dev-serve.mjs --root out/web --port 8080

serve-dev: serve

# Native connected loop against the local authority: starts it when absent.
PLAYER ?= local-dev
connect-local: dev
	curl -fsS http://127.0.0.1:28093/game/status >/dev/null 2>&1 || (cd .. && pnpm server:local:persistent)
	./$(DEV_NATIVE_BIN) --dev-identity --endpoint ws://127.0.0.1:28093 --player-id $(PLAYER) --actor-id $(PLAYER) $(ARGS)

# no_std purity proof: the engine crates must build for a bare-metal target.
nostd:
	$(CARGO) build -p successor-engine-core --target $(NO_STD_TARGET)
	$(CARGO) build -p successor-engine-render --target $(NO_STD_TARGET)

# Stripped copies of both binaries (input to the size gate).
strip-port: all
	mkdir -p /tmp/successor-port
	cp $(NATIVE_BIN) $(NATIVE_STRIPPED)
	cp $(WASM_OUT) $(WASM_STRIPPED)
	strip -x $(NATIVE_STRIPPED) 2>/dev/null || strip $(NATIVE_STRIPPED)
	$(WASM_STRIP) --strip-all $(WASM_STRIPPED) 2>/dev/null || wasm-strip $(WASM_STRIPPED)

model-check:
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	git -C .. ls-files -z -- '*.glb' '*.gltf' '*.obj' '*.fbx' '*.blend' ':(exclude)tools/successor/assets/cloning-facility-opus5/blend/*.blend' | ./$(DEV_BIN) --model-corpus

test-unit:
	$(CARGO) test -p successor-engine-core --features std
	$(CARGO) test -p successor-engine-render --features std
	$(CARGO) test -p successor-client-proto
	$(CARGO) test -p successor-platform
	$(CARGO) test -p successor-client

# Criterion microbenches; `std` gates off the no_std runtime items so libtest links.
bench:
	$(CARGO) bench -p successor-engine-render --features std

bench-check: bench
	$(PYTHON) bench/compare.py check --perf

size-check: strip-port
	$(PYTHON) bench/compare.py check --size --native $(NATIVE_STRIPPED) --wasm $(WASM_STRIPPED)
# Allocation and runtime probes are built only with the developer capability.
# Production binaries are intentionally unable to select demo/probe modes;
# connected-scene probes can use the same instrumented binary and caps.
check-allocs:
	$(CARGO) build --release -p successor-client --bin successor --features dev-tools,alloc-count
	$(DEV_BIN) --demo parity-basic --frames 600 --assert-zero-allocs

# Live connected-frame allocation gate. Caller supplies a disposable authority
# identity; 240 warmup frames cover deferred presentation initialization.
connected-check-allocs:
	test -n "$(CONNECTED_ENDPOINT)" -a -n "$(CONNECTED_PLAYER)" -a -n "$(CONNECTED_ACTOR)"
	$(CARGO) build --release -p successor-client --bin successor --features dev-tools,alloc-count
	$(DEV_BIN) --dev-identity --endpoint $(CONNECTED_ENDPOINT) --player-id $(CONNECTED_PLAYER) --actor-id $(CONNECTED_ACTOR) --frames 600 --assert-zero-allocs

runtime-check:
	mkdir -p out
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	$(DEV_BIN) --demo parity-basic --frames 600 --stats-json $(STATS_JSON)
	$(PYTHON) bench/compare.py check --runtime $(STATS_JSON)
# Material parity GPU p99, measured after 120 warmup frames.
render-check:
	mkdir -p out
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	$(DEV_BIN) --demo material-parity --quality high --frames 840 --gpu-stats-json $(RENDER_STATS_JSON)
	$(PYTHON) bench/compare.py check --render $(RENDER_STATS_JSON)

# Deterministic terrain material probes plus GPU p99 after 120 warmup frames.
terrain-check:
	mkdir -p out
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	$(DEV_BIN) --demo terrain-material --biome desert --quality high --frames 120 --assert-terrain-material
	$(DEV_BIN) --demo terrain-material --biome forest --quality high --frames 120 --assert-terrain-material
	$(DEV_BIN) --demo terrain-material --biome desert --quality high --frames 840 --gpu-stats-json $(TERRAIN_STATS_JSON)
	$(PYTHON) bench/compare.py check --terrain $(TERRAIN_STATS_JSON)

# Rewrites this machine's baseline (perf medians, stripped sizes, runtime, and render stats).
bench-baseline: strip-port bench
	mkdir -p out
	$(CARGO) build --release -p successor-client --bin successor $(DEV_FEATURES)
	$(DEV_BIN) --demo parity-basic --frames 600 --stats-json $(STATS_JSON)
	$(DEV_BIN) --demo material-parity --quality high --frames 840 --gpu-stats-json $(RENDER_STATS_JSON)
	$(DEV_BIN) --demo terrain-material --biome desert --quality high --frames 840 --gpu-stats-json $(TERRAIN_STATS_JSON)
	$(PYTHON) bench/compare.py capture --native $(NATIVE_STRIPPED) --wasm $(WASM_STRIPPED) --runtime $(STATS_JSON) --render $(RENDER_STATS_JSON) --terrain $(TERRAIN_STATS_JSON)

# Pre-acceptance gate: unit tests + perf gate + size gate.
# (check-allocs and runtime-check open no window but still run the demo headless-timed;
#  they are separate targets so `verify` stays fast and display-independent.)
verify: model-check test-unit bench-check size-check
	@echo "VERIFY: PASS"

clean:
	$(CARGO) clean
	rm -rf out
