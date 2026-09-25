import { describe, expect, it } from "vitest";
import { circuitExampleCatalog, createCircuitExample, type CircuitExampleKind } from "./circuit-examples.js";
import { analyzeCircuit } from "./circuit-solver.js";
import { parseCircuitDocument, serializeCircuitDocument } from "./circuit-serialization.js";

describe("working circuit examples", () => {
  it.each(Object.keys(circuitExampleCatalog) as CircuitExampleKind[])("can save, reopen, and solve %s", (kind) => {
    const document = createCircuitExample(kind);
    const parsed = parseCircuitDocument(serializeCircuitDocument(document));
    expect(parsed).toEqual({ ok: true, document });
    const analysis = analyzeCircuit(document);
    expect(analysis.status, analysis.message).toBe("closed");
    expect(analysis.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports the RC filter's RMS magnitude, phase, and real power", () => {
    const analysis = analyzeCircuit(createCircuitExample("ac"));
    const omegaRc = 2 * Math.PI * 1000 * 1000 * 1e-6;
    const capacitorVolts = 5 / Math.hypot(1, omegaRc);
    expect(analysis.mode).toBe("ac");
    expect(analysis.frequencyHz).toBe(1000);
    expect(analysis.parts.load.voltageVolts).toBeCloseTo(capacitorVolts, 6);
    expect(analysis.parts.load.voltagePhaseDegrees).toBeCloseTo(-Math.atan(omegaRc) * 180 / Math.PI, 6);
    expect(analysis.parts.load.powerWatts).toBeCloseTo(0, 9);
    expect(analysis.parts.resistor.powerWatts).toBeCloseTo(analysis.parts.source.powerWatts, 8);
    expect(analysis.wireCurrents).toEqual({});
  });

  it("preserves signed DC values and applies zero AC-source offset to the DC operating point", () => {
    const circuit = createCircuitExample("ac");
    const dc = analyzeCircuit(circuit, {}, { mode: "dc" });
    expect(dc.mode).toBe("dc");
    expect(dc.parts.source.voltageVolts).toBe(0);
    expect(dc.parts.load.currentAmps).toBe(0);
    const biased = { ...circuit, parts: circuit.parts.map((part) => part.id === "source" ? { ...part, offsetVolts: -2 } : part) };
    expect(analyzeCircuit(biased, {}, { mode: "dc" }).parts.load.voltageVolts).toBeCloseTo(-2, 6);
  });

  it("limits LED current and closes the op-amp's feedback loop", () => {
    const led = analyzeCircuit(createCircuitExample("led"));
    expect(led.parts.load.currentAmps).toBeGreaterThan(0.005);
    expect(led.parts.load.currentAmps).toBeLessThan(0.02);
    expect(led.parts.load.brightness).toBeGreaterThan(0);
    expect(analyzeCircuit(createCircuitExample("opamp")).parts.opamp.voltageVolts).toBeCloseTo(2, 3);
  });
});
