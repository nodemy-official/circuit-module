import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit, type AnalogCircuitAnalysis, type ComplexValue } from "./analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "./circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
});

function network(parts: CircuitPart[], connections: [string, string][]): CircuitDocument {
  return {
    title: "物理法則の検証",
    parts,
    wires: connections.map(([from, to], index) => {
      const [fromPart, fromTerminal] = from.split(":");
      const [toPart, toTerminal] = to.split(":");
      return {
        id: `w${index}`,
        from: { partId: fromPart, terminal: fromTerminal as "a" | "b" },
        to: { partId: toPart, terminal: toTerminal as "a" | "b" },
      };
    }),
  };
}

function phasorError(actual: ComplexValue, real: number, imaginary: number, scale = 1) {
  return Math.max(Math.abs(actual.real - real), Math.abs(actual.imaginary - imaginary)) / scale;
}

function currentImbalance(result: AnalogCircuitAnalysis, terminals: string[]) {
  const currents = terminals.map((endpoint) => {
    const [id, terminal] = endpoint.split(":");
    return result.parts[id].terminalCurrents[terminal as "a" | "b"]!;
  });
  const scale = Math.max(...currents.map((value) => Math.hypot(value.real, value.imaginary))) || 1;
  return phasorError({
    real: currents.reduce((sum, value) => sum + value.real, 0),
    imaginary: currents.reduce((sum, value) => sum + value.imaginary, 0),
  }, 0, 0, scale);
}

function powerImbalance(result: AnalogCircuitAnalysis) {
  const powers = Object.values(result.parts).map((reading) => reading.power);
  const scale = Math.max(...powers.map((value) => Math.hypot(value.real, value.imaginary))) || 1;
  return phasorError({
    real: powers.reduce((sum, value) => sum + value.real, 0),
    imaginary: powers.reduce((sum, value) => sum + value.imaginary, 0),
  }, 0, 0, scale);
}

function bridgeCircuit(resistances: number[]) {
  return network([
    part("source", "battery", { voltageVolts: 12 }),
    ...resistances.map((resistanceOhms, index) => part(`r${index}`, "resistor", { resistanceOhms })),
    part("gnd", "ground"),
  ], [
    ["source:a", "r0:a"], ["source:a", "r2:a"],
    ["r0:b", "r1:a"], ["r0:b", "r4:a"],
    ["r2:b", "r3:a"], ["r2:b", "r4:b"],
    ["r1:b", "source:b"], ["r3:b", "source:b"], ["gnd:a", "source:b"],
  ]);
}

