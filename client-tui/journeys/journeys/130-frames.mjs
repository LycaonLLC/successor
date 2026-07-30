/**
 * Full-TUI frame capture — the compositor's pane grid under a real PTY:
 * masthead, vitals gauges, weapon pipe, radar, receipts cluster. /snap
 * writes the frame; the journey asserts pane markers in the file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export default async function frames({ session, actorId, passDir, check }) {
  const tui = session({ actorId: actorId("a"), displayName: "GateFramer", spawnX: 514, spawnY: 514, plain: false });
  await tui.expect(/You are in the world|open desert/i, { timeoutMs: 15_000 });
  tui.send("/look");
  await tui.idle(1500); // let the compositor settle a full grid
  const framePath = path.join(passDir, "tui-frame.txt");
  tui.send(`/snap ${framePath}`);
  await tui.idle(1200);
  const frame = readFileSync(framePath, "utf8");
  check("masthead names the game and area", /SUCCESSOR · OPEN DESERT/.test(frame));
  check("vitals pane draws gauges", /HP [█▓▒░]/.test(frame) || /HP \S+ \d+/.test(frame));
  check("weapon pane shows the magazine pipe", /▮|\d+\/\d+/.test(frame));
  check("command line is live", />/.test(frame));
  check("receipts cluster stamps ok", /ok \d+|\d+✓/.test(frame));
}
