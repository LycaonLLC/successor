// Browser play. A roster/workshop ENTER action is the one visible action that
// mints entry tickets and hands off to the browser runtime; /play/ does not
// insert a second confirmation screen in that path. A direct /play/ visit
// retains the character picker as a fallback. The runtime pointer is checked
// before any ticket is minted, so an unpublished runtime never wastes one-use
// capabilities. The selected-character handoff is consumed once, and a reload
// never replays it.
import { api as realApi } from "../api/client";
import type { Api } from "../api/client";
import type { LaunchContext } from "../api/types";
import { consumeSelectedCharacterId } from "./characterHandoff";
import { loadRuntimePointer } from "./runtimePointer";
import { attachMacroPortBridge, type MacroPortBridge } from "./macros";
import { refreshSession, setBusy, setFormStatus, showApiStatus } from "./session";

export const LAUNCH_MESSAGE_TYPE = "successor.launch.v1";
export const CLIENT_READY_TYPE = "successor.client.ready.v1";
export const LAUNCH_FAILED_TYPE = "successor.launch.failed.v1";
export const CLIENT_EXIT_WORLD_TYPE = "successor.client.exit-world.v1";
export const CLIENT_EXIT_WORLD_RESULT_TYPE = "successor.client.exit-world-result.v1";
const CLIENT_EXIT_WORLD_TIMEOUT_MS = 1_250;
// Fixed safe copy: never echo client- or server-provided failure detail.
const LAUNCH_FAILED_NOTICE =
  "Entry failed before the world opened. The tickets expire unused within a minute — try again for fresh ones.";
const SESSION_REPLACED_NOTICE =
  "This character was opened in another client, so this view stopped. Enter again here to take control in this browser.";

interface LiveFrameSession {
  iframe: HTMLIFrameElement;
  clientOrigin: string;
  dispose: () => void;
}

export function isLaunchContext(value: unknown): value is LaunchContext {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const endpoints = v.endpoints as Record<string, unknown> | undefined;
  const release = v.release as Record<string, unknown> | undefined;
  return (
    v.schema === "successor.launch-context.v1" &&
    typeof v.gameTicket === "string" &&
    typeof v.chatTicket === "string" &&
    typeof v.characterId === "string" &&
    typeof v.expiresAt === "number" &&
    typeof endpoints === "object" &&
    endpoints !== null &&
    typeof endpoints.game === "string" &&
    typeof endpoints.chat === "string" &&
    typeof release === "object" &&
    release !== null &&
    typeof release.client === "string" &&
    typeof release.server === "string" &&
    typeof release.shard === "string"
  );
}

function professionLabel(professionId: string): string {
  if (professionId.length === 0) return "unassigned";
  return professionId;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Ask one exact hosted client to save/despawn its character before teardown. */
export function requestHostedClientExit(
  iframe: HTMLIFrameElement,
  clientOrigin: string,
  timeoutMs = CLIENT_EXIT_WORLD_TIMEOUT_MS,
): Promise<boolean> {
  const win = iframe.ownerDocument.defaultView;
  const child = iframe.contentWindow;
  if (!win || !child) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      win.removeEventListener("message", onMessage);
      win.clearTimeout(timer);
      resolve(ok);
    };
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.origin !== clientOrigin || event.source !== child) return;
      if (
        !isPlainRecord(event.data)
        || event.data.type !== CLIENT_EXIT_WORLD_RESULT_TYPE
        || typeof event.data.ok !== "boolean"
        || Object.keys(event.data).length !== 2
      ) {
        return;
      }
      finish(event.data.ok);
    };
    win.addEventListener("message", onMessage);
    const timer = win.setTimeout(() => finish(false), timeoutMs);
    child.postMessage({ type: CLIENT_EXIT_WORLD_TYPE }, clientOrigin);
  });
}

function releaseBrowserCapture(doc: Document): void {
  if (doc.pointerLockElement && typeof doc.exitPointerLock === "function") {
    doc.exitPointerLock();
  }
  if (doc.fullscreenElement && typeof doc.exitFullscreen === "function") {
    void doc.exitFullscreen().catch(() => undefined);
  }
}

