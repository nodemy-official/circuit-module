import type { CircuitPartKind } from "../circuit-model.js";

export function measurementLabels(kind: CircuitPartKind) {
  switch (kind) {
    case "npn-transistor":
    case "pnp-transistor": return { voltage: "電圧（C−E）", current: "電流（Cへ流入）" };
    case "nmos":
    case "pmos": return { voltage: "電圧（D−S）", current: "電流（Dへ流入）" };
    case "op-amp": return { voltage: "出力電圧（対GND）", current: "電流（出力へ流入）" };
    case "potentiometer": return { voltage: "電圧（A−B）", current: "電流（Aへ流入）" };
    default: return { voltage: "電圧（A−B）", current: "電流（A→B）" };
  }
}
