import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
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
