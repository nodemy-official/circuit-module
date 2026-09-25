import { useId, useState } from "react";
import { circuitPartCatalog, type CircuitPartKind } from "../circuit-model.js";
import { CircuitIcon } from "./CircuitIcon.js";
import "./editor.css";

export interface CircuitPaletteProps {
  onAdd: (kind: CircuitPartKind) => void;
  className?: string;
}

const categories: { name: string; kinds: readonly CircuitPartKind[] }[] = [
  { name: "基本部品", kinds: ["battery", "resistor", "bulb", "switch"] },
  { name: "計測", kinds: ["ammeter", "voltmeter"] },
  { name: "配線", kinds: ["junction"] },
];

const presetLabels: Record<CircuitPartKind, string> = {
  battery: "9 V · 直流電源",
  resistor: "10 Ω",
  bulb: "20 Ω · 定格 2 W",
  switch: "回路を開閉",
  ammeter: "直列につないで計測",
  voltmeter: "並列につないで計測",
  junction: "導線を分岐",
};

/** A searchable part picker that can be placed anywhere in a host application. */
export function CircuitPalette({ onAdd, className = "" }: CircuitPaletteProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCategories = categories
    .map((category) => ({
      ...category,
      kinds: category.kinds.filter((kind) => {
        const spec = circuitPartCatalog[kind];
        return `${spec.name} ${kind}`.toLocaleLowerCase().includes(normalizedQuery);
      }),
    }))
    .filter((category) => category.kinds.length > 0);
  const resultCount = visibleCategories.reduce((count, category) => count + category.kinds.length, 0);
  const searchId = `circuit-palette-search-${id}`;

  return (
    <section className={`circuit-panel circuit-palette ${className}`} aria-label="部品パレット">
      <div className="circuit-panel__heading circuit-palette__heading">
        <h2>部品</h2>
        <p>追加する部品を選択</p>
      </div>

      <label className="circuit-palette__search" htmlFor={searchId}>
        <CircuitIcon name="search" size={16} className="circuit-palette__search-icon" />
        <input
          id={searchId}
          className="circuit-palette__search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="部品を検索"
          aria-label="部品を検索"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="circuit-palette__count" aria-live="polite">{resultCount}</span>
      </label>

      {visibleCategories.length > 0 ? (
        <div className="circuit-palette__categories">
          {visibleCategories.map((category) => (
            <section className="circuit-palette__category" key={category.name} aria-label={category.name}>
              <h3 className="circuit-palette__category-title">{category.name}</h3>
              <div className="circuit-palette__list">
                {category.kinds.map((kind) => {
                  const spec = circuitPartCatalog[kind];
                  const descriptionId = `circuit-part-description-${id}-${kind}`;
                  return (
                    <button
                      key={kind}
                      type="button"
                      className="circuit-palette__item"
                      onClick={() => onAdd(kind)}
                      aria-label={`${spec.name}を追加`}
                      aria-keyshortcuts={spec.shortcut}
                      aria-describedby={descriptionId}
                      title={`${spec.description}（${spec.shortcut}キー）`}
                    >
                      <span className="circuit-palette__icon" aria-hidden="true">
                        <CircuitPartIcon kind={kind} />
                      </span>
                      <span className="circuit-palette__text">
                        <strong>{spec.name}</strong>
                        <small id={descriptionId} className="circuit-palette__description">{presetLabels[kind]}</small>
                      </span>
                      <kbd className="circuit-palette__shortcut" aria-label={`${spec.shortcut}キー`}>{spec.shortcut}</kbd>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="circuit-palette__empty" role="status">
          <strong>部品が見つかりません</strong>
          <span>名前または英語名で検索してください。</span>
          <button type="button" onClick={() => setQuery("")}>検索をクリア</button>
        </div>
      )}
    </section>
  );
}

/** Circuit notation shown beside each part in the palette. */
export function CircuitPartIcon({ kind }: { kind: CircuitPartKind }) {
  return (
    <svg viewBox="0 0 40 28" aria-hidden="true" focusable="false">
      {kind === "battery" && <path d="M2 14h10m0-9v18m8-13v8m0-4h18" />}
      {kind === "resistor" && <path d="M2 14h6l4-7 5 14 5-14 5 14 5-7h6" />}
      {kind === "bulb" && <>
        <path d="M2 14h6m24 0h6M8 14a12 12 0 1 0 24 0 12 12 0 1 0-24 0" />
        <path d="m15.5 8 9 12m0-12-9 12" />
      </>}
      {kind === "switch" && <>
        <path d="M2 14h10m16 0h10M12 14l15-8" />
        <circle cx="12" cy="14" r="2" />
        <circle cx="28" cy="14" r="2" />
      </>}
      {kind === "ammeter" && <>
        <path d="M2 14h6m24 0h6" />
        <circle cx="20" cy="14" r="12" />
        <text x="20" y="18">A</text>
      </>}
      {kind === "voltmeter" && <>
        <path d="M2 14h6m24 0h6" />
        <circle cx="20" cy="14" r="12" />
        <text x="20" y="18">V</text>
      </>}
      {kind === "junction" && <>
        <path d="M2 14h36M20 2v24" />
        <circle cx="20" cy="14" r="2.5" className="circuit-palette__junction" />
      </>}
    </svg>
  );
}
