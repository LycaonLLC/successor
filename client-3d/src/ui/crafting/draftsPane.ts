import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { authorityIssuedAtServerTick, enqueueAuthorityFactoryManufactureCommand } from "@successor/client/src/slice-core/authorityCommandSystem";
import { composeDraftRows } from "./composers";
import { CRAFT_COPY } from "./copy";
import { resolveFactorySession } from "./factoryLink";
import { craftDrafts, craftStoreVersion, syncCraftChannelFromAuthority } from "./store";
import { UI_ICONS } from "../icons";

/**
 * DATAPAD · SCHEMATICS — the FACTORY DRAFTS shelf.
 *
 * Renders the player-created frozen patterns (DRAFT SCHEMATIC exits): output
 * name, remaining/max uses, the locked materials line production will demand
 * IDENTICALLY, and the frozen result stats when known (the live wire freezes
 * stats inside the output variant, so that line hides rather than invent
 * numbers). At a bound factory workbench the shelf can spend one physical draft run.
 * Away from a factory it still names what a draft is worth. Distinct noun from
 * the CRAFT window's KNOWN RECIPES (owner naming law: recipes are what you
 * know, drafts are what you made).
 */
export interface DraftsPane {
  root: HTMLElement;
  update(): void;
  dispose(): void;
}

export function createDraftsPane(deps: { state: PlayState; slice: SliceSnapshot; onStatus?: (line: string, ok?: boolean) => void }): DraftsPane {
  const root = document.createElement("div");
  root.className = "scp-craft-drafts";
  root.innerHTML = `
    <header class="scp-craft-drafts-head">
      <strong>${CRAFT_COPY.drafts.title}</strong>
      <span data-ref="count"></span>
    </header>
    <div class="scp-craft-draftlist" data-ref="list"></div>
    <div class="scp-empty" data-ref="empty" hidden>
      <span class="scp-empty-glyph" aria-hidden="true">${UI_ICONS.craft}</span>
      <span>${CRAFT_COPY.drafts.empty}</span>
      <small>${CRAFT_COPY.drafts.emptyHint}</small>
    </div>
  `;
  const countEl = paneRef(root, "count");
  const listEl = paneRef(root, "list");
  const emptyEl = paneRef(root, "empty");

  let appliedVersion = -1;
  let appliedFactoryKey = "";

  const rebuild = (): void => {
    const rows = composeDraftRows(craftDrafts());
    countEl.textContent = String(rows.length);
    emptyEl.hidden = rows.length > 0;
    listEl.textContent = "";
    for (const row of rows) {
      const el = document.createElement("div");
      el.className = "scp-craft-draft";
      el.dataset.schematicId = row.schematicId;
      el.toggleAttribute("data-spent", row.spent);
      el.innerHTML = `
        <div class="scp-craft-draft-head">
          <strong></strong>
          <span class="scp-craft-draft-uses"></span>
        </div>
        <span class="scp-craft-draft-line" data-role="locks"></span>
        <span class="scp-craft-draft-line" data-role="stats"></span>
      `;
      const head = el.children[0] as HTMLElement;
      (head.children[0] as HTMLElement).textContent = row.name;
      const uses = head.children[1] as HTMLElement;
      uses.textContent = row.spent ? CRAFT_COPY.drafts.spent : row.usesText;
      const locks = el.children[1] as HTMLElement;
      locks.textContent = `${CRAFT_COPY.drafts.locks} · ${row.lockLine}`;
      const stats = el.children[2] as HTMLElement;
      stats.textContent = row.statLine.length > 0 ? `${CRAFT_COPY.drafts.stats} · ${row.statLine}` : "";
      stats.hidden = row.statLine.length === 0;
      const factorySession = resolveFactorySession(deps.state, deps.slice);
      const factoryId = factorySession.inReach ? factorySession.factoryId : null;
      if (!row.spent && factoryId) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "scp-craft-draft-run";
        btn.textContent = CRAFT_COPY.drafts.manufacture;
        btn.addEventListener("click", () => {
          const live = resolveFactorySession(deps.state, deps.slice);
          const liveFactoryId = live.inReach ? live.factoryId : null;
          if (!liveFactoryId) {
            deps.onStatus?.(CRAFT_COPY.drafts.needFactory, false);
            rebuild();
            return;
          }
          const issuedAtTick = authorityIssuedAtServerTick(deps.state, deps.slice.tickRateHz, deps.slice.tick);
          const queued = enqueueAuthorityFactoryManufactureCommand(
            deps.state.authorityCommands,
            liveFactoryId,
            row.schematicId,
            issuedAtTick,
          );
          deps.onStatus?.(
            queued ? CRAFT_COPY.drafts.manufactureQueued : CRAFT_COPY.drafts.manufactureBlocked,
            Boolean(queued),
          );
        });
        el.appendChild(btn);
      } else if (!row.spent) {
        const hint = document.createElement("span");
        hint.className = "scp-craft-draft-line";
        hint.textContent = CRAFT_COPY.drafts.needFactory;
        el.appendChild(hint);
      }
      listEl.appendChild(el);
    }
  };

  return {
    root,
    update(): void {
      syncCraftChannelFromAuthority(deps.state);
      const version = craftStoreVersion();
      const session = resolveFactorySession(deps.state, deps.slice);
      const factoryKey = session.inReach ? (session.factoryId ?? "") : "";
      if (version === appliedVersion && factoryKey === appliedFactoryKey) return;
      appliedVersion = version;
      appliedFactoryKey = factoryKey;
      rebuild();
    },
    dispose(): void {
      root.remove();
    },
  };
}

function paneRef(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`drafts pane: missing data-ref="${name}"`);
  return el;
}
