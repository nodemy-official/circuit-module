import { expect, it, vi } from "vitest";
import { retainedComplex, restoredComplex } from "../../circuit-reading.js";
import { capturedExactReference, combineExactExpressionHandles, createExactExpressionCapture, exactExpressionHandle, freezeCapturedExactExpressions, matchingExactExpressions, retainExactExpressionHandle, snapshotExactExpressions, withExactExpressionCapture, type ExactExpressionNode } from "../../exact-expression.js";
import { addExactRational, deferExactRationalReduction, divideExactRational, multiplyExactRational, numberToExactRational, solveExactComplexLinearSystem, solveExactRealLinearSystem, sumExactRationals, type ExactRational } from "../../exact-linear-algebra.js";
import { complexFromExact, exactComplexValue } from "../../exact-numeric-state.js";

it.each((["add", "sum", "handle"] as const).flatMap((source) => [1n, -1n].map((direction) => ({ source, direction }))))(
  "snapshots caller-owned literal operands recorded through $source with denominator sign $direction",
  ({ source, direction }) => {
    const denominator = 2n ** 5000n;
    const input = { numerator: direction * (denominator + 1n), denominator: direction * denominator };
    const one = { numerator: 1n, denominator: 1n };
    const capture = createExactExpressionCapture();
    const reading = withExactExpressionCapture(capture, () => {
      const handle = source === "handle"
        ? combineExactExpressionHandles("add", exactExpressionHandle(input), exactExpressionHandle(one)) : undefined;
      const result = source === "sum" ? sumExactRationals([input, one]) : addExactRational(input, one);
      if (handle) { retainExactExpressionHandle(result, handle); }
      input.numerator += denominator;
      input.denominator *= 3n;
      return retainedComplex(complexFromExact({ real: result, imaginary: { numerator: 0n, denominator: 1n } }))!;
    });
    const original = { reading, table: freezeCapturedExactExpressions(capture) };

    for (const transported of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const value = restoredComplex(transported.reading, transported.table);
      expect(value).toBeDefined();
      const restored = exactComplexValue(value!)!.real;
      // At the time of the operation: (d + 1) / d + 1 = (2d + 1) / d.
      expect(restored.numerator * denominator).toBe((2n * denominator + 1n) * restored.denominator);
    }
  },
);

it.each(["divide", "sum", "alias", "retained"].flatMap((source) => [-1, 1].map((unitSign) => ({ source, unitSign }))))(
  "keeps a canonical unit from $source ($unitSign) independent of previous captures",
  ({ source, unitSign }) => {
    const firstNumerator = 2n ** 5000n + 17n;
    const firstDenominator = 2n ** 4900n;
    const firstCapture = createExactExpressionCapture();
    let unit: ExactRational = numberToExactRational(unitSign)!;
    withExactExpressionCapture(firstCapture, () => {
      const large = addExactRational(deferExactRationalReduction({ numerator: firstNumerator, denominator: firstDenominator }), numberToExactRational(1)!);
      const signedLarge = unitSign === 1 ? large : multiplyExactRational(large, numberToExactRational(-1)!);
      capturedExactReference(large);
      if (source === "divide") { unit = divideExactRational(signedLarge, large)!; }
      else if (source === "sum") {
        unit = sumExactRationals([large, {
          numerator: BigInt(unitSign) * large.denominator - large.numerator,
          denominator: large.denominator,
        }]);
      } else {
        const expression = combineExactExpressionHandles("divide", exactExpressionHandle(signedLarge), exactExpressionHandle(large));
        if (source === "alias") {
          // A large unreduced unit still needs compact expression evidence.
          const scale = 2n ** 5000n;
          const noncanonical = retainExactExpressionHandle({ numerator: BigInt(unitSign) * scale, denominator: scale }, expression);
          const reference = capturedExactReference(noncanonical)!;
          expect(firstCapture.nodes[reference.expression]?.operation).toBe("divide");
          unit = deferExactRationalReduction(noncanonical);
        } else {
          unit = retainExactExpressionHandle(unit, expression);
        }
      }
    });
    freezeCapturedExactExpressions(firstCapture);
    expect(unit.numerator).toBe(BigInt(unitSign) * unit.denominator);

    const numerator = 2n ** 5200n + 101n;
    const denominator = 2n ** 5100n;
    const capture = createExactExpressionCapture();
    const reading = withExactExpressionCapture(capture, () => retainedComplex(complexFromExact({
      real: addExactRational(unit, { numerator, denominator }),
      imaginary: { numerator: 0n, denominator: 1n },
    }))!);
    const original = { reading, table: freezeCapturedExactExpressions(capture) };
    expect(original.table.some((node) => node.operation === "literal" && node.numerator === `0x${firstNumerator.toString(16)}`)).toBe(false);
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const restored = exactComplexValue(restoredComplex(result.reading, result.table)!)!;
      // Independent integer arithmetic checks the transported fraction.
      expect(restored.real.numerator * denominator).toBe((numerator + BigInt(unitSign) * denominator) * restored.real.denominator);
      expect(restored.imaginary.numerator).toBe(0n);
    }
  },
);

