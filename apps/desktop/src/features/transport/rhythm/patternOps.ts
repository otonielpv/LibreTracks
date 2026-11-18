// Operaciones puras sobre patrones de loop, reimplementadas UNA vez aquí para
// el editor (plan drum-loops). Espejo de `crates/libretracks-core/src/drum_loops.rs`
// con los mismos casos de test (`patternOps.test.ts`). Todas devuelven un
// patrón nuevo: nunca mutan el que reciben.
import {
  DRUM_KIT_MAX_SOUNDS,
  DRUM_LOOP_MAX_STEPS,
  DRUM_LOOP_VARIATIONS,
  type DrumKit,
  type LoopPattern,
  type LoopRow,
} from "@libretracks/shared/models";

export const STEP_SOFT = 1;
export const STEP_NORMAL = 2;
export const STEP_ACCENT = 3;
const MAX_STEP_VELOCITY = 3;
const MIN_BPM = 30;
const MAX_BPM = 300;
const MAX_SWING = 0.75;

export function stepsPerBar(pattern: Pick<LoopPattern, "signature" | "stepsPerBeat">): number {
  return Math.max(1, pattern.signature.numerator) * Math.max(1, pattern.stepsPerBeat);
}

export function stepCount(pattern: Pick<LoopPattern, "signature" | "stepsPerBeat" | "bars">): number {
  return Math.min(DRUM_LOOP_MAX_STEPS, stepsPerBar(pattern) * Math.max(1, pattern.bars));
}

function clampBars(value: number): 1 | 2 | 4 {
  if (value <= 1) return 1;
  if (value <= 3) return 2;
  return 4;
}

function cloneRows(rows: LoopRow[]): LoopRow[] {
  return rows.map((row) => ({ ...row, variations: row.variations.map((v) => v.slice()) }));
}

function fitLength(steps: number[], length: number): number[] {
  const out = steps.slice(0, length).map((s) => Math.min(MAX_STEP_VELOCITY, Math.max(0, s | 0)));
  while (out.length < length) out.push(0);
  return out;
}

/** Recorta a los límites y ajusta cada variación a `bars × compás × pasos`. */
export function normalizePattern(pattern: LoopPattern, kit?: DrumKit | null): LoopPattern {
  const next: LoopPattern = { ...pattern, signature: { ...pattern.signature }, rows: cloneRows(pattern.rows) };
  if (next.stepsPerBeat !== 3 && next.stepsPerBeat !== 4) next.stepsPerBeat = 4;
  next.bars = clampBars(next.bars);
  next.signature.numerator = Math.min(16, Math.max(1, next.signature.numerator | 0));
  if (![2, 4, 8, 16].includes(next.signature.denominator)) next.signature.denominator = 4;
  next.bpm = Number.isFinite(next.bpm) ? Math.min(MAX_BPM, Math.max(MIN_BPM, next.bpm)) : 120;
  next.swing = Number.isFinite(next.swing) ? Math.min(MAX_SWING, Math.max(0, next.swing)) : 0;
  while (next.bars > 1 && stepsPerBar(next) * next.bars > DRUM_LOOP_MAX_STEPS) {
    next.bars = clampBars(next.bars / 2);
  }
  const ownKit = kit ?? (next.kit.kind === "embedded" ? next.kit.kit : null);
  if (ownKit) {
    const ids = new Set(ownKit.sounds.slice(0, DRUM_KIT_MAX_SOUNDS).map((s) => s.id));
    next.rows = next.rows.filter((row) => ids.has(row.soundId));
  }
  next.rows = next.rows.slice(0, DRUM_KIT_MAX_SOUNDS);
  const steps = stepCount(next);
  for (const row of next.rows) {
    const variations = row.variations.slice(0, DRUM_LOOP_VARIATIONS);
    while (variations.length < DRUM_LOOP_VARIATIONS) variations.push([]);
    row.variations = variations.map((v) => fitLength(v, steps));
  }
  return next;
}

function withStep(
  pattern: LoopPattern,
  row: number,
  variation: number,
  step: number,
  value: (current: number) => number,
): LoopPattern {
  const steps = pattern.rows[row]?.variations[variation];
  if (!steps || step < 0 || step >= steps.length) return pattern;
  const rows = cloneRows(pattern.rows);
  rows[row].variations[variation][step] = value(steps[step]);
  return { ...pattern, rows };
}

/** Normal ↔ silencio. */
export function toggleStep(pattern: LoopPattern, row: number, variation: number, step: number): LoopPattern {
  return withStep(pattern, row, variation, step, (v) => (v === 0 ? STEP_NORMAL : 0));
}

/** silencio/suave → normal → acento → suave. */
export function cycleVelocity(pattern: LoopPattern, row: number, variation: number, step: number): LoopPattern {
  return withStep(pattern, row, variation, step, (v) =>
    v === STEP_NORMAL ? STEP_ACCENT : v === STEP_ACCENT ? STEP_SOFT : STEP_NORMAL,
  );
}

/** Pinta `value` en `[start, end)` (arrastre del editor). */
export function paintSteps(
  pattern: LoopPattern,
  row: number,
  variation: number,
  start: number,
  end: number,
  value: number,
): LoopPattern {
  const steps = pattern.rows[row]?.variations[variation];
  if (!steps) return pattern;
  const v = Math.min(MAX_STEP_VELOCITY, Math.max(0, value | 0));
  const to = Math.min(end, steps.length);
  let changed = false;
  for (let i = Math.max(0, start); i < to; i += 1) if (steps[i] !== v) changed = true;
  if (!changed) return pattern;
  const rows = cloneRows(pattern.rows);
  for (let i = Math.max(0, start); i < to; i += 1) rows[row].variations[variation][i] = v;
  return { ...pattern, rows };
}

