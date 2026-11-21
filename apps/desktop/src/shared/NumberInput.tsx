import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";

/**
 * Campo numérico que deja borrar el número para escribir otro.
 *
 * Un `<input type="number" value={n}>` que convierte cada pulsación con
 * `Number(...) || 1` vuelve a poner el número en cuanto queda vacío: en móvil
 * no se puede borrar el "1" para escribir "2,5". Aquí lo escrito vive en un
 * borrador de texto; solo se avisa al modelo cuando el borrador es un número
 * válido, y al salir del campo un borrador vacío o inválido vuelve al último
 * valor bueno (o al recortado al rango).
 */
export type NumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange" | "type" | "min" | "max"
> & {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** Redondea a entero (contadores, compases, canales...). */
  integer?: boolean;
  /** Cómo se pinta el valor del modelo en el campo; por defecto `String`. */
  format?: (value: number) => string;
};

export function parseNumberDraft(draft: string): number | null {
  const normalized = draft.trim().replace(",", ".");
  if (normalized === "" || normalized === "-" || normalized === ".") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  integer = false,
  format = String,
  onBlur,
  onFocus,
  inputMode,
  ...rest
}: NumberInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(() => format(value));

  const normalize = (next: number) => {
    let result = integer ? Math.round(next) : next;
    if (min !== undefined) result = Math.max(min, result);
    if (max !== undefined) result = Math.min(max, result);
    return result;
  };

  // Un cambio que llega de fuera (otro control, deshacer...) se ve en el campo,
  // salvo mientras se está escribiendo en él.
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setDraft(format(value));
    }
    // `format` suele ser una lambda nueva en cada render: solo importa el valor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      {...rest}
      ref={inputRef}
      type="number"
      inputMode={inputMode ?? (integer && (min ?? 0) >= 0 ? "numeric" : "decimal")}
      min={min}
      max={max}
      value={draft}
      onFocus={onFocus}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
        const parsed = parseNumberDraft(nextDraft);
        // Fuera de rango mientras se teclea (p. ej. "1" camino de "12" con
        // min 5) no se recorta todavía: se avisa solo si ya es válido.
        if (parsed === null) return;
        const normalized = normalize(parsed);
        if (normalized === parsed) onChange(normalized);
      }}
      onBlur={(event) => {
        const parsed = parseNumberDraft(draft);
        const next = parsed === null ? value : normalize(parsed);
        setDraft(format(next));
        if (next !== value) onChange(next);
        onBlur?.(event);
      }}
    />
  );
}
