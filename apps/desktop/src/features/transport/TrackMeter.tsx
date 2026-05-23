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
  peakHoldDb: number;
  peakHoldUntil: number;
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
  const peakRef = useRef<HTMLDivElement | null>(null);
  const animationStateRef = useRef<MeterAnimationState>({
    frameId: null,
    lastFrameAt: 0,
    currentDb: peakToMeterDb(0),
    targetDb: peakToMeterDb(0),
    clipHoldUntil: 0,
    peakHoldDb: METER_MIN_DB,
    peakHoldUntil: 0,
  });

  useEffect(() => {
    const animationState = animationStateRef.current;

    const applyCurrentMeter = () => {
      const now = performance.now();
      applyMeterBar(barRef.current, animationState.currentDb);
      applyClipIndicator(clipRef.current, now <= animationState.clipHoldUntil);
      applyPeakHold(
        peakRef.current,
        animationState.peakHoldDb,
        animationState.peakHoldDb > METER_MIN_DB + METER_ACTIVE_EPSILON_DB,
      );
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

      if (animationState.currentDb >= animationState.peakHoldDb) {
        animationState.peakHoldDb = animationState.currentDb;
        animationState.peakHoldUntil = now + METER_PEAK_HOLD_MS;
      } else if (now > animationState.peakHoldUntil) {
        animationState.peakHoldDb = stepMeterDb(
          animationState.peakHoldDb,
          animationState.currentDb,
          elapsedMs,
          METER_PEAK_DECAY_DB_PER_SECOND,
        );
      }

      applyCurrentMeter();

      const shouldContinue =
        Math.abs(animationState.currentDb - animationState.targetDb) > METER_ACTIVE_EPSILON_DB ||
        animationState.peakHoldDb > animationState.currentDb + METER_ACTIVE_EPSILON_DB ||
        now <= animationState.clipHoldUntil ||
        now <= animationState.peakHoldUntil;

      if (!shouldContinue) {
        animationState.currentDb = animationState.targetDb;
        animationState.peakHoldDb = animationState.currentDb;
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
      if (animationState.targetDb >= animationState.peakHoldDb) {
        animationState.peakHoldDb = animationState.targetDb;
        animationState.peakHoldUntil = performance.now() + METER_PEAK_HOLD_MS;
      }
      scheduleAnimation();
    };

    const currentMeter = useTransportStore.getState().meters[trackId] ?? EMPTY_METER;
    animationState.currentDb = peakToMeterDb(resolveTrackPeak(currentMeter));
    animationState.targetDb = animationState.currentDb;
    animationState.peakHoldDb = animationState.currentDb;
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
      animationState.peakHoldDb = METER_MIN_DB;
      animationState.peakHoldUntil = 0;
      applyMeterBar(barRef.current, peakToMeterDb(0));
      applyClipIndicator(clipRef.current, false);
      applyPeakHold(peakRef.current, METER_MIN_DB, false);
    };
  }, [trackId]);

  const idleMeterStyle = meterStyleFromDb(peakToMeterDb(0));

  return (
    <div className="lt-track-meter" aria-hidden="true">
      <div className="lt-track-meter-channel">
        <div className="lt-track-meter-bar" ref={barRef} style={idleMeterStyle} />
        <div className="lt-track-meter-peak" ref={peakRef} />
        <div className="lt-track-meter-clip" ref={clipRef} />
      </div>
    </div>
  );
}

export const TrackMeter = memo(TrackMeterComponent);
