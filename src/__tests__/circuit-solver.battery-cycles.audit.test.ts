import { expect, it } from "vitest";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";

function batteryBranchDocument(branches: readonly (readonly [string, string, string, number, number])[]): CircuitDocument {
  const nodes = new Set(branches.flatMap(([, from, to]) => [from, to]));
  return {
    title: "Grouped battery return network",
    parts: [
      ...[...nodes].map((id) => ({ id, kind: "junction" as const, label: id, x: 0, y: 0 })),
      ...branches.flatMap(([id, , , voltageVolts, resistanceOhms]) => [
        { id, kind: "battery" as const, label: id, x: 0, y: 0, voltageVolts, internalResistanceOhms: 0.1 },
        { id: `r${id}`, kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms },
      ]),
    ],
    wires: branches.flatMap(([id, from, to]) => [
      { id: `${id}1`, from: { partId: from, terminal: "a" as const }, to: { partId: `r${id}`, terminal: "a" as const } },
      { id: `${id}2`, from: { partId: `r${id}`, terminal: "b" as const }, to: { partId: id, terminal: "a" as const } },
      { id: `${id}3`, from: { partId: id, terminal: "b" as const }, to: { partId: to, terminal: "a" as const } },
    ]),
  };
}

function addWeakLoad(document: CircuitDocument, from: string, to: string) {
  const id = `bleed${from}${to}`;
  document.parts.push({ id, kind: "resistor", label: "Weak load", x: 0, y: 0, resistanceOhms: 1000 });
  document.wires.push(
    { id: `${id}a`, from: { partId: from, terminal: "a" }, to: { partId: id, terminal: "a" } },
    { id: `${id}b`, from: { partId: to, terminal: "a" }, to: { partId: id, terminal: "b" } },
  );
}

it.each([[2, "closed"], [2 + 2 ** -40, "short"]] as const)(
  "keeps the EMF of other source groups when weak loads join a %s-V triangle", (voltage, expected) => {
    const document = batteryBranchDocument([
      ["ab", "A", "B", 1, 0.000_01], ["ac", "A", "C", voltage, 0.000_01], ["bc", "B", "C", 1, 0.000_01],
    ]);
    addWeakLoad(document, "A", "B");
    addWeakLoad(document, "A", "C");
    const detached = { ...document, parts: [...document.parts, { id: "detached", kind: "resistor" as const, label: "Open", x: 0, y: 0, resistanceOhms: 1 }] };
    for (const variant of [document, detached, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
      const result = analyzeCircuit(variant);
      expect(result.status, result.message).toBe(expected);
      if (voltage === 2) {
        // Independent two-node rational KCL with r=.100013 and L=1000.000002.
        for (const [id, current] of [["ab", -0.001_333_188_882_262_195], ["ac", -0.001_666_511_102_743_804_9], ["bc", -0.000_333_322_220_481_609_9]] as const) {
          expect(result.parts[id]!.currentAmps / current).toBeCloseTo(1, 14);
        }
      }
    }
  });

it.each([[1, "closed"], [1 + 2 ** -40, "short"], [2, "short"]] as const)(
  "retains parallel return groups after a weak load joins every source terminal (%s V)", (returnVoltage, expected) => {
    const document = batteryBranchDocument([
      ["s0", "A", "B", 1, 0.0001],
      ["s1", "A", "B", returnVoltage, 0.0015], ["s2", "A", "B", returnVoltage, 0.0015],
    ]);
    addWeakLoad(document, "A", "B");
    const reversed = { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() };
    const reversePolarity = { ...document, wires: document.wires.map((wire) => ({ ...wire,
      from: document.parts.some((part) => part.id === wire.from.partId && part.kind === "battery") ? { ...wire.from, terminal: wire.from.terminal === "a" ? "b" as const : "a" as const } : wire.from,
      to: document.parts.some((part) => part.id === wire.to.partId && part.kind === "battery") ? { ...wire.to, terminal: wire.to.terminal === "a" ? "b" as const : "a" as const } : wire.to,
    })) };
    for (const variant of [document, reversed, reversePolarity]) {
      const result = analyzeCircuit(variant);
      expect(result.status, result.message).toBe(expected);
      // Independent KCL at A, including each cell's internal resistance.
      const firstR = 0.100_103;
      const returnR = 0.101_503;
      const loadR = 1000.000_002;
      const voltage = (1 / firstR + 2 * returnVoltage / returnR) / (1 / firstR + 2 / returnR + 1 / loadR);
      const current = (voltage - 1) / firstR;
      if (returnVoltage === 2) {
        expect(Math.abs(result.parts.s0!.currentAmps) / current).toBeCloseTo(1, 14);
      }
    }
  });

it("retains a shorted diamond return after weak loads join all intermediate components", () => {
  const branches: [string, string, string, number, number][] = [["s0", "A", "B", 1, 0.0001]];
  for (const node of ["C", "D"]) {
    for (const duplicate of [0, 1]) {
      branches.push([`a${node}${duplicate}`, "A", node, 2, 0.0012], [`b${node}${duplicate}`, node, "B", 2, 0.0012]);
    }
  }
  const document = batteryBranchDocument(branches);
  for (const to of ["B", "C", "D"]) { addWeakLoad(document, "A", to); }
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const result = analyzeCircuit(variant);
    expect(result.status, result.message).toBe("short");
    // Independent rational nodal calculation, with all three weak loads.
    expect(result.parts.s0!.currentAmps / 19.904_998_594_150_445).toBeCloseTo(1, 14);
  }
});

