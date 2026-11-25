import { useState } from "react";
import { useTranslation } from "react-i18next";

import { formatAudioRouteLabel } from "../helpers";
import type { LevelTrackGroup } from "./levelSongsPlan";

type Props = {
  groups: LevelTrackGroup[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onSetMany: (ids: string[], on: boolean) => void;
};

/**
 * Which tracks count, one collapsible row per song. Folded, a setlist of ten
 * songs is ten lines that say what each song measures and what it leaves out;
 * a song opens only to change something in it. The shared group (tracks heard
 * in several songs, usually the click) starts open: it is the one that most
 * needs a look.
 */
export function LevelTrackPicker({ groups, selected, onToggle, onSetMany }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(groups.length === 1 ? [groups[0].key] : ["shared"]),
  );
  const toggleOpen = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <ul className="lt-render-track-list lt-level-songs-groups">
      {groups.map((group) => {
        const ids = group.tracks.map((track) => track.id);
        const on = ids.filter((id) => selected.has(id)).length;
        const left = group.tracks.filter((track) => !selected.has(track.id));
        const isOpen = open.has(group.key);
        const title = group.region
          ? group.region.name
          : t("transport.levelSongs.sharedTracks");
        return (
          <li key={group.key} className="lt-level-songs-group">
            <div className="lt-level-songs-group-header">
              <input
                type="checkbox"
                aria-label={title}
                checked={on === ids.length}
                ref={(input) => {
                  if (input) input.indeterminate = on > 0 && on < ids.length;
                }}
                onChange={() => onSetMany(ids, on !== ids.length)}
              />
              <button
                type="button"
                className="lt-level-songs-group-toggle"
                aria-expanded={isOpen}
                onClick={() => toggleOpen(group.key)}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {isOpen ? "expand_more" : "chevron_right"}
                </span>
                <span className="lt-level-songs-group-title">{title}</span>
                <span className="lt-level-songs-group-summary">
                  {t("transport.levelSongs.groupCount", { count: on, total: ids.length })}
                  {left.length > 0
                    ? ` · ${t("transport.levelSongs.groupLeftOut", {
                        tracks: left.map((track) => track.name).join(", "),
                      })}`
                    : ""}
                </span>
              </button>
            </div>
            {isOpen ? (
              <ul className="lt-render-track-grid lt-level-songs-track-grid">
                {group.tracks.map((track) => (
                  <li key={track.id}>
                    <label
                      className={`lt-render-track${track.exclusion ? " is-excluded" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(track.id)}
                        onChange={() => onToggle(track.id)}
                      />
                      <span
                        className="lt-render-track-swatch"
                        style={{ background: track.color ?? "var(--lt-accent)" }}
                        aria-hidden="true"
                      />
                      <span className="lt-render-track-name">{track.name}</span>
                      <span className="lt-level-songs-tag">
                        {track.exclusion
                          ? t(`transport.levelSongs.exclusion.${track.exclusion}`)
                          : formatAudioRouteLabel(track.route, t)}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
