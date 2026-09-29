import { describe, expect, it } from "vitest";

import {
  circuitPartCatalog,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
  type CircuitTerminal,
  terminalsOf,
} from "../circuit-model.js";
import { analyzeAnalogCircuit, type AnalogCircuitAnalysis } from "../analog-solver.js";

interface Phasor {
  real: number;
  imaginary: number;
}

interface RlcComponent {
  id: string;
  kind: "resistor" | "capacitor" | "inductor";
  value: number;
}

const makePart = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
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

const conjugate = (value: Phasor): Phasor => ({ real: value.real, imaginary: -value.imaginary });

const polar = (magnitude: number, phaseDegrees: number): Phasor => {
  const phase = (phaseDegrees * Math.PI) / 180;
  return { real: magnitude * Math.cos(phase), imaginary: magnitude * Math.sin(phase) };
};

const impedance = (component: RlcComponent, omega: number): Phasor => {
  if (component.kind === "resistor") { return { real: component.value, imaginary: 0 }; }
  if (component.kind === "inductor") { return { real: 0, imaginary: omega * component.value }; }
  return { real: 0, imaginary: -1 / (omega * component.value) };
};

const closePhasor = (actual: Phasor, expected: Phasor, relative = 1e-8, absolute = 1e-11) => {
  const error = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const tolerance = absolute + relative * Math.hypot(expected.real, expected.imaginary);
  if (error >= tolerance) {
    throw new Error(`actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} error=${error}`);
  }
};

const complexPower = (voltage: Phasor, current: Phasor) => multiply(voltage, conjugate(current));

function seriesDocument(
  componentSpecs: RlcComponent[],
  sourceSpec: { voltage: number; phase: number; frequency: number },
  groundAt = "source:b",
): CircuitDocument {
  const parts: CircuitPart[] = [
    makePart("source", "ac-source", {
      voltageVolts: sourceSpec.voltage,
      phaseDegrees: sourceSpec.phase,
      frequencyHz: sourceSpec.frequency,
    }),
    ...componentSpecs.map((component) => makePart(
      component.id,
      component.kind,
      component.kind === "resistor"
        ? { resistanceOhms: component.value }
        : component.kind === "capacitor"
          ? { capacitanceFarads: component.value }
          : { inductanceHenries: component.value },
    )),
    makePart("ground", "ground"),
  ];
  const wires = [] as CircuitDocument["wires"];
  const first = componentSpecs[0];
  const last = componentSpecs.at(-1);
  if (first) { wires.push(wire("series-start", "source", "a", first.id, "a")); }
  for (let index = 0; index < componentSpecs.length - 1; index += 1) {
    const current = componentSpecs[index];
    const next = componentSpecs[index + 1];
    if (current && next) { wires.push(wire(`series-${index}`, current.id, "b", next.id, "a")); }
  }
  if (last) { wires.push(wire("series-end", last.id, "b", "source", "b")); }
  const [groundPartId = "source", groundTerminal = "b"] = groundAt.split(":") as [string, CircuitTerminal?];
  wires.push(wire("ground-wire", "ground", "a", groundPartId, groundTerminal ?? "b"));
  return { title: "直列RLCメタモルフィック検査", parts, wires };
}

function parallelDocument(
  sourceSpec: { voltage: number; phase: number; frequency: number },
  branches: RlcComponent[],
): CircuitDocument {
  const parts: CircuitPart[] = [
    makePart("source", "ac-source", {
      voltageVolts: sourceSpec.voltage,
      phaseDegrees: sourceSpec.phase,
      frequencyHz: sourceSpec.frequency,
    }),
    ...branches.map((component) => makePart(
      component.id,
      component.kind,
      component.kind === "resistor"
        ? { resistanceOhms: component.value }
        : component.kind === "capacitor"
          ? { capacitanceFarads: component.value }
          : { inductanceHenries: component.value },
    )),
    makePart("ground", "ground"),
  ];
  const wires = [wire("ground-wire", "source", "b", "ground", "a")];
  for (const branch of branches) {
    wires.push(wire(`source-${branch.id}`, "source", "a", branch.id, "a"));
    wires.push(wire(`return-${branch.id}`, branch.id, "b", "source", "b"));
  }
  return { title: "並列RLCメタモルフィック検査", parts, wires };
}

