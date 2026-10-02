import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import {
  complex, complexAdd, complexFromPolar, complexMagnitude, complexMultiply, complexRectangularValue,
  complexSubtract, withComplexMagnitudeNormalization,
} from "../../analog-math.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitTerminal } from "../../circuit-model.js";
import { exactRationalMagnitudeExponent, floorExactRationalSquareRootWithRelativeError } from "../../exact-linear-algebra.js";
import { exactComplexValue } from "../../exact-numeric-state.js";
import {
  addRational, assertCorrectRounding, assertCorrectSqrtRounding, compareRational,
  divideRational, multiplyRational, negateRational, rational, rationalFromNumber,
  subtractRational, type Rational,
} from "../helpers/numeric-oracle.js";

const ONE = rational(1n);
const square = (value: Rational) => multiplyRational(value, value);
const binaryPower = (exponent: number) => exponent < 0
  ? rational(1n, 2n ** BigInt(-exponent)) : rational(2n ** BigInt(exponent));
const exactNumber = (value: number) => rationalFromNumber(value)!;

function nearAxisDifferenceBounds(amplitude: number, firstDegrees: number, secondDegrees: number) {
  const radians = (degrees: number) => divideRational(multiplyRational(exactNumber(degrees), exactNumber(Math.PI)), rational(180n));
  const first = radians(firstDegrees);
  const second = radians(secondDegrees);
  const upperSquared = square(multiplyRational(exactNumber(amplitude), subtractRational(first, second)));
  // The normalized directions are (1,t)/sqrt(1+t²). Their chord is at
  // most |t-u| and at least |sin(atan(t)-atan(u))|.
  const lowerSquared = divideRational(upperSquared,
    multiplyRational(addRational(ONE, square(first)), addRational(ONE, square(second))));
  return { lowerSquared, upperSquared, first };
}

const part = (id: string, kind: CircuitPart["kind"], values: Partial<CircuitPart> = {}): CircuitPart => ({
  id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
});
const wire = (id: string, from: string, fromTerminal: CircuitTerminal, to: string, toTerminal: CircuitTerminal) => ({
  id, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal },
});

