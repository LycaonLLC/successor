// Per-page progressive enhancement. Every page's content works without
// this file; home cinema media, download rows, and account/device/play
// interactions light up when it runs.
import { initAccountPage } from "./features/account";
import { initConnectPage } from "./features/connect";
import { initPlayPage } from "./features/play";
import { initDownloads } from "./features/downloads";
import { initHome } from "./features/home";

const page = document.body.dataset.page;

if (page === "home") {
  initHome(document);
} else if (page === "account") {
  initAccountPage(document);
} else if (page === "connect") {
  initConnectPage(document);
} else if (page === "play") {
  void initPlayPage(document);
} else if (page === "download") {
  void initDownloads(document);
}
