import type { CircuitDocument } from "./circuit-model.js";
import { MAX_CIRCUIT_DOCUMENT_PARTS, MAX_CIRCUIT_DOCUMENT_WIRES, serializeCircuitDocument } from "./circuit-serialization.js";

/** Capacity checks shared by completed headless edits and editor property changes. */
export function circuitDocumentStorageIssue(document: CircuitDocument): string | null {
  if (document.parts.length > MAX_CIRCUIT_DOCUMENT_PARTS) {
    return `部品数は${MAX_CIRCUIT_DOCUMENT_PARTS}個以下にしてください。`;
  }
  if (document.wires.length > MAX_CIRCUIT_DOCUMENT_WIRES) {
    return `導線数は${MAX_CIRCUIT_DOCUMENT_WIRES}本以下にしてください。`;
  }
  try {
    serializeCircuitDocument(document);
  } catch (error) {
    if (error instanceof RangeError) { return error.message; }
    // Incomplete host documents remain editable so invalid part settings can be
    // repaired. Their validation errors still belong to saving and diagnostics.
  }
  return null;
}
