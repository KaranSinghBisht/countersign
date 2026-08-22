import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "test/unit/**/*.test.ts", "test/no-pii-in-prompt.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          // Integration tests share one Postgres; running them in parallel
          // across files would interleave transactions and mask the races we
          // specifically want to observe.
          sequence: { concurrent: false },
          pool: "forks",
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          // Setup hooks talk to Postgres — migrating once and truncating
          // between tests. The 10s default is tight for the first run against
          // a cold container.
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
