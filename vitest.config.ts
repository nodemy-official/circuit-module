import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    projects: [
      {
        extends: true,
        test: {
          name: "headless",
          include: ["src/**/*.test.ts"],
          isolate: false,
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          include: ["src/**/*.test.tsx"],
          isolate: true,
        },
      },
    ],
  },
});
