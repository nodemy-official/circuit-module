import { expect, it } from "vitest";
import {
  complex, complexAdd, complexDivide, complexFromNormalizedFraction, complexMagnitude, complexMagnitudeNormalization, complexNormalizedFraction,
  complexRectangularValue, withComplexMagnitudeNormalization,
} from "../../analog-math.js";

const makeSum = () => complexAdd(
  withComplexMagnitudeNormalization(complex(1), { numerator: 2n, denominator: 1n }),
  complex(1),
);

it.each(["sum", "fraction"] as const)("isolates a %s's algebraic state from edits to its exported fraction", (kind) => {
  const value = kind === "sum" ? makeSum() : complexDivide(complex(1), makeSum())!;
  // 1 + sqrt(2), and its reciprocal sqrt(2) - 1. These expected values
  // use elementary identities, independently of the normalization helpers.
  const expected = kind === "sum" ? 1 + Math.SQRT2 : Math.SQRT2 - 1;
  const initialMagnitude = complexMagnitude(value);
  expect(initialMagnitude).toBeCloseTo(expected, 15);
  const fraction = complexNormalizedFraction(value)!;
  expect(fraction).toBeDefined();
  const snapshot = structuredClone(fraction);
  for (const terms of [fraction.numerator, fraction.denominator]) {
    for (const term of terms) {
      term.coefficient = { real: { numerator: 10n, denominator: 1n }, imaginary: { numerator: 0n, denominator: 1n } };
      term.squared = { numerator: 3n, denominator: 1n };
    }
    Reflect.set(terms, "0", { coefficient: { real: { numerator: 7n, denominator: 1n }, imaginary: { numerator: 0n, denominator: 1n } }, squared: { numerator: 1n, denominator: 1n } });
  }

  expect(complexNormalizedFraction(value)).toEqual(snapshot);
  expect(complexMagnitude(value)).toBe(initialMagnitude);
  expect(complexRectangularValue(value).real).toBe(value.real);
  expect(complexMagnitude(complexAdd(value, complex(1)))).toBeCloseTo(expected + 1, 15);
});

it("keeps the implicit unit normalization independent of caller edits", () => {
  const unit = complexMagnitudeNormalization(complex(1));
  const original = unit.numerator;
  try {
    Reflect.set(unit, "numerator", 9n);
    // Reading one value's metadata cannot scale unrelated complex numbers.
    expect(complexMagnitude(complex(2))).toBe(2);
  } finally {
    // Keep a deliberately failing regression run from corrupting other tests.
    Reflect.set(unit, "numerator", original);
  }
});

it("retains the input fraction's coefficients and radicals at construction time", () => {
  const term = (squared: bigint) => ({
    coefficient: { real: { numerator: 1n, denominator: 1n }, imaginary: { numerator: 0n, denominator: 1n } },
    squared: { numerator: squared, denominator: 1n },
  });
  const input = { numerator: [term(2n)], denominator: [term(3n), term(5n)] };
  const expected = Math.sqrt(2) / (Math.sqrt(3) + Math.sqrt(5));
  const value = complexFromNormalizedFraction(input);
  expect(value.real).toBeCloseTo(expected, 15);
  const captured = complexNormalizedFraction(value);

  input.numerator[0]!.coefficient.real.numerator = 10n;
  input.numerator[0]!.squared.numerator = 7n;
  input.denominator[0]!.coefficient.imaginary.numerator = 2n;
  input.denominator[1]!.squared.denominator = 11n;

  expect(complexNormalizedFraction(value)).toEqual(captured);
  expect(complexMagnitude(value)).toBeCloseTo(expected, 15);
  expect(complexRectangularValue(value).real).toBeCloseTo(expected, 15);
  expect(complexMagnitude(complexAdd(value, complex(1)))).toBeCloseTo(expected + 1, 15);
});
