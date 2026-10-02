import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { simulateTransient } from "../../transient-solver.js";

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

describe("transient AC source phase axes", () => {
  it("preserves the tiny positive voltage just before two 45-degree offsets reach a zero crossing", () => {
    const voltageVolts = 1e150;
    const frequencyHz = 1;
    const timeSeconds = 0.125 - Number.EPSILON / 16;
    const document: CircuitDocument = {
      title: "Transient voltage immediately before a phase-axis crossing",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz, phaseDegrees: 45 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });
    const sample = waveform.samples.at(-1);
    const expectedVoltage = Math.SQRT2 * voltageVolts * 2 * Math.PI * (0.125 - timeSeconds);

    expect(waveform.status, waveform.message).toBe("valid");
    expect(sample?.timeSeconds).toBe(timeSeconds);
    expect(sample?.parts.source?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
    expect(sample?.parts.load?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
  });

  it("preserves the tiny positive voltage just before a 45-degree source phase reaches a zero crossing", () => {
    const voltageVolts = 1e150;
    const timeSeconds = 0.125;
    const phaseDegrees = 45 - Number.EPSILON * 32;
    const phaseOffsetDegrees = 45 - phaseDegrees;
    const document: CircuitDocument = {
      title: "Transient voltage immediately before a source-phase crossing",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz: 1, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });
    const sample = waveform.samples.at(-1);
    const expectedVoltage = phaseOffsetDegrees * (Math.PI / 180) * Math.SQRT2 * voltageVolts;

    expect(45 - Number.EPSILON * 32).toBeLessThan(45);
    expect(45 - (45 - Number.EPSILON * 32)).toBe(Number.EPSILON * 32);
    expect(phaseDegrees + Number.EPSILON * 32).toBe(45);
    expect(waveform.status, waveform.message).toBe("valid");
    expect(sample?.timeSeconds).toBe(timeSeconds);
    expect(sample?.parts.source?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
    expect(sample?.parts.load?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
  });

  it("retains the exact subnormal turn fraction when the RMS-scaled voltage is representable", () => {
    const voltageVolts = 1e150;
    const frequencyHz = Number.MIN_VALUE;
    const timeSeconds = 1.5;
    const document: CircuitDocument = {
      title: "Subnormal turn fraction precision",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz, phaseDegrees: 90 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });
    const sampledVoltage = waveform.samples.at(-1)?.parts.source?.voltageVolts;
    // Scale the exact subnormal frequency before multiplying by time. This
    // keeps 1.5 * Number.MIN_VALUE distinguishable from its rounded turn count.
    const expectedVoltage = -((((voltageVolts * frequencyHz) * timeSeconds) * 2 * Math.PI) * Math.SQRT2);

    expect(waveform.status, waveform.message).toBe("valid");
    expect(sampledVoltage).toBeDefined();
    expect((sampledVoltage ?? Number.NaN) / expectedVoltage).toBeCloseTo(1, 12);
  });

  it("keeps a finite offset waveform when its separate peak overflows", () => {
    const rms = 1.5e308;
    const document: CircuitDocument = {
      title: "Finite offset waveform",
      parts: [
        part("source", "ac-source", { voltageVolts: rms, offsetVolts: -rms, frequencyHz: 50 }),
        part("load", "resistor", { resistanceOhms: 1e308 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const result = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    const expected = (Math.SQRT2 - 1) * rms;

    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]?.parts.source?.voltageVolts / expected).toBeCloseTo(1, 13);
    expect(result.samples[0]?.parts.load?.voltageVolts / expected).toBeCloseTo(1, 13);
  });

  it.each([
    { phaseDegrees: 90, expectedSlope: -1 },
    { phaseDegrees: 270, expectedSlope: 1 },
  ])("keeps the tiny time offset beside a $phaseDegrees° phasor axis", ({ phaseDegrees, expectedSlope }) => {
    const voltageVolts = 1e150;
    const frequencyHz = Number.MIN_VALUE;
    const timeSeconds = 0.2;
    const document: CircuitDocument = {
      title: "Subnormal-frequency phase-axis consistency",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const steadyState = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });
    const sampledVoltage = waveform.samples.at(-1)?.parts.source?.voltageVolts;
    // Keep RMS and angular frequency large before multiplying by the subnormal
    // frequency so the independent first-order cosine oracle remains representable.
    const expectedVoltage = expectedSlope * Math.SQRT2 * voltageVolts * 2 * Math.PI * frequencyHz * timeSeconds;

    expect(steadyState.status, steadyState.message).toBe("valid");
    expect(steadyState.parts.source.voltage.real).toBe(0);
    expect(steadyState.parts.source.voltage.imaginary).toBe(expectedSlope === -1 ? voltageVolts : -voltageVolts);
    expect(waveform.status, waveform.message).toBe("valid");
    expect(sampledVoltage).toBeDefined();
    expect((sampledVoltage ?? Number.NaN) / expectedVoltage).toBeCloseTo(1, 8);
  });

  it.each([
    { phaseDegrees: 90, turns: 0, description: "90-degree source phase at t=0" },
    { phaseDegrees: 270, turns: 0, description: "270-degree source phase at t=0" },
    { phaseDegrees: 45, turns: 0.125, description: "two 45-degree offsets meeting at a zero crossing" },
    { phaseDegrees: 0, turns: 0.25, description: "quarter-cycle sample" },
    { phaseDegrees: 0, turns: 0.75, description: "three-quarter-cycle sample" },
  ])("returns the exact zero crossing for $description even at huge RMS voltage", ({ phaseDegrees, turns }) => {
    // A power-of-two frequency keeps these sample times exact in binary64.
    const frequencyHz = 64;
    const targetTimeSeconds = turns / frequencyHz;
    const durationSeconds = turns === 0 ? 0.001 : targetTimeSeconds;
    const document: CircuitDocument = {
      title: "Exact transient zero crossing",
      parts: [
        part("source", "ac-source", { voltageVolts: 1e150, frequencyHz, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const result = simulateTransient(document, { durationSeconds, timeStepSeconds: durationSeconds });

    expect(result.status, result.message).toBe("valid");
    const sample = turns === 0 ? result.samples[0] : result.samples.at(-1);
    expect(sample?.timeSeconds).toBe(targetTimeSeconds);
    expect(sample?.parts.source?.voltageVolts).toBe(0);
    expect(sample?.parts.load?.voltageVolts).toBe(0);
  });

  it.each([
    { phaseDegrees: 0, expectedVoltage: Math.SQRT2 * 5 },
    { phaseDegrees: 90, expectedVoltage: 0 },
  ])("preserves quadrantal phase after an exactly representable $phaseDegrees° cycle count", ({ phaseDegrees, expectedVoltage }) => {
    const frequencyHz = 2 ** 53;
    const timeSeconds = 1;
    const document: CircuitDocument = {
      title: "Large exact cycle count",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz, phaseDegrees }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });

    expect(waveform.status, waveform.message).toBe("valid");
    expect(waveform.samples.at(-1)?.parts.source?.voltageVolts).toBe(expectedVoltage);
    expect(waveform.samples.at(-1)?.parts.load?.voltageVolts).toBe(expectedVoltage);
  });

  it("preserves the half-cycle lost when a large frequency-time product rounds to an integer", () => {
    const frequencyHz = 2 ** 53 - 1;
    const timeSeconds = 1.5;
    const expectedVoltage = -Math.SQRT2 * 5;
    const document: CircuitDocument = {
      title: "Large half-cycle retained",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz, phaseDegrees: 0 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });

    expect(waveform.status, waveform.message).toBe("valid");
    expect(waveform.samples.at(-1)?.parts.source?.voltageVolts).toBe(expectedVoltage);
    expect(waveform.samples.at(-1)?.parts.load?.voltageVolts).toBe(expectedVoltage);
  });

  it("retains the exact cycle remainder for a large rounded frequency-time product", () => {
    const frequencyHz = 7;
    const timeSeconds = 9_586_980.571_428_569;
    const voltageVolts = 1e150;
    // The exact binary64 product has a remainder of -9/2^29 turns, even
    // though its rounded Number product has a different fractional part.
    const exactRemainderTurns = -9 / 2 ** 29;
    const expectedVoltage = Math.SQRT2 * voltageVolts * Math.sin(-2 * Math.PI * exactRemainderTurns);
    const document: CircuitDocument = {
      title: "Exact cycle remainder for a large rounded product",
      parts: [
        part("source", "ac-source", { voltageVolts, frequencyHz, phaseDegrees: 90 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });

    expect(waveform.status, waveform.message).toBe("valid");
    expect(waveform.samples.at(-1)?.parts.source?.voltageVolts / expectedVoltage).toBeCloseTo(1, 12);
  });

  it("keeps an exact integer cycle count when the frequency-time product overflows", () => {
    const frequencyHz = Number.MAX_VALUE;
    const timeSeconds = 2;
    const expectedVoltage = Math.SQRT2 * 5;
    const document: CircuitDocument = {
      title: "Overflowed exact cycle count",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz, phaseDegrees: 0 }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-to-load", "source", "a", "load", "a"),
        wire("load-to-source", "load", "b", "source", "b"),
      ],
    };

    const waveform = simulateTransient(document, {
      durationSeconds: timeSeconds,
      timeStepSeconds: timeSeconds,
    });

    expect(waveform.status, waveform.message).toBe("valid");
    expect(waveform.samples.at(-1)?.parts.source?.voltageVolts).toBe(expectedVoltage);
    expect(waveform.samples.at(-1)?.parts.load?.voltageVolts).toBe(expectedVoltage);
  });
});
