import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 20000,
    hookTimeout: 30000,
    fileParallelism: false, // tests share one Postgres database
  },
});
