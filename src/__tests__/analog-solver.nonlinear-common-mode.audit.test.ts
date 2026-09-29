import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../circuit-model.js";

const COMMON_MODE = 1e16;

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
  from: string,
  fromTerminal: CircuitTerminal,
  to: string,
  toTerminal: CircuitTerminal,
) => ({ id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal } });

function dcReference(shifted: boolean) {
  return shifted ? "offset" : "ground";
}

function commonModeParts(shifted: boolean) {
  return [part("ground", "ground"), ...(shifted ? [part("offset", "battery", { voltageVolts: COMMON_MODE })] : [])];
}

function commonModeWires(shifted: boolean) {
  return shifted ? [wire("offset-ground", "offset", "b", "ground", "a")] : [];
}

function diodeCircuit(shifted: boolean, supplyVoltage = 1): CircuitDocument {
  const reference = dcReference(shifted);
  return {
    title: "diode common-mode invariance",
    parts: [
      ...commonModeParts(shifted),
      part("supply", "battery", { voltageVolts: supplyVoltage }),
      part("load", "resistor", { resistanceOhms: 1000 }),
      part("diode", "diode"),
    ],
    wires: [
      ...commonModeWires(shifted),
      wire("supply-load", "supply", "a", "load", "a"),
      wire("load-diode", "load", "b", "diode", "a"),
      wire("diode-return", "diode", "b", "supply", "b"),
      wire("supply-reference", "supply", "b", reference, "a"),
    ],
  };
}

function bjtCircuit(shifted: boolean): CircuitDocument {
  const reference = dcReference(shifted);
  return {
    title: "BJT common-mode invariance",
    parts: [
      ...commonModeParts(shifted),
      part("base-bias", "battery", { voltageVolts: 0.7 }),
      part("collector-bias", "battery", { voltageVolts: 5 }),
      part("base-resistor", "resistor", { resistanceOhms: 10_000 }),
      part("collector-resistor", "resistor", { resistanceOhms: 2000 }),
      part("transistor", "npn-transistor", { currentGain: 100, saturationCurrentAmps: 1e-14 }),
    ],
    wires: [
      ...commonModeWires(shifted),
      wire("base-source-resistor", "base-bias", "a", "base-resistor", "a"),
      wire("base-resistor-base", "base-resistor", "b", "transistor", "b"),
      wire("base-source-return", "base-bias", "b", reference, "a"),
      wire("collector-source-resistor", "collector-bias", "a", "collector-resistor", "a"),
      wire("collector-resistor-collector", "collector-resistor", "b", "transistor", "a"),
      wire("collector-source-return", "collector-bias", "b", reference, "a"),
      wire("emitter-return", "transistor", "c", reference, "a"),
    ],
  };
}

function mosCircuit(shifted: boolean): CircuitDocument {
  const reference = dcReference(shifted);
  return {
    title: "MOS common-mode invariance",
    parts: [
      ...commonModeParts(shifted),
      part("supply", "battery", { voltageVolts: 5 }),
      part("load", "resistor", { resistanceOhms: 100 }),
      part("mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: 0.02,
        channelLengthModulation: 0,
      }),
    ],
    wires: [
      ...commonModeWires(shifted),
      wire("supply-load", "supply", "a", "load", "a"),
      wire("load-mos", "load", "b", "mos", "a"),
      wire("mos-gate-drain", "mos", "a", "mos", "b"),
      wire("mos-source-return", "mos", "c", reference, "a"),
      wire("supply-return", "supply", "b", reference, "a"),
    ],
  };
}

function analyzeNonlinearPair(baseline: CircuitDocument, shifted: CircuitDocument) {
  const base = analyzeAnalogCircuit(baseline, { mode: "dc" });
  const translated = analyzeAnalogCircuit(shifted, { mode: "dc" });
  return { base, translated };
}

describe("nonlinear common-mode invariance", () => {
  it("preserves diode bias when the entire circuit is shifted by 1e16 V", () => {
    const { base, translated } = analyzeNonlinearPair(diodeCircuit(false), diodeCircuit(true));
    const diode = translated.parts.diode;
    expect(base.status, base.message).toBe("valid");
    expect(translated.status, translated.message).toBe("valid");
    expect(diode.voltage).toEqual(base.parts.diode.voltage);
    expect(diode.current).toEqual(base.parts.diode.current);
    expect(diode.terminalCurrents).toEqual(base.parts.diode.terminalCurrents);
    expect(diode.current.real).toBeGreaterThan(0);
  });

  it("matches the diode series-load equation under a 1e16 V common-mode shift", () => {
    const supplyVoltage = 10;
    const resistance = 1000;
    const saturationCurrent = 1e-12;
    const thermalVoltage = 0.025_85;
    let low = 0;
    let high = supplyVoltage;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const diodeVoltage = (low + high) / 2;
      const diodeCurrent = saturationCurrent * Math.expm1(diodeVoltage / thermalVoltage);
      if (diodeVoltage + resistance * diodeCurrent > supplyVoltage) {
        high = diodeVoltage;
      } else {
        low = diodeVoltage;
      }
    }
    const expectedVoltage = (low + high) / 2;
    const expectedCurrent = (supplyVoltage - expectedVoltage) / resistance;
    const baseline = analyzeAnalogCircuit(diodeCircuit(false, supplyVoltage), { mode: "dc" });
    const shifted = analyzeAnalogCircuit(diodeCircuit(true, supplyVoltage), { mode: "dc" });

    expect(baseline.status, baseline.message).toBe("valid");
    expect(shifted.status, shifted.message).toBe("valid");
    expect(baseline.parts.diode.voltage.real).toBeCloseTo(expectedVoltage, 10);
    expect(shifted.parts.diode.voltage.real).toBeCloseTo(expectedVoltage, 10);
    expect(baseline.parts.diode.current.real).toBeCloseTo(expectedCurrent, 10);
    expect(shifted.parts.diode.current.real).toBeCloseTo(expectedCurrent, 10);
  });

  it("preserves a separate 0.7 V BJT base-emitter bias after a 1e16 V shift", () => {
    const { base, translated } = analyzeNonlinearPair(bjtCircuit(false), bjtCircuit(true));
    const transistor = translated.parts.transistor;
    expect(base.status, base.message).toBe("valid");
    expect(translated.status, translated.message).toBe("valid");
    expect(transistor.voltage).toEqual(base.parts.transistor.voltage);
    expect(transistor.current).toEqual(base.parts.transistor.current);
    expect(transistor.terminalCurrents).toEqual(base.parts.transistor.terminalCurrents);
    expect(transistor.terminalCurrents.b?.real).toBeGreaterThan(0);
  });

  it("preserves MOS channel current when the entire circuit is shifted by 1e16 V", () => {
    const { base, translated } = analyzeNonlinearPair(mosCircuit(false), mosCircuit(true));
    const mos = translated.parts.mos;
    expect(base.status, base.message).toBe("valid");
    expect(translated.status, translated.message).toBe("valid");
    expect(mos.voltage).toEqual(base.parts.mos.voltage);
    expect(mos.current).toEqual(base.parts.mos.current);
    expect(mos.terminalCurrents).toEqual(base.parts.mos.terminalCurrents);
    expect(mos.channelConducting).toBe(true);
    expect(mos.terminalCurrents.a?.real).toBeGreaterThan(0);
  });
});
