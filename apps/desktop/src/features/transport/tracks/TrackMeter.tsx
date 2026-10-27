import { memo, useEffect, useRef } from "react";

import {
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_CLIP_HOLD_MS,
  METER_CLIP_THRESHOLD,
  METER_MIN_DB,
  METER_PEAK_DECAY_DB_PER_SECOND,
  METER_PEAK_HOLD_MS,
  type MeterOrientation,
  meterStyleFromDb,
  peakHoldStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "@libretracks/shared/meterBallistics";

import { useSongStore } from "../songStore";
import { useTransportStore, type TrackMeterState } from "../store";
import { registerMeter, selectMeter } from "./meterTicker";

const EMPTY_METER: TrackMeterState = {
  leftPeak: 0,
  rightPeak: 0,
};

const CHANNEL_COUNT = 2;

type ChannelAnimationState = {
  currentDb: number;
  targetDb: number;
  clipHoldUntil: number;
  peakHoldDb: number;
  peakHoldUntil: number;
};

type ChannelElements = {
  bar: HTMLDivElement | null;
  peak: HTMLDivElement | null;
  clip: HTMLDivElement | null;
};

/** Raw peaks per channel, left then right. Each side gets its own bar; a mono
 * source panned centre arrives as two equal peaks. Until stereo meters, the
 * header showed `Math.max` of both and hid where the signal sat.
 *
 * A track converted to mono shows ONE bar, like Ableton: its channels carry
 * the same signal, so the bar takes the louder side. */
export function channelPeaks(meter: TrackMeterState, mono = false): [number, number] {
  if (mono) {
    const peak = Math.max(meter.leftPeak, meter.rightPeak);
    return [peak, peak];
  }
  return [meter.leftPeak, meter.rightPeak];
}

function idleChannel(): ChannelAnimationState {
  return {
    currentDb: peakToMeterDb(0),
    targetDb: peakToMeterDb(0),
    clipHoldUntil: 0,
    peakHoldDb: METER_MIN_DB,
    peakHoldUntil: 0,
  };
}

function applyMeterBar(
  element: HTMLDivElement | null,
  meterDb: number,
  orientation: MeterOrientation,
) {
  if (!element) {
    return;
  }

  const nextStyle = meterStyleFromDb(meterDb, orientation);
  element.style.clipPath = nextStyle.clipPath;
  element.style.opacity = nextStyle.opacity;
}

function applyPeakHold(
  element: HTMLDivElement | null,
  peakDb: number,
  visible: boolean,
  orientation: MeterOrientation,
) {
  if (!element) {
    return;
  }

  const nextStyle = peakHoldStyleFromDb(peakDb, orientation);
  element.style.transform = nextStyle.transform;
  element.style.opacity = visible ? nextStyle.opacity : "0";
}

function applyClipIndicator(element: HTMLDivElement | null, isClipping: boolean) {
  if (!element) {
    return;
  }

  element.style.opacity = isClipping ? "1" : "0";
  element.style.transform = isClipping ? "scale(1)" : "scale(0)";
}

function applyChannel(
  elements: ChannelElements,
  channel: ChannelAnimationState,
  now: number,
  orientation: MeterOrientation,
) {
  applyMeterBar(elements.bar, channel.currentDb, orientation);
  applyClipIndicator(elements.clip, now <= channel.clipHoldUntil);
  applyPeakHold(
    elements.peak,
    channel.peakHoldDb,
    channel.peakHoldDb > METER_MIN_DB + METER_ACTIVE_EPSILON_DB,
    orientation,
  );
}

/** Advance one channel's ballistics; returns whether it is still moving. */
function stepChannel(channel: ChannelAnimationState, now: number, elapsedMs: number) {
  channel.currentDb = stepMeterDb(
    channel.currentDb,
    channel.targetDb,
    elapsedMs,
    DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  );

  if (channel.currentDb >= channel.peakHoldDb) {
    channel.peakHoldDb = channel.currentDb;
    channel.peakHoldUntil = now + METER_PEAK_HOLD_MS;
  } else if (now > channel.peakHoldUntil) {
    channel.peakHoldDb = stepMeterDb(
      channel.peakHoldDb,
      channel.currentDb,
      elapsedMs,
      METER_PEAK_DECAY_DB_PER_SECOND,
    );
  }

  const moving =
    Math.abs(channel.currentDb - channel.targetDb) > METER_ACTIVE_EPSILON_DB ||
    channel.peakHoldDb > channel.currentDb + METER_ACTIVE_EPSILON_DB ||
    now <= channel.clipHoldUntil ||
    now <= channel.peakHoldUntil;

  if (!moving) {
    channel.currentDb = channel.targetDb;
    channel.peakHoldDb = channel.currentDb;
  }
  return moving;
}

function setChannelTarget(channel: ChannelAnimationState, rawPeak: number, now: number) {
  channel.targetDb = peakToMeterDb(rawPeak);
  if (rawPeak >= METER_CLIP_THRESHOLD) {
    channel.clipHoldUntil = now + METER_CLIP_HOLD_MS;
  }
  if (channel.targetDb >= channel.peakHoldDb) {
    channel.peakHoldDb = channel.targetDb;
    channel.peakHoldUntil = now + METER_PEAK_HOLD_MS;
  }
}

type SongState = ReturnType<typeof useSongStore.getState>;
type SongTrack = NonNullable<SongState["song"]>["tracks"][number];

// Índice id → pista por canción. Cada edición publica una canción nueva, así
// que se reconstruye una vez por edición y no una vez por medidor: con
// `tracks.find` en el selector, N medidores hacían N búsquedas de N pistas.
const trackIndexBySong = new WeakMap<object, Map<string, SongTrack>>();

function trackById(song: SongState["song"], id: string): SongTrack | undefined {
  if (!song) {
    return undefined;
  }
  let index = trackIndexBySong.get(song);
  if (!index) {
    index = new Map(song.tracks.map((track) => [track.id, track]));
    trackIndexBySong.set(song, index);
  }
  return index.get(id);
}

type StereoMeterProps = {
  /** Una pista (`meters`) o el master de una canción (`regionMeters`). */
  source: "track" | "region";
  id: string;
  orientation: MeterOrientation;
  className: string;
};

function StereoMeterComponent({ source, id, orientation, className }: StereoMeterProps) {
  // «Convertir a mono» de la pista: un solo canal en el medidor. El master de
  // una canción no tiene esa opción.
  const mono = useSongStore(
    (state) => source === "track" && trackById(state.song, id)?.monoDownmix === true,
  );
  const monoRef = useRef(mono);
  monoRef.current = mono;
  // Styles are written through refs, never setState: this animates at 60 fps
  // for every visible track while playing.
  const elementsRef = useRef<ChannelElements[]>(
    Array.from({ length: CHANNEL_COUNT }, () => ({ bar: null, peak: null, clip: null })),
  );
  const animationRef = useRef<{
    lastFrameAt: number;
    channels: ChannelAnimationState[];
  }>({
    lastFrameAt: 0,
    channels: Array.from({ length: CHANNEL_COUNT }, idleChannel),
  });

  useEffect(() => {
    const animation = animationRef.current;
    const elements = elementsRef.current;

    const applyAll = (now: number) => {
      animation.channels.forEach((channel, index) => {
        applyChannel(elements[index], channel, now, orientation);
      });
    };

    // The shared ticker calls this once per frame while the meter moves.
    const step = (now: number) => {
      const elapsedMs = animation.lastFrameAt > 0 ? now - animation.lastFrameAt : 16.67;
      animation.lastFrameAt = now;

      let moving = false;
      for (const channel of animation.channels) {
        if (stepChannel(channel, now, elapsedMs)) {
          moving = true;
        }
      }
      applyAll(now);

      if (!moving) {
        animation.lastFrameAt = 0;
      }
      return moving;
    };

    const registration = registerMeter({
      source,
      id,
      step,
      onMeter: (meter) => {
        const peaks = channelPeaks(meter ?? EMPTY_METER, monoRef.current);
        const now = performance.now();
        animation.channels.forEach((channel, index) => {
          setChannelTarget(channel, peaks[index], now);
        });
        registration.wake();
      },
    });

    const currentPeaks = channelPeaks(
      selectMeter(useTransportStore.getState(), source, id) ?? EMPTY_METER,
      monoRef.current,
    );
    animation.channels.forEach((channel, index) => {
      channel.currentDb = peakToMeterDb(currentPeaks[index]);
      channel.targetDb = channel.currentDb;
      channel.peakHoldDb = channel.currentDb;
    });
    applyAll(performance.now());

    if (animation.channels.some((channel) => channel.currentDb > peakToMeterDb(0))) {
      registration.wake();
    }

    return () => {
      registration.unregister();
      animation.lastFrameAt = 0;
      animation.channels = Array.from({ length: CHANNEL_COUNT }, idleChannel);
      applyAll(0);
    };
    // Re-seat the bars when the track switches between mono and stereo.
  }, [source, id, mono, orientation]);

  const idleMeterStyle = meterStyleFromDb(peakToMeterDb(0), orientation);

  return (
    <div
      className={`${className}${mono ? " is-mono" : ""}${
        orientation === "horizontal" ? " is-horizontal" : ""
      }`}
      aria-hidden="true"
    >
      {elementsRef.current.slice(0, mono ? 1 : CHANNEL_COUNT).map((channelElements, index) => (
        <div className="lt-track-meter-channel" key={index}>
          <div
            className="lt-track-meter-bar"
            ref={(node) => {
              channelElements.bar = node;
            }}
            style={idleMeterStyle}
          />
          <div
            className="lt-track-meter-peak"
            ref={(node) => {
              channelElements.peak = node;
            }}
          />
          <div
            className="lt-track-meter-clip"
            ref={(node) => {
              channelElements.clip = node;
            }}
          />
        </div>
      ))}
    </div>
  );
}

const StereoMeter = memo(StereoMeterComponent);

type TrackMeterProps = {
  trackId: string;
};

function TrackMeterComponent({ trackId }: TrackMeterProps) {
  return (
    <StereoMeter source="track" id={trackId} orientation="vertical" className="lt-track-meter" />
  );
}

export const TrackMeter = memo(TrackMeterComponent);

type SongMasterMeterProps = {
  regionId: string;
  /** Para colgar los estilos de cada sitio (vista compacta, barra del timeline). */
  className?: string;
  /** Vertical en la tira del master de la consola de Setlist, como las pistas. */
  orientation?: "horizontal" | "vertical";
};

/** Medidor estéreo horizontal del master de una canción: L arriba, R abajo.
 * Va dentro de la ranura de su fader, debajo del cap. */
function SongMasterMeterComponent({
  regionId,
  className = "",
  orientation = "horizontal",
}: SongMasterMeterProps) {
  return (
    <StereoMeter
      source="region"
      id={regionId}
      orientation={orientation}
      // lt-song-master-meter is the horizontal in-slot look (full width, no
      // flex). On a vertical strip it squeezed the fader next to it to 0 px.
      className={`lt-track-meter${orientation === "horizontal" ? " lt-song-master-meter" : ""} ${className}`.trim()}
    />
  );
}

export const SongMasterMeter = memo(SongMasterMeterComponent);
