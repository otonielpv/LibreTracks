import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { LyricsSlideTiming } from "@libretracks/shared/models";

import type { MarkerReport, RegionReport, SlideInfo } from "./lyricsApi";
import { spreadSlides } from "./lyricsEdits";
import type { LyricsHandlers } from "./lyricsHandlers";
import { captureSpaceBar, createStepRecorder, type StepRecorder } from "./lyricsStepRecorder";
import { useSlideThumbnails } from "./useSlideThumbnails";

/** How often the recorder checks whether the section is over. */
const END_POLL_MS = 100;

type Props = {
  regionId: string;
  report: RegionReport;
  marker: MarkerReport;
  handlers: LyricsHandlers;
  /** Runs a save through the panel (its "Saving… / Saved" footer). */
  onSave: (work: Promise<unknown>) => void;
  onBack: () => void;
  /** Where the space bar is caught while recording (tests pass their own). */
  keyTarget?: Window;
};

/** What a slide is called: its group, or "Title" for the title slide. */
export function slideGroup(slide: SlideInfo, t: (key: string) => string): string {
  return slide.title ? t("lyrics.section.titleSlide") : slide.groupLabel;
}

/** "Puente · Y en tu presencia": the group and the slide's first line. */
export function slideLabel(slide: SlideInfo, t: (key: string) => string): string {
  const group = slideGroup(slide, t);
  const first = slide.text.split(/\r?\n/)[0]?.trim() ?? "";
  return first ? `${group} · ${first}` : group;
}

function sameList(a: number[], b: number[]) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

type Recording = { phase: "idle" } | { phase: "recording" } | { phase: "done"; taps: number[] };

/**
 * One marker's slides: which slides of the presentation it shows (chosen
 * by hand, split among its repeats), when each one passes, and a recorder
 * for just this section. Every repeat is edited on its own.
 */
