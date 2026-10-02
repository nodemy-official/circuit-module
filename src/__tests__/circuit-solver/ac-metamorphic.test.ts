import { describe, expect, it } from "vitest";

import { analyzeCircuit, type CircuitAnalysis, type CircuitPartReading } from "../../circuit-solver.js";
import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
} from "../../circuit-model.js";

interface Phasor {
  real: number;
  imaginary: number;
}

interface RlcSpec {
  id: string;
  kind: "resistor" | "inductor" | "capacitor";
  value: number;
}

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

const add = (left: Phasor, right: Phasor): Phasor => ({
  real: left.real + right.real,
  imaginary: left.imaginary + right.imaginary,
});

const multiply = (left: Phasor, right: Phasor): Phasor => ({
  real: left.real * right.real - left.imaginary * right.imaginary,
  imaginary: left.real * right.imaginary + left.imaginary * right.real,
});

const divide = (left: Phasor, right: Phasor): Phasor => {
  const denominator = right.real ** 2 + right.imaginary ** 2;
  return {
    real: (left.real * right.real + left.imaginary * right.imaginary) / denominator,
    imaginary: (left.imaginary * right.real - left.real * right.imaginary) / denominator,
  };
};

const polar = (magnitude: number, phaseDegrees: number): Phasor => {
  const phase = phaseDegrees * Math.PI / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
};

const readingPhasor = (
  reading: CircuitPartReading,
  quantity: "voltage" | "current",
  terminal?: CircuitTerminal,
): Phasor => {
  const magnitude = terminal === undefined
    ? (quantity === "voltage" ? reading.voltageVolts : reading.currentAmps)
    : (quantity === "voltage" ? reading.terminalVoltages?.[terminal] : reading.terminalCurrents?.[terminal]) ?? 0;
  const phaseDegrees = terminal === undefined
    ? (quantity === "voltage" ? reading.voltagePhaseDegrees : reading.currentPhaseDegrees) ?? 0
    : (quantity === "voltage"
      ? reading.terminalVoltagePhasesDegrees?.[terminal]
      : reading.terminalCurrentPhasesDegrees?.[terminal]) ?? 0;
  return polar(magnitude, phaseDegrees);
};

function expectPhasor(actual: Phasor, expected: Phasor, relative = 2e-8, absolute = 1e-11) {
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const tolerance = absolute + relative * Math.hypot(expected.real, expected.imaginary);
  if (error >= tolerance) {
    throw new Error(`actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} error=${error} tolerance=${tolerance}`);
  }
}

function expectScalar(actual: number, expected: number, relative = 2e-8, absolute = 1e-20) {
  const error = Math.abs(actual - expected);
  const tolerance = absolute + relative * Math.abs(expected);
  if (error >= tolerance) {
    throw new Error(`actual=${actual} expected=${expected} error=${error} tolerance=${tolerance}`);
  }
}

function assertAcResult(result: CircuitAnalysis): CircuitAnalysis {
  if (result.status !== "closed" || result.mode !== "ac") {
    throw new Error(`Expected a closed AC circuit; received ${result.status}/${result.mode}: ${result.message}`);
  }
  return result;
}

function componentPart(spec: RlcSpec) {
  switch (spec.kind) {
    case "resistor": return part(spec.id, spec.kind, { resistanceOhms: spec.value });
    case "inductor": return part(spec.id, spec.kind, { inductanceHenries: spec.value });
    case "capacitor": return part(spec.id, spec.kind, { capacitanceFarads: spec.value });
  }
}

