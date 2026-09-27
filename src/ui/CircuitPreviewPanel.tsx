import { useId, useState, type ReactNode } from "react";
import { circuitPartCatalog, circuitPartNumericFields, type CircuitDocument, type CircuitPart, type CircuitPartNumericKey } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { getMeterDisplay, CircuitMeterReadout } from "./CircuitMeterReadout.js";
import { measurementLabels } from "./measurement-labels.js";
import { Button, Input, Switch, Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives.js";

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

function comparableValue(part: CircuitPart, key: AdjustableValue): number | boolean | undefined {
  if (key === "initiallyClosed") { return part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false; }
  return part[key] ?? circuitPartCatalog[part.kind].defaults[key] as number | undefined;
}

function isValidNumericValue(key: CircuitPartNumericKey, value: number, part: CircuitPart) {
  const field = circuitPartNumericFields(part.kind).find(({ key: fieldKey }) => fieldKey === key);
  if (!Number.isFinite(value)) { return false; }
  if (field?.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) { return false; }
  if (field?.max !== undefined && value > field.max) { return false; }
  return true;
}

function numericError(key: CircuitPartNumericKey, draft: string | undefined, part: CircuitPart) {
  if (draft === undefined) { return; }
  if (draft.trim() === "") { return "値を入力してください。現在の値は維持されます。"; }
  const value = Number(draft);
  if (!Number.isFinite(value)) { return "有限の数値を入力してください。"; }
  const field = circuitPartNumericFields(part.kind).find(({ key: fieldKey }) => fieldKey === key);
  if (!isValidNumericValue(key, value, part)) {
    if (field?.min !== undefined && (field.exclusiveMin ? value <= field.min : value < field.min)) {
      return `${field.min}${field.exclusiveMin ? "より大きい" : "以上の"}数値を入力してください。`;
    }
    if (field?.max !== undefined) { return `${field.max}以下の数値を入力してください。`; }
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
  const formatted = Number((value / scale).toPrecision(4)).toString();
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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const scopedParts = partId ? document.parts.filter((part) => part.id === partId) : document.parts;

  const { changedPartIds, changedValueCount } = previewChanges(scopedParts, initialDocument);

  const controls = [...scopedParts]
    .filter((part) => adjustableValues(part).length > 0)
    .sort((first, second) => partOrder(first) - partOrder(second));
  const readings = scopedParts.filter((part) => part.kind !== "junction");

  function reset() {
    setDrafts({});
    onReset();
  }

  function numeric(part: CircuitPart, key: CircuitPartNumericKey, label: string, unit: string, min?: number, max?: number, step?: number) {
    const draftKey = `${part.id}:${key}`;
    const draft = drafts[draftKey];
    const defaultValue = part.kind === "battery" && key === "voltageVolts"
      ? undefined
      : circuitPartCatalog[part.kind].defaults[key] as number | undefined;
    const committedValue = part[key] ?? defaultValue;
    const displayLabel = part.kind === "battery" && key === "voltageVolts" ? "電源電圧" : label;
    const errorId = `${id}-${part.id}-${key}-error`;
    const errorMessage = numericError(key, draft, part);

    return (
      <label className="circuit-preview__field" key={key} htmlFor={`${errorId}-input`}>
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
              value={draft ?? (committedValue === undefined ? "" : String(committedValue))}
              onValueChange={(valueText) => {
                setDrafts((current) => ({ ...current, [draftKey]: valueText }));
                if (valueText.trim() === "") { return; }
                const value = Number(valueText);
                if (isValidNumericValue(key, value, part)) {
                  onChange(part.id, { [key]: value } as Pick<Partial<CircuitPart>, CircuitPartNumericKey>);
                }
              }}
              onBlur={() => {
                setDrafts((current) => {
                  if (!(draftKey in current)) { return current; }
                  const next = { ...current };
                  delete next[draftKey];
                  return next;
                });
              }}
            />
            {unit && <small>{unit}</small>}
          </span>
          {errorMessage && <small className="circuit-preview__field-error" id={errorId}>{errorMessage}</small>}
        </span>
      </label>
    );
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
                {part.kind === "switch" && (
                  <label className="circuit-preview__switch" htmlFor={`${id}-${part.id}-switch`}>
                    <span>スイッチ</span>
                    <small className="circuit-preview__switch-hint">押して切り替え</small>
                    <Switch
                      id={`${id}-${part.id}-switch`}
                      aria-label={`${part.label}のON / OFF`}
                      checked={part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false}
                      onCheckedChange={(checked) => onChange(part.id, { initiallyClosed: checked })}
                    />
                    <strong>{(part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false) ? "ON" : "OFF"}</strong>
                  </label>
                )}
                {circuitPartNumericFields(part.kind).map(({ key, label, unit, min, max, step }) =>
                  numeric(part, key, label, key === "wiperPosition" ? "0–1" : unit, min, max, step))}
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
    return readings.length > 0 ? (
      <div className="circuit-preview__parts">
        <p className="circuit-preview__measurement-note">
          {analysis.mode === "ac"
            ? `交流解析 (${format(analysis.frequencyHz, "Hz")}) の電圧・電流は実効値です。位相は角度で表示します。`
            : "直流の電圧・電流は端子の向きに対する符号付き値です。"}
        </p>
        {readings.map((part) => {
          const reading = analysis.parts[part.id];
          const labels = measurementLabels(part.kind);
          const meter = getMeterDisplay(part.kind, reading, analysis.status);
          return (
            <section className="circuit-preview__part" key={part.id} data-part-id={part.id} data-changed={changedPartIds.has(part.id)}>
              {partHeading(part)}
              {meter ? <CircuitMeterReadout kind={part.kind} reading={reading} analysisStatus={analysis.status} /> : <dl className="circuit-preview__readings">
                <div data-measurement="voltage"><dt>{labels.voltage}</dt><dd>{format(reading?.voltageVolts, "V")}</dd></div>
                <div data-measurement="current"><dt>{labels.current}</dt><dd>{format(reading?.currentAmps, "A")}</dd></div>
                <div data-measurement="power"><dt>電力</dt><dd>{format(reading?.powerWatts, "W")}</dd></div>
                {analysis.mode === "ac" && <>
                  {reading && Math.abs(reading.voltageVolts) > 0 && <div data-measurement="voltage-phase"><dt>電圧位相</dt><dd>{format(reading.voltagePhaseDegrees, "°")}</dd></div>}
                  {reading && Math.abs(reading.currentAmps) > 0 && <div data-measurement="current-phase"><dt>電流位相</dt><dd>{format(reading.currentPhaseDegrees, "°")}</dd></div>}
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

      {partId ? (
        <div className="circuit-preview__part-layout">
          <section className="circuit-preview__controls" aria-label="部品の操作">{renderControls()}</section>
          <section className="circuit-preview__live" aria-label="部品の計測値">
            <h3>計測値<span>値の変更を反映</span></h3>
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
