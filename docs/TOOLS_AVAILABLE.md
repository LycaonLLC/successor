# Tools Available to Agents

This document describes repository-owned developer tools that agents should use
instead of inventing parallel automation paths. Tooling here does not change
runtime authority or public deployment identity.

## Native Rust client remote control

`client-rust/` provides a developer-only remote-control path for driving and
inspecting the native client. Use it for native visual QA, connected-client
journeys, deterministic input capture, and graphics-mastering checks.

The controlled process is `client-rust/out/bin/successor-dev`. The companion CLI
is `client-rust/out/bin/successor-control`. Both are built by:

```sh
make -C client-rust dev
```

`make -C client-rust native` builds the shipped `out/bin/successor`, which is
deliberately compiled WITHOUT the `dev-tools` capability: it refuses
`--control-port`, `--demo`, and raw `--endpoint` identity with
`developer probes and demo modes require the dev-tools capability`. Drive
`successor-dev` for agent journeys and observation harnesses.

The control server is disabled by default, native-only, and bound exclusively
to `127.0.0.1`. It is not available in the WebAssembly client and is not a
public or gameplay-authority endpoint. Remote input still reaches gameplay
through the client's ordinary Colyseus command path.

### Start a controllable client

Run the client from `client-rust/`: its asset root is `..`, so a different
working directory fails with `required asset missing: render/props-mapping.json`.
Start a windowed demo with an ephemeral control port:

```sh
cd client-rust
out/bin/successor-dev --demo parity-basic --gl --control-port 0
```

Or connect to a local authority. A durable roster character must join by
`--character-id`; the shard rejects the bare `{playerId, actorId}` dev shape for
any id its character store already owns:

```sh
cd client-rust
out/bin/successor-dev \
  --dev-identity \
  --endpoint ws://127.0.0.1:28093 \
  --player-id <character-id> --actor-id <character-id> \
  --character-id <character-id> \
  --control-port 47778
```

The process prints the actual listener after binding:

```text
successor_control_server=127.0.0.1:<port>
```

Prefer `--control-port 0` when several clients or agents may run concurrently;
read the printed port and pass it to the CLI. `--control` uses the default
port. The equivalent environment switches are `SUCCESSOR_CONTROL=1` and
`SUCCESSOR_CONTROL_PORT=N`.

Use the agent harness's supervised-process facility for a client that must stay
running while later commands inspect or control it. Do not launch an unmanaged
background process.

### Send commands

The CLI accepts one command in argv:

```sh
client-rust/out/bin/successor-control --port 47778 status
client-rust/out/bin/successor-control --port 47778 key tap backquote
client-rust/out/bin/successor-control --port 47778 screenshot /tmp/successor-view.bmp
```

For a journey, pipe commands or pass `--file PATH`. One CLI invocation keeps a
single TCP connection for the whole stream:

```sh
printf '%s\n' \
  'key down w' \
  'wait 750' \
  'key up w' \
  'screenshot /tmp/successor-agent-view.bmp' \
  | client-rust/out/bin/successor-control --port 47778
```

Blank lines and lines beginning with `#` are ignored in command files and
piped input. `wait <milliseconds>` is implemented by the CLI and delays the
next command; it is not sent to the client.

Supported server commands are:

```text
key <down|up|tap> <key>
mouse move <abs|rel> <x> <y>
mouse <down|up> <left|right|middle>
text <text>
scroll <x> <y>
screenshot <path.bmp>
record start <path.input>
record stop
ui window <open|close|toggle> <surface-id>
ui theme <index>
ui opacity <window|hud> <0.35..1.0>
status
quit
```

`key` accepts every code the client binds, not just movement:

```text
w a s d r f i c o v x n p k b m g
0..9 (also digit0..digit9)
up down left right space enter escape backspace shift tab semicolon backquote
```

`p k b m g` reach the datapad, skills, action browser, macros, and association
windows; `i c o` reach inventory, character, and options.

