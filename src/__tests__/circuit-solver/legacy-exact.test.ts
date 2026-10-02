import { expect, it } from "vitest";

import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import {
  divideExactRational,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
} from "../../exact-linear-algebra.js";

const part = (id: string, kind: CircuitPart["kind"], extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (
  id: string,
  from: string,
  fromTerminal: "a" | "b",
  to: string,
  toTerminal: "a" | "b",
) => ({ id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } });

it("preserves a small net EMF when large parallel battery source terms cancel", () => {
  const document: CircuitDocument = {
    title: "大きな並列電池電圧の相殺",
    parts: [
      part("positive", "junction"),
      part("negative", "junction"),
      part("load", "resistor", { resistanceOhms: 1e-6 }),
      part("meter", "voltmeter"),
      part("high-positive", "battery", { voltageVolts: 1e16 }),
      part("small", "battery", { voltageVolts: 1 }),
      part("high-negative", "battery", { voltageVolts: 1e16 }),
    ],
    wires: [
      wire("load-positive", "load", "a", "positive", "a"),
      wire("load-negative", "load", "b", "negative", "a"),
      wire("meter-positive", "meter", "a", "positive", "a"),
      wire("meter-negative", "meter", "b", "negative", "a"),
      wire("positive-source-a", "high-positive", "a", "positive", "a"),
      wire("negative-source-a", "high-positive", "b", "negative", "a"),
      wire("positive-source-b", "small", "a", "positive", "a"),
      wire("negative-source-b", "small", "b", "negative", "a"),
      wire("negative-source-c", "high-negative", "a", "negative", "a"),
      wire("positive-source-c", "high-negative", "b", "positive", "a"),
    ],
  };

  const analysis = analyzeCircuit(document);
  const one = numberToExactRational(1)!;
  const twelfth = divideExactRational(one, numberToExactRational(12)!)!;
  const exactResistance = numberToExactRational(1e-6)!;
  const exactCurrent = divideExactRational(twelfth, exactResistance)!;
  const exactPower = multiplyExactRational(twelfth, exactCurrent);
  const expectedCurrent = exactRationalToNumber(exactCurrent);

  expect(analysis.parts.meter.voltageVolts).toBeCloseTo(0.25, 12);
  expect(analysis.parts.load.voltageVolts).toBe(exactRationalToNumber(twelfth));
  expect(analysis.parts.load.currentAmps).toBe(expectedCurrent);
  expect(analysis.parts.load.powerWatts).toBe(exactRationalToNumber(exactPower));
  expect(analysis.wireCurrents["load-positive"]).toBe(-expectedCurrent);
});
