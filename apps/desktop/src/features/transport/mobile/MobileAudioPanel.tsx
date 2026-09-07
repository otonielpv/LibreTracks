import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createAudioTracksWithClips, createClipsBatch, type LibraryAssetSummary } from "../desktopApi";
import type { MobilePanelProps } from "./types";
import { requireSeconds } from "./preparationModel";

export function MobileAudioPanel({ song, regionId, run, positionRef, assets, onImport, importing, importMessage }:
  MobilePanelProps & { assets: LibraryAssetSummary[]; onImport: () => unknown; importing: boolean; importMessage?: string }) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [destination, setDestination] = useState(regionId ? "song" : "cursor");
  const [position, setPosition] = useState(String(positionRef.current));
  const [trackId, setTrackId] = useState("");
  const [placing, setPlacing] = useState(false);
  const region = song.regions.find((item) => item.id === regionId);
  const available = assets.filter((asset) => !asset.isMissing);
  const visible = available.filter((asset) => asset.fileName.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const chosen = available.filter((asset) => selected.includes(asset.filePath));
  const add = async () => {
    const success = await run(async () => {
      if (!chosen.length) throw new Error("selectionRequired");
      if (destination === "song" && !region) throw new Error("missingSelection");
      if (trackId && !song.tracks.some((track) => track.id === trackId && track.kind === "audio")) throw new Error("missingSelection");
      const seconds = destination === "song" ? region!.startSeconds : requireSeconds(position);
      if (trackId) return createClipsBatch(chosen.map((asset) => ({ filePath: asset.filePath, trackId, timelineStartSeconds: seconds })));
      return createAudioTracksWithClips(chosen.map((asset) => ({ filePath: asset.filePath,
        trackName: asset.fileName.replace(/\.[^.]+$/, ""), timelineStartSeconds: seconds })));
    });
    if (success) { setSelected([]); setPlacing(false); }
  };
  return <div className={`lt-prep-columns ${placing ? "has-inspector" : ""}`}>
    <div>
      {chosen.length > 0 && <button type="button" className="lt-prep-selection-action is-primary" onClick={() => setPlacing(true)}>{t("mobilePreparation.add")} · {t("mobilePreparation.selected", { count: chosen.length })}</button>}
      <button type="button" className="is-primary" onClick={onImport} disabled={importing}>{t("mobilePreparation.import")}</button>
      {importing && <p role="status">{importMessage || t("mobilePreparation.working")}</p>}
      <input type="search" aria-label={t("mobilePreparation.search")} placeholder={t("mobilePreparation.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
      <label className="lt-prep-check"><input type="checkbox" checked={visible.length > 0 && visible.every((asset) => selected.includes(asset.filePath))}
        onChange={(event) => setSelected(event.target.checked ? [...new Set([...selected, ...visible.map((asset) => asset.filePath)])] : selected.filter((path) => !visible.some((asset) => asset.filePath === path)))} />{t("mobilePreparation.selectAll")}</label>
      <div className="lt-prep-list">{visible.map((asset) => <label key={asset.filePath} className="lt-prep-check">
        <input type="checkbox" checked={selected.includes(asset.filePath)} onChange={(event) => setSelected(event.target.checked ? [...selected, asset.filePath] : selected.filter((path) => path !== asset.filePath))} />
        <span>{asset.fileName}<small>{asset.durationSeconds.toFixed(1)} s</small></span>
      </label>)}</div>
      {!available.length && <p>{t("mobilePreparation.noAudio")}</p>}
    </div>
    {placing && <div className="lt-prep-inspector">
      <strong>{t("mobilePreparation.selected", { count: chosen.length })}</strong>
      <label>{t("mobilePreparation.destination")}<select value={destination} onChange={(event) => setDestination(event.target.value)}>
        {region && <option value="song">{region.name} · {t("mobilePreparation.atStart")} ({region.startSeconds.toFixed(3)} s)</option>}
        <option value="cursor">{t("mobilePreparation.position")}</option>
      </select></label>
      {destination === "cursor" && <><label>{t("mobilePreparation.position")}<input type="number" min="0" step="0.001" value={position} onChange={(event) => setPosition(event.target.value)} /></label>
        <button type="button" onClick={() => setPosition(String(positionRef.current))}>{t("mobilePreparation.useCursor")}</button></>}
      <label>{t("mobilePreparation.tracks")}<select value={trackId} onChange={(event) => setTrackId(event.target.value)}>
        <option value="">{t("mobilePreparation.addStems")}</option>
        {song.tracks.filter((track) => track.kind === "audio").map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
      </select></label>
      {!trackId && <p>{t("mobilePreparation.alignHint")}</p>}
      <button type="button" className="is-primary" disabled={!chosen.length} onClick={() => void add()}>{t("mobilePreparation.add")}</button>
      <button type="button" onClick={() => setPlacing(false)}>{t("mobilePreparation.cancel")}</button>
    </div>}
  </div>;
}
