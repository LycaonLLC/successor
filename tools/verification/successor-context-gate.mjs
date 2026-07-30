#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const retiredSliceNamingLabel = `retired ${["street", "slice"].join("-")} naming`;
const retiredSliceNamingPattern = new RegExp([
  "street[-_]?",
  "slice",
  "|",
  "street",
  "Slice",
  "|",
  "Street",
  "Slice",
  "|",
  "Street",
  "Authority",
].join(""));
const retiredStreetEnvPattern = new RegExp(["DEAD", "WIRE", "_STREET_"].join(""));

const retiredInferenceTerms = [
  { label: "retired npc intent lane", pattern: /llm[-_]npc/i },
  { label: "intent probe", pattern: /intent[-_ ]probe/i },
  { label: "llama-cli", pattern: /llama[-_ ]?cli/i },
  { label: "local model server", pattern: /local[-_ ]model[-_ ]server|model[-_ ]server/i },
  { label: "per-actor inference", pattern: /per[-_ ](actor|pawn)[-_ ]inference/i },
  { label: "per-actor polling", pattern: /per[-_ ]actor[-_ ]polling/i },
  { label: "retired command probe", pattern: /commander[-_ ]?(process|probe|loop)s?/i },
  { label: "old desktop protocol", pattern: /goblin:\/\/app/i },
  { label: "old desktop global", pattern: /__goblinGhettoDesktop/ },
  { label: "old desktop key event", pattern: /goblin-ghetto-desktop-key-input/i },
  { label: "old desktop package", pattern: /goblin-ghetto-linux|run-goblin-ghetto|goblin-ghetto\.desktop/i },
  { label: "old ticket env", pattern: /GOBLIN_GHETTO_TICKET_REDEEM_URL/ },
  { label: "old ticket endpoint", pattern: /goblin-ghetto\.localhost|storefront\/goblin-ghetto/i },
  { label: "old game room type", pattern: /GoblinGame(Room|Client)/ },
  { label: "old product name in active code", pattern: /Goblin Ghetto/ },
  { label: "old tool path", pattern: /tools\/goblin-ghetto/i },
  { label: "old browser fixture unit", pattern: /goblinghetto-main-8092/i },
  { label: "old package scope", pattern: /@codename-sundae|codename-sundae/i },
  { label: "old Rust crate name", pattern: /sundae[-_](core|inventory|net|sim|wasm|content)/i },
  { label: "old asset/schema namespace", pattern: /goblin-ghetto[.-]/i },
  { label: "old dotted schema namespace", pattern: /goblin\.ghetto/i },
  { label: "old browser probe global", pattern: /__goblinGhetto/ },
  { label: "old browser probe global", pattern: /__goblin[A-Z]/ },
  { label: "retired Claude game identity", pattern: /\bclaude\b/i },
  { label: "removed attrition lane", pattern: /attrition/i },
  { label: "removed Scrungo fixture", pattern: /scrungo/i },
  { label: "removed Character v2 assets", pattern: /character[-_ ]?v2/i },
  { label: "removed browser map lab", pattern: /map[-_ ]lab/i },
  { label: "removed weapon attachment lab", pattern: /weapon[-_ ]attachment[-_ ]lab/i },
  { label: "removed browser author mode", pattern: /author[-_ ]mode/i },
  { label: "removed 2D render backend", pattern: /canvas2d|pixi/i },
  {
    label: "removed 2D actor appearance alias",
    pattern: /\b(?:human|rogue|vendor)-walk\b|\bsprite\s*[:=]\s*["'](?:human|humanoid|pawn|aw4|aw5a)["']/i,
  },
  { label: "removed Neon Row fixture", pattern: /neon[-_ ]?row/i },
  { label: "removed Mosswick setting identity", pattern: /mosswick(?:_troopers|-)|\bMosswick\b/i },
  { label: "removed Pocket fixture identity", pattern: /Pocket Observer|["']Pocket["']|["']pocket["']/ },
  { label: "removed cloner fixture", pattern: /cloner[-_ ]interior|amb_cloner|music_cloner/i },
  { label: "removed ballistic command model", pattern: /FireProjectile|combatModel.{0,4}ballistic/i },
  { label: "removed physical projectile authority", pattern: /ProjectileAuthorityState|ProjectileDeltaBundle|apply_fire_for_actor/i },
  { label: "removed projectile spatial category", pattern: /SpatialCategory::Projectile/ },
  { label: "removed client combat simulation", pattern: /applyPassiveRegen|applyBleedTick|updateDownedVitals|tickCombatStatuses|ensureDownedBleedPressure|recentIncomingDamageDecayMs|maxBleedStacks|bleedStackDiminishingFactors/i },
  { label: "removed synthetic mass-combat benchmark", pattern: /mass[-_ ]combat/i },
  { label: "removed TypeScript ambient AI loop", pattern: /GAME_AMBIENT_AI_IDLE|simulateWhenIdle|runAmbientAi/i },
  { label: "removed mission command", pattern: /AcceptMission/ },
  { label: "removed street actor roles", pattern: /street_vendor|street_runner/i },
  { label: "removed authority authoring state", pattern: /authority\.authoring|commander_orders|next_authoring_id/i },
  { label: "retired local authority port", pattern: /\b8092\b/ },
  { label: "retired graphical client port", pattern: /\b5178\b/ },
  { label: "retired Deadwire product identity", pattern: /deadwire/i },
  { label: retiredSliceNamingLabel, pattern: retiredSliceNamingPattern },
  { label: "retired street env vars", pattern: retiredStreetEnvPattern },
];

const activePathPrefixes = [
  "client-3d/scripts/",
  "client-3d/src/",
  "client-tui/journeys/",
  "client-tui/src/",
  "client/public/successor-audio/",
  "client/public/successor-slice/",
  "client/src/",
  "content-pipeline/",
  "crates/",
  "desktop/",
  "docs/",
  "scripts/",
  "server/scripts/",
  "server/src/",
  "tools/",
  "verification/",
];

const activeRootFiles = new Set([
  "AGENTS.md",
  "Cargo.toml",
  "CONTRIBUTING.md",
  "README.md",
  "package.json",
  "pnpm-workspace.yaml",
]);

const ignoredPrefixes = [
  "client/dist/",
  "client/test-results/",
  "desktop/dist/",
  "desktop/node_modules/",
  "desktop/release/",
  "node_modules/",
  "target/",
  "verification/.runs/",
  "verification/ledgers/",
];

const ignoredPaths = new Set([
  "tools/verification/successor-context-gate.mjs",
]);

const binaryExtensions = new Set([
  ".aseprite",
  ".bin",
  ".gif",
  ".glb",
  ".gltf",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".ogg",
  ".png",
  ".tar",
  ".ttf",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);

const files = listRepoFiles().filter(shouldScan);
const failures = [];

for (const file of files) {
  const absolutePath = path.join(repoRoot, file);
  if (!fs.existsSync(absolutePath)) continue;
  const text = fs.readFileSync(absolutePath, "utf8");
  const lines = text.split(/\r?\n/);
  for (const term of retiredInferenceTerms) {
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isNegativeEnforcementLine(file, line)) continue;
      if (term.pattern.test(line)) {
        failures.push({
          file,
          line: index + 1,
          label: term.label,
          text: line.trim(),
        });
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Successor context gate failed: active code/scripts still reference retired inference or product-entrypoint paths.");
  for (const failure of failures) {
    console.error(`${failure.file}:${failure.line}: ${failure.label}: ${failure.text}`);
  }
  process.exit(1);
}

console.log(`Successor context gate passed (${files.length} active files scanned, ${retiredInferenceTerms.length} retired active-context patterns).`);

function listRepoFiles() {
  const result = childProcess.spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }
  return result.stdout.split(/\r?\n/).filter(Boolean).sort();
}

function shouldScan(file) {
  if (ignoredPaths.has(file)) return false;
  if (ignoredPrefixes.some((prefix) => file.startsWith(prefix))) return false;
  if (binaryExtensions.has(path.extname(file).toLowerCase())) return false;
  return activeRootFiles.has(file) || activePathPrefixes.some((prefix) => file.startsWith(prefix));
}

function isNegativeEnforcementLine(file, line) {
  return (
    file === "tools/verification/scenario/zero-gpu-check.mjs" &&
    line.includes("const forbiddenSpecifier =")
  ) || (
    file === "client/src/headless/protocol.test.ts" &&
    line.includes("expect(source, file).not.toMatch")
  );
}
