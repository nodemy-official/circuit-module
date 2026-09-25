import { circuitPartCatalog, createExampleCircuit, type CircuitDocument, type CircuitPart, type CircuitPartKind, type CircuitTerminal, type CircuitWire } from "./circuit-model.js";

export const circuitExampleCatalog = {
  dc: { name: "直流の基本回路", description: "電池・抵抗・電球・スイッチを接続した回路です。" },
  ac: { name: "交流のRCフィルタ", description: "実効値と位相の違いを確認できます。コンデンサを選んで計測値を見てください。" },
  rlc: { name: "交流のRLC直列回路", description: "抵抗・コイル・コンデンサを直列に接続しています。交流電源の周波数を変えると電流と位相が変わります。" },
  charging: { name: "コンデンサの充電", description: "時間波形を計算すると、1 msの時定数で充電する様子が見えます。" },
  led: { name: "LEDと電流制限抵抗", description: "5 Vの電源に330 Ωの抵抗を入れ、LEDへ流れる電流を抑えます。" },
  rectifier: { name: "ダイオードの半波整流", description: "時間波形の負荷電圧で整流を確認できます。交流の小信号解析とは結果が異なります。" },
  transistor: { name: "NPNトランジスタ", description: "ベース電流とコレクタ電流の関係を確認する簡易回路です。" },
  mosfet: { name: "MOSFETのスイッチ", description: "ゲート電圧で負荷電流を制御します。電源値としきい値を調節して試せます。" },
  opamp: { name: "オペアンプの電圧フォロワ", description: "出力を反転入力へ戻し、非反転入力とほぼ同じ出力電圧を得ます。" },
} as const;

export type CircuitExampleKind = keyof typeof circuitExampleCatalog;

function part(id: string, kind: CircuitPartKind, x: number, y: number, patch: Partial<CircuitPart> = {}): CircuitPart {
  return { id, kind, x, y, ...circuitPartCatalog[kind].defaults, ...patch };
}

function connections(links: [string, CircuitTerminal, string, CircuitTerminal][]): CircuitWire[] {
  return links.map(([from, fromTerminal, to, toTerminal], index) => ({
    id: `wire-${index + 1}`, from: { partId: from, terminal: fromTerminal }, to: { partId: to, terminal: toTerminal },
  }));
}

function seriesExample(kind: "ac" | "rlc" | "charging" | "led" | "rectifier"): CircuitDocument {
  const ac = kind === "ac" || kind === "rlc" || kind === "rectifier";
  const loadKind = kind === "led" ? "led" : "capacitor";
  const parts = [
    part("source", ac ? "ac-source" : "battery", 8, 10, { rotation: 90, voltageVolts: 5 }),
    part("resistor", kind === "rectifier" ? "diode" : "resistor", 16, 8, kind === "rectifier" ? {} : { resistanceOhms: kind === "led" ? 330 : 1000 }),
    part("load", kind === "rectifier" ? "resistor" : loadKind, kind === "rlc" ? 32 : 24, 10, { rotation: 90, ...(kind === "rectifier" ? { resistanceOhms: 1000 } : {}) }),
    part("ground", "ground", 8, 16),
  ];
  const links: [string, CircuitTerminal, string, CircuitTerminal][] = [
    ["source", "a", "resistor", "a"], ["resistor", "b", "load", "a"],
    ["load", "b", "source", "b"], ["source", "b", "ground", "a"],
  ];
  if (kind === "rlc") {
    parts.push(part("inductor", "inductor", 24, 8));
    links[1] = ["resistor", "b", "inductor", "a"];
    links.push(["inductor", "b", "load", "a"]);
  }
  return { title: circuitExampleCatalog[kind].name, parts, wires: connections(links) };
}

function transistorExample(mos: boolean): CircuitDocument {
  const parts = [
    part("supply", "battery", 8, 10, { rotation: 90, voltageVolts: 5 }),
    part("load", "resistor", 16, 8, { resistanceOhms: 1000 }),
    part("device", mos ? "nmos" : "npn-transistor", 24, 12),
    part("bias", "resistor", 16, 12, { resistanceOhms: 100_000 }),
    part("g1", "ground", 8, 16), part("g2", "ground", 24, 18),
  ];
  return {
    title: circuitExampleCatalog[mos ? "mosfet" : "transistor"].name,
    parts,
    wires: connections([
      ["supply", "a", "load", "a"], ["load", "b", "device", "a"],
      ["supply", "a", "bias", "a"], ["bias", "b", "device", "b"],
      ["device", "c", "g2", "a"], ["supply", "b", "g1", "a"],
    ]),
  };
}

function opampExample(): CircuitDocument {
  return {
    title: circuitExampleCatalog.opamp.name,
    parts: [
      part("input", "battery", 8, 10, { rotation: 90, voltageVolts: 2 }),
      part("opamp", "op-amp", 20, 9), part("load", "resistor", 28, 11, { rotation: 90, resistanceOhms: 1000 }),
      part("g1", "ground", 8, 16), part("g2", "ground", 28, 17),
    ],
    wires: connections([
      ["input", "a", "opamp", "a"], ["input", "b", "g1", "a"],
      ["opamp", "c", "opamp", "b"], ["opamp", "c", "load", "a"], ["load", "b", "g2", "a"],
    ]),
  };
}

/** Working circuits for the preset's sample chooser and headless hosts. */
export function createCircuitExample(kind: CircuitExampleKind): CircuitDocument {
  if (kind === "dc") { return createExampleCircuit(); }
  if (kind === "transistor" || kind === "mosfet") { return transistorExample(kind === "mosfet"); }
  if (kind === "opamp") { return opampExample(); }
  return seriesExample(kind);
}
