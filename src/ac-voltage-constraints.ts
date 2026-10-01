import type { CircuitPart } from "./circuit-model.js";
import type { ComplexValue } from "./analog-math.js";
import { exactComplexValue } from "./exact-numeric-state.js";
import { addExactRational, divideExactRational, multiplyExactRational, numberToExactRational, type ExactRational } from "./exact-linear-algebra.js";

export interface IdealAcVoltageEdge {
  part: CircuitPart;
  voltage: ComplexValue;
  orientation: number;
}

const ZERO = numberToExactRational(0)!;
const ONE = numberToExactRational(1)!;
const piValues = new Map<number, ExactRational>();

function absolute(value: ExactRational): ExactRational {
  return value.numerator < 0n ? { numerator: -value.numerator, denominator: value.denominator } : value;
}

function lessOrEqual(first: ExactRational, second: ExactRational) {
  return first.numerator * second.denominator <= second.numerator * first.denominator;
}

function arctangentInverse(inverse: bigint, scale: bigint) {
  let power = inverse;
  let sum = 0n;
  let count = 0n;
  for (let index = 0n; ; index += 1n) {
    const term = scale / (power * (2n * index + 1n));
    if (term === 0n) { break; }
    sum += index % 2n === 0n ? term : -term;
    count += 1n;
    power *= inverse * inverse;
  }
  // Integer truncation costs <1 unit per term; the alternating tail <1 unit.
  return { sum, error: count + 1n };
}

function boundedPi(bits: number): ExactRational {
  const cached = piValues.get(bits);
  if (cached) { return cached; }
  const guard = 64;
  const scale = 2n ** BigInt(bits + guard);
  const first = arctangentInverse(5n, scale);
  const second = arctangentInverse(239n, scale);
  const sum = 16n * first.sum - 4n * second.sum;
  const error = 16n * first.error + 4n * second.error;
  const divisor = 2n ** BigInt(guard);
  const lower = (sum - error) / divisor;
  const upper = (sum + error + divisor - 1n) / divisor;
  // Machin's identity gives a certified enclosure. Its midpoint has absolute
  // error at most one target unit, even if pi lies on a truncation boundary.
  const value = { numerator: lower + upper, denominator: 2n ** BigInt(bits + 1) };
  if (piValues.size >= 16) { piValues.delete(piValues.keys().next().value!); }
  piValues.set(bits, value);
  return value;
}

interface Direction {
  real: ExactRational;
  imaginary: ExactRational;
  realError: ExactRational;
  imaginaryError: ExactRational;
}

function directionAtPhase(phase: number, bits: number): Direction {
  const wrapped = phase % 360;
  const quadrant = Math.round(wrapped / 90);
  const degrees = wrapped - quadrant * 90;
  if (degrees === 0) {
    const axes = [[ONE, ZERO], [ZERO, ONE], [numberToExactRational(-1)!, ZERO], [ZERO, numberToExactRational(-1)!]];
    const [real, imaginary] = axes[((quadrant % 4) + 4) % 4]!;
    return { real: real!, imaginary: imaginary!, realError: ZERO, imaginaryError: ZERO };
  }
  const degree = numberToExactRational(degrees)!;
  const angle = divideExactRational(multiplyExactRational(degree, boundedPi(bits)), numberToExactRational(180)!)!;
  // Resolve both a tiny angle and its second-order curvature. Fixed-point
  // recurrences keep integer sizes bounded instead of growing Taylor fractions.
  const workingBits = bits + 80 + 2 * Math.max(0, -Math.floor(Math.log2(Math.abs(degrees))));
  const scale = 2n ** BigInt(workingBits);
  const x = angle.numerator * scale / angle.denominator;
  const squared = x * x / scale;
  let sine = x;
  let sineTerm = x;
  let cosine = scale;
  let cosineTerm = scale;
  let count = 0n;
  for (let index = 1n; ; index += 1n) {
    sineTerm = -sineTerm * squared / (scale * 2n * index * (2n * index + 1n));
    cosineTerm = -cosineTerm * squared / (scale * (2n * index - 1n) * 2n * index);
    sine += sineTerm;
    cosine += cosineTerm;
    count = index;
    if (sineTerm === 0n && cosineTerm === 0n) { break; }
  }
  const unit = { numerator: 1n, denominator: scale };
  const piError = divideExactRational(absolute(degree), { numerator: 180n * 2n ** BigInt(bits), denominator: 1n })!;
  const angleError = addExactRational(piError, unit);
  // |x|<1. Each fixed-point recurrence error contracts (denominators >=2);
  // 8*(N+1)^2 units also bounds accumulated truncation and the omitted tail.
  const arithmeticError = { numerator: 8n * (count + 1n) ** 2n, denominator: scale };
  const sineError = addExactRational(angleError, arithmeticError);
  const cosineError = addExactRational(multiplyExactRational(addExactRational(absolute(angle), angleError), angleError), arithmeticError);
  const sin = { numerator: sine, denominator: scale };
  const cos = { numerator: cosine, denominator: scale };
  const negative = (value: ExactRational) => ({ numerator: -value.numerator, denominator: value.denominator });
  const rotations = [
    { real: cos, imaginary: sin, realError: cosineError, imaginaryError: sineError },
    { real: negative(sin), imaginary: cos, realError: sineError, imaginaryError: cosineError },
    { real: negative(cos), imaginary: negative(sin), realError: cosineError, imaginaryError: sineError },
    { real: sin, imaginary: negative(cos), realError: sineError, imaginaryError: cosineError },
  ];
  return rotations[((quadrant % 4) + 4) % 4]!;
}

