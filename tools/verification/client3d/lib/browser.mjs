// Browser driver + per-session step API for the client-3d journey harness.
//
// Uses Playwright Chromium by default; journeys marked headed launch a
// task-owned omp-headed-browser session and Playwright attaches over CDP.
// Gameplay keys are synthetic window KeyboardEvents; chat/clicks are real DOM
// events. Probes are read straight from the MAIN world via page.evaluate.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import { delay } from "./util.mjs";

const VIEWPORT = { width: 1440, height: 900 };
const CHAT_INPUT = ".sc3d-chat input.sc3d-chat-input";
const MANAGED_BROWSER_BIN = path.join(os.homedir(), "bin", "omp-headed-browser");
const MANAGED_SESSION_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const LOOPBACK_URL_RE = /^https?:\/\/127\.0\.0\.1(?::\d+)?(?:[/?#]|$)/u;
const MANAGED_BROWSER_TTL_SEC = 3600;
/** Renew well before lease expiry so long headed farms do not die mid-run. */
const MANAGED_BROWSER_RENEW_EVERY_MS = 30 * 60 * 1000;

/** Resolve playwright-core's chromium from the workspace (pnpm virtual store aware). */
export function loadChromium(repoRoot) {
  const failures = [];
  const specs = ["playwright", "@playwright/test", "playwright-core"];
  for (const base of [path.join(repoRoot, "package.json"), path.join(repoRoot, "client-3d", "package.json")]) {
    const req = createRequire(base);
    for (const spec of specs) {
      try {
        const mod = req(spec);
        if (mod.chromium) return { chromium: mod.chromium, resolvedFrom: `${spec} via ${base}` };
      } catch (error) { failures.push(`${spec}@${base}: ${error.message}`); }
    }
  }
  // pnpm virtual store fallback: node_modules/.pnpm/playwright@x/node_modules/playwright
  const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");
  try {
    const entries = fs.readdirSync(pnpmDir).filter((name) => /^playwright(-core)?@/u.test(name));
    entries.sort().reverse();
    for (const entry of entries) {
      const pkgName = entry.startsWith("playwright-core@") ? "playwright-core" : "playwright";
      const candidate = path.join(pnpmDir, entry, "node_modules", pkgName, "index.js");
      if (fs.existsSync(candidate)) {
        const req = createRequire(candidate);
        const mod = req(candidate);
        if (mod.chromium) return { chromium: mod.chromium, resolvedFrom: candidate };
      }
    }
  } catch (error) { failures.push(`pnpm-store: ${error.message}`); }
  throw new Error(`no playwright chromium available:\n${failures.join("\n")}`);
}

/**
 * Build a 1-32 char omp-headed-browser session name from a run id.
 * Long ids keep a short readable prefix plus a deterministic hash of the full
 * raw runId so farm shard ids that share a long prefix never collide.
 */
export function managedSessionName(runId) {
  const raw = String(runId ?? "");
  const clean = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const base = clean || "client3d";
  let name;
  if (base.length <= 32) {
    name = base;
  } else {
    const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
    // prefix + "-" + 8-hex digest must fit in 32 chars.
    const prefix = base.slice(0, 23).replace(/-+$/u, "") || "client3d";
    name = `${prefix}-${digest}`;
  }
  if (!MANAGED_SESSION_NAME_RE.test(name) || name.length < 1 || name.length > 32) {
    throw new Error(`managed browser session name out of contract: ${name}`);
  }
  return name;
}

/** Headed launch only accepts this harness's local Vite loopback URL. */
export function assertHeadedLoopbackUrl(url) {
  if (typeof url !== "string" || !LOOPBACK_URL_RE.test(url)) {
    throw new Error("headed browser requires a ready loopback http(s)://127.0.0.1 URL");
  }
  return url;
}

/** Parse start stdout for the owned session JSON row with a matching name + cdp_port. */
export function parseManagedSession(stdout, expectedName) {
  const lines = String(stdout ?? "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (
        value
        && value.name === expectedName
        && Number.isInteger(value.cdp_port)
        && value.cdp_port >= 1024
        && value.cdp_port <= 65535
      ) {
        return value;
      }
    } catch {
      /* try earlier line */
    }
  }
  throw new Error(`managed browser returned no matching session record for ${expectedName}`);
}

function managedBrowserCommand(argv) {
  return spawnSync(MANAGED_BROWSER_BIN, argv, { encoding: "utf8", timeout: 60_000 });
}

