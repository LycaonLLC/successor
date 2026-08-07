// Per-page progressive enhancement. Every page's content works without
// this file; the theme deck, home cinema media, download rows, and
// account/device/play interactions light up when it runs.
import { initAccountPage } from "./features/account";
import { initConnectPage } from "./features/connect";
import { initPlayPage } from "./features/play";
import { initDownloads } from "./features/downloads";
import { initHome } from "./features/home";
import { initTheme } from "./features/theme";

initTheme(document);

const page = document.body.dataset.page;

if (page === "home") {
  initHome(document);
} else if (page === "account") {
  initAccountPage(document);
} else if (page === "connect") {
  initConnectPage(document);
} else if (page === "play") {
  const beta = document.body.dataset.runtimeChannel === "beta";
  void initPlayPage(document, undefined, beta
    ? {
      runtimePointerPath: "/beta/release.json",
      beta: true,
      consumeCharacterHandoff: false,
      enableMacroBridge: false,
    }
    : {});
} else if (page === "download") {
  void initDownloads(document);
}
