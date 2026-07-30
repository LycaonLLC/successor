import "./styles.css";
import type { Successor3dApp } from "./boot/successor3dApp";
import { renderCharacterSelect } from "./ui/characterSelect";
import { renderEntryScreen } from "./ui/entryScreen";
import { initUiTheme } from "./ui/uiTheme";
import { mountStatusPlate, type StatusPlateController } from "./ui/statusPlate";
import { createSfxPlayer } from "@successor/client/src/audio/sfx";
import { successorAudioIds } from "@successor/client/src/slice-core/successorAudioIds";
import { SUCCESSOR_MACROS_RECORD_KIND } from "./ui/macros/store";
import { isCreatorMode, usesTicketDirectEntry } from "./entryRouting";
import { createHostedCharacterCreatorPort } from "./ui/hostedCharacterCreator";
import {
  installParentExitWorldHandler,
  notifyHostedLaunchFailure,
  takeTrustedDesktopLaunch,
  waitForParentLaunch,
} from "./launchProtocol";
import { sendExitWorld } from "@successor/client/src/slice-core/gameAuthoritySystem";


if (typeof document !== "undefined") {
// Apply the persisted UI theme synchronously, before the app shell first
// paints, so the chrome never flashes the wrong palette.
initUiTheme();

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app");

let app: Successor3dApp | null = null;
let plate: StatusPlateController | null = null;
let bootPromise: Promise<void> | null = null;
const disposeParentExitWorld = installParentExitWorldHandler(async () => {
  const current = app;
  if (!current) return false;
  const sent = sendExitWorld(current.state);
  if (!sent) return false;
  const deadline = performance.now() + 900;
  while (current.state.serverAuthority.connected && performance.now() < deadline) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  }
  const serverClosed = !current.state.serverAuthority.connected;
  if (app === current) {
    plate?.dispose();
    plate = null;
    current.stop();
    app = null;
  }
  return serverClosed;
});
// One SfxPlayer for the whole page (menu music now, world audio after boot) —
// a second player would re-decode the full 146-clip manifest and leak its
// AudioContext, so the world app REUSES this instance via startSuccessor3dApp.
let sharedSfx: ReturnType<typeof createSfxPlayer> | null = null;

