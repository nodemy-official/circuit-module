import { useEffect, useLayoutEffect } from "react";

/** Keep browser updates before paint without scheduling layout work during SSR. */
export const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
