import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const frequencyHz = 50;

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
) => ({ id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } });

function largeSourceChainWithSmallMeterDrop(): CircuitDocument {
  const sourceVoltages = [1e308, 1e308, -1e308, -1e308, 12];
  const sources = sourceVoltages.map((voltage, index) => part(`source-${index}`, "ac-source", {
    voltageVolts: Math.abs(voltage),
    phaseDegrees: voltage < 0 ? 180 : 0,
    frequencyHz,
  }));
  const wires = [
    // Anchor the reference between the two positive sources. Every node voltage
    // then remains finite even though summing the meter path in order overflows.
    wire("ground-reference", "source-0", "b", "ground", "a"),
    wire("chain-0", "source-0", "b", "source-1", "a"),
    wire("chain-1", "source-1", "b", "source-2", "a"),
    wire("chain-2", "source-2", "b", "source-3", "a"),
    wire("chain-3", "source-3", "b", "source-4", "a"),
    wire("meter-positive", "meter", "a", "source-0", "a"),
    wire("meter-negative", "meter", "b", "source-4", "b"),
  ];

  return {
    title: "浮動小数の範囲を超える中間和を含む交流電圧計経路",
    parts: [...sources, part("ground", "ground"), part("meter", "voltmeter")],
    wires,
  };
}

describe("AC voltmeter path summation", () => {
  it("reports RMS magnitude and phase with reversed probes across multiple series branches", () => {
    const document: CircuitDocument = {
      title: "二つの直列抵抗をまたぐ交流電圧計",
      parts: [
        part("source", "ac-source", { voltageVolts: 12, phaseDegrees: 37, frequencyHz }),
        part("r0", "resistor", { resistanceOhms: 10 }),
        part("r1", "resistor", { resistanceOhms: 10 }),
        part("r2", "resistor", { resistanceOhms: 10 }),
        part("forward", "voltmeter"),
        part("reverse", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("source-r0", "source", "a", "r0", "a"),
        wire("r0-r1", "r0", "b", "r1", "a"),
        wire("r1-r2", "r1", "b", "r2", "a"),
        wire("r2-source", "r2", "b", "source", "b"),
        wire("ground-return", "ground", "a", "source", "b"),
        wire("forward-positive", "forward", "a", "r0", "b"),
        wire("forward-negative", "forward", "b", "r2", "b"),
        wire("reverse-positive", "reverse", "a", "r2", "b"),
        wire("reverse-negative", "reverse", "b", "r0", "b"),
      ],
    };

    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.forward.voltageVolts).toBeCloseTo(8, 10);
    expect(result.parts.forward.voltagePhaseDegrees).toBeCloseTo(37, 9);
    expect(result.parts.reverse.voltageVolts).toBeCloseTo(8, 10);
    expect(result.parts.reverse.voltagePhaseDegrees).toBeCloseTo(-143, 9);
  });

  it("keeps the finite RMS voltage and phase when large source drops overflow the path intermediate sum", () => {
    const result = analyzeCircuit(largeSourceChainWithSmallMeterDrop(), {}, { mode: "ac", frequencyHz });

    expect(result.status, result.message).toBe("open");
    expect(result.parts.meter.meterStatus).toBe("connected");
    expect(result.parts.meter.voltageVolts).toBe(12);
    expect(result.parts.meter.voltagePhaseDegrees).toBe(0);
  });
});
