export type CircuitPartKind =
  | "battery"
  | "resistor"
  | "bulb"
  | "switch"
  | "ammeter"
  | "voltmeter"
  | "junction"
  | "ac-source"
  | "capacitor"
  | "inductor"
  | "ground"
  | "current-source"
  | "potentiometer"
  | "diode"
  | "led"
  | "npn-transistor"
  | "pnp-transistor"
  | "nmos"
  | "pmos"
  | "op-amp";
export type CircuitTerminal = "a" | "b" | "c";
/** Clockwise rotation in degrees. Terminal A points left at 0°. */
export type CircuitRotation = 0 | 90 | 180 | 270;

export interface CircuitPart {
  id: string;
  kind: CircuitPartKind;
  /** Grid column of the part centre. One grid step is one ruled cell on the board. */
  x: number;
  /** Grid row of the part centre. */
  y: number;
  label: string;
  rotation?: CircuitRotation;
  voltageVolts?: number;
  /** Internal resistance of a battery. Omitted or 0 means an ideal source. */
  internalResistanceOhms?: number;
  resistanceOhms?: number;
  /** Power at which a bulb shines at full brightness. */
  ratedPowerWatts?: number;
  initiallyClosed?: boolean;
  /** AC source RMS amplitude uses voltageVolts; time signal is offset + √2 V cos(2πft + phase). */
  frequencyHz?: number;
  phaseDegrees?: number;
  offsetVolts?: number;
  capacitanceFarads?: number;
  inductanceHenries?: number;
  initialVoltageVolts?: number;
  initialCurrentAmps?: number;
  /** Independent current source: positive current flows from A to B. */
  currentAmps?: number;
  /** Fraction of total resistance between terminal A and wiper C, from 0 to 1. */
  wiperPosition?: number;
  saturationCurrentAmps?: number;
  emissionCoefficient?: number;
  ratedCurrentAmps?: number;
  currentGain?: number;
  /** Positive threshold magnitude, including for a PMOS. */
  thresholdVolts?: number;
  transconductanceAmpsPerVoltSquared?: number;
  channelLengthModulation?: number;
  openLoopGain?: number;
  /** Simplified op-amp supply limits, relative to GND. */
  positiveRailVolts?: number;
  negativeRailVolts?: number;
}

export interface CircuitEndpoint {
  partId: string;
  terminal: CircuitTerminal;
}

export interface CircuitWire {
  id: string;
  from: CircuitEndpoint;
  to: CircuitEndpoint;
  /** Optional intermediate route points in grid cells; endpoints are derived from their parts. */
  waypoints?: { x: number; y: number }[];
}

/** Maximum number of manually stored route points on one wire. */
export const MAX_CIRCUIT_WIRE_WAYPOINTS = 10_000;

export interface CircuitDocument {
  title: string;
  parts: CircuitPart[];
  wires: CircuitWire[];
}

export interface CircuitPartSpec {
  /** Name used in menus and announcements. */
  name: string;
  /** Short description shown in the palette tooltip. */
  description: string;
  /** Single key that adds the part while the board is focused, or empty for no shortcut. */
  shortcut: string;
  terminals: readonly CircuitTerminal[];
  defaults: Pick<CircuitPart, "label"> & Partial<CircuitPart>;
}

