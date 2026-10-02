import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import type { CircuitDocument } from "../../circuit-model.js";

it("preserves a tiny AC source when its series branch conductance differs greatly", () => {
  const document: CircuitDocument = {
    title: "小信号交流源と異なる枝抵抗",
    parts: [
      { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 1 },
      { id: "hi", kind: "ac-source", label: "正電源", x: 0, y: 0, voltageVolts: 1, phaseDegrees: 0, frequencyHz: 1 },
      { id: "r0", kind: "resistor", label: "正側抵抗", x: 0, y: 0, resistanceOhms: 1 },
      { id: "small", kind: "ac-source", label: "小信号電源", x: 0, y: 0, voltageVolts: 1e-16, phaseDegrees: 0, frequencyHz: 1 },
      { id: "r1", kind: "resistor", label: "小信号側抵抗", x: 0, y: 0, resistanceOhms: 1e-5 },
      { id: "lo", kind: "ac-source", label: "逆相電源", x: 0, y: 0, voltageVolts: 1, phaseDegrees: 180, frequencyHz: 1 },
      { id: "r2", kind: "resistor", label: "逆相側抵抗", x: 0, y: 0, resistanceOhms: 1 },
    ],
    wires: [
      { id: "sa0", from: { partId: "hi", terminal: "a" }, to: { partId: "r0", terminal: "a" } },
      { id: "rl0", from: { partId: "r0", terminal: "b" }, to: { partId: "load", terminal: "a" } },
      { id: "sb0", from: { partId: "hi", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      { id: "sa1", from: { partId: "small", terminal: "a" }, to: { partId: "r1", terminal: "a" } },
      { id: "rl1", from: { partId: "r1", terminal: "b" }, to: { partId: "load", terminal: "a" } },
      { id: "sb1", from: { partId: "small", terminal: "b" }, to: { partId: "load", terminal: "b" } },
      { id: "sa2", from: { partId: "lo", terminal: "a" }, to: { partId: "r2", terminal: "a" } },
      { id: "rl2", from: { partId: "r2", terminal: "b" }, to: { partId: "load", terminal: "a" } },
      { id: "sb2", from: { partId: "lo", terminal: "b" }, to: { partId: "load", terminal: "b" } },
    ],
  };
  const expectedVoltage = 1e-11 / 100_003;

  const analysis = analyzeAnalogCircuit(document, { mode: "ac" });

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.load!.voltage.real / expectedVoltage).toBeCloseTo(1, 10);
  expect(analysis.parts.load!.voltage.imaginary).toBe(0);
});
