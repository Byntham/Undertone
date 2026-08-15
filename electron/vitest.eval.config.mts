import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["evals/**/*.eval.ts"],
    disableConsoleIntercept: true,
    fileParallelism: false,
    testTimeout: 30 * 60_000,
  },
});
