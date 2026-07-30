import type { WindowContentHandle, WindowContext, WindowDefinition } from "../windowManager";
import { createRejectWatcher } from "./commandReceipts";
import {
  activeTravelTerminal,
  heldTicketsForTerminal,
  nearestTerminalInRange,
  setActiveTravelTerminal,
  terminalContext,
  travelCatalogFrom,
  withinTerminalRange,
  type TravelCatalog,
  type TravelPlanet,
} from "../../travel/travelSystem";
import { purchaseTravelTicket, useTravelTicket } from "../../travel/travelActions";
import { planetMapSvg } from "../../travel/planetChart";

/**
 * TRAVEL — the terminal's screen, windowed (Planetfall v1).
 *
 * Layout: square planetary map (left) + destination controls (right).
 * The map is the future star of the feature — v1 already renders the real
 * catalog: a stylized planet chart per destination planet with CLICKABLE
 * city markers, so "click the city on the map" and "pick from the dropdown"
 * are the same selection from day one. Cities we don't have yet will simply
 * appear as more markers.
 *
 * Rules mirrored from the server (honest affordances, server re-validates):
 * - a terminal never sells passage to ITSELF (same planet+city disabled);
 * - TRAVEL NOW gates on live ≤10-cell proximity to the ORIGIN terminal.
 *
 * Transient window: opens from a terminal interaction, never restored at
 * boot, no dock button — it is the terminal's screen, not a HUD panel.
 */

const STATUS_FLASH_MS = 3200;

export function createTravelWindowDefinition(): WindowDefinition {
  return {
    id: "travel",
    title: "TRAVEL",
    icon: "travel",
    hotkey: null,
    minWidth: 560,
    minHeight: 360,
    dockVisible: false,
    transient: true,
    defaultBounds: (viewport) => {
      const w = Math.max(560, Math.round(viewport.w * 0.44));
      const h = Math.max(360, Math.round(viewport.h * 0.5));
      return { x: Math.round((viewport.w - w) / 2), y: Math.round((viewport.h - h) * 0.42), w, h };
    },
    mount: (contentRoot, ctx) => mountTravelContent(contentRoot, ctx),
  };
}