function seriesDocument(
  specs: RlcSpec[],
  source: { voltage: number; phase: number; frequency: number },
  groundNode = "source:b",
): CircuitDocument {
  const parts = [
    part("source", "ac-source", {
      voltageVolts: source.voltage,
      phaseDegrees: source.phase,
      frequencyHz: source.frequency,
    }),
    ...specs.map(componentPart),
    part("ground", "ground"),
  ];
  const wires = [] as CircuitDocument["wires"];
  const first = specs[0];
  const last = specs.at(-1);
  if (first) { wires.push(wire("start", "source", "a", first.id, "a")); }
  for (let index = 0; index + 1 < specs.length; index += 1) {
    const left = specs[index];
    const right = specs[index + 1];
    if (left && right) { wires.push(wire(`series-${index}`, left.id, "b", right.id, "a")); }
  }
  if (last) { wires.push(wire("end", last.id, "b", "source", "b")); }
  const [groundPart = "source", groundTerminal = "b"] = groundNode.split(":") as [string, CircuitTerminal?];
  wires.push(wire("ground-wire", "ground", "a", groundPart, groundTerminal ?? "b"));
  return { title: "公開APIの交流直列検査", parts, wires };
}

function parallelDocument(
  branches: RlcSpec[],
  source: { voltage: number; phase: number; frequency: number },
): CircuitDocument {
  const parts = [
    part("source", "ac-source", {
      voltageVolts: source.voltage,
      phaseDegrees: source.phase,
      frequencyHz: source.frequency,
    }),
    ...branches.map(componentPart),
    part("ground", "ground"),
  ];
  const wires = [wire("ground-wire", "source", "b", "ground", "a")];
  for (const branch of branches) {
    wires.push(wire(`source-${branch.id}`, "source", "a", branch.id, "a"));
    wires.push(wire(`return-${branch.id}`, branch.id, "b", "source", "b"));
  }
  return { title: "公開APIの交流並列検査", parts, wires };
}

function seededRandom(seed: number) {
  let state = BigInt(seed);
  const modulus = 4_294_967_296n;
  return () => {
    state = (state * 1_664_525n + 1_013_904_223n) % modulus;
    return Number(state) / 4_294_967_296;
  };
}

function logUniform(random: () => number, minExponent: number, maxExponent: number) {
  return 10 ** (minExponent + random() * (maxExponent - minExponent));
}

function impedance(spec: RlcSpec, omega: number): Phasor {
  if (spec.kind === "resistor") { return { real: spec.value, imaginary: 0 }; }
  if (spec.kind === "inductor") { return { real: 0, imaginary: omega * spec.value }; }
  return { real: 0, imaginary: -1 / (omega * spec.value) };
}

function assertComplexKcl(document: CircuitDocument, result: CircuitAnalysis) {
  const parent = new Map<string, string>();
  const endpoint = (partId: string, terminal: CircuitTerminal) => `${partId}:${terminal}`;
  const find = (key: string): string => {
    const current = parent.get(key);
    if (current === undefined) { parent.set(key, key); return key; }
    if (current === key) { return key; }
    const root = find(current);
    parent.set(key, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) { parent.set(leftRoot, rightRoot); }
  };

  for (const circuitPart of document.parts) {
    for (const terminal of terminalsOf(circuitPart.kind)) { find(endpoint(circuitPart.id, terminal)); }
  }
  for (const connection of document.wires) {
    union(endpoint(connection.from.partId, connection.from.terminal), endpoint(connection.to.partId, connection.to.terminal));
  }
  const grounds = document.parts.filter((circuitPart) => circuitPart.kind === "ground");
  for (const ground of grounds.slice(1)) {
    if (grounds[0]) { union(endpoint(grounds[0].id, "a"), endpoint(ground.id, "a")); }
  }

  const sums = new Map<string, Phasor>();
  const scales = new Map<string, number>();
  for (const circuitPart of document.parts) {
    const reading = result.parts[circuitPart.id];
    for (const terminal of terminalsOf(circuitPart.kind)) {
      const current = reading ? readingPhasor(reading, "current", terminal) : { real: 0, imaginary: 0 };
      const key = find(endpoint(circuitPart.id, terminal));
      sums.set(key, add(sums.get(key) ?? { real: 0, imaginary: 0 }, current));
      scales.set(key, (scales.get(key) ?? 0) + Math.hypot(current.real, current.imaginary));
    }
  }
  for (const [node, sum] of sums) {
    const residual = Math.hypot(sum.real, sum.imaginary);
    const tolerance = 2e-10 + 2e-8 * (scales.get(node) ?? 0);
    if (residual >= tolerance) { throw new Error(`KCL residual at ${node} is ${residual} A (tolerance ${tolerance})`); }
  }
}

