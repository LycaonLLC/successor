/**
 * Account-link shell renderer. Presentation only: every fact on screen comes
 * from the main-process snapshot pushed over the preload bridge. No network,
 * no storage, no timers beyond the expiry countdown. Secrets never arrive
 * here — the snapshot carries the human link code and stage/notice kinds.
 */

const bridge = window.__successorDesktop?.hosted ?? null;

const plate = document.getElementById("plate");
const el = {
  signinNotice: document.getElementById("signin-notice"),
  userCode: document.getElementById("user-code"),
  approvalHost: document.getElementById("approval-host"),
  openLabel: document.getElementById("open-label"),
  linkingStatus: document.getElementById("linking-status"),
  countdown: document.getElementById("countdown"),
  charactersNotice: document.getElementById("characters-notice"),
  roster: document.getElementById("roster"),
  rosterEmpty: document.getElementById("roster-empty"),
  persistNote: document.getElementById("persist-note"),
  btnStart: document.getElementById("btn-start"),
  btnOpen: document.getElementById("btn-open"),
  btnCopy: document.getElementById("btn-copy"),
  btnCancel: document.getElementById("btn-cancel"),
  btnEnter: document.getElementById("btn-enter"),
  btnRefresh: document.getElementById("btn-refresh"),
  btnCreate: document.getElementById("btn-create"),
  btnSignout: document.getElementById("btn-signout"),
};

// Player-facing words for semantic notice kinds. Dry and specific; the main
// process never sends prose.
const NOTICE_TEXT = {
  "denied": "The request was declined in your browser. Nothing was linked.",
  "expired": "That code expired. Codes only last a few minutes — get a new one.",
  "revoked": "This computer's link is no longer valid. Get a new code to continue.",
  "link-error": "The account service didn't answer. Check your connection and try again.",
  "characters-error": "Couldn't fetch your characters. Try refresh.",
  "launch-failed": "Couldn't enter the world. That attempt is fully discarded — enter again when ready.",
  "game-missing": "The game files are missing from this install.",
};

const BAD_NOTICES = new Set(["denied", "expired", "revoked", "link-error", "launch-failed", "game-missing"]);

let current = null;
let selectedCharacterId = null;
let countdownTimer = null;
let copiedTimer = null;

function noticeText(kind) {
  return kind ? (NOTICE_TEXT[kind] ?? "Something went wrong. Try again.") : "";
}

function applyNotice(target, kind) {
  target.textContent = noticeText(kind);
  if (kind && BAD_NOTICES.has(kind)) target.dataset.tone = "bad";
  else delete target.dataset.tone;
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function renderCountdown(expiresAt) {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    el.countdown.textContent = "Code expired.";
    stopCountdown();
    return;
  }
  const totalSec = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = String(totalSec % 60).padStart(2, "0");
  el.countdown.textContent = `Code expires in ${minutes}:${seconds}.`;
}

function renderRoster(characters) {
  el.roster.replaceChildren();
  const rows = Array.isArray(characters) ? characters : [];
  if (rows.length > 0 && !rows.some((row) => row.id === selectedCharacterId)) {
    selectedCharacterId = rows[0].id;
  }
  if (rows.length === 0) selectedCharacterId = null;
  for (const row of rows) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "roster-row";
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", row.id === selectedCharacterId ? "true" : "false");
    button.dataset.characterId = row.id;
    const name = document.createElement("span");
    name.className = "roster-name";
    name.textContent = row.name;
    button.append(name);
    if (row.professionId) {
      const tag = document.createElement("span");
      tag.className = "roster-tag";
      tag.textContent = row.professionId;
      button.append(tag);
    }
    button.addEventListener("click", () => {
      selectedCharacterId = row.id;
      renderRoster(current?.characters ?? []);
    });
    button.addEventListener("dblclick", () => {
      selectedCharacterId = row.id;
      void act("enter-world", { characterId: row.id });
    });
    item.append(button);
    el.roster.append(item);
  }
  el.rosterEmpty.hidden = rows.length !== 0;
  el.btnEnter.disabled = selectedCharacterId === null;
}

function render(snapshot) {
  current = snapshot;
  plate.dataset.stage = snapshot.stage === "restoring" ? "loading" : snapshot.stage;
  plate.dataset.notice = snapshot.notice ?? "";

  applyNotice(el.signinNotice, snapshot.stage === "signin" ? snapshot.notice : null);
  applyNotice(el.charactersNotice, snapshot.stage === "characters" ? snapshot.notice : null);

  if (snapshot.stage === "linking" && snapshot.link) {
    el.userCode.textContent = snapshot.link.userCode;
    el.approvalHost.textContent = `${snapshot.approvalHost}/connect`;
    el.openLabel.textContent = snapshot.approvalHost;
    stopCountdown();
    renderCountdown(snapshot.link.expiresAt);
    countdownTimer = setInterval(() => renderCountdown(snapshot.link.expiresAt), 1000);
  } else {
    el.userCode.textContent = "";
    stopCountdown();
  }

  if (snapshot.stage === "characters") {
    renderRoster(snapshot.characters);
    el.persistNote.hidden = snapshot.persistAvailable || snapshot.persisted;
  }
}

async function act(op, args) {
  if (!bridge) return;
  try {
    const snapshot = await bridge.control(op, args);
    if (snapshot) render(snapshot);
  } catch {
    // The main process pushes authoritative state; nothing to do here.
  }
}

function wire() {
  el.btnStart.addEventListener("click", () => void act("start-link"));
  el.btnOpen.addEventListener("click", () => void act("open-approval"));
  el.btnCopy.addEventListener("click", async () => {
    await act("copy-code");
    el.btnCopy.textContent = "Copied";
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      el.btnCopy.textContent = "Copy code";
      copiedTimer = null;
    }, 1600);
  });
  el.btnCancel.addEventListener("click", () => void act("cancel-link"));
  el.btnEnter.addEventListener("click", () => {
    if (selectedCharacterId) void act("enter-world", { characterId: selectedCharacterId });
  });
  el.btnRefresh.addEventListener("click", () => void act("refresh-characters"));
  el.btnCreate.addEventListener("click", () => void act("open-approval"));
  el.btnSignout.addEventListener("click", () => void act("sign-out"));

  document.addEventListener("keydown", (event) => {
    if (!current) return;
    if (current.stage === "characters") {
      const rows = current.characters ?? [];
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (rows.length === 0) return;
        event.preventDefault();
        const index = rows.findIndex((row) => row.id === selectedCharacterId);
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);
        selectedCharacterId = rows[nextIndex]?.id ?? selectedCharacterId;
        renderRoster(rows);
      } else if (event.key === "Enter" && selectedCharacterId && document.activeElement?.tagName !== "BUTTON") {
        void act("enter-world", { characterId: selectedCharacterId });
      }
    } else if (current.stage === "signin" && event.key === "Enter") {
      void act("start-link");
    }
  });
}

if (!bridge) {
  plate.dataset.stage = "nobridge";
} else {
  wire();
  bridge.onState(render);
  void act("state");
}