function bindPlayViewControls(doc: Document): void {
  const controls = doc.getElementById("play-frame-controls");
  const exitButton = doc.getElementById("play-frame-exit");
  const enterButton = doc.getElementById("play-frame-enter");
  if (
    !(controls instanceof HTMLElement) ||
    !(exitButton instanceof HTMLButtonElement) ||
    !(enterButton instanceof HTMLButtonElement) ||
    controls.dataset.viewBound === "1"
  ) {
    return;
  }
  controls.dataset.viewBound = "1";

  const leaveFullView = (): void => {
    if (doc.body.dataset.playState !== "live" || doc.body.dataset.playView !== "full") return;
    releaseBrowserCapture(doc);
    doc.body.dataset.playView = "framed";
    enterButton.focus({ preventScroll: true });
  };

  const enterFullView = (): void => {
    if (doc.body.dataset.playState !== "live") return;
    doc.body.dataset.playView = "full";
    const iframe = doc.getElementById("game-frame");
    if (iframe instanceof HTMLIFrameElement) iframe.focus({ preventScroll: true });
  };

  exitButton.addEventListener("click", leaveFullView);
  enterButton.addEventListener("click", enterFullView);
  doc.defaultView?.addEventListener(
    "keydown",
    (event) => {
      if (
        event.code !== "Escape" ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      if (doc.body.dataset.playState !== "live" || doc.body.dataset.playView !== "full") return;
      event.preventDefault();
      leaveFullView();
    },
    { capture: true },
  );
}

export function initPlayPage(doc: Document, api: Api = realApi): Promise<void> {
  let liveFrame: LiveFrameSession | null = null;
  let launchInFlight = false;
  bindPlayViewControls(doc);
  return bootstrap();

  function beginDirectEntry(stage: HTMLElement): void {
    stage.dataset.stageState = "launching";
    stage.setAttribute("aria-busy", "true");
    doc.body.dataset.playState = "launching";
    doc.body.dataset.playView = "full";
  }

  function restoreDirectEntrySurface(stage: HTMLElement | null): void {
    if (doc.body.dataset.playState !== "launching") return;
    if (stage) {
      stage.dataset.stageState = "idle";
      stage.removeAttribute("aria-busy");
    }
    doc.body.dataset.playState = "idle";
    delete doc.body.dataset.playView;
  }

  async function retireLiveFrame(): Promise<void> {
    const current = liveFrame;
    if (!current) return;
    liveFrame = null;
    current.dispose();
    releaseBrowserCapture(doc);
    await requestHostedClientExit(current.iframe, current.clientOrigin);
    current.iframe.remove();
    const stage = doc.getElementById("launch-section");
    if (stage instanceof HTMLElement) stage.dataset.stageState = "idle";
    doc.body.dataset.playState = "idle";
    delete doc.body.dataset.playView;
  }

  async function bootstrap(): Promise<void> {
    const active = await refreshSession(doc, api);
    if (!active) return;

    const select = doc.getElementById("launch-character");
    const form = doc.getElementById("launch-form");
    if (!(select instanceof HTMLSelectElement) || !(form instanceof HTMLFormElement)) return;

    const roster = await api.characters();
    if (!roster.ok) {
      setFormStatus(form, roster.error.message, "error");
      if (roster.error.kind === "unavailable") showApiStatus(doc, roster.error);
      const retry = doc.getElementById("launch-retry");
      if (retry instanceof HTMLButtonElement) {
        retry.hidden = false;
        retry.onclick = () => {
          retry.hidden = true;
          setFormStatus(form, "");
          void bootstrap();
        };
      }
      return;
    }
    select.textContent = "";
    for (const character of roster.value.characters) {
      const option = doc.createElement("option");
      option.value = character.id;
      const pending = character.worldEntryClaimed ? "" : " · waiting";
      option.textContent = `${character.name} — ${professionLabel(character.initialProfessionId)}${pending}`;
      select.append(option);
    }
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const launchRetry = doc.getElementById("launch-retry");
    if (launchRetry instanceof HTMLButtonElement) launchRetry.hidden = true;

    // Consume the workshop/roster handoff exactly once, even when it cannot
    // be used, so a stale id never lingers into a later visit.
    const win = doc.defaultView;
    const handedOff = win === null ? null : consumeSelectedCharacterId(win);

    if (roster.value.characters.length === 0) {
      setFormStatus(form, "No characters yet — make one on the account page.", "error");
      if (button) button.disabled = true;
      select.disabled = true;
      return;
    }

    // The roster/workshop ENTER was already the explicit player action. When
    // its one-shot id still belongs to this account, launch it directly rather
    // than asking for a redundant second confirmation on /play/.
    const directEntry = handedOff !== null && roster.value.characters.some((c) => c.id === handedOff);
    if (directEntry) {
      select.value = handedOff;
      setFormStatus(form, "Opening the world…", "success");
    }

    if (!directEntry) select.focus({ preventScroll: true });

    if (form.dataset.launchBound === "1") return;
    form.dataset.launchBound = "1";

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (launchInFlight) return;
      launchInFlight = true;
      void (async () => {
        try {
          const resultNote = doc.getElementById("launch-result");
          if (resultNote) {
            resultNote.hidden = true;
            resultNote.textContent = "";
          }
          setFormStatus(form, "");
          const characterId = select.value;
          if (!characterId) {
            setFormStatus(form, "Pick a character first.", "error");
            select.focus({ preventScroll: true });
            return;
          }
          if (button) setBusy(button, true);

          // Runtime first: no pointer, no ticket spent and the current world
          // stays intact when no replacement client is published.
          const stage = doc.getElementById("launch-section");
          const entry = await loadRuntimePointer(doc.baseURI);
          if (entry === null) {
            if (button) setBusy(button, false);
            restoreDirectEntrySurface(stage instanceof HTMLElement ? stage : null);
            if (resultNote) {
              resultNote.hidden = false;
              resultNote.textContent =
                "The browser client is not available at this address yet, so no ticket was spent. The world is up; try the installed client while this gets sorted.";
            }
            return;
          }

          // Save/despawn the old character before minting the replacement
          // capability or removing its frame. This is the browser equivalent
          // of /camp, not an unclean WebSocket disappearance.
          await retireLiveFrame();

          const ticket = await api.playTicket(characterId);
          if (!ticket.ok) {
            if (button) setBusy(button, false);
            restoreDirectEntrySurface(stage instanceof HTMLElement ? stage : null);
            if (ticket.error.kind === "unavailable") {
              showApiStatus(doc, ticket.error);
              setFormStatus(form, "Service unreachable — see the notice above.", "error");
            } else {
              setFormStatus(form, ticket.error.message, "error");
            }
            return;
          }
          let pendingContext: LaunchContext | null = ticket.value;
          if (!isLaunchContext(pendingContext)) {
            if (button) setBusy(button, false);
            restoreDirectEntrySurface(stage instanceof HTMLElement ? stage : null);
            if (resultNote) {
              resultNote.hidden = false;
              resultNote.textContent =
                "The server answered with an entry format this client does not understand. The tickets expire unused — try again or reload the page.";
            }
            return;
          }

          // Hand off to the immutable client iframe. The context travels over
          // postMessage to the exact origin and window only — never in the URL,
          // never in storage, never in logs.
          const clientUrl = new URL(entry.href);
          const clientOrigin = clientUrl.origin;
          const iframe = doc.createElement("iframe");
          iframe.id = "game-frame";
          iframe.className = "stage-frame";
          iframe.title = "Successor";
          iframe.setAttribute("allow", "fullscreen");
          iframe.allowFullscreen = true;
          // Protocol handshake: the client announces successor.client.ready.v1
          // from its exact origin/window. The client repeats READY until it
          // accepts the envelope, so answer every verified retry with the same
          // in-memory envelope. A fast cached iframe can otherwise miss the
          // first cross-origin delivery and wait forever on a blank frame.
          let launched = false;
          let macroBridge: MacroPortBridge | null = null;
          let readyDeadline: number | null = null;
          const session: LiveFrameSession = {
            iframe,
            clientOrigin,
            dispose: () => {
              window.removeEventListener("message", onMessage);
              if (readyDeadline !== null) window.clearTimeout(readyDeadline);
              readyDeadline = null;
              macroBridge?.dispose();
              macroBridge = null;
              pendingContext = null;
            },
          };
          const fail = (reason?: unknown): void => {
            session.dispose();
            if (liveFrame === session) liveFrame = null;
            iframe.remove();
            if (stage) stage.dataset.stageState = "idle";
            stage?.removeAttribute("aria-busy");
            doc.body.dataset.playState = "idle";
            delete doc.body.dataset.playView;
            if (button) setBusy(button, false);
            if (resultNote) {
              resultNote.hidden = false;
              resultNote.textContent =
                reason === "session-replaced" ? SESSION_REPLACED_NOTICE : LAUNCH_FAILED_NOTICE;
            }
          };
          const onMessage = (message: MessageEvent): void => {
            if (message.origin !== clientOrigin || message.source !== iframe.contentWindow) return;
            const data: unknown = message.data;
            if (data === null || typeof data !== "object" || !("type" in data)) return;
            if (data.type === CLIENT_READY_TYPE && pendingContext !== null) {
              const launch = pendingContext;
              // Keep the bounded listener and envelope alive while this exact
              // child continues to retry. The ticket is minted once and never
              // leaves memory; duplicate READY does not create another launch.
              iframe.contentWindow?.postMessage(
                { type: LAUNCH_MESSAGE_TYPE, launch },
                clientOrigin,
              );
              if (!launched) {
                launched = true;
                // Character-bound macro data port: parent holds cookie/CSRF.
                macroBridge?.dispose();
                macroBridge = attachMacroPortBridge({
                  api,
                  iframe,
                  clientOrigin,
                  characterId: launch.characterId,
                });
                // The launch form deliberately focused the character selector.
                // Transfer keyboard ownership to the cross-origin client only
                // after its authenticated READY handshake, so Enter, WASD, and
                // window hotkeys work without a sacrificial click in the frame.
                iframe.focus({ preventScroll: true });
                if (button) setBusy(button, false);
                setFormStatus(form, "Handed off to the client.", "success");
              }
            } else if (data.type === LAUNCH_FAILED_TYPE) {
              fail("reason" in data ? data.reason : undefined);
            }
          };
          window.addEventListener("message", onMessage);
          readyDeadline = window.setTimeout(() => {
            if (launched) {
              pendingContext = null;
              readyDeadline = null;
            }
            else fail();
          }, 30_000);
          liveFrame = session;
          if (stage) stage.dataset.stageState = "live";
          stage?.removeAttribute("aria-busy");
          doc.body.dataset.playState = "live";
          doc.body.dataset.playView = "full";
          stage?.append(iframe);
          iframe.src = clientUrl.href;
        } finally {
          launchInFlight = false;
        }
      })();
    });

    if (directEntry) {
      const stage = doc.getElementById("launch-section");
      if (stage instanceof HTMLElement) beginDirectEntry(stage);
      form.requestSubmit(button ?? undefined);
    }
  }
}
