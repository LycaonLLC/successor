import type { WindowContentHandle, WindowContext, WindowDefinition } from "./windowManager";

/**
 * Deferred window mount — chrome opens immediately; feature module loads on
 * first open with loading / error / retry states and one-load module caching.
 *
 * After a successful load the real feature root is the contentRoot's first
 * element child so windowManager.syncScrollCue still sees the true scroller
 * (FX Lab / long panes more-below cue). Loading and error chrome are temporary
 * first children only while the module is not ready.
 *
 * Static import() factories only (no dynamic string imports). Cached module
 * promises mean a successful load is reused for the session; failures clear
 * so Retry can re-request the chunk.
 */

export type DeferredLoadState = "idle" | "loading" | "ready" | "error";

export interface DeferredModuleCacheEntry<TModule> {
  promise: Promise<TModule> | null;
  module: TModule | null;
  error: unknown;
  state: DeferredLoadState;
  loads: number;
}

const moduleCaches = new Map<string, DeferredModuleCacheEntry<unknown>>();

export function deferredModuleCacheKey(featureId: string): string {
  return `successor3d.deferred.${featureId}`;
}

export function getDeferredModuleCacheEntry<TModule>(
  featureId: string,
): DeferredModuleCacheEntry<TModule> {
  const key = deferredModuleCacheKey(featureId);
  let entry = moduleCaches.get(key) as DeferredModuleCacheEntry<TModule> | undefined;
  if (!entry) {
    entry = { promise: null, module: null, error: null, state: "idle", loads: 0 };
    moduleCaches.set(key, entry as DeferredModuleCacheEntry<unknown>);
  }
  return entry;
}

/** Test / dispose seam: drop one or all deferred module caches. */
export function resetDeferredModuleCache(featureId?: string): void {
  if (featureId === undefined) {
    moduleCaches.clear();
    return;
  }
  moduleCaches.delete(deferredModuleCacheKey(featureId));
}

export function loadDeferredModuleOnce<TModule>(
  featureId: string,
  loader: () => Promise<TModule>,
): Promise<TModule> {
  const entry = getDeferredModuleCacheEntry<TModule>(featureId);
  if (entry.module) return Promise.resolve(entry.module);
  if (entry.promise) return entry.promise;
  entry.state = "loading";
  entry.error = null;
  entry.loads += 1;
  const pending = loader()
    .then((mod) => {
      entry.module = mod;
      entry.state = "ready";
      entry.promise = null;
      return mod;
    })
    .catch((error: unknown) => {
      entry.error = error;
      entry.state = "error";
      entry.promise = null;
      throw error;
    });
  entry.promise = pending;
  return pending;
}

export interface DeferredWindowShellOptions<TModule> {
  featureId: string;
  /** Static import() factory — never build the specifier from a runtime string. */
  load: () => Promise<TModule>;
  /** Build the real content handle once the feature module is ready. */
  mountLoaded: (mod: TModule, contentRoot: HTMLElement, ctx: WindowContext) => WindowContentHandle;
  loadingLabel?: string;
  errorLabel?: string;
}

/**
 * WindowDefinition.mount wrapper: shows loading chrome, loads once, mounts
 * real content as contentRoot's first child (scroll-cue host), and exposes
 * Retry on failure without tearing the window frame.
 */
export function createDeferredWindowMount<TModule>(
  options: DeferredWindowShellOptions<TModule>,
): WindowDefinition["mount"] {
  const loadingLabel = options.loadingLabel ?? "LOADING…";
  const errorLabel = options.errorLabel ?? "LOAD FAILED";

  return (contentRoot, ctx) => {
    let disposed = false;
    let child: WindowContentHandle | null = null;
    let generation = 0;

    const clearContent = (): void => {
      child?.dispose();
      child = null;
      contentRoot.replaceChildren();
    };

    const paintStatus = (state: "loading" | "error", message: string): void => {
      clearContent();
      const shell = document.createElement("div");
      shell.className = "scp-root scp-deferred";
      shell.dataset.deferredFeature = options.featureId;
      shell.dataset.deferredState = state;
      shell.setAttribute("role", "status");
      shell.setAttribute("aria-live", "polite");
      const label = document.createElement("span");
      label.className = "scp-deferred-label";
      label.textContent = message;
      shell.appendChild(label);
      if (state === "error") {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "scp-deferred-retry";
        retry.textContent = "RETRY";
        retry.addEventListener("click", () => {
          if (disposed) return;
          const entry = getDeferredModuleCacheEntry<TModule>(options.featureId);
          if (entry.state === "error") {
            entry.promise = null;
            entry.module = null;
            entry.error = null;
            entry.state = "idle";
          }
          beginLoad();
        });
        shell.appendChild(retry);
      }
      contentRoot.appendChild(shell);
    };

    const mountFromModule = (mod: TModule): void => {
      if (disposed) return;
      clearContent();
      // Real feature root becomes contentRoot.firstElementChild — the same
      // scroll host windowManager.syncScrollCue inspects for the more-below cue.
      child = options.mountLoaded(mod, contentRoot, ctx);
      child.onResized();
    };

    const beginLoad = (): void => {
      if (disposed) return;
      const token = ++generation;
      const cached = getDeferredModuleCacheEntry<TModule>(options.featureId);
      if (cached.module) {
        mountFromModule(cached.module);
        return;
      }
      paintStatus("loading", loadingLabel);
      void loadDeferredModuleOnce(options.featureId, options.load)
        .then((mod) => {
          if (disposed || token !== generation) return;
          mountFromModule(mod);
        })
        .catch(() => {
          if (disposed || token !== generation) return;
          paintStatus("error", errorLabel);
        });
    };

    beginLoad();

    return {
      update(dtSeconds, timeMs) {
        child?.update(dtSeconds, timeMs);
      },
      onResized() {
        child?.onResized();
      },
      dispose() {
        disposed = true;
        generation += 1;
        clearContent();
      },
    };
  };
}

