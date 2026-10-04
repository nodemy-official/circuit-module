import { expect, it } from "vitest";
import { retainedComplex, restoredComplex } from "../../circuit-reading.js";
import { createExactExpressionCapture, freezeCapturedExactExpressions, matchingExactExpressions, snapshotExactExpressions, withExactExpressionCapture, type ExactExpressionNode } from "../../exact-expression.js";
import { solveExactComplexLinearSystem, solveExactRealLinearSystem } from "../../exact-linear-algebra.js";
import { complexFromExact, exactComplexValue } from "../../exact-numeric-state.js";

it.each(["real", "complex"] as const)("preserves the exact %s solution's transport across dense pivot swaps and JSON cloning", (mode) => {
  const matrix = [0, 1, 1, 2, 3, 4, 3, 2, 5];
  const denominator = 2n ** 8192n + 13n;
  const numerators = [2n ** 4096n + 17n, -(2n ** 4096n + 19n), 2n ** 4096n + 23n];
  const imaginaryNumerators = mode === "complex" ? [1n, -2n, 3n] : [0n, 0n, 0n];
  const coefficients = matrix.map((value) => ({ numerator: BigInt(value), denominator: 1n }));
  // Independent oracle: choose x, construct b=A*x with integer arithmetic.
  // The zero first pivot requires a row swap; det(A)=-3 is nonzero.
  const rhs = (values: bigint[]) => values.map((_, row) => ({
    numerator: values.reduce((sum, value, column) => sum + BigInt(matrix[row * 3 + column]!) * value, 0n), denominator,
  }));
  const capture = createExactExpressionCapture();
  const readings = withExactExpressionCapture(capture, () => {
    const solved = mode === "real"
      ? solveExactRealLinearSystem(3, coefficients, rhs(numerators))!.map((real) => ({ real, imaginary: { numerator: 0n, denominator: 1n } }))
      : solveExactComplexLinearSystem(3, coefficients, coefficients.map(() => ({ numerator: 0n, denominator: 1n })), rhs(numerators), rhs(imaginaryNumerators))!;
    return solved.map((value) => retainedComplex(complexFromExact(value))!);
  });
  const original = { readings, precisionExpressions: freezeCapturedExactExpressions(capture) };
  expect(original.precisionExpressions.length).toBeGreaterThan(0);
  for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
    for (const [index, reading] of result.readings.entries()) {
      const restored = exactComplexValue(restoredComplex(reading, result.precisionExpressions)!)!;
      expect(restored.real.numerator * denominator).toBe(numerators[index]! * restored.real.denominator);
      expect(restored.imaginary.numerator * denominator).toBe(imaginaryNumerators[index]! * restored.imaginary.denominator);
    }
  }
});

it("invalidates restored expression values when a mutable dependency or operation changes", () => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  const assertValue = (numerator: bigint, denominator: bigint) => {
    const exact = exactComplexValue(restoredComplex(reading, table)!)!.real;
    expect(exact.numerator * denominator).toBe(numerator * exact.denominator);
  };
  assertValue(2n, 3n);
  table[0] = { operation: "literal", numerator: "1", denominator: "5" };
  assertValue(2n, 5n);
  table[2] = { operation: "add", arguments: [0, 1] };
  assertValue(11n, 5n);
  table[2] = { operation: "multiply", arguments: [0, 0] };
  assertValue(1n, 25n);
});

it.each(["node", "argument"])("rejects sparse expression tables after a %s is deleted", (field) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "5", denominator: "9" },
    { operation: "literal", numerator: "0", denominator: "1" },
    { operation: "add", arguments: [0, 1] },
  ];
  const snapshot = snapshotExactExpressions(table);
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)).toBeDefined();
  if (field === "node") { Reflect.deleteProperty(table, "0"); }
  else {
    const node = table[2]!;
    if (node.operation === "literal") { throw new Error("Expected operation"); }
    Reflect.deleteProperty(node.arguments, "0");
  }
  expect(matchingExactExpressions(table, snapshot)).toBe(false);
  expect(restoredComplex(reading, table)).toBeUndefined();
});

it.each(["table", "arguments"])("rejects array-like objects replacing expression %s", (field) => {
  const input: { table: ExactExpressionNode[] } = { table: [
    { operation: "literal", numerator: "5", denominator: "9" },
    { operation: "literal", numerator: "0", denominator: "1" },
    { operation: "add", arguments: [0, 1] },
  ] };
  const snapshot = snapshotExactExpressions(input.table);
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(matchingExactExpressions(input.table, snapshot)).toBe(true);
  expect(restoredComplex(reading, input.table)).toBeDefined();
  if (field === "table") {
    Reflect.set(input, "table", { ...input.table, length: input.table.length });
  } else {
    const node = input.table[2]!;
    if (node.operation === "literal") { throw new Error("Expected operation"); }
    Reflect.set(node, "arguments", { ...node.arguments, length: node.arguments.length });
  }
  expect(matchingExactExpressions(input.table, snapshot)).toBe(false);
  expect(matchingExactExpressions(snapshot, input.table)).toBe(false);
  expect(() => snapshotExactExpressions(input.table)).toThrow();
  expect(restoredComplex(reading, input.table)).toBeUndefined();
});

it.each(["iterator", "map"])("uses indexed expression arguments after a %s method changes", (method) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "5", denominator: "9" },
    { operation: "literal", numerator: "0", denominator: "1" },
    { operation: "add", arguments: [0, 1] },
  ];
  const snapshot = snapshotExactExpressions(table);
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)!.real).toBe(5 / 9);
  const node = table[2]!;
  if (node.operation === "literal") { throw new Error("Expected operation"); }
  let methodCalls = 0;
  if (method === "iterator") {
    Reflect.set(node.arguments, Symbol.iterator, function* () { methodCalls += 1; yield 1; yield 1; });
  } else {
    Reflect.set(node.arguments, "map", (callback: (argument: number) => unknown) => {
      methodCalls += 1;
      return [callback(1), callback(1)];
    });
  }
  expect(matchingExactExpressions(table, snapshot)).toBe(true);
  expect(restoredComplex(reading, table)!.real).toBe(5 / 9);
  expect(restoredComplex(reading, table.slice())!.real).toBe(5 / 9);
  expect(restoredComplex(reading, snapshotExactExpressions(table))!.real).toBe(5 / 9);
  expect(methodCalls).toBe(0);
});
