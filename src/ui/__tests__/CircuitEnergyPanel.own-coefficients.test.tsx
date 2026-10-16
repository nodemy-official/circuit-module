import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { simulateTransient } from "../../transient-solver.js";
import { CircuitEnergyPanel } from "../CircuitEnergyPanel.js";

function circuit(kind: "capacitor" | "inductor", coefficient: number | undefined, proxyCoefficient: number) {
  const key = kind === "capacitor" ? "capacitanceFarads" : "inductanceHenries";
  const storage: CircuitDocument["parts"][number] = {
    id: "storage", kind, label: "蓄積部品", x: 0, y: 0,
  };
  if (coefficient !== undefined) {
    Object.defineProperty(storage, key, { value: coefficient, writable: true, enumerable: false });
  }
  const document: CircuitDocument = {
    title: "解析に使用した蓄積係数",
    parts: [
      { id: "source", kind: kind === "capacitor" ? "battery" : "current-source", label: "電源", x: 0, y: 0, voltageVolts: 1, currentAmps: -1 },
      new Proxy(storage, {
        get(target, property, receiver) {
          return property === key ? proxyCoefficient : Reflect.get(target, property, receiver);
        },
      }),
    ],
    wires: [
      { id: "a", from: { partId: "source", terminal: "a" }, to: { partId: "storage", terminal: "a" } },
      { id: "b", from: { partId: "source", terminal: "b" }, to: { partId: "storage", terminal: "b" } },
    ],
  };
  return { document, storage, key };
}

describe("energy coefficient snapshots", () => {
  it.each([
    { kind: "capacitor", coefficient: 1, expected: 0.5 },
    { kind: "inductor", coefficient: 1, expected: 0.5 },
    { kind: "capacitor", coefficient: undefined, expected: 5e-7 },
    { kind: "inductor", coefficient: undefined, expected: 0.005 },
  ] as const)("uses the own $kind coefficient ($coefficient) in steady and transient energy", ({ kind, coefficient, expected }) => {
    const { document } = circuit(kind, coefficient, 2);
    const analysis = analyzeCircuit(document);
    const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1, startFromOperatingPoint: true });
    expect(analysis.status, analysis.message).toBe(kind === "capacitor" ? "open" : "closed");
    expect(analysis.parts.storage![kind === "capacitor" ? "voltageVolts" : "currentAmps"]).toBe(1);
    expect(transient.status, transient.message).toBe("valid");

    for (const frame of [undefined, { analysis: transient, sampleIndex: 0 }]) {
      const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis} frame={frame} />);
      // With V=1 V or I=1 A, stored energy is exactly half the own coefficient.
      expect(markup).toContain(`data-energy-joules="${expected}"`);
    }
  });

  it.each(["capacitor", "inductor"] as const)("invalidates cached %s energy after its own coefficient changes", (kind) => {
    const { document, storage, key } = circuit(kind, 1, 1);
    const analysis = analyzeCircuit(document);
    const transient = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 1, startFromOperatingPoint: true });
    expect(transient.status, transient.message).toBe("valid");
    expect(transient.energyReadings?.storage?.coefficient).toBe(1);
    storage[key] = 2;

    const markup = renderToStaticMarkup(<CircuitEnergyPanel document={document} analysis={analysis}
      frame={{ analysis: transient, sampleIndex: 0 }} />);

    // The sampled state is still one, while the current own coefficient is two.
    expect(markup).toContain('data-energy-joules="1"');
  });
});
