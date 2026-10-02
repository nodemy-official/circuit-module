import { describe, expect, it } from "vitest";

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

describe("AC reference groups for MOS feedback topology", () => {
  it("recognizes a finite gate-drain resistor as gm feedback", () => {
    const document: CircuitDocument = {
      title: "Saturated MOS with gate-drain resistor feedback",
      parts: [
        part("ground", "ground"),
        part("mos", "nmos", {
          thresholdVolts: 0,
          transconductanceAmpsPerVoltSquared: 2,
          channelLengthModulation: 0,
        }),
        part("load-current", "current-source", { currentAmps: -1 }),
        part("feedback", "resistor", { resistanceOhms: 7 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("source-ground", "mos", "c", "ground", "a"),
        wire("load-drain", "load-current", "a", "mos", "a"),
        wire("load-return", "load-current", "b", "ground", "a"),
        wire("feedback-drain", "feedback", "a", "mos", "a"),
        wire("feedback-gate", "feedback", "b", "mos", "b"),
        wire("meter-drain", "meter", "a", "mos", "a"),
        wire("meter-source", "meter", "b", "mos", "c"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.mos!.terminalVoltages.a.real).toBe(1);
    expect(dc.parts.mos!.terminalVoltages.b.real).toBe(1);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.meter!.meterStatus).toBe("connected");
    expect(ac.parts.mos!.acReferenceTerminalGroups).toEqual([["b", "c"], ["a", "c"]]);
  });

  it("recognizes reverse-channel gate-source feedback as drain-source conductance", () => {
    const document: CircuitDocument = {
      title: "Reverse-saturated MOS with gate-source feedback",
      parts: [
        part("ground", "ground"),
        part("mos", "nmos", {
          thresholdVolts: 0,
          transconductanceAmpsPerVoltSquared: 2,
          channelLengthModulation: 0,
        }),
        part("load-current", "current-source", { currentAmps: 1 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("gate-source-feedback", "mos", "b", "mos", "c"),
        wire("load-drain", "load-current", "a", "mos", "a"),
        wire("load-return", "load-current", "b", "mos", "c"),
        wire("meter-drain", "meter", "a", "mos", "a"),
        wire("meter-source", "meter", "b", "mos", "c"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.mos!.terminalVoltages.a.real).toBeLessThan(dc.parts.mos!.terminalVoltages.c.real);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.meter!.meterStatus).toBe("connected");
    expect(ac.parts.mos!.acReferenceTerminalGroups).toEqual([["a", "b"]]);
  });
});