export function LyricsSectionEditor({
  regionId,
  report,
  marker,
  handlers,
  onSave,
  onBack,
  keyTarget,
}: Props) {
  const { t } = useTranslation();
  const slides = report.slides ?? [];
  const order = new Map(slides.map((slide, position) => [slide.index, position]));
  const [draft, setDraft] = useState<number[]>(marker.slides);
  const [bars, setBars] = useState(marker.timing.type === "everyBars" ? marker.timing.bars : 2);
  const [recording, setRecording] = useState<Recording>({ phase: "idle" });
  const recorder = useRef<StepRecorder | null>(null);
  const recorderBox = useRef<HTMLDivElement | null>(null);
  /** While recording: whether the playhead has reached the marker, and the
   * taps so far (the count-in bar plays first; taps there do not count). */
  const [live, setLive] = useState<{ inside: boolean; count: number }>({ inside: false, count: 0 });
  const pictures = useSlideThumbnails(
    report.link?.presentationId,
    slides.map((slide) => slide.index),
    handlers.slideThumbnails,
  );

  useEffect(() => {
    setDraft(marker.slides);
  }, [marker.slides]);

  const name =
    marker.occurrence > 0
      ? `${marker.markerName} ${t("lyrics.song.occurrence", { n: marker.occurrence + 1 })}`
      : marker.markerName;
  const siblings = report.markers
    .filter((other) => other.markerName.trim().toLowerCase() === marker.markerName.trim().toLowerCase())
    .sort((a, b) => a.startSeconds - b.startSeconds);
  const dirty = !sameList(draft, marker.slides);

  const toggle = (index: number) => {
    setDraft((current) =>
      current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    );
  };

  const saveSlides = () => onSave(handlers.setSlides(regionId, [{ markerId: marker.markerId, indexes: draft }]));
  const resetSlides = () => onSave(handlers.setSlides(regionId, [{ markerId: marker.markerId, indexes: [] }]));
  const spread = () => {
    const parts = spreadSlides(draft, siblings.length);
    onSave(
      handlers.setSlides(
        regionId,
        siblings.map((sibling, i) => ({ markerId: sibling.markerId, indexes: parts[i] ?? [] })),
      ),
    );
  };
  const setTiming = (timing: LyricsSlideTiming) =>
    onSave(handlers.setTiming(regionId, marker.markerId, timing));

  // --- Recorder -------------------------------------------------------

  const tap = () => {
    void recorder.current?.tap().then((counted) => {
      if (counted) setLive({ inside: true, count: recorder.current?.count() ?? 0 });
    });
  };

  const finish = () => {
    void handlers.pause().catch(() => {});
    setRecording({ phase: "done", taps: recorder.current?.taps() ?? [] });
  };

  useEffect(() => {
    if (recording.phase !== "recording") return () => {};
    const release = captureSpaceBar(keyTarget ?? window, tap);
    // While recording, playback does not send this song's slide changes:
    // only the taps move the slides.
    void handlers.setRecording(regionId);
    const poll = window.setInterval(() => {
      void handlers
        .tapPosition()
        .then((position) => {
          if (position >= marker.endSeconds) {
            finish();
            return;
          }
          const inside = position >= marker.startSeconds;
          setLive((current) => (current.inside === inside ? current : { ...current, inside }));
        })
        .catch(() => {});
    }, END_POLL_MS);
    return () => {
      release();
      window.clearInterval(poll);
      void handlers.setRecording(null);
    };
    // tap/finish read refs; re-binding per render is not needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording.phase, keyTarget, handlers, regionId, marker.endSeconds]);

  const record = () => {
    recorder.current = createStepRecorder({
      section: {
        markerId: marker.markerId,
        startSeconds: marker.startSeconds,
        endSeconds: marker.endSeconds,
      },
      getPosition: handlers.tapPosition,
      sendStep: (markerId, k) => void handlers.testSend(regionId, markerId, k),
    });
    setLive({ inside: false, count: 0 });
    setRecording({ phase: "recording" });
    // The tap button must be on screen without hunting for it.
    window.requestAnimationFrame(() => recorderBox.current?.scrollIntoView?.({ block: "nearest" }));
    void handlers
      .seekTo(marker.countInSeconds)
      .then(() => handlers.play())
      .catch(() => {});
  };

  const saveRecording = (taps: number[]) => {
    recorder.current = null;
    setRecording({ phase: "idle" });
    onSave(handlers.saveSectionRecording(regionId, marker.markerId, taps));
  };

  const discard = () => {
    recorder.current = null;
    setRecording({ phase: "idle" });
  };

  const timing = marker.timing;
  const multi = marker.slideCount > 1;

  return (
    <section className="lt-lyrics-section-editor" aria-label={t("lyrics.section.title", { name })}>
      <header className="lt-lyrics-section-header">
        <button type="button" className="lt-lyrics-btn" onClick={onBack}>
          <span className="material-symbols-outlined" aria-hidden="true">
            arrow_back
          </span>
          {t("lyrics.section.back")}
        </button>
        <h3>{t("lyrics.section.title", { name })}</h3>
        <button
          type="button"
          className="lt-lyrics-btn"
          disabled={marker.status === "unmatched" && !marker.customSlides}
          onClick={() => void handlers.testSend(regionId, marker.markerId, 0)}
        >
          {t("lyrics.song.test")}
        </button>
      </header>

      <h4>{t("lyrics.section.slidesHeading")}</h4>
      <small>
        {marker.customSlides
          ? t("lyrics.section.custom")
          : marker.status === "matched"
            ? t("lyrics.section.fromGroup", { group: marker.groupLabel })
            : null}{" "}
        {t("lyrics.section.slidesHelp")}
      </small>
      {slides.length === 0 ? (
        <p>{t("lyrics.section.noSlides")}</p>
      ) : (
        <ol className="lt-lyrics-slide-picker">
          {slides.map((slide) => {
            const chosen = draft.indexOf(slide.index);
            return (
              <li key={slide.index}>
                <button
                  type="button"
                  className={`lt-lyrics-slide ${chosen >= 0 ? "is-selected" : ""}`}
                  aria-pressed={chosen >= 0}
                  aria-label={slideLabel(slide, t)}
                  onClick={() => toggle(slide.index)}
                >
                  <span className="lt-lyrics-slide-head">
                    <span className="lt-lyrics-slide-group">{slideGroup(slide, t)}</span>
                    {chosen >= 0 ? <span className="lt-lyrics-slide-order">{chosen + 1}</span> : null}
                  </span>
                  <span className="lt-lyrics-slide-screen">
                    {pictures.has(slide.index) ? (
                      <img src={pictures.get(slide.index)} alt="" draggable={false} />
                    ) : (
                      <span className="lt-lyrics-slide-text">{slide.text}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      <div className="lt-lyrics-row">
        <button
          type="button"
          className="lt-lyrics-btn is-primary"
          disabled={!dirty || draft.length === 0}
          onClick={saveSlides}
        >
          {t("lyrics.section.saveSlides")}
        </button>
        {marker.customSlides ? (
          <button type="button" className="lt-lyrics-btn" onClick={resetSlides}>
            {t("lyrics.section.resetSlides")}
          </button>
        ) : null}
        {siblings.length > 1 && draft.length > 1 ? (
          <button
            type="button"
            className="lt-lyrics-btn"
            title={t("lyrics.section.spreadHelp", { count: siblings.length, name: marker.markerName })}
            onClick={spread}
          >
            {t("lyrics.section.spread", { count: siblings.length })}
          </button>
        ) : null}
      </div>

      <h4>{t("lyrics.section.timingHeading")}</h4>
      {!multi ? (
        <small>{t("lyrics.section.oneSlide")}</small>
      ) : (
        <>
          <div className="lt-lyrics-timing" role="radiogroup" aria-label={t("lyrics.section.timingHeading")}>
            <label>
              <input type="radio" checked={timing.type === "auto"} onChange={() => setTiming({ type: "auto" })} />
              {t("lyrics.section.auto")}
            </label>
            <label>
              <input
                type="radio"
                checked={timing.type === "everyBars"}
                onChange={() => setTiming({ type: "everyBars", bars })}
              />
              {t("lyrics.section.everyBars")}
              <input
                className="lt-lyrics-input lt-lyrics-bars"
                type="number"
                min={1}
                max={64}
                aria-label={t("lyrics.section.everyBarsFor")}
                value={bars}
                onChange={(event) => setBars(Math.max(1, Math.round(Number(event.target.value) || 1)))}
                onBlur={() => {
                  if (timing.type === "everyBars" && timing.bars !== bars) setTiming({ type: "everyBars", bars });
                }}
              />
              {t("lyrics.section.everyBarsUnit")}
            </label>
            <label>
              <input
                type="radio"
                checked={timing.type === "recorded"}
                onChange={() => setTiming({ type: "recorded" })}
              />
              {t("lyrics.section.recorded")}
            </label>
            <label>
              <input
                type="radio"
                checked={timing.type === "firstOnly"}
                onChange={() => setTiming({ type: "firstOnly" })}
              />
              {t("lyrics.section.firstOnly")}
            </label>
          </div>
          {timing.type !== "firstOnly" ? (
            <small>
              {marker.changePoints.length > 0
                ? t("lyrics.section.changesOn", {
                    bars: marker.changePoints.map((point) => `${point.bar}.${point.beat}`).join(" · "),
                  })
                : t("lyrics.section.noChanges")}
            </small>
          ) : null}
        </>
      )}

      {multi || recording.phase !== "idle" ? (
        <h4>{t("lyrics.section.recorderHeading")}</h4>
      ) : null}
      {recording.phase === "recording" ? (
        <div
          ref={recorderBox}
          className="lt-lyrics-recorder"
          role="group"
          aria-label={t("lyrics.section.recorderHeading")}
        >
          <p className={`lt-lyrics-recorder-status ${live.inside ? "is-live" : ""}`} role="status">
            {live.inside ? t("lyrics.section.live", { count: live.count }) : t("lyrics.section.waiting")}
          </p>
          <div className="lt-lyrics-recorder-row">
            <button type="button" className="lt-lyrics-btn lt-lyrics-tap" onClick={tap}>
              {t("lyrics.section.tap")}
            </button>
            <button type="button" className="lt-lyrics-btn lt-lyrics-stop" onClick={finish}>
              <span className="material-symbols-outlined" aria-hidden="true">
                stop
              </span>
              {t("lyrics.section.stop")}
            </button>
          </div>
        </div>
      ) : recording.phase === "done" ? (
        <div className="lt-lyrics-recorder" role="group" aria-label={t("lyrics.section.recorderHeading")}>
          <p>
            {recording.taps.length > 0
              ? t("lyrics.section.taps", { count: recording.taps.length })
              : t("lyrics.section.tapsNone")}
          </p>
          <div className="lt-lyrics-row">
            <button
              type="button"
              className="lt-lyrics-btn is-primary"
              disabled={recording.taps.length === 0}
              onClick={() => saveRecording(recording.taps)}
            >
              {t("lyrics.section.save")}
            </button>
            <button type="button" className="lt-lyrics-btn" onClick={record}>
              {t("lyrics.section.again")}
            </button>
            <button type="button" className="lt-lyrics-btn" onClick={discard}>
              {t("lyrics.section.discard")}
            </button>
          </div>
        </div>
      ) : !multi ? null : (
        <>
          <small>{t("lyrics.section.recorderHelp")}</small>
          <button type="button" className="lt-lyrics-btn lt-lyrics-record" onClick={record}>
            <span className="material-symbols-outlined" aria-hidden="true">
              fiber_manual_record
            </span>
            {t("lyrics.section.record")}
          </button>
        </>
      )}
    </section>
  );
}
