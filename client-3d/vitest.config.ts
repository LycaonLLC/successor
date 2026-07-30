import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "../tools/verification/client3d/lib/**/*.test.mjs",
      "../tools/verification/scenario/**/*.test.mjs",
    ],
    environment: "node",
  },
});
