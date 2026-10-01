import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitTerminal,
} from "../circuit-model.js";
import { analyzeAnalogCircuit, type ComplexValue } from "../analog-solver.js";
import { analyzeCircuit } from "../circuit-solver.js";

const frequencyHz = 50;

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
) => ({ id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } });

interface SourceBranchOrderCase {
  label: string;
  commonModeVolts: number;
  differentialVolts: number;
  sourceBgVoltageVolts?: number;
  sourceBgPhaseDegrees?: number;
  sourceAbPhaseDegrees?: number;
  expectedLoadVoltage?: ComplexValue;
}

function sourceOrderDocument(testCase: SourceBranchOrderCase, sourceOrder: string[]): CircuitDocument {
  const { commonModeVolts, differentialVolts } = testCase;
  const sourceById: Record<string, CircuitPart> = {
    "source-ag": part("source-ag", "ac-source", {
      voltageVolts: commonModeVolts,
      frequencyHz,
    }),
    "source-bg": part("source-bg", "ac-source", {
      voltageVolts: testCase.sourceBgVoltageVolts ?? commonModeVolts + differentialVolts,
      phaseDegrees: testCase.sourceBgPhaseDegrees ?? 0,
      frequencyHz,
    }),
    "source-ab": part("source-ab", "ac-source", {
      voltageVolts: differentialVolts,
      phaseDegrees: testCase.sourceAbPhaseDegrees ?? 180,
      frequencyHz,
    }),
  };
  return {
    title: testCase.label,
    parts: [
      ...sourceOrder.map((id) => sourceById[id]!),
      part("shunt-a", "resistor", { resistanceOhms: 13 }),
      part("shunt-b", "resistor", { resistanceOhms: 19 }),
      part("load", "resistor", { resistanceOhms: 37 }),
      part("ground", "ground"),
    ],
    wires: [
      wire("node-a", "source-ag", "a", "source-ab", "a"),
      wire("node-b", "source-bg", "a", "source-ab", "b"),
      wire("node-g", "source-ag", "b", "source-bg", "b"),
      wire("shunt-a-positive", "source-ag", "a", "shunt-a", "a"),
      wire("shunt-a-ground", "source-ag", "b", "shunt-a", "b"),
      wire("shunt-b-positive", "source-bg", "a", "shunt-b", "a"),
      wire("shunt-b-ground", "source-bg", "b", "shunt-b", "b"),
      wire("load-a", "source-ag", "a", "load", "a"),
      wire("load-b", "source-bg", "a", "load", "b"),
      wire("ground", "source-ag", "b", "ground", "a"),
    ],
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) { return [values]; }
  return values.flatMap((value, index) => permutations([
    ...values.slice(0, index),
    ...values.slice(index + 1),
  ]).map((suffix) => [value, ...suffix]));
}

function expectRelativePhasor(actual: ComplexValue, expected: ComplexValue, label: string) {
  const scale = Math.max(Math.hypot(actual.real, actual.imaginary), Math.hypot(expected.real, expected.imaginary));
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  if (scale === 0 ? error !== 0 : error / scale > 2e-8) {
    throw new Error(`${label}: actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}, relative error=${error / scale}`);
  }
}

describe("consistent ideal AC source branch order audit", () => {
  it.each<SourceBranchOrderCase>([
    { label: "small source amplitudes", commonModeVolts: 1e-30, differentialVolts: 1e-30 },
    { label: "very small source amplitudes", commonModeVolts: 1e-200, differentialVolts: 1e-200 },
    { label: "near-subnormal source amplitudes", commonModeVolts: 1e-300, differentialVolts: 1e-300 },
    { label: "large common mode at adjacent float", commonModeVolts: 2 ** 53, differentialVolts: 2 },
    { label: "larger common mode at one ULP", commonModeVolts: 2 ** 500, differentialVolts: 2 ** 448 },

  ])("keeps the redundant-source count and load voltage across all source orders: $label", (testCase) => {
    const sourceIds = ["source-ag", "source-bg", "source-ab"];
    const expectedLoadVoltage = testCase.expectedLoadVoltage ?? { real: -testCase.differentialVolts, imaginary: 0 };
    for (const order of permutations(sourceIds)) {
      const document = sourceOrderDocument(testCase, order);
      const analog = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
      expect(analog.status, `${testCase.label}, order=${order.join(",")}: ${analog.message}`).toBe("valid");
      expectRelativePhasor(analog.parts.load!.voltage, expectedLoadVoltage, `${testCase.label}, analog order=${order.join(",")}`);
      const redundantBranches = sourceIds.filter((id) => {
        const current = analog.parts[id]!.current;
        return current.real === 0 && current.imaginary === 0;
      });
      expect(redundantBranches, `${testCase.label}, order=${order.join(",")}, currents=${JSON.stringify(Object.fromEntries(sourceIds.map((id) => [id, analog.parts[id]!.current])))}`).toHaveLength(1);

      const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
      expect(scalar.status, `${testCase.label}, scalar order=${order.join(",")}: ${scalar.message}`).toBe("closed");
      const scalarPhase = (scalar.parts.load!.voltagePhaseDegrees ?? 0) * Math.PI / 180;
      expectRelativePhasor({
        real: scalar.parts.load!.voltageVolts * Math.cos(scalarPhase),
        imaginary: scalar.parts.load!.voltageVolts * Math.sin(scalarPhase),
      }, expectedLoadVoltage, `${testCase.label}, scalar order=${order.join(",")}`);
    }
  });

  it("rejects a near-axis loop whose omitted cosine curvature contradicts its ideal source amplitudes", () => {
    const testCase: SourceBranchOrderCase = {
      label: "near-axis cosine curvature",
      commonModeVolts: 1e16,
      differentialVolts: (1e16 * (Math.PI / 180)) * 1e-18,
      sourceBgVoltageVolts: 1e16,
      sourceBgPhaseDegrees: 1e-18,
      sourceAbPhaseDegrees: 270,
    };
    // cos(theta)<1 for this nonzero theta, while the third source has zero
    // real part. The two equal RMS amplitudes therefore cannot obey KVL.
    for (const order of permutations(["source-ag", "source-bg", "source-ab"])) {
      const document = sourceOrderDocument(testCase, order);
      expect(analyzeAnalogCircuit(document, { mode: "ac", frequencyHz }).status).toBe("invalid");
      expect(analyzeCircuit(document, {}, { mode: "ac", frequencyHz }).status).toBe("invalid");
    }
  });
});
