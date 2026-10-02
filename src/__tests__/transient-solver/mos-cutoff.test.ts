import { expect, it } from "vitest";
import type { CircuitDocument } from "../../circuit-model.js";
import { analysisAtTransientFrame, circuitNodes } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";
import { analyzeAnalogCircuit } from "../../analog-solver.js";

const cases = (["nmos", "pmos"] as const).flatMap((kind) => [0, 2].flatMap((threshold) => [0, 0.03].flatMap((lambda) => [false, true].map((reverse) => ({ kind, threshold, lambda, reverse })))));

function twoChannelDocument(kind: "nmos" | "pmos", reverse: boolean, beta: number, current: number) {
  const document = mosDocument(kind, 0, 0, reverse);
  document.parts.find((part) => part.id === "l")!.initialCurrentAmps = kind === "nmos" ? current : -current;
  document.parts.find((part) => part.id === "q")!.transconductanceAmpsPerVoltSquared = beta;
  document.parts.push({ id: "q2", kind, label: "Q2", x: 0, y: 0, thresholdVolts: 0, transconductanceAmpsPerVoltSquared: beta, channelLengthModulation: 0 });
  const gateTerminal = reverse ? "c" : "a";
  const fixedTerminal = reverse ? "a" : "c";
  document.wires = document.wires.map((wire) => wire.id === "qg" ? { ...wire, to: { partId: "q2", terminal: gateTerminal } } : wire);
  document.wires.push(
    { id: "q2gate", from: { partId: "q2", terminal: gateTerminal }, to: { partId: "q2", terminal: "b" } },
    { id: "q2g", from: { partId: "q2", terminal: fixedTerminal }, to: { partId: "g", terminal: "a" } },
  );
  return document;
}

const scaledCurrentCases = (["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => [
  { beta: 1 / 16, current: 2 ** -401, voltage: 2 ** -198 },
  { beta: Number.MIN_VALUE, current: 2 ** -875, voltage: 2 ** 100 },
  { beta: Number.MIN_VALUE, current: 2 ** -475, voltage: 2 ** 300 },
  { beta: Number.MIN_VALUE, current: 0.5, voltage: 2 ** 537 },
].map((scale) => ({ kind, reverse, ...scale }))));

it("keeps a shorted independent current source out of the MOS series-current seed", () => {
  const document = twoChannelDocument("nmos", false, 1 / 16, 2 ** -401);
  document.parts.push({ id: "shorted", kind: "current-source", label: "Shorted source", x: 0, y: 0, currentAmps: 1 });
  document.wires.push({ id: "shorted-loop", from: { partId: "shorted", terminal: "a" }, to: { partId: "shorted", terminal: "b" } });
  const analysis = analyzeAnalogCircuit(document, { mode: "dc", initialInductorCurrents: true });
  expect(analysis.status, analysis.message).toBe("valid");
  expect(analysis.parts.q!.voltage.real).toBe(2 ** -198);
  expect(analysis.parts.q!.current.real).toBe(2 ** -401);
  expect(analysis.parts.shorted!.voltage.real).toBe(0);
});

const parallelCurrentCases = (["nmos", "pmos"] as const).flatMap((kind) => [false, true].flatMap((reverse) => [
  { beta: 1 / 16, current: 2 ** -400, voltage: 2 ** -198 },
  { beta: Number.MIN_VALUE, current: 1, voltage: 2 ** 537 },
].map((scale) => ({ kind, reverse, ...scale }))));

