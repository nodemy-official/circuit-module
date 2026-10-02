import { describe, expect, it } from "vitest";
import {
  complex,
  complexAdd,
  complexFromPolar,
  complexMagnitude,
  complexMultiply,
  complexRectangularValue,
  complexSubtract,
  type ComplexValue,
  withComplexMagnitudeNormalization,
} from "../analog-math.js";
import { finiteComplexReferenceShift } from "../analog-reference.js";
import { complexFromExact, exactComplexValue } from "../exact-numeric-state.js";
import {
  addRational,
  assertCorrectSqrtRounding,
  compareRational,
  createSeededRandom,
  divideRational,
  midpointRational,
  multiplyRational,
  negateRational,
  rational,
  rationalFromNumber,
  subtractRational,
  type Rational,
} from "./helpers/numeric-oracle.js";

interface Point {
  real: Rational;
  imaginary: Rational;
}

interface OracleCircle {
  center: Point;
  squaredRadius: Rational;
}

const ZERO = rational(0n);
const TWO = rational(2n);

function point(real: number | bigint, imaginary: number | bigint = 0): Point {
  return {
    real: typeof real === "bigint" ? rational(real) : rationalFromNumber(real)!,
    imaginary: typeof imaginary === "bigint" ? rational(imaginary) : rationalFromNumber(imaginary)!,
  };
}

function square(value: Rational) {
  return multiplyRational(value, value);
}

function normSquared(value: Point) {
  return addRational(square(value.real), square(value.imaginary));
}

function difference(left: Point, right: Point): Point {
  return { real: subtractRational(left.real, right.real), imaginary: subtractRational(left.imaginary, right.imaginary) };
}

function translateAndScale(value: Point, scale: Rational, offset = point(0)): Point {
  return {
    real: addRational(multiplyRational(value.real, scale), offset.real),
    imaginary: addRational(multiplyRational(value.imaginary, scale), offset.imaginary),
  };
}

// Independent exhaustive geometry oracle: enumerate every one-/two-/three-point
// support, solve absolute Cartesian bisector equations by Cramer's rule, and
// check all points with the independent BigInt rational arithmetic. Production
// instead incrementally intersects center intervals on a perpendicular bisector.
function circumcenter(first: Point, second: Point, third: Point): Point | null {
  const a = multiplyRational(TWO, subtractRational(second.real, first.real));
  const b = multiplyRational(TWO, subtractRational(second.imaginary, first.imaginary));
  const c = multiplyRational(TWO, subtractRational(third.real, first.real));
  const d = multiplyRational(TWO, subtractRational(third.imaginary, first.imaginary));
  const e = subtractRational(normSquared(second), normSquared(first));
  const f = subtractRational(normSquared(third), normSquared(first));
  const determinant = subtractRational(multiplyRational(a, d), multiplyRational(b, c));
  if (determinant.numerator === 0n) { return null; }
  return {
    real: divideRational(subtractRational(multiplyRational(e, d), multiplyRational(b, f)), determinant),
    imaginary: divideRational(subtractRational(multiplyRational(a, f), multiplyRational(e, c)), determinant),
  };
}

function oracleCircle(points: readonly Point[]): OracleCircle {
  let best: OracleCircle | null = null;
  const consider = (center: Point, boundary: Point) => {
    const squaredRadius = normSquared(difference(center, boundary));
    if (best && compareRational(squaredRadius, best.squaredRadius) >= 0) { return; }
    if (points.every((value) => compareRational(normSquared(difference(value, center)), squaredRadius) <= 0)) {
      best = { center, squaredRadius };
    }
  };
  for (let first = 0; first < points.length; first += 1) {
    const a = points[first]!;
    consider(a, a);
    for (let second = 0; second < first; second += 1) {
      const b = points[second]!;
      consider({ real: midpointRational(a.real, b.real), imaginary: midpointRational(a.imaginary, b.imaginary) }, a);
      for (let third = 0; third < second; third += 1) {
        const center = circumcenter(a, b, points[third]!);
        if (center) { consider(center, a); }
      }
    }
  }
  if (!best) { throw new Error("No enclosing circle in oracle"); }
  return best;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) { throw new Error(message); }
}

function expectPoint(actual: ComplexValue, expected: Point) {
  const retained = exactComplexValue(complexRectangularValue(actual));
  assertCondition(retained, "Complex result must retain exact coordinates");
  assertCondition(compareRational(retained.real, expected.real) === 0, "real coordinate differs from rational oracle");
  assertCondition(compareRational(retained.imaginary, expected.imaginary) === 0, "imaginary coordinate differs from rational oracle");
}

