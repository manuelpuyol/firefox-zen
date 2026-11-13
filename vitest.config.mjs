import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["extension/**/*.js"],
      reporter: ["text-summary", "text", "json"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.js"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e/**/*.test.js"],
          // One real Firefox at a time; starting it takes a few seconds.
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
