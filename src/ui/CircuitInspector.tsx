import { circuitPartCatalog, type CircuitPart, type CircuitWire } from "../circuit-model.js";
import type { CircuitPartReading } from "../circuit-solver.js";
import { CircuitIcon } from "./CircuitIcon.js";
import "./editor.css";

export interface CircuitInspectorProps {
  part?: CircuitPart;
  reading?: CircuitPartReading;
  wire?: CircuitWire;
  /** Human-readable connection, for example "電池の−端子 → 抵抗の端子A". */
  wireLabel?: string;
  onChange?: (id: string, patch: Partial<CircuitPart>) => void;
  onRotate?: () => void;
  onDelete?: () => void;
  className?: string;
}

const number = (value: number | undefined) => value ?? 0;
const format = (value: number | undefined) => value === undefined ? "—" : value.toFixed(2);
const terminalLabel = (terminal: CircuitWire["from"]["terminal"]) => terminal === "a" ? "端子A" : "端子B";

/** Properties and live readings for the selected part or wire. */
export function CircuitInspector({ part, reading, wire, wireLabel, onChange, onRotate, onDelete, className = "" }: CircuitInspectorProps) {
  const heading = <div className="circuit-panel__heading"><h2>プロパティ</h2></div>;

  if (!part && !wire) return (
    <section className={`circuit-panel circuit-inspector ${className}`} aria-label="プロパティ">
      {heading}
      <div className="circuit-inspector__empty">
        <CircuitIcon name="cursor" />
        <strong>部品または導線を選択</strong>
        <p>部品を選ぶと、ここで値を編集できます。</p>
      </div>
    </section>
  );

  if (!part && wire) return (
    <section className={`circuit-panel circuit-inspector ${className}`} aria-label="プロパティ">
      {heading}
      <div className="circuit-inspector__selection">
        <CircuitIcon name="wire" />
        <div><strong>導線</strong><span>接続</span></div>
      </div>
      <div className="circuit-inspector__wire-detail">
        <span>接続先</span>
        <strong>{wireLabel ?? `${terminalLabel(wire.from.terminal)} → ${terminalLabel(wire.to.terminal)}`}</strong>
      </div>
      <div className="circuit-inspector__actions">
        <button type="button" className="danger" onClick={onDelete} disabled={!onDelete}>
          <CircuitIcon name="trash" />削除
        </button>
      </div>
    </section>
  );

  if (!part) return null;

  const change = (patch: Partial<CircuitPart>) => onChange?.(part.id, patch);
  const numeric = (label: string, key: "voltageVolts" | "internalResistanceOhms" | "resistanceOhms" | "ratedPowerWatts", unit: string, min: number) => (
    <label className="circuit-field" key={key}>
      <span className="circuit-field__label">{label}</span>
      <span className="circuit-field__input"><input type="number" step="any" min={min} value={number(part[key])} onChange={(event) => change({ [key]: Number(event.target.value) })} disabled={!onChange} /><small>{unit}</small></span>
    </label>
  );

  return (
    <section className={`circuit-panel circuit-inspector ${className}`} aria-label="プロパティ">
      {heading}
      <div className="circuit-inspector__selection">
        <strong>{circuitPartCatalog[part.kind].name}</strong>
        <span>{part.label || "名称未設定"}</span>
      </div>
      <div className="circuit-inspector__fields">
        <label className="circuit-field">
          <span className="circuit-field__label">表示名</span>
          <input type="text" value={part.label} onChange={(event) => change({ label: event.target.value })} disabled={!onChange} />
        </label>
        {part.kind === "battery" && <>{numeric("電圧", "voltageVolts", "V", 0)}{numeric("内部抵抗", "internalResistanceOhms", "Ω", 0)}</>}
        {(part.kind === "resistor" || part.kind === "bulb") && numeric("抵抗", "resistanceOhms", "Ω", 0)}
        {part.kind === "bulb" && numeric("定格電力", "ratedPowerWatts", "W", 0)}
        {part.kind === "switch" && (
          <label className="circuit-switch">
            <span><strong>スイッチ</strong><small>回路を閉じる</small></span>
            <input type="checkbox" role="switch" aria-label="スイッチを閉じる" checked={part.initiallyClosed ?? false} onChange={(event) => change({ initiallyClosed: event.target.checked })} disabled={!onChange} />
          </label>
        )}
      </div>
      {reading && <div className="circuit-inspector__readings"><h3>計測値</h3><dl>
        <div><dt>電圧</dt><dd><span>{format(reading.voltageVolts)}</span><small>V</small></dd></div>
        <div><dt>電流</dt><dd><span>{format(reading.currentAmps)}</span><small>A</small></dd></div>
        <div><dt>電力</dt><dd><span>{format(reading.powerWatts)}</span><small>W</small></dd></div>
      </dl></div>}
      <div className="circuit-inspector__actions">
        <button type="button" onClick={onRotate} disabled={!onRotate || part.kind === "junction"}>
          <CircuitIcon name="rotate" />回転
        </button>
        <button type="button" className="danger" onClick={onDelete} disabled={!onDelete}>
          <CircuitIcon name="trash" />削除
        </button>
      </div>
    </section>
  );
}
