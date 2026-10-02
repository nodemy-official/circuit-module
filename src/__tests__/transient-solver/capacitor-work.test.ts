import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

it("does not count removed Norton companion parts against the transient work budget", () => {
  const document: CircuitDocument = {
    title: "並列でないコンデンサの過渡計算量",
    parts: Array.from({ length: 11 }, (_, index) => ({
      id: `capacitor-${index}`,
      kind: "capacitor" as const,
      label: `C${index}`,
      x: 0,
      y: 0,
    })),
    wires: [],
  };
  const result = simulateTransient(document, { durationSeconds: 2, timeStepSeconds: 0.001 });

  expect(result.status, result.message).toBe("valid");
  expect(result.samples).toHaveLength(2001);
});
