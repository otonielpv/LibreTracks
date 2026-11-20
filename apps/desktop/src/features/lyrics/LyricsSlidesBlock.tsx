import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsStepMode } from "@libretracks/shared/models";

import type { RegionReport } from "./lyricsApi";
import type { LyricsHandlers } from "./lyricsHandlers";
import {
  captureSpaceBar,
  createStepRecorder,
  type RecorderSummary,
  type SectionSpan,
  type StepRecorder,
} from "./lyricsStepRecorder";

type Props = {
  regionId: string;
  report: RegionReport;
  regionStartSeconds: number;
  regionEndSeconds: number;
  stepMode: LyricsStepMode;
  handlers: LyricsHandlers;
  onSaved: () => void;
  /** Where the space bar is caught while recording (tests pass their own). */
  keyTarget?: Window;
};

/**
 * Sections with several slides (D14): automatic changes on whole bars,
 * recorded by tapping along, or only the first slide. The mode is per song:
 * a real setlist showed no need for per-section exceptions, and recording
 * one section already replaces just that section's changes.
 */
export function LyricsSlidesBlock({
  regionId,
  report,
  regionStartSeconds,
  regionEndSeconds,
  stepMode,
  handlers,
  onSaved,
  keyTarget,
}: Props) {
  const { t } = useTranslation();
  const [recording, setRecording] = useState(false);
  const [summary, setSummary] = useState<RecorderSummary | null>(null);
  const [lastTap, setLastTap] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const recorder = useRef<StepRecorder | null>(null);

  const sections: SectionSpan[] = useMemo(() => {
    const sorted = [...report.markers].sort((a, b) => a.startSeconds - b.startSeconds);
    // Only sections with several slides take taps: a tap elsewhere has no
    // slide to move to.
    return sorted
      .map((marker, index) => ({
        markerId: marker.markerId,
        markerName: marker.markerName,
        startSeconds: marker.startSeconds,
        endSeconds: sorted[index + 1]?.startSeconds ?? regionEndSeconds,
        slides: marker.slideCount,
      }))
      .filter((section) => section.slides > 1);
  }, [report.markers, regionEndSeconds]);

  const tap = () => {
    void recorder.current?.tap().then((section) => {
      setLastTap(section ? section.markerName : null);
    });
  };

  useEffect(() => {
    if (!recording) return () => {};
    return captureSpaceBar(keyTarget ?? window, tap);
    // tap reads the recorder ref; re-binding per render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, keyTarget]);

  const multi = report.markers.filter((marker) => marker.slideCount > 1);

  const start = () => {
    recorder.current = createStepRecorder({
      sections,
      getPosition: handlers.tapPosition,
      sendStep: (markerId, k) => void handlers.testSend(regionId, markerId, k),
    });
    setSummary(null);
    setLastTap(null);
    setRecording(true);
  };

  const transport = (work: Promise<boolean>) => {
    void work.then(setPlaying).catch(() => {});
  };

  const stop = () => {
    setRecording(false);
    if (playing) transport(handlers.pause());
    setSummary(recorder.current?.summary() ?? []);
  };

  const save = () => {
    const taps = recorder.current?.taps() ?? [];
    recorder.current = null;
    setSummary(null);
    void handlers.saveRecording(regionId, taps).then(onSaved);
  };

  const discard = () => {
    recorder.current = null;
    setSummary(null);
  };

  return (
    <section className="lt-lyrics-slides" aria-label={t("lyrics.slides.title")}>
      <h3>{t("lyrics.slides.title")}</h3>
      {multi.length === 0 ? <small>{t("lyrics.slides.noneMulti")}</small> : null}
      {multi.length === 0 ? null : (
      <label className="lt-settings-field">
        <span>{t("lyrics.slides.mode")}</span>
        <select className="lt-lyrics-select"
          aria-label={t("lyrics.slides.mode")}
          value={stepMode}
          onChange={(event) =>
            void handlers.setStepMode(regionId, event.target.value as LyricsStepMode).then(onSaved)
          }
        >
          <option value="auto">{t("lyrics.slides.auto")}</option>
          <option value="manual">{t("lyrics.slides.manual")}</option>
          <option value="off">{t("lyrics.slides.off")}</option>
        </select>
      </label>
      )}
      {stepMode === "auto" && multi.length > 0 ? (
        <ul className="lt-lyrics-slides-list">
          {multi.map((marker) => (
            <li key={marker.markerId}>
              {marker.markerName}:{" "}
              {marker.autoChangeBars.length > 0
                ? t("lyrics.slides.changesOnBars", { bars: marker.autoChangeBars.join(", ") })
                : t("lyrics.slides.slides", { count: marker.slideCount })}
            </li>
          ))}
        </ul>
      ) : null}
      {multi.length === 0 ? null : recording ? (
        <div className="lt-lyrics-recorder" role="group" aria-label={t("lyrics.slides.recording")}>
          <p>{t("lyrics.slides.recordingHelp")}</p>
          <div className="lt-lyrics-recorder-transport">
            <button
              type="button"
              className="lt-lyrics-btn"
              onClick={() => transport(handlers.seekTo(regionStartSeconds))}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                skip_previous
              </span>
              {t("lyrics.slides.toSongStart")}
            </button>
            <button
              type="button"
              className="lt-lyrics-btn"
              onClick={() => transport(playing ? handlers.pause() : handlers.play())}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                {playing ? "pause" : "play_arrow"}
              </span>
              {playing ? t("lyrics.slides.pause") : t("lyrics.slides.play")}
            </button>
          </div>
          <button type="button" className="lt-lyrics-btn lt-lyrics-tap" onClick={tap}>
            {t("lyrics.slides.tap")}
          </button>
          {lastTap ? <small>{t("lyrics.slides.lastTap", { name: lastTap })}</small> : null}
          <button className="lt-lyrics-btn" type="button" onClick={stop}>
            {t("lyrics.slides.stop")}
          </button>
        </div>
      ) : summary ? (
        <div className="lt-lyrics-recorder" role="group" aria-label={t("lyrics.slides.summary")}>
          {summary.length === 0 ? (
            <p>{t("lyrics.slides.nothing")}</p>
          ) : (
            <ul>
              {summary.map((entry) => (
                <li key={entry.markerName}>
                  {t("lyrics.slides.summaryLine", { name: entry.markerName, count: entry.changes })}
                </li>
              ))}
            </ul>
          )}
          <div className="lt-lyrics-row">
            <button type="button" className="lt-lyrics-btn is-primary" disabled={summary.length === 0} onClick={save}>
              {t("lyrics.slides.save")}
            </button>
            <button className="lt-lyrics-btn" type="button" onClick={discard}>
              {t("lyrics.slides.discard")}
            </button>
          </div>
        </div>
      ) : (
        <button className="lt-lyrics-btn" type="button" onClick={start}>
          {t("lyrics.slides.record")}
        </button>
      )}
    </section>
  );
}
