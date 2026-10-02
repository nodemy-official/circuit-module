import { describe, expect, it } from "vitest";
import type { CircuitDocument, CircuitTerminal } from "../../circuit-model.js";
import { analyzeCircuit } from "../../circuit-solver.js";
import { analysisAtTransientFrame, circuitNodes, circuitPotential } from "../../circuit-visualization.js";
import { simulateTransient } from "../../transient-solver.js";

function highResistanceCircuit(potentiometer: boolean): CircuitDocument {
  const lastTerminal = potentiometer ? "c" : "b";
  return {
    title: "大きな共通電位に重なる微小な直流電圧",
    parts: [
      { id: "source", kind: "battery", label: "電源", x: 0, y: 0, voltageVolts: 9 },
      { id: "small", kind: potentiometer ? "potentiometer" : "resistor", label: "微小電圧", x: 0, y: 0, resistanceOhms: 1, wiperPosition: 0.25 },
      { id: "next", kind: "resistor", label: "次の抵抗", x: 0, y: 0, resistanceOhms: 2 },
      { id: "large", kind: "resistor", label: "大きな抵抗", x: 0, y: 0, resistanceOhms: 1e20 },
      { id: "ground", kind: "ground", label: "GND", x: 0, y: 0 },
    ],
    wires: [
      { id: "supply", from: { partId: "source", terminal: "a" }, to: { partId: "small", terminal: "a" } },
      { id: "middle", from: { partId: "small", terminal: lastTerminal }, to: { partId: "next", terminal: "a" } },
      { id: "load", from: { partId: "next", terminal: "b" }, to: { partId: "large", terminal: "a" } },
      { id: "return", from: { partId: "large", terminal: "b" }, to: { partId: "source", terminal: "b" } },
      { id: "ground", from: { partId: "ground", terminal: "a" }, to: { partId: "source", terminal: "b" } },
    ],
  };
}

