import { describe, expect, it } from "vitest";
import { analyzeAnalogCircuit } from "../analog-solver.js";
import { circuitPartCatalog, type CircuitDocument, type CircuitPart, type CircuitPartKind } from "../circuit-model.js";
import { analyzeCircuit } from "../circuit-solver.js";
import { simulateTransient } from "../transient-solver.js";

function part(id: string, kind: CircuitPartKind, fields: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x: 0, y: 0, ...circuitPartCatalog[kind].defaults, ...fields };
}

function currentLoop(current: number): CircuitDocument {
  const parts = [
    part("out", "current-source", { currentAmps: current }),
    part("back", "current-source", { currentAmps: current }),
    part("left", "resistor", { resistanceOhms: 10 }),
    part("right", "resistor", { resistanceOhms: 20 }),
    part("local", "voltmeter"),
    part("floating", "voltmeter"),
  ];
  const nets: [string, "a" | "b"][][] = [
    [["out", "a"], ["left", "a"], ["local", "a"], ["floating", "a"]],
    [["back", "b"], ["left", "b"], ["local", "b"]],
    [["out", "b"], ["right", "a"], ["floating", "b"]],
    [["back", "a"], ["right", "b"]],
  ];
  const wires = nets.flatMap(([first, ...rest], net) => rest.map(([partId, terminal], index) => ({
    id: `w${net}-${index}`,
    from: { partId: first![0], terminal: first![1] },
    to: { partId, terminal },
  })));
  return { title: "Balanced current-source cutset", parts, wires };
}

