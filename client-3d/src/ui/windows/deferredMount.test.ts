// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDeferredWindowMount,
  getDeferredModuleCacheEntry,
  loadDeferredModuleOnce,
  resetDeferredModuleCache,
} from "./deferredMount";
import type { WindowContentHandle, WindowContext } from "./windowManager";

const ctx = { state: {} as WindowContext["state"], slice: {} as WindowContext["slice"] };

function mountRoot(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  resetDeferredModuleCache();
  document.body.replaceChildren();
});

describe("deferred window mount", () => {
  it("shows loading then mounts content once the module resolves", async () => {
    const root = mountRoot();
    let loads = 0;
    let release!: (value: { ok: true }) => void;
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = resolve;
    });
    const mount = createDeferredWindowMount<{ ok: true }>({
      featureId: "test-load",
      load: () => {
        loads += 1;
        return gate;
      },
      mountLoaded: (_mod, contentRoot) => {
        const node = document.createElement("div");
        node.className = "scp-root";
        node.textContent = "READY";
        contentRoot.appendChild(node);
        return {
          update() {},
          onResized() {},
          dispose() { node.remove(); },
        } satisfies WindowContentHandle;
      },
    });
    const handle = mount(root, ctx);
    const shell = root.querySelector<HTMLElement>(".scp-deferred")!;
    expect(shell.dataset.deferredState).toBe("loading");
    expect(root.firstElementChild).toBe(shell);
    release({ ok: true });
    await vi.waitFor(() => {
      expect(root.querySelector(".scp-deferred")).toBeNull();
      expect(root.firstElementChild?.textContent).toBe("READY");
    });
    expect(root.firstElementChild?.classList.contains("scp-root")).toBe(true);
    expect(loads).toBe(1);
    handle.dispose();
  });

  it("surfaces error + retry and caches a successful module for one-load reuse", async () => {
    const root = mountRoot();
    let attempts = 0;
    const mount = createDeferredWindowMount<{ n: number }>({
      featureId: "test-retry",
      load: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("chunk missing");
        return { n: attempts };
      },
      mountLoaded: (mod, contentRoot) => {
        const node = document.createElement("div");
        node.className = "scp-root";
        node.textContent = `N${mod.n}`;
        contentRoot.appendChild(node);
        return { update() {}, onResized() {}, dispose() { node.remove(); } };
      },
    });
    const handle = mount(root, ctx);
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLElement>(".scp-deferred")?.dataset.deferredState).toBe("error");
    });
    const shell = root.querySelector<HTMLElement>(".scp-deferred")!;
    const retry = shell.querySelector<HTMLButtonElement>(".scp-deferred-retry")!;
    expect(retry).toBeTruthy();
    retry.click();
    await vi.waitFor(() => {
      expect(root.querySelector(".scp-deferred")).toBeNull();
      expect(root.firstElementChild?.textContent).toBe("N2");
    });
    expect(attempts).toBe(2);

    // Second mount reuses the cached module (no third network/module load).
    const root2 = mountRoot();
    const handle2 = mount(root2, ctx);
    await vi.waitFor(() => expect(root2.firstElementChild?.textContent).toBe("N2"));
    expect(attempts).toBe(2);
    expect(getDeferredModuleCacheEntry("test-retry").loads).toBe(2);
    handle.dispose();
    handle2.dispose();
  });

  it("dedupes concurrent loadDeferredModuleOnce callers onto one promise", async () => {
    let loads = 0;
    let release!: (value: { v: number }) => void;
    const gate = new Promise<{ v: number }>((resolve) => {
      release = resolve;
    });
    const loader = () => {
      loads += 1;
      return gate;
    };
    const a = loadDeferredModuleOnce("test-dedupe", loader);
    const b = loadDeferredModuleOnce("test-dedupe", loader);
    expect(loads).toBe(1);
    release({ v: 7 });
    await expect(a).resolves.toEqual({ v: 7 });
    await expect(b).resolves.toEqual({ v: 7 });
    await expect(loadDeferredModuleOnce("test-dedupe", loader)).resolves.toEqual({ v: 7 });
    expect(loads).toBe(1);
  });

  it("promotes the real feature root to contentRoot.firstElementChild after load", async () => {
    const root = mountRoot();
    let scrollerEl: HTMLElement | null = null;
    const mount = createDeferredWindowMount<{ ok: true }>({
      featureId: "test-scroll-host",
      load: async () => ({ ok: true }),
      mountLoaded: (_mod, contentRoot) => {
        const scroller = document.createElement("div");
        scroller.className = "scp-root scp-fxlab";
        contentRoot.appendChild(scroller);
        scrollerEl = scroller;
        return {
          update() {},
          onResized() {},
          dispose() { scroller.remove(); },
        };
      },
    });
    const handle = mount(root, ctx);
    await vi.waitFor(() => {
      const host = root.firstElementChild;
      expect(host).toBeInstanceOf(HTMLElement);
      expect((host as HTMLElement).classList.contains("scp-deferred")).toBe(false);
      expect((host as HTMLElement).classList.contains("scp-root")).toBe(true);
    });
    // Identity: syncScrollCue reads contentRoot.firstElementChild as the scroll host.
    const host = root.firstElementChild as HTMLElement;
    expect(host).toBe(scrollerEl);
    // happy-dom has no layout engine — define scroll metrics deterministically and
    // apply the same more-below predicate windowManager.syncScrollCue uses.
    Object.defineProperty(host, "scrollHeight", { configurable: true, value: 400 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 40 });
    Object.defineProperty(host, "scrollTop", { configurable: true, value: 0 });
    const canCue = host.scrollHeight > host.clientHeight + 1;
    const below = host.scrollTop + host.clientHeight < host.scrollHeight - 2;
    expect(canCue).toBe(true);
    expect(below).toBe(true);
    handle.dispose();
  });
});
