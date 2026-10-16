import { createContext, useContext, useRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { simulationDocumentKey } from "./simulation-document-key.js";

interface DocumentKey {
  document: CircuitDocument;
  key: string | null;
}

export const SimulationDocumentKeysContext = createContext<readonly DocumentKey[] | null>(null);

/** Share a parent's current capture once; local child updates must capture again. */
export function useSimulationDocumentKey(document: CircuitDocument | undefined, enabled: boolean): string | null {
  const shared = useContext(SimulationDocumentKeysContext);
  const consumed = useRef<typeof shared>(null);
  const fresh = shared !== consumed.current;
  consumed.current = shared;
  if (!enabled || !document) { return null; }
  const captured = fresh ? shared?.find((entry) => entry.document === document) : undefined;
  return captured ? captured.key : simulationDocumentKey(document);
}
