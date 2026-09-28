import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "./circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: CircuitTerminal,
  toPart: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function highResistanceBatteryCircuit({
  loadFirst,
  commonModeVolts,
  seriesLoads,
}: {
  loadFirst: boolean;
  commonModeVolts?: number;
  seriesLoads: boolean;
}): CircuitDocument {
  const battery = part("battery", "battery", {
    voltageVolts: 3,
    internalResistanceOhms: 1e20,
  });
  const loads = seriesLoads
    ? [
        part("load-1", "resistor", { resistanceOhms: 0.4 }),
        part("load-2", "resistor", { resistanceOhms: 0.6 }),
      ]
    : [part("load", "resistor", { resistanceOhms: 1 })];
  const meter = part("meter", "voltmeter");
  const commonMode = commonModeVolts === undefined
    ? []
    : [part("common-mode", "battery", { voltageVolts: Math.abs(commonModeVolts) })];
  const ground = [part("ground", "ground")];

  const wires = [
    wire("meter-positive", "meter", "a", "battery", "a"),
    wire("meter-negative", "meter", "b", "battery", "b"),
    wire("battery-load-start", "battery", "a", loads[0]!.id, "a"),
  ];
  if (seriesLoads) {
    wires.push(
      wire("load-series", "load-1", "b", "load-2", "a"),
      wire("load-battery-return", "load-2", "b", "battery", "b"),
    );
  } else {
    wires.push(wire("load-battery-return", "load", "b", "battery", "b"));
  }

  if (commonModeVolts === undefined) {
    wires.push(wire("ground-return", "ground", "a", "battery", "b"));
  } else if (commonModeVolts < 0) {
    wires.push(
      wire("ground-common-mode", "ground", "a", "common-mode", "a"),
      wire("common-mode-return", "common-mode", "b", "battery", "b"),
    );
  } else {
    wires.push(
      wire("common-mode-return", "common-mode", "a", "battery", "b"),
      wire("ground-common-mode", "ground", "a", "common-mode", "b"),
    );
  }

  return {
    title: "内部抵抗が大きい電池の端子電圧",
    parts: [
      ...(loadFirst ? [...loads, battery, meter] : [battery, ...loads, meter]),
      ...commonMode,
      ...ground,
    ],
    wires,
  };
}

function parameterizedBatteryCircuit({
  sourceVoltage,
  internalResistance,
  loadResistance,
  loadFirst,
  commonModeVolts,
}: {
  sourceVoltage: number;
  internalResistance: number;
  loadResistance: number;
  loadFirst: boolean;
  commonModeVolts?: number;
}): CircuitDocument {
  const battery = part("battery", "battery", {
    voltageVolts: sourceVoltage,
    internalResistanceOhms: internalResistance,
  });
  const load = part("load", "resistor", { resistanceOhms: loadResistance });
  const meter = part("meter", "voltmeter");
  const commonMode = commonModeVolts === undefined
    ? []
    : [part("common-mode", "battery", { voltageVolts: Math.abs(commonModeVolts) })];
  const ground = part("ground", "ground");
  const wires = [
    wire("meter-positive", "meter", "a", "battery", "a"),
    wire("meter-negative", "meter", "b", "battery", "b"),
    wire("battery-load-start", "battery", "a", "load", "a"),
    wire("load-battery-return", "load", "b", "battery", "b"),
  ];
  if (commonModeVolts === undefined) {
    wires.push(wire("ground-return", "ground", "a", "battery", "b"));
  } else if (commonModeVolts < 0) {
    wires.push(
      wire("ground-common-mode", "ground", "a", "common-mode", "a"),
      wire("common-mode-return", "common-mode", "b", "battery", "b"),
    );
  } else {
    wires.push(
      wire("common-mode-return", "common-mode", "a", "battery", "b"),
      wire("ground-common-mode", "ground", "a", "common-mode", "b"),
    );
  }
  return {
    title: "閉形式oracleによる電池内部抵抗Sweep",
    parts: [
      ...(loadFirst ? [load, battery, meter] : [battery, load, meter]),
      ...commonMode,
      ground,
    ],
    wires,
  };
}

function relativeRatio(actual: number, expected: number) {
  return actual / expected;
}