it.each([-1, 1])("keeps expression evidence bounded across captures that return %s", (unitSign) => {
  let unit = numberToExactRational(unitSign)!;
  let firstTableSize: number | undefined;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const numerator = 2n ** 5200n + BigInt(101 + iteration);
    const denominator = 2n ** 5100n;
    const capture = createExactExpressionCapture();
    const reading = withExactExpressionCapture(capture, () => {
      const large = addExactRational(unit, deferExactRationalReduction({ numerator, denominator }));
      const result = retainedComplex(complexFromExact({ real: large, imaginary: { numerator: 0n, denominator: 1n } }))!;
      unit = divideExactRational(multiplyExactRational(large, numberToExactRational(unitSign)!), large)!;
      return result;
    });
    const original = { reading, table: freezeCapturedExactExpressions(capture) };
    firstTableSize ??= original.table.length;
    expect(original.table.length).toBe(firstTableSize);
    for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const restored = exactComplexValue(restoredComplex(result.reading, result.table)!)!.real;
      expect(restored.numerator * denominator).toBe((numerator + BigInt(unitSign) * denominator) * restored.denominator);
    }
  }
});

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

it("keeps replayed values paired with the dependency snapshot actually evaluated", () => {
  const literal = {
    operation: "literal" as const,
    numerator: "1",
    get denominator() {
      // Reading a transported metadata accessor can edit another field. The
      // first replay observes 1/1, and the next replay must observe 2/1.
      literal.numerator = "2";
      return "1";
    },
  };
  const table: ExactExpressionNode[] = [literal];
  const reading = { real: { expression: 0, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(1);
  expect(restoredComplex(reading, table)?.real).toBe(2);
  expect(restoredComplex(reading, table)?.real).toBe(2);
});

it("reuses unchanged immutable metadata during mutable-table replay cache hits", () => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  const freeze = vi.spyOn(Object, "freeze");
  let frozenMetadata = 0;
  try {
    for (let repeat = 0; repeat < 10; repeat += 1) {
      restoredComplex(reading, table);
    }
    frozenMetadata = freeze.mock.calls.filter(([value]) => Array.isArray(value) || Object.hasOwn(value, "operation")).length;
  } finally { freeze.mockRestore(); }
  // Cache hits still inspect the editable equations, but must not allocate
  // and freeze another copy of every node on every playback frame.
  expect(frozenMetadata).toBe(0);
});

it("keeps previously observed prefixes when a later accessor changes both equations", () => {
  let numerator = "1";
  let numeratorReads = 0;
  const table: ExactExpressionNode[] = [
    { operation: "literal", get numerator() { numeratorReads += 1; return numerator; }, denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  numeratorReads = 0;
  let operationReads = 0;
  Object.defineProperty(table[2]!, "operation", {
    get() { operationReads += 1; numerator = "2"; return "add"; },
  });

  // The first replay observes 1/3 before observing the new addition. The
  // later edit to that numerator belongs to the next replay's evidence.
  expect(restoredComplex(reading, table)?.real).toBe(7 / 3);
  expect(numeratorReads).toBe(1);
  expect(operationReads).toBe(1);
  expect(restoredComplex(reading, table)?.real).toBe(8 / 3);
  expect(numeratorReads).toBe(2);
  expect(operationReads).toBe(2);
});

it("invalidates all cached roots when only a shared dependency changes", () => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
    { operation: "add", arguments: [0, 1] },
  ];
  const reading = (expression: number) => ({ real: { expression, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } });
  expect(restoredComplex(reading(2), table)?.real).toBe(2 / 3);
  expect(restoredComplex(reading(3), table)?.real).toBe(7 / 3);
  Reflect.set(table[0]!, "numerator", "2");
  expect(restoredComplex(reading(2), table)?.real).toBe(4 / 3);
  expect(restoredComplex(reading(3), table)?.real).toBe(8 / 3);
});

it.each(["table", "arguments"] as const)("observes the transported %s length once during replay", (field) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  let lengthReads = 0;
  const proxy = <T extends unknown[]>(array: T) => new Proxy(array, {
    get(target, key, receiver) {
      if (key === "length") { lengthReads += 1; return lengthReads === 1 ? array.length : 1; }
      return Reflect.get(target, key, receiver);
    },
  });
  const transported = field === "table" ? proxy(table) : table;
  if (field === "arguments") { Reflect.set(table[2]!, "arguments", proxy([0, 1])); }
  for (let repeat = 0; repeat < 2; repeat += 1) {
    lengthReads = 0;
    expect(restoredComplex(reading, transported)?.real).toBe(2 / 3);
    expect(lengthReads).toBe(1);
  }
});

