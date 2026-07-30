/**
 * Polygon Forge Face Kit
 *
 * A zero-dependency, mesh-agnostic facial texture compositor. It combines
 * independently selected eye, brow, nose, and mouth artwork from 4x2 atlases,
 * applies semantic iris recoloring, and returns a browser canvas ready for
 * export or use as a Three.js texture.
 */

export const FACE_STYLE_ORDER = Object.freeze([
  "stoic", "rogue", "youth", "ghost",
  "sharp", "feral", "regal", "veteran",
]);

export const FACE_STYLE_LABELS = Object.freeze({
  stoic: "PS2 Natural",
  rogue: "Western Toon",
  youth: "Anime Hero",
  ghost: "Chibi Adventure",
  sharp: "Graphic Novel",
  feral: "Arcade Fighter",
  regal: "Painterly Noble",
  veteran: "Wasteland Veteran",
});

export const SKIN_TONES = Object.freeze([
  "#f3c6a5", "#dca27f", "#bd7f5d", "#915b42",
  "#633c2e", "#3f2923", "#d8b597", "#a66f58",
]);
export const EYE_COLORS = Object.freeze(["#7eb7c7", "#78955e", "#7b573b", "#b7aa72", "#4c5261", "#b7d4dd"]);
export const BROW_COLORS = Object.freeze(["#171313", "#35241e", "#5b3827", "#8a5b38", "#b58b5b", "#77716b"]);
export const LIP_COLORS = Object.freeze(["#74443f", "#94544f", "#ae6d68", "#6c3438", "#b77a72", "#4f302e"]);

const irisPair = (leftU, rightU, v, radiusU, radiusV, pupilRatioU, pupilRatioV = pupilRatioU, pupilOffsetU = 0, pupilOffsetV = 0) => ({
  eyes: [
    { u: leftU, v, radiusU, radiusV, pupilRatioU, pupilRatioV, pupilOffsetU, pupilOffsetV },
    { u: rightU, v, radiusU, radiusV, pupilRatioU, pupilRatioV, pupilOffsetU: -pupilOffsetU, pupilOffsetV },
  ],
});

/** Pixel-measured iris regions for every eye cell in face-eyes-v3.png. */
export const FACE_SEMANTIC_LAYOUT = Object.freeze({
  stoic: irisPair(.290, .710, .382, .035, .039, .34),
  rogue: irisPair(.290, .710, .375, .040, .043, .34, .38, 0, -.006),
  youth: irisPair(.290, .710, .386, .033, .066, .31, .38, 0, -.008),
  ghost: irisPair(.305, .695, .391, .055, .081, .38, .45, 0, -.012),
  sharp: irisPair(.290, .710, .374, .029, .034, .52, .52),
  feral: irisPair(.290, .710, .385, .040, .044, .30),
  regal: irisPair(.290, .710, .376, .047, .050, .34),
  veteran: irisPair(.290, .710, .372, .045, .041, .24),
});

const IDENTITY = Object.freeze({ offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 });

export const DEFAULT_FACE_CONFIG = Object.freeze({
  skinColor: "#bd7f5d",
  eyeColor: "#7eb7c7",
  browColor: "#35241e",
  lipColor: "#74443f",
  styles: Object.freeze({ eyes: "stoic", brows: "stoic", nose: "stoic", mouth: "stoic" }),
  eyes: Object.freeze({ ...IDENTITY, spacing: 1, irisScale: 1 }),
  brows: Object.freeze({ ...IDENTITY, spacing: 1 }),
  nose: IDENTITY,
  mouth: IDENTITY,
  paint: Object.freeze([]),
});

export const FACE_ASSET_FILES = Object.freeze({
  eyes: "face-eyes-v3.png",
  brows: "face-brows-v3.png",
  noses: "face-noses-v3.png",
  mouths: "face-mouths-v3.png",
  semantic: "face-iris-mask-v3.png",
});

const STYLE_INDEX = Object.freeze(Object.fromEntries(FACE_STYLE_ORDER.map((style, index) => [style, index])));
const FEATURE_BACKGROUND = Object.freeze([202, 136, 97]);
const WARM_WHITE = Object.freeze([242, 238, 226]);

