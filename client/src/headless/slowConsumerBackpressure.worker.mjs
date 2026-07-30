import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("slow-consumer worker requires a parent port");

// Colyseus selects the browser-compatible WebSocket if this global is present.
// This dedicated worker removes it before importing the SDK so the real `ws`
// transport exposes its TCP reader. After `game.hello`, it pauses the socket
// and blocks on a parent-owned atomic signal, so the worker cannot drain frames.
Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });

const { Client: ColyseusClient } = await import("@colyseus/sdk");
const room = await new ColyseusClient(workerData.endpoint).joinOrCreate("game", {
  playerId: workerData.actorId,
  actorId: workerData.actorId,
  displayName: "Slow Consumer Probe",
  zoneId: "open-desert",
  spawnArea: "open-desert-overworld",
  spawnX: "521",
  spawnY: "520",
  facing: "right",
});

const hello = Promise.withResolvers();
room.onMessage("game.packet", (packet) => {
  if (packet?.type === "game.hello") hello.resolve(packet);
});
room.send("game.ready", {
  area_id: "open-desert-overworld",
  viewport_width_cells: 160,
  viewport_height_cells: 120,
  margin_cells: 64,
  center_actor_id: workerData.actorId,
});
const packet = await hello.promise;
if (packet.playerActorId !== workerData.actorId) throw new Error(`slow consumer joined as ${String(packet.playerActorId)}`);

const socket = room.connection.transport.ws?._socket;
if (!socket?.pause || !socket?.resume) throw new Error("slow-consumer worker did not receive a pausable Node WebSocket TCP socket");
const releaseSignal = new Int32Array(workerData.releaseSignal);
socket.pause();
parentPort.postMessage({ type: "paused" });
Atomics.wait(releaseSignal, 0, 0);
socket.resume();
await room.leave(true).catch(() => undefined);
parentPort.postMessage({ type: "closed" });