export const circuitPartCatalog: Record<CircuitPartKind, CircuitPartSpec> = {
  battery: {
    name: "電池",
    description: "直流の電源。長い極板が＋極です。",
    shortcut: "1",
    terminals: ["a", "b"],
    defaults: { label: "電池", voltageVolts: 9, internalResistanceOhms: 0 },
  },
  resistor: {
    name: "抵抗",
    description: "電流の流れにくさを表す部品。",
    shortcut: "2",
    terminals: ["a", "b"],
    defaults: { label: "抵抗", resistanceOhms: 10 },
  },
  bulb: {
    name: "電球",
    description: "消費電力に応じて明るく光ります。",
    shortcut: "3",
    terminals: ["a", "b"],
    defaults: { label: "電球", resistanceOhms: 20, ratedPowerWatts: 2 },
  },
  switch: {
    name: "スイッチ",
    description: "回路を開閉します。",
    shortcut: "4",
    terminals: ["a", "b"],
    defaults: { label: "スイッチ", initiallyClosed: true },
  },
  ammeter: {
    name: "電流計",
    description: "直列につないで電流を測ります。",
    shortcut: "5",
    terminals: ["a", "b"],
    defaults: { label: "電流計" },
  },
  voltmeter: {
    name: "電圧計",
    description: "並列につないで電圧を測ります。",
    shortcut: "6",
    terminals: ["a", "b"],
    defaults: { label: "電圧計" },
  },
  junction: {
    name: "接続点",
    description: "導線を枝分かれさせる点。",
    shortcut: "7",
    terminals: ["a"],
    defaults: { label: "接続点" },
  },
  "ac-source": {
    name: "交流電源",
    description: "正弦波の電圧源。実効値・周波数・位相を設定できます。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "交流電源", voltageVolts: 5, frequencyHz: 1000, phaseDegrees: 0, offsetVolts: 0 },
  },
  capacitor: {
    name: "コンデンサ",
    description: "電荷を蓄えます。直流の定常状態では電流を通しません。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "コンデンサ", capacitanceFarads: 1e-6, initialVoltageVolts: 0 },
  },
  inductor: {
    name: "コイル",
    description: "インダクタ。電流の変化を妨げ、磁界にエネルギーを蓄えます。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "コイル", inductanceHenries: 0.01, initialCurrentAmps: 0 },
  },
  ground: {
    name: "GND",
    description: "電位の基準（0 V）。すべてのGNDは電気的につながります。",
    shortcut: "",
    terminals: ["a"],
    defaults: { label: "GND" },
  },
  "current-source": {
    name: "電流源",
    description: "AからBへ一定の直流電流を流します。負の値で向きを反転します。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "電流源", currentAmps: 0.01 },
  },
  potentiometer: {
    name: "可変抵抗",
    description: "3端子のポテンショメータ。摺動端子Cの位置を調節します。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "可変抵抗", resistanceOhms: 1000, wiperPosition: 0.5 },
  },
  diode: {
    name: "ダイオード",
    description: "アノードからカソードへ電流を流す、簡易Shockleyモデル。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "ダイオード", saturationCurrentAmps: 1e-12, emissionCoefficient: 1 },
  },
  led: {
    name: "LED",
    description: "発光ダイオード。順方向の電流に応じて光ります。",
    shortcut: "",
    terminals: ["a", "b"],
    defaults: { label: "LED", saturationCurrentAmps: 1e-20, emissionCoefficient: 2, ratedCurrentAmps: 0.02 },
  },
  "npn-transistor": {
    name: "NPNトランジスタ",
    description: "端子はC・B・E。簡易BJTモデルで増幅とスイッチ動作を確認できます。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "NPN", currentGain: 100, saturationCurrentAmps: 1e-14 },
  },
  "pnp-transistor": {
    name: "PNPトランジスタ",
    description: "端子はC・B・E。NPNと極性が反対の簡易BJTモデル。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "PNP", currentGain: 100, saturationCurrentAmps: 1e-14 },
  },
  nmos: {
    name: "NチャネルMOSFET",
    description: "端子はD・G・S。簡易二乗則モデル。ボディダイオードと寄生容量は省略しています。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "NMOS", thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 0.02, channelLengthModulation: 0.01 },
  },
  pmos: {
    name: "PチャネルMOSFET",
    description: "端子はD・G・S。しきい値は絶対値で設定。ボディダイオードと寄生容量は省略しています。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "PMOS", thresholdVolts: 2, transconductanceAmpsPerVoltSquared: 0.02, channelLengthModulation: 0.01 },
  },
  "op-amp": {
    name: "オペアンプ",
    description: "入力＋・入力−・出力の簡易3端子モデル。電源電圧はプロパティで指定します。",
    shortcut: "",
    terminals: ["a", "b", "c"],
    defaults: { label: "オペアンプ", openLoopGain: 100_000, positiveRailVolts: 15, negativeRailVolts: -15 },
  },
};

export const circuitPartKinds = Object.keys(circuitPartCatalog) as CircuitPartKind[];