const clamp = (value, min, max) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const clampByte = value => clamp(Math.round(value), 0, 255);
const smoothstep = (a, b, value) => {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (base, overlay, amount) => base.map((channel, index) => clampByte(channel + (overlay[index] - channel) * clamp(amount, 0, 1)));
const ellipseMask = (u, v, centerU, centerV, radiusU, radiusV) =>
  1 - smoothstep(.72, 1, Math.hypot((u - centerU) / radiusU, (v - centerV) / radiusV));

function parseColor(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) return value.slice(0, 3).map(clampByte);
  const hex = typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  const number = Number.parseInt(hex.slice(1), 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function style(value) {
  return Object.hasOwn(STYLE_INDEX, value) ? value : "stoic";
}

function transform(value = {}, pair = false, iris = false) {
  const normalized = {
    offsetY: clamp(Number(value.offsetY ?? 0), -.10, .10),
    scaleX: clamp(Number(value.scaleX ?? 1), .55, 1.55),
    scaleY: clamp(Number(value.scaleY ?? 1), .55, 1.55),
    rotation: clamp(Number(value.rotation ?? 0), -30, 30),
  };
  if (pair) normalized.spacing = clamp(Number(value.spacing ?? 1), .65, 1.35);
  if (iris) normalized.irisScale = clamp(Number(value.irisScale ?? 1), .55, 1.5);
  return normalized;
}

/** Return a defensive, clamped config accepted by every renderer in this kit. */
export function normalizeFaceConfig(input = {}) {
  return {
    skinColor: typeof input.skinColor === "string" ? input.skinColor : DEFAULT_FACE_CONFIG.skinColor,
    eyeColor: typeof input.eyeColor === "string" ? input.eyeColor : DEFAULT_FACE_CONFIG.eyeColor,
    browColor: typeof input.browColor === "string" ? input.browColor : DEFAULT_FACE_CONFIG.browColor,
    lipColor: typeof input.lipColor === "string" ? input.lipColor : DEFAULT_FACE_CONFIG.lipColor,
    styles: {
      eyes: style(input.styles?.eyes),
      brows: style(input.styles?.brows),
      nose: style(input.styles?.nose),
      mouth: style(input.styles?.mouth),
    },
    eyes: transform(input.eyes, true, true),
    brows: transform(input.brows, true, false),
    nose: transform(input.nose, false, false),
    mouth: transform(input.mouth, false, false),
    paint: Array.isArray(input.paint) ? input.paint : [],
  };
}

function imageDataFromImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function loadImageData(url, label) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      try { resolve(imageDataFromImage(image)); }
      catch (error) { reject(error); }
    };
    image.onerror = () => reject(new Error(`Unable to load ${label} from ${url}`));
    image.src = url;
  });
}

/**
 * Load the five runtime atlases. `baseUrl` may be a URL object or a string
 * ending at the assets directory.
 */
export async function loadFaceAssets(baseUrl = new URL("../assets/", import.meta.url)) {
  const base = baseUrl instanceof URL ? baseUrl : new URL(baseUrl, document.baseURI);
  const entries = await Promise.all(Object.entries(FACE_ASSET_FILES).map(async ([key, filename]) => [
    key,
    await loadImageData(new URL(filename, base).href, key),
  ]));
  const assets = Object.fromEntries(entries);
  const dimensions = `${assets.eyes.width}x${assets.eyes.height}`;
  if (Object.values(assets).some(image => `${image.width}x${image.height}` !== dimensions)) {
    throw new Error("Face atlases and semantic mask must have identical dimensions");
  }
  if (assets.eyes.width % 2 || assets.eyes.height % 1) {
    throw new Error("Invalid face atlas dimensions");
  }
  return assets;
}

function sample(image, x, y) {
  const ix = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const iy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const offset = (iy * image.width + ix) * 4;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
}

function readCell(sheet, styleName, u, v) {
  const index = STYLE_INDEX[style(styleName)];
  const column = index % 4;
  const row = Math.floor(index / 4);
  const cellWidth = sheet.width / 4;
  const cellHeight = sheet.height / 2;
  return sample(sheet, (column + clamp(u, .01, .99)) * cellWidth, (row + clamp(v, .01, .99)) * cellHeight);
}

