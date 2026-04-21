type ImportAudioModalProps = {
  isOpen: boolean;
  isImporting: boolean;
  onClose: () => void;
  onImport: () => Promise<void>;
};

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
          <h2 className="lt-import-simple-title">Selecciona archivos WAV desde tu ordenador</h2>
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
