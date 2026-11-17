// Única definición de cada acción del panel Ritmo (D14). Las vistas y el
// teclado/MIDI invocan estos handlers; nunca reimplementan la llamada.
//
// Se instancia una vez con `useMemo`: lo volátil (ajustes) se lee por getter.
import type { AppSettings, LoopClockMode, LoopQuantize } from "@libretracks/shared/models";

import { calculateTapTempoBpm, nextTapTempoTimes } from "../tapTempo";

export type RhythmApi = {
  loopToggle: () => Promise<boolean>;
  /** Arranca o para sin alternar (botones de pantalla). */
  setLoopPlaying: (playing: boolean) => Promise<void>;
  loopToggleRow: (row: number) => Promise<boolean>;
  loopSetRow: (row: number, variation: number) => Promise<boolean>;
  loopSetAllRows: (variation: number) => Promise<boolean>;
  oneShotDown: (pad: number, velocity?: number) => Promise<boolean>;
  oneShotUp: (pad: number) => Promise<boolean>;
  oneShotsStopAll: () => Promise<boolean>;
  setActivePattern: (patternId: string) => Promise<AppSettings>;
  setOneShotBank: (bank: number) => Promise<AppSettings>;
  setLoopConfig: (config: {
    clockMode: LoopClockMode;
    freeBpm: number;
    quantize: LoopQuantize;
    output: string;
    volume: number;
    followTransport?: boolean;
  }) => Promise<AppSettings>;
  setOneShotConfig: (output: string, volume: number) => Promise<AppSettings>;
};

export type RhythmHandlerDeps = {
  api: RhythmApi;
  getSettings: () => AppSettings | null;
  /** Aplica los ajustes que devuelve el backend al store de la app. */
  applySettings: (settings: AppSettings) => void;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export type RhythmHandlers = ReturnType<typeof createRhythmHandlers>;

export function createRhythmHandlers(deps: RhythmHandlerDeps) {
  const now = deps.now ?? (() => performance.now());
  const report = (error: unknown) => deps.onError?.(error);
  // Los comandos corren en el threadpool de Tauri y podrían adelantarse:
  // down y up de un mismo pad van encadenados para que un gate no se quede
  // colgado.
  const padChains = new Map<number, Promise<unknown>>();
  let tapTimes: number[] = [];
  // Ajustes en serie y solo la ÚLTIMA respuesta se aplica: un fader manda
  // decenas de cambios por segundo y respuestas desordenadas lo hacían
  // vibrar.
  let settingsChain: Promise<unknown> = Promise.resolve();
  let settingsSeq = 0;
  const serialSettings = (run: () => Promise<AppSettings>) => {
    const seq = ++settingsSeq;
    const next = settingsChain
      .catch(() => {})
      .then(run)
      .then((settings) => {
        if (seq === settingsSeq) deps.applySettings(settings);
      })
      .catch(report);
    settingsChain = next;
    return next;
  };

  const chainPad = (pad: number, run: () => Promise<unknown>) => {
    const previous = padChains.get(pad) ?? Promise.resolve();
    const next = previous.then(run, run).catch(report);
    padChains.set(pad, next);
    return next;
  };

  // Lo último pedido, para que dos cambios seguidos no se pisen mientras la
  // respuesta del primero no ha vuelto.
  let pendingLoop: Partial<{
    clockMode: LoopClockMode;
    freeBpm: number;
    quantize: LoopQuantize;
    output: string;
    volume: number;
    followTransport: boolean;
  }> = {};
  const loopConfig = (patch: typeof pendingLoop) => {
    const s = deps.getSettings();
    if (!s) return Promise.resolve();
    pendingLoop = { ...pendingLoop, ...patch };
    const request = {
      clockMode: s.loopClockMode,
      freeBpm: s.loopFreeBpm,
      quantize: s.loopQuantize,
      output: s.loopOutput,
      volume: s.loopVolume,
      followTransport: s.loopFollowTransport,
      ...pendingLoop,
    };
    const seq = settingsSeq + 1;
    return serialSettings(() => deps.api.setLoopConfig(request)).finally(() => {
      // Solo al acabar la última: hasta entonces los ajustes aplicados aún no
      // llevan lo pedido después.
      if (seq === settingsSeq) pendingLoop = {};
    });
  };

  return {
    toggleLoop: () => deps.api.loopToggle().catch(report),
    /** Botones de pantalla: el estado que se ve decide qué se pide. */
    setLoopPlaying: (playing: boolean) => deps.api.setLoopPlaying(playing).catch(report),
    toggleRow: (row: number) => deps.api.loopToggleRow(row).catch(report),
    setRowVariation: (row: number, variation: number) => deps.api.loopSetRow(row, variation).catch(report),
    setAllRows: (variation: number) => deps.api.loopSetAllRows(variation).catch(report),
    padDown: (pad: number, velocity?: number) => chainPad(pad, () => deps.api.oneShotDown(pad, velocity)),
    padUp: (pad: number) => chainPad(pad, () => deps.api.oneShotUp(pad)),
    stopAllPads: () => deps.api.oneShotsStopAll().catch(report),
    selectPattern: (patternId: string) =>
      deps.api.setActivePattern(patternId).then(deps.applySettings).catch(report),
    selectBank: (bank: number) =>
      deps.api.setOneShotBank(Math.min(3, Math.max(0, bank))).then(deps.applySettings).catch(report),
    setClockMode: (clockMode: LoopClockMode) => loopConfig({ clockMode }),
    setFollowTransport: (followTransport: boolean) => loopConfig({ followTransport }),
    setQuantize: (quantize: LoopQuantize) => loopConfig({ quantize }),
    setLoopVolume: (volume: number) => loopConfig({ volume }),
    setOneShotVolume: (volume: number) => {
      const s = deps.getSettings();
      if (!s) return Promise.resolve();
      return serialSettings(() => deps.api.setOneShotConfig(s.oneShotOutput, volume));
    },
    /** Tap: solo en Libre fija la BPM del loop (D16). Devuelve la BPM o null. */
    tap: (): number | null => {
      const s = deps.getSettings();
      if (!s || s.loopClockMode !== "free") return null;
      tapTimes = nextTapTempoTimes(tapTimes, now());
      const bpm = calculateTapTempoBpm(tapTimes);
      if (bpm === null) return null;
      const rounded = Math.round(Math.min(300, Math.max(30, bpm)) * 10) / 10;
      void loopConfig({ freeBpm: rounded });
      return rounded;
    },
  };
}
