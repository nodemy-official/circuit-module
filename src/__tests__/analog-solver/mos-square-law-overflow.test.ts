import { expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart } from "../../circuit-model.js";

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
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
  fromTerminal: "a" | "b" | "c",
  toPart: string,
  toTerminal: "a" | "b" | "c",
) => ({
  id,
  from: { partId: fromPart, terminal: fromTerminal },
  to: { partId: toPart, terminal: toTerminal },
});

function fixedBiasMosDocument(
  kind: "nmos" | "pmos",
  terminalVoltages: { a: number; b: number; c: number },
  parameters: { threshold: number; beta: number; lambda: number },
  acAmplitudes: Partial<Record<"a" | "b" | "c", number>> = {},
): CircuitDocument {
  const parts: CircuitPart[] = [
    part("ground", "ground"),
    part("mos", kind, {
      thresholdVolts: parameters.threshold,
      transconductanceAmpsPerVoltSquared: parameters.beta,
      channelLengthModulation: parameters.lambda,
    }),
  ];
  const wires: CircuitDocument["wires"] = [];
  for (const terminal of ["a", "b", "c"] as const) {
    const voltage = terminalVoltages[terminal];
    const acAmplitude = acAmplitudes[terminal];
    const sourceId = `bias-${terminal}`;
    if (acAmplitude !== undefined) {
      const orientation = voltage < 0 ? -1 : 1;
      parts.push(part(sourceId, "ac-source", {
        voltageVolts: Math.abs(acAmplitude),
        frequencyHz: 1000,
        phaseDegrees: acAmplitude * orientation < 0 ? 180 : 0,
        offsetVolts: Math.abs(voltage),
      }));
      if (voltage < 0) {
        wires.push(
          wire(`${sourceId}-reference`, sourceId, "a", "ground", "a"),
          wire(`${sourceId}-terminal`, sourceId, "b", "mos", terminal),
        );
      } else {
        wires.push(
          wire(`${sourceId}-terminal`, sourceId, "a", "mos", terminal),
          wire(`${sourceId}-reference`, sourceId, "b", "ground", "a"),
        );
      }
      continue;
    }
    if (voltage === 0) {
      wires.push(wire(`${sourceId}-terminal`, "mos", terminal, "ground", "a"));
      continue;
    }
    parts.push(part(sourceId, "battery", { voltageVolts: Math.abs(voltage) }));
    if (voltage < 0) {
      wires.push(
        wire(`${sourceId}-reference`, sourceId, "a", "ground", "a"),
        wire(`${sourceId}-terminal`, sourceId, "b", "mos", terminal),
      );
    } else {
      wires.push(
        wire(`${sourceId}-terminal`, sourceId, "a", "mos", terminal),
        wire(`${sourceId}-reference`, sourceId, "b", "ground", "a"),
      );
    }
  }
  return { title: "fixed-bias MOS oracle", parts, wires };
}

it("keeps a finite MOS square-law solution when unscaled voltage squares overflow", () => {
  const voltageScale = 1e155;
  const normalizedDrainVoltage = 0.9;
  const beta = 1e-157;
  const overdrive = voltageScale;
  const drainVoltage = normalizedDrainVoltage * voltageScale;
  // Scale beta before the voltage product so the independent oracle stays finite.
  const expectedCurrent = ((beta * voltageScale) * voltageScale) *
    (normalizedDrainVoltage - normalizedDrainVoltage ** 2 / 2);
  const expectedPower = drainVoltage * expectedCurrent;
  const document: CircuitDocument = {
    title: "finite-power MOS square-law overflow audit",
    parts: [
      part("ground", "ground"),
      part("drain-bias", "battery", { voltageVolts: drainVoltage }),
      part("gate-bias", "battery", { voltageVolts: overdrive }),
      part("mos", "nmos", {
        thresholdVolts: 2,
        transconductanceAmpsPerVoltSquared: beta,
        channelLengthModulation: 0,
      }),
    ],
    wires: [
      wire("drain-positive", "drain-bias", "a", "mos", "a"),
      wire("drain-return", "drain-bias", "b", "ground", "a"),
      wire("gate-positive", "gate-bias", "a", "mos", "b"),
      wire("gate-return", "gate-bias", "b", "ground", "a"),
      wire("source-return", "mos", "c", "ground", "a"),
    ],
  };

  const analysis = analyzeAnalogCircuit(document, { mode: "dc" });

  expect(expectedCurrent).toBeGreaterThan(0);
  expect(Number.isFinite(expectedPower)).toBe(true);
  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.mos.terminalCurrents.a!.real / expectedCurrent).toBeCloseTo(1, 12);
  expect(analysis.parts.mos.power.real / expectedPower).toBeCloseTo(1, 12);
});