const bootWorld = (canvasHost: HTMLElement, setStatus: (message: string) => void, shell: HTMLElement): void => {
  if (app || bootPromise) return;
  sharedSfx?.stopLoop?.(successorAudioIds.musicMenuCharcreateLoop, 1200);
  setStatus("Entering world…");
  bootPromise = import("./boot/successor3dApp")
    .then(({ startSuccessor3dApp }) => startSuccessor3dApp(canvasHost, setStatus, { ...(sharedSfx ? { sfx: sharedSfx } : {}), onLaunchFailure: (reason) => {
      plate?.dispose();
      plate = null;
      app?.stop();
      app = null;
      window.__successorLaunchContext?.discard();
      window.__successorLaunchContext = undefined;
      notifyHostedLaunchFailure(reason);
      setStatus(
        reason === "session-replaced"
          ? "This character was opened in another client. Return to the account shell to take control here."
          : "Launch rejected. Return to the account shell and try again.",
      );
    } }))
    .then((started) => {
      app = started;
      plate = mountStatusPlate(shell, started.state, started.slice);
    })
    .catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Successor 3D failed to start");
      if (window.__successorLaunchContext) {
        window.__successorLaunchContext.discard();
        window.__successorLaunchContext = undefined;
        notifyHostedLaunchFailure("game-failed");
      }
      console.error("Successor 3D boot failed", error);
    })
    .finally(() => {
      bootPromise = null;
    });
};
const route = () => {

const params = new URLSearchParams(window.location.search);
if (isCreatorMode(params)) {
  try {
    const creatorPort = createHostedCharacterCreatorPort();
    void renderCharacterSelect(root, creatorPort).finally(() => creatorPort.dispose());
  } catch (error) {
    root.innerHTML = `<main class="successor3d-shell sc3d-charselect"><p class="sc3d-cs-note">CREATOR UNAVAILABLE — RETURN TO THE ACCOUNT SHELL AND RETRY.</p></main>`;
    console.error("Hosted creator unavailable", error);
  }
  return;
}
// Production handoff: the Successor site has already selected the character and
// minted a one-use ticket, so the local dev character-select route must not run.
if (usesTicketDirectEntry(params)) {
  const entry = renderEntryScreen(root, () => {
    entry.setStatus("Entering world…");
    entry.showStage();
    bootWorld(entry.canvasHost, entry.setStatus, entry.shell);
  });
  entry.setStatus("Entering world…");
  entry.showStage();
  bootWorld(entry.canvasHost, entry.setStatus, entry.shell);
} else if (params.get("autoEnter") === "1") {
  // Labs, fixtures, and verify scripts keep the legacy direct path: autoEnter=1
  // (with player/actorId params) skips character select entirely.
  const entry = renderEntryScreen(root, () => {
    entry.setStatus("Entering world…");
    entry.showStage();
    bootWorld(entry.canvasHost, entry.setStatus, entry.shell);
  });
} else {
  // Owner path: desktop launch lands on CHARACTER SELECT (owner spec
  // 2026-07-06 — select-before-enter per docs/CHARACTER_SYSTEM.md).
  // Menu/char-creation music (owner OST ruling 2026-07-08). Starts silent until
  // the first user gesture unlocks the AudioContext (browser autoplay policy).
  sharedSfx = createSfxPlayer();
  sharedSfx.setLoop?.(successorAudioIds.musicMenuCharcreateLoop, { volume: 0.55, fadeMs: 1500 });
  void renderCharacterSelect(root).then(({ character, join }) => {
    if (!join) return;
    // Hand the selected character to the launch-identity chain (join options
    // read window.__successorSelectedCharacter) + bake spawn/name into the URL
    // so the world boot consumes the store-issued deployment. The join payload
    // also carries per-character record kinds — the macro store seeds from it
    // without a fetch (successor.macros.v1 join-payload sync).
    (window as Window & { __successorSelectedCharacter?: unknown }).__successorSelectedCharacter = {
      id: character.id,
      ownerRef: character.ownerRef,
      name: character.name,
      macroRecords: join.recordKinds?.[SUCCESSOR_MACROS_RECORD_KIND] ?? null,
      worn: join.worn ?? [],
    };
    const url = new URL(window.location.href);
    url.searchParams.set("player", join.player);
    url.searchParams.set("actorId", join.actorId);
    url.searchParams.set("name", join.name);
    url.searchParams.set("spawnArea", join.spawnArea);
    url.searchParams.set("spawnX", String(join.spawnX));
    url.searchParams.set("spawnY", String(join.spawnY));
    url.searchParams.set("facing", join.facing);
    url.searchParams.set("characterId", character.id);
    window.history.replaceState(null, "", url);
    const entry = renderEntryScreen(root, () => {
      entry.setStatus("Entering world…");
      entry.showStage();
      bootWorld(entry.canvasHost, entry.setStatus, entry.shell);
    });
    // The select screen already collected the choice — enter immediately.
    const enterButton = root.querySelector<HTMLButtonElement>("#successor3d-enter");
    enterButton?.click();
  });
}

};
// Desktop hosted launches hand the envelope over the trusted preload bridge;
// browser hosted launches arrive from the site parent frame. Whichever wins,
// the capabilities are consumed exactly once before routing.
const initialParams = new URLSearchParams(window.location.search);
if (isCreatorMode(initialParams)) {
  route();
} else {
void takeTrustedDesktopLaunch().then((desktopLaunch) => desktopLaunch ?? waitForParentLaunch()).then((parentLaunch) => {
  if (parentLaunch && "capabilities" in parentLaunch) {
    window.__successorLaunchContext = parentLaunch.capabilities;
    (window as Window & { __successorSelectedCharacter?: unknown }).__successorSelectedCharacter = { id: parentLaunch.launch.characterId };
  } else if (parentLaunch) {
    window.__successorLaunch = parentLaunch;
  }
  route();
}).catch((error: unknown) => console.error("Successor hosted launch failed", error));
}
window.addEventListener("beforeunload", () => {
  plate?.dispose();
  disposeParentExitWorld();
  // Best effort for ordinary tab/navigation exits. When the clean packet was
  // queued, leave the socket alive for document teardown instead of racing it
  // with Room.leave(); the parent handshake above is the confirmed path used
  // for in-page character switches.
  if (!app || !sendExitWorld(app.state)) app?.stop();
});
}
