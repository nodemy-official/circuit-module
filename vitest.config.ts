import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    // Exact BigInt solver audits are CPU intensive; concurrent suites can
    // exhaust per-test timeouts even when each circuit finishes promptly.
    maxWorkers: 1,
    // High-order cancellation fixtures take over five seconds on a busy CPU.
    // This is a wall-clock limit; numerical tolerances remain unchanged.
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "headless",
          include: ["src/**/__tests__/**/*.test.ts"],
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/**/__tests__/**/*.test.tsx"],
          isolate: true,
        },
      },
    ],
  },
});
