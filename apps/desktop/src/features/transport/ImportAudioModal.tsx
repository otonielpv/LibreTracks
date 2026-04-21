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
  if (!isOpen) {
    return null;
  }

  return (
    <div className="lt-import-overlay">
      <div className="lt-import-dialog lt-import-dialog--simple">
        <header className="lt-import-header">
          <div className="lt-import-header-title">
            <span className="material-symbols-outlined">audio_file</span>
            <span>Importar Audio</span>
          </div>
          <button type="button" className="lt-import-close" onClick={onClose} disabled={isImporting}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="lt-import-simple-body">
          <span className="material-symbols-outlined lt-import-simple-icon">folder_open</span>
          <p className="lt-import-simple-title">Selecciona archivos WAV desde tu ordenador</p>
          <p className="lt-import-simple-hint">
            Se abrirá el explorador de archivos del sistema. Puedes seleccionar uno o varios archivos WAV.
          </p>
          <button
            type="button"
            disabled={isImporting}
            className="lt-import-submit"
            onClick={() => {
              void onImport();
            }}
          >
            <span className="material-symbols-outlined">file_open</span>
            {isImporting ? "Importando..." : "Seleccionar archivos..."}
          </button>
        </div>

        <footer className="lt-import-footer">
          <div />
          <div className="lt-import-actions">
            <button type="button" className="lt-import-cancel" onClick={onClose} disabled={isImporting}>
              Cancelar
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
