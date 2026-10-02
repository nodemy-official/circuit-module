// biome-ignore-all lint/suspicious/noMisplacedAssertion: Independent oracle assertions are called by tests.
import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

interface Q { n: bigint; d: bigint }
function q(n: bigint, d = 1n): Q {
  let a = n < 0n ? -n : n;
  let b = d < 0n ? -d : d;
  while (b) { [a, b] = [b, a % b]; }
  const divisor = (a || 1n) * (d < 0n ? -1n : 1n);
  return { n: n / divisor, d: d / divisor };
}
function input(value: number): Q {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const exponent = Number(bits / 2n ** 52n % 2048n);
  const mantissa = bits % 2n ** 52n;
  const signed = (bits / 2n ** 63n ? -1n : 1n) * (exponent ? mantissa + 2n ** 52n : mantissa);
  const shift = exponent ? exponent - 1075 : -1074;
  return shift < 0 ? q(signed, 2n ** BigInt(-shift)) : q(signed * 2n ** BigInt(shift));
}
function add(a: Q, b: Q): Q { return q(a.n * b.d + b.n * a.d, a.d * b.d); }
function neg(a: Q): Q { return { n: -a.n, d: a.d }; }
function mul(a: Q, b: Q): Q { return q(a.n * b.n, a.d * b.d); }
function div(a: Q, b: Q): Q { return q(a.n * b.d, a.d * b.n); }
function sum(values: readonly Q[]): Q { return values.reduce(add, q(0n)); }
function number(value: Q): number { return Number(value.n) / Number(value.d); }
function below(value: Q): boolean { return add(value, neg(input(0.001))).n < 0n; }
const lead = input(1e-6);

function part(id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, label: id, x: 0, y: 0, ...values };
}
function wire(id: string, from: string, to: string): CircuitWire {
  const [fromPart, fromTerminal] = from.split(":");
  const [toPart, toTerminal] = to.split(":");
  return { id, from: { partId: fromPart, terminal: fromTerminal as "a" | "b" }, to: { partId: toPart, terminal: toTerminal as "a" | "b" } };
}

interface Branch {
  id: string;
  from: number;
  to: number;
  emf?: number;
  resistance: number;
  device?: "ammeter" | "switch";
}
function documentFor(branches: readonly Branch[]): CircuitDocument {
  const nodes = [...new Set(branches.flatMap(({ from, to }) => [from, to]))];
  const document: CircuitDocument = { title: "Independent local source-group audit", parts: nodes.map((node) => part(`j${node}`, "junction")), wires: [] };
  for (const branch of branches) {
    document.parts.push(branch.emf === undefined
      ? part(branch.id, "resistor", { resistanceOhms: branch.resistance })
      : part(branch.id, "battery", { voltageVolts: Math.abs(branch.emf), internalResistanceOhms: branch.resistance }));
    const a = `${branch.id}:${(branch.emf ?? 1) > 0 ? "a" : "b"}`;
    const b = `${branch.id}:${(branch.emf ?? 1) > 0 ? "b" : "a"}`;
    if (branch.device) {
      document.parts.push(part(`${branch.id}-device`, branch.device, { initiallyClosed: true }));
      document.wires.push(wire(`${branch.id}-in`, `j${branch.from}:a`, `${branch.id}-device:a`), wire(`${branch.id}-mid`, `${branch.id}-device:b`, a));
    } else { document.wires.push(wire(`${branch.id}-in`, `j${branch.from}:a`, a)); }
    document.wires.push(wire(`${branch.id}-out`, b, `j${branch.to}:a`));
  }
  return document;
}

