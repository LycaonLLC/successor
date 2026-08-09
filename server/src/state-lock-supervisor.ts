import fs from "node:fs";
import path from "node:path";

const [lockPath] = process.argv.slice(2);
const schema = "successor.state-lock.v1";
if (!lockPath) fail("state-lock supervisor requires a lock path");
const lockStat = fs.statSync(lockPath);
let lockFd: number | null = null;
const fdDirectory = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
for (const name of fs.readdirSync(fdDirectory)) {
  const fd = Number(name);
  if (!Number.isInteger(fd) || fd <= 3) continue;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.dev === lockStat.dev && stat.ino === lockStat.ino) { lockFd = fd; break; }
  } catch { /* descriptor may disappear during enumeration */ }
}
if (lockFd === null) fail(`state-lock supervisor did not inherit the flock descriptor for ${lockPath}`);
try {
  fs.writeSync(3, `${JSON.stringify({ schema, pid: process.pid, lockPath: path.resolve(lockPath) })}\n`);
  fs.closeSync(3);
} catch (error) {
  fail(`state-lock handshake failed: ${error instanceof Error ? error.message : String(error)}`);
}
let stopping = false;
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/u);
  buffer = lines.pop() ?? "";
  for (const command of lines.map((line) => line.trim())) {
    if (command === "release") { stopping = true; process.exit(0); }
    if (command) fail(`unknown state-lock supervisor command ${JSON.stringify(command)}`);
  }
});
process.stdin.on("end", () => process.exit(0));
process.once("SIGTERM", () => { stopping = true; process.exit(0); });
process.once("SIGINT", () => { stopping = true; process.exit(0); });
void stopping;

function fail(message: string): never {
  process.stderr.write(`[successor-state-lock] ${message}\n`);
  process.exit(1);
}
