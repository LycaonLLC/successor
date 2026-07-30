#!/usr/bin/env node
/**
 * Local fake of the standalone alpha API — just enough surface for smoking a
 * packaged successor-tui against device sign-in, character listing, launch
 * minting, and logout. Plain node:http, no dependencies, loopback only.
 *
 *   node test/fakeAlphaApi.mjs [--port N] [--approve-after N]
 *
 * Prints `FAKE_ALPHA_API http://127.0.0.1:<port>` once listening. Device
 * authorizations auto-approve after --approve-after polls (default 1).
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] !== undefined ? Number(args[at + 1]) : fallback;
};
const port = flag("--port", 0);
const approveAfter = flag("--approve-after", 1);

const devices = new Map(); // deviceCode -> { polls, status }
const credentials = new Set();

const CHARACTERS = [
  { id: "char_vex", name: "Vex Marrow", appearance: {}, worn: {}, initialProfessionId: "scout", worldEntryClaimed: true },
  { id: "char_tally", name: "Tally Bright", appearance: {}, worn: {}, initialProfessionId: "medic", worldEntryClaimed: false },
];

function token() {
  return randomBytes(32).toString("base64url");
}

function send(response, status, body) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(payload);
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/u.exec(request.headers.authorization ?? "");
  return match ? match[1] : undefined;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

const server = createServer(async (request, response) => {
  const { method, url } = request;
  if (method === "POST" && url === "/alpha-api/device/start") {
    const body = await readJson(request);
    if (!body?.clientId || !body?.releaseId || !Array.isArray(body?.scopes)) return send(response, 400, { error: "invalid_request" });
    const deviceCode = token();
    devices.set(deviceCode, { polls: 0 });
    return send(response, 201, {
      authorizationId: `device_${randomBytes(8).toString("hex")}`,
      deviceCode,
      userCode: "FAKECODE42",
      expiresAt: Date.now() + 600_000,
      pollIntervalMs: 5000,
      scopes: body.scopes,
    });
  }
  if (method === "POST" && url === "/alpha-api/device/poll") {
    const body = await readJson(request);
    const device = devices.get(body?.deviceCode);
    if (!device) return send(response, 404, { error: "device_not_found" });
    device.polls += 1;
    if (device.polls > approveAfter) {
      const credential = token();
      credentials.add(credential);
      devices.delete(body.deviceCode);
      return send(response, 200, { status: "exchanged", expiresAt: Date.now() + 600_000, credential, scopes: ["character:list", "play-ticket"] });
    }
    return send(response, 200, { status: "pending", expiresAt: Date.now() + 600_000 });
  }
  if (method === "POST" && url === "/alpha-api/device/logout") {
    const credential = bearer(request);
    if (credential) credentials.delete(credential);
    return send(response, 204);
  }
  if (method === "GET" && url === "/alpha-api/characters") {
    if (!credentials.has(bearer(request) ?? "")) return send(response, 401, { error: "invalid_auth" });
    return send(response, 200, { characters: CHARACTERS });
  }
  if (method === "POST" && url === "/alpha-api/play-ticket") {
    if (!credentials.has(bearer(request) ?? "")) return send(response, 401, { error: "invalid_auth" });
    const body = await readJson(request);
    const character = CHARACTERS.find((entry) => entry.id === body?.characterId);
    if (!character) return send(response, 404, { error: "character_not_found" });
    return send(response, 200, {
      gameTicket: token(),
      chatTicket: token(),
      characterId: character.id,
      expiresAt: Date.now() + 45_000,
      endpoints: { game: `http://127.0.0.1:${server.address().port}`, chat: "" },
      release: { client: "dev", server: "dev", shard: "open-desert" },
    });
  }
  return send(response, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`FAKE_ALPHA_API http://127.0.0.1:${server.address().port}\n`);
});
