const { contextBridge, ipcRenderer } = require("electron");

const desktopKeyEventName = "successor-desktop-key-input";
const desktopWindowStateChannel = "successor-window-state";
const desktopToggleFullScreenChannel = "successor-toggle-fullscreen";
const desktopMacroFilesChannel = "successor-macro-files";
const hostedControlChannel = "successor-hosted-control";
const hostedEventChannel = "successor-hosted-event";
const hostedTakeLaunchChannel = "successor-hosted-take-launch";
const hostedLaunchFailedChannel = "successor-hosted-launch-failed";

contextBridge.exposeInMainWorld("__successorDesktop", {
  platform: process.platform,
  keyEventName: desktopKeyEventName,
  isDesktopShell: true,
  windowState: () => ipcRenderer.invoke(desktopWindowStateChannel),
  // Read-only local macro library: one call lists+reads <userData>/macros/*.macro.
  macroFiles: () => ipcRenderer.invoke(desktopMacroFilesChannel),
  // Hosted launch handoff: the main process arms one envelope for this
  // webContents right before loading the game page; the first take clears it.
  takeHostedLaunch: () => ipcRenderer.invoke(hostedTakeLaunchChannel),
  hostedLaunchFailed: (reason) => ipcRenderer.invoke(hostedLaunchFailedChannel, String(reason ?? "unknown")),
  // Account-link shell controls. The main process validates the sender frame;
  // snapshots never carry credentials or tickets.
  hosted: {
    control: (op, args) => ipcRenderer.invoke(hostedControlChannel, {
      op: String(op),
      ...(args && typeof args === "object" ? { args } : {}),
    }),
    onState: (callback) => {
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on(hostedEventChannel, listener);
      return () => ipcRenderer.removeListener(hostedEventChannel, listener);
    },
  },
});

window.addEventListener("keydown", (event) => {
  if (!isFullScreenToggleEvent(event) || event.repeat) return;
  event.preventDefault();
  void ipcRenderer.invoke(desktopToggleFullScreenChannel).catch(() => undefined);
}, { capture: true });

function isFullScreenToggleEvent(event) {
  return event.code === "F11" || (event.altKey && event.code === "Enter");
}

ipcRenderer.on(desktopKeyEventName, (_event, input) => {
  window.dispatchEvent(new CustomEvent(desktopKeyEventName, { detail: input }));
});
