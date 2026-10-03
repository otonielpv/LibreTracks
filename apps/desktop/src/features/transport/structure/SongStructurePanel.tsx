import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { markerCategory, type SongView } from "@libretracks/shared/models";

import { confirmDialog, promptDialog } from "../../../shared/dialog/dialogService";
import { useSongStore } from "../songStore";
import { SongStructureEditor } from "./SongStructureEditor";
import {
  closeStructureEditor,
  draftForArrangement,
  draftFromOriginal,
  initialDraft,
  isDraftDirty,
  loadDraft,
  markDraftSaved,
  newArrangementId,
  nextArrangementName,
  sectionLabel,
  toArrangementInput,
  updateDraft,
} from "./structureEditor";
import type { StructureHandlers } from "./structureHandlers";
import { draftsEqual, useStructureStore } from "./structureStore";
import type { SongStructureSummary } from "./types";

import "./structure.css";

/** Section markers inside a song that has no original yet (the preview shown
 * before "Save as original"). Uses `markerCategory`, never the kind alone, so
 * a marker dragged into the cue lane does not count. */
export function detectedSections(song: SongView | null, regionId: string) {
  const region = song?.regions.find((candidate) => candidate.id === regionId);
  if (!song || !region) return [];
  return song.sectionMarkers
    .filter(
      (marker) =>
        markerCategory(marker) === "section" &&
        marker.startSeconds >= region.startSeconds - 0.001 &&
        marker.startSeconds < region.endSeconds,
    )
    .sort((left, right) => left.startSeconds - right.startSeconds);
}

/** Ask before throwing away unapplied changes. Resolves `true` when it is fine
 * to go on. */
export async function confirmDiscardChanges(
  t: (key: string) => string,
): Promise<boolean> {
  if (!isDraftDirty()) return true;
  return confirmDialog(t("transport.structure.closeWithChanges"));
}

type SongStructurePanelProps = {
  handlers: StructureHandlers;
};

/**
 * Desktop arrangement editor: a docked panel over the bottom of the timeline.
 * Opened from the song menu ("Arrangement") or the compact view's arrangement
 * indicator. The edits stay local until "Apply".
 */
