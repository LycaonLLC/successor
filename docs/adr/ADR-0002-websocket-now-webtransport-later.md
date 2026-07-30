# ADR-0002: WebSocket now, WebTransport later

**Status:** accepted
**Date:** 2026-05-10

## Context

The product is browser-native. Real-time state requires a transport. Three candidates:

- **WebSocket** — mature, ubiquitous, simple, but TCP-only (head-of-line blocking) and reliable-ordered only.
- **WebTransport** — HTTP/3-based, supports unreliable datagrams, multiple streams, out-of-order delivery. Promising for snapshot deltas. Server / CDN / proxy stack support is uneven in 2026.
- **WebRTC** — designed for peer connectivity, not authoritative servers. Complex signaling and NAT logic; cheating boundary problems for an MMO.

## Decision

First playable uses WebSocket exclusively. WebTransport is added later, as a separate transport channel for snapshot datagrams, behind a capability check. WebRTC is not used for authoritative gameplay state.

Channel layout:

| Channel | Phase 1 transport | Phase 4+ transport |
|---------|-------------------|--------------------|
| Login / session | WebSocket | unchanged |
| Chat | WebSocket | unchanged |
| Command stream (player → server, ordered, reliable) | WebSocket | unchanged |
| Snapshot stream (server → player, latest-wins, lossy) | WebSocket | WebTransport datagram (with WebSocket fallback) |
| File / asset streaming | HTTP/3 + range | unchanged |

## Consequences

- One transport to debug for first playable.
- We accept WebSocket head-of-line blocking for snapshots in early phases. Snapshot deltas are small, so the cost is bounded.
- The netcode layer is written with a transport abstraction so the snapshot channel can switch backends without subsystem rewrites.
- We avoid the complexity of WebRTC's signaling and connection management.
- Deferred-decision risk: if WebTransport adoption is patchy at launch, the WebSocket fallback remains, just with more bandwidth.

## Alternatives considered

- **WebTransport from day one.** Rejected for first playable. Server/proxy/CDN integration cost is too high before we have a vertical slice. Will revisit.
- **WebRTC for authoritative state.** Rejected. Wrong tool. Cheating boundary problems and operational complexity.
