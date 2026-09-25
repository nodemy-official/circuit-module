import type { ReactNode } from "react";

export type CircuitIconName =
  | "cursor"
  | "hand"
  | "wire"
  | "undo"
  | "redo"
  | "rotate"
  | "trash"
  | "plus"
  | "minus"
  | "fit"
  | "grid"
  | "search"
  | "chevron"
  | "close"
  | "help"
  | "circuit"
  | "layers"
  | "sliders"
  | "check"
  | "arrowLeft"
  | "arrowRight"
  | "sample"
  | "download";

export interface CircuitIconProps {
  name: CircuitIconName;
  size?: number;
  className?: string;
}

/** A small, consistent 24 × 24 line icon set for circuit editor controls. */
export function CircuitIcon({ name, size = 18, className }: CircuitIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}

const glyphs: Record<CircuitIconName, ReactNode> = {
  cursor: <path d="M5 3.5v16l4.2-4.1 2.8 6.1 2.5-1.1-2.8-6.1H18L5 3.5Z" />,
  hand: <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0v4.1-5.1a1.5 1.5 0 0 1 3 0v5-3a1.5 1.5 0 0 1 3 0v4-1a1.5 1.5 0 0 1 3 0v4.1c0 4-2.5 6.4-6.2 6.4h-1.2c-2.1 0-3.4-.9-4.7-2.5l-3.1-3.7a1.6 1.6 0 0 1 2.2-2.3L8 13.8" />,
  wire: <>
    <path d="M3 12h6m6 0h6" />
    <circle cx="12" cy="12" r="3" />
  </>,
  undo: <>
    <path d="M9 7 4 11l5 4" />
    <path d="M5 11h8a6 6 0 0 1 6 6" />
  </>,
  redo: <>
    <path d="m15 7 5 4-5 4" />
    <path d="M19 11h-8a6 6 0 0 0-6 6" />
  </>,
  rotate: <>
    <path d="M20 7v5h-5" />
    <path d="M19 12a7.5 7.5 0 1 0 1 3" />
  </>,
  trash: <>
    <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7" />
    <path d="M10 11v5m4-5v5" />
  </>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <>
    <path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4" />
    <path d="M9 9h6v6H9z" />
  </>,
  grid: <>
    <rect x="4" y="4" width="16" height="16" rx="1.5" />
    <path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" />
  </>,
  search: <>
    <circle cx="10.8" cy="10.8" r="6.3" />
    <path d="m15.5 15.5 4.2 4.2" />
  </>,
  chevron: <path d="m8 10 4 4 4-4" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  help: <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.6 9a2.5 2.5 0 1 1 4.5 1.5c-.8 1-2.1 1.2-2.1 2.8m0 3h.01" />
  </>,
  circuit: <>
    <circle cx="5" cy="6" r="2" /><circle cx="19" cy="18" r="2" />
    <path d="M7 6h10a2 2 0 0 1 2 2v4M5 12v4a2 2 0 0 0 2 2h10M5 8v4h3l2-4 4 8 2-4h3v4" />
  </>,
  layers: <>
    <path d="m12 3 9 5-9 5-9-5 9-5Z" />
    <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
  </>,
  sliders: <>
    <path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3" />
    <circle cx="15" cy="6" r="2" />
    <circle cx="9" cy="12" r="2" />
    <circle cx="15" cy="18" r="2" />
  </>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  arrowLeft: <>
    <path d="M19 12H5m7 7-7-7 7-7" />
  </>,
  arrowRight: <>
    <path d="M5 12h14m-7-7 7 7-7 7" />
  </>,
  sample: <>
    <path d="M6 3h8l4 4v14H6z" />
    <path d="M14 3v5h5M8.5 15h2l1.5-3 2 6 1.5-3H18" />
  </>,
  download: <>
    <path d="M12 3v12m-5-5 5 5 5-5" />
    <path d="M5 17v3h14v-3" />
  </>,
};