export function SongStructurePanel({ handlers }: SongStructurePanelProps) {
  const { t } = useTranslation();
  const regionId = useStructureStore((state) => state.editorRegionId);
  const draft = useStructureStore((state) => state.draft);
  const savedDraft = useStructureStore((state) => state.savedDraft);
  const selectedBlockId = useStructureStore((state) => state.selectedBlockId);
  const report = useStructureStore((state) => state.report);
  const region = useSongStore((state) =>
    regionId ? state.song?.regions.find((candidate) => candidate.id === regionId) ?? null : null,
  );
  const song = useSongStore((state) => state.song);
  const structure: SongStructureSummary | undefined = region?.structure;

  // The song disappeared (deleted, another session): nothing to edit.
  useEffect(() => {
    if (regionId && song && !region) closeStructureEditor();
  }, [region, regionId, song]);

  // First open, or the original was just captured: start a working copy.
  useEffect(() => {
    if (!regionId || !structure || draft?.regionId === regionId) return;
    const { draft: initial, saved } = initialDraft(regionId, structure, t);
    loadDraft(initial, saved);
  }, [draft?.regionId, regionId, structure, t]);

  const detected = useMemo(
    () => (regionId && !structure ? detectedSections(song, regionId) : []),
    [regionId, song, structure],
  );

  if (!regionId || !region) return null;

  const dirty = draft !== null && !draftsEqual(draft, savedDraft);
  const appliedId = structure?.appliedArrangementId ?? null;
  const draftIsApplied = draft?.arrangementId != null && draft.arrangementId === appliedId;
  const warnings = report?.regionId === regionId ? report.warnings : [];
  const sectionName = (markerId: string) => {
    const section = structure?.sections.find((s) => s.markerId === markerId);
    if (section) return sectionLabel(section, t);
    return song?.sectionMarkers.find((m) => m.id === markerId)?.name ?? markerId;
  };

  const close = async () => {
    if (await confirmDiscardChanges(t)) closeStructureEditor();
  };

  const apply = async () => {
    if (!draft || draft.blocks.length === 0) return;
    const id = draft.arrangementId ?? newArrangementId();
    const ok = await handlers.saveArrangement(regionId, toArrangementInput(draft, id), true);
    if (ok) markDraftSaved(id);
  };

  const switchTo = async (arrangementId: string) => {
    if (!structure || arrangementId === draft?.arrangementId) return;
    if (!(await confirmDiscardChanges(t))) return;
    const arrangement = structure.arrangements.find((a) => a.id === arrangementId);
    if (arrangement) {
      const next = draftForArrangement(regionId, arrangement);
      loadDraft(next, next);
    }
  };

  const createNew = async () => {
    if (!structure || !(await confirmDiscardChanges(t))) return;
    loadDraft(draftFromOriginal(regionId, structure, nextArrangementName(structure, t)), null);
  };

  const rename = async () => {
    if (!draft) return;
    const name = (await promptDialog(t("transport.structure.renamePrompt"), draft.name))?.trim();
    if (!name) return;
    updateDraft((d) => ({ ...d, name }));
    // A saved arrangement is renamed right away (it does not change the
    // timeline); the blocks keep their unapplied changes, if any.
    if (draft.arrangementId && savedDraft) {
      const ok = await handlers.saveArrangement(
        regionId,
        toArrangementInput({ ...savedDraft, name }, draft.arrangementId),
        false,
      );
      if (ok) {
        useStructureStore.setState((state) => ({
          savedDraft: state.savedDraft ? { ...state.savedDraft, name } : null,
        }));
      }
    }
  };

  const remove = async () => {
    if (!draft?.arrangementId || !structure) return;
    if (!(await confirmDialog(t("transport.structure.deleteConfirm", { name: draft.name })))) {
      return;
    }
    await handlers.deleteArrangement(regionId, draft.arrangementId);
    loadDraft(draftFromOriginal(regionId, structure, nextArrangementName(structure, t)), null);
  };

  return (
    <aside
      className="lt-structure-panel"
      role="dialog"
      aria-label={t("transport.structure.panelTitle", { song: region.name })}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          void close();
        }
      }}
    >
      <header className="lt-structure-header">
        <h2>{t("transport.structure.panelTitle", { song: region.name })}</h2>
        {dirty ? (
          <span className="lt-structure-dirty">{t("transport.structure.unappliedChanges")}</span>
        ) : null}
        <button
          type="button"
          className="lt-structure-close material-symbols-outlined"
          aria-label={t("transport.structure.close")}
          onClick={() => void close()}
        >
          close
        </button>
      </header>

      {warnings.length > 0 ? (
        <ul className="lt-structure-warnings" aria-label={t("transport.structure.warnings.title")}>
          {warnings.map((warning) => (
            <li key={`${warning.kind}:${warning.markerId}:${warning.clipId ?? ""}`}>
              <span>
                {warning.kind === "offBeatSection"
                  ? t("transport.structure.warnings.offBeat", { name: sectionName(warning.markerId) })
                  : t("transport.structure.warnings.midiCrosses", {
                      name: sectionName(warning.markerId),
                    })}
              </span>
              {warning.kind === "offBeatSection" && warning.suggestedStartSeconds !== null ? (
                <button
                  type="button"
                  onClick={() =>
                    void handlers.snapSectionToBar(
                      regionId,
                      { id: warning.markerId, name: sectionName(warning.markerId) },
                      warning.suggestedStartSeconds ?? 0,
                    )
                  }
                >
                  {t("transport.structure.warnings.snapToBar")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {!structure ? (
        <div className="lt-structure-capture">
          <p>{t("transport.structure.noOriginal")}</p>
          <div className="lt-structure-caption">
            <strong>{t("transport.structure.detectedSections")}</strong>
          </div>
          <ol className="lt-structure-detected">
            {detected.map((marker) => (
              <li key={marker.id}>{marker.name}</li>
            ))}
          </ol>
          {detected.length < 2 ? (
            <p className="lt-structure-hint">{t("transport.structure.needTwoSections")}</p>
          ) : null}
          <button
            type="button"
            className="is-primary"
            disabled={detected.length < 2}
            onClick={() => void handlers.captureOriginal(regionId)}
          >
            {t("transport.structure.captureOriginal")}
          </button>
        </div>
      ) : draft ? (
        <>
          <div className="lt-structure-toolbar">
            <label>
              <span>{t("transport.structure.selector")}</span>
              <select
                value={draft.arrangementId ?? ""}
                onChange={(event) => void switchTo(event.target.value)}
              >
                {draft.arrangementId === null ? <option value="">{draft.name}</option> : null}
                {structure.arrangements.map((arrangement) => (
                  <option key={arrangement.id} value={arrangement.id}>
                    {arrangement.id === appliedId
                      ? `${arrangement.name} · ${t("transport.structure.appliedBadge")}`
                      : arrangement.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void createNew()}>
              {t("transport.structure.newArrangement")}
            </button>
            <button type="button" onClick={() => void rename()}>
              {t("transport.structure.rename")}
            </button>
            <button type="button" disabled={!draft.arrangementId} onClick={() => void remove()}>
              {t("transport.structure.delete")}
            </button>
          </div>
          <SongStructureEditor
            sections={structure.sections}
            draft={draft}
            selectedBlockId={selectedBlockId}
            layout="horizontal"
          />
          <footer className="lt-structure-footer">
            <button
              type="button"
              disabled={!appliedId}
              onClick={() => void handlers.applyArrangement(regionId, null)}
            >
              {t("transport.structure.original")}
            </button>
            <button
              type="button"
              className={`is-primary ${dirty || !draftIsApplied ? "is-attention" : ""}`}
              disabled={draft.blocks.length === 0 || (draftIsApplied && !dirty)}
              onClick={() => void apply()}
            >
              {t("transport.structure.apply")}
            </button>
          </footer>
        </>
      ) : null}
    </aside>
  );
}