function parallelChannelDocument(kind: "nmos" | "pmos", reverse: boolean, beta: number, current: number) {
  const document = twoChannelDocument(kind, reverse, beta, current);
  document.parts = document.parts.filter((part) => !["s", "r", "l"].includes(part.id));
  document.parts.push({ id: "i", kind: "current-source", label: "I", x: 0, y: 0, currentAmps: kind === "nmos" ? current : -current });
  document.wires = document.wires.filter((wire) => !["s", "r", "l"].includes(wire.from.partId) && !["s", "r", "l"].includes(wire.to.partId));
  const gateTerminal = reverse ? "c" : "a";
  document.wires = document.wires.map((wire) => wire.id === "qg" ? { ...wire, to: { partId: "g", terminal: "a" } } : wire);
  document.wires.push(
    { id: "parallel", from: { partId: "q", terminal: gateTerminal }, to: { partId: "q2", terminal: gateTerminal } },
    { id: "ig", from: { partId: "i", terminal: "a" }, to: { partId: "g", terminal: "a" } },
    { id: "iq", from: { partId: "i", terminal: "b" }, to: { partId: "q", terminal: gateTerminal } },
  );
  return document;
}

it.each(parallelCurrentCases)("seeds parallel $kind channels driven by current=$current (reverse=$reverse)", ({ kind, reverse, beta, current, voltage }) => {
  const document = parallelChannelDocument(kind, reverse, beta, current);
  const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const dc = analyzeAnalogCircuit(variant, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    for (const id of ["q", "q2"]) {
      // Two identical channels satisfy I_total=beta*V^2 independently.
      expect(dc.parts[id]!.voltage.real / (sign * voltage)).toBeCloseTo(1, 11);
      expect(dc.parts[id]!.current.real / (sign * current / 2)).toBeCloseTo(1, 11);
    }
    expect(dc.parts.i!.voltage.real / (-(kind === "nmos" ? 1 : -1) * voltage)).toBeCloseTo(1, 11);
  }
});

it.each([false, true])("resolves unequal parallel channels with an independent tiny-current oracle (cutoff=%s)", (cutoff) => {
  const current = 2 ** (cutoff ? -401 : -399);
  const document = parallelChannelDocument("nmos", false, 1 / 16, current);
  const second = document.parts.find((part) => part.id === "q2")!;
  second.transconductanceAmpsPerVoltSquared = cutoff ? 1 / 16 : 3 / 16;
  second.thresholdVolts = cutoff ? 2 : 0;
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = simulateTransient(variant, { durationSeconds: 1 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      for (let index = 0; index <= 1; index += 1) {
        const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: index })!;
        // Independent square laws: V=2^-198, I1=2^-401. The second
        // channel carries three times I1 or is below its 2 V threshold.
        expect(frame.parts.q!.voltageVolts / 2 ** -198).toBeCloseTo(1, 11);
        expect(frame.parts.q!.currentAmps / 2 ** -401).toBeCloseTo(1, 11);
        if (cutoff) { expect(frame.parts.q2!.currentAmps).toBe(0); }
        else { expect(frame.parts.q2!.currentAmps / (3 * 2 ** -401)).toBeCloseTo(1, 11); }
        expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / current < 1e-11)).toBe(true);
      }
    }
  }
});

it("seeds a floating parallel channel group when the gate is the coordinate reference", () => {
  const document = parallelChannelDocument("nmos", false, 1 / 16, 2 ** -400);
  document.parts = document.parts.filter((part) => part.id !== "g").sort((left, right) => Number(left.id === "i") - Number(right.id === "i"));
  document.wires = document.wires.filter((wire) => wire.id !== "ig").map((wire) => ({
    ...wire,
    from: wire.from.partId === "g" ? { partId: "i", terminal: "a" as const } : wire.from,
    to: wire.to.partId === "g" ? { partId: "i", terminal: "a" as const } : wire.to,
  }));
  const dc = analyzeAnalogCircuit(document, { mode: "dc" });
  expect(dc.status, dc.message).toBe("valid");
  expect(dc.parts.q!.voltage.real).toBe(2 ** -198);
  expect(dc.parts.q2!.current.real).toBe(2 ** -401);
});

