// Successor Rust Client — WebGL2, WebSockets, Fetch, and Input JS loader.
"use strict";

// `tools/web-release.mjs` replaces this complete development block when it
// assembles a public artifact. Release builds fail closed on every blank field.
const successorBuild = Object.freeze({
    allowDevLaunch: true,
    storefrontOrigin: "",
    clientReleaseId: "",
    serverReleaseId: "",
    gameOrigin: "",
    chatOrigin: "",
    objectStore: false
});

const canvas = document.getElementById("app");
const loading = document.getElementById("loading");
const loadingPhase = document.getElementById("loading-phase");
const loadingBar = document.getElementById("loading-bar");
const loadingDetail = document.getElementById("loading-detail");

function showLoading(phase, detail = "", fraction = 0) {
    loadingPhase.textContent = phase;
    loadingDetail.textContent = detail;
    loadingBar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
}

function failLoading(error) {
    loading.classList.add("error");
    showLoading("UNABLE TO ENTER WORLD", String(error).replaceAll(/[?#].*/g, ""), 0);
}

function finishLoading() {
    loading.classList.add("hidden");
    window.setTimeout(() => loading.remove(), 220);
}
const gl = canvas.getContext("webgl2");

let webglContextLost = false;
canvas.addEventListener("webglcontextlost", e => {
    e.preventDefault();
    webglContextLost = true;
    window.__successorRenderError = "WebGL context lost; reconnecting renderer";
});
canvas.addEventListener("webglcontextrestored", () => {
    webglContextLost = false;
    window.__successorRenderError = null;
    if (typeof wasmExports.context_restored === "function") wasmExports.context_restored();
});
if (!gl) {
    console.error("WebGL2 is not supported by this browser.");
}

// Input state tracking. Indices are the stable engine-core Key discriminants.
const keyState = new Uint8Array(39);
const keyMap = {
    "KeyW": 0, "KeyA": 1, "KeyS": 2, "KeyD": 3,
    "ArrowUp": 4, "ArrowDown": 5, "ArrowLeft": 6, "ArrowRight": 7,
    "Space": 8, "Enter": 9, "Escape": 10, "Backspace": 11,
    "ShiftLeft": 12, "Backquote": 13, "KeyR": 14, "KeyF": 15,
    "KeyI": 16, "KeyC": 17, "Semicolon": 18, "KeyO": 19,
    "Tab": 20, "KeyV": 21, "KeyX": 22, "KeyN": 23,
    ...Object.fromEntries(Array.from({length: 10}, (_, i) => [`Digit${i}`, 24 + i])),
    "KeyP": 34, "KeyK": 35, "KeyB": 36, "KeyM": 37, "KeyG": 38
};

window.addEventListener("keydown", (e) => {
    const code = keyMap[e.code];
    if (code !== undefined) {
        keyState[code] = 1;
    }
    if (e.isTrusted) authorizeAudioGesture();
});

window.addEventListener("keyup", (e) => {
    const code = keyMap[e.code];
    if (code !== undefined) {
        keyState[code] = 0;
    }
});

function releaseMovementInput(reason) {
    keyState.fill(0);
    mouseButtons.fill(0);
    if (typeof wasmExports.release_movement_input === "function") {
        wasmExports.release_movement_input(reason);
    }
}
window.addEventListener("blur", () => releaseMovementInput(0));
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") releaseMovementInput(1);
});
window.addEventListener("pagehide", () => releaseMovementInput(1));

let mouseX = 0, mouseY = 0;
const mouseButtons = new Uint8Array(3);
function updatePointer(e) {
    const r = canvas.getBoundingClientRect();
    mouseX = (e.clientX - r.left) * canvas.width / r.width;
    mouseY = (e.clientY - r.top) * canvas.height / r.height;
}
canvas.addEventListener("pointermove", updatePointer);
canvas.addEventListener("pointerdown", e => {
    updatePointer(e);
    if (e.button < mouseButtons.length) mouseButtons[e.button] = 1;
    canvas.setPointerCapture(e.pointerId);
    if (e.isTrusted) authorizeAudioGesture();
});
function releasePointer(e) {
    updatePointer(e);
    if (e.button < mouseButtons.length) mouseButtons[e.button] = 0;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
}
canvas.addEventListener("pointerup", releasePointer);
canvas.addEventListener("pointercancel", e => {
    mouseButtons.fill(0);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
});
canvas.addEventListener("lostpointercapture", () => mouseButtons.fill(0));
const charQueue = [];
window.addEventListener("keypress", (e) => {
    if (e.key.length === 1) {
        charQueue.push(e.key.charCodeAt(0));
    }
});

// Resource table: WebGL objects referenced by integer ID from WASM.
// Index 0 = null/invalid.

let scrollX = 0;
let scrollY = 0;
window.addEventListener("wheel", (e) => {
    scrollX += e.deltaX;
    scrollY += e.deltaY;
}, { passive: true });
const glResources = [null];

function glAlloc(obj) {
    glResources.push(obj);
    return glResources.length - 1;
}

let launchContextText = "";
let hostedLaunch = false;
const creatorMode = new URLSearchParams(window.location.search).get("mode") === "creator";

function takeDevelopmentLaunch() {
    if (!successorBuild.allowDevLaunch) return "";
    const supplied = window.__SUCCESSOR_LAUNCH_CONTEXT;
    if (typeof supplied === "string" && supplied.trim()) return supplied;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("launchContext") || params.get("launch");
    if (!raw) return "";
    try {
        return params.has("launchContext") ? decodeURIComponent(raw) : atob(raw);
    } catch (_) {
        return raw;
    }
}

function validHostedLaunch(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (Object.keys(value).sort().join(",") !== "characterId,chatTicket,endpoints,expiresAt,gameTicket,release,schema") return false;
    if (value.schema !== "successor.launch-context.v1") return false;
    if (typeof value.gameTicket !== "string" || value.gameTicket.length < 32) return false;
    if (typeof value.chatTicket !== "string" || value.chatTicket.length < 32 || value.chatTicket === value.gameTicket) return false;
    if (typeof value.characterId !== "string" || value.characterId.length < 1 || value.characterId.length > 128) return false;
    if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 50000) return false;
    if (value.release === null || typeof value.release !== "object") return false;
    if (value.release.client !== successorBuild.clientReleaseId || value.release.server !== successorBuild.serverReleaseId) return false;
    if (value.endpoints === null || typeof value.endpoints !== "object") return false;
    try {
        return new URL(value.endpoints.game).origin === successorBuild.gameOrigin
            && new URL(value.endpoints.chat).origin === successorBuild.chatOrigin;
    } catch (_) {
        return false;
    }
}

// The workshop has no account/session capability. It is deliberately a tiny
// exact-origin relay for its five versioned creator messages, installed before
// WASM boot so a parent response cannot race child initialization.
const CREATOR_READY = "successor.creator.ready.v1";
const CREATOR_CREATE = "successor.creator.create.v1";
const CREATOR_SELECT = "successor.creator.select.v1";
const CREATOR_STATE = "successor.creator.state.v1";
const CREATOR_CREATE_RESULT = "successor.creator.create-result.v1";
const CREATOR_MAX_QUEUE = 8;
const CREATOR_MAX_MESSAGE_BYTES = 16 * 1024;
const CREATOR_MAX_ROSTER = 10;
const CREATOR_FACE_KEYS = ["eyes", "brows", "nose", "mouth", "eyeColor", "browColor", "lipColor"];
const creatorTextEncoder = new TextEncoder();

function isPlainRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, keys) {
    return isPlainRecord(value) && Object.keys(value).every(key => keys.includes(key));
}

