import { expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../../analog-solver.js";
import type { CircuitDocument, CircuitTerminal } from "../../circuit-model.js";

const cases = (["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => [false, true].flatMap((initial) => [
  { paths: 1, series: 1, sources: 2 },
  { paths: 2, series: 2, sources: 1 },
  { paths: 2, series: 3, sources: 2 },
].flatMap((network) => [
  { beta: 1 / 16, channelCurrent: 2 ** -401, voltage: 2 ** -198 },
  { beta: Number.MIN_VALUE, channelCurrent: 0.5, voltage: 2 ** 537 },
].map((scale) => ({ kind, reverse, initial, ...network, ...scale }))))));

function networkDocument(test: typeof cases[number]): CircuitDocument {
  const { kind, reverse, initial, paths, series, sources, beta, channelCurrent } = test;
  const sign = kind === "nmos" ? 1 : -1;
  const document: CircuitDocument = { title: "Independent current-network square-law oracle", parts: [{ id: "g", kind: "ground", label: "GND", x: 0, y: 0 }], wires: [] };
  const wire = (id: string, fromId: string, fromTerminal: CircuitTerminal, toId: string, toTerminal: CircuitTerminal) => document.wires.push({ id, from: { partId: fromId, terminal: fromTerminal }, to: { partId: toId, terminal: toTerminal } });
  const gateTerminal = reverse ? "c" : "a";
  const fixedTerminal = reverse ? "a" : "c";
  for (let path = 0; path < paths; path += 1) {
    for (let index = 0; index < series; index += 1) {
      const id = `q${path}_${index}`;
      document.parts.push({ id, kind, label: id, x: 0, y: 0, thresholdVolts: 0, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: 0 });
      wire(`${id}gate`, id, gateTerminal, id, "b");
      wire(`${id}return`, id, fixedTerminal, index === series - 1 ? "g" : `q${path}_${index + 1}`, index === series - 1 ? "a" : gateTerminal);
    }
    if (path !== 0) { wire(`parallel${path}`, `q${path}_0`, gateTerminal, "q0_0", gateTerminal); }
  }
  for (let index = 0; index < sources; index += 1) {
    const id = `i${index}`;
    const current = sign * paths * channelCurrent / sources;
    document.parts.push({ id, kind: initial ? "inductor" : "current-source", label: id, x: 0, y: 0, ...(initial ? { inductanceHenries: 0.125, initialCurrentAmps: current } : { currentAmps: current }) });
    wire(`${id}return`, id, "a", "g", "a");
    wire(`${id}feed`, id, "b", "q0_0", gateTerminal);
  }
  return document;
}

const mixedCases = [false, true].flatMap((flipped) => [false, true].flatMap((initial) => [false, true].flatMap((grounded) => [false, true].map((aggregate) => ({ flipped, initial, grounded, aggregate })))));

it.each(mixedCases)("preserves a mixed-polarity microscopic network beside a one-ampere loop (flipped=$flipped, initial=$initial, grounded=$grounded, aggregate=$aggregate)", ({ flipped, initial, grounded, aggregate }) => {
  const voltage = 2 ** -198;
  const unitCurrent = 2 ** -401;
  const sign = flipped ? -1 : 1;
  const document: CircuitDocument = { title: "Mixed local controls at a shared reference", parts: [
    { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
    ...[0, 1, 2].map((index) => ({ id: `v${index}`, kind: "junction" as const, label: `V${index}`, x: 0, y: 0 })),
    { id: "localR", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 1 },
    { id: "localI", kind: "current-source", label: "I", x: 0, y: 0, currentAmps: 1 },
  ], wires: [] };
  const wire = (id: string, fromId: string, fromTerminal: CircuitTerminal, toId: string, toTerminal: CircuitTerminal) => document.wires.push({ id, from: { partId: fromId, terminal: fromTerminal }, to: { partId: toId, terminal: toTerminal } });
  for (const [index, [high, low]] of ([[2, 1], [1, 0], [2, 0]] as const).entries()) {
    const id = `q${index}`;
    const originalP = index === 1;
    const kind = originalP !== flipped ? "pmos" : "nmos";
    const current = sign * (high - low) ** 2 * unitCurrent;
    document.parts.push({ id, kind, label: id, x: 0, y: 0, thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 1 / 16, channelLengthModulation: 0 });
    wire(`${id}gate`, id, "a", id, "b");
    wire(`${id}a`, id, "a", `v${originalP ? low : high}`, "a");
    wire(`${id}c`, id, "c", `v${originalP ? high : low}`, "a");
    if (!aggregate) {
      document.parts.push({ id: `i${index}`, kind: initial ? "inductor" : "current-source", label: "I", x: 0, y: 0, ...(initial ? { inductanceHenries: 0.125, initialCurrentAmps: current } : { currentAmps: current }) });
      wire(`i${index}a`, `i${index}`, "a", `v${low}`, "a");
      wire(`i${index}b`, `i${index}`, "b", `v${high}`, "a");
    }
  }
  if (aggregate) {
    const current = sign * 5 * unitCurrent;
    document.parts.push({ id: "i", kind: initial ? "inductor" : "current-source", label: "I", x: 0, y: 0, ...(initial ? { inductanceHenries: 0.125, initialCurrentAmps: current } : { currentAmps: current }) });
    wire("ia", "i", "a", "v0", "a");
    wire("ib", "i", "b", "v2", "a");
  }
  wire("localA", "localI", "a", "localR", "b");
  wire("localB", "localI", "b", "localR", "a");
  wire("localReturn", "localR", "b", "v0", "a");
  if (grounded) { wire("ground", "v0", "a", "g", "a"); }
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const analysis = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: initial });
    expect(analysis.status, analysis.message).toBe("valid");
    for (const [index, factor] of [1, -1, 2].entries()) {
      expect(analysis.parts[`q${index}`]!.voltage.real / (sign * factor * voltage)).toBeCloseTo(1, 11);
      expect(analysis.parts[`q${index}`]!.current.real / (sign * Math.sign(factor) * factor ** 2 * unitCurrent)).toBeCloseTo(1, 11);
    }
    expect(analysis.parts.localR!.voltage.real).toBe(1);
    expect(analysis.parts.localR!.current.real).toBe(1);
  }
});