describe("balanced ideal current-source cutsets", () => {
  it.each([1, -1, 1e-100])("solves a loop between separate resistive networks at %s A", (current) => {
    for (const reversed of [false, true]) {
      const document = currentLoop(current);
      if (reversed) {
        document.parts.reverse();
        document.wires.reverse();
      }
      const result = analyzeAnalogCircuit(document);
      expect(result.status, result.message).toBe("valid");
      // KCL fixes both resistor currents independently of either island's
      // arbitrary common-mode voltage. Ohm's law fixes their local voltages.
      expect(result.parts.left!.current.real / current).toBe(-1);
      expect(result.parts.right!.current.real / current).toBe(1);
      expect(result.parts.left!.voltage.real / (-10 * current)).toBeCloseTo(1, 14);
      expect(result.parts.right!.voltage.real / (20 * current)).toBeCloseTo(1, 14);
      expect(result.parts.local!.meterStatus).toBe("connected");
      expect(result.parts.floating!.meterStatus).toBe("floating");
      const publicResult = analyzeCircuit(document);
      expect(publicResult.status, publicResult.message).toBe("closed");
      expect(publicResult.parts.left!.currentAmps / current).toBe(-1);
    }
  });

  it("rejects an unbalanced cutset instead of sinking its current into a gauge reference", () => {
    const document = currentLoop(1);
    document.parts.find((value) => value.id === "back")!.currentAmps = 1 + Number.EPSILON;
    const result = analyzeAnalogCircuit(document);
    expect(result.status).toBe("invalid");
    expect(result.issues.some((issue) => issue.code === "current-source-no-return-path")).toBe(true);
  });

  it.each([1, Number.MIN_VALUE, Number.MAX_VALUE])("allows an opposing source pair with floating voltage at %s A", (current) => {
    const document: CircuitDocument = {
      title: "Equal opposing current sources",
      parts: [
        part("out", "current-source", { currentAmps: current }),
        part("back", "current-source", { currentAmps: -current }),
        part("meter", "voltmeter"),
      ],
      wires: [
        { id: "a", from: { partId: "out", terminal: "a" }, to: { partId: "back", terminal: "a" } },
        { id: "b", from: { partId: "out", terminal: "b" }, to: { partId: "back", terminal: "b" } },
        { id: "ma", from: { partId: "out", terminal: "a" }, to: { partId: "meter", terminal: "a" } },
        { id: "mb", from: { partId: "out", terminal: "b" }, to: { partId: "meter", terminal: "b" } },
      ],
    };
    const result = analyzeAnalogCircuit(document);
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.out!.current.real).toBe(current);
    expect(result.parts.back!.current.real).toBe(-current);
    expect(result.parts.meter!.meterStatus).toBe("floating");
  });

  it("preserves a balanced cutset through transient initialization and later samples", () => {
    const result = simulateTransient(currentLoop(1), { durationSeconds: 0.2, timeStepSeconds: 0.1 });
    expect(result.status, result.message).toBe("valid");
    expect(result.samples).toHaveLength(3);
    for (const sample of result.samples) {
      expect(sample.parts.left!.currentAmps).toBe(-1);
      expect(sample.parts.right!.voltageVolts).toBe(20);
      expect(sample.parts.local!.meterStatus).toBe("connected");
      expect(sample.parts.floating!.meterStatus).toBe("floating");
    }
  });

  it("uses balanced cutsets in the DC bias for a separate nonlinear AC network", () => {
    const document = currentLoop(1);
    document.parts.push(part("diode", "diode"));
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    expect(result.parts.left!.current.real).toBe(0);
    expect(result.parts.right!.current.real).toBe(0);
    expect(result.parts.floating!.meterStatus).toBe("floating");
  });

  it("reports source voltages and powers in the same gauge as its public terminal voltages", () => {
    const document = currentLoop(1);
    document.parts.push(part("extra", "resistor", { resistanceOhms: 10 }));
    const connection = document.wires.find((wire) => wire.from.partId === "back" && wire.to.partId === "right")!;
    connection.from = { partId: "extra", terminal: "a" };
    document.wires.push({ id: "extra-back", from: { partId: "extra", terminal: "b" }, to: { partId: "back", terminal: "a" } });
    const result = analyzeAnalogCircuit(document);
    expect(result.status, result.message).toBe("valid");
    for (const id of ["out", "back"]) {
      const reading = result.parts[id]!;
      const voltage = reading.terminalVoltages.a!.real - reading.terminalVoltages.b!.real;
      expect(reading.voltage.real).toBe(voltage);
      expect(reading.power.real).toBe(voltage * reading.current.real);
    }
    expect(Object.values(result.parts).reduce((sum, reading) => sum + reading.power.real, 0)).toBe(0);
  });

  it("reports a zero-current source's AC voltage in the public voltage reference", () => {
    const document = currentLoop(0);
    document.parts.push(
      part("extra", "resistor", { resistanceOhms: 10 }),
      part("feeder", "resistor", { resistanceOhms: 30 }),
      part("drive", "ac-source", { voltageVolts: 3, phaseDegrees: 90, frequencyHz: 100 }),
    );
    const connection = document.wires.find((wire) => wire.from.partId === "back" && wire.to.partId === "right")!;
    connection.from = { partId: "extra", terminal: "a" };
    document.wires.push(
      { id: "extra-back", from: { partId: "extra", terminal: "b" }, to: { partId: "back", terminal: "a" } },
      { id: "drive-return", from: { partId: "drive", terminal: "b" }, to: { partId: "back", terminal: "a" } },
      { id: "drive-feeder", from: { partId: "drive", terminal: "a" }, to: { partId: "feeder", terminal: "a" } },
      { id: "feeder-right", from: { partId: "feeder", terminal: "b" }, to: { partId: "right", terminal: "a" } },
    );
    const result = analyzeAnalogCircuit(document, { mode: "ac" });
    expect(result.status, result.message).toBe("valid");
    for (const id of ["out", "back"]) {
      const reading = result.parts[id]!;
      expect(reading.voltage.real).toBe(reading.terminalVoltages.a!.real - reading.terminalVoltages.b!.real);
      expect(reading.voltage.imaginary).toBe(reading.terminalVoltages.a!.imaginary - reading.terminalVoltages.b!.imaginary);
    }
    expect(result.parts.out!.voltage).toEqual({ real: 0, imaginary: 0 });
    expect(result.parts.back!.voltage).toEqual({ real: 0, imaginary: -1.5 });
  });
});