function assertKcl(document: CircuitDocument, result: AnalogCircuitAnalysis) {
  const parent = new Map<string, string>();
  const endpoint = (partId: string, terminal: CircuitTerminal) => `${partId}:${terminal}`;
  const find = (node: string): string => {
    const current = parent.get(node);
    if (!current) {
      parent.set(node, node);
      return node;
    }
    if (current === node) { return node; }
    const root = find(current);
    parent.set(node, root);
    return root;
  };
  const union = (left: string, right: string) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) { parent.set(leftRoot, rightRoot); }
  };

  for (const part of document.parts) {
    for (const terminal of terminalsOf(part.kind)) { find(endpoint(part.id, terminal)); }
  }
  for (const connection of document.wires) {
    union(endpoint(connection.from.partId, connection.from.terminal), endpoint(connection.to.partId, connection.to.terminal));
  }
  const grounds = document.parts.filter((part) => part.kind === "ground");
  for (const ground of grounds.slice(1)) { union(endpoint(grounds[0]!.id, "a"), endpoint(ground.id, "a")); }

  const sums = new Map<string, Phasor>();
  const scales = new Map<string, number>();
  for (const part of document.parts) {
    const currents = result.parts[part.id]?.terminalCurrents ?? {};
    for (const terminal of terminalsOf(part.kind)) {
      const current = currents[terminal] ?? { real: 0, imaginary: 0 };
      const key = find(endpoint(part.id, terminal));
      sums.set(key, add(sums.get(key) ?? { real: 0, imaginary: 0 }, current));
      scales.set(key, (scales.get(key) ?? 0) + Math.hypot(current.real, current.imaginary));
    }
  }
  for (const [node, sum] of sums) {
    const scale = scales.get(node) ?? 0;
    const residual = Math.hypot(sum.real, sum.imaginary);
    if (residual >= 1e-10 * Math.max(scale, 1)) {
      throw new Error(`KCL residual at ${node} is ${residual} A (scale ${scale} A)`);
    }
  }
}

function assertPowerConservation(result: AnalogCircuitAnalysis) {
  let total = { real: 0, imaginary: 0 };
  let scale = 0;
  for (const reading of Object.values(result.parts)) {
    total = add(total, reading.power);
    scale += Math.hypot(reading.power.real, reading.power.imaginary);
    closePhasor(reading.power, complexPower(reading.voltage, reading.current), 1e-8, 1e-9);
  }
  const residual = Math.hypot(total.real, total.imaginary);
  if (residual >= 1e-8 * Math.max(scale, 1)) {
    throw new Error(`Complex power residual is ${residual} VA (scale ${scale} VA)`);
  }
}

function assertValid(document: CircuitDocument, analysis?: AnalogCircuitAnalysis) {
  const result = analysis ?? analyzeAnalogCircuit(document, { mode: "ac" });
  if (result.status !== "valid") { throw new Error(result.message); }
  assertKcl(document, result);
  assertPowerConservation(result);
  return result;
}

const seriesComponents: RlcComponent[] = [
  { id: "r", kind: "resistor", value: 68 },
  { id: "l", kind: "inductor", value: 0.15 },
  { id: "c", kind: "capacitor", value: 22e-6 },
];
const seriesSource = { voltage: 12, phase: 35, frequency: 120 };

