import { describe, expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, fromPart: string, fromTerminal: "a" | "b", toPart: string, toTerminal: "a" | "b") => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function highCommonModeDocument(includeIsolatedOpAmp: boolean): CircuitDocument {
  const parts: CircuitPart[] = [
    part("high", "ac-source", { voltageVolts: 1e16, phaseDegrees: 31, frequencyHz: 60 }),
    part("left", "resistor", { resistanceOhms: 1e16 }),
    part("small", "ac-source", { voltageVolts: 2e-3, phaseDegrees: -47, frequencyHz: 60 }),
    part("load", "resistor", { resistanceOhms: 1e-3 }),
    part("right", "resistor", { resistanceOhms: 1e16 }),
    part("ground", "ground"),
    ...(includeIsolatedOpAmp ? [part("isolated-op-amp", "op-amp")] : []),
  ];
  return {
    title: "別成分のOPアンプを含む高共通電位回路",
    parts,
    wires: [
      wire("high-left", "high", "a", "left", "a"),
      wire("left-small", "left", "b", "small", "a"),
      wire("left-load", "left", "b", "load", "a"),
      wire("small-right", "small", "b", "right", "a"),
      wire("load-right", "load", "b", "right", "a"),
      wire("return", "high", "b", "right", "b"),
      wire("ground-wire", "ground", "a", "high", "b"),
    ],
  };
}

