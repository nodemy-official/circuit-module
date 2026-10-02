import { describe, expect, it } from "vitest";

import {
  complex,
  complexAdd,
  complexConjugate,
  complexDivide,
  complexMagnitude,
  complexMultiply,
  complexSubtract,
  exactComponentSum,
  exactProductSumQuotient as productionProductSumQuotient,
  scaledProduct,
} from "../../analog-math.js";
import {
  addRational,
  assertCorrectRounding,
  assertCorrectSqrtRounding,
  compareRational,
  createSeededRandom,
  divideRational,
  finiteNumbersAcrossExponentFields,
  multiplyRational,
  midpointRational,
  negateRational,
  nextUp,
  randomFiniteNumber,
  rational,
  rationalFromNumber,
  subtractRational,
  type Rational,
} from "../helpers/numeric-oracle.js";

const seed = 0x6e756d6572696321n;

function exactNumber(value: number): Rational {
  const result = rationalFromNumber(value);
  if (!result) { throw new Error(`Test input must be finite: ${String(value)}`); }
  return result;
}

function exactSum(values: readonly number[]) {
  return values.reduce((sum, value) => addRational(sum, exactNumber(value)), rational(0n));
}

function exactProduct(values: readonly number[]) {
  return values.reduce((product, value) => multiplyRational(product, exactNumber(value)), rational(1n));
}

function oracleProductSumQuotient(
  terms: readonly { factors: readonly number[]; sign?: 1 | -1 }[],
  denominator: number,
) {
  const total = terms.reduce((sum, term) => {
    const product = exactProduct(term.factors);
    return addRational(sum, term.sign === -1 ? negateRational(product) : product);
  }, rational(0n));
  return divideRational(total, exactNumber(denominator));
}