describe("AC solver metamorphic checks against impedance equations", () => {
  it("matches analytic series RLC voltage, current, KVL and complex power", () => {
    const document = seriesDocument(seriesComponents, seriesSource);
    const result = assertValid(document);
    const omega = 2 * Math.PI * seriesSource.frequency;
    const sourceVoltage = polar(seriesSource.voltage, seriesSource.phase);
    const componentImpedances = seriesComponents.map((component) => impedance(component, omega));
    const totalImpedance = componentImpedances.reduce(add, { real: 0, imaginary: 0 });
    const expectedCurrent = divide(sourceVoltage, totalImpedance);
    let voltageSum = { real: 0, imaginary: 0 };
    let expectedPowerSum = { real: 0, imaginary: 0 };

    for (let index = 0; index < seriesComponents.length; index += 1) {
      const component = seriesComponents[index]!;
      const expectedVoltage = multiply(expectedCurrent, componentImpedances[index]!);
      const reading = result.parts[component.id]!;
      closePhasor(reading.current, expectedCurrent);
      closePhasor(reading.voltage, expectedVoltage);
      closePhasor(reading.terminalCurrents.a!, expectedCurrent);
      voltageSum = add(voltageSum, reading.voltage);
      expectedPowerSum = add(expectedPowerSum, complexPower(expectedVoltage, expectedCurrent));
    }
    closePhasor(voltageSum, sourceVoltage);
    closePhasor(result.parts.source.voltage, sourceVoltage);
    closePhasor(result.parts.source.current, { real: -expectedCurrent.real, imaginary: -expectedCurrent.imaginary });
    closePhasor(result.parts.source.power, complexPower(sourceVoltage, result.parts.source.current));
    closePhasor(expectedPowerSum, complexPower(sourceVoltage, expectedCurrent));
  });

  it("matches analytic parallel RLC branch currents and source KCL", () => {
    const branches: RlcComponent[] = [
      { id: "r", kind: "resistor", value: 120 },
      { id: "l", kind: "inductor", value: 0.03 },
      { id: "c", kind: "capacitor", value: 47e-6 },
    ];
    const document = parallelDocument({ voltage: 8, phase: -27, frequency: 230 }, branches);
    const result = assertValid(document);
    const omega = 2 * Math.PI * 230;
    const expectedVoltage = polar(8, -27);
    const expectedCurrents = branches.map((branch) => divide(expectedVoltage, impedance(branch, omega)));
    const expectedSourceCurrent = expectedCurrents.reduce(add, { real: 0, imaginary: 0 });

    branches.forEach((branch, index) => {
      const reading = result.parts[branch.id]!;
      closePhasor(reading.voltage, expectedVoltage);
      closePhasor(reading.current, expectedCurrents[index]!);
    });
    closePhasor(result.parts.source.voltage, expectedVoltage);
    closePhasor(result.parts.source.current, {
      real: -expectedSourceCurrent.real,
      imaginary: -expectedSourceCurrent.imaginary,
    });
  });

  it("rotates and scales every AC voltage/current consistently when source phase and RMS amplitude change", () => {
    const base = assertValid(seriesDocument(seriesComponents, seriesSource));
    const gain = 3.25;
    const phaseShift = 67;
    const changed = assertValid(seriesDocument(seriesComponents, {
      ...seriesSource,
      voltage: seriesSource.voltage * gain,
      phase: seriesSource.phase + phaseShift,
    }));
    const transform = polar(gain, phaseShift);

    for (const part of Object.keys(base.parts)) {
      closePhasor(changed.parts[part]!.voltage, multiply(base.parts[part]!.voltage, transform));
      closePhasor(changed.parts[part]!.current, multiply(base.parts[part]!.current, transform));
      closePhasor(changed.parts[part]!.power, {
        real: base.parts[part]!.power.real * gain ** 2,
        imaginary: base.parts[part]!.power.imaginary * gain ** 2,
      });
    }
  });

  it("is invariant to part and wire array ordering", () => {
    const document = seriesDocument(seriesComponents, seriesSource);
    const baseline = assertValid(document);
    const permuted = assertValid({
      ...document,
      parts: [...document.parts].reverse(),
      wires: [...document.wires].reverse(),
    });
    for (const part of Object.keys(baseline.parts)) {
      closePhasor(permuted.parts[part]!.voltage, baseline.parts[part]!.voltage);
      closePhasor(permuted.parts[part]!.current, baseline.parts[part]!.current);
      closePhasor(permuted.parts[part]!.power, baseline.parts[part]!.power);
    }
  });

  it("keeps branch quantities invariant when GND moves to another series node", () => {
    const baselineDocument = seriesDocument(seriesComponents, seriesSource);
    const movedGroundDocument = seriesDocument(seriesComponents, seriesSource, "r:b");
    const baseline = assertValid(baselineDocument);
    const moved = assertValid(movedGroundDocument);
    const referenceShift = baseline.parts.r!.terminalVoltages.b!;

    for (const part of seriesComponents) {
      closePhasor(moved.parts[part.id]!.voltage, baseline.parts[part.id]!.voltage);
      closePhasor(moved.parts[part.id]!.current, baseline.parts[part.id]!.current);
      closePhasor(moved.parts[part.id]!.power, baseline.parts[part.id]!.power);
      for (const terminal of ["a", "b"] as const) {
        const expectedTerminalVoltage = add(baseline.parts[part.id]!.terminalVoltages[terminal]!, {
          real: -referenceShift.real,
          imaginary: -referenceShift.imaginary,
        });
        closePhasor(moved.parts[part.id]!.terminalVoltages[terminal]!, expectedTerminalVoltage);
      }
    }
    closePhasor(moved.parts.ground!.terminalVoltages.a!, { real: 0, imaginary: 0 });
  });

  it("retains millivolt branch drops when the accumulated high-source phasor magnitude overflows", () => {
    expect(Math.hypot(1.4e308, 1.4e308)).toBe(Number.POSITIVE_INFINITY);
    const document: CircuitDocument = {
      title: "合成振幅が表現範囲を超える直列高電位源",
      parts: [
        makePart("high-real", "ac-source", { voltageVolts: 1.4e308, phaseDegrees: 0, frequencyHz: 1000 }),
        makePart("high-imaginary", "ac-source", { voltageVolts: 1.4e308, phaseDegrees: 90, frequencyHz: 1000 }),
        makePart("small", "ac-source", { voltageVolts: 3e-3, phaseDegrees: 90, frequencyHz: 1000 }),
        makePart("r1", "resistor", { resistanceOhms: 1e-3 }),
        makePart("ground", "ground"),
      ],
      wires: [
        wire("ground", "high-real", "b", "ground", "a"),
        wire("high-sources", "high-real", "a", "high-imaginary", "b"),
        wire("high-small", "high-imaginary", "a", "small", "a"),
        wire("chain-start", "high-imaginary", "a", "r1", "a"),
        wire("chain-end", "r1", "b", "small", "b"),
      ],
    };
    const result = assertValid(document);

    closePhasor(result.parts.r1.voltage, { real: 0, imaginary: 3e-3 }, 1e-7, 1e-12);
    closePhasor(result.parts.r1.current, { real: 0, imaginary: 3 }, 1e-7, 1e-9);
    closePhasor(result.parts.small.voltage, { real: 0, imaginary: 3e-3 }, 1e-7, 1e-12);
    closePhasor(result.parts.small.current, { real: 0, imaginary: -3 }, 1e-7, 1e-9);
    closePhasor(result.parts.ground.terminalVoltages.a!, { real: 0, imaginary: 0 });
    closePhasor(result.nodeVoltages["high-real:b"]!, { real: 0, imaginary: 0 });
  });
});