// Eliminate each untapped wire/device in series, then solve scalar rail KCL
// by independent rational Gauss-Jordan elimination (at most three unknowns).
function railOracle(branches: readonly Branch[]) {
  const size = Math.max(...branches.flatMap(({ from, to }) => [from, to])) + 1;
  const matrix = Array.from({ length: size - 1 }, () => Array.from({ length: size }, () => q(0n)));
  const resistances = branches.map((branch) => add(input(branch.emf === undefined ? branch.resistance : Math.max(branch.resistance, 1e-6)), mul(lead, q(branch.device ? 4n : 2n))));
  for (const [i, branch] of branches.entries()) {
    const conductance = div(q(1n), resistances[i]);
    for (const [node, other, sign] of [[branch.from, branch.to, 1n], [branch.to, branch.from, -1n]] as const) {
      if (node === 0) { continue; }
      const row = matrix[node - 1];
      row[node - 1] = add(row[node - 1], conductance);
      if (other !== 0) { row[other - 1] = add(row[other - 1], neg(conductance)); }
      row[size - 1] = add(row[size - 1], mul(mul(input(branch.emf ?? 0), conductance), q(sign)));
    }
  }
  for (let column = 0; column < size - 1; column += 1) {
    const divisor = matrix[column][column];
    matrix[column] = matrix[column].map((value) => div(value, divisor));
    for (let row = 0; row < size - 1; row += 1) {
      if (row === column) { continue; }
      const factor = matrix[row][column];
      matrix[row] = matrix[row].map((value, index) => add(value, neg(mul(factor, matrix[column][index]))));
    }
  }
  const voltages = [q(0n), ...matrix.map((row) => row[size - 1])];
  return branches.map((branch, index) => div(sum([voltages[branch.from], neg(voltages[branch.to]), input(-(branch.emf ?? 0))]), resistances[index]));
}
function expectQ(actual: number, expected: Q, label: string) {
  if (!expected.n) { expect(actual, label).toBe(0); }
  else { expect(Math.abs(actual / number(expected) - 1), label).toBeLessThan(3e-14); }
}
function verify(branches: readonly Branch[], document: CircuitDocument, sign = 1) {
  const analysis = analyzeCircuit(document);
  const currents = railOracle(branches);
  for (const [index, branch] of branches.entries()) {
    const current = mul(currents[index], input(branch.emf === undefined ? sign : Math.sign(branch.emf)));
    const voltage = branch.emf === undefined ? mul(input(branch.resistance), current)
      : add(input(Math.abs(branch.emf)), mul(input(Math.max(branch.resistance, 1e-6)), current));
    const power = mul(voltage, branch.emf === undefined ? current : neg(current));
    const actual = analysis.parts[branch.id];
    expectQ(actual.currentAmps, current, `${branch.id}:I`);
    expectQ(actual.voltageVolts, voltage, `${branch.id}:V`);
    expectQ(actual.powerWatts, power, `${branch.id}:P`);
    if (branch.device) {
      const deviceCurrent = mul(currents[index], input(sign));
      expectQ(analysis.parts[`${branch.id}-device`].currentAmps, deviceCurrent, `${branch.id}:device I`);
      expectQ(analysis.parts[`${branch.id}-device`].voltageVolts, mul(deviceCurrent, lead), `${branch.id}:device V`);
      expectQ(analysis.parts[`${branch.id}-device`].powerWatts, mul(mul(deviceCurrent, deviceCurrent), lead), `${branch.id}:device P`);
    }
    const inWire = document.wires.find((connection) => connection.id === `${branch.id}-in`)!;
    const outWire = document.wires.find((connection) => connection.id === `${branch.id}-out`)!;
    const inSign = inWire.from.partId === `j${branch.from}` ? sign : -sign;
    const outSign = outWire.to.partId === `j${branch.to}` ? sign : -sign;
    expectQ(analysis.wireCurrents[inWire.id], mul(currents[index], input(inSign)), `${branch.id}:wire in`);
    expectQ(analysis.wireCurrents[outWire.id], mul(currents[index], input(outSign)), `${branch.id}:wire out`);
    if (branch.device) {
      const midWire = document.wires.find((connection) => connection.id === `${branch.id}-mid`)!;
      const midSign = midWire.from.partId === `${branch.id}-device` ? sign : -sign;
      expectQ(analysis.wireCurrents[midWire.id], mul(currents[index], input(midSign)), `${branch.id}:wire mid`);
    }
  }
  return analysis;
}
function variants(document: CircuitDocument) {
  const batteryIds = new Set(document.parts.filter((item) => item.kind === "battery").map((item) => item.id));
  const reverse = (endpoint: CircuitWire["from"]): CircuitWire["from"] => batteryIds.has(endpoint.partId)
    ? { ...endpoint, terminal: endpoint.terminal === "a" ? "b" : "a" } : endpoint;
  return [
    { document, sign: 1 },
    { document: { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }, sign: 1 },
    { document: { ...document, wires: document.wires.map((connection) => ({ ...connection, from: connection.to, to: connection.from })) }, sign: 1 },
    { document: { ...document, wires: document.wires.map((connection) => ({ ...connection, from: reverse(connection.from), to: reverse(connection.to) })) }, sign: -1 },
  ];
}

