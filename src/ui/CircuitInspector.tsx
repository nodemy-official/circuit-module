import { circuitPartCatalog, circuitPartNumericFields, type CircuitPart, type CircuitPartNumericKey, type CircuitWire } from "../circuit-model.js";
import type { CircuitAnalysis, CircuitPartReading } from "../circuit-solver.js";
import { circuitSlot, type CircuitStyleProps } from "./style-props.js";
import { CircuitIcon } from "./CircuitIcon.js";
import { measurementLabels } from "./measurement-labels.js";
import { CircuitMeterReadout, getMeterDisplay } from "./CircuitMeterReadout.js";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

export type CircuitInspectorSlot =
  | "root"
  | "heading"
  | "headingTitle"
  | "emptyState"
  | "emptyIcon"
  | "emptyTitle"
  | "emptyDescription"
  | "selection"
  | "selectionName"
  | "selectionLabel"
  | "wireIcon"
  | "wireKindLabel"
  | "wireConnectionLabel"
  | "wireDetail"
  | "wireDetailLabel"
  | "wireDetailValue"
  | "wireReconnectActions"
  | "wireFromReconnectButton"
  | "wireToReconnectButton"
  | "wireReconnectHint"
  | "wireRouteHint"
  | "wireRouteResetButton"
  | "fields"
  | "field"
  | "fieldLabel"
  | "textInput"
  | "numericInputContainer"
  | "numericInput"
  | "unit"
  | "switch"
  | "switchText"
  | "switchLabel"
  | "switchDescription"
  | "switchInput"
  | "readings"
  | "readingsTitle"
  | "readingNote"
  | "readingList"
  | "readingRow"
  | "readingLabel"
  | "readingValue"
  | "readingUnit"
  | "actions"
  | "rotateButton"
  | "rotateIcon"
  | "deleteButton"
  | "deleteIcon";

export interface CircuitInspectorProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "onChange" | "part" | "style"> {
  part?: CircuitPart;
  reading?: CircuitPartReading;
  analysisStatus?: CircuitAnalysis["status"];
  wire?: CircuitWire;
  /** Human-readable connection, for example "電池の−端子 → 抵抗の端子A". */
  wireLabel?: string;
  /** Human-readable endpoint names displayed on the reconnect buttons. */
  wireEndpoints?: { from: string; to: string };
  onChange?: (id: string, patch: Partial<CircuitPart>) => void;
  onRotate?: () => void;
  onDelete?: () => void;
  onReconnect?: (end: "from" | "to") => void;
  /** Removes manual waypoints so the wire returns to automatic routing. */
  onResetWireRoute?: () => void;
  style?: CircuitStyleProps["style"];
  slotProps?: Partial<Record<CircuitInspectorSlot, CircuitStyleProps>>;
}

const format = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "—" : Number(value.toPrecision(4)).toString();
const terminalLabel = (terminal: CircuitWire["from"]["terminal"]) => `端子${terminal.toUpperCase()}`;

interface InspectorShell {
  sectionProps: Omit<ComponentPropsWithoutRef<"section">, "children">;
  rootProps: CircuitStyleProps;
  ariaLabel?: string;
  slotProps?: CircuitInspectorProps["slotProps"];
  heading: ReactNode;
}

function InspectorSection({
  shell,
  state,
  kind,
  children,
}: {
  shell: InspectorShell;
  state: "empty" | "wire" | "part";
  kind?: CircuitPart["kind"];
  children: ReactNode;
}) {
  return (
    <section {...shell.sectionProps} {...shell.rootProps} aria-label={shell.ariaLabel ?? "プロパティ"} data-state={state} data-kind={kind}>
      {shell.heading}
      {children}
    </section>
  );
}

function EmptyInspector({ shell }: { shell: InspectorShell }) {
  const { slotProps } = shell;
  return (
    <InspectorSection shell={shell} state="empty">
      <div {...circuitSlot("circuit-inspector__empty", slotProps?.emptyState)}>
        <CircuitIcon name="cursor" {...circuitSlot(undefined, slotProps?.emptyIcon)} />
        <strong {...circuitSlot(undefined, slotProps?.emptyTitle)}>部品または導線を選択</strong>
        <p {...circuitSlot(undefined, slotProps?.emptyDescription)}>部品を選ぶと、ここで値を編集できます。</p>
      </div>
    </InspectorSection>
  );
}

