import { memo, useEffect, useRef } from "react";

import { useTransportStore, type TrackMeterState } from "./store";

const EMPTY_METER: TrackMeterState = {
  leftPeak: 0,
  rightPeak: 0,
};
const PEAK_FALLOFF_PER_SECOND = 1.8;
const PEAK_EPSILON = 0.001;
const METER_MIN_DB = -60;
const METER_MAX_DB = 9;
const CLIP_THRESHOLD = 1;
const CLIP_HOLD_MS = 220;

type MeterAnimationState = {
  frameId: number | null;
  lastFrameAt: number;
  currentPeak: number;
  targetPeak: number;
  clipHoldUntil: number;
};

function clampPeak(peak: number) {
  return Math.max(0, Math.min(1, peak));
}

function resolveTrackPeak(meter: TrackMeterState) {
  return Math.max(meter.leftPeak, meter.rightPeak);
}

function gainToDb(peak: number) {
  return 20 * Math.log10(Math.max(peak, 0.000_001));
}

function peakToDisplayScale(peak: number) {
  const nextPeak = clampPeak(peak);
  if (nextPeak <= PEAK_EPSILON) {
    return 0;
  }

  const peakDb = gainToDb(nextPeak);
  return Math.max(0, Math.min(1, (peakDb - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)));
}

function meterStyleValue(peak: number) {
  const nextPeak = peakToDisplayScale(peak);
  return {
    clipPath: `inset(${((1 - nextPeak) * 100).toFixed(2)}% 0 0 0)`,
    opacity: nextPeak > PEAK_EPSILON ? "1" : "0.18",
  } as const;
}

function applyMeterBar(element: HTMLDivElement | null, peak: number) {
  if (!element) {
    return;
  }

  const nextStyle = meterStyleValue(peak);
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
    currentPeak: 0,
    targetPeak: 0,
    clipHoldUntil: 0,
  });

  useEffect(() => {
    const animationState = animationStateRef.current;

    const applyCurrentMeter = () => {
      applyMeterBar(barRef.current, animationState.currentPeak);
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

      const decayAmount = (PEAK_FALLOFF_PER_SECOND * elapsedMs) / 1000;
      animationState.currentPeak =
        animationState.targetPeak > animationState.currentPeak
          ? animationState.targetPeak
          : Math.max(animationState.targetPeak, animationState.currentPeak - decayAmount);

      applyCurrentMeter();

      const shouldContinue =
        Math.abs(animationState.currentPeak - animationState.targetPeak) > PEAK_EPSILON;

      if (!shouldContinue) {
        animationState.currentPeak = animationState.targetPeak;
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
      const nextPeak = clampPeak(rawPeak);
      animationState.targetPeak = nextPeak;
      if (rawPeak >= CLIP_THRESHOLD) {
        animationState.clipHoldUntil = performance.now() + CLIP_HOLD_MS;
      }
      scheduleAnimation();
    };

    const currentMeter = useTransportStore.getState().meters[trackId] ?? EMPTY_METER;
    animationState.currentPeak = clampPeak(resolveTrackPeak(currentMeter));
    animationState.targetPeak = animationState.currentPeak;
    applyCurrentMeter();

    if (animationState.currentPeak > PEAK_EPSILON) {
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
      animationState.currentPeak = 0;
      animationState.targetPeak = 0;
      animationState.clipHoldUntil = 0;
      applyMeterBar(barRef.current, 0);
      applyClipIndicator(clipRef.current, false);
    };
  }, [trackId]);

  const idleMeterStyle = meterStyleValue(0);

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