it.each(parallelCurrentCases)("keeps an opposite-polarity parallel $kind channel off at current=$current (reverse=$reverse)", ({ kind, reverse, beta, current, voltage }) => {
  const document = parallelChannelDocument(kind, reverse, beta, current / 2);
  document.parts.find((part) => part.id === "q2")!.kind = kind === "nmos" ? "pmos" : "nmos";
  const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const dc = analyzeAnalogCircuit(variant, { mode: "dc" });
    expect(dc.status, dc.message).toBe("valid");
    // The one conducting channel takes all I: I=(beta/2)*V^2.
    expect(dc.parts.q!.voltage.real / (sign * voltage)).toBeCloseTo(1, 11);
    expect(dc.parts.q!.current.real / (sign * current / 2)).toBeCloseTo(1, 11);
    expect(dc.parts.q2!.current.real).toBe(0);
    expect(dc.parts.q2!.channelConducting).toBe(false);
  }
});

it.each(scaledCurrentCases)("scales the $kind series seed to current=$current and beta=$beta (reverse=$reverse)", ({ kind, reverse, beta, current, voltage }) => {
  const document = twoChannelDocument(kind, reverse, beta, current);
  const sign = (kind === "nmos" ? 1 : -1) * (reverse ? -1 : 1);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const dc = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: true });
    expect(dc.status, dc.message).toBe("valid");
    for (const id of ["q", "q2"]) {
      // Independent powers of two satisfy I=(beta/2)*V^2 exactly, even
      // when computing 2*I/beta in binary64 would overflow first.
      expect(dc.parts[id]!.voltage.real / (sign * voltage)).toBeCloseTo(1, 11);
      expect(dc.parts[id]!.current.real / (sign * current)).toBeCloseTo(1, 11);
    }
    const original = simulateTransient(variant, { durationSeconds: 1 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: 0 })!;
      expect(frame.parts.q!.currentAmps / (sign * current)).toBeCloseTo(1, 11);
      expect(frame.parts.q2!.voltageVolts / (sign * voltage)).toBeCloseTo(1, 11);
      expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / current < 1e-11)).toBe(true);
    }
  }
});

function mosDocument(kind: "nmos" | "pmos", threshold: number, lambda: number, reverse: boolean): CircuitDocument {
  const sign = kind === "nmos" ? 1 : -1;
  const supply = threshold + 1.3;
  return {
    title: "Zero-current MOS inductive startup",
    parts: [
      { id: "s", kind: "battery", label: "S", x: 0, y: 0, voltageVolts: supply },
      { id: "r", kind: "resistor", label: "R", x: 0, y: 0, resistanceOhms: 32 },
      { id: "l", kind: "inductor", label: "L", x: 0, y: 0, inductanceHenries: 0.125, initialCurrentAmps: 0 },
      { id: "q", kind, label: "Q", x: 0, y: 0, thresholdVolts: threshold, transconductanceAmpsPerVoltSquared: 0.04, channelLengthModulation: lambda },
      { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
    ], wires: [
      { id: "sr", from: { partId: "s", terminal: sign === 1 ? "a" : "b" }, to: { partId: "r", terminal: "a" } },
      { id: "rl", from: { partId: "r", terminal: "b" }, to: { partId: "l", terminal: "a" } },
      { id: "lq", from: { partId: "l", terminal: "b" }, to: { partId: "q", terminal: reverse ? "c" : "a" } },
      { id: "feedback", from: { partId: "q", terminal: reverse ? "c" : "a" }, to: { partId: "q", terminal: "b" } },
      { id: "qg", from: { partId: "q", terminal: reverse ? "a" : "c" }, to: { partId: "g", terminal: "a" } },
      { id: "sg", from: { partId: "s", terminal: sign === 1 ? "b" : "a" }, to: { partId: "g", terminal: "a" } },
    ],
  };
}

it.each(cases)("starts a diode-connected $kind at exact cutoff (threshold=$threshold, lambda=$lambda, reverse=$reverse)", ({ kind, threshold, lambda, reverse }) => {
  const sign = kind === "nmos" ? 1 : -1;
  const supply = threshold + 1.3;
  const document = mosDocument(kind, threshold, lambda, reverse);
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = simulateTransient(variant, { durationSeconds: 4 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    expect(original.samples).toHaveLength(5);
    const initial = original.samples[0]!.parts;
    expect(Math.abs(initial.l!.currentAmps)).toBe(0);
    expect(initial.q!.voltageVolts).toBe(threshold === 0 ? 0 : (reverse ? -sign : sign) * threshold);
    expect(initial.l!.voltageVolts).toBe(sign * (supply - threshold));
    const currents: number[] = [];
    let previous = 0;
    for (let index = 0; index < 4; index += 1) {
      // Independent BE and square-law polynomial oracle. L/h=16 and R=32;
      // v=Vs+16*Iprev-48*I, I=.02*(v-threshold)^2*(1+lambda*v).
      let low = threshold;
      let high = supply + 16 * previous;
      for (let iteration = 0; iteration < 80; iteration += 1) {
        const voltage = (low + high) / 2;
        const current = 0.02 * (voltage - threshold) ** 2 * (1 + lambda * voltage);
        if (voltage + 48 * current > supply + 16 * previous) { high = voltage; } else { low = voltage; }
      }
      previous = 0.02 * (((low + high) / 2) - threshold) ** 2 * (1 + lambda * ((low + high) / 2));
      currents.push(previous);
    }
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      for (const [index, expected] of currents.entries()) {
        const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: index + 1 })!;
        expect(frame.parts.l!.currentAmps / (sign * expected)).toBeCloseTo(1, 11);
        expect(frame.parts.q!.currentAmps / ((reverse ? -sign : sign) * expected)).toBeCloseTo(1, 11);
        expect(frame.status).toBe("closed");
        expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / expected < 1e-11)).toBe(true);
      }
    }
  }
});

