import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, net, protocol, screen, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startGameServer, stopGameServer } from "./server-runtime.mjs";
import { listMacroFiles } from "./macro-library.mjs";
import { closeDesktopLogSink, desktopLog } from "./log-sink.mjs";
import { successorDesktopEnv } from "./env.mjs";
import { DESKTOP_MODE_OFFLINE, resolveDesktopMode, resolveHostedConfig } from "./hosted-mode.mjs";
import { createCredentialStore } from "./credential-store.mjs";
import { createHostedSession } from "./hosted-session.mjs";
import { createLaunchHandoff, isGameSenderUrl, isShellSenderUrl } from "./hosted-bridge.mjs";
import { createHostedNetworkPolicy } from "./hosted-net-policy.mjs";

const appScheme = "successor";
const appHost = "app";
const shellHost = "shell";
const defaultDevUrl = "http://127.0.0.1:5179/";
const ownedControlCodes = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
]);
const blockedBrowserCodes = new Set([
  "KeyL",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyT",
  "F5",
  "BrowserBack",
  "BrowserForward",
]);

const desktopWindowStateChannel = "successor-window-state";
const desktopToggleFullScreenChannel = "successor-toggle-fullscreen";
const desktopMacroFilesChannel = "successor-macro-files";
const hostedControlChannel = "successor-hosted-control";
const hostedEventChannel = "successor-hosted-event";
const hostedTakeLaunchChannel = "successor-hosted-take-launch";
const hostedLaunchFailedChannel = "successor-hosted-launch-failed";
let lastFullScreenToggleAt = 0;
// One fixed in-memory renderer partition for every BrowserWindow in this
// process. Names without the `persist:` prefix are session-scoped RAM only
// (Electron: non-persist partitions do not write cookie/localStorage/cache to
// disk). That keeps renderer storage non-durable; it does NOT by itself stop
// Chromium OSCrypt from probing macOS Keychain (see use-mock-keychain below).
// Device credentials still persist only through createCredentialStore's
// 0700/0600 file path — not through defaultSession or safeStorage.
const desktopRendererPartition = "successor-desktop-renderer";

const defaultDesktopGamePort = 18192;
const desktopShardId = "desktop-open-desert";
const sharedPublicPrefixes = ["/successor-slice/", "/successor-audio/"];
const defaultPackagedQueryEntries = [
  ["gamePort", String(defaultDesktopGamePort)],
  // The OFFLINE packaged app lands on CHARACTER SELECT. The select screen
  // issues the deployment (player/actorId/name/spawn*/characterId) from the
  // local character store.
  ["equip", "slugthrower"],
  ["slicePath", "/successor-slice/open-desert-slice.json"],
  ["mapBundlePath", "/successor-slice/open-desert-map-bundle.json"],
];
// Hosted launches never carry a port, ticket, or deployment in the URL: the
// world entry comes from the one-use launch envelope over IPC, and the
// authoritative deployment comes from the hosted server at ticket redemption.
const hostedPackagedQueryEntries = [
  ["slicePath", "/successor-slice/open-desert-slice.json"],
  ["mapBundlePath", "/successor-slice/open-desert-map-bundle.json"],
];
let appProtocolRegistered = false;
let allowQuitAfterRuntimeStop = false;
let quitRuntimeStopPromise = null;
let handlingRuntimeCrash = false;
// Hosted-mode runtime: session + one-use launch handoff bound to one window.
let hostedRuntime = null;

function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

process.on("uncaughtException", (error) => {
  desktopLog("uncaught-exception", errorDetails(error));
});

process.on("unhandledRejection", (reason) => {
  desktopLog("unhandled-rejection", errorDetails(reason));
});

const requestedPasswordStore = successorDesktopEnv("PASSWORD_STORE")
  ?? (process.platform === "linux" ? "basic" : "");
if (requestedPasswordStore) app.commandLine.appendSwitch("password-store", requestedPasswordStore);
// Darwin: Chromium OSCrypt still looks up the app Safe Storage Keychain item
// even when every BrowserWindow uses the fixed non-persist in-memory partition
// above (reproduced on packaged builds after denying the prompt).
// `--use-mock-keychain` is Chromium's testing-only switch: a per-process
// random key, no Keychain prompt. Acceptable here because that partition holds
// no durable cookies/localStorage/cache to protect, and the only durable auth
// is createCredentialStore. This native desktop artifact stays publishable:false.
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: appScheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

