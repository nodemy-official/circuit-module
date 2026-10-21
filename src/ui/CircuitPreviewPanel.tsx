import { useId, useState, type ReactNode } from "react";
import { circuitPartNumericFields, type CircuitDocument, type CircuitPart, type CircuitPartNumericKey } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { formatCircuitNumber } from "../number-format.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { getMeterDisplay, CircuitMeterReadout } from "./CircuitMeterReadout.js";
import { measurementLabels } from "./measurement-labels.js";
import { Button, Input, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives.js";
import { partNumericField, partNumericValue } from "./part-numeric-field.js";
import { partSwitchValue } from "./part-switch-value.js";
import { useNumericDraft } from "./NumericInput.js";
import { analysisPartReading } from "./analysis-readings.js";
import { nonzeroAcMeasurement } from "./ac-reading-phase.js";
import { readOptionalPrecision } from "../circuit-reading.js";

type AdjustableValue = CircuitPartNumericKey | "initiallyClosed";

export interface CircuitPreviewPanelProps {
  document: CircuitDocument;
  initialDocument?: CircuitDocument;
  analysis: CircuitAnalysis;
  onChange: (id: string, patch: Pick<Partial<CircuitPart>, AdjustableValue>) => void;
  onReset: () => void;
  summary?: ReactNode;
  /** Show readings alongside the simulation controls. */
  showReadings?: boolean;
  /** Limit controls and live measurements to the part opened from the board. */
  partId?: string;
}

function adjustableValues(part: CircuitPart): AdjustableValue[] {
  const numeric = circuitPartNumericFields(part.kind).map(({ key }) => key);
  return part.kind === "switch" ? ["initiallyClosed", ...numeric] : numeric;
}

function comparableValue(part: CircuitPart, key: AdjustableValue): number | boolean | null | undefined {
  if (key === "initiallyClosed") { return partSwitchValue(part); }
  return partNumericValue(part, key);
}

function isValidNumericValue(key: CircuitPartNumericKey, value: number, part: CircuitPart) {
  const catalogField = circuitPartNumericFields(part.kind).find(({ key: fieldKey }) => fieldKey === key);
  const field = catalogField && partNumericField(part, catalogField);
  if (!Number.isFinite(value)) { return false; }
  if (field?.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) { return false; }
  if (field?.max !== undefined && (field.exclusiveMax ? value >= field.max : value > field.max)) { return false; }
  return true;
}

function numericError(key: CircuitPartNumericKey, draft: string | undefined, part: CircuitPart) {
  if (draft === undefined) { return; }
  if (draft.trim() === "") { return "値を入力してください。現在の値は維持されます。"; }
  const value = Number(draft);
  if (!Number.isFinite(value)) { return "有限の数値を入力してください。"; }
  const catalogField = circuitPartNumericFields(part.kind).find(({ key: fieldKey }) => fieldKey === key);
  const field = catalogField && partNumericField(part, catalogField);
  if (!isValidNumericValue(key, value, part)) {
    if (field?.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) {
      return `${field.min}${field.exclusiveMin ? "より大きい" : "以上の"}数値を入力してください。`;
    }
    if (field?.max !== undefined) { return `${field.max}${field.exclusiveMax ? "より小さい" : "以下の"}数値を入力してください。`; }
    return "有効な数値を入力してください。";
  }
}

const engineeringPrefixes: [number, string][] = [[1e-12, "p"], [1e-9, "n"], [1e-6, "μ"], [1e-3, "m"], [1, ""], [1e3, "k"], [1e6, "M"], [1e9, "G"], [1e12, "T"]];

function format(value: number | undefined, unit: string) {
  if (value === undefined || !Number.isFinite(value)) { return "—"; }
  if (value === 0) { return unit === "°" ? "0°" : `0 ${unit}`; }
  const [scale, prefix] = unit === "°"
    ? [1, ""]
    : engineeringPrefixes.find(([threshold]) => Math.abs(value) < threshold * 1000) ?? engineeringPrefixes.at(-1)!;
  const suffix = `${prefix}${unit}`;
  const formatted = formatCircuitNumber(value / scale);
  return suffix ? `${formatted} ${suffix}` : formatted;
}

function partOrder(part: CircuitPart) {
  switch (part.kind) {
    case "switch": return 0;
    case "battery":
    case "ac-source":
    case "current-source": return 1;
    case "resistor":
    case "bulb":
    case "capacitor":
    case "inductor":
    case "potentiometer": return 2;
    case "diode":
    case "led":
    case "npn-transistor":
    case "pnp-transistor":
    case "nmos":
    case "pmos":
    case "op-amp": return 3;
    default: return 4;
  }
}

function previewChanges(parts: CircuitPart[], initialDocument?: CircuitDocument) {
  const baselineById = new Map<string, CircuitPart>((initialDocument?.parts ?? []).map((part) => [part.id, part]));
  const changedPartIds = new Set<string>();
  let changedValueCount = 0;
  if (initialDocument) {
    for (const part of parts) {
      const baseline = baselineById.get(part.id);
      for (const key of adjustableValues(part)) {
        if (!baseline || !Object.is(comparableValue(part, key), comparableValue(baseline, key))) {
          changedValueCount += 1;
          changedPartIds.add(part.id);
        }
      }
    }
  }

  return { changedPartIds, changedValueCount };
}

function PreviewSwitchField({ part, id, onChange }: {
  part: CircuitPart;
  id: string;
  onChange: CircuitPreviewPanelProps["onChange"];
}) {
  const closed = partSwitchValue(part);
  return (
    <label className="circuit-preview__switch" htmlFor={id}>
      <span>スイッチ</span>
      <small className="circuit-preview__switch-hint">押して切り替え</small>
      <Switch
        id={id}
        aria-label={`${part.label}のON / OFF`}
        aria-invalid={closed === null || undefined}
        checked={closed === true}
        onCheckedChange={(checked) => onChange(part.id, { initiallyClosed: checked })}
      />
      <strong>{closed === null ? "値を確認" : closed ? "ON" : "OFF"}</strong>
    </label>
  );
}

function PreviewNumericField({ part, field, onChange }: {
  part: CircuitPart;
  field: ReturnType<typeof partNumericField>;
  onChange: CircuitPreviewPanelProps["onChange"];
}) {
  const id = useId();
  const { key, label, min, max, step, exclusiveMin, exclusiveMax } = field;
  const unit = key === "wiperPosition" ? "0–1" : field.unit;
  const committedValue = partNumericValue(part, key);
  const draft = useNumericDraft({
    value: committedValue ?? 0,
    min, max, exclusiveMin, exclusiveMax,
    onValueChange: (value) => onChange(part.id, { [key]: value }),
  });
  const displayLabel = part.kind === "battery" && key === "voltageVolts" ? "電源電圧" : label;
  const errorId = `${id}-${part.id}-${key}-error`;
  const errorMessage = numericError(key, draft.text, part);

  return (
    <label className="circuit-preview__field" htmlFor={`${errorId}-input`}>
      <span>{label}</span>
      <span className="circuit-preview__field-control">
        <span className="circuit-preview__number">
          <Input
            id={`${errorId}-input`}
            type="number"
            min={min}
            max={max}
            step={step ?? "any"}
            aria-label={`${part.label}の${displayLabel}`}
            aria-describedby={errorMessage ? errorId : undefined}
            aria-invalid={errorMessage ? true : undefined}
            value={draft.text}
            onValueChange={draft.change}
            onBlur={draft.restore}
            onKeyDown={draft.keyDown}
          />
          {unit && <small>{unit}</small>}
        </span>
        {errorMessage && <small className="circuit-preview__field-error" id={errorId}>{errorMessage}</small>}
      </span>
    </label>
  );
}

export function CircuitPreviewPanel({
  document,
  initialDocument,
  analysis,
  onChange,
  onReset,
  summary,
  showReadings = true,
  partId,
}: CircuitPreviewPanelProps) {
  const id = useId();
  const [resetVersion, setResetVersion] = useState(0);
  const scopedParts = partId ? document.parts.filter((part) => part.id === partId) : document.parts;

  const { changedPartIds, changedValueCount } = previewChanges(scopedParts, initialDocument);

  const controls = [...scopedParts]
    .filter((part) => adjustableValues(part).length > 0)
    .sort((first, second) => partOrder(first) - partOrder(second));
  const readings = scopedParts.filter((part) => part.kind !== "junction");

  function reset() {
    setResetVersion((current) => current + 1);
    onReset();
  }

  function partHeading(part: CircuitPart) {
    if (partId) { return null; }
    return (
      <header className="circuit-preview__part-heading">
        <CircuitPartIcon kind={part.kind} aria-hidden="true" />
        <h3>{part.label}</h3>
        {changedPartIds.has(part.id) && <span className="circuit-preview__changed">変更あり</span>}
      </header>
    );
  }

  function renderControls() {
    return (
      <div className="circuit-preview__tabpanel-content">
        {controls.length > 0 ? (
          <div className="circuit-preview__parts">
            {controls.map((part) => (
              <section className="circuit-preview__part" key={part.id} data-part-id={part.id} data-changed={changedPartIds.has(part.id)}>
                {partHeading(part)}
                {part.kind === "switch" && <PreviewSwitchField part={part} id={`${id}-${part.id}-switch`} onChange={onChange} />}
                {circuitPartNumericFields(part.kind).map((field) => <PreviewNumericField
                  key={`${field.key}:${resetVersion}`}
                  part={part}
                  field={partNumericField(part, field)}
                  onChange={onChange}
                />)}
              </section>
            ))}
          </div>
        ) : (
          <p className="circuit-preview__empty">{partId ? "この部品に調整できる値はありません。" : "操作できる部品はありません。"}</p>
        )}
      </div>
    );
  }

  function renderReadings() {
    const expressions = readOptionalPrecision(() => analysis.precisionExpressions);
    return readings.length > 0 ? (
      <div className="circuit-preview__parts">
        <p className="circuit-preview__measurement-note">
          {analysis.timeSeconds !== undefined && Number.isFinite(analysis.timeSeconds)
            ? `時間カーソル ${formatCircuitNumber(analysis.timeSeconds)} s の瞬時値です。`
            : analysis.mode === "ac"
              ? `交流解析 (${format(analysis.frequencyHz, "Hz")}) の電圧・電流は実効値です。位相は角度で表示します。`
              : "直流の電圧・電流は端子の向きに対する符号付き値です。"}
        </p>
        {readings.map((part) => {
          const reading = analysisPartReading(analysis, part.id);
          const labels = measurementLabels(part.kind);
          const meter = getMeterDisplay(part.kind, reading, analysis.status, expressions);
          return (
            <section className="circuit-preview__part" key={part.id} data-part-id={part.id} data-changed={changedPartIds.has(part.id)}>
              {partHeading(part)}
              {meter ? <CircuitMeterReadout kind={part.kind} reading={reading} analysisStatus={analysis.status} precisionExpressions={expressions} /> : <dl className="circuit-preview__readings">
                <div data-measurement="voltage"><dt>{labels.voltage}</dt><dd>{format(reading?.voltageVolts, "V")}</dd></div>
                <div data-measurement="current"><dt>{labels.current}</dt><dd>{format(reading?.currentAmps, "A")}</dd></div>
                <div data-measurement="power"><dt>電力</dt><dd>{format(reading?.powerWatts, "W")}</dd></div>
                {analysis.mode === "ac" && <>
                  {reading && nonzeroAcMeasurement(part.kind, reading, "voltage", expressions) && <div data-measurement="voltage-phase"><dt>電圧位相</dt><dd>{format(reading.voltagePhaseDegrees, "°")}</dd></div>}
                  {reading && nonzeroAcMeasurement(part.kind, reading, "current", expressions) && <div data-measurement="current-phase"><dt>電流位相</dt><dd>{format(reading.currentPhaseDegrees, "°")}</dd></div>}
                  <div data-measurement="reactive-power"><dt>無効電力</dt><dd>{format(reading?.reactivePowerVars, "var")}</dd></div>
                </>}
              </dl>}
            </section>
          );
        })}
      </div>
    ) : (
      <p className="circuit-preview__empty">計測できる部品はありません。</p>
    );
  }

  return (
    <section className="circuit-preview" aria-label="回路プレビューの操作" data-scoped={Boolean(partId)}>
      <header className="circuit-preview__heading">
        <div className="circuit-preview__heading-copy">
          <h2>{partId ? "値を調整" : "プレビュー操作"}</h2>
          {initialDocument && (
            <p className="circuit-preview__change-status" role="status" aria-live="polite">
              {changedValueCount === 0 ? "変更なし" : `${changedValueCount}項目を変更`}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={reset} disabled={Boolean(initialDocument) && changedValueCount === 0} title="編集時の値に戻す">
          {partId ? "この部品をリセット" : "すべてリセット"}
        </Button>
      </header>
      {!partId && <p className="circuit-preview__description">値やスイッチの変更はプレビュー内だけに反映されます。</p>}
      {summary && <div className="circuit-preview__summary">{summary}</div>}

      {partId && showReadings ? (
        <div className="circuit-preview__part-layout">
          <section className="circuit-preview__controls" aria-label="部品の操作">{renderControls()}</section>
          <section className="circuit-preview__live" aria-label="部品の計測値">
            <h3>計測値</h3>
            {renderReadings()}
          </section>
        </div>
      ) : showReadings ? (
        <Tabs defaultValue="controls">
          <TabsList aria-label="プレビュー表示" className="circuit-preview__tabs">
            <TabsTrigger value="controls">操作</TabsTrigger>
            <TabsTrigger value="readings">計測</TabsTrigger>
          </TabsList>
          <TabsContent value="controls" className="circuit-preview__tabpanel">{renderControls()}</TabsContent>
          <TabsContent value="readings" className="circuit-preview__tabpanel">{renderReadings()}</TabsContent>
        </Tabs>
      ) : (
        <div className="circuit-preview__tabpanel">{renderControls()}</div>
      )}
    </section>
  );
}