function assertAcPowerBalance(document: CircuitDocument, result: CircuitAnalysis) {
  let deliveredWatts = 0;
  let absorbedWatts = 0;
  let reactiveTotal = 0;
  let reactiveScale = 0;
  for (const circuitPart of document.parts) {
    const reading = result.parts[circuitPart.id];
    if (!reading) { continue; }
    if (circuitPart.kind === "ac-source") { deliveredWatts += reading.powerWatts; }
    else if (circuitPart.kind !== "capacitor" && circuitPart.kind !== "inductor") { absorbedWatts += reading.powerWatts; }
    const reactive = reading.reactivePowerVars ?? 0;
    reactiveTotal += reactive;
    reactiveScale += Math.abs(reactive);
  }
  const activeTolerance = 1e-20 + 2e-8 * Math.max(Math.abs(deliveredWatts), Math.abs(absorbedWatts));
  const reactiveTolerance = 1e-20 + 2e-8 * reactiveScale;
  if (Math.abs(deliveredWatts - absorbedWatts) >= activeTolerance) {
    throw new Error(`Real power residual is ${deliveredWatts - absorbedWatts} W`);
  }
  if (Math.abs(reactiveTotal) >= reactiveTolerance) {
    throw new Error(`Reactive power residual is ${reactiveTotal} var`);
  }
}

function expectReadingsEqual(left: CircuitAnalysis, right: CircuitAnalysis, ids: string[]) {
  for (const id of ids) {
    const leftReading = left.parts[id];
    const rightReading = right.parts[id];
    if (!leftReading || !rightReading) { throw new Error(`Missing reading for ${id}`); }
    expectPhasor(readingPhasor(rightReading, "voltage"), readingPhasor(leftReading, "voltage"));
    expectPhasor(readingPhasor(rightReading, "current"), readingPhasor(leftReading, "current"));
    if (Math.abs(rightReading.powerWatts - leftReading.powerWatts) > 1e-12 + 1e-8 * Math.abs(leftReading.powerWatts)) {
      throw new Error(`Real power changed for ${id}: ${leftReading.powerWatts} → ${rightReading.powerWatts}`);
    }
    const leftReactive = leftReading.reactivePowerVars ?? 0;
    const rightReactive = rightReading.reactivePowerVars ?? 0;
    if (Math.abs(rightReactive - leftReactive) > 1e-12 + 1e-8 * Math.abs(leftReactive)) {
      throw new Error(`Reactive power changed for ${id}: ${leftReactive} → ${rightReactive}`);
    }
  }
}

