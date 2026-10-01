import type { ExactRational } from "./exact-linear-algebra.js";

type BinaryOperation = "add" | "subtract" | "multiply" | "divide";
type Expression = { operation: "literal"; value: ExactRational }
  | { operation: BinaryOperation | "sum"; arguments: readonly Expression[]; sign?: -1 | 0 | 1 };

export type ExactExpressionHandle = Expression;

export type ExactExpressionNode = { readonly operation: "literal"; readonly numerator: string; readonly denominator: string }
  | { readonly operation: BinaryOperation | "sum"; readonly arguments: readonly number[] };

export interface ExactExpressionReference { expression: number; sign: -1 | 0 | 1; }

export interface ExactExpressionCapture {
  nodes: ExactExpressionNode[];
  indexes: WeakMap<Expression, number>;
  literals: Map<string, number>;
  signs: (-1 | 0 | 1 | undefined)[];
}

const expressions = new WeakMap<ExactRational, Expression>();
const LARGE_VALUE = 2n ** 4096n;
const COMPACT_LITERAL_VALUE = 2n ** 512n;
let activeCapture: ExactExpressionCapture | undefined;
const capturedSigns = new WeakMap<readonly ExactExpressionNode[], readonly (-1 | 0 | 1 | undefined)[]>();
const immutableTables = new WeakSet<readonly ExactExpressionNode[]>();

function sign(value: ExactRational): -1 | 0 | 1 { return value.numerator < 0n ? -1 : value.numerator > 0n ? 1 : 0; }

export function createExactExpressionCapture(): ExactExpressionCapture {
  return { nodes: [], indexes: new WeakMap(), literals: new Map(), signs: [] };
}

export function exactExpressionCaptureIsActive() { return activeCapture !== undefined; }

export function freezeCapturedExactExpressions(capture: ExactExpressionCapture): readonly ExactExpressionNode[] {
  for (const node of capture.nodes) {
    if (node.operation !== "literal") { Object.freeze(node.arguments); }
    Object.freeze(node);
  }
  const table = Object.freeze(capture.nodes);
  immutableTables.add(table);
  capturedSigns.set(table, Object.freeze(capture.signs));
  return table;
}

export function capturedExactExpressionSign(table: readonly ExactExpressionNode[] | undefined, reference: number) {
  return table && capturedSigns.get(table)?.[reference];
}

export function withExactExpressionCapture<T>(capture: ExactExpressionCapture, callback: () => T): T {
  const previous = activeCapture;
  activeCapture = capture;
  try { return callback(); } finally { activeCapture = previous; }
}

function large(value: ExactRational) {
  return value.denominator >= LARGE_VALUE || value.numerator >= LARGE_VALUE || value.numerator <= -LARGE_VALUE;
}

function expressionFor(value: ExactRational): Expression {
  return expressions.get(value) ?? { operation: "literal", value };
}

/** Symbolic unscaled RHS, separate from Bareiss's common integer denominator. */
export function exactExpressionHandle(value: ExactRational): ExactExpressionHandle { return expressionFor(value); }

export function combineExactExpressionHandles(operation: BinaryOperation, first: ExactExpressionHandle, second: ExactExpressionHandle): ExactExpressionHandle {
  return { operation, arguments: [first, second] };
}

export function retainExactExpressionHandle(value: ExactRational, expression: ExactExpressionHandle): ExactRational {
  if (activeCapture && value.numerator !== 0n) { expressions.set(value, expression); }
  return value;
}

export function recordExactAlias(original: ExactRational, result: ExactRational): ExactRational {
  const expression = expressions.get(original);
  if (activeCapture && expression && result !== original) { expressions.set(result, expression); }
  return result;
}

/** Records provenance during sampling; arithmetic results are never changed. */
export function recordExactExpression(operation: BinaryOperation, first: ExactRational, second: ExactRational, result: ExactRational | null) {
  if (!activeCapture || !result || result.numerator === 0n || result === first || result === second) { return result; }
  if (large(result) || expressions.has(first) || expressions.has(second)) {
    expressions.set(result, { operation, arguments: [expressionFor(first), expressionFor(second)], sign: sign(result) });
  }
  return result;
}

