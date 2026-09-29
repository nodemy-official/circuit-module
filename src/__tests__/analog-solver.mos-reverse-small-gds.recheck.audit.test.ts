import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
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

it("retains reverse-saturation MOS output conductance below the gm ulp", () => {
  const lambda = 1e-20;
  const beta = 2;
  const overdrive = 1;
  const document: CircuitDocument = {
    title: "Reverse MOS with sub-ulp output conductance",
    parts: [
      part("ground", "ground"),
      part("gate-bias", "battery", { voltageVolts: 2 }),
      part("source-drive", "ac-source", {
        voltageVolts: 1,
        offsetVolts: 1,
        frequencyHz: 1000,
      }),
      part("mos", "nmos", {
        thresholdVolts: 1,
        transconductanceAmpsPerVoltSquared: beta,
        channelLengthModulation: lambda,
      }),
    ],
    wires: [
      wire("gate-positive", "gate-bias", "a", "mos", "b"),
      wire("gate-reference", "gate-bias", "b", "ground", "a"),
      wire("source-positive", "source-drive", "a", "mos", "c"),
      wire("source-reference", "source-drive", "b", "ground", "a"),
      wire("drain-reference", "mos", "a", "ground", "a"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
  const independentDrainCurrent = -0.5 * lambda * beta * overdrive * overdrive;

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.mos!.terminalVoltages.a!.real).toBe(0);
  expect(analysis.parts.mos!.terminalVoltages.b!.real).toBe(0);
  expect(analysis.parts.mos!.terminalVoltages.c!.real).toBe(1);
  expect(analysis.parts.mos!.terminalCurrents.a!.real).toBe(independentDrainCurrent);
});