/** Copia la variación `from` sobre `to` en todas las filas. */
export function copyVariation(pattern: LoopPattern, from: number, to: number): LoopPattern {
  if (from === to || from < 0 || to < 0 || from >= DRUM_LOOP_VARIATIONS || to >= DRUM_LOOP_VARIATIONS) {
    return pattern;
  }
  const rows = cloneRows(pattern.rows);
  for (const row of rows) {
    if (row.variations[from] && row.variations[to]) row.variations[to] = row.variations[from].slice();
  }
  return { ...pattern, rows };
}

/** Vacía las cuatro variaciones de una fila. */
export function clearRow(pattern: LoopPattern, row: number): LoopPattern {
  if (!pattern.rows[row]) return pattern;
  const rows = cloneRows(pattern.rows);
  rows[row].variations = rows[row].variations.map((v) => v.map(() => 0));
  return { ...pattern, rows };
}

/** Al crecer repite el contenido; al encoger trunca. */
export function resizeBars(pattern: LoopPattern, newBars: number): LoopPattern {
  const oldSteps = stepCount(pattern);
  const next: LoopPattern = { ...pattern, bars: clampBars(newBars), rows: cloneRows(pattern.rows) };
  const newSteps = stepCount(next);
  for (const row of next.rows) {
    row.variations = row.variations.map((v) => {
      const source = fitLength(v, oldSteps);
      if (newSteps <= oldSteps || oldSteps === 0) return fitLength(source, newSteps);
      return Array.from({ length: newSteps }, (_, i) => source[i % oldSteps]);
    });
  }
  return next;
}

/** Cambia los pasos por tiempo conservando la posición de cada paso activo;
 * `movedSteps` cuenta los que no caían exactos (la UI avisa). */
export function setStepsPerBeat(
  pattern: LoopPattern,
  newStepsPerBeat: 3 | 4,
): { pattern: LoopPattern; movedSteps: number } {
  if ((newStepsPerBeat !== 3 && newStepsPerBeat !== 4) || newStepsPerBeat === pattern.stepsPerBeat) {
    return { pattern, movedSteps: 0 };
  }
  const oldSpb = Math.max(1, pattern.stepsPerBeat);
  const next: LoopPattern = { ...pattern, stepsPerBeat: newStepsPerBeat, rows: cloneRows(pattern.rows) };
  const newSteps = stepCount(next);
  let moved = 0;
  for (const row of next.rows) {
    row.variations = row.variations.map((v) => {
      const out = new Array<number>(newSteps).fill(0);
      v.forEach((value, index) => {
        if (value === 0) return;
        const scaled = index * newStepsPerBeat;
        if (scaled % oldSpb !== 0) moved += 1;
        const target = Math.floor((scaled + Math.floor(oldSpb / 2)) / oldSpb);
        if (target < newSteps) out[target] = Math.max(out[target], value);
      });
      return out;
    });
  }
  return { pattern: next, movedSteps: moved };
}

/** Un patrón vacío con una fila por sonido del kit. */
export function emptyPattern(id: string, name: string, kit: DrumKit, kitRef: LoopPattern["kit"]): LoopPattern {
  return normalizePattern(
    {
      id,
      name,
      kit: kitRef,
      bpm: 100,
      signature: { numerator: 4, denominator: 4 },
      stepsPerBeat: 4,
      bars: 1,
      swing: 0,
      rows: kit.sounds.slice(0, DRUM_KIT_MAX_SOUNDS).map((s) => ({ soundId: s.id, gainDb: 0, variations: [] })),
    },
    kit,
  );
}

/** Ajusta las filas tras editar el kit: quita las de sonidos borrados y añade
 * una fila vacía por cada sonido nuevo (los que no estaban en `previous`).
 * Devuelve el mismo patrón si no cambia nada. */
export function syncRowsToKit(pattern: LoopPattern, previous: DrumKit, kit: DrumKit): LoopPattern {
  const ids = new Set(kit.sounds.slice(0, DRUM_KIT_MAX_SOUNDS).map((s) => s.id));
  const before = new Set(previous.sounds.map((s) => s.id));
  const kept = pattern.rows.filter((row) => ids.has(row.soundId));
  const present = new Set(kept.map((row) => row.soundId));
  const added = kit.sounds
    .slice(0, DRUM_KIT_MAX_SOUNDS)
    .filter((s) => !before.has(s.id) && !present.has(s.id))
    .map((s) => ({ soundId: s.id, gainDb: 0, variations: [] as number[][] }));
  if (kept.length === pattern.rows.length && added.length === 0) return pattern;
  return normalizePattern({ ...pattern, rows: [...kept, ...added] }, kit);
}

/** Cambia el kit del patrón: una fila por sonido del kit nuevo, en su orden.
 * Las filas cuyo sonido existe en ambos (mismo id) conservan sus pasos; el
 * resto empieza vacío. Una copia de un kit conserva los ids, y con ellos todo. */
export function withKit(pattern: LoopPattern, kit: DrumKit, ref: LoopPattern["kit"]): LoopPattern {
  const byId = new Map(pattern.rows.map((row) => [row.soundId, row]));
  const rows = kit.sounds
    .slice(0, DRUM_KIT_MAX_SOUNDS)
    .map((s) => byId.get(s.id) ?? { soundId: s.id, gainDb: 0, variations: [] as number[][] });
  return normalizePattern({ ...pattern, kit: ref, rows }, kit);
}
