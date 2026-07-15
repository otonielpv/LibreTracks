import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import type { PadCatalogEntry } from "@libretracks/shared/models";
import {
  assignPadKey,
  clearPadKey,
  createUserPad,
  deletePad,
  downloadPad,
  getPadsCatalog,
  listenToPadDownloadProgress,
  renameUserPad,
  type PadDownloadProgressEvent,
} from "../desktopApi";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called after any change so the popover can refresh its catalog. */
  onCatalogChanged: () => void;
};

// The 12 keys, in chromatic order. Display uses the sharp glyph; the index
// (0..11) is what the backend maps to a filesystem stem.
const KEY_LABELS = [
  "C",
  "C♯",
  "D",
  "D♯",
  "E",
  "F",
  "F♯",
  "G",
  "G♯",
  "A",
  "A♯",
  "B",
];

const AUDIO_EXTENSIONS = ["wav", "flac", "mp3", "ogg", "m4a", "aac"];

function PadManagerModalImpl({ open: isOpen, onClose, onCatalogChanged }: Props) {
  const { t } = useTranslation();
  const [pads, setPads] = useState<PadCatalogEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  // Key index currently being assigned/cleared (shows a spinner + blocks reentry).
  const [busyKey, setBusyKey] = useState<number | null>(null);
  const [busyGlobal, setBusyGlobal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  // Which flow is shown. Tabs keep the modal a fixed height as the official
  // catalog grows, instead of stacking two ever-taller lists.
  const [tab, setTab] = useState<"official" | "user">("official");
  // Download progress keyed by pad id (official packs only).
  const [downloads, setDownloads] = useState<
    Record<string, PadDownloadProgressEvent>
  >({});

  // The catalog splits into two flows the modal presents as separate sections:
  // official packs (downloaded/removed from the manifest) and the user's own
  // pads (created + edited key-by-key). A user pad is flagged `isUser`.
  const userPads = useMemo(() => pads.filter((p) => p.isUser), [pads]);
  const officialPads = useMemo(() => pads.filter((p) => !p.isUser), [pads]);
  const selected = useMemo(
    () => userPads.find((p) => p.id === selectedId) ?? null,
    [userPads, selectedId],
  );

  const refresh = useCallback(async () => {
    try {
      const catalog = await getPadsCatalog();
      setPads(catalog.pads);
      setOffline(catalog.offline);
      onCatalogChanged();
    } catch {
      setPads([]);
      setOffline(true);
    }
  }, [onCatalogChanged]);

  // Load the catalog on open; keep the selection sticky when possible.
  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    void refresh();
  }, [isOpen, refresh]);

  // Default the selection to the first user pad; sync the rename field to it.
  useEffect(() => {
    if (!isOpen) return;
    if (userPads.length === 0) {
      setSelectedId("");
      return;
    }
    if (!userPads.some((p) => p.id === selectedId)) {
      setSelectedId(userPads[0].id);
    }
  }, [isOpen, userPads, selectedId]);

  useEffect(() => {
    setRenameValue(selected?.name ?? "");
  }, [selected]);

  // Escape closes the modal (only when not mid-operation).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyGlobal && busyKey === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, busyGlobal, busyKey]);

  // Subscribe to download progress while open. On completion, clear the entry
  // and refresh so the pack flips to "installed".
  useEffect(() => {
    if (!isOpen) return;
    let unlisten: (() => void) | undefined;
    let active = true;
    void (async () => {
      unlisten = await listenToPadDownloadProgress((event) => {
        if (!active) return;
        setDownloads((prev) => ({ ...prev, [event.padId]: event }));
        if (event.done) {
          window.setTimeout(() => {
            setDownloads((prev) => {
              const next = { ...prev };
              delete next[event.padId];
              return next;
            });
            void refresh();
          }, 400);
        }
      });
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [isOpen, refresh]);

  const startDownload = useCallback((padId: string) => {
    setDownloads((prev) => ({
      ...prev,
      [padId]: { padId, percent: 0, message: "", done: false },
    }));
    // Errors surface via the terminal progress event (done + error).
    void downloadPad(padId).catch(() => {});
  }, []);

  const handleDeletePack = useCallback(
    async (padId: string) => {
      setBusyGlobal(true);
      setError(null);
      try {
        await deletePad(padId);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyGlobal(false);
      }
    },
    [refresh],
  );

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setBusyGlobal(true);
    setError(null);
    try {
      const created = await createUserPad(name);
      setNewName("");
      await refresh();
      setSelectedId(created.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyGlobal(false);
    }
  }, [newName, refresh]);

  const handleRename = useCallback(async () => {
    if (!selected) return;
    const name = renameValue.trim();
    if (!name || name === selected.name) return;
    setBusyGlobal(true);
    setError(null);
    try {
      await renameUserPad(selected.id, name);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyGlobal(false);
    }
  }, [selected, renameValue, refresh]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const ok = window.confirm(
      t("pads.confirmDelete", {
        defaultValue: '¿Eliminar el pad "{{name}}"? Se borran sus audios.',
        name: selected.name,
      }),
    );
    if (!ok) return;
    setBusyGlobal(true);
    setError(null);
    try {
      await deletePad(selected.id);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyGlobal(false);
    }
  }, [selected, refresh, t]);

  const handleAssign = useCallback(
    async (keyIndex: number) => {
      if (!selected) return;
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: t("pads.audioFilter", { defaultValue: "Audio" }),
            extensions: AUDIO_EXTENSIONS,
          },
        ],
      });
      const path = typeof picked === "string" ? picked : null;
      if (!path) return;
      setBusyKey(keyIndex);
      setError(null);
      try {
        await assignPadKey(selected.id, keyIndex, path);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyKey(null);
      }
    },
    [selected, refresh, t],
  );

  const handleClear = useCallback(
    async (keyIndex: number) => {
      if (!selected) return;
      setBusyKey(keyIndex);
      setError(null);
      try {
        await clearPadKey(selected.id, keyIndex);
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusyKey(null);
      }
    },
    [selected, refresh],
  );

  if (!isOpen) return null;

  const body = (
    <div
      className="lt-modal-backdrop"
      onClick={() => {
        if (!busyGlobal && busyKey === null) onClose();
      }}
    >
      <section
        className="lt-settings-modal lt-pad-manager-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-pad-manager-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("pads.title", { defaultValue: "Pads de ambiente" })}
            </span>
            <h2 id="lt-pad-manager-title">
              {t("pads.managerTitle", { defaultValue: "Gestor de pads" })}
            </h2>
            <p>
              {t("pads.managerSubtitle", {
                defaultValue:
                  "Crea tus propios pads y asigna un audio a cada tonalidad. Las tonalidades sin audio quedan desactivadas.",
              })}
            </p>
          </div>
          <button
            type="button"
            className="lt-settings-modal-close"
            aria-label={t("common.close", { defaultValue: "Cerrar" })}
            onClick={onClose}
            disabled={busyGlobal || busyKey !== null}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              close
            </span>
          </button>
        </header>

        <div className="lt-settings-modal-body lt-pad-manager-body">
          {error && <p className="lt-pad-manager-error">{error}</p>}

          <div className="lt-pad-manager-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "official"}
              className={
                tab === "official"
                  ? "lt-pad-manager-tab is-active"
                  : "lt-pad-manager-tab"
              }
              onClick={() => setTab("official")}
            >
              {t("pads.officialSection", { defaultValue: "Packs oficiales" })}
              <span className="lt-pad-manager-tab-count">
                {officialPads.length}
              </span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "user"}
              className={
                tab === "user"
                  ? "lt-pad-manager-tab is-active"
                  : "lt-pad-manager-tab"
              }
              onClick={() => setTab("user")}
            >
              {t("pads.userSection", { defaultValue: "Mis pads" })}
              <span className="lt-pad-manager-tab-count">{userPads.length}</span>
            </button>
          </div>

          {tab === "official" && (
            <section className="lt-pad-manager-section" role="tabpanel">
              {offline && (
                <p className="lt-pad-manager-note">
                  {t("pads.offline", {
                    defaultValue:
                      "No se pudo cargar el catálogo. Revisa tu conexión.",
                  })}
                </p>
              )}
              {officialPads.length === 0 ? (
                <p className="lt-pad-manager-empty">
                  {offline
                    ? t("pads.noOfficialOffline", {
                        defaultValue: "No hay packs oficiales instalados.",
                      })
                    : t("pads.none", {
                        defaultValue: "No hay pads disponibles.",
                      })}
                </p>
              ) : (
                <ul className="lt-pad-manager-pack-list lt-pad-manager-scroll">
                  {officialPads.map((pad) => (
                    <PadPackRow
                      key={pad.id}
                      pad={pad}
                      progress={downloads[pad.id]}
                      busy={busyGlobal}
                      onDownload={() => startDownload(pad.id)}
                      onDelete={() => void handleDeletePack(pad.id)}
                      t={t}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {tab === "user" && (
          <section className="lt-pad-manager-section" role="tabpanel">
          <div className="lt-pad-manager-create">
            <input
              type="text"
              className="lt-pad-manager-name-input"
              placeholder={t("pads.newPadPlaceholder", {
                defaultValue: "Nombre del nuevo pad",
              })}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleCreate();
              }}
              disabled={busyGlobal}
            />
            <button
              type="button"
              className="lt-pad-manager-create-btn"
              onClick={() => void handleCreate()}
              disabled={busyGlobal || newName.trim() === ""}
            >
              {t("pads.createPad", { defaultValue: "Crear pad" })}
            </button>
          </div>

          {userPads.length === 0 ? (
            <p className="lt-pad-manager-empty">
              {t("pads.noUserPads", {
                defaultValue:
                  "Aún no tienes pads propios. Crea uno para empezar.",
              })}
            </p>
          ) : (
            <div className="lt-pad-manager-layout">
              <ul className="lt-pad-manager-list" role="listbox">
                {userPads.map((pad) => (
                  <li key={pad.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={pad.id === selectedId}
                      className={
                        pad.id === selectedId
                          ? "lt-pad-manager-list-item is-active"
                          : "lt-pad-manager-list-item"
                      }
                      onClick={() => setSelectedId(pad.id)}
                    >
                      <span className="lt-pad-manager-list-name">
                        {pad.name}
                      </span>
                      <span className="lt-pad-manager-list-count">
                        {t("pads.partial", {
                          defaultValue: "{{n}}/12",
                          n: pad.keysPresent,
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>

              {selected && (
                <div className="lt-pad-manager-detail">
                  <div className="lt-pad-manager-detail-head">
                    <input
                      type="text"
                      className="lt-pad-manager-name-input"
                      value={renameValue}
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={() => void handleRename()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void handleRename();
                      }}
                      aria-label={t("pads.renamePad", {
                        defaultValue: "Renombrar pad",
                      })}
                      disabled={busyGlobal}
                    />
                    <button
                      type="button"
                      className="lt-pad-manager-delete-btn"
                      onClick={() => void handleDelete()}
                      disabled={busyGlobal}
                    >
                      {t("pads.delete", { defaultValue: "Eliminar" })}
                    </button>
                  </div>

                  <div className="lt-pad-manager-keys" role="group">
                    {KEY_LABELS.map((label, index) => {
                      const present =
                        selected.keysPresentMask?.[index] ?? false;
                      const busy = busyKey === index;
                      return (
                        <div
                          key={label}
                          className={
                            present
                              ? "lt-pad-manager-key is-present"
                              : "lt-pad-manager-key"
                          }
                        >
                          <span className="lt-pad-manager-key-label">
                            {label}
                          </span>
                          <div className="lt-pad-manager-key-actions">
                            <button
                              type="button"
                              className="lt-pad-manager-key-assign"
                              onClick={() => void handleAssign(index)}
                              disabled={busy || busyGlobal}
                            >
                              {busy
                                ? t("pads.assigning", {
                                    defaultValue: "…",
                                  })
                                : present
                                  ? t("pads.replace", {
                                      defaultValue: "Reemplazar",
                                    })
                                  : t("pads.assign", {
                                      defaultValue: "Asignar",
                                    })}
                            </button>
                            {present && (
                              <button
                                type="button"
                                className="lt-pad-manager-key-clear"
                                aria-label={t("pads.clearKey", {
                                  defaultValue: "Quitar audio",
                                })}
                                onClick={() => void handleClear(index)}
                                disabled={busy || busyGlobal}
                              >
                                <span
                                  className="material-symbols-outlined"
                                  aria-hidden="true"
                                >
                                  delete
                                </span>
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          </section>
          )}
        </div>
      </section>
    </div>
  );

  return createPortal(body, document.body);
}

// One official pack: shows install/partial state and either a download/retry
// button (with progress) or a delete button. User pads never render here.
function PadPackRow({
  pad,
  progress,
  busy,
  onDownload,
  onDelete,
  t,
}: {
  pad: PadCatalogEntry;
  progress: PadDownloadProgressEvent | undefined;
  busy: boolean;
  onDownload: () => void;
  onDelete: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const downloading = Boolean(progress) && !progress?.done;
  const failed = Boolean(progress?.done && progress?.error);
  const sizeMb = pad.sizeBytes > 0 ? Math.round(pad.sizeBytes / 1_000_000) : 0;
  const canDownload = pad.downloadUrl !== "";
  const present = pad.keysPresent > 0;

  return (
    <li className="lt-pad-manager-pack-row">
      <div className="lt-pad-manager-pack-info">
        <span className="lt-pad-manager-pack-name">{pad.name}</span>
        <span className="lt-pad-manager-pack-meta">
          {sizeMb > 0 && <span>{sizeMb} MB</span>}
          {present && !pad.installed && (
            <span className="lt-pads-partial-badge">
              {t("pads.partial", { defaultValue: "{{n}}/12", n: pad.keysPresent })}
            </span>
          )}
        </span>
      </div>
      {downloading ? (
        <div
          className="lt-pads-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress?.percent ?? 0)}
        >
          <div className="lt-pads-progress-track">
            <div
              className="lt-pads-progress-fill"
              style={{
                width: `${Math.max(0, Math.min(100, progress?.percent ?? 0))}%`,
              }}
            />
          </div>
          <span className="lt-pads-progress-label">
            {progress?.message ||
              t("pads.downloading", { defaultValue: "Descargando…" })}{" "}
            {Math.round(progress?.percent ?? 0)}%
          </span>
        </div>
      ) : (
        <div className="lt-pad-manager-pack-actions">
          {present && (
            <button
              type="button"
              className="lt-pad-manager-delete-btn"
              onClick={onDelete}
              disabled={busy}
            >
              {t("pads.delete", { defaultValue: "Eliminar" })}
            </button>
          )}
          {!pad.installed && canDownload && (
            <button
              type="button"
              className="lt-pad-manager-download-btn"
              onClick={onDownload}
              disabled={busy}
            >
              {failed
                ? t("pads.retry", { defaultValue: "Reintentar" })
                : t("pads.download", { defaultValue: "Descargar" })}
            </button>
          )}
        </div>
      )}
      {failed && (
        <span className="lt-pad-manager-pack-error">{progress?.error}</span>
      )}
    </li>
  );
}

export const PadManagerModal = PadManagerModalImpl;