function appRoot() {
  return app.getAppPath();
}

function packagedClientReleaseId() {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(appRoot(), "package.json"), "utf8"));
    if (typeof metadata.successorClientReleaseId === "string" && metadata.successorClientReleaseId) {
      return metadata.successorClientReleaseId;
    }
  } catch {
    // Source/dev runs and older packages retain the legacy fallback.
  }
  return "successor-alpha";
}

function repoRootForSourceAssets() {
  const candidates = [
    path.resolve(appRoot(), ".."),
    path.resolve(appRoot(), "../../../../../.."),
    path.resolve(appRoot(), "../../../../.."),
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.resolve(process.cwd(), "../.."),
    path.resolve(process.cwd(), "../../.."),
  ];
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (directoryExists(path.join(root, "client", "public")) || directoryExists(path.join(root, "client-3d", "dist"))) {
      return root;
    }
  }
  return path.resolve(appRoot(), "..");
}

function preloadPath() {
  return path.join(appRoot(), "src", "preload.cjs");
}

function shellRootPath() {
  return path.join(appRoot(), "src", "shell");
}

function shellUrl() {
  return `${appScheme}://${shellHost}/connect.html`;
}

function packagedClientDist() {
  return path.join(appRoot(), "client");
}

function sourceClientDist() {
  return path.join(repoRootForSourceAssets(), "client-3d", "dist");
}

function bundledSharedPublicRoot() {
  return path.join(appRoot(), "shared-public");
}

function sourceSharedPublicRoot() {
  return path.join(repoRootForSourceAssets(), "client", "public");
}

function sharedPublicRootChain(clientDist = clientDistPath()) {
  const explicit = successorDesktopEnv("SHARED_PUBLIC");
  const roots = explicit
    ? [path.resolve(explicit)]
    : [bundledSharedPublicRoot()];
  roots.push(path.resolve(clientDist), sourceSharedPublicRoot());
  return [...new Set(roots)];
}

function clientDistPath() {
  const explicit = successorDesktopEnv("CLIENT_DIST");
  if (explicit) return path.resolve(explicit);
  const packaged = packagedClientDist();
  if (fs.existsSync(path.join(packaged, "index.html"))) return packaged;
  return sourceClientDist();
}

function shouldLoadDevUrl(clientDist = clientDistPath()) {
  if (successorDesktopEnv("URL") || successorDesktopEnv("DEV_URL")) return true;
  return !fs.existsSync(path.join(clientDist, "index.html"));
}

function shouldUseGameFullScreen() {
  if (successorDesktopEnv("WINDOWED") === "1") return false;
  return successorDesktopEnv("FULLSCREEN") === "1";
}

function runtimeUrl() {
  return successorDesktopEnv("URL") ?? successorDesktopEnv("DEV_URL") ?? defaultDevUrl;
}

function packagedRuntimeUrl(gamePort) {
  const url = new URL(`${appScheme}://${appHost}/index.html`);
  const overrideParams = desktopAppQueryParams();
  const params = overrideParams ?? defaultPackagedQueryParams(gamePort);
  if (overrideParams?.has("gamePort")) params.set("gamePort", String(gamePort));
  for (const [key, value] of params) url.searchParams.set(key, value);
  return url.toString();
}

function hostedPackagedRuntimeUrl() {
  const url = new URL(`${appScheme}://${appHost}/index.html`);
  for (const [key, value] of hostedPackagedQueryEntries) url.searchParams.set(key, value);
  return url.toString();
}

function desktopAppQueryParams() {
  const query = successorDesktopEnv("APP_QUERY");
  if (!query) return null;
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}

function defaultPackagedQueryParams(gamePort) {
  const params = new URLSearchParams();
  for (const [key, value] of defaultPackagedQueryEntries) {
    params.set(key, key === "gamePort" ? String(gamePort) : value);
  }
  return params;
}