it.each(["table", "arguments"] as const)("rejects invalid Proxy %s lengths without reusing warmed roots", (field) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  let length: unknown = field === "table" ? 3 : 2;
  const proxy = <T extends unknown[]>(array: T) => new Proxy(array, {
    get(target, key, receiver) { return key === "length" ? length : Reflect.get(target, key, receiver); },
  });
  const transported = field === "table" ? proxy(table) : table;
  if (field === "arguments") { Reflect.set(table[2]!, "arguments", proxy([0, 1])); }
  const snapshot = snapshotExactExpressions(transported);
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, transported)?.real).toBe(2 / 3);
  for (length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32, field === "table" ? "3" : "2"]) {
    expect(() => snapshotExactExpressions(transported)).toThrow();
    expect(matchingExactExpressions(transported, snapshot)).toBe(false);
    expect(restoredComplex(reading, transported)).toBeUndefined();
  }
  length = field === "table" ? 3 : 2;
  expect(restoredComplex(reading, transported)?.real).toBe(2 / 3);
});

it.each(["operation", "arguments", "argument-index"] as const)("captures a mutable %s once before matching a replay cache", (field) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  let reads = 0;
  const node = table[2]!;
  if (field === "argument-index") {
    if (node.operation === "literal") { throw new Error("Expected arithmetic expression"); }
    Object.defineProperty(node.arguments, "0", { get() { reads += 1; return reads === 1 ? 0 : 1; } });
  } else {
    Object.defineProperty(node, field, {
      get() {
        reads += 1;
        return field === "operation" ? reads === 1 ? "multiply" : "add" : reads === 1 ? [0, 1] : [1, 1];
      },
    });
  }

  // The first observed equation is (1/3)*2. The changed equation belongs to
  // the next read: either 1/3+2=7/3 or 2*2=4, independently of replay helpers.
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  expect(reads).toBe(1);
  expect(restoredComplex(reading, table)?.real).toBe(field === "operation" ? 7 / 3 : 4);
  expect(reads).toBe(2);
});

