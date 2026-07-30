import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * SSR node bundle mirroring client/vite.headless.config.ts — the TUI is a
 * terminal process on the shared slice-core runtime (?raw manifest imports
 * need the vite pipeline, exactly like the headless host build).
 */
export default defineConfig({
  root,
  publicDir: false,
  define: {
    "process.env.WS_NO_BUFFER_UTIL": JSON.stringify("1"),
    "process.env.WS_NO_UTF_8_VALIDATE": JSON.stringify("1"),
  },
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    ssr: true,
    rollupOptions: {
      input: {
        cli: path.resolve(root, "src/cli.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  ssr: {
    noExternal: ["ws"],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
  },
});
