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
    chatOrigin: ""
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
const keyState = new Uint8Array(34);
const keyMap = {
    "KeyW": 0, "KeyA": 1, "KeyS": 2, "KeyD": 3,
    "ArrowUp": 4, "ArrowDown": 5, "ArrowLeft": 6, "ArrowRight": 7,
    "Space": 8, "Enter": 9, "Escape": 10, "Backspace": 11,
    "ShiftLeft": 12, "Backquote": 13, "KeyR": 14, "KeyF": 15,
    "KeyI": 16, "KeyC": 17, "Semicolon": 18, "KeyO": 19,
    "Tab": 20, "KeyV": 21, "KeyX": 22, "KeyN": 23,
    ...Object.fromEntries(Array.from({length: 10}, (_, i) => [`Digit${i}`, 24 + i]))
};

window.addEventListener("keydown", (e) => {
    const code = keyMap[e.code];
    if (code !== undefined) {
        keyState[code] = 1;
    }
});

window.addEventListener("keyup", (e) => {
    const code = keyMap[e.code];
    if (code !== undefined) {
        keyState[code] = 0;
    }
});

window.addEventListener("blur", () => {
    keyState.fill(0);
});

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
    // A gesture is the only legal point at which web audio may start.
    audioUnlock();
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
let audioContext = null;
function audioUnlock() {
    if (!audioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) audioContext = new Ctx();
    }
    if (audioContext && audioContext.state === "suspended") audioContext.resume();
}
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

async function fetchInitialAssets() {
    showLoading("STREAMING WORLD", "READING RELEASE MANIFEST", 0);
    const manifestResponse = await fetch("release-manifest.json", { cache: "no-store" });
    if (!manifestResponse.ok) throw new Error(`release manifest ${manifestResponse.status}`);
    const manifest = await manifestResponse.json();
    if (!Array.isArray(manifest.initialAssets)) throw new Error("release manifest has no initial asset stream");
    const files = new Map(manifest.files.map(file => [file.path, file]));
    const assets = manifest.initialAssets.map(path => {
        const file = files.get(path);
        if (!file) throw new Error(`initial asset missing from inventory: ${path}`);
        return file;
    });
    const total = assets.reduce((sum, file) => sum + file.bytes, 0);
    let loaded = 0;
    globalThis.__successorFetchCache = new Map();
    let next = 0;
    const worker = async () => {
        while (next < assets.length) {
            const file = assets[next++];
            const response = await fetch(file.path);
            if (!response.ok) throw new Error(`asset ${response.status}: ${file.path}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength !== file.bytes) throw new Error(`asset size mismatch: ${file.path}`);
            globalThis.__successorFetchCache.set(file.path, bytes);
            loaded += bytes.byteLength;
            const mib = value => (value / 1048576).toFixed(1);
            showLoading("STREAMING WORLD", `${mib(loaded)} / ${mib(total)} MiB`, total > 0 ? loaded / total : 1);
        }
    };
    await Promise.all(Array.from({ length: Math.min(6, assets.length) }, worker));
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
            const view = new Float32Array(wasmMemory.buffer, ptr, 16);
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
        js_audio_unlock: () => audioUnlock(),
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
                if (!bytes) {
                    const xhr = new XMLHttpRequest();
                    xhr.open("GET", url, false); // synchronous
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
                    if (len >= bytes.length) cache.delete(url);
                    return len;
                }
                return bytes.length;
            } catch (e) {
                console.error("fetch_get network error:", e, url);
                return -1;
            }
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

        const params = new URLSearchParams(window.location.search);
        const demoName = params.get("demo");
        const demoSelector = demoName === "material-parity"
            ? 1
            : demoName === "terrain-material"
                ? (params.get("biome") === "forest" ? 3 : 2)
                : 0;
        if (demoSelector === 0) {
            showLoading("CONNECTING", "WAITING FOR LAUNCH", 0);
            await waitForHostedLaunch();
            await fetchInitialAssets();
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
        installHostedExitHandler();
        // Kick the wasm networking runtime (optional export): connect once,
        // then poll each frame.
        if (typeof wasmExports.net_connect === "function") {
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
                if (typeof wasmExports.net_poll === "function" && demoSelector === 0) {
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
                renderedFrames += 1;
                if (demoSelector === 0 && typeof wasmExports.net_state === "function") {
                    const state = wasmExports.net_state();
                    window.__successorNetState = state;
                    if (state === 4 && renderedFrames > 2) {
                        window.__successorRenderReady = true;
                        if (!firstWorldFrame) {
                            firstWorldFrame = true;
                            finishLoading();
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