it.each(["operation", "arguments", "argument-index"] as const)("compares a mutable %s from one observation", (field) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "5", denominator: "9" },
    { operation: "literal", numerator: "0", denominator: "1" },
    { operation: "add", arguments: [0, 1] },
  ];
  const snapshot = snapshotExactExpressions(table);
  let reads = 0;
  const node = table[2]!;
  if (field === "argument-index") {
    if (node.operation === "literal") { throw new Error("Expected arithmetic expression"); }
    Object.defineProperty(node.arguments, "0", { get() { reads += 1; return reads === 1 ? 0 : 1; } });
  } else {
    Object.defineProperty(node, field, {
      get() {
        reads += 1;
        return field === "operation" ? reads === 1 ? "add" : "constructor" : reads === 1 ? [0, 1] : [1, 1];
      },
    });
  }

  expect(matchingExactExpressions(table, snapshot)).toBe(true);
  expect(reads).toBe(1);
  expect(matchingExactExpressions(table, snapshot)).toBe(false);
  expect(reads).toBe(2);
});

it.each(["literal", "arithmetic"])("snapshots known %s fields without reading unrelated metadata", (kind) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "5", denominator: "9" },
    { operation: "literal", numerator: "0", denominator: "1" },
    { operation: "add", arguments: [0, 1] },
  ];
  Object.defineProperty(table[kind === "literal" ? 0 : 2]!, "unused", {
    enumerable: true,
    get() { throw new Error("Unused metadata must not be read"); },
  });
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  const snapshot = snapshotExactExpressions(table);

  expect(restoredComplex(reading, table)?.real).toBe(5 / 9);
  expect(restoredComplex(reading, snapshot)?.real).toBe(5 / 9);
});

it("compares every expression argument using the initially observed array length", () => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const snapshot = snapshotExactExpressions(table);
  let lengthReads = 0;
  Reflect.set(table[2]!, "arguments", new Proxy([0, 0], {
    get(target, key, receiver) {
      if (key === "length") { lengthReads += 1; return lengthReads === 1 ? 2 : 1; }
      return Reflect.get(target, key, receiver);
    },
  }));

  expect(matchingExactExpressions(table, snapshot)).toBe(false);
  expect(lengthReads).toBe(1);
});

it.each([
  { name: "self reference", node: { operation: "multiply", arguments: [2, 1] } },
  { name: "forward reference", node: { operation: "multiply", arguments: [3, 1] } },
  { name: "negative reference", node: { operation: "multiply", arguments: [-1, 1] } },
  { name: "fractional reference", node: { operation: "multiply", arguments: [0.5, 1] } },
  { name: "missing operand", node: { operation: "multiply", arguments: [0] } },
  { name: "self sum", node: { operation: "sum", arguments: [2] } },
  { name: "zero denominator", node: { operation: "literal", numerator: "1", denominator: "0" } },
  { name: "invalid literal", node: { operation: "literal", numerator: " 1", denominator: "3" } },
] satisfies { name: string; node: ExactExpressionNode }[])("rejects $name metadata after warming the cache and recovers after repair", ({ node }) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  table[2] = node;
  expect(restoredComplex(reading, table)).toBeUndefined();

  table[0] = { operation: "literal", numerator: "1", denominator: "5" };
  table[2] = { operation: "multiply", arguments: [0, 1] };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 5);
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

it.each(["constructor", "__proto__", "toString", "unsupported"])("rejects an unsupported expression operation (%s)", (operation) => {
  const table: ExactExpressionNode[] = [
    { operation: "literal", numerator: "1", denominator: "3" },
    { operation: "literal", numerator: "2", denominator: "1" },
    { operation: "multiply", arguments: [0, 1] },
  ];
  const original = snapshotExactExpressions(table);
  const reading = { real: { expression: 2, sign: 1 as const }, imaginary: { numerator: "0", denominator: "1" } };
  expect(restoredComplex(reading, table)?.real).toBe(2 / 3);
  Reflect.set(table[2]!, "operation", operation);

  expect(matchingExactExpressions(table, original)).toBe(false);
  expect(matchingExactExpressions(table, table)).toBe(false);
  expect(() => snapshotExactExpressions(table)).toThrow();
  expect(restoredComplex(reading, table)).toBeUndefined();
});