The `ui` family exists because most surfaces have no hotkey at all — `survey`,
`bank`, `loot`, `trade`, `craft`, `converse` and the rest open from a terminal,
a target, or an item, and a review that cannot reach them is not a review. The
intents are applied through the same entry points the player's own action uses,
so a captured pane is the pane the player would see. Surface ids come from
`status`.

`status` reports a `window_frames` array beside the `windows` id list. Each
entry is `{id, rect:[x,y,w,h], open, iconified, interactive}` for every
registered workspace frame, HUD panes included. Assert move, resize, and layout
persistence against those numbers instead of reading pixels — the frame rects
are the same values the manager persists.

Requests are UTF-8 lines. Responses are one JSON object per line. The CLI exits
nonzero if a command returns `"ok":false`, so do not discard its exit status.
While a control connection is active, or a remote key or mouse button remains
held, remote state replaces local GLFW input. Always release held keys and
buttons in the same script unless the test intentionally inspects held state.

### Screenshots are completion boundaries

`screenshot <path.bmp>` reads the completed rendered frame before buffer swap.
Its successful JSON response is emitted only after the BMP has been written.
Wait for that response before reading or inspecting the file. A successful TCP
response proves file creation, not visual correctness; inspect the pixels for
visual claims.

Use protocol screenshots from the control CLI for remote journeys. The
client's startup `--screenshot` option is useful for bounded demo captures but
does not replace a live control journey when input or connected behavior is
under test.

### Record and replay input

Start recording either when launching the client:

```sh
client-rust/out/bin/successor \
  --demo parity-basic --gl --control-port 0 \
  --record-input /tmp/successor-journey.input
```

or through the control protocol:

```text
record start /tmp/successor-journey.input
record stop
```

The current-only format begins with `successor.input.v1` and stores
frame-indexed key, pointer, text, and scroll commands. Replay it with the same
scene or connected-client setup:

```sh
client-rust/out/bin/successor \
  --demo parity-basic --gl --control-port 0 \
  --replay-input /tmp/successor-journey.input
```

Replay owns input for the run. Malformed or out-of-order recordings fail
closed. During replay, live input mutation is rejected; `status`, `screenshot`,
and `quit` remain available. `--record-input` and `--replay-input` cannot be
combined.

### Required proof

Follow `docs/VERIFICATION.md` for the authoritative gate. For native
agent-control changes, proof must include a real loopback journey that:

1. launches a windowed demo or connected client with control enabled;
2. sends multiple input commands through `successor-control`;
3. requests and visually inspects a protocol screenshot;
4. saves a `successor.input.v1` recording;
5. relaunches with `--replay-input`; and
6. proves the replayed UI or actor result in a second screenshot.

A listener, JSON acknowledgement, or generated screenshot file alone is not
visual or gameplay proof. For connected movement, confirm the authority-streamed
result rather than treating local presentation as authority. Graphics-mastering
changes must also complete the overlay and pixel-inspection procedure in
`docs/VERIFICATION.md`.

The implementation and lower-level protocol notes live in
`client-rust/README.md` and
`client-rust/source/platform/src/native/control.rs`. If this guide disagrees
with the current implementation, update the guide and verification contract in
the same change rather than adding a second control path.

## Observation harnesses

Single-point probing is the slowest and least reliable way to understand a
visual or spatial defect. These two answer the whole question at once, and both
prefer measurement over a screenshot someone has to squint at.

### Character surfaces — `tools/observe/pawn_observatory.py`

The character is drawn by four independent paths: the world view and the
inventory, character and examine viewers. A body change can land correctly in
one and wrongly in another, and one front-on shot hides it. This drives a live
client through `successor-control` and collects the same subject from every
surface at several angles, then lays them out side by side.

```sh
python3 tools/observe/pawn_observatory.py --port 47779 --out /tmp/obs
```

