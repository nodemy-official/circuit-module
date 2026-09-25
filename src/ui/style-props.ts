import type { CSSProperties } from "react";

export type CircuitCSSProperties = CSSProperties & {
  [property: `--${string}`]: string | number | undefined;
};

/** Appearance overrides for an internal UI element. No styles are installed automatically. */
export interface CircuitStyleProps {
  className?: string;
  style?: CSSProperties | CircuitCSSProperties;
}

/** Retain stable CSS hooks while giving the host precedence over default inline values. */
export function circuitSlot(
  defaultClassName: string | undefined,
  props?: CircuitStyleProps,
  defaultStyle?: CSSProperties | CircuitCSSProperties,
): CircuitStyleProps {
  return {
    className: [defaultClassName, props?.className].filter(Boolean).join(" ") || undefined,
    style: defaultStyle || props?.style ? { ...defaultStyle, ...props?.style } : undefined,
  };
}