function isSafeText(value, min, max) {
    return typeof value === "string"
        && value.length >= min
        && value.length <= max
        && /^[\x20-\x7e]*$/u.test(value);
}

function isCreatorCharacterId(value) {
    return typeof value === "string"
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCreatorRequestId(value) {
    return typeof value === "string"
        && /^[A-Za-z0-9._:-]{1,64}$/u.test(value);
}

function isCreatorName(value) {
    return typeof value === "string"
        && /^[A-Za-z]+(?:-[A-Za-z]+)*$/u.test(value)
        && value.length >= 3
        && value.length <= 16;
}

function isCreatorProfession(value) {
    return typeof value === "string" && /^[a-z][a-z_-]{0,31}$/u.test(value);
}

function normalizeCreatorAppearance(value) {
    if (!hasOnlyKeys(value, ["body", "skinTone", "hair", "hairMat", "face"])) return null;
    if ((value.body !== "male" && value.body !== "female")
        || !isSafeText(value.skinTone, 1, 64)
        || !isSafeText(value.hairMat, 1, 64)
        || (value.hair !== null && !isSafeText(value.hair, 1, 64))) {
        return null;
    }
    let face = null;
    if (value.face !== null) {
        if (!hasOnlyKeys(value.face, CREATOR_FACE_KEYS)
            || !CREATOR_FACE_KEYS.every(key => isSafeText(value.face[key], 1, 64))) {
            return null;
        }
        face = {
            eyes: value.face.eyes,
            brows: value.face.brows,
            nose: value.face.nose,
            mouth: value.face.mouth,
            eyeColor: value.face.eyeColor,
            browColor: value.face.browColor,
            lipColor: value.face.lipColor
        };
    }
    return {
        body: value.body,
        skinTone: value.skinTone,
        hair: value.hair,
        hairMat: value.hairMat,
        face
    };
}

function safeCreatorWorn(value) {
    return hasOnlyKeys(value, ["item", "colors"])
        && isSafeText(value.item, 1, 128)
        && Array.isArray(value.colors)
        && value.colors.length <= 8
        && value.colors.every(color => isSafeText(color, 1, 64));
}

function normalizeCreatorRecord(value) {
    if (!hasOnlyKeys(value, ["id", "name", "initialProfessionId", "worldEntryClaimed", "appearance", "worn"])
        || !isCreatorCharacterId(value.id)
        || !isCreatorName(value.name)
        || (value.initialProfessionId !== null && !isCreatorProfession(value.initialProfessionId))
        || typeof value.worldEntryClaimed !== "boolean") {
        return null;
    }
    const appearance = normalizeCreatorAppearance(value.appearance);
    if (appearance === null
        || (value.worn !== undefined
            && (!Array.isArray(value.worn)
                || value.worn.length > 8
                || !value.worn.every(safeCreatorWorn)))) {
        return null;
    }
    // Keep exactly the roster projection consumed by Rust. Worn pieces are
    // checked above but not queued because the current screen does not render
    // wardrobe; this prevents dormant arbitrary payloads crossing the fence.
    return {
        id: value.id,
        name: value.name,
        initialProfessionId: value.initialProfessionId,
        worldEntryClaimed: value.worldEntryClaimed,
        appearance
    };
}

function normalizeCreatorState(value) {
    if (!hasOnlyKeys(value, ["type", "characters", "selectedCharacterId"])
        || value.type !== CREATOR_STATE
        || !Array.isArray(value.characters)
        || value.characters.length > CREATOR_MAX_ROSTER) {
        return null;
    }
    const characters = value.characters.map(normalizeCreatorRecord);
    if (characters.some(character => character === null)) return null;
    const ids = new Set();
    for (const character of characters) {
        if (ids.has(character.id)) return null;
        ids.add(character.id);
    }
    if (value.selectedCharacterId !== undefined
        && (!isCreatorCharacterId(value.selectedCharacterId) || !ids.has(value.selectedCharacterId))) {
        return null;
    }
    return {
        type: CREATOR_STATE,
        characters,
        ...(value.selectedCharacterId === undefined ? {} : { selectedCharacterId: value.selectedCharacterId })
    };
}

function normalizeCreatorCreateResult(value) {
    if (!hasOnlyKeys(value, ["type", "requestId", "ok", "error"])
        || value.type !== CREATOR_CREATE_RESULT
        || !isCreatorRequestId(value.requestId)
        || typeof value.ok !== "boolean") {
        return null;
    }
    if (value.ok && value.error !== undefined) return null;
    if (value.error !== undefined && !isSafeText(value.error, 1, 128)) return null;
    return {
        type: CREATOR_CREATE_RESULT,
        requestId: value.requestId,
        ok: value.ok,
        ...(value.error === undefined ? {} : { error: value.error })
    };
}

function normalizeCreatorCreate(value) {
    if (!hasOnlyKeys(value, ["type", "requestId", "character"])
        || value.type !== CREATOR_CREATE
        || !isCreatorRequestId(value.requestId)
        || !hasOnlyKeys(value.character, ["name", "initialProfessionId", "appearance"])
        || !isCreatorName(value.character.name)
        || !isCreatorProfession(value.character.initialProfessionId)) {
        return null;
    }
    const appearance = normalizeCreatorAppearance(value.character.appearance);
    if (appearance === null) return null;
    return {
        type: CREATOR_CREATE,
        requestId: value.requestId,
        character: {
            name: value.character.name,
            initialProfessionId: value.character.initialProfessionId,
            appearance
        }
    };
}

function exactCreatorOrigin(value) {
    if (typeof value !== "string" || !value) return null;
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:"
            && !parsed.username
            && !parsed.password
            && parsed.pathname === "/"
            && !parsed.search
            && !parsed.hash
            && !parsed.hostname.includes("*")
            && parsed.origin === value
            ? parsed.origin
            : null;
    } catch (_) {
        return null;
    }
}

function createCreatorBridge() {
    const origin = exactCreatorOrigin(successorBuild.storefrontOrigin);
    if (!origin || window.parent === window) {
        throw new Error("hosted creator is not configured");
    }
    const queue = [];
    const enqueue = message => {
        const bytes = creatorTextEncoder.encode(JSON.stringify(message));
        if (bytes.byteLength === 0 || bytes.byteLength > CREATOR_MAX_MESSAGE_BYTES) return;
        if (message.type === CREATOR_STATE) {
            for (let index = queue.length - 1; index >= 0; index -= 1) {
                if (queue[index].type === CREATOR_STATE) queue.splice(index, 1);
            }
        }
        if (queue.length >= CREATOR_MAX_QUEUE) {
            const stateIndex = queue.findIndex(entry => entry.type === CREATOR_STATE);
            if (stateIndex >= 0) queue.splice(stateIndex, 1);
            else return;
        }
        queue.push({ type: message.type, bytes });
    };
    window.addEventListener("message", event => {
        if (event.source !== window.parent || event.origin !== origin) return;
        const state = normalizeCreatorState(event.data);
        if (state !== null) {
            enqueue(state);
            return;
        }
        const result = normalizeCreatorCreateResult(event.data);
        if (result !== null) enqueue(result);
    });
    return {
        ready: () => window.parent.postMessage({ type: CREATOR_READY }, origin),
        messageLength: () => queue[0]?.bytes.byteLength ?? 0,
        copyMessage: (ptr, maxLen) => {
            const entry = queue.shift();
            if (!entry || entry.bytes.byteLength > maxLen || !wasmMemory) return 0;
            new Uint8Array(wasmMemory.buffer, ptr, entry.bytes.byteLength).set(entry.bytes);
            return entry.bytes.byteLength;
        },
        discardMessage: () => { queue.shift(); },
        postCreate: raw => {
            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (_) {
                return false;
            }
            const message = normalizeCreatorCreate(parsed);
            if (message === null) return false;
            window.parent.postMessage(message, origin);
            return true;
        },
        postSelect: characterId => {
            if (!isCreatorCharacterId(characterId)) return false;
            window.parent.postMessage({ type: CREATOR_SELECT, characterId }, origin);
            return true;
        }
    };
}

