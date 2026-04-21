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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-background/60 p-6 backdrop-blur-md">
      <div className="flex h-[80vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-surface">
        <header className="flex items-center justify-between bg-surface-container-high px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="font-headline text-lg font-semibold tracking-tight">Import Audio Files</span>
          </div>
          <button type="button" className="rounded-sm px-2 py-1 text-on-surface-variant hover:bg-surface-container" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <aside className="w-56 shrink-0 bg-surface-container-low p-3">
            <span className="font-label text-[10px] uppercase tracking-[0.16em] text-on-surface-variant">Locations</span>
            <div className="mt-3 flex flex-col gap-1">
              <button type="button" className="rounded-sm px-3 py-2 text-left text-sm text-on-surface-variant hover:bg-surface-container">This PC</button>
              <button type="button" className="rounded-sm px-3 py-2 text-left text-sm text-on-surface-variant hover:bg-surface-container">Samples Drive</button>
              <button type="button" className="rounded-sm bg-primary/10 px-3 py-2 text-left text-sm text-primary">Project Audio</button>
              <button type="button" className="rounded-sm px-3 py-2 text-left text-sm text-on-surface-variant hover:bg-surface-container">Cloud Storage</button>
            </div>
          </aside>

          <main className="flex min-h-0 flex-1 flex-col bg-surface-container-lowest">
            <div className="flex items-center justify-between bg-surface-container px-4 py-3">
              <div className="font-body text-sm text-on-surface-variant">Samples Drive / Project Audio / Bounces</div>
              <input
                type="text"
                readOnly
                value="Search..."
                className="w-44 rounded-sm bg-surface-container-lowest px-3 py-1.5 text-xs text-on-surface-variant"
              />
            </div>

            <div className="grid grid-cols-[2.3rem_1fr_6rem_6rem_5rem] bg-surface-container-low px-3 py-2 font-label text-[10px] uppercase tracking-[0.16em] text-on-surface-variant">
              <span />
              <span>Name</span>
              <span className="text-right">Format</span>
              <span className="text-right">Duration</span>
              <span className="text-right">Size</span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {DEMO_FILES.map((file) => {
                const isSelected = selectedIds.includes(file.id);
                return (
                  <button
                    key={file.id}
                    type="button"
                    disabled={!file.selectable}
                    className={`mb-1 grid w-full grid-cols-[2.3rem_1fr_6rem_6rem_5rem] items-center rounded-sm px-2 py-2 text-left transition ${
                      file.selectable
                        ? isSelected
                          ? "bg-surface-container-high text-on-surface"
                          : "text-on-surface-variant hover:bg-surface-container"
                        : "cursor-not-allowed opacity-45"
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
                    <span className="flex h-4 w-4 items-center justify-center rounded-sm border border-outline-variant text-[10px]">
                      {isSelected ? "✓" : ""}
                    </span>
                    <span className="truncate text-sm">{file.name}</span>
                    <span className="text-right font-label text-xs">{file.format}</span>
                    <span className="text-right font-label text-xs">{file.duration}</span>
                    <span className="text-right font-label text-xs">{file.size}</span>
                  </button>
                );
              })}
            </div>
          </main>
        </div>

        <footer className="flex items-center justify-between bg-surface-container px-4 py-3">
          <div className="flex items-center gap-2 text-xs text-on-surface-variant">
            <span className="h-4 w-8 rounded-full bg-primary/20" />
            Auto-Play Preview
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-sm px-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container-high" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedCount === 0 || isImporting}
              className="rounded-sm bg-gradient-to-b from-primary to-primary-container px-4 py-2 text-sm font-semibold text-on-primary disabled:opacity-60"
              onClick={() => {
                void onImport();
              }}
            >
              {isImporting ? "Importing..." : `Import Selected (${selectedCount})`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
