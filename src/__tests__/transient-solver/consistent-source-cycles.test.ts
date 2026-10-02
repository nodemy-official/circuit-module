import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitEndpoint,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
  type CircuitWire,
} from "../../circuit-model.js";
import { simulateTransient } from "../../transient-solver.js";

function part(id: string, kind: CircuitPartKind, extra: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...extra };
}

function source(id: string, phaseDegrees: number, extra: Partial<CircuitPart> = {}): CircuitPart {
  return part(id, "ac-source", { voltageVolts: 1, frequencyHz: 1, phaseDegrees, offsetVolts: 0, ...extra });
}

function endpoint(partId: string, terminal: CircuitTerminal): CircuitEndpoint {
  return { partId, terminal };
}

function connect(groups: CircuitEndpoint[][]): CircuitWire[] {
  return groups.flatMap((group, node) => group.slice(1).map((to, index) => ({
    id: `node-${node}-${index}`, from: group[0]!, to,
  })));
}

function parallel(parts: CircuitPart[]): CircuitDocument {
  return { title: "Parallel waveform audit", parts,
    wires: connect([parts.map(({ id }) => endpoint(id, "a")), parts.map(({ id }) => endpoint(id, "b"))]) };
}

const permutations = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
] as const;

function triangle(rotation = 0, order: readonly number[] = permutations[0], reversed = false, amplitude = 1): CircuitDocument {
  const sources = [
    source("left", rotation - 60, { voltageVolts: amplitude, offsetVolts: amplitude / 4 }),
    source("right", rotation + 60 + (reversed ? 180 : 0), {
      voltageVolts: amplitude, offsetVolts: (reversed ? -1 : 1) * amplitude / 2,
    }),
    source("total", rotation, { voltageVolts: amplitude, offsetVolts: 3 * amplitude / 4 }),
  ];
  return { title: "Independent cosine addition identity", parts: [
    ...order.map((index) => sources[index]!), part("load", "resistor", { resistanceOhms: amplitude }),
  ], wires: connect([
    [endpoint("left", "a"), endpoint("total", "a"), endpoint("load", "a")],
    [endpoint("left", "b"), endpoint("right", reversed ? "b" : "a")],
    [endpoint("right", reversed ? "a" : "b"), endpoint("total", "b"), endpoint("load", "b")],
  ]) };
}

function closedChain(parts: CircuitPart[]): CircuitDocument {
  return { title: "Closed source waveform chain", parts: [...parts, part("load", "resistor", { resistanceOhms: 4 })],
    wires: connect(parts.map((item, index) => [
      endpoint(item.id, "a"), endpoint(parts[(index + parts.length - 1) % parts.length]!.id, "b"),
      ...(index === 0 ? [endpoint("load", "a")] : []),
      ...(index === 1 ? [endpoint("load", "b")] : []),
    ])) };
}

// These references use analytic identities and ordinary Math functions, not
// the solver's waveform, phasor, or exact arithmetic implementation. The
// relative checks cover the documented binary64 trigonometric boundary;
// nonzero constraint conflicts must still be rejected without a tolerance.
function analyticVoltage(item: CircuitPart, timeSeconds: number): number {
  if (item.kind === "battery") { return item.voltageVolts!; }
  return item.offsetVolts! + Math.SQRT2 * item.voltageVolts! *
    Math.cos(2 * Math.PI * item.frequencyHz! * timeSeconds + item.phaseDegrees! * Math.PI / 180);
}

