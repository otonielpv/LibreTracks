import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  site: "https://libretracks.pages.dev",
  i18n: {
    defaultLocale: "en",
    locales: ["en", "es"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  integrations: [
    tailwind({ applyBaseStyles: false }),
    starlight({
      title: {
        en: "LibreTracks Docs",
        es: "Documentacion LibreTracks",
      },
      logo: {
        src: "./src/assets/icon.svg",
        alt: "LibreTracks",
      },
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/otonielpv/LibreTracks" }],
      customCss: ["./src/styles/starlight.css"],
      sidebar: [
        {
          label: "Overview & Core",
          translations: { es: "Resumen y Conceptos" },
          collapsed: false,
          items: [
            { label: "Overview", translations: { es: "Resumen" }, slug: "docs" },
            { label: "System Requirements", translations: { es: "Requisitos del sistema" }, slug: "docs/system-requirements" },
            { label: "Core Concepts", translations: { es: "Conceptos base" }, slug: "docs/core-concepts" },
            { label: "Compact View", translations: { es: "Vista Compacta" }, slug: "docs/compact-view" },
            { label: "Pitch, Warp & The T Button", translations: { es: "Pitch, warp y el boton T" }, slug: "docs/pitch-and-warp" },
          ],
        },
        {
          label: "Live Playback & Routing",
          translations: { es: "Directo y Enrutamiento" },
          collapsed: false,
          items: [
            { label: "Audio Routing & Metronome", translations: { es: "Routing y metrónomo" }, slug: "docs/audio-routing-metronome" },
            { label: "Live Control Flow", translations: { es: "Control en vivo" }, slug: "docs/live-control-flow" },
            { label: "Voice Guide", translations: { es: "Voz guía" }, slug: "docs/voice-guide" },
            { label: "Automation", translations: { es: "Automatizaciones" }, slug: "docs/automation" },
            { label: "Integration & Ecosystem", translations: { es: "Integración y ecosistema" }, slug: "docs/integration-ecosystem" },
          ],
        },
      ],
    }),
  ],
});
