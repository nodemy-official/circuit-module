import { describe, expect, it } from "vitest";

import type { CircuitDocument, CircuitPart, CircuitPartKind, CircuitWire } from "./circuit-model.js";
import { solveAnalogStep } from "./analog-solver.js";
import { simulateTransient } from "./transient-solver.js";

const auditFrequencyHz = 50;
const auditTimeStepSeconds = 0.0002;
const auditPeriodSeconds = 1 / auditFrequencyHz;
const auditSamplesPerCycle = Math.round(auditPeriodSeconds / auditTimeStepSeconds);

function part(id: string, kind: CircuitPartKind, properties: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, label: id, ...properties };
}

function wire(id: string, fromPart: string, fromTerminal: "a" | "b" | "c", toPart: string, toTerminal: "a" | "b" | "c"): CircuitWire {
  return { id, from: { partId: fromPart, terminal: fromTerminal }, to: { partId: toPart, terminal: toTerminal } };
}

const source = (voltageVolts: number, offsetVolts: number) =>
  part("signal", "ac-source", { voltageVolts, frequencyHz: auditFrequencyHz, offsetVolts });
const ground = part("ground", "ground");

function circuitFor(kind: CircuitPartKind): CircuitDocument {
  const commonTail = [ground];
  switch (kind) {
    case "diode":
    case "led": {
      const bias = kind === "led" ? 2.1 : 0.65;
      return {
        title: `${kind} transient operating-point audit`,
        parts: [source(0.001, bias), part("series", "resistor", { resistanceOhms: 1000 }), part("device", kind), ...commonTail],
        wires: [
          wire("source-series", "signal", "a", "series", "a"),
          wire("series-device", "series", "b", "device", "a"),
          wire("device-ground", "device", "b", "ground", "a"),
          wire("ground-source", "ground", "a", "signal", "b"),
        ],
      };
    }
    case "npn-transistor":
      return {
        title: "NPN transient operating-point audit",
        parts: [
          source(0.0001, 0.65), part("base-resistor", "resistor", { resistanceOhms: 10_000 }),
          part("supply", "battery", { voltageVolts: 5 }), part("collector-resistor", "resistor", { resistanceOhms: 1000 }),
          part("device", kind), ...commonTail,
        ],
        wires: [
          wire("signal-base-r", "signal", "a", "base-resistor", "a"),
          wire("base-r-base", "base-resistor", "b", "device", "b"),
          wire("supply-collector-r", "supply", "a", "collector-resistor", "a"),
          wire("collector-r-collector", "collector-resistor", "b", "device", "a"),
          wire("emitter-ground", "device", "c", "ground", "a"),
          wire("supply-ground", "supply", "b", "ground", "a"),
          wire("signal-ground", "signal", "b", "ground", "a"),
        ],
      };
    case "pnp-transistor":
      return {
        title: "PNP transient operating-point audit",
        parts: [
          source(0.0001, 4.35), part("base-resistor", "resistor", { resistanceOhms: 10_000 }),
          part("supply", "battery", { voltageVolts: 5 }), part("collector-resistor", "resistor", { resistanceOhms: 1000 }),
          part("device", kind), ...commonTail,
        ],
        wires: [
          wire("signal-base-r", "signal", "a", "base-resistor", "a"),
          wire("base-r-base", "base-resistor", "b", "device", "b"),
          wire("emitter-supply", "device", "c", "supply", "a"),
          wire("collector-r-collector", "collector-resistor", "b", "device", "a"),
          wire("collector-r-ground", "collector-resistor", "a", "ground", "a"),
          wire("supply-ground", "supply", "b", "ground", "a"),
          wire("signal-ground", "signal", "b", "ground", "a"),
        ],
      };
    case "nmos":
    case "pmos": {
      const isPmos = kind === "pmos";
      return {
        title: `${kind} transient operating-point audit`,
        parts: [
          source(0.0001, 2.5), part("supply", "battery", { voltageVolts: 5 }),
          part("load", "resistor", { resistanceOhms: 1000 }), part("device", kind), ...commonTail,
        ],
        wires: [
          wire("gate-source", "signal", "a", "device", "b"),
          wire(isPmos ? "drain-load" : "supply-load", isPmos ? "device" : "supply", isPmos ? "a" : "a", "load", isPmos ? "b" : "a"),
          wire(isPmos ? "load-ground" : "load-drain", "load", isPmos ? "a" : "b", isPmos ? "ground" : "device", isPmos ? "a" : "a"),
          wire(isPmos ? "source-supply" : "source-ground", "device", "c", isPmos ? "supply" : "ground", isPmos ? "a" : "a"),
          wire("supply-ground", "supply", "b", "ground", "a"),
          wire("signal-ground", "signal", "b", "ground", "a"),
        ],
      };
    }
    case "op-amp":
      return {
        title: "Op-amp transient operating-point audit",
        parts: [source(0.0001, 0), part("load", "resistor", { resistanceOhms: 1000 }), part("device", kind), ...commonTail],
        wires: [
          wire("signal-positive", "signal", "a", "device", "a"),
          wire("follower-feedback", "device", "c", "device", "b"),
          wire("output-load", "device", "c", "load", "a"),
          wire("load-ground", "load", "b", "ground", "a"),
          wire("signal-ground", "signal", "b", "ground", "a"),
        ],
      };
    default:
      throw new Error(`Unsupported audit kind ${kind}`);
  }
}

