import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/runtime/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
