import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MidiClipSummary,
  MidiEventKindSummary,
  MidiEventSummary,
  SongView,
} from "../desktopApi";
import { formatClock } from "../helpers";
import { MidiEventFields, describeEvent } from "./MidiEventFields";

/**
 * What the modal is editing. `clipId` is present when editing an existing clip.
 */
export type MidiClipDraft = {
  clipId: string | null;
  trackId: string;
  timelineStartSeconds: number;
  name: string;
  events: MidiEventSummary[];
};

export type MidiClipModalResult = {
  clipId: string | null;
  trackId: string;
  timelineStartSeconds: number;
  name: string;
  events: MidiEventSummary[];
};

type MidiClipModalProps = {
  draft: MidiClipDraft | null;
  song: SongView | null;
  onCancel: () => void;
  /**
   * Receives the whole clip, not just the edited fields: the draft already
   * carries the track and position, so echoing them back here keeps the caller
   * from having to re-assemble the clip around the modal's result.
   */
  /** Fire the current form values without saving them. */
  onTest?: (result: MidiClipModalResult) => void;
  onConfirm: (result: MidiClipModalResult) => void;
};

const EVENT_TYPES: MidiEventKindSummary["type"][] = [
  "note",
  "controlChange",
  "programChange",
  "controlCurve",
];

const EVENT_LABEL_KEYS: Record<MidiEventKindSummary["type"], string> = {
  note: "transport.midi.eventNote",
  controlChange: "transport.midi.eventControlChange",
  programChange: "transport.midi.eventProgramChange",
  controlCurve: "transport.midi.eventControlCurve",
};

let eventCounter = 0;
function nextEventId() {
  eventCounter += 1;
  return `midi_event_${Date.now()}_${eventCounter}`;
}

/** A fresh event of the given type, seeded with values that do something audible. */
function makeEvent(type: MidiEventKindSummary["type"]): MidiEventSummary {
  // channel omitted on purpose: a new message inherits the track's channel,
  // which is what makes "one track = one destination" work without repeating
  // the channel on every row.
  const base = { id: nextEventId(), atSeconds: 0, channel: null };
  switch (type) {
    case "note":
      return {
        ...base,
        kind: { type: "note", note: 60, velocity: 100, durationSeconds: 0.5 },
      };
    case "controlChange":
      return { ...base, kind: { type: "controlChange", controller: 1, value: 64 } };
    case "programChange":
      return { ...base, kind: { type: "programChange", program: 0 } };
    case "controlCurve":
      return {
        ...base,
        kind: {
          type: "controlCurve",
          controller: 1,
          fromValue: 0,
          toValue: 127,
          durationSeconds: 4,
        },
      };
  }
}

/**
 * Editor for one MIDI clip: a list of messages fired when the playhead reaches
 * the clip. Deliberately not a piano roll — several notes at the same offset
 * are just several rows, which is the shape a multitrack player needs to drive
 * lighting desks and lyric software.
 */