export function recordExactSum(values: readonly ExactRational[], result: ExactRational): ExactRational {
  if (activeCapture && result.numerator !== 0n && (large(result) || values.some((value) => expressions.has(value)))) {
    expressions.set(result, { operation: "sum", arguments: values.map(expressionFor), sign: sign(result) });
  }
  return result;
}

function hexadecimal(value: bigint) { return value < 0n ? `-0x${(-value).toString(16)}` : `0x${value.toString(16)}`; }

function registerExpression(capture: ExactExpressionCapture, current: Expression) {
  if (current.operation !== "literal") {
    capture.indexes.set(current, capture.nodes.length);
    capture.nodes.push({ operation: current.operation, arguments: current.arguments.map((argument) => capture.indexes.get(argument)!) });
    capture.signs.push(current.sign);
    return;
  }
  const numerator = hexadecimal(current.value.numerator);
  const denominator = hexadecimal(current.value.denominator);
  const key = `${numerator}/${denominator}`;
  const existing = capture.literals.get(key);
  if (existing !== undefined) { capture.indexes.set(current, existing); return; }
  capture.literals.set(key, capture.nodes.length);
  capture.indexes.set(current, capture.nodes.length);
  capture.nodes.push({ operation: "literal", numerator, denominator });
  capture.signs.push(sign(current.value));
}

export function capturedExactReference(value: ExactRational): ExactExpressionReference | undefined {
  const capture = activeCapture;
  if (!capture || (value.denominator < COMPACT_LITERAL_VALUE && value.numerator < COMPACT_LITERAL_VALUE && value.numerator > -COMPACT_LITERAL_VALUE)) { return; }
  // Medium-sized literals are shared too. Repeating their full hexadecimal
  // components in input snapshots otherwise dominates saved result size.
  const root = expressions.get(value) ?? { operation: "literal" as const, value };
  // Dependencies precede consumers. An explicit stack supports long histories.
  const pending: { expression: Expression; expanded: boolean }[] = [{ expression: root, expanded: false }];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    const current = entry.expression;
    if (capture.indexes.has(current)) { continue; }
    if (current.operation !== "literal" && !entry.expanded) {
      pending.push({ expression: current, expanded: true });
      for (const argument of current.arguments) {
        if (!capture.indexes.has(argument)) { pending.push({ expression: argument, expanded: false }); }
      }
      continue;
    }
    registerExpression(capture, current);
  }
  const reference = capture.indexes.get(root)!;
  capture.signs[reference] = sign(value);
  return { expression: reference, sign: sign(value) };
}

interface ExpressionOperations {
  literal: (value: ExactRational) => ExactRational;
  add: (left: ExactRational, right: ExactRational) => ExactRational;
  subtract: (left: ExactRational, right: ExactRational) => ExactRational;
  multiply: (left: ExactRational, right: ExactRational) => ExactRational;
  divide: (left: ExactRational, right: ExactRational) => ExactRational | null;
  sum: (values: readonly ExactRational[]) => ExactRational;
}

/** A separate immutable snapshot preserves evidence across editable result transports. */
export function snapshotExactExpressions(table: readonly ExactExpressionNode[]): readonly ExactExpressionNode[] {
  const snapshot = Object.freeze(table.map((node) => Object.freeze(node.operation === "literal"
    ? { ...node } : { ...node, arguments: Object.freeze([...node.arguments]) })));
  immutableTables.add(snapshot);
  return snapshot;
}

export function matchingExactExpressions(first: readonly ExactExpressionNode[] | undefined, second: readonly ExactExpressionNode[] | undefined): boolean {
  if (!first || !second) { return first === second; }
  if (first.length !== second.length) { return false; }
  try {
    return Array.from({ length: first.length }, (_, index) => index).every((index) => {
      const node = first[index];
      const other = second[index];
      if (!node || !other || node.operation !== other.operation) { return false; }
      if (node.operation === "literal") {
        return other.operation === "literal" && node.numerator === other.numerator && node.denominator === other.denominator;
      }
      return other.operation !== "literal" && node.arguments.length === other.arguments.length &&
        Array.from({ length: node.arguments.length }, (_, argumentIndex) => argumentIndex).every((argumentIndex) =>
          Number.isSafeInteger(node.arguments[argumentIndex]) && node.arguments[argumentIndex] === other.arguments[argumentIndex]);
    });
  } catch { return false; }
}

