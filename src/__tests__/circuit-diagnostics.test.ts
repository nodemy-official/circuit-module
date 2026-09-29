import { describe, expect, it } from "vitest";
import { createExampleCircuit, type CircuitDocument, type CircuitEndpoint, type CircuitPart, type CircuitPartKind, type CircuitTerminal, type CircuitWire } from "../circuit-model.js";
import { inspectCircuit } from "../circuit-diagnostics.js";

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
