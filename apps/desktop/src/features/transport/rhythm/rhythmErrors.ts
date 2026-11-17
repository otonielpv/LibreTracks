// Errores del backend de ritmo traducidos (plan drum-loops, paso 09). Los
// límites de D11 llegan como texto fijo desde Rust (`rhythm/import.rs` y el
// banco de muestras del motor).
import type { TFunction } from "i18next";

import { formatUserFacingError } from "../errors/formatTransportError";

const TOO_LONG = /sample too long: ([\d.]+) s, limit (\d+) s/;
const OVER_MEMORY = /sample bank over memory limit: ([\d.]+) MB > ([\d.]+) MB/;

export function formatRhythmError(error: unknown, t: TFunction): string {
  const text = error instanceof Error ? error.message : String(error);
  const tooLong = TOO_LONG.exec(text);
  if (tooLong) return t("rhythm.errors.tooLong", { seconds: tooLong[1], limit: tooLong[2] });
  const memory = OVER_MEMORY.exec(text);
  if (memory) return t("rhythm.errors.memory", { used: memory[1], limit: memory[2] });
  return formatUserFacingError(error, t);
}
