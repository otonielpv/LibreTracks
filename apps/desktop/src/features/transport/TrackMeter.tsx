import { memo, useEffect, useRef } from "react";

import {
  DEFAULT_METER_FALLOFF_DB_PER_SECOND,
  METER_ACTIVE_EPSILON_DB,
  METER_CLIP_HOLD_MS,
  METER_CLIP_THRESHOLD,
  meterStyleFromDb,
  peakToMeterDb,
  stepMeterDb,
} from "@libretracks/shared/meterBallistics";

import { useTransportStore, type TrackMeterState } from "./store";

const EMPTY_METER: TrackMeterState = {
  leftPeak: 0,
  rightPeak: 0,
};
type MeterAnimationState = {
  frameId: number | null;
  lastFrameAt: number;
  currentDb: number;
  targetDb: number;
  clipHoldUntil: number;
};

function resolveTrackPeak(meter: TrackMeterState) {
  return Math.max(meter.leftPeak, meter.rightPeak);
}

function applyMeterBar(element: HTMLDivElement | null, meterDb: number) {
  if (!element) {
    return;
  }

  const nextStyle = meterStyleFromDb(meterDb);
  element.style.clipPath = nextStyle.clipPath;
  element.style.opacity = nextStyle.opacity;
}

function applyClipIndicator(element: HTMLDivElement | null, isClipping: boolean) {
  if (!element) {
    return;
  }

  element.style.opacity = isClipping ? "1" : "0";
  element.style.transform = isClipping ? "scaleY(1)" : "scaleY(0)";
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
  const barRef = useRef<HTMLDivElement | null>(null);
  const clipRef = useRef<HTMLDivElement | null>(null);
  const animationStateRef = useRef<MeterAnimationState>({
    frameId: null,
    lastFrameAt: 0,
    currentDb: peakToMeterDb(0),
    targetDb: peakToMeterDb(0),
    clipHoldUntil: 0,
  });

  useEffect(() => {
    const animationState = animationStateRef.current;

    const applyCurrentMeter = () => {
      applyMeterBar(barRef.current, animationState.currentDb);
      applyClipIndicator(clipRef.current, performance.now() <= animationState.clipHoldUntil);
    };

    const stopAnimation = () => {
      if (animationState.frameId !== null) {
        cancelAnimationFrame(animationState.frameId);
        animationState.frameId = null;
      }
      animationState.lastFrameAt = 0;
    };

    const stepAnimation = (now: number) => {
      const elapsedMs = animationState.lastFrameAt > 0 ? now - animationState.lastFrameAt : 16.67;
      animationState.lastFrameAt = now;

      animationState.currentDb = stepMeterDb(
        animationState.currentDb,
        animationState.targetDb,
        elapsedMs,
        DEFAULT_METER_FALLOFF_DB_PER_SECOND,
      );

      applyCurrentMeter();

      const shouldContinue =
        Math.abs(animationState.currentDb - animationState.targetDb) > METER_ACTIVE_EPSILON_DB ||
        performance.now() <= animationState.clipHoldUntil;

      if (!shouldContinue) {
        animationState.currentDb = animationState.targetDb;
        applyCurrentMeter();
        stopAnimation();
        return;
      }

      animationState.frameId = requestAnimationFrame(stepAnimation);
    };

    const scheduleAnimation = () => {
      if (animationState.frameId !== null) {
        return;
      }

      animationState.frameId = requestAnimationFrame(stepAnimation);
    };

    const updateMeterTarget = (meter: TrackMeterState | undefined) => {
      const rawPeak = resolveTrackPeak(meter ?? EMPTY_METER);
      animationState.targetDb = peakToMeterDb(rawPeak);
      if (rawPeak >= METER_CLIP_THRESHOLD) {
        animationState.clipHoldUntil = performance.now() + METER_CLIP_HOLD_MS;
      }
      scheduleAnimation();
    };

    const currentMeter = useTransportStore.getState().meters[trackId] ?? EMPTY_METER;
    animationState.currentDb = peakToMeterDb(resolveTrackPeak(currentMeter));
    animationState.targetDb = animationState.currentDb;
    applyCurrentMeter();

    if (animationState.currentDb > peakToMeterDb(0)) {
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
      animationState.currentDb = peakToMeterDb(0);
      animationState.targetDb = peakToMeterDb(0);
      animationState.clipHoldUntil = 0;
      applyMeterBar(barRef.current, peakToMeterDb(0));
      applyClipIndicator(clipRef.current, false);
    };
  }, [trackId]);

  const idleMeterStyle = meterStyleFromDb(peakToMeterDb(0));

  return (
    <div className="lt-track-meter" aria-hidden="true">
      <div className="lt-track-meter-channel">
        <div className="lt-track-meter-bar" ref={barRef} style={idleMeterStyle} />
        <div className="lt-track-meter-clip" ref={clipRef} />
      </div>
    </div>
  );
}

export const TrackMeter = memo(TrackMeterComponent);