it.each([[0.001_791_000_5, "short"], [0.001_791_003, "closed"]] as const)(
  "includes weak intermediate loads in a diamond return near the short threshold (%s ohms)", (resistance, expected) => {
    const branches: [string, string, string, number, number][] = [["s0", "A", "B", 1, 0.0001]];
    for (const node of ["C", "D"]) {
      for (const duplicate of [0, 1]) {
        branches.push([`a${node}${duplicate}`, "A", node, 2, resistance], [`b${node}${duplicate}`, node, "B", 2, resistance]);
      }
    }
    const document = batteryBranchDocument(branches);
    for (const to of ["B", "C", "D"]) { addWeakLoad(document, "A", to); }
    const stage = (resistance + 3e-6) / 2;
    const load = 1000.000_002;
    // Two identical return routes; each upper stage is shunted by its
    // weak load. A third weak load crosses the entire return network.
    const returned = 1 / (1 / load + 2 / (stage + 1 / (1 / stage + 1 / load)));
    expect(0.000_103 + returned < 0.001).toBe(expected === "short");
    expect(analyzeCircuit(document).status).toBe(expected);
    expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }).status).toBe(expected);
  });

it.each([[0.001_791_000_5, "short"], [0.001_791_002, "closed"]] as const)(
  "includes a weak parallel load on both sides of the short threshold (%s ohms)", (resistance, expected) => {
    const document = batteryBranchDocument([
      ["s0", "A", "B", 1, 0.0001],
      ["s1", "A", "B", 2, resistance], ["s2", "A", "B", 2, resistance],
    ]);
    addWeakLoad(document, "A", "B");
    const external = 0.000_103 + 1 / (2 / (resistance + 3e-6) + 1 / 1000.000_002);
    expect(external < 0.001).toBe(expected === "short");
    expect(analyzeCircuit(document).status).toBe(expected);
  });

it.each([[0.0012, "short"], [0.001_790_999_999_9, "short"], [0.001_791_000_000_1, "closed"], [0.0018, "closed"]] as const)(
  "combines equal-EMF return routes through separate intermediate nodes (%s ohms)", (resistance, expected) => {
  const branches: [string, string, string, number, number][] = [["s0", "A", "B", 1, 0.0001]];
  for (const [position, node] of ["C", "D"].entries()) {
    for (const duplicate of [0, 1]) {
      branches.push([`s${1 + 4 * position + duplicate}`, "A", node, 2, resistance],
        [`s${3 + 4 * position + duplicate}`, node, "B", 2, resistance]);
    }
  }
  const document = batteryBranchDocument(branches);
  const external = 0.000_103 + (resistance + 3e-6) / 2;
  expect(external < 0.001).toBe(expected === "short");
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  expect(result.parts.s0!.currentAmps / (3 / (0.15 + external))).toBeCloseTo(1, 14);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe(expected);
});

