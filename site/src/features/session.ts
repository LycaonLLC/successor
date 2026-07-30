// Shared session plumbing for the account, connect, and play pages.
// Session truth lives in the HttpOnly cookie; these helpers only reflect
// what /alpha-api/session reports into the page.
import type { Api } from "../api/client";
import type { ApiError } from "../api/types";

export type SessionState = "unknown" | "none" | "active";

export function showApiStatus(
  doc: Document,
  error: ApiError | null,
  options: { quiet?: boolean } = {},
): void {
  const el = doc.getElementById("api-status");
  if (!el) return;
  if (error && error.kind === "unavailable") {
    // A failed background probe is ambient information; a failed user action
    // is an event. Only the second one gets the loud treatment.
    el.textContent = options.quiet
      ? "The account service is not reachable right now. This page stays read-only until it comes back."
      : error.message;
    el.classList.toggle("quiet", options.quiet === true);
    el.classList.toggle("error", options.quiet !== true);
    el.hidden = false;
  } else {
    el.textContent = "";
    el.classList.remove("quiet", "error");
    el.hidden = true;
  }
}

export function setSessionState(doc: Document, state: SessionState): void {
  doc.body.dataset.sessionState = state;
  const active = state === "active";
  for (const section of doc.querySelectorAll<HTMLElement>(".session-gated")) {
    section.hidden = !active;
  }
  const benches = doc.getElementById("auth-benches");
  if (benches) benches.hidden = active;
  const signinFirst = doc.getElementById("signin-first");
  if (signinFirst) signinFirst.hidden = state !== "none";
}

export async function refreshSession(doc: Document, api: Api): Promise<boolean> {
  const result = await api.session();
  if (!result.ok) {
    // 401 is simply "signed out"; only an unreachable service gets a notice.
    if (result.error.kind === "unavailable") {
      showApiStatus(doc, result.error, { quiet: true });
    } else {
      showApiStatus(doc, null);
    }
    setSessionState(doc, "none");
    return false;
  }
  showApiStatus(doc, null);
  const session = result.value;
  const active = typeof session.callsign === "string" && session.callsign.length > 0;
  setSessionState(doc, active ? "active" : "none");
  if (active) {
    for (const slot of doc.querySelectorAll<HTMLElement>('[data-slot="session-callsign"]')) {
      slot.textContent = session.callsign;
    }
    doc.body.dataset.maxCharacters = String(session.setup?.maxCharacters ?? 5);
  }
  return active;
}

export function setBusy(button: HTMLButtonElement, busy: boolean): void {
  if (busy) {
    button.dataset.idleLabel = button.textContent ?? "";
    button.textContent = button.dataset.busyLabel ?? "Working…";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  } else {
    button.textContent = button.dataset.idleLabel ?? button.textContent;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

export function setFormStatus(form: HTMLElement, message: string, kind: "info" | "error" | "success" = "info"): void {
  const status = form.querySelector<HTMLElement>(".form-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", kind === "error" && message.length > 0);
  status.classList.toggle("is-success", kind === "success" && message.length > 0);
}

export function setFieldError(doc: Document, inputId: string, message: string): void {
  const input = doc.getElementById(inputId);
  const field = input?.closest<HTMLElement>(".field") ?? null;
  const target =
    field?.querySelector<HTMLElement>(".field-error") ??
    doc.querySelector<HTMLElement>(`.field-error[data-for="${inputId}"]`);
  if (target) {
    if (!target.id) target.id = `${inputId}-error`;
    target.textContent = message;
  }
  field?.classList.toggle("invalid", message.length > 0);
  if (input instanceof HTMLInputElement || input instanceof HTMLSelectElement) {
    if (message.length > 0) {
      input.setAttribute("aria-invalid", "true");
      if (target?.id) input.setAttribute("aria-describedby", target.id);
    } else {
      input.removeAttribute("aria-invalid");
      // Keep static aria-describedby (hints) if the markup set one; only clear
      // the error wiring we added.
      if (target?.id && input.getAttribute("aria-describedby") === target.id) {
        input.removeAttribute("aria-describedby");
      }
    }
  }
}

export function clearFieldErrors(form: HTMLElement): void {
  for (const el of form.querySelectorAll<HTMLElement>(".field-error")) el.textContent = "";
  for (const el of form.querySelectorAll<HTMLElement>(".field.invalid")) {
    el.classList.remove("invalid");
  }
  for (const el of form.querySelectorAll<HTMLElement>("[aria-invalid='true']")) {
    el.removeAttribute("aria-invalid");
  }
}

/** Move keyboard focus to the first invalid control in a form, without scrolling the page. */
export function focusFirstInvalid(form: HTMLElement): void {
  const invalid =
    form.querySelector<HTMLElement>(".field.invalid input, .field.invalid select, [aria-invalid='true']") ??
    form.querySelector<HTMLElement>(".field-error:not(:empty)");
  if (invalid && "focus" in invalid && typeof invalid.focus === "function") {
    invalid.focus({ preventScroll: true });
  }
}

export async function renderDevices(doc: Document, api: Api): Promise<void> {
  const list = doc.getElementById("device-list");
  const status = doc.getElementById("devices-status");
  if (!list) return;
  const result = await api.deviceList();
  if (!result.ok) {
    if (status) status.textContent = result.error.message;
    return;
  }
  list.textContent = "";
  const devices = result.value.devices;
  if (status) status.textContent = devices.length === 0 ? "No devices approved yet." : "";
  for (const device of devices) {
    const li = doc.createElement("li");
    const name = doc.createElement("strong");
    name.textContent = device.clientId;
    const meta = doc.createElement("span");
    meta.className = "device-meta";
    meta.textContent = `${device.kind} · ${device.status}`;
    const revoke = doc.createElement("button");
    revoke.type = "button";
    revoke.className = "btn btn-secondary";
    revoke.dataset.busyLabel = "Revoking…";
    revoke.textContent = "Revoke";
    revoke.setAttribute("aria-label", `Revoke ${device.clientId}`);
    revoke.addEventListener("click", () => {
      void (async () => {
        setBusy(revoke, true);
        const outcome = await api.deviceRevoke(device.id);
        setBusy(revoke, false);
        if (!outcome.ok) {
          if (outcome.error.kind === "unavailable") showApiStatus(doc, outcome.error);
          else if (status) status.textContent = outcome.error.message;
          return;
        }
        await renderDevices(doc, api);
      })();
    });
    li.append(name, meta, revoke);
    list.append(li);
  }
}
