import { describe, expect, it } from "vitest";

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
  it("keeps millivolt drops accurate after two large series AC common-mode sources", () => {
    const document: CircuitDocument = {
      title: "直列高電位源上の微小交流降下",
      parts: [
        part("high1", "ac-source", { voltageVolts: 1e12, frequencyHz: 1000 }),
        part("high2", "ac-source", { voltageVolts: 1e12, frequencyHz: 1000 }),
        part("small", "ac-source", { voltageVolts: 3e-3, frequencyHz: 1000 }),
        part("r1", "resistor", { resistanceOhms: 1e-3 }),
        part("r2", "resistor", { resistanceOhms: 1e-3 }),
        part("r3", "resistor", { resistanceOhms: 1e-3 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("ground", "ground", "a", "high1", "b"),
        wire("high-sources", "high1", "a", "high2", "b"),
        wire("high-small", "high2", "a", "small", "a"),
        wire("chain-start", "high2", "a", "r1", "a"),
        wire("chain-1", "r1", "b", "r2", "a"),
        wire("chain-2", "r2", "b", "r3", "a"),
        wire("chain-end", "r3", "b", "small", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    for (const id of ["r1", "r2", "r3"]) {
      expect(result.parts[id]?.current.real).toBeCloseTo(1, 10);
      expect(result.parts[id]?.voltage.real).toBeCloseTo(1e-3, 10);
    }
    expect(result.parts.small.voltage.real).toBeCloseTo(3e-3, 10);
    expect(result.parts.ground.terminalVoltages.a).toEqual({ real: 0, imaginary: 0 });
  });

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

  it("linearizes an AC diode around the operating point set by the source DC offset", () => {
    const resistance = 1000;
    const sourceAmplitude = 0.01;
    const saturationCurrent = 1e-12;
    const thermalVoltage = 0.025_85;
    const document: CircuitDocument = {
      title: "オフセットでバイアスしたダイオードの交流応答",
      parts: [
        part("source", "ac-source", {
          voltageVolts: sourceAmplitude,
          offsetVolts: 5,
          frequencyHz: 1000,
        }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("diode", "diode", { saturationCurrentAmps: saturationCurrent }),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "diode", "a"),
        wire("w3", "diode", "b", "source", "b"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.source.voltage.real).toBeCloseTo(5, 10);
    expect(dc.parts.diode.current.real).toBeGreaterThan(0.004);
    expect(dc.parts.diode.current.real).toBeLessThan(0.005);

    const diodeConductance = (dc.parts.diode.current.real + saturationCurrent) / thermalVoltage;
    const expectedCurrent = sourceAmplitude / (resistance + 1 / diodeConductance);
    const expectedDiodeVoltage = expectedCurrent / diodeConductance;

    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.diode.current.real).toBeCloseTo(expectedCurrent, 10);
    expect(ac.parts.diode.current.imaginary).toBeCloseTo(0, 12);
    expect(ac.parts.diode.voltage.real).toBeCloseTo(expectedDiodeVoltage, 10);
    expect(ac.parts.diode.voltage.imaginary).toBeCloseTo(0, 12);
  });

  it("preserves a small-signal diode voltage above a large AC common mode", () => {
    const resistance = 1000;
    const sourceAmplitude = 1e-3;
    const saturationCurrent = 1e-12;
    const thermalVoltage = 0.025_85;
    const document: CircuitDocument = {
      title: "大きい交流共通電位上のダイオード微小信号",
      parts: [
        part("high", "ac-source", { voltageVolts: 1e12, frequencyHz: 1000 }),
        part("small", "ac-source", { voltageVolts: sourceAmplitude, frequencyHz: 1000 }),
        part("bias", "battery", { voltageVolts: 5 }),
        part("resistor", "resistor", { resistanceOhms: resistance }),
        part("diode", "diode", { saturationCurrentAmps: saturationCurrent }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("ground", "high", "b", "ground", "a"),
        wire("small-source-high", "high", "a", "small", "a"),
        wire("small-source-resistor", "small", "b", "resistor", "a"),
        wire("resistor-diode", "resistor", "b", "diode", "b"),
        wire("diode-bias", "diode", "a", "bias", "a"),
        wire("bias-return", "bias", "b", "high", "a"),
        wire("meter-diode-a", "meter", "a", "diode", "a"),
        wire("meter-diode-b", "meter", "b", "diode", "b"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac" });
    const diodeConductance = (dc.parts.diode.current.real + saturationCurrent) / thermalVoltage;
    const expectedCurrent = sourceAmplitude / (resistance + 1 / diodeConductance);
    const expectedDiodeVoltage = expectedCurrent / diodeConductance;

    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.diode.current.real).toBeCloseTo(expectedCurrent, 9);
    expect(ac.parts.diode.voltage.real).toBeCloseTo(expectedDiodeVoltage, 9);
    expect(ac.parts.meter.meterStatus).toBe("connected");
    expect(ac.parts.meter.voltage.real).toBeCloseTo(expectedDiodeVoltage, 9);
  });

  it("keeps a representable inductor reactance when angular frequency would overflow first", () => {
    const frequencyHz = 1e308;
    const inductanceHenries = 1e-308;
    const document: CircuitDocument = {
      title: "中間値がオーバーフローするコイル回路",
      parts: [
        part("source", "ac-source", { voltageVolts: 1, frequencyHz }),
        part("inductor", "inductor", { inductanceHenries }),
      ],
      wires: [
        wire("w1", "source", "a", "inductor", "a"),
        wire("w2", "inductor", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.inductor.voltage.real).toBeCloseTo(1, 10);
    expect(result.parts.inductor.voltage.imaginary).toBeCloseTo(0, 10);
    expect(result.parts.inductor.current.real).toBeCloseTo(0, 10);
    expect(result.parts.inductor.current.imaginary).toBeCloseTo(-1 / (2 * Math.PI), 10);
  });

  it("avoids losing precision when angular frequency times inductance is subnormal", () => {
    const frequencyHz = 1e-308;
    const inductanceHenries = 7.4e-16;
    const sourceVoltage = 1e-308;
    const expectedCurrentImaginary = -1 / (2 * Math.PI * inductanceHenries);
    const document: CircuitDocument = {
      title: "サブノーマル領域のコイルリアクタンス",
      parts: [
        part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
        part("inductor", "inductor", { inductanceHenries }),
      ],
      wires: [
        wire("w1", "source", "a", "inductor", "a"),
        wire("w2", "inductor", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.inductor.current.imaginary / expectedCurrentImaginary).toBeCloseTo(1, 10);
  });

  it.each([
    { kind: "capacitor" as const, frequencyHz: 1e-308, capacitanceFarads: 1e-308, expectedCurrentImaginary: 0 },
    { kind: "inductor" as const, frequencyHz: 1e308, inductanceHenries: 1e308, expectedCurrentImaginary: -0 },
  ])("keeps the sign of the rounded sub-binary64 $kind branch current", (reactive) => {
    const document: CircuitDocument = {
      title: "極大リアクタンスで微小電流が流れる回路",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: reactive.frequencyHz }),
        part("resistor", "resistor", { resistanceOhms: 100 }),
        part("reactive", reactive.kind, reactive),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "reactive", "a"),
        wire("w3", "reactive", "b", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.reactive.voltage.real).toBeCloseTo(5, 10);
    expect(result.parts.reactive.current.real).toBe(0);
    expect(result.parts.reactive.current.imaginary).toBe(reactive.expectedCurrentImaginary);
    expect(result.parts.resistor.voltage.real).toBe(0);
    expect(result.parts.resistor.voltage.imaginary).toBe(reactive.expectedCurrentImaginary);
  });

  it.each([
    { kind: "capacitor" as const, frequencyHz: 1e-308, capacitanceFarads: 1e-308 },
    { kind: "inductor" as const, frequencyHz: 1e308, inductanceHenries: 1e308 },
  ])("does not make a dangling open $kind branch singular", (reactive) => {
    const document: CircuitDocument = {
      title: "片端が未接続の開放リアクタンス",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: reactive.frequencyHz }),
        part("reactive", reactive.kind, reactive),
      ],
      wires: [wire("w1", "source", "a", "reactive", "a")],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.reactive.current.real).toBe(0);
    expect(result.parts.reactive.current.imaginary).toBe(0);
  });

  it("solves an out-of-range capacitor reactance through its representable admittance", () => {
    const document: CircuitDocument = {
      title: "表現範囲を超えたリアクタンスの電流整合",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e308, frequencyHz: 0.5 }),
        part("resistor", "resistor", { resistanceOhms: 1 }),
        part("capacitor", "capacitor", { capacitanceFarads: 1e-309 }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "capacitor", "a"),
        wire("w3", "capacitor", "b", "source", "b"),
        wire("w4", "ground", "a", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.capacitor.voltage.real).toBe(1e308);
    const expectedCurrent = ((2 * Math.PI * 0.5) * 1e-309) * 1e308;
    expect(result.parts.capacitor.current.imaginary / expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.resistor.current.imaginary / expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.source.current.imaginary / -expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.resistor.voltage.imaginary / expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.resistor.terminalCurrents.b!.imaginary +
      result.parts.capacitor.terminalCurrents.a!.imaginary).toBeCloseTo(0, 8);
    expect(result.parts.source.terminalCurrents.a!.imaginary +
      result.parts.resistor.terminalCurrents.a!.imaginary).toBeCloseTo(0, 8);
    expect(result.parts.resistor.power.real).toBeCloseTo(expectedCurrent ** 2, 8);
    expect(result.parts.capacitor.power.real).toBe(0);
    expect(result.parts.capacitor.voltage.real / 1e308).toBeCloseTo(1, 8);
    expect(result.parts.capacitor.voltage.imaginary / 1e308).toBeCloseTo(0, 8);
    expect(result.parts.capacitor.power.imaginary / (-1e308 * expectedCurrent)).toBeCloseTo(1, 8);
    expect(result.parts.source.power.imaginary / -result.parts.capacitor.power.imaginary).toBeCloseTo(1, 8);
    expect(result.parts.source.voltage.real - result.parts.resistor.voltage.real -
      result.parts.capacitor.voltage.real).toBeCloseTo(0, 8);
    expect(result.parts.source.voltage.imaginary - result.parts.resistor.voltage.imaginary -
      result.parts.capacitor.voltage.imaginary).toBeCloseTo(0, 8);
    expect((result.parts.source.power.real + result.parts.resistor.power.real) /
      result.parts.resistor.power.real).toBeCloseTo(0, 8);
  });

  it("solves an out-of-range inductor reactance through its representable admittance", () => {
    const frequencyHz = 0.5;
    const inductanceHenries = 1e308;
    const sourceVoltage = 1e308;
    const expectedCurrent = sourceVoltage * (1 / (2 * Math.PI * frequencyHz)) / inductanceHenries;
    const document: CircuitDocument = {
      title: "有限アドミタンスで解く範囲外コイルリアクタンス",
      parts: [
        part("source", "ac-source", { voltageVolts: sourceVoltage, frequencyHz }),
        part("resistor", "resistor", { resistanceOhms: 1 }),
        part("inductor", "inductor", { inductanceHenries }),
        part("ground", "ground"),
      ],
      wires: [
        wire("w1", "source", "a", "resistor", "a"),
        wire("w2", "resistor", "b", "inductor", "a"),
        wire("w3", "inductor", "b", "source", "b"),
        wire("w4", "ground", "a", "source", "b"),
      ],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac" });

    expect(result.status, result.message).toBe("valid");
    expect(expectedCurrent).toBeGreaterThan(0.3);
    expect(result.parts.inductor.current.imaginary / -expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.resistor.current.imaginary / -expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.source.current.imaginary / expectedCurrent).toBeCloseTo(1, 8);
    expect(result.parts.resistor.terminalCurrents.b!.imaginary +
      result.parts.inductor.terminalCurrents.a!.imaginary).toBeCloseTo(0, 8);
    expect(result.parts.source.terminalCurrents.a!.imaginary +
      result.parts.resistor.terminalCurrents.a!.imaginary).toBeCloseTo(0, 8);
    expect(result.parts.inductor.voltage.real / 1e308).toBeCloseTo(1, 8);
    expect(result.parts.inductor.power.imaginary / (1e308 * expectedCurrent)).toBeCloseTo(1, 8);
    expect(result.parts.source.power.imaginary / -result.parts.inductor.power.imaginary).toBeCloseTo(1, 8);
    expect((result.parts.source.power.real + result.parts.resistor.power.real) /
      result.parts.resistor.power.real).toBeCloseTo(0, 8);
    expect((result.parts.source.voltage.real - result.parts.resistor.voltage.real -
      result.parts.inductor.voltage.real) / 1e308).toBeCloseTo(0, 8);
    expect(result.parts.source.voltage.imaginary - result.parts.resistor.voltage.imaginary -
      result.parts.inductor.voltage.imaginary).toBeCloseTo(0, 8);
  });

  it("keeps a shorted capacitor finite when its admittance exceeds the numeric range", () => {
    const document: CircuitDocument = {
      title: "アドミタンスが表現範囲を超える短絡コンデンサー",
      parts: [part("capacitor", "capacitor", { capacitanceFarads: 1e10 })],
      wires: [wire("short", "capacitor", "a", "capacitor", "b")],
    };

    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1e308 });

    expect(result.status, result.message).toBe("valid");
    expect(result.parts.capacitor.voltage).toEqual({ real: 0, imaginary: 0 });
    expect(result.parts.capacitor.current).toEqual({ real: 0, imaginary: 0 });
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

  it("matches sub-nanohertz frequencies only within floating-point rounding", () => {
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

    const rounded = analyzeAnalogCircuit(document, {
      mode: "ac",
      frequencyHz: 1e-10 + 2 * Number.EPSILON * 1e-10,
    });
    const distinct = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1.000_000_000_5e-10 });

    expect(rounded.status).toBe("valid");
    expect(rounded.parts.load.voltage.real).toBeCloseTo(3, 8);
    expect(distinct.status).toBe("valid");
    expect(distinct.parts.load.voltage.real).toBeCloseTo(0, 12);
    expect(distinct.issues.some((issue) => issue.message.includes("異なる"))).toBe(true);
  });
});
