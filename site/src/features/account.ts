// Account page: register, sign in, roster, the character workshop, devices,
// deletion. Every success state below renders what the server reported —
// never an assumed outcome. Unavailable endpoints surface as the #api-status
// notice. Character creation lives in the embedded client workshop
// (see creator.ts); there is no plain form and no silent fallback to one.
import { api as realApi } from "../api/client";
import type { Api } from "../api/client";
import type { ApiError, Character } from "../api/types";
import { storeSelectedCharacterId } from "./characterHandoff";
import { initCreatorStage } from "./creator";
import {
  clearFieldErrors,
  focusFirstInvalid,
  refreshSession,
  renderDevices,
  setBusy,
  setFieldError,
  setFormStatus,
  showApiStatus,
} from "./session";

export const LEGAL_VERSION = "2026-07-24";
export const CALLSIGN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;

function reportFailure(doc: Document, form: HTMLElement, error: ApiError): void {
  if (error.kind === "unavailable") {
    showApiStatus(doc, error);
    setFormStatus(form, "Service unreachable — see the notice above.", "error");
  } else {
    setFormStatus(form, error.message, "error");
  }
}

/**
 * After an interactive sign-in or registration the player is still looking at
 * the benches. Move keyboard focus to the workshop heading without scrolling
 * the page (no activation scroll). Reduced-motion and layout stay as-is.
 */
function revealWorkshop(doc: Document): void {
  const section = doc.getElementById("creator-section");
  if (!(section instanceof HTMLElement) || section.hidden) return;
  const focusTarget =
    doc.getElementById("h-creator") ??
    section.querySelector<HTMLElement>("h2, [tabindex]") ??
    section;
  if (!focusTarget.hasAttribute("tabindex") && focusTarget.id === "h-creator") {
    focusTarget.setAttribute("tabindex", "-1");
  }
  focusTarget.focus({ preventScroll: true });
}

function inputValue(doc: Document, id: string): string {
  const el = doc.getElementById(id);
  return el instanceof HTMLInputElement ? el.value : "";
}

function professionLabel(professionId: string): string {
  if (professionId.length === 0) return "Unassigned";
  return professionId.charAt(0).toUpperCase() + professionId.slice(1);
}

function rosterMetaCopy(character: Character): string {
  const profession = professionLabel(character.initialProfessionId ?? "");
  if (!character.worldEntryClaimed) {
    // Pending first world entry — the slot is held, entry not yet claimed.
    return `${profession} · waiting to enter`;
  }
  return `${profession} · in the world`;
}

async function renderRoster(
  doc: Document,
  api: Api,
  navigate: (path: string) => void,
): Promise<void> {
  const list = doc.getElementById("roster-list");
  const status = doc.getElementById("roster-status");
  const retry = doc.getElementById("roster-retry");
  if (!list) return;
  list.setAttribute("aria-busy", "true");
  const result = await api.characters();
  list.removeAttribute("aria-busy");
  if (!result.ok) {
    list.textContent = "";
    if (status) {
      status.textContent =
        result.error.kind === "unavailable"
          ? "Could not load characters. Try again."
          : result.error.message;
      status.classList.add("is-error");
    }
    if (retry instanceof HTMLButtonElement) retry.hidden = false;
    if (result.error.kind === "unavailable") showApiStatus(doc, result.error, { quiet: true });
    return;
  }
  if (retry instanceof HTMLButtonElement) retry.hidden = true;
  list.textContent = "";
  const { characters } = result.value;
  const slots = Number(doc.body.dataset.maxCharacters ?? "5");
  if (status) {
    status.classList.remove("is-error");
    if (characters.length === 0) {
      status.textContent = "No characters yet — make one in the workshop above.";
    } else {
      status.textContent = `${characters.length} of ${slots} slots used.`;
    }
  }
  for (const character of characters) {
    const li = doc.createElement("li");
    li.className = "roster-row";

    const body = doc.createElement("div");
    body.className = "roster-body";

    const name = doc.createElement("span");
    name.className = "roster-name";
    name.textContent = character.name;

    const meta = doc.createElement("span");
    meta.className = "roster-meta";
    meta.textContent = rosterMetaCopy(character);

    body.append(name, meta);

    // This Enter is the only confirmation. /play/ consumes the one-shot
    // character id and opens the 3D client directly.
    const choose = doc.createElement("button");
    choose.type = "button";
    choose.className = "btn btn-secondary roster-launch";
    choose.textContent = "Enter";
    choose.setAttribute("aria-label", `Enter the field as ${character.name}`);
    choose.addEventListener("click", () => {
      const win = doc.defaultView;
      if (win) storeSelectedCharacterId(win, character.id);
      navigate("/play/");
    });

    li.append(body, choose);
    list.append(li);
  }
}

