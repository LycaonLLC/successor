// Device-code approval. The requesting client shows the code and what it is;
// the signed-in browser decides. One form, two explicit decisions.
import { api as realApi } from "../api/client";
import type { Api } from "../api/client";
import {
  clearFieldErrors,
  refreshSession,
  renderDevices,
  setBusy,
  setFieldError,
  setFormStatus,
  showApiStatus,
} from "./session";

export function normalizeUserCode(raw: string): string {
  return raw.trim().replace(/[\s-]+/g, "").toUpperCase();
}

export function initConnectPage(doc: Document, api: Api = realApi): void {
  const bootstrap = async (): Promise<void> => {
    const active = await refreshSession(doc, api);
    if (active) await renderDevices(doc, api);
  };
  void bootstrap();

  const form = doc.getElementById("device-decision-form");
  if (!(form instanceof HTMLFormElement)) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submitter = event instanceof SubmitEvent ? event.submitter : null;
    void (async () => {
      clearFieldErrors(form);
      setFormStatus(form, "");
      const resultNote = doc.getElementById("decision-result");
      if (resultNote) {
        resultNote.hidden = true;
        resultNote.textContent = "";
      }
      const input = doc.getElementById("device-code");
      const code = input instanceof HTMLInputElement ? normalizeUserCode(input.value) : "";
      if (code.length < 4) {
        setFieldError(doc, "device-code", "That is not a complete code.");
        return;
      }
      const decision =
        submitter instanceof HTMLButtonElement && submitter.value === "denied"
          ? "denied"
          : "approved";
      const button = submitter instanceof HTMLButtonElement ? submitter : null;
      if (button) setBusy(button, true);
      const outcome = await api.deviceDecision(code, decision);
      if (button) setBusy(button, false);
      if (!outcome.ok) {
        if (outcome.error.kind === "unavailable") {
          showApiStatus(doc, outcome.error);
          setFormStatus(form, "Service unreachable — see the notice above.");
        } else {
          setFormStatus(form, outcome.error.message);
        }
        return;
      }
      if (resultNote) {
        resultNote.hidden = false;
        resultNote.textContent =
          decision === "approved"
            ? "Approved. The device picks it up on its next check — give it a few seconds."
            : "Denied. The code is gone; the client will say so.";
      }
      if (input instanceof HTMLInputElement) input.value = "";
      await renderDevices(doc, api);
    })();
  });
}
