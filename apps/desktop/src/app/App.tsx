import { TransportPanel } from "../features/transport/TransportPanel";

export function App() {
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">LibreTracks</p>
          <h1>Importa WAVs y prueba el primer reproductor multitrack</h1>
          <p className="lede">
            La shell del escritorio ya puede crear, abrir y guardar proyectos, importar una o
            varias pistas WAV y mover el transporte directamente sobre el timeline desde Tauri.
          </p>
        </div>
        <div className="meta-card">
          <span>WAV Import</span>
          <span>Rust Audio</span>
          <span>Tauri Desktop</span>
        </div>
      </header>

      <TransportPanel />

      <section className="panel">
        <h2>Roadmap inmediato</h2>
        <ul>
          <li>Persistencia de `song.json` completada.</li>
          <li>Importacion WAV completada.</li>
          <li>Importacion multiple de WAVs ya operativa desde el selector nativo.</li>
          <li>Importacion y reproduccion WAV iniciales ya probables en Tauri.</li>
          <li>Crear, abrir y guardar proyecto ya disponibles en la UI desktop.</li>
          <li>Timeline visual minimo ya integrado en el escritorio.</li>
          <li>Base de waveform por clip ya integrada para evolucionar el timeline.</li>
          <li>Zoom, cursor directo, secciones por arrastre y saltos basicos ya disponibles.</li>
          <li>Mezcla por pista y grupo ya conectada al motor con controles en desktop.</li>
        </ul>
      </section>
    </main>
  );
}