function gamePortFromDesktopAppQuery() {
  const raw = desktopAppQueryParams()?.get("gamePort");
  return parseDesktopGamePort(raw, "SUCCESSOR_DESKTOP_APP_QUERY gamePort");
}

function gamePortForPackagedLoadWithoutServer() {
  return gamePortFromDesktopAppQuery()
    ?? parseDesktopGamePort(successorDesktopEnv("GAME_PORT"), "SUCCESSOR_DESKTOP_GAME_PORT")
    ?? defaultDesktopGamePort;
}

function parseDesktopGamePort(raw, label) {
  if (raw === undefined || raw === null || raw === "") return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer TCP port from 1 to 65535; got ${raw}`);
  }
  return port;
}

// Register successor:// on the window's session protocol (the fixed
// non-persist partition), not Electron's defaultSession. Privileged scheme
// setup stays global/before-ready above; the handle must match the session
// that will loadURL, or shell/app pages fail with ERR_FAILED.
function registerAppProtocol(sessionProtocol, clientDist, sharedPublicRoots, shellRoot = shellRootPath()) {
  if (appProtocolRegistered) return;
  appProtocolRegistered = true;
  sessionProtocol.handle(appScheme, (request) => {
    const url = new URL(request.url);

    if (url.host === shellHost) {
      const resolved = resolveShellFile(shellRoot, url.pathname);
      if (!resolved) return new Response("Unknown Successor shell page.", { status: 404 });
      return net.fetch(pathToFileURL(resolved).toString());
    }

    if (url.host !== appHost) return new Response("Unknown Successor host.", { status: 404 });

    const sharedAsset = resolveSharedPublicFile(sharedPublicRoots, url.pathname);
    if (sharedAsset.handled) {
      if (!sharedAsset.resolved) return new Response(sharedAsset.message, { status: sharedAsset.status });
      return net.fetch(pathToFileURL(sharedAsset.resolved).toString());
    }

    const resolved = resolveAppFile(clientDist, url.pathname);
    if (!resolved) return new Response("Successor app asset not found.", { status: 404 });

    return net.fetch(pathToFileURL(resolved).toString());
  });
}

function resolveShellFile(shellRoot, requestPath) {
  const target = requestPath === "/" ? "/connect.html" : requestPath;
  const resolved = resolveRootFile(shellRoot, target);
  if (resolved.status) return null;
  return fileExists(resolved.path) ? resolved.path : null;
}

function resolveSharedPublicFile(sharedPublicRoots, requestPath) {
  if (!sharedPublicPrefixes.some((prefix) => requestPath.startsWith(prefix))) return { handled: false };

  for (const sharedPublic of sharedPublicRoots) {
    const resolved = resolveRootFile(sharedPublic, requestPath);
    if (resolved.status) return { handled: true, ...resolved };
    if (fileExists(resolved.path)) return { handled: true, resolved: resolved.path };
  }

  return {
    handled: true,
    resolved: null,
    status: 404,
    message: "Successor shared asset not found.",
  };
}

function resolveRootFile(rootPath, requestPath) {
  const root = path.resolve(rootPath);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath === "/" ? "/index.html" : requestPath);
  } catch {
    return { path: null, status: 400, message: "Bad Successor asset path." };
  }
  const normalized = path.normalize(decodedPath).replace(/^([/\\])+/, "");
  const requested = path.resolve(root, normalized);
  if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
    return { path: null, status: 403, message: "Forbidden Successor asset path." };
  }
  return { path: requested, status: 0, message: "" };
}

function resolveAppFile(clientDist, requestPath) {
  const resolved = resolveRootFile(clientDist, requestPath);
  if (resolved.status) return null;

  if (fileExists(resolved.path)) return resolved.path;
  if (path.extname(resolved.path)) return null;
  const indexPath = path.join(path.resolve(clientDist), "index.html");
  return fileExists(indexPath) ? indexPath : null;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function browserWindowIconPath() {
  const iconPath = path.join(appRoot(), "assets", "icon.png");
  return fileExists(iconPath) ? iconPath : null;
}

async function createWindow({ clientDist = clientDistPath(), loadUrl = runtimeUrl() } = {}) {
  const fullScreen = shouldUseGameFullScreen();
  const initialBounds = fullScreen ? screen.getPrimaryDisplay().bounds : centeredWindowBounds(1440, 960);
  const icon = browserWindowIconPath();
  desktopLog("create-window", {
    fullScreen,
    clientDist,
    loadUrl,
    appPath: appRoot(),
    icon,
  });
  const win = new BrowserWindow({
    ...initialBounds,
    minWidth: 1024,
    minHeight: 720,
    title: "Successor",
    backgroundColor: "#05070a",
    show: false,
    autoHideMenuBar: true,
    frame: !fullScreen,
    useContentSize: true,
    fullscreen: false,
    fullscreenable: true,
    resizable: !fullScreen,
    ...(icon ? { icon } : {}),
    webPreferences: {
      // Non-`persist:` partition => one in-memory Session for this process.
      // Renderer storage is not durable; credential durability stays in
      // createCredentialStore. Darwin still needs use-mock-keychain above.
      partition: desktopRendererPartition,
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.removeMenu();
  win.once("ready-to-show", () => {
    desktopLog("ready-to-show", displayStateForWindow(win));
    win.show();
    if (fullScreen) {
      enterGameFullScreen(win);
      setTimeout(() => {
        if (!win.isDestroyed() && !win.isResizable()) enterGameFullScreen(win);
      }, 180);
    }
  });
  win.on("close", () => {
    desktopLog("window-close", displayStateForWindow(win));
  });
  win.on("closed", () => {
    desktopLog("window-closed");
  });
  win.webContents.on("console-message", (_event, details, ...legacy) => {
    if (details && typeof details === "object") {
      desktopLog("renderer-console", {
        level: details.level,
        message: details.message,
        line: details.lineNumber,
        sourceId: details.url,
      });
      return;
    }
    const [message, line, sourceId] = legacy;
    desktopLog("renderer-console", { level: details, message, line, sourceId });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    desktopLog("did-fail-load", { errorCode, errorDescription, validatedURL, isMainFrame });
  });
  win.webContents.on("did-finish-load", () => {
    desktopLog("did-finish-load", { url: win.webContents.getURL() });
  });
  win.webContents.on("dom-ready", () => {
    desktopLog("dom-ready", { url: win.webContents.getURL() });
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    desktopLog("render-process-gone", details);
  });
  win.webContents.on("unresponsive", () => {
    desktopLog("window-unresponsive");
  });
  win.webContents.on("responsive", () => {
    desktopLog("window-responsive");
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  installInputOwnership(win);

  // Same fixed partition => one session for the process; the guard inside
  // registerAppProtocol keeps activate/reopen from double-handle registration.
  registerAppProtocol(
    win.webContents.session.protocol,
    clientDist,
    sharedPublicRootChain(clientDist),
  );

  try {
    await win.loadURL(loadUrl);
    desktopLog("load-url-complete", { url: loadUrl });
  } catch (error) {
    desktopLog("load-url-failed", { url: loadUrl, ...errorDetails(error) });
    throw error;
  }

  return win;
}

function toggleGameFullScreen(win) {
  if (isGameFullScreen(win)) {
    exitGameFullScreen(win);
  } else {
    enterGameFullScreen(win);
  }
}

function requestGameFullScreenToggle(win) {
  const now = Date.now();
  if (now - lastFullScreenToggleAt < 180) return displayStateForWindow(win);
  lastFullScreenToggleAt = now;
  toggleGameFullScreen(win);
  return displayStateForWindow(win);
}

function enterGameFullScreen(win) {
  if (win.isFullScreen()) return;
  if (win.isResizable()) {
    win.setFullScreen(true);
    return;
  }

  const displayBounds = screen.getPrimaryDisplay().bounds;
  win.setBounds(displayBounds);
  const refit = () => {
    if (!win.isDestroyed() && !win.isResizable()) fitWindowContentToDisplay(win);
  };
  setTimeout(refit, 80);
  setTimeout(refit, 220);
}

function fitWindowContentToDisplay(win) {
  if (win.isDestroyed()) return;
  const displayBounds = screen.getPrimaryDisplay().bounds;
  const contentBounds = win.getContentBounds();
  const contentRight = contentBounds.x + contentBounds.width;
  const contentBottom = contentBounds.y + contentBounds.height;
  const displayRight = displayBounds.x + displayBounds.width;
  const displayBottom = displayBounds.y + displayBounds.height;
  const offsetX = Math.max(0, contentBounds.x - displayBounds.x);
  const offsetY = Math.max(0, contentBounds.y - displayBounds.y);
  const widthShortfall = Math.max(0, displayRight - contentRight);
  const heightShortfall = Math.max(0, displayBottom - contentBottom);
  win.setBounds({
    x: displayBounds.x - offsetX,
    y: displayBounds.y - offsetY,
    width: displayBounds.width + widthShortfall,
    height: displayBounds.height + heightShortfall,
  });
}

function exitGameFullScreen(win) {
  let applied = false;
  const applyWindowedBounds = (attempt = 0) => {
    if (applied || win.isDestroyed()) return;
    const targetBounds = centeredWindowBounds(1440, 960);
    if (win.isMaximized()) win.unmaximize();
    win.setResizable(true);
    setWindowedContentBounds(win, targetBounds);
    if (attempt < 8) {
      setTimeout(() => {
        if (win.isDestroyed()) return;
        if (contentBoundsFillDisplay(win) || !contentBoundsMatch(win, targetBounds)) applyWindowedBounds(attempt + 1);
        else applied = true;
      }, 80);
      return;
    }
    applied = true;
  };
  if (win.isFullScreen()) {
    win.once("leave-full-screen", applyWindowedBounds);
    win.setFullScreen(false);
    setTimeout(applyWindowedBounds, 240);
    return;
  }
  applyWindowedBounds();
}

function isGameFullScreen(win) {
  return win.isFullScreen() || contentBoundsFillDisplay(win);
}

function contentBoundsFillDisplay(win) {
  const contentBounds = win.getContentBounds();
  const displayBounds = screen.getDisplayMatching(contentBounds).bounds;
  return (
    contentBounds.x <= displayBounds.x
    && contentBounds.y <= displayBounds.y
    && contentBounds.x + contentBounds.width >= displayBounds.x + displayBounds.width
    && contentBounds.y + contentBounds.height >= displayBounds.y + displayBounds.height
  );
}

function setWindowedContentBounds(win, bounds) {
  if (typeof win.setContentBounds === "function") {
    win.setContentBounds(bounds);
    return;
  }
  win.setBounds(bounds);
}

function contentBoundsMatch(win, expected) {
  const actual = win.getContentBounds();
  return (
    Math.abs(actual.x - expected.x) <= 2
    && Math.abs(actual.y - expected.y) <= 2
    && Math.abs(actual.width - expected.width) <= 2
    && Math.abs(actual.height - expected.height) <= 2
  );
}

function centeredWindowBounds(width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
}

function displayStateForWindow(win) {
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    fullScreen: win.isFullScreen(),
    gameFullScreen: isGameFullScreen(win),
    resizable: win.isResizable(),
    bounds,
    contentBounds: win.getContentBounds(),
    displayBounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
  };
}

function installInputOwnership(win) {

  win.webContents.on("before-input-event", (event, input) => {
    if (isFullScreenToggleInput(input)) {
      event.preventDefault();
      if (input.type === "keyDown" && !input.isAutoRepeat) requestGameFullScreenToggle(win);
      return;
    }

    if (isOwnedGameControlChord(input)) {
      event.preventDefault();
      sendDesktopKeyInput(win, input);
      return;
    }

    if (isBlockedBrowserAccelerator(input)) {
      event.preventDefault();
    }
  });
}

function isFullScreenToggleInput(input) {
  return input.code === "F11" || (input.alt && input.code === "Enter");
}

function isOwnedGameControlChord(input) {
  return (input.control || input.meta) && ownedControlCodes.has(input.code);
}

function isBlockedBrowserAccelerator(input) {
  if (input.alt && ["ArrowLeft", "ArrowRight", "F4"].includes(input.code)) return true;
  if (!(input.control || input.meta)) return input.code === "F5";
  if (input.shift && input.code === "KeyI") return successorDesktopEnv("ENABLE_DEVTOOLS") !== "1";
  return blockedBrowserCodes.has(input.code);
}

function sendDesktopKeyInput(win, input) {
  win.webContents.send("successor-desktop-key-input", {
    type: input.type === "keyUp" ? "keyup" : "keydown",
    key: input.key,
    code: input.code,
    repeat: Boolean(input.isAutoRepeat),
    ctrlKey: Boolean(input.control),
    metaKey: Boolean(input.meta),
    shiftKey: Boolean(input.shift),
    altKey: Boolean(input.alt),
  });
}

function isAllowedInAppNavigation(url) {
  const parsed = new URL(url);
  if (parsed.protocol === `${appScheme}:`) return true;
  return allowedDevNavigationOrigins().has(parsed.origin);
}

function allowedDevNavigationOrigins() {
  return new Set([
    defaultDevUrl,
    successorDesktopEnv("URL"),
    successorDesktopEnv("DEV_URL"),
  ].filter(Boolean).map((url) => new URL(url).origin));
}

async function openRuntimeWindow() {
  const clientDist = clientDistPath();
  const sharedPublicRoots = sharedPublicRootChain(clientDist);
  const useDevUrl = shouldLoadDevUrl(clientDist);
  desktopLog("app-ready", {
    appPath: appRoot(),
    clientDist,
    sharedPublicRoots,
    useDevUrl,
  });

  const serverRuntime = await maybeStartGameServer(useDevUrl);
  const loadUrl = useDevUrl
    ? runtimeUrl()
    : packagedRuntimeUrl(serverRuntime?.port ?? gamePortForPackagedLoadWithoutServer());
  desktopLog("runtime-load-url", {
    loadUrl,
    serverPort: serverRuntime?.port ?? null,
    serverSkipped: !serverRuntime,
    useDevUrl,
  });
  return createWindow({ clientDist, loadUrl });
}

function desktopGameStateDir() {
  const override = successorDesktopEnv("STATE_DIR");
  return override
    ? path.resolve(override)
    : path.join(app.getPath("appData"), "successor", "game-state");
}

/**
 * Hosted mode (the release default): account-link shell first, no local shard
 * ever. The session lives in the main process; the window swaps between the
 * shell page and the game page.
 */
async function openHostedWindow() {
  const config = resolveHostedConfig(successorDesktopEnv, packagedClientReleaseId());
  const clientDist = clientDistPath();
  desktopLog("hosted-shell-open", { apiOrigin: config.apiOrigin, clientDist });

  const win = await createWindow({ clientDist, loadUrl: shellUrl() });
  const handoff = createLaunchHandoff();
  // Standalone game/chat sockets demand the exact HTTPS storefront Origin;
  // the policy presents it only for this window's requests to the armed
  // envelope's hosts, never attaches cookies/bearer material, and refuses
  // sockets to unexpected hosts.
  const netPolicy = createHostedNetworkPolicy({
    storefrontOrigin: config.apiOrigin,
    appOrigin: (successorDesktopEnv("URL") || successorDesktopEnv("DEV_URL"))
      ? new URL(runtimeUrl()).origin
      : `${appScheme}://${appHost}`,
  });
  const webRequestFilter = { urls: ["ws://*/*", "wss://*/*", "http://*/*", "https://*/*"] };
  win.webContents.session.webRequest.onBeforeRequest(webRequestFilter, (details, callback) => {
    callback(netPolicy.decideRequest({ webContentsId: details.webContentsId, url: details.url }));
  });
  win.webContents.session.webRequest.onBeforeSendHeaders(webRequestFilter, (details, callback) => {
    const decision = netPolicy.decideHeaders({
      webContentsId: details.webContentsId,
      url: details.url,
      requestHeaders: details.requestHeaders,
    });
    callback(decision ?? { requestHeaders: details.requestHeaders });
  });
  win.webContents.session.webRequest.onHeadersReceived(webRequestFilter, (details, callback) => {
    const decision = netPolicy.decideResponseHeaders({
      webContentsId: details.webContentsId,
      url: details.url,
      responseHeaders: details.responseHeaders,
    });
    callback(decision ?? { responseHeaders: details.responseHeaders });
  });
  const credentialStore = createCredentialStore({
    userDataDir: app.getPath("userData"),
  });
  const session = createHostedSession({
    config,
    credentialStore,
    log: desktopLog,
    onState: (snapshot) => {
      if (!win.isDestroyed()) win.webContents.send(hostedEventChannel, snapshot);
    },
    armLaunch: (envelope) => {
      handoff.arm(envelope, win.webContents.id);
      netPolicy.arm(win.webContents.id, envelope.endpoints);
    },
    disarmLaunch: () => {
      handoff.disarm();
      netPolicy.clear();
    },
    navigateToGame: async () => {
      await win.loadURL(hostedGameLoadUrl(clientDist));
    },
    navigateToShell: async () => {
      netPolicy.clear();
      if (!win.isDestroyed()) await win.loadURL(shellUrl());
    },
    openExternal: (url) => shell.openExternal(url),
    copyText: (text) => clipboard.writeText(text),
    canLaunchGame: () => hostedGameAvailability(clientDist),
  });
  hostedRuntime = { session, handoff, webContentsId: win.webContents.id, win };
  win.on("closed", () => {
    if (hostedRuntime?.win === win) {
      hostedRuntime.session.dispose();
      hostedRuntime = null;
    }
  });
  void session.restore();
  return win;
}

