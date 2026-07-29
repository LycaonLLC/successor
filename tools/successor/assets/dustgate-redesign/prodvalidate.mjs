import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execSync } from "node:child_process";

const GLB_DIR = "verification/ledgers/artifacts/dustgate-opus5-production-20260729/glb";
const QA_DIR = "verification/ledgers/artifacts/dustgate-opus5-production-20260729/qa";

const FILES = [
  "clone_lod0.glb",
  "clone_lod1.glb",
  "clone_lod2.glb",
  "commerce_lod0.glb",
  "commerce_lod1.glb",
  "commerce_lod2.glb",
  "shelter_lod0.glb",
  "shelter_lod1.glb",
  "shelter_lod2.glb"
];

function runInspect(filePath) {
  // Step 1: Try --format json, fall back to plain text
  let raw = "";
  let jsonOutput = null;
  const resJson = spawnSync("npx", ["--yes", "@gltf-transform/cli", "inspect", filePath, "--format", "json"], {
    encoding: "utf8"
  });
  if (resJson.status === 0 && resJson.stdout) {
    try {
      jsonOutput = JSON.parse(resJson.stdout);
    } catch {
      // not valid json
    }
  }

  // Fallback to plain text CLI
  const resPlain = spawnSync("npx", ["--yes", "@gltf-transform/cli", "inspect", filePath], {
    encoding: "utf8"
  });
  raw = resPlain.stdout || resPlain.stderr || "";

  return { jsonOutput, raw };
}

function parseCsvIssues(csvText) {
  const lines = csvText.trim().split("\n");
  if (lines.length <= 1) return [];
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const firstComma = line.indexOf(",");
    const lastComma = line.lastIndexOf(",");
    const secondLastComma = line.lastIndexOf(",", lastComma - 1);

    const code = line.substring(0, firstComma).trim();
    const pointer = line.substring(lastComma + 1).trim();
    const severityStr = line.substring(secondLastComma + 1, lastComma).trim();
    let message = line.substring(firstComma + 1, secondLastComma).trim();
    if (message.startsWith('"') && message.endsWith('"')) {
      message = message.substring(1, message.length - 1).replace(/""/g, '"');
    }

    const severity = parseInt(severityStr, 10);
    const severityName = severity === 0 ? "ERROR" : severity === 1 ? "WARNING" : severity === 2 ? "INFO" : "HINT";

    rows.push({
      code,
      message,
      severity,
      severityName,
      pointer
    });
  }
  return rows;
}

function runValidate(filePath) {
  // Step 2: Try --format json, fall back to plain text / csv
  let jsonOutput = null;
  let raw = "";
  const resJson = spawnSync("npx", ["--yes", "@gltf-transform/cli", "validate", filePath, "--format", "json"], {
    encoding: "utf8"
  });
  if (resJson.status === 0 && resJson.stdout) {
    try {
      jsonOutput = JSON.parse(resJson.stdout);
    } catch {
      // not valid json
    }
  }

  const resPretty = spawnSync("npx", ["--yes", "@gltf-transform/cli", "validate", filePath], {
    encoding: "utf8"
  });
  raw = resPretty.stdout || resPretty.stderr || "";

  const resCsv = spawnSync("npx", ["--yes", "@gltf-transform/cli", "validate", filePath, "--format", "csv"], {
    encoding: "utf8"
  });
  const csvText = resCsv.stdout || "";
  const issues = parseCsvIssues(csvText);

  return { jsonOutput, raw, issues };
}