it.each([false, true])("handles a dense inconsistent source network without enumerating every simple cycle (dangling=%s)", (dangling) => {
  const branches: [string, string, string, number, number][] = [];
  for (let from = 1; from < 9; from += 1) {
    for (let to = 0; to < from; to += 1) {
      branches.push([`s${from}_${to}`, `N${from}`, `N${to}`, from === 2 && to === 0 ? 2.25 : from - to, 0.01]);
    }
  }
  branches.push(["duplicate", "N1", "N0", 1, 0.01]);
  const document = batteryBranchDocument(branches);
  if (dangling) {
    for (const [id] of branches) {
      document.parts.push({ id: `dang${id}`, kind: "resistor", label: "Open stub", x: 0, y: 0, resistanceOhms: 1000 });
      document.wires.push({ id: `dang${id}`, from: { partId: id, terminal: "a" }, to: { partId: `dang${id}`, terminal: "a" } });
    }
  }
  const result = analyzeCircuit(document);
  // Every driven cycle includes the 2.25-V branch, with external R>0.01.
  expect(result.status, result.message).toBe("closed");
  expect(result.parts.s2_0!.currentAmps / -1.790_584_774_685_208_2).toBeCloseTo(1, 14);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }).status).toBe("closed");
});

it("prunes a dense low-resistance zero-EMF core with a resistive driving inconsistency", () => {
  const count = 15;
  const branches: [string, string, string, number, number][] = [];
  for (let from = 1; from < count; from += 1) {
    for (let to = 0; to < from; to += 1) {
      const inconsistent = from === 2 && to === 0;
      branches.push([`s${from}_${to}`, `N${from}`, `N${to}`, inconsistent ? 2.25 : from - to, inconsistent ? 0.01 : 0.0001]);
    }
  }
  branches.push(["duplicate", "N1", "N0", 1, 0.0001]);
  const result = analyzeCircuit(batteryBranchDocument(branches));
  expect(result.status, result.message).toBe("closed");
  // Independent rank-one updates of the complete-graph Laplacian: remove
  // the 2-0 branch, add a second 1-0 branch, then restore the driven branch.
  const ratio = (2 * count * count - 6 - count) / ((count - 2) * (count * count - 3));
  const expected = -0.25 / (0.110_003 + 0.100_103 * ratio);
  expect(result.parts.s2_0!.currentAmps / expected).toBeCloseTo(1, 14);
});

it.each([false, true])("retains a shorted return network after adding an inconsistent transverse source (parallel=%s)", (parallel) => {
  const branches: [string, string, string, number, number][] = [["s0", "A", "B", 1, 0.0001]];
  for (const node of ["C", "D"]) {
    for (let duplicate = 0; duplicate < (parallel ? 2 : 1); duplicate += 1) {
      branches.push([`a${node}${duplicate}`, "A", node, 2, parallel ? 0.0012 : 0.0008],
        [`b${node}${duplicate}`, node, "B", 2, parallel ? 0.0012 : 0.0008]);
    }
  }
  branches.push(["cross", "C", "D", 1, 0.0001]);
  const document = batteryBranchDocument(branches);
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe("short");
  const external = 0.000_103 + (parallel ? (0.0012 + 3e-6) / 2 : 0.0008 + 3e-6);
  // Symmetric transverse circulation leaves the AB current unchanged.
  const internal = parallel ? 0.15 : 0.2;
  expect(result.parts.s0!.currentAmps / (3 / (internal + external))).toBeCloseTo(1, 14);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }).status).toBe("short");
});

