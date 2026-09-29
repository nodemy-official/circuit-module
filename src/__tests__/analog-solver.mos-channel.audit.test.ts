import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
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
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

function diodeConnectedNmos(): CircuitDocument {
  return {
    title: "チャネル長変調のないダイオード接続NMOS",
    parts: [
      part("supply", "battery", { voltageVolts: 5 }),
      part("load", "resistor", { resistanceOhms: 100 }),
      part("signal", "ac-source", { voltageVolts: 1e-3, frequencyHz: 1000 }),
      part("mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: 0.02,
        channelLengthModulation: 0,
      }),
      part("ground", "ground"),
    ],
    wires: [
      wire("supply-load", "supply", "a", "load", "a"),
      wire("load-signal", "load", "b", "signal", "a"),
      wire("signal-mos", "signal", "b", "mos", "a"),
      wire("diode-connection", "mos", "a", "mos", "b"),
      wire("mos-ground", "mos", "c", "ground", "a"),
      wire("supply-ground", "supply", "b", "ground", "a"),
    ],
  };
}

it("keeps a lambda-zero diode-connected MOS channel responsive in DC and AC", () => {
  const document = diodeConnectedNmos();
  const dc = analyzeAnalogCircuit(document, { mode: "dc" });
  const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.mos.channelConducting).toBe(true);
  const expectedDcVoltage = (3 + Math.sqrt(13)) / 2;
  expect(dc.parts.mos.terminalVoltages.a!.real).toBeCloseTo(expectedDcVoltage, 10);
  expect(ac.status, ac.message).toBe("valid");
  expect(ac.parts.mos.channelConducting).toBe(true);
  const expectedAcMagnitude = 1e-3 / Math.sqrt(13);
  expect(Math.hypot(ac.parts.mos.voltage.real, ac.parts.mos.voltage.imaginary)).toBeCloseTo(expectedAcMagnitude, 8);
});

it("lets a current source bias a diode-connected MOS that starts at cutoff", () => {
  const document: CircuitDocument = {
    title: "カットオフから電流源で立ち上がるNMOS",
    parts: [
      part("source", "current-source", { currentAmps: 0.01 }),
      part("mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: 0.02,
        channelLengthModulation: 0,
      }),
      part("ground", "ground"),
    ],
    wires: [
      wire("source-return", "source", "a", "ground", "a"),
      wire("source-drain", "source", "b", "mos", "a"),
      wire("diode-connection", "mos", "a", "mos", "b"),
      wire("mos-return", "mos", "c", "ground", "a"),
    ],
  };

  const dc = analyzeAnalogCircuit(document, { mode: "dc" });
  const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.mos.channelConducting).toBe(true);
  expect(dc.parts.mos.terminalVoltages.a!.real).toBeCloseTo(3, 10);
  expect(dc.parts.mos.current.real).toBeCloseTo(0.01, 10);
  expect(ac.status, ac.message).toBe("valid");
  expect(ac.parts.mos.channelConducting).toBe(true);
});

it("seeds current-biased diode-connected and independently gate-biased MOS devices together", () => {
  const document: CircuitDocument = {
    title: "異なる初期条件の電流源負荷NMOS",
    parts: [
      part("diode-load", "current-source", { currentAmps: 0.01 }),
      part("diode-mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: 0.02,
        channelLengthModulation: 0,
      }),
      part("gate-bias", "battery", { voltageVolts: 4 }),
      part("drain-load", "current-source", { currentAmps: 0.01 }),
      part("biased-mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: 0.02,
        channelLengthModulation: 0,
      }),
      part("ground", "ground"),
    ],
    wires: [
      wire("diode-load-return", "diode-load", "a", "ground", "a"),
      wire("diode-load-drain", "diode-load", "b", "diode-mos", "a"),
      wire("diode-connection", "diode-mos", "a", "diode-mos", "b"),
      wire("diode-mos-return", "diode-mos", "c", "ground", "a"),
      wire("gate-return", "gate-bias", "b", "ground", "a"),
      wire("gate-drive", "gate-bias", "a", "biased-mos", "b"),
      wire("drain-load-return", "drain-load", "a", "ground", "a"),
      wire("drain-load-drain", "drain-load", "b", "biased-mos", "a"),
      wire("biased-mos-return", "biased-mos", "c", "ground", "a"),
    ],
  };

  const dc = analyzeAnalogCircuit(document, { mode: "dc" });
  const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts["diode-mos"].channelConducting).toBe(true);
  expect(dc.parts["diode-mos"].terminalVoltages.a!.real).toBeCloseTo(3, 10);
  expect(dc.parts["diode-mos"].current.real).toBeCloseTo(0.01, 10);
  expect(dc.parts["biased-mos"].channelConducting).toBe(true);
  expect(dc.parts["biased-mos"].terminalVoltages.a!.real).toBeCloseTo(2 - Math.sqrt(3), 10);
  expect(dc.parts["biased-mos"].terminalVoltages.b!.real).toBeCloseTo(4, 10);
  expect(dc.parts["biased-mos"].current.real).toBeCloseTo(0.01, 10);
  expect(ac.status, ac.message).toBe("valid");
  expect(ac.parts["diode-mos"].channelConducting).toBe(true);
  expect(ac.parts["biased-mos"].channelConducting).toBe(true);
});
