#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { loadChromium } from "./client3d/lib/browser.mjs";

const ACCOUNT_URL = "https://www.successorgame.com/account/";
const CONNECT_URL = "https://www.successorgame.com/connect/";
const EXPECTED_RELEASE_ID = "successor-alpha@cdab7dccacc1d75c";
const EXPECTED_SOURCE_COMMIT = "656f79edb08ba4eba81f49d00fb7fa24b7fee3ed";
const EXPECTED_SOURCE_TREE = "7e4fb327d90d48d7f95d89075a28f8796bd2b75f";
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

const repoRoot = path.resolve(import.meta.dirname, "../..");
const { chromium } = loadChromium(repoRoot);

const outputDir = requiredAbsolutePath("PROOF_OUT_DIR");
const privateStateRoot = requiredAbsolutePath("PROOF_PRIVATE_STATE_DIR");
const desktopArchive = requiredAbsolutePath("DESKTOP_ARCHIVE");
const desktopRecordPath = requiredAbsolutePath("DESKTOP_RECORD");
const tuiArchive = requiredAbsolutePath("TUI_ARCHIVE");
const tuiManifestPath = requiredAbsolutePath("TUI_MANIFEST");
const targetPlatform = process.env.PROOF_PLATFORM || "linux";
const targetArch = process.env.PROOF_ARCH || (targetPlatform === "darwin" ? "arm64" : "x64");
const browserExecutablePath = process.env.PROOF_BROWSER_BIN || "/usr/bin/google-chrome";
const browserHeadless = process.env.PROOF_BROWSER_HEADLESS === "1";
const desktopHeadless = process.env.PROOF_DESKTOP_HEADLESS === "1";

await mkdirEmpty(outputDir, 0o755);
await mkdirEmpty(privateStateRoot, 0o700);

const desktopRecord = await readJson(desktopRecordPath);
const tuiManifest = await readJson(tuiManifestPath);
const tuiRow = tuiManifest.artifacts?.[0];
assertArtifactIdentity(desktopRecord, "desktop", targetPlatform, targetArch);
assertArtifactIdentity(tuiRow, "tui", targetPlatform, targetArch);
assert(desktopRecord.requirements?.publishable === false, "desktop build record must remain pre-proof");
assert(tuiRow.publishable === false, "TUI build record must remain pre-proof");
await assertFileIdentity(desktopArchive, desktopRecord.bytes, desktopRecord.sha256);
await assertFileIdentity(tuiArchive, tuiRow.bytes, tuiRow.sha256);

const workRoot = path.join(outputDir, "work");
const desktopExtractRoot = path.join(workRoot, "desktop");
const tuiExtractRoot = path.join(workRoot, "tui");
await mkdir(desktopExtractRoot, { recursive: true });
await mkdir(tuiExtractRoot, { recursive: true });
await execChecked("tar", ["-xzf", desktopArchive, "-C", desktopExtractRoot]);
await execChecked("tar", ["-xzf", tuiArchive, "-C", tuiExtractRoot]);

const desktopRoot = path.join(desktopExtractRoot, `successor-${targetPlatform}-${targetArch}`);
const desktopLauncher = path.join(desktopRoot, "run-successor.sh");
const desktopAppRoot = targetPlatform === "darwin"
  ? path.join(desktopRoot, "Successor.app", "Contents", "Resources", "app")
  : path.join(desktopRoot, "resources", "app");
const desktopBundle = await readJson(path.join(desktopAppRoot, "package.json"));
assert(desktopBundle.successorClientReleaseId === EXPECTED_RELEASE_ID, "desktop embedded release id mismatch");

const tuiEntrypoint = path.join(tuiExtractRoot, ...String(tuiRow.entrypoint).split("/"));
const tuiBundleRoot = path.resolve(path.dirname(tuiEntrypoint), "..");
const tuiBundle = await readJson(path.join(tuiBundleRoot, "bundle.json"));
assert(tuiBundle.releaseId === EXPECTED_RELEASE_ID, "TUI embedded release id mismatch");
assert(tuiBundle.runtime?.version === tuiRow.runtime, "TUI embedded runtime mismatch");

