import React from "react";
import ReactDOM from "react-dom/client";

function RemoteApp() {
  return (
    <main style={{ fontFamily: "Segoe UI, sans-serif", padding: "2rem" }}>
      <h1>LibreTracks Remote</h1>
      <p>Placeholder de la app remota para las fases posteriores.</p>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RemoteApp />
  </React.StrictMode>,
);
