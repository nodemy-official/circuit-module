import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircuitBoard } from "../src/ui/CircuitBoard.js";
import { CircuitPalette } from "../src/ui/CircuitPalette.js";
import { CircuitInspector } from "../src/ui/CircuitInspector.js";
import { CircuitAnalysisPanel } from "../src/ui/CircuitAnalysisPanel.js";
import { useCircuitEditor } from "../src/ui/useCircuitEditor.js";
import { analyzeCircuit } from "../src/circuit-solver.js";
import { createExampleCircuit, type CircuitEndpoint } from "../src/circuit-model.js";
import "../src/ui/styles.css";

const document = createExampleCircuit();
const analysis = analyzeCircuit(document);

const meta = {
  title: "Circuit/Parts",
  component: CircuitBoard,
  args: { document },
  parameters: { layout: "padded" },
} satisfies Meta<typeof CircuitBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Board: Story = {
  name: "基板",
  args: { document },
};

export const Palette: Story = {
  name: "部品パレット",
  render: () => <div style={{ width: 250, padding: 18, border: "1px solid var(--circuit-line)" }}><CircuitPalette onAdd={() => {}} /></div>,
};

export const Inspector: Story = {
  name: "設定パネル",
  render: () => <div style={{ width: 270, padding: 18, border: "1px solid var(--circuit-line)" }}><CircuitInspector part={document.parts[0]} reading={analysis.parts[document.parts[0].id]} /></div>,
};

export const Analysis: Story = {
  name: "解析パネル",
  render: () => <div style={{ width: 270, padding: 18, border: "1px solid var(--circuit-line)" }}><CircuitAnalysisPanel analysis={analysis} partCount={document.parts.length} wireCount={document.wires.length} /></div>,
};

function CustomWorkbench() {
  const editor = useCircuitEditor();
  const selected = editor.document.parts.find((part) => part.id === editor.selection.parts[0]);
  const selectedWire = editor.document.wires.find((wire) => wire.id === editor.selection.wires[0]);
  const endpointLabel = (endpoint: CircuitEndpoint) => {
    const part = editor.document.parts.find((item) => item.id === endpoint.partId);
    return `${part?.label || part?.id || "部品"}の${endpoint.terminal === "a" ? "端子A" : "端子B"}`;
  };
  const wireEndpoints = selectedWire ? { from: endpointLabel(selectedWire.from), to: endpointLabel(selectedWire.to) } : undefined;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: 20, background: "var(--circuit-soft)", padding: 24 }}>
      <div style={{ minWidth: 0 }}>
        <CircuitAnalysisPanel analysis={editor.analysis} partCount={editor.document.parts.length} wireCount={editor.document.wires.length} />
        <CircuitBoard
          document={editor.document}
          selection={editor.selection}
          pendingEndpoint={editor.pendingEndpoint}
          pendingWire={editor.pendingWire}
          onSelectPart={editor.selectPart}
          onSelectWire={editor.selectWire}
          onTerminalClick={editor.chooseTerminal}
          onConnectionStart={editor.startConnection}
          onReconnectStart={editor.startReconnect}
          onConnectionCancel={editor.cancelConnection}
          onBoardClick={editor.choosePoint}
          onMovePart={editor.movePart}
          onWireRouteChange={editor.updateWireRoute}
          onWireRouteCancel={editor.cancelWireRoute}
          onWireRouteEnd={editor.endEdit}
        />
      </div>
      <div style={{ background: "var(--circuit-surface)", padding: 16 }}>
        <CircuitInspector
          part={selected}
          wire={selectedWire}
          wireEndpoints={wireEndpoints}
          reading={selected ? editor.analysis.parts[selected.id] : undefined}
          onChange={editor.updatePart}
          onRotate={editor.rotateSelected}
          onDelete={editor.removeSelected}
          onReconnect={selectedWire ? (end) => editor.startReconnect(selectedWire.id, end) : undefined}
          onResetWireRoute={selectedWire ? () => editor.resetWireRoute(selectedWire.id) : undefined}
        />
        <CircuitPalette onAdd={editor.add} />
      </div>
    </div>
  );
}

export const CustomLayout: Story = {
  name: "自由な組み合わせ",
  render: () => <CustomWorkbench />,
};
