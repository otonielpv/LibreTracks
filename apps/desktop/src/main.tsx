import "./shared/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { installGlobalErrorHandlers } from "./shared/errorLogging";
import "./shared/styles.css";

installGlobalErrorHandlers();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
