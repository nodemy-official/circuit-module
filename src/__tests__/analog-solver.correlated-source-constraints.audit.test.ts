import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../analog-solver.js";
import type { CircuitDocument, CircuitPart, CircuitWire } from "../circuit-model.js";

function source(id: string, voltageVolts: number, phaseDegrees: number): CircuitPart {
  return { id, kind: "ac-source", label: id, x: 0, y: 0, voltageVolts, phaseDegrees, frequencyHz: 1000 };
}

function wire(id: string, first: string, firstTerminal: "a" | "b", second: string, secondTerminal: "a" | "b"): CircuitWire {
  return { id, from: { partId: first, terminal: firstTerminal }, to: { partId: second, terminal: secondTerminal } };
}

it.each([0, 37, 45, 90, -135, 405])("rejects an exact amplitude conflict at common phase %s degrees in either part order", (phase) => {
  const document: CircuitDocument = {
    title: "相関した方向係数と異なる振幅",
    parts: [source("first", 1, phase), source("second", 1 + Number.EPSILON, phase),
      { id: "load", kind: "resistor", label: "負荷", x: 0, y: 0, resistanceOhms: 1 }],
    wires: [wire("a", "first", "a", "second", "a"), wire("b", "first", "b", "second", "b"),
      wire("load-a", "first", "a", "load", "a"), wire("load-b", "first", "b", "load", "b")],
  };
  for (const parts of [document.parts, document.parts.toReversed()]) {
    const result = analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" });
    expect(result.status, result.message).toBe("invalid");
    expect(result.message).toContain("電圧が一致しません");
  }
});

it.each([37, 45, -135, 405])("keeps equal same-direction or reversed sources compatible at %s degrees", (phase) => {
  for (const reversed of [false, true]) {
    const document: CircuitDocument = {
      title: "等しい電圧制約",
      parts: [source("first", 1, phase), source("second", 1, phase + (reversed ? 180 : 0))],
      wires: [wire("a", "first", "a", "second", reversed ? "b" : "a"),
        wire("b", "first", "b", "second", reversed ? "a" : "b")],
    };
    expect(analyzeAnalogCircuit(document, { mode: "ac" }).status).toBe("valid");
  }
});

it.each([37, 45])("checks correlated amplitude sums over a source loop at %s degrees", (phase) => {
  for (const conflict of [0, 2 ** -49]) {
    const document: CircuitDocument = {
      title: "三電源の閉ループ",
      parts: [source("first", 3, phase), source("second", 5, phase), source("total", 8 + conflict, phase)],
      wires: [wire("a", "first", "a", "total", "a"), wire("b", "first", "b", "second", "a"),
        wire("c", "second", "b", "total", "b")],
    };
    // The common phase coefficient factors out of KVL: 3+5 must equal 8.
    for (const parts of [document.parts, document.parts.toReversed()]) {
      expect(analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" }).status).toBe(conflict ? "invalid" : "valid");
    }
  }
});

it.each([0, 37, 45, -135])("rejects distinct representable phases near %s degrees", (phase) => {
  const document: CircuitDocument = {
    title: "微小な位相差のある並列電源",
    parts: [source("first", 1, phase), source("second", 1, phase + 2 ** -40)],
    wires: [wire("a", "first", "a", "second", "a"), wire("b", "first", "b", "second", "b")],
  };
  for (const parts of [document.parts, document.parts.toReversed()]) {
    expect(analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" }).status).toBe("invalid");
  }
});

it.each([0, 37, 90, -135])("distinguishes mixed-phase equality from a one-ULP conflict after rotation by %s degrees", (phase) => {
  for (const conflict of [0, Number.EPSILON]) {
    const document: CircuitDocument = {
      title: "混相電源の厳密な合成",
      parts: [source("first", 1, phase + 60), source("second", 1, phase - 60), source("total", 1 + conflict, phase)],
      wires: [wire("a", "first", "a", "total", "a"), wire("b", "first", "b", "second", "a"),
        wire("c", "second", "b", "total", "b")],
    };
    // e^(i*60°)+e^(-i*60°)=1, and a common rotation preserves KVL.
    for (const parts of [document.parts, document.parts.toReversed()]) {
      expect(analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" }).status).toBe(conflict ? "invalid" : "valid");
    }
  }
});

it("retains a subnormal phase mismatch instead of rounding it onto the real axis", () => {
  const document: CircuitDocument = {
    title: "最小位相差",
    parts: [source("first", 1, 0), source("second", 1, Number.MIN_VALUE)],
    wires: [wire("a", "first", "a", "second", "a"), wire("b", "first", "b", "second", "b")],
  };
  expect(analyzeAnalogCircuit(document, { mode: "ac" }).status).toBe("invalid");
});

it.each([1e-160, Number.MIN_VALUE])("rejects a mixed-phase cycle with a %s degree residual", (phase) => {
  const document: CircuitDocument = {
    title: "混相ループの最小位相差",
    parts: [source("first", 1, 60), source("second", 1, -60), source("total", 1, phase)],
    wires: [wire("a", "first", "a", "total", "a"), wire("b", "first", "b", "second", "a"),
      wire("c", "second", "b", "total", "b")],
  };
  // The first two sources sum to exactly 1 on the real axis; any
  // representable nonzero phase on the total source contradicts that sum.
  for (const parts of [document.parts, document.parts.toReversed()]) {
    expect(analyzeAnalogCircuit({ ...document, parts }, { mode: "ac" }).status).toBe("invalid");
  }
});