describe("DC circuit conservation and invariance", () => {
  it.each([1, 47, 2200, 1e6, 1e9])("matches a balanced bridge at resistance scale %s", (scale) => {
    const document = bridgeCircuit([scale, 2 * scale, 3 * scale, 6 * scale, 0.1 * scale]);
    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.r4.voltage.real).toBeCloseTo(0, 8);
    expect(result.parts.r0.voltage.real).toBeCloseTo(4, 8);
    expect(result.parts.r1.voltage.real).toBeCloseTo(8, 8);
    expect(phasorError(result.parts.r0.current, 4 / scale, 0, 4 / scale)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.r2.current, 4 / (3 * scale), 0, 4 / (3 * scale))).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["source:a", "r0:a", "r2:a"])).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["r0:b", "r1:a", "r4:a"])).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["r2:b", "r3:a", "r4:b"])).toBeLessThan(1e-9);
    expect(powerImbalance(result)).toBeLessThan(1e-9);
  });

  it("conserves current and power in 100 bridges spanning 18 orders of resistance", () => {
    let seed = 20_260_926;
    const nextResistance = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 2 ** 32;
      return 10 ** (-2 + 18 * seed / 2 ** 32);
    };
    for (let index = 0; index < 100; index += 1) {
      const document = bridgeCircuit(Array.from({ length: 5 }, nextResistance));
      const result = analyzeAnalogCircuit(document);

      expect(result.status).toBe("valid");
      expect(currentImbalance(result, ["source:a", "r0:a", "r2:a"])).toBeLessThan(1e-9);
      expect(currentImbalance(result, ["r0:b", "r1:a", "r4:a"])).toBeLessThan(1e-9);
      expect(currentImbalance(result, ["r2:b", "r3:a", "r4:b"])).toBeLessThan(1e-9);
      expect(currentImbalance(result, ["source:b", "r1:b", "r3:b"])).toBeLessThan(1e-9);
      expect(powerImbalance(result)).toBeLessThan(1e-9);
      expect(result.parts.r0.voltage.real + result.parts.r1.voltage.real).toBeCloseTo(12, 10);
      expect(result.parts.r2.voltage.real + result.parts.r3.voltage.real).toBeCloseTo(12, 10);

      const reordered = analyzeAnalogCircuit({
        ...document,
        parts: [...document.parts].reverse(),
        wires: [...document.wires].reverse().map((wire) => ({ ...wire, from: wire.to, to: wire.from })),
      });
      expect(reordered.status).toBe("valid");
      for (const component of document.parts) {
        expect(phasorError(reordered.parts[component.id].voltage, result.parts[component.id].voltage.real, 0, 12)).toBeLessThan(1e-9);
        const expectedCurrent = result.parts[component.id].current.real;
        // Near a balanced bridge, its current can be set by a voltage smaller
        // than the rounding error of the two 12 V node potentials. Bound that
        // error in amperes using Ohm's law instead of a fixed current floor.
        const roundingAmps = 64 * Number.EPSILON * 12 / (component.resistanceOhms ?? 1);
        expect(Math.abs(reordered.parts[component.id].current.real - expectedCurrent))
          .toBeLessThanOrEqual(1e-9 * Math.abs(expectedCurrent) + roundingAmps);
      }
    }
  });

  it("keeps a high-resistance bridge unchanged when unused floating parts are added", () => {
    const document = bridgeCircuit([1e9, 2e9, 3e9, 6e9, 1e8]);
    document.parts.push(part("unused-capacitor", "capacitor"), part("unused-meter", "voltmeter"));
    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.r0.voltage.real).toBeCloseTo(4, 8);
    expect(result.parts.r4.voltage.real).toBeCloseTo(0, 8);
    expect(currentImbalance(result, ["source:a", "r0:a", "r2:a"])).toBeLessThan(1e-9);
    expect(powerImbalance(result)).toBeLessThan(1e-9);
  });

  it.each(["dc", "ac"] as const)(
    "keeps a disconnected low-resistance part from making %s analysis singular",
    (mode) => {
      const document = network([
        part("source", "ac-source", { voltageVolts: 5, offsetVolts: 5 }),
        part("load", "resistor", { resistanceOhms: 100 }),
        part("unused", "resistor", { resistanceOhms: 1e-6 }),
        part("ground", "ground"),
      ], [["source:a", "load:a"], ["source:b", "load:b"], ["ground:a", "source:b"]]);

      const result = analyzeAnalogCircuit(document, { mode });

      expect(result.status, result.message).toBe("valid");
      expect(result.parts.load.voltage.real).toBeCloseTo(5, 12);
      expect(result.parts.load.current.real).toBeCloseTo(0.05, 12);
      expect(result.parts.unused.voltage.real).toBeCloseTo(0, 12);
      expect(result.parts.unused.current.real).toBeCloseTo(0, 12);
      expect(powerImbalance(result)).toBeLessThan(1e-9);
    },
  );

  it.each([1e-6, 1, 1e12, 1e20])(
    "preserves a floating source and load at resistance %s without artificial leakage",
    (resistanceOhms) => {
      const document = network([
        part("ground", "ground"),
        part("source", "battery", { voltageVolts: 3 }),
        part("load", "resistor", { resistanceOhms }),
      ], [["source:a", "load:a"], ["source:b", "load:b"]]);

      const result = analyzeAnalogCircuit(document);

      expect(result.status, result.message).toBe("valid");
      expect(result.parts.load.voltage.real).toBeCloseTo(3, 12);
      expect(result.parts.load.current.real / (3 / resistanceOhms)).toBeCloseTo(1, 10);
      expect(result.parts.source.current.real / (-3 / resistanceOhms)).toBeCloseTo(1, 10);
      expect(powerImbalance(result)).toBeLessThan(1e-9);
    },
  );

  it.each(["resistor", "bulb", "potentiometer"] as const)(
    "preserves a small %s's current, voltage and power with a large series resistance",
    (kind) => {
      const document = network([
        part("source", "ac-source", { voltageVolts: 9, offsetVolts: 9 }),
        part("small", kind, { resistanceOhms: 0.01 }),
        part("large", "resistor", { resistanceOhms: 1e16 }),
        part("ground", "ground"),
      ], [["source:a", "small:a"], ["small:b", "large:a"], ["large:b", "source:b"], ["ground:a", "source:b"]]);
      const expectedCurrent = 9 / (1e16 + 0.01);

      for (const mode of ["dc", "ac"] as const) {
        const result = analyzeAnalogCircuit(document, { mode });
        expect(result.status, result.message).toBe("valid");
        for (const id of ["small", "large"]) {
          expect(result.parts[id].current.real / expectedCurrent).toBeCloseTo(1, 10);
        }
        expect(result.parts.source.current.real / -expectedCurrent).toBeCloseTo(1, 10);
        expect(result.parts.small.voltage.real / (0.01 * expectedCurrent)).toBeCloseTo(1, 10);
        expect(result.parts.small.power.real / (0.01 * expectedCurrent ** 2)).toBeCloseTo(1, 10);
      }
    },
  );

  it("computes absorbed power from terminal differences even at a large common voltage", () => {
    const document = network([
      part("bias", "battery", { voltageVolts: 1e9 }),
      part("source", "battery", { voltageVolts: 1 }),
      part("r", "resistor", { resistanceOhms: 3 }),
      part("gnd", "ground"),
    ], [["bias:b", "gnd:a"], ["bias:a", "source:b"], ["source:a", "r:a"], ["source:b", "r:b"]]);
    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("valid");
    expect(result.parts.r.power.real).toBeCloseTo(result.parts.r.voltage.real * result.parts.r.current.real, 12);
    expect(result.parts.source.power.real).toBeCloseTo(result.parts.source.voltage.real * result.parts.source.current.real, 12);
    expect(result.parts.bias.current.real).toBeCloseTo(0, 12);
  });
});

