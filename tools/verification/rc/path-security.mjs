import fs from "node:fs/promises";
import path from "node:path";

const PRIVATE_MODE = 0o700;

/**
 * Create/validate a private directory beneath runRoot without traversing a
 * symlink. Existing directories are normalized owner-only before callers can
 * write capabilities, state, logs, or evidence.
 */
export async function ensurePrivateDirectory(runRoot, relative = ".") {
  const root = path.resolve(String(runRoot ?? ""));
  if (!root || root === path.parse(root).root) throw new Error("runRoot must not be filesystem root");
  const target = path.resolve(root, String(relative ?? "."));
  if (!pathInside(root, target)) throw new Error("private path escapes runRoot");

  await ensureDirectory(root, "runRoot");
  const realRoot = await fs.realpath(root);
  let cursor = root;
  const relativeParts = path.relative(root, target).split(path.sep).filter(Boolean);
  for (const part of relativeParts) {
    if (part === "." || part === "..") throw new Error("private path contains traversal");
    cursor = path.join(cursor, part);
    await ensureDirectory(cursor, "private path");
  }
  const realTarget = await fs.realpath(target);
  if (!pathInside(realRoot, realTarget)) throw new Error("private path realpath escapes runRoot");
  return { root, realRoot, path: target, realPath: realTarget };
}

/**
 * Require an ordinary file whose lexical and real paths remain inside the
 * exact worktree. Symlink components are rejected rather than followed.
 */
export async function assertRegularFileUnderWorktree(worktree, candidate, label = "file") {
  const root = path.resolve(String(worktree ?? ""));
  const file = path.resolve(String(candidate ?? ""));
  if (!root || root === path.parse(root).root || !pathInside(root, file)) throw new Error(`${label} must be inside worktree`);
  await assertNoSymlinkComponents(root, file, label);
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (!pathInside(realRoot, realFile)) throw new Error(`${label} realpath escapes worktree`);
  const metadata = await fs.stat(realFile);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return realFile;
}


export async function assertPrivatePath(runRoot, candidate) {
  const root = path.resolve(String(runRoot ?? ""));
  const target = path.resolve(String(candidate ?? ""));
  if (!pathInside(root, target)) throw new Error("private path escapes runRoot");
  const parent = path.dirname(target);
  await ensurePrivateDirectory(root, path.relative(root, parent));
  try {
    const metadata = await fs.lstat(target);
    if (metadata.isSymbolicLink()) throw new Error("private file symlink refused");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const realRoot = await fs.realpath(root);
  const realParent = await fs.realpath(parent);
  if (!pathInside(realRoot, realParent)) throw new Error("private path realpath escapes runRoot");
  return target;
}

export function pathInside(root, target) {
  const parent = path.resolve(root);
  const child = path.resolve(target);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

async function ensureDirectory(candidate, label) {
  try {
    await fs.mkdir(candidate, { recursive: true, mode: PRIVATE_MODE });
  } catch (error) {
    throw new Error(`${label} cannot be created: ${error?.message ?? error}`);
  }
  const metadata = await fs.lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error(`${label} symlink refused`);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
  await fs.chmod(candidate, PRIVATE_MODE);
}

async function assertNoSymlinkComponents(root, target, label) {
  const rootMetadata = await fs.lstat(root);
  if (rootMetadata.isSymbolicLink()) throw new Error(`${label} symlink refused`);
  const relative = path.relative(root, target);
  let cursor = root;
  const parts = relative.split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (part === "." || part === "..") throw new Error(`${label} path contains traversal`);
    cursor = path.join(cursor, part);
    const metadata = await fs.lstat(cursor);
    if (metadata.isSymbolicLink()) throw new Error(`${label} symlink refused`);
  }
}
