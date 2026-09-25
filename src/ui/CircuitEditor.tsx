import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { useCircuitEditor, type CircuitEditorController } from "./useCircuitEditor.js";

const CircuitEditorContext = createContext<CircuitEditorController | null>(null);

export interface CircuitEditorProps {
  initialDocument?: CircuitDocument;
  onDocumentChange?: (document: CircuitDocument) => void;
  children: ReactNode | ((editor: CircuitEditorController) => ReactNode);
}

/** Provides circuit editor state and commands without rendering any DOM. */
export function CircuitEditor({ initialDocument, onDocumentChange, children }: CircuitEditorProps) {
  const editor = useCircuitEditor(initialDocument);
  const previousDocument = useRef(editor.document);

  useEffect(() => {
    if (previousDocument.current !== editor.document) {
      previousDocument.current = editor.document;
      onDocumentChange?.(editor.document);
    }
  }, [editor.document, onDocumentChange]);

  const content = typeof children === "function" ? children(editor) : children;
  return <CircuitEditorContext.Provider value={editor}>{content}</CircuitEditorContext.Provider>;
}

/** Returns the nearest editor state, or throws when used outside a CircuitEditor. */
export function useCircuitEditorContext(): CircuitEditorController {
  const editor = useContext(CircuitEditorContext);
  if (!editor) {
    throw new Error("useCircuitEditorContext must be used within a <CircuitEditor> provider.");
  }
  return editor;
}