const restoredRoots = new WeakMap<readonly ExactExpressionNode[], {
  snapshot: readonly ExactExpressionNode[];
  roots: Map<number, ExactRational>;
}>();

function expressionDependencies(table: readonly ExactExpressionNode[], reference: number, cached: ReadonlyMap<number, ExactRational>) {
  const needed = new Set<number>();
  const pending = [reference];
  const lastUse = new Map<number, number>();
  while (pending.length > 0) {
    const index = pending.pop()!;
    if (needed.has(index)) { continue; }
    needed.add(index);
    if (cached.has(index)) { continue; }
    const node = table[index];
    if (!node) { return; }
    if (node.operation === "literal") { continue; }
    for (const argument of node.arguments) {
      if (!Number.isSafeInteger(argument) || argument < 0 || argument >= index) { return; }
      lastUse.set(argument, Math.max(lastUse.get(argument) ?? -1, index));
      pending.push(argument);
    }
  }
  return { needed: [...needed].sort((first, second) => first - second), lastUse };
}

function evaluateExpression(node: ExactExpressionNode, live: ReadonlyMap<number, ExactRational>, operations: ExpressionOperations) {
  if (node.operation === "literal") {
    const numerator = node.numerator.startsWith("-") ? -BigInt(node.numerator.slice(1)) : BigInt(node.numerator);
    const denominator = BigInt(node.denominator);
    return denominator > 0n ? operations.literal({ numerator, denominator }) : undefined;
  }
  const arguments_ = node.arguments.map((argument) => live.get(argument));
  if (arguments_.some((argument) => !argument)) { return; }
  const values = arguments_.filter((argument): argument is ExactRational => argument !== undefined);
  if (node.operation !== "sum" && values.length !== 2) { return; }
  return node.operation === "sum" ? operations.sum(values) : operations[node.operation](values[0]!, values[1]!);
}

function cacheExpressionValue(cache: Map<number, ExactRational>, index: number, value: ExactRational) {
  cache.delete(index);
  if (cache.size >= 32) { cache.delete(cache.keys().next().value!); }
  cache.set(index, value);
}

function evaluateDependencies(table: readonly ExactExpressionNode[], reference: number, operations: ExpressionOperations, cached: Map<number, ExactRational>) {
  // Anchors must survive cache eviction while the new dependency set is
  // evaluated. The working cache stays bounded independently of this copy.
  const anchors = new Map(cached);
  const dependencies = expressionDependencies(table, reference, anchors);
  if (!dependencies) { return; }
  const live = new Map<number, ExactRational>();
  for (const index of dependencies.needed) {
    const node = table[index]!;
    const value = anchors.get(index) ?? evaluateExpression(node, live, operations);
    if (!value) { return; }
    if (node.operation !== "literal") {
      for (const argument of node.arguments) {
        if (dependencies.lastUse.get(argument) === index) { live.delete(argument); }
      }
    }
    live.set(index, value);
    cacheExpressionValue(cached, index, value);
  }
  return live.get(reference);
}

export function restoreExactExpression(table: readonly ExactExpressionNode[] | undefined, reference: number, operations: ExpressionOperations): ExactRational | undefined {
  if (!table || !Number.isSafeInteger(reference) || reference < 0 || reference >= table.length) { return; }
  try {
    const previous = restoredRoots.get(table);
    const immutable = immutableTables.has(table);
    const cached = previous && (immutable || matchingExactExpressions(table, previous.snapshot)) ? previous : undefined;
    const roots = cached?.roots ?? new Map<number, ExactRational>();
    const known = roots.get(reference);
    if (known) { return known; }
    const result = evaluateDependencies(table, reference, operations, roots);
    if (!result) { return; }
    restoredRoots.set(table, { roots, snapshot: cached?.snapshot ?? (immutable ? table : snapshotExactExpressions(table)) });
    return result;
  } catch {
    // Malformed optional result metadata falls back to scalar readings.
  }
}
