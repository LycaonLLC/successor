import { getLaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import { runtimeBackendHttpBase } from "@successor/client/src/runtime/runtimeDefaults";
import { applyThemeVariables, SUCCESSOR_THEME } from "./theme";

export interface EntryScreenElements {
  shell: HTMLElement;
  stage: HTMLElement;
  canvasHost: HTMLElement;
  status: HTMLElement;
  setStatus: (message: string) => void;
  showStage: () => void;
}

/** Shape of the slice of GET /game/status this screen reads. */
interface FieldOfficeStatus {
  shardId?: string;
  actorCount?: number;
  sessionCount?: number;
  source?: {
    stateHash?: string;
    actorCount?: number;
  };
}

const STATUS_POLL_MS = 5_000;

export function renderEntryScreen(root: HTMLElement, onEnterWorld: () => void): EntryScreenElements {
  applyThemeVariables();
  const launchIdentity = getLaunchIdentity();
  const strings = SUCCESSOR_THEME.strings;
  root.innerHTML = `
    <main class="successor3d-shell" data-state="entry">
      <section class="successor3d-entry" aria-labelledby="successor3d-entry-title">
        <div class="successor3d-form">
          <header class="successor3d-form-head">
            <span>${strings.formNumber}</span>
            <span>${strings.formTitle}</span>
          </header>
          <h1 id="successor3d-entry-title" class="successor3d-masthead">${strings.masthead}</h1>
          <p class="successor3d-subline">${strings.subline}</p>
          <label class="successor3d-formline">
            <span>${strings.nameLabel}</span>
            <input id="successor3d-name" name="name" autocomplete="nickname" spellcheck="false" maxlength="32" />
          </label>
          <button id="successor3d-enter" type="button">${strings.enter}</button>
          <p id="successor3d-status" class="successor3d-entry-status" role="status">${strings.statusReady}</p>
          <footer class="successor3d-fineprint">
            <span id="successor3d-manifest">${strings.manifestPending}</span>
            <span id="successor3d-field-office">FIELD OFFICE · —</span>
            <span id="successor3d-slice">SLICE · —</span>
          </footer>
        </div>
      </section>
      <div id="successor3d-ribbon" class="successor3d-ribbon" hidden></div>
      <section class="successor3d-stage" aria-label="Successor 3D isometric world" hidden>
        <div id="successor3d-canvas-host" class="successor3d-canvas-host"></div>
      </section>
    </main>
  `;

  const shell = getRequired<HTMLElement>(root, ".successor3d-shell");
  const stage = getRequired<HTMLElement>(root, ".successor3d-stage");
  const canvasHost = getRequired<HTMLElement>(root, "#successor3d-canvas-host");
  const status = getRequired<HTMLElement>(root, "#successor3d-status");
  const ribbon = getRequired<HTMLElement>(root, "#successor3d-ribbon");
  const manifestLine = getRequired<HTMLElement>(root, "#successor3d-manifest");
  const fieldOfficeLine = getRequired<HTMLElement>(root, "#successor3d-field-office");
  const sliceLine = getRequired<HTMLElement>(root, "#successor3d-slice");
  const nameInput = getRequired<HTMLInputElement>(root, "#successor3d-name");
  const enterButton = getRequired<HTMLButtonElement>(root, "#successor3d-enter");
  nameInput.value = launchIdentity.displayName;

  const params = new URLSearchParams(window.location.search);
  const apiBase = runtimeBackendHttpBase({ gameWsUrl: launchIdentity.gameWsUrl, searchParams: params });
  const slicePath = params.get("slicePath");
  const sliceName = slicePath
    ? (slicePath.split("/").pop() ?? slicePath).replace(/\.json$/i, "").toUpperCase()
    : "OPEN-DESERT-SLICE (DEFAULT)";
  sliceLine.textContent = `SLICE · ${sliceName}`;

  let statusPollTimer = 0;
  const refreshFieldOfficeStatus = async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4_000);
    try {
      const response = await fetch(`${apiBase}/game/status`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const data = (await response.json()) as FieldOfficeStatus;
      const sourceHash = data.source?.stateHash ?? "UNKNOWN SOURCE";
      const roster = data.source?.actorCount ?? data.actorCount ?? 0;
      manifestLine.textContent = `MANIFEST · SRC ${sourceHash.toUpperCase()} · ROSTER ${roster}`;
      const shard = data.shardId ? ` · SHARD ${data.shardId.toUpperCase()}` : "";
      fieldOfficeLine.textContent = `FIELD OFFICE ${apiBase} · LIVE${shard}`;
    } catch {
      manifestLine.textContent = "MANIFEST · NOT ON FILE";
      fieldOfficeLine.textContent = `FIELD OFFICE ${apiBase} · UNREACHABLE`;
    } finally {
      window.clearTimeout(timeout);
    }
  };
  void refreshFieldOfficeStatus();
  statusPollTimer = window.setInterval(() => void refreshFieldOfficeStatus(), STATUS_POLL_MS);

  let submitted = false;
  const submit = () => {
    if (submitted) return;
    submitted = true;
    window.clearInterval(statusPollTimer);
    enterButton.disabled = true;
    enterButton.textContent = SUCCESSOR_THEME.strings.statusSubmitting;
    const name = nameInput.value.trim();
    if (name) {
      const url = new URL(window.location.href);
      url.searchParams.set("name", name);
      window.history.replaceState(null, "", url);
    }
    onEnterWorld();
  };

  enterButton.addEventListener("click", submit);
  nameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  if (params.get("autoEnter") === "1") {
    window.setTimeout(submit, 0);
  }

  return {
    shell,
    stage,
    canvasHost,
    status,
    setStatus(message: string) {
      status.textContent = message;
      // In world state, the entry form is gone; loading/error text rides a
      // small ribbon instead. The frame loop's steady "Server …" pump means
      // boot is done — the status plate owns the readout from there.
      if (shell.dataset.state === "world") {
        ribbon.textContent = message;
        ribbon.hidden = message.startsWith("Server ");
      }
    },
    showStage() {
      shell.dataset.state = "world";
      stage.hidden = false;
    },
  };
}

function getRequired<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}
