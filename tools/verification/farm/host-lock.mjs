import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { FarmError } from "./common.mjs";
import { validateId } from "./protocol.mjs";

const LOCK_SCHEMA = "successor.farm-host-lock.v1";

export function farmHostRoot() {
  return path.join(os.homedir(), "successor-farm");
}

/**
 * Lock ownership is published by atomically linking a fully-written candidate
 * file into place. A contender therefore never observes an acquired lock with
 * a missing owner record.
 */
export async function acquireHostLock({ runId, leaseId, hostId, root = farmHostRoot() }) {
  validateId(runId, "lock runId");
  validateId(leaseId, "lock leaseId");
  validateId(hostId, "lock hostId");
  const lockPath = path.join(path.resolve(root), "checkout.lock");
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const owner = {
    schema: LOCK_SCHEMA,
    runId,
    leaseId,
    hostId,
    pid: process.pid,
    birthToken: processBirthToken(process.pid),
    acquiredAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidatePath = `${lockPath}.candidate-${process.pid}-${attempt}-${Date.now()}`;
    await fs.writeFile(candidatePath, `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await fs.link(candidatePath, lockPath);
      return {
        path: lockPath,
        owner,
        async release() {
          const current = await readLockOwner(lockPath);
          if (sameOwner(current, owner)) await fs.unlink(lockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = await readLockOwner(lockPath);
      if (!current) {
        throw new FarmError("farm checkout lock has no valid atomic owner", { code: "HOST_LOCK_CORRUPT" });
      }
      if (!isStaleOwner(current)) {
        throw new FarmError("farm checkout is already leased by a live worker", {
          code: "HOST_LOCKED",
          details: { runId: current.runId, leaseId: current.leaseId, hostId: current.hostId, pid: current.pid },
        });
      }
      const stalePath = `${lockPath}.stale-${process.pid}-${attempt}`;
      try {
        await fs.rename(lockPath, stalePath);
        await fs.rm(stalePath, { recursive: true, force: true });
      } catch (renameError) {
        if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(renameError?.code)) throw renameError;
      }
    } finally {
      await fs.rm(candidatePath, { force: true }).catch(() => {});
    }
  }
  throw new FarmError("could not acquire the farm checkout lock", { code: "HOST_LOCK_RACE" });
}

export function processBirthToken(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync("ps", ["-o", "pid=,lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1500 });
  if (result.status !== 0) return null;
  const text = String(result.stdout ?? "").trim().replace(/\s+/gu, " ");
  return text || null;
}

export function ownedProcessIsAlive(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0 || typeof record.birthToken !== "string") return false;
  return processBirthToken(record.pid) === record.birthToken;
}

async function readLockOwner(lockPath) {
  try {
    const value = JSON.parse(await fs.readFile(lockPath, "utf8"));
    return value?.schema === LOCK_SCHEMA ? value : null;
  } catch {
    return null;
  }
}

function isStaleOwner(owner) {
  return !ownedProcessIsAlive(owner);
}

function sameOwner(left, right) {
  return left?.schema === LOCK_SCHEMA && left.runId === right.runId && left.leaseId === right.leaseId && left.hostId === right.hostId && left.pid === right.pid && left.birthToken === right.birthToken;
}
