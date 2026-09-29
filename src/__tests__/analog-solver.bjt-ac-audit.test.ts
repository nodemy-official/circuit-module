import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  ...circuitPartCatalog[kind].defaults,
  ...extra,
});

const wire = (id: string, from: string, fromTerminal: "a" | "b" | "c", to: string, toTerminal: "a" | "b" | "c") => ({
  id,
  from: { partId: from, terminal: fromTerminal },
  to: { partId: to, terminal: toTerminal },
});

describe("AC biased BJT voltage readings", () => {
  it("matches an independent hybrid-pi solution at transistor terminals and voltmeters", () => {
    const beta = 100;
    const saturationCurrent = 1e-14;
    const sourceRms = 1e-3;
    const sourceResistance = 1e3;
    const baseBiasResistance = 1e4;
    const collectorResistance = 2e3;
    const thermalVoltage = 0.025_85;
    const document: CircuitDocument = {
      title: "BJTの直流バイアス付き小信号交流",
      parts: [
        part("ground", "ground"),
        part("base-bias", "battery", { voltageVolts: 0.7 }),
        part("collector-bias", "battery", { voltageVolts: 5 }),
        part("ac", "ac-source", {
          voltageVolts: sourceRms,
          offsetVolts: 0.7,
          phaseDegrees: 90,
          frequencyHz: 1000,
        }),
        part("base-bias-resistor", "resistor", { resistanceOhms: baseBiasResistance }),
        part("source-resistor", "resistor", { resistanceOhms: sourceResistance }),
        part("collector-resistor", "resistor", { resistanceOhms: collectorResistance }),
        part("transistor", "npn-transistor", { currentGain: beta, saturationCurrentAmps: saturationCurrent }),
        part("base-meter", "voltmeter"),
        part("collector-meter", "voltmeter"),
      ],
      wires: [
        wire("base-bias-return", "base-bias", "b", "ground", "a"),
        wire("collector-bias-return", "collector-bias", "b", "ground", "a"),
        wire("ac-return", "ac", "b", "ground", "a"),
        wire("bias-resistor-source", "base-bias", "a", "base-bias-resistor", "a"),
        wire("bias-resistor-base", "base-bias-resistor", "b", "transistor", "b"),
        wire("ac-source-resistor", "ac", "a", "source-resistor", "a"),
        wire("source-resistor-base", "source-resistor", "b", "transistor", "b"),
        wire("collector-supply-resistor", "collector-bias", "a", "collector-resistor", "a"),
        wire("collector-resistor-transistor", "collector-resistor", "b", "transistor", "a"),
        wire("emitter-return", "transistor", "c", "ground", "a"),
        wire("base-meter-positive", "base-meter", "a", "transistor", "b"),
        wire("base-meter-return", "base-meter", "b", "ground", "a"),
        wire("collector-meter-positive", "collector-meter", "a", "transistor", "a"),
        wire("collector-meter-return", "collector-meter", "b", "ground", "a"),
      ],
    };

    const dc = analyzeAnalogCircuit(document, { mode: "dc" });
    const ac = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1000 });
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz: 1000 });

    expect(dc.status, dc.message).toBe("valid");
    expect(ac.status, ac.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");

    const alphaForward = beta / (beta + 1);
    const baseVoltageDc = dc.parts.transistor.terminalVoltages.b!.real;
    const collectorVoltageDc = dc.parts.transistor.terminalVoltages.a!.real;
    const emitterVoltageDc = dc.parts.transistor.terminalVoltages.c!.real;
    const forwardConductance = ((saturationCurrent / alphaForward) *
      Math.exp((baseVoltageDc - emitterVoltageDc) / thermalVoltage)) / thermalVoltage;
    const reverseConductance = (2 * saturationCurrent *
      Math.exp((baseVoltageDc - collectorVoltageDc) / thermalVoltage)) / thermalVoltage;
    const baseConductance = forwardConductance / (beta + 1) + reverseConductance / 2;
    const collectorFromBaseConductance = alphaForward * forwardConductance - reverseConductance;
    const sourceConductance = 1 / sourceResistance;
    const baseBiasConductance = 1 / baseBiasResistance;
    const collectorLoadConductance = 1 / collectorResistance;
    const baseDiagonal = sourceConductance + baseBiasConductance + baseConductance;
    const baseToCollector = -reverseConductance / 2;
    const collectorDiagonal = collectorLoadConductance + reverseConductance;
    const determinant = baseDiagonal * collectorDiagonal - baseToCollector * collectorFromBaseConductance;
    const expectedBaseMagnitude = sourceConductance * sourceRms * collectorDiagonal / determinant;
    const expectedCollectorMagnitude = -sourceConductance * sourceRms * collectorFromBaseConductance / determinant;

    expect(ac.parts.transistor.terminalVoltages.b!.real).toBeCloseTo(0, 10);
    expect(ac.parts.transistor.terminalVoltages.b!.imaginary).toBeCloseTo(expectedBaseMagnitude, 9);
    expect(ac.parts.transistor.terminalVoltages.a!.real).toBeCloseTo(0, 10);
    expect(ac.parts.transistor.terminalVoltages.a!.imaginary).toBeCloseTo(expectedCollectorMagnitude, 9);
    expect(ac.parts.transistor.terminalVoltages.c).toEqual({ real: 0, imaginary: 0 });

    expect(scalar.parts.transistor.terminalVoltages?.b).toBeCloseTo(expectedBaseMagnitude, 9);
    expect(scalar.parts.transistor.terminalVoltagePhasesDegrees?.b).toBeCloseTo(90, 8);
    expect(scalar.parts.transistor.terminalVoltages?.a).toBeCloseTo(Math.abs(expectedCollectorMagnitude), 9);
    expect(scalar.parts.transistor.terminalVoltagePhasesDegrees?.a).toBeCloseTo(-90, 8);
    expect(scalar.parts.transistor.terminalVoltages?.c).toBe(0);

    expect(scalar.parts["base-meter"].voltageVolts).toBeCloseTo(expectedBaseMagnitude, 9);
    expect(scalar.parts["base-meter"].voltagePhaseDegrees).toBeCloseTo(90, 8);
    expect(scalar.parts["collector-meter"].voltageVolts).toBeCloseTo(Math.abs(expectedCollectorMagnitude), 9);
    expect(scalar.parts["collector-meter"].voltagePhaseDegrees).toBeCloseTo(-90, 8);
  });
});
