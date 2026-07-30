import "./lab/lab.css";
import { startAssetLab, type AssetLabApp } from "./lab/app";

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("missing #app");

let app: AssetLabApp | null = null;

void startAssetLab(root)
  .then((started) => {
    app = started;
    // Debug handle for harness/console inspection of the lab (dev tool surface).
    (window as Window & { __successorAssetLab?: AssetLabApp }).__successorAssetLab = started;
  })
  .catch((error: unknown) => {
    root.textContent = error instanceof Error ? error.message : "Successor Asset Lab failed to start";
    console.error("Successor Asset Lab boot failed", error);
  });

window.addEventListener("beforeunload", () => {
  app?.dispose();
});
