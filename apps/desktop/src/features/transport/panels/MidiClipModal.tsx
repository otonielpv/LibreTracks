import { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  MidiClipSummary,
  MidiEventKindSummary,
  MidiEventSummary,
  SongView,
} from "../desktopApi";
import { formatClock } from "../helpers";

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

type MidiClipModalProps = {
  draft: MidiClipDraft | null;
  song: SongView | null;
  onCancel: () => void;
  /**
   * Receives the whole clip, not just the edited fields: the draft already
   * carries the track and position, so echoing them back here keeps the caller
   * from having to re-assemble the clip around the modal's result.
   */
  onConfirm: (result: {
    clipId: string | null;
    trackId: string;
    timelineStartSeconds: number;
    name: string;
    events: MidiEventSummary[];
  }) => void;
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

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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
  onConfirm,
}: MidiClipModalProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<MidiEventSummary[]>(
    () => draft?.events ?? [],
  );
  const [name, setName] = useState(() => draft?.name ?? "");

  if (!draft) {
    return null;
  }

  const isEditing = draft.clipId !== null;
  const track = song?.tracks.find((candidate) => candidate.id === draft.trackId);
  const trackName = track?.name ?? draft.trackId;
  // Shown as the channel field's placeholder so an empty box reads as "this
  // message goes out on the track's channel", not as "no channel".
  const inheritedChannelLabel = t("transport.midi.channelInherited", {
    channel: track?.midiChannel ?? 1,
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
            <ol className="lt-automation-action-list">
              {events.map((event, index) => (
                <li key={event.id} className="lt-automation-action-row">
                  <div className="lt-automation-action-head">
                    <select
                      value={event.kind.type}
                      aria-label={t("transport.midi.eventType")}
                      onChange={(e) =>
                        changeType(index, e.target.value as MidiEventKindSummary["type"])
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
                      className="lt-automation-action-remove"
                      onClick={() => removeAt(index)}
                      aria-label={t("transport.midi.removeEvent")}
                    >
                      ✕
                    </button>
                  </div>

                  <div className="lt-automation-action-fields">
                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">{t("transport.midi.offsetSeconds")}</span>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={event.atSeconds}
                        onChange={(e) =>
                          updateAt(index, {
                            ...event,
                            atSeconds: Math.max(0, Number(e.target.value) || 0),
                          })
                        }
                      />
                    </label>
                    {/* Blank = inherit the track's channel, which is the
                        normal case; a number overrides it for this message
                        alone. Labelled as optional so it doesn't read as a
                        required field the user forgot to fill in. */}
                    <label className="lt-settings-field">
                      <span className="lt-settings-field-label">
                        {t("transport.midi.channelOverride")}
                      </span>
                      <small className="lt-settings-field-hint">
                        {t("transport.midi.channelOverrideHint")}
                      </small>
                      <input
                        type="number"
                        min={1}
                        max={16}
                        placeholder={inheritedChannelLabel}
                        value={event.channel ?? ""}
                        onChange={(e) =>
                          updateAt(index, {
                            ...event,
                            channel:
                              e.target.value.trim() === ""
                                ? null
                                : clamp(Number(e.target.value) || 1, 1, 16),
                          })
                        }
                      />
                    </label>

                    {event.kind.type === "note" && (
                      <>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.note")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.note}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "note",
                                note: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.velocity")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.velocity}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "note",
                                velocity: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.durationSeconds")}</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={event.kind.durationSeconds}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "note",
                                durationSeconds: Math.max(0, Number(e.target.value) || 0),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                      </>
                    )}

                    {event.kind.type === "controlChange" && (
                      <>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.controller")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.controller}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlChange",
                                controller: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.value")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.value}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlChange",
                                value: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                      </>
                    )}

                    {event.kind.type === "programChange" && (
                      <label className="lt-settings-field">
                        <span className="lt-settings-field-label">{t("transport.midi.program")}</span>
                        <input
                          type="number"
                          min={0}
                          max={127}
                          value={event.kind.program}
                          onChange={(e) =>
                            updateKind(index, {
                              ...event.kind,
                              type: "programChange",
                              program: clamp(Number(e.target.value) || 0, 0, 127),
                            } as MidiEventKindSummary)
                          }
                        />
                      </label>
                    )}

                    {event.kind.type === "controlCurve" && (
                      <>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.controller")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.controller}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlCurve",
                                controller: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.fromValue")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.fromValue}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlCurve",
                                fromValue: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.toValue")}</span>
                          <input
                            type="number"
                            min={0}
                            max={127}
                            value={event.kind.toValue}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlCurve",
                                toValue: clamp(Number(e.target.value) || 0, 0, 127),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                        <label className="lt-settings-field">
                          <span className="lt-settings-field-label">{t("transport.midi.durationSeconds")}</span>
                          <input
                            type="number"
                            min={0}
                            step={0.01}
                            value={event.kind.durationSeconds}
                            onChange={(e) =>
                              updateKind(index, {
                                ...event.kind,
                                type: "controlCurve",
                                durationSeconds: Math.max(0, Number(e.target.value) || 0),
                              } as MidiEventKindSummary)
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}

          <div className="lt-automation-add-row">
            {EVENT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="lt-secondary-button"
                onClick={() => addEvent(type)}
              >
                + {t(EVENT_LABEL_KEYS[type])}
              </button>
            ))}
          </div>
        </div>

        <div className="lt-inline-actions lt-automation-modal-actions">
          <button type="button" className="lt-secondary-button" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!canConfirm}
            onClick={() =>
              onConfirm({
                clipId: draft.clipId,
                trackId: draft.trackId,
                timelineStartSeconds: draft.timelineStartSeconds,
                name,
                events,
              })
            }
          >
            {t("common.save")}
          </button>
        </div>
      </section>
    </div>
  );
}
