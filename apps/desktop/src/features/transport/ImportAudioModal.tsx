import { useMemo, useState } from "react";

type ImportAudioModalProps = {
  isOpen: boolean;
  isImporting: boolean;
  onClose: () => void;
  onImport: () => Promise<void>;
};

type DemoFile = {
  id: string;
  name: string;
  format: string;
  duration: string;
  size: string;
  selectable: boolean;
};

const DEMO_FILES: DemoFile[] = [
  {
    id: "lead-vocal",
    name: "Lead_Vocal_Take1.wav",
    format: "44.1/24",
    duration: "03:45.210",
    size: "38.2 MB",
    selectable: true,
  },
  {
    id: "bv-left",
    name: "Backing_Vocals_L.wav",
    format: "44.1/24",
    duration: "03:45.210",
    size: "38.2 MB",
    selectable: true,
  },
  {
    id: "bv-right",
    name: "Backing_Vocals_R.wav",
    format: "44.1/24",
    duration: "03:45.210",
    size: "38.2 MB",
    selectable: true,
  },
  {
    id: "synth-bass",
    name: "Synth_Bass_Drop.wav",
    format: "48.0/24",
    duration: "00:12.400",
    size: "5.1 MB",
    selectable: true,
  },
  {
    id: "notes",
    name: "Project_Notes.txt",
    format: "--",
    duration: "--",
    size: "4 KB",
    selectable: false,
  },
];

export function ImportAudioModal({ isOpen, isImporting, onClose, onImport }: ImportAudioModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(["lead-vocal", "synth-bass"]);

  const selectedCount = useMemo(() => selectedIds.length, [selectedIds]);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-import-overlay">
      <div className="lt-import-dialog">
        <header className="lt-import-header">
          <div className="lt-import-header-title">
            <span className="material-symbols-outlined">library_music</span>
            <span>Import Audio Files</span>
          </div>
          <button type="button" className="lt-import-close" onClick={onClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="lt-import-body">
          <aside className="lt-import-sidebar">
            <span className="lt-import-sidebar-label">Locations</span>
            <div className="lt-import-sidebar-list">
              <button type="button">This PC</button>
              <button type="button">Samples Drive</button>
              <button type="button" className="is-active">Project Audio</button>
              <button type="button">Cloud Storage</button>
            </div>
          </aside>

          <main className="lt-import-main">
            <div className="lt-import-breadcrumbs">
              <div>Samples Drive / Project Audio / Bounces</div>
              <input
                type="text"
                readOnly
                value="Search..."
                className="lt-import-search"
              />
            </div>

            <div className="lt-import-table-header">
              <span />
              <span>Name</span>
              <span>Format</span>
              <span>Duration</span>
              <span>Size</span>
            </div>

            <div className="lt-import-file-list">
              {DEMO_FILES.map((file) => {
                const isSelected = selectedIds.includes(file.id);
                return (
                  <button
                    key={file.id}
                    type="button"
                    disabled={!file.selectable}
                    className={`lt-import-file-row ${
                      file.selectable
                        ? isSelected
                          ? "is-selected"
                          : ""
                        : "is-disabled"
                    }`}
                    onClick={() => {
                      if (!file.selectable) {
                        return;
                      }

                      setSelectedIds((current) =>
                        current.includes(file.id)
                          ? current.filter((id) => id !== file.id)
                          : [...current, file.id],
                      );
                    }}
                  >
                    <span className="lt-import-check">{isSelected ? "✓" : ""}</span>
                    <span className="lt-import-file-name">{file.name}</span>
                    <span className="lt-import-file-meta">{file.format}</span>
                    <span className="lt-import-file-meta">{file.duration}</span>
                    <span className="lt-import-file-meta">{file.size}</span>
                  </button>
                );
              })}
            </div>
          </main>
        </div>

        <footer className="lt-import-footer">
          <div className="lt-import-preview-toggle">
            <span className="lt-import-preview-pill" />
            Auto-Play Preview
          </div>
          <div className="lt-import-actions">
            <button type="button" className="lt-import-cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedCount === 0 || isImporting}
              className="lt-import-submit"
              onClick={() => {
                void onImport();
              }}
            >
              <span className="material-symbols-outlined">file_download</span>
              {isImporting ? "Importing..." : `Import Selected (${selectedCount})`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