describe("DC potential display precision", () => {
  it("keeps potentiometer segment voltages when segment resistance underflows", () => {
    const document: CircuitDocument = {
      title: "Potentiometer with unrepresentable segment resistance",
      parts: [
        { id: "v", kind: "battery", label: "V", x: 0, y: 0, voltageVolts: 2 * Number.MIN_VALUE, internalResistanceOhms: 0 },
        { id: "p", kind: "potentiometer", label: "P", x: 0, y: 0, resistanceOhms: Number.MIN_VALUE, wiperPosition: 0.5 },
      ],
      wires: [
        { id: "a", from: { partId: "v", terminal: "a" }, to: { partId: "p", terminal: "a" } },
        { id: "b", from: { partId: "v", terminal: "b" }, to: { partId: "p", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document);
    expect(original.status, original.message).toBe("closed");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      // Exercise the terminal-current fallback used without local differences.
      analysis.parts.p!.terminalVoltageDifferences = undefined;
      const nodes = circuitNodes(document, analysis);
      const node = (terminal: CircuitTerminal) => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === "p" && endpoint.terminal === terminal));
      const context = { document, analysis, nodes };
      // An unloaded midpoint divides the source voltage into equal halves.
      expect(circuitPotential(node("a"), node("c"), false, context)?.volts).toBe(Number.MIN_VALUE);
      expect(circuitPotential(node("c"), node("a"), false, context)?.volts).toBe(-Number.MIN_VALUE);
      expect(circuitPotential(node("b"), node("c"), false, context)?.volts).toBe(-Number.MIN_VALUE);
      expect(circuitPotential(node("c"), node("b"), false, context)?.volts).toBe(Number.MIN_VALUE);
    }
  });

  it.each(["dc", "ac"] as const)("subtracts nearly equal %s divider outputs using retained branch values", (mode) => {
    const document: CircuitDocument = {
      title: "Nearly equal divider outputs without a direct measurement branch",
      parts: [
        { id: "v", kind: mode === "dc" ? "battery" : "ac-source", label: "V", x: 0, y: 0, voltageVolts: 1, internalResistanceOhms: 0, frequencyHz: 50, phaseDegrees: 0 },
        ...["la", "lb", "ra", "rb", "tiny"].map((id) => ({ id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: id === "tiny" ? 1e-20 : 1 })),
        { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "vl", from: { partId: "v", terminal: "a" }, to: { partId: "la", terminal: "a" } },
        { id: "ll", from: { partId: "la", terminal: "b" }, to: { partId: "lb", terminal: "a" } },
        { id: "lv", from: { partId: "lb", terminal: "b" }, to: { partId: "v", terminal: "b" } },
        { id: "vt", from: { partId: "v", terminal: "a" }, to: { partId: "tiny", terminal: "a" } },
        { id: "tr", from: { partId: "tiny", terminal: "b" }, to: { partId: "ra", terminal: "a" } },
        { id: "rr", from: { partId: "ra", terminal: "b" }, to: { partId: "rb", terminal: "a" } },
        { id: "rv", from: { partId: "rb", terminal: "b" }, to: { partId: "v", terminal: "b" } },
        { id: "g", from: { partId: "g", terminal: "a" }, to: { partId: "v", terminal: "b" } },
      ],
    };
    const original = analyzeCircuit(document, {}, { mode });
    expect(original.status, original.message).toBe("closed");
    for (const analysis of [original, JSON.parse(JSON.stringify(original)) as typeof original, structuredClone(original)]) {
      const nodes = circuitNodes(document, analysis);
      const node = (id: string) => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === id && endpoint.terminal === "a"));
      expect(node("lb")!.voltageVolts).toBe(0.5);
      expect(node("rb")!.voltageVolts).toBe(0.5);
      const context = { document, analysis, nodes };
      // Independent 1/2 - 1/(2+r) = r/[2(2+r)].
      expect(circuitPotential(node("lb"), node("rb"), mode === "ac", context)!.volts).toBe(2.5e-21);
      expect(circuitPotential(node("rb"), node("lb"), mode === "ac", context)!.volts).toBe(mode === "ac" ? 2.5e-21 : -2.5e-21);
    }
  });

  it("retains an open switch's voltage when both terminal potentials round to the same value", () => {
    for (const mode of ["dc", "ac"] as const) {
      const document: CircuitDocument = {
        title: "Open switch between nearly equal divider outputs",
        parts: [
          { id: "v", kind: mode === "dc" ? "battery" : "ac-source", label: "V", x: 0, y: 0, voltageVolts: 1, internalResistanceOhms: 0, frequencyHz: 1, phaseDegrees: 0 },
          ...["leftTop", "leftBottom", "rightTop", "rightBottom", "tiny"].map((id) => ({
            id, kind: "resistor" as const, label: id, x: 0, y: 0, resistanceOhms: id === "tiny" ? 1e-20 : 1,
          })),
          { id: "s", kind: "switch", label: "S", x: 0, y: 0, initiallyClosed: false },
          { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
        ],
        wires: [
          { id: "vl", from: { partId: "v", terminal: "a" }, to: { partId: "leftTop", terminal: "a" } },
          { id: "la", from: { partId: "leftTop", terminal: "b" }, to: { partId: "leftBottom", terminal: "a" } },
          { id: "lb", from: { partId: "leftBottom", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          { id: "vt", from: { partId: "v", terminal: "a" }, to: { partId: "tiny", terminal: "a" } },
          { id: "tr", from: { partId: "tiny", terminal: "b" }, to: { partId: "rightTop", terminal: "a" } },
          { id: "ra", from: { partId: "rightTop", terminal: "b" }, to: { partId: "rightBottom", terminal: "a" } },
          { id: "rb", from: { partId: "rightBottom", terminal: "b" }, to: { partId: "v", terminal: "b" } },
          { id: "sl", from: { partId: "s", terminal: "a" }, to: { partId: "leftBottom", terminal: "a" } },
          { id: "sr", from: { partId: "s", terminal: "b" }, to: { partId: "rightBottom", terminal: "a" } },
          { id: "g", from: { partId: "g", terminal: "a" }, to: { partId: "v", terminal: "b" } },
        ],
      };
      const analysis = analyzeCircuit(document, {}, { mode });
      const analyses = [analysis];
      if (mode === "dc") {
        const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
        expect(transient.status, transient.message).toBe("valid");
        analyses.push(...transient.samples.map((_, sampleIndex) => analysisAtTransientFrame(document, { analysis: transient, sampleIndex })!));
      }
      for (const original of analyses) {
        for (const result of [original, JSON.parse(JSON.stringify(original)) as typeof original]) {
          expect(result.status, result.message).toBe("closed");
          expect(result.parts.s!.currentAmps).toBe(0);
          expect(result.parts.s!.switchClosed).toBe(false);
          // Independent voltage divider: 1/2 - 1/(2+r) = r/[2(2+r)].
          const expected = 1e-20 / (2 * (2 + 1e-20));
          expect(result.parts.s!.voltageVolts).toBe(expected);
          const nodes = circuitNodes(document, result);
          const node = (terminal: CircuitTerminal) => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === "s" && endpoint.terminal === terminal));
          expect(node("a")!.voltageVolts).toBe(node("b")!.voltageVolts);
          const context = { document, analysis: result, nodes };
          expect(circuitPotential(node("a"), node("b"), mode === "ac", context)!.volts).toBe(expected);
          expect(circuitPotential(node("b"), node("a"), mode === "ac", context)!.volts).toBe(mode === "ac" ? expected : -expected);
          if (mode === "ac") {
            expect(circuitPotential(node("a"), node("b"), true, context)!.phaseDegrees).toBe(0);
            expect(Math.abs(circuitPotential(node("b"), node("a"), true, context)!.phaseDegrees)).toBe(180);
          }
        }
      }
    }
  });

  it.each([false, true])("keeps potentiometer voltages when terminal current underflows (loaded=%s)", (loaded) => {
    const voltageVolts = 2 ** -80;
    for (const mode of ["dc", "ac"] as const) {
      const document: CircuitDocument = {
        title: "Potentiometer voltage with unrepresentable current",
        parts: [
          { id: "v", kind: mode === "dc" ? "battery" : "ac-source", label: "V", x: 0, y: 0, voltageVolts, internalResistanceOhms: 0, frequencyHz: 1, phaseDegrees: 0 },
          { id: "p", kind: "potentiometer", label: "P", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE, wiperPosition: 0.75 },
          { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
          ...(loaded ? [{ id: "r", kind: "resistor" as const, label: "R", x: 0, y: 0, resistanceOhms: Number.MAX_VALUE }] : []),
        ],
        wires: [
          { id: "va", from: { partId: "v", terminal: "a" }, to: { partId: "p", terminal: "a" } },
          { id: "vb", from: { partId: "v", terminal: "b" }, to: { partId: "p", terminal: "b" } },
          { id: "g", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
          ...(loaded ? [
            { id: "load", from: { partId: "p", terminal: "c" as const }, to: { partId: "r", terminal: "a" as const } },
            { id: "return", from: { partId: "p", terminal: "b" as const }, to: { partId: "r", terminal: "b" as const } },
          ] : []),
        ],
      };
      const analysis = analyzeCircuit(document, {}, { mode });
      expect(analysis.status, analysis.message).toBe("closed");
      expect(analysis.parts.p!.terminalCurrents!.a).toBe(0);
      const analyses = [analysis, JSON.parse(JSON.stringify(analysis)) as typeof analysis];
      if (mode === "dc") {
        const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
        expect(transient.status, transient.message).toBe("valid");
        analyses.push(...transient.samples.map((_, sampleIndex) => analysisAtTransientFrame(document, { analysis: transient, sampleIndex })!));
      }
      for (const result of analyses) {
        const nodes = circuitNodes(document, result);
        const node = (terminal: CircuitTerminal) => nodes.find((candidate) => candidate.endpoints.some((endpoint) => endpoint.partId === "p" && endpoint.terminal === terminal));
        const context = { document, analysis: result, nodes };
        // Unloaded: 3/4 and 1/4. Loaded: (1/4)||1=1/5,
        // so the total is 19/20 and the segment ratios are 15/19,4/19.
        const ac = mode === "ac";
        const expected = voltageVolts * (loaded ? 15 / 19 : 0.75);
        expect(circuitPotential(node("a"), node("c"), ac, context)!.volts / expected).toBeCloseTo(1, 14);
        expect(circuitPotential(node("c"), node("a"), ac, context)!.volts / expected).toBeCloseTo(ac ? 1 : -1, 14);
        const second = voltageVolts * (loaded ? 4 / 19 : 0.25);
        expect(circuitPotential(node("b"), node("c"), ac, context)!.volts / second).toBeCloseTo(ac ? 1 : -1, 14);
        if (ac) {
          expect(circuitPotential(node("a"), node("c"), true, context)!.phaseDegrees).toBe(0);
          expect(Math.abs(circuitPotential(node("b"), node("c"), true, context)!.phaseDegrees)).toBe(180);
        }
      }
    }
  });

  it.each(["nmos", "pmos"] as const)("uses the local %s branch voltage above a large common potential in DC and transient frames", (kind) => {
    const sign = kind === "nmos" ? 1 : -1;
    const document: CircuitDocument = {
      title: "Local MOS voltage above binary64 common-mode resolution",
      parts: [
        { id: "v", kind: "battery", label: "V", x: 0, y: 0, voltageVolts: 2 ** 54, internalResistanceOhms: 0 },
        { id: "gate", kind: "ac-source", label: "Gate", x: 0, y: 0, voltageVolts: 0, offsetVolts: sign * 3 },
        { id: "i", kind: "current-source", label: "I", x: 0, y: 0, currentAmps: -sign * 1.5 },
        { id: "q", kind, label: "Q", x: 0, y: 0, thresholdVolts: 1, transconductanceAmpsPerVoltSquared: 1, channelLengthModulation: 0 },
        { id: "g", kind: "ground", label: "GND", x: 0, y: 0 },
      ],
      wires: [
        { id: "vg", from: { partId: "v", terminal: "b" }, to: { partId: "g", terminal: "a" } },
        { id: "vs", from: { partId: "v", terminal: "a" }, to: { partId: "q", terminal: "c" } },
        { id: "gs", from: { partId: "gate", terminal: "b" }, to: { partId: "q", terminal: "c" } },
        { id: "gg", from: { partId: "gate", terminal: "a" }, to: { partId: "q", terminal: "b" } },
        { id: "id", from: { partId: "i", terminal: "a" }, to: { partId: "q", terminal: "a" } },
        { id: "is", from: { partId: "i", terminal: "b" }, to: { partId: "q", terminal: "c" } },
      ],
    };
    const dc = analyzeCircuit(document, {}, { mode: "dc" });
    expect(dc.status, dc.message).toBe("closed");
    const transient = simulateTransient(document, { durationSeconds: 0.001, timeStepSeconds: 0.001 });
    expect(transient.status, transient.message).toBe("valid");
    const analyses = [dc, ...transient.samples.map((_, sampleIndex) => analysisAtTransientFrame(document, { analysis: transient, sampleIndex })!)];
    for (const analysis of analyses) {
      // The independent triode equation at |Vgs|=3, Vth=1, k=1:
      // |I|=2*|Vds|-|Vds|^2/2=1.5 gives |Vds|=1 on this branch.
      expect(analysis.parts.q!.voltageVolts).toBe(sign);
      const nodes = circuitNodes(document, analysis);
      const drain = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "q" && endpoint.terminal === "a"));
      const source = nodes.find((node) => node.endpoints.some((endpoint) => endpoint.partId === "q" && endpoint.terminal === "c"));
      expect(drain?.voltageVolts).toBe(source?.voltageVolts);
      const context = { document, analysis, nodes };
      expect(circuitPotential(drain, source, false, context)?.volts).toBe(sign);
      expect(circuitPotential(source, drain, false, context)?.volts).toBe(-sign);
    }
  });

  it.each([false, true])("preserves signed small branch and path voltages (potentiometer=%s)", (potentiometer) => {
    const document = highResistanceCircuit(potentiometer);
    const analysis = analyzeCircuit(document);
    expect(analysis.status).toBe("closed");
    const nodes = circuitNodes(document, analysis);
    const context = { document, analysis, nodes };
    const node = (id: string, terminal: CircuitTerminal) => nodes.find((candidate) =>
      candidate.endpoints.some((endpoint) => endpoint.partId === id && endpoint.terminal === terminal));
    const start = node("small", "a");
    const middle = node("small", potentiometer ? "c" : "b");
    const end = node("next", "b");
    expect(start?.voltageVolts).toBe(middle?.voltageVolts);
    const expected = 9e-20 * (potentiometer ? 0.25 : 1);
    expect(circuitPotential(start, middle, false, context)!.volts / expected).toBeCloseTo(1, 12);
    expect(circuitPotential(middle, start, false, context)!.volts / expected).toBeCloseTo(-1, 12);
    expect(circuitPotential(start, end, false, context)!.volts / (expected + 18e-20)).toBeCloseTo(1, 12);
    expect(circuitPotential(end, start, false, context)!.volts / (expected + 18e-20)).toBeCloseTo(-1, 12);
  });
});
