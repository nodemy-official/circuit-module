import { useId, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { circuitPartCatalog, type CircuitPartKind } from "../circuit-model.js";
import { circuitSlot, type CircuitStyleProps } from "./style-props.js";
import { CircuitIcon } from "./CircuitIcon.js";

export type CircuitPaletteSlot =
  | "root"
  | "heading"
  | "headingTitle"
  | "headingDescription"
  | "search"
  | "searchIcon"
  | "searchInput"
  | "resultCount"
  | "categories"
  | "category"
  | "categoryTitle"
  | "partList"
  | "partItem"
  | "partIcon"
  | "partText"
  | "partName"
  | "partDescription"
  | "partShortcut"
  | "emptyState"
  | "emptyTitle"
  | "emptyDescription"
  | "clearSearchButton";

export interface CircuitPaletteProps extends Omit<ComponentPropsWithoutRef<"section">, "children" | "style"> {
  onAdd: (kind: CircuitPartKind) => void;
  style?: CircuitStyleProps["style"];
  slotProps?: Partial<Record<CircuitPaletteSlot, CircuitStyleProps>>;
}

const categories: { name: string; kinds: readonly CircuitPartKind[] }[] = [
  { name: "基本部品", kinds: ["battery", "resistor", "bulb", "switch"] },
  { name: "交流・独立電源", kinds: ["ac-source", "current-source"] },
  { name: "受動部品", kinds: ["capacitor", "inductor", "potentiometer"] },
  { name: "半導体", kinds: ["diode", "led", "npn-transistor", "pnp-transistor", "nmos", "pmos", "op-amp"] },
  { name: "計測", kinds: ["ammeter", "voltmeter"] },
  { name: "配線・接地", kinds: ["ground", "junction"] },
];

const presetLabels: Record<CircuitPartKind, string> = {
  battery: "9 V · 直流電源",
  "ac-source": "5 V RMS · 1 kHz",
  "current-source": "10 mA",
  resistor: "10 Ω",
  bulb: "20 Ω · 定格 2 W",
  switch: "回路を開閉",
  capacitor: "1 μF",
  inductor: "10 mH",
  potentiometer: "1 kΩ · 可変",
  diode: "シリコンダイオード",
  led: "順方向 20 mA",
  "npn-transistor": "NPN · β=100",
  "pnp-transistor": "PNP · β=100",
  nmos: "Nチャネル MOSFET",
  pmos: "Pチャネル MOSFET",
  "op-amp": "簡易オペアンプ",
  ammeter: "直列につないで計測",
  voltmeter: "並列につないで計測",
  ground: "基準電位 0 V",
  junction: "導線を分岐",
};

const searchTerms: Partial<Record<CircuitPartKind, string>> = {
  battery: "電池 直流 dc cell",
  "ac-source": "交流 電圧源 AC voltage source sine 正弦波",
  "current-source": "電流源 current source",
  resistor: "抵抗 resistance R",
  bulb: "電球 lamp",
  switch: "スイッチ 開閉",
  capacitor: "コンデンサ condenser C",
  inductor: "コイル inductance L",
  potentiometer: "可変抵抗 ポテンショメータ variable resistor pot",
  diode: "ダイオード rectifier",
  led: "発光ダイオード light emitting diode",
  "npn-transistor": "NPN トランジスタ bipolar transistor BJT",
  "pnp-transistor": "PNP トランジスタ bipolar transistor BJT",
  nmos: "NMOS MOSFET n-channel",
  pmos: "PMOS MOSFET p-channel",
  "op-amp": "オペアンプ operational amplifier",
  ammeter: "電流計 ammeter",
  voltmeter: "電圧計 voltmeter",
  ground: "GND ground 接地 グラウンド",
  junction: "接続点 分岐 junction node",
};

/** A searchable part picker that can be placed anywhere in a host application. */
export function CircuitPalette({
  onAdd,
  className,
  style,
  slotProps,
  "aria-label": ariaLabel,
  ...sectionProps
}: CircuitPaletteProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCategories = categories
    .map((category) => ({
      ...category,
      kinds: category.kinds.filter((kind) => {
        const spec = circuitPartCatalog[kind];
        return `${spec.name} ${kind} ${spec.description} ${searchTerms[kind] ?? ""}`.toLocaleLowerCase().includes(normalizedQuery);
      }),
    }))
    .filter((category) => category.kinds.length > 0);
  const resultCount = visibleCategories.reduce((count, category) => count + category.kinds.length, 0);
  const searchId = `circuit-palette-search-${id}`;
  const rootProps = circuitSlot("circuit-panel circuit-palette", {
    className: [className, slotProps?.root?.className].filter(Boolean).join(" "),
    style: style || slotProps?.root?.style ? { ...style, ...slotProps?.root?.style } : undefined,
  });

  return (
    <section {...sectionProps} {...rootProps} aria-label={ariaLabel ?? "部品パレット"}>
      <div {...circuitSlot("circuit-panel__heading circuit-palette__heading", slotProps?.heading)}>
        <h2 {...circuitSlot(undefined, slotProps?.headingTitle)}>部品</h2>
        <p {...circuitSlot(undefined, slotProps?.headingDescription)}>追加する部品を選択</p>
      </div>

      <label {...circuitSlot("circuit-palette__search", slotProps?.search)} htmlFor={searchId}>
        <CircuitIcon name="search" size={16} {...circuitSlot("circuit-palette__search-icon", slotProps?.searchIcon)} />
        <input
          {...circuitSlot("circuit-palette__search-input", slotProps?.searchInput)}
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="部品を検索"
          aria-label="部品を検索"
          autoComplete="off"
          spellCheck={false}
        />
        <span {...circuitSlot("circuit-palette__count", slotProps?.resultCount)} aria-live="polite">{resultCount}</span>
      </label>

      {visibleCategories.length > 0 ? (
        <div {...circuitSlot("circuit-palette__categories", slotProps?.categories)}>
          {visibleCategories.map((category) => (
            <section
              {...circuitSlot("circuit-palette__category", slotProps?.category)}
              key={category.name}
              aria-label={category.name}
              data-category={category.name}
            >
              <h3 {...circuitSlot("circuit-palette__category-title", slotProps?.categoryTitle)}>{category.name}</h3>
              <div {...circuitSlot("circuit-palette__list", slotProps?.partList)}>
                {category.kinds.map((kind) => {
                  const spec = circuitPartCatalog[kind];
                  const descriptionId = `circuit-part-description-${id}-${kind}`;
                  return (
                    <button
                      {...circuitSlot("circuit-palette__item", slotProps?.partItem)}
                      key={kind}
                      type="button"
                      onClick={() => onAdd(kind)}
                      aria-label={`${spec.name}を追加`}
                      aria-keyshortcuts={spec.shortcut || undefined}
                      aria-describedby={descriptionId}
                      title={spec.shortcut ? `${spec.description}（${spec.shortcut}キー）` : spec.description}
                      data-kind={kind}
                    >
                      <span {...circuitSlot("circuit-palette__icon", slotProps?.partIcon)} aria-hidden="true">
                        <CircuitPartIcon kind={kind} />
                      </span>
                      <span {...circuitSlot("circuit-palette__text", slotProps?.partText)}>
                        <strong {...circuitSlot(undefined, slotProps?.partName)}>{spec.name}</strong>
                        <small {...circuitSlot("circuit-palette__description", slotProps?.partDescription)} id={descriptionId}>{presetLabels[kind]}</small>
                      </span>
                      {spec.shortcut && <kbd {...circuitSlot("circuit-palette__shortcut", slotProps?.partShortcut)} aria-label={`${spec.shortcut}キー`}>{spec.shortcut}</kbd>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div {...circuitSlot("circuit-palette__empty", slotProps?.emptyState)} role="status">
          <strong {...circuitSlot(undefined, slotProps?.emptyTitle)}>部品が見つかりません</strong>
          <span {...circuitSlot(undefined, slotProps?.emptyDescription)}>名前または英語名で検索してください。</span>
          <button {...circuitSlot(undefined, slotProps?.clearSearchButton)} type="button" onClick={() => setQuery("")}>検索をクリア</button>
        </div>
      )}
    </section>
  );
}

export interface CircuitPartIconProps extends Omit<ComponentPropsWithoutRef<"svg">, "children" | "style"> {
  kind: CircuitPartKind;
  style?: CircuitStyleProps["style"];
}

/** Circuit notation shown beside each part in the palette. */
const partIconArtwork: Record<CircuitPartKind, ReactNode> = {
  battery: <path d="M2 14h10m0-9v18m8-13v8m0-4h18" />,
  "ac-source": <><path d="M2 14h6m24 0h6" /><circle cx="20" cy="14" r="12" /><path d="M14 14c2-5 4-5 6 0s4 5 6 0" /></>,
  "current-source": <><path d="M2 14h6m24 0h6" /><circle cx="20" cy="14" r="12" /><path d="M12 14h16m-5-5 5 5-5 5" /></>,
  resistor: <path d="M2 14h6l4-7 5 14 5-14 5 14 5-7h6" />,
  bulb: <><path d="M2 14h6m24 0h6M8 14a12 12 0 1 0 24 0 12 12 0 1 0-24 0" /><path d="m15.5 8 9 12m0-12-9 12" /></>,
  switch: <><path d="M2 14h10m16 0h10M12 14l15-8" /><circle cx="12" cy="14" r="2" /><circle cx="28" cy="14" r="2" /></>,
  capacitor: <path d="M2 14h14m0-9v18m6-18v18m0-9h14" />,
  inductor: <path d="M2 14h5c0-8 6-8 6 0s6 8 6 0 6-8 6 0 6 8 6 0h2" />,
  potentiometer: <><path d="M2 14h5l3-5 4 10 4-10 4 10 3-5h5m-9-11 2 5 5 2" /><path d="m23 3 1 5 5-1" /></>,
  diode: <path d="M2 14h9M11 5v18m0-18 15 9-15 9m17-18v18m0-9h10" />,
  led: <><path d="M2 14h9M11 5v18m0-18 15 9-15 9m17-18v18m0-9h10" /><path d="m20 5 5-4m-1 5 5-4m-6-4 2 0-1 2m4-2 2 0-1 2" /></>,
  "npn-transistor": <><circle cx="20" cy="14" r="10" /><path d="M20 4v6m0 8v6M10 14h7m3-2 6-6m-6 10 6 6m-6-3 4 4m-5-1 5 1-1-5" /></>,
  "pnp-transistor": <><circle cx="20" cy="14" r="10" /><path d="M20 4v6m0 8v6M10 14h7m3-2 6-6m-6 10 6 6m3-13-4-4m5 1-5-1 1 5" /></>,
  nmos: <><path d="M20 2v7m0 10v7M7 14h5m3-9v18m7-13h5m-5 8h5m-3-4 6 2-6 2" /></>,
  pmos: <><path d="M20 2v7m0 10v7M7 14h5m3-9v18m7-13h5m-5 8h5m-5-10-6 2 6 2" /></>,
  "op-amp": <><path d="M11 3v22l20-11zM2 9h9m-9 10h9m20-5h7" /><path d="M13 9h4m-2-2v4m-2 8h4" /></>,
  ammeter: <><path d="M2 14h6m24 0h6" /><circle cx="20" cy="14" r="12" /><text x="20" y="18">A</text></>,
  voltmeter: <><path d="M2 14h6m24 0h6" /><circle cx="20" cy="14" r="12" /><text x="20" y="18">V</text></>,
  junction: <><path d="M2 14h36M20 2v24" /><circle cx="20" cy="14" r="2.5" className="circuit-palette__junction" /></>,
  ground: <path d="M20 2v12m-12 0h24m-19 5h14m-10 5h6" />,
};

export function CircuitPartIcon({ kind, ...svgProps }: CircuitPartIconProps) {
  return <svg viewBox="0 0 40 28" aria-hidden="true" focusable="false" {...svgProps}>{partIconArtwork[kind]}</svg>;
}