function WireInspector({
  shell,
  wire,
  wireLabel,
  wireEndpoints,
  onReconnect,
  onResetWireRoute,
  onDelete,
}: {
  shell: InspectorShell;
  wire: CircuitWire;
  wireLabel?: string;
  wireEndpoints?: CircuitInspectorProps["wireEndpoints"];
  onReconnect?: CircuitInspectorProps["onReconnect"];
  onResetWireRoute?: CircuitInspectorProps["onResetWireRoute"];
  onDelete?: () => void;
}) {
  const { slotProps } = shell;
  const fromLabel = wireEndpoints?.from ?? terminalLabel(wire.from.terminal);
  const toLabel = wireEndpoints?.to ?? terminalLabel(wire.to.terminal);
  return (
    <InspectorSection shell={shell} state="wire">
      <div {...circuitSlot("circuit-inspector__selection", slotProps?.selection)}>
        <CircuitIcon name="wire" {...circuitSlot(undefined, slotProps?.wireIcon)} />
        <div>
          <strong {...circuitSlot(undefined, slotProps?.wireKindLabel)}>導線</strong>
          <span {...circuitSlot(undefined, slotProps?.wireConnectionLabel)}>接続</span>
        </div>
      </div>
      <div {...circuitSlot("circuit-inspector__wire-detail", slotProps?.wireDetail)}>
        <span {...circuitSlot(undefined, slotProps?.wireDetailLabel)}>接続先</span>
        <strong {...circuitSlot(undefined, slotProps?.wireDetailValue)}>{wireLabel ?? `${terminalLabel(wire.from.terminal)} → ${terminalLabel(wire.to.terminal)}`}</strong>
      </div>
      <p {...circuitSlot("circuit-inspector__wire-route-hint", slotProps?.wireRouteHint)}>
        導線や四角のハンドルをドラッグして経路を調整できます。端の丸は接続先変更に使います。
      </p>
      {wire.waypoints !== undefined && onResetWireRoute && (
        <button
          {...circuitSlot("circuit-inspector__wire-route-reset-button", slotProps?.wireRouteResetButton)}
          type="button"
          onClick={onResetWireRoute}
          aria-label="自動配線に戻す"
        >
          自動配線に戻す
        </button>
      )}
      {onReconnect && (
        <>
          <div {...circuitSlot("circuit-inspector__wire-reconnect", slotProps?.wireReconnectActions)}>
            <button
              {...circuitSlot("circuit-inspector__wire-reconnect-button", slotProps?.wireFromReconnectButton)}
              type="button"
              onClick={() => onReconnect("from")}
              aria-label={`始点の${fromLabel}をつなぎ替え`}
            >
              始点: {fromLabel} · つなぎ替え
            </button>
            <button
              {...circuitSlot("circuit-inspector__wire-reconnect-button", slotProps?.wireToReconnectButton)}
              type="button"
              onClick={() => onReconnect("to")}
              aria-label={`終点の${toLabel}をつなぎ替え`}
            >
              終点: {toLabel} · つなぎ替え
            </button>
          </div>
          <p {...circuitSlot("circuit-inspector__wire-reconnect-hint", slotProps?.wireReconnectHint)}>
            導線の両端の丸をドラッグして接続先を変更できます。
          </p>
        </>
      )}
      <div {...circuitSlot("circuit-inspector__actions", slotProps?.actions)}>
        <button {...circuitSlot("danger", slotProps?.deleteButton)} type="button" onClick={onDelete} disabled={!onDelete}>
          <CircuitIcon name="trash" {...circuitSlot(undefined, slotProps?.deleteIcon)} />削除
        </button>
      </div>
    </InspectorSection>
  );
}

