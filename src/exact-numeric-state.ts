import type { ComplexValue } from "./analog-math.js";
import {
  addExactRational,
  exactComplexToNumber,
  exactRationalToNumber,
  multiplyExactRational,
  numberToExactRational,
  type ExactComplexValue,
  type ExactRational,
} from "./exact-linear-algebra.js";

// Public results remain ordinary numbers. Keep their exact internal values in
// weak sidecars so a display rounding cannot alter a later circuit equation.
const realStates = new WeakMap<Float64Array, {
  exact: readonly ExactRational[];
  rounded: Float64Array;
  invalid: Set<number>;
}>();
const realEntries = new WeakMap<Float64Array, Map<number, { exact: ExactRational; rounded: number }>>();
const complexValues = new WeakMap<ComplexValue, {
  exact: ExactComplexValue;
  real: number;
  imaginary: number;
}>();

const ZERO: ExactRational = { numerator: 0n, denominator: 1n };

// Reuse immutable canonical values from the solver, but snapshot a caller's
// mutable rational so changing the input cannot silently change stored state.
function snapshotExact(value: ExactRational) {
  return addExactRational(value, ZERO);
}

export function realStateFromExact(values: readonly ExactRational[]): Float64Array {
  const exact = values.map(snapshotExact);
  const rounded = Float64Array.from(exact, exactRationalToNumber);
  realStates.set(rounded, { exact, rounded: rounded.slice(), invalid: new Set() });
  return rounded;
}

/** Reads exact state, respecting any caller mutation of the public array. */
export function exactRealStateValue(state: Float64Array, index: number): ExactRational | null {
  const value = state[index];
  const entries = realEntries.get(state);
  const entry = entries?.get(index);
  if (entry && Object.is(value, entry.rounded)) { return entry.exact; }
  if (entry) { entries?.delete(index); }
  const stored = realStates.get(state);
  if (stored && !stored.invalid.has(index) && Object.is(value, stored.rounded[index])) {
    return stored.exact[index] ?? null;
  }
  stored?.invalid.add(index);
  return numberToExactRational(value ?? Number.NaN);
}

/** Sets an exact matrix/RHS entry without exposing BigInt in the public data. */
export function setRealStateValue(state: Float64Array, index: number, value: number | ExactRational) {
  const exact = typeof value === "number" ? numberToExactRational(value) : snapshotExact(value);
  if (!exact) {
    state[index] = typeof value === "number" ? value : Number.NaN;
    realEntries.get(state)?.delete(index);
    realStates.get(state)?.invalid.add(index);
    return;
  }
  const rounded = exactRationalToNumber(exact);
  state[index] = rounded;
  const entries = realEntries.get(state) ?? new Map();
  entries.set(index, { exact, rounded });
  realEntries.set(state, entries);
  realStates.get(state)?.invalid.add(index);
}

export function addRealStateValue(state: Float64Array, index: number, value: number | ExactRational) {
  if (typeof value === "number" ? value === 0 : value.numerator === 0n) { return; }
  const previous = exactRealStateValue(state, index);
  const next = typeof value === "number" ? numberToExactRational(value) : value;
  setRealStateValue(state, index, previous && next
    ? addExactRational(previous, next)
    : (state[index] ?? 0) + (typeof value === "number" ? value : exactRationalToNumber(value)));
}

export function clearRealStateRange(state: Float64Array, start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    setRealStateValue(state, index, 0);
  }
}

/** Passes untouched arrays through; assembled arrays retain all exact entries. */
export function exactRealStateInput(state: Float64Array): Float64Array | readonly ExactRational[] {
  if (!realStates.has(state) && !realEntries.has(state)) { return state; }
  const exact = Array.from(state, (_, index) => exactRealStateValue(state, index));
  return exact.every((value): value is ExactRational => value !== null) ? exact : state;
}

export function cloneRealState(state: Float64Array): Float64Array {
  const exact = Array.from(state, (_, index) => exactRealStateValue(state, index));
  return exact.every((value): value is ExactRational => value !== null)
    ? realStateFromExact(exact)
    : state.slice();
}

/** Newton updates keep both the correction and the previous state exact. */
export function addScaledRealState(
  state: Float64Array,
  delta: Float64Array,
  scale: number,
): Float64Array {
  const exactScale = numberToExactRational(scale);
  const exact: ExactRational[] = [];
  for (let index = 0; index < state.length; index += 1) {
    const value = exactRealStateValue(state, index);
    const correction = exactRealStateValue(delta, index);
    if (!value || !correction || !exactScale) {
      return Float64Array.from(state, (entry, column) => entry + scale * (delta[column] ?? 0));
    }
    exact.push(addExactRational(value, multiplyExactRational(exactScale, correction)));
  }
  return realStateFromExact(exact);
}

export function complexFromExact(value: ExactComplexValue): ComplexValue {
  const exact = Object.freeze({ real: snapshotExact(value.real), imaginary: snapshotExact(value.imaginary) });
  const rounded = exactComplexToNumber(exact);
  complexValues.set(rounded, { exact, real: rounded.real, imaginary: rounded.imaginary });
  return rounded;
}

/** Reads exact components, invalidating the sidecar if the object was edited. */
export function exactComplexValue(value: ComplexValue): ExactComplexValue | null {
  const stored = complexValues.get(value);
  if (stored && Object.is(value.real, stored.real) && Object.is(value.imaginary, stored.imaginary)) {
    return stored.exact;
  }
  if (stored) { complexValues.delete(value); }
  const real = numberToExactRational(value.real);
  const imaginary = numberToExactRational(value.imaginary);
  return real && imaginary ? { real, imaginary } : null;
}
