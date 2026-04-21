import { TransportPanel } from "../features/transport/TransportPanel";

export function App() {
  return (
    <main className="h-screen w-screen overflow-hidden bg-background text-on-surface font-body antialiased selection:bg-primary/30">
      <TransportPanel />
    </main>
  );
}
