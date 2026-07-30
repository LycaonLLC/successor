// Prove the capture rig: headless playwright chromium (unmuted, PULSE_SINK
// pinned to the private null sink) plays a 440Hz tone; ffmpeg records the
// sink monitor; report captured RMS. Exit 0 iff tone lands above -35 dBFS.
import { spawn } from "node:child_process";
import { loadChromium } from "../verification/client3d/lib/browser.mjs";

const repoRoot = new URL("../..", import.meta.url).pathname;
const { chromium } = loadChromium(repoRoot);

const browser = await chromium.launch({
  headless: true,
  ignoreDefaultArgs: ["--mute-audio"],
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  env: { ...process.env, PULSE_SINK: "successor_ab" },
});
const page = await browser.newPage();
await page.goto("data:text/html,<h1>tone</h1>");
const cap = spawn("ffmpeg", ["-hide_banner", "-y", "-f", "pulse", "-i", "successor_ab.monitor", "-t", "3", "-ac", "1", "/tmp/tone-probe.wav"], { stdio: "ignore" });
await page.evaluate(() => {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.25;
  osc.frequency.value = 440;
  osc.connect(gain); gain.connect(ctx.destination);
  osc.start();
  return ctx.resume();
});
await new Promise((resolve) => cap.on("exit", resolve));
await browser.close();
const probe = spawn("ffmpeg", ["-hide_banner", "-i", "/tmp/tone-probe.wav", "-af", "astats=measure_overall=RMS_level:measure_perchannel=none", "-f", "null", "-"], { stdio: ["ignore", "ignore", "pipe"] });
let err = "";
probe.stderr.on("data", (d) => { err += d; });
await new Promise((resolve) => probe.on("exit", resolve));
const match = err.match(/RMS level dB:\s*(-?[\d.]+)/);
const rms = match ? Number(match[1]) : -Infinity;
console.log("captured RMS dBFS:", rms);
process.exit(rms > -35 ? 0 : 1);
