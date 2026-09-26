import { describe, expect, it } from "vitest";

import {
  complex,
  complexDivide,
  solveComplexLinearSystem,
  solveRealLinearSystem,
} from "./analog-math.js";

describe("complexDivide", () => {
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

  it("rejects a singular system", () => {
    expect(solveRealLinearSystem(2, new Float64Array([1, 2, 2, 4]), new Float64Array([5, 10]))).toBeNull();
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
