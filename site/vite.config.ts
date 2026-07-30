import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Static multi-page build. Every route ships as a real HTML file so direct
// deep links work on any static host without rewrite rules.
export default defineConfig({
  appType: "mpa",
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        alpha: resolve(__dirname, "alpha/index.html"),
        roadmap: resolve(__dirname, "roadmap/index.html"),
        account: resolve(__dirname, "account/index.html"),
        connect: resolve(__dirname, "connect/index.html"),
        play: resolve(__dirname, "play/index.html"),
        download: resolve(__dirname, "download/index.html"),
        legalTerms: resolve(__dirname, "legal/terms/index.html"),
        legalPrivacy: resolve(__dirname, "legal/privacy/index.html"),
      },
    },
  },
  test: {
    environment: "happy-dom",
    include: ["tests/**/*.test.ts"],
  },
});