it.each([0.001, 0.01])("keeps a cutoff startup independent of a second channel carrying %s amperes", (initialCurrentAmps) => {
  const document = mosDocument("nmos", 0, 0.03, false);
  const biased: CircuitDocument = {
    ...document,
    parts: document.parts.map((part) => ({ ...part, id: `biased_${part.id}`, ...(part.kind === "inductor" ? { initialCurrentAmps } : {}) })),
    wires: document.wires.map((wire) => ({ ...wire, id: `biased_${wire.id}`, from: { ...wire.from, partId: `biased_${wire.from.partId}` }, to: { ...wire.to, partId: `biased_${wire.to.partId}` } })),
  };
  const combined = { ...document, parts: [...document.parts, ...biased.parts], wires: [...document.wires, ...biased.wires] };
  const options = { durationSeconds: 4 / 128, timeStepSeconds: 1 / 128 };
  const alone = simulateTransient(document, options);
  const biasedAlone = simulateTransient(biased, options);
  expect(alone.status).toBe("valid");
  expect(biasedAlone.status).toBe("valid");
  for (const variant of [combined, { ...combined, parts: [...combined.parts].reverse(), wires: [...combined.wires].reverse() }]) {
    const original = simulateTransient(variant, options);
    expect(original.status, original.message).toBe("valid");
    // Independent circuits share only their ground. Adding a biased channel
    // cannot change the startup oracle or erase the other channel's current.
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      expect(analysis.samples[0]!.parts.q!.voltageVolts).toBe(0);
      expect(analysis.samples[0]!.parts.biased_q!.currentAmps / initialCurrentAmps).toBeCloseTo(1, 11);
      for (let index = 1; index < analysis.samples.length; index += 1) {
        expect(analysis.samples[index]!.parts.l!.currentAmps / alone.samples[index]!.parts.l!.currentAmps).toBeCloseTo(1, 11);
        expect(analysis.samples[index]!.parts.biased_l!.currentAmps / biasedAlone.samples[index]!.parts.biased_l!.currentAmps).toBeCloseTo(1, 11);
        const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: index })!;
        const currentScale = Math.max(frame.parts.l!.currentAmps, frame.parts.biased_l!.currentAmps);
        expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / currentScale < 1e-11)).toBe(true);
      }
    }
  }
});