describe("independent low-voltage parallel group load audit", () => {
  it.each([2, 5, 16].flatMap((count) => [0.000_996, 0.000_996_5, 0.000_997, 0.000_997_5, 0.000_998, 0.001].map((resistance) => ({ count, resistance }))))(
    "retains the joint local drive: count=$count R=$resistance", ({ count, resistance }) => {
      const local: Branch[] = [
        ...Array.from({ length: count }, (_, index) => ({ id: `s${index}`, from: 1, to: 0, emf: 1, resistance: 0.1 })),
        { id: "load", from: 1, to: 0, resistance },
      ];
      // Parallel cells share their 2-uohm leads. A source path with the same
      // net EMF adds no passive resistance to this existing local drive.
      const external = sum([input(resistance), mul(lead, q(2n)), div(mul(lead, q(2n)), q(BigInt(count)))]);
      const equivalent = [...local, { id: "high", from: 1, to: 2, emf: 3, resistance: 0.1 }, { id: "charging", from: 0, to: 2, emf: 2, resistance: 0.1 }];
      for (const branches of [local, equivalent]) {
        const jointLeadG = add(div(q(BigInt(count)), mul(lead, q(2n))), branches === equivalent ? div(q(1n), mul(lead, q(4n))) : q(0n));
        const jointExternal = sum([input(resistance), mul(lead, q(2n)), div(q(1n), jointLeadG)]);
        const expected = below(jointExternal) ? "short" : "closed";
        for (const { document, sign } of variants(documentFor(branches))) {
          const analysis = verify(branches, document, sign);
          expect.soft(analysis.status, `${branches.length} branches; baseline external=${number(external)}; joint external=${number(jointExternal)}; ${analysis.message}`).toBe(expected);
        }
      }
    },
  );
});

describe("all distributions of loads in a consistent source triangle", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask).flatMap((mask) =>
    [0.000_990, 0.01].flatMap((resistance) => [false, true].map((weak) => ({ mask, resistance, weak }))),
  ))("checks all local loads: mask=$mask R=$resistance weak=$weak", ({ mask, resistance, weak }) => {
    const branches: Branch[] = [
      { id: "local", from: 1, to: 0, emf: 1, resistance: 0.1 },
      { id: "high", from: 1, to: 2, emf: 3, resistance: 0.1 },
      { id: "charging", from: 0, to: 2, emf: 2, resistance: 0.1 },
    ];
    for (const [index, [from, to]] of [[1, 0], [0, 2], [1, 2]].entries()) {
      if (Math.floor(mask / 2 ** index) % 2) { branches.push({ id: `load${index}`, from, to, resistance }); }
      if (weak) { branches.push({ id: `weak${index}`, from, to, resistance: 1000 }); }
    }
    for (const { document, sign } of variants(documentFor(branches))) {
      const analysis = verify(branches, document, sign);
      expect(analysis.status, analysis.message).toBe(mask !== 0 && resistance < 0.001 ? "short" : "closed");
    }
  });
});

