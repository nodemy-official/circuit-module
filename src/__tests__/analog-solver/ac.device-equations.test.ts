import { describe, expect, it } from "vitest";

import { analyzeAnalogCircuit, type ComplexValue } from "../../analog-solver.js";
import {
  circuitPartCatalog,
  terminalsOf,
  type CircuitDocument,
  type CircuitPart,
  type CircuitPartKind,
} from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";

const part = (id: string, kind: CircuitPartKind, values: Partial<CircuitPart> = {}): CircuitPart => ({
  id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...values,
});

type NetPart = readonly [CircuitPart, readonly string[]];

function circuit(entries: readonly NetPart[]): CircuitDocument {
  const wires: CircuitDocument["wires"] = [];
  const nets = new Map<string, CircuitDocument["wires"][number]["from"]>();
  for (const [item, names] of entries) {
    for (const [index, terminal] of terminalsOf(item.kind).entries()) {
      const name = names[index]!;
      const endpoint = { partId: item.id, terminal };
      const first = nets.get(name);
      if (first) { wires.push({ id: `wire-${wires.length}`, from: first, to: endpoint }); }
      else { nets.set(name, endpoint); }
    }
  }
  return { title: "Independent AC physics audit", parts: entries.map(([item]) => item), wires };
}

// The oracle deliberately uses elementary physical equations and ordinary
// arithmetic, without importing the solver's complex or device-model helpers.
const add = (a: ComplexValue, b: ComplexValue): ComplexValue => ({ real: a.real + b.real, imaginary: a.imaginary + b.imaginary });
const scale = (a: ComplexValue, b: number): ComplexValue => ({ real: a.real * b, imaginary: a.imaginary * b });
const subtract = (a: ComplexValue, b: ComplexValue) => add(a, scale(b, -1));
const multiply = (a: ComplexValue, b: ComplexValue): ComplexValue => ({ real: a.real * b.real - a.imaginary * b.imaginary, imaginary: a.real * b.imaginary + a.imaginary * b.real });
const divide = (a: ComplexValue, b: ComplexValue): ComplexValue => {
  const norm = b.real ** 2 + b.imaginary ** 2;
  return { real: (a.real * b.real + a.imaginary * b.imaginary) / norm, imaginary: (a.imaginary * b.real - a.real * b.imaginary) / norm };
};
const polar = (amplitude: number, degrees: number): ComplexValue => ({ real: amplitude * Math.cos(degrees * Math.PI / 180), imaginary: amplitude * Math.sin(degrees * Math.PI / 180) });
const power = (voltage: ComplexValue, current: ComplexValue) => multiply(voltage, { real: current.real, imaginary: -current.imaginary });

function near(actual: number, expected: number, tolerance = 2e-10) {
  const error = expected === 0 ? (actual === 0 ? 0 : Number.POSITIVE_INFINITY) : Math.abs((actual - expected) / expected);
  if (!(error < tolerance)) { throw new Error(`actual=${actual} expected=${expected} relativeError=${error}`); }
}

function phasor(actual: ComplexValue | undefined, expected: ComplexValue, tolerance = 2e-10) {
  if (!actual) { throw new Error(`Missing phasor; expected=${JSON.stringify(expected)}`); }
  const norm = Math.hypot(expected.real, expected.imaginary);
  const difference = Math.hypot(actual.real - expected.real, actual.imaginary - expected.imaginary);
  const error = norm === 0 ? (difference === 0 ? 0 : Number.POSITIVE_INFINITY) : difference / norm;
  if (!(error < tolerance)) { throw new Error(`actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} relativeError=${error}`); }
}