describe("adaptive amplitude normalization precision", () => {
  it("certifies square-root errors independently across magnitudes and distances from one", () => {
    function verifySquareRootBounds(input: Rational, relativeBits: number, absoluteExponent?: number) {
      const result = floorExactRationalSquareRootWithRelativeError(input, relativeBits, absoluteExponent);
      expect(result).not.toBeNull();
      if (!result) { return; }
      const squared = square(result);
      expect(compareRational(squared, input)).toBeLessThanOrEqual(0);
      const epsilon = binaryPower(-relativeBits);
      // result >= (1-epsilon)*sqrt(input), tested by squaring rational values.
      expect(compareRational(squared, multiplyRational(square(subtractRational(ONE, epsilon)), input)))
        .toBeGreaterThanOrEqual(0);
      if (compareRational(input, ONE) !== 0) {
        // Isolate sqrt(input) in the relative bound on its departure from one.
        const upperRoot = compareRational(input, ONE) < 0
          ? divideRational(addRational(result, epsilon), addRational(ONE, epsilon))
          : divideRational(subtractRational(result, epsilon), subtractRational(ONE, epsilon));
        expect(compareRational(input, square(upperRoot))).toBeLessThanOrEqual(0);
      }
      if (absoluteExponent !== undefined) {
        expect(compareRational(input, square(addRational(result, binaryPower(absoluteExponent)))))
          .toBeLessThanOrEqual(0);
      }
    }
    for (const relativeBits of [53, 512]) {
      for (const exponent of [-2400, -1200, -600, 0, 600, 1200, 2400]) {
        verifySquareRootBounds(multiplyRational(rational(3n, 2n), binaryPower(exponent)), relativeBits);
      }
      for (const exponent of [-4000, -2200, -1024, -512, -60]) {
        const gap = binaryPower(exponent);
        verifySquareRootBounds(addRational(ONE, gap), relativeBits);
        verifySquareRootBounds(subtractRational(ONE, gap), relativeBits);
      }
    }
    verifySquareRootBounds(rational(2n), 53, -4000);
    expect(floorExactRationalSquareRootWithRelativeError(rational(0n), 512)).toEqual(rational(0n));
    for (const bits of [0, 1, 2.5, Number.NaN]) {
      expect(floorExactRationalSquareRootWithRelativeError(ONE, bits)).toBeNull();
    }
    expect(floorExactRationalSquareRootWithRelativeError(rational(-1n), 512)).toBeNull();
    expect(floorExactRationalSquareRootWithRelativeError(ONE, 512, Number.POSITIVE_INFINITY)).toBeNull();
    expect(floorExactRationalSquareRootWithRelativeError(rational(1n, 9n), 53)).toEqual(rational(1n, 3n));
    expect(floorExactRationalSquareRootWithRelativeError({ numerator: 2n, denominator: 18n }, 53)).toEqual(rational(1n, 3n));
  });

  it("extracts rational exponents without projecting to binary64", () => {
    for (const exponent of [-4000, -1075, -1, 0, 1024, 4000]) {
      const value = multiplyRational(rational(3n, 2n), binaryPower(exponent));
      expect(exactRationalMagnitudeExponent(value)).toBe(exponent);
      expect(exactRationalMagnitudeExponent(negateRational(value))).toBe(exponent);
    }
    expect(exactRationalMagnitudeExponent(rational(0n))).toBeNull();
    expect(exactRationalMagnitudeExponent({ numerator: 1n, denominator: 0n })).toBeNull();
  });

  it.each([Number.MIN_VALUE, -Number.MIN_VALUE, 1e-200, -1e-200, 1e-100, -1e-100])(
    "preserves the chord and its radial component for phase %s degrees", (degrees) => {
      const amplitude = 2 ** 512;
      const value = complexFromPolar(amplitude, degrees);
      for (const secondDegrees of [0, degrees * 2, -degrees]) {
        const difference = complexSubtract(value, complexFromPolar(amplitude, secondDegrees));
        const bounds = nearAxisDifferenceBounds(amplitude, degrees, secondDegrees);
        assertCorrectSqrtRounding(complexMagnitude(difference), bounds.lowerSquared, "chord lower bound");
        assertCorrectSqrtRounding(complexMagnitude(difference), bounds.upperSquared, "chord upper bound");
      }
      const difference = complexSubtract(value, complex(amplitude));
      const { first } = nearAxisDifferenceBounds(amplitude, degrees, 0);
      const upperRadial = divideRational(multiplyRational(exactNumber(amplitude), square(first)), rational(2n));
      const lowerRadial = divideRational(upperRadial, addRational(ONE, square(first)));
      assertCorrectRounding(difference.real, negateRational(upperRadial), "radial upper bound");
      assertCorrectRounding(difference.real, negateRational(lowerRadial), "radial lower bound");
      expect(exactComplexValue(difference)?.real.numerator).not.toBe(0n);
    },
  );

  it("refines cached roots for arbitrarily close mixed corrections", () => {
    const amplitude = 2 ** 1000;
    const first = rational(2n);
    const gap = binaryPower(-2000);
    const second = addRational(first, gap);
    const left = withComplexMagnitudeNormalization(complex(amplitude), first);
    const right = withComplexMagnitudeNormalization(complex(amplitude), second);
    complexRectangularValue(left);
    complexRectangularValue(right);
    const difference = complexSubtract(left, right);
    // sqrt(second)-sqrt(first) = gap/(sqrt(second)+sqrt(first)).
    const numerator = square(multiplyRational(exactNumber(amplitude), gap));
    const lowerSquared = divideRational(numerator, multiplyRational(rational(4n), second));
    const upperSquared = divideRational(numerator, multiplyRational(rational(4n), first));
    expect(difference.real).toBeLessThan(0);
    assertCorrectSqrtRounding(complexMagnitude(difference), lowerSquared, "mixed correction lower bound");
    assertCorrectSqrtRounding(complexMagnitude(difference), upperSquared, "mixed correction upper bound");
    const exactCancellation = complexSubtract(
      withComplexMagnitudeNormalization(complex(2), rational(2n)),
      withComplexMagnitudeNormalization(complex(1, 1), rational(8n)),
    );
    expect(exactCancellation.real).toBe(0);
    assertCorrectSqrtRounding(-exactCancellation.imaginary, rational(8n), "noncancelled imaginary component");
  });

  it("keeps finite values when correction roots are below the old fractional grid", () => {
    const value = withComplexMagnitudeNormalization(complex(2 ** 600), binaryPower(-1200));
    expect(complexRectangularValue(value)).toEqual(complex(1));
    expect(complexAdd(value, complex(1))).toEqual(complex(2));
  });

  it("keeps rational normalization roots exact at binary64 midpoint ties", () => {
    const diagonal = complexFromPolar(1, 45);
    const rotatedSquare = complexMultiply(complexMultiply(diagonal, diagonal), complex(0, -1));
    const rationalCorrection = withComplexMagnitudeNormalization(complex(3), rational(1n, 9n));
    for (const value of [rotatedSquare, rationalCorrection]) {
      for (const numerator of [1n, 3n, 5n]) {
        const offset = Number(numerator) * 2 ** -53;
        const expected = addRational(ONE, rational(numerator, 2n ** 53n));
        const result = complexAdd(value, complex(offset));
        assertCorrectRounding(result.real, expected, "exact rational correction midpoint");
        expect(compareRational(exactComplexValue(result)!.real, expected)).toBe(0);
      }
    }
  });

  it.each([Number.MIN_VALUE, 1, 2 ** 512, Number.MAX_VALUE])(
    "preserves amplitude %s with large and diagonal phase inputs", (amplitude) => {
      for (const degrees of [45, -45, 135, -135, Number.MAX_VALUE, -Number.MAX_VALUE, 1e200, -1e200]) {
        const value = complexFromPolar(amplitude, degrees);
        expect(complexMagnitude(value)).toBe(amplitude);
        expect(complexMagnitude(complexRectangularValue(value))).toBe(amplitude);
      }
    },
  );

  it.each([1, 2 ** 512])("preserves the local AC response on a common mode of %s volts", (amplitude) => {
    const degrees = 1e-200;
    const document: CircuitDocument = {
      title: "Mixed normalization common mode",
      parts: [
        part("first", "ac-source", { voltageVolts: amplitude, phaseDegrees: degrees, frequencyHz: 1 }),
        part("second", "ac-source", { voltageVolts: amplitude, phaseDegrees: 0, frequencyHz: 1 }),
        part("load", "resistor", { resistanceOhms: 1 }), part("ground", "ground"),
      ],
      wires: [
        wire("1", "first", "a", "load", "a"), wire("2", "second", "a", "load", "b"),
        wire("3", "first", "b", "ground", "a"), wire("4", "second", "b", "ground", "a"),
      ],
    };
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz: 1 });
    expect(result.status, result.message).toBe("valid");
    const bounds = nearAxisDifferenceBounds(amplitude, degrees, 0);
    for (const value of [result.parts.load.voltage, result.parts.load.current]) {
      assertCorrectSqrtRounding(complexMagnitude(value), bounds.lowerSquared, "AC response lower bound");
      assertCorrectSqrtRounding(complexMagnitude(value), bounds.upperSquared, "AC response upper bound");
    }
  });
});