const chainCases = (["nmos", "pmos"] as const).flatMap((kind) => [0, 2].flatMap((threshold) => [2, 3].flatMap((count) => [false, true].map((reverse) => ({ kind, threshold, count, reverse })))));

it("reconciles a cutoff candidate with a second MOS controlled by its gate", () => {
  const document = mosDocument("nmos", 0, 0.03, false);
  document.parts.push(
    { id: "out", kind: "battery", label: "Out", x: 0, y: 0, voltageVolts: 5 },
    { id: "load", kind: "resistor", label: "Load", x: 0, y: 0, resistanceOhms: 100 },
    { id: "controlled", kind: "nmos", label: "Controlled", x: 0, y: 0, thresholdVolts: 0, transconductanceAmpsPerVoltSquared: 0.04, channelLengthModulation: 0.03 },
  );
  document.wires.push(
    { id: "ol", from: { partId: "out", terminal: "a" }, to: { partId: "load", terminal: "a" } },
    { id: "lc", from: { partId: "load", terminal: "b" }, to: { partId: "controlled", terminal: "a" } },
    { id: "cg", from: { partId: "controlled", terminal: "c" }, to: { partId: "g", terminal: "a" } },
    { id: "og", from: { partId: "out", terminal: "b" }, to: { partId: "g", terminal: "a" } },
    { id: "control", from: { partId: "q", terminal: "b" }, to: { partId: "controlled", terminal: "b" } },
  );
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = simulateTransient(variant, { durationSeconds: 1 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      expect(analysis.samples[0]!.parts.q!.currentAmps).toBe(0);
      expect(analysis.samples[0]!.parts.controlled!.currentAmps).toBe(0);
      expect(analysis.samples[0]!.parts.controlled!.voltageVolts).toBe(5);
      const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: 1 })!;
      // Independent square law, a zero-current gate and Ohm's law:
      // Q1's BE current is unaffected; Vout=5-100*.02*Vg^2*(1+.03*Vout).
      expect(frame.parts.l!.currentAmps / 0.011_476_338_482_046_615).toBeCloseTo(1, 11);
      const gate = frame.parts.q!.voltageVolts;
      const output = (5 - 2 * gate ** 2) / (1 + 0.06 * gate ** 2);
      expect(frame.parts.controlled!.voltageVolts / output).toBeCloseTo(1, 11);
      expect(frame.parts.controlled!.currentAmps / ((5 - output) / 100)).toBeCloseTo(1, 11);
      expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / frame.parts.l!.currentAmps < 1e-11)).toBe(true);
    }
  }
});

it.each([false, true])("seeds a subnormal-current series MOS chain (reverse=%s)", (reverse) => {
  const document = mosDocument("nmos", 0, 0, reverse);
  document.parts.find((part) => part.id === "l")!.initialCurrentAmps = 8 * Number.MIN_VALUE;
  document.parts.find((part) => part.id === "q")!.transconductanceAmpsPerVoltSquared = Number.MIN_VALUE;
  document.parts.push({ id: "q2", kind: "nmos", label: "Q2", x: 0, y: 0, thresholdVolts: 0, transconductanceAmpsPerVoltSquared: Number.MIN_VALUE, channelLengthModulation: 0 });
  const gateTerminal = reverse ? "c" : "a";
  const fixedTerminal = reverse ? "a" : "c";
  document.wires = document.wires.map((wire) => wire.id === "qg" ? { ...wire, to: { partId: "q2", terminal: gateTerminal } } : wire);
  document.wires.push(
    { id: "q2gate", from: { partId: "q2", terminal: gateTerminal }, to: { partId: "q2", terminal: "b" } },
    { id: "q2g", from: { partId: "q2", terminal: fixedTerminal }, to: { partId: "g", terminal: "a" } },
  );
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const dc = analyzeAnalogCircuit(variant, { mode: "dc", initialInductorCurrents: true });
    expect(dc.status, dc.message).toBe("valid");
    const original = simulateTransient(variant, { durationSeconds: 1 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      // Independent exact square law: (1/2)*MIN*4^2 = 8*MIN.
      for (const id of ["q", "q2"]) {
        expect(analysis.samples[0]!.parts[id]!.voltageVolts / (reverse ? -4 : 4)).toBeCloseTo(1, 11);
        expect(analysis.samples[0]!.parts[id]!.currentAmps).toBe((reverse ? -8 : 8) * Number.MIN_VALUE);
      }
      const initial = analysisAtTransientFrame(variant, { analysis, sampleIndex: 0 })!;
      expect(circuitNodes(variant, initial).every((node) => node.currentResidualAmps === 0)).toBe(true);
      const last = analysisAtTransientFrame(variant, { analysis, sampleIndex: 1 })!;
      expect(last.status).toBe("closed");
      expect(circuitNodes(variant, last).every((node) => node.currentResidualAmps === 0)).toBe(true);
    }
  }
});