const unequalCases = (["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => [false, true].flatMap((initial) => [0, 2].flatMap((threshold) => [0, 0.03].map((lambda) => ({ kind, reverse, initial, threshold, lambda }))))));

it.each((["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => [false, true].map((initial) => ({ kind, reverse, initial })))))("balances unequal devices inside a weak series path ($kind, reverse=$reverse, initial=$initial)", ({ kind, reverse, initial }) => {
  const document = networkDocument({ kind, reverse, initial, paths: 2, series: 2, sources: 1, beta: 1 / 16, channelCurrent: 1 / 64, voltage: 1 });
  document.parts.find((part) => part.id === "q1_0")!.transconductanceAmpsPerVoltSquared = 2 ** -300;
  const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const analysis = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: initial });
    expect(analysis.status, analysis.message).toBe("valid");
    // Independent series KVL and equal current give Vweak/Vstrong=2^148.
    // Input rounds to 2 V, so the weak path has drops 2 V and 2^-147 V,
    // and both currents round to 2^-299 A. This is not a zero-current branch.
    expect(analysis.parts.q1_0!.voltage.real / (sign * 2)).toBeCloseTo(1, 11);
    expect(analysis.parts.q1_1!.voltage.real / (sign * 2 ** -147)).toBeCloseTo(1, 11);
    for (const id of ["q1_0", "q1_1"]) {
      expect(analysis.parts[id]!.current.real / (sign * 2 ** -299)).toBeCloseTo(1, 11);
    }
  }
});

it.each(unequalCases)("balances unequal parallel series paths ($kind, reverse=$reverse, initial=$initial, threshold=$threshold, lambda=$lambda)", ({ kind, reverse, initial, threshold, lambda }) => {
  const document = networkDocument({ kind, reverse, initial, paths: 2, series: 2, sources: 1, beta: 1 / 16, channelCurrent: 1 / 64, voltage: 1 });
  for (const part of document.parts) {
    if (part.id.startsWith("q1_")) { part.transconductanceAmpsPerVoltSquared = 2 ** -300; }
    if (part.kind === kind) { part.thresholdVolts = threshold; part.channelLengthModulation = lambda; }
  }
  // The weak coefficient changes the shared voltage by less than one
  // binary64 ulp. An independent scalar polynomial determines the drop.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const overdrive = (low + high) / 2;
    if (overdrive ** 2 * (1 + lambda * (threshold + overdrive)) > 1) { high = overdrive; }
    else { low = overdrive; }
  }
  const overdrive = (low + high) / 2;
  const voltage = threshold + overdrive;
  const weakCurrent = 2 ** -301 * overdrive ** 2 * (1 + lambda * voltage);
  const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const analysis = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: initial });
    expect(analysis.status, analysis.message).toBe("valid");
    for (let index = 0; index < 2; index += 1) {
      // Equal-length paths have equal local drops. Independently,
      // (V-threshold)^2*(1+lambda*V)=1 within the binary64 boundary.
      expect(analysis.parts[`q0_${index}`]!.voltage.real / (sign * voltage)).toBeCloseTo(1, 11);
      expect(analysis.parts[`q0_${index}`]!.current.real / (sign / 32)).toBeCloseTo(1, 11);
      expect(analysis.parts[`q1_${index}`]!.voltage.real / (sign * voltage)).toBeCloseTo(1, 11);
      expect(analysis.parts[`q1_${index}`]!.current.real / (sign * weakCurrent)).toBeCloseTo(1, 11);
    }
  }
});

it.each(cases)("scales $paths paths of $series $kind channels with $sources sources (initial=$initial, reverse=$reverse, beta=$beta)", (test) => {
  const document = networkDocument(test);
  const sign = (test.kind === "nmos" ? 1 : -1) * (test.reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const analysis = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: test.initial });
    expect(analysis.status, analysis.message).toBe("valid");
    for (let path = 0; path < test.paths; path += 1) {
      for (let index = 0; index < test.series; index += 1) {
        const reading = analysis.parts[`q${path}_${index}`]!;
        // Independent powers of two: beta*V^2/2=I_channel, parallel
        // KCL sums paths*I_channel, series KVL sums series*V.
        expect(reading.voltage.real / (sign * test.voltage)).toBeCloseTo(1, 11);
        expect(reading.current.real / (sign * test.channelCurrent)).toBeCloseTo(1, 11);
      }
    }
    expect(analysis.parts.i0!.voltage.real / (-(test.kind === "nmos" ? 1 : -1) * test.series * test.voltage)).toBeCloseTo(1, 11);
  }
});