function hostedGameLoadUrl(clientDist) {
  if (successorDesktopEnv("URL") || successorDesktopEnv("DEV_URL")) return runtimeUrl();
  if (fs.existsSync(path.join(clientDist, "index.html"))) return hostedPackagedRuntimeUrl();
  throw new Error("Successor game files are missing from this install.");
}

function hostedGameAvailability(clientDist) {
  if (successorDesktopEnv("URL") || successorDesktopEnv("DEV_URL")) return { ok: true };
  if (fs.existsSync(path.join(clientDist, "index.html"))) return { ok: true };
  return { ok: false, reason: "game-missing" };
}

function isTopFrameSender(event) {
  return Boolean(event.senderFrame) && event.senderFrame === event.sender.mainFrame;
}

async function maybeStartGameServer(useDevUrl) {
  if (useDevUrl) {
    if (successorDesktopEnv("SPAWN_SERVER") !== "1") return null;
  } else if (successorDesktopEnv("SKIP_SERVER") === "1") {
    return null;
  }

  const queryPort = useDevUrl ? null : gamePortFromDesktopAppQuery();
  return startGameServer({
    log: desktopLog,
    requestedPort: queryPort,
    shardId: desktopShardId,
    stateDir: desktopGameStateDir(),
    onUnexpectedExit: handleGameServerUnexpectedExit,
  });
}

