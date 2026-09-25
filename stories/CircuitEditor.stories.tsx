import type { Meta, StoryObj } from "@storybook/react-vite";
import { CircuitEditor } from "../src/ui/CircuitEditor.js";
import { CircuitEditorLayout } from "../src/ui/preset.js";
import { createExampleCircuit, type CircuitDocument } from "../src/circuit-model.js";
import { createCircuitExample } from "../src/circuit-examples.js";
import "../src/ui/styles.css";

const meta = {
  title: "Circuit/Editor",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;
const exampleCircuit = createExampleCircuit();

function openPartPreview(canvasElement: HTMLElement, partId: string) {
  const previewButton = canvasElement.querySelector<HTMLButtonElement>('button[title="回路をプレビュー"]');
  if (!previewButton) { throw new Error("プレビューボタンが見つかりません。"); }
  previewButton.click();
  const part = canvasElement.querySelector<SVGElement>(`.circuit-board__part[data-part-id="${partId}"]`);
  if (!part) { throw new Error(`プレビューする部品が見つかりません: ${partId}`); }
  part.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
}

const shortCircuitDocument: CircuitDocument = {
  title: "短絡の確認",
  parts: [{
    id: "battery-1",
    kind: "battery",
    x: 10,
    y: 8,
    label: "電池",
    voltageVolts: 9,
    internalResistanceOhms: 0,
  }, {
    id: "junction-left",
    kind: "junction",
    x: 5,
    y: 12,
    label: "接続点1",
  }, {
    id: "junction-right",
    kind: "junction",
    x: 15,
    y: 12,
    label: "接続点2",
  }],
  wires: [
    {
      id: "wire-1",
      from: { partId: "battery-1", terminal: "a" },
      to: { partId: "junction-left", terminal: "a" },
    },
    {
      id: "wire-2",
      from: { partId: "junction-left", terminal: "a" },
      to: { partId: "junction-right", terminal: "a" },
    },
    {
      id: "wire-3",
      from: { partId: "junction-right", terminal: "a" },
      to: { partId: "battery-1", terminal: "b" },
    },
  ],
};

const meterReadingsDocument: CircuitDocument = {
  title: "電流計と電圧計",
  parts: [{
    id: "battery",
    kind: "battery",
    x: 5,
    y: 8,
    label: "電池 9 V",
    voltageVolts: 9,
    internalResistanceOhms: 0,
  }, {
    id: "ammeter",
    kind: "ammeter",
    x: 11,
    y: 8,
    label: "電流計",
  }, {
    id: "resistor",
    kind: "resistor",
    x: 17,
    y: 8,
    label: "抵抗 30 Ω",
    resistanceOhms: 30,
  }, {
    id: "voltmeter",
    kind: "voltmeter",
    x: 17,
    y: 13,
    label: "電圧計",
  }],
  wires: [
    { id: "wire-1", from: { partId: "battery", terminal: "a" }, to: { partId: "ammeter", terminal: "a" } },
    { id: "wire-2", from: { partId: "ammeter", terminal: "b" }, to: { partId: "resistor", terminal: "a" } },
    { id: "wire-3", from: { partId: "resistor", terminal: "b" }, to: { partId: "battery", terminal: "b" } },
    { id: "wire-4", from: { partId: "voltmeter", terminal: "a" }, to: { partId: "resistor", terminal: "a" } },
    { id: "wire-5", from: { partId: "voltmeter", terminal: "b" }, to: { partId: "resistor", terminal: "b" } },
  ],
};

const wireRoutingDocument: CircuitDocument = {
  title: "導線の経路編集",
  parts: [{
    id: "junction-start",
    kind: "junction",
    x: 5,
    y: 8,
    label: "接続点A",
  }, {
    id: "junction-end",
    kind: "junction",
    x: 17,
    y: 8,
    label: "接続点B",
  }],
  wires: [{
    id: "wire-route",
    from: { partId: "junction-start", terminal: "a" },
    to: { partId: "junction-end", terminal: "a" },
    waypoints: [{ x: 5, y: 4 }, { x: 17, y: 4 }],
  }],
};

export const Interactive: Story = {
  name: "回路エディター",
  render: () => <CircuitEditor><CircuitEditorLayout /></CircuitEditor>,
};

export const Preview: Story = {
  name: "プレビュー",
  render: () => <CircuitEditor><CircuitEditorLayout /></CircuitEditor>,
  play: ({ canvasElement }) => {
    const previewButton = canvasElement.querySelector<HTMLButtonElement>('button[title="回路をプレビュー"]');
    if (!previewButton) { throw new Error("プレビューボタンが見つかりません。"); }
    previewButton.click();
  },
};

export const PreviewPartDialog: Story = {
  name: "プレビュー・部品ダイアログ",
  render: () => <CircuitEditor><CircuitEditorLayout /></CircuitEditor>,
  play: ({ canvasElement }) => openPartPreview(canvasElement, "part-2"),
};

export const PreviewMobile: Story = {
  name: "プレビュー・モバイル",
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <CircuitEditor><CircuitEditorLayout /></CircuitEditor>,
  play: ({ canvasElement }) => openPartPreview(canvasElement, "part-2"),
};

export const PreviewDark: Story = {
  name: "プレビュー・ダーク",
  globals: { theme: "dark" },
  render: () => <CircuitEditor><CircuitEditorLayout /></CircuitEditor>,
  play: ({ canvasElement }) => openPartPreview(canvasElement, "part-2"),
};

export const OpenCircuit: Story = {
  name: "開回路",
  render: () => (
    <CircuitEditor initialDocument={{
      ...exampleCircuit,
      title: "スイッチを開いた回路",
      parts: exampleCircuit.parts.map((part) =>
        part.kind === "switch" ? { ...part, initiallyClosed: false } : part,
      ),
    }}>
      <CircuitEditorLayout />
    </CircuitEditor>
  ),
};

export const EmptyCircuit: Story = {
  name: "空の回路",
  render: () => <CircuitEditor initialDocument={{ title: "空の回路", parts: [], wires: [] }}><CircuitEditorLayout /></CircuitEditor>,
};

export const ShortCircuit: Story = {
  name: "短絡",
  render: () => <CircuitEditor initialDocument={shortCircuitDocument}><CircuitEditorLayout /></CircuitEditor>,
};

export const MeterReadings: Story = {
  name: "電流計・電圧計",
  render: () => <CircuitEditor initialDocument={meterReadingsDocument}><CircuitEditorLayout /></CircuitEditor>,
};

export const WireRouting: Story = {
  name: "導線の経路編集",
  render: () => <CircuitEditor initialDocument={wireRoutingDocument}><CircuitEditorLayout /></CircuitEditor>,
  play: ({ canvasElement }) => {
    const wire = canvasElement.querySelector<SVGGElement>('[data-wire-id="wire-route"]');
    if (!wire) { throw new Error("経路を編集する導線が見つかりません。"); }
    wire.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  },
};

export const AlternatingCurrent: Story = {
  name: "交流のRCフィルタ",
  render: () => <CircuitEditor initialDocument={createCircuitExample("ac")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Rlc: Story = {
  name: "RLC回路",
  render: () => <CircuitEditor initialDocument={createCircuitExample("rlc")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Charging: Story = {
  name: "コンデンサの充電・学習可視化",
  parameters: {
    docs: {
      description: {
        story: "「電位を色で表示」を有効にして、抵抗やコンデンサの端子電位を見比べます。「解析の設定」から「時間波形・過渡解析」を開き、「波形を計算」を押して部品を2〜3個選びます。共通の「時間カーソル」を動かすか「再生」すると、同時刻の数値と回路図上の状態が同期します。値を変更して比べるときは「プレビュー」を開き、基板の下にある「学習ビュー」で変更前後の波形と計測値を確認します。",
      },
    },
  },
  render: () => <CircuitEditor initialDocument={createCircuitExample("charging")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Rectifier: Story = {
  name: "ダイオードの半波整流",
  render: () => <CircuitEditor initialDocument={createCircuitExample("rectifier")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Semiconductors: Story = {
  name: "LED",
  render: () => <CircuitEditor initialDocument={createCircuitExample("led")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Transistor: Story = {
  name: "トランジスタ",
  render: () => <CircuitEditor initialDocument={createCircuitExample("transistor")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Mosfet: Story = {
  name: "MOSFET",
  render: () => <CircuitEditor initialDocument={createCircuitExample("mosfet")}><CircuitEditorLayout /></CircuitEditor>,
};

export const Opamp: Story = {
  name: "オペアンプ",
  render: () => <CircuitEditor initialDocument={createCircuitExample("opamp")}><CircuitEditorLayout /></CircuitEditor>,
};
