import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { browserslistToTargets } from "lightningcss";

// macOS Catalina ships Safari 13.1; High Sierra (our tauri minimumSystemVersion
// 10.13) ships Safari 13.0. WebKit that old rejects whole declarations it can't
// parse — modern CSS Color 4 `rgb(r g b / a)`, `color-mix()`, flex `gap`,
// `aspect-ratio`, unprefixed `backdrop-filter` — which is why the UI rendered
// black / gridless / misaligned there. Lightning CSS down-levels the bundled
// CSS to these targets at minify time. PostCSS (Tailwind) still runs first.
const legacyWebkitTargets = browserslistToTargets(["safari >= 13"]);

export default defineConfig({
  plugins: [react()],
  build: {
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