Nothing in it hardcodes a screen position. The subject is found by motion:
disturb only it, diff the frames, and the pixels that changed are the subject.
That survives window moves, resolution changes, and UI edits. Toggling a window
finds the panel, spinning inside it finds the doll, and idle animation finds the
world pawn — walking does not, because the camera follows and every pixel
changes.

### Collision — `tools/observe/collision_map.py`

Walking into a wall yields one number and no shape. This rasterises the
authority's own rule — anchor to ground-centre offset, 300 milli radius,
`collisionBounds` always solid, the door blocker only while shut — then floods
from outside and reports how much of each building interior a player can
actually reach, with the door open and shut.

```sh
python3 tools/observe/collision_map.py                        # every building
python3 tools/observe/collision_map.py --prop dustgate-home-starter
```

The flood fill is the point, not the picture: it answers "can the player get
in" without walking anywhere. Run it before and after any collision change. A
working door shows a large jump between shut and open; a sealed one does not
move at all.

### Every UI surface — `tools/observe/pane_gallery.py`

A UI regression hides in the one pane nobody opened. There are 30 registered
surfaces and most open from a terminal, a target, or an item, so clicking
through them is not a review anyone repeats. This drives a live client, opens
each surface alone, crops the capture to the frame's own rect, and grades what
it captured.

```sh
python3 tools/observe/pane_gallery.py --port 47778 --out /tmp/gallery
python3 tools/observe/pane_gallery.py --port 47778 --only survey,bank --themes 0,2
```

Three numbers per pane, and each one caught a real defect the first time it
ran:

- **themed** — the same pane captured under two themes, compared pixel by
  pixel. Ink that does not move between an aqua theme and an amber one is a
  hardcoded literal, and the report prints the exact colours. This is how the
  chat console was found to be 0% themed and `ButtonStyle::default` was found
  to be frozen across six surfaces.
- **black** — the share of the pane's own ink that is near-black. This is how
  every window was found to be painting a near-black slab instead of the
  original's translucent tint.
- **contrast** — WCAG ratio between the pane's 99th-percentile and median
  luminance, over the pane's own ink only.

That last qualifier matters: the pane is captured twice, once open and once
closed, and only the pixels that differ are graded. Without it a pane with
nothing to say grades the terrain showing through it and reports a contrast of
1.0. Panes drawing under 2% of their rect are reported as empty instead.

Composited 3D content — the paperdoll in the inventory and character sheets —
never themes and should not. It shows up as frozen ink inside the viewer cell;
that is the model, not a literal.

### Equipment fit — the two humanoid gates

Skinned wearables and rigid socket attachments fail in different ways, so they
have separate gates. Both run on macOS through Blender's Python.

```sh
blender --background --factory-startup \
  --python content-pipeline/labs/humanoid-runtime-refit/verify_wearable_fit.py
blender --background --factory-startup \
  --python content-pipeline/labs/humanoid-runtime-refit/probe_weapons.py
```

`verify_wearable_fit.py` covers the 101 skinned wearables on both bodies and
writes `reports/wearable_fit.json`. `probe_weapons.py` covers what it cannot
see: weapons, hats, and anything else welded to a bone rather than skinned. It
resolves each socket the way `pawn/catalog.rs` does, measures hand or scalp
penetration on both bodies, and compares the two resolved mount positions. It
writes `reports/rigid_mount_fit.json`.

The cross-body delta is the cheap signal: male and female share one 45-joint
skeleton, so a socket that resolves more than a millimetre apart is a rig
defect. A grip buried past 30 mm is out the far side of the hand.

### Debug views in the connected client

- **Shift+C** — collision overlay: blocked cells, prop bounds, door blockers
  with live open/closed state, and the player capsule.
- **Shift+V** — free the camera. Arrows orbit, shift+arrow dollies. The shipped
  camera is locked north-up at a fixed pitch, which cannot show which way a
  door slides or how far it travels. It opens on the shipped view, so nothing
  changes until it is moved.