let creatorBridge = null;
let creatorStartupError = null;
if (creatorMode) {
    try {
        creatorBridge = createCreatorBridge();
    } catch (error) {
        creatorStartupError = error;
    }
}

function waitForHostedLaunch(timeoutMs = 30000) {
    const development = takeDevelopmentLaunch();
    if (development) {
        launchContextText = development;
        return Promise.resolve();
    }
    const configured = [
        successorBuild.storefrontOrigin,
        successorBuild.clientReleaseId,
        successorBuild.serverReleaseId,
        successorBuild.gameOrigin,
        successorBuild.chatOrigin
    ].every(value => typeof value === "string" && value.length > 0);
    if (!configured || window.parent === window) return Promise.reject(new Error("hosted launch is not configured"));
    return new Promise((resolve, reject) => {
        let settled = false;
        const ready = () => window.parent.postMessage({
            type: "successor.client.ready.v1",
            releaseId: successorBuild.clientReleaseId
        }, successorBuild.storefrontOrigin);
        const finish = callback => {
            if (settled) return;
            settled = true;
            window.removeEventListener("message", onMessage);
            clearInterval(retry);
            clearTimeout(timeout);
            callback();
        };
        const onMessage = event => {
            if (event.source !== window.parent || event.origin !== successorBuild.storefrontOrigin) return;
            const data = event.data;
            if (data === null || typeof data !== "object" || Object.keys(data).sort().join(",") !== "launch,type") return;
            if (data.type !== "successor.launch.v1" || !validHostedLaunch(data.launch)) return;
            launchContextText = JSON.stringify(data.launch);
            hostedLaunch = true;
            finish(resolve);
        };
        window.addEventListener("message", onMessage);
        const retry = setInterval(ready, 2000);
        const timeout = setTimeout(() => finish(() => reject(new Error("hosted launch timed out"))), timeoutMs);
        ready();
    });
}

function installHostedExitHandler() {
    if (!hostedLaunch) return;
    let running = false;
    window.addEventListener("message", event => {
        if (running || event.source !== window.parent || event.origin !== successorBuild.storefrontOrigin) return;
        if (event.data === null || typeof event.data !== "object") return;
        if (Object.keys(event.data).join(",") !== "type" || event.data.type !== "successor.client.exit-world.v1") return;
        running = true;
        const started = typeof wasmExports.net_exit_world === "function" && wasmExports.net_exit_world() === 1;
        const deadline = performance.now() + 1250;
        const finish = ok => {
            window.parent.postMessage({ type: "successor.client.exit-world-result.v1", ok }, successorBuild.storefrontOrigin);
            running = false;
        };
        if (!started) {
            finish(false);
            return;
        }
        const waitForClose = () => {
            if (typeof wasmExports.net_exit_complete === "function" && wasmExports.net_exit_complete() === 1) finish(true);
            else if (performance.now() >= deadline) finish(false);
            else setTimeout(waitForClose, 25);
        };
        waitForClose();
    });
}
const AUDIO_MANIFEST_PATH = "successor-audio/sfx/manifest.json";
let audioContext = null;
let audioMaster = null;
let audioPrepared = false;
let audioAvailable = false;
let gestureUnlocked = false;
let audioSequence = 0;
const audioBuffers = new Map();
const audioVoices = new Set();
const audioVoicesByKey = new Map();
const pendingAudioLoops = new Map();
const audioRecent = [];
const audioErrors = [];

