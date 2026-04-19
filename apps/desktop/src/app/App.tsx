import { TransportPanel } from "../features/transport/TransportPanel";

export function App() {
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">LibreTracks</p>
          <h1>Base tecnica lista para el primer prototipo multitrack</h1>
          <p className="lede">
            La interfaz todavia es minima, pero ya refleja el modelo de trabajo:
            transporte, grupos y timeline como piezas separadas.
          </p>
        </div>
        <div className="meta-card">
          <span>BPM 72</span>
          <span>Key D</span>
          <span>4/4</span>
        </div>
      </header>

      <TransportPanel />

      <section className="panel">
        <h2>Roadmap inmediato</h2>
        <ul>
          <li>Persistencia de `song.json` completada.</li>
          <li>Importacion WAV completada.</li>
          <li>Transporte local sincronizado en progreso.</li>
        </ul>
      </section>
    </main>
  );
}