describe("independent continuous-source consistency audit", () => {
  it.each(permutations.flatMap((order, index) => [0, 37, 45, 90, -135, -397].flatMap((rotation) =>
    [false, true].map((reversed) => ({ order, index, rotation, reversed })))))(
    "preserves rotated identities in order $index at $rotation degrees with reversed polarity $reversed",
    ({ order, rotation, reversed }) => {
      const document = triangle(rotation, order, reversed);
      expect(analyzeAnalogCircuit(document, { mode: "dc" }).status).toBe("valid");
      expect(analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 }).status).toBe("valid");
      const result = simulateTransient(document, { durationSeconds: 0.375, timeStepSeconds: 0.125 });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(4);
      for (const sample of result.samples) {
        const expected = 0.75 + Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + rotation * Math.PI / 180);
        expect(Math.abs(sample.parts.load!.voltageVolts - expected)).toBeLessThan(2e-14);
        expect(Math.abs(sample.parts.load!.currentAmps - expected)).toBeLessThan(2e-14);
        const rightSign = reversed ? -1 : 1;
        expect(Math.abs(sample.parts.left!.voltageVolts + rightSign * sample.parts.right!.voltageVolts -
          sample.parts.total!.voltageVolts)).toBeLessThan(2e-14);
      }
    },
  );

  it.each([2 ** -1000, 2 ** -400, 2 ** 400])("preserves the identity at RMS amplitude %s", (amplitude) => {
    const result = simulateTransient(triangle(37, permutations[5], true, amplitude), {
      durationSeconds: 0.25, timeStepSeconds: 0.125,
    });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const normalized = 0.75 + Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      expect(Math.abs(sample.parts.load!.voltageVolts / amplitude - normalized)).toBeLessThan(2e-14);
      expect(Math.abs(sample.parts.load!.currentAmps - normalized)).toBeLessThan(2e-14);
    }
  });

  it.each([3, 5, 6].flatMap((count) => [0, 37].flatMap((rotation) =>
    [false, true].map((reversed) => ({ count, rotation, reversed })))))(
    "satisfies the roots-of-unity identity for $count phases, rotation $rotation, reversed order $reversed",
    ({ count, rotation, reversed }) => {
      // Sum of all nth roots of unity is exactly zero, including a pentagon
      // whose phase coefficients are not expressible as binary64 values.
      const document = closedChain(Array.from({ length: count }, (_, index) => source(`s-${index}`, rotation + index * 360 / count)));
      if (reversed) { document.parts.reverse(); }
      const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
      expect(result.status, result.message).toBe("valid");
      for (const sample of result.samples) {
        for (const item of document.parts.filter((entry) => entry.kind === "ac-source")) {
          expect(Math.abs(sample.parts[item.id]!.voltageVolts - analyticVoltage(item, sample.timeSeconds))).toBeLessThan(2e-14);
        }
        expect(Math.abs(sample.parts.load!.currentAmps - sample.parts["s-0"]!.voltageVolts / 4)).toBeLessThan(2e-14);
      }
    },
  );

  it.each([false, true])("checks independent frequencies and a battery offset in one loop (reverse $reversed)", (reversed) => {
    const document = closedChain([
      source("one", 37, { frequencyHz: 0.5, offsetVolts: 0.5 }),
      source("minus-one", 217, { frequencyHz: 0.5, offsetVolts: -0.25 }),
      source("two", -23, { frequencyHz: 3.25, voltageVolts: 2 }),
      source("minus-two", 157, { frequencyHz: 3.25, voltageVolts: 2, offsetVolts: -0.75 }),
      source("zero", 19, { frequencyHz: 17, voltageVolts: 0 }),
      part("dc", "battery", { voltageVolts: 0.5 }),
    ]);
    if (reversed) { document.parts.reverse(); }
    const result = simulateTransient(document, { durationSeconds: 0.375, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      for (const item of document.parts.filter((entry) => entry.kind !== "resistor")) {
        expect(Math.abs(sample.parts[item.id]!.voltageVolts - analyticVoltage(item, sample.timeSeconds))).toBeLessThan(2e-14);
      }
    }
  });

  it.each([Number.MIN_VALUE, 1e-160, 2 ** -40])("rejects a nonzero phase %s despite rounded initial equality", (phaseDegrees) => {
    const document = triangle();
    document.parts.find(({ id }) => id === "total")!.phaseDegrees = phaseDegrees;
    for (const parts of [document.parts, document.parts.toReversed()]) {
      const result = simulateTransient({ ...document, parts }, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
      expect(result.status, result.message).toBe("invalid");
      expect(result.samples).toHaveLength(0);
      expect(result.issues.some((issue) => issue.message.includes("時間波形"))).toBe(true);
    }
  });

  it.each([0, 37, 90])("rejects one ULP of amplitude conflict after rotation %s", (rotation) => {
    const document = triangle(rotation);
    document.parts.find(({ id }) => id === "total")!.voltageVolts = 1 + Number.EPSILON;
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it.each([1e-160, Number.MIN_VALUE])("rejects the second-order curvature conflict at symmetric phase %s", (phaseDegrees) => {
    // cos(x-d)+cos(x+d)=2*cos(d)*cos(x), which differs from 2*cos(x)
    // at second order even when the rounded initial voltages and slopes agree.
    const document = closedChain([source("positive", phaseDegrees), source("negative", -phaseDegrees),
      source("total", 180, { voltageVolts: 2 })]);
    const result = simulateTransient(document, { durationSeconds: 1, timeStepSeconds: 0.5 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it.each([Number.MIN_VALUE, Number.EPSILON])("rejects an exact DC residual %s in an otherwise consistent loop", (offsetVolts) => {
    const document = triangle();
    for (const item of document.parts.filter((entry) => entry.kind === "ac-source")) {
      item.offsetVolts = item.id === "total" ? offsetVolts : 0;
    }
    expect(simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 }).status).toBe("invalid");
  });

  it.each([1 + Number.EPSILON, 2, Number.MIN_VALUE])("rejects a different nonzero frequency %s", (frequencyHz) => {
    const result = simulateTransient(parallel([source("first", 0), source("second", 0, { frequencyHz })]), {
      durationSeconds: 1, timeStepSeconds: 0.5,
    });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it("ignores phase and frequency when the RMS amplitude is exactly zero", () => {
    const result = simulateTransient(parallel([
      source("one", Number.MIN_VALUE, { frequencyHz: Number.MIN_VALUE, voltageVolts: 0, offsetVolts: 0.5 }),
      source("two", -397, { frequencyHz: 3.25, voltageVolts: 0, offsetVolts: 0.5 }),
      part("dc", "battery", { voltageVolts: 0.5 }),
      part("load", "resistor", { resistanceOhms: 2 }),
    ]), { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      expect(sample.parts.load!.voltageVolts).toBe(0.5);
      expect(sample.parts.load!.currentAmps).toBe(0.25);
    }
  });

  it.each([false, true])("rejects a mismatch between the two smallest nonzero RMS amplitudes (reverse %s)", (reversed) => {
    const parts = [source("one", 90, { voltageVolts: Number.MIN_VALUE }),
      source("two", 90, { voltageVolts: 2 * Number.MIN_VALUE })];
    const result = simulateTransient(parallel(reversed ? parts.reverse() : parts), { durationSeconds: 1, timeStepSeconds: 1 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it("retains a consistent subnormal waveform without rounding its resistor current to zero", () => {
    const document = triangle(37);
    document.parts = document.parts.map((item) => item.kind === "ac-source"
      ? { ...item, voltageVolts: Number.MIN_VALUE, offsetVolts: 0 }
      : { ...item, resistanceOhms: Number.MIN_VALUE });
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const current = Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      expect(Math.abs(sample.parts.load!.currentAmps - current)).toBeLessThan(2e-14);
      expect(sample.parts.load!.currentAmps).not.toBe(0);
    }
  });

  it.each([1e-10, 2 ** 800])("preserves consistent source constraints at frequency %s", (frequencyHz) => {
    const document = triangle(45);
    document.parts = document.parts.map((item) => item.kind === "ac-source" ? { ...item, frequencyHz } : item);
    const result = simulateTransient(document, { durationSeconds: 0.375, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      // 2^800 times each binary-fraction sample time is an exact whole cycle.
      const turns = frequencyHz > 1 ? 0 : frequencyHz * sample.timeSeconds;
      const voltage = 0.75 + Math.SQRT2 * Math.cos(2 * Math.PI * turns + Math.PI / 4);
      expect(Math.abs(sample.parts.load!.currentAmps - voltage)).toBeLessThan(2e-14);
    }
  });

  it.each([
    { kind: "ammeter" as const, terminal: "a" as const, extra: {} },
    { kind: "switch" as const, terminal: "a" as const, extra: { initiallyClosed: true } },
    { kind: "potentiometer" as const, terminal: "a" as const, extra: { resistanceOhms: 2, wiperPosition: 0 } },
    { kind: "potentiometer" as const, terminal: "b" as const, extra: { resistanceOhms: 2, wiperPosition: 1 } },
  ])("checks the source loop through a zero-volt $kind segment at terminal $terminal", ({ kind, terminal, extra }) => {
    const document = triangle(37);
    document.parts.push(part("bridge", kind, extra));
    const middle = document.wires.find((wire) => wire.from.partId === "left" && wire.from.terminal === "b")!;
    middle.to = endpoint("bridge", terminal);
    const otherTerminal = kind === "potentiometer" ? "c" : "b";
    document.wires.push({ id: "bridge-out", from: endpoint("bridge", otherTerminal), to: endpoint("right", "a") });
    for (const reverse of [false, true]) {
      const parts = reverse ? document.parts.toReversed() : document.parts;
      const options = { durationSeconds: 0.25, timeStepSeconds: 0.125 };
      const valid = simulateTransient({ ...document, parts }, options);
      expect(valid.status, valid.message).toBe("valid");
      expect(valid.samples).toHaveLength(3);
      const badParts = parts.map((item) => item.id === "total" ? { ...item, voltageVolts: 1 + Number.EPSILON } : item);
      const invalid = simulateTransient({ ...document, parts: badParts }, options);
      expect(invalid.status).toBe("invalid");
      expect(invalid.samples).toHaveLength(0);
    }
  });

  it.each([false, true])("uses the effective switch state when a waveform loop is opened (initially closed %s)", (initiallyClosed) => {
    const document = triangle(37);
    document.parts.push(part("bridge", "switch", { initiallyClosed }));
    const middle = document.wires.find((wire) => wire.from.partId === "left" && wire.from.terminal === "b")!;
    middle.to = endpoint("bridge", "a");
    document.wires.push({ id: "bridge-out", from: endpoint("bridge", "b"), to: endpoint("right", "a") });
    document.parts.find(({ id }) => id === "total")!.voltageVolts = 1 + Number.EPSILON;
    const options = { durationSeconds: 0.25, timeStepSeconds: 0.125 };
    const open = simulateTransient(document, { ...options, switchStates: { bridge: false } });
    const closed = simulateTransient(document, { ...options, switchStates: { bridge: true } });
    expect(open.status, open.message).toBe("valid");
    expect(open.samples).toHaveLength(3);
    expect(closed.status).toBe("invalid");
    expect(closed.samples).toHaveLength(0);
    for (const sample of open.samples) {
      expect(sample.parts.bridge!.currentAmps).toBe(0);
      expect(sample.parts.left!.currentAmps).toBe(0);
      expect(sample.parts.right!.currentAmps).toBe(0);
    }
  });

  it("does not impose a zero-voltage constraint across an ideal voltmeter", () => {
    const document = triangle(37);
    document.parts.push(part("bridge", "voltmeter"));
    const middle = document.wires.find((wire) => wire.from.partId === "left" && wire.from.terminal === "b")!;
    middle.to = endpoint("bridge", "a");
    document.wires.push({ id: "bridge-out", from: endpoint("bridge", "b"), to: endpoint("right", "a") });
    document.parts.find(({ id }) => id === "total")!.voltageVolts = 2;
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status, result.message).toBe("valid");
    for (const sample of result.samples) {
      const voltage = Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      expect(sample.parts.bridge!.currentAmps).toBe(0);
      expect(Math.abs(sample.parts.bridge!.voltageVolts - voltage)).toBeLessThan(2e-14);
    }
  });

  it.each([false, true])("preserves the RC and RL state under initialization mode %s", (startFromOperatingPoint) => {
    const document = triangle(37, permutations[5], true);
    document.parts.push(
      part("rc", "resistor", { resistanceOhms: 2 }), part("c", "capacitor", { capacitanceFarads: 0.25, initialVoltageVolts: 0.125 }),
      part("rl", "resistor", { resistanceOhms: 3 }), part("l", "inductor", { inductanceHenries: 0.5, initialCurrentAmps: 0.125 }),
    );
    document.wires.push(...connect([
      [endpoint("total", "a"), endpoint("rc", "a"), endpoint("rl", "a")],
      [endpoint("total", "b"), endpoint("c", "b"), endpoint("l", "b")],
      [endpoint("rc", "b"), endpoint("c", "a")], [endpoint("rl", "b"), endpoint("l", "a")],
    ]).map((wire) => ({ ...wire, id: `storage-${wire.id}` })));
    const result = simulateTransient(document, { durationSeconds: 0.375, timeStepSeconds: 0.125, startFromOperatingPoint });
    expect(result.status, result.message).toBe("valid");
    let capacitor = startFromOperatingPoint ? 0.75 : 0.125;
    let inductor = startFromOperatingPoint ? 0.25 : 0.125;
    for (const [index, sample] of result.samples.entries()) {
      const voltage = 0.75 + Math.SQRT2 * Math.cos(2 * Math.PI * sample.timeSeconds + 37 * Math.PI / 180);
      if (index > 0) {
        capacitor = (capacitor + 0.25 * voltage) / 1.25;
        inductor = (inductor + 0.25 * voltage) / 1.75;
      }
      expect(Math.abs(sample.parts.c!.voltageVolts - capacitor)).toBeLessThan(2e-14);
      expect(Math.abs(sample.parts.c!.currentAmps - (voltage - capacitor) / 2)).toBeLessThan(2e-14);
      expect(Math.abs(sample.parts.l!.currentAmps - inductor)).toBeLessThan(2e-14);
      expect(Math.abs(sample.parts.l!.voltageVolts - (voltage - 3 * inductor))).toBeLessThan(2e-14);
    }
  });

  it.each([false, true])("retains a direct capacitor's derivative without relaxing its initial voltage (operating point %s)", (startFromOperatingPoint) => {
    const document = triangle(90, permutations[5]);
    document.parts.push(part("c", "capacitor", { capacitanceFarads: 0.25, initialVoltageVolts: 0.75 }));
    document.wires.push({ id: "c-top", from: endpoint("c", "a"), to: endpoint("total", "a") },
      { id: "c-bottom", from: endpoint("c", "b"), to: endpoint("total", "b") });
    const options = { durationSeconds: 0.25, timeStepSeconds: 0.125, startFromOperatingPoint };
    const result = simulateTransient(document, options);
    expect(result.status, result.message).toBe("valid");
    expect(result.samples[0]!.parts.c!.voltageVolts).toBe(0.75);
    expect(result.samples[0]!.parts.c!.currentAmps / (-0.5 * Math.PI * Math.SQRT2)).toBeCloseTo(1, 14);
    let previous = 0.75;
    for (const sample of result.samples.slice(1)) {
      const voltage = 0.75 - Math.SQRT2 * Math.sin(2 * Math.PI * sample.timeSeconds);
      expect(Math.abs(sample.parts.c!.voltageVolts - voltage)).toBeLessThan(2e-14);
      expect(Math.abs(sample.parts.c!.currentAmps - 2 * (voltage - previous))).toBeLessThan(2e-14);
      previous = voltage;
    }
    const badParts = document.parts.map((item) => item.kind === "ac-source" ? { ...item, phaseDegrees: item.phaseDegrees! - 90 } : item);
    const invalid = simulateTransient({ ...document, parts: badParts }, options);
    expect(invalid.status).toBe("invalid");
    expect(invalid.samples).toHaveLength(0);
  });

  it("does not absorb a subnormal capacitor initial-voltage conflict", () => {
    const document = parallel([source("one", 90), source("two", 450),
      part("c", "capacitor", { capacitanceFarads: 0.25, initialVoltageVolts: Number.MIN_VALUE })]);
    const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125 });
    expect(result.status).toBe("invalid");
    expect(result.samples).toHaveLength(0);
  });

  it.each([false, true].flatMap((reverse) => [false, true].map((startFromOperatingPoint) => ({ reverse, startFromOperatingPoint }))))(
    "handles two compatible triangles sharing a capacitor (reverse $reverse, operating point $startFromOperatingPoint)",
    ({ reverse, startFromOperatingPoint }) => {
      const document = triangle(90, permutations[5]);
      document.parts.unshift(part("c", "capacitor", { capacitanceFarads: 0.25, initialVoltageVolts: 0.75 }),
        source("other-left", 30, { offsetVolts: 0.25 }), source("other-right", 150, { offsetVolts: 0.5 }));
      document.wires.push(...connect([
        [endpoint("total", "a"), endpoint("other-left", "a"), endpoint("c", "a")],
        [endpoint("total", "b"), endpoint("other-right", "b"), endpoint("c", "b")],
        [endpoint("other-left", "b"), endpoint("other-right", "a")],
      ]).map((wire) => ({ ...wire, id: `shared-${wire.id}` })));
      if (reverse) { document.parts.reverse(); }
      const result = simulateTransient(document, { durationSeconds: 0.25, timeStepSeconds: 0.125, startFromOperatingPoint });
      expect(result.status, result.message).toBe("valid");
      expect(result.samples).toHaveLength(3);
      expect(result.samples[0]!.parts.c!.currentAmps / (-0.5 * Math.PI * Math.SQRT2)).toBeCloseTo(1, 14);
      for (const sample of result.samples) {
        const voltage = 0.75 - Math.SQRT2 * Math.sin(2 * Math.PI * sample.timeSeconds);
        expect(Math.abs(sample.parts.c!.voltageVolts - voltage)).toBeLessThan(2e-14);
      }
    },
  );
});
