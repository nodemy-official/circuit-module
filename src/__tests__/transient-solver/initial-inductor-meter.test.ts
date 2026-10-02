import { expect, it } from "vitest";

import type { CircuitDocument } from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

it("keeps the initial voltage constraint for a voltmeter across an isolated inductor", () => {
  const document: CircuitDocument = {
    title: "Initial voltage across an isolated inductor",
    parts: [
      { id: "inductor", kind: "inductor", label: "L", x: 0, y: 0, inductanceHenries: 1, initialCurrentAmps: 0 },
      { id: "voltmeter", kind: "voltmeter", label: "V", x: 0, y: 0 },
    ],
    wires: [
      { id: "meter-a", from: { partId: "voltmeter", terminal: "a" }, to: { partId: "inductor", terminal: "a" } },
      { id: "meter-b", from: { partId: "voltmeter", terminal: "b" }, to: { partId: "inductor", terminal: "b" } },
    ],
  };

  const result = simulateTransient(document, { durationSeconds: 0.1, timeStepSeconds: 0.1 });

  expect(result.status, result.message).toBe("valid");
  expect(result.samples[0]?.parts.voltmeter?.meterStatus).toBe("connected");
  expect(result.samples[0]?.parts.voltmeter?.voltageVolts).toBe(0);
  expect(result.samples[1]?.parts.voltmeter?.meterStatus).toBe("connected");
});