it.each([false, true])("starts a cutoff channel with a shared finite return (floating=%s)", (floating) => {
  const first = mosDocument("nmos", 0, 0.03, false);
  const document: CircuitDocument = {
    ...first,
    parts: [...first.parts, ...first.parts.map((part) => ({ ...part, id: `biased_${part.id}`, ...(part.kind === "inductor" ? { initialCurrentAmps: 0.001 } : {}) })),
      { id: "return", kind: "resistor", label: "Return", x: 0, y: 0, resistanceOhms: 16 }],
    wires: [...first.wires, ...first.wires.map((wire) => ({ ...wire, id: `biased_${wire.id}`, from: { ...wire.from, partId: `biased_${wire.from.partId}` }, to: { ...wire.to, partId: `biased_${wire.to.partId}` } })),
      { id: "rg", from: { partId: "return", terminal: "b" }, to: { partId: "g", terminal: "a" } },
      { id: "gg", from: { partId: "g", terminal: "a" }, to: { partId: "biased_g", terminal: "a" } }],
  };
  document.wires = document.wires.map((wire) => wire.id === "qg" || wire.id === "biased_qg" ? { ...wire, to: { partId: "return", terminal: "a" } } : wire);
  if (floating) { document.parts = document.parts.map((part) => part.kind === "ground" ? { ...part, kind: "junction" } : part); }
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = simulateTransient(variant, { durationSeconds: 2 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      expect(analysis.samples[0]!.parts.q!.currentAmps).toBe(0);
      expect(analysis.samples[0]!.parts.return!.voltageVolts).toBe(0.016);
      let previous = [0, 0.001];
      for (let step = 1; step <= 2; step += 1) {
        const currentsAtReturn = (returnVoltage: number) => previous.map((current) => {
          const supply = 1.3 + 16 * current - returnVoltage;
          let low = 0;
          let high = Math.max(0, supply);
          for (let iteration = 0; iteration < 80; iteration += 1) {
            const voltage = (low + high) / 2;
            const channel = 0.02 * voltage ** 2 * (1 + 0.03 * voltage);
            if (voltage + 48 * channel > supply) { high = voltage; } else { low = voltage; }
          }
          const voltage = (low + high) / 2;
          return 0.02 * voltage ** 2 * (1 + 0.03 * voltage);
        });
        let low = 0;
        let high = 1.3;
        for (let iteration = 0; iteration < 80; iteration += 1) {
          const returnVoltage = (low + high) / 2;
          const currents = currentsAtReturn(returnVoltage);
          if (returnVoltage > 16 * (currents[0]! + currents[1]!)) { high = returnVoltage; } else { low = returnVoltage; }
        }
        previous = currentsAtReturn((low + high) / 2);
        const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: step })!;
        expect(frame.parts.l!.currentAmps / previous[0]!).toBeCloseTo(1, 11);
        expect(frame.parts.biased_l!.currentAmps / previous[1]!).toBeCloseTo(1, 11);
        expect(frame.parts.return!.voltageVolts / (16 * (previous[0]! + previous[1]!))).toBeCloseTo(1, 11);
        expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / previous[0]! < 1e-11)).toBe(true);
      }
    }
  }
});

