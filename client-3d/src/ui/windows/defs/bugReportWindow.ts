import {
  BugReportSubmissionError,
  bugReportBodyMaxCharacters,
  bugReportBodyMinCharacters,
  type AcceptedBugReport,
  type BugReportCategory,
  type BugReportSubmission,
} from "@successor/client/src/slice-core/bugReportSystem";
import type { WindowContentHandle, WindowDefinition } from "../windowManager";

export const BUG_REPORT_WINDOW_ID = "bugReport";

export interface BugReportWindowDeps {
  readonly submit: (report: BugReportSubmission) => Promise<AcceptedBugReport>;
  readonly diagnostics: () => Readonly<Record<string, unknown>>;
  readonly requestId?: () => string;
}

export function bugReportSlashLine(line: string, open: () => void): string | null {
  if (!/^\/bugreport(?:\s.*)?$/iu.test(line.trim())) return null;
  open();
  return "BUG REPORT OPEN";
}

export function createBugReportWindowDefinition(deps: BugReportWindowDeps): WindowDefinition {
  return {
    id: BUG_REPORT_WINDOW_ID,
    title: "REPORT",
    icon: "bug-report",
    hotkey: null,
    minWidth: 420,
    minHeight: 390,
    dockVisible: false,
    transient: true,
    boundsRevision: 1,
    defaultBounds: (viewport) => {
      const w = Math.min(540, Math.max(420, Math.round(viewport.w * 0.42)));
      const h = Math.min(560, Math.max(390, Math.round(viewport.h * 0.58)));
      return {
        x: Math.max(12, Math.round((viewport.w - w) / 2)),
        y: Math.max(40, Math.round((viewport.h - h) / 2)),
        w,
        h,
      };
    },
    mount: (contentRoot) => mountBugReportWindow(contentRoot, deps),
  };
}

function mountBugReportWindow(
  contentRoot: HTMLElement,
  deps: BugReportWindowDeps,
): WindowContentHandle {
  const root = document.createElement("div");
  root.className = "scp-root scp-bugreport";
  root.innerHTML = `
    <form class="scp-bugreport-form" data-ref="form">
      <p class="scp-bugreport-intro">Tell us what broke, what you expected, and what you did just before it happened.</p>
      <label class="scp-bugreport-field scp-bugreport-category">
        <span>AREA</span>
        <select data-ref="category" aria-label="Bug area">
          <option value="gameplay">Gameplay</option>
          <option value="interface">Interface</option>
          <option value="connection">Connection</option>
          <option value="graphics_audio">Graphics / audio</option>
          <option value="other">Other</option>
        </select>
      </label>
      <label class="scp-bugreport-field scp-bugreport-body">
        <span>WHAT HAPPENED?</span>
        <textarea data-ref="body" minlength="${bugReportBodyMinCharacters}"
          maxlength="${bugReportBodyMaxCharacters}" aria-describedby="scp-bugreport-help"
          placeholder="Where were you? What did you try? What happened instead? Can you make it happen again?"></textarea>
      </label>
      <div class="scp-bugreport-help" id="scp-bugreport-help">
        Names, exact steps, and whether it happened twice are especially useful.
      </div>
      <details class="scp-bugreport-diagnostics">
        <summary>SESSION LOG ATTACHED</summary>
        <p>Includes build and shard IDs, location, client errors, connection health, input settings, open windows, and recent command receipts. It never includes passwords, tickets, cookies, chat, or inventory contents.</p>
      </details>
      <footer class="scp-bugreport-actions">
        <span class="scp-bugreport-count" data-ref="count">0 / ${bugReportBodyMaxCharacters.toLocaleString()}</span>
        <span class="scp-bugreport-status" data-ref="status" role="status" aria-live="polite"></span>
        <button class="scp-bugreport-submit" data-ref="submit" type="submit" disabled>SEND REPORT</button>
      </footer>
    </form>
    <section class="scp-bugreport-received" data-ref="received" hidden>
      <span class="scp-bugreport-received-mark" aria-hidden="true">✓</span>
      <h2>REPORT RECEIVED</h2>
      <p>Your session log and notes are together in the queue.</p>
      <code data-ref="reportId"></code>
      <button class="scp-bugreport-again" data-ref="again" type="button">ANOTHER REPORT</button>
    </section>
  `;
  contentRoot.appendChild(root);

  const form = mustRef<HTMLFormElement>(root, "form");
  const category = mustRef<HTMLSelectElement>(root, "category");
  const body = mustRef<HTMLTextAreaElement>(root, "body");
  const count = mustRef<HTMLElement>(root, "count");
  const status = mustRef<HTMLElement>(root, "status");
  const submit = mustRef<HTMLButtonElement>(root, "submit");
  const received = mustRef<HTMLElement>(root, "received");
  const reportId = mustRef<HTMLElement>(root, "reportId");
  const again = mustRef<HTMLButtonElement>(root, "again");
  let submitting = false;
  let focused = false;

  const updateControls = (): void => {
    const length = body.value.trim().length;
    count.textContent = `${length.toLocaleString()} / ${bugReportBodyMaxCharacters.toLocaleString()}`;
    submit.disabled = submitting || length < bugReportBodyMinCharacters;
    submit.textContent = submitting ? "SENDING…" : "SEND REPORT";
  };

  const send = async (): Promise<void> => {
    const reportBody = body.value.trim();
    if (submitting || reportBody.length < bugReportBodyMinCharacters) return;
    submitting = true;
    status.textContent = "PACKING SESSION LOG…";
    status.removeAttribute("data-denied");
    updateControls();
    const requestId = deps.requestId?.() ?? createRequestId();
    try {
      const accepted = await deps.submit({
        schema: "successor.bug-report-submission.v1",
        requestId,
        category: category.value as BugReportCategory,
        body: reportBody,
        diagnostics: deps.diagnostics(),
      });
      body.value = "";
      form.hidden = true;
      received.hidden = false;
      reportId.textContent = accepted.reportId;
      status.textContent = "";
    } catch (error) {
      const reasonCode = error instanceof BugReportSubmissionError
        ? error.reasonCode
        : "unavailable";
      status.textContent = reportErrorCopy(reasonCode);
      status.toggleAttribute("data-denied", true);
    } finally {
      submitting = false;
      updateControls();
    }
  };

  body.addEventListener("input", updateControls);
  body.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void send();
  });
  form.addEventListener("submit", (event: SubmitEvent) => {
    event.preventDefault();
    void send();
  });
  again.addEventListener("click", () => {
    received.hidden = true;
    form.hidden = false;
    category.value = "gameplay";
    status.textContent = "";
    status.removeAttribute("data-denied");
    updateControls();
    body.focus();
  });
  updateControls();

  return {
    update(): void {
      if (!focused) {
        focused = true;
        body.focus();
      }
    },
    onResized(): void {},
    dispose(): void {
      root.remove();
    },
  };
}

function reportErrorCopy(reasonCode: string): string {
  if (reasonCode === "rate_limited") return "QUEUE BUSY · TRY AGAIN IN A MINUTE";
  if (reasonCode === "invalid_report") return "REPORT NEEDS MORE DETAIL";
  return "NO LINK · YOUR REPORT IS KEPT, TRY AGAIN";
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mustRef<T extends Element>(root: ParentNode, name: string): T {
  const element = root.querySelector<T>(`[data-ref="${name}"]`);
  if (!element) throw new Error(`bug report window missing ${name}`);
  return element;
}