function handleGameServerUnexpectedExit(details) {
  if (allowQuitAfterRuntimeStop || quitRuntimeStopPromise) return;
  desktopLog("game-server-unexpected-exit", details);
  if (handlingRuntimeCrash) return;
  handlingRuntimeCrash = true;
  dialog.showErrorBox(
    "Successor server stopped",
    "The local Successor game server exited unexpectedly. The desktop client will close so the runtime does not stay split-brain.",
  );
  app.quit();
}

function requestQuitAfterStoppingRuntime(source) {
  if (allowQuitAfterRuntimeStop) return quitRuntimeStopPromise;
  if (!quitRuntimeStopPromise) {
    desktopLog("quit-requested", { source });
    quitRuntimeStopPromise = (async () => {
      try {
        await stopGameServer({ log: desktopLog });
      } catch (error) {
        desktopLog("game-server-stop-failed", errorDetails(error));
        allowQuitAfterRuntimeStop = true;
        dialog.showErrorBox(
          "Successor save failed",
          "The game server could not complete its final durable save. Successor will exit with an error; your previous checkpoint has been retained.",
        );
        closeDesktopLogSink();
        app.exit(1);
        return;
      }
      allowQuitAfterRuntimeStop = true;
      closeDesktopLogSink();
      app.quit();
    })();
  }
  return quitRuntimeStopPromise;
}

