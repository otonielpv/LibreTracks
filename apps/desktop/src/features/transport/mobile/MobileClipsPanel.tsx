import { useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteClips, duplicateClips, moveClipsBatch, splitClips, updateClipWindow } from "../desktopApi";
import type { MobilePanelProps } from "./types";
import { clipPlacements, requireSeconds, songClips } from "./preparationModel";

export function MobileClipsPanel({ song, regionId, run, positionRef }: MobilePanelProps) {
  const { t } = useTranslation();
  const [ids, setIds] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState("0");
  const [track, setTrack] = useState("");
  const [source, setSource] = useState("0");
  const [duration, setDuration] = useState("1");
  const [editing, setEditing] = useState(false);
  const clips = songClips(song, regionId);
  const selected = clips.filter((clip) => ids.includes(clip.id));
  const visible = clips.filter((clip) => `${clip.trackName} ${clip.filePath}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const select = (next: string[]) => {
    setIds(next);
    const items = clips.filter((clip) => next.includes(clip.id));
    if (!items.length) return;
    setPosition(String(Math.min(...items.map((clip) => clip.timelineStartSeconds))));
    setSource(String(items[0].sourceStartSeconds)); setDuration(String(items[0].durationSeconds));
  };
  const move = (duplicate = false) => run(async () => {
    if (track && !song.tracks.some((item) => item.id === track && item.kind === "audio")) throw new Error("missingSelection");
    const placements = clipPlacements(selected, requireSeconds(position), duplicate ? undefined : track || undefined);
    return duplicate ? duplicateClips(placements) : moveClipsBatch(placements);
  });
  return <div className={`lt-prep-columns ${editing && selected.length ? "has-inspector" : ""}`}><div>
    {selected.length > 0 && <button type="button" className="lt-prep-selection-action is-primary" onClick={() => setEditing(true)}>{t("mobilePreparation.edit")} · {t("mobilePreparation.selected", { count: selected.length })}</button>}
    <input type="search" aria-label={t("mobilePreparation.search")} placeholder={t("mobilePreparation.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
    <label className="lt-prep-check"><input type="checkbox" checked={visible.length > 0 && visible.every((clip) => ids.includes(clip.id))} onChange={(event) => select(event.target.checked ? [...new Set([...ids, ...visible.map((clip) => clip.id)])] : ids.filter((id) => !visible.some((clip) => clip.id === id)))} />{t("mobilePreparation.selectAll")}</label>
    <div className="lt-prep-list">{visible.map((clip) => <label className="lt-prep-check" key={clip.id}><input type="checkbox" checked={ids.includes(clip.id)} onChange={(event) => select(event.target.checked ? [...ids, clip.id] : ids.filter((id) => id !== clip.id))} />
      <span>{clip.filePath.split(/[\\/]/).pop()}<small>{clip.trackName} · {clip.timelineStartSeconds.toFixed(3)} s</small></span>
    </label>)}</div>{!clips.length && <p>{t("mobilePreparation.noClips")}</p>}
  </div>{editing && selected.length > 0 && <div className="lt-prep-inspector">
    <button type="button" onClick={() => setEditing(false)}>{t("mobilePreparation.done")}</button>
    <strong>{t("mobilePreparation.selected", { count: selected.length })}</strong><p>{t("mobilePreparation.clipHint")}</p>
    <label>{t("mobilePreparation.position")}<input type="number" min="0" step="0.001" value={position} onChange={(event) => setPosition(event.target.value)} /></label>
    <button type="button" onClick={() => setPosition(String(positionRef.current))}>{t("mobilePreparation.useCursor")}</button>
    <label>{t("mobilePreparation.destination")}<select value={track} onChange={(event) => setTrack(event.target.value)}><option value="">{t("mobilePreparation.keepTracks")}</option>
      {song.tracks.filter((item) => item.kind === "audio").map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
    </select></label>
    <div className="lt-prep-actions"><button type="button" onClick={() => void move()}>{t("mobilePreparation.move")}</button>
      <button type="button" onClick={() => void move(true)}>{t("mobilePreparation.duplicate")}</button>
      <button type="button" onClick={() => void run(() => splitClips(selected.map((clip) => clip.id), positionRef.current))}>{t("mobilePreparation.split")}</button></div>
    {selected.length === 1 && <><label>{t("mobilePreparation.sourceStart")}<input type="number" min="0" step="0.001" value={source} onChange={(event) => setSource(event.target.value)} /></label>
      <label>{t("mobilePreparation.duration")}<input type="number" min="0.001" step="0.001" value={duration} onChange={(event) => setDuration(event.target.value)} /></label>
      <button type="button" onClick={() => void run(async () => { const length = requireSeconds(duration); if (length <= 0) throw new Error("invalid"); return updateClipWindow(selected[0].id, requireSeconds(position), requireSeconds(source), length); })}>{t("mobilePreparation.trim")}</button></>}
    <button type="button" onClick={() => void run(() => deleteClips(selected.map((clip) => clip.id))).then((ok) => { if (ok) setIds([]); })}>{t("mobilePreparation.delete")}</button>
  </div>}</div>;
}
