import { describe, expect, it } from "vitest";

import {
  complex,
  complexDivide,
  complexMultiply,
  scaledProduct,
  solveComplexLinearSystem,
  solveRealLinearSystem,
} from "./analog-math.js";

describe("complexMultiply", () => {
  it("adds tiny power contributions before rounding to subnormal units", () => {
    const value = complex(1.4e-162, 1.4e-162);
    const power = complexMultiply(value, complex(value.real, -value.imaginary));
    expect(power.real).toBe(Number.MIN_VALUE);
    expect(power.imaginary).toBe(0);
    const rotated = complexMultiply(value, value);
    expect(rotated.real).toBe(0);
    expect(rotated.imaginary).toBe(Number.MIN_VALUE);
  });

  it("retains a tiny real result after cancellation of subnormal products", () => {
    const value = complex(2.6e-162, 1.6e-162);
    const square = complexMultiply(value, value);

    expect(square.real).toBe(Number.MIN_VALUE);
    expect(square.imaginary).toBe(2 * Number.MIN_VALUE);
  });
});

describe("scaledProduct", () => {
  it("rounds a subnormal energy only after applying all factors", () => {
    expect(scaledProduct([0.5, Number.MIN_VALUE, 1.5, 1.5])).toBe(Number.MIN_VALUE);
    expect(scaledProduct([1.5, 1.5, Number.MIN_VALUE, 0.5])).toBe(Number.MIN_VALUE);
    expect(scaledProduct([Number.MIN_VALUE, 1.5, 1.5])).toBe(2 * Number.MIN_VALUE);
  });

  it("preserves products across intermediate overflow and underflow", () => {
    expect(scaledProduct([1e300, 1e300, 1e-300, 1e-300])).toBeCloseTo(1, 14);
    expect(scaledProduct([1e-300, 1e-300, 1e300, 1e300])).toBeCloseTo(1, 14);
    expect(scaledProduct([0.5, 1e-200, -1e200, -1e200]) / 5e199).toBeCloseTo(1, 14);
  });

  it("preserves zero, sign, and genuine numeric range limits", () => {
    expect(scaledProduct([Number.MAX_VALUE, 2, 0])).toBe(0);
    expect(scaledProduct([-2, 3, 4])).toBe(-24);
    expect(scaledProduct([Number.MAX_VALUE, 2])).toBe(Number.POSITIVE_INFINITY);
    expect(scaledProduct([Number.MIN_VALUE, 0.5])).toBe(0);
    expect(scaledProduct([Number.MIN_VALUE, 1.5])).toBe(2 * Number.MIN_VALUE);
    expect(scaledProduct([Number.NaN])).toBeNaN();
  });
});

