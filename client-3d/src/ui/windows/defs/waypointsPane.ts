import { currentArea } from "@successor/client/src/slice-core/worldQueries";
import {
  createWaypoint,
  defaultWaypointName,
  deleteWaypoint,
  renameWaypoint,
  setWaypointActive,
  waypointStoreVersion,
  waypoints,
  type Waypoint,
} from "../../waypoints/store";
import { travelCatalogFrom } from "../../travel/travelSystem";
import type { ContextRadial } from "../contextRadial";
import type { WindowContentHandle, WindowContext } from "../windowManager";

interface WaypointsPaneDeps {
  radial: ContextRadial;
}

export interface WaypointsPane extends WindowContentHandle {
  root: HTMLElement;
}

interface RowNodes {
  distance: HTMLElement;
  area: HTMLElement;
  toggle: HTMLButtonElement;
  row: HTMLElement;
}

interface PlanetGroup {
  key: string;
  label: string;
  rows: Waypoint[];
}

const STATUS_FLASH_MS = 1400;
const EDIT_INPUT_MAX = 48;

export function createWaypointsPane(ctx: WindowContext, deps: WaypointsPaneDeps): WaypointsPane {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-waypoints";
  root.innerHTML = `
    <header class="scp-waypoints-head">
      <div class="scp-waypoints-title">
        <strong>WAYPOINTS</strong>
        <span data-ref="count">0 / 100</span>
      </div>
      <button class="scp-waypoint-new" type="button" data-ref="new">NEW WAYPOINT</button>
    </header>
    <div class="scp-waypoint-list" data-ref="list"></div>
    <div class="scp-empty scp-waypoint-empty" data-ref="empty" hidden>
      <span>No waypoints</span>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status"></span>
    </footer>
  `;

  const countEl = ref(root, "count");
  const newButton = ref(root, "new") as HTMLButtonElement;
  const listEl = ref(root, "list");
  const emptyEl = ref(root, "empty");
  const statusEl = ref(root, "status");
  const rowNodes = new Map<string, RowNodes>();

  let disposed = false;
  let appliedVersion = -1;
  let editingId: string | null = null;
  let statusFlashTimer = 0;

  const flashStatus = (message: string): void => {
    window.clearTimeout(statusFlashTimer);
    statusEl.textContent = message;
    statusEl.toggleAttribute("data-flash", true);
    statusFlashTimer = window.setTimeout(() => {
      statusEl.toggleAttribute("data-flash", false);
    }, STATUS_FLASH_MS);
  };

  const beginEdit = (id: string): void => {
    editingId = id;
    renderList();
    requestAnimationFrame(() => {
      const input = listEl.querySelector<HTMLInputElement>(`input[data-id="${cssEscape(id)}"]`);
      input?.focus();
      input?.select();
    });
  };

  const createAtPlayer = (): void => {
    const area = currentArea(slice, state);
    const result = createWaypoint({
      name: defaultWaypointName(),
      x: Math.floor(state.player.x),
      y: Math.floor(state.player.y),
      areaId: area.id,
    });
    flashStatus(result.status);
    if (result.ok && result.waypoint) {
      editingId = result.waypoint.id;
      renderList();
      requestAnimationFrame(() => {
        const input = listEl.querySelector<HTMLInputElement>(`input[data-id="${cssEscape(result.waypoint!.id)}"]`);
        input?.focus();
        input?.select();
      });
    }
  };

  const commitEdit = (id: string, input: HTMLInputElement, previousName: string): void => {
    const next = input.value.trim();
    if (next.length === 0) {
      input.value = previousName;
      editingId = null;
      flashStatus("WAYPOINT NAME REQUIRED");
      renderList();
      return;
    }
    const result = renameWaypoint(id, next);
    flashStatus(result.status);
    editingId = null;
    renderList();
  };

  const toggleWaypoint = (id: string): void => {
    const waypoint = waypoints().find((entry) => entry.id === id);
    if (!waypoint) {
      flashStatus("WAYPOINT GONE");
      renderList();
      return;
    }
    const result = setWaypointActive(id, !waypoint.active);
    flashStatus(result.status);
    renderList();
  };

  const deleteRow = (id: string): void => {
    const result = deleteWaypoint(id);
    flashStatus(result.status);
    if (editingId === id) editingId = null;
    renderList();
  };

  newButton.addEventListener("click", createAtPlayer);

  listEl.addEventListener("click", (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionButton = target.closest<HTMLButtonElement>("button[data-action]");
    if (!actionButton) return;
    const row = actionButton.closest<HTMLElement>(".scp-waypoint-row");
    const id = row?.dataset.id;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (actionButton.dataset.action === "toggle") toggleWaypoint(id);
    else if (actionButton.dataset.action === "delete") deleteRow(id);
  });

  listEl.addEventListener("contextmenu", (event: MouseEvent) => {
    event.preventDefault();
    const target = event.target;
    const row = target instanceof Element ? target.closest<HTMLElement>(".scp-waypoint-row") : null;
    const id = row?.dataset.id;
    if (!id) {
      deps.radial.close();
      return;
    }
    const waypoint = waypoints().find((entry) => entry.id === id);
    if (!waypoint) return;
    deps.radial.openFor(event.clientX, event.clientY, [
      { id: "rename", label: "RENAME", enabled: true, note: null },
      { id: "toggle", label: waypoint.active ? "DEACTIVATE" : "ACTIVATE", enabled: true, note: null },
      { id: "delete", label: "DELETE", enabled: true, note: null },
    ], {
      onAction: (actionId) => {
        if (actionId === "rename") beginEdit(id);
        else if (actionId === "toggle") toggleWaypoint(id);
        else if (actionId === "delete") deleteRow(id);
      },
      onDisabled: (note) => flashStatus(note || "DENIED"),
    });
  });

  function renderList(): void {
    appliedVersion = waypointStoreVersion();
    rowNodes.clear();
    listEl.textContent = "";
    const rows = waypoints();
    countEl.textContent = `${rows.length} / 100`;
    emptyEl.hidden = rows.length > 0;
    if (rows.length === 0) return;
    const groups = groupedWaypoints(slice, rows);
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "scp-waypoint-group";
      const header = document.createElement("h3");
      header.className = "scp-waypoint-planet";
      header.textContent = group.label;
      section.appendChild(header);
      for (const waypoint of group.rows) {
        section.appendChild(renderRow(waypoint, group.label));
      }
      listEl.appendChild(section);
    }
    refreshDynamicFields();
  }

  function renderRow(waypoint: Waypoint, planetLabel: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "scp-waypoint-row";
    row.dataset.id = waypoint.id;
    row.toggleAttribute("data-active", waypoint.active);

    const marker = document.createElement("span");
    marker.className = "scp-waypoint-marker";
    marker.setAttribute("aria-hidden", "true");

    const main = document.createElement("div");
    main.className = "scp-waypoint-main";
    if (editingId === waypoint.id) {
      const input = document.createElement("input");
      input.className = "scp-waypoint-name-input";
      input.dataset.id = waypoint.id;
      input.maxLength = EDIT_INPUT_MAX;
      input.value = waypoint.name;
      input.setAttribute("aria-label", "Waypoint name");
      input.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.code === "Enter" || event.code === "NumpadEnter") {
          event.preventDefault();
          event.stopPropagation();
          commitEdit(waypoint.id, input, waypoint.name);
          return;
        }
        if (event.code === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          editingId = null;
          renderList();
        }
      });
      input.addEventListener("blur", () => {
        if (editingId === waypoint.id) commitEdit(waypoint.id, input, waypoint.name);
      });
      main.appendChild(input);
    } else {
      const name = document.createElement("button");
      name.type = "button";
      name.className = "scp-waypoint-name";
      name.textContent = waypoint.name;
      name.title = "Rename waypoint";
      name.addEventListener("click", () => beginEdit(waypoint.id));
      main.appendChild(name);
    }
    const area = document.createElement("span");
    area.className = "scp-waypoint-area";
    main.appendChild(area);

    const distance = document.createElement("span");
    distance.className = "scp-waypoint-distance";

    const actions = document.createElement("div");
    actions.className = "scp-waypoint-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "scp-waypoint-action";
    toggle.dataset.action = "toggle";
    const del = document.createElement("button");
    del.type = "button";
    del.className = "scp-waypoint-action";
    del.dataset.action = "delete";
    del.textContent = "DELETE";
    actions.append(toggle, del);

    row.append(marker, main, distance, actions);
    rowNodes.set(waypoint.id, { row, area, distance, toggle });
    row.dataset.planet = planetLabel;
    return row;
  }

  function refreshDynamicFields(): void {
    const currentAreaId = state.activeAreaId;
    const playerX = state.player.x + 0.5;
    const playerY = state.player.y + 0.5;
    for (const waypoint of waypoints()) {
      const nodes = rowNodes.get(waypoint.id);
      if (!nodes) continue;
      const planetLabel = nodes.row.dataset.planet || planetLabelForArea(slice, waypoint.areaId);
      nodes.row.toggleAttribute("data-active", waypoint.active);
      nodes.area.textContent = `${areaLabelFor(slice, waypoint.areaId)} · ${Math.round(waypoint.x)}:${Math.round(waypoint.y)}`;
      if (waypoint.areaId === currentAreaId) {
        const distance = Math.hypot(waypoint.x + 0.5 - playerX, waypoint.y + 0.5 - playerY);
        nodes.distance.textContent = `${Math.round(distance)}m`;
        nodes.distance.dataset.local = "true";
      } else {
        nodes.distance.textContent = planetLabel;
        delete nodes.distance.dataset.local;
      }
      nodes.toggle.textContent = waypoint.active ? "DEACTIVATE" : "ACTIVATE";
    }
  }

  renderList();

  return {
    root,
    update(): void {
      if (appliedVersion !== waypointStoreVersion()) renderList();
      refreshDynamicFields();
    },
    onResized(): void {},
    dispose(): void {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(statusFlashTimer);
      root.remove();
    },
  };
}

function groupedWaypoints(slice: WindowContext["slice"], rows: readonly Waypoint[]): PlanetGroup[] {
  const groups: PlanetGroup[] = [];
  for (const waypoint of rows) {
    const label = planetLabelForArea(slice, waypoint.areaId);
    let group = groups.find((entry) => entry.key === label);
    if (!group) {
      group = { key: label, label, rows: [] };
      groups.push(group);
    }
    group.rows.push(waypoint);
  }
  groups.sort((a, b) => a.label.localeCompare(b.label));
  for (const group of groups) group.rows.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return groups;
}

function planetLabelForArea(slice: WindowContext["slice"], areaId: string): string {
  const catalog = travelCatalogFrom(slice);
  const planet = catalog?.planets.find((entry) => entry.areaId === areaId) ?? null;
  return (planet?.label ?? areaId).toUpperCase();
}

function areaLabelFor(slice: WindowContext["slice"], areaId: string): string {
  return (slice.areas.find((area) => area.id === areaId)?.name ?? areaId).toUpperCase();
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/gu, "\\$&");
}

function ref(root: ParentNode, name: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${name}"]`);
  if (!el) throw new Error(`waypoints pane: missing data-ref="${name}"`);
  return el;
}
