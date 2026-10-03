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

describe("AC reference detection for an underflowed diode slope", () => {
  it("keeps two resistor islands independently referenceable when their diode has zero AC conductance", () => {
    const document: CircuitDocument = {
      title: "Zero-slope diode between floating AC islands",
      parts: [
        part("diode", "diode", {
          saturationCurrentAmps: Number.MIN_VALUE,
          emissionCoefficient: Number.MAX_VALUE,
        }),
        part("left-load", "resistor", { resistanceOhms: 1000 }),
        part("right-load", "resistor", { resistanceOhms: 2000 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("left-diode", "diode", "a", "left-load", "a"),
        wire("right-diode", "diode", "b", "right-load", "a"),
        wire("meter-left", "meter", "a", "diode", "a"),
        wire("meter-right", "meter", "b", "diode", "b"),
      ],
    };

    const analysis = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(analysis.status, analysis.message).toBe("valid");
    expect(analysis.parts.diode.current).toEqual({ real: 0, imaginary: 0 });
    expect(analysis.parts["left-load"]!.current).toEqual({ real: 0, imaginary: 0 });
    expect(analysis.parts["right-load"]!.current).toEqual({ real: 0, imaginary: 0 });
    expect(analysis.parts.meter!.meterStatus).toBe("floating");
  });

  it.each([1 - 2 ** -52, 1])("distinguishes positive triode slope from exact saturation (current=%s)", (current) => {
    const document: CircuitDocument = {
      title: "Unloaded saturated MOS drain",
      parts: [
        part("ground", "ground"),
        part("gate-bias", "ac-source", {
          voltageVolts: 0,
          offsetVolts: 1,
          frequencyHz: 1000,
        }),
        part("mos", "nmos", {
          thresholdVolts: 0,
          transconductanceAmpsPerVoltSquared: 2,
          channelLengthModulation: 0,
        }),
        part("load-current", "current-source", { currentAmps: -current }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("gate-supply", "gate-bias", "a", "mos", "b"),
        wire("gate-return", "gate-bias", "b", "ground", "a"),
        wire("source-ground", "mos", "c", "ground", "a"),
        wire("load-drain", "load-current", "a", "mos", "a"),
        wire("load-return", "load-current", "b", "ground", "a"),
        wire("meter-drain", "meter", "a", "mos", "a"),
        wire("meter-source", "meter", "b", "mos", "c"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.mos!.current.real).toBe(current);
    // I=2*Vds-Vds^2: I=1-2^-52 gives Vds=1-2^-26 and gds>0.
    // I=1 requires saturation (Vds>=1), where gds=0 and the AC drain floats.
    if (current < 1) { expect(dc.parts.mos!.voltage.real).toBe(1 - 2 ** -26); }
    else { expect(dc.parts.mos!.voltage.real).toBeGreaterThanOrEqual(1); }
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.mos!.channelConducting).toBe(true);
    expect(ac.parts.meter!.meterStatus).toBe(current < 1 ? "connected" : "floating");
    expect(ac.parts.mos!.acReferenceTerminalGroups).toEqual(current < 1 ? [["a", "c"]] : [["b", "c"]]);
  });

  it("reports a diode-connected lambda-zero MOS as AC-connected at saturation", () => {
    const document: CircuitDocument = {
      title: "Diode-connected lambda-zero MOS at saturation",
      parts: [
        part("ground", "ground"),
        part("mos", "nmos", {
          thresholdVolts: 0,
          transconductanceAmpsPerVoltSquared: 2,
          channelLengthModulation: 0,
        }),
        part("load-current", "current-source", { currentAmps: -1 }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("drain-gate-feedback", "mos", "a", "mos", "b"),
        wire("source-ground", "mos", "c", "ground", "a"),
        wire("load-drain", "load-current", "a", "mos", "a"),
        wire("load-return", "load-current", "b", "ground", "a"),
        wire("meter-drain", "meter", "a", "mos", "a"),
        wire("meter-source", "meter", "b", "mos", "c"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.mos!.terminalVoltages.a!.real).toBe(1);
    expect(dc.parts.mos!.current.real).toBe(1);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.meter!.meterStatus).toBe("connected");
    expect(ac.parts.mos!.acReferenceTerminalGroups).toEqual([
      ["b", "c"],
      ["a", "c"],
    ]);
  });

  it("uses the drain KCL relation to reference a floating normal-operation gate-source pair", () => {
    const document: CircuitDocument = {
      title: "Normal saturated MOS gm relation with an open drain in AC",
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

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    const dcMos = dc.parts.mos!;
    const vgs = dcMos.terminalVoltages.b!.real - dcMos.terminalVoltages.c!.real;
    const vds = dcMos.terminalVoltages.a!.real - dcMos.terminalVoltages.c!.real;
    const overdrive = Math.max(vgs, 0);
    const expectedDrainCurrent = vds < overdrive
      ? 2 * (overdrive * vds - 0.5 * vds * vds)
      : overdrive * overdrive;
    expect(expectedDrainCurrent).toBeCloseTo(dcMos.current.real, 12);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.mos!.acReferenceTerminalGroups).toEqual([["b", "c"]]);
    expect(ac.parts["gate-source-meter"]!.meterStatus).toBe("connected");
  });

  it("keeps the BJT base-emitter reference when only the scaled base slope survives underflow", () => {
    const thermalVoltage = 0.025_85;
    const document: CircuitDocument = {
      title: "Underflowed BJT transport slope with a representable base slope",
      parts: [
        part("ground", "ground"),
        part("transistor", "npn-transistor", {
          currentGain: Number.MIN_VALUE,
          saturationCurrentAmps: Number.MIN_VALUE,
        }),
        part("base-bias", "battery", { voltageVolts: 10 * thermalVoltage }),
        part("meter", "voltmeter"),
      ],
      wires: [
        wire("base-reference", "base-bias", "a", "ground", "a"),
        wire("base-voltage", "base-bias", "b", "transistor", "b"),
        wire("collector-ground", "transistor", "a", "ground", "a"),
        wire("emitter-ground", "transistor", "c", "ground", "a"),
        wire("meter-base", "meter", "a", "transistor", "b"),
        wire("meter-emitter", "meter", "b", "transistor", "c"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(dc.parts.transistor!.terminalVoltages.b!.real).toBe(-10 * thermalVoltage);
    expect(dc.parts.transistor!.terminalVoltages.a!.real).toBe(0);
    expect(dc.parts.transistor!.terminalVoltages.c!.real).toBe(0);
    expect(Number.MIN_VALUE * Math.exp(-10) / thermalVoltage).toBe(0);
    expect(Math.exp(-10) / thermalVoltage).toBeGreaterThan(0);
    expect(ac.status, ac.message).toBe("valid");
    expect(ac.parts.transistor!.acReferenceTerminalGroups).toEqual([["b", "c"]]);
    expect(ac.parts.transistor!.acCurrentResponseTerminalGroups).toEqual([["b", "c"]]);
    expect(ac.parts.meter!.meterStatus).toBe("connected");
  });
});
