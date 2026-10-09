import { memo, useEffect, useRef } from "react";

import {
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_CLIP_HOLD_MS,
  METER_CLIP_THRESHOLD,
  METER_MIN_DB,
  METER_PEAK_DECAY_DB_PER_SECOND,
  METER_PEAK_HOLD_MS,
  meterStyleFromDb,
  peakHoldStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "@libretracks/shared/meterBallistics";

import { useSongStore } from "../songStore";
import { useTransportStore, type TrackMeterState } from "../store";

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

function applyMeterBar(element: HTMLDivElement | null, meterDb: number) {
  if (!element) {
    return;
  }

  const nextStyle = meterStyleFromDb(meterDb);
  element.style.clipPath = nextStyle.clipPath;
  element.style.opacity = nextStyle.opacity;
}

function applyPeakHold(element: HTMLDivElement | null, peakDb: number, visible: boolean) {
  if (!element) {
    return;
  }

  const nextStyle = peakHoldStyleFromDb(peakDb);
  element.style.transform = nextStyle.transform;
  element.style.opacity = visible ? nextStyle.opacity : "0";
}

function applyClipIndicator(element: HTMLDivElement | null, isClipping: boolean) {
  if (!element) {
    return;
  }

  element.style.opacity = isClipping ? "1" : "0";
  element.style.transform = isClipping ? "scaleY(1)" : "scaleY(0)";
}

function applyChannel(
  elements: ChannelElements,
  channel: ChannelAnimationState,
  now: number,
) {
  applyMeterBar(elements.bar, channel.currentDb);
  applyClipIndicator(elements.clip, now <= channel.clipHoldUntil);
  applyPeakHold(
    elements.peak,
    channel.peakHoldDb,
    channel.peakHoldDb > METER_MIN_DB + METER_ACTIVE_EPSILON_DB,
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

function areTrackMetersEqual(
  previousMeter: TrackMeterState | undefined,
  nextMeter: TrackMeterState | undefined,
) {
  return (
    (previousMeter?.leftPeak ?? 0) === (nextMeter?.leftPeak ?? 0) &&
    (previousMeter?.rightPeak ?? 0) === (nextMeter?.rightPeak ?? 0)
  );
}

type TrackMeterProps = {
  trackId: string;
};

function TrackMeterComponent({ trackId }: TrackMeterProps) {
  // «Convertir a mono» de la pista: un solo canal en el medidor.
  const mono = useSongStore(
    (state) => state.song?.tracks.find((track) => track.id === trackId)?.monoDownmix === true,
  );
  const monoRef = useRef(mono);
  monoRef.current = mono;
  // Styles are written through refs, never setState: this animates at 60 fps
  // for every visible track while playing.
  const elementsRef = useRef<ChannelElements[]>(
    Array.from({ length: CHANNEL_COUNT }, () => ({ bar: null, peak: null, clip: null })),
  );
  const animationRef = useRef<{
    frameId: number | null;
    lastFrameAt: number;
    channels: ChannelAnimationState[];
  }>({
    frameId: null,
    lastFrameAt: 0,
    channels: Array.from({ length: CHANNEL_COUNT }, idleChannel),
  });

  useEffect(() => {
    const animation = animationRef.current;
    const elements = elementsRef.current;

    const applyAll = (now: number) => {
      animation.channels.forEach((channel, index) => {
        applyChannel(elements[index], channel, now);
      });
    };

    const stopAnimation = () => {
      if (animation.frameId !== null) {
        cancelAnimationFrame(animation.frameId);
        animation.frameId = null;
      }
      animation.lastFrameAt = 0;
    };

    // One frame loop drives both channels.
    const stepAnimation = (now: number) => {
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
        stopAnimation();
        return;
      }

      animation.frameId = requestAnimationFrame(stepAnimation);
    };

    const scheduleAnimation = () => {
      if (animation.frameId !== null) {
        return;
      }

      animation.frameId = requestAnimationFrame(stepAnimation);
    };

    const updateMeterTarget = (meter: TrackMeterState | undefined) => {
      const peaks = channelPeaks(meter ?? EMPTY_METER, monoRef.current);
      const now = performance.now();
      animation.channels.forEach((channel, index) => {
        setChannelTarget(channel, peaks[index], now);
      });
      scheduleAnimation();
    };

    const currentPeaks = channelPeaks(
      useTransportStore.getState().meters[trackId] ?? EMPTY_METER,
      monoRef.current,
    );
    animation.channels.forEach((channel, index) => {
      channel.currentDb = peakToMeterDb(currentPeaks[index]);
      channel.targetDb = channel.currentDb;
      channel.peakHoldDb = channel.currentDb;
    });
    applyAll(performance.now());

    if (animation.channels.some((channel) => channel.currentDb > peakToMeterDb(0))) {
      scheduleAnimation();
    }

    const unsubscribe = useTransportStore.subscribe(
      (state) => state.meters[trackId],
      (meter) => {
        updateMeterTarget(meter);
      },
      {
        equalityFn: areTrackMetersEqual,
      },
    );

    return () => {
      unsubscribe();
      stopAnimation();
      animation.channels = Array.from({ length: CHANNEL_COUNT }, idleChannel);
      applyAll(0);
    };
    // Re-seat the bars when the track switches between mono and stereo.
  }, [trackId, mono]);

  const idleMeterStyle = meterStyleFromDb(peakToMeterDb(0));

  return (
    <div className={`lt-track-meter${mono ? " is-mono" : ""}`} aria-hidden="true">
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

export const TrackMeter = memo(TrackMeterComponent);