it("preserves two three-stage return routes despite inconsistent transverse sources and part reordering", () => {
  const branches = [
    ["s0", "A", "B", 1, 0.0001],
    ["s1", "A", "C", 2, 0.0005], ["s2", "C", "E", 2, 0.0005], ["s3", "E", "B", 2, 0.0005],
    ["s4", "A", "D", 2, 0.0005], ["s5", "D", "F", 2, 0.0005], ["s6", "F", "B", 2, 0.0005],
    ["s7", "C", "F", 1, 0.0001], ["s8", "D", "E", 1, 0.0001],
  ] as const;
  const document = batteryBranchDocument(branches);
  const variants = [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }];
  const swapped = [...document.parts];
  const first = swapped.findIndex((part) => part.id === "A");
  const second = swapped.findIndex((part) => part.id === "s5");
  [swapped[first], swapped[second]] = [swapped[second]!, swapped[first]!];
  variants.push({ ...document, parts: swapped });
  // The two 6-V return routes have external R=3*503/2 uOhm;
  // the AB lead adds 103uOhm. A separate rational nodal oracle gives
  // I_AB=1805054000000/90546186281 A including transverse circulation.
  for (const variant of variants) {
    const result = analyzeCircuit(variant);
    expect(result.status, result.message).toBe("short");
    expect(result.parts.s0!.currentAmps / (1_805_054_000_000 / 90_546_186_281)).toBeCloseTo(1, 14);
  }
});

it.each([[0.000_496, "short"], [0.0005, "closed"]] as const)(
  "combines a bridged return network without direct parallel battery edges (%s ohms)", (resistance, expected) => {
  const branches = [
    ["s0", "A", "B", 1, resistance],
    ["s1", "A", "C", 2, resistance], ["s2", "C", "B", 2, resistance],
    ["s3", "A", "D", 1, resistance], ["s4", "D", "B", 3, resistance],
    ["s5", "D", "C", 1, resistance],
  ] as const;
  const document = batteryBranchDocument(branches);
  const result = analyzeCircuit(document);
  // The 4-V return graph is a balanced Wheatstone bridge: the middle
  // branch carries no circulation, and two 2r paths combine to r.
  const external = 2 * (resistance + 3e-6);
  expect(external < 0.001).toBe(expected === "short");
  expect(result.status, result.message).toBe(expected);
  expect(result.parts.s0!.currentAmps / (3 / (0.2 + external))).toBeCloseTo(1, 14);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }).status).toBe(expected);
});

it.each([[0.0011, "short"], [0.001_687_999_999_9, "short"], [0.001_688_000_000_1, "closed"], [0.0017, "closed"]] as const)(
  "combines parallel return groups through an intermediate source component (%s ohms)", (returnResistance, expected) => {
  const branches = [
    ["s0", "A", "B", 1, 0.0001],
    ["s1", "A", "C", 3, returnResistance], ["s2", "A", "C", 3, returnResistance],
    ["s3", "C", "B", 1, 0.0001], ["s4", "C", "B", 1, 0.0001],
  ] as const;
  const document: CircuitDocument = {
    title: "Two parallel return groups in series",
    parts: [
      ...["A", "B", "C"].map((id) => ({ id, kind: "junction" as const, label: id, x: 0, y: 0 })),
      ...branches.flatMap(([id, , , voltageVolts, resistanceOhms]) => [
        { id, kind: "battery" as const, label: id, x: 0, y: 0, voltageVolts, internalResistanceOhms: 0.1 },
        { id: `r${id}`, kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms },
      ]),
    ],
    wires: branches.flatMap(([id, from, to]) => [
      { id: `${id}1`, from: { partId: from, terminal: "a" as const }, to: { partId: `r${id}`, terminal: "a" as const } },
      { id: `${id}2`, from: { partId: `r${id}`, terminal: "b" as const }, to: { partId: id, terminal: "a" as const } },
      { id: `${id}3`, from: { partId: id, terminal: "b" as const }, to: { partId: to, terminal: "a" as const } },
    ]),
  };
  const external = 0.000_103 + (returnResistance + 3e-6) / 2 + 0.000_103 / 2;
  expect(external < 0.001).toBe(expected === "short");
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  const current = 3 / (0.2 + external);
  expect(result.parts.s0!.currentAmps / current).toBeCloseTo(1, 14);
  for (const id of ["s1", "s2", "s3", "s4"]) {
    expect(result.parts[id]!.currentAmps / (-current / 2)).toBeCloseTo(1, 14);
  }
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe(expected);
});

