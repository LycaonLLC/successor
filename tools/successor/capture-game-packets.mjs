import { Client as ColyseusClient } from "@colyseus/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Parse arguments
const args = process.argv.slice(2);
let endpoint = "ws://127.0.0.1:28093";
let playerId = "dev-player-capture";
let actorId = "dev-player-capture";
let seconds = 5;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--endpoint" && args[i + 1]) {
    endpoint = args[i + 1];
    i++;
  } else if (args[i] === "--player-id" && args[i + 1]) {
    playerId = args[i + 1];
    i++;
  } else if (args[i] === "--actor-id" && args[i + 1]) {
    actorId = args[i + 1];
    i++;
  } else if (args[i] === "--seconds" && args[i + 1]) {
    seconds = parseFloat(args[i + 1]);
    i++;
  }
}

console.log(`Config: endpoint=${endpoint}, playerId=${playerId}, actorId=${actorId}, seconds=${seconds}`);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, "../../client-rust/source/client-proto/fixtures");

// Ensure fixtures directory exists
if (!fs.existsSync(fixturesDir)) {
  fs.mkdirSync(fixturesDir, { recursive: true });
}

// We set the dev identity environment variable to allow connections.
process.env.GAME_ALLOW_DEV_IDENTITY = "1";

async function main() {
  console.log("Connecting to Colyseus server...");
  let client;
  let room;
  try {
    client = new ColyseusClient(endpoint);
    const matchmakePromise = client.joinOrCreate("game", {
      playerId,
      actorId,
      displayName: "Packet Capture Agent",
      zoneId: "open-desert",
      spawnArea: "open-desert-overworld",
    });
    
    // Guard using a timeout so it doesn't hang forever
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Connection / Matchmake timed out")), 3000)
    );
    
    room = await Promise.race([matchmakePromise, timeoutPromise]);
    console.log(`Successfully joined room: ${room.roomId} (sessionId: ${room.sessionId})`);
  } catch (error) {
    console.log(`\n[Connection Guard] Could not connect to local authority server at ${endpoint}.`);
    console.log(`Reason: ${error.message}`);
    console.log("Exiting cleanly as instructed.\n");
    process.exit(0);
  }

  // Set up listeners
  const capturedTypes = new Set();
  room.onMessage("game.packet", (packet) => {
    if (packet && packet.type) {
      const type = packet.type;
      if (!capturedTypes.has(type)) {
        capturedTypes.add(type);
        const fileName = `${type.replace(".", "_")}.json`;
        const filePath = path.join(fixturesDir, fileName);
        fs.writeFileSync(filePath, JSON.stringify(packet, null, 2), "utf8");
        console.log(`Captured and wrote packet type "${type}" to fixtures/${fileName}`);
      }
    }
  });

  // Let it run for the specified number of seconds
  console.log(`Listening for packets for ${seconds} seconds...`);
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  
  console.log("Leaving room...");
  await room.leave(true).catch(() => {});
  console.log("Capture completed successfully.");
}

main().catch((err) => {
  console.error("Fatal error during capture:", err);
  process.exit(1);
});
