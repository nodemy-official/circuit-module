import type { CircuitDocument } from "../circuit-model.js";
import { CircuitEditor } from "./CircuitEditor.js";
import { CircuitEditorLayout, type CircuitEditorLayoutProps } from "./CircuitEditorLayout.js";

export interface CircuitPreviewProps extends Omit<CircuitEditorLayoutProps, "previewOnly"> {
  /** Circuit to experiment with. Values are kept local to this mounted preview. */
  initialDocument?: CircuitDocument;
}

/** Inline, interactive circuit output for a lesson or notebook block. */
export function CircuitPreview({ initialDocument, ...props }: CircuitPreviewProps) {
  return (
    <CircuitEditor initialDocument={initialDocument}>
      <CircuitEditorLayout {...props} previewOnly />
    </CircuitEditor>
  );
}
