import type { Meta, StoryObj } from "@storybook/react-vite";
import { createEmptyCircuit, createExampleCircuit, type CircuitDocument } from "../src/circuit-model.js";
import { createCircuitExample } from "../src/circuit-examples.js";
import { CircuitPreview } from "../src/ui/preset.js";
import "./circuit-preview-story.css";

const meta = {
  title: "Circuit/Preview",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const exampleCircuit = createExampleCircuit();
const previewExamples = [
  { title: "交流RLC回路", document: createCircuitExample("rlc") },
  { title: "LED回路", document: createCircuitExample("led") },
  { title: "トランジスタ回路", document: createCircuitExample("transistor") },
  { title: "MOSFET回路", document: createCircuitExample("mosfet") },
  { title: "オペアンプ回路", document: createCircuitExample("opamp") },
];
const longNamesDocument: CircuitDocument = {
  ...createExampleCircuit(),
  title: "長い部品名と計測カードの折り返しを確認する回路",
  parts: createExampleCircuit().parts.map((part) => ({
    ...part,
    label: part.kind === "battery"
      ? "実験用の直流安定化電源（出力電圧を調整できます）"
      : part.kind === "resistor"
        ? "電流制限と電圧降下を確認するセラミック抵抗"
        : part.kind === "bulb"
          ? "定格電力と消費電力を比べるフィラメント電球"
          : "回路を開閉する押しボタンスイッチ",
  })),
};

function PreviewCase({ title, document }: { title: string; document: CircuitDocument }) {
  return (
    <figure className="circuit-preview-story__block">
      <figcaption className="circuit-preview-story__caption">
        <strong>{title}</strong>
        <small>{document.parts.length}部品</small>
      </figcaption>
      <div className="circuit-preview-story__result">
        <CircuitPreview initialDocument={document} />
      </div>
    </figure>
  );
}

function LearningBlock({ narrow = false }: { narrow?: boolean }) {
  return (
    <main
      className={
        narrow
          ? "circuit-preview-story circuit-preview-story--width-360"
          : "circuit-preview-story"
      }
    >
      <div className="circuit-preview-story__content">
        <p className="circuit-preview-story__text">
          電池と抵抗を導線でつないだ回路です。回路図を見ながら、電気の流れを確かめましょう。
        </p>

        <figure className="circuit-preview-story__block">
          <figcaption className="circuit-preview-story__caption">
            <strong>回路</strong>
            <small>実行結果</small>
          </figcaption>
          <div className="circuit-preview-story__result">
            <CircuitPreview initialDocument={exampleCircuit} />
          </div>
        </figure>

        <p className="circuit-preview-story__text">
          スイッチを操作して回路の状態を変え、測定値の変化を見比べてみましょう。
        </p>
      </div>
    </main>
  );
}

export const Embedded: Story = {
  name: "教材ブロックへの埋め込み",
  render: () => <LearningBlock />,
};

export const Width360: Story = {
  name: "幅360px",
  render: () => <LearningBlock narrow />,
};

export const Dark: Story = {
  name: "ダークテーマ",
  globals: { theme: "dark" },
  render: () => <LearningBlock />,
};

export const DiverseParts: Story = {
  name: "多種類の部品と計測値",
  render: () => (
    <main className="circuit-preview-story">
      <div className="circuit-preview-story__content">
        <p className="circuit-preview-story__text">
          回路ごとに部品の設定値と計測値を確認できます。部品カードから詳細を開き、値を変えて結果を比べてください。
        </p>
        {previewExamples.map(({ title, document }) => <PreviewCase key={title} title={title} document={document} />)}
      </div>
    </main>
  ),
};

export const EmptyCircuit: Story = {
  name: "部品のない回路",
  render: () => (
    <main className="circuit-preview-story">
      <div className="circuit-preview-story__content">
        <p className="circuit-preview-story__text">部品がまだない場合のプレビュー表示です。</p>
        <PreviewCase title="新しい回路" document={createEmptyCircuit("新しい回路")} />
      </div>
    </main>
  ),
};

export const LongPartNames: Story = {
  name: "長い部品名",
  render: () => (
    <main className="circuit-preview-story circuit-preview-story--width-360">
      <div className="circuit-preview-story__content">
        <p className="circuit-preview-story__text">狭い幅で長い部品名や設定値が読みやすく折り返されるか確認できます。</p>
        <PreviewCase title="長い名前の回路" document={longNamesDocument} />
      </div>
    </main>
  ),
};