it("keeps finite square-law current and power when the saturation product overflows", () => {
  const parameters = { threshold: 2, beta: 1e308, lambda: 0 };
  const bias = { a: 1.5, b: 3.5, c: 0 };
  const analysis = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
  ));
  const ac = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
    { b: 1e-308 },
  ), { mode: "ac", frequencyHz: 1000 });
  const expectedCurrent = 1.125e308;
  const expectedPower = 1.6875e308;

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.mos.current.real / expectedCurrent).toBeCloseTo(1, 12);
  expect(analysis.parts.mos.power.real / expectedPower).toBeCloseTo(1, 12);
  expect(ac.status, ac.message).toBe("valid");
  expect(ac.parts.mos.terminalCurrents.a!.real).toBeCloseTo(1.5, 10);
});

it.each([
  {
    kind: "nmos" as const,
    terminalVoltages: { a: 0.9e155, b: 1e155, c: 0 },
    expectedCurrent: 4.95e152,
    expectedPower: 4.455e307,
  },
  {
    kind: "pmos" as const,
    terminalVoltages: { a: 0.1e155, b: 0, c: 1e155 },
    expectedCurrent: -4.95e152,
    expectedPower: 4.455e307,
  },
  {
    kind: "nmos" as const,
    terminalVoltages: { a: 0, b: 1.2e155, c: 1e155 },
    expectedCurrent: -7e152,
    expectedPower: 7e307,
  },
  {
    kind: "pmos" as const,
    terminalVoltages: { a: 1e155, b: -0.2e155, c: 0 },
    expectedCurrent: 7e152,
    expectedPower: 7e307,
  },
])("preserves large-bias $kind current and power in either drain direction", ({
  kind,
  terminalVoltages,
  expectedCurrent,
  expectedPower,
}) => {
  const analysis = analyzeAnalogCircuit(fixedBiasMosDocument(
    kind,
    terminalVoltages,
    { threshold: 2, beta: 1e-157, lambda: 0 },
  ));

  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.mos.current.real / expectedCurrent).toBeCloseTo(1, 12);
  expect(analysis.parts.mos.power.real / expectedPower).toBeCloseTo(1, 12);
});

it("retains finite lambda-modulated current, gm, and gds after base underflow and modulation overflow", () => {
  const bias = { a: 1e155, b: 1e-100, c: 0 };
  const parameters = { threshold: 0, beta: 1e-200, lambda: 1e155 };
  const dc = analyzeAnalogCircuit(fixedBiasMosDocument("nmos", bias, parameters));
  const gateAc = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
    { b: 1e-110 },
  ), { mode: "ac", frequencyHz: 1000 });
  const drainAc = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
    { a: 1e100, b: 0 },
  ), { mode: "ac", frequencyHz: 1000 });
  const expectedDcCurrent = 5e-91;
  const expectedDcPower = 5e64;
  const expectedGateCurrent = 1e-100;
  const expectedDrainCurrent = 5e-146;

  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.mos.current.real / expectedDcCurrent).toBeCloseTo(1, 10);
  expect(dc.parts.mos.power.real / expectedDcPower).toBeCloseTo(1, 10);
  expect(gateAc.status, gateAc.message).toBe("valid");
  expect(gateAc.parts.mos.terminalCurrents.a!.real / expectedGateCurrent).toBeCloseTo(1, 10);
  expect(drainAc.status, drainAc.message).toBe("valid");
  expect(drainAc.parts.mos.terminalCurrents.a!.real / expectedDrainCurrent).toBeCloseTo(1, 10);
});

it("retains finite triode current and slopes when lambda times VDS overflows", () => {
  const bias = { a: 2, b: 3, c: 0 };
  const parameters = { threshold: 0, beta: Number.MIN_VALUE, lambda: Number.MAX_VALUE };
  const betaLambda = Number.MIN_VALUE * Number.MAX_VALUE;
  const dc = analyzeAnalogCircuit(fixedBiasMosDocument("nmos", bias, parameters));
  const gateAc = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
    { b: 1e-3 },
  ), { mode: "ac", frequencyHz: 1000 });
  const drainAc = analyzeAnalogCircuit(fixedBiasMosDocument(
    "nmos",
    bias,
    parameters,
    { a: 1e-3, b: 0 },
  ), { mode: "ac", frequencyHz: 1000 });
  const expectedCurrent = 8 * betaLambda;
  const expectedPower = 2 * expectedCurrent;
  const expectedGateCurrent = 4 * betaLambda * 1e-3;
  const expectedDrainCurrent = 6 * betaLambda * 1e-3;

  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.mos.current.real / expectedCurrent).toBeCloseTo(1, 10);
  expect(dc.parts.mos.power.real / expectedPower).toBeCloseTo(1, 10);
  expect(gateAc.status, gateAc.message).toBe("valid");
  expect(gateAc.parts.mos.terminalCurrents.a!.real / expectedGateCurrent).toBeCloseTo(1, 10);
  expect(drainAc.status, drainAc.message).toBe("valid");
  expect(drainAc.parts.mos.terminalCurrents.a!.real / expectedDrainCurrent).toBeCloseTo(1, 10);
});
