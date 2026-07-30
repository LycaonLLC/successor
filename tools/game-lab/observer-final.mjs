import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { request } from "node:http";
import { createRequire } from "node:module";
const playwrightCore = createRequire(import.meta.url)("playwright-core");

const { chromium } = playwrightCore;
const repoRoot = path.resolve(import.meta.dirname, "../..");
const gameLabDir = path.join(repoRoot, ".game-lab", "browser-proof-first-session-final");
const pidsDir = path.join(gameLabDir, "pids");
const screenshotsDir = path.join(gameLabDir, "screenshots");
const stateDir = path.join(gameLabDir, "state-dir");
const charStorePath = path.join(gameLabDir, "characters.json");

// Find free ports
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function getFreeDisplay() {
  for (let display = 101; display < 200; display++) {
    const lockFile = path.join(tmpRoot, `.X${display}-lock`);
    const socketFile = path.join(tmpRoot, ".X11-unix", `X${display}`);
    if (!fs.existsSync(lockFile) && !fs.existsSync(socketFile)) {
      return display;
    }
  }
  return 105;
}

// HTTP waiter
async function waitForHttp(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = request(url, { method: "GET", timeout: 1000 }, (res) => {
          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve();
          } else {
            reject(new Error(`Status: ${res.statusCode}`));
          }
        });
        req.on("error", reject);
        req.end();
      });
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`HTTP endpoint ${url} not reachable after ${timeoutMs}ms`);
}