/** Default values for new parts, kept for hosts that build documents themselves. */
export const circuitPartDefaults = Object.fromEntries(
  circuitPartKinds.map((kind) => [kind, circuitPartCatalog[kind].defaults]),
) as Record<CircuitPartKind, CircuitPartSpec["defaults"]>;

export type CircuitPartNumericKey = Exclude<{
  [Key in keyof CircuitPart]-?: NonNullable<CircuitPart[Key]> extends number ? Key : never;
}[keyof CircuitPart], "x" | "y" | "rotation">;

export interface CircuitPartNumericField {
  key: CircuitPartNumericKey;
  label: string;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  exclusiveMin?: boolean;
}

const numericField = (
  key: CircuitPartNumericKey,
  label: string,
  unit: string,
  min?: number,
  exclusiveMin?: boolean,
  max?: number,
): CircuitPartNumericField => ({ key, label, unit, min, exclusiveMin, max });

const numericFields: Record<CircuitPartNumericKey, CircuitPartNumericField> = {
  voltageVolts: numericField("voltageVolts", "電圧", "V", 0),
  internalResistanceOhms: numericField("internalResistanceOhms", "内部抵抗", "Ω", 0),
  resistanceOhms: numericField("resistanceOhms", "抵抗値", "Ω", 0, true),
  ratedPowerWatts: numericField("ratedPowerWatts", "定格電力", "W", 0, true),
  frequencyHz: numericField("frequencyHz", "周波数", "Hz", 0, true),
  phaseDegrees: numericField("phaseDegrees", "位相", "°"),
  offsetVolts: numericField("offsetVolts", "直流オフセット", "V"),
  capacitanceFarads: numericField("capacitanceFarads", "静電容量", "F", 0, true),
  inductanceHenries: numericField("inductanceHenries", "インダクタンス", "H", 0, true),
  initialVoltageVolts: numericField("initialVoltageVolts", "初期電圧（過渡）", "V"),
  initialCurrentAmps: numericField("initialCurrentAmps", "初期電流（過渡）", "A"),
  currentAmps: numericField("currentAmps", "電流 A → B", "A"),
  wiperPosition: numericField("wiperPosition", "摺動位置 A → B", "", 0, false, 1),
  saturationCurrentAmps: numericField("saturationCurrentAmps", "飽和電流 Is", "A", 0, true),
  emissionCoefficient: numericField("emissionCoefficient", "理想係数 n", "", 0, true),
  ratedCurrentAmps: numericField("ratedCurrentAmps", "定格電流", "A", 0, true),
  currentGain: numericField("currentGain", "直流電流増幅率 β", "", 0, true),
  thresholdVolts: numericField("thresholdVolts", "しきい値の絶対値", "V", 0),
  transconductanceAmpsPerVoltSquared: numericField("transconductanceAmpsPerVoltSquared", "伝導係数 k", "A/V²", 0, true),
  channelLengthModulation: numericField("channelLengthModulation", "チャネル長変調 λ", "1/V", 0),
  openLoopGain: numericField("openLoopGain", "開ループ利得", "", 0, true),
  positiveRailVolts: numericField("positiveRailVolts", "正側電源（GND基準）", "V"),
  negativeRailVolts: numericField("negativeRailVolts", "負側電源（GND基準）", "V"),
};

const partNumericKeys: Partial<Record<CircuitPartKind, readonly CircuitPartNumericKey[]>> = {
  battery: ["voltageVolts", "internalResistanceOhms"],
  resistor: ["resistanceOhms"],
  bulb: ["resistanceOhms", "ratedPowerWatts"],
  "ac-source": ["voltageVolts", "frequencyHz", "phaseDegrees", "offsetVolts"],
  capacitor: ["capacitanceFarads", "initialVoltageVolts"],
  inductor: ["inductanceHenries", "initialCurrentAmps"],
  "current-source": ["currentAmps"],
  potentiometer: ["resistanceOhms", "wiperPosition"],
  diode: ["saturationCurrentAmps", "emissionCoefficient"],
  led: ["saturationCurrentAmps", "emissionCoefficient", "ratedCurrentAmps"],
  "npn-transistor": ["currentGain", "saturationCurrentAmps"],
  "pnp-transistor": ["currentGain", "saturationCurrentAmps"],
  nmos: ["thresholdVolts", "transconductanceAmpsPerVoltSquared", "channelLengthModulation"],
  pmos: ["thresholdVolts", "transconductanceAmpsPerVoltSquared", "channelLengthModulation"],
  "op-amp": ["openLoopGain", "positiveRailVolts", "negativeRailVolts"],
};

