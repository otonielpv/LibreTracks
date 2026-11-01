/**
 * Contadores de actividad de la interfaz, siempre activos.
 *
 * El PerfHud sólo existe en builds de depuración, y en iOS la «CPU de la app»
 * del medidor de recursos no incluye el proceso WebContent: el coste de la UI
 * no se veía en ningún sitio en un móvil de verdad. Estos contadores sólo suman
 * enteros, así que pueden ir en release; el menú de recursos los lee una vez
 * por segundo y enseña la tasa.
 */

export type UiActivityKind =
  /** Render de TransportPanelContent (el monolito). */
  | "panelRenders"
  /** Commits de React bajo el Profiler del transporte (panel o hijos). */
  | "uiCommits"
  /** Snapshots de transporte recibidos por el sondeo. */
  | "snapshots"
  /** Eventos `audio:meters` recibidos. */
  | "meterEvents";

const KINDS: UiActivityKind[] = [
  "panelRenders",
  "uiCommits",
  "snapshots",
  "meterEvents",
];

const counts: Record<UiActivityKind, number> = {
  panelRenders: 0,
  uiCommits: 0,
  snapshots: 0,
  meterEvents: 0,
};

export function countUiActivity(kind: UiActivityKind) {
  counts[kind] += 1;
}

export type UiActivityRates = Record<UiActivityKind, number>;

let lastReadAt: number | null = null;
let lastCounts: Record<UiActivityKind, number> = { ...counts };

/**
 * Eventos por segundo desde la lectura anterior. La primera lectura no tiene
 * referencia y devuelve null.
 */
export function readUiActivityRates(now = performance.now()): UiActivityRates | null {
  const previousAt = lastReadAt;
  const previous = lastCounts;
  lastReadAt = now;
  lastCounts = { ...counts };
  if (previousAt === null || now <= previousAt) {
    return null;
  }
  const seconds = (now - previousAt) / 1000;
  const rates = {} as UiActivityRates;
  for (const kind of KINDS) {
    rates[kind] = (counts[kind] - previous[kind]) / seconds;
  }
  return rates;
}

/** Sólo para tests. */
export function resetUiActivityForTests() {
  for (const kind of KINDS) {
    counts[kind] = 0;
  }
  lastReadAt = null;
  lastCounts = { ...counts };
}