const overflowMidpoint = midpointRational(rationalFromNumber(Number.MAX_VALUE)!, rational(2n ** 1024n));
const overflowSquared = square(overflowMidpoint);

function expectOracleShift(points: readonly Point[], values: readonly ComplexValue[] = points.map(complexFromExact)) {
  const expected = oracleCircle(points);
  const shift = finiteComplexReferenceShift(values);
  if (compareRational(expected.squaredRadius, overflowSquared) >= 0) {
    assertCondition(shift === null, "No finite circle exists according to the independent oracle");
    return null;
  }
  assertCondition(shift, "A finite minimum enclosing circle exists according to the independent oracle");
  expectPoint(shift, { real: negateRational(expected.center.real), imaginary: negateRational(expected.center.imaginary) });
  for (let index = 0; index < points.length; index += 1) {
    const shifted = complexAdd(values[index]!, shift);
    const expectedPoint = difference(points[index]!, expected.center);
    expectPoint(shifted, expectedPoint);
    assertCorrectSqrtRounding(complexMagnitude(shifted), normSquared(expectedPoint), `terminal ${index}`);
    assertCondition(Number.isFinite(complexMagnitude(shifted)), "Every original terminal must have finite magnitude");
  }
  return shift;
}

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length === 0) { return [[]]; }
  return values.flatMap((value, index) => permutations(values.filter((_, other) => other !== index))
    .map((rest) => [value, ...rest]));
}