export function managedSessionPresent(result, expectedName) {
  if (!result || result.status !== 0) return true;
  const output = String(result.stdout ?? "").trim();
  if (!output) return false;
  try {
    const value = JSON.parse(output);
    return Array.isArray(value?.sessions) && value.sessions.some((session) => session?.name === expectedName);
  } catch {
    return true;
  }
}

/**
 * Stop one owned managed session and fail loud if status still lists it.
 * `command` / `wait` are injectable for deterministic unit tests.
 */
export async function stopManagedSession(name, command = managedBrowserCommand, wait = delay) {
  if (typeof name !== "string" || !MANAGED_SESSION_NAME_RE.test(name)) {
    throw new Error(`refusing to stop invalid managed browser name: ${name}`);
  }
  let stopped = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    command(["stop", name]);
    if (!managedSessionPresent(command(["status"]), name)) {
      stopped = true;
      break;
    }
    if (attempt < 11) await wait(500);
  }
  if (!stopped) throw new Error(`managed browser survivor: ${name}`);
  return { ok: true, name };
}

export function renewManagedSession(name, command = managedBrowserCommand) {
  if (typeof name !== "string" || !MANAGED_SESSION_NAME_RE.test(name)) {
    throw new Error(`refusing to renew invalid managed browser name: ${name}`);
  }
  const result = command(["renew", "--name", name, "--ttl", String(MANAGED_BROWSER_TTL_SEC)]);
  if (!result || result.status !== 0) {
    const detail = `${String(result?.stderr ?? "").trim()}\n${String(result?.stdout ?? "").trim()}`.trim();
    throw new Error(`managed browser renew failed for ${name}${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }
  return result;
}

/**
 * Keep an owned session lease alive until clear() runs.
 * Renewal failures are stored and rethrown from close so the verdict is visible.
 */
export function startManagedSessionRenewal(name, {
  command = managedBrowserCommand,
  everyMs = MANAGED_BROWSER_RENEW_EVERY_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let lastError = null;
  const timer = setIntervalFn(() => {
    try {
      renewManagedSession(name, command);
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }, everyMs);
  if (typeof timer?.unref === "function") timer.unref();
  return {
    name,
    get lastError() { return lastError; },
    takeError() {
      const error = lastError;
      lastError = null;
      return error;
    },
    clear() {
      clearIntervalFn(timer);
    },
  };
}

/**
 * Launch the browser used by 3D journeys. Headless remains the standard gate
 * mode. A journey declaring `headed: true` instead gets a task-owned
 * omp-headed-browser session; Playwright attaches over CDP.
 */
export async function launchBrowser(chromium, options = {}) {
  if (!options.headed) {
    return chromium.launch({
      headless: true,
      args: ["--no-sandbox", ...chromiumArgs()],
      timeout: 45000,
    });
  }
  const url = assertHeadedLoopbackUrl(options.url);
  const command = options.managedBrowserCommand ?? managedBrowserCommand;
  const wait = options.managedBrowserStartDelay ?? delay;

  const rawSeed = options.runId ?? options.sessionName;
  const sessionName1 = managedSessionName(rawSeed);
  const sessionName2 = managedSessionName(rawSeed ? `${rawSeed}-retry` : "client3d-retry");
  const candidateNames = [sessionName1, sessionName2];

  let started = null;
  let sessionName = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    sessionName = candidateNames[attempt];
    started = command([
      "start",
      sessionName,
      url,
      "--viewport",
      `${VIEWPORT.width}x${VIEWPORT.height}`,
      "--ttl",
      String(MANAGED_BROWSER_TTL_SEC),
      "--memory",
      "12G",
      "--cpu",
      "800%",
    ]);
    if (started.status === 0) {
      break;
    }
    // Nonzero start never establishes ownership — do not stop; the name may
    // already belong to another concurrent run.
    if (attempt === 0) {
      await wait(1000);
    }
  }

  if (started.status !== 0) {
    const detail = `${String(started.stderr ?? "").trim()}\n${String(started.stdout ?? "").trim()}`.trim();
    throw new Error(`managed browser ${sessionName} failed to start${detail ? `: ${detail.slice(0, 400)}` : ""}`);
  }

  let browser = null;
  let renewal = null;
  let owned = true;
  const clearRenewal = () => {
    if (!renewal) return;
    renewal.clear();
    renewal = null;
  };
  try {
    const session = parseManagedSession(started.stdout, sessionName);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${session.cdp_port}`);
    renewal = startManagedSessionRenewal(sessionName, { command });
  } catch (error) {
    clearRenewal();
    if (browser) await browser.close().catch(() => {});
    if (owned) {
      owned = false;
      await stopManagedSession(sessionName, command);
    }
    throw error;
  }

  const disconnect = browser.close.bind(browser);
  browser.close = async () => {
    const renewError = renewal?.takeError?.() ?? renewal?.lastError ?? null;
    clearRenewal();
    try {
      await disconnect();
    } finally {
      if (owned) {
        owned = false;
        await stopManagedSession(sessionName, command);
      }
    }
    if (renewError) throw renewError;
  };
  browser.__managedSessionName = sessionName;
  return browser;
}