export function initAccountPage(
  doc: Document,
  api: Api = realApi,
  navigate?: (path: string) => void,
): void {
  const win = doc.defaultView;
  const go =
    navigate ??
    ((path: string) => {
      win?.location.assign(path);
    });

  const creator = initCreatorStage(doc, api, {
    navigate: go,
    onRosterChanged: () => void renderRoster(doc, api, go),
  });

  const bootstrap = async (): Promise<void> => {
    const active = await refreshSession(doc, api);
    if (!active) {
      // Session gone (logout, expiry, deletion): tear the workshop down so
      // no frame or roster copy outlives the account it belonged to.
      creator.deactivate();
      const list = doc.getElementById("roster-list");
      if (list) list.textContent = "";
      const rosterStatus = doc.getElementById("roster-status");
      if (rosterStatus) {
        rosterStatus.textContent = "";
        rosterStatus.classList.remove("is-error");
      }
      const rosterRetry = doc.getElementById("roster-retry");
      if (rosterRetry instanceof HTMLButtonElement) rosterRetry.hidden = true;
      return;
    }
    creator.activate();
    await Promise.all([renderRoster(doc, api, go), renderDevices(doc, api), creator.refresh()]);
  };
  void bootstrap();

  const rosterRetry = doc.getElementById("roster-retry");
  if (rosterRetry instanceof HTMLButtonElement) {
    rosterRetry.addEventListener("click", () => {
      void renderRoster(doc, api, go);
    });
  }

  const loginForm = doc.getElementById("login-form");
  if (loginForm instanceof HTMLFormElement) {
    loginForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        clearFieldErrors(loginForm);
        setFormStatus(loginForm, "");
        const callsign = inputValue(doc, "login-callsign").trim();
        const password = inputValue(doc, "login-password");
        let invalid = false;
        if (callsign.length === 0) {
          setFieldError(doc, "login-callsign", "Callsign first.");
          invalid = true;
        }
        if (password.length === 0) {
          setFieldError(doc, "login-password", "Password too.");
          invalid = true;
        }
        if (invalid) {
          focusFirstInvalid(loginForm);
          return;
        }
        const button = loginForm.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button) setBusy(button, true);
        const result = await api.login({ callsign, password });
        if (button) setBusy(button, false);
        if (!result.ok) {
          reportFailure(doc, loginForm, result.error);
          focusFirstInvalid(loginForm);
          return;
        }
        loginForm.reset();
        setFormStatus(loginForm, "Signed in.", "success");
        await bootstrap();
        revealWorkshop(doc);
      })();
    });
  }

  const registerForm = doc.getElementById("register-form");
  if (registerForm instanceof HTMLFormElement) {
    registerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        clearFieldErrors(registerForm);
        setFormStatus(registerForm, "");
        const callsign = inputValue(doc, "reg-callsign").trim();
        const password = inputValue(doc, "reg-password");
        const repeat = inputValue(doc, "reg-password-repeat");
        const legal = doc.getElementById("reg-legal");
        const legalAccepted = legal instanceof HTMLInputElement && legal.checked;
        let invalid = false;
        if (!CALLSIGN_PATTERN.test(callsign)) {
          setFieldError(
            doc,
            "reg-callsign",
            "3–24 characters: letters, numbers, dashes. Starts and ends with a letter or number.",
          );
          invalid = true;
        }
        if (password.length < 10) {
          setFieldError(doc, "reg-password", "At least 10 characters.");
          invalid = true;
        }
        if (repeat !== password) {
          setFieldError(doc, "reg-password-repeat", "These do not match.");
          invalid = true;
        }
        if (!legalAccepted) {
          setFieldError(doc, "reg-legal", "Required — read them, they are short.");
          invalid = true;
        }
        if (invalid) {
          focusFirstInvalid(registerForm);
          return;
        }
        const button = registerForm.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button) setBusy(button, true);
        const result = await api.register({
          callsign,
          password,
          legal: { terms: LEGAL_VERSION, privacy: LEGAL_VERSION },
        });
        if (button) setBusy(button, false);
        if (!result.ok) {
          if (result.error.kind === "rejected" && result.error.code === "callsign_taken") {
            setFieldError(doc, "reg-callsign", result.error.message);
          } else {
            reportFailure(doc, registerForm, result.error);
          }
          focusFirstInvalid(registerForm);
          return;
        }
        registerForm.reset();
        setFormStatus(
          registerForm,
          "Account created. You are signed in — now write that password down.",
          "success",
        );
        await bootstrap();
        revealWorkshop(doc);
      })();
    });
  }

  const logoutButton = doc.getElementById("logout-button");
  if (logoutButton instanceof HTMLButtonElement) {
    logoutButton.addEventListener("click", () => {
      void (async () => {
        setBusy(logoutButton, true);
        const result = await api.logout();
        setBusy(logoutButton, false);
        if (!result.ok && result.error.kind === "unavailable") {
          showApiStatus(doc, result.error);
          return;
        }
        await bootstrap();
        const callsign = doc.getElementById("login-callsign");
        if (callsign instanceof HTMLInputElement) callsign.focus({ preventScroll: true });
      })();
    });
  }

  const deleteForm = doc.getElementById("delete-form");
  if (deleteForm instanceof HTMLFormElement) {
    deleteForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        clearFieldErrors(deleteForm);
        setFormStatus(deleteForm, "");
        const password = inputValue(doc, "delete-password");
        const confirm = doc.getElementById("delete-confirm");
        if (password.length === 0) {
          setFieldError(doc, "delete-password", "Password required — deletion is not casual.");
          focusFirstInvalid(deleteForm);
          return;
        }
        if (!(confirm instanceof HTMLInputElement) || !confirm.checked) {
          setFormStatus(deleteForm, "Tick the box if you mean it.", "error");
          confirm?.focus({ preventScroll: true });
          return;
        }
        const button = deleteForm.querySelector<HTMLButtonElement>('button[type="submit"]');
        if (button) setBusy(button, true);
        const result = await api.deleteAccount(password);
        if (button) setBusy(button, false);
        if (!result.ok) {
          reportFailure(doc, deleteForm, result.error);
          focusFirstInvalid(deleteForm);
          return;
        }
        deleteForm.reset();
        await bootstrap();
        const callsign = doc.getElementById("login-callsign");
        if (callsign instanceof HTMLInputElement) callsign.focus({ preventScroll: true });
      })();
    });
  }
}
