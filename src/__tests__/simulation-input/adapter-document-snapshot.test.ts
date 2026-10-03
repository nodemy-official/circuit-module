import { describe, expect, it } from "vitest";
import { analyzeExtendedCircuit } from "../../circuit-analog-adapter.js";
import { createCircuitFromSpecs } from "../helpers/circuit-fixture.js";

describe("direct adapter document snapshots", () => {
  it("uses switch data descriptors for readings and connectivity without invoking a Proxy get", () => {
    const document = createCircuitFromSpecs([
      ["source", "battery", ["s", "0"], { voltageVolts: 9 }],
      ["load", "resistor", ["s", "return"], { resistanceOhms: 100 }],
      ["switch", "switch", ["return", "0"], { initiallyClosed: true }],
    ], "Direct adapter switch snapshot");
    let reads = 0;
    document.parts[2] = new Proxy(document.parts[2]!, {
      get(target, key, receiver) {
        return key === "initiallyClosed" ? ++reads <= 2 : Reflect.get(target, key, receiver);
      },
    });
    const result = analyzeExtendedCircuit(document, {}, { mode: "dc" });

    expect(result.status, result.message).toBe("closed");
    expect(result.parts.switch!.switchClosed).toBe(true);
    expect(result.parts.load!.currentAmps).toBe(0.09);
    expect(result.currentAmps).toBe(0.09);
    expect(reads).toBe(0);
  });
});