export function MidiClipModal({
  draft,
  song,
  onCancel,
  onTest,
  onConfirm,
}: MidiClipModalProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<MidiEventSummary[]>(
    () => draft?.events ?? [],
  );
  const [name, setName] = useState(() => draft?.name ?? "");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [pendingType, setPendingType] =
    useState<MidiEventKindSummary["type"]>("note");

  if (!draft) {
    return null;
  }

  const isEditing = draft.clipId !== null;
  const track = song?.tracks.find((candidate) => candidate.id === draft.trackId);
  const trackName = track?.name ?? draft.trackId;
  // Shown as the channel field's placeholder so an empty box reads as "this
  // message goes out on the track's channel", not as "no channel".
  const inheritedChannel = track?.midiChannel ?? 1;
  const inheritedChannelLabel = t("transport.midi.channelInherited", {
    channel: inheritedChannel,
  });

  const toggleCollapsed = (eventId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });

  /** Swap a message with its neighbour. Order matters for same-offset events. */
  const move = (index: number, delta: number) =>
    setEvents((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });

  const updateAt = (index: number, event: MidiEventSummary) =>
    setEvents((prev) => prev.map((item, i) => (i === index ? event : item)));

  const updateKind = (index: number, kind: MidiEventKindSummary) =>
    setEvents((prev) =>
      prev.map((item, i) => (i === index ? { ...item, kind } : item)),
    );

  const removeAt = (index: number) =>
    setEvents((prev) => prev.filter((_, i) => i !== index));

  const addEvent = (type: MidiEventKindSummary["type"]) =>
    setEvents((prev) => [...prev, makeEvent(type)]);

  const changeType = (index: number, type: MidiEventKindSummary["type"]) =>
    setEvents((prev) =>
      prev.map((item, i) =>
        i === index ? { ...makeEvent(type), id: item.id, atSeconds: item.atSeconds, channel: item.channel } : item,
      ),
    );

  const canConfirm = events.length > 0;
  const currentResult = (): MidiClipModalResult => ({
    clipId: draft.clipId,
    trackId: draft.trackId,
    timelineStartSeconds: draft.timelineStartSeconds,
    name,
    events,
  });

  return (
    <div className="lt-modal-backdrop" onClick={onCancel}>
      <section
        className="lt-settings-modal lt-automation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-midi-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.midi.modalEyebrow")}
            </span>
            <h2 id="lt-midi-modal-title">
              {t(
                isEditing
                  ? "transport.midi.modalEditTitle"
                  : "transport.midi.modalNewTitle",
              )}
            </h2>
            <p>
              {t("transport.midi.modalAtTime", {
                time: formatClock(draft.timelineStartSeconds),
                track: trackName,
              })}
            </p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-automation-actions-body">
          <label className="lt-settings-field lt-midi-name-field">
            <span className="lt-settings-field-label">
              {t("transport.midi.clipName")}
            </span>
            <input
              type="text"
              value={name}
              placeholder={t("transport.midi.clipNamePlaceholder")}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          {events.length === 0 ? (
            <p className="lt-automation-empty">{t("transport.midi.modalEmpty")}</p>
          ) : (
            events.map((event, index) => {
              const isCollapsed = collapsed.has(event.id);
              return (
                <div className="lt-automation-action-row" key={event.id}>
                  <div className="lt-automation-action-head">
                    {/* The whole header toggles the row, so a long list of
                        messages can be folded down to one line each. */}
                    <button
                      type="button"
                      className="lt-midi-event-toggle"
                      aria-expanded={!isCollapsed}
                      onClick={() => toggleCollapsed(event.id)}
                    >
                      <span className="lt-midi-event-caret">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      <span className="lt-automation-action-kind">
                        {t(EVENT_LABEL_KEYS[event.kind.type])}
                      </span>
                      <span className="lt-midi-event-summary">
                        {describeEvent(event, t, inheritedChannel)}
                      </span>
                    </button>
                    <div className="lt-automation-action-tools">
                      <button
                        type="button"
                        aria-label={t("transport.automation.moveUp")}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={t("transport.automation.moveDown")}
                        disabled={index >= events.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        aria-label={t("transport.midi.removeEvent")}
                        onClick={() => removeAt(index)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {isCollapsed ? null : (
                    <MidiEventFields
                      event={event}
                      index={index}
                      inheritedChannelLabel={inheritedChannelLabel}
                      t={t}
                      onChangeType={changeType}
                      onChange={updateAt}
                      onChangeKind={updateKind}
                    />
                  )}
                </div>
              );
            })
          )}

          {/* One "add" control instead of four buttons: the type is picked in
              the dropdown, which is where it is edited afterwards anyway. */}
          <div className="lt-automation-add-row">
            <span className="lt-settings-field-label">
              {t("transport.midi.addMessage")}
            </span>
            <div className="lt-midi-add-control">
              <select
                value={pendingType}
                aria-label={t("transport.midi.eventType")}
                onChange={(e) =>
                  setPendingType(e.target.value as MidiEventKindSummary["type"])
                }
              >
                {EVENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(EVENT_LABEL_KEYS[type])}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="is-primary"
                onClick={() => addEvent(pendingType)}
              >
                + {t("common.create")}
              </button>
            </div>
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          {/* Preview uses this live form state and never persists the draft. */}
          {onTest ? (
            <button
              type="button"
              className="lt-secondary-button"
              title={t("transport.midi.testClipHint")}
              disabled={!canConfirm}
              onClick={() => onTest(currentResult())}
            >
              {t("transport.midi.testClip")}
            </button>
          ) : null}
          <button type="button" className="lt-secondary-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!canConfirm}
            onClick={() => onConfirm(currentResult())}
          >
            {t("common.save")}
          </button>
        </div>
      </section>
    </div>
  );
}