async function handleStartupFailure(error) {
  desktopLog("app-ready-failed", errorDetails(error));
  dialog.showErrorBox("Successor failed to start", error instanceof Error ? error.message : String(error));
  try {
    await stopGameServer({ log: desktopLog });
  } catch (stopError) {
    desktopLog("game-server-stop-failed", errorDetails(stopError));
  } finally {
    allowQuitAfterRuntimeStop = true;
    closeDesktopLogSink();
    app.exit(1);
  }
}

Menu.setApplicationMenu(null);
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isAllowedInAppNavigation(url)) return;
    event.preventDefault();
    void shell.openExternal(url);
  });
});

ipcMain.handle(desktopWindowStateChannel, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) {
    return {
      fullScreen: false,
      gameFullScreen: false,
      resizable: false,
      bounds: null,
      contentBounds: null,
      displayBounds: null,
      workArea: null,
      scaleFactor: 1,
    };
  }
  return displayStateForWindow(win);
});

ipcMain.handle(desktopToggleFullScreenChannel, (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  return requestGameFullScreenToggle(win);
});
// Read-only local macro library: list/read <userData>/macros/*.macro in one
// call. No write/delete IPC exists by design — files are player-managed on
// disk and copied into the character record through the game UI.
ipcMain.handle(desktopMacroFilesChannel, (event) => {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    return { ok: false, dir: null, error: "unknown sender" };
  }
  return listMacroFiles(path.join(app.getPath("userData"), "macros"));
});

