import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "./circuit-model.js";
import { analyzeCircuit } from "./circuit-solver.js";

const frequencyHz = 50;

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  label: id,
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
) => ({ id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } });

function independentLoads(groundedCircuit?: "a" | "b"): CircuitDocument {
  const parts = [
    part("source-a", "ac-source", { voltageVolts: 8, phaseDegrees: 37, frequencyHz }),
    part("load-a", "resistor", { resistanceOhms: 16 }),
    part("source-b", "ac-source", { voltageVolts: 5, phaseDegrees: -25, frequencyHz }),
    part("load-b", "resistor", { resistanceOhms: 10 }),
    part("meter", "voltmeter"),
  ];
  const wires = [
    wire("a-positive", "source-a", "a", "load-a", "a"),
    wire("a-return", "load-a", "b", "source-a", "b"),
    wire("b-positive", "source-b", "a", "load-b", "a"),
    wire("b-return", "load-b", "b", "source-b", "b"),
    wire("meter-a", "meter", "a", "source-a", "a"),
    wire("meter-b", "meter", "b", "source-b", "a"),
  ];
  if (groundedCircuit) {
    parts.push(part("ground", "ground"));
    wires.push(groundedCircuit === "a"
      ? wire("ground-wire", "ground", "a", "source-a", "b")
      : wire("ground-wire", "ground", "a", "source-b", "a"));
  }
  return { title: "独立した二つの交流負荷", parts, wires };
}

describe("AC independent and floating circuit references", () => {
  it.each([undefined, "a", "b"] as const)(
    "keeps both independent load phasors when the document reference is %s",
    (groundedCircuit) => {
      const result = analyzeCircuit(independentLoads(groundedCircuit), {}, { mode: "ac", frequencyHz });

      expect(result.status, result.message).toBe("closed");
      expect(result.parts["load-a"].voltageVolts).toBeCloseTo(8, 11);
      expect(result.parts["load-a"].voltagePhaseDegrees).toBeCloseTo(37, 10);
      expect(result.parts["load-a"].currentAmps).toBeCloseTo(0.5, 11);
      expect(result.parts["load-a"].currentPhaseDegrees).toBeCloseTo(37, 10);
      expect(result.parts["load-b"].voltageVolts).toBeCloseTo(5, 11);
      expect(result.parts["load-b"].voltagePhaseDegrees).toBeCloseTo(-25, 10);
      expect(result.parts["load-b"].currentAmps).toBeCloseTo(0.5, 11);
      expect(result.parts["load-b"].currentPhaseDegrees).toBeCloseTo(-25, 10);
      expect(result.parts.meter.meterStatus).toBe("floating");
    },
  );

  it("reports the supplied phasor on an isolated AC source and flags its unconnected voltmeter", () => {
    const document: CircuitDocument = {
      title: "未接続の交流電源と電圧計",
      parts: [
        part("source", "ac-source", { voltageVolts: 6, phaseDegrees: 70, frequencyHz }),
        part("resistor", "resistor", { resistanceOhms: 12 }),
        part("meter", "voltmeter"),
      ],
      wires: [],
    };
    const result = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });

    expect(result.status, result.message).toBe("open");
    expect(result.parts.source.voltageVolts).toBeCloseTo(6, 11);
    expect(result.parts.source.voltagePhaseDegrees).toBeCloseTo(70, 10);
    expect(result.parts.source.currentAmps).toBe(0);
    expect(result.parts.resistor.voltageVolts).toBe(0);
    expect(result.parts.resistor.currentAmps).toBe(0);
    expect(result.parts.meter.meterStatus).toBe("unconnected");
  });
});
