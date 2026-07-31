# Tools Available to Agents

This document describes repository-owned developer tools that agents should use
instead of inventing parallel automation paths. Tooling here does not change
runtime authority or public deployment identity.

## Native Rust client remote control

`client-rust/` provides a developer-only remote-control path for driving and
inspecting the native client. Use it for native visual QA, connected-client
journeys, deterministic input capture, and graphics-mastering checks.

The controlled process is `client-rust/out/bin/successor`. The companion CLI is
`client-rust/out/bin/successor-control`. Both are built by:

```sh
make -C client-rust native
```

The control server is disabled by default, native-only, and bound exclusively
to `127.0.0.1`. It is not available in the WebAssembly client and is not a
public or gameplay-authority endpoint. Remote input still reaches gameplay
through the client's ordinary Colyseus command path.

### Start a controllable client

Run commands from the repository root. Start a windowed demo with an ephemeral
control port:

```sh
client-rust/out/bin/successor \
  --demo parity-basic --gl --control-port 0
```

Or connect to a local authority using an explicit port:

```sh
client-rust/out/bin/successor \
  --endpoint ws://127.0.0.1:28093 \
  --player-id agent-1 --actor-id agent-1 \
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
key <down|up|tap> <w|a|s|d|up|down|left|right|space|enter|escape|backspace|shift|backquote>
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
