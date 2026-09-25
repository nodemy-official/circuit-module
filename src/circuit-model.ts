export type CircuitPartKind =
  | "battery"
  | "resistor"
  | "bulb"
  | "switch"
  | "ammeter"
  | "voltmeter"
  | "junction";
export type CircuitTerminal = "a" | "b";
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
}

export interface CircuitEndpoint {
  partId: string;
  terminal: CircuitTerminal;
}

export interface CircuitWire {
  id: string;
  from: CircuitEndpoint;
  to: CircuitEndpoint;
}

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
  /** Single key that adds the part while the board is focused. */
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
};

export const circuitPartKinds = Object.keys(circuitPartCatalog) as CircuitPartKind[];

/** Default values for new parts, kept for hosts that build documents themselves. */
export const circuitPartDefaults = Object.fromEntries(
  circuitPartKinds.map((kind) => [kind, circuitPartCatalog[kind].defaults]),
) as Record<CircuitPartKind, CircuitPartSpec["defaults"]>;

export function terminalsOf(kind: CircuitPartKind) {
  return circuitPartCatalog[kind].terminals;
}

const polarized = new Set<CircuitPartKind>(["battery", "ammeter", "voltmeter"]);

/** Human-readable terminal name: polarity for sources and meters, A/B otherwise. */
export function terminalName(part: Pick<CircuitPart, "kind">, terminal: CircuitTerminal) {
  if (part.kind === "junction") return "接続点";
  if (polarized.has(part.kind)) return terminal === "a" ? "＋端子" : "−端子";
  return terminal === "a" ? "端子A" : "端子B";
}

/** "電池の＋端子", or just the label for a junction, which has a single terminal. */
export function endpointName(part: Pick<CircuitPart, "kind" | "label">, terminal: CircuitTerminal) {
  return part.kind === "junction" ? part.label : `${part.label}の${terminalName(part, terminal)}`;
}

export function sameEndpoint(first: CircuitEndpoint, second: CircuitEndpoint) {
  return first.partId === second.partId && first.terminal === second.terminal;
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
