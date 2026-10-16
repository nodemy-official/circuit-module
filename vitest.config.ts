import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    // Exact BigInt solver audits are CPU intensive; concurrent suites can
    // exhaust per-test timeouts even when each circuit finishes promptly.
    maxWorkers: 1,
    // UI tests retain this default; headless numerical audits override it below.
    testTimeout: 10_000,
    projects: [
      {
        extends: true,
        test: {
          name: "headless",
          include: ["src/**/__tests__/**/*.test.ts"],
          isolate: false,
          // Exact BigInt and continuous-history audits need wall-clock headroom
          // on busy CPUs. Numerical tolerances are defined separately by each test.
          testTimeout: 30_000,
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