function chromiumArgs() {
  return [
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ];
}

const GAME_KEY = { KeyW: "w", KeyA: "a", KeyS: "s", KeyD: "d", KeyF: "f", KeyG: "g", KeyM: "m", KeyE: "e", ShiftLeft: "Shift", Tab: "Tab", Escape: "Escape", KeyR: "r" };
function keyFor(code) { return GAME_KEY[code] ?? code; }

export class JourneyAssertionError extends Error {}

/**
 * A single browser session bound to one backend (gamePort) + one character.
 * Carries the step API journeys drive. Two-browser journeys hold two Sessions
 * over the SAME backend.
 */
/**
 * Pure charselect row readiness for enterWorld. Link-dead rows stay
 * interactable — CharacterSelect exposes RECONNECT (LD) on that exact row.
 * Only attachment + visibility gate entry attempts.
 */
export function charSelectRowIsInteractable(snapshot) {
  if (!snapshot || snapshot.connected !== true) return false;
  if (snapshot.display === "none" || snapshot.visibility === "hidden") return false;
  if (snapshot.opacity === "0") return false;
  return true;
}

/** Selection is latched only when the exact target row carries data-active. */
export function charSelectRowIsSelected(snapshot) {
  return Boolean(snapshot && snapshot.connected === true && snapshot.active === true);
}

/** ENTER/RECONNECT is activatable only when the exact row is active and the button is enabled. */
export function charSelectEnterReady(snapshot) {
  return Boolean(
    snapshot
      && snapshot.rowConnected === true
      && snapshot.rowActive === true
      && snapshot.enterConnected === true
      && snapshot.enterEnabled === true
      && snapshot.focused === true
  );
}

export class Session {
  constructor({ browser, name, gamePort, vitePort, actorId, shotsDir, shotPrefix }) {
    this.browser = browser;
    this.name = name;
    this.gamePort = gamePort;
    this.vitePort = vitePort;
    this.actorId = actorId;
    this.shotsDir = shotsDir;
    this.shotPrefix = shotPrefix;
    this.gameUrl = `http://127.0.0.1:${gamePort}`;
    this.context = null;
    this.page = null;
    this.console = [];
    this.pageErrors = [];
    this.screenshots = [];
  }

  async open() {
    this.context = await this.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    this.page.setDefaultNavigationTimeout(45000);
    this.page.on("console", (msg) => {
      const type = msg.type();
      if (type === "error" || type === "warning") this.console.push({ type, text: msg.text(), at: Date.now() });
    });
    this.page.on("pageerror", (error) => this.pageErrors.push({ message: error.stack ?? error.message, at: Date.now() }));
  }

  async close() {
    await this.context?.close().catch(() => {});
  }

