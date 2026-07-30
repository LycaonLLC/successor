// A SimPlayer = a headless driver session (real-time tick, human pacing)
// + a chat-hub socket + a behaviour brain (personality-weighted). It exposes
// paced act()/say() primitives, a human-readable transcript, and feeds every
// driver step into the KPI/invariant monitors. Behaviours (activity loops +
// choreography) compose the PlayFlows primitives through this shell.
import { startPlayFlowDriver } from "../../successor/play-flows/client.mjs";
import { createFlowContext, query, issueAuthorityLine } from "../../successor/play-flows/primitives.mjs";
import { buildPersonality } from "./personality.mjs";
import { streamRng } from "./rng.mjs";
import { createKpi, recordStep, countChat } from "./kpi.mjs";
import { fetchJson, delay } from "./world.mjs";

export class SimPlayer {
  constructor({ baseSeed, body, archetype, repoRoot, gameUrl, slicePath, zone = "open-desert", onBeat, farm = false }) {
    this.baseSeed = baseSeed;
    this.body = body;
    this.actorId = body.id;
    this.name = body.name;
    this.archetype = archetype;
    this.repoRoot = repoRoot;
    this.gameUrl = gameUrl;
    this.slicePath = slicePath;
    this.zone = zone;
    this.personality = buildPersonality({ baseSeed, actorId: body.id, archetype });
    this.rng = streamRng(baseSeed, "brain", body.id);
    this.kpi = createKpi(this);
    this.transcript = [];
    this.onBeat = onBeat ?? (() => {});
    this.driver = null;
    this.ctx = null;
    this.chat = null;
    this.home = { areaId: body.areaId, x: body.x, y: body.y };
    this.alive = true;
    this.busy = false; // choreography lock
    this.farm = farm; // macro-uptime probe: minimal pacing, no idle/afk
    this.startMs = Date.now();
    this._queue = Promise.resolve();
  }

  // Serial per-actor task queue so the choreography director can claim a
  // SimPlayer between its solo activities without racing its driver.
  enqueue(fn) {
    const run = this._queue.then(() => fn());
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async boot(join) {
    this.driver = startPlayFlowDriver({
      repoRoot: this.repoRoot,
      gameUrl: this.gameUrl,
      slicePath: this.slicePath, // MUST match the server's materialized slice
      character: { id: this.body.id, name: this.body.name },
      join,
      spawnX: this.body.x,
      spawnY: this.body.y,
      facing: this.body.facing ?? "right",
    });
    await this.driver.waitFor((e) => e.type === "status" && e.status === "ready", `${this.name} ready`, 18_000);
    this.ctx = createFlowContext({
      flowName: `sim:${this.actorId}`,
      gameUrl: this.gameUrl,
      driver: this.driver,
      fetchJson: (url, init) => fetchJson(url, init),
      onStep: (step) => recordStep(this.kpi, step),
      defaultTimeoutMs: 14_000,
    });
    // A human client takes a beat to load in; let the authoritative position
    // reconcile before the first decision (validated: /where flips to server).
    await this.settle(1600);
    this.chat = await this.openChat().catch(() => null);
    const w = await this.where().catch(() => null);
    this.beat("login", `${this.name} (${this.personality.label}) logs in near (${w?.x ?? this.body.x},${w?.y ?? this.body.y}).`, { traits: this.personality.traits });
    return this;
  }

  // ---- pacing -------------------------------------------------------------
  async settle(ms) { await delay(ms); }

  async pace(kind = "reaction") {
    const p = this.personality.pacing;
    let ms;
    if (this.farm) { ms = kind === "idle" ? 120 : this.rng.latency(150, 90, 400); await delay(ms); return ms; }
    if (kind === "reaction") ms = this.rng.latency(p.reactionBaseMs, p.reactionSpreadMs, p.reactionSkewMilli);
    else if (kind === "step") ms = this.rng.latency(p.stepGapBaseMs, p.stepGapSpreadMs, 500);
    else if (kind === "idle") {
      if (this.rng.chanceMilli(p.afkChanceMilli)) {
        ms = this.rng.latency(p.afkBaseMs, p.afkSpreadMs, 500);
        this.beat("idle", `${this.name} steps away for a moment.`, { afkMs: ms });
      } else {
        ms = this.rng.latency(p.idleGapBaseMs, p.idleGapSpreadMs, 500);
      }
    } else ms = this.rng.latency(400, 300, 500);
    await delay(ms);
    return ms;
  }

  // ---- transcript ---------------------------------------------------------
  beat(kind, text, data = {}) {
    const entry = { ms: Date.now() - this.startMs, at: new Date().toISOString(), actor: this.name, archetype: this.personality.label, kind, text, ...data };
    this.transcript.push(entry);
    this.onBeat(this, entry);
    return entry;
  }

  // Run a paced deliberate action; failures are recorded, never thrown up as
  // fatal (a real player's action can fail — that is data, not a crash).
  async act(kind, label, fn) {
    await this.pace(kind);
    try {
      return await fn();
    } catch (error) {
      this.beat("warn", `${this.name}: ${label} did not land (${error.message}).`, { error: error.message, label });
      return { error: error.message };
    }
  }

  // ---- driver query wrappers ---------------------------------------------
  async where() { const r = await query(this.ctx, "/where"); return r.data; }
  async vitals() { const r = await query(this.ctx, "/vitals"); return r.data; }
  async inv(filter = "") { const r = await query(this.ctx, filter ? `/inv ${filter}` : "/inv"); return r.data; }
  async nearby(scope = "all") { const r = await query(this.ctx, `/nearby ${scope}`); return r.data; }

  authority(line, options = {}) { return issueAuthorityLine(this.ctx, line, options); }

  // ---- chat ---------------------------------------------------------------
  async openChat() {
    if (typeof WebSocket !== "function") return null;
    const url = new URL("/chat/ws", this.gameUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("playerId", this.actorId);
    url.searchParams.set("displayName", this.name);
    url.searchParams.set("zone", `${this.zone}-overworld`);
    const socket = new WebSocket(url.href);
    const heard = [];
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("chat hello timeout")), 8_000);
      socket.addEventListener("message", (ev) => {
        let packet; try { packet = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
        if (packet.type === "chat.hello") { clearTimeout(timer); resolve(); }
        if (packet.type === "chat.message" && packet.message?.sender?.id !== this.actorId) {
          heard.push(packet.message);
          this.beat("hear", `${this.name} hears ${packet.message.sender?.displayName ?? "someone"}: "${packet.message.body}"`, { channel: packet.message.channel });
        }
      });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("chat socket error")); });
    });
    await ready;
    return { socket, heard, seq: 0 };
  }

  async say(channel, line) {
    this.beat("say", `${this.name} says (${channel}): "${line}"`, { channel });
    countChat(this.kpi);
    if (!this.chat || this.chat.socket.readyState !== 1) return false;
    this.chat.seq += 1;
    this.chat.socket.send(JSON.stringify({ type: "chat.send", requestId: `${this.actorId}-${this.chat.seq}`, channel, body: line }));
    return true;
  }

  async close(reason = "logout") {
    this.alive = false;
    try { if (this.chat?.socket && this.chat.socket.readyState === 1) this.chat.socket.close(1000, reason); } catch {}
    if (this.driver) await this.driver.close().catch(() => {});
  }
}
