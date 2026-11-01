import { recordMeterTick } from "../perf/perfMetrics";
import { useMeterStore, type TrackMeterState } from "../meterStore";

/**
 * Reloj compartido de los medidores (`TrackMeter`, `SongMasterMeter`).
 *
 * Antes cada medidor tenía su propia suscripción al store y su propio
 * `requestAnimationFrame`: con 138 pistas eran 138 selectores por publicación
 * de `setMeters` y hasta 138 callbacks de rAF por frame
 * (`docs/plans/track-virtualization/00-DIAGNOSTICO.md`, E2). Aquí hay UNA
 * suscripción y UN bucle, que recorre sólo los medidores en movimiento.
 *
 * El contrato por medidor no cambia: el bucle arranca cuando un medidor recibe
 * un objetivo nuevo y se para solo cuando ninguno se mueve. La balística y las
 * escrituras de estilo siguen en el medidor (`step`); el reloj sólo decide
 * cuándo llamarlas.
 */

export type MeterSource = "track" | "region";

export type MeterClient = {
  source: MeterSource;
  id: string;
  /** Su entrada del store cambió: fija el nuevo objetivo. No pinta. */
  onMeter: (meter: TrackMeterState | undefined) => void;
  /** Avanza un frame y escribe estilos. Devuelve si sigue en movimiento. */
  step: (now: number) => boolean;
};

export type MeterRegistration = {
  /** Mete el medidor en el bucle (si no lo estaba) y lo arranca. */
  wake: () => void;
  unregister: () => void;
};

type MeterState = ReturnType<typeof useMeterStore.getState>;

const clients = new Set<MeterClient>();
const moving = new Set<MeterClient>();
let frameId: number | null = null;
let unsubscribeStore: (() => void) | null = null;

export function selectMeter(
  state: Pick<MeterState, "meters" | "regionMeters">,
  source: MeterSource,
  id: string,
) {
  return source === "track" ? state.meters[id] : state.regionMeters[id];
}

export function areTrackMetersEqual(
  previousMeter: TrackMeterState | undefined,
  nextMeter: TrackMeterState | undefined,
) {
  return (
    (previousMeter?.leftPeak ?? 0) === (nextMeter?.leftPeak ?? 0) &&
    (previousMeter?.rightPeak ?? 0) === (nextMeter?.rightPeak ?? 0)
  );
}

function dispatchMeters(state: MeterState, previous: MeterState) {
  if (state.meters === previous.meters && state.regionMeters === previous.regionMeters) {
    return;
  }
  for (const client of clients) {
    const next = selectMeter(state, client.source, client.id);
    if (!areTrackMetersEqual(selectMeter(previous, client.source, client.id), next)) {
      client.onMeter(next);
    }
  }
}

function runFrame(now: number) {
  frameId = null;
  recordMeterTick();
  for (const client of moving) {
    if (!client.step(now)) {
      moving.delete(client);
    }
  }
  if (moving.size > 0) {
    frameId = requestAnimationFrame(runFrame);
  }
}

function scheduleFrame() {
  if (frameId === null) {
    frameId = requestAnimationFrame(runFrame);
  }
}

export function registerMeter(client: MeterClient): MeterRegistration {
  clients.add(client);
  if (unsubscribeStore === null) {
    unsubscribeStore = useMeterStore.subscribe(dispatchMeters);
  }

  return {
    wake: () => {
      if (!clients.has(client)) {
        return;
      }
      moving.add(client);
      scheduleFrame();
    },
    unregister: () => {
      clients.delete(client);
      moving.delete(client);
      if (moving.size === 0 && frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      if (clients.size === 0 && unsubscribeStore !== null) {
        unsubscribeStore();
        unsubscribeStore = null;
      }
    },
  };
}

/** Medidores registrados y en movimiento. Para tests. */
export function meterTickerStats() {
  return {
    registered: clients.size,
    moving: moving.size,
    frameScheduled: frameId !== null,
    subscribed: unsubscribeStore !== null,
  };
}
