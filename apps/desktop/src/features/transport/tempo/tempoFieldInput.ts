/**
 * Lo que se puede escribir en los campos de BPM y compás, y cómo se leen.
 *
 * El BPM era `type="number"`, que deja escribir "e" (notación científica): con
 * "1e" a medias el navegador da `value = ""`, `Number("")` es 0 y el commit lo
 * recortaba al mínimo, así que el tempo saltaba a 20 BPM. El compás aceptaba
 * cualquier texto y el backend solo rechaza lo que no sea `n/d`. Aquí se
 * filtra al teclear y se valida al confirmar, igual en todas las plataformas.
 */

import { MAX_SESSION_BPM, MIN_SESSION_BPM } from "./tapTempoHandler";

/** Denominadores con sentido musical: figuras, no números cualesquiera. */
const TIME_SIGNATURE_DENOMINATORS = new Set([1, 2, 4, 8, 16, 32]);
const MAX_TIME_SIGNATURE_NUMERATOR = 32;

/**
 * Deja solo cifras y UN separador decimal ("." o ","; los teclados en español
 * dan coma), con hasta 3 cifras enteras y 2 decimales.
 */
export function sanitizeBpmDraft(raw: string): string {
  let integer = "";
  let decimals = "";
  let separator = "";
  for (const char of raw) {
    if (char >= "0" && char <= "9") {
      if (separator) {
        if (decimals.length < 2) decimals += char;
      } else if (integer.length < 3) {
        integer += char;
      }
    } else if ((char === "." || char === ",") && !separator) {
      separator = char;
    }
  }
  return integer + separator + decimals;
}

/** BPM válido dentro del rango de la sesión, o `null` si no hay número. */
export function parseBpmDraft(draft: string): number | null {
  const normalized = draft.trim().replace(",", ".");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(normalized)) {
    return null;
  }
  const bpm = Number(normalized);
  if (!Number.isFinite(bpm) || bpm <= 0) {
    return null;
  }
  return Math.max(MIN_SESSION_BPM, Math.min(MAX_SESSION_BPM, bpm));
}

/** Deja solo cifras y UNA barra, con hasta 2 cifras a cada lado. */
export function sanitizeTimeSignatureDraft(raw: string): string {
  let numerator = "";
  let denominator = "";
  let slash = false;
  for (const char of raw) {
    if (char >= "0" && char <= "9") {
      if (slash) {
        if (denominator.length < 2) denominator += char;
      } else if (numerator.length < 2) {
        numerator += char;
      }
    } else if (char === "/" && !slash) {
      slash = true;
    }
  }
  return slash ? `${numerator}/${denominator}` : numerator;
}

/**
 * Compás normalizado ("07/8" → "7/8") o `null` si no es un compás: numerador
 * 1–32 y denominador 1, 2, 4, 8, 16 o 32.
 */
export function parseTimeSignatureDraft(draft: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(draft.trim());
  if (!match) {
    return null;
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    numerator < 1 ||
    numerator > MAX_TIME_SIGNATURE_NUMERATOR ||
    !TIME_SIGNATURE_DENOMINATORS.has(denominator)
  ) {
    return null;
  }
  return `${numerator}/${denominator}`;
}
