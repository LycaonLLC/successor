import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { desktopCheckpointProjectionStateHash } from "../../../../desktop/src/server-runtime.mjs";
import { getJson, waitFor } from "../lib/util.mjs";

const CHARACTER_ID = "char_0cb14da6ef3748cd";
const ITEM_ID = 7_201;
const VARIANT_ID = 60_000_105;
const STACK_ID = 3;
const WORN_KEY = "top_frayed_tunic";
const FIXED_WORN_KEYS = ["under_bodysuit", "boots_canvas_ankle"];

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function treeFileHashes(root) {
  const hashes = {};
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute, relative);
      } else if (entry.isFile()) {
        hashes[relative] = sha256File(absolute);
      } else if (entry.isSymbolicLink()) {
        hashes[relative] = `symlink:${fs.readlinkSync(absolute)}`;
      } else {
        hashes[relative] = `other:${entry.name}`;
      }
    }
  };
  visit(root);
  return hashes;
}

function assertSameHashes(s, before, after, label) {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...names].filter((name) => before[name] !== after[name]).sort();
  s.assert(changed.length === 0, `${label} changed files: ${changed.join(", ")}`);
}

async function openInventory(s) {
  const inventory = s.page.locator('.sc3d-window[data-window="inventory"]');
  if (await inventory.isVisible().catch(() => false)) return;
  await s.press("KeyI");
  await s.waitDom('.sc3d-window[data-window="inventory"]', { state: "visible", timeoutMs: 10_000 });
}

function hasWornKey(probe, key) {
  return (probe?.authorityPlayer?.worn ?? []).some((piece) => piece.item === key);
}

function hasFixedOutfit(probe) {
  return FIXED_WORN_KEYS.every((key) => hasWornKey(probe, key));
}

async function waitAcceptedClothingReceipt(s, knownCommandIds, label) {
  const probe = await s.waitProbe(
    (candidate) => (candidate.authorityReceiptTail ?? []).some((entry) => (
      !knownCommandIds.has(entry.commandId)
      && entry.kind === "SetEquippedClothing"
      && entry.accepted === true
    )),
    { label, timeoutMs: 12_000, intervalMs: 100 },
  );
  return probe.authorityReceiptTail.find((entry) => (
    !knownCommandIds.has(entry.commandId)
    && entry.kind === "SetEquippedClothing"
    && entry.accepted === true
  ));
}

