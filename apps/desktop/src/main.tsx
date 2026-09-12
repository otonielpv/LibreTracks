// Must be first: installs runtime polyfills for the older system WebKit on the
// macOS versions we support, before any other module runs.
import "./shared/legacy-polyfills";
import "./shared/i18n";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { installGlobalErrorHandlers } from "./shared/errorLogging";
import { isIOSApp, isMobileApp } from "./features/transport/desktopApi";
import "./shared/styles.css";

installGlobalErrorHandlers();

// Root hook for the mobile stylesheet section. The historical `.lt-android`
// class now names the shared touch layout used by both Tauri mobile targets.
if (isMobileApp) {
  document.documentElement.classList.add("lt-mobile");
  // Keep the historical hook while the existing touch rules migrate to the
  // platform-neutral `.lt-mobile` contract.
  document.documentElement.classList.add("lt-android");
}
if (isIOSApp) {
  document.documentElement.classList.add("lt-ios");
}

// One line, once, on mobile: what the WebView believes it has to draw on.
// The simulator screenshots of 2026-09-12 showed the iPhone UI ending 124 pt
// short of the right edge (exactly twice the 62 pt notch inset) while the iPad
// filled its screen, and no amount of reading CSS can tell you whether the
// viewport is genuinely narrower or the layout is padding itself twice. This
// says which, from inside, on any device anyone ever reports.
if (isMobileApp) {
  window.setTimeout(() => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;" +
      "padding-left:env(safe-area-inset-left,0px);" +
      "padding-right:env(safe-area-inset-right,0px);" +
      "padding-top:env(safe-area-inset-top,0px);" +
      "padding-bottom:env(safe-area-inset-bottom,0px);";
    document.body.appendChild(probe);
    const safe = getComputedStyle(probe);
    const shell = document.querySelector<HTMLElement>(".lt-app-shell");
    const rect = shell?.getBoundingClientRect();
    const report =
      `inner=${window.innerWidth}x${window.innerHeight} ` +
      `screen=${window.screen.width}x${window.screen.height} ` +
      `dpr=${window.devicePixelRatio} ` +
      `safe=L${safe.paddingLeft} R${safe.paddingRight} T${safe.paddingTop} B${safe.paddingBottom} ` +
      `shell=${rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)}` : "<sin montar>"}`;
    console.log(`[LT_VIEWPORT] ${report}`);
    probe.remove();

    // Cuánto se sale la barra de transporte de lo que hay. Recortarla a ojo
    // es adivinar; esto dice los píxeles exactos que faltan en cada
    // dispositivo, que es lo único que permite decidir qué encoger.
    const overflowOf = (selector: string): string => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) return `${selector}=<no montado>`;
      const over = el.scrollWidth - el.clientWidth;
      return `${selector}=${el.clientWidth}/${el.scrollWidth}${over > 0 ? ` DESBORDA ${over}px` : " cabe"}`;
    };
    const bars = [".lt-transport", ".lt-topbar-main-row", ".lt-view-toolbar"]
      .map(overflowOf)
      .join(" | ");
    console.log(`[LT_BARS] ${bars}`);

    const banner = document.createElement("div");
    banner.textContent = `${report}
${bars}`;
    banner.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:2147483647;" +
      "background:#b00020;color:#fff;font:11px/1.3 monospace;padding:3px 6px;" +
      "pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(banner);
    window.setTimeout(() => banner.remove(), 90000);

  }, 1500);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
