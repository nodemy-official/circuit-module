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

const wire = (
  id: string,
  fromPart: string,
  fromTerminal: "a" | "b" | "c",
  toPart: string,
  toTerminal: "a" | "b" | "c",
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function opAmpReferenceDocument({
  inputOffset,
  positiveRail,
  negativeRail,
}: {
  inputOffset: number;
  positiveRail: number;
  negativeRail: number;
}): CircuitDocument {
  return {
    title: "交流再基準化とOPアンプ動作点監査",
    parts: [
      part("ground", "ground"),
      part("common-mode", "ac-source", {
        voltageVolts: 1e12,
        offsetVolts: 1.5,
        phaseDegrees: 31,
        frequencyHz: 1000,
      }),
      part("differential", "ac-source", {
        voltageVolts: 0.1,
        offsetVolts: inputOffset,
        phaseDegrees: 90,
        frequencyHz: 1000,
      }),
      part("opamp", "op-amp", {
        openLoopGain: 1e8,
        positiveRailVolts: positiveRail,
        negativeRailVolts: negativeRail,
      }),
      part("load", "resistor", { resistanceOhms: 1000 }),
      part("meter", "voltmeter"),
    ],
    wires: [
      wire("common-return", "common-mode", "b", "ground", "a"),
      wire("common-positive", "common-mode", "a", "differential", "a"),
      wire("positive-input", "differential", "a", "opamp", "a"),
      wire("negative-input", "differential", "b", "opamp", "b"),
      wire("output-load", "opamp", "c", "load", "a"),
      wire("load-return", "load", "b", "ground", "a"),
      wire("meter-output", "meter", "a", "opamp", "c"),
      wire("meter-return", "meter", "b", "ground", "a"),
    ],
  };
}

describe("AC nonlinear reference readings", () => {
  it.each([
    { name: "positive rail", inputOffset: 0.75, positiveRail: 100e6, negativeRail: -50e6 },
    { name: "negative rail", inputOffset: -0.75, positiveRail: 50e6, negativeRail: -100e6 },
  ])("keeps $name clipping and terminal KCL after AC re-referencing", (scenario) => {
    const result = analyzeAnalogCircuit(opAmpReferenceDocument(scenario), { mode: "ac" });
    const expectedOutputVoltageVolts = 1e8 * 0.1 * 1000 / (1000 + 20);
    const expectedOutputCurrentAmps = expectedOutputVoltageVolts / 1000;
    const outputVoltage = result.parts.opamp.voltage;
    const opAmpCurrentReading = result.parts.opamp.terminalCurrents.c;
    const opAmpCurrent = opAmpCurrentReading ?? { real: 0, imaginary: 0 };
    const opAmpOutputVoltageReading = result.parts.opamp.terminalVoltages.c;
    const opAmpOutputVoltage = opAmpOutputVoltageReading ?? { real: 0, imaginary: 0 };
    const loadCurrent = result.parts.load.current;

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.differential.voltage.real).toBeCloseTo(0, 10);
    expect(result.parts.differential.voltage.imaginary).toBeCloseTo(0.1, 10);
    expect(opAmpCurrentReading).toBeDefined();
    expect(opAmpOutputVoltageReading).toBeDefined();
    expect(result.parts.opamp.terminalCurrents.a?.real).toBeCloseTo(0, 12);
    expect(result.parts.opamp.terminalCurrents.a?.imaginary).toBeCloseTo(0, 12);
    expect(result.parts.opamp.terminalCurrents.b?.real).toBeCloseTo(0, 12);
    expect(result.parts.opamp.terminalCurrents.b?.imaginary).toBeCloseTo(0, 12);
    expect(opAmpCurrent.real).toBeCloseTo(0, 8);
    expect(opAmpCurrent.imaginary / -expectedOutputCurrentAmps).toBeCloseTo(1, 8);
    expect(loadCurrent.imaginary / expectedOutputCurrentAmps).toBeCloseTo(1, 8);
    expect((opAmpCurrent.imaginary + loadCurrent.imaginary) / expectedOutputCurrentAmps).toBeCloseTo(0, 8);
    expect(outputVoltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
    expect(opAmpOutputVoltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
    expect(result.parts.opamp.power.real / -(expectedOutputVoltageVolts * expectedOutputCurrentAmps)).toBeCloseTo(1, 8);
    expect(result.parts.opamp.power.imaginary).toBeCloseTo(0, 12);
    expect(result.parts.load.voltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
    expect(result.parts.meter.voltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
  });

  it("keeps the implicit physical return node when AC re-referencing a circuit without GND", () => {
    const document: CircuitDocument = {
      title: "GND端子のない交流OPアンプ回路",
      parts: [
        part("common-mode", "ac-source", {
          voltageVolts: 1e12,
          offsetVolts: 1.5,
          phaseDegrees: 31,
          frequencyHz: 1000,
        }),
        part("differential", "ac-source", {
          voltageVolts: 0.1,
          offsetVolts: 0.75,
          phaseDegrees: 90,
          frequencyHz: 1000,
        }),
        part("opamp", "op-amp", {
          openLoopGain: 1e8,
          positiveRailVolts: 100e6,
          negativeRailVolts: -50e6,
        }),
        part("load", "resistor", { resistanceOhms: 1000 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("high-positive", "common-mode", "a", "load", "b"),
        wire("high-negative", "common-mode", "b", "differential", "a"),
        wire("positive-input", "differential", "a", "opamp", "a"),
        wire("negative-input", "differential", "b", "opamp", "b"),
        wire("output-load", "opamp", "c", "load", "a"),
        wire("meter-output", "meter", "a", "opamp", "c"),
        wire("meter-return", "meter", "b", "common-mode", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    const expectedOutputVoltageVolts = 1e8 * 0.1 * 1000 / (1000 + 20);
    const expectedOutputCurrentAmps = expectedOutputVoltageVolts / 1000;
    const outputCurrentReading = result.parts.opamp.terminalCurrents.c;
    const outputCurrent = outputCurrentReading ?? { real: 0, imaginary: 0 };

    expect(result.status, result.message).toBe("valid");
    expect(outputCurrentReading).toBeDefined();
    expect(result.parts.differential.voltage.imaginary).toBeCloseTo(0.1, 10);
    expect(result.parts.opamp.voltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
    expect(outputCurrent.imaginary / -expectedOutputCurrentAmps).toBeCloseTo(1, 8);
    expect(result.parts.load.current.imaginary / expectedOutputCurrentAmps).toBeCloseTo(1, 8);
    expect(result.parts.meter.voltage.imaginary / expectedOutputVoltageVolts).toBeCloseTo(1, 8);
  });

  it("uses the original DC node indexing for a biased diode after AC re-referencing", () => {
    const document: CircuitDocument = {
      title: "交流再基準化後のダイオード動作点",
      parts: [
        part("ground", "ground"),
        part("common-mode", "ac-source", {
          voltageVolts: 1e12,
          offsetVolts: 1.5,
          phaseDegrees: 31,
          frequencyHz: 1000,
        }),
        part("differential", "ac-source", {
          voltageVolts: 1e-4,
          offsetVolts: 0.5,
          phaseDegrees: 90,
          frequencyHz: 1000,
        }),
        part("diode", "diode"),
      ],
      wires: [
        wire("common-return", "common-mode", "b", "ground", "a"),
        wire("common-positive", "common-mode", "a", "differential", "a"),
        wire("diode-anode", "differential", "a", "diode", "a"),
        wire("diode-cathode", "differential", "b", "diode", "b"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac" });
    const saturationCurrent = 1e-12;
    const diodeConductance = (dc.parts.diode.current.real + saturationCurrent) / 0.025_85;

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.diode.voltage.real).toBeCloseTo(0.5, 10);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.diode.voltage.real).toBeCloseTo(0, 10);
    expect(ac.parts.diode.voltage.imaginary).toBeCloseTo(1e-4, 10);
    expect(ac.parts.diode.current.real).toBeCloseTo(0, 10);
    expect(ac.parts.diode.current.imaginary / (diodeConductance * 1e-4)).toBeCloseTo(1, 8);
  });
});