describe("source cycles, zero current, charging and conductor loss", () => {
  it.each([false, true].flatMap((balanced) => [0.000_99, 0.001_01].flatMap((resistance) =>
    [undefined, "ammeter", "switch"].map((device) => ({ balanced, resistance, device })),
  )))("checks a protected source cycle: balanced=$balanced R=$resistance device=$device", ({ balanced, resistance, device }) => {
    const branches: Branch[] = [
      { id: "first", from: 1, to: 0, emf: 1, resistance: 0.1 },
      { id: "second", from: 2, to: 1, emf: balanced ? -1 : 2, resistance: 0.2 },
      { id: "return", from: 2, to: 0, resistance, device: device as "ammeter" | "switch" | undefined },
    ];
    const external = add(input(resistance), mul(lead, q(device ? 8n : 6n)));
    for (const { document, sign } of variants(documentFor(branches))) {
      const analysis = verify(branches, document, sign);
      expect(analysis.status, analysis.message).toBe(!balanced && below(external) ? "short" : "closed");
    }
  });

  it.each([1, 2, 3])("does not stop checking other sources when cell %s carries zero current", (middleEmf) => {
    const branches: Branch[] = [
      { id: "zero", from: 1, to: 0, emf: middleEmf, resistance: 0.1 },
      { id: "weak", from: 1, to: 0, emf: middleEmf - 0.5, resistance: 0.1 },
      { id: "strong", from: 1, to: 0, emf: middleEmf + 0.5, resistance: 0.1 },
    ];
    for (const { document, sign } of variants(documentFor(branches))) {
      const analysis = verify(branches, document, sign);
      expect(analysis.parts.zero.currentAmps).toBe(0);
      expect(analysis.parts.zero.voltageVolts).toBe(middleEmf);
      expect(analysis.parts.weak.currentAmps).toBeGreaterThan(0);
      expect(analysis.parts.weak.powerWatts).toBeLessThan(0);
      expect(analysis.status, analysis.message).toBe("short");
    }
  });
});

describe("large equal-EMF source group and open-source invariance", () => {
  it.each([32, 64].flatMap((count) => [0.000_995, 0.001_01].map((resistance) => ({ count, resistance }))))(
    "checks $count equal sources with R=$resistance", ({ count, resistance }) => {
      const branches: Branch[] = [
        ...Array.from({ length: count }, (_, index) => ({ id: `s${index}`, from: 1, to: 0, emf: 1, resistance: 0.1 })),
        { id: "load", from: 1, to: 0, resistance },
      ];
      const external = sum([input(resistance), mul(lead, q(2n)), div(mul(lead, q(2n)), q(BigInt(count)))]);
      for (const { document, sign } of variants(documentFor(branches))) {
        const analysis = verify(branches, document, sign);
        expect(analysis.status, analysis.message).toBe(below(external) ? "short" : "closed");
      }
    },
  );
});

