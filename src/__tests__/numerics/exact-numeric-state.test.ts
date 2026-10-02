import { expect, it } from "vitest";

import {
  addExactRational,
  divideExactRational,
  numberToExactRational,
} from "../../exact-linear-algebra.js";
import {
  addRealStateValue,
  addScaledRealState,
  clearRealStateRange,
  cloneRealState,
  complexFromExact,
  exactComplexValue,
  exactRealStateInput,
  exactRealStateValue,
  realStateFromExact,
  setRealStateValue,
} from "../../exact-numeric-state.js";

const rational = (numerator: bigint, denominator = 1n) => ({ numerator, denominator });

function exactNumber(value: number) {
  const exact = numberToExactRational(value);
  if (!exact) { throw new Error("Expected a finite number."); }
  return exact;
}

it("retains an exact real state through underflow so later scaling can recover it", () => {
  const halfSubnormal = divideExactRational(exactNumber(Number.MIN_VALUE), exactNumber(2));
  expect(halfSubnormal).not.toBeNull();

  const state = realStateFromExact([halfSubnormal!]);
  expect(state[0]).toBe(0);

  const rescaled = addScaledRealState(state, state, 1);
  expect(rescaled[0]).toBe(Number.MIN_VALUE);
});

it("retains an exact real state through overflow so later cancellation can recover it", () => {
  const beyondMaximum = addExactRational(exactNumber(Number.MAX_VALUE), exactNumber(2 ** 971));
  const state = realStateFromExact([beyondMaximum]);
  const opposite = realStateFromExact([rational(-beyondMaximum.numerator, beyondMaximum.denominator)]);

  expect(state[0]).toBe(Number.POSITIVE_INFINITY);
  const cancelled = addScaledRealState(state, opposite, 1);
  expect(cancelled[0]).toBe(0);
});

it("preserves hidden exact values when cloning a rounded real state", () => {
  const halfSubnormal = divideExactRational(exactNumber(Number.MIN_VALUE), exactNumber(2));
  expect(halfSubnormal).not.toBeNull();
  const state = realStateFromExact([halfSubnormal!]);

  const clone = cloneRealState(state);
  expect(clone[0]).toBe(0);
  expect(addScaledRealState(clone, clone, 1)[0]).toBe(Number.MIN_VALUE);
});

it("discards real sidecar metadata after a caller mutation is observed", () => {
  const state = realStateFromExact([rational(1n, 3n)]);
  const rounded = state[0]!;

  state[0] = 2;
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(2));
  state[0] = rounded;

  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(rounded));
});

it("discards complex sidecar metadata after a caller mutation is observed", () => {
  const value = complexFromExact({ real: rational(1n, 3n), imaginary: rational(1n, 7n) });
  const roundedReal = value.real;
  const roundedImaginary = value.imaginary;

  value.real = 2;
  expect(exactComplexValue(value)).toEqual({
    real: exactNumber(2),
    imaginary: exactNumber(roundedImaginary),
  });
  value.real = roundedReal;

  expect(exactComplexValue(value)).toEqual({
    real: exactNumber(roundedReal),
    imaginary: exactNumber(roundedImaginary),
  });
});

it("preserves small matrix contributions across a large cancelling sum", () => {
  const coefficients = new Float64Array(1);
  addRealStateValue(coefficients, 0, 1e16);
  addRealStateValue(coefficients, 0, 1);
  addRealStateValue(coefficients, 0, -1e16);

  expect(coefficients[0]).toBe(1);
  expect(exactRealStateInput(coefficients)).toEqual([exactNumber(1)]);
});

it("keeps an exact underflowing matrix entry available to the linear solver", () => {
  const halfSubnormal = divideExactRational(exactNumber(Number.MIN_VALUE), exactNumber(2));
  expect(halfSubnormal).not.toBeNull();
  const matrix = new Float64Array(1);

  setRealStateValue(matrix, 0, halfSubnormal!);

  expect(matrix[0]).toBe(0);
  expect(exactRealStateInput(matrix)).toEqual([halfSubnormal]);
});

it("snapshots caller-owned rationals when creating an exact real state", () => {
  const input = rational(1n, 2n);
  const state = realStateFromExact([input]);

  input.numerator = 3n;

  expect(state[0]).toBe(0.5);
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(0.5));
});

it("snapshots exact array entries when creating a real state", () => {
  const inputs = [rational(1n, 2n)];
  const state = realStateFromExact(inputs);

  inputs[0] = rational(3n, 2n);

  expect(state[0]).toBe(0.5);
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(0.5));
});

it("snapshots caller-owned rationals when setting an exact state entry", () => {
  const input = rational(1n, 2n);
  const state = new Float64Array(1);
  setRealStateValue(state, 0, input);

  input.numerator = 3n;

  expect(state[0]).toBe(0.5);
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(0.5));
});

it("snapshots complex components and rationals before retaining a sidecar", () => {
  const input = { real: rational(1n, 2n), imaginary: rational(1n, 4n) };
  const value = complexFromExact(input);

  input.real.numerator = 3n;
  input.imaginary.denominator = 2n;
  input.real = rational(4n);

  expect(value).toEqual({ real: 0.5, imaginary: 0.25 });
  expect(exactComplexValue(value)).toEqual({
    real: exactNumber(0.5),
    imaginary: exactNumber(0.25),
  });
});

it("does not restore stale exact entries after clear, set, or caller mutation", () => {
  const oldValue = rational(1n, 3n);
  const state = realStateFromExact([oldValue]);
  const oldRounded = state[0]!;

  clearRealStateRange(state, 0, 1);
  state[0] = oldRounded;
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(oldRounded));

  setRealStateValue(state, 0, oldValue);
  setRealStateValue(state, 0, 2);
  state[0] = oldRounded;
  expect(exactRealStateValue(state, 0)).toEqual(exactNumber(oldRounded));
});
