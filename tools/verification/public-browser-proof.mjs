import { mkdir, readdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { loadChromium } from "./client3d/lib/browser.mjs";

const ACCOUNT_URL = "https://www.successorgame.com/account/";
const EXPECTED_SOURCE_COMMIT = "cdab7dccacc1d75cd301c38158fa1e8a1ec93c73";
const EXPECTED_CLIENT_RELEASE_ID = "successor-alpha@cdab7dccacc1d75c";
const EXPECTED_MANIFEST_SHA256 = "740879b7f9f886b52aff21f953c1de60366096e21bb2e4af8f17f72eb1b381b0";
const EXPECTED_ENTRY =
  "https://d2kf3ri6r74a0m.cloudfront.net/releases/740879b7f9f886b52aff21f953c1de60366096e21bb2e4af8f17f72eb1b381b0/index.html";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const { chromium } = loadChromium(repoRoot);

const outputDir = process.env.PROOF_OUT_DIR;
if (!outputDir || !path.isAbsolute(outputDir)) {
  throw new Error("PROOF_OUT_DIR must be an absolute path");
}
await mkdir(outputDir, { recursive: true });
const prior = await readdir(outputDir);
if (prior.length > 0) {
  throw new Error(`proof output directory is not empty: ${outputDir}`);
}

const token = randomBytes(4).toString("hex");
const letters = [...randomBytes(5)].map((byte) => String.fromCharCode(65 + (byte % 26))).join("");
const callsign = `GrugProof-${token}`;
const password = `Grug!${randomBytes(18).toString("base64url")}`;
const characterName = `Grug-${letters}`;
const marker = `CDAB-PROOF-${token.toUpperCase()}`;

const consoleErrors = [];
const pageErrors = [];
const requestFailures = [];
let browser;

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const waitForCreatorFrame = async (page) => {
  await page.locator('iframe[title="Character workshop"]').waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    () => {
      const frame = document.querySelector('iframe[title="Character workshop"]');
      return frame instanceof HTMLIFrameElement && frame.src.includes("mode=creator");
    },
    undefined,
    { timeout: 120_000 },
  );
  const handle = await page.locator('iframe[title="Character workshop"]').elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("character workshop frame was not available");
  await frame.waitForFunction(
    () =>
      window.__successor3dCharacterSelect?.serverOnline === true &&
      window.__successor3dCharacterSelect?.mode === "select",
    undefined,
    { timeout: 180_000 },
  );
  return frame;
};

