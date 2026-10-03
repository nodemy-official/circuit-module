import { useEffect, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent } from "react";
import { circuitNumericValueSchema } from "../circuit-validation.js";

interface NumericInputOptions {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  integer?: boolean;
}

/** Keep incomplete native number input text without putting invalid values into the model. */
export function useNumericDraft({ value, onValueChange, min, max, exclusiveMin, integer }: NumericInputOptions) {
  const [text, setText] = useState(String(value));
  const emittedValue = useRef(value);
  useEffect(() => {
    if (!Object.is(emittedValue.current, value)) {
      emittedValue.current = value;
      setText(String(value));
    }
  }, [value]);

  const change = (nextText: string) => {
    setText(nextText);
    const next = nextText.trim() === "" ? Number.NaN : Number(nextText);
    const parsed = circuitNumericValueSchema({ min, max, exclusiveMin, integer }).safeParse(next);
    if (!parsed.success) { return; }
    emittedValue.current = parsed.data;
    if (!Object.is(parsed.data, value)) { onValueChange(parsed.data); }
  };
  const restore = () => {
    emittedValue.current = value;
    setText(String(value));
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter") { event.currentTarget.blur(); }
    if (event.key === "Escape") { restore(); }
  };
  return { text, change, restore, keyDown };
}

type NumericInputProps = Omit<ComponentPropsWithoutRef<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"> & NumericInputOptions;

export function NumericInput({
  value, onValueChange, min, max, exclusiveMin, integer, onBlur, onKeyDown, ...props
}: NumericInputProps) {
  const draft = useNumericDraft({ value, onValueChange, min, max, exclusiveMin, integer });
  return <input {...props} type="number" min={min} max={max} value={draft.text}
    onChange={(event) => draft.change(event.currentTarget.value)}
    onBlur={(event) => { draft.restore(); onBlur?.(event); }}
    onKeyDown={(event) => { draft.keyDown(event); onKeyDown?.(event); }}
  />;
}