describe("AC series RLC analytic response", () => {
  const resistance = 30;
  const inductance = 0.02;
  const capacitance = 2e-6;
  const resonance = 1 / (2 * Math.PI * Math.sqrt(inductance * capacitance));

  it("keeps a very small series current consistent across reactive branches", () => {
    const frequencyHz = 6.666_255_255_133_77e-7;
    const resistanceOhms = 1;
    const inductanceHenries = 267_856.600_114_970_1;
    const capacitanceFarads = 6.732_898_839_007_561e-18;
    const reactance = 2 * Math.PI * frequencyHz * inductanceHenries -
      1 / (2 * Math.PI * frequencyHz * capacitanceFarads);
    const expectedCurrent = 5 / Math.hypot(resistanceOhms, reactance);
    const document = network([
      part("source", "ac-source", { voltageVolts: 5, phaseDegrees: 23, frequencyHz }),
      part("r", "resistor", { resistanceOhms }),
      part("l", "inductor", { inductanceHenries }),
      part("c", "capacitor", { capacitanceFarads }),
    ], [["source:a", "r:a"], ["r:b", "l:a"], ["l:b", "c:a"], ["c:b", "source:b"]]);

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    for (const id of ["r", "l", "c"]) {
      const current = result.parts[id].current;
      expect(Math.hypot(current.real, current.imaginary) / expectedCurrent).toBeCloseTo(1, 10);
      expect(phasorError(current, result.parts.r.current.real, result.parts.r.current.imaginary, expectedCurrent)).toBeLessThan(1e-10);
    }
    expect(currentImbalance(result, ["source:a", "r:a"])).toBeLessThan(1e-10);
    expect(currentImbalance(result, ["r:b", "l:a"])).toBeLessThan(1e-10);
    expect(currentImbalance(result, ["l:b", "c:a"])).toBeLessThan(1e-10);
  });

  it.each(["capacitor", "inductor"] as const)(
    "preserves the small %s voltage drop and series current at a large impedance ratio",
    (kind) => {
      const frequencyHz = 1000;
      const omega = 2 * Math.PI * frequencyHz;
      const reactance = kind === "capacitor" ? -1 / omega : omega * 1e-8;
      const document = network([
        part("source", "ac-source", { voltageVolts: 9, phaseDegrees: 45, frequencyHz }),
        part("reactive", kind, { capacitanceFarads: 1, inductanceHenries: 1e-8 }),
        part("load", "resistor", { resistanceOhms: 1e16 }),
        part("ground", "ground"),
      ], [["source:a", "reactive:a"], ["reactive:b", "load:a"], ["load:b", "source:b"], ["ground:a", "source:b"]]);
      const result = analyzeAnalogCircuit(document, { mode: "ac" });
      const currentComponent = 9 / Math.sqrt(2) / 1e16;

      expect(result.status, result.message).toBe("valid");
      for (const id of ["reactive", "load"]) {
        expect(result.parts[id].current.real / currentComponent).toBeCloseTo(1, 10);
        expect(result.parts[id].current.imaginary / currentComponent).toBeCloseTo(1, 10);
      }
      expect(result.parts.reactive.voltage.real / (-reactance * currentComponent)).toBeCloseTo(1, 10);
      expect(result.parts.reactive.voltage.imaginary / (reactance * currentComponent)).toBeCloseTo(1, 10);
      expect(result.parts.reactive.power.real).toBe(0);
      expect(result.parts.reactive.power.imaginary / (2 * reactance * currentComponent ** 2)).toBeCloseTo(1, 10);
    },
  );

  it.each([0.01, 0.1, 1, 10, 100])("matches impedance, phase and complex power at %s times resonance", (ratio) => {
    const frequencyHz = resonance * ratio;
    const omega = 2 * Math.PI * frequencyHz;
    const reactance = omega * inductance - 1 / (omega * capacitance);
    const phase = Math.PI / 6;
    const voltageReal = 5 * Math.cos(phase);
    const voltageImaginary = 5 * Math.sin(phase);
    const denominator = resistance ** 2 + reactance ** 2;
    const currentReal = (voltageReal * resistance + voltageImaginary * reactance) / denominator;
    const currentImaginary = (voltageImaginary * resistance - voltageReal * reactance) / denominator;
    const currentMagnitude = Math.hypot(currentReal, currentImaginary);
    const document = network([
      part("source", "ac-source", { voltageVolts: 5, phaseDegrees: 30, frequencyHz }),
      part("r", "resistor", { resistanceOhms: resistance }),
      part("l", "inductor", { inductanceHenries: inductance }),
      part("c", "capacitor", { capacitanceFarads: capacitance }),
      part("gnd", "ground"),
    ], [["source:a", "r:a"], ["r:b", "l:a"], ["l:b", "c:a"], ["c:b", "source:b"], ["gnd:a", "source:b"]]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });

    expect(result.status).toBe("valid");
    for (const id of ["r", "l", "c"]) {
      expect(phasorError(result.parts[id].current, currentReal, currentImaginary, currentMagnitude)).toBeLessThan(1e-9);
    }
    expect(phasorError(result.parts.r.voltage, resistance * currentReal, resistance * currentImaginary, 5)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.l.voltage, -omega * inductance * currentImaginary, omega * inductance * currentReal, 5)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.c.voltage, currentImaginary / (omega * capacitance), -currentReal / (omega * capacitance), 5)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.r.power, resistance * currentMagnitude ** 2, 0)).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["source:a", "r:a"])).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["r:b", "l:a"])).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["l:b", "c:a"])).toBeLessThan(1e-9);
    expect(powerImbalance(result)).toBeLessThan(1e-9);
  });

  it("solves parallel inductors although their DC short-circuit currents are indeterminate", () => {
    const frequencyHz = 1000;
    const omega = 2 * Math.PI * frequencyHz;
    const document = network([
      part("source", "ac-source", { voltageVolts: 5, frequencyHz }),
      part("r", "resistor", { resistanceOhms: 10 }),
      part("l1", "inductor", { inductanceHenries: 0.01 }),
      part("l2", "inductor", { inductanceHenries: 0.02 }),
      part("gnd", "ground"),
    ], [
      ["source:a", "r:a"], ["r:b", "l1:a"], ["l1:a", "l2:a"],
      ["l1:b", "source:b"], ["l2:b", "source:b"], ["gnd:a", "source:b"],
    ]);
    const equivalentReactance = omega * (0.01 * 0.02) / (0.01 + 0.02);
    const denominator = 100 + equivalentReactance ** 2;
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });

    expect(result.status).toBe("valid");
    expect(phasorError(result.parts.r.current, 50 / denominator, -5 * equivalentReactance / denominator)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.l1.current, 2 * result.parts.l2.current.real, 2 * result.parts.l2.current.imaginary)).toBeLessThan(1e-9);
    expect(currentImbalance(result, ["r:b", "l1:a", "l2:a"])).toBeLessThan(1e-9);
    expect(powerImbalance(result)).toBeLessThan(1e-9);
  });

  it("matches impedance voltage division and KCL for a series resistor feeding parallel L and C", () => {
    const frequencyHz = 1000;
    const resistanceOhms = 100;
    const inductanceHenries = 0.01;
    const capacitanceFarads = 1e-6;
    const sourceVoltage = 5;
    const omega = 2 * Math.PI * frequencyHz;
    const inductorReactance = omega * inductanceHenries;
    const capacitorReactance = -1 / (omega * capacitanceFarads);
    const parallelReactance = inductorReactance * capacitorReactance /
      (inductorReactance + capacitorReactance);
    const totalImpedanceSquared = resistanceOhms ** 2 + parallelReactance ** 2;
    const expectedCurrent = {
      real: sourceVoltage * resistanceOhms / totalImpedanceSquared,
      imaginary: -sourceVoltage * parallelReactance / totalImpedanceSquared,
    };
    const expectedParallelVoltage = {
      real: sourceVoltage * parallelReactance ** 2 / totalImpedanceSquared,
      imaginary: sourceVoltage * resistanceOhms * parallelReactance / totalImpedanceSquared,
    };
    const document = network([
      part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
      part("r", "resistor", { resistanceOhms }),
      part("l", "inductor", { inductanceHenries }),
      part("c", "capacitor", { capacitanceFarads }),
      part("ground", "ground"),
    ], [
      ["source:a", "r:a"], ["r:b", "l:a"], ["l:a", "c:a"],
      ["l:b", "source:b"], ["c:b", "source:b"], ["ground:a", "source:b"],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });

    expect(result.status, result.message).toBe("valid");
    expect(phasorError(result.parts.r.current, expectedCurrent.real, expectedCurrent.imaginary, sourceVoltage / resistanceOhms))
      .toBeLessThan(1e-10);
    expect(phasorError(result.parts.r.voltage,
      resistanceOhms * expectedCurrent.real, resistanceOhms * expectedCurrent.imaginary, sourceVoltage)).toBeLessThan(1e-10);
    for (const id of ["l", "c"]) {
      expect(phasorError(result.parts[id].voltage,
        expectedParallelVoltage.real, expectedParallelVoltage.imaginary, sourceVoltage)).toBeLessThan(1e-10);
    }
    expect(phasorError({
      real: result.parts.l.current.real + result.parts.c.current.real,
      imaginary: result.parts.l.current.imaginary + result.parts.c.current.imaginary,
    }, expectedCurrent.real, expectedCurrent.imaginary, sourceVoltage / resistanceOhms)).toBeLessThan(1e-10);
    expect(currentImbalance(result, ["r:b", "l:a", "c:a"])).toBeLessThan(1e-10);
    expect(phasorError({
      real: result.parts.r.voltage.real + result.parts.c.voltage.real,
      imaginary: result.parts.r.voltage.imaginary + result.parts.c.voltage.imaginary,
    }, sourceVoltage, 0, sourceVoltage)).toBeLessThan(1e-10);
  });

  it("adds quadrature sources as phasors and balances their supplied complex power", () => {
    const frequencyHz = 1000;
    const document = network([
      part("first", "ac-source", { voltageVolts: 3, phaseDegrees: 0, frequencyHz }),
      part("second", "ac-source", { voltageVolts: 4, phaseDegrees: 90, frequencyHz }),
      part("r", "resistor", { resistanceOhms: 100 }),
      part("gnd", "ground"),
    ], [["first:b", "second:a"], ["second:b", "r:b"], ["first:a", "r:a"], ["second:b", "gnd:a"]]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });

    expect(result.status).toBe("valid");
    expect(phasorError(result.parts.r.voltage, 3, 4)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.r.current, 0.03, 0.04)).toBeLessThan(1e-9);
    expect(phasorError(result.parts.r.power, 0.25, 0)).toBeLessThan(1e-9);
    expect(powerImbalance(result)).toBeLessThan(1e-9);
  });
});