function inverseFeaturePoint(u, v, centerU, centerV, settings, side = 1) {
  const spacing = settings.spacing ?? 1;
  const targetCenterU = .5 + (centerU - .5) * spacing;
  const targetCenterV = centerV + settings.offsetY;
  const angle = settings.rotation * Math.PI / 180 * side;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = u - targetCenterU;
  const dy = v - targetCenterV;
  return {
    u: centerU + (cosine * dx + sine * dy) / settings.scaleX,
    v: centerV + (-sine * dx + cosine * dy) / settings.scaleY,
  };
}

const markStrength = art => smoothstep(4, 18, Math.max(...art.map((channel, index) => Math.abs(channel - FEATURE_BACKGROUND[index]))));
const tintSkin = (art, skin) => art.map((channel, index) => clampByte(skin[index] + (channel - FEATURE_BACKGROUND[index]) * .86));
function shadeColor(target, art, strength = 1) {
  const sourceLuma = art[0] * .24 + art[1] * .64 + art[2] * .12;
  const baseLuma = FEATURE_BACKGROUND[0] * .24 + FEATURE_BACKGROUND[1] * .64 + FEATURE_BACKGROUND[2] * .12;
  const shade = clamp(.42 + sourceLuma / baseLuma * .50, .28, 1.2) * strength;
  return target.map(channel => clampByte(channel * shade));
}

function featureSample(assets, sheetName, styleName, u, v, centerU, centerV, radiusU, radiusV, settings, side = 1) {
  const source = inverseFeaturePoint(u, v, centerU, centerV, settings, side);
  const art = readCell(assets[sheetName], styleName, source.u, source.v);
  const mask = ellipseMask(source.u, source.v, centerU, centerV, radiusU, radiusV) * markStrength(art);
  return { art, source, mask };
}

function overPixel(target, offset, color, alpha) {
  const amount = clamp(alpha, 0, 1);
  target[offset] = clampByte(target[offset] + (color[0] - target[offset]) * amount);
  target[offset + 1] = clampByte(target[offset + 1] + (color[1] - target[offset + 1]) * amount);
  target[offset + 2] = clampByte(target[offset + 2] + (color[2] - target[offset + 2]) * amount);
}

function accumulateDecal(premultiplied, alphaBuffer, pixelIndex, color, alpha) {
  const amount = clamp(alpha, 0, 1);
  if (amount <= 0) return;
  const inverse = 1 - amount;
  const offset = pixelIndex * 3;
  premultiplied[offset] = color[0] * amount + premultiplied[offset] * inverse;
  premultiplied[offset + 1] = color[1] * amount + premultiplied[offset + 1] * inverse;
  premultiplied[offset + 2] = color[2] * amount + premultiplied[offset + 2] * inverse;
  alphaBuffer[pixelIndex] = amount + alphaBuffer[pixelIndex] * inverse;
}

function validateAssets(assets) {
  for (const key of Object.keys(FACE_ASSET_FILES)) {
    const image = assets?.[key];
    if (!image || !Number.isFinite(image.width) || !Number.isFinite(image.height) || !image.data) {
      throw new Error(`Missing or invalid face asset: ${key}`);
    }
  }
}

/**
 * Pure pixel compositor. Works in browsers, workers, and Node when supplied
 * decoded RGBA assets. Returns straight RGBA in a Uint8ClampedArray.
 */
