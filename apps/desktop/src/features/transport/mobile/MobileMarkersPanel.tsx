import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createSectionMarker, deleteSectionMarker, seekTransport, updateSectionMarker, type MarkerKind, type SectionMarkerSummary } from "../desktopApi";
import { MARKER_KINDS, CUE_KINDS, markerKindLabel, markerKindVariants } from "../markerKinds";
import type { MobilePanelProps } from "./types";
import { requireSeconds } from "./preparationModel";

export function MobileMarkersPanel({ song, regionId, run, positionRef, normalizeSeconds }: MobilePanelProps & { normalizeSeconds: (seconds: number, duration: number) => number }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<{ id?: string; name: string; seconds: string; kind: MarkerKind; variant: number | null } | null>(null);
  const region = song.regions.find((item) => item.id === regionId);
  const markers = [...song.sectionMarkers].filter((marker) => !region || (marker.startSeconds >= region.startSeconds && marker.startSeconds < region.endSeconds)).sort((a, b) => a.startSeconds - b.startSeconds);
  const edit = (marker?: SectionMarkerSummary) => setDraft({ id: marker?.id, name: marker?.name ?? "", seconds: String(marker?.startSeconds ?? positionRef.current), kind: marker?.kind ?? "custom", variant: marker?.variant ?? null });
  const save = async () => {
    if (!draft) return;
    const success = await run(async () => {
      const seconds = requireSeconds(draft.seconds);
      if (draft.id) {
        if (!song.sectionMarkers.some((marker) => marker.id === draft.id)) throw new Error("missingSelection");
        if (!draft.name.trim()) throw new Error("invalid");
        return updateSectionMarker(draft.id, draft.name.trim(), seconds);
      }
      return createSectionMarker(seconds, { kind: draft.kind, variant: draft.variant, name: draft.name.trim() || undefined });
    });
    if (success) setDraft(null);
  };
  return <div className={`lt-prep-columns ${draft ? "has-inspector" : ""}`}>
    <div><button type="button" className="is-primary" onClick={() => edit()}>{t("mobilePreparation.newMarker")}</button>
      <p>{t("mobilePreparation.markerHint")}</p>
      <div className="lt-prep-list">{markers.map((marker) => <div className="lt-prep-row" key={marker.id}>
        <button type="button" onClick={() => edit(marker)}><strong>{marker.name}</strong><small>{marker.startSeconds.toFixed(3)} s</small></button>
        <button type="button" aria-label={`${t("mobilePreparation.listen")} · ${marker.name}`} onClick={() => void run(() => seekTransport(marker.startSeconds))}>▶</button>
      </div>)}</div>{!markers.length && <p>{t("mobilePreparation.noMarkers")}</p>}
    </div>
    {draft && <form className="lt-prep-inspector" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>{t("mobilePreparation.name")}<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      {!draft.id && <><label>{t("mobilePreparation.kind")}<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as MarkerKind, variant: null })}>
        {[...new Set([...MARKER_KINDS, ...CUE_KINDS])].map((kind) => <option key={kind} value={kind}>{markerKindLabel(kind, t)}</option>)}
      </select></label>{markerKindVariants(draft.kind).length > 0 && <select aria-label={t("mobilePreparation.kind")} value={draft.variant ?? ""} onChange={(event) => setDraft({ ...draft, variant: event.target.value ? Number(event.target.value) : null })}>
        <option value="">{markerKindLabel(draft.kind, t)}</option>{markerKindVariants(draft.kind).map((variant) => <option key={variant} value={variant}>{markerKindLabel(draft.kind, t)} {variant}</option>)}
      </select>}</>}
      <label>{t("mobilePreparation.position")}<input type="number" min="0" step="0.001" required value={draft.seconds} onChange={(event) => setDraft({ ...draft, seconds: event.target.value })} /></label>
      <div className="lt-prep-actions"><button type="button" onClick={() => setDraft({ ...draft, seconds: String(positionRef.current) })}>{t("mobilePreparation.useCursor")}</button>
        <button type="button" onClick={() => { const seconds = Number(draft.seconds); if (draft.seconds.trim() && Number.isFinite(seconds) && seconds >= 0) setDraft({ ...draft, seconds: String(normalizeSeconds(seconds, Math.max(song.durationSeconds, seconds))) }); }}>{t("mobilePreparation.snap")}</button></div>
      <div className="lt-prep-actions"><button type="submit" className="is-primary">{t("mobilePreparation.save")}</button><button type="button" onClick={() => setDraft(null)}>{t("mobilePreparation.cancel")}</button>
        {draft.id && <button type="button" onClick={() => void run(() => deleteSectionMarker(draft.id!)).then((ok) => { if (ok) setDraft(null); })}>{t("mobilePreparation.delete")}</button>}</div>
    </form>}
  </div>;
}