describe("public analyzeCircuit AC analytic and metamorphic audit", () => {
  it("matches deterministic series RLC impedance cases and preserves KCL, KVL, and power", () => {
    const random = seededRandom(0x61_ac_20_26);
    for (let index = 0; index < 24; index += 1) {
      const source = {
        voltage: 0.5 + random() * 24,
        phase: random() * 720 - 360,
        frequency: logUniform(random, 1, 4.3),
      };
      const specs: RlcSpec[] = [
        { id: "r", kind: "resistor", value: logUniform(random, -1, 3) },
        { id: "l", kind: "inductor", value: logUniform(random, -5, 0) },
        { id: "c", kind: "capacitor", value: logUniform(random, -7, -3) },
      ];
      const groundNode = index % 3 === 0 ? "r:b" : "source:b";
      const document = seriesDocument(specs, source, groundNode);
      const result = assertAcResult(analyzeCircuit(document));
      const omega = 2 * Math.PI * source.frequency;
      const sourceVoltage = polar(source.voltage, source.phase);
      const impedances = specs.map((spec) => impedance(spec, omega));
      const totalImpedance = impedances.reduce(add, { real: 0, imaginary: 0 });
      const expectedCurrent = divide(sourceVoltage, totalImpedance);
      let expectedVoltageSum = { real: 0, imaginary: 0 };
      let expectedRealAbsorption = 0;

      expect(result.frequencyHz).toBeCloseTo(source.frequency, 12);
      for (let componentIndex = 0; componentIndex < specs.length; componentIndex += 1) {
        const spec = specs[componentIndex]!;
        const expectedVoltage = multiply(expectedCurrent, impedances[componentIndex]!);
        const reading = result.parts[spec.id]!;
        expectPhasor(readingPhasor(reading, "current"), expectedCurrent);
        expectPhasor(readingPhasor(reading, "voltage"), expectedVoltage);
        expectPhasor(readingPhasor(reading, "current", "a"), expectedCurrent);
        expectedVoltageSum = add(expectedVoltageSum, expectedVoltage);
        if (spec.kind === "resistor") { expectedRealAbsorption += expectedCurrent.real ** 2 * spec.value + expectedCurrent.imaginary ** 2 * spec.value; }
        if (spec.kind === "inductor") {
          expect(reading.reactivePowerVars).toBeGreaterThan(0);
          expect(reading.powerWatts).toBeCloseTo(0, 10);
        }
        if (spec.kind === "capacitor") {
          expect(reading.reactivePowerVars).toBeLessThan(0);
          expect(reading.powerWatts).toBeCloseTo(0, 10);
        }
      }
      expectPhasor(expectedVoltageSum, sourceVoltage);
      expectPhasor(readingPhasor(result.parts.source!, "voltage"), sourceVoltage);
      expectPhasor(readingPhasor(result.parts.source!, "current"), { real: -expectedCurrent.real, imaginary: -expectedCurrent.imaginary });
      expect(result.parts.source!.powerWatts).toBeCloseTo(expectedRealAbsorption, 8);
      expect(result.parts.ground!.terminalVoltages?.a).toBeCloseTo(0, 12);
      assertComplexKcl(document, result);
      assertAcPowerBalance(document, result);

      if (index === 5) {
        const permuted = assertAcResult(analyzeCircuit({
          ...document,
          parts: [...document.parts].reverse(),
          wires: [...document.wires].reverse(),
        }));
        expectReadingsEqual(result, permuted, ["source", "r", "l", "c"]);
      }
      if (index === 8) {
        const gain = 2.75;
        const phaseShift = 123;
        const changed = assertAcResult(analyzeCircuit(seriesDocument(specs, {
          ...source,
          voltage: source.voltage * gain,
          phase: source.phase + phaseShift,
        }, groundNode)));
        const transform = polar(gain, phaseShift);
        for (const id of ["source", "r", "l", "c"]) {
          expectPhasor(readingPhasor(changed.parts[id]!, "voltage"), multiply(readingPhasor(result.parts[id]!, "voltage"), transform));
          expectPhasor(readingPhasor(changed.parts[id]!, "current"), multiply(readingPhasor(result.parts[id]!, "current"), transform));
          expect(changed.parts[id]!.powerWatts).toBeCloseTo(result.parts[id]!.powerWatts * gain ** 2, 7);
          expect(changed.parts[id]!.reactivePowerVars).toBeCloseTo((result.parts[id]!.reactivePowerVars ?? 0) * gain ** 2, 7);
        }
      }
      if (index === 11) {
        const movedGround = assertAcResult(analyzeCircuit(seriesDocument(specs, source, "c:b")));
        expectReadingsEqual(result, movedGround, ["source", "r", "l", "c"]);
        expect(movedGround.parts.ground!.terminalVoltages?.a).toBeCloseTo(0, 12);
      }
    }
  });

  it("resolves near-resonant series circuits without losing opposing reactive voltage drops", () => {
    const random = seededRandom(0x52_45_53_4f);
    for (let index = 0; index < 12; index += 1) {
      const frequency = logUniform(random, 0, 3.5);
      const inductance = logUniform(random, -4, 0);
      const omega = 2 * Math.PI * frequency;
      const capacitance = 1 / (omega ** 2 * inductance);
      const resistance = logUniform(random, -1, 2);
      const source = { voltage: 1 + random() * 10, phase: random() * 360 - 180, frequency };
      const specs: RlcSpec[] = [
        { id: "r", kind: "resistor", value: resistance },
        { id: "l", kind: "inductor", value: inductance },
        { id: "c", kind: "capacitor", value: capacitance },
      ];
      const document = seriesDocument(specs, source);
      const result = assertAcResult(analyzeCircuit(document));
      const totalImpedance = specs.map((spec) => impedance(spec, omega)).reduce(add, { real: 0, imaginary: 0 });
      const expectedCurrent = divide(polar(source.voltage, source.phase), totalImpedance);
      let sum = { real: 0, imaginary: 0 };
      for (const spec of specs) {
        const branchImpedance = impedance(spec, omega);
        const expectedVoltage = multiply(expectedCurrent, branchImpedance);
        expectPhasor(readingPhasor(result.parts[spec.id]!, "current"), expectedCurrent);
        expectPhasor(readingPhasor(result.parts[spec.id]!, "voltage"), expectedVoltage);
        sum = add(sum, readingPhasor(result.parts[spec.id]!, "voltage"));
      }
      expectPhasor(sum, readingPhasor(result.parts.source!, "voltage"), 2e-8, 2e-9);
      assertComplexKcl(document, result);
      assertAcPowerBalance(document, result);
    }
  });

  it("matches parallel RLC branch admittances and source KCL for seeded values", () => {
    const random = seededRandom(0x50_41_20_26);
    for (let index = 0; index < 12; index += 1) {
      const source = {
        voltage: 0.5 + random() * 24,
        phase: random() * 360 - 180,
        frequency: logUniform(random, 1, 4),
      };
      const branches: RlcSpec[] = [
        { id: "r", kind: "resistor", value: logUniform(random, 0, 3) },
        { id: "l", kind: "inductor", value: logUniform(random, -5, 0) },
        { id: "c", kind: "capacitor", value: logUniform(random, -7, -3) },
      ];
      const document = parallelDocument(branches, source);
      const result = assertAcResult(analyzeCircuit(document, {}, { mode: "ac" }));
      const expectedVoltage = polar(source.voltage, source.phase);
      const expectedSourceCurrent = branches.reduce((sum, branch) => {
        const branchCurrent = divide(expectedVoltage, impedance(branch, 2 * Math.PI * source.frequency));
        const reading = result.parts[branch.id]!;
        expectPhasor(readingPhasor(reading, "voltage"), expectedVoltage);
        expectPhasor(readingPhasor(reading, "current"), branchCurrent);
        return add(sum, branchCurrent);
      }, { real: 0, imaginary: 0 });
      expectPhasor(readingPhasor(result.parts.source!, "current"), {
        real: -expectedSourceCurrent.real,
        imaginary: -expectedSourceCurrent.imaginary,
      });
      assertComplexKcl(document, result);
      assertAcPowerBalance(document, result);
    }
  });

  it("keeps reactive branch equations finite at the smallest and largest positive frequencies", () => {
    const cases = [
      { frequency: Number.MIN_VALUE, inductance: Number.MAX_VALUE, capacitance: Number.MAX_VALUE },
      { frequency: Number.MAX_VALUE, inductance: Number.MIN_VALUE, capacitance: Number.MIN_VALUE },
    ];
    for (const boundary of cases) {
      const document = seriesDocument([
        { id: "r", kind: "resistor", value: 1 },
        { id: "l", kind: "inductor", value: boundary.inductance },
        { id: "c", kind: "capacitor", value: boundary.capacitance },
      ], { voltage: 2, phase: 23, frequency: boundary.frequency });
      const result = assertAcResult(analyzeCircuit(document));
      const omegaL = (boundary.frequency * boundary.inductance) * (2 * Math.PI);
      const omegaC = (boundary.frequency * boundary.capacitance) * (2 * Math.PI);
      const sourceVoltage = polar(2, 23);
      const totalImpedance = { real: 1, imaginary: omegaL - 1 / omegaC };
      const expectedCurrent = divide(sourceVoltage, totalImpedance);

      expect(result.frequencyHz).toBe(boundary.frequency);
      expectPhasor(readingPhasor(result.parts.r!, "current"), expectedCurrent, 2e-7, 1e-25);
      expectPhasor(readingPhasor(result.parts.l!, "current"), expectedCurrent, 2e-7, 1e-25);
      expectPhasor(readingPhasor(result.parts.c!, "current"), expectedCurrent, 2e-7, 1e-25);
      expectPhasor(readingPhasor(result.parts.r!, "voltage"), expectedCurrent, 2e-7, 1e-25);
      expectPhasor(readingPhasor(result.parts.l!, "voltage"), multiply(expectedCurrent, { real: 0, imaginary: omegaL }), 2e-7, 1e-25);
      expectPhasor(readingPhasor(result.parts.c!, "voltage"), multiply(expectedCurrent, { real: 0, imaginary: -1 / omegaC }), 2e-7, 1e-10);
      const currentSquared = expectedCurrent.real ** 2 + expectedCurrent.imaginary ** 2;
      expectScalar(result.parts.r!.powerWatts, currentSquared);
      expectScalar(result.parts.source!.powerWatts, currentSquared);
      expectScalar(result.parts.l!.reactivePowerVars ?? 0, currentSquared * omegaL, 2e-7, 1e-35);
      expectScalar(result.parts.c!.reactivePowerVars ?? 0, -currentSquared / omegaC, 2e-7, 1e-35);
      expectScalar(result.parts.source!.reactivePowerVars ?? 0, -currentSquared * totalImpedance.imaginary, 2e-7, 1e-35);
      assertComplexKcl(document, result);
      assertAcPowerBalance(document, result);
    }
  });

  it("adds coherent source phasors and leaves physical readings unchanged when GND moves", () => {
    const source1 = { voltage: 3.7, phase: 172, frequency: 50 };
    const source2 = { voltage: 5.2, phase: -83, frequency: 50 };
    const document: CircuitDocument = {
      title: "複数交流源の公開API検査",
      parts: [
        part("source-1", "ac-source", { voltageVolts: source1.voltage, phaseDegrees: source1.phase, frequencyHz: source1.frequency }),
        part("source-2", "ac-source", { voltageVolts: source2.voltage, phaseDegrees: source2.phase, frequencyHz: source2.frequency }),
        part("load", "resistor", { resistanceOhms: 37 }),
        part("meter", "voltmeter"),
        part("ground", "ground"),
      ],
      wires: [
        wire("sources", "source-1", "b", "source-2", "a"),
        wire("load-start", "source-1", "a", "load", "a"),
        wire("load-end", "load", "b", "source-2", "b"),
        wire("meter-a", "meter", "a", "load", "a"),
        wire("meter-b", "meter", "b", "load", "b"),
        wire("ground-wire", "source-1", "b", "ground", "a"),
      ],
    };
    const base = assertAcResult(analyzeCircuit(document));
    const expectedSourceVoltage = add(polar(source1.voltage, source1.phase), polar(source2.voltage, source2.phase));
    const expectedCurrent = { real: expectedSourceVoltage.real / 37, imaginary: expectedSourceVoltage.imaginary / 37 };
    expect(base.parts.load!.voltageVolts).toBeCloseTo(Math.hypot(expectedSourceVoltage.real, expectedSourceVoltage.imaginary), 9);
    expectPhasor(readingPhasor(base.parts.load!, "current"), expectedCurrent);
    expectPhasor(readingPhasor(base.parts.meter!, "voltage"), expectedSourceVoltage);
    expect(base.parts.meter!.currentAmps).toBe(0);
    assertComplexKcl(document, base);
    assertAcPowerBalance(document, base);

    const moved = assertAcResult(analyzeCircuit({
      ...document,
      wires: document.wires.map((connection) => connection.id === "ground-wire"
        ? wire("ground-wire", "load", "a", "ground", "a")
        : connection),
    }));
    expectReadingsEqual(base, moved, ["source-1", "source-2", "load", "meter"]);
    expect(moved.parts.ground!.terminalVoltages?.a).toBeCloseTo(0, 12);
  });

  it("keeps mode, frequency, and open/idle/invalid statuses consistent at frequency boundaries", () => {
    const random = seededRandom(0x0f_0e_20_26);
    const frequencies = [Number.MIN_VALUE, 1e-308, 50, 60, 1e308, Number.MAX_VALUE];
    for (const frequency of frequencies) {
      const document = seriesDocument(
        [{ id: "r", kind: "resistor", value: 10 + random() * 90 }],
        { voltage: 1 + random() * 4, phase: random() * 360 - 180, frequency },
      );
      const automatic = assertAcResult(analyzeCircuit(document));
      expect(automatic.frequencyHz).toBe(frequency);
      expect(automatic.parts.r!.currentAmps).toBeCloseTo(automatic.parts.source!.currentAmps, 10);
      expect(automatic.status).toBe("closed");
    }

    const circuit = seriesDocument(
      [{ id: "r", kind: "resistor", value: 100 }],
      { voltage: 5, phase: 0, frequency: 50 },
    );
    const wrongFrequency = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 60 });
    expect(wrongFrequency.status).toBe("idle");
    expect(wrongFrequency.frequencyHz).toBe(60);
    expect(wrongFrequency.parts.r!.currentAmps).toBe(0);

    const dc = analyzeCircuit({
      ...circuit,
      parts: circuit.parts.map((item) => item.id === "source" ? { ...item, offsetVolts: 2 } : item),
    }, {}, { mode: "dc" });
    expect(dc.status).toBe("closed");
    expect(dc.mode).toBe("dc");
    expect(dc.parts.r!.voltageVolts).toBeCloseTo(2, 10);
    expect(dc.parts.r!.currentAmps).toBeCloseTo(0.02, 10);

    const invalidFrequency = analyzeCircuit(circuit, {}, { mode: "ac", frequencyHz: 0 });
    expect(invalidFrequency.status).toBe("invalid");
    expect(invalidFrequency.issues.some((issue) => issue.severity === "error")).toBe(true);

    const openSwitch: CircuitDocument = {
      title: "開放状態の交流回路",
      parts: [
        part("source", "ac-source", { voltageVolts: 5, frequencyHz: 50 }),
        part("switch", "switch", { initiallyClosed: false }),
        part("load", "resistor", { resistanceOhms: 100 }),
      ],
      wires: [
        wire("source-switch", "source", "a", "switch", "a"),
        wire("switch-load", "switch", "b", "load", "a"),
        wire("load-source", "load", "b", "source", "b"),
      ],
    };
    const opened = analyzeCircuit(openSwitch);
    expect(opened.status).toBe("open");
    expect(opened.mode).toBe("ac");
    expect(opened.currentAmps).toBe(0);
    expect(opened.parts.load!.currentAmps).toBe(0);
    expect(analyzeCircuit(openSwitch, { switch: true }).status).toBe("closed");
  });
});
