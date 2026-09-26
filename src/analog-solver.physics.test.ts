import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "./analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...values,
});

const wire = (id: string, fromPart: string, fromTerminal: CircuitTerminal, toPart: string, toTerminal: CircuitTerminal) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function mosAt(drain: number, gate: number, source: number): CircuitDocument {
  const parts: CircuitPart[] = [part("mos", "nmos", {
    thresholdVolts: 2,
    transconductanceAmpsPerVoltSquared: 0.02,
    channelLengthModulation: 0,
  }), part("ground", "ground")];
  const wires: CircuitDocument["wires"] = [];
  const connectBias = (terminal: CircuitTerminal, voltage: number, suffix: string) => {
    if (voltage === 0) {
      wires.push(wire(`w${suffix}-ground`, "mos", terminal, "ground", "a"));
      return;
    }
    const batteryId = `bias-${suffix}`;
    parts.push(part(batteryId, "battery", { voltageVolts: voltage }));
    wires.push(
      wire(`w${suffix}-bias`, batteryId, "a", "mos", terminal),
      wire(`w${suffix}-return`, batteryId, "b", "ground", "a"),
    );
  };
  connectBias("a", drain, "drain");
  connectBias("b", gate, "gate");
  connectBias("c", source, "source");
  return { title: "MOSFET動作領域", parts, wires };
}

function bjtAt(collector: number, base: number, emitter: number, currentGain = 100): CircuitDocument {
  const parts: CircuitPart[] = [
    part("transistor", "npn-transistor", { currentGain }),
    part("ground", "ground"),
  ];
  const wires: CircuitDocument["wires"] = [];
  for (const [terminal, voltage] of [["a", collector], ["b", base], ["c", emitter]] as const) {
    if (voltage === 0) {
      wires.push(wire(`w-${terminal}-ground`, "transistor", terminal, "ground", "a"));
    } else {
      const sourceId = `bias-${terminal}`;
      parts.push(part(sourceId, "battery", { voltageVolts: voltage }));
      wires.push(
        wire(`w-${terminal}-bias`, sourceId, "a", "transistor", terminal),
        wire(`w-${terminal}-return`, sourceId, "b", "ground", "a"),
      );
    }
  }
  return { title: "NPN動作点", parts, wires };
}