describe("finiteComplexReferenceShift", () => {
  it("centers the 1.7e308 T-shaped four-source chain at its junction", () => {
    const amplitude = 1.7e308;
    const scale = rationalFromNumber(amplitude)!;
    const points = [point(0), point(1), point(2), point(1), point(1, 1)]
      .map((value) => translateAndScale(value, scale));
    const values = [complex()];
    for (const phase of [0, 0, 180, 90]) {
      values.push(complexAdd(values.at(-1)!, complexFromPolar(amplitude, phase)));
    }
    expect(values.some((value) => !Number.isFinite(complexMagnitude(value)))).toBe(true);
    // A rectangle midpoint has radius sqrt(5/4)*E, which overflows.
    const rectangleShift = complexFromExact({ real: negateRational(scale), imaginary: negateRational(divideRational(scale, TWO)) });
    expect(complexMagnitude(complexAdd(values[0]!, rectangleShift))).toBe(Number.POSITIVE_INFINITY);
    expectOracleShift(points, values);
  });

  it.each([
    { name: "acute triangle", points: [point(0), point(4), point(2, 3)] },
    { name: "obtuse triangle", points: [point(0), point(6), point(2, 1)] },
    { name: "right triangle", points: [point(0), point(4), point(0, 3)] },
    { name: "collinear duplicates", points: [point(-5, -10), point(2, 4), point(8, 16), point(2, 4)] },
    { name: "coincident points", points: [point(7, -9), point(7, -9), point(7, -9)] },
    { name: "single point", points: [point(7, -9)] },
    { name: "asymmetric hull", points: [point(-3, 1), point(-1, -2), point(4), point(2, 4), point(0)] },
  ])("matches the independent rational oracle for $name", ({ points }) => {
    for (const scale of [rational(1n), rationalFromNumber(2e307)!]) {
      const transformed = points.map((value) => translateAndScale(value, scale, point(5n * 10n ** 308n, -8n * 10n ** 308n)));
      expectOracleShift(transformed);
    }
  });

  it("returns the same exact shift for all terminal/component permutations", () => {
    const points = [point(-3, 1), point(0, -2), point(4, 1), point(1, 4), point(1)];
    const expected = oracleCircle(points).center;
    for (const ordering of permutations(points)) {
      const shift = finiteComplexReferenceShift(ordering.map(complexFromExact));
      expect(shift).not.toBeNull();
      expectPoint(shift!, { real: negateRational(expected.real), imaginary: negateRational(expected.imaginary) });
    }
  });

  it("matches exhaustively enumerated supports for generated rational point sets", () => {
    const random = createSeededRandom(0x5245464552454e43n);
    for (let sample = 0; sample < 80; sample += 1) {
      const points = Array.from({ length: 3 + Number(random() % 5n) }, () => ({
        real: rational(random() % 61n - 30n, 1n + random() % 7n),
        imaginary: rational(random() % 61n - 30n, 1n + random() % 7n),
      }));
      expectOracleShift(points);
    }
  });

  it("retains huge offsets and subnormal differences without projection or tolerances", () => {
    const offset = point(10n ** 620n, -(10n ** 619n));
    const scale = rational(1n, 2n ** 1200n);
    const points = [point(0), point(4), point(2, 3)].map((value) => translateAndScale(value, scale, offset));
    const values = points.map(complexFromExact);
    const shift = expectOracleShift(points, values)!;
    const after = values.map((value) => complexAdd(value, shift));
    expect(after.every((value) => complexMagnitude(value) === 0)).toBe(true);
    // Exact differences below binary64 underflow remain nonzero for controls.
    for (let index = 1; index < after.length; index += 1) {
      expectPoint(complexSubtract(after[index]!, after[0]!), difference(points[index]!, points[0]!));
      expect(exactComplexValue(complexSubtract(after[index]!, after[0]!))!.real.numerator).not.toBe(0n);
    }
  });

  it("uses physical coordinates when AC magnitude normalizations differ", () => {
    const scale = rationalFromNumber(1e308)!;
    const points = [point(0), point(2), point(1, 2), point(1), point(1, 1)]
      .map((value) => translateAndScale(value, scale));
    const corrections = [rational(1n), rational(2n), rational(3n, 2n), rational(1n, 4n), rational(3n)];
    const values = points.map((value, index) => {
      const correction = corrections[index]!;
      return withComplexMagnitudeNormalization(complexFromExact({
        real: divideRational(value.real, correction),
        imaginary: divideRational(value.imaginary, correction),
      }), square(correction));
    });
    expectOracleShift(points, values);
    expectOracleShift(points.toReversed(), values.toReversed());
  });

  it("preserves irrational mixed normalizations and every voltage control difference", () => {
    // All physical points are sqrt(2) times this independently solved rational
    // set, encoded with differing coefficient frames (sqrt(2), sqrt(8), sqrt(18)).
    const scale = rationalFromNumber(6e307)!;
    const points = [point(0), point(2), point(1, 2), point(1), point(1, 1)]
      .map((value) => translateAndScale(value, scale));
    const expected = oracleCircle(points);
    const values = points.map((value, index) => {
      const divisor = rational(BigInt(1 + index % 3));
      return withComplexMagnitudeNormalization(complexFromExact({
        real: divideRational(value.real, divisor), imaginary: divideRational(value.imaginary, divisor),
      }), multiplyRational(TWO, square(divisor)));
    });
    const shift = finiteComplexReferenceShift(values);
    expect(shift).not.toBeNull();
    const after = values.map((value) => complexAdd(value, shift!));
    for (let first = 0; first < points.length; first += 1) {
      assertCorrectSqrtRounding(complexMagnitude(after[first]!),
        multiplyRational(TWO, normSquared(difference(points[first]!, expected.center))), `irrational terminal ${first}`);
      for (let second = 0; second < first; second += 1) {
        assertCorrectSqrtRounding(complexMagnitude(complexSubtract(after[first]!, after[second]!)),
          multiplyRational(TWO, normSquared(difference(points[first]!, points[second]!))), `control ${first}-${second}`);
      }
    }
  });

  it.each([-1n, 0n, 1n])("decides finite magnitude exactly at the overflow midpoint plus %s", (delta) => {
    const radius = addRational(overflowMidpoint, rational(delta));
    const offset = point(10n ** 310n, -(10n ** 310n));
    const points = [point(-1), point(1)].map((value) => translateAndScale(value, radius, offset));
    expectOracleShift(points);
  });

  it("centers an acute triangle mixing unrelated sqrt(2) and sqrt(3) amplitude frames", () => {
    const amplitude = 1e308;
    const squaredAmplitude = square(rationalFromNumber(amplitude)!);
    const left = withComplexMagnitudeNormalization(complex(-amplitude), TWO);
    const right = withComplexMagnitudeNormalization(complex(amplitude), TWO);
    const top = withComplexMagnitudeNormalization(complex(0, amplitude), rational(3n));
    const offset = complexFromExact(point(10n ** 309n, -3n * 10n ** 309n));
    const values = [left, right, top].map((value) => complexAdd(value, offset));
    // Cartesian oracle for x=±sqrt(2)*E, y=0 and x=0, y=sqrt(3)*E:
    // symmetry gives center x=0; equating squared distances gives center
    // y=E/(2*sqrt(3)), so every squared boundary radius is (25/12)*E².
    const squaredRadius = multiplyRational(rational(25n, 12n), squaredAmplitude);
    for (const ordering of permutations(values)) {
      const shift = finiteComplexReferenceShift(ordering);
      expect(shift).not.toBeNull();
      const shifted = values.map((value) => complexAdd(value, shift!));
      for (const value of shifted) {
        assertCorrectSqrtRounding(complexMagnitude(value), squaredRadius, "unrelated radicals boundary radius");
        expect(Number.isFinite(complexMagnitude(value))).toBe(true);
      }
      const centerRelativeToOffset = complexAdd(shift!, offset);
      assertCorrectSqrtRounding(complexMagnitude(centerRelativeToOffset),
        multiplyRational(rational(1n, 12n), squaredAmplitude), "unrelated radicals center");
      expect(exactComplexValue(centerRelativeToOffset)!.real.numerator).toBe(0n);
      expect(exactComplexValue(centerRelativeToOffset)!.imaginary.numerator < 0n).toBe(true);
      for (const [first, second, squaredFactor] of [[0, 1, 8n], [0, 2, 5n], [1, 2, 5n]] as const) {
        assertCorrectSqrtRounding(complexMagnitude(complexSubtract(shifted[first]!, shifted[second]!)),
          multiplyRational(rational(squaredFactor), squaredAmplitude), "unrelated radicals voltage control");
      }
    }
  });

  it("rejects a three-point obstruction even when every pair could fit", () => {
    const scale = rationalFromNumber(1e308)!;
    const points = [point(-1.7), point(1.7), point(0, 3)].map((value) => translateAndScale(value, scale));
    for (let first = 0; first < points.length; first += 1) {
      for (let second = 0; second < first; second += 1) {
        expect(compareRational(divideRational(normSquared(difference(points[first]!, points[second]!)), rational(4n)), overflowSquared)).toBe(-1);
      }
    }
    expectOracleShift(points);
    expect(finiteComplexReferenceShift(points.map(complexFromExact))).toBeNull();
  });

  it("checks all original points including a late outlier with its own normalization", () => {
    const amplitude = rationalFromNumber(1e308)!;
    const points = [point(-1), point(1), point(0, 4)].map((value) => translateAndScale(value, amplitude));
    const values = points.slice(0, 2).map(complexFromExact);
    values.push(withComplexMagnitudeNormalization(complexFromExact({ real: ZERO, imaginary: amplitude }), rational(16n)));
    expectOracleShift(points, values);
    expect(finiteComplexReferenceShift(values)).toBeNull();
  });

  it("handles 512 ordered terminals without enumerating every support triple", () => {
    const offset = point(5n * 10n ** 309n, -7n * 10n ** 309n);
    const scale = rationalFromNumber(1e308)!;
    // Rational parametrization of the unit circle, including antipodal points.
    const points = Array.from({ length: 510 }, (_, index) => {
      const parameter = rational(BigInt(index - 255), 64n);
      const denominator = addRational(rational(1n), square(parameter));
      return {
        real: divideRational(subtractRational(rational(1n), square(parameter)), denominator),
        imaginary: divideRational(multiplyRational(TWO, parameter), denominator),
      };
    });
    points.push(point(-1), point(1));
    const transformed = points.map((value) => translateAndScale(value, scale, offset));
    const values = transformed.map(complexFromExact);
    for (const ordering of [values, values.toReversed()]) {
      const shift = finiteComplexReferenceShift(ordering);
      expect(shift).not.toBeNull();
      expectPoint(shift!, { real: negateRational(offset.real), imaginary: negateRational(offset.imaginary) });
      expect(ordering.every((value) => complexMagnitude(complexAdd(value, shift!)) === 1e308)).toBe(true);
    }
  });

  it("does not mutate the array, its values, or normalization metadata", () => {
    const first = withComplexMagnitudeNormalization(complex(1e308, 0), rational(4n));
    const second = complexMultiply(first, complex(0, 1));
    const values = Object.freeze([Object.freeze(first), Object.freeze(second), Object.freeze(complex())]);
    const originals = values.map((value) => ({ ...value }));
    expect(finiteComplexReferenceShift(values)).not.toBeNull();
    expect(values).toEqual(originals);
    expect(complexMagnitude(first)).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns zero for empty input and null for non-finite inputs without retained exact values", () => {
    expect(finiteComplexReferenceShift([])).toEqual(complex());
    for (const invalid of [complex(Number.NaN), complex(Number.POSITIVE_INFINITY), complex(0, Number.NEGATIVE_INFINITY)]) {
      expect(finiteComplexReferenceShift([complex(), invalid])).toBeNull();
    }
  });
});
