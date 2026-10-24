import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.js"], environment: "node",
    pool: "forks", poolOptions: { forks: { singleFork: true, maxForks: 1, minForks: 0 } },
    reporters: ["default"],
  },
});
