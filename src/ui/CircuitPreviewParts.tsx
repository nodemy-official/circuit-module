import { circuitPartCatalog, circuitPartNumericFields, type CircuitDocument, type CircuitPart } from "../circuit-model.js";
import type { CircuitAnalysis } from "../circuit-solver.js";
import { formatCircuitQuantity } from "../circuit-visualization.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { getMeterDisplay } from "./CircuitMeterReadout.js";
import { CircuitPartIcon } from "./CircuitPalette.js";
import { measurementLabels } from "./measurement-labels.js";
import { Button } from "./primitives.js";

interface CircuitPreviewPartsProps {
  document: CircuitDocument;
  initialDocument: CircuitDocument;
  analysis: CircuitAnalysis;
  onInspectPart: (id: string) => void;
  onSwitchToggle: (id: string) => void;
  onReset: () => void;
}

function partChanged(part: CircuitPart, initial?: CircuitPart) {
  if (!initial) { return true; }
  const defaults = circuitPartCatalog[part.kind].defaults;
  const numericChanged = circuitPartNumericFields(part.kind).some(({ key }) =>
    !Object.is(part[key] ?? defaults[key], initial[key] ?? defaults[key]));
  return numericChanged || (part.kind === "switch" &&
    (part.initiallyClosed ?? defaults.initiallyClosed) !== (initial.initiallyClosed ?? defaults.initiallyClosed));
}

function setting(part: CircuitPart) {
  const fields = circuitPartNumericFields(part.kind);
  const field = part.kind === "led" ? fields.find(({ key }) => key === "ratedCurrentAmps") : fields[0];
  if (!field) { return; }
  const value = part[field.key] ?? circuitPartCatalog[part.kind].defaults[field.key];
  return {
    label: field.label,
    value: field.unit === "°" ? `${value ?? "—"}°` : field.unit ? formatCircuitQuantity(value, field.unit) : String(value ?? "—"),
  };
}

function PartReadings({ part, analysis }: { part: CircuitPart; analysis: CircuitAnalysis }) {
  if (part.kind === "ground" || part.kind === "junction") {
    return <p className="circuit-preview-parts__note">{part.kind === "ground" ? "回路の電位の基準" : "導線をつなぐ接続点"}</p>;
  }
  const reading = analysis.parts[part.id];
  const meter = getMeterDisplay(part.kind, reading, analysis.status);
  if (meter) {
    return <div className="circuit-preview-parts__meter" data-status={meter.status}>
      <span>{part.kind === "ammeter" ? "計測電流" : "計測電圧"}</span>
      <strong>{meter.text}</strong>
      {meter.phaseText && <small>{meter.phaseText}</small>}
    </div>;
  }
  const measurable = analysis.status !== "invalid" && analysis.status !== "short";
  const labels = measurementLabels(part.kind);
  return <dl className="circuit-preview-parts__readings">
    <div><dt>{labels.voltage}</dt><dd>{formatCircuitQuantity(measurable ? reading?.voltageVolts : undefined, "V")}</dd></div>
    <div><dt>{labels.current}</dt><dd>{formatCircuitQuantity(measurable ? reading?.currentAmps : undefined, "A")}</dd></div>
  </dl>;
}

function LightStatus({ part, analysis }: { part: CircuitPart; analysis: CircuitAnalysis }) {
  if (part.kind !== "bulb" && part.kind !== "led") { return null; }
  const brightness = analysis.status === "invalid" || analysis.status === "short" ? undefined : analysis.parts[part.id]?.brightness;
  const lit = brightness !== undefined && brightness > 0;
  return <span className="circuit-preview-parts__light" data-lit={lit}>{brightness === undefined ? "点灯状態未計測" : lit ? "点灯" : "消灯"}</span>;
}

/** Visible controls and live readings keep experiments next to the circuit. */
export function CircuitPreviewParts({ document, initialDocument, analysis, onInspectPart, onSwitchToggle, onReset }: CircuitPreviewPartsProps) {
  const initialParts = new Map(initialDocument.parts.map((part) => [part.id, part]));
  const changedIds = new Set(document.parts.filter((part) => partChanged(part, initialParts.get(part.id))).map((part) => part.id));
  if (document.parts.length === 0) { return null; }
  return <section className="circuit-preview-parts" aria-label="部品の操作と計測">
    <header className="circuit-preview-parts__heading">
      <h2>部品 <span>{document.parts.length}</span></h2>
      <Button variant="ghost" disabled={changedIds.size === 0} onClick={() => onReset()}><CircuitIcon name="undo" size={15} />元の値に戻す</Button>
    </header>
    <ul className="circuit-preview-parts__grid">
      {document.parts.map((part) => {
        const value = setting(part);
        const reading = analysis.parts[part.id];
        const closed = reading?.switchClosed ?? part.initiallyClosed ?? circuitPartCatalog.switch.defaults.initiallyClosed ?? false;
        return <li className="circuit-preview-parts__card" key={part.id} data-part-id={part.id} data-kind={part.kind} data-changed={changedIds.has(part.id)}>
          <div className="circuit-preview-parts__identity">
            <span className="circuit-preview-parts__icon"><CircuitPartIcon kind={part.kind} aria-hidden="true" /></span>
            <div><h3>{part.label}</h3>{part.label !== circuitPartCatalog[part.kind].name && <span>{circuitPartCatalog[part.kind].name}</span>}</div>
            {changedIds.has(part.id) && <span className="circuit-preview-parts__changed">変更済み</span>}
          </div>
          <div className="circuit-preview-parts__configuration">
            {part.kind === "switch" ? <button type="button" className="circuit-preview-parts__switch" aria-label={`${part.label}のON / OFF`} aria-pressed={closed} onClick={() => onSwitchToggle(part.id)}>
              <span className="circuit-preview-parts__switch-track" aria-hidden="true"><span /></span><strong>{closed ? "ON" : "OFF"}</strong>
            </button> : value && <div className="circuit-preview-parts__setting"><span>{value.label}</span><strong>{value.value}</strong></div>}
            <LightStatus part={part} analysis={analysis} />
          </div>
          <PartReadings part={part} analysis={analysis} />
          <button type="button" className="circuit-preview-parts__inspect" aria-label={`${part.label}の調整・詳細`} aria-haspopup="dialog" onClick={() => onInspectPart(part.id)}>詳細<CircuitIcon name="arrowRight" size={14} /></button>
        </li>;
      })}
    </ul>
    <p className="circuit-preview-parts__footnote">{analysis.timeSeconds !== undefined ? "計測値は選択した時刻の瞬時値です。" : analysis.mode === "ac" ? "交流の電圧・電流は実効値です。" : "電圧・電流の符号は端子の向きを表します。"} 変更はこのプレビュー内にだけ反映されます。</p>
  </section>;
}