function weakSeriesDocument(resistanceOhms: number, secondVoltage = 1, reverseSecond = false): CircuitDocument {
  const document: CircuitDocument = {
    title: "Series batteries with a weak intermediate shunt",
    parts: [
      { id: "s1", kind: "battery", label: "S1", x: 0, y: 0, voltageVolts: 1, internalResistanceOhms: 0.1 },
      { id: "s2", kind: "battery", label: "S2", x: 0, y: 0, voltageVolts: secondVoltage, internalResistanceOhms: 0.1 },
      { id: "load", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms },
      { id: "bleed", kind: "resistor", label: "B", x: 0, y: 0, resistanceOhms: 1000 },
    ],
    wires: [
      { id: "w1", from: { partId: "s1", terminal: "b" }, to: { partId: "s2", terminal: reverseSecond ? "b" : "a" } },
      { id: "w2", from: { partId: "s1", terminal: "a" }, to: { partId: "load", terminal: "a" } },
      { id: "w3", from: { partId: "s2", terminal: reverseSecond ? "a" : "b" }, to: { partId: "load", terminal: "b" } },
      { id: "w4", from: { partId: "s1", terminal: "a" }, to: { partId: "bleed", terminal: "a" } },
      { id: "w5", from: { partId: "s1", terminal: "b" }, to: { partId: "bleed", terminal: "b" } },
    ],
  };
  return document;
}

it.each([[0.000_996_9, "short"], [0.000_997_5, "closed"]] as const)("retains series conductors when a high-resistance branch connects an intermediate terminal (%s ohms)", (resistanceOhms, expected) => {
  const document = weakSeriesDocument(resistanceOhms);
  // Unit group drive gives 0.5V per battery. The two passive loops share
  // only their ideal source, so their dissipated powers add independently.
  const external = 1 / (1 / (resistanceOhms + 3e-6) + 0.25 / (1000 + 2e-6));
  expect(external < 0.001).toBe(expected === "short");
  expect(analyzeCircuit(document).status).toBe(expected);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe(expected);
});

it.each([[1, "closed"], [1 + 2 ** -40, "short"], [2, "short"], [3, "short"]] as const)(
  "detects a low-resistance driven loop with opposing %s-V sources despite a weak intermediate shunt", (secondVoltage, expected) => {
  const document = weakSeriesDocument(0.0005, secondVoltage, true);
  // The directed loop has external R=0.000503 ohm. Its driving EMF is
  // 1-secondVoltage, so only exact equality makes this an undriven loop.
  expect(analyzeCircuit(document).status).toBe(expected);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe(expected);
});

it.each([[0.0015, "short"], [0.0022, "closed"]] as const)("retains parallel-group short detection inside a branched source block (%s ohms)", (returnResistance, expected) => {
  const branches = [
    ["s0", "A", "B", 1, 0.0001],
    ["s1", "A", "B", 2, returnResistance],
    ["s2", "A", "B", 2, returnResistance],
    ["s3", "A", "C", 4, 1],
    ["s4", "B", "C", 3, 1],
    ["s5", "B", "C", 3, 1],
  ] as const;
  const document: CircuitDocument = {
    title: "Parallel groups inside a three-node source block",
    parts: [
      ...["A", "B", "C"].map((id) => ({ id, kind: "junction" as const, label: id, x: 0, y: 0 })),
      ...branches.flatMap(([id, , , voltageVolts, resistanceOhms]) => [
        { id, kind: "battery" as const, label: id, x: 0, y: 0, voltageVolts, internalResistanceOhms: 0.1 },
        { id: `r${id}`, kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms },
      ]),
    ],
    wires: branches.flatMap(([id, from, to]) => [
      { id: `${id}1`, from: { partId: from, terminal: "a" as const }, to: { partId: `r${id}`, terminal: "a" as const } },
      { id: `${id}2`, from: { partId: `r${id}`, terminal: "b" as const }, to: { partId: id, terminal: "a" as const } },
      { id: `${id}3`, from: { partId: id, terminal: "b" as const }, to: { partId: to, terminal: "a" as const } },
    ]),
  };
  // The AB subloop has external resistance 103+(returnResistance*1e6+3)/2 uOhm.
  expect(0.000_103 + (returnResistance + 3e-6) / 2 < 0.001).toBe(expected === "short");
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  if (returnResistance === 0.0015) {
    // Independent three-node rational MNA also satisfies KCL and power balance.
    const currents = [6.496_311_372_479_584_5, -3.445_215_832_839_187_5, -3.445_215_832_839_187_5,
      0.394_120_293_198_790_66, -0.197_060_146_599_395_3, -0.197_060_146_599_395_3];
    for (const [index, current] of currents.entries()) {
      expect(result.parts[`s${index}`]!.currentAmps / current).toBeCloseTo(1, 14);
    }
  }
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe(expected);
});