function InspectorFields({
  part,
  onChange,
  slotProps,
}: {
  part: CircuitPart;
  onChange?: CircuitInspectorProps["onChange"];
  slotProps?: CircuitInspectorProps["slotProps"];
}) {
  const change = (patch: Partial<CircuitPart>) => onChange?.(part.id, patch);
  const defaults = circuitPartCatalog[part.kind].defaults;
  const numericFields = circuitPartNumericFields(part.kind);
  const numeric = (key: CircuitPartNumericKey, label: string, unit: string, min?: number, max?: number, step?: number, exclusiveMin?: boolean) => {
    const value = part[key] ?? defaults[key] ?? 0;
    return (
      <label {...circuitSlot("circuit-field", slotProps?.field)} key={key} data-field={key}>
        <span {...circuitSlot("circuit-field__label", slotProps?.fieldLabel)}>{label}</span>
        <span {...circuitSlot("circuit-field__input", slotProps?.numericInputContainer)}>
          <input
            {...circuitSlot(undefined, slotProps?.numericInput)}
            type="number"
            step={step ?? "any"}
            min={min}
            max={max}
            value={value}
            onChange={(event) => {
              const nextValue = event.currentTarget.valueAsNumber;
              if (!Number.isFinite(nextValue)) { return; }
              if (min !== undefined && (exclusiveMin ? nextValue <= min : nextValue < min)) { return; }
              if (max !== undefined && nextValue > max) { return; }
              change({ [key]: nextValue });
            }}
            disabled={!onChange}
            data-field={key}
          />
          {unit && <small {...circuitSlot(undefined, slotProps?.unit)}>{unit}</small>}
        </span>
      </label>
    );
  };

  return (
    <div {...circuitSlot("circuit-inspector__fields", slotProps?.fields)}>
      <label {...circuitSlot("circuit-field", slotProps?.field)} data-field="label">
        <span {...circuitSlot("circuit-field__label", slotProps?.fieldLabel)}>表示名</span>
        <input
          {...circuitSlot(undefined, slotProps?.textInput)}
          type="text"
          value={part.label}
          onChange={(event) => change({ label: event.target.value })}
          disabled={!onChange}
          data-field="label"
        />
      </label>
      {numericFields.map(({ key, label, unit, min, max, step, exclusiveMin }) =>
        numeric(key, label, key === "wiperPosition" ? "0–1" : unit, min, max, step, exclusiveMin))}
      {part.kind === "switch" && (
        <label {...circuitSlot("circuit-switch", slotProps?.switch)} data-field="initiallyClosed">
          <span {...circuitSlot(undefined, slotProps?.switchText)}>
            <strong {...circuitSlot(undefined, slotProps?.switchLabel)}>スイッチ</strong>
            <small {...circuitSlot(undefined, slotProps?.switchDescription)}>回路を閉じる</small>
          </span>
          <input
            {...circuitSlot(undefined, slotProps?.switchInput)}
            type="checkbox"
            role="switch"
            aria-label="スイッチを閉じる"
            aria-checked={part.initiallyClosed ?? false}
            checked={part.initiallyClosed ?? false}
            onChange={(event) => change({ initiallyClosed: event.target.checked })}
            disabled={!onChange}
            data-field="initiallyClosed"
          />
        </label>
      )}
    </div>
  );
}

function InspectorReadings({
  kind,
  reading,
  analysisStatus,
  slotProps,
}: {
  kind: CircuitPart["kind"];
  reading?: CircuitPartReading;
  analysisStatus?: CircuitAnalysis["status"];
  slotProps?: CircuitInspectorProps["slotProps"];
}) {
  const meterDisplay = getMeterDisplay(kind, reading, analysisStatus);
  if (meterDisplay) {
    return (
      <div {...circuitSlot("circuit-inspector__readings", slotProps?.readings)}>
        <h3 {...circuitSlot(undefined, slotProps?.readingsTitle)}>計測値</h3>
        <CircuitMeterReadout kind={kind} reading={reading} analysisStatus={analysisStatus} />
      </div>
    );
  }
  if (!reading) { return null; }
  const labels = measurementLabels(kind);
  const isAc = reading.voltagePhaseDegrees !== undefined || reading.currentPhaseDegrees !== undefined;
  return (
    <div {...circuitSlot("circuit-inspector__readings", slotProps?.readings)}>
      <h3 {...circuitSlot(undefined, slotProps?.readingsTitle)}>計測値</h3>
      <p {...circuitSlot("circuit-inspector__reading-note", slotProps?.readingNote)}>
        {isAc ? "交流の電圧・電流は実効値です。位相は角度で表示します。" : "直流の電圧・電流は端子の向きに対する符号付き値です。"}
      </p>
      <dl {...circuitSlot(undefined, slotProps?.readingList)}>
        <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="voltage">
          <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>{labels.voltage}</dt>
          <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.voltageVolts)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>V</small></dd>
        </div>
        <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="current">
          <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>{labels.current}</dt>
          <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.currentAmps)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>A</small></dd>
        </div>
        <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="power">
          <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>電力</dt>
          <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.powerWatts)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>W</small></dd>
        </div>
        {(reading.voltagePhaseDegrees !== undefined || reading.currentPhaseDegrees !== undefined) && <>
          <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="voltage-phase">
            <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>電圧位相</dt>
            <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.voltagePhaseDegrees)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>°</small></dd>
          </div>
          <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="current-phase">
            <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>電流位相</dt>
            <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.currentPhaseDegrees)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>°</small></dd>
          </div>
          {reading.reactivePowerVars !== undefined && <div {...circuitSlot(undefined, slotProps?.readingRow)} data-measurement="reactive-power">
            <dt {...circuitSlot(undefined, slotProps?.readingLabel)}>無効電力</dt>
            <dd {...circuitSlot(undefined, slotProps?.readingValue)}><span>{format(reading.reactivePowerVars)}</span><small {...circuitSlot(undefined, slotProps?.readingUnit)}>var</small></dd>
          </div>}
        </>}
      </dl>
    </div>
  );
}