describe("analog solver physical model regressions", () => {
  it.each([
    { mode: "cutoff", drain: 5, gate: 1, source: 0, current: 0 },
    { mode: "triode", drain: 1, gate: 4, source: 0, current: 0.03 },
    { mode: "saturation", drain: 5, gate: 4, source: 0, current: 0.04 },
    { mode: "reverse channel", drain: 1, gate: 8, source: 5, current: -0.24 },
  ])("computes NMOS $mode current with the square-law model", ({ drain, gate, source, current }) => {
    const result = analyzeAnalogCircuit(mosAt(drain, gate, source));

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.mos.terminalCurrents.a?.real).toBeCloseTo(current, current === 0 ? 12 : 4);
    expect(result.parts.mos.terminalCurrents.a!.real + result.parts.mos.terminalCurrents.b!.real +
      result.parts.mos.terminalCurrents.c!.real).toBeCloseTo(0, 12);
  });

  it("starts an initially cut-off NMOS from its bias point for a current-source load", () => {
    const document: CircuitDocument = {
      title: "電流源負荷のNMOS",
      parts: [
        part("source", "current-source", { currentAmps: 0.01 }),
        part("gate-bias", "battery", { voltageVolts: 4 }),
        part("mos", "nmos", {
          thresholdVolts: 2,
          transconductanceAmpsPerVoltSquared: 0.02,
          channelLengthModulation: 0,
        }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "source", "a", "ground", "a"),
        wire("w2", "source", "b", "mos", "a"),
        wire("w3", "mos", "b", "gate-bias", "a"),
        wire("w4", "gate-bias", "b", "ground", "a"),
        wire("w5", "mos", "c", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.mos.voltage.real).toBeCloseTo(2 - Math.sqrt(3), 8);
    expect(result.parts.mos.current.real).toBeCloseTo(0.01, 10);
  });

  it("conserves BJT terminal current and gives the configured forward beta", () => {
    const beta = 100;
    const result = analyzeAnalogCircuit(bjtAt(5, 0.7, 0, beta));

    expect(result.status, result.message).toBe("valid");
    const currents = result.parts.transistor.terminalCurrents;
    expect(currents.a!.real / currents.b!.real).toBeCloseTo(beta, 6);
    expect(currents.a!.real + currents.b!.real + currents.c!.real).toBeCloseTo(0, 12);
  });

  it("matches the finite-gain closed-loop op-amp output under load", () => {
    const gain = 1000;
    const lower = 10_000;
    const feedback = 90_000;
    const load = 1000;
    const outputResistance = 20;
    const input = 1;
    const feedbackFraction = lower / (lower + feedback);
    const expectedOutput = gain * input /
      (1 + gain * feedbackFraction + outputResistance * (1 / load + 1 / (lower + feedback)));
    const document: CircuitDocument = {
      title: "有限利得の非反転増幅回路",
      parts: [
        part("input", "battery", { voltageVolts: input }),
        part("opamp", "op-amp", { openLoopGain: gain }),
        part("feedback", "resistor", { resistanceOhms: feedback }),
        part("lower", "resistor", { resistanceOhms: lower }),
        part("load", "resistor", { resistanceOhms: load }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "input", "a", "opamp", "a"),
        wire("w2", "input", "b", "ground", "a"),
        wire("w3", "opamp", "c", "feedback", "a"),
        wire("w4", "feedback", "b", "lower", "a"),
        wire("w5", "lower", "b", "ground", "a"),
        wire("w6", "feedback", "b", "opamp", "b"),
        wire("w7", "opamp", "c", "load", "a"),
        wire("w8", "load", "b", "ground", "a"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.opamp.terminalVoltages.c?.real).toBeCloseTo(expectedOutput, 8);
    expect(result.parts.opamp.terminalVoltages.b?.real).toBeCloseTo(
      expectedOutput * feedbackFraction,
      8,
    );
  });

  it.each([1e-12, 1e-20, 1e-30])(
    "keeps a diode micro-signal independent of GMIN at Is=%s A",
    (saturationCurrent) => {
      const current = saturationCurrent * 0.01;
      const thermalVoltage = 0.025_85;
      const document: CircuitDocument = {
        title: "微小電流のダイオード動作点",
        parts: [
          part("source", "current-source", { currentAmps: current }),
          part("diode", "diode", { saturationCurrentAmps: saturationCurrent }),
        ],
        wires: [
          wire("w1", "source", "a", "diode", "a"),
          wire("w2", "source", "b", "diode", "b"),
        ],
      };

      const result = analyzeAnalogCircuit(document);

      expect(result.status, result.message).toBe("valid");
      expect(Math.abs(result.parts.diode.current.real + current) / current).toBeLessThan(1e-9);
      expect(result.parts.diode.voltage.real).toBeCloseTo(
        thermalVoltage * Math.log(1 - current / saturationCurrent),
        8,
      );
    },
  );

  it("rejects finite inputs whose computed component power overflows", () => {
    const document: CircuitDocument = {
      title: "電力オーバーフロー",
      parts: [
        part("source", "battery", { voltageVolts: 1e200 }),
        part("load", "resistor", { resistanceOhms: 1e-100 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "source", "b", "load", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document);

    expect(result.status).toBe("invalid");
    expect(result.message).toContain("有限でない");
  });

  it("uses relative frequency matching below one nanohertz", () => {
    const document: CircuitDocument = {
      title: "極低周波の電源",
      parts: [
        part("source", "ac-source", { voltageVolts: 3, frequencyHz: 1e-10 }),
        part("load", "resistor", { resistanceOhms: 10 }),
      ],
      wires: [
        wire("w1", "source", "a", "load", "a"),
        wire("w2", "source", "b", "load", "b"),
      ],
    };

    const mismatched = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 2e-10 });
    const matched = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1.000_000_000_5e-10 });

    expect(mismatched.status).toBe("valid");
    expect(mismatched.parts.load.voltage.real).toBeCloseTo(0, 12);
    expect(mismatched.issues.some((issue) => issue.message.includes("異なる"))).toBe(true);
    expect(matched.status).toBe("valid");
    expect(matched.parts.load.voltage.real).toBeCloseTo(3, 8);
  });
});