function seriesParallelDocument(counts: number[], returnResistance: number): CircuitDocument {
  return {
    title: "Parallel paths containing series batteries",
    parts: [
      ...counts.flatMap((count, branch) => Array.from({ length: count }, (_, index) => ({
        id: `s${branch}_${index}`, kind: "battery" as const, label: "S", x: 0, y: 0, voltageVolts: (branch === 0 ? 1 : 2) / count, internalResistanceOhms: 0.1 / count,
      }))),
      ...counts.map((_, index) => ({
        id: `r${index}`, kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms: index === 0 ? 0.0001 : returnResistance,
      })),
      { id: "p", kind: "junction", label: "P", x: 0, y: 0 },
      { id: "n", kind: "junction", label: "N", x: 0, y: 0 },
    ],
    wires: counts.flatMap((count, branch) => [
      { id: `pr${branch}`, from: { partId: "p", terminal: "a" as const }, to: { partId: `r${branch}`, terminal: "b" as const } },
      { id: `rs${branch}`, from: { partId: `r${branch}`, terminal: "a" as const }, to: { partId: `s${branch}_0`, terminal: "a" as const } },
      ...Array.from({ length: count - 1 }, (_, index) => ({
        id: `ss${branch}_${index}`, from: { partId: `s${branch}_${index}`, terminal: "b" as const }, to: { partId: `s${branch}_${index + 1}`, terminal: "a" as const },
      })),
      { id: `sn${branch}`, from: { partId: `s${branch}_${count - 1}`, terminal: "b" as const }, to: { partId: "n", terminal: "a" as const } },
    ]),
  };
}

it.each([[0.001_790_000_5, "short"], [0.001_790_002, "closed"]] as const)(
  "retains weak-load threshold effects when each parallel return has two series cells (%s ohms)", (resistance, expected) => {
    const document = seriesParallelDocument([1, 2, 2], resistance);
    addWeakLoad(document, "p", "n");
    const external = 0.000_103 + 1 / (2 / (resistance + 4e-6) + 1 / 1000.000_002);
    expect(external < 0.001).toBe(expected === "short");
    for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
      const result = analyzeCircuit(variant);
      expect(result.status, result.message).toBe(expected);
      if (expected === "short") {
        // Separate rational node equations including both series cells.
        expect(result.parts.s0_0!.currentAmps / 6.621_956_045_428_459).toBeCloseTo(1, 14);
      }
    }
  });

