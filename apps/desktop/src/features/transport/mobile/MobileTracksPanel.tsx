import { useState } from "react";
import { useTranslation } from "react-i18next";
import { commitTrackMixChange, createTrack, deleteTrack, moveTrack, updateTrack, type TrackSummary } from "../desktopApi";
import type { MobilePanelProps, MobileRun } from "./types";
import { canParentTrack } from "./preparationModel";

type Routes = Array<{ value: string; label: string }>;
function TrackEditor({ track, tracks, routes, run, onDone }: { track: TrackSummary; tracks: TrackSummary[]; routes: Routes; run: MobileRun; onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(track.name);
  const [db, setDb] = useState(track.volume > 0 ? Math.max(-60, 20 * Math.log10(track.volume)) : -60);
  const [pan, setPan] = useState(track.pan);
  const [route, setRoute] = useState(track.audioTo);
  const [before, setBefore] = useState("");
  const [parent, setParent] = useState(track.parentTrackId ?? "");
  const routeOptions = track.parentTrackId ? [{ value: "inherit", label: t("trackHeader.inherited") }, ...routes] : routes;
  const audio = track.kind !== "midi";
  return <div className="lt-prep-inspector">
    <button type="button" onClick={onDone}>{t("mobilePreparation.done")}</button>
    <label>{t("mobilePreparation.name")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
    <button type="button" disabled={!name.trim() || name === track.name} onClick={() => void run(() => updateTrack({ trackId: track.id, name: name.trim() }))}>{t("mobilePreparation.rename")}</button>
    {audio && <>
      <div className="lt-prep-actions"><button type="button" aria-pressed={track.muted} onClick={() => void run(() => commitTrackMixChange({ trackId: track.id, muted: !track.muted }))}>{t("mobilePreparation.mute")}</button>
        <button type="button" aria-pressed={track.solo} onClick={() => void run(() => commitTrackMixChange({ trackId: track.id, solo: !track.solo }))}>{t("mobilePreparation.solo")}</button></div>
      <label>{t("mobilePreparation.volume")}<input type="range" min="-60" max="6" step="0.1" value={db} onChange={(event) => setDb(Number(event.target.value))} />
        <input type="number" aria-label={t("mobilePreparation.volume")} min="-60" max="6" step="0.1" value={Number(db.toFixed(1))} onChange={(event) => setDb(event.target.valueAsNumber)} /></label>
      <label>{t("mobilePreparation.pan")}<input type="range" min="-1" max="1" step="0.01" value={pan} onChange={(event) => setPan(Number(event.target.value))} /><output>{Math.round(pan * 100)}</output></label>
      <label>{t("mobilePreparation.output")}<select value={route} onChange={(event) => setRoute(event.target.value)}>
        {!routeOptions.some((item) => item.value === route) && <option value={route}>{route} · {t("mobilePreparation.unavailable")}</option>}
        {routeOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <button type="button" className="is-primary" disabled={!Number.isFinite(db) || db < -60 || db > 6} onClick={() => void run(() => commitTrackMixChange({ trackId: track.id, volume: db <= -60 ? 0 : 10 ** (db / 20), pan, audioTo: route }))}>{t("mobilePreparation.save")}</button>
    </>}
    <label>{t("mobilePreparation.moveBefore")}<select value={before} onChange={(event) => setBefore(event.target.value)}><option value="">—</option>
      {tracks.filter((item) => item.id !== track.id && canParentTrack(tracks, track.id, item.parentTrackId ?? "")).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <button type="button" disabled={!before} onClick={() => void run(() => moveTrack({ trackId: track.id, insertBeforeTrackId: before, parentTrackId: tracks.find((item) => item.id === before)?.parentTrackId ?? null }))}>{t("mobilePreparation.move")}</button>
    <label>{t("mobilePreparation.folder")}<select value={parent} onChange={(event) => setParent(event.target.value)}><option value="">{t("mobilePreparation.root")}</option>
      {tracks.filter((item) => item.kind === "folder" && canParentTrack(tracks, track.id, item.id)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <button type="button" disabled={parent === (track.parentTrackId ?? "")} onClick={() => void run(() => moveTrack({ trackId: track.id, parentTrackId: parent || null }))}>{t("mobilePreparation.move")}</button>
    <button type="button" onClick={() => void run(() => deleteTrack(track.id))}>{t("mobilePreparation.delete")}</button>
  </div>;
}

export function MobileTracksPanel({ song, run, routes }: MobilePanelProps & { routes: Routes }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"audio" | "folder">("audio");
  const track = song.tracks.find((item) => item.id === selected);
  return <><p>{t("mobilePreparation.globalTracks")}</p><div className={`lt-prep-columns ${track ? "has-inspector" : ""}`}><div>
    <form className="lt-prep-actions" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void run(() => createTrack({ name: name.trim(), kind })).then((ok) => { if (ok) setName(""); }); }}>
      <input aria-label={t("mobilePreparation.newTrack")} placeholder={t("mobilePreparation.newTrack")} value={name} onChange={(event) => setName(event.target.value)} required />
      <select aria-label={t("mobilePreparation.kind")} value={kind} onChange={(event) => setKind(event.target.value as "audio" | "folder")}><option value="audio">{t("mobilePreparation.audioTrack")}</option><option value="folder">{t("mobilePreparation.folderTrack")}</option></select>
      <button type="submit">{t("mobilePreparation.create")}</button>
    </form>
    <input type="search" aria-label={t("mobilePreparation.search")} placeholder={t("mobilePreparation.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
    <div className="lt-prep-list">{song.tracks.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((item) => <button type="button" aria-pressed={item.id === selected} key={item.id} onClick={() => setSelected(item.id)}>
      <strong>{"↳ ".repeat(Math.min(item.depth, 3))}{item.name}</strong><small>{item.kind === "midi" ? "MIDI" : routes.find((route) => route.value === item.audioTo)?.label ?? item.audioTo}</small>
    </button>)}</div>{!song.tracks.length && <p>{t("mobilePreparation.noTracks")}</p>}
  </div>{track && <TrackEditor key={`${track.id}:${track.name}:${track.volume}:${track.pan}:${track.audioTo}:${track.parentTrackId}`} track={track} tracks={song.tracks} routes={routes} run={run} onDone={() => setSelected(null)} />}</div></>;
}
