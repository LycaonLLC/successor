// Site theme engine, keyed to the game client.
//
// DAWN is the site's own daylight glass. The other four are byte-exact ports
// of the Rust client's `hud.rs` THEMES — picking SIGNAL here is the same
// chrome a player cycles to in the field. GAME_PARITY carries the shipped
// palette bytes so tests/theme-contract.test.ts can hold tokens.css and
// hud.rs to the same truth.

export const THEME_STORAGE_KEY = "successor-theme";

export interface SiteTheme {
  id: string;
  label: string;
  /** Swatch + meta theme-color source. */
  accent: string;
  field: string;
  inGame: boolean;
}

/** hud.rs THEMES parity bytes (bg_panel/bg_cell carry their shipped alphas). */
export const GAME_PARITY = {
  signal: {
    bgPanel: "#113337", bgPanelAlpha: 232, bgCell: "#0a1e20", bgCellAlpha: 235,
    ink: "#cfe9ef", inkDim: "#899a9e", hairline: "#1a4d53",
    accent: "#48d6e6", accentSoft: "#164045", danger: "#e34a4a",
  },
  phosphor: {
    bgPanel: "#113d1d", bgPanelAlpha: 232, bgCell: "#0a2411", bgCellAlpha: 235,
    ink: "#9cf0b4", inkDim: "#45b362", hairline: "#195c2c",
    accent: "#46ff7a", accentSoft: "#154c25", danger: "#e34a4a",
  },
  amber: {
    bgPanel: "#3d2b12", bgPanelAlpha: 232, bgCell: "#24190a", bgCellAlpha: 235,
    ink: "#ffd98c", inkDim: "#ad945f", hairline: "#5c401b",
    accent: "#ffb24a", accentSoft: "#4c3516", danger: "#e34a4a",
  },
  oxide: {
    bgPanel: "#36190e", bgPanelAlpha: 232, bgCell: "#1f0e08", bgCellAlpha: 235,
    ink: "#e6d4b8", inkDim: "#938876", hairline: "#512515",
    accent: "#e0673a", accentSoft: "#431f11", danger: "#e34a4a",
  },
} as const;

const DAWN: SiteTheme = { id: "dawn", label: "Dawn", accent: "#3e93a8", field: "#eef4f7", inGame: false };

export const THEMES: readonly SiteTheme[] = [
  DAWN,
  { id: "signal", label: "Signal", accent: GAME_PARITY.signal.accent, field: "#05100f", inGame: true },
  { id: "phosphor", label: "Phosphor", accent: GAME_PARITY.phosphor.accent, field: "#04110a", inGame: true },
  { id: "amber", label: "Amber", accent: GAME_PARITY.amber.accent, field: "#120d05", inGame: true },
  { id: "oxide", label: "Oxide", accent: GAME_PARITY.oxide.accent, field: "#100704", inGame: true },
];


export function storedTheme(storage: Pick<Storage, "getItem"> = localStorage): string {
  try {
    const value = storage.getItem(THEME_STORAGE_KEY);
    return value !== null && THEMES.some((theme) => theme.id === value) ? value : "dawn";
  } catch {
    return "dawn";
  }
}

export function applyTheme(doc: Document, id: string): void {
  const theme = THEMES.find((entry) => entry.id === id) ?? DAWN;
  if (theme.id === "dawn") {
    doc.documentElement.removeAttribute("data-theme");
  } else {
    doc.documentElement.setAttribute("data-theme", theme.id);
  }
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = theme.field;
  for (const button of doc.querySelectorAll<HTMLButtonElement>("[data-theme-pick]")) {
    button.setAttribute("aria-pressed", button.dataset.themePick === theme.id ? "true" : "false");
  }
}

/** Mount the deck into every [data-theme-deck] and apply the stored theme. */
export function initTheme(doc: Document): void {
  for (const host of doc.querySelectorAll<HTMLElement>("[data-theme-deck]")) {
    host.classList.add("theme-deck");
    host.setAttribute("role", "group");
    host.setAttribute("aria-label", "Site theme — Signal, Phosphor, Amber and Oxide match the in-game chrome");
    host.textContent = "";
    for (const theme of THEMES) {
      const button = doc.createElement("button");
      button.type = "button";
      button.dataset.themePick = theme.id;
      button.setAttribute("aria-pressed", "false");
      button.title = theme.inGame ? `${theme.label} — as worn in the field` : theme.label;

      const swatch = doc.createElement("span");
      swatch.className = "swatch";
      swatch.setAttribute("aria-hidden", "true");

      const label = doc.createElement("span");
      label.className = "label";
      label.textContent = theme.label;

      button.append(swatch, label);
      button.addEventListener("click", () => {
        try {
          localStorage.setItem(THEME_STORAGE_KEY, theme.id);
        } catch {
          /* private mode: theme still applies for this page */
        }
        applyTheme(doc, theme.id);
      });
      host.append(button);
    }
  }
  applyTheme(doc, storedTheme());
}
