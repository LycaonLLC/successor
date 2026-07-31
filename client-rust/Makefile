# Successor Rust client — build orchestration and regression gates.
# Outputs land in out/bin and out/web. Mirrors ~/code/sandbox/voxel_engine/Makefile.

CARGO ?= cargo
WASM_TARGET := wasm32-unknown-unknown
NO_STD_TARGET := thumbv7em-none-eabihf
PYTHON ?= python3
WASM_STRIP := $(shell command -v wasm-strip || command -v llvm-strip || echo /opt/homebrew/opt/llvm/bin/llvm-strip)
STATS_JSON := out/stats.json
RENDER_STATS_JSON := out/material-parity-gpu.json

NATIVE_BIN := out/bin/successor
WASM_OUT := out/web/successor.wasm
NATIVE_STRIPPED := /tmp/successor-port/successor
WASM_STRIPPED := /tmp/successor-port/successor.wasm

.PHONY: all native web run serve strip-port size-check bench bench-check \
        bench-baseline check-allocs runtime-check render-check model-check test-unit nostd verify clean

all: native web

native:
	$(CARGO) build --release -p successor-client --bin successor
	mkdir -p out/bin
	cp target/release/successor $(NATIVE_BIN)

web:
	$(CARGO) build --release --target $(WASM_TARGET) -p successor-client --lib
	mkdir -p out/web
	cp target/$(WASM_TARGET)/release/successor_client.wasm $(WASM_OUT)
	cp web/index.html web/successor.js out/web/
	mkdir -p out/web/parity-assets
	cp ../client-3d/public/assets/world-items/commerce_facility.glb out/web/parity-assets/
	cp ../client-3d/public/assets/pawn-pack/weapons/custom/lightning_carbine.glb out/web/parity-assets/
	cp ../client-3d/public/assets/creatures/mossmuff_adult.glb out/web/parity-assets/
	cp ../client-3d/public/assets/wave-props/everyday-wave-20260719/prepared-foods/successor_food_beer_mug.glb out/web/parity-assets/
	cp ../client-3d/public/assets/items/custom/accessories/field_cap.glb out/web/parity-assets/
	cp ../client-3d/public/assets/world-items/megalith_brick_hex.glb out/web/parity-assets/

run: native
	./$(NATIVE_BIN) $(ARGS)

serve: web
	cd out/web && $(PYTHON) -m http.server 8080

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

model-check: native
	git -C .. ls-files -z -- '*.glb' '*.gltf' '*.obj' '*.fbx' '*.blend' | ./$(NATIVE_BIN) --model-corpus

test-unit:
	$(CARGO) test -p successor-engine-core --features std
	$(CARGO) test -p successor-engine-render --features std
	$(CARGO) test -p successor-client-proto

# Criterion microbenches; `std` gates off the no_std runtime items so libtest links.
bench:
	$(CARGO) bench -p successor-engine-render --features std

bench-check: bench
	$(PYTHON) bench/compare.py check --perf

size-check: strip-port
	$(PYTHON) bench/compare.py check --size --native $(NATIVE_STRIPPED) --wasm $(WASM_STRIPPED)

# Native build with the allocation counter; the demo prints frame-alloc lines and
# exits nonzero if any steady-state frame allocated.
check-allocs:
	$(CARGO) build --release -p successor-client --bin successor --features successor-client/alloc-count
	./target/release/successor --demo parity-basic --frames 600 --assert-zero-allocs

# Frame p50/p99, peak RSS, steady allocs -> STATS_JSON, then gate vs baseline + ceilings.
runtime-check: native
	mkdir -p out
	./$(NATIVE_BIN) --demo parity-basic --frames 600 --stats-json $(STATS_JSON)
	$(PYTHON) bench/compare.py check --runtime $(STATS_JSON)

# Material parity GPU p99, measured after 120 warmup frames.
render-check: native
	mkdir -p out
	./$(NATIVE_BIN) --demo material-parity --quality high --frames 840 --gpu-stats-json $(RENDER_STATS_JSON)
	$(PYTHON) bench/compare.py check --render $(RENDER_STATS_JSON)

# Rewrites this machine's baseline (perf medians, stripped sizes, runtime, and render stats).
# The resulting bench/baselines diff is reviewed and committed like code.
bench-baseline: strip-port bench
	mkdir -p out
	./$(NATIVE_BIN) --demo parity-basic --frames 600 --stats-json $(STATS_JSON)
	./$(NATIVE_BIN) --demo material-parity --quality high --frames 840 --gpu-stats-json $(RENDER_STATS_JSON)
	$(PYTHON) bench/compare.py capture --native $(NATIVE_STRIPPED) --wasm $(WASM_STRIPPED) --runtime $(STATS_JSON) --render $(RENDER_STATS_JSON)

# Pre-acceptance gate: unit tests + perf gate + size gate.
# (check-allocs and runtime-check open no window but still run the demo headless-timed;
#  they are separate targets so `verify` stays fast and display-independent.)
verify: model-check test-unit bench-check size-check
	@echo "VERIFY: PASS"

clean:
	$(CARGO) clean
	rm -rf out