// Account-link shell controls. Only the hosted window's TOP frame, loaded
// from the desktop-owned shell pages, is answered. Snapshots carry no
// credential, device code, or ticket by construction (hosted-session.mjs).
ipcMain.handle(hostedControlChannel, async (event, payload) => {
  const hosted = hostedRuntime;
  if (!hosted || event.sender.id !== hosted.webContentsId) return null;
  if (!isTopFrameSender(event)) return null;
  if (!isShellSenderUrl(event.senderFrame.url)) return null;
  return hosted.session.control(payload);
});

// One-use launch envelope handoff to the game page. Wrong sender, wrong
// frame, wrong page, or a second take gets null — and only the armed
// webContents can consume the pending launch at all.
ipcMain.handle(hostedTakeLaunchChannel, (event) => {
  const hosted = hostedRuntime;
  if (!hosted) return null;
  if (!isTopFrameSender(event)) return null;
  if (!isGameSenderUrl(event.senderFrame.url, [...allowedDevNavigationOrigins()])) return null;
  const envelope = hosted.handoff.take(event.sender.id);
  if (!envelope) return null;
  desktopLog("hosted-launch-handoff", { webContentsId: event.sender.id });
  return { type: "successor.launch.v1", launch: envelope };
});

// Game-side split-launch failure: both legs are closed client-side; land the
// window back on character select where the next Enter remints.
ipcMain.handle(hostedLaunchFailedChannel, async (event, reason) => {
  const hosted = hostedRuntime;
  if (!hosted || event.sender.id !== hosted.webContentsId) return null;
  if (!isTopFrameSender(event)) return null;
  if (!isGameSenderUrl(event.senderFrame.url, [...allowedDevNavigationOrigins()])) return null;
  await hosted.session.handleLaunchFailure(typeof reason === "string" ? reason : "unknown");
  return null;
});

function openWindowForMode() {
  const mode = resolveDesktopMode();
  desktopLog("desktop-mode", { mode });
  return mode === DESKTOP_MODE_OFFLINE ? openRuntimeWindow() : openHostedWindow();
}

app.whenReady().then(async () => {
  await openWindowForMode();
}).catch((error) => {
  void handleStartupFailure(error);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void openWindowForMode().catch(handleStartupFailure);
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", (event) => {
  if (allowQuitAfterRuntimeStop) return;
  event.preventDefault();
  void requestQuitAfterStoppingRuntime("will-quit");
});

process.on("SIGINT", () => {
  void requestQuitAfterStoppingRuntime("SIGINT");
});

process.on("SIGTERM", () => {
  void requestQuitAfterStoppingRuntime("SIGTERM");
});
