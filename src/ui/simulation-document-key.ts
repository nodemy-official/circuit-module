import { circuitPartCatalog, type CircuitDocument } from "../circuit-model.js";
import { SimulationSnapshotContext } from "../simulation-input.js";

const arrayFields = Reflect.ownKeys(Array.prototype);

function recordDescriptors(value: unknown, context: SimulationSnapshotContext) {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new TypeError("Expected an input record"); }
  const captured = context.captureProperties(value);
  if (!captured || (captured.prototype !== Object.prototype && captured.prototype !== null)) {
    throw new TypeError("Expected own data properties");
  }
  return captured.descriptors;
}

function arrayValues(value: unknown, context: SimulationSnapshotContext): unknown[] {
  if (!Array.isArray(value)) { throw new TypeError("Expected an input array"); }
  const captured = context.captureProperties(value, arrayFields);
  if (!captured || captured.prototype !== Array.prototype) { throw new TypeError("Expected own array entries"); }
  const descriptors = captured.descriptors;
  const length = descriptors.length?.value;
  if (!Number.isInteger(length) || length < 0 || Reflect.ownKeys(descriptors).length !== length + 1) {
    throw new TypeError("Expected a dense input array");
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[index];
    if (!descriptor) { throw new TypeError("Expected an indexed data property"); }
    values.push(descriptor.value);
  }
  return values;
}

function scalarKey(value: unknown): readonly unknown[] {
  if (value === null) { return ["null"]; }
  if (value === undefined) { return ["undefined"]; }
  if (typeof value === "number") { return ["number", Object.is(value, -0) ? "-0" : String(value)]; }
  if (typeof value === "string" || typeof value === "boolean") { return [typeof value, value]; }
  throw new TypeError("Circuit simulation fields must be scalar values");
}

/** Captures electrical inputs without revalidating the circuit or calling getters / toJSON. */
export function simulationDocumentKey(document: CircuitDocument | undefined): string | null {
  if (!document) { return null; }
  try {
    const context = new SimulationSnapshotContext();
    const captured = recordDescriptors(document, context);
    const parts = arrayValues(captured.parts?.value, context).map((part) => {
      const fields = recordDescriptors(part, context);
      const kind = fields.kind?.value;
      if (typeof kind !== "string" || !Object.hasOwn(circuitPartCatalog, kind)) { throw new TypeError("Unknown component kind"); }
      const spec = circuitPartCatalog[kind as CircuitDocument["parts"][number]["kind"]];
      return ["id", "kind", "label", ...Object.keys(spec.defaults)].map((field) => scalarKey(fields[field]?.value));
    });
    const wires = arrayValues(captured.wires?.value, context).map((wire) => {
      const fields = recordDescriptors(wire, context);
      const from = recordDescriptors(fields.from?.value, context);
      const to = recordDescriptors(fields.to?.value, context);
      return [fields.id?.value, from.partId?.value, from.terminal?.value, to.partId?.value, to.terminal?.value].map(scalarKey);
    });
    // Reverse revalidation also catches a later Proxy trap changing an earlier
    // part after its values have already been captured.
    return context.isStable() ? JSON.stringify([parts, wires]) : null;
  } catch {
    return null;
  }
}