export function composeFacePixels(assets, inputConfig = {}, options = {}) {
  validateAssets(assets);
  const config = normalizeFaceConfig(inputConfig);
  const size = Math.round(clamp(Number(options.size ?? 256), 32, 2048));
  const transparent = Boolean(options.transparent);
  const skin = parseColor(config.skinColor, DEFAULT_FACE_CONFIG.skinColor);
  const irisColor = parseColor(config.eyeColor, DEFAULT_FACE_CONFIG.eyeColor);
  const browColor = parseColor(config.browColor, DEFAULT_FACE_CONFIG.browColor);
  const lipColor = parseColor(config.lipColor, DEFAULT_FACE_CONFIG.lipColor);
  const pixels = new Uint8ClampedArray(size * size * 4);
  const decalRgb = transparent ? new Float32Array(size * size * 3) : null;
  const decalAlpha = transparent ? new Float32Array(size * size) : null;
  const eyeStyle = config.styles.eyes;
  const semanticLayout = FACE_SEMANTIC_LAYOUT[eyeStyle] ?? FACE_SEMANTIC_LAYOUT.stoic;

  for (let y = 0; y < size; y++) {
    const v = (y + .5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + .5) / size;
      const pixelIndex = y * size + x;
      const offset = pixelIndex * 4;
      pixels[offset] = skin[0];
      pixels[offset + 1] = skin[1];
      pixels[offset + 2] = skin[2];
      pixels[offset + 3] = 255;
      const layer = (color, alpha) => {
        overPixel(pixels, offset, color, alpha);
        if (transparent) accumulateDecal(decalRgb, decalAlpha, pixelIndex, color, alpha);
      };

      const nose = featureSample(assets, "noses", config.styles.nose, u, v, .5, .585, .12, .15, config.nose);
      layer(tintSkin(nose.art, skin), nose.mask);

      const mouth = featureSample(assets, "mouths", config.styles.mouth, u, v, .5, .755, .22, .085, config.mouth);
      const mouthArt = mix(tintSkin(mouth.art, skin), shadeColor(lipColor, mouth.art), .76 * mouth.mask);
      layer(mouthArt, mouth.mask);

      for (const side of [-1, 1]) {
        const sideIndex = side < 0 ? 0 : 1;
        const centerU = side < 0 ? .29 : .71;
        const irisRegion = semanticLayout.eyes[sideIndex];
        const eyeRadiusV = eyeStyle === "ghost" ? .145 : eyeStyle === "youth" ? .132 : eyeStyle === "rogue" ? .12 : .108;
        const eyes = featureSample(assets, "eyes", eyeStyle, u, v, centerU, .385, .195, eyeRadiusV, config.eyes, side);
        let eyeArt = tintSkin(eyes.art, skin);
        const scleraSignal = Math.min(eyes.art[1] - FEATURE_BACKGROUND[1], eyes.art[2] - FEATURE_BACKGROUND[2]);
        eyeArt = mix(eyeArt, WARM_WHITE, smoothstep(10, 48, scleraSignal) * eyes.mask);

        const sourceSemantic = readCell(assets.semantic, eyeStyle, eyes.source.u, eyes.source.v);
        eyeArt = mix(eyeArt, WARM_WHITE, sourceSemantic[0] / 255 * eyes.mask);

        const irisU = irisRegion.u + (eyes.source.u - irisRegion.u) / config.eyes.irisScale;
        const irisV = irisRegion.v + (eyes.source.v - irisRegion.v) / config.eyes.irisScale;
        const irisArt = readCell(assets.eyes, eyeStyle, irisU, irisV);
        const irisSemantic = readCell(assets.semantic, eyeStyle, irisU, irisV);
        eyeArt = mix(eyeArt, irisArt, irisSemantic[0] / 255 * eyes.mask);
        eyeArt = mix(eyeArt, shadeColor(irisColor, irisArt, 1.08), irisSemantic[1] / 255 * eyes.mask);
        layer(eyeArt, eyes.mask);

        const brows = featureSample(assets, "brows", config.styles.brows, u, v, centerU, .225, .215, .082, config.brows, side);
        layer(shadeColor(browColor, brows.art), brows.mask);
      }

      if (transparent) {
        const alpha = decalAlpha[pixelIndex];
        const premultipliedOffset = pixelIndex * 3;
        if (alpha > 0.0001) {
          pixels[offset] = clampByte(decalRgb[premultipliedOffset] / alpha);
          pixels[offset + 1] = clampByte(decalRgb[premultipliedOffset + 1] / alpha);
          pixels[offset + 2] = clampByte(decalRgb[premultipliedOffset + 2] / alpha);
          pixels[offset + 3] = clampByte(alpha * 255);
        } else {
          pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = pixels[offset + 3] = 0;
        }
      }
    }
  }
  return { width: size, height: size, data: pixels, config };
}