const token = randomBytes(4).toString("hex");
const letters = [...randomBytes(5)].map((byte) => String.fromCharCode(65 + (byte % 26))).join("");
const callsign = `NativeProof-${token}`;
const password = `Grug!${randomBytes(18).toString("base64url")}`;
const characterName = `Native-${letters}`;
const browserErrors = [];
let accountBrowser;

const desktopState = path.join(privateStateRoot, "desktop-user-data");
const tuiStateHome = path.join(privateStateRoot, "tui-state");
await mkdir(desktopState, { recursive: true, mode: 0o700 });
await chmod(desktopState, 0o700);
await mkdir(tuiStateHome, { recursive: true, mode: 0o700 });
await chmod(tuiStateHome, 0o700);

try {
  accountBrowser = await chromium.launch({
    headless: browserHeadless,
    executablePath: browserExecutablePath,
    args: [
      "--mute-audio",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const accountContext = await accountBrowser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "en-US",
  });
  const accountPage = await accountContext.newPage();
  accountPage.on("pageerror", (error) => browserErrors.push(error.message));

  const character = await createAccountAndCharacter(accountPage, {
    callsign,
    password,
    characterName,
  });
  await accountPage.screenshot({ path: path.join(outputDir, "01-account-character.png") });

  const firstDesktop = await runDesktopEntry({
    accountPage,
    character,
    launcher: desktopLauncher,
    stateDir: desktopState,
    runtimeLog: path.join(outputDir, "desktop-runtime.log"),
    screenshot: path.join(outputDir, "02-desktop-first-entry.png"),
    approve: true,
    headless: desktopHeadless,
  });

  const desktopCredentialPath = path.join(desktopState, "hosted-device-credential.v2.json");
  const desktopCredential = await privateFileFacts(desktopState, desktopCredentialPath);

  const restoredDesktop = await runDesktopEntry({
    accountPage,
    character,
    launcher: desktopLauncher,
    stateDir: desktopState,
    runtimeLog: path.join(outputDir, "desktop-runtime.log"),
    screenshot: path.join(outputDir, "03-desktop-saved-credential.png"),
    approve: false,
    headless: desktopHeadless,
  });

  const tuiEnv = {
    ...process.env,
    XDG_STATE_HOME: tuiStateHome,
    PULSE_SERVER: "unix:/tmp/successor-proof-no-audio.sock",
    TERM: "dumb",
  };
  const tuiLogin = spawnCaptured(tuiEntrypoint, ["login"], { env: tuiEnv });
  const tuiCode = await waitForMatch(
    () => tuiLogin.output(),
    /Enter this code:\s*([A-Z0-9-]{4,32})/u,
    60_000,
    "TUI device code",
  );
  await approveCode(accountPage, tuiCode[1]);
  const tuiLoginExit = await waitForExit(tuiLogin.child, 90_000, "TUI login");
  assert(tuiLoginExit.code === 0, `TUI login exited ${formatExit(tuiLoginExit)}`);
  assert(tuiLogin.output().includes("Approved. This computer is connected to your account."), "TUI login never reported approval");
  assert(tuiLogin.output().includes("Stored this computer's access"), "TUI login did not persist its credential");

  const tuiCredentialPath = path.join(tuiStateHome, "successor", "credential.json");
  const tuiCredential = await privateFileFacts(path.dirname(tuiCredentialPath), tuiCredentialPath);
  const firstTui = await runTuiEntry(tuiEntrypoint, tuiEnv, character.name);
  const restoredTui = await runTuiEntry(tuiEntrypoint, tuiEnv, character.name);

  const proof = {
    schema: "successor.public-native-proof.v1",
    status: "pass",
    observedAt: new Date().toISOString(),
    releaseId: EXPECTED_RELEASE_ID,
    version: desktopRecord.version,
    target: {
      platform: targetPlatform,
      arch: targetArch,
    },
    source: {
      commit: EXPECTED_SOURCE_COMMIT,
      tree: EXPECTED_SOURCE_TREE,
    },
    account: {
      callsign,
      passwordDiscarded: true,
      character,
    },
    desktop: {
      artifact: artifactFacts(desktopRecord),
      embeddedReleaseId: desktopBundle.successorClientReleaseId,
      firstEntry: firstDesktop,
      savedCredentialRelaunch: restoredDesktop,
      credentialStorage: desktopCredential,
    },
    tui: {
      artifact: artifactFacts(tuiRow),
      embeddedReleaseId: tuiBundle.releaseId,
      runtime: tuiBundle.runtime?.version,
      firstEntry: firstTui,
      savedCredentialRelaunch: restoredTui,
      credentialStorage: tuiCredential,
    },
    isolation: {
      display: process.env.DISPLAY ?? null,
      audio: "muted; nonexistent Pulse server",
      browserHeadless,
      desktopHeadless,
      privateStateRoot,
      credentialContentsCopiedToEvidence: false,
      deviceCodesCopiedToEvidence: false,
    },
    browserPageErrorCount: browserErrors.length,
    browserPageErrors: browserErrors,
    screenshots: [
      "01-account-character.png",
      "02-desktop-first-entry.png",
      "03-desktop-saved-credential.png",
    ],
  };
  await writeFile(path.join(outputDir, "public-native-proof.json"), `${JSON.stringify(proof, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} finally {
  await accountBrowser?.close().catch(() => undefined);
}

function requiredAbsolutePath(name) {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.resolve(value);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function mkdirEmpty(directory, mode) {
  await mkdir(directory, { recursive: true, mode });
  await chmod(directory, mode);
  const entries = await readdir(directory);
  assert(entries.length === 0, `directory must be empty: ${directory}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function assertArtifactIdentity(row, label, platform, arch) {
  assert(row && typeof row === "object", `${label} artifact record missing`);
  assert(row.releaseId === EXPECTED_RELEASE_ID, `${label} release id mismatch`);
  assert(row.version === "0.0.4", `${label} version mismatch`);
  assert(row.platform === platform && row.arch === arch, `${label} target mismatch`);
  const commit = row.source?.commit ?? row.sourceCommit;
  const tree = row.source?.tree ?? EXPECTED_SOURCE_TREE;
  assert(commit === EXPECTED_SOURCE_COMMIT, `${label} source commit mismatch`);
  assert(tree === EXPECTED_SOURCE_TREE, `${label} source tree mismatch`);
}

async function assertFileIdentity(file, expectedBytes, expectedSha256) {
  const fileStat = await stat(file);
  assert(fileStat.isFile(), `artifact is not a regular file: ${file}`);
  assert(fileStat.size === expectedBytes, `artifact byte mismatch: ${file}`);
  const digest = await sha256File(file);
  assert(digest === expectedSha256, `artifact SHA-256 mismatch: ${file}`);
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function artifactFacts(row) {
  return {
    platform: row.platform,
    arch: row.arch,
    bytes: row.bytes,
    sha256: row.sha256,
  };
}

async function execChecked(command, args) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const captured = captureChild(child);
  const result = await waitForExit(child, 120_000, command);
  if (result.code !== 0) {
    throw new Error(`${command} exited ${formatExit(result)}: ${captured.output().slice(-2_000)}`);
  }
}

async function createAccountAndCharacter(page, input) {
  await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator('body[data-session-state="none"]').waitFor({ timeout: 60_000 });
  await page.locator("#reg-callsign").fill(input.callsign);
  await page.locator("#reg-password").fill(input.password);
  await page.locator("#reg-password-repeat").fill(input.password);
  await page.locator("#reg-legal").check();
  await page.locator('#register-form button[type="submit"]').click();
  await page.locator('body[data-session-state="active"]').waitFor({ timeout: 120_000 });

  await page.locator('iframe[title="Character workshop"]').waitFor({ state: "visible", timeout: 120_000 });
  const frameHandle = await page.locator('iframe[title="Character workshop"]').elementHandle();
  const frame = await frameHandle?.contentFrame();
  assert(frame, "character workshop frame unavailable");
  await frame.waitForFunction(
    () => window.__successor3dCharacterSelect?.serverOnline === true,
    undefined,
    { timeout: 180_000 },
  );
  await frame.locator('[data-ref="newButton"]').click();
  await frame.waitForFunction(
    () => window.__successor3dCharacterSelect?.mode === "create",
    undefined,
    { timeout: 30_000 },
  );
  await frame.locator('[data-ref="nameInput"]').fill(input.characterName);
  await frame.locator('[data-ref="createProfessionGrid"] [data-profession-id="scout"]').click();
  await frame.locator('[data-ref="faceRandomize"]').click();
  await frame.locator('[data-ref="createButton"]').click();
  await frame.waitForFunction(
    () => {
      const probe = window.__successor3dCharacterSelect;
      return probe?.mode === "select" && probe.characterCount === 1 && typeof probe.selectedId === "string";
    },
    undefined,
    { timeout: 120_000 },
  );
  const selected = await frame.evaluate(() => window.__successor3dCharacterSelect);
  assert(selected?.selectedId, "created character was not selected");
  return {
    id: selected.selectedId,
    name: input.characterName,
    initialProfessionId: "scout",
  };
}

async function approveCode(page, userCode) {
  assert(/^[A-Z0-9-]{4,32}$/u.test(userCode), "device code did not match the human-code contract");
  await page.goto(CONNECT_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator('body[data-session-state="active"]').waitFor({ timeout: 60_000 });
  await page.locator("#decision-section:not([hidden])").waitFor({ state: "visible", timeout: 60_000 });
  await page.locator("#device-code").fill(userCode);
  await page.locator('#device-decision-form button[value="approved"]').click();
  await page.locator("#decision-result:not([hidden])").waitFor({ state: "visible", timeout: 60_000 });
  const result = (await page.locator("#decision-result").textContent())?.replace(/\s+/gu, " ").trim() ?? "";
  assert(/approv|connected/iu.test(result), `device approval result was not affirmative: ${result}`);
}

async function runDesktopEntry({
  accountPage,
  character,
  launcher,
  stateDir,
  runtimeLog,
  screenshot,
  approve,
  headless,
}) {
  const cdpPort = await freePort();
  const logHandle = await open(runtimeLog, "a", 0o600);
  const desktopArgs = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${stateDir}`,
      "--no-sandbox",
      "--mute-audio",
      "--disable-dev-shm-usage",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ];
  if (headless) desktopArgs.unshift("--headless");
  const child = spawn(
    launcher,
    desktopArgs,
    {
      env: {
        ...process.env,
        PULSE_SERVER: "unix:/tmp/successor-proof-no-audio.sock",
        SUCCESSOR_DESKTOP_WINDOWED: "1",
        SUCCESSOR_DESKTOP_RUNTIME_LOG: runtimeLog,
      },
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    },
  );
  let cdpBrowser;
  try {
    await waitForCdp(cdpPort, child);
    cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await waitForElectronPage(cdpBrowser);
    const stages = [];
    const initialStage = await waitForDesktopStage(page, approve ? ["signin"] : ["characters"]);
    stages.push(initialStage);
    if (approve) {
      await page.locator("#btn-start").click();
      await waitForDesktopStage(page, ["linking"]);
      stages.push("linking");
      const userCode = (await page.locator("#user-code").textContent())?.trim() ?? "";
      await approveCode(accountPage, userCode);
      await waitForDesktopStage(page, ["characters"]);
      stages.push("characters");
    }
    const rosterRow = page.locator(`.roster-row[data-character-id="${character.id}"]`);
    await rosterRow.waitFor({ state: "visible", timeout: 90_000 });
    await rosterRow.click();
    await page.locator("#btn-enter").click();
    stages.push("launching");
    await page.waitForFunction(
      ({ characterId }) => {
        const probe = window.__successor3d;
        return (
          location.protocol === "successor:" &&
          location.host === "app" &&
          probe?.serverStatus === "connected" &&
          probe.sourceMatchesClient === true &&
          probe.playerActorId === characterId &&
          window.__successor3dChatProbe?.connected === true
        );
      },
      { characterId: character.id },
      { timeout: 240_000 },
    );
    stages.push("in-world");
    await page.waitForTimeout(800);
    const world = await page.evaluate(() => ({
      url: location.href,
      serverStatus: window.__successor3d?.serverStatus ?? null,
      sourceMatchesClient: window.__successor3d?.sourceMatchesClient ?? null,
      playerActorId: window.__successor3d?.playerActorId ?? null,
      tick: window.__successor3d?.tick ?? 0,
      actorCount: window.__successor3d?.actorCount ?? 0,
      chatConnected: window.__successor3dChatProbe?.connected ?? false,
    }));
    await page.screenshot({ path: screenshot });
    await page.close();
    return { status: "pass", approvalRequired: approve, stages, world };
  } finally {
    await cdpBrowser?.close().catch(() => undefined);
    await stopChild(child);
    await logHandle.close();
  }
}

async function waitForDesktopStage(page, allowed) {
  await page.waitForFunction(
    (stages) => {
      const stage = document.querySelector("#plate")?.getAttribute("data-stage");
      return typeof stage === "string" && stages.includes(stage);
    },
    allowed,
    { timeout: 90_000 },
  );
  return page.locator("#plate").getAttribute("data-stage");
}

async function runTuiEntry(launcher, env, characterName) {
  const run = spawnCaptured(
    launcher,
    ["--plain", "--no-intro", "--character", characterName],
    { env },
  );
  await waitForMatch(
    () => run.output(),
    /Signal locked\. You are in the world\./u,
    180_000,
    "TUI world readiness",
  );
  await waitForMatch(
    () => run.output(),
    /Chat connected\.|Connected to Successor chat\./u,
    60_000,
    "TUI chat readiness",
  );
  run.child.stdin.write("/quit\n");
  const result = await waitForExit(run.child, 30_000, "TUI world exit");
  assert(result.code === 0, `TUI world run exited ${formatExit(result)}`);
  const output = run.output();
  return {
    status: "pass",
    requestedCharacter: characterName,
    characterResolutionSucceeded: true,
    authorityConnected: output.includes("Signal locked. You are in the world."),
    chatConnected: /Chat connected\.|Connected to Successor chat\./u.test(output),
    cleanQuit: output.includes("Folding the terminal"),
  };
}

function spawnCaptured(command, args, options = {}) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, ...captureChild(child) };
}

function captureChild(child) {
  let captured = "";
  const ingest = (chunk) => {
    captured += chunk.toString("utf8");
    if (Buffer.byteLength(captured, "utf8") > MAX_CAPTURE_BYTES) {
      captured = captured.slice(-MAX_CAPTURE_BYTES);
    }
  };
  child.stdout?.on("data", ingest);
  child.stderr?.on("data", ingest);
  return { output: () => captured };
}

async function waitForMatch(read, pattern, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = read().match(pattern);
    if (match) return match;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForExit(child, timeoutMs, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`${label} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  try {
    await waitForExit(child, 10_000, "desktop process");
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 10_000, "desktop process after SIGKILL");
  }
}

function formatExit(result) {
  return `code=${result.code ?? "null"} signal=${result.signal ?? "null"}`;
}

async function waitForCdp(port, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`desktop exited before CDP: ${formatExit({ code: child.exitCode, signal: child.signalCode })}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(200);
  }
  throw new Error(`desktop CDP did not listen on ${port}`);
}

async function waitForElectronPage(browser) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith("successor://")) return page;
      }
    }
    await delay(100);
  }
  throw new Error("Electron exposed no successor:// page");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("failed to allocate a loopback port"));
        else resolve(port);
      });
    });
  });
}

async function privateFileFacts(directory, file) {
  const directoryStat = await lstat(directory);
  const fileStat = await lstat(file);
  assert(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), `unsafe credential directory: ${directory}`);
  assert(fileStat.isFile() && !fileStat.isSymbolicLink(), `unsafe credential file: ${file}`);
  const directoryMode = (directoryStat.mode & 0o777).toString(8).padStart(4, "0");
  const fileMode = (fileStat.mode & 0o777).toString(8).padStart(4, "0");
  assert(directoryMode === "0700", `credential directory mode was ${directoryMode}`);
  assert(fileMode === "0600", `credential file mode was ${fileMode}`);
  return {
    directory,
    file,
    directoryMode,
    fileMode,
    fileBytes: fileStat.size,
    contentsInspected: false,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