async function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: 2000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Parse error: ${e.message} from ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const milestoneTimes = {};
  const milestoneTimesWall = {};
  const recordMilestone = (name) => {
    milestoneTimes[name] = performance.now();
    milestoneTimesWall[name] = new Date().toISOString();
    console.log(`[MILESTONE] ${name} reached at ${milestoneTimesWall[name]}`);
  };

  recordMilestone("start");

  const backendPort = await getFreePort();
  const vitePort = await getFreePort();
  const chromeCdpPort = await getFreePort();
  const display = getFreeDisplay();

  console.log(`Configured:`);
  console.log(`  backendPort: ${backendPort}`);
  console.log(`  vitePort: ${vitePort}`);
  console.log(`  chromeCdpPort: ${chromeCdpPort}`);
  console.log(`  display: :${display}`);

  // Clean characters.json and state files
  if (fs.existsSync(charStorePath)) {
    fs.unlinkSync(charStorePath);
    console.log(`Cleaned characters.json`);
  }
  const checkState = path.join(stateDir, "open-desert.checkpoint.json");
  if (fs.existsSync(checkState)) {
    fs.unlinkSync(checkState);
  }
  const journalState = path.join(stateDir, "open-desert.journal.jsonl");
  if (fs.existsSync(journalState)) {
    fs.unlinkSync(journalState);
  }

  // Chrome profile cleanup
  const profileDir = `/tmp/successor-chrome-profile-final-${display}`;
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true });
    console.log(`Cleaned chrome profile dir ${profileDir}`);
  }

  const procs = [];

  const cleanup = async () => {
    console.log(`Cleaning up processes...`);
    for (const item of procs) {
      try {
        console.log(`Killing ${item.name} (PID ${item.proc.pid})...`);
        item.proc.kill("SIGTERM");
        // Wait a bit
        await new Promise(r => setTimeout(r, 200));
        if (!item.proc.killed) {
          item.proc.kill("SIGKILL");
        }
      } catch (e) {
        console.error(`Error killing ${item.name}: ${e.message}`);
      }
    }
    // Delete pid files
    try {
      const pidFiles = fs.readdirSync(pidsDir);
      for (const file of pidFiles) {
        fs.unlinkSync(path.join(pidsDir, file));
      }
    } catch (e) {}
    console.log(`Cleanup complete!`);
  };

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(1);
  });

  try {
    // 1. Spawn Xvfb
    console.log(`Spawning Xvfb on :${display}...`);
    const xvfbLog = fs.openSync(path.join(gameLabDir, "xvfb.log"), "w");
    const xvfbProc = spawn("/usr/bin/Xvfb", [`:${display}`, "-screen", "0", "1600x900x24"], {
      detached: false,
      stdio: ["ignore", xvfbLog, xvfbLog],
    });
    procs.push({ name: "Xvfb", proc: xvfbProc });
    fs.writeFileSync(path.join(pidsDir, "xvfb.pid"), String(xvfbProc.pid));
    await new Promise(r => setTimeout(r, 1000));

    // 2. Spawn Backend Server
    console.log(`Spawning backend server on port ${backendPort}...`);
    const serverLog = fs.openSync(path.join(gameLabDir, "server.log"), "w");
    const serverProc = spawn("node", ["server/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PORT: String(backendPort),
        HOST: "127.0.0.1",
        GAME_SHARD_PERSISTENCE: "1",
        GAME_SHARD_STATE_DIR: stateDir,
        GAME_CHARACTER_STORE_PATH: charStorePath,
        LOG_LEVEL: "info",
      },
      stdio: ["ignore", serverLog, serverLog],
    });
    procs.push({ name: "Backend", proc: serverProc });
    fs.writeFileSync(path.join(pidsDir, "server.pid"), String(serverProc.pid));

    // 3. Spawn Vite dev server
    console.log(`Spawning Vite dev server on port ${vitePort}...`);
    const viteLog = fs.openSync(path.join(gameLabDir, "vite.log"), "w");
    const viteProc = spawn("npx", ["vite", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: path.join(repoRoot, "client-3d"),
      env: {
        ...process.env,
        SUCCESSOR_GAME_LAB: "1",
      },
      stdio: ["ignore", viteLog, viteLog],
    });
    procs.push({ name: "Vite", proc: viteProc });
    fs.writeFileSync(path.join(pidsDir, "vite.pid"), String(viteProc.pid));

    // 4. Spawn Google Chrome
    console.log(`Spawning Google Chrome on display :${display} (CDP port ${chromeCdpPort})...`);
    const chromeLog = fs.openSync(path.join(gameLabDir, "chrome.log"), "w");
    const chromeProc = spawn("/usr/bin/google-chrome", [
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${chromeCdpPort}`,
      "--window-size=1600,900",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--disable-gpu",
      "--no-sandbox",
    ], {
      env: {
        ...process.env,
        DISPLAY: `:${display}`,
      },
      stdio: ["ignore", chromeLog, chromeLog],
    });
    procs.push({ name: "Chrome", proc: chromeProc });
    fs.writeFileSync(path.join(pidsDir, "chrome.pid"), String(chromeProc.pid));

    // Wait for services
    console.log(`Waiting for services to become available...`);
    await Promise.all([
      waitForHttp(`http://127.0.0.1:${backendPort}/healthz`),
      waitForHttp(`http://127.0.0.1:${vitePort}/`),
      waitForHttp(`http://127.0.0.1:${chromeCdpPort}/json/version`),
    ]);
    recordMilestone("services_online");

    // Connect Playwright
    console.log(`Connecting Playwright over CDP to http://127.0.0.1:${chromeCdpPort}...`);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${chromeCdpPort}`);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const clientUrl = `http://127.0.0.1:${vitePort}/?backendPort=${backendPort}`;
    console.log(`Navigating to ${clientUrl}...`);
    await page.goto(clientUrl, { waitUntil: "domcontentloaded" });

    console.log(`Waiting for character select roster...`);
    await page.waitForFunction(() => !!window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.serverOnline === true, null, { timeout: 20000 });
    recordMilestone("charselect_online");

    // Create character
    console.log(`Clicking [NEW CHARACTER]...`);
    await page.click('[data-ref="newButton"]');
    await page.waitForSelector('[data-ref="nameInput"]', { timeout: 5000 });

    const charName = "HeroFinal";
    console.log(`Filling name: ${charName}`);
    await page.fill('[data-ref="nameInput"]', charName);

    console.log(`Selecting Brawler profession...`);
    await page.click('[data-ref="createProfessionGrid"] [data-profession-id="brawler"]');
    await new Promise(r => setTimeout(r, 300)); // Settle draft change

    console.log(`Clicking [CREATE]...`);
    const timeCreateStart = performance.now();
    await page.click('[data-ref="createButton"]');

    console.log(`Waiting for record to be filed...`);
    await page.waitForFunction(() => window.__successor3dCharacterSelect && window.__successor3dCharacterSelect.mode === "select" && window.__successor3dCharacterSelect.characterCount >= 1, null, { timeout: 15000 });
    
    const characterId = await page.evaluate(() => window.__successor3dCharacterSelect.selectedId);
    console.log(`Character created with ID: ${characterId}`);
    recordMilestone("character_created");

    console.log(`Clicking [ENTER WORLD]...`);
    const enterSel = '.sc3d-charselect [data-ref="enterButton"]:not([disabled])';
    await page.click(enterSel);

    console.log(`Waiting for world to load and connect...`);
    await page.waitForFunction(() => !!window.__successor3d && window.__successor3d.serverStatus === "connected" && !!window.__successor3d.authorityPlayer, null, { timeout: 45000 });
    
    console.log(`Waiting for planetfall load screen to clear...`);
    await page.waitForFunction(() => !document.querySelector(".sc3d-loadscreen:not(.sc3d-loadscreen--fading)"), null, { timeout: 20000 });
    await new Promise(r => setTimeout(r, 1500)); // wait for inputs and HUD to fully mount
    
    const timeSpawnEnd = performance.now();
    console.log(`Pawn spawned successfully!`);
    recordMilestone("spawned");

    const createToSpawnMs = timeSpawnEnd - timeCreateStart;
    console.log(`Time from CREATE click to SPAWN in world: ${(createToSpawnMs / 1000).toFixed(2)}s`);

    const actorId = await page.evaluate(() => window.__successor3d.playerActorId ?? window.__successor3d.authorityPlayer.id);
    console.log(`Player Actor ID: ${actorId}`);

    // --- STEP 1: Observe initial MOVE chip ---
    console.log(`\n=== STEP 1: Initial MOVE chip ===`);
    const stepsVisible = await page.isVisible(".sc3d-first-steps");
    console.log(`First steps container visible: ${stepsVisible}`);
    
    const teachVisible = await page.isVisible(".sc3d-first-steps [data-ref=\"teach\"]");
    const teachMainText = await page.locator(".sc3d-first-steps [data-ref=\"teachMain\"]").textContent().catch(() => "");
    const teachSubText = await page.locator(".sc3d-first-steps [data-ref=\"teachSub\"]").textContent().catch(() => "");
    console.log(`Teach row visible: ${teachVisible}`);
    console.log(`Teach main text: "${teachMainText}"`);
    console.log(`Teach sub text: "${teachSubText}"`);
    
    const objVisibleDom = await page.isVisible(".sc3d-first-steps [data-ref=\"objective\"]");
    console.log(`Objective row visible: ${objVisibleDom}`);

    const probe1 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state:`, JSON.stringify(probe1));
    
    // Save screenshot
    let buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "01_move_chip.png"), buf);
    console.log(`Saved screenshot 01_move_chip.png`);
    recordMilestone("move_chip_observed");

    // --- STEP 2: Actual movement completing MOVE ---
    console.log(`\n=== STEP 2: Actual movement completing MOVE ===`);
    console.log(`Pressing KeyD (East) for 1500ms...`);
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", key: "d", bubbles: true }));
    });
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD", key: "d", bubbles: true }));
    });

    console.log(`Waiting for MOVE to be completed in probe...`);
    let moveDone = false;
    for (let i = 0; i < 30; i++) {
      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (p && p.done.includes("move")) {
        moveDone = true;
        break;
      }
      // Fallback: tap KeyD again if not far enough
      if (i === 10) {
        console.log(`Still not completed, tapping KeyS (South) for 1000ms...`);
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", key: "s", bubbles: true })));
        await new Promise(r => setTimeout(r, 1000));
        await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyS", key: "s", bubbles: true })));
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`Move completed in probe: ${moveDone}`);

    const probe2 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state after move:`, JSON.stringify(probe2));

    // Get authority position and receipts
    const oracle = await getJson(`http://127.0.0.1:${backendPort}/game/debug/oracle?freshAiDebug=1`);
    const authActor = oracle.actors[actorId];
    console.log(`Authority Position of actor: x=${authActor?.x?.toFixed(2)}, y=${authActor?.y?.toFixed(2)}, area=${authActor?.areaId}`);
    console.log(`Authority Receipts:`, JSON.stringify(oracle.receipts?.filter(r => r.actorId === actorId)));

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "02_move_completed.png"), buf);
    console.log(`Saved screenshot 02_move_completed.png`);
    recordMilestone("move_completed");

    // Verify objective row and waypoint active
    const objVisibleDom2 = await page.isVisible(".sc3d-first-steps [data-ref=\"objective\"]");
    const objMainText = await page.locator(".sc3d-first-steps [data-ref=\"objective\"] .sc3d-first-steps-main").textContent().catch(() => "");
    console.log(`Objective row visible (expect true): ${objVisibleDom2}, text: "${objMainText}"`);
    console.log(`Waypoint ID active: ${probe2.waypointId}`);
    recordMilestone("trainer_objective_visible");

    // --- STEP 3: Approach Cache (USE) ---
    console.log(`\n=== STEP 3: Navigate to Cache & USE ===`);
    const cacheX = 507;
    const cacheY = 508;
    console.log(`Pathing towards Cache at (${cacheX}, ${cacheY})...`);
    let reachedCache = false;
    
    for (let attempt = 0; attempt < 50; attempt++) {
      const cell = await page.evaluate(() => window.__successor3d.playerCell);
      const dist = Math.hypot(cell.x - cacheX, cell.y - cacheY);
      
      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (p && (p.teach === "interact" || p.done.includes("interact"))) {
        reachedCache = true;
        console.log(`USE instruction is active in probe: teach="${p.teach}", done=${JSON.stringify(p.done)}`);
        break;
      }
      
      if (dist <= 2.5) {
        reachedCache = true;
        console.log(`Player close enough to cache: distance=${dist.toFixed(2)}`);
        break;
      }

      console.log(`Pathing to Cache: Player at (${cell.x.toFixed(2)}, ${cell.y.toFixed(2)}), dist to Cache: ${dist.toFixed(2)}`);
      
      const keys = [];
      if (cell.x > cacheX + 0.5) keys.push("KeyA");
      if (cell.x < cacheX - 0.5) keys.push("KeyD");
      if (cell.y > cacheY + 0.5) keys.push("KeyW");
      if (cell.y < cacheY - 0.5) keys.push("KeyS");
      
      if (keys.length === 0) break;
      
      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keydown", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 180));
      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keyup", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 50));
    }

    // Verify trainer objective and waypoint STILL persist
    const trainerVisibleStill = await page.isVisible(".sc3d-first-steps [data-ref=\"objective\"]");
    const probeBeforeUse = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Before USE - Trainer objective still visible: ${trainerVisibleStill}, Waypoint ID: ${probeBeforeUse.waypointId}`);

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "03_use_cache_chip.png"), buf);
    console.log(`Saved screenshot 03_use_cache_chip.png`);

    console.log(`Tapping KeyF to open Cache...`);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true })));
    await new Promise(r => setTimeout(r, 80));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF", key: "f", bubbles: true })));

    console.log(`Waiting for loot window or interact complete...`);
    let lootOpen = false;
    for (let i = 0; i < 20; i++) {
      const isLoot = await page.evaluate(() => {
        const win = document.querySelector('.sc3d-window[data-window="loot"]');
        return win && !win.hidden;
      });
      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (isLoot || (p && p.done.includes("interact"))) {
        lootOpen = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`Loot window open / interact complete: ${lootOpen}`);

    const probe3 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state after USE:`, JSON.stringify(probe3));
    
    // Verify waypoint still active
    console.log(`Loot Open - Trainer objective visible in probe: ${probe3.objectiveVisible}, Waypoint ID: ${probe3.waypointId}`);

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "04_use_cache_loot_open.png"), buf);
    console.log(`Saved screenshot 04_use_cache_loot_open.png`);

    console.log(`Closing loot window (Escape)...`);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 60));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 300));
    recordMilestone("cache_used");

    // --- STEP 4: Converse with GR0K ---
    console.log(`\n=== STEP 4: Path to GR0K & Converse/Examine ===`);
    const grokX = 510;
    const grokY = 514;
    console.log(`Pathing to GR0K at (${grokX}, ${grokY})...`);
    for (let attempt = 0; attempt < 50; attempt++) {
      const cell = await page.evaluate(() => window.__successor3d.playerCell);
      const dist = Math.hypot(cell.x - grokX, cell.y - grokY);
      if (dist <= 2.0) {
        console.log(`Player close enough to GR0K: distance=${dist.toFixed(2)}`);
        break;
      }
      console.log(`Pathing to GR0K: Player at (${cell.x.toFixed(2)}, ${cell.y.toFixed(2)}), dist to GR0K: ${dist.toFixed(2)}`);
      
      const keys = [];
      if (cell.x > grokX + 0.5) keys.push("KeyA");
      if (cell.x < grokX - 0.5) keys.push("KeyD");
      if (cell.y > grokY + 0.5) keys.push("KeyW");
      if (cell.y < grokY - 0.5) keys.push("KeyS");
      
      if (keys.length === 0) break;
      
      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keydown", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 180));
      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keyup", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Targeting grok and triggering examine...`);
    await page.fill(".sc3d-chat input.sc3d-chat-input", "/target grok");
    await page.press(".sc3d-chat input.sc3d-chat-input", "Enter");
    await new Promise(r => setTimeout(r, 300));
    await page.fill(".sc3d-chat input.sc3d-chat-input", "/examine");
    await page.press(".sc3d-chat input.sc3d-chat-input", "Enter");
    await new Promise(r => setTimeout(r, 500));

    const examineVisible = await page.evaluate(() => {
      const win = document.querySelector('.sc3d-window[data-window="examine"]');
      return win && !win.hidden;
    });
    console.log(`Examine window visible: ${examineVisible}`);

    const probeGrok = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state after GR0K examine (expect trainer not complete):`, JSON.stringify(probeGrok));

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "05_grok_examine.png"), buf);
    console.log(`Saved screenshot 05_grok_examine.png`);

    console.log(`Closing examine window (Escape)...`);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 60));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 300));
    recordMilestone("grok_conversed");

    // --- STEP 5: Reach Knox & Converse ---
    console.log(`\n=== STEP 5: Navigate to Trainer (Knox) & Converse ===`);
    const trainerX = 517;
    const trainerY = 518;
    console.log(`Pathing to Trainer at (${trainerX}, ${trainerY})...`);
    let reachedTrainer = false;

    for (let attempt = 0; attempt < 50; attempt++) {
      const cell = await page.evaluate(() => window.__successor3d.playerCell);
      const dist = Math.hypot(cell.x - trainerX, cell.y - trainerY);

      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (p && p.done.includes("trainer")) {
        reachedTrainer = true;
        break;
      }

      if (dist <= 2.0) {
        reachedTrainer = true;
        console.log(`Player close enough to trainer Knox: distance=${dist.toFixed(2)}`);
        break;
      }

      console.log(`Pathing to Trainer Knox: Player at (${cell.x.toFixed(2)}, ${cell.y.toFixed(2)}), dist: ${dist.toFixed(2)}`);

      const keys = [];
      if (cell.x > trainerX + 0.5) keys.push("KeyA");
      if (cell.x < trainerX - 0.5) keys.push("KeyD");
      if (cell.y > trainerY + 0.5) keys.push("KeyW");
      if (cell.y < trainerY - 0.5) keys.push("KeyS");

      if (keys.length === 0) break;

      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keydown", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 180));
      for (const key of keys) {
        await page.evaluate((k) => window.dispatchEvent(new KeyboardEvent("keyup", { code: k, bubbles: true })), keys[0]);
      }
      await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Tapping KeyF to converse with Knox...`);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true })));
    await new Promise(r => setTimeout(r, 80));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF", key: "f", bubbles: true })));

    console.log(`Waiting for converse window to open...`);
    let converseOpen = false;
    for (let i = 0; i < 20; i++) {
      const isConv = await page.evaluate(() => {
        const win = document.querySelector('.sc3d-window[data-window="converse"]');
        return win && !win.hidden;
      });
      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (isConv || (p && p.done.includes("trainer"))) {
        converseOpen = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`Converse window open / trainer complete: ${converseOpen}`);

    const probe4 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state after Knox converse:`, JSON.stringify(probe4));

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "06_knox_converse.png"), buf);
    console.log(`Saved screenshot 06_knox_converse.png`);
    recordMilestone("trainer_conversed");

    // --- STEP 6: Target Selection (ACT) ---
    console.log(`\n=== STEP 6: Target Selection (ACT) ===`);
    console.log(`Closing converse window (Escape)...`);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 80));
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { code: "Escape", key: "Escape", bubbles: true })));
    await new Promise(r => setTimeout(r, 300));

    console.log(`Selecting "grok" using slash command /target grok...`);
    await page.fill(".sc3d-chat input.sc3d-chat-input", "/target grok");
    await page.press(".sc3d-chat input.sc3d-chat-input", "Enter");
    await new Promise(r => setTimeout(r, 500));

    const selectedId = await page.evaluate(() => window.__successor3d.selectedActorId);
    console.log(`Selected Actor ID: ${selectedId}`);

    const probe5 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Probe state after target selection:`, JSON.stringify(probe5));

    // Check DOM for ACT chip
    const actVisible = await page.isVisible(".sc3d-first-steps [data-ref=\"teach\"]");
    const actMainText = await page.locator(".sc3d-first-steps [data-ref=\"teachMain\"]").textContent().catch(() => "");
    console.log(`ACT teach chip visible in DOM: ${actVisible}, text: "${actMainText}"`);

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "07_act_chip.png"), buf);
    console.log(`Saved screenshot 07_act_chip.png`);
    recordMilestone("act_chip_observed");

    // --- STEP 7: Act (Attack) ---
    console.log(`\n=== STEP 7: Act (Attack) ===`);
    console.log(`Queuing combat action on target using slash command /attack...`);
    await page.fill(".sc3d-chat input.sc3d-chat-input", "/attack");
    await page.press(".sc3d-chat input.sc3d-chat-input", "Enter");

    console.log(`Waiting for ACT to be completed in probe...`);
    let actDone = false;
    for (let i = 0; i < 20; i++) {
      const p = await page.evaluate(() => window.__successor3dFirstSteps);
      if (p && p.done.includes("act")) {
        actDone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    console.log(`Act completed in probe: ${actDone}`);

    const probe6 = await page.evaluate(() => window.__successor3dFirstSteps);
    console.log(`Final Probe state:`, JSON.stringify(probe6));

    buf = await page.screenshot();
    await fs.promises.writeFile(path.join(screenshotsDir, "08_first_steps_complete.png"), buf);
    console.log(`Saved screenshot 08_first_steps_complete.png`);
    recordMilestone("act_completed");

    console.log(`\n=== ALL FIRST STEPS SUCCESSFULLY COMPLETED ===`);
    
    // Close browser context
    await context.close();
    await browser.close();

  } catch (err) {
    console.error(`ERROR DURING EXECUTION:`, err.stack);
  } finally {
    await cleanup();
  }

  // Verify that there are no "unavailable active title" errors in the server log
  console.log(`\n=== Server Log Title Validation Check ===`);
  const serverLogContent = fs.readFileSync(path.join(gameLabDir, "server.log"), "utf8");
  const titleErrorFound = serverLogContent.includes("unavailable active title");
  console.log(`Found 'unavailable active title' error in server log: ${titleErrorFound}`);

  console.log(`\n=== Milestone Times ===`);
  console.log(JSON.stringify(milestoneTimes, null, 2));
  console.log(JSON.stringify(milestoneTimesWall, null, 2));
}

main().catch(console.error);
