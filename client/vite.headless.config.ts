import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  publicDir: false,
  build: {
    target: "node22",
    outDir: "dist/headless",
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    ssr: true,
    rollupOptions: {
      input: {
        index: path.resolve(root, "src/headless/index.ts"),
        cli: path.resolve(root, "src/headless/cli.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
});
