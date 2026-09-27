import type { CircuitDocument } from "../circuit-model.js";
import type { CircuitAnalysis, CircuitAnalysisOptions } from "../circuit-solver.js";

export interface CircuitLearningFeatures {
  /** Show transient waveforms. Defaults to true. */
  transient?: boolean;
  /** Show power and energy. Defaults to true. */
  energy?: boolean;
  /** Defaults to "auto": show AC tools for AC sources or a selected AC analysis. */
  ac?: boolean | "auto";
  /** Show comparison with the original circuit. Defaults to true. */
  comparison?: boolean;
}

/** Presentation only: these settings never change the circuit or analysis mode. */
export interface CircuitPreviewFeatures extends CircuitLearningFeatures {
  /** Show the circuit title. Defaults to true. */
  title?: boolean;
  /** Show the analysis summary on the board and in the dialog. Defaults to true. */
  summary?: boolean;
  /** Show part lists and allow part adjustment, including board switches. Defaults to true. */
  parts?: boolean;
  /** Show steady-state analysis settings. Defaults to true. */
  analysisSettings?: boolean;
  /** Show the learning section; false overrides all learning features. Defaults to true. */
  learning?: boolean;
}

export function resolveAcFeature(
  value: CircuitLearningFeatures["ac"],
  document: CircuitDocument,
  analysis: CircuitAnalysis,
  options: CircuitAnalysisOptions,
) {
  return typeof value === "boolean" ? value : analysis.mode === "ac" || options.mode === "ac" || document.parts.some((part) => part.kind === "ac-source");
}

export function resolvePreviewFeatures(features: CircuitPreviewFeatures | undefined, document: CircuitDocument, analysis: CircuitAnalysis, options: CircuitAnalysisOptions) {
  const resolved = {
    title: features?.title ?? true,
    summary: features?.summary ?? true,
    parts: features?.parts ?? true,
    analysisSettings: features?.analysisSettings ?? true,
    learning: features?.learning ?? true,
    transient: features?.transient ?? true,
    energy: features?.energy ?? true,
    ac: resolveAcFeature(features?.ac, document, analysis, options),
    comparison: features?.comparison ?? true,
  };
  return {
    ...resolved,
    learning: resolved.learning && (resolved.transient || resolved.energy || resolved.ac || resolved.comparison),
    dialog: resolved.parts || resolved.analysisSettings,
    header: resolved.title || resolved.parts || resolved.analysisSettings,
  };
}

export type ResolvedPreviewFeatures = ReturnType<typeof resolvePreviewFeatures>;
