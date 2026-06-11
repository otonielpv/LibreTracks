import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { browserslistToTargets } from "lightningcss";

// macOS Catalina (our minimum) ships Safari 13.1, and the Tauri WebView uses
// the system Safari. That WebKit rejects whole declarations it can't parse —
// CSS Color 4 `rgb(r g b / a)`, flex `gap`, `aspect-ratio`, unprefixed
// `backdrop-filter` — which left the UI black / gridless / misaligned there.
// Lightning CSS down-levels the bundled CSS to this target at minify time.
// PostCSS (Tailwind) still runs first. NOTE: color-mix() and :has() are NOT
// down-levelable against runtime vars, so those are handled by hand in
// styles.css (solid-colour ::after overlays + an explicit modifier class).
const legacyWebkitTargets = browserslistToTargets(["safari >= 13"]);

export default defineConfig({
  plugins: [react()],
  build: {
    // The Tauri WebView uses the system Safari; our floor is macOS 10.15
    // Catalina (Safari 13.1). Vite's default target ('modules') assumes
    // Safari 14, so pin esbuild to down-level JS *syntax* to Safari 13.
    // Runtime *methods* newer than 13.1 are polyfilled in
    // src/shared/legacy-polyfills.ts (esbuild down-levels syntax, not methods).
    target: ["safari13", "es2020"],
    cssMinify: "lightningcss",
  },
  css: {
    lightningcss: {
      targets: legacyWebkitTargets,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
