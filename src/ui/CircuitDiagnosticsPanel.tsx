import type { ComponentPropsWithoutRef } from "react";
import type { CircuitDiagnostic } from "../circuit-diagnostics.js";
import type { CircuitSelection } from "../circuit-edit.js";
import { circuitSlot, type CircuitStyleProps } from "./style-props.js";

export type CircuitDiagnosticsPanelSlot = "root" | "heading" | "summary" | "list" | "issue" | "issueButton";

export interface CircuitDiagnosticsPanelProps extends Omit<ComponentPropsWithoutRef<"section">, "style" | "onSelect"> {
  style?: CircuitStyleProps["style"];
  diagnostics: readonly CircuitDiagnostic[];
  onSelect?: (selection: CircuitSelection) => void;
  slotProps?: Partial<Record<CircuitDiagnosticsPanelSlot, CircuitStyleProps>>;
}

const severityNames = { error: "エラー", warning: "注意", info: "確認" };

/** Structural checks with links back to the affected parts and wires. */
export function CircuitDiagnosticsPanel({ diagnostics, onSelect, slotProps, className, style, ...props }: CircuitDiagnosticsPanelProps) {
  return <section {...props} aria-label={props["aria-label"] ?? "接続チェック"} {...circuitSlot(["circuit-panel circuit-diagnostics", className].filter(Boolean).join(" "), slotProps?.root, style)}>
    <h2 {...circuitSlot("circuit-diagnostics__heading", slotProps?.heading)}>接続チェック</h2>
    <p {...circuitSlot("circuit-diagnostics__summary", slotProps?.summary)} role="status">
      {diagnostics.length === 0 ? "接続上の問題は見つかりませんでした。" : `${diagnostics.length} 件の確認項目があります。`}
    </p>
    {diagnostics.length > 0 && <ul {...circuitSlot("circuit-diagnostics__list", slotProps?.list)}>
      {diagnostics.map((diagnostic) => <li key={diagnostic.id} data-severity={diagnostic.severity} data-code={diagnostic.code} {...circuitSlot("circuit-diagnostics__issue", slotProps?.issue)}>
        {onSelect ? <button type="button" {...circuitSlot("circuit-diagnostics__issue-button", slotProps?.issueButton)} onClick={() => onSelect({ parts: diagnostic.partIds, wires: diagnostic.wireIds })}>
          <span>{severityNames[diagnostic.severity]}</span> {diagnostic.message}
        </button> : <><span>{severityNames[diagnostic.severity]}</span> {diagnostic.message}</>}
      </li>)}
    </ul>}
  </section>;
}
