import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

it.each([
  ["nmos", 1], ["pmos", -1],
] as const)("recognizes the %s amplifier's driven output loop when its input draws no current", (kind, polarity) => {
  const document: CircuitDocument = {
    title: "MOS amplifier with zero gate current",
    parts: [
      { id: "d", kind: "battery", label: "DC", x: 0, y: 0, voltageVolts: 5, internalResistanceOhms: 0 },
      { id: "v", kind: "ac-source", label: "AC", x: 0, y: 0, voltageVolts: 0.001, offsetVolts: 3 * polarity, frequencyHz: 1000 },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 100 },
      { id: "q", kind, label: "Q", x: 0, y: 0, thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 0.02, channelLengthModulation: 0 },
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "dr", from: { partId: "d", terminal: polarity === 1 ? "a" : "b" }, to: { partId: "r", terminal: "a" } },
      { id: "rq", from: { partId: "r", terminal: "b" }, to: { partId: "q", terminal: "a" } },
      { id: "vq", from: { partId: "v", terminal: "a" }, to: { partId: "q", terminal: "b" } },
      { id: "dg", from: { partId: "d", terminal: polarity === 1 ? "b" : "a" }, to: { partId: "g", terminal: "a" } },
      { id: "vg", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "qg", from: { partId: "q", terminal: "c" }, to: { partId: "g", terminal: "a" } },
    ],
  };
  const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });
  expect(result.status, result.message).toBe("closed");
  expect(result.parts.v!.currentAmps).toBe(0);
  // gm=beta*(Vgs-Vth)=0.02 S; I=gm*1mV, V=100*I, P=100*I^2.
  expect(result.parts.r!.currentAmps / 0.000_02).toBeCloseTo(1, 14);
  expect(result.parts.r!.voltageVolts / 0.002).toBeCloseTo(1, 14);
  expect(result.parts.r!.powerWatts / 4e-8).toBeCloseTo(1, 14);

  // A detached, unexcited output load must not close the driven gate circuit.
  const detached = { ...document, wires: document.wires.filter(({ id }) => id !== "rq") };
  const open = analyzeCircuit(detached, {}, { mode: "ac", frequencyHz: 1000 });
  expect(open.status, open.message).toBe("open");
  expect(open.parts.r!.currentAmps).toBe(0);
});
