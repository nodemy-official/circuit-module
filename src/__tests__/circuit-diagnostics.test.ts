import { describe, expect, it } from "vitest";
import { createExampleCircuit, type CircuitDocument, type CircuitEndpoint, type CircuitPart, type CircuitPartKind, type CircuitTerminal, type CircuitWire } from "../circuit-model.js";
import { inspectCircuit } from "../circuit-diagnostics.js";
import { analyzeAnalogCircuit } from "../analog-solver.js";

const part = (id: string, kind: CircuitPartKind, label = id): CircuitPart => ({
  id,
  kind,
  x: 0,
  y: 0,
  label,
});

const wire = (id: string, from: CircuitEndpoint, to: CircuitEndpoint): CircuitWire => ({ id, from, to });

const endpoint = (partId: string, terminal: CircuitTerminal): CircuitEndpoint => ({ partId, terminal });

const document = (parts: CircuitPart[], wires: CircuitWire[] = []): CircuitDocument => ({
  title: "diagnostic test",
  parts,
  wires,
});

describe("inspectCircuit", () => {
  it("does not report a fully connected example circuit", () => {
    expect(inspectCircuit(createExampleCircuit())).toEqual([]);
  });

  it("groups the open terminals of a fully isolated part into one finding", () => {
    const diagnostics = inspectCircuit(document([part("r1", "resistor", "抵抗") ]));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "isolated-part",
      severity: "warning",
      partIds: ["r1"],
      wireIds: [],
    });
  });

  it("reports open terminals only when another terminal on that part is wired", () => {
    const diagnostics = inspectCircuit(document(
      [part("battery", "battery"), part("resistor", "resistor")],
      [wire("wire-1", endpoint("battery", "b"), endpoint("resistor", "a"))],
    ));

    expect(diagnostics.filter(({ code }) => code === "unconnected-terminal")).toMatchObject([
      { partIds: ["battery"] },
      { partIds: ["resistor"] },
    ]);
    expect(diagnostics.some(({ code }) => code === "isolated-part")).toBe(false);
  });

  it("reports a junction with only one attached wire", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("j1", "junction", "分岐")],
      [wire("wire-1", endpoint("r1", "a"), endpoint("j1", "a"))],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "dead-end-junction",
      severity: "warning",
      partIds: ["j1"],
      wireIds: ["wire-1"],
    }));
  });

  it("does not treat a junction with three attached wires as a dead end", () => {
    const diagnostics = inspectCircuit(document(
      [part("j1", "junction"), part("battery", "battery"), part("r1", "resistor"), part("r2", "resistor")],
      [
        wire("wire-1", endpoint("j1", "a"), endpoint("battery", "a")),
        wire("wire-2", endpoint("j1", "a"), endpoint("r1", "a")),
        wire("wire-3", endpoint("j1", "a"), endpoint("r2", "a")),
      ],
    ));

    expect(diagnostics.some(({ code, partIds }) => code === "dead-end-junction" && partIds.includes("j1"))).toBe(false);
  });

  it("reports a connected component without a battery and identifies its members", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("r2", "resistor")],
      [wire("wire-1", endpoint("r1", "b"), endpoint("r2", "a"))],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "unpowered-component",
      severity: "warning",
      partIds: ["r1", "r2"],
      wireIds: ["wire-1"],
    }));
  });

  it.each([
    ["junction", "ground"],
    ["ground", "ground"],
  ] as const)("does not require a source for wires between %s and %s symbols", (firstKind, secondKind) => {
    const diagnostics = inspectCircuit(document(
      [part("first", firstKind), part("second", secondKind)],
      [wire("wire-1", endpoint("first", "a"), endpoint("second", "a"))],
    ));

    expect(diagnostics.some(({ code }) => code === "unpowered-component")).toBe(false);
  });

  it("still reports a grounded load without a source", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("gnd", "ground")],
      [wire("wire-1", endpoint("r1", "a"), endpoint("gnd", "a"))],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "unpowered-component",
      partIds: ["gnd", "r1"],
      wireIds: ["wire-1"],
    }));
  });

  it("keeps findings distinct when part and wire IDs contain separators", () => {
    const input = document(
      [part("a", "resistor"), part("b,c,d", "resistor"), part("a,b", "resistor"), part("c,d", "resistor")],
      [
        wire("w", endpoint("a", "a"), endpoint("b,c,d", "a")),
        wire("x,y", endpoint("a", "b"), endpoint("b,c,d", "b")),
        wire("w,x", endpoint("a,b", "a"), endpoint("c,d", "a")),
        wire("y", endpoint("a,b", "b"), endpoint("c,d", "b")),
      ],
    );
    const diagnostics = inspectCircuit(input);

    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every(({ code }) => code === "unpowered-component")).toBe(true);
    expect(new Set(diagnostics.map(({ id }) => id)).size).toBe(2);
    expect(inspectCircuit(input)).toEqual(diagnostics);
  });

  it("distinguishes a wire bypass across a battery from a bypass across another part", () => {
    const diagnostics = inspectCircuit(document(
      [part("battery", "battery"), part("resistor", "resistor")],
      [
        wire("battery-short", endpoint("battery", "a"), endpoint("battery", "b")),
        wire("resistor-bypass", endpoint("resistor", "a"), endpoint("resistor", "b")),
      ],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "wire-shorted-battery",
      severity: "error",
      partIds: ["battery"],
      wireIds: ["battery-short"],
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "wire-bypassed-part",
      severity: "warning",
      partIds: ["resistor"],
      wireIds: ["resistor-bypass"],
    }));
  });

  it("rejects duplicate wires and references to missing parts or terminals", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("r2", "resistor")],
      [
        wire("wire-1", endpoint("r1", "a"), endpoint("r2", "b")),
        wire("wire-2", endpoint("r2", "b"), endpoint("r1", "a")),
        wire("wire-3", endpoint("absent", "a"), endpoint("r1", "a")),
        wire("wire-4", { partId: "r1", terminal: "z" } as unknown as CircuitEndpoint, endpoint("r2", "a")),
      ],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate-wire",
      severity: "error",
      partIds: ["r1", "r2"],
      wireIds: ["wire-1", "wire-2"],
    }));
    expect(diagnostics.some(({ code, wireIds }) => code === "missing-wire-part" && wireIds.includes("wire-3"))).toBe(true);
    expect(diagnostics.some(({ code, wireIds }) => code === "invalid-wire-terminal" && wireIds.includes("wire-4"))).toBe(true);
  });

  it.each([
    {
      code: "missing-wire-part",
      parts: [part("r", "resistor")],
      wires: [
        wire("shared", endpoint("missing", "a"), endpoint("missing", "b")),
        wire("shared", endpoint("missing", "a"), endpoint("missing", "b")),
      ],
      count: 4,
    },
    {
      code: "ambiguous-wire-part",
      parts: [part("r", "resistor", "first"), part("r", "resistor", "second")],
      wires: [
        wire("shared", endpoint("r", "a"), endpoint("r", "b")),
        wire("shared", endpoint("r", "a"), endpoint("r", "b")),
      ],
      count: 4,
    },
    {
      code: "invalid-wire-terminal",
      parts: [part("j", "junction")],
      wires: [
        wire("shared", endpoint("j", "b"), endpoint("j", "c")),
        wire("shared", endpoint("j", "b"), endpoint("j", "c")),
      ],
      count: 4,
    },
    {
      code: "same-terminal-wire",
      parts: [part("r", "resistor")],
      wires: [
        wire("shared", endpoint("r", "a"), endpoint("r", "a")),
        wire("shared", endpoint("r", "b"), endpoint("r", "b")),
      ],
      count: 2,
    },
  ])("keeps $code findings distinct when wire IDs repeat", ({ code, parts, wires, count }) => {
    const input = document(parts, wires);
    const diagnostics = inspectCircuit(input);

    expect(diagnostics.filter((diagnostic) => diagnostic.code === code)).toHaveLength(count);
    expect(new Set(diagnostics.map(({ id }) => id)).size).toBe(diagnostics.length);
    expect(inspectCircuit(input)).toEqual(diagnostics);
  });

  it("keeps separate duplicate edges distinct when every wire shares one ID", () => {
    const input = document(
      [part("r1", "resistor"), part("r2", "resistor")],
      [
        wire("shared:1", endpoint("r1", "a"), endpoint("r2", "a")),
        wire("shared:1", endpoint("r2", "a"), endpoint("r1", "a")),
        wire("shared:1", endpoint("r1", "b"), endpoint("r2", "b")),
        wire("shared:1", endpoint("r2", "b"), endpoint("r1", "b")),
      ],
    );
    const diagnostics = inspectCircuit(input);

    expect(diagnostics.filter(({ code }) => code === "duplicate-wire")).toHaveLength(2);
    expect(new Set(diagnostics.map(({ id }) => id)).size).toBe(diagnostics.length);
    expect(inspectCircuit(input)).toEqual(diagnostics);
  });

  it("preserves existing finding IDs when wire IDs are unique", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("r2", "resistor")],
      [
        wire("missing-wire", endpoint("missing", "a"), endpoint("r1", "a")),
        wire("terminal-wire", endpoint("r1", "c"), endpoint("r2", "b")),
        wire("self-wire", endpoint("r1", "b"), endpoint("r1", "b")),
        wire("edge-1", endpoint("r1", "a"), endpoint("r2", "a")),
        wire("edge-2", endpoint("r2", "a"), endpoint("r1", "a")),
      ],
    ));

    expect(diagnostics.slice(0, 4).map(({ id }) => id)).toEqual([
      "missing-wire-part:[[\"missing\"],[\"missing-wire\"],\"from\"]",
      "invalid-wire-terminal:[[\"r1\"],[\"terminal-wire\"],\"from\"]",
      "same-terminal-wire:[[\"r1\"],[\"self-wire\"],\"\"]",
      "duplicate-wire:[[\"r1\",\"r2\"],[\"edge-1\",\"edge-2\"],\"\"]",
    ]);
  });

  it("reports duplicate display labels once with all affected parts", () => {
    const diagnostics = inspectCircuit(document([
      part("r1", "resistor", "抵抗"),
      part("r2", "resistor", " 抵抗 "),
      part("r3", "resistor", ""),
    ]));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "duplicate-label",
      severity: "warning",
      partIds: ["r1", "r2"],
      wireIds: [],
    }));
  });

  it("allows multiple GND parts with the shared GND label", () => {
    const diagnostics = inspectCircuit(document([
      part("g1", "ground", "GND"),
      part("g2", "ground", "GND"),
    ]));

    expect(diagnostics.some(({ code }) => code === "duplicate-label")).toBe(false);
  });

  it("does not report an unpowered component when the connection includes a battery", () => {
    const diagnostics = inspectCircuit(document(
      [part("battery", "battery"), part("resistor", "resistor")],
      [wire("wire-1", endpoint("battery", "b"), endpoint("resistor", "a"))],
    ));

    expect(diagnostics.some(({ code }) => code === "unpowered-component")).toBe(false);
  });

  it.each(["ac-source", "current-source"] as const)("recognizes %s as a power source", (kind) => {
    const diagnostics = inspectCircuit(document(
      [part("source", kind), part("r1", "resistor")],
      [wire("wire-1", endpoint("source", "b"), endpoint("r1", "a"))],
    ));
    expect(diagnostics.some(({ code }) => code === "unpowered-component")).toBe(false);
  });

  it("recognizes an op-amp's internal supply rails when it drives a load", () => {
    const input = document(
      [
        { ...part("amp", "op-amp"), openLoopGain: 100_000, positiveRailVolts: 15, negativeRailVolts: 5 },
        { ...part("load", "resistor"), resistanceOhms: 1000 },
        part("gnd", "ground"),
      ],
      [
        wire("input-plus", endpoint("amp", "a"), endpoint("gnd", "a")),
        wire("input-minus", endpoint("amp", "b"), endpoint("gnd", "a")),
        wire("output", endpoint("amp", "c"), endpoint("load", "a")),
        wire("return", endpoint("load", "b"), endpoint("gnd", "a")),
      ],
    );
    const analysis = analyzeAnalogCircuit(input, { mode: "dc" });

    expect(analysis.status).toBe("valid");
    expect(analysis.parts.load.power.real).toBeGreaterThan(0);
    expect(analysis.parts.amp.power.real).toBeLessThan(0);
    expect(inspectCircuit(input)).toEqual([]);
  });

  it("treats separate GND symbols as the same electrical node", () => {
    const diagnostics = inspectCircuit(document(
      [part("r1", "resistor"), part("g1", "ground"), part("g2", "ground")],
      [
        wire("wire-1", endpoint("r1", "a"), endpoint("g1", "a")),
        wire("wire-2", endpoint("r1", "b"), endpoint("g2", "a")),
      ],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "wire-bypassed-part",
      partIds: ["r1"],
      wireIds: ["wire-1", "wire-2"],
    }));
  });

  it("does not apply two-terminal bypass checks to a three-terminal potentiometer", () => {
    const diagnostics = inspectCircuit(document(
      [part("pot", "potentiometer"), part("g1", "ground"), part("g2", "ground")],
      [
        wire("wire-1", endpoint("pot", "a"), endpoint("g1", "a")),
        wire("wire-2", endpoint("pot", "b"), endpoint("g2", "a")),
      ],
    ));

    expect(diagnostics.some(({ code, partIds }) => code === "wire-bypassed-part" && partIds.includes("pot"))).toBe(false);
  });

  it("reports an AC voltage source shorted by an explicit wire", () => {
    const diagnostics = inspectCircuit(document(
      [part("ac", "ac-source")],
      [wire("short", endpoint("ac", "a"), endpoint("ac", "b"))],
    ));

    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: "wire-shorted-voltage-source",
      severity: "error",
      partIds: ["ac"],
      wireIds: ["short"],
    }));
  });
});
