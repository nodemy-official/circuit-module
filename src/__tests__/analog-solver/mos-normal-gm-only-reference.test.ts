import { expect, it } from "vitest";

import { analyzeCircuit } from "../../circuit-solver.js";
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

it("publishes the forward gm-only gate-source reference at the exact saturation boundary", () => {
  const document: CircuitDocument = {
    title: "Forward lambda-zero MOS at saturation boundary",
    parts: [
      part("ground", "ground"),
      part("mos", "nmos", {
        thresholdVolts: 0,
        transconductanceAmpsPerVoltSquared: 2,
        channelLengthModulation: 0,
      }),
      part("load-current", "current-source", { currentAmps: -1 }),
    ],
    wires: [
      wire("drain-gate-feedback", "mos", "a", "mos", "b"),
      wire("source-ground", "mos", "c", "ground", "a"),
      wire("load-drain", "load-current", "a", "mos", "a"),
      wire("load-return", "load-current", "b", "ground", "a"),
    ],
  };

  const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

  expect(analysis.status, analysis.message).toBe("idle");
  expect(analysis.parts.mos!.channelConducting).toBe(true);
  expect(analysis.parts.mos!.acReferenceTerminalGroups).toContainEqual(["b", "c"]);
  expect(analysis.parts.mos!.acReferenceTerminalGroups).toContainEqual(["a", "c"]);
});

it("does not call a gm-only MOS path a return for a drain-source drive with fixed Vgs", () => {
  const document: CircuitDocument = {
    title: "Lambda-zero MOS with fixed AC gate-source voltage",
    parts: [
      part("ground", "ground"),
      part("gate-bias", "battery", { voltageVolts: 2 }),
      part("drain-drive", "ac-source", {
        voltageVolts: 1,
        offsetVolts: 1,
        frequencyHz: 1000,
      }),
      part("mos", "nmos", {
        thresholdVolts: 1,
        transconductanceAmpsPerVoltSquared: 2,
        channelLengthModulation: 0,
      }),
    ],
    wires: [
      wire("gate-voltage", "gate-bias", "a", "mos", "b"),
      wire("gate-reference", "gate-bias", "b", "ground", "a"),
      wire("drain-voltage", "drain-drive", "a", "mos", "a"),
      wire("drain-reference", "drain-drive", "b", "ground", "a"),
      wire("source-ground", "mos", "c", "ground", "a"),
    ],
  };

  const analysis = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

  expect(analysis.status, analysis.message).toBe("closed");
  expect(analysis.parts.mos!.acCurrentResponseTerminalGroups).toEqual([["a", "c"]]);
  expect(analysis.parts.mos!.terminalCurrents!.a).toBe(0);
  expect(analysis.parts["drain-drive"]!.currentAmps).toBe(0);
});