  // ── navigation + spawn ────────────────────────────────────────────────
  async goto(url) {
    // Headed multi-context: a freshly opened second page is often backgrounded.
    // Front it before navigation so boot/charselect is not throttled mid-goto
    // (duel-headed-r1 timed out in page.goto before enterWorld ran).
    if (this.page && typeof this.page.bringToFront === "function") {
      await this.page.bringToFront();
    }
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  /** Real character-select -> ENTER WORLD -> spawn. Waits until connected. */
  async enterWorld(characterId, { timeoutMs = 45000 } = {}) {
    // Headed multi-context journeys (deathblow) open two CDP pages in one
    // managed browser. Chromium throttles background pages hard enough that
    // the second session can accept authority then stall world hydration
    // (probe stays disconnected while the row shows LD). Bring this page to
    // the front before charselect work and again immediately before ENTER so
    // the connected wait runs on a live renderer.
    if (this.page && typeof this.page.bringToFront === "function") {
      await this.page.bringToFront();
    }
    // 1. character-select roster online with our probe char present.
    await this.waitFn(
      "!!window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.serverOnline === true && window.__successor3dCharacterSelect.characterCount >= 1",
      { timeoutMs: 20000, label: "charselect roster online" },
    );
    // 2. select the probe character row. Headed multi-session charselect can
    //    rebuild the roster DOM mid-click (including linkdead/reconnect flaps);
    //    re-resolve the exact-id row each attempt. Link-dead rows remain valid —
    //    RECONNECT (LD) is the intentional entry path for that state.
    const rowSel = `.sc3d-cs-row[data-character-id="${characterId}"]`;
    const readRowSnapshot = async () => this.page.evaluate((id) => {
      const row = document.querySelector(`.sc3d-cs-row[data-character-id="${id}"]`);
      if (!(row instanceof HTMLElement) || !row.isConnected) {
        return { connected: false, active: false, display: "none", visibility: "hidden", opacity: "0", linkdead: false };
      }
      const style = window.getComputedStyle(row);
      return {
        connected: true,
        active: row.hasAttribute("data-active"),
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        linkdead: row.hasAttribute("data-linkdead"),
      };
    }, characterId);
    const rowReady = async () => {
      await this.page.waitForFunction(
        (id) => {
          const row = document.querySelector(`.sc3d-cs-row[data-character-id="${id}"]`);
          if (!(row instanceof HTMLElement) || !row.isConnected) return false;
          const style = window.getComputedStyle(row);
          // Link-dead is allowed (RECONNECT path). Attachment + visibility only.
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        },
        characterId,
        { timeout: 20000 },
      );
    };
    let selected = false;
    let lastError = null;
    for (let attempt = 0; attempt < 4 && !selected; attempt += 1) {
      try {
        await rowReady();
        const snap = await readRowSnapshot();
        if (!charSelectRowIsInteractable(snap)) {
          throw new Error(`row not interactable: ${JSON.stringify(snap)}`);
        }
        const row = this.page.locator(rowSel).first();
        await row.waitFor({ state: "visible", timeout: 5000 });
        await row.click({ timeout: 5000 });
        // Latch requires the EXACT target row to carry data-active — never a
        // sibling selection that merely enables ENTER/RECONNECT.
        await this.page.waitForFunction(
          (id) => {
            const row = document.querySelector(`.sc3d-cs-row[data-character-id="${id}"]`);
            return row instanceof HTMLElement && row.isConnected && row.hasAttribute("data-active");
          },
          characterId,
          { timeout: 4000 },
        );
        const latched = await readRowSnapshot();
        if (!charSelectRowIsSelected(latched)) {
          throw new Error(`exact row not data-active after click: ${JSON.stringify(latched)}`);
        }
        selected = true;
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    if (!selected) {
      throw new JourneyAssertionError(
        `[${this.name}] timed out selecting character row ${characterId}: ${lastError?.message ?? "unknown"}`,
      );
    }
    // 3. ENTER WORLD / RECONNECT enabled -> activate (re-resolve; roster rebuilds can detach).
    //    Button copy is ENTER WORLD or RECONNECT (LD); both share data-ref=enterButton.
    //    deathblow-r6/r9: locator.click and locator.waitFor/focus raced roster rebuilds
    //    (ready button detached after snapshot). ONE atomic evaluate validates the exact
    //    row + button and focuses without scroll; page.keyboard.press then fires trusted
    //    Enter with no second locator stage.
    await this.page.waitForFunction(
      (id) => {
        const row = document.querySelector(`.sc3d-cs-row[data-character-id="${id}"]`);
        const enter = document.querySelector('.sc3d-charselect [data-ref="enterButton"]');
        return row instanceof HTMLElement
          && row.isConnected
          && row.hasAttribute("data-active")
          && enter instanceof HTMLButtonElement
          && !enter.disabled;
      },
      characterId,
      { timeout: 20000 },
    );
    if (this.page && typeof this.page.bringToFront === "function") {
      await this.page.bringToFront();
    }
    const enterSnap = await this.page.evaluate((id) => {
      const row = document.querySelector(`.sc3d-cs-row[data-character-id="${id}"]`);
      const enter = document.querySelector('.sc3d-charselect [data-ref="enterButton"]');
      const rowConnected = row instanceof HTMLElement && row.isConnected;
      const rowActive = rowConnected && row.hasAttribute("data-active");
      const enterConnected = enter instanceof HTMLButtonElement && enter.isConnected;
      const enterEnabled = enterConnected && !enter.disabled;
      let focused = false;
      if (rowConnected && rowActive && enterConnected && enterEnabled) {
        enter.focus({ preventScroll: true });
        focused = document.activeElement === enter;
      }
      return { rowConnected, rowActive, enterConnected, enterEnabled, focused };
    }, characterId);
    if (!charSelectEnterReady(enterSnap)) {
      throw new JourneyAssertionError(
        `[${this.name}] ENTER/RECONNECT not ready/focused for ${characterId}: ${JSON.stringify(enterSnap)}`,
      );
    }
    await this.page.keyboard.press("Enter");
    // 4. world frame loop connected + authoritative pawn present.
    await this.waitFn(
      "!!window.__successor3d && window.__successor3d.serverStatus === \"connected\" && !!window.__successor3d.authorityPlayer",
      { timeoutMs, label: "world connected" },
    );
    // 5. the planetfall load screen swallows keydowns while active
    //    (input.ts isLoadScreenActive gate) — wait it out before any driving.
    await this.waitLoadScreenClear();
    // 6. the interactive HUD (chat input + window dock) must be mounted before
    //    any slash/hotkey driving — under shared-vite load this lags connect.
    await this.page.waitForSelector(CHAT_INPUT, { state: "attached", timeout: 10000 });
    await this.page.waitForSelector(".sc3d-dock", { state: "attached", timeout: 10000 });
    // settle a few frames so the pawn is rendered before the first shot.
    await delay(700);
  }

  /** Block until no ACTIVE (non-fading) planetfall load screen holds the frame. */
  async waitLoadScreenClear({ timeoutMs = 14000 } = {}) {
    await this.waitFn(
      '() => !document.querySelector(".sc3d-loadscreen:not(.sc3d-loadscreen--fading)")',
      { timeoutMs, label: "load screen cleared" },
    );
    await delay(200);
  }

  // ── probe reads (main world) ──────────────────────────────────────────
  async probe(name = "__successor3d") {
    // Playwright deep-serializes the return value; probes are plain data.
    // Return null (not throw) when absent so waitProbe can poll pre-spawn.
    return this.page.evaluate((n) => (window)[n] ?? null, name);
  }

  /** __successorFx.debug() snapshot (lastArrival etc.), or null. */
  async fx() {
    return this.page.evaluate(() => {
      try { return window.__successorFx?.debug?.() ?? null; } catch { return null; }
    });
  }

  /** Evaluate an expression string in the main world; returns its value. */
  async evalExpr(expr) {
    return this.page.evaluate((e) => {
      // eslint-disable-next-line no-new-func
      return new Function(`return (${e});`)();
    }, expr);
  }

  async oracle() {
    const { getJson } = await import("./util.mjs");
    return getJson(`${this.gameUrl}/game/debug/oracle?freshAiDebug=1`, 3000);
  }

  async debugCommand(command) {
    const { postJson } = await import("./util.mjs");
    return postJson(`${this.gameUrl}/game/debug/authority-command`, { actorId: this.actorId, command });
  }

  async restockLoadout() {
    const { postJson } = await import("./util.mjs");
    return postJson(`${this.gameUrl}/game/debug/restock-loadout`, { actorId: this.actorId });
  }

  // ── waits ─────────────────────────────────────────────────────────────
  /**
   * Wait until a main-world boolean EXPRESSION is true. `expr` MUST be a plain
   * JS expression (re-evaluated each poll), never an arrow function — Playwright
   * treats an arrow-function string as an expression and a function object is
   * truthy, so `"() => cond"` would resolve immediately.
   */
  async waitFn(expr, { timeoutMs = 15000, label = "condition", pollMs = 150 } = {}) {
    try {
      await this.page.waitForFunction(expr, undefined, { timeout: timeoutMs, polling: pollMs });
    } catch (error) {
      throw new JourneyAssertionError(`[${this.name}] timed out waiting for ${label} (${timeoutMs}ms): ${error.message}`);
    }
  }

  /** Wait until the named probe satisfies predicate(probe). */
  async waitProbe(predicate, { timeoutMs = 15000, label = "probe", name = "__successor3d", intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() <= deadline) {
      last = await this.probe(name);
      if (last && predicate(last)) return last;
      await delay(intervalMs);
    }
    throw new JourneyAssertionError(`[${this.name}] timed out waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 400)}`);
  }

  /** Wait until an async producer's value satisfies predicate (probe-style). */
  async waitProbeCall(producer, predicate, { timeoutMs = 8000, label = "probe call", intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() <= deadline) {
      last = await producer();
      if (predicate(last)) return last;
      await delay(intervalMs);
    }
    throw new JourneyAssertionError(`[${this.name}] timed out waiting for ${label}; last=${JSON.stringify(last)?.slice(0, 400)}`);
  }

  async waitDom(selector, { state = "visible", timeoutMs = 10000 } = {}) {
    try {
      await this.page.waitForSelector(selector, { state, timeout: timeoutMs });
    } catch (error) {
      throw new JourneyAssertionError(`[${this.name}] DOM wait failed for ${selector} (${state}): ${error.message}`);
    }
  }

  // ── input ─────────────────────────────────────────────────────────────
  async dispatchKeys(type, codes) {
    const events = codes.map((code) => ({ code, key: keyFor(code) }));
    await this.page.evaluate(({ evType, keyEvents }) => {
      for (const e of keyEvents) {
        window.dispatchEvent(new KeyboardEvent(evType, { code: e.code, key: e.key, bubbles: true, cancelable: true }));
      }
    }, { evType: type, keyEvents: events });
  }

  /** Hold codes down for ms, then release (reverse order). */
  async hold(codes, ms) {
    const arr = Array.isArray(codes) ? codes : [codes];
    await this.dispatchKeys("keydown", arr);
    await delay(ms);
    await this.dispatchKeys("keyup", [...arr].reverse());
    await delay(120);
  }

  /** Tap a single key (down+up). */
  async press(code) {
    await this.dispatchKeys("keydown", [code]);
    await delay(60);
    await this.dispatchKeys("keyup", [code]);
    await delay(120);
  }

  async releaseAll() {
    await this.dispatchKeys("keyup", ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft"]).catch(() => {});
  }

  /**
   * Type a chat line into the chat input and submit (real DOM events). The
   * chat pane clears the input on submit, so an empty value confirms the line
   * landed; retry once if a transient (first-frame focus race) drops it.
   */
  async slash(line) {
    await this.page.waitForSelector(CHAT_INPUT, { state: "attached", timeout: 8000 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.page.fill(CHAT_INPUT, line);
      await this.page.press(CHAT_INPUT, "Enter");
      await delay(200);
      const leftover = await this.page.inputValue(CHAT_INPUT).catch(() => "");
      if (leftover === "") return;
      await delay(250);
    }
    // Final attempt left the value in the box — clear it so it can't leak.
    await this.page.fill(CHAT_INPUT, "").catch(() => {});
  }

  async click(selector) {
    await this.page.click(selector, { timeout: 8000 });
    await delay(120);
  }

  async dblclick(selector) {
    await this.page.dblclick(selector, { timeout: 8000 });
    await delay(120);
  }

  // ── assertions ────────────────────────────────────────────────────────
  async assertDom(selector, { visible = true } = {}, message) {
    const count = await this.page.locator(selector).count();
    const present = visible ? await this.page.locator(selector).first().isVisible().catch(() => false) : count > 0;
    if (visible && !present) throw new JourneyAssertionError(message ?? `[${this.name}] expected visible ${selector}`);
    if (!visible && count > 0) {
      const stillVisible = await this.page.locator(selector).first().isVisible().catch(() => false);
      if (stillVisible) throw new JourneyAssertionError(message ?? `[${this.name}] expected ${selector} not visible`);
    }
    return present;
  }

  assert(condition, message) {
    if (!condition) throw new JourneyAssertionError(`[${this.name}] ${message}`);
  }

  /** Read the named probe once and assert a predicate over it. */
  async assertProbe(predicate, message, name = "__successor3d") {
    const probe = await this.probe(name);
    if (!probe || !predicate(probe)) {
      throw new JourneyAssertionError(`[${this.name}] ${message}; probe=${JSON.stringify(probe)?.slice(0, 300)}`);
    }
    return probe;
  }

  // ── proof ─────────────────────────────────────────────────────────────
  async shot(step, options = {}) {
    const type = options.type === "jpeg" ? "jpeg" : "png";
    const extension = type === "jpeg" ? "jpg" : "png";
    const file = path.join(this.shotsDir, `${this.shotPrefix}-${step}.${extension}`);
    await this.page.screenshot({
      path: file,
      fullPage: false,
      type,
      ...(options.clip ? { clip: options.clip } : {}),
      ...(type === "jpeg" ? { quality: options.quality ?? 90 } : {}),
    });
    this.screenshots.push({ step, path: file });
    return file;
  }
}