function cyclePrecision(edges: readonly IdealAcVoltageEdge[]) {
  const amplitudes = edges.flatMap(({ part, voltage }) => {
    const exact = exactComplexValue(voltage)!;
    return part.kind === "ac-source" && (exact.real.numerator !== 0n || exact.imaginary.numerator !== 0n) && (part.voltageVolts ?? 0) > 0
      ? [part.voltageVolts!] : [];
  });
  const exponents = amplitudes.map((amplitude) => Math.floor(Math.log2(amplitude)));
  const phases = [...new Set(edges.filter(({ part, voltage }) => part.kind === "ac-source" &&
    (exactComplexValue(voltage)!.real.numerator !== 0n || exactComplexValue(voltage)!.imaginary.numerator !== 0n))
    .map(({ part }) => (part.phaseDegrees ?? 0) % 360))];
  const gaps = phases.flatMap((phase, index) => [
    Math.abs(phase - Math.round(phase / 90) * 90),
    ...phases.slice(0, index).map((other) => Math.abs(phase - other)),
  ]).filter((gap) => gap > 0);
  const tinyAngleBits = gaps.reduce((maximum, gap) => Math.max(maximum, -Math.floor(Math.log2(gap))), 0);
  // M independent phase coefficients can cancel M-1 Taylor orders. Include
  // their smallest angular separation as well as the amplitude range, so a
  // mixed loop's large coefficients cannot hide a subnormal phase residual.
  return 512 + (exponents.length ? Math.max(...exponents) - Math.min(...exponents) : 0)
    + Math.max(2, phases.length) * tinyAngleBits;
}

export function compatibleIdealAcVoltageCycle(edges: readonly IdealAcVoltageEdge[]): boolean {
  const bits = cyclePrecision(edges);
  const directions = new Map<number, Direction>();
  const groups = new Map<string, { direction: Direction; amplitude: ExactRational }>();
  let real = ZERO;
  let imaginary = ZERO;
  for (const edge of edges) {
    const exact = exactComplexValue(edge.voltage)!;
    const orientation = numberToExactRational(edge.orientation)!;
    if (edge.part.kind !== "ac-source" || (exact.real.numerator === 0n && exact.imaginary.numerator === 0n)) {
      real = addExactRational(real, multiplyExactRational(exact.real, orientation));
      imaginary = addExactRational(imaginary, multiplyExactRational(exact.imaginary, orientation));
      continue;
    }
    const phase = (edge.part.phaseDegrees ?? 0) % 360;
    const direction = directions.get(phase) ?? directionAtPhase(phase, bits);
    directions.set(phase, direction);
    const leading = direction.real.numerator === 0n ? direction.imaginary.numerator : direction.real.numerator;
    const sign = leading < 0n ? -1n : 1n;
    const canonical = { ...direction, real: { ...direction.real, numerator: sign * direction.real.numerator },
      imaginary: { ...direction.imaginary, numerator: sign * direction.imaginary.numerator } };
    const key = `${canonical.real.numerator}/${canonical.real.denominator}:${canonical.imaginary.numerator}/${canonical.imaginary.denominator}`;
    const amplitude = multiplyExactRational(numberToExactRational(edge.part.voltageVolts ?? 0)!, { numerator: sign * BigInt(edge.orientation), denominator: 1n });
    const previous = groups.get(key);
    groups.set(key, { direction: canonical, amplitude: previous ? addExactRational(previous.amplitude, amplitude) : amplitude });
  }
  let realError = ZERO;
  let imaginaryError = ZERO;
  for (const { direction, amplitude } of groups.values()) {
    real = addExactRational(real, multiplyExactRational(direction.real, amplitude));
    imaginary = addExactRational(imaginary, multiplyExactRational(direction.imaginary, amplitude));
    realError = addExactRational(realError, multiplyExactRational(direction.realError, absolute(amplitude)));
    imaginaryError = addExactRational(imaginaryError, multiplyExactRational(direction.imaginaryError, absolute(amplitude)));
  }
  return lessOrEqual(absolute(real), realError) && lessOrEqual(absolute(imaginary), imaginaryError);
}