function instantSourceVoltage(sampleTime: number, rms: number, offset: number) {
  return offset + Math.SQRT2 * rms * Math.cos(2 * Math.PI * auditFrequencyHz * sampleTime);
}

function estimatedRmsPhasor(samples: ReturnType<typeof simulateTransient>["samples"], partId: string, field: "voltageVolts" | "currentAmps") {
  let cosineSum = 0;
  let sineSum = 0;
  for (const sample of samples) {
    const value = sample.parts[partId]?.[field] ?? Number.NaN;
    const angle = 2 * Math.PI * auditFrequencyHz * sample.timeSeconds;
    cosineSum += value * Math.cos(angle);
    sineSum += value * Math.sin(angle);
  }
  return { real: Math.SQRT2 * cosineSum / samples.length, imaginary: -Math.SQRT2 * sineSum / samples.length };
}

function complexRelativeError(actual: { real: number; imaginary: number }, expected: { real: number; imaginary: number }) {
  return Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary) /
    Math.max(Math.hypot(expected.real, expected.imaginary), 1e-12);
}

describe("nonlinear transient/DC consistency audit", () => {
  it.each(["diode", "led", "npn-transistor", "pnp-transistor", "nmos", "pmos", "op-amp"] as const)(
    "matches the DC operating point at each instantaneous source voltage for %s",
    (kind) => {
      const document = circuitFor(kind);
      const rms = document.parts.find(({ id }) => id === "signal")?.voltageVolts ?? 0;
      const offset = document.parts.find(({ id }) => id === "signal")?.offsetVolts ?? 0;
      const waveform = simulateTransient(document, { durationSeconds: 0.02, timeStepSeconds: 0.002 });

      expect(waveform.status, waveform.message).toBe("valid");
      for (const sample of waveform.samples) {
        const point = solveAnalogStep(document, {
          mode: "dc",
          voltageOverrides: { signal: instantSourceVoltage(sample.timeSeconds, rms, offset) },
        });
        expect(point.status, `${kind} DC point at t=${sample.timeSeconds}: ${point.message}`).toBe("valid");
        for (const circuitPart of document.parts) {
          const actual = sample.parts[circuitPart.id];
          const expected = point.parts[circuitPart.id];
          expect(actual?.voltageVolts, `${kind} ${circuitPart.id} voltage at t=${sample.timeSeconds}`).toBeCloseTo(expected?.voltage.real ?? Number.NaN, 7);
          expect(actual?.currentAmps, `${kind} ${circuitPart.id} current at t=${sample.timeSeconds}`).toBeCloseTo(expected?.current.real ?? Number.NaN, 7);
          for (const terminal of ["a", "b", "c"] as const) {
            if (expected?.terminalVoltages[terminal] !== undefined) {
              expect(actual?.terminalVoltages?.[terminal], `${kind} ${circuitPart.id}.${terminal} voltage at t=${sample.timeSeconds}`).toBeCloseTo(expected.terminalVoltages[terminal]?.real ?? Number.NaN, 7);
            }
            if (expected?.terminalCurrents[terminal] !== undefined) {
              expect(actual?.terminalCurrents?.[terminal], `${kind} ${circuitPart.id}.${terminal} current at t=${sample.timeSeconds}`).toBeCloseTo(expected.terminalCurrents[terminal]?.real ?? Number.NaN, 7);
            }
          }
        }
      }
    },
  );

  it.each(["diode", "led", "npn-transistor", "pnp-transistor", "nmos", "pmos", "op-amp"] as const)(
    "matches nonlinear small-signal AC phasors for a small transient around the DC bias for %s",
    (kind) => {
      const document = circuitFor(kind);
      // These fixtures have no C/L storage and the nonlinear models are memoryless, so no settling cycles are needed.
      // Exclude the t=0 initialization sample from the phasor estimate.
      expect(
        document.parts.some(({ kind: partKind }) => partKind === "capacitor" || partKind === "inductor"),
        `${kind} one-cycle comparison assumes there are no energy-storage parts`,
      ).toBe(false);
      const analysis = solveAnalogStep(document, { mode: "ac", frequencyHz: auditFrequencyHz });
      const waveform = simulateTransient(document, {
        durationSeconds: auditPeriodSeconds,
        timeStepSeconds: auditTimeStepSeconds,
      });

      expect(analysis.status, analysis.message).toBe("valid");
      expect(waveform.status, waveform.message).toBe("valid");
      const periodicSamples = waveform.samples.slice(1, auditSamplesPerCycle + 1);
      expect(periodicSamples).toHaveLength(auditSamplesPerCycle);
      for (const [field, quantity] of [["voltageVolts", "voltage"], ["currentAmps", "current"]] as const) {
        const observed = estimatedRmsPhasor(periodicSamples, "device", field);
        const expected = analysis.parts.device[quantity];
        expect(expected, `${kind} AC small-signal ${quantity} reading`).toBeDefined();
        expect(complexRelativeError(observed, expected ?? { real: Number.NaN, imaginary: Number.NaN }), `${kind} transient vs AC ${quantity} phasor`).toBeLessThan(0.02);
      }
    },
  );
});
