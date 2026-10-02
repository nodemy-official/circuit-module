import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, from: string, fromTerminal: "a" | "b", to: string, toTerminal: "a" | "b") => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function cancellingSources(order: number[], phaseDegrees: number, grounded: boolean, reactiveKind?: "inductor" | "capacitor"): CircuitDocument {
  const voltages = [1e12, 1e-4, -1e12];
  const reactive = (id: string) => reactiveKind === "inductor"
    ? part(id, "inductor", { inductanceHenries: 1e12 / (2 * Math.PI) })
    : part(id, "capacitor", { capacitanceFarads: 1 / (1e12 * 2 * Math.PI) });
  const returnPart = reactiveKind ? "load-reactive" : "load";
  return {
    title: "AC Norton currents with a small net excitation",
    parts: [
      part("load", "resistor", { resistanceOhms: 1e12 }),
      ...(reactiveKind ? [reactive("load-reactive")] : []),
      part("meter", "voltmeter"),
      ...order.flatMap((index) => [
        part(`source-${index}`, "ac-source", {
          voltageVolts: Math.abs(voltages[index]!),
          phaseDegrees: phaseDegrees + (voltages[index]! < 0 ? 180 : 0),
          frequencyHz: 1,
        }),
        part(`resistor-${index}`, "resistor", { resistanceOhms: 1e12 }),
        ...(reactiveKind ? [reactive(`reactive-${index}`)] : []),
      ]),
      ...(grounded ? [part("ground", "ground")] : []),
    ],
    wires: [
      wire("meter-a", "meter", "a", "load", "a"),
      wire("meter-b", "meter", "b", returnPart, "b"),
      ...(reactiveKind ? [wire("load-reactive", "load", "b", returnPart, "a")] : []),
      ...order.flatMap((index) => [
        wire(`source-resistor-${index}`, `source-${index}`, "a", `resistor-${index}`, "a"),
        ...(reactiveKind ? [wire(`resistor-reactive-${index}`, `resistor-${index}`, "b", `reactive-${index}`, "a")] : []),
        wire(`resistor-load-${index}`, reactiveKind ? `reactive-${index}` : `resistor-${index}`, "b", "load", "a"),
        wire(`source-return-${index}`, `source-${index}`, "b", returnPart, "b"),
      ]),
      ...(grounded ? [wire("ground", "ground", "a", returnPart, "b")] : []),
    ],
  };
}

describe("AC cancellation between source branches", () => {
  it.each(([undefined, "inductor", "capacitor"] as const).flatMap((reactiveKind) =>
    [0, 90, 37].map((phaseDegrees) => ({ reactiveKind, phaseDegrees })),
  ))("preserves the net excitation at phase $phaseDegrees with $reactiveKind branches", ({ phaseDegrees, reactiveKind }) => {
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    // Nodal analysis gives Vout = (V1 + V2 + V3) / 4.
    const expectedMagnitude = 2.5e-5;
    const expectedReal = phaseDegrees === 90 ? 0 : expectedMagnitude * Math.cos(phaseDegrees * Math.PI / 180);
    const expectedImaginary = phaseDegrees === 0 ? 0 : expectedMagnitude * Math.sin(phaseDegrees * Math.PI / 180);
    for (const order of orders) {
      for (const grounded of [true, false]) {
        const document = cancellingSources(order, phaseDegrees, grounded, reactiveKind);
        const analysis = analyzeAnalogCircuit(document, { mode: "ac" });
        const context = `phase=${phaseDegrees}, order=${order}, grounded=${grounded}`;

        expect(analysis.status, `${context}: ${analysis.message}`).toBe("valid");
        for (const id of ["load", "meter"]) {
          const reactanceSign = reactiveKind === "inductor" ? 1 : -1;
          const real = id === "load" && reactiveKind ? (expectedReal + reactanceSign * expectedImaginary) / 2 : expectedReal;
          const imaginary = id === "load" && reactiveKind ? (expectedImaginary - reactanceSign * expectedReal) / 2 : expectedImaginary;
          expect((analysis.parts[id]!.voltage.real - real) / expectedMagnitude, `${context}, ${id} real`).toBeCloseTo(0, 10);
          expect((analysis.parts[id]!.voltage.imaginary - imaginary) / expectedMagnitude, `${context}, ${id} imaginary`).toBeCloseTo(0, 10);
        }
        const adapted = analyzeCircuit(document, {}, { mode: "ac" });
        expect(adapted.status, adapted.message).toBe("closed");
        expect(adapted.parts.meter!.voltageVolts / expectedMagnitude, context).toBeCloseTo(1, 10);
      }
    }
  });
});
