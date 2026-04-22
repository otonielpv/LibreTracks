import { memo, useEffect, useRef } from "react";

import { useTransportStore, type TrackMeterState } from "./store";

const EMPTY_METER: TrackMeterState = {
  leftPeak: 0,
  rightPeak: 0,
};

function meterStyleValue(peak: number) {
  const nextPeak = Math.max(0, Math.min(1, peak));
  return {
    transform: `scaleY(${nextPeak.toFixed(4)})`,
    opacity: nextPeak > 0.001 ? "1" : "0.18",
  } as const;
}

function applyMeterBar(element: HTMLDivElement | null, peak: number) {
  if (!element) {
    return;
  }

  const nextStyle = meterStyleValue(peak);
  element.style.transform = nextStyle.transform;
  element.style.opacity = nextStyle.opacity;
}

function applyMeterBars(
  leftBar: HTMLDivElement | null,
  rightBar: HTMLDivElement | null,
  meter: TrackMeterState,
) {
  applyMeterBar(leftBar, meter.leftPeak);
  applyMeterBar(rightBar, meter.rightPeak);
}

type TrackMeterProps = {
  trackId: string;
};

function TrackMeterComponent({ trackId }: TrackMeterProps) {
  const leftBarRef = useRef<HTMLDivElement | null>(null);
  const rightBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const applyTrackMeter = (meter: TrackMeterState) => {
      applyMeterBars(leftBarRef.current, rightBarRef.current, meter);
    };

    applyTrackMeter(useTransportStore.getState().meters[trackId] ?? EMPTY_METER);

    const unsubscribe = useTransportStore.subscribe(
      (state) => state.meters[trackId] ?? EMPTY_METER,
      (meter) => {
        applyTrackMeter(meter);
      },
    );

    return unsubscribe;
  }, [trackId]);

  const idleMeterStyle = meterStyleValue(0);

  return (
    <div className="lt-track-meter" aria-hidden="true">
      <div className="lt-track-meter-channel">
        <div className="lt-track-meter-bar is-left" ref={leftBarRef} style={idleMeterStyle} />
      </div>
      <div className="lt-track-meter-channel">
        <div className="lt-track-meter-bar is-right" ref={rightBarRef} style={idleMeterStyle} />
      </div>
    </div>
  );
}

export const TrackMeter = memo(TrackMeterComponent);