/** Editable quantities and their domains, shared by forms and file validation. */
export function circuitPartNumericFields(kind: CircuitPartKind): readonly CircuitPartNumericField[] {
  return (partNumericKeys[kind] ?? []).map((key) => {
    const field = numericFields[key];
    if (key !== "voltageVolts") { return field; }
    return kind === "ac-source"
      ? { ...field, label: "電圧（実効値）" }
      : { ...field, exclusiveMin: true };
  });
}

export function terminalsOf(kind: CircuitPartKind) {
  return circuitPartCatalog[kind].terminals;
}

const polarized = new Set<CircuitPartKind>(["battery", "ac-source", "ammeter", "voltmeter"]);

const namedTerminals: Partial<Record<CircuitPartKind, Partial<Record<CircuitTerminal, string>>>> = {
  ground: { a: "GND端子" },
  potentiometer: { a: "端子A", b: "端子B", c: "摺動端子C" },
  diode: { a: "アノード", b: "カソード" },
  led: { a: "アノード", b: "カソード" },
  "npn-transistor": { a: "コレクタC", b: "ベースB", c: "エミッタE" },
  "pnp-transistor": { a: "コレクタC", b: "ベースB", c: "エミッタE" },
  nmos: { a: "ドレインD", b: "ゲートG", c: "ソースS" },
  pmos: { a: "ドレインD", b: "ゲートG", c: "ソースS" },
  "op-amp": { a: "非反転入力＋", b: "反転入力−", c: "出力" },
};

/** Human-readable terminal name: polarity for sources and meters, A/B otherwise. */
export function terminalName(part: Pick<CircuitPart, "kind">, terminal: CircuitTerminal) {
  if (part.kind === "junction") { return "接続点"; }
  const named = namedTerminals[part.kind]?.[terminal];
  if (named) { return named; }
  if (polarized.has(part.kind)) { return terminal === "a" ? "＋端子" : "−端子"; }
  return `端子${terminal.toUpperCase()}`;
}

/** "電池の＋端子", or just the label for a junction, which has a single terminal. */
export function endpointName(part: Pick<CircuitPart, "kind" | "label">, terminal: CircuitTerminal) {
  return part.kind === "junction" ? part.label : `${part.label}の${terminalName(part, terminal)}`;
}

export function sameEndpoint(first: CircuitEndpoint, second: CircuitEndpoint) {
  return first.partId === second.partId && first.terminal === second.terminal;
}

export function createEmptyCircuit(title = "新しい回路"): CircuitDocument {
  return { title, parts: [], wires: [] };
}

export function createExampleCircuit(): CircuitDocument {
  const part = (id: string, kind: CircuitPartKind, x: number, y: number): CircuitPart => ({
    id,
    kind,
    x,
    y,
    ...circuitPartCatalog[kind].defaults,
  });
  return {
    title: "直流回路",
    parts: [
      part("part-1", "battery", 8, 5),
      part("part-2", "resistor", 20, 5),
      part("part-3", "bulb", 20, 13),
      part("part-4", "switch", 8, 13),
    ],
    wires: [
      {
        id: "wire-1",
        from: { partId: "part-1", terminal: "b" },
        to: { partId: "part-2", terminal: "a" },
      },
      {
        id: "wire-2",
        from: { partId: "part-2", terminal: "b" },
        to: { partId: "part-3", terminal: "b" },
      },
      {
        id: "wire-3",
        from: { partId: "part-3", terminal: "a" },
        to: { partId: "part-4", terminal: "b" },
      },
      {
        id: "wire-4",
        from: { partId: "part-4", terminal: "a" },
        to: { partId: "part-1", terminal: "a" },
      },
    ],
  };
}