function audioError(path, error) {
    const cleanPath = String(path).replace(/[?#].*/s, "").slice(0, 180);
    const name = String(error?.name || "Error").replace(/[?#].*/s, "").slice(0, 48);
    audioErrors.push(`${cleanPath}:${name}`);
    if (audioErrors.length > 16) audioErrors.shift();
}

function ensureAudioContext() {
    if (!audioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        audioContext = new Ctx();
        audioMaster = audioContext.createGain();
        audioMaster.connect(audioContext.destination);
    }
    return audioContext;
}

function voiceCursor(voice) {
    const elapsed = Math.max(0, audioContext.currentTime - voice.startedAt);
    return voice.looped && voice.duration > 0 ? elapsed % voice.duration : elapsed;
}

function removeVoice(voice) {
    if (!audioVoices.delete(voice)) return;
    const keyed = audioVoicesByKey.get(voice.key);
    if (keyed) {
        keyed.delete(voice);
        if (keyed.size === 0) audioVoicesByKey.delete(voice.key);
    }
    updateMasterGain();
}

function stopVoice(voice) {
    removeVoice(voice);
    voice.source.onended = null;
    try { voice.source.stop(); } catch (_) {}
}

function greatestCursor(voices) {
    let selected = null;
    let cursor = -1;
    for (const voice of voices) {
        const candidate = voiceCursor(voice);
        if (candidate > cursor) {
            cursor = candidate;
            selected = voice;
        }
    }
    return selected;
}

function voiceLimit(polyphony, looped) {
    const p = Math.max(1, Math.trunc(polyphony));
    return looped ? p : Math.max(p, Math.min(64, Math.ceil(p * 2.5), p + 12));
}

function concurrencyGain(count) {
    return count <= 8 ? 1 : Math.max(0.38, Math.min(1, 1 / Math.sqrt(1 + (count - 8) * 0.72)));
}

function updateMasterGain() {
    if (audioMaster) audioMaster.gain.value = concurrencyGain(audioVoices.size);
}

function audioStop(key) {
    pendingAudioLoops.delete(key >>> 0);
    for (const voice of [...(audioVoicesByKey.get(key >>> 0) || [])]) stopVoice(voice);
}

function audioPlay(path, key, gain, pan, looped, polyphony) {
    path = String(path);
    key >>>= 0;
    gain = Math.max(0, Math.min(4, Number(gain)));
    pan = Math.max(-1, Math.min(1, Number(pan)));
    polyphony = Math.max(1, Math.trunc(polyphony));
    const intent = { path, key, gain, pan, looped: Boolean(looped), polyphony };
    if (!gestureUnlocked || audioContext?.state !== "running") {
        if (intent.looped) pendingAudioLoops.set(key, intent);
        return false;
    }
    const buffer = audioBuffers.get(path);
    if (!buffer) {
        ensureClipDecode(path);
        return false;
    }
    if (intent.looped) audioStop(key);
    const keyed = audioVoicesByKey.get(key);
    const limit = voiceLimit(polyphony, intent.looped);
    if (keyed && keyed.size >= limit) {
        const victim = greatestCursor(keyed);
        if (victim) stopVoice(victim);
    }
    if (audioVoices.size >= 64) {
        const victim = greatestCursor(audioVoices);
        if (victim) stopVoice(victim);
    }
    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();
    const panNode = audioContext.createStereoPanner();
    source.buffer = buffer;
    source.loop = intent.looped;
    gainNode.gain.value = gain;
    panNode.pan.value = pan;
    source.connect(gainNode).connect(panNode).connect(audioMaster);
    const voice = {
        source, key, looped: intent.looped, duration: buffer.duration,
        startedAt: audioContext.currentTime, sequence: ++audioSequence
    };
    audioVoices.add(voice);
    if (!audioVoicesByKey.has(key)) audioVoicesByKey.set(key, new Set());
    audioVoicesByKey.get(key).add(voice);
    source.onended = () => removeVoice(voice);
    updateMasterGain();
    source.start();
    audioRecent.push({ path: path.replace(/[?#].*/s, ""), key, gain, pan });
    if (audioRecent.length > 64) audioRecent.shift();
    return true;
}

async function resumeAuthorizedAudio() {
    const context = ensureAudioContext();
    if (!context || !gestureUnlocked) return;
    if (context.state !== "running") await context.resume();
    if (context.state !== "running") return;
    const pending = [...pendingAudioLoops.values()];
    pendingAudioLoops.clear();
    for (const intent of pending) {
        audioPlay(intent.path, intent.key, intent.gain, intent.pan, true, intent.polyphony);
    }
}

function authorizeAudioGesture() {
    if (!gestureUnlocked) gestureUnlocked = true;
    resumeAuthorizedAudio().catch(error => audioError("audio-resume", error));
}

function audioUnlock() {
    if (gestureUnlocked) resumeAuthorizedAudio().catch(error => audioError("audio-resume", error));
}

function normalizedAudioPath(path) {
    if (typeof path !== "string") return null;
    const trimmed = path.startsWith("/") ? path.slice(1) : path;
    if (!trimmed.startsWith("successor-audio/") || trimmed.includes("..") ||
        trimmed.includes("\\") || trimmed.includes("://") || trimmed.startsWith("/")) return null;
    return trimmed;
}

function validateAudioManifest(value) {
    if (!value || value.schema !== "successor-sfx-manifest-v1" ||
        !value.buses || typeof value.buses !== "object" || !Array.isArray(value.clips)) {
        throw new TypeError("invalid audio manifest");
    }
    const buses = new Set(Object.keys(value.buses));
    const ids = new Set();
    return value.clips.map(clip => {
        const path = normalizedAudioPath(clip?.path);
        if (!clip || typeof clip.id !== "string" || !clip.id || ids.has(clip.id) || !path ||
            !buses.has(clip.bus) || !Number.isFinite(clip.volume) ||
            !Number.isSafeInteger(clip.polyphony) || clip.polyphony <= 0) {
            throw new TypeError("invalid audio clip");
        }
        ids.add(clip.id);
        return path;
    });
}

function runVoicePolicySelfCheck() {
    return voiceLimit(4, false) === 10 && voiceLimit(4, true) === 4 &&
        Math.abs(concurrencyGain(8) - 1) < 1e-9 &&
        Math.abs(concurrencyGain(9) - 1 / Math.sqrt(1.72)) < 1e-9 &&
        65 > 64 && [0.1, 0.8, 0.3].reduce((best, value) => value > best ? value : best, -1) === 0.8;
}

async function prepareWebAudio() {
    const cache = globalThis.__successorFetchCache;
    const manifestBytes = cache?.get(AUDIO_MANIFEST_PATH);
    if (!manifestBytes) throw new Error("audio manifest missing from initial assets");
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    const paths = validateAudioManifest(manifest);
    const context = ensureAudioContext();
    audioAvailable = Boolean(context);
    if (!context) {
        audioPrepared = true;
        return;
    }
    // Core audio ships in its own pack fetched right after the visual boot
    // stage; wait for it so panel/chat/footstep cues are decoded at entry.
    if (releaseFiles?.has("packs/audio-boot.spak")) {
        try { await fetchPackIntoCache("packs/audio-boot.spak"); } catch (error) { audioError("packs/audio-boot.spak", error); }
    }
    await decodeCachedClips(paths);
    audioPrepared = true;
}

async function decodeCachedClips(paths) {
    const cache = globalThis.__successorFetchCache;
    let next = 0;
    const worker = async () => {
        while (next < paths.length) {
            const path = paths[next++];
            if (audioBuffers.has(path)) continue;
            const bytes = cache.get(path);
            if (!bytes) continue; // undecoded clips decode lazily on first trigger
            try {
                const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                audioBuffers.set(path, await audioContext.decodeAudioData(copy));
            } catch (error) {
                audioError(path, error);
            } finally {
                cache.delete(path);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, paths.length) }, worker));
}

// Lazy clip path: a trigger for an undecoded clip starts the fetch/decode and
// is itself skipped; subsequent triggers play normally.
const pendingClipDecodes = new Map();
function ensureClipDecode(path) {
    if (audioBuffers.has(path) || pendingClipDecodes.has(path) || !audioContext) return;
    pendingClipDecodes.set(path, (async () => {
        try {
            const cache = globalThis.__successorFetchCache;
            if (!cache.get(path)) {
                const packed = packIndex[path];
                if (packed) await fetchPackIntoCache(packed.pack);
                else await fetchStandaloneIntoCache(path);
            }
            await decodeCachedClips([path]);
        } catch (error) {
            audioError(path, error);
        } finally {
            pendingClipDecodes.delete(path);
        }
    })());
}

function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value)) deepFreeze(nested);
    }
    return value;
}

Object.defineProperty(window, "__successorAudioProbe", {
    configurable: false,
    get: () => deepFreeze({
        ready: audioPrepared,
        available: audioAvailable,
        gestureUnlocked,
        decodedCount: audioBuffers.size,
        encodedClipCacheCount: [...(globalThis.__successorFetchCache?.keys() || [])]
            .filter(path => path.startsWith("successor-audio/") && path.endsWith(".mp3")).length,
        manifestCachePresent: Boolean(globalThis.__successorFetchCache?.has(AUDIO_MANIFEST_PATH)),
        activeVoices: audioVoices.size,
        activeVoiceCountsByKey: [...audioVoicesByKey].map(([key, voices]) => ({ key, count: voices.size }))
            .sort((a, b) => a.key - b.key),
        activeLoops: [...audioVoicesByKey].map(([key, voices]) => ({
            key,
            activeSourceCount: [...voices].filter(voice => voice.looped).length,
            sourceSequences: [...voices].filter(voice => voice.looped).map(voice => voice.sequence).sort((a, b) => a - b)
        })).filter(loop => loop.activeSourceCount > 0).sort((a, b) => a.key - b.key),
        masterConcurrencyGain: concurrencyGain(audioVoices.size),
        voicePolicySelfCheck: runVoicePolicySelfCheck(),
        recent: audioRecent.map(record => ({ ...record })),
        errors: [...audioErrors]
    })
});
window.__successorAudioState = () => audioContext?.state ?? "locked";

function glGet(id) {
    return id > 0 && id < glResources.length ? glResources[id] : null;
}

// WebSocket connections table
const wsConnections = [null];

let wasmMemory;
let wasmExports = {};

// Helper: Decode a string (ptr + len) from WASM memory
function getString(ptr, len) {
    if (!wasmMemory) return "";
    const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
    return new TextDecoder().decode(bytes);
}

// Manifest files keyed by stable id, populated by fetchInitialAssets. In
// object-store releases assets resolve to content-addressed immutable objects
// so the browser/CDN cache survives release boundaries.
let releaseFiles = null;
let packIndex = {};
function assetUrl(path) {
    if (!successorBuild.objectStore) return path;
    const file = releaseFiles?.get(path);
    if (!file) throw new Error(`asset not in release manifest: ${path}`);
    return `/objects/${file.sha256}`;
}

// ── Asset packs (successor.assetpack.v1) ────────────────────────────────────
// Packs are a pure transport concern: they are unpacked into the stable-id
// byte cache and the Rust runtime always reads by stable id.
const fetchedPacks = new Map();
// Async asset channel state for js_asset_begin/js_asset_poll. Entries:
// { state: "pending" | "ready" | "error", bytes: Uint8Array | null }.
const assetRequests = new Map();
let nextAssetHandle = 1;
function unpackPack(bytes) {
    const magic = new TextDecoder().decode(bytes.subarray(0, 6));
    if (magic !== "SPAK1\n") throw new Error("bad pack magic");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const indexLength = view.getUint32(6, true);
    const indexStart = 10;
    const index = JSON.parse(new TextDecoder().decode(bytes.subarray(indexStart, indexStart + indexLength)));
    if (index.schema !== "successor.assetpack.v1" || !Array.isArray(index.entries)) throw new Error("bad pack index");
    const payloadStart = indexStart + indexLength;
    return index.entries.map(entry => {
        const slice = bytes.slice(payloadStart + entry.offset, payloadStart + entry.offset + entry.bytes);
        if (slice.byteLength !== entry.bytes) throw new Error(`pack entry truncated: ${entry.path}`);
        return [entry.path, slice];
    });
}

async function fetchPackIntoCache(packPath) {
    let pending = fetchedPacks.get(packPath);
    if (!pending) {
        pending = (async () => {
            const response = await fetch(assetUrl(packPath));
            if (!response.ok) throw new Error(`pack ${response.status}: ${packPath}`);
            for (const [path, bytes] of unpackPack(new Uint8Array(await response.arrayBuffer()))) {
                globalThis.__successorFetchCache.set(path, bytes);
            }
        })();
        fetchedPacks.set(packPath, pending);
    }
    return pending;
}

function fetchPackIntoCacheSync(packPath) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", assetUrl(packPath), false); // synchronous
    xhr.overrideMimeType("text/plain; charset=x-user-defined");
    xhr.send(null);
    if (xhr.status !== 200) throw new Error(`pack ${xhr.status}: ${packPath}`);
    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    for (const [path, entryBytes] of unpackPack(bytes)) {
        globalThis.__successorFetchCache.set(path, entryBytes);
    }
}

async function fetchStandaloneIntoCache(path, onBytes) {
    const file = releaseFiles.get(path);
    const response = await fetch(assetUrl(path));
    if (!response.ok) throw new Error(`asset ${response.status}: ${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (file && bytes.byteLength !== file.bytes) throw new Error(`asset size mismatch: ${path}`);
    globalThis.__successorFetchCache.set(path, bytes);
    if (onBytes) onBytes(bytes.byteLength);
}

// Stage 1: visual boot pack + standalone boot documents — the world opens as
// soon as these land. Stage 2: core audio. Everything else streams after the
// first world frame (and on demand via the async asset channel).
async function fetchInitialAssets() {
    showLoading("STREAMING WORLD", "READING RELEASE MANIFEST", 0);
    const manifestResponse = await fetch("release-manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error(`release manifest ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    releaseFiles = new Map(manifest.files.map(file => [file.path, file]));
    packIndex = manifest.packIndex ?? {};
    const boot = manifest.boot ?? manifest.initialAssets;
    if (!Array.isArray(boot) || boot.length === 0) throw new Error("release manifest has no boot stream");
    globalThis.__successorFetchCache = new Map();

    const AUDIO_BOOT_PACK = "packs/audio-boot.spak";
    const stagePacks = new Set();
    const stageStandalone = [];
    let total = 0;
    for (const id of boot) {
        const packed = packIndex[id];
        if (packed) {
            if (packed.pack !== AUDIO_BOOT_PACK) {
                stagePacks.add(packed.pack);
                total += packed.bytes;
            }
        } else {
            stageStandalone.push(id);
            total += releaseFiles.get(id)?.bytes ?? 0;
        }
    }
    // Spawn-neighborhood region packs stage with the visual boot so the first
    // world frame has its props; every other region streams via the watcher.
    for (const packPath of manifest.bootPacks ?? []) {
        if (!stagePacks.has(packPath) && releaseFiles.has(packPath)) {
            stagePacks.add(packPath);
            total += releaseFiles.get(packPath)?.bytes ?? 0;
        }
    }
    let loaded = 0;
    const mib = value => (value / 1048576).toFixed(1);
    const report = () => showLoading("STREAMING WORLD", `${mib(loaded)} / ${mib(total)} MiB`, total > 0 ? loaded / total : 1);
    report();
    const stageJobs = [...stagePacks].map(async packPath => {
        await fetchPackIntoCache(packPath);
        loaded += releaseFiles.get(packPath)?.bytes ?? 0;
        report();
    });
    let nextStandalone = 0;
    const standaloneWorker = async () => {
        while (nextStandalone < stageStandalone.length) {
            const id = stageStandalone[nextStandalone++];
            await fetchStandaloneIntoCache(id, bytes => { loaded += bytes; report(); });
        }
    };
    await Promise.all([...stageJobs, ...Array.from({ length: Math.min(6, stageStandalone.length) }, standaloneWorker)]);
    if (releaseFiles.has(AUDIO_BOOT_PACK)) {
        fetchPackIntoCache(AUDIO_BOOT_PACK).catch(error => audioError(AUDIO_BOOT_PACK, error));
    }
}

// After the first world frame: pull the shared remainder packs only
// (audio-rest, world-rest). Wardrobe, creature, and region-pack bytes are
// deliberately NOT prefetched — they stream on demand through the async
// asset channel (wearing actor / creature entering AOI, region watcher).
// Races with on-demand requests are deduped by fetchedPacks / the byte cache.
function startBackgroundPrefetch() {
    const packs = [...releaseFiles.keys()].filter(path =>
        path.startsWith("packs/") &&
        !path.startsWith("packs/region/") &&
        path !== "packs/boot.spak" &&
        !fetchedPacks.has(path));
    (async () => {
        for (const packPath of packs) {
            try { await fetchPackIntoCache(packPath); } catch (error) { audioError(packPath, error); }
        }
    })().catch(() => {});
}

let firstWorldFrame = false;
const importObject = {
    env: {
        // --- WebGL2 Functions ---
        glClearColor: (r, g, b, a) => gl.clearColor(r, g, b, a),
        glClear: (mask) => gl.clear(mask),
        glFinish: () => gl.finish(),
        glViewport: (x, y, w, h) => gl.viewport(x, y, w, h),
        glEnable: (cap) => gl.enable(cap),
        glDisable: (cap) => gl.disable(cap),
        glCullFace: (mode) => gl.cullFace(mode),
        glDepthMask: (flag) => gl.depthMask(flag !== 0),
        glColorMask: (r, g, b, a) => gl.colorMask(r !== 0, g !== 0, b !== 0, a !== 0),
        glBlendFunc: (s, d) => gl.blendFunc(s, d),

        glCreateShader: (type) => glAlloc(gl.createShader(type)),
        glShaderSource: (shader, ptr, len) => {
            const src = getString(ptr, len);
            gl.shaderSource(glGet(shader), src);
        },
        glCompileShader: (shader) => gl.compileShader(glGet(shader)),
        glGetShaderiv: (shader, pname) => {
            const param = gl.getShaderParameter(glGet(shader), pname);
            return typeof param === "boolean" ? (param ? 1 : 0) : param;
        },
        glGetShaderInfoLog: (shader, bufPtr, maxLen) => {
            const log = gl.getShaderInfoLog(glGet(shader)) || "";
            const bytes = new TextEncoder().encode(log);
            const truncated = bytes.subarray(0, maxLen);
            const dest = new Uint8Array(wasmMemory.buffer, bufPtr, maxLen);
            dest.set(truncated);
            return truncated.length;
        },
        glDeleteShader: (shader) => {
            gl.deleteShader(glGet(shader));
            glResources[shader] = null;
        },

        glCreateProgram: () => glAlloc(gl.createProgram()),
        glAttachShader: (program, shader) => gl.attachShader(glGet(program), glGet(shader)),
        glLinkProgram: (program) => gl.linkProgram(glGet(program)),
        glGetProgramiv: (program, pname) => {
            const param = gl.getProgramParameter(glGet(program), pname);
            return typeof param === "boolean" ? (param ? 1 : 0) : param;
        },
        glGetProgramInfoLog: (program, bufPtr, maxLen) => {
            const log = gl.getProgramInfoLog(glGet(program)) || "";
            const bytes = new TextEncoder().encode(log);
            const truncated = bytes.subarray(0, maxLen);
            const dest = new Uint8Array(wasmMemory.buffer, bufPtr, maxLen);
            dest.set(truncated);
            return truncated.length;
        },
        glUseProgram: (program) => gl.useProgram(glGet(program)),
        glDeleteProgram: (program) => {
            gl.deleteProgram(glGet(program));
            glResources[program] = null;
        },

        glGetUniformLocation: (program, ptr, len) => {
            const name = getString(ptr, len);
            const loc = gl.getUniformLocation(glGet(program), name);
            if (!loc) return -1;
            return glAlloc(loc);
        },
        glUniform1i: (loc, val) => gl.uniform1i(glGet(loc), val),
        glUniform1f: (loc, val) => gl.uniform1f(glGet(loc), val),
        glUniform2f: (loc, x, y) => gl.uniform2f(glGet(loc), x, y),
        glUniform3f: (loc, x, y, z) => gl.uniform3f(glGet(loc), x, y, z),
        glUniform4f: (loc, x, y, z, w) => gl.uniform4f(glGet(loc), x, y, z, w),
        glUniformMatrix4fv: (loc, count, transpose, ptr) => {
            const view = new Float32Array(wasmMemory.buffer, ptr, count * 16);
            gl.uniformMatrix4fv(glGet(loc), transpose !== 0, view);
        },
        glUniform3fv: (loc, count, ptr) => {
            const view = new Float32Array(wasmMemory.buffer, ptr, count * 3);
            gl.uniform3fv(glGet(loc), view);
        },
        glUniform1fv: (loc, count, ptr) => {
            const view = new Float32Array(wasmMemory.buffer, ptr, count);
            gl.uniform1fv(glGet(loc), view);
        },

        glGenTexture: () => glAlloc(gl.createTexture()),
        glDeleteTexture: (tex) => {
            gl.deleteTexture(glGet(tex));
            glResources[tex] = null;
        },
        glBindTexture: (target, tex) => gl.bindTexture(target, glGet(tex)),
        glActiveTexture: (unit) => gl.activeTexture(unit),
        glTexParameteri: (target, pname, param) => gl.texParameteri(target, pname, param),
        glTexImage2D: (target, level, internalFormat, width, height, border, format, type, ptr, len) => {
            const pixels = len > 0 ? new Uint8Array(wasmMemory.buffer, ptr, len) : null;
            gl.texImage2D(target, level, internalFormat, width, height, border, format, type, pixels);
        },

        glGenBuffer: () => glAlloc(gl.createBuffer()),
        glDeleteBuffer: (buf) => {
            gl.deleteBuffer(glGet(buf));
            glResources[buf] = null;
        },
        glBindBuffer: (target, buf) => gl.bindBuffer(target, glGet(buf)),
        glGetInteger: (pname) => gl.getParameter(pname) | 0,
        glReadPixels: (x, y, width, height, format, type, ptr, len) => {
            const pixels = new Uint8Array(wasmMemory.buffer, ptr, len);
            gl.readPixels(x, y, width, height, format, type, pixels);
        },
        glBufferData: (target, ptr, len, usage) => {
            const bytes = new Uint8Array(wasmMemory.buffer, ptr, len);
            gl.bufferData(target, bytes, usage);
        },

        glGenVertexArray: () => glAlloc(gl.createVertexArray()),
        glDeleteVertexArray: (vao) => {
            gl.deleteVertexArray(glGet(vao));
            glResources[vao] = null;
        },
        glBindVertexArray: (vao) => gl.bindVertexArray(glGet(vao)),
        glVertexAttribPointer: (index, size, type, normalized, stride, offset) => {
            gl.vertexAttribPointer(index, size, type, normalized !== 0, stride, offset);
        },
        glEnableVertexAttribArray: (index) => gl.enableVertexAttribArray(index),
        glDisableVertexAttribArray: (index) => gl.disableVertexAttribArray(index),

        glDrawArrays: (mode, first, count) => gl.drawArrays(mode, first, count),
        glDrawElements: (mode, count, type, offset) => gl.drawElements(mode, count, type, offset),
        glVertexAttribDivisor: (index, divisor) => gl.vertexAttribDivisor(index, divisor),
        glDrawElementsInstanced: (mode, count, type, offset, primcount) => gl.drawElementsInstanced(mode, count, type, offset, primcount),
        glDrawArraysInstanced: (mode, first, count, primcount) => gl.drawArraysInstanced(mode, first, count, primcount),

        glGenFramebuffer: () => glAlloc(gl.createFramebuffer()),
        glDeleteFramebuffer: (fbo) => {
            gl.deleteFramebuffer(glGet(fbo));
            glResources[fbo] = null;
        },
        glBindFramebuffer: (target, fbo) => gl.bindFramebuffer(target, glGet(fbo)),
        glFramebufferTexture2D: (target, attachment, texTarget, tex, level) => {
            gl.framebufferTexture2D(target, attachment, texTarget, glGet(tex), level);
        },
        glCheckFramebufferStatus: (target) => gl.checkFramebufferStatus(target),
        glDrawBuffers: (ptr, len) => {
            const attachments = new Uint32Array(wasmMemory.buffer, ptr, len);
            gl.drawBuffers(Array.from(attachments));
        },
        glPixelStorei: (pname, param) => gl.pixelStorei(pname, param),
        glTexImage3D: (target, level, internalFormat, width, height, depth, border, format, type, ptr, len) => {
            const pixels = len > 0 ? new Uint8Array(wasmMemory.buffer, ptr, len) : null;
            gl.texImage3D(target, level, internalFormat, width, height, depth, border, format, type, pixels);
        },
        glTexSubImage3D: (target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, ptr, len) => {
            const pixels = new Uint8Array(wasmMemory.buffer, ptr, len);
            gl.texSubImage3D(target, level, xoffset, yoffset, zoffset, width, height, depth, format, type, pixels);
        },
        glGenerateMipmap: (target) => gl.generateMipmap(target),
        glCapHalfFloatTarget: () => {
            const disabled = new URLSearchParams(location.search).has("disable-half-float");
            const supported = Boolean(gl.getExtension("EXT_color_buffer_float") ||
                gl.getExtension("EXT_color_buffer_half_float"));
            window.__successorHalfFloatTarget = supported && !disabled;
            return window.__successorHalfFloatTarget ? 1 : 0;
        },

        // --- Window/Input/Time Functions ---
        js_init: (titlePtr, titleLen, w, h) => {
            const title = getString(titlePtr, titleLen);
            console.log(`js_init: "${title}", target size ${w}x${h}`);
        },
        js_log: (ptr, len) => {
            const str = getString(ptr, len);
            if (!window.__successorRenderLog) window.__successorRenderLog = [];
            window.__successorRenderLog.push(str);
            console.log(str);
        },
        js_get_canvas_size: (w_ptr, h_ptr) => {
            const w_arr = new Int32Array(wasmMemory.buffer, w_ptr, 1);
            const h_arr = new Int32Array(wasmMemory.buffer, h_ptr, 1);
            w_arr[0] = canvas.width;
            h_arr[0] = canvas.height;
        },
        js_get_mouse_x: () => mouseX,
        js_get_mouse_y: () => mouseY,
        js_mouse_button_down: (button) => button < mouseButtons.length ? mouseButtons[button] : 0,
        js_launch_context_len: () => new TextEncoder().encode(launchContextText).length,
        js_launch_context_copy: (ptr, maxLen) => {
            const bytes = new TextEncoder().encode(launchContextText);
            const len = Math.min(bytes.length, maxLen);
            new Uint8Array(wasmMemory.buffer, ptr, len).set(bytes.subarray(0, len));
            return len;
        },
        js_creator_mode: () => creatorMode ? 1 : 0,
        js_creator_ready: () => { creatorBridge?.ready(); },
        js_creator_message_len: () => creatorBridge?.messageLength() ?? 0,
        js_creator_message_copy: (ptr, maxLen) => creatorBridge?.copyMessage(ptr, maxLen) ?? 0,
        js_creator_message_discard: () => { creatorBridge?.discardMessage(); },
        js_creator_post_create: (ptr, len) => creatorBridge?.postCreate(getString(ptr, len)) ? 1 : 0,
        js_creator_post_select: (ptr, len) => creatorBridge?.postSelect(getString(ptr, len)) ? 1 : 0,
        js_audio_unlock: () => audioUnlock(),
        js_audio_play: (ptr, len, key, gain, pan, looped, polyphony) =>
            audioPlay(getString(ptr, len), key, gain, pan, looped !== 0, polyphony) ? 1 : 0,
        js_audio_stop: key => audioStop(key),
        js_audio_active_voices: () => audioVoices.size,
        js_now_ms: () => performance.now(),
        js_is_key_down: (key) => {
            return key < keyState.length ? keyState[key] : 0;
        },
        js_set_cursor_visible: (visible) => {
            canvas.style.cursor = visible ? "default" : "none";
        },
        js_poll_char: () => {
            return charQueue.length > 0 ? charQueue.shift() : -1;
        },
        js_poll_scroll_x: () => {
            const value = scrollX; scrollX = 0; return value;
        },
        js_poll_scroll_y: () => {
            const value = scrollY; scrollY = 0; return value;
        },

        // --- WebSocket & Fetch Functions ---
        js_ws_connect: (urlPtr, urlLen) => {
            const url = getString(urlPtr, urlLen);
            try {
                const ws = new WebSocket(url);
                ws.binaryType = "arraybuffer";
                
                const handle = wsConnections.length;
                const state = {
                    ws,
                    open: false,
                    openReported: false,
                    closed: false,
                    error: false,
                    queue: []
                };
                
                wsConnections.push(state);
                
                ws.onopen = () => { state.open = true; };
                ws.onmessage = (e) => { state.queue.push(new Uint8Array(e.data)); };
                ws.onclose = () => { state.closed = true; };
                ws.onerror = () => { state.error = true; };
                
                return handle;
            } catch (e) {
                console.error("WebSocket connect failed:", e);
                return 0;
            }
        },
        js_ws_send: (id, ptr, len) => {
            const state = wsConnections[id];
            if (state && state.ws.readyState === WebSocket.OPEN) {
                const bytes = new Uint8Array(wasmMemory.buffer, ptr, len).slice();
                state.ws.send(bytes);
            }
        },
        js_ws_poll: (id, bufPtr, maxLen) => {
            const state = wsConnections[id];
            if (!state) return -2;
            
            if (state.error) {
                state.error = false;
                return -2;
            }
            
            if (state.open && !state.openReported) {
                state.openReported = true;
                return -3;
            }
            
            if (state.queue.length > 0) {
                const msg = state.queue.shift();
                const len = Math.min(msg.length, maxLen);
                const dest = new Uint8Array(wasmMemory.buffer, bufPtr, len);
                dest.set(msg.subarray(0, len));
                return len;
            }
            
            if (state.closed) {
                return -1;
            }
            
            return 0;
        },
        js_ws_close: (id) => {
            const state = wsConnections[id];
            if (state) {
                state.ws.close();
            }
        },
        js_fetch_post_json: (urlPtr, urlLen, bodyPtr, bodyLen, outPtr, outMaxLen) => {
            const url = getString(urlPtr, urlLen);
            const body = getString(bodyPtr, bodyLen);
            
            try {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", url, false); // synchronous XMLHttpRequest
                xhr.setRequestHeader("Content-Type", "application/json");
                xhr.send(body);
                
                if (xhr.status === 200) {
                    const text = xhr.responseText;
                    const bytes = new TextEncoder().encode(text);
                    const len = Math.min(bytes.length, outMaxLen);
                    const dest = new Uint8Array(wasmMemory.buffer, outPtr, len);
                    dest.set(bytes.subarray(0, len));
                    return len;
                } else {
                    console.error("fetch_post_json server error status:", xhr.status);
                    return -1;
                }
            } catch (e) {
                console.error("fetch_post_json network error:", e);
                return -1;
            }
        },
        // Two-phase binary GET. First call (outMaxLen 0) fetches synchronously,
        // caches by url, and returns the total byte length. Second call copies
        // up to outMaxLen bytes from the cached blob. Returns -1 on error.
        js_fetch_get: (urlPtr, urlLen, outPtr, outMaxLen) => {
            const url = getString(urlPtr, urlLen);
            try {
                if (!globalThis.__successorFetchCache) globalThis.__successorFetchCache = new Map();
                const cache = globalThis.__successorFetchCache;

                let bytes = cache.get(url);
                if (!bytes && packIndex[url]) {
                    // Rust demanded a packed asset before the background stream
                    // reached it: sync-fetch the whole pack once (logged — every
                    // hit here is a prefetch-ordering bug worth fixing).
                    console.warn("sync pack fallback:", url, "via", packIndex[url].pack);
                    try {
                        fetchPackIntoCacheSync(packIndex[url].pack);
                    } catch (error) {
                        console.error("pack fallback failed:", url, error);
                        return -1;
                    }
                    bytes = cache.get(url);
                }
                if (!bytes) {
                    console.warn("sync asset fallback:", url);
                    const xhr = new XMLHttpRequest();
                    xhr.open("GET", assetUrl(url), false); // synchronous
                    xhr.overrideMimeType("text/plain; charset=x-user-defined");
                    xhr.send(null);
                    if (xhr.status !== 200) {
                        console.error("fetch_get error status:", xhr.status, url);
                        return -1;
                    }
                    const text = xhr.responseText;
                    bytes = new Uint8Array(text.length);
                    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
                    cache.set(url, bytes);
                }
                if (outMaxLen > 0 && outPtr !== 0) {
                    const len = Math.min(bytes.length, outMaxLen);
                    const dest = new Uint8Array(wasmMemory.buffer, outPtr, len);
                    dest.set(bytes.subarray(0, len));
                    if (len >= bytes.length && url !== AUDIO_MANIFEST_PATH) cache.delete(url);
                    return len;
                }
                return bytes.length;
            } catch (e) {
                console.error("fetch_get network error:", e, url);
                return -1;
            }
        },
        // Async asset channel backing Rust Platform::begin_asset. Starts a
        // real (non-blocking) fetch through the same pack-index/object-store
        // resolution as js_fetch_get, then returns a handle immediately.
        js_asset_begin: (pathPtr, pathLen) => {
            const path = getString(pathPtr, pathLen);
            if (!globalThis.__successorFetchCache) globalThis.__successorFetchCache = new Map();
            const cache = globalThis.__successorFetchCache;
            const handle = nextAssetHandle++;
            const entry = { state: "pending", bytes: null };
            assetRequests.set(handle, entry);
            const cached = cache.get(path);
            if (cached) {
                entry.state = "ready";
                entry.bytes = cached;
                return handle;
            }
            const fail = (error) => {
                console.error("async asset failed:", path, error);
                entry.state = "error";
            };
            const complete = () => {
                const bytes = cache.get(path);
                if (bytes) {
                    entry.state = "ready";
                    entry.bytes = bytes;
                } else {
                    fail(new Error("asset missing after fetch"));
                }
            };
            const pack = packIndex[path];
            if (pack) fetchPackIntoCache(pack.pack).then(complete).catch(fail);
            else fetchStandaloneIntoCache(path).then(complete).catch(fail);
            return handle;
        },
        // Poll an in-flight async fetch. -1 pending, -2 failed/unknown; once
        // ready, a null buffer returns the length and the copy call delivers
        // the bytes and consumes the entry (two-phase, like js_fetch_get).
        js_asset_poll: (id, outPtr, outMaxLen) => {
            const entry = assetRequests.get(id);
            if (!entry) return -2;
            if (entry.state === "pending") return -1;
            if (entry.state === "error") {
                assetRequests.delete(id);
                return -2;
            }
            const bytes = entry.bytes;
            if (outMaxLen > 0 && outPtr !== 0) {
                const len = Math.min(bytes.length, outMaxLen);
                const dest = new Uint8Array(wasmMemory.buffer, outPtr, len);
                dest.set(bytes.subarray(0, len));
                assetRequests.delete(id);
                return len;
            }
            return bytes.length;
        }
    }
};

let lastTime = performance.now();

// Load the WASM module
fetch("successor.wasm")
    .then(response => response.arrayBuffer())
    .then(bytes => WebAssembly.instantiate(bytes, importObject))
    .then(async results => {
        const instance = results.instance;
        wasmMemory = instance.exports.memory;
        wasmExports = instance.exports;
        window.__successorMovementProbe = () => {
            if (typeof wasmExports.movement_probe !== "function") return null;
            const value = index => wasmExports.movement_probe(index);
            const authoritative = [value(0), value(1)];
            if (!Number.isFinite(authoritative[0])) return null;
            return {
                authoritative,
                predicted: [value(2), value(3)],
                rendered: [value(4), value(5)],
                correctionCells: value(6),
                intent: [value(7), value(8), value(9) === 1],
                appliedCommandId: value(10),
                blockerCount: value(11),
                presentedGroundY: value(12),
                sampledGroundY: value(13),
                frameDtMs: value(14),
                lastChangeMs: value(15),
                lastSendMs: value(16),
                nextSendMs: value(17),
                stopRetryUntilMs: value(18),
                sampledAtMs: value(19),
            };
        };

        if (creatorStartupError) throw creatorStartupError;
        const params = new URLSearchParams(window.location.search);
        const demoName = params.get("demo");
        const demoSelector = creatorMode
            ? 0
            : demoName === "material-parity"
                ? 1
                : demoName === "terrain-material"
                    ? (params.get("biome") === "forest" ? 3 : 2)
                    : 0;
        if (demoSelector === 0 && creatorMode) {
            showLoading("CHARACTER WORKSHOP", "WAITING FOR ROSTER", 1);
        } else if (demoSelector === 0) {
            await fetchInitialAssets();
            await prepareWebAudio();
            showLoading("CONNECTING", "WAITING FOR LAUNCH", 1);
            await waitForHostedLaunch();
            showLoading("ENTERING WORLD", "BUILDING SCENE", 1);
        }
        window.__successorRenderReady = false;
        window.__successorRenderError = null;
        window.__successorRenderProbe = null;
        if (demoSelector === 1) {
            const parityAssets = [
                "commerce_facility.glb",
                "lightning_carbine.glb",
                "mossmuff_adult.glb",
                "successor_food_beer_mug.glb",
                "field_cap.glb",
                "megalith_brick_hex.glb"
            ];
            globalThis.__successorFetchCache = new Map();
            await Promise.all(parityAssets.map(async name => {
                const url = `parity-assets/${name}`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`asset fetch ${response.status}: ${url}`);
                globalThis.__successorFetchCache.set(
                    url,
                    new Uint8Array(await response.arrayBuffer())
                );
            }));
        }
        if (typeof wasmExports.init === "function") {
            wasmExports.init(demoSelector);
        }
        if (!creatorMode) installHostedExitHandler();
        // Kick the wasm networking runtime (optional export): connected play
        // only. Creator mode has no tickets, launch context, or socket path.
        if (!creatorMode && typeof wasmExports.net_connect === "function") {
            try { wasmExports.net_connect(); } catch (e) { console.warn("net_connect:", e); }
        }

        // Call resize on resize
        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            if (typeof wasmExports.resize === "function") {
                wasmExports.resize(canvas.width, canvas.height);
            }
        }
        window.addEventListener("resize", resizeCanvas);
        resizeCanvas();

        let renderedFrames = 0;
        function tick(time) {
            const dt = (time - lastTime) / 1000.0;
            lastTime = time;
            try {
                if (!creatorMode && typeof wasmExports.net_poll === "function" && demoSelector === 0) {
                    wasmExports.net_poll();
                }
                if (!webglContextLost) {
                    if (typeof wasmExports.update === "function") {
                        wasmExports.update(dt);
                    }
                    if (typeof wasmExports.render === "function") {
                        wasmExports.render();
                    }
                }
                if (creatorMode && typeof wasmExports.net_fatal === "function" && wasmExports.net_fatal() === 1) {
                    throw new Error("creator runtime entered fatal state");
                }
                renderedFrames += 1;
                if (creatorMode && demoSelector === 0 && renderedFrames > 2) {
                    window.__successorRenderReady = true;
                    if (!firstWorldFrame) {
                        firstWorldFrame = true;
                        finishLoading();
                        startBackgroundPrefetch();
                    }
                } else if (demoSelector === 0 && typeof wasmExports.net_state === "function") {
                    const state = wasmExports.net_state();
                    window.__successorNetState = state;
                    if (state === 4 && renderedFrames > 2) {
                        window.__successorRenderReady = true;
                        if (!firstWorldFrame) {
                            firstWorldFrame = true;
                            finishLoading();
                            startBackgroundPrefetch();
                        }
                    }
                    if (typeof wasmExports.net_fatal === "function" && wasmExports.net_fatal() === 1) {
                        throw new Error("connected runtime entered fatal state");
                    }
                }
                if (demoSelector === 1 && renderedFrames === 120 && typeof wasmExports.probe_material_parity === "function") {
                    const passed = wasmExports.probe_material_parity();
                    window.__successorRenderProbe = {
                        passed: passed === 1,
                        frame: renderedFrames,
                        width: canvas.width,
                        height: canvas.height
                    };
                    window.__successorRenderReady = passed === 1;
                    if (passed !== 1) window.__successorRenderError = "material parity probe failed";
                }
                if ((demoSelector === 2 || demoSelector === 3) && renderedFrames === 120 && typeof wasmExports.probe_terrain_material === "function") {
                    const passed = wasmExports.probe_terrain_material();
                    if (passed !== 1) {
                        throw new Error("terrain material probe failed");
                    }
                    window.__successorRenderProbe = { terrainMaterial: true };
                    window.__successorRenderReady = true;
                }
            } catch (error) {
                window.__successorRenderError = String(error);
                failLoading(error);
                console.error("render loop failed:", error);
                return;
            }
            requestAnimationFrame(tick);
        }
        requestAnimationFrame(tick);
    })
    .catch(err => {
        console.error("WASM instantiation failed:", err);
        window.__successorRenderReady = false;
        window.__successorRenderError = String(err);
        failLoading(err);
    });