function parseGlbChunk(filePath) {
  const buf = fs.readFileSync(filePath);
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const sizeBytes = buf.length;

  let offset = 12;
  let gltf = null;

  while (offset < buf.length) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    if (chunkType === 0x4E4F534A) {
      const jsonBytes = buf.subarray(offset + 8, offset + 8 + chunkLength);
      gltf = JSON.parse(jsonBytes.toString("utf8"));
    }
    offset += 8 + chunkLength;
  }

  const nodes = gltf.nodes || [];
  const nodeNames = nodes.map(n => n.name).filter(Boolean).sort();
  const nodesWithoutName = nodes.filter(n => !n.name).length;
  const doorSlideNodes = nodes
    .filter(n => n.name && n.name.startsWith("door_slide"))
    .map(n => ({
      name: n.name,
      translation: n.translation || [0, 0, 0]
    }));

  const animations = (gltf.animations || []).map(anim => ({
    name: anim.name || "unnamed",
    channels: (anim.channels || []).map(ch => ({
      targetNodeName: nodes[ch.target.node]?.name || `node_${ch.target.node}`,
      targetPath: ch.target.path
    }))
  }));

  const meshCount = (gltf.meshes || []).length;
  let primitiveCount = 0;
  let totalTriangles = 0;
  let hasTEXCOORD_0OnEveryPrimitive = true;
  const primitivesLackingTEXCOORD_0 = [];

  (gltf.meshes || []).forEach((m, mIdx) => {
    (m.primitives || []).forEach((p, pIdx) => {
      primitiveCount++;
      if (p.indices !== undefined) {
        const acc = gltf.accessors[p.indices];
        totalTriangles += acc.count / 3;
      }
      if (!p.attributes || p.attributes.TEXCOORD_0 === undefined) {
        hasTEXCOORD_0OnEveryPrimitive = false;
        primitivesLackingTEXCOORD_0.push({
          meshIndex: mIdx,
          primitiveIndex: pIdx,
          meshName: m.name || null
        });
      }
    });
  });

  const materialCount = (gltf.materials || []).length;
  const textureCount = (gltf.textures || []).length;
  const imageCount = (gltf.images || []).length;
  const imagesEmbedded = (gltf.images || []).every(img => img.bufferView !== undefined);

  let bboxMin = [Infinity, Infinity, Infinity];
  let bboxMax = [-Infinity, -Infinity, -Infinity];

  (gltf.accessors || []).forEach(acc => {
    if (acc.type === "VEC3" && acc.min && acc.max) {
      const isPosition = (gltf.meshes || []).some(m =>
        (m.primitives || []).some(p => p.attributes && gltf.accessors.indexOf(acc) === p.attributes.POSITION)
      );
      if (isPosition) {
        bboxMin[0] = Math.min(bboxMin[0], acc.min[0]);
        bboxMin[1] = Math.min(bboxMin[1], acc.min[1]);
        bboxMin[2] = Math.min(bboxMin[2], acc.min[2]);
        bboxMax[0] = Math.max(bboxMax[0], acc.max[0]);
        bboxMax[1] = Math.max(bboxMax[1], acc.max[1]);
        bboxMax[2] = Math.max(bboxMax[2], acc.max[2]);
      }
    }
  });

  return {
    sha256,
    sizeBytes,
    nodeNames,
    nodesWithoutName,
    doorSlideNodes,
    animations,
    meshCount,
    primitiveCount,
    materialCount,
    textureCount,
    imageCount,
    totalTriangles,
    hasTEXCOORD_0OnEveryPrimitive,
    primitivesLackingTEXCOORD_0,
    imagesEmbedded,
    sceneBboxFromAccessors: {
      space: "accessor-space (raw, untransformed)",
      min: bboxMin,
      max: bboxMax
    }
  };
}