export default {
  id: "wearable-persistence",
  title: "Natural wearable equip/unequip/restart persistence",
  headed: true,
  timeoutMs: 240_000,
  required: false,
  optIn: true,
  // The isolated durable character store is copied into the journey after its
  // first blank boot reveals the run-owned checkpoint and journal paths.
  characters: [],

  async run(ctx) {
    const s = ctx.primary;
    const backend = ctx.backend;
    const sourceStatePath = process.env.SUCCESSOR_WEARABLE_STATE_DIR;
    s.assert(
      sourceStatePath && fs.existsSync(sourceStatePath),
      "SUCCESSOR_WEARABLE_STATE_DIR must point to an existing isolated current game-state directory",
    );
    const sourceStateDir = fs.realpathSync(path.resolve(sourceStatePath));

    const stateFiles = {
      characters: path.join(sourceStateDir, "characters.json"),
      checkpoint: path.join(sourceStateDir, "desktop-open-desert.checkpoint.json"),
      journal: path.join(sourceStateDir, "desktop-open-desert.journal.jsonl"),
      craftRollKey: path.join(sourceStateDir, "desktop-open-desert.checkpoint.json.craft-roll-key"),
    };
    for (const [kind, file] of Object.entries(stateFiles)) {
      s.assert(fs.existsSync(file), `isolated ${kind} file missing: ${file}`);
    }

    const sourceHashesBefore = treeFileHashes(sourceStateDir);
    const sourceTreeDigest = crypto.createHash("sha256").update(JSON.stringify(sourceHashesBefore)).digest("hex");
    ctx.note(`isolated state tree digest sha256=${sourceTreeDigest} (${Object.keys(sourceHashesBefore).length} files)`);

    try {
      const initialStatus = await getJson(`${backend.url}/game/status`, 3_000);
      const checkpointPath = path.resolve(initialStatus.persistence.checkpointPath);
      const journalPath = path.resolve(initialStatus.persistence.journalPath);
      const storePath = path.resolve(backend.storePath);
      const craftRollKeyPath = path.resolve(`${checkpointPath}.craft-roll-key`);

      const isInsideSourceDir = (target) => target === sourceStateDir || target.startsWith(`${sourceStateDir}${path.sep}`);
      s.assert(!isInsideSourceDir(checkpointPath), "backend checkpoint destination must be outside isolated source tree");
      s.assert(!isInsideSourceDir(journalPath), "backend journal destination must be outside isolated source tree");
      s.assert(!isInsideSourceDir(storePath), "backend character store destination must be outside isolated source tree");
      s.assert(!isInsideSourceDir(craftRollKeyPath), "backend craft-roll-key destination must be outside isolated source tree");

      const checkpoint = JSON.parse(fs.readFileSync(stateFiles.checkpoint, "utf8"));
      const targetSliceHash = initialStatus.source.sliceHash;
      s.assert(
        checkpoint.sliceHash === initialStatus.source.sliceHash,
        `isolated checkpoint/client slice mismatch: ${checkpoint.sliceHash} vs ${initialStatus.source.sliceHash}`,
      );
      s.assert(
        checkpoint.sourceStateHash === initialStatus.source.stateHash,
        `isolated checkpoint authored-state mismatch: ${checkpoint.sourceStateHash} vs ${initialStatus.source.stateHash}`,
      );

      const stopped = await backend.teardown();
      s.assert(stopped.ok === true, `blank seed backend did not stop cleanly: ${JSON.stringify(stopped.failures ?? [])}`);
      fs.copyFileSync(stateFiles.characters, backend.storePath);
      checkpoint.shardId = initialStatus.shardId;
      checkpoint.projectionStateHash = desktopCheckpointProjectionStateHash(checkpoint);
      fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
      fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
      fs.copyFileSync(stateFiles.journal, journalPath);
      fs.copyFileSync(stateFiles.craftRollKey, craftRollKeyPath);

      await backend.boot();
      const restoredStatus = await waitFor(
        () => getJson(`${backend.url}/game/status`, 2_000),
        {
          timeoutMs: 30_000,
          intervalMs: 150,
          label: "isolated Rust checkpoint restore",
          predicate: (status) => status?.persistence?.restore?.loaded === true,
        },
      );
      s.assert(restoredStatus.source.sliceHash === targetSliceHash, "restored backend drifted from current slice");
      ctx.note(`isolated current checkpoint restored tick=${restoredStatus.tick} stateHash=${restoredStatus.persistence.stateHash}`);

      const pageUrl = s.page.url();
      await s.goto(pageUrl);
      await s.enterWorld(CHARACTER_ID);
      const initial = await s.waitProbe(
        (probe) => probe.serverStatus === "connected" && probe.authorityPlayer,
        { label: "JohnSuccessor authority projection", timeoutMs: 15_000 },
      );
      s.assert(!hasWornKey(initial, WORN_KEY), "Busted Field Jacket was already equipped in isolated source state");
      s.assert(hasFixedOutfit(initial), `fixed outfit missing before equip: ${JSON.stringify(initial.authorityPlayer.worn)}`);

      await openInventory(s);
      const slotSelector = `.inv-slot[data-item-id="${ITEM_ID}"][data-variant-id="${VARIANT_ID}"]`;
      await s.waitDom(slotSelector, { state: "visible", timeoutMs: 10_000 });
      const slot = s.page.locator(slotSelector);
      const titleText = await slot.locator(".inv-slot-title").innerText();
      const stackKey = await slot.getAttribute("data-key");
      s.assert(titleText.includes("Frayed Work Tunic"), `unexpected natural wearable title: ${titleText}`);
      s.assert(
        stackKey?.endsWith(`:${ITEM_ID}:${VARIANT_ID}:${STACK_ID}`),
        `wrong physical wearable row selected: ${stackKey}`,
      );
      await ctx.moneyShot("01-natural-jacket-row");

      const beforeEquip = await s.probe();
      const equipKnown = new Set((beforeEquip.authorityReceiptTail ?? []).map((entry) => entry.commandId));
      await s.dblclick(slotSelector);
      const equipReceipt = await waitAcceptedClothingReceipt(s, equipKnown, "exact jacket equip receipt");
      await s.waitDom(`${slotSelector}[data-equipped]`, { state: "visible", timeoutMs: 8_000 });
      const equipped = await s.waitProbe(
        (probe) => hasWornKey(probe, WORN_KEY) && hasFixedOutfit(probe),
        { label: "exact jacket worn with fixed outfit", timeoutMs: 8_000, intervalMs: 100 },
      );
      ctx.note(`exact equip accepted command=${equipReceipt.commandId} stack=${STACK_ID} variant=${VARIANT_ID}; worn=${JSON.stringify(equipped.authorityPlayer.worn)}`);
      await ctx.moneyShot("02-natural-jacket-equipped");

      const persistedStop = await backend.teardown();
      s.assert(persistedStop.ok === true, `equipped backend did not checkpoint cleanly: ${JSON.stringify(persistedStop.failures ?? [])}`);
      await backend.boot();
      await waitFor(
        () => getJson(`${backend.url}/game/status`, 2_000),
        {
          timeoutMs: 30_000,
          intervalMs: 150,
          label: "equipped checkpoint restart",
          predicate: (status) => status?.persistence?.restore?.loaded === true,
        },
      );
      await s.goto(pageUrl);
      await s.enterWorld(CHARACTER_ID);
      const afterRestart = await s.waitProbe(
        (probe) => probe.serverStatus === "connected" && hasWornKey(probe, WORN_KEY) && hasFixedOutfit(probe),
        { label: "jacket persistence after backend restart", timeoutMs: 15_000, intervalMs: 100 },
      );
      await openInventory(s);
      await s.waitDom(`${slotSelector}[data-equipped]`, { state: "visible", timeoutMs: 8_000 });
      ctx.note(`restart preserved stack=${STACK_ID} variant=${VARIANT_ID}; worn=${JSON.stringify(afterRestart.authorityPlayer.worn)}`);
      await ctx.moneyShot("03-natural-jacket-persisted");

      const beforeUnequip = await s.probe();
      const unequipKnown = new Set((beforeUnequip.authorityReceiptTail ?? []).map((entry) => entry.commandId));
      await s.dblclick(slotSelector);
      const unequipReceipt = await waitAcceptedClothingReceipt(s, unequipKnown, "exact jacket unequip receipt");
      await s.waitProbeCall(
        () => slot.evaluate((element) => element.hasAttribute("data-equipped")),
        (isEquipped) => !isEquipped,
        { timeoutMs: 8_000, label: "jacket unequipped visibly" },
      );
      const unequipped = await s.waitProbe(
        (probe) => !hasWornKey(probe, WORN_KEY) && hasFixedOutfit(probe),
        { label: "exact jacket removed and fixed outfit retained", timeoutMs: 8_000, intervalMs: 100 },
      );
      await s.waitDom(slotSelector, { state: "visible", timeoutMs: 5_000 });
      ctx.note(`exact unequip accepted command=${unequipReceipt.commandId}; row retained; worn=${JSON.stringify(unequipped.authorityPlayer.worn)}`);
      await ctx.moneyShot("04-natural-jacket-unequipped");
    } finally {
      const sourceHashesAfter = treeFileHashes(sourceStateDir);
      assertSameHashes(s, sourceHashesBefore, sourceHashesAfter, "isolated source state");
      ctx.note(`isolated state tree remained byte-identical (${Object.keys(sourceHashesAfter).length} files)`);
    }
  },
};