try {
  browser = await chromium.launch({
    headless: false,
    executablePath: "/usr/bin/google-chrome",
    args: [
      "--mute-audio",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1",
      "--use-gl=angle",
      "--use-angle=swiftshader-webgl",
      "--enable-unsafe-swiftshader",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    locale: "en-US",
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    requestFailures.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });

  const release = await page.request.get("https://www.successorgame.com/client/release.json");
  assert(release.ok(), `release pointer request failed: ${release.status()}`);
  const releasePointer = await release.json();
  assert(releasePointer.sourceCommit === EXPECTED_SOURCE_COMMIT, "release pointer source commit mismatch");
  assert(releasePointer.clientReleaseId === EXPECTED_CLIENT_RELEASE_ID, "release pointer client id mismatch");
  assert(releasePointer.browserManifestSha256 === EXPECTED_MANIFEST_SHA256, "release pointer manifest mismatch");
  assert(releasePointer.entry === EXPECTED_ENTRY, "release pointer entry mismatch");

  await page.goto(ACCOUNT_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.locator('body[data-session-state="none"]').waitFor({ timeout: 60_000 });
  await page.locator("#reg-callsign").fill(callsign);
  await page.locator("#reg-password").fill(password);
  await page.locator("#reg-password-repeat").fill(password);
  await page.locator("#reg-legal").check();
  await page.locator('#register-form button[type="submit"]').click();
  await page.locator('body[data-session-state="active"]').waitFor({ timeout: 120_000 });

  const creatorFrame = await waitForCreatorFrame(page);
  const initialCreatorProbe = await creatorFrame.evaluate(() => window.__successor3dCharacterSelect);
  assert(initialCreatorProbe?.characterCount === 0, "fresh account did not have an empty roster");
  assert(new URL(page.url()).pathname === "/account/", "registration left the account/workshop route");
  await page.screenshot({ path: path.join(outputDir, "01-account-workshop.png") });

  await creatorFrame.locator('[data-ref="newButton"]').click();
  await creatorFrame.waitForFunction(
    () => window.__successor3dCharacterSelect?.mode === "create",
    undefined,
    { timeout: 30_000 },
  );
  await creatorFrame.locator('[data-ref="nameInput"]').fill(characterName);
  await creatorFrame.locator('[data-ref="createProfessionGrid"] [data-profession-id="scout"]').click();
  const skinSwatches = creatorFrame.locator('[data-ref="skinRow"] .sc3d-cs-swatch');
  const skinCount = await skinSwatches.count();
  assert(skinCount >= 5, `expected at least five skin swatches, saw ${skinCount}`);
  await skinSwatches.nth(skinCount - 2).click();
  await creatorFrame.locator('[data-ref="faceRandomize"]').click();
  await creatorFrame.locator('[data-ref="dollHost"][data-chardoll-ready="true"] canvas').waitFor({
    state: "visible",
    timeout: 180_000,
  });
  await creatorFrame.waitForTimeout(1_000);
  const canvasBox = await creatorFrame.locator('[data-ref="dollHost"] canvas').boundingBox();
  assert(canvasBox && canvasBox.width > 200 && canvasBox.height > 400, "creator doll canvas was not materially sized");
  const creatorProbe = await creatorFrame.evaluate(() => window.__successor3dCharacterSelect);
  assert(creatorProbe?.draftInitialProfessionId === "scout", "Scout profession did not stick");
  assert(creatorProbe?.draftFace !== null, "randomized face was absent from creator probe");
  await page.screenshot({ path: path.join(outputDir, "02-character-design.png") });
  await creatorFrame.locator('[data-ref="dollHost"] canvas').screenshot({
    path: path.join(outputDir, "02a-character-doll.png"),
  });

  await creatorFrame.locator('[data-ref="createButton"]').click();
  await creatorFrame.waitForFunction(
    () => {
      const probe = window.__successor3dCharacterSelect;
      return probe?.mode === "select" && probe.characterCount === 1 && typeof probe.selectedId === "string";
    },
    undefined,
    { timeout: 120_000 },
  );
  const selectedProbe = await creatorFrame.evaluate(() => window.__successor3dCharacterSelect);
  assert(selectedProbe?.selectedId, "created character did not become selected");
  const characterId = selectedProbe.selectedId;

  await Promise.all([
    page.waitForURL((url) => url.origin === "https://www.successorgame.com" && url.pathname === "/play/", {
      timeout: 120_000,
    }),
    creatorFrame.locator('[data-ref="enterButton"]').click(),
  ]);
  const directWorkshopEntry = new URL(page.url()).pathname === "/play/";
  assert(directWorkshopEntry, "ENTER WORLD did not navigate directly to /play/");

  await page.locator("iframe#game-frame").waitFor({ state: "visible", timeout: 180_000 });
  const gameHandle = await page.locator("iframe#game-frame").elementHandle();
  const gameFrame = await gameHandle?.contentFrame();
  if (!gameFrame) throw new Error("game frame was not available");
  await gameFrame.waitForFunction(
    () => {
      const probe = window.__successor3d;
      return (
        probe?.serverStatus === "connected" &&
        probe.sourceMatchesClient === true &&
        typeof probe.playerActorId === "string" &&
        probe.playerActorId.length > 0 &&
        window.__successor3dChatProbe?.connected === true
      );
    },
    undefined,
    { timeout: 240_000 },
  );
  await gameFrame.waitForTimeout(1_000);
  const initialWorld = await gameFrame.evaluate(() => {
    const probe = window.__successor3d;
    return {
      tick: probe?.tick ?? 0,
      actorCount: probe?.actorCount ?? 0,
      playerCell: probe ? { ...probe.playerCell } : null,
      acceptedCommands: probe?.acceptedCommands ?? 0,
      sourceMatchesClient: probe?.sourceMatchesClient ?? null,
      serverStatus: probe?.serverStatus ?? "missing",
      playerActorId: probe?.playerActorId ?? null,
      chatConnected: window.__successor3dChatProbe?.connected ?? false,
    };
  });
  assert(initialWorld.playerActorId === characterId, "world actor id did not match created character");
  await page.screenshot({ path: path.join(outputDir, "03-live-world.png") });

  await page.locator("iframe#game-frame").focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(1_100);
  await page.keyboard.up("w");
  await gameFrame.waitForFunction(
    ({ tick, accepted }) => {
      const probe = window.__successor3d;
      return Boolean(probe && probe.tick > tick && probe.acceptedCommands > accepted);
    },
    { tick: initialWorld.tick, accepted: initialWorld.acceptedCommands },
    { timeout: 60_000 },
  );
  const afterMovement = await gameFrame.evaluate(() => {
    const probe = window.__successor3d;
    return {
      tick: probe?.tick ?? 0,
      playerCell: probe ? { ...probe.playerCell } : null,
      acceptedCommands: probe?.acceptedCommands ?? 0,
    };
  });
  const movementDelta = Math.hypot(
    (afterMovement.playerCell?.x ?? 0) - (initialWorld.playerCell?.x ?? 0),
    (afterMovement.playerCell?.y ?? 0) - (initialWorld.playerCell?.y ?? 0),
  );
  assert(movementDelta > 0.05, `movement delta was too small: ${movementDelta}`);

  const chatInput = gameFrame.locator('.sc3d-chat-input[data-ref="input"]');
  await chatInput.fill("/bugreport");
  await chatInput.press("Enter");
  const reportRoot = gameFrame.locator(".scp-bugreport");
  await reportRoot.waitFor({ state: "visible", timeout: 30_000 });
  await reportRoot.locator('[data-ref="category"]').selectOption("interface");
  const reportBody =
    `Automated public player journey ${marker}. The report form was opened from chat after verified movement. ` +
    "This is a release acceptance probe; please confirm the attached session diagnostics and receipt state are coherent.";
  await reportRoot.locator('[data-ref="body"]').fill(reportBody);
  await reportRoot.locator('[data-ref="submit"]:not([disabled])').waitFor({ timeout: 30_000 });
  await gameFrame.waitForTimeout(300);
  await page.screenshot({ path: path.join(outputDir, "04-bugreport-form.png") });
  await reportRoot.locator('[data-ref="submit"]').click();
  await reportRoot.locator('[data-ref="reportId"]').waitFor({ state: "visible", timeout: 60_000 });
  await gameFrame.waitForFunction(
    () => {
      const root = document.querySelector(".scp-bugreport");
      const reportId = root?.querySelector('[data-ref="reportId"]')?.textContent?.trim() ?? "";
      return reportId.startsWith("bug_");
    },
    undefined,
    { timeout: 60_000 },
  );
  const receipt = await reportRoot.evaluate((root) => {
    const form = root.querySelector('[data-ref="form"]');
    const received = root.querySelector('[data-ref="received"]');
    const reportId = root.querySelector('[data-ref="reportId"]')?.textContent?.trim() ?? "";
    if (!(form instanceof HTMLElement) || !(received instanceof HTMLElement)) {
      throw new Error("bug report receipt DOM was incomplete");
    }
    return {
      reportId,
      formHidden: form.hidden,
      formDisplay: getComputedStyle(form).display,
      receivedHidden: received.hidden,
      receivedDisplay: getComputedStyle(received).display,
      receivedText: received.textContent?.replace(/\s+/g, " ").trim() ?? "",
    };
  });
  assert(receipt.formHidden === true, "submitted bug report form was not hidden");
  assert(receipt.formDisplay === "none", `submitted form computed display was ${receipt.formDisplay}`);
  assert(receipt.receivedHidden === false, "bug report receipt remained hidden");
  assert(receipt.receivedDisplay !== "none", "bug report receipt computed display was none");
  assert(receipt.receivedText.includes("REPORT RECEIVED"), "bug report receipt copy was absent");
  await reportRoot.locator('[data-ref="received"]').scrollIntoViewIfNeeded();
  await gameFrame.waitForTimeout(300);
  await page.screenshot({ path: path.join(outputDir, "05-bugreport-received.png") });

  const result = {
    schema: "successor.public-browser-proof.v1",
    status: "pass",
    observedAt: new Date().toISOString(),
    account: { callsign, passwordDiscarded: true },
    character: {
      id: characterId,
      name: characterName,
      initialProfessionId: "scout",
      draftFace: creatorProbe.draftFace,
    },
    directWorkshopEntry,
    client: {
      sourceCommit: releasePointer.sourceCommit,
      clientReleaseId: releasePointer.clientReleaseId,
      manifestSha256: releasePointer.browserManifestSha256,
      entry: releasePointer.entry,
      frameOrigin: new URL(gameFrame.url()).origin,
    },
    world: {
      initial: initialWorld,
      afterMovement,
      movementDelta,
    },
    bugReport: {
      reportId: receipt.reportId,
      marker,
      category: "interface",
      receivedUx: true,
      receipt,
    },
    consoleErrorCount: consoleErrors.length,
    pageErrorCount: pageErrors.length,
    requestFailureCount: requestFailures.length,
    consoleErrors,
    pageErrors,
    requestFailures,
    screenshots: [
      "01-account-workshop.png",
      "02-character-design.png",
      "02a-character-doll.png",
      "03-live-world.png",
      "04-bugreport-form.png",
      "05-bugreport-received.png",
    ],
  };
  await writeFile(path.join(outputDir, "proof-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  password.replaceAll(/./g, "x");
  await browser?.close();
}
