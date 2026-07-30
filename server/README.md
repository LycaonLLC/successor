# Successor Server

The server is Successor's network edge. It hosts the Colyseus game room and
chat transport, validates launch identity, shapes AOI output, projects
persistence, and bridges commands to the Rust `successor-sim` authority. It is
not a second gameplay simulation.

The default local endpoint is `http://127.0.0.1:28093`. Both supported clients
use it:

- `client-3d/`, the Three.js graphical client;
- `client-tui/`, the terminal client through the shared headless runtime.

Important routes are:

- `/game/status` for shard identity, source hash, authority mode, population,
  sessions, counters, persistence, weather, and world-clock state;
- `/chat/ws` and `/chat/status` for chat transport and health;
- `/matchmake/:method/:roomName` plus the Colyseus room websocket path;
- `/healthz` and `/version` for process health and package identity.

Gameplay truth lives in Rust. TypeScript owns connection policy, command
transport, AOI filtering, packet shaping, and persistence mirrors. Rust owns
movement, collision, combat, life state, inventory, resources, crafting,
professions, farming, trade, travel, cloning, and economy mutations.

Before judging a local session, inspect `/game/status` and match the fixture
hash to `client/public/successor-slice/open-desert-slice.json`. A page on port
5179 proves only that the graphical client is listening; it does not prove the
expected authority or fixture is active.

The current chat implementation is production-shaped but in-memory. Session
limits are configured with `CHAT_MAX_SESSIONS`,
`CHAT_MAX_SESSIONS_PER_USER`, and `CHAT_MAX_PACKET_BYTES`. See
`docs/CHAT_SYSTEM.md` for channel policy and persistence boundaries.