function drawStroke(context, stroke, size) {
  if (!Array.isArray(stroke?.points) || !stroke.points.length) return;
  context.save();
  context.globalCompositeOperation = stroke.tool === "erase" ? "destination-out" : "source-over";
  context.globalAlpha = clamp(Number(stroke.opacity ?? 1), 0, 1);
  context.fillStyle = context.strokeStyle = typeof stroke.color === "string" ? stroke.color : "#7d3432";
  context.lineWidth = clamp(Number(stroke.size ?? 4), .25, 64) * size / 128;
  context.lineCap = "round";
  context.lineJoin = "round";
  const paths = [stroke.points];
  if (stroke.mirror) paths.push(stroke.points.map(point => ({
    u: point.mirrorU ?? 1 - point.u,
    v: point.mirrorV ?? point.v,
  })));
  for (const path of paths) {
    context.beginPath();
    context.moveTo(path[0].u * size, (1 - path[0].v) * size);
    if (path.length === 1) {
      context.arc(path[0].u * size, (1 - path[0].v) * size, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      for (const point of path.slice(1)) context.lineTo(point.u * size, (1 - point.v) * size);
      context.stroke();
    }
  }
  context.restore();
}

/** Render a face to an HTMLCanvasElement. */
export function renderFaceTexture(assets, inputConfig = {}, options = {}) {
  if (typeof document === "undefined") throw new Error("renderFaceTexture requires a browser DOM; use composeFacePixels in Node or a worker");
  const result = composeFacePixels(assets, inputConfig, options);
  const canvas = options.canvas ?? document.createElement("canvas");
  canvas.width = result.width;
  canvas.height = result.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable");
  context.putImageData(new ImageData(result.data, result.width, result.height), 0, 0);
  for (const stroke of result.config.paint) drawStroke(context, stroke, result.width);
  return canvas;
}

/** Create a Three.js CanvasTexture without coupling this kit to a Three version. */
export function makeThreeTexture(THREE, canvas, options = {}) {
  if (!THREE?.CanvasTexture) throw new Error("Pass the imported Three.js namespace as the first argument");
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  if (options.pixelated !== false) {
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = options.mipmaps === false ? THREE.NearestFilter : THREE.NearestMipmapNearestFilter;
  }
  texture.generateMipmaps = options.mipmaps !== false;
  texture.flipY = options.flipY ?? true;
  texture.needsUpdate = true;
  return texture;
}

/** Re-render into an existing CanvasTexture without reallocating GPU state. */
export function updateThreeTexture(texture, assets, config, options = {}) {
  const canvas = renderFaceTexture(assets, config, { ...options, canvas: texture.image });
  texture.image = canvas;
  texture.needsUpdate = true;
  return texture;
}

export function downloadFacePNG(canvas, filename = "face-texture.png") {
  const link = document.createElement("a");
  link.download = filename;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

export function randomFaceConfig(random = Math.random) {
  const pick = values => values[Math.floor(random() * values.length) % values.length];
  return normalizeFaceConfig({
    skinColor: pick(SKIN_TONES), eyeColor: pick(EYE_COLORS), browColor: pick(BROW_COLORS), lipColor: pick(LIP_COLORS),
    styles: { eyes: pick(FACE_STYLE_ORDER), brows: pick(FACE_STYLE_ORDER), nose: pick(FACE_STYLE_ORDER), mouth: pick(FACE_STYLE_ORDER) },
    eyes: { offsetY: (random() - .5) * .035, scaleX: .82 + random() * .34, scaleY: .82 + random() * .34, rotation: (random() - .5) * 14, spacing: .82 + random() * .34, irisScale: .76 + random() * .48 },
    brows: { offsetY: (random() - .5) * .045, scaleX: .82 + random() * .34, scaleY: .82 + random() * .30, rotation: (random() - .5) * 18, spacing: .84 + random() * .32 },
    nose: { offsetY: (random() - .5) * .035, scaleX: .82 + random() * .30, scaleY: .78 + random() * .40, rotation: (random() - .5) * 8 },
    mouth: { offsetY: (random() - .5) * .035, scaleX: .78 + random() * .42, scaleY: .82 + random() * .30, rotation: (random() - .5) * 10 },
  });
}