function mountTravelContent(contentRoot: HTMLElement, ctx: WindowContext): WindowContentHandle {
  const { state, slice } = ctx;
  const root = document.createElement("div");
  root.className = "scp-root scp-travel";
  root.innerHTML = `
    <header class="scp-travel-head">
      <span class="scp-travel-origin" data-ref="origin">NO TERMINAL LINK</span>
      <span class="scp-travel-headnote">TRANSIT AUTHORITY · PASSAGE FREE</span>
    </header>
    <div class="scp-travel-body">
      <div class="scp-travel-map" data-ref="map"></div>
      <div class="scp-travel-controls">
        <label class="scp-travel-field">PLANET
          <select class="scp-select" data-ref="planet"></select>
        </label>
        <label class="scp-travel-field">CITY
          <select class="scp-select" data-ref="city"></select>
        </label>
        <div class="scp-travel-summary" data-ref="summary"></div>
        <button type="button" class="scp-travel-print" data-ref="print">PRINT TICKET</button>
        <div class="scp-travel-tickets">
          <div class="scp-travel-tickets-head">HELD TICKETS · THIS TERMINAL</div>
          <div class="scp-travel-tickets-list" data-ref="tickets"></div>
        </div>
      </div>
    </div>
    <footer class="scp-status-foot">
      <span class="scp-status-line" data-ref="status"></span>
    </footer>
  `;
  contentRoot.appendChild(root);

  const originEl = mustRef(root, "origin");
  const mapEl = mustRef(root, "map");
  const planetEl = mustRef(root, "planet") as HTMLSelectElement;
  const cityEl = mustRef(root, "city") as HTMLSelectElement;
  const summaryEl = mustRef(root, "summary");
  const printEl = mustRef(root, "print") as HTMLButtonElement;
  const ticketsEl = mustRef(root, "tickets");
  const statusEl = mustRef(root, "status");

  const rejectWatcher = createRejectWatcher(state, ["PurchaseTravelTicket", "UseTravelTicket"]);

  let selectedPlanetId: string | null = null;
  let selectedCityId: string | null = null;
  let renderKey = "";
  let mapKey = "";
  let statusFlashUntil = 0;
  let lastHeldCount = -1;

  const flashStatus = (text: string, timeMs: number): void => {
    statusEl.textContent = text;
    statusFlashUntil = timeMs + STATUS_FLASH_MS;
  };

  planetEl.addEventListener("change", () => {
    selectedPlanetId = planetEl.value || null;
    selectedCityId = null; // re-derive first legal city for the new planet
    renderKey = "";
  });
  cityEl.addEventListener("change", () => {
    selectedCityId = cityEl.value || null;
    renderKey = "";
  });
  printEl.addEventListener("click", () => {
    const terminalId = activeTravelTerminal();
    if (!terminalId || !selectedPlanetId || !selectedCityId) return;
    if (purchaseTravelTicket(state, slice, terminalId, selectedPlanetId, selectedCityId)) {
      flashStatus("PRINTING…", performance.now());
    }
  });
  mapEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-city]") : null;
    const cityId = target?.getAttribute("data-city");
    if (!cityId) return;
    selectedCityId = cityId;
    renderKey = "";
  });

  const update = (_dtSeconds: number, timeMs: number): void => {
    const catalog = travelCatalogFrom(slice);
    let terminalId = activeTravelTerminal();
    // Auto-link (journey lens): opened from the dock/`/ui` while standing at
    // a terminal — or holding a stale link with a DIFFERENT terminal in reach
    // — the window adopts the terminal beside you. The F-use path stays
    // canonical; out-of-range links keep the honest LINK LOST read.
    if (!terminalId || !withinTerminalRange(state, slice, terminalId)) {
      const nearby = nearestTerminalInRange(state, slice);
      if (nearby && nearby !== terminalId) {
        setActiveTravelTerminal(nearby);
        terminalId = nearby;
      }
    }
    const origin = catalog && terminalId ? terminalContext(catalog, terminalId) : null;

    const denied = rejectWatcher.poll();
    if (denied) flashStatus(denied, timeMs);

    if (!catalog || !terminalId || !origin) {
      originEl.textContent = "NO TERMINAL LINK";
      summaryEl.textContent = "";
      printEl.disabled = true;
      if (renderKey !== "offline") {
        renderKey = "offline";
        mapKey = "";
        mapEl.innerHTML = `<div class="scp-travel-map-offline">LINK A TERMINAL<br/>TO CHART PASSAGE</div>`;
        planetEl.innerHTML = "";
        cityEl.innerHTML = "";
        ticketsEl.innerHTML = "";
      }
      if (timeMs > statusFlashUntil) statusEl.textContent = "";
      return;
    }

    // ── Selection normalization (never the origin itself) ────────────────
    const planets = catalog.planets;
    const planetLegal = (planet: TravelPlanet): boolean =>
      planet.cities.some((city) => !(planet.id === origin.planet.id && city.id === origin.city.id));
    const selectedPlanet = planets.find((planet) => planet.id === selectedPlanetId && planetLegal(planet))
      ?? planets.find((planet) => planet.id !== origin.planet.id && planetLegal(planet))
      ?? planets.find(planetLegal)
      ?? null;
    selectedPlanetId = selectedPlanet?.id ?? null;
    const legalCities = selectedPlanet
      ? selectedPlanet.cities.filter((city) => !(selectedPlanet.id === origin.planet.id && city.id === origin.city.id))
      : [];
    const selectedCity = legalCities.find((city) => city.id === selectedCityId) ?? legalCities[0] ?? null;
    selectedCityId = selectedCity?.id ?? null;

    const held = heldTicketsForTerminal(state, terminalId);
    const inRange = withinTerminalRange(state, slice, terminalId);
    if (lastHeldCount >= 0 && held.length > lastHeldCount) {
      flashStatus("TICKET PRINTED · IN YOUR PACK", timeMs);
    }
    lastHeldCount = held.length;

    const nextKey = [
      terminalId,
      selectedPlanetId,
      selectedCityId,
      held.map((ticket) => ticket.data.ticketId).join(","),
      inRange ? "in" : "out",
    ].join("|");
    if (nextKey !== renderKey) {
      renderKey = nextKey;
      originEl.textContent = `${origin.planet.label.toUpperCase()} · ${origin.city.label.toUpperCase()}`;

      // Planet dropdown — origin-only planets stay listed but disabled (honest).
      planetEl.innerHTML = "";
      for (const planet of planets) {
        const option = document.createElement("option");
        option.value = planet.id;
        option.textContent = planet.label.toUpperCase();
        option.disabled = !planetLegal(planet);
        option.selected = planet.id === selectedPlanetId;
        planetEl.appendChild(option);
      }
      cityEl.innerHTML = "";
      for (const city of legalCities) {
        const option = document.createElement("option");
        option.value = city.id;
        option.textContent = city.label.toUpperCase();
        option.selected = city.id === selectedCityId;
        cityEl.appendChild(option);
      }

      summaryEl.textContent = !inRange
        ? "LINK LOST · RETURN TO TERMINAL"
        : selectedPlanet && selectedCity
          ? `${origin.city.label.toUpperCase()} → ${selectedCity.label.toUpperCase()}, ${selectedPlanet.label.toUpperCase()}`
          : "NO DESTINATION";
      printEl.disabled = !inRange || !(selectedPlanet && selectedCity);

      // Held tickets — one row per ticket, TRAVEL NOW gated on live range.
      ticketsEl.innerHTML = "";
      if (held.length === 0) {
        const empty = document.createElement("div");
        empty.className = "scp-travel-ticket-empty";
        empty.textContent = "NONE — PRINT ONE ABOVE";
        ticketsEl.appendChild(empty);
      }
      for (const ticket of held) {
        const destPlanet = planets.find((planet) => planet.id === ticket.data.toPlanetId);
        const destCity = destPlanet?.cities.find((city) => city.id === ticket.data.toCityId);
        const row = document.createElement("div");
        row.className = "scp-travel-ticket";
        const label = document.createElement("span");
        label.className = "scp-travel-ticket-dest";
        label.textContent = `→ ${(destCity?.label ?? ticket.data.toCityId).toUpperCase()}, ${(destPlanet?.label ?? ticket.data.toPlanetId).toUpperCase()}`;
        const go = document.createElement("button");
        go.type = "button";
        go.className = "scp-travel-go";
        go.textContent = "TRAVEL NOW";
        go.disabled = !inRange;
        go.title = inRange ? "Consume ticket and depart" : "Step within 10 cells of this terminal";
        go.addEventListener("click", () => {
          if (useTravelTicket(state, slice, ticket)) flashStatus("BOARDING…", performance.now());
        });
        row.appendChild(label);
        row.appendChild(go);
        ticketsEl.appendChild(row);
      }

      // Map re-render only when the CHART changes (planet or selection).
      const nextMapKey = `${selectedPlanetId}|${selectedCityId}`;
      if (nextMapKey !== mapKey && selectedPlanet) {
        mapKey = nextMapKey;
        mapEl.innerHTML = planetMapSvg(selectedPlanet, selectedCityId);
      }
    }

    if (timeMs > statusFlashUntil) statusEl.textContent = "";
  };

  return {
    update,
    onResized: () => {
      // Square map is CSS-driven (aspect-ratio); nothing to re-measure.
    },
    dispose: () => {
      contentRoot.innerHTML = "";
    },
  };
}


function mustRef(root: HTMLElement, ref: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-ref="${ref}"]`);
  if (!el) throw new Error(`travel window: missing ref ${ref}`);
  return el;
}