describe("complexDivide", () => {
  it("rounds a subnormal quotient only after applying its normalized component", () => {
    // (m + mi) / (1 + 2i) = 3m/5 - mi/5, which rounds to m + 0i.
    const minimum = Number.MIN_VALUE;
    const quotient = complexDivide(complex(minimum, minimum), complex(1, 2));
    expect(quotient.real).toBe(minimum);
    expect(quotient.imaginary === 0).toBe(true);
    const rotated = complexDivide(complex(-minimum, minimum), complex(1, 2));
    expect(rotated.real === 0).toBe(true);
    expect(rotated.imaginary).toBe(minimum);
  });

  it.each([1, 1e-200, 1e200, Number.MAX_VALUE])(
    "preserves a finite quotient when both operands have scale %s",
    (scale) => {
      const quotient = complexDivide(complex(scale, scale), complex(scale, -scale));

      expect(quotient.real).toBeCloseTo(0, 14);
      expect(quotient.imaginary).toBeCloseTo(1, 14);
    },
  );

  it("does not overflow an intermediate sum for a representable quotient", () => {
    const scale = Number.MAX_VALUE;
    const quotient = complexDivide(complex(scale, scale), complex(0.5 * scale, scale));

    expect(quotient.real).toBeCloseTo(1.2, 14);
    expect(quotient.imaginary).toBeCloseTo(-0.4, 14);
  });

  it("preserves finite components when the ratio of operand scales overflows", () => {
    const quotient = complexDivide(complex(1e308, 1e308), complex(0.5, 0.5));

    expect(quotient.real).toBe(Number.POSITIVE_INFINITY);
    expect(quotient.imaginary).toBe(0);
  });

  it("keeps both components finite when the intermediate scale ratio overflows", () => {
    const quotient = complexDivide(complex(Number.MAX_VALUE), complex(0.75, 0.75));

    expect(quotient.real / Number.MAX_VALUE).toBeCloseTo(2 / 3, 14);
    expect(quotient.imaginary / Number.MAX_VALUE).toBeCloseTo(-2 / 3, 14);
  });

  it("preserves a small component when the divisor components span the floating-point range", () => {
    const quotient = complexDivide(complex(1e308), complex(1e100, 1e-250));
    const rotated = complexDivide(complex(1e308), complex(1e-250, 1e100));

    expect(quotient.real / 1e208).toBeCloseTo(1, 14);
    expect(quotient.imaginary / -1e-142).toBeCloseTo(1, 14);
    expect(rotated.real / 1e-142).toBeCloseTo(1, 14);
    expect(rotated.imaginary / -1e208).toBeCloseTo(1, 14);
  });

  it("divides independently by a real divisor without discarding a small numerator component", () => {
    const quotient = complexDivide(complex(1e308, 1e-250), complex(1e-100));

    expect(quotient.real).toBe(Number.POSITIVE_INFINITY);
    expect(quotient.imaginary / 1e-150).toBeCloseTo(1, 14);
  });

  it("preserves normal quotient components when the normalized divisor is subnormal", () => {
    const quotient = complexDivide(complex(1e308), complex(1e100, 1e-220));
    const rotated = complexDivide(complex(1e308), complex(1e-220, 1e100));

    expect(quotient.real / 1e208).toBeCloseTo(1, 14);
    expect(quotient.imaginary / -1e-112).toBeCloseTo(1, 14);
    expect(rotated.real / 1e-112).toBeCloseTo(1, 14);
    expect(rotated.imaginary / -1e208).toBeCloseTo(1, 14);
  });

  it("retains a finite minor component even when the dominant quotient overflows", () => {
    const quotient = complexDivide(complex(1e308), complex(1e-15, Number.MIN_VALUE));
    const expectedImaginary = -(1e308 * Number.MIN_VALUE) / 1e-15 / 1e-15;

    expect(quotient.real).toBe(Number.POSITIVE_INFINITY);
    expect(quotient.imaginary / expectedImaginary).toBeCloseTo(1, 14);
  });

  it("divides independently by an imaginary divisor", () => {
    const quotient = complexDivide(complex(1e308, 1e-250), complex(0, 1e-100));

    expect(quotient.real / 1e-150).toBeCloseTo(1, 14);
    expect(quotient.imaginary).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("solveRealLinearSystem", () => {
  it.each([1, 1e-200, 1e200])("solves the same equations at scale %s", (scale) => {
    // x + 2y = 5, 3x + 4y = 11 has x = 1, y = 2, independent of units.
    const solution = solveRealLinearSystem(
      2,
      Float64Array.from([1, 2, 3, 4], (value) => value * scale),
      Float64Array.from([5, 11], (value) => value * scale),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0]).toBeCloseTo(1, 12);
    expect(solution?.[1]).toBeCloseTo(2, 12);
  });

  it("pivots past a zero diagonal", () => {
    const solution = solveRealLinearSystem(2, new Float64Array([0, 2, 1, 3]), new Float64Array([4, 7]));

    expect(Array.from(solution ?? [])).toEqual([1, 2]);
  });

  it("scales badly scaled rows before pivoting to preserve a small solution component", () => {
    // The exact binary64 input has x = 1 + 1e-20 and y = 1 - 1e-20.
    // Unscaled elimination loses x when subtracting two values near 1e20.
    const solution = solveRealLinearSystem(
      2,
      new Float64Array([1, 1e20, 1, 1]),
      new Float64Array([1e20, 2]),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0]).toBeCloseTo(1, 14);
    expect(solution?.[1]).toBeCloseTo(1, 14);
    const x = solution?.[0] ?? Number.NaN;
    const y = solution?.[1] ?? Number.NaN;
    const rowResiduals = [x + 1e20 * y - 1e20, x + y - 2];
    const rowScales = [Math.abs(x) + 1e20 * Math.abs(y) + 1e20, Math.abs(x) + Math.abs(y) + 2];
    expect(rowResiduals.every((residual, row) =>
      Math.abs(residual) / (rowScales[row] ?? Number.POSITIVE_INFINITY) < 1e-15
    )).toBe(true);
  });

  it("preserves nonzero subnormal coefficients that affect a finite solution", () => {
    const minimum = Number.MIN_VALUE;
    const rhs = [
      1e308 * 1e-308 + minimum * 1e308,
      1e308 * 1e-308 + (2 * minimum) * 1e308,
    ];
    const solution = solveRealLinearSystem(
      2,
      new Float64Array([1e308, minimum, 1e308, 2 * minimum]),
      new Float64Array(rhs),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0]).toBe(1e-308);
    expect(solution?.[1]).toBe(2 ** 1023);
    expect(1e308 * (solution?.[0] ?? 0) + minimum * (solution?.[1] ?? 0)).toBe(rhs[0]);
    expect(1e308 * (solution?.[0] ?? 0) + (2 * minimum) * (solution?.[1] ?? 0)).toBe(rhs[1]);
  });

  it("solves sparse rows across subnormal, normal, and extreme scales", () => {
    const minimum = Number.MIN_VALUE;
    const solution = solveRealLinearSystem(
      3,
      new Float64Array([minimum, 0, 0, 0, 1e308, 0, 0, 0, 3]),
      new Float64Array([2 * minimum, 1, 12]),
    );

    expect(Array.from(solution ?? [])).toEqual([2, 1e-308, 4]);
  });

  it("rejects a singular system", () => {
    expect(solveRealLinearSystem(2, new Float64Array([1, 2, 2, 4]), new Float64Array([5, 10]))).toBeNull();
  });

  it("still rejects an exactly singular system after extreme row scaling", () => {
    expect(solveRealLinearSystem(
      2,
      new Float64Array([1e308, 5e307, 5e307, 2.5e307]),
      new Float64Array([1e308, 5e307]),
    )).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects a nonfinite coefficient %s", (value) => {
    expect(solveRealLinearSystem(1, new Float64Array([value]), new Float64Array([1]))).toBeNull();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects a nonfinite right-hand side %s", (value) => {
    expect(solveRealLinearSystem(1, new Float64Array([1]), new Float64Array([value]))).toBeNull();
  });

  it("rejects a solution that overflows", () => {
    expect(solveRealLinearSystem(1, new Float64Array([1e-10]), new Float64Array([1e308]))).toBeNull();
  });

  it("rejects incomplete dimensions instead of returning invented zero entries", () => {
    expect(solveRealLinearSystem(1, new Float64Array([1]), new Float64Array())).toBeNull();
  });

  it("supports an empty system", () => {
    expect(solveRealLinearSystem(0, new Float64Array(), new Float64Array())).toEqual(new Float64Array());
  });
});

describe("solveComplexLinearSystem", () => {
  it.each([1, 1e-200, 1e200])("solves the same complex equations at scale %s", (scale) => {
    // A = [[0, 1+i], [2-i, 3]], x = [1+i, 2-i], b = [3+i, 9-2i].
    const solution = solveComplexLinearSystem(
      2,
      Float64Array.from([0, 1, 2, 3], (value) => value * scale),
      Float64Array.from([0, 1, -1, 0], (value) => value * scale),
      Float64Array.from([3, 9], (value) => value * scale),
      Float64Array.from([1, -2], (value) => value * scale),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0].real).toBeCloseTo(1, 12);
    expect(solution?.[0].imaginary).toBeCloseTo(1, 12);
    expect(solution?.[1].real).toBeCloseTo(2, 12);
    expect(solution?.[1].imaginary).toBeCloseTo(-1, 12);
  });

  it("rejects a singular complex system", () => {
    expect(solveComplexLinearSystem(
      2,
      new Float64Array([1, 2, 2, 4]),
      new Float64Array([1, 2, 2, 4]),
      new Float64Array([3, 6]),
      new Float64Array([3, 6]),
    )).toBeNull();
  });

  it("rejects incomplete dimensions", () => {
    expect(solveComplexLinearSystem(
      1,
      new Float64Array([1]),
      new Float64Array(),
      new Float64Array([1]),
      new Float64Array([0]),
    )).toBeNull();
  });

  it("scales complex rows before pivoting to preserve a small solution component", () => {
    const solution = solveComplexLinearSystem(
      2,
      new Float64Array([1, 1e20, 1, 1]),
      new Float64Array([0, 0, 0, 0]),
      new Float64Array([1e20, 2]),
      new Float64Array([0, 0]),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0].real).toBeCloseTo(1, 14);
    expect(solution?.[1].real).toBeCloseTo(1, 14);
    expect(solution?.[0].imaginary === 0).toBe(true);
    expect(solution?.[1].imaginary === 0).toBe(true);
    const x = solution?.[0].real ?? Number.NaN;
    const y = solution?.[1].real ?? Number.NaN;
    expect(Math.abs(x + 1e20 * y - 1e20) / (Math.abs(x) + 1e20 * Math.abs(y) + 1e20)).toBeLessThan(1e-15);
    expect(Math.abs(x + y - 2) / (Math.abs(x) + Math.abs(y) + 2)).toBeLessThan(1e-15);
  });

  it("preserves complex subnormal coefficients that affect a finite solution", () => {
    const minimum = Number.MIN_VALUE;
    const rhs = [
      1e308 * 1e-308 + minimum * 1e308,
      1e308 * 1e-308 + (2 * minimum) * 1e308,
    ];
    const solution = solveComplexLinearSystem(
      2,
      new Float64Array([0, 0, 0, 0]),
      new Float64Array([1e308, minimum, 1e308, 2 * minimum]),
      new Float64Array([0, 0]),
      new Float64Array(rhs),
    );

    expect(solution).not.toBeNull();
    expect(solution?.[0].real).toBe(1e-308);
    expect(solution?.[1].real).toBe(2 ** 1023);
    expect(solution?.[0].imaginary === 0).toBe(true);
    expect(solution?.[1].imaginary === 0).toBe(true);
    expect(1e308 * (solution?.[0].real ?? 0) + minimum * (solution?.[1].real ?? 0)).toBe(rhs[0]);
    expect(1e308 * (solution?.[0].real ?? 0) + (2 * minimum) * (solution?.[1].real ?? 0)).toBe(rhs[1]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects nonfinite inputs %s", (value) => {
    expect(solveComplexLinearSystem(
      1,
      new Float64Array([1]),
      new Float64Array([0]),
      new Float64Array([value]),
      new Float64Array([0]),
    )).toBeNull();
  });
});