function PartInspector({
  shell,
  part,
  reading,
  analysisStatus,
  onChange,
  onRotate,
  onDelete,
}: {
  shell: InspectorShell;
  part: CircuitPart;
  reading?: CircuitPartReading;
  analysisStatus?: CircuitAnalysis["status"];
  onChange?: CircuitInspectorProps["onChange"];
  onRotate?: () => void;
  onDelete?: () => void;
}) {
  const { slotProps } = shell;
  return (
    <InspectorSection shell={shell} state="part" kind={part.kind}>
      <div {...circuitSlot("circuit-inspector__selection", slotProps?.selection)}>
        <strong {...circuitSlot(undefined, slotProps?.selectionName)}>{circuitPartCatalog[part.kind].name}</strong>
        <span {...circuitSlot(undefined, slotProps?.selectionLabel)}>{part.label || "名称未設定"}</span>
      </div>
      <InspectorFields part={part} onChange={onChange} slotProps={slotProps} />
      <InspectorReadings kind={part.kind} reading={reading} analysisStatus={analysisStatus} slotProps={slotProps} />
      <div {...circuitSlot("circuit-inspector__actions", slotProps?.actions)}>
        <button {...circuitSlot(undefined, slotProps?.rotateButton)} type="button" onClick={onRotate} disabled={!onRotate || part.kind === "junction"}>
          <CircuitIcon name="rotate" {...circuitSlot(undefined, slotProps?.rotateIcon)} />回転
        </button>
        <button {...circuitSlot("danger", slotProps?.deleteButton)} type="button" onClick={onDelete} disabled={!onDelete}>
          <CircuitIcon name="trash" {...circuitSlot(undefined, slotProps?.deleteIcon)} />削除
        </button>
      </div>
    </InspectorSection>
  );
}

/** Properties and live readings for the selected part or wire. */
export function CircuitInspector({
  part,
  reading,
  analysisStatus,
  wire,
  wireLabel,
  wireEndpoints,
  onChange,
  onRotate,
  onDelete,
  onReconnect,
  onResetWireRoute,
  className,
  style,
  slotProps,
  "aria-label": ariaLabel,
  ...sectionProps
}: CircuitInspectorProps) {
  const heading = (
    <div {...circuitSlot("circuit-panel__heading", slotProps?.heading)}>
      <h2 {...circuitSlot(undefined, slotProps?.headingTitle)}>プロパティ</h2>
    </div>
  );
  const rootProps = circuitSlot("circuit-panel circuit-inspector", {
    className: [className, slotProps?.root?.className].filter(Boolean).join(" "),
    style: style || slotProps?.root?.style ? { ...style, ...slotProps?.root?.style } : undefined,
  });
  const shell: InspectorShell = { sectionProps, rootProps, ariaLabel, slotProps, heading };
  if (!part && !wire) { return <EmptyInspector shell={shell} />; }
  if (!part && wire) { return <WireInspector shell={shell} wire={wire} wireLabel={wireLabel} wireEndpoints={wireEndpoints} onReconnect={onReconnect} onResetWireRoute={onResetWireRoute} onDelete={onDelete} />; }
  if (!part) { return null; }
  return <PartInspector shell={shell} part={part} reading={reading} analysisStatus={analysisStatus} onChange={onChange} onRotate={onRotate} onDelete={onDelete} />;
}
