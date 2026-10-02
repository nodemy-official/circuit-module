import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";

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

it("keeps published DC floating-node gauges consistent with the MOS bias equation", () => {
  const document: CircuitDocument = {
    title: "Floating MOS gate with a current-set operating point",
    parts: [
      part("ground", "ground"),
      part("mos", "nmos", {
        thresholdVolts: 0,
        transconductanceAmpsPerVoltSquared: 2,
        channelLengthModulation: 0,
      }),
      part("load-current", "current-source", { currentAmps: -1 }),
      part("gate-source-meter", "voltmeter"),
    ],
    wires: [
      wire("source-ground", "mos", "c", "ground", "a"),
      wire("load-drain", "load-current", "a", "mos", "a"),
      wire("load-return", "load-current", "b", "ground", "a"),
      wire("meter-gate", "gate-source-meter", "a", "mos", "b"),
      wire("meter-source", "gate-source-meter", "b", "mos", "c"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode: "dc" });

  expect(analysis.status, analysis.message).toBe("valid");
  const mos = analysis.parts.mos!;
  const vgs = mos.terminalVoltages.b!.real - mos.terminalVoltages.c!.real;
  const vds = mos.terminalVoltages.a!.real - mos.terminalVoltages.c!.real;
  const overdrive = Math.max(vgs, 0);
  const independentDrainCurrent = vds < overdrive
    ? 2 * (overdrive * vds - 0.5 * vds * vds)
    : overdrive * overdrive;

  expect(mos.current.real).toBe(1);
  expect(independentDrainCurrent).toBeCloseTo(mos.current.real, 12);
  expect(analysis.parts["gate-source-meter"]!.meterStatus).toBe("floating");
});