function minimalParallelTriangle(): CircuitDocument {
  return {
    title: "Two equal low cells retain their shared passive short",
    parts: [
      part("a", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
      part("b", "battery", { voltageVolts: 1, internalResistanceOhms: 0.1 }),
      part("high", "battery", { voltageVolts: 3, internalResistanceOhms: 0.1 }),
      part("charging", "battery", { voltageVolts: 2, internalResistanceOhms: 0.1 }),
      part("load", "resistor", { resistanceOhms: 0.000_998_5 }),
    ],
    wires: [
      wire("ap", "a:a", "load:a"), wire("an", "a:b", "load:b"),
      wire("bp", "b:a", "load:a"), wire("bn", "b:b", "load:b"),
      wire("hp", "high:a", "load:a"), wire("hc", "high:b", "charging:b"),
      wire("cn", "charging:a", "load:b"),
    ],
  };
}

function verifyMinimal(document: CircuitDocument, sign: number, weak: boolean) {
  const sourceR = add(input(0.1), mul(lead, q(2n)));
  const otherR = add(mul(input(0.1), q(2n)), mul(lead, q(3n)));
  const totalG = add(div(q(2n), sourceR), div(q(1n), otherR));
  const sourceEquivalent = div(q(1n), totalG);
  const weakResistance = add(input(1000), mul(lead, q(2n)));
  const loadConductance = add(div(q(1n), input(0.000_998_5)), weak ? div(q(1n), weakResistance) : q(0n));
  const loadResistance = div(q(1n), loadConductance);
  const totalCurrent = div(q(1n), add(loadResistance, sourceEquivalent));
  const deficit = mul(totalCurrent, sourceEquivalent);
  const localCurrent = neg(div(deficit, sourceR));
  const highCurrent = neg(div(deficit, otherR));
  const analysis = analyzeCircuit(document);
  for (const [id, emf, current] of [["a", 1, localCurrent], ["b", 1, localCurrent], ["high", 3, highCurrent], ["charging", 2, neg(highCurrent)]] as const) {
    const voltage = add(input(emf), mul(input(0.1), current));
    expectQ(analysis.parts[id].currentAmps, current, `${id}:I`);
    expectQ(analysis.parts[id].voltageVolts, voltage, `${id}:V`);
    expectQ(analysis.parts[id].powerWatts, mul(voltage, neg(current)), `${id}:P`);
  }
  const loadVoltage = mul(mul(totalCurrent, loadResistance), input(sign));
  const loadCurrent = div(loadVoltage, input(0.000_998_5));
  expectQ(analysis.parts.load.currentAmps, loadCurrent, "load:I");
  expectQ(analysis.parts.load.voltageVolts, loadVoltage, "load:V");
  expectQ(analysis.parts.load.powerWatts, mul(loadVoltage, loadCurrent), "load:P");
  if (weak) {
    const weakCurrent = div(loadVoltage, weakResistance);
    const weakVoltage = mul(weakCurrent, input(1000));
    expectQ(analysis.parts.weak.currentAmps, weakCurrent, "weak:I");
    expectQ(analysis.parts.weak.voltageVolts, weakVoltage, "weak:V");
    expectQ(analysis.parts.weak.powerWatts, mul(weakVoltage, weakCurrent), "weak:P");
  }
  for (const id of ["open", "open-meter", "open-stop"]) {
    if (analysis.parts[id]) {
      expect(analysis.parts[id].currentAmps).toBe(0);
      expect(analysis.parts[id].powerWatts).toBe(0);
    }
  }
  if (analysis.parts.open) {
    expect(analysis.parts.open.voltageVolts).toBe(1e20);
    expect(analysis.parts["open-meter"].voltageVolts).toBe(0);
  }
  return analysis;
}

describe("minimal shared local short regression", () => {
  it.each([false, true].flatMap((open) => [false, true].map((weak) => ({ open, weak }))))("retains the two-cell short after an equivalent path is added (open=$open weak=$weak)", ({ open, weak }) => {
    let document = minimalParallelTriangle();
    const baseline = {
      ...document, parts: document.parts.filter((item) => item.id !== "high" && item.id !== "charging"),
      wires: document.wires.filter((connection) => !["hp", "hc", "cn"].includes(connection.id)),
    };
    const sharedExternal = add(input(0.000_998_5), lead);
    const individualExternal = add(input(0.000_998_5), mul(lead, q(2n)));
    expect(below(sharedExternal)).toBe(true);
    expect(below(individualExternal)).toBe(false);
    expect(analyzeCircuit(baseline).status).toBe("short");
    if (weak) {
      document = {
        ...document,
        parts: [...document.parts, part("weak", "resistor", { resistanceOhms: 1000 })],
        wires: [...document.wires, wire("weak1", "load:a", "weak:a"), wire("weak2", "load:b", "weak:b")],
      };
    }
    if (open) {
      document = {
        ...document,
        parts: [...document.parts, part("open", "battery", { voltageVolts: 1e20, internalResistanceOhms: 0.3 }), part("open-meter", "ammeter"), part("open-stop", "switch", { initiallyClosed: false })],
        wires: [...document.wires, wire("open1", "load:a", "open:b"), wire("open2", "open:a", "open-meter:b"), wire("open3", "open-meter:a", "open-stop:a")],
      };
    }
    for (const { document: variant, sign } of variants(document)) {
      const analysis = verifyMinimal(variant, sign, weak);
      const readings = Object.fromEntries(["a", "b", "high", "charging", "load"].map((id) => [id, {
        voltage: analysis.parts[id].voltageVolts, current: analysis.parts[id].currentAmps, power: analysis.parts[id].powerWatts,
      }]));
      expect.soft(analysis.status, `shared R=${number(sharedExternal)}; individual R=${number(individualExternal)}; readings=${JSON.stringify(readings)}; ${analysis.message}`).toBe("short");
    }
  });
});
