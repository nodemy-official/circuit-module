import {
  complex,
  complexAdd,
  complexConjugate,
  complexDivide,
  complexMagnitude,
  complexMultiply,
  complexSubtract,
  type ComplexValue,
} from "./analog-math.js";
import { exactComplexValue } from "./exact-numeric-state.js";

interface Circle {
  center: ComplexValue;
  squaredRadius: ComplexValue;
}

// All scalar quantities are real ComplexValues so their AC normalization and
// symbolic radicals survive products, quotients, and cancellation. A positive
// normalization cannot change the sign of a retained rectangular coefficient.
// The common arithmetic refines irrational expansions to relative error below
// 2^-514 and equal binary64 rounding at both enclosure endpoints. Reading the
// retained numerator therefore also distinguishes signs below Number.MIN_VALUE.
// Geometry introduces no square-root approximation or containment tolerance.
function realSign(value: ComplexValue) {
  const numerator = exactComplexValue(value)!.real.numerator;
  return numerator < 0n ? -1 : numerator > 0n ? 1 : 0;
}

function squaredLength(value: ComplexValue) {
  return complexMultiply(value, complexConjugate(value));
}

function dotProduct(left: ComplexValue, right: ComplexValue) {
  const product = complexMultiply(left, complexConjugate(right));
  return complexMultiply(complexAdd(product, complexConjugate(product)), complex(0.5));
}

function contains(circle: Circle, point: ComplexValue) {
  return realSign(complexSubtract(squaredLength(complexSubtract(point, circle.center)), circle.squaredRadius)) <= 0;
}

function closestToZero(lower: ComplexValue | null, upper: ComplexValue | null) {
  if (lower && realSign(lower) > 0) { return lower; }
  if (upper && realSign(upper) < 0) { return upper; }
  return complex();
}

/** Minimize a circle through p,q subject to the preceding points being inside. */
function circleThroughPair(points: readonly ComplexValue[], end: number, p: ComplexValue, q: ComplexValue): Circle | null {
  const center = complexMultiply(complexAdd(p, q), complex(0.5));
  const squaredRadius = squaredLength(complexSubtract(p, center));
  const normal = complexMultiply(complexSubtract(q, p), complex(0, 1));
  let lower: ComplexValue | null = null;
  let upper: ComplexValue | null = null;

  // Every eligible center is m + t*n, where m=(p+q)/2, n=i*(q-p).
  // Containment of r is the linear constraint
  //   |r-m|² - |p-m|² <= 2*t*dot(r-m,n).
  // Its feasible interval's point closest to zero minimizes the radius.
  for (let index = 0; index < end; index += 1) {
    const delta = complexSubtract(points[index]!, center);
    const excess = complexSubtract(squaredLength(delta), squaredRadius);
    const coefficient = complexMultiply(dotProduct(delta, normal), complex(2));
    const direction = realSign(coefficient);
    if (direction === 0) {
      if (realSign(excess) > 0) { return null; }
      continue;
    }
    const bound = complexDivide(excess, coefficient);
    if (direction > 0) {
      if (!lower || realSign(complexSubtract(bound, lower)) > 0) { lower = bound; }
    } else if (!upper || realSign(complexSubtract(bound, upper)) < 0) {
      upper = bound;
    }
  }
  if (lower && upper && realSign(complexSubtract(lower, upper)) > 0) { return null; }
  const parameter = closestToZero(lower, upper);
  if (realSign(parameter) === 0) { return { center, squaredRadius }; }
  const constrainedCenter = complexAdd(center, complexMultiply(normal, parameter));
  return { center: constrainedCenter, squaredRadius: squaredLength(complexSubtract(p, constrainedCenter)) };
}

function circleThroughPoint(points: readonly ComplexValue[], end: number, point: ComplexValue): Circle | null {
  let circle: Circle = { center: point, squaredRadius: complex() };
  for (let index = 0; index < end; index += 1) {
    const other = points[index]!;
    if (contains(circle, other)) { continue; }
    const next = circleThroughPair(points, index, point, other);
    if (!next) { return null; }
    circle = next;
  }
  return circle;
}

function shuffledPoints(values: readonly ComplexValue[]) {
  const points = [...values];
  // A fixed permutation makes runs reproducible and avoids the usual ordered
  // collinear/circular input cost. These bounded integers only schedule points;
  // no geometric value is converted to number or used by the generator.
  let seed = 1;
  for (let index = points.length - 1; index > 0; index -= 1) {
    seed = (seed * 48_271) % 2_147_483_647;
    const other = seed % (index + 1);
    [points[index], points[other]] = [points[other]!, points[index]!];
  }
  return points;
}

/**
 * Add the returned common shift with complexAdd to every floating terminal.
 * Its minimum enclosing circle minimizes the largest RMS complexMagnitude;
 * all pairwise voltage differences (including semiconductor controls) survive.
 * Returns zero for no points, or null for invalid inputs / no finite candidate.
 * The shift itself may display Infinity while retaining a usable exact value.
 *
 * Intended only after detecting overflow in a floating component. Incremental
 * one-/two-boundary construction uses O(n) storage and O(n³) worst-case geometry
 * operations, with a reproducible shuffle for the existing 512-terminal limit.
 * BigInt and symbolic-normalization costs depend on the input expressions.
 * Always validate against every ORIGINAL input, including its AC normalization.
 */
export function finiteComplexReferenceShift(values: readonly ComplexValue[]): ComplexValue | null {
  if (values.length === 0) { return complex(); }
  if (values.some((value) => exactComplexValue(value) === null)) { return null; }
  const points = shuffledPoints(values);
  let circle: Circle = { center: points[0]!, squaredRadius: complex() };
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    if (contains(circle, point)) { continue; }
    const next = circleThroughPoint(points, index, point);
    if (!next) { return null; }
    circle = next;
  }
  const shift = complexSubtract(complex(), circle.center);
  return values.every((value) => Number.isFinite(complexMagnitude(complexAdd(value, shift)))) ? shift : null;
}