describe("AC device equations and conservation", () => {
  it.each([37, 731, 18_013])("matches the parallel RLC admittance and RMS power at %s Hz", (frequencyHz) => {
    const voltage = polar(2.7, -137);
    const document = circuit([
      [part("source", "ac-source", { voltageVolts: 2.7, phaseDegrees: -137, frequencyHz }), ["hot", "return"]],
      [part("resistor", "resistor", { resistanceOhms: 83 }), ["hot", "return"]],
      [part("capacitor", "capacitor", { capacitanceFarads: 3.1e-6 }), ["hot", "return"]],
      [part("inductor", "inductor", { inductanceHenries: 0.023 }), ["hot", "return"]],
      [part("ground", "ground"), ["return"]],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    const omega = 2 * Math.PI * frequencyHz;
    const currents = {
      resistor: scale(voltage, 1 / 83),
      capacitor: multiply(voltage, { real: 0, imaginary: omega * 3.1e-6 }),
      inductor: multiply(voltage, { real: 0, imaginary: -1 / (omega * 0.023) }),
    };
    let total = { real: 0, imaginary: 0 };
    for (const [id, current] of Object.entries(currents)) {
      phasor(result.parts[id].current, current);
      phasor(result.parts[id].power, power(voltage, current));
      near(scalar.parts[id].currentAmps, Math.hypot(current.real, current.imaginary));
      const expectedPhase = Math.atan2(current.imaginary, current.real) * 180 / Math.PI;
      near(scalar.parts[id].currentPhaseDegrees!, expectedPhase);
      total = add(total, current);
    }
    phasor(result.parts.source.current, scale(total, -1));
    phasor(result.parts.source.power, scale(power(voltage, total), -1));
    near(scalar.parts.source.powerWatts, 2.7 ** 2 / 83);
    near(scalar.parts.resistor.powerWatts, 2.7 ** 2 / 83);
    expect(scalar.parts.capacitor.powerWatts).toBe(0);
    expect(scalar.parts.inductor.powerWatts).toBe(0);
  });

  it.each([113, 887])("separates the %s Hz tone in a two-source reactive loop", (frequencyHz) => {
    const document = circuit([
      [part("first", "ac-source", { voltageVolts: 3, phaseDegrees: 24, frequencyHz: 113 }), ["first", "zero"]],
      [part("second", "ac-source", { voltageVolts: 5, phaseDegrees: -71, frequencyHz: 887 }), ["second", "zero"]],
      [part("r", "resistor", { resistanceOhms: 127 }), ["first", "middle"]],
      [part("c", "capacitor", { capacitanceFarads: 7.3e-6 }), ["middle", "second"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    const excitation = frequencyHz === 113 ? polar(3, 24) : scale(polar(5, -71), -1);
    const current = divide(excitation, { real: 127, imaginary: -1 / (2 * Math.PI * frequencyHz * 7.3e-6) });
    phasor(result.parts.r.current, current);
    phasor(result.parts.c.current, current);
    phasor(result.parts.r.power, { real: Math.hypot(current.real, current.imaginary) ** 2 * 127, imaginary: 0 });
    const inactive = frequencyHz === 113 ? "second" : "first";
    phasor(result.parts[inactive].voltage, { real: 0, imaginary: 0 });
    expect(result.issues.some((issue) => issue.partId === inactive)).toBe(true);
  });

  it("retains local floating-loop voltage while rejecting a voltage between independent islands", () => {
    const document = circuit([
      [part("source", "ac-source", { voltageVolts: 4.1, phaseDegrees: 43 }), ["hot", "zero"]],
      [part("r", "resistor", { resistanceOhms: 220 }), ["hot", "zero"]],
      [part("island", "ac-source", { voltageVolts: 1.3, phaseDegrees: -19 }), ["island-hot", "island-return"]],
      [part("island-r", "resistor", { resistanceOhms: 71 }), ["island-hot", "island-return"]],
      [part("local", "voltmeter"), ["island-hot", "island-return"]],
      [part("cross", "voltmeter"), ["hot", "island-hot"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    phasor(result.parts["island-r"].current, scale(polar(1.3, -19), 1 / 71));
    phasor(result.parts.local.voltage, polar(1.3, -19));
    expect(result.parts.local.meterStatus).toBe("connected");
    expect(result.parts.cross.meterStatus).toBe("floating");
  });

  it.each(["diode", "led"] as const)("matches an independently solved Shockley bias and capacitive %s small signal", (kind) => {
    const saturation = kind === "diode" ? 1e-12 : 1e-20;
    const ideality = kind === "diode" ? 1 : 2;
    const thermal = ideality * 0.025_85;
    const resistance = 430;
    let low = 0;
    let high = 3.7;
    for (let index = 0; index < 100; index += 1) {
      const midpoint = (low + high) / 2;
      if (saturation * Math.expm1(midpoint / thermal) > (3.7 - midpoint) / resistance) { high = midpoint; }
      else { low = midpoint; }
    }
    const bias = (low + high) / 2;
    const conductance = saturation * Math.exp(bias / thermal) / thermal;
    const frequencyHz = 1237;
    const excitation = polar(0.007, 62);
    const admittance = { real: conductance, imaginary: 2 * Math.PI * frequencyHz * 8.7e-6 };
    const expectedVoltage = divide(excitation, add({ real: 1, imaginary: 0 }, scale(admittance, resistance)));
    const document = circuit([
      [part("source", "ac-source", { offsetVolts: 3.7, voltageVolts: 0.007, phaseDegrees: 62, frequencyHz }), ["hot", "zero"]],
      [part("r", "resistor", { resistanceOhms: resistance }), ["hot", "device"]],
      [part("device", kind, { saturationCurrentAmps: saturation, emissionCoefficient: ideality }), ["device", "zero"]],
      [part("c", "capacitor", { capacitanceFarads: 8.7e-6 }), ["device", "zero"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    phasor(result.parts.device.voltage, expectedVoltage);
    phasor(result.parts.device.current, scale(expectedVoltage, conductance));
    phasor(result.parts.device.power, power(expectedVoltage, scale(expectedVoltage, conductance)));
  });

  it.each((["nmos", "pmos"] as const).flatMap((kind) => [
    { kind, drain: 0.8, gate: 3.9, source: 0.2, region: "triode" },
    { kind, drain: 5, gate: 3.9, source: 0.2, region: "saturation" },
    { kind, drain: 0.8, gate: 6.5, source: 4.7, region: "reverse" },
    { kind, drain: 5, gate: 1.9, source: 0.2, region: "cutoff" },
  ]))("matches all three simultaneous terminal excitations for $kind $region", ({ kind, drain, gate, source }) => {
    const sign = kind === "pmos" ? -1 : 1;
    const bias = [drain, gate, source];
    const signals = [polar(0.003, 17), polar(0.005, -73), polar(0.002, 139)];
    const entries: NetPart[] = [
      [part("mos", kind, { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 0.031, channelLengthModulation: 0.047 }), ["drain", "gate", "source"]],
      [part("ground", "ground"), ["zero"]],
    ];
    for (const [index, net] of ["drain", "gate", "source"].entries()) {
      entries.push([part(`bias-${net}`, "ac-source", { offsetVolts: sign * bias[index]!, voltageVolts: [0.003, 0.005, 0.002][index], phaseDegrees: [17, -73, 139][index] }), [net, "zero"]]);
    }
    const reverse = drain < source;
    const overdrive = gate - (reverse ? drain : source) - 2;
    const channelVoltage = Math.abs(drain - source);
    const gm = overdrive <= 0 ? 0 : 0.031 * Math.min(channelVoltage, overdrive) * (1 + 0.047 * channelVoltage);
    const baseCurrent = overdrive <= 0 ? 0 : channelVoltage < overdrive
      ? 0.031 * (overdrive * channelVoltage - channelVoltage ** 2 / 2)
      : 0.031 * overdrive ** 2 / 2;
    const gds = overdrive <= 0 ? 0 : (channelVoltage < overdrive ? 0.031 * (overdrive - channelVoltage) * (1 + 0.047 * channelVoltage) : 0) + baseCurrent * 0.047;
    const expected = reverse
      ? subtract(subtract(scale(signals[0]!, gm + gds), scale(signals[1]!, gm)), scale(signals[2]!, gds))
      : subtract(add(scale(signals[0]!, gds), scale(signals[1]!, gm)), scale(signals[2]!, gm + gds));
    const result = analyzeAnalogCircuit(circuit(entries), { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    phasor(result.parts.mos.current, expected);
    phasor(result.parts.mos.terminalCurrents.b, { real: 0, imaginary: 0 });
    phasor(result.parts.mos.terminalCurrents.c, scale(expected, -1));
    phasor(result.parts.mos.power, power(subtract(signals[0]!, signals[2]!), expected));
  });

  it.each(["npn-transistor", "pnp-transistor"] as const)("matches independent Ebers-Moll derivatives and three-terminal power for %s", (kind) => {
    const sign = kind === "pnp-transistor" ? -1 : 1;
    const beta = 73;
    const saturation = 3.2e-14;
    const bias = [0.41, 0.53, 0.17];
    const signals = [polar(0.003, 17), polar(0.005, -73), polar(0.002, 139)];
    const entries: NetPart[] = [
      [part("bjt", kind, { currentGain: beta, saturationCurrentAmps: saturation }), ["collector", "base", "emitter"]],
      [part("ground", "ground"), ["zero"]],
    ];
    for (const [index, net] of ["collector", "base", "emitter"].entries()) {
      entries.push([part(`bias-${net}`, "ac-source", { offsetVolts: sign * bias[index]!, voltageVolts: [0.003, 0.005, 0.002][index], phaseDegrees: [17, -73, 139][index] }), [net, "zero"]]);
    }
    const forward = saturation * Math.exp((bias[1]! - bias[2]!) / 0.025_85) / 0.025_85;
    const reverse = saturation * Math.exp((bias[1]! - bias[0]!) / 0.025_85) / 0.025_85;
    const vbe = subtract(signals[1]!, signals[2]!);
    const vbc = subtract(signals[1]!, signals[0]!);
    const collector = subtract(scale(vbe, forward), scale(vbc, 2 * reverse));
    const base = add(scale(vbe, forward / beta), scale(vbc, reverse));
    const emitter = scale(add(collector, base), -1);
    const result = analyzeAnalogCircuit(circuit(entries), { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    phasor(result.parts.bjt.terminalCurrents.a, collector);
    phasor(result.parts.bjt.terminalCurrents.b, base);
    phasor(result.parts.bjt.terminalCurrents.c, emitter);
    phasor(result.parts.bjt.power, add(power(subtract(signals[0]!, signals[2]!), collector), power(vbe, base)));
  });

  it.each(["capacitor", "inductor"] as const)("preserves the finite %s response when its impedance or admittance exceeds binary64 range", (kind) => {
    const frequencyHz = 2 ** -500;
    const amplitude = kind === "capacitor" ? 2 ** 1000 : 2 ** -1000;
    const document = circuit([
      [part("source", "ac-source", { voltageVolts: amplitude, phaseDegrees: 0, frequencyHz }), ["hot", "zero"]],
      [part("reactive", kind, { capacitanceFarads: 2 ** -700, inductanceHenries: 2 ** -700 }), ["hot", "zero"]],
      [part("meter", "voltmeter"), ["hot", "zero"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    // Cancel powers of two algebraically before evaluating any number.
    const current = kind === "capacitor" ? 2 * Math.PI * 2 ** -200 : -(2 ** 200) / (2 * Math.PI);
    const vars = kind === "capacitor" ? -2 * Math.PI * 2 ** 800 : 2 ** -800 / (2 * Math.PI);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    phasor(result.parts.reactive.current, { real: 0, imaginary: current });
    phasor(result.parts.reactive.voltage, { real: amplitude, imaginary: 0 });
    phasor(result.parts.reactive.power, { real: 0, imaginary: vars });
    near(scalar.parts.reactive.currentAmps, Math.abs(current));
    near(scalar.parts.reactive.reactivePowerVars!, vars);
    expect(scalar.parts.meter.meterStatus).toBe("connected");
    near(scalar.parts.meter.voltageVolts, amplitude);
  });

  it.each([0, 0.02])("matches finite-gain op-amp feedback with reactive loading at %s V DC input", (offsetVolts) => {
    const frequencyHz = 1703;
    const gain = 817;
    const voltage = polar(0.001, -39);
    const document = circuit([
      [part("source", "ac-source", { voltageVolts: 0.001, phaseDegrees: -39, frequencyHz, offsetVolts }), ["input", "zero"]],
      [part("amp", "op-amp", { openLoopGain: gain, positiveRailVolts: 15, negativeRailVolts: -15 }), ["input", "feedback", "output"]],
      [part("rf", "resistor", { resistanceOhms: 2700 }), ["output", "feedback"]],
      [part("rg", "resistor", { resistanceOhms: 900 }), ["feedback", "zero"]],
      [part("load", "resistor", { resistanceOhms: 600 }), ["output", "zero"]],
      [part("c", "capacitor", { capacitanceFarads: 1.7e-6 }), ["output", "zero"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    // (A*Vin - (1+A/4)*Vout)/20 = Vout*(1/600+1/3600+j*w*C).
    const admittance = { real: 1 / 600 + 1 / 3600, imaginary: 2 * Math.PI * frequencyHz * 1.7e-6 };
    const expectedVoltage = divide(scale(voltage, gain), add({ real: 1 + gain / 4, imaginary: 0 }, scale(admittance, 20)));
    const expectedOutputCurrent = scale(multiply(expectedVoltage, admittance), -1);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    phasor(result.parts.amp.voltage, expectedVoltage);
    phasor(result.parts.amp.current, expectedOutputCurrent);
    phasor(result.parts.amp.power, power(expectedVoltage, expectedOutputCurrent));
    phasor(result.parts.rf.current, scale(expectedVoltage, 1 / 3600));
  });

  it.each(["nmos", "pmos"] as const)("matches source-degenerated %s gain with a capacitive drain load", (kind) => {
    const sign = kind === "pmos" ? -1 : 1;
    const frequencyHz = 941;
    const beta = 0.024;
    const overdrive = 0.9;
    const sourceResistance = 37;
    const current = beta * overdrive ** 2 / 2;
    const sourceBias = current * sourceResistance;
    const voltage = polar(0.0021, 31);
    const document = circuit([
      [part("input", "ac-source", { offsetVolts: sign * (sourceBias + 2 + overdrive), voltageVolts: 0.0021, phaseDegrees: 31, frequencyHz }), ["gate", "zero"]],
      [part("supply", "ac-source", { offsetVolts: sign * 7, voltageVolts: 0, frequencyHz }), ["supply", "zero"]],
      [part("mos", kind, { thresholdVolts: 2, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: 0 }), ["drain", "gate", "source"]],
      [part("rd", "resistor", { resistanceOhms: 173 }), ["supply", "drain"]],
      [part("rs", "resistor", { resistanceOhms: sourceResistance }), ["source", "zero"]],
      [part("c", "capacitor", { capacitanceFarads: 2.3e-6 }), ["drain", "zero"]],
      [part("meter", "voltmeter"), ["drain", "source"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    // Id=gm*(Vin-Vs), Vs=Rs*Id, Vd=-Id/(1/Rd+j*w*C).
    const expectedCurrent = scale(voltage, beta * overdrive / (1 + beta * overdrive * sourceResistance));
    const drainVoltage = scale(divide(expectedCurrent, { real: 1 / 173, imaginary: 2 * Math.PI * frequencyHz * 2.3e-6 }), -1);
    const sourceVoltage = scale(expectedCurrent, sourceResistance);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    phasor(result.parts.mos.current, expectedCurrent);
    phasor(result.parts.mos.voltage, subtract(drainVoltage, sourceVoltage));
    phasor(result.parts.meter.voltage, subtract(drainVoltage, sourceVoltage));
    expect(scalar.parts.meter.meterStatus).toBe("connected");
    near(scalar.parts.mos.currentAmps, Math.hypot(expectedCurrent.real, expectedCurrent.imaginary));
  });

  it.each([113, 887])("keeps every DC bias contribution while exciting only %s Hz in a nonlinear mixed-source loop", (frequencyHz) => {
    const document = circuit([
      [part("first", "ac-source", { offsetVolts: 3.7, voltageVolts: 0.007, phaseDegrees: 47, frequencyHz: 113 }), ["first", "zero"]],
      [part("battery", "battery", { voltageVolts: 1.2, internalResistanceOhms: 67 }), ["supply", "first"]],
      [part("second", "ac-source", { offsetVolts: 0.2, voltageVolts: 0.013, phaseDegrees: -111, frequencyHz: 887 }), ["series", "supply"]],
      [part("r", "resistor", { resistanceOhms: 430 }), ["series", "device"]],
      [part("diode", "diode", { saturationCurrentAmps: 1e-12, emissionCoefficient: 1 }), ["device", "zero"]],
      [part("bias-current", "current-source", { currentAmps: 0.002 }), ["device", "zero"]],
      [part("c", "capacitor", { capacitanceFarads: 1.3e-6 }), ["device", "zero"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    let low = 0;
    let high = 5.1;
    for (let index = 0; index < 100; index += 1) {
      const mid = (low + high) / 2;
      if (1e-12 * Math.expm1(mid / 0.025_85) + 0.002 > (5.1 - mid) / 497) { high = mid; }
      else { low = mid; }
    }
    const conductance = 1e-12 * Math.exp(((low + high) / 2) / 0.025_85) / 0.025_85;
    const admittance = { real: conductance, imaginary: 2 * Math.PI * frequencyHz * 1.3e-6 };
    const excitation = frequencyHz === 113 ? polar(0.007, 47) : polar(0.013, -111);
    const voltage = divide(excitation, add({ real: 1, imaginary: 0 }, scale(admittance, 497)));
    const current = multiply(voltage, admittance);
    const result = analyzeAnalogCircuit(document, { mode: "ac", frequencyHz });
    const scalar = analyzeCircuit(document, {}, { mode: "ac", frequencyHz });
    expect(result.status, result.message).toBe("valid");
    expect(scalar.status, scalar.message).toBe("closed");
    phasor(result.parts.diode.voltage, voltage);
    phasor(result.parts.r.current, current);
    phasor(result.parts["bias-current"].current, { real: 0, imaginary: 0 });
    phasor(result.parts.battery.voltage, scale(current, -67));
    near(scalar.parts.battery.powerWatts, Math.hypot(current.real, current.imaginary) ** 2 * 67);
    const active = frequencyHz === 113 ? "first" : "second";
    const inactive = frequencyHz === 113 ? "second" : "first";
    phasor(result.parts[inactive].voltage, { real: 0, imaginary: 0 });
    near(scalar.parts[active].powerWatts, power(excitation, current).real);
    near(scalar.parts[active].powerWatts, scalar.parts.r.powerWatts + scalar.parts.battery.powerWatts + scalar.parts.diode.powerWatts);
  });

  it.each([false, true])("checks KVL and current nonuniqueness in an ideal-source rectangle; inconsistent=%s", (inconsistent) => {
    const document = circuit([
      [part("s1", "ac-source", { voltageVolts: 10, phaseDegrees: 0 }), ["one", "zero"]],
      [part("s2", "ac-source", { voltageVolts: 4, phaseDegrees: 90 }), ["two", "one"]],
      [part("s3", "ac-source", { voltageVolts: 10, phaseDegrees: 180 }), ["three", "two"]],
      [part("s4", "ac-source", { voltageVolts: inconsistent ? 4 + 1e-12 : 4, phaseDegrees: -90 }), ["four", "three"]],
      [part("meter", "ammeter"), ["four", "zero"]],
      [part("load", "resistor", { resistanceOhms: 13 }), ["two", "zero"]],
      [part("ground", "ground"), ["zero"]],
    ]);
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    if (inconsistent) {
      // The rectangle's voltage sum is exactly -j*1e-12 V rather than zero.
      expect(result.status).toBe("invalid");
    } else {
      expect(result.status, result.message).toBe("valid");
      phasor(result.parts.load.voltage, { real: 10, imaginary: 4 });
      phasor(result.parts.load.current, { real: 10 / 13, imaginary: 4 / 13 });
      near(result.parts.load.power.real, 116 / 13);
      expect(result.parts.meter.meterStatus).toBe("floating");
      const sum = Object.values(result.parts).reduce((total, reading) => add(total, reading.power), { real: 0, imaginary: 0 });
      phasor(sum, { real: 0, imaginary: 0 });
    }
  });
});