function main() {
  fs.mkdirSync(QA_DIR, { recursive: true });

  const perFileResults = {};
  const tableRows = [];
  const summaryPerFile = {};

  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfos = 0;

  const allErrorsList = [];
  const allWarningsList = [];

  for (const filename of FILES) {
    const filePath = path.join(GLB_DIR, filename);
    const inspectResult = runInspect(filePath);
    const validateResult = runValidate(filePath);
    const customResult = parseGlbChunk(filePath);

    const fileErrors = validateResult.issues.filter(i => i.severity === 0);
    const fileWarnings = validateResult.issues.filter(i => i.severity === 1);
    const fileInfos = validateResult.issues.filter(i => i.severity === 2);

    totalErrors += fileErrors.length;
    totalWarnings += fileWarnings.length;
    totalInfos += fileInfos.length;

    fileErrors.forEach(e => allErrorsList.push({ file: filename, ...e }));
    fileWarnings.forEach(w => allWarningsList.push({ file: filename, ...w }));

    summaryPerFile[filename] = {
      errors: fileErrors.length,
      warnings: fileWarnings.length,
      infos: fileInfos.length
    };

    perFileResults[filename] = {
      sha256: customResult.sha256,
      sizeBytes: customResult.sizeBytes,
      inspectRaw: inspectResult.raw,
      inspectJson: inspectResult.jsonOutput,
      validateRaw: validateResult.raw,
      validateJson: validateResult.jsonOutput,
      issues: validateResult.issues,
      parsedGlb: customResult
    };

    tableRows.push({
      file: filename,
      triangles: customResult.totalTriangles,
      primitives: customResult.primitiveCount,
      materials: customResult.materialCount,
      textures: customResult.textureCount,
      animations: customResult.animations.length,
      errors: fileErrors.length,
      warnings: fileWarnings.length
    });
  }

  const summary = {
    totalErrors,
    totalWarnings,
    totalInfos,
    perFile: summaryPerFile
  };

  // Top-level payload with sorted keys
  const rawPayload = {
    files: perFileResults,
    generatedBy: "tools/successor/assets/dustgate-redesign/prodvalidate.mjs",
    summary
  };

  const payload = Object.keys(rawPayload)
    .sort()
    .reduce((obj, key) => {
      obj[key] = rawPayload[key];
      return obj;
    }, {});

  // Write qa/gltf_validation.json
  const jsonPath = path.join(QA_DIR, "gltf_validation.json");
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  // Format Markdown Table
  const tableHeaders = "| file | triangles | primitives | materials | textures | animations | errors | warnings |";
  const tableSep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
  const tableBodyLines = tableRows.map(
    r => `| ${r.file} | ${r.triangles} | ${r.primitives} | ${r.materials} | ${r.textures} | ${r.animations} | ${r.errors} | ${r.warnings} |`
  );
  const markdownTable = [tableHeaders, tableSep, ...tableBodyLines].join("\n");

  let mdContent = `# glTF Validation Report\n\n${markdownTable}\n\n`;

  mdContent += "## Errors\n\n";
  if (allErrorsList.length === 0) {
    mdContent += "Zero validation errors found across all files.\n\n";
  } else {
    for (const err of allErrorsList) {
      mdContent += `- **${err.file}** [${err.code}]: ${err.message} (pointer: \`${err.pointer}\`)\n`;
    }
    mdContent += "\n";
  }

  mdContent += "## Warnings\n\n";
  if (allWarningsList.length === 0) {
    mdContent += "Zero validation warnings found across all files.\n\n";
  } else {
    // Group by file
    const byFile = {};
    for (const warn of allWarningsList) {
      if (!byFile[warn.file]) byFile[warn.file] = [];
      byFile[warn.file].push(warn);
    }
    for (const [file, warns] of Object.entries(byFile)) {
      mdContent += `### ${file}\n\n`;
      for (const w of warns) {
        mdContent += `- **\`${w.code}\`**: ${w.message} (pointer: \`${w.pointer}\`)\n`;
      }
      mdContent += "\n";
    }
  }

  // Write qa/gltf_validation.md
  const mdPath = path.join(QA_DIR, "gltf_validation.md");
  fs.writeFileSync(mdPath, mdContent, "utf8");

  // Print table to stdout
  console.log(markdownTable);

  if (totalErrors > 0) {
    process.exit(1);
  }
}

main();