function complexInputs() {
  const nextBits = createSeededRandom(seed);
  const inputs: Array<readonly [number, number, number, number]> = [];
  for (let index = 0; index < 96; index += 1) {
    inputs.push([
      randomFiniteNumber(nextBits),
      randomFiniteNumber(nextBits),
      randomFiniteNumber(nextBits),
      randomFiniteNumber(nextBits),
    ]);
  }
  inputs.push(
    [1.4e154, 5e153, 1.4e154, 5e153],
    [1e154, 1e154, 1e-154, 1.000_000_000_000_000_1e-154],
    [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
    [Number.MIN_VALUE, Number.MIN_VALUE, 1, 2],
    [1e308, 1e-250, 1e-100, 1e100],
    [-Number.MIN_VALUE, Number.MIN_VALUE, 1e200, -1e200],
  );
  return inputs;
}

describe("independent BigInt numeric contracts", () => {
  it("self-checks midpoint, underflow, and overflow decisions in the oracle", () => {
    const one = exactNumber(1);
    const adjacent = nextUp(1);
    const tie = midpointRational(one, exactNumber(adjacent));

    assertCorrectRounding(1, tie, "ties-to-even accepts the even lower candidate");
    expect(() => assertCorrectRounding(adjacent, tie, "ties-to-even rejects odd candidate"))
      .toThrow();
    expect(() => assertCorrectRounding(adjacent, one, "oracle rejects adjacent-float error"))
      .toThrow();
    expect(() => assertCorrectRounding(0, exactNumber(Number.MIN_VALUE), "oracle rejects lost subnormal"))
      .toThrow();
    expect(() => assertCorrectRounding(
      Number.POSITIVE_INFINITY,
      exactNumber(Number.MAX_VALUE),
      "oracle rejects premature infinity",
    )).toThrow();
    expect(() => assertCorrectRounding(
      Number.MAX_VALUE,
      multiplyRational(exactNumber(Number.MAX_VALUE), rational(2n)),
      "oracle rejects finite result after overflow threshold",
    )).toThrow();
  });

  it("rounds exact component sums correctly across the full binary64 exponent range", () => {
    const nextBits = createSeededRandom(seed);
    const exponentSamples = finiteNumbersAcrossExponentFields(nextBits);
    const generatedVectors = Array.from({ length: 96 }, () => {
      const length = 3 + Number(nextBits() % 6n);
      return Array.from({ length }, () => randomFiniteNumber(nextBits));
    });
    const directedVectors = [
      [1e308, Number.MIN_VALUE, -1e308],
      [Number.MAX_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE],
      [2 ** 53, 1, -(2 ** 53)],
      [Number.MIN_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE],
      [Number.MAX_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
      [-Number.MAX_VALUE, -Number.MAX_VALUE, -Number.MAX_VALUE],
    ];

    for (const [index, value] of exponentSamples.entries()) {
      assertCorrectRounding(
        exactComponentSum([value, Number.MIN_VALUE, -value]),
        exactNumber(Number.MIN_VALUE),
        `sum cancellation at exponent field ${String(index)}`,
      );
    }
    for (const [index, values] of [...generatedVectors, ...directedVectors].entries()) {
      assertCorrectRounding(
        exactComponentSum(values),
        exactSum(values),
        `generated component sum ${String(index)}`,
      );
    }
  });

  it("rounds completed products once, including intermediate overflow and underflow", () => {
    const nextBits = createSeededRandom(0x50524f44554354n);
    const exponentSamples = finiteNumbersAcrossExponentFields(nextBits);
    const generatedProducts = Array.from({ length: 96 }, () => {
      const length = 3 + Number(nextBits() % 4n);
      return Array.from({ length }, () => randomFiniteNumber(nextBits));
    });
    const directedProducts = [
      [Number.MAX_VALUE, Number.MAX_VALUE, 1 / Number.MAX_VALUE, 1 / Number.MAX_VALUE],
      [Number.MIN_VALUE, Number.MIN_VALUE, Number.MAX_VALUE, Number.MAX_VALUE],
      [Number.MIN_VALUE, 0.5, 1.5, 1.5],
      [0.5, 1e-200, -1e200, -1e200],
      [Number.MAX_VALUE, 2, 0],
      [Number.MIN_VALUE, 0.5],
    ];

    for (const [index, value] of exponentSamples.entries()) {
      const exponentField = index;
      const scale = 2 ** (1023 - exponentField);
      const factors = [value, scale, 1.5, 0.5];
      assertCorrectRounding(
        scaledProduct(factors),
        exactProduct(factors),
        `product across exponent field ${String(index)}`,
      );
    }
    for (const [index, factors] of [...generatedProducts, ...directedProducts].entries()) {
      assertCorrectRounding(
        scaledProduct(factors),
        exactProduct(factors),
        `generated product ${String(index)}`,
      );
    }
  });

  it("rounds exact product sums and quotients after cancellation and range recovery", () => {
    const nextBits = createSeededRandom(0x51554f5449454e54n);
    const exponentSamples = finiteNumbersAcrossExponentFields(nextBits);
    const generatedExpressions = Array.from({ length: 72 }, () => {
      const termCount = 2 + Number(nextBits() % 4n);
      const terms = Array.from({ length: termCount }, () => {
        const factorCount = 1 + Number(nextBits() % 4n);
        return {
          factors: Array.from({ length: factorCount }, () => randomFiniteNumber(nextBits)),
          sign: nextBits() % 2n === 0n ? 1 as const : -1 as const,
        };
      });
      const denominator = randomFiniteNumber(nextBits);
      return { terms, denominator: denominator === 0 ? 1 : denominator };
    });
    const directedExpressions = [
      {
        terms: [
          { factors: [Number.MAX_VALUE, Number.MAX_VALUE] },
          { factors: [Number.MAX_VALUE, Number.MAX_VALUE], sign: -1 as const },
          { factors: [Number.MAX_VALUE, Number.MIN_VALUE] },
        ],
        denominator: Number.MIN_VALUE,
      },
      {
        terms: [{ factors: [Number.MIN_VALUE, Number.MIN_VALUE] }],
        denominator: Number.MIN_VALUE,
      },
      {
        terms: [
          { factors: [1e308, 1e308] },
          { factors: [1e308, 1e308], sign: -1 as const },
          { factors: [Number.MIN_VALUE] },
        ],
        denominator: 1,
      },
    ];

    for (const [index, value] of exponentSamples.entries()) {
      const scale = 2 ** (1023 - index);
      const terms = [
        { factors: [value, scale] },
        { factors: [value, scale], sign: -1 as const },
        { factors: [Number.MIN_VALUE, 3] },
      ];
      const expected = oracleProductSumQuotient(terms, 3);
      assertCorrectRounding(
        productionProductSumQuotient(terms, 3),
        expected,
        `generated quotient at exponent field ${String(index)}`,
      );
    }
    for (const [index, expression] of [...generatedExpressions, ...directedExpressions].entries()) {
      const expected = oracleProductSumQuotient(expression.terms, expression.denominator);
      assertCorrectRounding(
        productionProductSumQuotient(expression.terms, expression.denominator),
        expected,
        `generated product-sum quotient ${String(index)}`,
      );
    }
  });

  it("checks complex arithmetic and magnitudes against exact rational results", () => {
    for (const [index, [leftReal, leftImaginary, rightReal, rightImaginary]] of complexInputs().entries()) {
      const left = complex(leftReal, leftImaginary);
      const right = complex(rightReal, rightImaginary);
      const a = exactNumber(leftReal);
      const b = exactNumber(leftImaginary);
      const c = exactNumber(rightReal);
      const d = exactNumber(rightImaginary);
      const label = `complex input ${String(index)}`;

      const added = complexAdd(left, right);
      assertCorrectRounding(added.real, addRational(a, c), `${label} addition real`);
      assertCorrectRounding(added.imaginary, addRational(b, d), `${label} addition imaginary`);

      const subtracted = complexSubtract(left, right);
      assertCorrectRounding(subtracted.real, subtractRational(a, c), `${label} subtraction real`);
      assertCorrectRounding(subtracted.imaginary, subtractRational(b, d), `${label} subtraction imaginary`);

      const multiplied = complexMultiply(left, right);
      const multiplyReal = subtractRational(multiplyRational(a, c), multiplyRational(b, d));
      const multiplyImaginary = addRational(multiplyRational(a, d), multiplyRational(b, c));
      assertCorrectRounding(multiplied.real, multiplyReal, `${label} multiplication real`);
      assertCorrectRounding(multiplied.imaginary, multiplyImaginary, `${label} multiplication imaginary`);

      const denominator = addRational(multiplyRational(c, c), multiplyRational(d, d));
      const divided = complexDivide(left, right);
      if (compareRational(denominator, rational(0n)) === 0) {
        if (!Number.isNaN(divided.real) || !Number.isNaN(divided.imaginary)) {
          throw new Error(`${label}: division by exact zero must return NaN components`);
        }
      } else {
        const divideReal = divideRational(
          addRational(multiplyRational(a, c), multiplyRational(b, d)),
          denominator,
        );
        const divideImaginary = divideRational(
          subtractRational(multiplyRational(b, c), multiplyRational(a, d)),
          denominator,
        );
        assertCorrectRounding(divided.real, divideReal, `${label} division real`);
        assertCorrectRounding(divided.imaginary, divideImaginary, `${label} division imaginary`);
      }

      const conjugated = complexConjugate(left);
      assertCorrectRounding(conjugated.real, a, `${label} conjugation real`);
      assertCorrectRounding(conjugated.imaginary, negateRational(b), `${label} conjugation imaginary`);

      const magnitudeSquared = addRational(multiplyRational(a, a), multiplyRational(b, b));
      assertCorrectSqrtRounding(complexMagnitude(left), magnitudeSquared, `${label} magnitude`);
    }
  });
});
