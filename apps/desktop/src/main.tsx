// Must be first: installs runtime polyfills for the older system WebKit on the
// macOS versions we support, before any other module runs.
import "./shared/legacy-polyfills";
import "./shared/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { installGlobalErrorHandlers } from "./shared/errorLogging";
import { isMobileApp } from "./features/transport/desktopApi";
import "./shared/styles.css";

installGlobalErrorHandlers();

// Root hook for the mobile stylesheet section. The historical `.lt-android`
// class now names the shared touch layout used by both Tauri mobile targets.
if (isMobileApp) {
  document.documentElement.classList.add("lt-android");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