describe("AC nonlinear re-reference isolation audit", () => {
  it("keeps branch readings stable with an isolated op-amp in the document", () => {
    const baseline = analyzeAnalogCircuit(highCommonModeDocument(false), { mode: "ac" });
    const withIsolatedOpAmp = analyzeAnalogCircuit(highCommonModeDocument(true), { mode: "ac" });

    expect(baseline.status, baseline.message).toBe("valid");
    expect(withIsolatedOpAmp.status, withIsolatedOpAmp.message).toBe("valid");
    expect(baseline.parts.load.voltage.real).toBeCloseTo(2e-3 * Math.cos(-47 * Math.PI / 180), 10);
    expect(baseline.parts.load.voltage.imaginary).toBeCloseTo(2e-3 * Math.sin(-47 * Math.PI / 180), 10);
    expect(withIsolatedOpAmp.parts.load.voltage.real).toBeCloseTo(2e-3 * Math.cos(-47 * Math.PI / 180), 10);
    expect(withIsolatedOpAmp.parts.load.voltage.imaginary).toBeCloseTo(2e-3 * Math.sin(-47 * Math.PI / 180), 10);
  });

  it("preserves a millivolt branch drop on a high resonant AC common mode", () => {
    const frequencyHz = 1000;
    const inductanceHenries = 1e10;
    const angularFrequency = 2 * Math.PI * frequencyHz;
    const document: CircuitDocument = {
      title: "共振で増幅した交流電位上の微小電圧",
      parts: [
        part("drive", "ac-source", { voltageVolts: 1e8, frequencyHz }),
        part("series-resistance", "resistor", { resistanceOhms: 1e8 }),
        part("inductor", "inductor", { inductanceHenries }),
        part("capacitor", "capacitor", { capacitanceFarads: 1 / (angularFrequency ** 2 * inductanceHenries) }),
        part("small", "ac-source", { voltageVolts: 2e-3, phaseDegrees: -90, frequencyHz }),
        part("load", "resistor", { resistanceOhms: 1e16 }),
        part("diode", "diode", { saturationCurrentAmps: 1e-6 }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("drive-resistor", "drive", "a", "series-resistance", "a"),
        wire("resistor-inductor", "series-resistance", "b", "inductor", "a"),
        wire("inductor-capacitor", "inductor", "b", "capacitor", "a"),
        wire("capacitor-ground", "capacitor", "b", "ground", "a"),
        wire("drive-ground", "drive", "b", "ground", "a"),
        wire("small-positive", "small", "a", "inductor", "b"),
        wire("load-positive", "load", "a", "inductor", "b"),
        wire("small-load-negative", "small", "b", "load", "b"),
        wire("diode-positive", "diode", "a", "inductor", "b"),
        wire("diode-negative", "diode", "b", "load", "b"),
        wire("meter-positive", "meter", "a", "inductor", "b"),
        wire("meter-negative", "meter", "b", "load", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    const withIsolatedOpAmp = analyzeAnalogCircuit({
      ...document,
      parts: [...document.parts, part("isolated-op-amp", "op-amp")],
    }, { mode: "ac" });
    const withDrivenOpAmp = analyzeAnalogCircuit({
      ...document,
      parts: [
        ...document.parts,
        part("op-signal", "ac-source", { voltageVolts: 1e-6, frequencyHz }),
        part("op-amp", "op-amp"),
        part("op-load", "resistor", { resistanceOhms: 20 }),
      ],
      wires: [
        ...document.wires,
        wire("op-signal-positive", "op-signal", "a", "op-amp", "a"),
        wire("op-signal-return", "op-signal", "b", "ground", "a"),
        wire("op-negative-ground", "op-amp", "b", "ground", "a"),
        wire("op-output-load", "op-amp", "c", "op-load", "a"),
        wire("op-load-ground", "op-load", "b", "ground", "a"),
      ],
    }, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.inductor.voltage.imaginary).toBeGreaterThan(1e13);
    expect(result.parts.small.voltage.real).toBeCloseTo(0, 12);
    expect(result.parts.small.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(result.parts.load.voltage.real).toBeCloseTo(0, 12);
    expect(result.parts.load.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(result.parts.diode.voltage.real).toBeCloseTo(0, 12);
    expect(result.parts.diode.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(result.parts.diode.current.real).toBeCloseTo(0, 20);
    expect(result.parts.diode.current.imaginary).toBeCloseTo(-2e-3 / 0.025_85 * 1e-6, 10);
    expect(result.parts.meter.voltage.real).toBeCloseTo(0, 12);
    expect(result.parts.meter.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(withIsolatedOpAmp.status, withIsolatedOpAmp.message).toBe("valid");
    expect(withIsolatedOpAmp.parts.diode.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(withIsolatedOpAmp.parts.diode.current.imaginary).toBeCloseTo(-2e-3 / 0.025_85 * 1e-6, 10);
    expect(withIsolatedOpAmp.parts.meter.voltage.imaginary).toBeCloseTo(-2e-3, 10);
    expect(withIsolatedOpAmp.parts["isolated-op-amp"].voltage).toEqual({ real: 0, imaginary: 0 });
    expect(withDrivenOpAmp.status, withDrivenOpAmp.message).toBe("valid");
    expect(withDrivenOpAmp.parts["op-amp"].voltage.real).toBeCloseTo(0.05, 10);
    expect(withDrivenOpAmp.parts["op-amp"].current.real).toBeCloseTo(-0.0025, 10);
    expect(withDrivenOpAmp.parts["op-load"].voltage.real).toBeCloseTo(0.05, 10);
    expect(withDrivenOpAmp.parts["op-load"].current.real).toBeCloseTo(0.0025, 10);
    const positiveNodeCurrents = [
      result.parts.inductor.terminalCurrents.b!,
      result.parts.capacitor.terminalCurrents.a!,
      result.parts.small.terminalCurrents.a!,
      result.parts.load.terminalCurrents.a!,
      result.parts.diode.terminalCurrents.a!,
      result.parts.meter.terminalCurrents.a!,
    ];
    const kclResidual = positiveNodeCurrents.reduce(
      (sum, current) => ({ real: sum.real + current.real, imaginary: sum.imaginary + current.imaginary }),
      { real: 0, imaginary: 0 },
    );
    expect(Math.hypot(kclResidual.real, kclResidual.imaginary)).toBeLessThan(1e-10);
  });
});