it.each([
  [0.0015, "short"], [0.001_79, "short"], [0.0022, "closed"],
] as const)("combines parallel series-source branches with %s-ohm return resistance", (returnResistance, expected) => {
  const document = seriesParallelDocument([1, 2, 2], returnResistance);
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  const externalResistance = 0.0001 + 3e-6 + (returnResistance + 4e-6) / 2;
  const expectedCurrent = 1 / (0.1 + 0.05 + externalResistance);
  expect(result.parts.s0_0!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
  // At 0.00179, the exact binary64-input sum is 255/2^72 below the
  // binary64 threshold, although both displayed values round to 0.001.
  const reversed = { ...document, wires: document.wires.map((wire) => ({
    ...wire,
    from: wire.from.partId.startsWith("s") ? { ...wire.from, terminal: wire.from.terminal === "a" ? "b" as const : "a" as const } : wire.from,
    to: wire.to.partId.startsWith("s") ? { ...wire.to, terminal: wire.to.terminal === "a" ? "b" as const : "a" as const } : wire.to,
  })) };
  expect(analyzeCircuit(reversed).status).toBe(expected);
});

it.each([
  [0.001_789_000_557_3, "short"],
  [0.001_789_000_557_5, "closed"],
  [0.001_789_000_557_8, "closed"],
] as const)("preserves paired ports at the threshold with different series-source counts (%s ohms)", (resistance, expected) => {
  const document = seriesParallelDocument([1, 2, 4], resistance);
  // The 1/2/4-cell branches contain 3/4/6 wires respectively. Both leads
  // must combine as a branch before the equal-EMF branches combine in parallel.
  const external = 0.0001 + 3e-6 + (resistance + 4e-6) * (resistance + 6e-6) / (2 * resistance + 10e-6);
  expect(external < 0.001).toBe(expected === "short");
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  const r1 = 0.1 + resistance + 4e-6;
  const r2 = 0.1 + resistance + 6e-6;
  const expectedCurrent = 1 / (0.1 + 0.0001 + 3e-6 + r1 * r2 / (r1 + r2));
  expect(result.parts.s0_0!.currentAmps / expectedCurrent).toBeCloseTo(1, 14);
});

it("preserves the pairing of unequal resistances on both sides of equal-EMF batteries", () => {
  const positive = [0.0001, 0.0018, 0.0002];
  const negative = [1e-6, 0.0002, 0.0018];
  const document: CircuitDocument = {
    title: "Asymmetric battery leads",
    parts: [
      ...positive.map((_, index) => ({
        id: `s${index}`, kind: "battery" as const, label: "S", x: 0, y: 0, voltageVolts: index === 0 ? 1 : 2, internalResistanceOhms: 0.1,
      })),
      ...[positive, negative].flatMap((values, side) => values.map((resistanceOhms, index) => ({
        id: `r${side}_${index}`, kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms,
      }))),
      { id: "p", kind: "junction", label: "P", x: 0, y: 0 },
      { id: "n", kind: "junction", label: "N", x: 0, y: 0 },
    ],
    wires: positive.flatMap((_, index) => [
      { id: `pr${index}`, from: { partId: "p", terminal: "a" as const }, to: { partId: `r0_${index}`, terminal: "a" as const } },
      { id: `rs${index}`, from: { partId: `r0_${index}`, terminal: "b" as const }, to: { partId: `s${index}`, terminal: "a" as const } },
      { id: `sr${index}`, from: { partId: `s${index}`, terminal: "b" as const }, to: { partId: `r1_${index}`, terminal: "a" as const } },
      { id: `rn${index}`, from: { partId: `r1_${index}`, terminal: "b" as const }, to: { partId: "n", terminal: "a" as const } },
    ]),
  };
  // Each return branch is 2004uOhm; the driven loop is 105+2004/2=1107uOhm.
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe("closed");
  expect(result.parts.s0!.currentAmps / (1 / (0.100_105 + 0.102_004 / 2))).toBeCloseTo(1, 14);
  expect(analyzeCircuit({ ...document, parts: [...document.parts].reverse(),
    wires: document.wires.map((wire) => ({ ...wire, from: wire.to, to: wire.from })).reverse(),
  }).status).toBe("closed");
});

it.each([3, 4, 8])("detects wire-only circulating shorts with %s unequal parallel batteries", (count) => {
  const document: CircuitDocument = {
    title: "Overlapping parallel battery cycles",
    parts: Array.from({ length: count }, (_, index) => ({
      id: `s${index}`, kind: "battery" as const, label: `S${index}`, x: 0, y: 0,
      voltageVolts: index + 1, internalResistanceOhms: 0.1,
    })),
    wires: Array.from({ length: count - 1 }, (_, index) => index + 1).flatMap((index) =>
      (["a", "b"] as const).map((terminal) => ({
        id: `${index}${terminal}`, from: { partId: "s0", terminal }, to: { partId: `s${index}`, terminal },
      })),
    ),
  };
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe("short");
  // Every outer source has two 1uOhm leads. KCL gives the shared voltage:
  // V=(1/0.1 + sum(2..n)/(0.1+2e-6))/(1/0.1+(n-1)/(0.1+2e-6)).
  const outerResistance = 0.1 + 2e-6;
  const sharedVoltage = (1 / 0.1 + (count * (count + 1) / 2 - 1) / outerResistance)
    / (1 / 0.1 + (count - 1) / outerResistance);
  expect(result.parts.s0!.currentAmps / ((sharedVoltage - 1) / 0.1)).toBeCloseTo(1, 14);
  const equalVoltage = { ...document, parts: document.parts.map((part) => ({ ...part, voltageVolts: 1 })) };
  expect(analyzeCircuit(equalVoltage).status).toBe("closed");
});

it.each([
  [0.0001, "short"], [0.001, "closed"],
] as const)("uses weighted external paths in overlapping cycles with %s-ohm branch resistors", (resistanceOhms, expectedStatus) => {
  const count = 4;
  const document: CircuitDocument = {
    title: "Overlapping battery cycles with branch resistance",
    parts: [
      ...Array.from({ length: count }, (_, index) => ({
        id: `s${index}`, kind: "battery" as const, label: `S${index}`, x: 0, y: 0,
        voltageVolts: index + 1, internalResistanceOhms: 0.1,
      })),
      ...Array.from({ length: count }, (_, index) => ({
        id: `r${index}`, kind: "resistor" as const, label: `R${index}`, x: 0, y: 0, resistanceOhms,
      })),
      { id: "p", kind: "junction", label: "P", x: 0, y: 0 },
      { id: "n", kind: "junction", label: "N", x: 0, y: 0 },
    ],
    wires: Array.from({ length: count }, (_, index) => [
      { id: `sr${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `r${index}`, terminal: "a" as const } },
      { id: `rp${index}`, from: { partId: `r${index}`, terminal: "b" as const }, to: { partId: "p", terminal: "a" as const } },
      { id: `sn${index}`, from: { partId: `s${index}`, terminal: "b" as const }, to: { partId: "n", terminal: "a" as const } },
    ]).flat(),
  };
  // Any two source branches form an external loop of 2*R+6uOhm.
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expectedStatus);
});

it.each([
  { voltages: [1, 2, 2], resistances: [1e-6, 0.0015, 0.0015], expected: "short" },
  { voltages: [1, 1, 2], resistances: [1e-6, 1e-6, 0.1], expected: "closed" },
])("groups equal EMFs before measuring circulating external resistance ($expected)", ({ voltages, resistances, expected }) => {
  const document: CircuitDocument = {
    title: "Equal-source groups in a parallel battery block",
    parts: [
      ...voltages.map((voltageVolts, index) => ({
        id: `s${index}`, kind: "battery" as const, label: `S${index}`, x: 0, y: 0, voltageVolts, internalResistanceOhms: 0.1,
      })),
      ...resistances.map((resistanceOhms, index) => ({
        id: `r${index}`, kind: "resistor" as const, label: `R${index}`, x: 0, y: 0, resistanceOhms,
      })),
      { id: "p", kind: "junction", label: "P", x: 0, y: 0 },
      { id: "n", kind: "junction", label: "N", x: 0, y: 0 },
    ],
    wires: voltages.flatMap((_, index) => [
      { id: `sr${index}`, from: { partId: `s${index}`, terminal: "a" as const }, to: { partId: `r${index}`, terminal: "a" as const } },
      { id: `rp${index}`, from: { partId: `r${index}`, terminal: "b" as const }, to: { partId: "p", terminal: "a" as const } },
      { id: `sn${index}`, from: { partId: `s${index}`, terminal: "b" as const }, to: { partId: "n", terminal: "a" as const } },
    ]),
  };
  // Identical source branches combine in parallel. Their mutual zero-EMF
  // loop is not a driven short; compare only different source-voltage groups.
  const result = analyzeCircuit(document);
  expect(result.status, result.message).toBe(expected);
  expect(result.parts.s0!.currentAmps).not.toBe(0);
});