it.each(chainCases)("starts $count series $kind channels at cutoff (threshold=$threshold, reverse=$reverse)", ({ kind, threshold, count, reverse }) => {
  const sign = kind === "nmos" ? 1 : -1;
  const document = mosDocument(kind, threshold, 0.03, reverse);
  const supply = count * threshold + 1.3;
  document.parts.find((part) => part.id === "s")!.voltageVolts = supply;
  document.parts = document.parts.filter((part) => part.id !== "q");
  document.wires = document.wires.filter((wire) => wire.from.partId !== "q" && wire.to.partId !== "q");
  for (let index = 0; index < count; index += 1) {
    const id = `q${index}`;
    const gateTerminal = reverse ? "c" : "a";
    const fixedTerminal = reverse ? "a" : "c";
    document.parts.push({ id, kind, label: id, x: 0, y: 0, thresholdVolts: threshold, transconductanceAmpsPerVoltSquared: 0.04, channelLengthModulation: 0.03 });
    document.wires.push(
      { id: `${id}gate`, from: { partId: id, terminal: gateTerminal }, to: { partId: id, terminal: "b" } },
      { id: `${id}return`, from: { partId: id, terminal: fixedTerminal }, to: index === count - 1 ? { partId: "g", terminal: "a" } : { partId: `q${index + 1}`, terminal: gateTerminal } },
    );
  }
  document.wires.push({ id: "lq0", from: { partId: "l", terminal: "b" }, to: { partId: "q0", terminal: reverse ? "c" : "a" } });
  for (const variant of [document, { ...document, parts: [...document.parts].reverse(), wires: [...document.wires].reverse() }]) {
    const original = simulateTransient(variant, { durationSeconds: 2 / 128, timeStepSeconds: 1 / 128 });
    expect(original.status, original.message).toBe("valid");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const initial = analysis.samples[0]!;
      for (let index = 0; index < count; index += 1) {
        expect(Math.abs(initial.parts[`q${index}`]!.currentAmps)).toBe(0);
        expect(initial.parts[`q${index}`]!.voltageVolts).toBe(threshold === 0 ? 0 : (reverse ? -sign : sign) * threshold);
      }
      expect(initial.parts.l!.voltageVolts).toBe(sign * (supply - count * threshold));
      const initialFrame = analysisAtTransientFrame(variant, { analysis, sampleIndex: 0 })!;
      expect(circuitNodes(variant, initialFrame).every((node) => node.currentResidualAmps === 0)).toBe(true);
      let previous = 0;
      for (let step = 1; step <= 2; step += 1) {
        // Equal monotone channels carry the same current and local voltage.
        // Independent KVL and BE: N*v+48*I=Vs+16*Iprev.
        let low = threshold;
        let high = (supply + 16 * previous) / count;
        for (let iteration = 0; iteration < 80; iteration += 1) {
          const voltage = (low + high) / 2;
          const current = 0.02 * (voltage - threshold) ** 2 * (1 + 0.03 * voltage);
          if (count * voltage + 48 * current > supply + 16 * previous) { high = voltage; } else { low = voltage; }
        }
        const voltage = (low + high) / 2;
        previous = 0.02 * (voltage - threshold) ** 2 * (1 + 0.03 * voltage);
        const frame = analysisAtTransientFrame(variant, { analysis, sampleIndex: step })!;
        expect(frame.parts.l!.currentAmps / (sign * previous)).toBeCloseTo(1, 11);
        for (let index = 0; index < count; index += 1) {
          expect(frame.parts[`q${index}`]!.currentAmps / ((reverse ? -sign : sign) * previous)).toBeCloseTo(1, 11);
        }
        expect(circuitNodes(variant, frame).every((node) => Math.abs(node.currentResidualAmps) / previous < 1e-11)).toBe(true);
      }
    }
  }
});