describe("high-resistance battery voltage recovery", () => {
  it.each([
    { name: "grounded, battery first, parallel load", loadFirst: false, seriesLoads: false },
    { name: "grounded, load first, parallel load", loadFirst: true, seriesLoads: false },
    { name: "100 V common mode, battery first, parallel load", loadFirst: false, commonModeVolts: 100, seriesLoads: false },
    { name: "100 V common mode, load first, parallel load", loadFirst: true, commonModeVolts: 100, seriesLoads: false },
    { name: "grounded, series loads provide an alternate path", loadFirst: false, seriesLoads: true },
    { name: "100 V common mode, series loads provide an alternate path", loadFirst: false, commonModeVolts: 100, seriesLoads: true },
  ])("recovers the battery and meter voltage for $name", ({ loadFirst, commonModeVolts, seriesLoads }) => {
    const analysis = analyzeAnalogCircuit(highResistanceBatteryCircuit({ loadFirst, commonModeVolts, seriesLoads }));
    const totalLoadResistance = seriesLoads ? 0.4 + 0.6 : 1;
    const expectedCurrent = 3 / (1e20 + totalLoadResistance);
    const expectedVoltage = expectedCurrent * totalLoadResistance;

    expect(analysis.status, analysis.message).toBe("valid");
    expect(relativeRatio(analysis.parts.meter!.voltage.real, expectedVoltage), "voltmeter voltage").toBeCloseTo(1, 9);
    expect(relativeRatio(analysis.parts.battery!.voltage.real, expectedVoltage), "battery terminal voltage").toBeCloseTo(1, 9);
    if (seriesLoads) {
      expect(relativeRatio(analysis.parts["load-1"]!.voltage.real, expectedCurrent * 0.4), "first series load voltage").toBeCloseTo(1, 9);
      expect(relativeRatio(analysis.parts["load-2"]!.voltage.real, expectedCurrent * 0.6), "second series load voltage").toBeCloseTo(1, 9);
    } else {
      expect(relativeRatio(analysis.parts.load!.voltage.real, expectedVoltage), "load voltage").toBeCloseTo(1, 9);
    }
  });

  it("keeps the AC battery internal-resistance drop when the DC source is suppressed", () => {
    const document: CircuitDocument = {
      title: "交流小信号での電池内部抵抗",
      parts: [
        part("source", "ac-source", { voltageVolts: 3, frequencyHz: 1000 }),
        part("battery", "battery", { voltageVolts: 9, internalResistanceOhms: 1e20 }),
        part("load", "resistor", { resistanceOhms: 1 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("source-load", "source", "a", "load", "a"),
        wire("load-battery", "load", "b", "battery", "a"),
        wire("battery-source-return", "battery", "b", "source", "b"),
        wire("meter-load-positive", "meter", "a", "load", "a"),
        wire("meter-load-negative", "meter", "b", "load", "b"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(analysis.status, analysis.message).toBe("valid");
    expect(relativeRatio(analysis.parts.load!.voltage.real, 3e-20), "AC load voltage").toBeCloseTo(1, 9);
    expect(relativeRatio(analysis.parts.meter!.voltage.real, 3e-20), "AC voltmeter voltage").toBeCloseTo(1, 9);
    expect(relativeRatio(analysis.parts.battery!.voltage.real, 3), "AC battery internal-resistance voltage").toBeCloseTo(1, 9);
  });

  it.each([
    { sourceVoltage: 3, internalResistance: 1e20, loadResistance: 1 },
    { sourceVoltage: 0.25, internalResistance: 1e12, loadResistance: 1e6 },
    { sourceVoltage: 12, internalResistance: 1e6, loadResistance: 1e12 },
    { sourceVoltage: 5, internalResistance: 1e-12, loadResistance: 1 },
    { sourceVoltage: 2, internalResistance: 10, loadResistance: 1e-6 },
    { sourceVoltage: 7, internalResistance: 1e-6, loadResistance: 10 },
  ])("matches the divider oracle across resistance scales ($internalResistance Ω / $loadResistance Ω)", (values) => {
    for (const loadFirst of [false, true]) {
      for (const commonModeVolts of [undefined, 100, -100, 1e6, -1e6]) {
        const analysis = analyzeAnalogCircuit(parameterizedBatteryCircuit({
          ...values,
          loadFirst,
          commonModeVolts,
        }));
        const expectedVoltage = values.sourceVoltage * values.loadResistance /
          (values.internalResistance + values.loadResistance);

        expect(analysis.status, analysis.message).toBe("valid");
        expect(relativeRatio(analysis.parts.load!.voltage.real, expectedVoltage), "load voltage").toBeCloseTo(1, 8);
        expect(relativeRatio(analysis.parts.meter!.voltage.real, expectedVoltage), "voltmeter voltage").toBeCloseTo(1, 8);
        expect(relativeRatio(analysis.parts.battery!.voltage.real, expectedVoltage), "battery terminal voltage").toBeCloseTo(1, 8);
      }
    }
  });
});
