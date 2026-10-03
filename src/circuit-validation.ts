import { z } from "zod";
import { circuitPartKinds, type CircuitPartKind, type CircuitPartNumericField } from "./circuit-model.js";

// Simulation schemas run on descriptor snapshots so caller accessors never run.
export const simulationRecordSchema = z.object({});
export const simulationIdentifierSchema = z.string().refine((value) => value.trim().length > 0);
export const simulationPartKindSchema = z.enum(circuitPartKinds);
export const simulationTerminalSchema = z.enum(["a", "b", "c"]);
export const simulationPartShapeSchema = z.object({
  id: simulationIdentifierSchema,
  label: z.string().optional(),
  kind: simulationPartKindSchema,
});
export const simulationWireIdSchema = z.looseObject({ id: simulationIdentifierSchema });
export const simulationEndpointSchema = z.object({
  partId: z.string(),
  terminal: simulationTerminalSchema,
});
export const simulationDocumentCollectionsSchema = z.object({
  parts: z.array(z.unknown()),
  wires: z.array(z.unknown()),
});
export const simulationBooleanSchema = z.boolean();
export const simulationFiniteNumberSchema = z.number();

export const circuitAnalysisOptionsSchema = z.object({
  mode: z.enum(["auto", "dc", "ac"], { error: "解析方式は auto、dc、または ac で指定してください。" }).optional(),
  frequencyHz: z.number({ error: "解析周波数は有限な0より大きい数値にしてください。" })
    .positive({ error: "解析周波数は有限な0より大きい数値にしてください。" }).optional(),
});

export const analogAnalysisOptionsSchema = z.object({
  mode: z.enum(["dc", "ac"], { error: "解析方式は dc または ac で指定してください。" }),
  frequencyHz: z.number({ error: "交流解析の周波数は有限な0より大きい数値にしてください。" })
    .positive({ error: "交流解析の周波数は有限な0より大きい数値にしてください。" }).optional(),
  initialInductorCurrents: z.boolean({ error: "コイルの初期電流を使う設定は真偽値で指定してください。" }).optional(),
}).refine((options) => !options.initialInductorCurrents || options.mode === "dc", {
  error: "コイルの初期電流を使う設定は直流の初期状態解析でのみ真偽値として指定してください。",
});

const transientTimeError = "解析時間と時間刻みは、有限な正の数値で指定してください。";
export const transientAnalysisOptionsSchema = z.object({
  durationSeconds: z.number({ error: transientTimeError }).positive({ error: transientTimeError }),
  timeStepSeconds: z.number({ error: transientTimeError }).positive({ error: transientTimeError }),
  startFromOperatingPoint: z.boolean({ error: "直流動作点から開始する設定は真偽値で指定してください。" }).optional(),
});

/** The catalog is the shared source of numeric domains for forms and files. */
export function circuitNumericValueSchema(field: Pick<CircuitPartNumericField, "min" | "max" | "exclusiveMin"> & { integer?: boolean }) {
  let schema = z.number();
  if (field.integer) { schema = schema.refine(Number.isInteger); }
  if (field.min !== undefined) {
    schema = field.exclusiveMin ? schema.gt(field.min) : schema.gte(field.min);
  }
  if (field.max !== undefined) { schema = schema.lte(field.max); }
  return schema;
}

function numericField(field: string, expectation: string) {
  return z.number({ error: `${field}は${expectation}にしてください。` });
}

function positiveField(field: string) {
  const error = `${field}は0より大きい数値にしてください。`;
  return z.number({ error }).positive({ error });
}

function nonnegativeField(field: string) {
  const error = `${field}は0以上の数値にしてください。`;
  return z.number({ error }).nonnegative({ error });
}

const junctionShape = {
  saturationCurrentAmps: positiveField("飽和電流"),
  emissionCoefficient: positiveField("理想係数"),
};
const transistorSchema = z.object({
  currentGain: positiveField("電流増幅率"),
  saturationCurrentAmps: positiveField("飽和電流"),
});
const mosSchema = z.object({
  thresholdVolts: nonnegativeField("しきい値"),
  transconductanceAmpsPerVoltSquared: positiveField("相互コンダクタンス係数"),
  channelLengthModulation: nonnegativeField("チャネル長変調係数"),
});

export const simulationPartValueSchemas: Partial<Record<CircuitPartKind, z.ZodType>> = {
  battery: z.object({ voltageVolts: positiveField("電圧"), internalResistanceOhms: nonnegativeField("内部抵抗") }),
  switch: z.object({ initiallyClosed: z.boolean({ error: "初期状態は真偽値にしてください。" }).optional() }),
  "ac-source": z.object({
    voltageVolts: nonnegativeField("実効電圧"),
    frequencyHz: positiveField("周波数"),
    phaseDegrees: numericField("位相", "有限の数値"),
    offsetVolts: numericField("直流オフセット", "有限の数値"),
  }),
  resistor: z.object({ resistanceOhms: positiveField("抵抗値") }),
  bulb: z.object({ resistanceOhms: positiveField("抵抗値"), ratedPowerWatts: positiveField("定格電力").optional() }),
  capacitor: z.object({ capacitanceFarads: positiveField("静電容量") }),
  inductor: z.object({ inductanceHenries: positiveField("インダクタンス") }),
  "current-source": z.object({ currentAmps: numericField("電流", "有限の数値") }),
  potentiometer: z.object({
    resistanceOhms: positiveField("抵抗値"),
    wiperPosition: numericField("摺動位置", "0から1の数値")
      .min(0, { error: "摺動位置は0から1の数値にしてください。" })
      .max(1, { error: "摺動位置は0から1の数値にしてください。" }),
  }),
  diode: z.object(junctionShape),
  led: z.object({ ...junctionShape, ratedCurrentAmps: positiveField("定格電流") }),
  "npn-transistor": transistorSchema,
  "pnp-transistor": transistorSchema,
  nmos: mosSchema,
  pmos: mosSchema,
  "op-amp": z.object({
    openLoopGain: positiveField("開ループ利得"),
    positiveRailVolts: numericField("電源レール", "有限の数値"),
    negativeRailVolts: numericField("電源レール", "有限の数値"),
  }).refine((part) => part.negativeRailVolts < part.positiveRailVolts, {
    error: "電源レールは負側が正側より小さい値にしてください。",
  }),
};

export const legacySwitchValueSchema = z.object({
  initiallyClosed: z.boolean({ error: "スイッチ状態は真偽値にしてください。" }).optional(),
});
