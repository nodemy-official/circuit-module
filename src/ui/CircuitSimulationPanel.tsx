import { useCallback, useId, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import type { CircuitDocument } from "../circuit-model.js";
import { analyzeCircuit, type CircuitAnalysis, type CircuitAnalysisOptions } from "../circuit-solver.js";
import { analysisAtTransientFrame, type CircuitTransientFrame } from "../circuit-visualization.js";
import { simulationRecordField, validatedSimulationDocument } from "../simulation-input.js";
import { CircuitEnergyPanel } from "./CircuitEnergyPanel.js";
import { CircuitAcPanel } from "./CircuitAcPanel.js";
import { CircuitComparisonPanel } from "./CircuitComparisonPanel.js";
import { CircuitTransientPanel } from "./CircuitTransientPanel.js";
import { resolveAcFeature, type CircuitLearningFeatures } from "./preview-features.js";
import { Input, NativeSelect } from "./primitives.js";
import { useNumericDraft } from "./NumericInput.js";
import { SimulationDocumentKeysContext } from "./simulation-document-context.js";
import { simulationDocumentKey } from "./simulation-document-key.js";

export type { CircuitLearningFeatures } from "./preview-features.js";

export interface CircuitSimulationPanelProps extends Omit<ComponentPropsWithoutRef<"section">, "onChange"> {
  document: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  onChange: (options: CircuitAnalysisOptions) => void;
  baselineDocument?: CircuitDocument;
  onFrameChange?: (frame: CircuitTransientFrame | null) => void;
  /** Omit learning panels when the host displays them beside the board elsewhere. */
  showLearningPanels?: boolean;
  /** Hide steady-state analysis settings when this panel is used for learning results only. */
  showAnalysisSettings?: boolean;
  /** Select which learning panels and AC controls are available. AC defaults to auto. */
  learningFeatures?: CircuitLearningFeatures;
  /** Pause transient playback while this panel is hidden in another tab. */
  active?: boolean;
}

function AnalysisSettings({
  analysis,
  options,
  onChange,
  frequency,
  acAvailable,
}: {
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  onChange: (options: CircuitAnalysisOptions) => void;
  frequency: number;
  acAvailable: boolean;
}) {
  const id = useId();
  const acAnalysisSelected = analysis.mode === "ac" || options.mode === "ac";
  const frequencyInput = useNumericDraft({
    value: frequency, min: 0, exclusiveMin: true,
    onValueChange: (value) => onChange({ ...options, mode: "ac", frequencyHz: value }),
  });
  return <>
    <div className="circuit-panel__heading"><h2>解析の設定</h2></div>
    {acAvailable || !acAnalysisSelected ? <>
      <label htmlFor={`${id}-mode`}>定常解析</label>
      <NativeSelect id={`${id}-mode`} value={options.mode ?? "auto"} onChange={(event) => onChange({ ...options, mode: event.target.value as CircuitAnalysisOptions["mode"] })}>
        <option value="auto">自動（電源に合わせる）</option>
        <option value="dc">直流・動作点</option>
        {acAvailable && <option value="ac">交流・小信号</option>}
      </NativeSelect>
    </> : <p>定常解析：交流・小信号</p>}
    {analysis.mode === "ac" ? <>
      {acAvailable && <>
        <label htmlFor={`${id}-frequency`}>解析周波数 (Hz)</label>
        <Input id={`${id}-frequency`} type="number" min="0" step="any" value={frequencyInput.text}
          onValueChange={frequencyInput.change} onBlur={frequencyInput.restore} onKeyDown={frequencyInput.keyDown} />
      </>}
      <p>{acAvailable
        ? "計測値は実効値と位相です。解析周波数と異なる交流電源は、この結果では0 Vとして扱います。別の周波数を確認するには解析周波数を変更してください。半導体は直流動作点まわりの小信号として計算します。"
        : "交流の計測値は実効値と位相です。"}</p>
    </> : <p>コンデンサは開放、コイルは短絡として定常状態を計算します。</p>}
  </>;
}

function LearningPanels({
  document,
  transientDocument,
  analysis,
  options,
  baselineDocument,
  baselineAnalysis,
  showTransient,
  showEnergy,
  showAc,
  showComparison,
  showAnalysisSettings,
  active,
  frame,
  sampledAnalysis,
  onFrameChange,
}: {
  document: CircuitDocument;
  transientDocument: CircuitDocument;
  analysis: CircuitAnalysis;
  options: CircuitAnalysisOptions;
  baselineDocument?: CircuitDocument;
  baselineAnalysis?: CircuitAnalysis;
  showTransient: boolean;
  showEnergy: boolean;
  showAc: boolean;
  showComparison: boolean;
  showAnalysisSettings: boolean;
  active: boolean;
  frame: CircuitTransientFrame | null;
  sampledAnalysis: CircuitAnalysis | null;
  onFrameChange: (frame: CircuitTransientFrame | null) => void;
}) {
  return <>
    {showTransient && <CircuitTransientPanel
      document={transientDocument}
      baselineDocument={baselineDocument}
      onFrameChange={onFrameChange}
      onReturnToSteadyState={frame ? () => onFrameChange(null) : undefined}
      active={active}
      defaultOpen={!showAnalysisSettings}
    />}
    {showEnergy && <details className="circuit-learning-section"><summary>電力とエネルギー</summary><CircuitEnergyPanel document={document} analysis={sampledAnalysis ?? analysis} frame={frame} /></details>}
    {showAc && <details className="circuit-learning-section"><summary>交流の位相・周波数応答</summary><CircuitAcPanel document={document} analysis={analysis} options={options} /></details>}
    {showComparison && <CircuitComparisonPanel document={document} analysis={analysis} baselineDocument={baselineDocument} baselineAnalysis={baselineAnalysis} />}
  </>;
}

function analyzedSwitchOverrides(document: CircuitDocument, analysis: CircuitAnalysis): string | null {
  try {
    return JSON.stringify(document.parts.flatMap((part) => {
      if (part.kind !== "switch") { return []; }
      const closed = analysis.parts[part.id]?.switchClosed;
      return closed !== undefined && closed !== (simulationRecordField(part, "initiallyClosed") ?? true)
        ? [[part.id, closed]] : [];
    }));
  } catch {
    return null;
  }
}

function documentWithSwitchOverrides(document: CircuitDocument, serializedOverrides: string | null): CircuitDocument {
  if (serializedOverrides === null) { return document; }
  const overrides = new Map<string, boolean>(JSON.parse(serializedOverrides));
  if (overrides.size === 0) { return document; }
  const copiedDocument = validatedSimulationDocument(document);
  // Let transient analysis diagnose malformed inputs without changing their data.
  if (typeof copiedDocument === "string") { return document; }
  return { ...copiedDocument, parts: copiedDocument.parts.map((part) => overrides.has(part.id)
    ? { ...part, initiallyClosed: overrides.get(part.id) } : part) };
}

function useTransientInputDocument(document: CircuitDocument, documentKey: string | null, analysis: CircuitAnalysis, enabled: boolean) {
  const switchOverrides = enabled ? analyzedSwitchOverrides(document, analysis) : "[]";
  const transientDocument = useMemo(() => documentWithSwitchOverrides(document, switchOverrides), [document, documentKey, switchOverrides]);
  return {
    transientDocument,
    transientAvailable: enabled && switchOverrides !== null,
    switchStateUnavailable: switchOverrides === null,
  };
}

function transientInputKey(documentKey: string | null, baselineDocument: CircuitDocument | undefined, baselineDocumentKey: string | null, enabled: boolean) {
  if (!enabled || documentKey === null || (baselineDocument && baselineDocumentKey === null)) { return null; }
  return JSON.stringify([documentKey, baselineDocumentKey]);
}

function learningDocumentKeys(document: CircuitDocument, documentKey: string | null,
  baselineDocument: CircuitDocument | undefined, baselineDocumentKey: string | null, showTransient: boolean, showComparison: boolean) {
  return [
    ...(showTransient ? [{ document, key: documentKey }] : []),
    ...(baselineDocument && (showTransient || showComparison) ? [{ document: baselineDocument, key: baselineDocumentKey }] : []),
  ];
}

interface TransientFrameState {
  document: CircuitDocument;
  inputsKey: string | null;
  frame: CircuitTransientFrame | null;
}

function matchingTransientFrame(state: TransientFrameState | null, document: CircuitDocument, inputsKey: string | null) {
  return inputsKey !== null && state?.document === document && state.inputsKey === inputsKey ? state.frame : null;
}

/** Analysis settings are session state; changing them does not alter the circuit. */
export function CircuitSimulationPanel({
  document,
  analysis,
  options: inputOptions,
  onChange,
  baselineDocument,
  onFrameChange,
  showLearningPanels = true,
  showAnalysisSettings = true,
  learningFeatures,
  active = true,
  className = "",
  ...props
}: CircuitSimulationPanelProps) {
  const mode = simulationRecordField(inputOptions, "mode") as CircuitAnalysisOptions["mode"];
  const frequencyHz = simulationRecordField(inputOptions, "frequencyHz") as number | undefined;
  // Keep edits and settings on the same own data fields as the solver,
  // including non-enumerable values and absent fields supplied by a Proxy.
  const options = useMemo(() => ({ mode, frequencyHz }), [mode, frequencyHz]);
  const showTransient = showLearningPanels && (learningFeatures?.transient ?? true);
  const showEnergy = showLearningPanels && (learningFeatures?.energy ?? true);
  const showAc = showLearningPanels && resolveAcFeature(learningFeatures?.ac, document, analysis, options);
  const showComparison = showLearningPanels && (learningFeatures?.comparison ?? true);
  const documentKey = showTransient ? simulationDocumentKey(document) : null;
  const baselineDocumentKey = showTransient || showComparison ? simulationDocumentKey(baselineDocument) : null;
  const { transientDocument, transientAvailable, switchStateUnavailable } = useTransientInputDocument(document, documentKey, analysis, showTransient);
  const transientInputsKey = transientInputKey(documentKey, baselineDocument, baselineDocumentKey, transientAvailable);
  const [frameState, setFrameState] = useState<TransientFrameState | null>(null);
  const frame = matchingTransientFrame(frameState, transientDocument, transientInputsKey);
  const sampledAnalysis = useMemo(() => frame ? analysisAtTransientFrame(document, frame) : null, [document, frame]);
  const baselineAnalysis = useMemo(() => baselineDocument && showComparison ? analyzeCircuit(baselineDocument, {}, options) : undefined, [baselineDocument, baselineDocumentKey, options, showComparison]);
  const changeFrame = useCallback((next: CircuitTransientFrame | null) => {
    setFrameState({ document: transientDocument, inputsKey: transientInputsKey, frame: next });
    onFrameChange?.(next);
  }, [transientDocument, transientInputsKey, onFrameChange]);
  const source = document.parts.find((part) => part.kind === "ac-source");
  const sourceFrequencyHz = source ? simulationRecordField(source, "frequencyHz") as number | undefined : undefined;
  const frequency = options.frequencyHz ?? sourceFrequencyHz ?? 1000;
  const ariaLabel = props["aria-label"] ?? (showAnalysisSettings ? "解析の設定" : "解析結果と学習ビュー");
  if (!showAnalysisSettings && !showTransient && !showEnergy && !showAc && !showComparison) { return null; }
  return <section {...props} className={`circuit-panel circuit-simulation ${className}`} aria-label={ariaLabel}>
    {showAnalysisSettings && <AnalysisSettings analysis={analysis} options={options} onChange={onChange} frequency={frequency} acAvailable={resolveAcFeature(learningFeatures?.ac, document, analysis, options)} />}
    {switchStateUnavailable && <p role="alert">スイッチ状態を読み取れないため、過渡解析を開始できません。</p>}
    {(transientAvailable || showEnergy || showAc || showComparison) && <SimulationDocumentKeysContext.Provider value={learningDocumentKeys(
      document, documentKey, baselineDocument, baselineDocumentKey, transientAvailable, showComparison,
    )}><LearningPanels
      document={document}
      transientDocument={transientDocument}
      analysis={analysis}
      options={options}
      baselineDocument={baselineDocument}
      baselineAnalysis={baselineAnalysis}
      showTransient={transientAvailable}
      showEnergy={showEnergy}
      showAc={showAc}
      showComparison={showComparison}
      showAnalysisSettings={showAnalysisSettings}
      active={active}
      frame={frame}
      sampledAnalysis={sampledAnalysis}
      onFrameChange={changeFrame}
    /></SimulationDocumentKeysContext.Provider>}
  </section>;
}
